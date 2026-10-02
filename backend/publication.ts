import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Publication } from './types.js';
import { mappingSchema, validateMappings } from './microtrends.js';
import { impactSchema, validateAssessments } from './impact.js';
import { contextSchema, validateContexts } from './context.js';

const text = z.string();
const isoDate = z.string().refine(value => value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value));
const sourceUrl = z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol));
export const recordSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), d: isoDate,
  scope: z.enum(['agents','other-ai','automation']), t: text.min(1), org: text.min(1),
  when: text, set: text, kind: text, sum: text, tag: text, src: text, rca: text, u: sourceUrl,
  cause: text, clabel: text, lesson: text, loss: text, impact: text, limits: text,
  th: z.array(z.tuple([text,text,text])), srcs: z.array(z.tuple([text,text,sourceUrl,text])),
  impact_assessment: impactSchema.optional(),
  map: mappingSchema.optional(),
  context: contextSchema.optional(),
}).catchall(z.unknown());
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const inputSchema = z.strictObject({
  repo: sourceUrl,
  settings: z.strictObject({chart_start: month,chart_end: month,microtrends_as_of: isoDate,
    methodology_version: z.enum(['legacy-setting-v1','impact-v1']),
    impact_review_mode: z.enum(['draft','reviewed']).optional(),
    microtrends_version: z.literal('maker-model-attack-v1').optional(),
    microtrends_review_mode: z.enum(['draft','reviewed']).optional(),
    context_version: z.literal('disclosure-comparison-v1').optional(),
    context_review_mode: z.enum(['draft','reviewed']).optional(), context_as_of: z.iso.date().optional()}),
  records: z.array(recordSchema).min(1).max(10000),
  microtrends: z.record(text,z.strictObject({p:z.array(z.tuple([text.min(1),text.min(1)])).min(1),act:text,exp:text,cat:text})),
  radar: z.strictObject({
    signals: z.array(z.strictObject({id:text.min(1),sample:z.boolean(),s:z.enum(['x','r']),n:text,h:text,t:text,
      st:z.enum(['unv','lnk','con','noise']),rec:text.optional(),txt:text,e:text,c:text})),
    clusters: z.array(z.strictObject({sample:z.boolean(),k:text.min(1),t:text,m:text,d:z.array(z.number().nonnegative()).min(2),
      mix:z.array(z.number().min(0).max(1)).length(3)})),
  }),
});

export function validatePublication(value: unknown): Publication {
  const result = inputSchema.parse(value);
  const ids = new Set(result.records.map(r=>r.id));
  if (ids.size !== result.records.length) throw new Error('Duplicate incident IDs');
  if (Object.keys(result.microtrends).some(id=>!ids.has(id))) throw new Error('Microtrend references an unknown incident');
  if (result.radar.signals.some(s=>s.rec && !ids.has(s.rec))) throw new Error('Radar references an unknown incident');
  if (new Set(result.radar.signals.map(s=>s.id)).size !== result.radar.signals.length
    || new Set(result.radar.clusters.map(c=>c.k)).size !== result.radar.clusters.length) throw new Error('Duplicate Radar identifiers');
  if (result.settings.chart_start > result.settings.chart_end || !result.settings.microtrends_as_of) throw new Error('Invalid display calendar');
  const [startYear,startMonth]=result.settings.chart_start.split('-').map(Number);
  const [endYear,endMonth]=result.settings.chart_end.split('-').map(Number);
  const months=(endYear-startYear)*12+endMonth-startMonth+1;
  if(months<12 || months>600) throw new Error('Chart calendar must contain 12–600 months');
  if (result.settings.methodology_version === 'impact-v1'
    && result.settings.impact_review_mode === undefined) {
    throw new Error('Impact methodology requires explicit review mode');
  }
  if (result.settings.methodology_version === 'legacy-setting-v1'
    && result.settings.impact_review_mode !== undefined) {
    throw new Error('Impact settings require impact-v1');
  }
  validateAssessments(result as Publication);
  validateMappings(result as Publication);
  validateContexts(result as Publication);
  return result as Publication;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export const publicationHash = (value: Publication) => createHash('sha256').update(canonical(value)).digest('hex');

// Called only by the operator CLI, inside its publication transaction.
export async function publish(client: PoolClient, data: Publication, actor: string, reason: string) {
  if (!actor.trim() || !reason.trim()) throw new Error('Publication requires actor and reason');
  const result = await client.query(`INSERT INTO publications(actor,reason,source_hash,settings,repo)
    VALUES($1,$2,$3,$4,$5) RETURNING id::text`,[actor,reason,publicationHash(data),data.settings,data.repo]);
  const publicationId = result.rows[0].id;
  for (const record of data.records) {
    const {id,d,scope,t,org,srcs,th,...content} = record;
    await client.query('INSERT INTO incidents(id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
    const m=data.microtrends[id];
    const revision = await client.query(`INSERT INTO incident_revisions
      (incident_id,publication_id,scope,sort_date,title,organization_display,content,action,exposure,category)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[id,publicationId,scope,d||null,t,org,content,m?.act,m?.exp,m?.cat]);
    const revisionId=revision.rows[0].id;
    for (const [position,[label,title,url,date]] of srcs.entries()) {
      await client.query('INSERT INTO sources(url) VALUES($1) ON CONFLICT DO NOTHING',[url]);
      await client.query('INSERT INTO revision_sources VALUES($1,$2,$3,$4,$5,$6)',[revisionId,position,url,label,title,date]);
    }
    for (const [position,[date,title,description]] of th.entries()) {
      await client.query('INSERT INTO incident_events VALUES($1,$2,$3,$4,$5)',[revisionId,position,date,title,description]);
    }
    for (const [position,[organization,system]] of (m?.p || []).entries()) {
      await client.query('INSERT INTO organizations VALUES($1) ON CONFLICT DO NOTHING',[organization]);
      await client.query('INSERT INTO systems(organization_name,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[organization,system]);
      await client.query(`INSERT INTO revision_systems(revision_id,position,system_id)
        SELECT $1,$2,id FROM systems WHERE organization_name=$3 AND name=$4`,[revisionId,position,organization,system]);
    }
  }
  for (const [position,{id,sample,...content}] of data.radar.signals.entries()) {
    await client.query('INSERT INTO radar_signals VALUES($1,$2,$3,$4,$5)',[publicationId,id,sample,content,position]);
  }
  for (const [position,{k,sample,...content}] of data.radar.clusters.entries()) {
    await client.query('INSERT INTO radar_clusters VALUES($1,$2,$3,$4,$5)',[publicationId,k,sample,content,position]);
  }
  return publicationId;
}
