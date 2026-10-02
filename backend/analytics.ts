import type { Incident, Publication } from './types.js';
import { microtrendsMetadata } from './microtrends.js';
import { impactIndex } from './impact.js';

// Setting-based helpers remain for Narrative and Comparison.
export const isReal = (r: Incident) => /real-world|third-party|reported/i.test(r.set);
export function sourceType(url: string) {
  const host=(url.match(/^https?:\/\/([^/]+)/)||[,''])[1];
  if (/openai\.com|anthropic\.com|huggingface\.co|rubygems\.org|deepmind|google\.com\/blog|meta\.com/.test(host)) return 'Lab & vendor';
  if (/\.gov|gov\.uk|gov\.au|aisi/.test(host)) return 'Government';
  if (/transluce|collusion\.wiki|invariantlabs|arxiv|\.edu/.test(host)) return 'Research';
  if (/saastr|x\.com|twitter|reddit|substack|medium/.test(host)) return 'Social & blogs';
  return 'News';
}
export function analytics(data: Publication) {
  const agents=data.records.filter(r=>r.scope==='agents'),dated=agents.filter(r=>r.d);
  const months: [number,number][]=[];
  const [startYear,startMonth]=data.settings.chart_start.split('-').map(Number);
  for(let year=startYear,month=startMonth-1;;) {
    const key=`${year}-${String(month+1).padStart(2,'0')}`;
    if(key>data.settings.chart_end) break;
    if(months.length>=600) throw new Error('Display interval exceeds 600 months');
    months.push([year,month]); month++;if(month>11){month=0;year++;}
  }
  if(months.length<12) throw new Error('Legacy chart requires at least twelve months');
  const mkey=(y:number,m:number)=>`${y}-${String(m+1).padStart(2,'0')}`;
  // Explicit legacy version support keeps existing publications reproducible.
  const impact=data.settings.methodology_version==='impact-v1'?impactIndex(data,months):null;
  const raw=impact?impact.series.map(row=>row.monthly_points):months.map(([y,m])=>dated.filter(r=>r.d.startsWith(mkey(y,m))).reduce((sum,r)=>sum+(/real-world/i.test(r.set)?3:isReal(r)?2:1),0));
  const roll=impact?impact.series.map(row=>row.points):raw.map((_,i)=>raw.slice(Math.max(0,i-2),i+1).reduce((a,b)=>a+b,0));
  const mx=Math.max(...roll),idx=impact?impact.series.map(row=>row.index):roll.map(v=>mx?Math.round(v/mx*100):0);
  const lastV=idx.at(-1)!,m6=idx.slice(-6).reduce((a,b)=>a+b,0)/6,p6=idx.slice(-12,-6).reduce((a,b)=>a+b,0)/6;
  const slope=Math.max(-3,Math.min(6,(m6-p6)/6));
  const fut=Array.from({length:6},(_,i)=>{const c=Math.max(0,Math.min(100,Math.round(lastV+(i+1)*slope)));
    return {c,lo:Math.max(0,c-8-i*5),hi:Math.min(100,c+8+i*5),lo2:Math.max(0,c-4-i*2.5),hi2:Math.min(100,c+4+i*2.5)};});
  const futMonths:[number,number][]=[];
  let [y,m]=months.at(-1)!;
  for(let i=0;i<6;i++){m++;if(m>11){m=0;y++;}futMonths.push([y,m]);}
  const cumReal=months.map(([y,m])=>dated.filter(r=>r.d<=mkey(y,m)+'-31'&&isReal(r)).length);
  const cumLab=months.map(([y,m])=>dated.filter(r=>r.d<=mkey(y,m)+'-31'&&!isReal(r)).length);
  const ir=months.map(([y,m])=>dated.filter(r=>r.d.startsWith(mkey(y,m))&&isReal(r)).length);
  const rr=ir.map((_,i)=>ir.slice(Math.max(0,i-2),i+1).reduce((a,b)=>a+b,0));
  const realOnly=impact?impact.series.map(row=>row.real_world_index):rr.map(v=>v/(Math.max(...rr)||1)*100*.8);
  const count:Record<string,number>={};dated.forEach(r=>{const t=sourceType(r.u);count[t]=(count[t]||0)+1;});
  const narrative=Object.entries(count).sort((a,b)=>b[1]-a[1]);
  const h1=raw.slice(-6).reduce((a,b)=>a+b,0),h0=raw.slice(-12,-6).reduce((a,b)=>a+b,0);
  const mean=raw.reduce((a,b)=>a+b,0)/raw.length,sd=Math.sqrt(raw.reduce((a,b)=>a+(b-mean)**2,0)/raw.length),cv=sd/(mean||1);
  const training=agents.filter(r=>/training|deployment|research|evaluation|experiment/i.test(r.set)).length;
  const rca:Record<string,number>={Full:0,Partial:0,None:0};
  agents.forEach(r=>{if(/causal/i.test(r.rca))rca.Full++;else if(/partial/i.test(r.rca))rca.Partial++;else rca.None++;});
  const y26=agents.filter(r=>r.d.startsWith('2026')).length,y25=agents.filter(r=>r.d.startsWith('2025')).length;
  return {methodology_version:data.settings.methodology_version,impact,months,raw,roll,idx,fut,futMonths,cumReal,cumLab,realOnly,
    lastV,narrative,sourceTypes:Object.fromEntries(data.records.map(r=>[r.id,sourceType(r.u)])),
    microtrends_as_of:data.settings.microtrends_as_of, microtrends:microtrendsMetadata(data),
    indicators:{growth:y26>y25?'Growing':y26<y25?'Declining':'Steady',speed:h1>h0*2?'Surging':h1>h0?'Rising':'Steady',
      volatility:cv<.6?'Low':cv<1.2?'Medium':'High',setting:agents.filter(isReal).length>training?'Real':'Training',
      disclosure:Object.entries(rca).sort((a,b)=>b[1]-a[1])[0][0],forecast:fut[5].c>lastV?'Growing':fut[5].c<lastV?'Declining':'Steady',
      stage:y26>10?'Established':'Emerging'},
    comparison: {real:project(cumReal),lab:project(cumLab)},
  };
}
function project(arr:number[]) {
  const last=arr.at(-1)!,rate=(last-arr[arr.length-7])/6;
  return Array.from({length:6},(_,i)=>{const c=last+rate*(i+1);return {c,lo:Math.max(last,c-rate*(i+1)*.6),hi:c+rate*(i+1)*.6+i*.4};});
}
