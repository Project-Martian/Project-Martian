import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createPool, readSnapshot } from '../database.js';
import { querySchema, submissionSchema, reportSchema, VERSION } from './schema.js';

const HOUR=3600000;
type Item={id:string;cluster_id:string|null;platform:string;posted_at:Date;display_until:Date;author_key:string;is_duplicate:boolean;
  primary_reviewed:boolean;evidence:string|null;company:string|null;model:string|null;harness:string|null;record_id:string|null;[key:string]:any};
export function stats(rows:Item[],now:number) {
  const all=rows.filter(p=>!p.is_duplicate),active=all.filter(p=>p.posted_at.getTime()>now-72*HOUR);
  const count=(start:number,end:number)=>all.filter(p=>p.posted_at.getTime()>start&&p.posted_at.getTime()<=end).length;
  const heatAt=(time:number)=>{
    const window=all.filter(p=>p.posted_at.getTime()>time-72*HOUR&&p.posted_at.getTime()<=time);
    const authors=new Set(window.map(p=>p.author_key)).size,platforms=new Set(window.map(p=>p.platform)).size;
    return count(time-6*HOUR,time)/(count(time-48*HOUR,time)/8+1)*(platforms>=3?1.5:platforms===2?1.3:1)*(authors<3?0.5:1)*
      (window.some(p=>p.primary_reviewed||p.evidence==='screenshot')?1.2:1);
  };
  const total24=count(now-24*HOUR,now),prior24=count(now-48*HOUR,now-24*HOUR),heat=heatAt(now);
  const latest=Math.max(...all.map(p=>p.posted_at.getTime())),first=all.slice().sort((a,b)=>a.posted_at.getTime()-b.posted_at.getTime()||a.id.localeCompare(b.id))[0];
  const platforms=Object.fromEntries(['x','reddit','linkedin','wild'].map(s=>[s,active.filter(p=>p.platform===s).length]));
  return {posts:active.length,authors:new Set(active.map(p=>p.author_key)).size,platforms,window_hours:72,
    first_seen:first?{at:first.posted_at,platform:first.platform}:null,last_seen:Number.isFinite(latest)?new Date(latest):null,
    velocity:{posts:total24,trend:total24>prior24?'rising':total24<prior24?'falling':'flat'},heat,
    heat_trend:heat>heatAt(now-6*HOUR)?'rising':heat<heatAt(now-6*HOUR)?'falling':'flat',
    state:now-latest>=72*HOUR?'faded':now-latest>=12*HOUR?'cooling':'emerging',
    hourly:Array.from({length:24},(_,i)=>{const end=Math.floor(now/HOUR)*HOUR-(22-i)*HOUR;return count(end-HOUR,Math.min(now,end));}),
    reshares:rows.filter(p=>p.is_duplicate).length,
    named:[...new Set(active.flatMap(p=>[p.company,p.model,p.harness].filter(Boolean)))],
    expires_at:rows.length?new Date(Math.min(...rows.map(p=>p.display_until.getTime()))):null};
}
const safePost=(p:Item)=>{const {author_key,is_duplicate,...rest}=p;return {...rest,status:p.record_id?'linked':'unverified'};};
async function read<T>(pool:Pool,fn:(db:PoolClient,now:number)=>Promise<T>) {
  const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const now=(await db.query('SELECT now() AS time')).rows[0].time.getTime();const value=await fn(db,now);await db.query('COMMIT');return value;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
async function detail(db:PoolClient,post:Item,now:number) {
  const rows:Item[]=post.cluster_id?(await db.query('SELECT * FROM radar_public.posts WHERE cluster_id=$1 ORDER BY posted_at,id LIMIT 501',[post.cluster_id])).rows:[post];
  if(rows.length>500)throw new Error('source-detail-capacity');
  const cluster=post.cluster_id?(await db.query('SELECT * FROM radar_public.clusters WHERE id=$1',[post.cluster_id])).rows[0]:null;
  const originals=rows.filter(p=>!p.is_duplicate),first=originals[0]?.id;
  const rank=(p:Item)=>p.primary_reviewed?0:p.id===first?1:p.kind==='first-hand report'?2:3;
  const sources=originals.sort((a,b)=>rank(a)-rank(b)||a.posted_at.getTime()-b.posted_at.getTime()||a.id.localeCompare(b.id))
    .map(p=>({id:p.id,kind:p.primary_reviewed?'Primary source':p.id===first?'First report':p.kind==='first-hand report'?'First-hand':p.kind,
      name:p.author_name,handle:p.author_handle,platform:p.platform,url:p.url,posted_at:p.posted_at}));
  return {post:safePost(post),cluster:cluster?{id:cluster.id,title:cluster.title,record_id:post.record_id}:null,...stats(rows,now),sources};
}
export async function registerRadar(app:FastifyInstance,pool:Pool) {
  const mode=z.enum(['sample','live']).parse(process.env.MARTIAN_RADAR_MODE||'sample');
  let intake:Pool|undefined,key:string|undefined;
  if(process.env.MARTIAN_RADAR_INTAKE_ENABLED==='true'){
    if(mode!=='live')throw new Error('Radar intake requires live mode');
    key=(await readFile(process.env.MARTIAN_RADAR_INTAKE_KEY_FILE||'','utf8')).trim();if(key.length<32)throw new Error('Intake key is too short');
    intake=await createPool({prefix:'RADAR_INTAKE_',max:1});app.addHook('onClose',async()=>{await intake!.end();});
    if(!(await intake.query("SELECT has_function_privilege(current_user,'radar_public.receive_intake(text,jsonb,text)','EXECUTE') AS allowed")).rows[0].allowed)throw new Error('Radar intake credential lacks insertion permission');
  }
  app.get('/api/radar',async(request,reply)=>{
    if(mode==='sample'){const snapshot=await readSnapshot(pool);return {version:VERSION,mode,publication:snapshot.publication,...snapshot.radar};}
    const query=querySchema.safeParse(request.query);if(!query.success)return reply.code(400).send({detail:'Invalid Radar filters.'});
    let cursor:{at:string;id:string}|null=null;
    if(query.data.cursor)try{cursor=z.strictObject({at:z.iso.datetime(),id:z.uuid()}).parse(JSON.parse(Buffer.from(query.data.cursor,'base64url').toString('utf8')));}catch{return reply.code(400).send({detail:'Invalid Radar cursor.'});}
    return read(pool,async(db,now)=>{
      const status=(await db.query('SELECT * FROM radar_public.status')).rows[0];
      const publication=(await db.query('SELECT id::text FROM public.publications ORDER BY id DESC LIMIT 1')).rows[0];
      const sources=(await db.query('SELECT * FROM radar_public.sources ORDER BY id')).rows;
      const result=await db.query<Item>(`SELECT * FROM radar_public.posts WHERE NOT is_duplicate AND ($1='all' OR platform=$1)
        AND ($2='' OR position(lower($2) in lower(text))>0) AND ($3::timestamptz IS NULL OR (posted_at,id)<($3::timestamptz,$4::uuid))
        ORDER BY posted_at DESC,id DESC LIMIT $5`,[query.data.source,query.data.q,cursor?.at||null,cursor?.id||null,query.data.limit+1]);
      const posts=result.rows.slice(0,query.data.limit),last=posts.at(-1);
      const metrics=(await db.query<Item>(`SELECT id,cluster_id,platform,posted_at,display_until,author_key,is_duplicate,primary_reviewed,evidence,company,model,harness,record_id
        FROM radar_public.posts WHERE cluster_id IS NOT NULL ORDER BY posted_at DESC LIMIT 5001`)).rows;
      if(metrics.length>5000)throw new Error('Radar aggregation capacity exceeded');
      const titles=(await db.query('SELECT * FROM radar_public.clusters')).rows;
      const clusters=titles.map(c=>({...c,...stats(metrics.filter(p=>p.cluster_id===c.id),now)}))
        .filter(c=>c.posts>=5&&c.authors>=3&&c.state!=='faded').sort((a,b)=>b.heat-a.heat||a.id.localeCompare(b.id)).slice(0,5);
      return {version:VERSION,mode,generated_at:new Date(now),publication_id:publication.id,published:status.public_enabled,
        intake_enabled:Boolean(intake)&&status.intake_enabled,sources,linkedin:{enabled:false,reason:'Public API feed is not enabled; submitted links are private tips.'},
        posts:posts.map(safePost),clusters,next_cursor:result.rows.length>query.data.limit&&last?Buffer.from(JSON.stringify({at:last.posted_at.toISOString(),id:last.id})).toString('base64url'):null};
    });
  });
  for(const kind of ['posts','clusters'] as const)app.get<{Params:{id:string}}>(`/api/radar/${kind}/:id`,async(request,reply)=>{
    if(mode!=='live'||!z.uuid().safeParse(request.params.id).success)return reply.code(404).send({detail:'Signal unavailable.'});
    const result=await read(pool,async(db,now)=>{
      const post=(await db.query<Item>(`SELECT * FROM radar_public.posts WHERE ${kind==='posts'?'id':'cluster_id'}=$1 AND NOT is_duplicate ORDER BY posted_at,id LIMIT 1`,[request.params.id])).rows[0];
      if(!post)return null;const publication=(await db.query('SELECT id::text FROM public.publications ORDER BY id DESC LIMIT 1')).rows[0];
      return {version:VERSION,publication_id:publication.id,generated_at:new Date(now),...await detail(db,post,now)};
    });
    return result||reply.code(404).send({detail:'Signal unavailable.'});
  });
  for(const kind of ['submission','report'] as const)app.post(`/api/radar/${kind}s`,{bodyLimit:20000},async(request,reply)=>{
    if(!intake)return reply.code(503).send({detail:'Radar intake is not enabled.'});
    let sameOrigin=false;try{const u=new URL(request.headers.origin||'');sameOrigin=u.host===request.headers.host&&['http:','https:'].includes(u.protocol);}catch{}
    if(!sameOrigin)return reply.code(403).send({detail:'Submit from the Project Martian website.'});
    if(request.headers['content-type']?.split(';')[0]!=='application/json')return reply.code(415).send({detail:'Send JSON.'});
    const parsed=(kind==='submission'?submissionSchema:reportSchema).safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({detail:'Check the link, text and contact fields.'});
    const client=createHmac('sha256',key!).update(new Date().toISOString().slice(0,13)+':'+request.ip).digest('hex');
    try{
      const result=await intake.query('SELECT radar_public.receive_intake($1,$2,$3) AS receipt',[kind,parsed.data,client]);
      return reply.code(202).send({receipt:result.rows[0].receipt,message:kind==='submission'?'Received for private review. This does not publish a post.':'Report received for review.'});
    }catch(error){
      if((error as {code?:string}).code==='P0001')return reply.code(429).send({detail:'Radar intake has reached its hourly limit.'});
      throw error;
    }
  });
}
