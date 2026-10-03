import type { Pool, PoolClient } from 'pg';
import { contentSchema, type Content, type Source, type PostRow } from './schema.js';
import { hash, normalize, safetyFlags, similarity, canonicalUrl } from './rules.js';

const canonicalSameLink=(a:string,b:string)=>canonicalUrl(a)===canonicalUrl(b);

export async function transaction<T>(pool:Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function reserve(pool:Pool,bucket:string,limit:number) {
  const result=await pool.query(`INSERT INTO radar_private.usage VALUES($1,(now() AT TIME ZONE 'UTC')::date,1)
    ON CONFLICT(bucket,day) DO UPDATE SET count=radar_private.usage.count+1 WHERE radar_private.usage.count<$2 RETURNING count`,[bucket,limit]);
  if(!result.rows.length)throw new Error('daily-budget-exhausted');
}
export async function audit(db:Pool|PoolClient,id:string|null,revision:number|null,actor:string,action:string,reason:string,details:unknown={}) {
  await db.query(`INSERT INTO radar_private.decisions(post_id,revision,actor,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)`,[id,revision,actor,action,reason,details]);
}
export async function ingest(pool:Pool,source:Source,input:unknown) {
  const content=contentSchema.parse(input);
  if(content.platform!==source.platform)throw new Error('source-platform-mismatch');
  content.author.known_researcher=source.config.researcher_ids.includes(content.author.id);
  const posted=Date.parse(content.posted_at),now=Date.now();
  if(posted>now+300000||posted<now-source.retention_hours*3600000)return;
  // Engagement changes do not invalidate approval; text, context and identity do.
  const evidence={text:content.text,context:content.context,author_id:content.author.id,known_researcher:content.author.known_researcher,has_media:content.has_media,links:content.links,entities:content.entities,reshare:content.reshare,reshare_of:content.reshare_of};
  const contentHash=hash(JSON.stringify(evidence)),normal=hash(normalize(content.text));
  await transaction(pool,async db=>{
    await db.query('SELECT pg_advisory_xact_lock(725111)');
    const old=(await db.query<PostRow>('SELECT * FROM radar_private.posts WHERE platform=$1 AND external_id=$2 FOR UPDATE',[content.platform,content.external_id])).rows[0];
    // A reviewed removal remains a tombstone until retention cleanup, never auto-restored.
    if(old?.decision==='removed')return;
    if(old&&now-posted>48*3600000)content.engagement=old.content.engagement;
    if(old?.content_hash===contentHash){
      await db.query(`UPDATE radar_private.posts SET content=$2,checked_at=now(),display_until=LEAST(now()+interval '1 hour',retain_until),
        via=ARRAY(SELECT DISTINCT unnest(via || ARRAY[$3]::text[])) WHERE id=$1`,[old.id,content,content.via]);return;
    }
    let duplicate:string|null=null;
    const candidates=await db.query<PostRow>(`SELECT * FROM radar_private.posts WHERE id IS DISTINCT FROM $1 AND decision<>'removed'
      AND NOT is_duplicate AND posted_at>now()-interval '72 hours' AND retain_until>now() ORDER BY posted_at,id LIMIT 2000`,[old?.id||null]);
    if(content.reshare&&content.reshare_of)duplicate=(await db.query('SELECT id FROM radar_private.posts WHERE platform=$1 AND external_id=$2 AND decision<>\'removed\'',[content.platform,content.reshare_of])).rows[0]?.id||null;
    duplicate ||= candidates.rows.find(p=>p.normalized_hash===normal||canonicalSameLink(p.content.url,content.url)||similarity(p.content.text,content.text)>0.9)?.id||null;
    const flags=safetyFlags(content),state=flags.length?'held':'pending';
    if(old){
      await db.query(`UPDATE radar_private.clusters SET title=NULL,title_members='{}' WHERE id=$1`,[old.cluster_id]);
      await db.query(`UPDATE radar_private.posts SET content=$2,content_hash=$3,normalized_hash=$4,revision=revision+1,decision=$5,
        flags=$6,cleared_flags='{}',rules_override=false,rules=NULL,classification=NULL,embedding=NULL,embedding_model=NULL,cluster_id=NULL,record_id=NULL,primary_reviewed=false,
        duplicate_of=$7,is_duplicate=$8,checked_at=now(),display_until=LEAST(now()+interval '1 hour',retain_until),
        published_at=NULL,via=ARRAY(SELECT DISTINCT unnest(via || ARRAY[$9]::text[])) WHERE id=$1`,
      [old.id,content,contentHash,normal,state,flags,duplicate,Boolean(duplicate)||content.reshare,content.via]);
      await audit(db,old.id,old.revision+1,'collector','edited','Source content changed; approval invalidated');
    }else{
      const inserted=await db.query(`INSERT INTO radar_private.posts(source_id,platform,external_id,content,content_hash,normalized_hash,via,
        posted_at,checked_at,display_until,retain_until,decision,flags,duplicate_of,is_duplicate)
        VALUES($1,$2,$3,$4,$5,$6,ARRAY[$7]::text[],$8,now(),LEAST(now()+interval '1 hour',$9),$9,$10,$11,$12,$13) RETURNING id`,
      [source.id,content.platform,content.external_id,content,contentHash,normal,content.via,content.posted_at,
        new Date(posted+source.retention_hours*3600000),state,flags,duplicate,Boolean(duplicate)||content.reshare]);
      await audit(db,inserted.rows[0].id,1,'collector',state,flags.length?'Safety screening requires review':'Received from configured source');
    }
  });
}
export async function removePost(db:Pool|PoolClient,post:PostRow,actor:string,reason:string) {
  // Replies/quotes carry source context too. Erase that dependent material with
  // the original so a removed report cannot survive inside another classification.
  const affected=(await db.query<{id:string;revision:number}>(`WITH RECURSIVE dependent AS (
    SELECT id,platform,external_id,revision FROM radar_private.posts WHERE id=$1
    UNION SELECT p.id,p.platform,p.external_id,p.revision FROM radar_private.posts p JOIN dependent d
      ON p.platform=d.platform AND p.content->'context_ids' ? d.external_id WHERE p.decision<>'removed'
    ) SELECT id,revision FROM dependent`,[post.id])).rows;
  const ids=affected.map(p=>p.id);
  await db.query(`UPDATE radar_private.clusters SET title=NULL,title_members='{}',centroid=NULL WHERE id IN
    (SELECT cluster_id FROM radar_private.posts WHERE id=ANY($1::uuid[]))`,[ids]);
  await db.query('DELETE FROM radar_private.decisions WHERE post_id=ANY($1::uuid[])',[ids]);
  await db.query(`UPDATE radar_private.posts SET content='{}',decision='removed',classification=NULL,rules=NULL,embedding=NULL,
    flags='{}',content_hash='',normalized_hash='',record_id=NULL,primary_reviewed=false,revision=revision+1 WHERE id=ANY($1::uuid[])`,[ids]);
  for(const p of affected)await audit(db,p.id,p.revision+1,actor,'removed',p.id===post.id?reason:'Referenced source was removed');
}
export async function purge(pool:Pool) {
  await transaction(pool,async db=>{
    await db.query('SELECT pg_advisory_xact_lock(725111)');
    const expired=(await db.query<PostRow>(`SELECT id,revision FROM radar_private.posts WHERE retain_until<=now() AND decision<>'removed' LIMIT 100`)).rows;
    for(const p of expired)await removePost(db,p,'retention','Source retention expired');
    await db.query(`UPDATE radar_private.clusters c SET title=NULL,title_members='{}',centroid=NULL WHERE EXISTS
      (SELECT 1 FROM radar_private.posts p WHERE p.id=ANY(c.title_members) AND (p.retain_until<=now() OR p.display_until<=now()))`);
    await db.query("DELETE FROM radar_private.posts WHERE retain_until<=now() AND decision='removed'");
    await db.query(`DELETE FROM radar_private.clusters c WHERE NOT EXISTS(SELECT 1 FROM radar_private.posts p WHERE p.cluster_id=c.id)`);
    await db.query(`DELETE FROM radar_private.intake WHERE created_at<now()-interval '7 days'`);
    await db.query(`DELETE FROM radar_private.intake_limits WHERE hour<now()-interval '2 hours'`);
    await db.query(`DELETE FROM radar_private.usage WHERE day<(now() AT TIME ZONE 'UTC')::date-31`);
  });
}
