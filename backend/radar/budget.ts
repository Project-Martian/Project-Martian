import { z } from 'zod';
import type { Pool } from 'pg';
import { transaction, reserve } from './repository.js';
import { hash } from './rules.js';

const rate=z.number().int().positive().max(100000000);
export const pricingSchema=z.discriminatedUnion('provider',[
  z.strictObject({provider:z.literal('x'),post_microusd:rate,user_microusd:rate,deduplicate_utc_day:z.boolean().default(false)}),
  z.strictObject({provider:z.literal('bedrock'),model_id:z.string().min(1),embedding_model_id:z.string().min(1),
    input_million_microusd:rate,output_million_microusd:rate,embedding_million_microusd:rate})
]);
export const budgetSchema=z.strictObject({id:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  starts_at:z.iso.datetime(),ends_at:z.iso.datetime(),limit_microusd:z.number().int().min(1).max(1000000000),pricing:pricingSchema
}).refine(b=>b.starts_at<b.ends_at,{message:'Budget end must follow start'});
export type Usage={posts?:number;users?:number;input_tokens?:number;output_tokens?:number;embedding_tokens?:number};
type Pricing=z.infer<typeof pricingSchema>;
export class BudgetError extends Error {}
const count=(n:number|undefined)=>z.number().int().nonnegative().max(10000000).parse(n??0);
export function estimate(pricing:Pricing,usage:Usage) {
  if(pricing.provider==='x')return count(usage.posts)*pricing.post_microusd+count(usage.users)*pricing.user_microusd;
  return Math.ceil((count(usage.input_tokens)*pricing.input_million_microusd+
    count(usage.output_tokens)*pricing.output_million_microusd+count(usage.embedding_tokens)*pricing.embedding_million_microusd)/1000000);
}
export async function reserveSpend(pool:Pool,provider:'x'|'bedrock',operation:string,maximum:Usage,model?:string,quota?:{bucket:string;limit:number}) {
  return transaction(pool,async db=>{
    // Serializes admissions across processes, including future worker replicas.
    await db.query('SELECT pg_advisory_xact_lock(725113)');
    const rows=(await db.query(`SELECT * FROM radar_private.spend_budgets
      WHERE provider=$1 AND enabled AND starts_at<=now() AND ends_at>now()`,[provider])).rows;
    if(rows.length!==1)throw new BudgetError('spend-budget-unavailable');
    const b=rows[0],pricing=pricingSchema.parse(b.pricing);
    if((await db.query(`SELECT 1 FROM radar_private.spend_requests WHERE budget_id=$1
      AND estimated_microusd>reserved_microusd LIMIT 1`,[b.id])).rowCount)
      throw new BudgetError('spend-response-limit-unreviewed');
    if(pricing.provider!==provider)throw new BudgetError('spend-pricing-mismatch');
    if(pricing.provider==='bedrock'&&model!==pricing.model_id&&model!==pricing.embedding_model_id)
      throw new BudgetError('spend-model-mismatch');
    const reserved=estimate(pricing,maximum);
    const used=Number((await db.query(`SELECT COALESCE(sum(COALESCE(estimated_microusd,reserved_microusd)),0)::text AS used
      FROM radar_private.spend_requests WHERE budget_id=$1`,[b.id])).rows[0].used);
    if(used+reserved>Number(b.limit_microusd))throw new BudgetError('spend-budget-exhausted');
    if(quota)await reserve(db,quota.bucket,quota.limit);
    const request=(await db.query(`INSERT INTO radar_private.spend_requests(budget_id,operation,reserved_microusd)
      VALUES($1,$2,$3) RETURNING id,created_at`,[b.id,operation,reserved])).rows[0];
    return {id:request.id as string,created_at:request.created_at as Date,pricing,reserved};
  });
}
export async function settleSpend(pool:Pool,reservation:Awaited<ReturnType<typeof reserveSpend>>,usage:Usage,resources?:{posts:string[];users:string[]}) {
  const estimated=await transaction(pool,async db=>{
    await db.query('SELECT pg_advisory_xact_lock(725113)');
    let billed=usage;
    if(reservation.pricing.provider==='x'&&reservation.pricing.deduplicate_utc_day&&estimate(reservation.pricing,usage)<=reservation.reserved){
      if(!resources||resources.posts.length!==usage.posts||resources.users.length!==usage.users)
        throw new BudgetError('spend-resource-count-mismatch');
      const day=(await db.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0].day;
      // Across UTC midnight the provider's accounting day is ambiguous. Charge
      // the full response and do not assert that any resource was deduplicated.
      if(reservation.created_at.toISOString().slice(0,10)===day){
        const counts:{posts:number;users:number}={posts:0,users:0};
        for(const kind of ['posts','users'] as const){
          const ids=z.array(z.string().regex(/^\d{1,30}$/)).parse(resources[kind]);
          const inserted=await db.query(`INSERT INTO radar_private.spend_resources(day,kind,resource_hash,request_id)
            SELECT $1::date,$2,unnest($3::text[]),$4 ON CONFLICT DO NOTHING RETURNING resource_hash`,
          [day,kind,[...new Set(ids)].map(id=>hash(id)),reservation.id]);
          counts[kind]=inserted.rowCount||0;
        }
        billed=counts;
      }
    }
    const cost=estimate(reservation.pricing,billed);
    const result=await db.query(`UPDATE radar_private.spend_requests SET estimated_microusd=$2,usage=$3,settled_at=now()
      WHERE id=$1 AND settled_at IS NULL RETURNING id`,[reservation.id,cost,{...usage,estimated_billable:billed}]);
    if(!result.rowCount)throw new BudgetError('spend-request-already-settled');
    return cost;
  });
  // A provider exceeding the declared response bound is an error, never ignored.
  if(estimated>reservation.reserved)throw new BudgetError('spend-response-exceeded-reservation');
}
