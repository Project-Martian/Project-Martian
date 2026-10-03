import { z } from 'zod';
import { taxonomy } from '../microtrends.js';

export const VERSION = 'radar-v1';
export const platforms = ['x','reddit','wild'] as const;
export const kinds = ['first-hand report','reshare of a report','analysis','question','primary source'] as const;
export const flagNames = ['personal-data','live-credentials','working-exploit','harassment','uninspected-media','coordination-risk'] as const;
export const httpsUrl = z.url().max(2048).refine(s=>{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port;});
const nullableCatalog = (values: string[]) => z.enum(values).nullable();
export const harnesses = [...new Set(taxonomy.models.map(m=>m.harness).filter((h):h is string=>Boolean(h)))];
export const classificationSchema = z.strictObject({
  relevant:z.boolean(),makes_sense:z.boolean(),kind:z.enum(kinds),claim:z.string().trim().min(1).max(800),
  attack_type:nullableCatalog(taxonomy.attacks.map(a=>a.name)),company:nullableCatalog(taxonomy.companies),
  model:nullableCatalog(taxonomy.models.filter(m=>m.kind==='named').map(m=>m.name)),harness:nullableCatalog(harnesses),
  evidence:z.enum(['none','link','screenshot','log','repo','CVE','primary source']),
  flags:z.array(z.enum(flagNames)).max(6),confidence:z.number().min(0).max(1),reason:z.string().trim().min(1).max(1000),
});
export type Classification=z.infer<typeof classificationSchema>;
export const contentSchema=z.strictObject({
  external_id:z.string().min(1).max(2048),platform:z.enum(platforms),url:httpsUrl,
  text:z.string().min(1).max(20000),context:z.string().max(12000).default(''),
  context_ids:z.array(z.string().min(1).max(2048)).max(10).default([]),
  author:z.strictObject({id:z.string().min(1).max(2048),name:z.string().min(1).max(200),handle:z.string().max(200),
    url:httpsUrl.nullable(),avatar:httpsUrl.nullable(),account_age_days:z.number().nonnegative().nullable(),known_researcher:z.boolean().default(false)}),
  posted_at:z.iso.datetime(),via:z.enum(['search','tag','feed']),
  engagement:z.number().int().nonnegative().nullable(),has_media:z.boolean().default(false),
  links:z.array(httpsUrl).max(100).default([]),
  entities:z.array(z.strictObject({start:z.number().int().nonnegative(),end:z.number().int().positive(),url:httpsUrl})).max(100).default([]),
  reshare:z.boolean().default(false),
  reshare_of:z.string().min(1).max(2048).nullable().default(null),
});
export type Content=z.infer<typeof contentSchema>;
const researchers=z.array(z.string().min(1).max(200)).max(200).default([]);
export const sourceSchema=z.strictObject({
  id:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),platform:z.enum(platforms),enabled:z.boolean(),
  approved_by:z.string().trim().min(1).max(120),retention_hours:z.number().int().min(1).max(720),
  requests_per_day:z.number().int().min(1).max(10000),
  config:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('x-search'),researcher_ids:researchers,query:z.string().min(1).max(512)}),
    z.strictObject({kind:z.literal('x-tags'),researcher_ids:researchers,user_id:z.string().regex(/^\d{1,30}$/)}),
    z.strictObject({kind:z.literal('reddit'),researcher_ids:researchers,subreddit:z.string().regex(/^[A-Za-z0-9_]{2,50}$/),listing:z.enum(['new','comments'])}),
    z.strictObject({kind:z.literal('rss'),researcher_ids:researchers,url:httpsUrl,publisher:z.string().min(1).max(200)})
  ])
}).refine(s=>s.platform===(s.config.kind.startsWith('x-')?'x':s.config.kind==='reddit'?'reddit':'wild'),{message:'Source platform and adapter must agree'});
export type Source=z.infer<typeof sourceSchema> & {cursor:Record<string,string>;last_attempt:Date|null};
export const querySchema=z.strictObject({source:z.enum(['all',...platforms,'linkedin']).default('all'),
  q:z.string().trim().max(120).default(''),cursor:z.string().max(300).optional(),limit:z.coerce.number().int().min(1).max(50).default(25)});
export const submissionSchema=z.strictObject({url:httpsUrl.refine(s=>/^(www\.)?linkedin\.com$/.test(new URL(s).hostname)),
  text:z.string().trim().min(12).max(5000),contact:z.string().trim().max(200).optional()});
export const reportSchema=z.strictObject({post_id:z.uuid(),reason:z.string().trim().min(5).max(1500),contact:z.string().trim().max(200).optional()});
export interface PostRow {id:string;source_id:string;external_id:string;platform:Content['platform'];content:Content;revision:number;content_hash:string;
  normalized_hash:string;flags:string[];cleared_flags:string[];rules_override:boolean;classification:Classification|null;decision:string;embedding:number[]|null;
  embedding_model:string|null;cluster_id:string|null;record_id:string|null;is_duplicate:boolean;primary_reviewed:boolean;
  posted_at:Date;checked_at:Date;retain_until:Date;display_until:Date;via:string[]}
