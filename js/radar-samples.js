window.renderRadarSamples=function({archive,openRecord}){
const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const esc=s=>String(s??" ").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const AGENTS=archive.records.filter(r=>r.scope==="agents"),BYID=Object.fromEntries(archive.records.map(r=>[r.id,r]));
/* ================= SIGNALS ================= */
// X and Reddit posts are illustrative samples with invented handles. "In the wild" rows are real records.
const SAMPLE_POSTS = archive.radar.signals;
const CLUSTERS = archive.radar.clusters;
const wild = AGENTS.filter(r=>r.d).sort((a,b)=>b.d.localeCompare(a.d)).slice(0,6).map(r=>({s:"w",n:r.org,h:r.set,t:r.when.replace(/^Reported /,""),st:"con",rec:r.id,txt:r.t,e:r.src,c:""}));
let sigSrc="all", sigSel=0;
const SRCS=[["all","All"],["x","X"],["r","Reddit"],["w","In the wild"]];
$("#sigseg").innerHTML = SRCS.map(([k,l])=>`<button type="button" data-k="${k}" aria-pressed="${k==="all"}">${l}</button>`).join("");
function feedItems(){ const all=[...SAMPLE_POSTS,...wild]; return sigSrc==="all"?all:all.filter(p=>p.s===sigSrc); }
const STL={unv:"Unverified",lnk:"Linked",con:"Confirmed",noise:"Filtered as noise"};
function renderFeed(){
  const items=feedItems(); if(sigSel>=items.length) sigSel=0;
  $("#feed").innerHTML = items.map((p,i)=>`<div class="post ${i===sigSel?"sel":""}" data-i="${i}" tabindex="0">
    <span class="src ${p.s}">${p.s==="x"?"𝕏":p.s==="r"?"r/":"●"}</span>
    <div><div class="top"><b>${esc(p.n)}</b><span class="h">${esc(p.h)}</span><span class="t">${esc(p.t)}</span></div>
    <p>${esc(p.txt)}</p>
    <div class="ft"><span class="st ${p.st}">${STL[p.st]}</span>${p.sample?'<span class="sample">Sample</span>':""}<span class="eng">${esc(p.e)}</span></div></div></div>`).join("");
  renderDetail(items[sigSel]);
}
function spark(d,w=74,h=26){const m=Math.max(...d);const pts=d.map((v,i)=>`${(i/(d.length-1)*w).toFixed(1)},${(h-3-(v/m)*(h-6)).toFixed(1)}`);const l=pts[pts.length-1].split(",");return `<svg width="${w+4}" height="${h}" viewBox="0 0 ${w+4} ${h}" aria-hidden="true"><polyline points="${pts.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"/><circle cx="${l[0]}" cy="${l[1]}" r="2.8" fill="var(--accent)"/></svg>`;}
function renderDetail(p){
  if(!p){$("#sigdetail").innerHTML="";return;}
  const cl = CLUSTERS.find(c=>c.k===p.c);
  const r = p.rec && BYID[p.rec];
  const mix = cl?cl.mix:(p.s==="w"?[.2,.1,.7]:[.5,.3,.2]);
  $("#sigdetail").innerHTML = `<span class="eyebrow">Signal detail</span>
    <h3>${esc(cl?cl.t:(r?r.t:p.txt))}</h3>
    <span class="st ${p.st}">${STL[p.st]}</span>
    <div class="mix"><i style="flex:${mix[0]};background:var(--ink)"></i><i style="flex:${mix[1]};background:#FF4500"></i><i style="flex:${mix[2]};background:var(--accent)"></i></div>
    <div class="mixl"><span><i style="background:var(--ink)"></i>X ${Math.round(mix[0]*100)}%</span><span><i style="background:#FF4500"></i>Reddit ${Math.round(mix[1]*100)}%</span><span><i style="background:var(--accent)"></i>News & disclosures ${Math.round(mix[2]*100)}%</span></div>
    <div class="kv">
      <div><span>Velocity</span>${cl?spark(cl.d):"<b>—</b>"}</div>
      <div><span>${r?"Record":"Status"}</span><b style="font-size:15px;font-family:var(--sans);font-weight:500">${r?`<a href="#" class="cite" data-rec="${r.id}">Open record ↗</a>`:(p.st==="noise"?"Ignored":"Needs 2 sources")}</b></div>
    </div>
    ${p.sample?'<p class="note">Sample signal. The live feed will fill this in from X and Reddit.</p>':""}`;
}
$("#sigseg").addEventListener("click",e=>{const b=e.target.closest("button"); if(!b) return; sigSrc=b.dataset.k; sigSel=0; $$("#sigseg button").forEach(x=>x.setAttribute("aria-pressed",x===b)); renderFeed();});
$("#feed").addEventListener("click",e=>{const p=e.target.closest(".post"); if(!p) return; sigSel=+p.dataset.i; renderFeed();});
$("#feed").addEventListener("keydown",e=>{if(e.key==="Enter"){const p=e.target.closest(".post"); if(p){sigSel=+p.dataset.i; renderFeed();}}});
$("#sigdetail").addEventListener("click",e=>{const c=e.target.closest(".cite"); if(c){e.preventDefault(); openRecord(c.dataset.rec);}});
$("#clusters").innerHTML = CLUSTERS.map(c=>`<div class="clu"><b>${esc(c.t)}</b>${spark(c.d)}<small>${esc(c.m)}</small></div>`).join("");
renderFeed();


};
