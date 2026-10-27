import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildApp} from '../dist/backend/application.js';
import {answerQuestion, InvalidAnswer, ModelUnavailable} from '../dist/backend/assistant.js';
import {archiveSession} from '../dist/backend/mcp-records.js';
import {askSchema, planSchema, wireSchema} from '../dist/backend/ask-models.js';

const incident=(id,d,scope='agents')=>({id,d,scope,t:`Synthetic incident ${id}`,org:'Synthetic Lab',
  when:d,set:'lab',kind:'synthetic',sum:'A fictional agent disclosed a fictional note.',tag:'fixture',
  src:'fixture',rca:'fixture',u:'fixture',cause:'fixture',clabel:'fixture',lesson:'fixture',loss:'none',
  impact:'Synthetic test only.',limits:'No real incident or customer data.',th:[],srcs:[]});
const snapshot={publication:{id:'1',published_at:'2026-10-01T00:00:00.000Z',source_hash:'synthetic'},
  repo:'synthetic/local',settings:{chart_start:'2026-01',chart_end:'2026-10',microtrends_as_of:'2026-10-01',
    methodology_version:'legacy-setting-v1'},records:[incident('fixture-a','2026-09-21'),incident('fixture-b','2026-10-01','other-ai')],
  microtrends:{},radar:{signals:[],clusters:[]}};
const plan=(extra={})=>({decision:'allow',interpretation:'Synthetic incidents in the requested interval',
  answer_kind:'listing',scope:'agents',start_date:'2026-09-21',end_date:'2026-09-27',clarification:'',...extra});
const selection={selection_mode:'selected_ids',record_ids:['fixture-a']};
const review={reason:'Synthetic grounding decision.',decision:'allow'};
const input=askSchema.parse({question:'Show the synthetic incidents.'});

function provider(outputs) {
  const calls=[];
  return {calls,async send(command){
    calls.push(command.input);
    assert.ok(outputs.length,'Unexpected physical model call');
    const next=outputs.shift();
    if(next instanceof Error)throw next;
    return {$metadata:{},stopReason:'tool_use',output:{message:{role:'assistant',content:[{
      toolUse:{toolUseId:`fixture-${calls.length}`,name:'return_result',input:next},
    }]}}};
  }};
}

async function application(t,options={}) {
  const app=await buildApp({pool:{},readSnapshot:async()=>structuredClone(snapshot),...options});
  t.after(()=>app.close());return app;
}

test('native Node Ask uses real MCP catalog bounds and cited evidence',async()=>{
  const model=provider([plan(),selection,review]);
  const result=await answerQuestion(input,snapshot,model);
  assert.equal(result.status,'answered');assert.deepEqual(result.record_ids,['fixture-a']);
  assert.match(result.text,/No real incident or customer data/);assert.equal(result.publication_id,'1');
  assert.equal(model.calls.length,3);
  const catalog=JSON.parse(model.calls[1].messages[0].content[0].text).catalogs[0];
  assert.equal(catalog.count,1);assert.equal(catalog.filters.start_date,'2026-09-21');
});

test('native MCP tools are read-only and cannot fetch unseen IDs',async t=>{
  const session=await archiveSession(snapshot);t.after(()=>session.close());
  const tools=(await session.client.listTools()).tools;
  assert.deepEqual(tools.map(t=>t.name).sort(),['get_archive_context','get_incident_details','list_incidents']);
  assert.ok(tools.every(t=>t.annotations.readOnlyHint&&t.annotations.openWorldHint===false));
  const unseen=await session.client.callTool({name:'get_incident_details',arguments:{record_ids:['fixture-b']}});
  assert.equal(unseen.isError,true);
  const badDate=await session.client.callTool({name:'list_incidents',arguments:{scope:'all',start_date:'yesterday',end_date:''}});
  assert.equal(badDate.isError,true);
});

for(const ids of [['invented'],['fixture-b'],['fixture-a','fixture-a']]) {
  test(`Node evidence selection rejects unsupported/duplicate IDs ${ids}`,async()=>{
    const model=provider([plan(),{...selection,record_ids:ids}]);
    await assert.rejects(answerQuestion(input,snapshot,model),InvalidAnswer);
    assert.equal(model.calls.length,2);
  });
}

test('whole-catalog selection preserves all matching IDs',async()=>{
  const model=provider([plan({scope:'all',start_date:'',end_date:''}),
    {selection_mode:'all_catalog',record_ids:[]},review]);
  const result=await answerQuestion(input,snapshot,model);
  assert.deepEqual(result.record_ids,['fixture-a','fixture-b']);assert.equal(result.matching_records,2);
});

test('scope rejection ends inference immediately',async()=>{
  const model=provider([plan({decision:'reject',interpretation:''})]);
  assert.equal((await answerQuestion(input,snapshot,model)).status,'rejected');
  assert.equal(model.calls.length,1);
});

test('no matches preserves requested bounds and accepted history',async()=>{
  const model=provider([plan(),{selection_mode:'selected_ids',record_ids:[]},review]);
  const result=await answerQuestion(input,snapshot,model);
  assert.equal(result.status,'no_matches');assert.match(result.context_turn.answer,/2026-09-21/);
  assert.match(result.context_turn.answer,/2026-09-27/);
  assert.ok(askSchema.safeParse({question:'What about the next period?',history:[result.context_turn]}).success);
});

test('coverage answers have no incident citations',async()=>{
  const model=provider([plan({answer_kind:'coverage'}),{intro:'This synthetic archive has two records.'},review]);
  const result=await answerQuestion(input,snapshot,model);
  assert.equal(result.answer_kind,'coverage');assert.deepEqual(result.record_ids,[]);
});

test('invalid model output and rejected grounding fail closed without repair',async()=>{
  for(const outputs of [[{unexpected:true}],[plan(),selection,{reason:'Unsupported',decision:'reject'}]]) {
    const count=outputs.length,model=provider(outputs);
    await assert.rejects(answerQuestion(input,snapshot,model),InvalidAnswer);assert.equal(model.calls.length,count);
  }
});

test('provider failure is classified without alternate inference',async()=>{
  const model=provider([new Error('synthetic transport failure')]);
  await assert.rejects(answerQuestion(input,snapshot,model),ModelUnavailable);assert.equal(model.calls.length,1);
});

test('strict model wire schema and local input limits remain distinct',()=>{
  const schema=wireSchema(planSchema);
  assert.deepEqual(new Set(schema.required),new Set(Object.keys(schema.properties)));
  assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.interpretation.maxLength,undefined);
  assert.equal(askSchema.safeParse({question:'x'.repeat(901)}).success,false);
  assert.equal(askSchema.safeParse({question:'x',history:Array(7).fill({})}).success,false);
});

test('actual Node HTTP route rejects bad input/private routes before inference',async t=>{
  let called=0;
  const app=await application(t,{answerQuestion:async()=>{called++;return {status:'rejected'};}});
  for(const [payload,status] of [[{question:' '},400],[{question:'x',history:[{}]},400],
    [{question:'x',history:[{question:'x',answer:'x',record_ids:['unknown']}]},400]]) {
    assert.equal((await app.inject({method:'POST',url:'/api/ask',payload})).statusCode,status);
  }
  assert.equal((await app.inject({method:'POST',url:'/api/ask',headers:{'content-type':'text/plain'},payload:'{}'})).statusCode,415);
  assert.equal((await app.inject({method:'POST',url:'/api/ask',headers:{origin:'https://elsewhere.example'},payload:{question:'x'}})).statusCode,403);
  assert.equal((await app.inject({url:'/',headers:{host:'elsewhere.example'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/ask',headers:{'content-type':'application/json'},payload:' '.repeat(262145)})).statusCode,413);
  for(const url of ['/backend/assistant.ts','/.env','/mcp','/package.json'])assert.equal((await app.inject({url})).statusCode,404);
  assert.equal(called,0);
});

test('disabled and over-capacity archives do not invoke the model',async t=>{
  let called=0;
  const answer=async()=>{called++;return {status:'rejected'};};
  const disabled=await application(t,{ask:{enabled:false},answerQuestion:answer});
  assert.equal((await disabled.inject({method:'POST',url:'/api/ask',payload:{question:'x'}})).statusCode,503);
  const full=await application(t,{readSnapshot:async()=>({...snapshot,records:Array.from({length:257},(_,i)=>incident(`fixture-${i}`,'2026-01-01'))}),answerQuestion:answer});
  assert.equal((await full.inject({method:'POST',url:'/api/ask',payload:{question:'x'}})).statusCode,503);
  assert.equal(called,0);
});

test('concurrency and hourly admission apply to real Node route',async t=>{
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  const app=await application(t,{ask:{concurrency:1,requestsPerHour:1},answerQuestion:async()=>{entered();await blocked;return {status:'rejected'};}});
  const first=app.inject({method:'POST',url:'/api/ask',payload:{question:'x'}}).then(r=>r);
  await started;
  assert.equal((await app.inject({method:'POST',url:'/api/ask',payload:{question:'x'}})).statusCode,429);
  release();assert.equal((await first).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/ask',payload:{question:'x'}})).statusCode,429);
});

test('model failures release capacity and subsequent request reads a new publication',async t=>{
  let count=0;
  const app=await application(t,{ask:{concurrency:1},readSnapshot:async()=>({...snapshot,publication:{...snapshot.publication,id:String(++count)}}),
    answerQuestion:async(_body,current)=>{if(count===1)throw new InvalidAnswer('synthetic');return {status:'answered',publication_id:current.publication.id};}});
  assert.equal((await app.inject({method:'POST',url:'/api/ask',payload:{question:'x'}})).statusCode,502);
  const next=await app.inject({method:'POST',url:'/api/ask',payload:{question:'x'}});
  assert.equal(next.statusCode,200);assert.equal(next.json().publication_id,'2');
});

test('real loopback HTTP POST runs native Ask and MCP without paid providers',async t=>{
  const model=provider([plan(),selection,review]);
  const app=await application(t,{answerQuestion:(body,current)=>answerQuestion(body,current,model)});
  const address=await app.listen({host:'127.0.0.1',port:0});
  const response=await fetch(address+'/api/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.status,'answered');assert.deepEqual(result.record_ids,['fixture-a']);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(model.calls.length,3);
});
