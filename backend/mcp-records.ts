import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { checkFilter, filterSchema, recordIds } from './ask-models.js';
import type { Snapshot } from './types.js';

const fields=(value:Record<string,unknown>,keys:string[])=>Object.fromEntries(keys.map(k=>[k,value[k]]));
const iso=(d:Date)=>d.toISOString().slice(0,10);
export function archiveContext(snapshot:Snapshot) {
  const todayString=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const today=new Date(todayString+'T00:00:00Z');
  const shift=(days:number)=>new Date(today.getTime()+days*86400000);
  const monday=shift(-((today.getUTCDay()+6)%7));
  const year=today.getUTCFullYear(),month=today.getUTCMonth(),previousEnd=new Date(Date.UTC(year,month,0));
  const dates=snapshot.records.map(r=>r.d).filter(Boolean).sort();
  return {today:todayString,weekday:today.toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long'}),timezone:'Asia/Kolkata',
    week_starts_on:'Monday',total_records:snapshot.records.length,agent_records:snapshot.records.filter(r=>r.scope==='agents').length,
    earliest_record_date:dates[0]||null,latest_record_date:dates.at(-1)||null,
    record_index:snapshot.records.map(r=>fields(r,['id','org','t','scope'])),live_news:false,
    archive_last_edited:null,publication_id:snapshot.publication.id,
    date_meaning:'Record sorting dates; not necessarily event occurrence dates. Preserve when and limits.',
    calendar_reference:{today:[todayString,todayString],yesterday:[iso(shift(-1)),iso(shift(-1))],
      this_week:[iso(monday),todayString],last_week:[iso(new Date(monday.getTime()-7*86400000)),iso(new Date(monday.getTime()-86400000))],
      last_7_days:[iso(shift(-6)),todayString],this_month:[iso(new Date(Date.UTC(year,month,1))),todayString],
      last_month:[iso(new Date(Date.UTC(previousEnd.getUTCFullYear(),previousEnd.getUTCMonth(),1))),iso(previousEnd)],
      this_quarter:[iso(new Date(Date.UTC(year,Math.floor(month/3)*3,1))),todayString],
      this_year:[`${year}-01-01`,todayString],last_year:[`${year-1}-01-01`,`${year-1}-12-31`]}};
}

export async function archiveSession(snapshot:Snapshot) {
  const server=new McpServer({name:'Project Martian public incident archive',version:'0.3.0'});
  const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  const respond=(value:Record<string,unknown>)=>({content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value});
  const seen=new Set<string>(),byId=new Map(snapshot.records.map(r=>[r.id,r]));
  server.registerTool('get_archive_context',{description:'Read the current Asia/Kolkata calendar, archive coverage and complete public record-title index. Record dates are not necessarily occurrence dates.',
    inputSchema:z.strictObject({}),annotations},async()=>respond(archiveContext(snapshot)));
  server.registerTool('list_incidents',{description:'List EVERY published incident in a scope and inclusive ISO date interval, newest first. Empty bounds are unrestricted. No search argument; the model interprets language. No truncation or ranking.',
    inputSchema:filterSchema,annotations},async args=>{
      const bounds=checkFilter(args);
      const hits=snapshot.records.filter(r=>(bounds.scope==='all'||r.scope==='agents')
        &&(!bounds.start_date||r.d&&r.d>=bounds.start_date)&&(!bounds.end_date||r.d&&r.d<=bounds.end_date));
      hits.forEach(r=>seen.add(r.id));
      return respond({filters:bounds,count:hits.length,complete:true,
        records:hits.map(r=>fields(r,['id','d','when','scope','org','kind','t','sum','tag','limits']))});
    });
  server.registerTool('get_incident_details',{description:'Read full published evidence for unique known IDs already read in a catalog during this request. Does not fetch source URLs. No writes or private data.',
    inputSchema:z.strictObject({record_ids:recordIds.min(1)}),annotations},async({record_ids})=>{
      if(new Set(record_ids).size!==record_ids.length||record_ids.some(id=>!seen.has(id)))throw new Error('IDs must belong to a catalog read in this request');
      return respond({records:record_ids.map(id=>byId.get(id))});
    });
  const client=new Client({name:'project-martian-ask',version:'0.3.0'});
  const [clientSide,serverSide]=InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  try {await client.connect(clientSide);}catch(error){await server.close();throw error;}
  return {client,close:async()=>{await client.close();await server.close();}};
}
