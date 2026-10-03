import { SaxesParser } from 'saxes';
import type { Pool } from 'pg';
import { contentSchema, type Content, type Source, type PostRow } from './schema.js';
import { getJson, getText, secret, SourceError } from './network.js';
import { reserve, ingest, transaction, removePost } from './repository.js';

const links=(text:string)=>[...new Set(text.match(/https:\/\/[^\s<>"\])]+/g)||[])].filter(v=>{try{const u=new URL(v);return !u.username&&!u.password&&!u.port;}catch{return false;}}).slice(0,100);
const iso=(value:unknown)=>{const time=typeof value==='number'?value:Date.parse(String(value));if(!Number.isFinite(time))throw new SourceError('missing-source-date');return new Date(time).toISOString();};
const xParams={
  'tweet.fields':'author_id,created_at,public_metrics,entities,referenced_tweets,attachments,edit_history_tweet_ids,note_tweet',
  'user.fields':'name,username,profile_image_url,created_at',
  expansions:'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys','media.fields':'type'
};
function xPost(tweet:any,data:any,via:'search'|'tag'):Content {
  const author=data.includes?.users?.find((u:any)=>u.id===tweet.author_id);
  if(!author?.username||!author?.profile_image_url)throw new SourceError('missing-x-attribution');
  const history:string[]=tweet.edit_history_tweet_ids||[tweet.id];
  if(history.at(-1)!==tweet.id)throw new SourceError('outdated-x-edit');
  const text=tweet.note_tweet?tweet.note_tweet.text:tweet.text;
  const entities=tweet.note_tweet?tweet.note_tweet.entities:tweet.entities;
  const refs=tweet.referenced_tweets||[];
  const reshared=refs.find((r:any)=>r.type==='retweeted'||r.type==='quoted');
  const original=reshared&&data.includes?.tweets?.find((t:any)=>t.id===reshared.id);
  const context=refs.map((r:any)=>data.includes?.tweets?.find((t:any)=>t.id===r.id)?.text||'').filter(Boolean).join('\n').slice(0,12000);
  const urls=(entities?.urls||[]).map((e:any)=>e.expanded_url).filter((u:any)=>typeof u==='string'&&u.startsWith('https://'));
  return contentSchema.parse({external_id:history[0],platform:'x',url:`https://x.com/${author.username}/status/${tweet.id}`,
    text,context,context_ids:refs.map((r:any)=>data.includes?.tweets?.find((t:any)=>t.id===r.id)?.edit_history_tweet_ids?.[0]||r.id),
    posted_at:iso(tweet.created_at),via,engagement:tweet.public_metrics?.like_count??null,
    author:{id:author.id,name:author.name,handle:'@'+author.username,url:`https://x.com/${author.username}`,avatar:author.profile_image_url,
      account_age_days:author.created_at?Math.max(0,(Date.now()-Date.parse(author.created_at))/86400000):null,known_researcher:false},
    links:urls,has_media:Boolean(tweet.attachments?.media_keys?.length),reshare:reshared?.type==='retweeted',reshare_of:reshared?(original?.edit_history_tweet_ids?.[0]||reshared.id):null,
    entities:[...(entities?.urls||[]).map((e:any)=>({start:e.start,end:e.end,url:e.url})),
      ...(entities?.mentions||[]).map((e:any)=>({start:e.start,end:e.end,url:`https://x.com/${e.username}`})),
      ...(entities?.hashtags||[]).map((e:any)=>({start:e.start,end:e.end,url:`https://x.com/hashtag/${encodeURIComponent(e.tag)}`}))]
  });
}
async function xRequest(pool:Pool,source:Source,path:string,params:Record<string,string>) {
  await reserve(pool,'source:'+source.id,source.requests_per_day);
  return getJson('https://api.x.com/2/'+path+'?'+new URLSearchParams({...xParams,...params}),{Authorization:'Bearer '+await secret('MARTIAN_RADAR_X_TOKEN_FILE')});
}
let redditToken:{token:string;until:number}|undefined;
async function redditHeaders() {
  if(!redditToken||redditToken.until<=Date.now()){
    const id=await secret('MARTIAN_RADAR_REDDIT_CLIENT_ID_FILE'),password=await secret('MARTIAN_RADAR_REDDIT_CLIENT_SECRET_FILE');
    const data=await getJson('https://www.reddit.com/api/v1/access_token',{
      Authorization:'Basic '+Buffer.from(id+':'+password).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},
    new URLSearchParams({grant_type:'refresh_token',refresh_token:await secret('MARTIAN_RADAR_REDDIT_REFRESH_TOKEN_FILE')}).toString());
    if(typeof data.access_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<120)throw new SourceError('reddit-authorization-failed');
    redditToken={token:data.access_token,until:Date.now()+(data.expires_in-60)*1000};
  }
  const userAgent=process.env.MARTIAN_RADAR_REDDIT_USER_AGENT;
  if(!userAgent||!userAgent.includes('/u/'))throw new SourceError('reddit-user-agent-required');
  return {Authorization:'Bearer '+redditToken.token,'User-Agent':userAgent};
}
async function redditRequest(pool:Pool,source:Source,path:string) {
  await reserve(pool,'source:'+source.id,source.requests_per_day);
  return getJson('https://oauth.reddit.com/'+path,await redditHeaders());
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
  let cursor={...source.cursor};
  if(source.config.kind==='rss'){
    await reserve(pool,'source:'+source.id,source.requests_per_day);
    const posts=rssPosts(await getText(source.config.url),source);
    for(const post of posts)await ingest(pool,source,post);
  }else if(source.config.kind==='reddit'){
    const data=await redditRequest(pool,source,`r/${source.config.subreddit}/${source.config.listing}?limit=100&raw_json=1`);
    if(!Array.isArray(data.data?.children))throw new SourceError('invalid-reddit-listing');
    for(const row of data.data.children){const post=redditPost(row);if(post)await ingest(pool,source,post);}
    // Each run reads the newest 100; a full page is explicitly marked as capacity pressure.
    if(data.data.children.length===100)throw new SourceError('reddit-page-capacity');
  }else{
    const kind=source.config.kind,path=kind==='x-search'?'tweets/search/recent':`users/${source.config.user_id}/mentions`;
    const params:Record<string,string>={max_results:'100'};
    if(source.config.kind==='x-search')params.query=source.config.query;
    if(cursor.since_id)params.since_id=cursor.since_id;
    if(cursor.next_token)params[kind==='x-search'?'next_token':'pagination_token']=cursor.next_token;
    const data=await xRequest(pool,source,path,params);
    if(!data.meta||data.errors?.length)throw new SourceError('incomplete-x-response');
    for(const tweet of data.data||[]){
      for(const ref of tweet.referenced_tweets||[]){
        if(!['retweeted','quoted'].includes(ref.type))continue;
        const original=data.includes?.tweets?.find((t:any)=>t.id===ref.id);
        if(original&&data.includes?.users?.some((u:any)=>u.id===original.author_id)&&
          (!original.edit_history_tweet_ids||original.edit_history_tweet_ids.at(-1)===original.id))await ingest(pool,source,xPost(original,data,'search'));
      }
      await ingest(pool,source,xPost(tweet,data,kind==='x-tags'?'tag':'search'));
    }
    const newest=data.meta.newest_id;
    if(newest&&(!cursor.high_water||BigInt(newest)>BigInt(cursor.high_water)))cursor.high_water=newest;
    if(data.meta.next_token)cursor.next_token=data.meta.next_token;
    else {if(cursor.high_water)cursor.since_id=cursor.high_water;delete cursor.high_water;delete cursor.next_token;}
  }
  await pool.query(`UPDATE radar_private.sources SET cursor=$2,last_success=now(),last_error=NULL WHERE id=$1`,[source.id,cursor]);
}
export async function refresh(pool:Pool,source:Source) {
  if(source.platform==='wild')return; // Feed presence refreshes permitted RSS excerpts during collection.
  const rows=(await pool.query<PostRow>(`SELECT * FROM radar_private.posts WHERE source_id=$1 AND decision<>'removed'
    AND checked_at<now()-interval '20 minutes' AND retain_until>now() ORDER BY checked_at LIMIT 100`,[source.id])).rows;
  if(!rows.length)return;
  const currentId=(p:PostRow)=>new URL(p.content.url).pathname.split('/').at(-1)!;
  const data=source.platform==='x'?await xRequest(pool,source,'tweets',{ids:rows.map(currentId).join(',')}):
    await redditRequest(pool,source,'api/info?raw_json=1&id='+rows.map(p=>p.external_id).join(','));
  for(const post of rows){
    let content:Content|null=null,deleted=false;
    if(source.platform==='x'){
      const tweet=data.data?.find((t:any)=>t.id===post.external_id||t.edit_history_tweet_ids?.[0]===post.external_id);
      if(tweet){
        if(tweet.edit_history_tweet_ids?.at(-1)!==tweet.id){await pool.query('UPDATE radar_private.posts SET display_until=now() WHERE id=$1',[post.id]);continue;}
        content=xPost(tweet,data,post.via.includes('tag')?'tag':'search');
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
