// Explicitly requested acceptance checks. Run only against an empty, isolated local pilot DB.
// Model output is deterministic here; the separately recorded RSS pilot uses real providers.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import Fastify from 'fastify';
if(process.env.PGHOST!=='127.0.0.1'||!/^project_martian_radar_pilot_\d+$/.test(process.env.PGDATABASE||''))throw new Error('Requires an isolated local Radar pilot database');
const base={host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,max:2};
const pool=async(user,file)=>new Pool({...base,user,password:(await readFile(file,'utf8')).trim()});
const owner=await pool('project_martian_owner',process.env.PGPASSWORD_FILE);
const worker=await pool('project_martian_radar_worker',process.env.RADAR_PILOT_WORKER_PASSWORD_FILE);
const appPool=await pool('project_martian_app',process.env.RADAR_PILOT_APP_PASSWORD_FILE);
const intakePool=await pool('project_martian_radar_intake',process.env.RADAR_INTAKE_PGPASSWORD_FILE);
const baseline=(await owner.query('SELECT id,source_hash FROM publications ORDER BY id DESC LIMIT 1')).rows[0];
assert.equal((await owner.query('SELECT count(*)::int AS n FROM radar_private.posts')).rows[0].n,0,'Pilot starts without posts');
for(const table of ['sources','intake'])assert.equal((await owner.query('SELECT count(*)::int AS n FROM radar_private.'+table)).rows[0].n,0,'Pilot starts without '+table);
const classification={relevant:true,makes_sense:true,kind:'first-hand report',claim:'Local fixture: a fictional agent disclosed internal project notes.',attack_type:null,company:'OpenAI',model:null,harness:null,evidence:'link',flags:[],confidence:0.95,reason:'Local deterministic fixture; no real incident.'};
let modelFailure=false,embedding=[1,0],classificationCount=0,titleCount=0;
mock.module('../dist/backend/radar/model.js',{namedExports:{MODEL:'fixture-model',EMBEDDING_MODEL:'fixture-embedding',PROMPT_VERSION:'fixture-v1',
 classify:async()=>{classificationCount++;if(modelFailure)throw new Error('fixture model unavailable');return structuredClone(classification);},
 embed:async()=>embedding,title:async()=>{titleCount++;return {safe:true,title:'Local fixture: project note disclosure'};}}});
const {ingest,removePost,transaction,purge,reserve}=await import('../dist/backend/radar/repository.js');
const {vet,cluster}=await import('../dist/backend/radar/pipeline.js');
const {rules,decision}=await import('../dist/backend/radar/rules.js');
const {stats,registerRadar}=await import('../dist/backend/radar/api.js');
const {sourceSchema,contentSchema}=await import('../dist/backend/radar/schema.js');
const results=[];
const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name);};
const source=platform=>({...sourceSchema.parse({id:'fixture-'+platform,platform,enabled:true,approved_by:'isolated-local-acceptance',retention_hours:720,requests_per_day:5,
 config:platform==='x'?{kind:'x-search',query:'local fixture'}:platform==='reddit'?{kind:'reddit',subreddit:'LocalFixture',listing:'new'}:{kind:'rss',url:'https://example.com/fixture.xml',publisher:'Local Fixture Publisher'}}),cursor:{},last_attempt:null});
const sources=Object.fromEntries(['x','reddit','wild'].map(p=>[p,source(p)]));
const HOUR=3600000,now=Date.now();
const content=(id,platform='x',extra={})=>contentSchema.parse({external_id:id,platform,url:`https://example.com/fixture/${id}`,
 text:`Local fixture ${id}: an OpenAI agent leaked fictional internal notes during a synthetic security check. This is not a real incident.`,context:'',
 author:{id:'author-'+id,name:'Fixture '+id,handle:'fixture_'+id,url:'https://example.com/authors/'+id,avatar:null,account_age_days:500},
 posted_at:new Date(now-HOUR).toISOString(),via:'search',engagement:2,links:['https://example.com/evidence/'+id],...extra});
const row=async id=>(await owner.query('SELECT * FROM radar_private.posts WHERE external_id=$1',[id])).rows[0];
const add=async(id,platform='x',extra={})=>{const c=content(id,platform,extra);await ingest(worker,sources[platform],c);return row(id);};
let api;
try{
 await owner.query('INSERT INTO radar_private.control DEFAULT VALUES ON CONFLICT DO NOTHING');
 await owner.query('UPDATE radar_private.control SET public_enabled=true,intake_enabled=true,model_calls_per_day=10');
 for(const s of Object.values(sources))await owner.query('INSERT INTO radar_private.sources(id,platform,enabled,config,approved_by,retention_hours,requests_per_day) VALUES($1,$2,true,$3,$4,$5,$6)',[s.id,s.platform,s.config,s.approved_by,s.retention_hours,s.requests_per_day]);
 process.env.MARTIAN_RADAR_MODE='live';process.env.MARTIAN_RADAR_INFERENCE_ENABLED='true';process.env.MARTIAN_RADAR_INTAKE_ENABLED='true';
 api=Fastify({logger:false});await registerRadar(api,appPool);await api.ready();
 const get=async url=>{const r=await api.inject({url});assert.equal(r.statusCode,200,r.body);return r.json();};
 await check('RSS and Atom preserve direct title/excerpt fields without media metadata',async()=>{
  const {rssPosts}=await import('../dist/backend/radar/sources.js');
  const date=new Date().toISOString();
  const xml=`<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><title>Local fixture title</title><link>https://example.com/article</link><pubDate>${date}</pubDate><description>Exact public excerpt.</description><media:group><media:title>Do not append this title</media:title><media:description>Do not append this caption</media:description></media:group></item></channel></rss>`;
  const posts=rssPosts(xml,sources.wild);assert.equal(posts.length,1);assert.equal(posts[0].text,'Local fixture title Exact public excerpt.');
  const atom=`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom fixture</title><link href="https://example.com/atom"/><published>${date}</published><summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">One <b>clear</b> sentence.</div></summary><author><name>Author metadata</name></author></entry></feed>`;
  assert.equal(rssPosts(atom,sources.wild)[0].text,'Atom fixture One clear sentence.');
 });
 await check('moderation confidence boundaries and flags',async()=>{
  for(const [n,expected] of [[0.49,'dropped'],[0.5,'held'],[0.79,'held'],[0.8,'published']])assert.equal(decision({...classification,confidence:n}),expected);
  assert.equal(decision({...classification,flags:['personal-data']}),'held');
  assert.equal(decision({...classification,relevant:false}),'dropped');
  assert.equal(rules(content('short','x',{text:'agent hello',links:[]})).score,0);
 });
 await check('rules drop irrelevant posts; media hold bypasses the model',async()=>{
  await add('irrelevant','wild',{text:'Local fixture: a bread recipe with cinnamon and raisins.',links:[]});
  await add('media','x',{has_media:true});const calls=classificationCount;
  await vet(worker,async()=>{});assert.equal((await row('irrelevant')).decision,'dropped');assert.equal((await row('media')).decision,'held');assert.equal(classificationCount,calls);
 });
 await check('model failure stays private and requires reprocessing',async()=>{
  const p=await add('failure');modelFailure=true;await vet(worker,async()=>{});modelFailure=false;
  assert.equal((await row('failure')).decision,'processing-error');assert.equal((await api.inject({url:'/api/radar/posts/'+p.id})).statusCode,404);
 });
 await check('ingestion idempotency and same-claim clustering',async()=>{
  const texts=['Local fixture: an OpenAI agent exposed fictional meeting notes through an incorrect document permission.',
   'Synthetic observation only: internal notes became visible in a fictional agent session using OpenAI.',
   'A test account saw project notes it should not see in this local OpenAI agent fixture.',
   'In this invented scenario, OpenAI-powered agent permissions allowed another account to read a meeting summary.',
   'Fictional agent security report: restricted notes were returned to an unrelated local test identity.'];
  for(let i=0;i<5;i++)await add('cluster-'+i,['x','reddit','wild'][i%3],{text:texts[i],posted_at:new Date(now-(i+1)*HOUR/5).toISOString()});
  const p=await row('cluster-0');await ingest(worker,sources.x,p.content);assert.equal((await row('cluster-0')).revision,1);
  await vet(worker,async()=>{});await cluster(worker,async()=>{});
  const groups=(await owner.query("SELECT count(DISTINCT cluster_id)::int AS n FROM radar_private.posts WHERE external_id LIKE 'cluster-%' AND decision='published'")).rows[0];assert.equal(groups.n,1);
  const feed=await get('/api/radar');assert.equal(feed.clusters.length,1,JSON.stringify({posts:feed.posts.map(p=>({id:p.id,cluster:p.cluster_id})),rows:(await owner.query("SELECT external_id,decision,is_duplicate,cluster_id FROM radar_private.posts")).rows,titles:(await owner.query('SELECT title,title_members,title_size FROM radar_private.clusters')).rows}));assert.equal(feed.clusters[0].posts,5);assert.equal(feed.clusters[0].authors,5);assert.equal(titleCount,1);
  assert.equal(feed.clusters[0].platforms.x,2);assert.equal(feed.clusters[0].platforms.reddit,2);assert.equal(feed.clusters[0].platforms.wild,1);
  assert.ok(Math.abs(feed.clusters[0].heat-(5/(5/8+1)*1.5))<1e-10);
 });
 await check('cosine threshold and null taxonomy do not merge unrelated claims',async()=>{
  const p=await add('orthogonal','wild',{text:'Local fixture: a distinct fictional agent security finding with different evidence.'});
  await vet(worker,async()=>{});embedding=[0,1];await cluster(worker,async()=>{});embedding=[1,0];
  assert.notEqual((await row('orthogonal')).cluster_id,(await row('cluster-0')).cluster_id);
  const q=await add('no-taxonomy','wild',{text:'Separate synthetic agent security scenario without a named vendor or matching taxonomy.'});await vet(worker,async()=>{});
  await owner.query('UPDATE radar_private.posts SET classification=$2 WHERE id=$1',[q.id,{...classification,company:null}]);await cluster(worker,async()=>{});
  assert.notEqual((await row('no-taxonomy')).cluster_id,(await row('cluster-0')).cluster_id);
 });
 await check('reshares fold without increasing cluster activity',async()=>{
  const original=await row('cluster-0');await add('reshare','x',{reshare:true,reshare_of:original.external_id,text:'Local fixture: forwarding the synthetic agent security original without an independent report.'});
  await vet(worker,async()=>{});await cluster(worker,async()=>{});
  const d=await get('/api/radar/posts/'+original.id);assert.equal(d.posts,5);assert.equal(d.reshares,1);assert.equal(d.sources.length,5);
  const reshared=await row('reshare');assert.ok(!(await get('/api/radar')).posts.some(p=>p.id===reshared.id));
 });
 await check('provenance sorts reviewed primary first and preserves source attribution',async()=>{
  const primary=await row('cluster-2');await owner.query('UPDATE radar_private.posts SET primary_reviewed=true WHERE id=$1',[primary.id]);
  const original=await row('cluster-0'),d=await get('/api/radar/posts/'+original.id);
  assert.equal(d.sources[0].id,primary.id);assert.equal(d.sources[0].kind,'Primary source');
  assert.equal(d.post.author_name,original.content.author.name);assert.equal(d.post.author_handle,original.content.author.handle);assert.equal(d.post.url,original.content.url);assert.equal(d.post.text,original.content.text);
  assert.equal(d.post.posted_at,original.content.posted_at);assert.equal(d.post.author_key,undefined);assert.equal(d.post.classification,undefined);
  assert.ok(Math.abs(d.heat-(5/(5/8+1)*1.5*1.2))<1e-10);
 });
 if(process.env.RADAR_PILOT_UI_MARKER){
  await writeFile(process.env.RADAR_PILOT_UI_MARKER,JSON.stringify({post:(await row('cluster-0')).id})+'\n',{mode:0o600});
  console.log('Paused for local desktop verification; press Enter to continue.');
  await new Promise(resolve=>process.stdin.once('data',resolve));process.stdin.pause();
 }
 await check('source edits revoke public visibility and dependent titles',async()=>{
  const p=await row('cluster-0');await ingest(worker,sources.x,{...p.content,text:p.content.text+' Corrected synthetic account.'});
  assert.equal((await row('cluster-0')).revision,2);assert.equal((await row('cluster-0')).classification,null);
  assert.equal((await api.inject({url:'/api/radar/posts/'+p.id})).statusCode,404);assert.equal((await get('/api/radar')).clusters.length,0);
 });
 await check('expiry hides source text and known quote context without a worker',async()=>{
  const parent=await row('cluster-3');const quote=await add('quote','x',{context_ids:[parent.external_id],context:'Only invented source context.',text:'Synthetic quoted-context attribution case for an OpenAI agent security report.'});
  await vet(worker,async()=>{});assert.equal((await api.inject({url:'/api/radar/posts/'+quote.id})).statusCode,200);
  await owner.query("UPDATE radar_private.posts SET display_until=now()-interval '1 second' WHERE id=$1",[parent.id]);
  assert.equal((await api.inject({url:'/api/radar/posts/'+quote.id})).statusCode,404);
  assert.equal((await api.inject({url:'/api/radar/posts/'+parent.id})).statusCode,404);
 });
 await check('removal erases raw/model material and dependent quotes; tombstones prevent reimport',async()=>{
  const p=await row('cluster-3');await transaction(worker,db=>removePost(db,p,'pilot','Remove local fixture'));
  for(const id of ['cluster-3','quote']){const r=await row(id);assert.equal(r.decision,'removed');assert.deepEqual(r.content,{});assert.equal(r.classification,null);assert.equal(r.embedding,null);}
  await ingest(worker,sources.x,p.content);assert.equal((await row('cluster-3')).decision,'removed');
 });
 await check('intake validates origin/payload; returns private receipts and enforces quotas',async()=>{
  const body={url:'https://www.linkedin.com/posts/local-fixture',text:'Local acceptance fixture only. Do not publish.'};
  const send=(headers={},payload=body)=>api.inject({method:'POST',url:'/api/radar/submissions',headers:{host:'localhost',origin:'http://localhost','content-type':'application/json',...headers},payload});
  assert.equal((await send({origin:'https://example.com'})).statusCode,403);
  assert.equal((await send({}, {...body,url:'https://example.com/not-linkedin'})).statusCode,400);
  for(let i=0;i<10;i++){const r=await send();assert.equal(r.statusCode,202);assert.ok(r.json().receipt);}
  assert.equal((await send()).statusCode,429);
  await owner.query("UPDATE radar_private.intake_limits SET count=200 WHERE key='global'");
  await assert.rejects(intakePool.query('SELECT radar_public.receive_intake($1,$2,$3)',['submission',body,'b'.repeat(64)]),e=>e.code==='P0001');
  await owner.query('UPDATE radar_private.control SET intake_enabled=false');
  await assert.rejects(intakePool.query('SELECT radar_public.receive_intake($1,$2,$3)',['submission',body,'c'.repeat(64)]),e=>e.code==='55000');
  await assert.rejects(intakePool.query('SELECT * FROM radar_private.intake'),e=>e.code==='42501');
  await assert.rejects(appPool.query('SELECT * FROM radar_private.posts'),e=>e.code==='42501');
  await assert.rejects(worker.query('UPDATE radar_private.control SET public_enabled=false'),e=>e.code==='42501');
 });
 await check('retention purges source/queue material and leaves incident publication unchanged',async()=>{
  await owner.query("UPDATE radar_private.posts SET retain_until=posted_at+interval '1 second'");
  await owner.query("UPDATE radar_private.intake SET created_at=now()-interval '8 days'");
  await purge(worker);assert.equal((await owner.query('SELECT count(*)::int AS n FROM radar_private.posts')).rows[0].n,0);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM radar_private.intake')).rows[0].n,0);
  assert.deepEqual((await owner.query('SELECT id,source_hash FROM publications ORDER BY id DESC LIMIT 1')).rows[0],baseline);
 });
 await check('daily request budget is persistent and bounded',async()=>{await reserve(worker,'fixture-budget',1);await assert.rejects(reserve(worker,'fixture-budget',1));});
 const report={at:new Date().toISOString(),type:'isolated deterministic acceptance; provider APIs and model quality not established',database:base.database,checks:results,model_calls:'mocked',publication:baseline};
 if(process.env.RADAR_PILOT_REPORT)await writeFile(process.env.RADAR_PILOT_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});
}finally{
 if(api)await api.close();
 await owner.query("DELETE FROM radar_private.posts WHERE source_id LIKE 'fixture-%'");
 await owner.query("DELETE FROM radar_private.clusters WHERE embedding_model='fixture-embedding'");
 await owner.query("DELETE FROM radar_private.decisions WHERE actor IN ('collector','pipeline','pilot','retention')");
 await owner.query("DELETE FROM radar_private.sources WHERE id LIKE 'fixture-%'");
 await owner.query("DELETE FROM radar_private.usage WHERE bucket='fixture-budget'");
 await owner.query('DELETE FROM radar_private.intake_limits');
 await owner.query('UPDATE radar_private.control SET public_enabled=false,intake_enabled=false');
 await Promise.all([owner,worker,appPool,intakePool].map(p=>p.end()));mock.restoreAll();
}
