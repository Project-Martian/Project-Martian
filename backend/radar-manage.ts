import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createPool } from './database.js';
import { sourceSchema, classificationSchema, flagNames, type PostRow } from './radar/schema.js';
import { transaction, audit, removePost } from './radar/repository.js';
import { canonicalUrl } from './radar/rules.js';

const {positionals,values}=parseArgs({allowPositionals:true,options:{actor:{type:'string'},reason:{type:'string'},revision:{type:'string'},
  decision:{type:'string'},record:{type:'string'},role:{type:'string'},'password-file':{type:'string'},'clear-flags':{type:'string'},
  public:{type:'string'},intake:{type:'string'},'model-calls':{type:'string'},content:{type:'boolean'}}});
const [command,id]=positionals;
const pool=await createPool({max:1});
try{
  if(command==='queue'){
    const state=z.enum(['held','dropped','pending','processing-error','published']).parse(values.decision||'held');
    const result=await pool.query(`SELECT id,revision,platform,decision,flags,rules->>'score' AS rules_score,
      classification->>'confidence' AS confidence,ingested_at,display_until FROM radar_private.posts WHERE decision=$1 ORDER BY ingested_at LIMIT 100`,[state]);
    process.stdout.write(JSON.stringify(result.rows,null,2)+'\n');
  }else if(command==='inspect'){
    z.uuid().parse(id);
    const result=await pool.query('SELECT * FROM radar_private.posts WHERE id=$1',[id]);
    if(!result.rowCount)throw new Error('unknown-post');
    const {content,embedding,...metadata}=result.rows[0];
    const urls=new Set((content.links||[]).map(canonicalUrl));
    const citations=(await pool.query(`SELECT DISTINCT r.incident_id,s.url FROM public.incident_revisions r
      JOIN public.revision_sources s ON s.revision_id=r.id WHERE r.publication_id=(SELECT max(id) FROM public.publications)`)).rows;
    const suggested_records=[...new Set(citations.filter(c=>urls.has(canonicalUrl(c.url))).map(c=>c.incident_id))];
    const history=(await pool.query('SELECT revision,actor,action,reason,created_at FROM radar_private.decisions WHERE post_id=$1 ORDER BY id',[id])).rows;
    process.stdout.write(JSON.stringify({...metadata,history,suggested_records,...(values.content?{content}:{})},null,2)+'\n');
  }else if(command==='intake'){
    const result=await pool.query(`SELECT id,kind,created_at${values.content?',content':''} FROM radar_private.intake WHERE state='pending' ORDER BY created_at LIMIT 100`);
    process.stdout.write(JSON.stringify(result.rows,null,2)+'\n');
  }else if(command==='status'){
    const settings=(await pool.query('SELECT * FROM radar_private.control')).rows;
    const sources=(await pool.query('SELECT id,platform,enabled,last_attempt,last_success,last_error FROM radar_private.sources ORDER BY id')).rows;
    const usage=(await pool.query(`SELECT * FROM radar_private.usage WHERE day=(now() AT TIME ZONE 'UTC')::date`)).rows;
    const heartbeat=(await pool.query('SELECT * FROM radar_private.heartbeat')).rows;
    process.stdout.write(JSON.stringify({settings,sources,usage,heartbeat},null,2)+'\n');
  }else{
    const actor=z.string().trim().min(1).max(120).parse(values.actor),reason=z.string().trim().min(1).max(1500).parse(values.reason);
    await transaction(pool,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(725111)');
      if(command==='provision'){
        const role=z.enum(['worker','reviewer','intake','backup']).parse(values.role);
        const password=(await readFile(values['password-file']||'','utf8')).trim();
        if(password.length<32||password.length>200)throw new Error('password-length');
        const sql=(await db.query("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L',$1::text,$2::text)",['project_martian_radar_'+role,password])).rows[0].format;
        await db.query(sql);await audit(db,null,null,actor,'provision','Radar role provisioned: '+role);
      }else if(command==='sources'){
        const sources=z.array(sourceSchema).max(30).parse(JSON.parse(await readFile(id,'utf8')));
        if(new Set(sources.map(s=>s.id)).size!==sources.length)throw new Error('duplicate-source-id');
        for(const s of sources){
          const old=(await db.query('SELECT config,platform FROM radar_private.sources WHERE id=$1',[s.id])).rows[0];
          if(old&&(JSON.stringify(old.config)!==JSON.stringify(s.config)||old.platform!==s.platform)){
            // Source config is immutable under an ID. This prevents cursor/approval reuse across sources.
            const sorted=(o:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a],[b])=>a.localeCompare(b))));
            if(old.platform!==s.platform||sorted(old.config)!==sorted(s.config))throw new Error('use-new-id-for-changed-source');
          }
          await db.query(`INSERT INTO radar_private.sources(id,platform,enabled,config,approved_by,retention_hours,requests_per_day)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,approved_by=EXCLUDED.approved_by,
            retention_hours=EXCLUDED.retention_hours,requests_per_day=EXCLUDED.requests_per_day`,[s.id,s.platform,s.enabled,s.config,s.approved_by,s.retention_hours,s.requests_per_day]);
          await db.query(`UPDATE radar_private.posts SET retain_until=LEAST(retain_until,posted_at+$2*interval '1 hour') WHERE source_id=$1`,[s.id,s.retention_hours]);
        }
        await audit(db,null,null,actor,'sources',reason,{source_ids:sources.map(s=>s.id)});
      }else if(command==='controls'){
        for(const v of [values.public,values.intake])if(v!==undefined)z.enum(['on','off']).parse(v);
        const limit=values['model-calls']===undefined?null:z.coerce.number().int().min(1).max(10000).parse(values['model-calls']);
        if(values.public===undefined&&values.intake===undefined&&limit===null)throw new Error('supply-a-control');
        await db.query('INSERT INTO radar_private.control DEFAULT VALUES ON CONFLICT DO NOTHING');
        await db.query(`UPDATE radar_private.control SET public_enabled=COALESCE($1,public_enabled),intake_enabled=COALESCE($2,intake_enabled),
          model_calls_per_day=COALESCE($3,model_calls_per_day),updated_at=now()`,[values.public===undefined?null:values.public==='on',values.intake===undefined?null:values.intake==='on',limit]);
        await audit(db,null,null,actor,'controls',reason,{public:values.public,intake:values.intake,model_calls:limit});
      }else if(command==='resolve'){
        z.uuid().parse(id);
        const result=await db.query(`UPDATE radar_private.intake SET state='resolved',resolved_at=now(),resolved_by=$2,resolution=$3 WHERE id=$1 AND state='pending' RETURNING id`,[id,actor,reason]);
        if(!result.rowCount)throw new Error('unknown-or-resolved-receipt');
        await audit(db,null,null,actor,'resolve',reason,{receipt:id});
      }else if(command==='link-cluster'||command==='unlink-cluster'){
        z.uuid().parse(id);const record=command==='link-cluster'?z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).parse(values.record):null;
        if(record&&!(await db.query('SELECT 1 FROM public.incident_revisions WHERE incident_id=$1 AND publication_id=(SELECT max(id) FROM public.publications)',[record])).rowCount)throw new Error('record-not-in-current-publication');
        const result=await db.query('UPDATE radar_private.clusters SET record_id=$2 WHERE id=$1 RETURNING id',[id,record]);
        if(!result.rowCount)throw new Error('unknown-cluster');
        await audit(db,null,null,actor,command,reason,{cluster_id:id,record_id:record});
      }else{
        z.uuid().parse(id);const revision=z.coerce.number().int().positive().parse(values.revision);
        const post=(await db.query<PostRow>('SELECT * FROM radar_private.posts WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(!post||post.revision!==revision||post.decision==='removed')throw new Error('unknown-removed-or-stale-post');
        if(command==='remove')await removePost(db,post,actor,reason);
        else if(command==='reprocess'){
          const cleared=z.array(z.enum(flagNames)).parse(values['clear-flags']?values['clear-flags'].split(','):[]);
          await db.query(`UPDATE radar_private.posts SET decision='pending',revision=revision+1,classification=NULL,embedding=NULL,cluster_id=NULL,
            record_id=NULL,primary_reviewed=false,rules_override=true,cleared_flags=$2,flags=ARRAY(SELECT unnest(flags) EXCEPT SELECT unnest($2::text[])) WHERE id=$1`,[id,cleared]);
          await audit(db,id,revision+1,actor,command,reason,{cleared_flags:cleared});
        }else if(command==='approve'||command==='drop'||command==='primary'){
          if(command!=='drop'){
            classificationSchema.parse(post.classification);
            if(post.flags.length||post.display_until.getTime()<=Date.now()||post.retain_until.getTime()<=Date.now())throw new Error('unsafe-or-expired-post');
          }
          await db.query(`UPDATE radar_private.posts SET decision=$2,primary_reviewed=$3,published_at=CASE WHEN $2='published' THEN now() ELSE NULL END,revision=revision+1 WHERE id=$1`,
            [id,command==='drop'?'dropped':'published',command==='primary'||post.primary_reviewed]);
          await audit(db,id,revision+1,actor,command,reason);
        }else throw new Error('unknown-command');
        if(post.cluster_id)await db.query("UPDATE radar_private.clusters SET title=NULL,title_members='{}',centroid=NULL WHERE id=$1",[post.cluster_id]);
      }
    });
    process.stdout.write(JSON.stringify({ok:true,command})+'\n');
  }
}catch(error){
  // Schema/input/database errors can contain private content; never echo them.
  console.error('Radar command failed. Check command, permissions, input schema and current revision.');process.exitCode=1;
}finally{await pool.end();}
