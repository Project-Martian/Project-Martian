import { z } from 'zod';
export const MAX_RECORDS=64;
export const recordIds=z.array(z.string().min(1).max(80)).max(MAX_RECORDS);
export const turnSchema=z.strictObject({question:z.string().min(1).max(900),answer:z.string().max(1200),record_ids:recordIds});
export const askSchema=z.strictObject({question:z.string().trim().min(1).max(900),history:z.array(turnSchema).max(6).default([])});
export const filterSchema=z.strictObject({scope:z.enum(['agents','all']),start_date:z.string(),end_date:z.string()});
export function checkFilter(value:unknown) {
  const data=filterSchema.parse(value);
  for(const v of [data.start_date,data.end_date]) if(v && (!/^\d{4}-\d{2}-\d{2}$/.test(v)
    || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,10)!==v)) throw new Error('Invalid ISO date');
  if(data.start_date&&data.end_date&&data.start_date>data.end_date) throw new Error('Invalid date interval');
  return data;
}
export const sectionSchema=z.strictObject({heading:z.string().min(1).max(200),text:z.string().min(1).max(2000),record_ids:recordIds.min(1)});
// Match the previous RequestPlan contract: unused rejection fields default locally,
// while wireSchema still requires explicit fields in the model's output schema.
export const planSchema=z.strictObject({decision:z.enum(['allow','reject','clarification']),interpretation:z.string().max(900)
    .describe('Standalone question preserving the user subject and any stated period, resolved using history and the archive record index.').default(''),
  answer_kind:z.enum(['listing','explanation','coverage']).nullable()
    .describe('coverage for questions about the archive itself, its freshness, date coverage or capabilities; listing for incident inventories/counts; explanation for incident facts, causes, impact or lessons. Null for rejection.').default(null),
  scope:z.enum(['agents','all']).nullable().default(null),
  start_date:z.string().nullable().default(null),end_date:z.string().nullable().default(null),clarification:z.string().max(400).default('')});
export const selectionSchema=z.strictObject({selection_mode:z.enum(['all_catalog','selected_ids']),record_ids:recordIds});
export const explanationSchema=z.strictObject({sections:z.array(sectionSchema).min(1).max(8)});
export const coverageSchema=z.strictObject({intro:z.string().min(1).max(900)});
export const reviewSchema=z.strictObject({reason:z.string().max(1200),decision:z.enum(['allow','reject'])});
export const answerSchema=z.strictObject({status:z.enum(['answered','no_matches','clarification']),answer_kind:z.enum(['listing','explanation','coverage']),
  intro:z.string().min(1).max(1000),record_ids:recordIds,sections:z.array(sectionSchema).max(8)});
export type AskInput=z.infer<typeof askSchema>;
export type Answer=z.infer<typeof answerSchema>;
export type Catalog={filters:z.infer<typeof filterSchema>;records:Record<string,unknown>[];count:number;complete:true};

export function wireSchema(schema:z.ZodType): Record<string,unknown> {
  const value=z.toJSONSchema(schema) as Record<string,unknown>;
  // Bedrock's strict subset omits these limits; Zod still enforces them locally.
  function visit(input:unknown):unknown {
    if(Array.isArray(input))return input.map(visit);
    if(input && typeof input==='object') {
      const obj=input as Record<string,unknown>,out:Record<string,unknown>={};
      for(const [key,v] of Object.entries(obj)) if(!['$schema','minLength','maxLength','maxItems','default','title'].includes(key))out[key]=visit(v);
      const labels:Record<string,string>={minLength:'Minimum characters',maxLength:'Maximum characters',maxItems:'Maximum items'};
      const limits=Object.keys(labels).filter(k=>k in obj).map(k=>`${labels[k]}: ${obj[k]}.`);
      if(limits.length)out.description=[out.description||'',...limits].join(' ').trim();
      if(out.type==='object')out.required=Object.keys(out.properties as object);
      return out;
    }
    return input;
  }
  return visit(value) as Record<string,unknown>;
}
