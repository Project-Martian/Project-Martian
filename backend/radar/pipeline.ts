import type { Pool } from 'pg';
import { classificationSchema, type PostRow, type Classification } from './schema.js';
import { rules, decision, cosine } from './rules.js';
import { transaction, audit } from './repository.js';
import { classify, embed, title, MODEL, EMBEDDING_MODEL, PROMPT_VERSION } from './model.js';

export async function vet(pool:Pool,progress:()=>Promise<void>) {
  const posts=(await pool.query<PostRow>(`SELECT p.* FROM radar_private.posts p JOIN radar_private.sources s ON s.id=p.source_id
    WHERE s.enabled AND p.decision='pending' AND p.retain_until>now() ORDER BY p.ingested_at LIMIT 20`)).rows;
  for(const post of posts){
    await progress();
    const scored=rules(post.content);
    try{
      let value:Classification|null=null,state:string;
      if(post.flags.length)state='held';
      else if(!post.rules_override&&(scored.drop||scored.score<0.3))state='dropped';
      else {
        if(process.env.MARTIAN_RADAR_INFERENCE_ENABLED!=='true')continue;
        value=await classify(pool,post.content);value.flags=value.flags.filter(f=>!post.cleared_flags.includes(f));state=decision(value);
      }
      await transaction(pool,async db=>{
        const result=await db.query(`UPDATE radar_private.posts SET rules=$3,classification=$4,decision=$5,flags=$6,
          is_duplicate=is_duplicate OR ($7 AND content->>'reshare_of' IS NOT NULL),
          published_at=CASE WHEN $5='published' THEN now() ELSE NULL END WHERE id=$1 AND revision=$2 AND decision='pending' RETURNING id`,
        [post.id,post.revision,scored,value,state,value?.flags||post.flags,value?.kind==='reshare of a report']);
        if(result.rowCount)await audit(db,post.id,post.revision,'pipeline',state,value?.reason||scored.drop||'Rules below publication threshold',
          {rules:scored,model:value?MODEL:null,prompt:value?PROMPT_VERSION:null,confidence:value?.confidence});
      });
    }catch{
      await transaction(pool,async db=>{
        const result=await db.query(`UPDATE radar_private.posts SET decision='processing-error',rules=$3 WHERE id=$1 AND revision=$2 AND decision='pending' RETURNING id`,[post.id,post.revision,scored]);
        if(result.rowCount)await audit(db,post.id,post.revision,'pipeline','processing-error','Classification failed; explicit reprocessing required');
      });
    }
  }
}
const overlap=(a:Classification,b:Classification)=>['attack_type','company','model','harness'].some(k=>a[k as keyof Classification]!==null&&a[k as keyof Classification]===b[k as keyof Classification]);
const average=(vectors:number[][])=>{
  const result=vectors[0].map((_,i)=>vectors.reduce((sum,v)=>sum+v[i],0)/vectors.length);
  const norm=Math.hypot(...result);if(!norm)throw new Error('zero-centroid');return result.map(x=>x/norm);
};
export async function cluster(pool:Pool,progress:()=>Promise<void>) {
  if(process.env.MARTIAN_RADAR_INFERENCE_ENABLED!=='true')return;
  const pending=(await pool.query<PostRow>(`SELECT * FROM radar_private.displayable_posts WHERE NOT is_duplicate
    AND cluster_id IS NULL AND classification IS NOT NULL ORDER BY posted_at,id LIMIT 20`)).rows;
  for(const post of pending){
    await progress();
    const claim=classificationSchema.parse(post.classification);
    const vector=await embed(pool,claim.claim);
    await transaction(pool,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(725111)');
      const fresh=await db.query(`SELECT id FROM radar_private.displayable_posts WHERE id=$1 AND revision=$2 AND cluster_id IS NULL`,[post.id,post.revision]);
      if(!fresh.rowCount)return;
      const candidates=(await db.query<PostRow>(`SELECT * FROM radar_private.displayable_posts WHERE NOT is_duplicate AND cluster_id IS NOT NULL
        AND embedding_model=$1 AND posted_at>now()-interval '72 hours' ORDER BY cluster_id,id LIMIT 5001`,[EMBEDDING_MODEL])).rows;
      if(candidates.length>5000)throw new Error('cluster-capacity-exceeded');
      const groups=new Map<string,PostRow[]>();for(const p of candidates){if(!groups.has(p.cluster_id!))groups.set(p.cluster_id!,[]);groups.get(p.cluster_id!)!.push(p);}
      let winner:string|null=null,best=0.82;
      for(const [id,rows] of groups){
        if(!rows.some(p=>p.classification&&overlap(claim,p.classification)))continue;
        const score=cosine(vector,average(rows.map(p=>p.embedding!)));
        if(score>=best){if(score>best||winner===null||id<winner){winner=id;best=score;}}
      }
      if(!winner)winner=(await db.query('INSERT INTO radar_private.clusters(embedding_model) VALUES($1) RETURNING id',[EMBEDDING_MODEL])).rows[0].id;
      await db.query('UPDATE radar_private.posts SET cluster_id=$3,embedding=$4,embedding_model=$5 WHERE id=$1 AND revision=$2',[post.id,post.revision,winner,vector,EMBEDDING_MODEL]);
      const rows=[...(groups.get(winner!)||[]),{...post,embedding:vector}];
      await db.query('UPDATE radar_private.clusters SET centroid=$2 WHERE id=$1',[winner,average(rows.map(p=>p.embedding!))]);
      const recent=rows.filter(p=>Date.now()-p.posted_at.getTime()<3600000);
      const accounts=new Map(recent.map(p=>[p.platform+':'+p.content.author.id,p.content.author.account_age_days]));
      const known=[...accounts.values()].filter((v):v is number=>v!==null);
      if(recent.length>=5&&accounts.size>=3&&known.length>=3&&known.filter(v=>v<30).length>known.length/2){
        for(const p of recent.filter(p=>!p.cleared_flags.includes('coordination-risk'))){
          await db.query(`UPDATE radar_private.posts SET decision='held',flags=ARRAY(SELECT DISTINCT unnest(flags||ARRAY['coordination-risk'])) WHERE id=$1`,[p.id]);
          await audit(db,p.id,p.revision,'pipeline','held','New-account same-claim spike requires review');
        }
        await db.query(`UPDATE radar_private.clusters SET title=NULL,title_members='{}' WHERE id=$1`,[winner]);
      }
    });
  }
  await pool.query(`UPDATE radar_private.posts p SET duplicate_of=original.id FROM radar_private.posts original
    WHERE p.content->>'reshare_of'=original.external_id AND p.platform=original.platform AND p.duplicate_of IS NULL
      AND p.id<>original.id AND p.is_duplicate AND original.decision<>'removed'`);
  await pool.query(`UPDATE radar_private.posts p SET cluster_id=original.cluster_id FROM radar_private.posts original
    WHERE p.duplicate_of=original.id AND p.cluster_id IS DISTINCT FROM original.cluster_id`);
  const needing=(await pool.query(`SELECT c.id,c.title,c.title_size,array_agg(p.id ORDER BY p.posted_at,p.id) AS members,
    array_agg(p.revision ORDER BY p.posted_at,p.id) AS revisions,
    array_agg(p.classification->>'claim' ORDER BY p.posted_at,p.id) AS claims
    FROM radar_private.clusters c JOIN radar_private.displayable_posts p ON p.cluster_id=c.id AND NOT p.is_duplicate
    GROUP BY c.id HAVING (c.title IS NULL AND c.title_members IS DISTINCT FROM array_agg(p.id ORDER BY p.posted_at,p.id))
      OR count(*)>=GREATEST(2,c.title_size*2) ORDER BY c.id LIMIT 10`)).rows;
  for(const c of needing){
    await progress();
    const result=await title(pool,c.claims);
    await transaction(pool,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(725111)');
      const current=(await db.query('SELECT id,revision FROM radar_private.displayable_posts WHERE cluster_id=$1 AND NOT is_duplicate ORDER BY posted_at,id',[c.id])).rows;
      if(JSON.stringify(current.map(p=>p.id))!==JSON.stringify(c.members)||JSON.stringify(current.map(p=>p.revision))!==JSON.stringify(c.revisions))return;
      await db.query('UPDATE radar_private.clusters SET title=$2,title_members=$3,title_size=$4 WHERE id=$1',[c.id,result.safe?result.title:null,c.members,c.members.length]);
    });
  }
}
