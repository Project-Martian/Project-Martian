import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { createPool, readSnapshot, readImpactHistory, readMappingHistory, readContextHistory } from './database.js';
import { microtrendsMetadata } from './microtrends.js';
import { analytics } from './analytics.js';
import { narrativeAnalytics, comparisonAnalytics, comparisonQuery } from './context.js';
import { askSchema, MAX_RECORDS } from './ask-models.js';
import { answerQuestion, MODEL_ID, ModelUnavailable, InvalidAnswer } from './assistant.js';

const pool=await createPool();
const app=Fastify({bodyLimit:65536,trustProxy:false,logger:false});
const root=fileURLToPath(new URL('../../',import.meta.url));
const enabled=(process.env.MARTIAN_ASK_ENABLED||'true').toLowerCase()==='true';
const hosts=(process.env.MARTIAN_ASK_ALLOWED_HOSTS||'127.0.0.1,localhost,projectmartian.ai,www.projectmartian.ai').split(',').map(s=>s.trim());
const capacity=Number(process.env.MARTIAN_ASK_CONCURRENCY||2),hourly=Number(process.env.MARTIAN_ASK_REQUESTS_PER_HOUR||300);
if(!Number.isInteger(capacity)||capacity<1||!Number.isInteger(hourly)||hourly<1)throw new Error('Ask limits must be positive integers');
let active=0;
const admissions:number[]=[];

app.addHook('onRequest',async(request,reply)=>{
  const path=request.url.split('?')[0];
  if(!['/healthz','/readyz'].includes(path)) {
    const host=request.headers.host||'';
    let allowed=false;
    try{const url=new URL('http://'+host);allowed=!url.username&&!url.password&&hosts.includes(url.hostname);}catch{}
    if(!allowed)return reply.code(400).send({detail:'Invalid host header.'});
  }
  if(path==='/api/ask'&&request.method==='POST') {
    if(!enabled)return reply.code(503).send({detail:'Ask is not enabled on this deployment.'});
    const origin=request.headers.origin;
    if(origin) {
      let valid=false;
      try{const url=new URL(origin);valid=url.host===request.headers.host&&['https:','http:'].includes(url.protocol);}catch{}
      if(!valid)return reply.code(403).send({detail:'Use Ask on the Project Martian website.'});
    }
    if(request.headers['content-type']?.split(';')[0]!=='application/json')return reply.code(415).send({detail:'Send a JSON question.'});
  }
});
app.addHook('onSend',async(request,reply)=>{
  reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','strict-origin-when-cross-origin')
    .header('Cache-Control',request.url.startsWith('/api/')||request.url.startsWith('/data/')?'no-store':'no-cache');
});
app.setErrorHandler((error,request,reply)=>{
  const status=(error as {statusCode?:number}).statusCode;
  if(status===413)return reply.code(413).send({detail:'Question request is too large.'});
  if(status===400)return reply.code(400).send({detail:'Invalid JSON request.'});
  console.warn('Request failed:',error instanceof Error?error.name:'UnknownError');
  return reply.code(503).send({detail:'The service is unavailable. Please try again later.'});
});
app.get('/healthz',async()=>({status:'ok'}));
app.get('/readyz',async(_request,reply)=>{
  try {
    const result=await pool.query('SELECT id FROM publications ORDER BY id DESC LIMIT 1');
    if(!result.rows.length)throw new Error('No publication');
    return {status:'ready'};
  } catch{return reply.code(503).send({status:'unavailable'});}
});
app.get('/api/config',async()=>({enabled,provider:'Amazon Bedrock',model_id:MODEL_ID,
  model_name:MODEL_ID==='moonshotai.kimi-k2.5'?'Kimi K2.5':MODEL_ID}));
app.get('/api/archive',async()=>{const snapshot=await readSnapshot(pool);return {...snapshot,analytics:analytics(snapshot)};});
app.get('/api/incidents',async()=>{const snapshot=await readSnapshot(pool);return {publication:snapshot.publication,records:snapshot.records};});
app.get<{Params:{id:string}}>('/api/incidents/:id',async(request,reply)=>{
  const snapshot=await readSnapshot(pool),record=snapshot.records.find(r=>r.id===request.params.id);
  return record?{publication:snapshot.publication,record}:reply.code(404).send({detail:'Unknown incident.'});
});
app.get<{Params:{id:string}}>('/api/incidents/:id/impact-history',async(request,reply)=>{
  const history=await readImpactHistory(pool,request.params.id);
  return history?{id:request.params.id,history}:reply.code(404).send({detail:'Unknown incident.'});
});
app.get<{Params:{id:string}}>('/api/incidents/:id/mapping-history',async(request,reply)=>{
  const history=await readMappingHistory(pool,request.params.id);
  return history?{id:request.params.id,history}:reply.code(404).send({detail:'Unknown incident.'});
});
app.get('/api/trends',async()=>{const snapshot=await readSnapshot(pool);return {publication:snapshot.publication,...analytics(snapshot)};});
app.get<{Params:{id:string}}>('/api/incidents/:id/context-history',async(request,reply)=>{
  const history=await readContextHistory(pool,request.params.id);
  return history?{id:request.params.id,history}:reply.code(404).send({detail:'Unknown incident.'});
});
app.get('/api/narrative',async(_request,reply)=>{
  const snapshot=await readSnapshot(pool), narrative=narrativeAnalytics(snapshot);
  return narrative?{publication:snapshot.publication,...narrative}:reply.code(409).send({detail:'Disclosure methodology is not enabled for this publication.'});
});
app.get('/api/comparison',async(request,reply)=>{
  const filters=comparisonQuery.safeParse(request.query);
  if(!filters.success)return reply.code(400).send({detail:'Use known context, evidence and date-basis filters.'});
  const snapshot=await readSnapshot(pool), comparison=comparisonAnalytics(snapshot,filters.data);
  return comparison?{publication:snapshot.publication,...comparison}:reply.code(409).send({detail:'Comparison methodology is not enabled for this publication.'});
});
app.get('/api/impact-index',async(_request,reply)=>{
  const snapshot=await readSnapshot(pool),impact=analytics(snapshot).impact;
  return impact?{publication:snapshot.publication,...impact}:reply.code(409).send({detail:'This publication uses the legacy methodology.'});
});
app.get('/data/impact_index.json',async(_request,reply)=>{
  const snapshot=await readSnapshot(pool),impact=analytics(snapshot).impact;
  return impact?impact.series.map(row=>({...row,methodology_version:impact.version,review_mode:impact.review_mode,
    publication_id:snapshot.publication.id})):reply.code(409).send({detail:'This publication uses the legacy methodology.'});
});
app.get('/api/microtrends',async()=>{const snapshot=await readSnapshot(pool);return {publication:snapshot.publication,map:snapshot.microtrends,as_of:snapshot.settings.microtrends_as_of,...microtrendsMetadata(snapshot)};});
app.get('/api/radar',async()=>{const snapshot=await readSnapshot(pool);return {publication:snapshot.publication,...snapshot.radar};});
app.get('/data/records.json',async()=> (await readSnapshot(pool)).records);
app.post('/api/ask',async(request,reply)=>{
  const body=askSchema.safeParse(request.body);
  if(!body.success)return reply.code(400).send({detail:'Send a question of 1–900 characters and at most six valid history turns.'});
  if(active>=capacity)return reply.code(429).send({detail:'Ask is busy. Please try again shortly.'});
  active++;
  try {
    const snapshot=await readSnapshot(pool),ids=new Set(snapshot.records.map(r=>r.id));
    if(body.data.history.some(turn=>turn.record_ids.some(id=>!ids.has(id))))return reply.code(400).send({detail:'Send valid history record IDs.'});
    if(snapshot.records.length>MAX_RECORDS)return reply.code(503).send({detail:'Ask archive capacity requires an update. The publication remains available.'});
    const now=performance.now();
    while(admissions.length&&admissions[0]<=now-3600000)admissions.shift();
    if(admissions.length>=hourly)return reply.code(429).send({detail:'Ask has reached its hourly request limit.'});
    admissions.push(now);
    return await answerQuestion(body.data,snapshot);
  } catch(error) {
    if(error instanceof ModelUnavailable)return reply.code(503).send({detail:error.message});
    if(error instanceof InvalidAnswer || (error instanceof Error && error.name==='ZodError')) {
      console.warn('Ask response failed validation:',error instanceof InvalidAnswer?error.message:'Invalid schema');
      return reply.code(502).send({detail:'The AI response could not be validated. Please try again later.'});
    }
    throw error;
  } finally {active--;}
});

// Only explicitly public asset directories are mounted. Data comes from PostgreSQL.
for(const [index,directory] of ['css','js','assets'].entries())await app.register(staticFiles,{
  root:root+directory,prefix:'/'+directory+'/',decorateReply:index===0,index:false,dotfiles:'deny',
});
app.get('/',async(_request,reply)=>reply.sendFile('index.html',root));
app.get('/index.html',async(_request,reply)=>reply.sendFile('index.html',root));
app.get('/project-martian-standalone.html',async(_request,reply)=>reply.sendFile('project-martian-standalone.html',root));
app.setNotFoundHandler((_request,reply)=>reply.code(404).send({detail:'Not found.'}));
app.addHook('onClose',async()=>pool.end());
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void app.close();});
await app.listen({host:process.env.HOST||'127.0.0.1',port:Number(process.env.PORT||8766)});
console.log('Project Martian Node service listening');
