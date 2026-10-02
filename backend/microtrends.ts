import { createHash } from 'node:crypto';
import { z } from 'zod';
import companies from '../data/taxonomy/companies.json' with { type: 'json' };
import models from '../data/taxonomy/models.json' with { type: 'json' };
import attacks from '../data/taxonomy/attacks.json' with { type: 'json' };
import type { Incident, Microtrend, Publication } from './types.js';

export const MICRO_VERSION = 'maker-model-attack-v1';
export const taxonomy = {companies, models, attacks};
const url = z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol));
const text = z.string().trim().min(1);
export const mappingSchema = z.strictObject({
  links: z.array(z.strictObject({company: text, model: text, version: text.nullable(),
    model_named_in_source: z.boolean(), source: url, quote: text.nullable()})).min(1),
  attack: text, attack_2: text.nullable(), harness: text.nullable(), ran_by: text, hit: text,
  exposure_category: z.enum(['Systems','Credentials','Instructions','Private data','Output','Money','People']),
  sources: z.strictObject({model: url, attack: url}),
  rationale: text, notes: z.string(), proposed_by: text, proposed_at: z.iso.datetime(),
  reviews: z.array(z.strictObject({reviewer: text, reviewed_at: z.iso.datetime(),
    mapping_hash: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['approve','dispute']), note: text})),
});
export type IncidentMapping = z.infer<typeof mappingSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function mappingHash(record: Incident) {
  if (!record.map) throw new Error('Missing mapping: ' + record.id);
  const {map, impact_assessment: _impact, ...evidence} = record;
  const {reviews: _reviews, ...mapping} = map;
  return createHash('sha256').update(canonical({evidence, mapping, taxonomy: {
    models: map.links.map(modelEntry),
    attacks: attacks.filter(attack => [map.attack,map.attack_2].includes(attack.name)),
  }})).digest('hex');
}
export function mappingState(record: Incident) {
  const current = record.map!.reviews.filter(review => review.mapping_hash === mappingHash(record));
  return current.some(review => review.decision === 'dispute') ? 'disputed'
    : current.some(review => review.decision === 'approve') ? 'reviewed' : 'draft';
}
function modelEntry(link: IncidentMapping['links'][number]) {
  const entry = models.find(model => model.name === link.model && model.company === link.company);
  if (!entry) throw new Error('Unknown model or maker/model pair: ' + link.company + ' / ' + link.model);
  return entry;
}
export function buildMicrotrends(records: Incident[], grouped = false): Record<string, Microtrend> {
  return Object.fromEntries(records.map(record => {
    if (!record.map) throw new Error('Missing mapping: ' + record.id);
    const pairs = record.map.links.map(link => {
      const entry = modelEntry(link);
      const version = link.version === null ? null : entry.versions.find(version => version.id === link.version);
      if (link.version !== null && !version) throw new Error('Unknown model version: ' + record.id);
      return [link.company, grouped ? entry.family : version ? version.label : entry.name] as [string,string];
    });
    return [record.id, {p: [...new Map(pairs.map(pair => [JSON.stringify(pair), pair])).values()],
      act: record.map.attack, exp: record.map.hit, cat: record.map.exposure_category}];
  }));
}
export function validateMappings(data: Publication) {
  const enabled = data.settings.microtrends_version === MICRO_VERSION;
  if (enabled !== (data.settings.microtrends_review_mode !== undefined)) throw new Error('Microtrends version and review mode must be set together');
  if (!enabled && data.records.some(record => record.map)) throw new Error('Record mappings require maker-model-attack-v1');
  if (!enabled) return;
  for (const record of data.records) {
    const map = record.map;
    if (!map) throw new Error('Missing mapping: ' + record.id);
    const urls = new Set([record.u, ...record.srcs.map(source => source[2])]);
    if ([map.sources.model, map.sources.attack, ...map.links.map(link => link.source)].some(url => !urls.has(url))) {
      throw new Error('Mapping must cite this record’s sources: ' + record.id);
    }
    if (!map.links.some(link => link.source === map.sources.model)) throw new Error('Primary model source must support a link: ' + record.id);
    const unique = new Set<string>();
    for (const link of map.links) {
      if (!companies.includes(link.company)) throw new Error('Unknown model maker: ' + record.id);
      const model = modelEntry(link);
      if (link.model_named_in_source !== (model.kind === 'named')) throw new Error('Named-model flag conflicts with catalog: ' + record.id);
      if (link.model_named_in_source && !link.quote) throw new Error('Named model requires a source quotation: ' + record.id);
      if (model.kind === 'harness' && model.harness !== map.harness) throw new Error('Harness label must match record harness: ' + record.id);
      const key = JSON.stringify([link.company, link.model, link.version]);
      if (unique.has(key)) throw new Error('Duplicate model link: ' + record.id);
      unique.add(key);
    }
    for (const name of [map.attack, map.attack_2].filter(name => name !== null)) {
      const attack = attacks.find(attack => attack.name === name);
      if (!attack) throw new Error('Unknown attack type: ' + record.id);
      if ((record.scope === 'agents') === (attack.family === 'AI failure')) throw new Error('Attack family conflicts with scope: ' + record.id);
    }
    if (map.attack === map.attack_2) throw new Error('Secondary attack duplicates primary: ' + record.id);
    if (map.reviews.some(review => review.mapping_hash !== mappingHash(record))) throw new Error('Stale mapping review: ' + record.id);
    if (new Set(map.reviews.map(review => review.reviewer.toLowerCase())).size !== map.reviews.length) throw new Error('Duplicate mapping reviewer: ' + record.id);
    if (data.settings.microtrends_review_mode === 'reviewed' && mappingState(record) !== 'reviewed') throw new Error('Mapping needs human review: ' + record.id);
  }
  if (canonical(data.microtrends) !== canonical(buildMicrotrends(data.records))) throw new Error('Microtrends must be generated from record mappings');
}
export function microtrendsMetadata(data: Publication) {
  if (data.settings.microtrends_version !== MICRO_VERSION) return {version: 'legacy-mapping-v1' as const};
  const agents = data.records.filter(record => record.scope === 'agents');
  return {version: MICRO_VERSION, review_mode: data.settings.microtrends_review_mode,
    model_families: Object.fromEntries(models.flatMap(model => [[model.name,model.family], ...model.versions.map(version => [version.label,model.family])])),
    group_above: 20, family_map: buildMicrotrends(data.records, true),
    coverage: {total: data.records.length, reviewed: data.records.filter(record => mappingState(record) === 'reviewed').length,
      agent_records: agents.length, named_agent_records: agents.filter(record => record.map!.links.some(link => link.model_named_in_source)).length}};
}
