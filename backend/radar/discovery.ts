import { z } from 'zod';
import type { Pool } from 'pg';
import { isIP } from 'node:net';
import { contentSchema, type Source, type PostRow } from './schema.js';
import { getJson, secret, SourceError } from './network.js';
import { canonicalUrl } from './rules.js';
import { ingest, reserve } from './repository.js';

const resultSchema=z.object({url:z.string(),title:z.string(),content:z.string(),published_date:z.string().nullable().optional()});
const excluded=['linkedin.com','reddit.com','x.com','twitter.com'];
function sourceUrl(value:string) {
  const u=new URL(value),host=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||u.username||u.password||u.port||isIP(host.replace(/^\[|\]$/g,''))||!host.includes('.')||
    /\.(localhost|local|internal|test|invalid)$/.test(host)||excluded.some(d=>host===d||host.endsWith('.'+d)))
    throw new SourceError('unsupported-discovery-url');
  return canonicalUrl(u.href);
}
async function tavily(pool:Pool,source:Source,path:'search'|'extract',body:unknown,credits:number) {
  const token=await secret('MARTIAN_RADAR_TAVILY_TOKEN_FILE');
  // Reserve basic-search/basic-extract credit units before each request. Failed
  // calls retain their allowance; no paid retries or automatic plan changes.
  for(let i=0;i<credits;i++)await reserve(pool,'source:'+source.id,source.requests_per_day);
  return getJson('https://api.tavily.com/'+path,{Authorization:'Bearer '+token,'Content-Type':'application/json'},JSON.stringify(body));
}
export async function discover(pool:Pool,source:Source) {
  if(source.config.kind!=='web-search')throw new SourceError('wrong-discovery-adapter');
  const index=Number(source.cursor.query_index||0)%source.config.queries.length;
  const response=z.object({results:z.array(resultSchema).max(20)}).parse(await tavily(pool,source,'search',{
    query:source.config.queries[index],search_depth:'basic',max_results:20,topic:'general',time_range:'m',
    include_published_date:true,filter_by_published_date:true,include_answer:false,include_raw_content:false,
    include_images:false,auto_parameters:false,exclude_domains:excluded,
  },1));
  const current=(await pool.query<PostRow>(`SELECT * FROM radar_private.posts WHERE source_id=$1 AND decision IN ('published','pending','held')
    AND retain_until>now() ORDER BY (decision='published') DESC,checked_at,id LIMIT 10`,[source.id])).rows;
  const candidates=new Map<string,{title:string;text:string;date:string}>();let undated=0;
  for(const row of response.results){
    let url:string;try{url=sourceUrl(row.url);}catch{continue;}
    const at=Date.parse(row.published_date||'');
    if(!Number.isFinite(at)||at>Date.now()+300000||at<Date.now()-source.retention_hours*3600000){undated++;continue;}
    candidates.set(url,{title:row.title.slice(0,300),text:row.content.length>600?row.content.slice(0,600).replace(/\s+\S*$/,'')+'…':row.content,date:new Date(at).toISOString()});
  }
  // Refresh existing signals as well as discover new ones. Sources not revalidated
  // expire automatically; extraction failure never renews display eligibility.
  const urls=[...new Set([...current.map(p=>p.content.url),...candidates.keys()])].slice(0,20);
  let extracted=0,failed=0;
  if(urls.length){
    const data=z.object({results:z.array(z.object({url:z.string(),raw_content:z.string()})).max(20),
      failed_results:z.array(z.object({url:z.string(),error:z.string()}))}).parse(await tavily(pool,source,'extract',
        {urls,extract_depth:'basic',format:'text',include_images:false,timeout:10},Math.ceil(urls.length/5)));
    const expected=new Set(urls),seen=new Set<string>();
    for(const item of data.results){
      const url=sourceUrl(item.url);
      if(!expected.has(url)||seen.has(url))throw new SourceError('unexpected-discovery-extraction');
      seen.add(url);if(item.raw_content.length<100){failed++;continue;}
      const old=current.find(p=>p.content.url===url),candidate=candidates.get(url);
      if(!old&&!candidate)throw new SourceError('unknown-discovery-source');
      const host=new URL(url).hostname;
      const content=old?{...old.content,context:item.raw_content.slice(0,8000)}:contentSchema.parse({
        external_id:url,platform:'wild',url,text:candidate!.title+'\n\n'+candidate!.text,
        context:item.raw_content.slice(0,8000),posted_at:candidate!.date,via:'search',engagement:null,
        author:{id:host,name:host,handle:host,url:new URL(url).origin,avatar:null,account_age_days:null,known_researcher:false},
        links:[url],entities:[],has_media:false,reshare:false,
      });
      await ingest(pool,source,content);extracted++;
    }
    failed+=urls.filter(url=>!seen.has(url)).length;
  }
  await pool.query(`UPDATE radar_private.sources SET cursor=$2,last_success=now(),last_complete=now(),last_error=$3 WHERE id=$1`,
    [source.id,{query_index:String((index+1)%source.config.queries.length)},failed?'partial-source-extraction':null]);
  console.log(JSON.stringify({event:'radar-discovery',source:source.id,query_index:index,search_results:response.results.length,
    dated_candidates:candidates.size,undated_or_outside_window:undated,extracted,failed}));
}
