import { SaxesParser } from 'saxes';
import type { Pool } from 'pg';
import { contentSchema, type Content, type Source, type PostRow } from './schema.js';
import { getText, secret, SourceError } from './network.js';
import { reserve, ingest, transaction, removePost } from './repository.js';
import { reserveSpend, settleSpend } from './budget.js';
import { checkRateLimit, providerJson } from './rate-limit.js';

const links=(text:string)=>[...new Set(text.match(/https:\/\/[^\s<>"\])]+/g)||[])].filter(v=>{try{const u=new URL(v);return !u.username&&!u.password&&!u.port;}catch{return false;}}).slice(0,100);
const iso=(value:unknown)=>{const time=typeof value==='number'?value:Date.parse(String(value));if(!Number.isFinite(time))throw new SourceError('missing-source-date');return new Date(time).toISOString();};
const xParams={
  'post.fields':'created_at,public_metrics,entities,attachments,note_post,withheld',
  'user.fields':'name,username,profile_image_url,protected,verified,verified_type',
  expansions:'author_id'
};
function xPost(tweet:any,data:any,via:'search'|'tag'):Content|null {
  const author=data.includes?.users?.find((u:any)=>u.id===tweet.author_id);
  if(author?.verified!==true)return null;
  if(!author?.username||!author?.profile_image_url)throw new SourceError('missing-x-attribution');
  if(tweet.withheld||author.protected)throw new SourceError('x-source-unavailable');
  const history:string[]=tweet.edit_history_post_ids;
  if(!Array.isArray(history)||!history.length)throw new SourceError('missing-x-edit-history');
  if(history.at(-1)!==tweet.id)throw new SourceError('outdated-x-edit');
  const text=tweet.note_post?tweet.note_post.text:tweet.text;
  const entities=tweet.note_post?tweet.note_post.entities:tweet.entities;
  const urls=(entities?.urls||[]).map((e:any)=>e.expanded_url).filter((u:any)=>typeof u==='string'&&u.startsWith('https://'));
  return contentSchema.parse({external_id:history[0],platform:'x',url:`https://x.com/${author.username}/status/${tweet.id}`,
    text,context:'',edited:history.length>1,context_ids:[],
    posted_at:iso(tweet.created_at),via,engagement:tweet.public_metrics?.like_count??null,
    author:{id:author.id,name:author.name,handle:'@'+author.username,url:`https://x.com/${author.username}`,avatar:author.profile_image_url,
      account_age_days:null,known_researcher:false,verified:true},
    links:urls,has_media:Boolean(tweet.attachments?.media_keys?.length),reshare:false,reshare_of:null,
    entities:[...(entities?.urls||[]).map((e:any)=>({start:e.start,end:e.end,url:e.url,display:e.display_url})),
      ...(entities?.mentions||[]).map((e:any)=>({start:e.start,end:e.end,url:`https://x.com/${e.username}`})),
      ...(entities?.hashtags||[]).map((e:any)=>({start:e.start,end:e.end,url:`https://x.com/hashtag/${encodeURIComponent(e.tag)}`}))]
  });
}
async function xRequest(pool:Pool,source:Source,path:string,params:Record<string,string>) {
  await checkRateLimit(pool,'x');
  const token=await secret('MARTIAN_RADAR_X_TOKEN_FILE');
  // Post search/lookup only, with minimal author attribution in the same response.
  // Reserve the full response bound before the request. An explicitly approved
  // daily-resource meter reduces the estimate only after a complete response.
  const roots=params.ids?params.ids.split(',').length:Number(params.max_results);
  const reservation=await reserveSpend(pool,'x','x:'+path,{posts:roots,users:roots},undefined,{bucket:'source:'+source.id,limit:source.requests_per_day});
  const data=await providerJson(pool,'x','https://api.x.com/2/'+path+'?'+new URLSearchParams({...xParams,...params}),{Authorization:'Bearer '+token});
  if(data.data!==undefined&&!Array.isArray(data.data))throw new SourceError('invalid-x-response');
  const posts=[...(data.data||[]),...(data.includes?.posts||[])],users=data.includes?.users||[];
  await settleSpend(pool,reservation,{posts:posts.length,users:users.length},{posts:posts.map((p:any)=>p.id),users:users.map((u:any)=>u.id)});
  return data;
}
let redditToken:{token:string;until:number}|undefined;
async function redditHeaders(pool:Pool,source:Source) {
  const userAgent=process.env.MARTIAN_RADAR_REDDIT_USER_AGENT;
  if(!userAgent||!userAgent.includes('/u/'))throw new SourceError('reddit-user-agent-required');
  if(!redditToken||redditToken.until<=Date.now()){
    const id=await secret('MARTIAN_RADAR_REDDIT_CLIENT_ID_FILE'),password=await secret('MARTIAN_RADAR_REDDIT_CLIENT_SECRET_FILE');
    const refreshToken=await secret('MARTIAN_RADAR_REDDIT_REFRESH_TOKEN_FILE');
    await reserve(pool,'source:'+source.id,source.requests_per_day);
    const data=await providerJson(pool,'reddit','https://www.reddit.com/api/v1/access_token',{
      Authorization:'Basic '+Buffer.from(id+':'+password).toString('base64'),'User-Agent':userAgent,'Content-Type':'application/x-www-form-urlencoded'},
    new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken}).toString());
    if(typeof data.access_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<120)throw new SourceError('reddit-authorization-failed');
    redditToken={token:data.access_token,until:Date.now()+(data.expires_in-60)*1000};
  }
  return {Authorization:'Bearer '+redditToken.token,'User-Agent':userAgent};
}
async function redditRequest(pool:Pool,source:Source,path:string) {
  await checkRateLimit(pool,'reddit');
  const headers=await redditHeaders(pool,source);
  await reserve(pool,'source:'+source.id,source.requests_per_day);
  return providerJson(pool,'reddit','https://oauth.reddit.com/'+path,headers);
}
function redditPost(row:any):Content|null {
  const d=row.data;
  if(!d?.name||!d.author||d.author==='[deleted]'||['[removed]','[deleted]'].includes(d.body)||['[removed]','[deleted]'].includes(d.selftext))return null;
  const text=d.body===undefined?[d.title,d.selftext].filter(Boolean).join('\n\n'):d.body;
  return contentSchema.parse({external_id:d.name,platform:'reddit',url:'https://www.reddit.com'+d.permalink,text,
    context:d.link_title||'',posted_at:iso(d.created_utc*1000),via:'search',engagement:Math.max(0,d.score),
    author:{id:d.author_fullname||d.author,name:d.author,handle:'u/'+d.author,url:'https://www.reddit.com/user/'+encodeURIComponent(d.author),avatar:null,
      account_age_days:null,known_researcher:false},links:links(text+(d.url?' '+d.url:'')),
    has_media:Boolean(d.is_video||d.post_hint==='image'||d.is_gallery),entities:[],reshare:false});
}
export function rssPosts(xml:string,source:Source):Content[] {
  if(source.config.kind!=='rss')throw new SourceError('wrong-feed-adapter');
  const config=source.config,parser=new SaxesParser({xmlns:true}),entries:Record<string,string>[]=[],stack:{local:string;uri:string}[]=[];
  let entry:Record<string,string>|null=null,entryDepth=0;
  const feedNamespace=(uri:string)=>uri===''||uri==='http://www.w3.org/2005/Atom';
  const fields=new Set(['title','description','summary','content','link','published','pubDate','date','updated']);
  // Only a direct feed field owns text. Media titles/descriptions and author
  // metadata must not be concatenated into the article title or excerpt.
  const append=(text:string)=>{
    const field=stack[entryDepth];
    if(entry&&field&&fields.has(field.local)&&(feedNamespace(field.uri)||field.local==='date'&&field.uri==='http://purl.org/dc/elements/1.1/'))
      entry[field.local]=(entry[field.local]||'')+text;
  };
  parser.on('doctype',()=>{throw new SourceError('feed-doctype-not-allowed');});
  parser.on('opentag',tag=>{
    if(stack.length>=64)throw new SourceError('feed-too-deep');
    stack.push({local:tag.local,uri:tag.uri});
    if(!entry&&(tag.local==='item'||tag.local==='entry')&&feedNamespace(tag.uri)){entry={};entryDepth=stack.length;}
    if(entry&&stack.length===entryDepth+1&&tag.local==='link'&&feedNamespace(tag.uri)){
      const attrs=Object.fromEntries(Object.values(tag.attributes).map(a=>[a.local,a.value]));
      if(attrs.href&&(!attrs.rel||attrs.rel==='alternate'))entry.url=attrs.href;
    }
    if(stack.length>entryDepth+1)append(' ');
  });
  parser.on('text',append);parser.on('cdata',append);
  parser.on('closetag',()=>{if(entry&&stack.length===entryDepth){entries.push(entry);entry=null;}else if(stack.length>entryDepth+1)append(' ');stack.pop();});
  parser.write(xml).close();
  const strip=(s:string)=>s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  const posts:Content[]=[];
  for(const e of entries.slice(0,200)){
    const url=e.url||e.link,date=e.published||e.pubDate||e.date||e.updated;
    if(!url||!date||!e.title)continue;
    const parsed=contentSchema.safeParse({external_id:url.trim(),platform:'wild',url:url.trim(),text:strip([e.title,e.description||e.summary||e.content||''].join('\n')),
      context:'',author:{id:config.url,name:config.publisher,handle:new URL(config.url).hostname,url:config.url,avatar:null,account_age_days:null,known_researcher:false},
      posted_at:Number.isFinite(Date.parse(date))?new Date(date).toISOString():'',via:'feed',engagement:null,links:[url.trim()],entities:[],has_media:false,reshare:false});
    if(parsed.success)posts.push(parsed.data);
  }
  return posts;
}
export async function collect(pool:Pool,source:Source) {
  if(source.config.kind==='web-search')throw new SourceError('use-web-discovery-adapter');
  let cursor={...source.cursor};
  let complete=true;
  if(source.config.kind==='rss'){
    await reserve(pool,'source:'+source.id,source.requests_per_day);
    const posts=rssPosts(await getText(source.config.url),source);
    for(const post of posts)await ingest(pool,source,post);
  }else if(source.config.kind==='reddit'){
    const params=new URLSearchParams({limit:String(source.page_size),raw_json:'1'});
    if(cursor.after)params.set('after',cursor.after);
    const data=await redditRequest(pool,source,`r/${source.config.subreddit}/${source.config.listing}?${params}`);
    if(!Array.isArray(data.data?.children))throw new SourceError('invalid-reddit-listing');
    const cutoff=cursor.cutoff?Date.parse(cursor.cutoff):Date.now()-source.retention_hours*3600000;
    cursor.cutoff=new Date(cutoff).toISOString();
    let reached=false;
    for(const row of data.data.children){
      const date=iso(row.data?.created_utc*1000);
      if(!cursor.high_water||date>cursor.high_water)cursor.high_water=date;
      if(Date.parse(date)<cutoff){reached=true;break;}
      const post=redditPost(row);if(post)await ingest(pool,source,post);
    }
    if(!reached&&data.data.after){cursor.after=data.data.after;complete=false;}
    else {
      // An exhausted listing cannot prove coverage back to a previous checkpoint.
      if(!reached&&cursor.since_time)throw new SourceError('reddit-listing-gap');
      if(cursor.high_water)cursor.since_time=cursor.high_water;
      cursor=cursor.since_time?{since_time:cursor.since_time,cutoff:cursor.since_time}:{};
    }
  }else{
    const kind=source.config.kind,path=kind==='x-search'?'tweets/search/recent':`users/${source.config.user_id}/mentions`;
    const params:Record<string,string>={max_results:String(source.page_size)};
    if(source.config.kind==='x-search')params.query=source.config.query;
    const popular=source.config.kind==='x-search'&&source.config.selection==='popular';
    if(popular){cursor={};params.sort_order='relevancy';params.start_time=new Date(Date.now()-Math.min(source.retention_hours,24)*3600000).toISOString();}
    else if(cursor.since_id)params.since_id=cursor.since_id;
    else {
      cursor.start_time??=new Date(Date.now()-Math.min(source.retention_hours,167)*3600000).toISOString();
      params.start_time=cursor.start_time;
    }
    if(kind==='x-search'&&cursor.start_time&&Date.parse(cursor.start_time)<Date.now()-168*3600000)
      throw new SourceError('x-search-window-expired');
    if(cursor.next_token)params[kind==='x-search'?'next_token':'pagination_token']=cursor.next_token;
    const data=await xRequest(pool,source,path,params);
    if(!data.meta||data.errors?.length)throw new SourceError('incomplete-x-response');
    for(const tweet of data.data||[]){
      const originalId=tweet.edit_history_post_ids?.[0];
      const author=data.includes?.users?.find((u:any)=>u.id===tweet.author_id);
      if(tweet.withheld||author?.protected){
        await transaction(pool,async db=>{
          await db.query('SELECT pg_advisory_xact_lock(725111)');
          const old=(await db.query<PostRow>("SELECT * FROM radar_private.posts WHERE platform='x' AND external_id=$1 FOR UPDATE",[originalId])).rows[0];
          if(old&&old.decision!=='removed')await removePost(db,old,'collector','Source withdrawal observed');
        });
        continue;
      }
      if(author?.verified!==true||tweet.edit_history_post_ids?.at(-1)!==tweet.id)
        await pool.query("UPDATE radar_private.posts SET content_hash='',display_until=now() WHERE platform='x' AND external_id=$1",[originalId]);
      const post=xPost(tweet,data,kind==='x-tags'?'tag':'search');
      if(post)await ingest(pool,source,post);
    }
    const newest=data.meta.newest_id;
    if(!popular&&newest&&(!cursor.high_water||BigInt(newest)>BigInt(cursor.high_water)))cursor.high_water=newest;
    if(!popular&&data.meta.next_token){cursor.next_token=data.meta.next_token;complete=false;}
    else {if(cursor.high_water)cursor.since_id=cursor.high_water;delete cursor.high_water;delete cursor.next_token;delete cursor.start_time;}
  }
  await pool.query(`UPDATE radar_private.sources SET cursor=$2,last_success=now(),last_error=$3,
    last_complete=CASE WHEN $4 THEN now() ELSE last_complete END WHERE id=$1`,[source.id,cursor,complete?null:'collection-backlog',complete]);
}
export async function refresh(pool:Pool,source:Source) {
  if(source.platform==='wild')return; // Feed presence refreshes permitted RSS excerpts during collection.
  const rows=(await pool.query<PostRow>(`SELECT * FROM radar_private.posts WHERE source_id=$1 AND decision<>'removed'
    AND checked_at<now()-interval '20 minutes' AND retain_until>now()
    ORDER BY (decision='published') DESC,checked_at LIMIT $2`,[source.id,source.refresh_limit])).rows;
  if(!rows.length)return;
  const currentId=(p:PostRow)=>new URL(p.content.url).pathname.split('/').at(-1)!;
  let data=source.platform==='x'?await xRequest(pool,source,'tweets',{ids:rows.map(currentId).join(',')}):
    await redditRequest(pool,source,'api/info?raw_json=1&id='+rows.map(p=>p.external_id).join(','));
  if(source.platform==='x'){
    const latest:string[]=[...new Set<string>((data.data||[]).filter((p:any)=>p.edit_history_post_ids?.at(-1)!==p.id)
      .map((p:any)=>p.edit_history_post_ids?.at(-1)).filter(Boolean))];
    // Hide obsolete text before the separately metered latest-version lookup.
    for(const p of data.data||[])if(p.edit_history_post_ids?.at(-1)!==p.id)
      await pool.query("UPDATE radar_private.posts SET content_hash='',display_until=now() WHERE platform='x' AND external_id=$1",[p.edit_history_post_ids?.[0]]);
    if(latest.length){
      const updated=await xRequest(pool,source,'tweets',{ids:latest.join(',')});
      data={data:[...(data.data||[]),...(updated.data||[])],errors:[...(data.errors||[]),...(updated.errors||[])],
        includes:{users:[...(data.includes?.users||[]),...(updated.includes?.users||[])],posts:[...(data.includes?.posts||[]),...(updated.includes?.posts||[])]}};
    }
  }
  for(const post of rows){
    let content:Content|null=null,deleted=false;
    if(source.platform==='x'){
      const tweet=data.data?.find((t:any)=>t.edit_history_post_ids?.[0]===post.external_id&&t.edit_history_post_ids?.at(-1)===t.id);
      if(tweet){
        if(tweet.withheld||data.includes?.users?.find((u:any)=>u.id===tweet.author_id)?.protected)deleted=true;
        else {
          content=xPost(tweet,data,post.via.includes('tag')?'tag':'search');
          if(content)content.posted_at=post.posted_at.toISOString();
          else await pool.query("UPDATE radar_private.posts SET content_hash='',display_until=now() WHERE id=$1",[post.id]);
        }
      }else deleted=Boolean(data.errors?.some((e:any)=>e.resource_id===currentId(post)&&String(e.type).endsWith('/resource-not-found')));
    }else{
      const row=data.data?.children?.find((r:any)=>r.data?.name===post.external_id);
      if(row){content=redditPost(row);deleted=!content;}
    }
    if(content){
      if(Date.now()-post.posted_at.getTime()>48*3600000)content.engagement=post.content.engagement;
      await ingest(pool,source,content);
    }else if(deleted)await transaction(pool,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(725111)');
      const current=(await db.query<PostRow>('SELECT * FROM radar_private.posts WHERE id=$1 FOR UPDATE',[post.id])).rows[0];
      if(current)await removePost(db,current,'collector','Source deletion observed');
    });
  }
}
