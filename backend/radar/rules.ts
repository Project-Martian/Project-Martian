import { createHash } from 'node:crypto';
import { taxonomy } from '../microtrends.js';
import type { Classification, Content } from './schema.js';

export const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/g,u=>URL.canParse(u)?canonicalUrl(u):u).replace(/\s+/g,' ').trim();
export function canonicalUrl(value:string) {
  const u=new URL(value);u.hash='';
  for(const key of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid|ref_src|ref_url)$/i.test(key))u.searchParams.delete(key);
  u.searchParams.sort();return u.href;
}
export function similarity(a:string,b:string) {
  const grams=(s:string)=>{const words=normalize(s).split(' ');return new Set(words.slice(2).map((_,i)=>words.slice(i,i+3).join(' ')));};
  const x=grams(a),y=grams(b);if(!x.size||!y.size)return normalize(a)===normalize(b)?1:0;
  const intersection=[...x].filter(k=>y.has(k)).length;return intersection/(x.size+y.size-intersection);
}
export function safetyFlags(post:Content):string[] {
  const text=post.text+'\n'+post.context,flags:string[]=[];
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp_|github_pat_|sk-live-)[A-Za-z0-9_]{16,}/.test(text))flags.push('live-credentials');
  if(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text))flags.push('personal-data');
  if(post.has_media)flags.push('uninspected-media');
  return flags;
}
export function rules(post:Content) {
  const text=post.text+'\n'+post.context,lower=text.toLowerCase();
  const components:Record<string,number>={};
  if(!/\b(agent[s]?|llm[s]?|claude|gpt\w*|mcp|copilot|codex|chatgpt|ai|computer use)\b/i.test(text))return {version:'rules-v1',score:0,drop:'missing-agent-term',components};
  if(/\b(we(?:'re| are) hiring|apply (?:for this job|now)|airdrop|buy (?:our|this) token|giveaway entry)\b/i.test(text))return {version:'rules-v1',score:0,drop:'promotion',components};
  if(/\b(injection|leak\w*|delet\w*|escap\w*|credential\w*|exfil\w*|unauthori[sz]ed|rogue|poison\w*|jailbreak\w*|secur\w*|vulnerab\w*|attack\w*)\b/i.test(text))components.harm=0.4;
  const named=[...taxonomy.companies.filter(c=>!['Unknown','Open source'].includes(c)),...taxonomy.models.filter(m=>m.kind==='named'||m.kind==='harness').map(m=>m.name)];
  if(named.some(n=>lower.includes(n.toLowerCase())))components.named=0.2;
  if(post.links.length||post.has_media||/\bCVE-\d{4}-\d+\b/i.test(text))components.evidence=0.2;
  if(post.author.known_researcher)components.researcher=0.1;
  if(post.author.account_age_days!==null&&post.author.account_age_days<30&&!post.author.known_researcher)components.new_account=-0.3;
  if(post.text.trim().split(/\s+/).length<12&&!post.links.length&&!post.has_media)components.short=-0.2;
  return {version:'rules-v1',score:Math.round(Math.max(0,Math.min(1,Object.values(components).reduce((a,b)=>a+b,0)))*100)/100,drop:null,components};
}
export function decision(value:Classification) {
  if(value.flags.length)return 'held';
  if(!value.relevant||!value.makes_sense||value.confidence<0.5)return 'dropped';
  return value.confidence<0.8?'held':'published';
}
export function cosine(a:number[],b:number[]) {
  if(!a.length||a.length!==b.length)throw new Error('Embedding dimension mismatch');
  const dot=a.reduce((v,x,i)=>v+x*b[i],0),norm=Math.hypot(...a)*Math.hypot(...b);
  if(!norm)throw new Error('Empty embedding');return dot/norm;
}
