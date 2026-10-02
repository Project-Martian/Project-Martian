(async function(){
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const response = await fetch("/api/archive", {cache:"no-store"});
if (!response.ok) throw new Error("The archive is unavailable. Please try again later.");
const archive = await response.json();
const REPO = archive.repo;
const REC = archive.records.map((r,i)=>Object.assign({}, r, {id: r.id || ("rec-"+i)}));
const BYID = Object.fromEntries(REC.map(r=>[r.id,r]));
const AGENTS = REC.filter(r=>r.scope==="agents");
const isReal = r => /real-world|third-party|reported/i.test(r.set);
const isLab = r => !isReal(r);

/* ---------- tabs / routing ---------- */
const VIEWS = [["ask","Ask"],["trends","Trends"],["timeline","Timeline"],["signals","Radar"],["mission","About"],["docs","Docs"],["contribute","Contribute"]];
function renderTabs(cur){
  const html = VIEWS.map(([k,l])=>`<button class="tab" role="tab" data-go="${k}" aria-selected="${k===cur}">${l}</button>`).join("");
  $("#tabs").innerHTML = html; $("#tabs-m").innerHTML = html;
}
let current = "ask";
function go(v, opts){
  if(!VIEWS.some(x=>x[0]===v)) v="ask";
  current = v;
  $$(".view").forEach(el=>el.hidden = el.dataset.view!==v);
  renderTabs(v);
  if(v==="trends") renderTrendPanel();
  if(v==="timeline") loadLogos();
  if(!(opts&&opts.keepScroll)) window.scrollTo({top:0});
  try{ history.replaceState(null,"","#"+v); }catch(e){ location.hash = v; }
}
document.addEventListener("click",e=>{
  const g = e.target.closest("[data-go]");
  if(g){ e.preventDefault(); go(g.dataset.go); }
});
const shareText = r => `${r.org}: ${r.t}`;
const shareBody = r => `${shareText(r)}\n\nSource: ${r.u}\n\nVia Project Martian`;
document.addEventListener("click",e=>{
  const b=e.target.closest('[data-share="copy"]'); if(!b) return;
  e.preventDefault(); const r=BYID[b.dataset.id]; if(!r) return;
  const done=()=>{ b.title="Copied"; b.classList.add("ok"); setTimeout(()=>b.classList.remove("ok"),1400); };
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(shareBody(r)).then(done).catch(()=>{ b.title="Copy blocked"; }); }
});

/* ---------- theme ---------- */
function setMode(m){
  document.body.setAttribute("data-mode",m);
  $$(".mode button").forEach(b=>b.setAttribute("aria-pressed", b.dataset.m===m));
  try{ localStorage.setItem("pm-mode",m); }catch(e){}
  if(current==="trends") renderTrendPanel();
}
$(".mode").addEventListener("click",e=>{const b=e.target.closest("button"); if(b) setMode(b.dataset.m);});

/* ---------- repo links ---------- */
$$(".repo").forEach(a=>a.href=REPO);
$$(".repo-path").forEach(a=>a.href=REPO+a.dataset.path);
if($("#cloneurl")) $("#cloneurl").textContent = REPO+".git";
if($("#copybtn")) $("#copybtn").addEventListener("click",()=>{
  const btn=$("#copybtn"), txt="git clone "+REPO+".git";
  const sel=()=>{const r=document.createRange();r.selectNodeContents($("#clonecmd"));const s=getSelection();s.removeAllRanges();s.addRange(r);btn.textContent="Selected";};
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(()=>{btn.textContent="Copied";setTimeout(()=>btn.textContent="Copy",1500);}).catch(sel); } else sel();
});

/* ---------- stats ---------- */
const latest = AGENTS.filter(r=>r.d).sort((a,b)=>b.d.localeCompare(a.d))[0];
const y26 = AGENTS.filter(r=>r.d.startsWith("2026")).length, y25 = AGENTS.filter(r=>r.d.startsWith("2025")).length;
$("#strip").innerHTML = `<div><b class="mono">${REC.length}</b>Records</div><div><b class="mono">${AGENTS.length}</b>Agent incidents</div><div><b class="mono">${y26}</b>In 2026</div><div><b>${esc(latest.when.replace(/^Reported /,""))}</b>Latest</div>`;
$("#tlcounts").innerHTML = `<div><b class="mono">${REC.length}</b>Records</div><div><b class="mono">${new Set(REC.map(r=>r.d.slice(0,4)).filter(Boolean)).size}</b>Years</div><div><b class="mono">${REC.reduce((a,r)=>a+(parseInt(r.src)||0),0)}</b>Sources</div>`;

/* ================= ASK ================= */
const QUESTIONS = [
  "Which agents went rogue?",
  "What's happening in agent security?",
  "What are the major security news related to agents?",
  "What happened with Hugging Face?",
  "Show me prompt injection incidents"
];
$("#chips").innerHTML = QUESTIONS.map(q=>`<button class="chip" type="button">${esc(q)}</button>`).join("");
$("#chips").addEventListener("click",e=>{const b=e.target.closest(".chip"); if(b) ask(b.textContent);});

let ctl = null, busy = false, apiReady = false, conversationHistory = [], modelName = "";

function mdToHtml(t, explainRecords=false){
  const lines = esc(t).split(/\n/);
  let html="", inList=false;
  for(let ln of lines){
    ln = ln.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");
    ln = ln.replace(/\[([a-z0-9][a-z0-9\-]+)\]/gi,(m,id)=> BYID[id] ? `<button class="cite" type="button" data-rec="${id}" title="${esc(BYID[id].t)}">↗ ${esc(BYID[id].org.split(" · ")[0])} · ${esc(BYID[id].when.replace(/^Reported /,""))}</button>${explainRecords ? ` <button class="explain-record" type="button" data-explain="${id}">Explain incident</button>` : ""}` : m);
    const li = ln.match(/^\s*[-•*]\s+(.*)/) || ln.match(/^\s*\d+\.\s+(.*)/);
    if(li){ if(!inList){html+="<ul>";inList=true;} html+=`<li>${li[1]}</li>`; continue; }
    if(inList){html+="</ul>";inList=false;}
    if(ln.trim()) html+=`<p>${ln.replace(/^#+\s*/,"")}</p>`;
  }
  if(inList) html+="</ul>";
  return html;
}
function addMsg(role, html){
  const c=$("#convo");
  const el=document.createElement("div");
  if(role==="u"){ el.className="msg-u"; el.textContent=html; }
  else { el.className="msg-a"; el.innerHTML=`<span class="av"><svg><use href="#mark"/></svg></span><div class="body">${html}</div>`; }
  c.appendChild(el); return el;
}
function setBusy(b){
  busy=b; const s=$("#send");
  s.classList.toggle("stop",b);
  s.setAttribute("aria-label", b?"Stop":"Ask");
  s.innerHTML = b ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>' : '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="2"/></svg>';
}
function startChat(){
  const box=$("#askbox");
  if(!box.classList.contains("chatting")){
    box.classList.add("chatting");
    const dock=document.createElement("div");
    dock.className="askdock";
    dock.append($("#askform"),$("#asknote"));
    box.append(dock);
    $("#q").placeholder="Ask a follow-up about these incidents";
  }
  $("#q").focus({preventScroll:true});
}
/* ---------- server-side Bedrock Ask ---------- */
$("#q").maxLength = 900;
$("#send").disabled = true;
$$("#chips button").forEach(button=>button.disabled=true);
(async()=>{
  if(location.protocol==="file:"){
    $("#asknote").textContent="Ask needs the Project Martian web service. Open the served website to use it.";
    return;
  }
  try{
    const response=await fetch("/api/config",{cache:"no-store"});
    if(!response.ok) throw new Error("Ask connection failed");
    const config=await response.json();
    if(!config.enabled || !config.model_name) throw new Error("Ask is unavailable");
    modelName=config.model_name;
    apiReady=true;
    $("#send").disabled=false;
    $$("#chips button").forEach(button=>button.disabled=false);
    $("#asknote").textContent=`${modelName} on Amazon Bedrock · Answers use the incident record. Unrelated questions are rejected.`;
  }catch(error){
    $("#asknote").textContent="Ask is unavailable on this deployment.";
  }
})();

async function ask(q){
  q=(q||"").trim(); if(!q||busy||!apiReady) return;
  startChat();
  addMsg("u",q); $("#q").value="";
  const el=addMsg("a",'<p class="thinking">Checking the question and the record<span class="blink"></span></p>');
  const body=el.querySelector(".body");
  el.scrollIntoView({behavior:"smooth",block:"nearest"});
  setBusy(true); ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),90000);
  try{
    const response=await fetch("/api/ask",{
      method:"POST",headers:{"Content-Type":"application/json"},signal:ctl.signal,
      body:JSON.stringify({question:q,history:conversationHistory})
    });
    const answer=await response.json();
    if(!response.ok) throw new Error(answer.detail||"The AI service is unavailable.");
    if(!["answered","rejected","no_matches","clarification"].includes(answer.status)||typeof answer.text!=="string") throw new Error("The AI response could not be validated.");
    body.innerHTML=mdToHtml(answer.text,answer.answer_kind==="listing");
    if(["answered","no_matches","clarification"].includes(answer.status) && answer.context_turn){
      conversationHistory.push(answer.context_turn); conversationHistory=conversationHistory.slice(-6);
    }
    $("#asknote").textContent=`${modelName} on Amazon Bedrock · Answers use the incident record. Unrelated questions are rejected.`;
  }catch(error){
    body.textContent=error.name==="AbortError"?"Request stopped.":error.message;
  }finally{
    clearTimeout(timer);setBusy(false);ctl=null;
  }
}
$("#askform").addEventListener("submit",e=>{ e.preventDefault(); if(busy){ ctl && ctl.abort(); return; } ask($("#q").value); });
$("#convo").addEventListener("click",e=>{
  const explain=e.target.closest("[data-explain]");
  if(explain && BYID[explain.dataset.explain]){ ask("Tell me more about: "+BYID[explain.dataset.explain].t); return; }
  const c=e.target.closest(".cite"); if(c) openRecord(c.dataset.rec);
});

/* ================= TIMELINE ================= */
/* ---------- companies + logos ---------- */
const OPENAI_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="#111" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2c1.79 0 3.24 1.45 3.24 3.24v.88c1.14.3 2.11 1.08 2.64 2.11.9 1.74.22 3.88-1.52 4.78l-.76.39c.12 1.17-.16 2.38-.87 3.38-1.04 1.47-3.08 1.82-4.55.78l-.71-.5-.71.5c-1.47 1.04-3.51.69-4.55-.78-.71-1-.99-2.21-.87-3.38l-.76-.39C1.9 13.43 1.22 11.29 2.12 9.55c.53-1.03 1.5-1.81 2.64-2.11v-.88c0-1.79 1.45-3.24 3.24-3.24.95 0 1.84.41 2.45 1.12.45-.08.91-.12 1.37-.12s.92.04 1.37.12A3.22 3.22 0 0 1 12 3.2Z" opacity=".18"/><path d="M10.3 4.25c1.06-.62 2.38-.62 3.44 0l1.42.82c.93.54 1.51 1.53 1.53 2.6l1.42.82c1.06.61 1.72 1.74 1.72 2.96s-.66 2.35-1.72 2.96l-1.42.82c-.02 1.07-.6 2.06-1.53 2.6l-1.42.82c-1.06.61-2.38.61-3.44 0l-1.42-.82c-.93-.54-1.51-1.53-1.53-2.6l-1.42-.82C4.27 13.73 3.61 12.6 3.61 11.38s.66-2.35 1.72-2.96l1.42-.82c.02-1.07.6-2.06 1.53-2.6z"/><path d="M9.04 6.05l6.97 11.9"/><path d="M16.98 8.75H7.02"/><path d="M14.96 18.7 7.99 6.8"/></g></svg>';
const ANTHROPIC_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="16.2" text-anchor="middle" font-family="Georgia, Times New Roman, serif" font-size="14.8" font-weight="700" fill="#111">A</text></svg>';
const META_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 15.2c0-3.4 2.2-6.3 4.4-6.3 2 0 3 2 3.9 4 .8 1.8 1.3 2.8 2 2.8.9 0 1.5-1.1 2.4-3 1-2.1 2-3.8 3.8-3.8 1.8 0 3.1 1.8 3.1 4 0 2.2-1.2 4-3.2 4-2 0-2.9-1.8-3.8-3.6-.7-1.5-1.2-2.4-1.9-2.4-.7 0-1.2 1-1.9 2.4-.9 1.8-1.9 3.6-3.8 3.6-2.9 0-4-1.7-4-3.7Z" fill="none" stroke="#111" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const HF_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2" fill="#FFD95E" stroke="#111" stroke-width="1.1"/><circle cx="9" cy="10.4" r="1" fill="#111"/><circle cx="15" cy="10.4" r="1" fill="#111"/><path d="M8.6 14c1 .95 2.1 1.4 3.4 1.4 1.32 0 2.44-.45 3.4-1.4" fill="none" stroke="#111" stroke-width="1.15" stroke-linecap="round"/><path d="M6.3 9.5c.7-1 1.7-1.7 2.9-2" fill="none" stroke="#111" stroke-width="1.15" stroke-linecap="round"/><path d="M17.7 9.5c-.7-1-1.7-1.7-2.9-2" fill="none" stroke="#111" stroke-width="1.15" stroke-linecap="round"/></svg>';
const AMAZON_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><text x="11.4" y="12.9" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="12.8" font-weight="700" fill="#111">a</text><path d="M6.8 15.8c3.2 1.7 6.6 1.7 10 0" fill="none" stroke="#111" stroke-width="1.25" stroke-linecap="round"/><path d="M15.6 14.9l1.8.8-1.3 1.5" fill="none" stroke="#111" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
const MS_LOGO = '<svg viewBox="0 0 23 23" aria-hidden="true"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="12" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="12" width="10" height="10" fill="#00A4EF"/><rect x="12" y="12" width="10" height="10" fill="#FFB900"/></svg>';
const COMPANIES = [
  {k:"openai", n:"OpenAI", re:/OpenAI|ChatGPT/, svg:OPENAI_LOGO, top:1},
  {k:"anthropic", n:"Anthropic", re:/Anthropic|Claude/, svg:ANTHROPIC_LOGO, top:1},
  {k:"google", n:"Google", re:/Google|Gemini|Jigsaw|AI Overviews/, svg:GOOGLE_G, top:1},
  {k:"meta", n:"Meta", re:/\bMeta\b/, svg:META_LOGO, top:1},
  {k:"microsoft", n:"Microsoft", re:/Microsoft|\bTay\b/, svg:MS_LOGO},
  {k:"huggingface", n:"Hugging Face", re:/Hugging Face/, svg:HF_LOGO},
  {k:"amazon", n:"Amazon", re:/Amazon/, svg:AMAZON_LOGO},
  {k:"replit", n:"Replit", re:/Replit/, ic:["replit-icon","replit"]},
  {k:"github", n:"GitHub", re:/GitHub/, ic:["github-icon","github"]},
  {k:"tesla", n:"Tesla", re:/Tesla/, ic:["tesla-icon","tesla"]},
  {k:"uber", n:"Uber", re:/Uber/, ic:["uber-icon","uber"]},
  {k:"ibm", n:"IBM", re:/\bIBM\b/, ic:["ibm"]}
];
const coOf = r => COMPANIES.filter(c=>c.re.test(r.org));
const UPLOADED_BRAND_IMG = {
  anthropic: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAsE0lEQVR42u19eZxcVbXut/be55yq6uohHRJAQESm0B0CGURBsRPv9YnDu4paBQQQRG9QFBVISALo6VIhA6N6HYhyFZEQqhyeE977vNppxQkJhoRuhiAqXsSMPVedYe+93h+nqtNJupPO0MHn9fx++SOddNU5e03f+tZwCIfpYt8XwFox/IPWqYyuFqZCweIf18Revu+Lsf6tmMvJiRQ6A/S3fDZ0OA6/UCjYRxe/+fSMbHiHjG1Gk/es4+H5KAqfnr6i9DwziAh8SA+/mJOULxkA6PDb1LxCp/4fJ4BiLifzpZLZeF3+VQ0u/Tztup5lhiFGbC1gMRAE9KFpt6++j31fHAp3NFKYjy684MSGOrX1lML9/QwQ4dAK+VBcYsLMn0G5lhbe7F+VdV3xDSHZ214Jop4g0gOVSFdCY2Jj6ydl8PWnllxyHgoF5oN0R4za4TM9fuP86xtdsZECs+Hxmy74KDHX3B39jxBAKZ8TVCjYv1TCLzR47imDcaQh4BJBEYQSIGmN1QaWDaLFBDBaWvhgBN7u+/QL/wNTu5fkOo90eQUbmyaJ449Ne3c9vji3KF8qGc7lxN+9ALiYuJ4nFl86f3JddGlvUNZEShEnysfEyR9Bqj8y7Ep6/boll82mQsEeaFBe294mC4WCnVTpufJldZlze4Z0aMCsjTU7BitxVrqffvr6i86iUsnwXkDB34UA1nZtqZp5PNO1YPDYik2WbFY5IsVDVwMAcgcWy+YWOg37OVcwLt9RiSwAhxJ3I7UhyjjCia3rAwC6u+nv3gUlx0LdFob29rRWQA6EMbsk3/3M9Rcfm8+XjL+fGsrFnCCAH4+ct9Wl1CsrJgKJnc9GACyBScZbAWBty5a/bwHMxVyb+GXzWCWILBPJvcAwstaaurRbV5H6/cnvrxUHZnF4kxJgYcmCdz1jQURM5sm/NRSkJkTxCwUGgLCnqdtM7n+uUfCJYQwL4jEOlkQQxqzY/usTfu621kJpaH9g49buqQwAZUccGQHEELtYHQNkrIGw4aaDSerWjlCMua1TuZZn/M0JAAB3+G1qTmFV/LuPv+dnnqKTKnFoBCBGPVOCCLUxk1Pey/oq9iICvtzhtymMM3nKFUsWBFi4R7GNICCTY69+FxFEObIIrfPcTgvt3K98hgoFA8DuAXsPMreYKAEMP2Q2jO4oG8yXkl1rmWlsHE6h1azBH+nw/a/ObS8YFMYZaQhcLLLExvdNZgsQEXH1XJjBShJpY3s9lfozAKC9wOP87OFk8pEl579qiufNrsQV7UKpslXbafmDJWZOvu5vLQhToWC5mJMnr1zTVbZ8S0PKFcxs9nKKohxqbkg50yfHz76JCMzFfUPS2pO/vOsjdXVGN1q2YLIjFJPZkQIA//dpy+7bUbWI8RwYDcPp6y++sll6D6cEvtikMl+uU94Xj0xnihsWXnw+EY3rPl8aFJQv2WIuJ0/3pq3o79dddY6jmHlsuoEEE1tIHV0LAOjad2LW7vsEAJMHtjSmo7DesAXI7nKOjhAgwnNE4HHmGdTht0nKl8zGhblbJmfll7S1zo4hrQcCrfsCEw2FgfEc8/nfLHnH5PauFvb9AzvLCRVATQ2pUIhCgQ8xGIIEj20FkIORtmkl5/1p0YVzaBz0RHvtQRzZJCSlLBtgVwjEkgiC7SYAyI0DgrLfJucVOvX6RblPNGecpb3liraG4ZBUTKRA1g11hAZPHV1n03cVCgXb2p2jvz0LAJAvlQwXc3LGrQ90lgOxuiHlSAuYvfgUm3Ik9Qp8DOMIcKVqUhWBJrtKYHcLE2BEJLHdaeoCgLX7PnxFhU69bsnF107JZgqDUazBLIXg4biSwFop+yqRbvLkJd1L578zXyqZA8ni9y/h8X3Bvq86/DbV4bepcZNbXSVmBlkVLe014aCbPAyPYTZyIIw5JeidXTdecTxKJbs36mBKVaONwBFKCgC7BkQGZDmOYZTcODJHGe26e8Fshwqdet2i+QumuHT7YBBoyywFgcAEHv5oAQYBzFDCgi0fN/JeJgQF+T5qdLHdkwjbOxKgAiy35uT0FaXnu6/PrWzMuJ/cVo40aNTvJ2tZN6dUemsQXUPAx7i1e5+KwtBTJDkYCQuZwa5UFOp4R53a/OzeEFC1ZhD/blH+HQ0pujuIYmOslZIEDasK7xL6mUiooTCODJnvHwi8HbcAOJeTVCiZJz924RzVmPqXP0NuS0nqzVbMn2Ys+2pnDQnsNTHJJ5r8lxdx+3b55OUpR54QxNYSjWKFRLI/Clk69P6f+5fegfx9f95XvYDITAWp5GxoOKZYV5KMDDbNLHy3dyddvSfUnFco6V9cf8E5GUeutlpbYzRJIWhs9pU55Sr06tTGM5Z/7Q+JDu5/PUOMx+1QqWQ2fPht09Jp50fNij9+AkWfOYqDe5udaO2mpRf/8ImrrjqK8iXT4bepvQbk1m46ZlWhHDEtcZUg0OhuiADSFqbJceoaKtHS2u/u7T4ty6l7eEMGSyVghLMRANb6bXK058uXSuZXiy46udmh/yPZpLUGBAnBsImrAUC7Gz7DphwikPkpgXhte9sBQVGxL44d7QV+cvFlr3DrvB/AiY7YMlCJonKgo6HQDISBqXPoLammgV9vXHzx3HmFTl3M5STz6HGB8kmgmrH8wdL2Srw26zqSeYyATJADQWwz0lz+zMJ3nFizoD0SvioNAdAUy1X1H8F4EDMU+HdjPh+A/7z1kroGyd/OkJgSxdYoYsFEYBLDfodHHFWS3AlRDnTo2fA+ALS32HLAAljb3iaJwDGFV03Jpk4MAh0TwU2gGEmClL1BaCRFx6cd81/dSy66Nl8qmfHgbUvy2lizkYmV8+gkHdusm04Nqkk3jGUF7S0lBgDXmqnWMph2Ct8CMtYxDEUbR3JGta9Y294mqVCwL98e/3tzWk2vRForIaQdFh6NBZdNOqXEoOEPnraitLGYyx1wOXVcKEhQ+PvQaCtGCbWCSAaxtTq2oiklb990Y/7+h/zzGvKl0V1StSolz1yx5ndDRt9Tn3KlZdixrKA/iGw94kueW5Q7dRQroEIBln1fWNBRxjLAXJMoO5KoEtuB5sg+PcwZ7Yb1N1z/7qXNKZXvL4daClJMO7OI0WAFM+umjKP6KtG/zVhZ/GqH36bypQMn5cR4WEaG80wUgwxYjKYUREl21VeOdJ2j5p8cNz688Zrzz5hX6NQdfpvavTWkvSXJHFk2fGIgsDs8KcaCpcTMti4Ft0L4OAFcGlFMqf3GevyxQTAfYaxN9LN6UkopbPeanjv6tm9vHRmAO6pY/9HrLntrnefcMlCJtQWkYQaPuI3dn9UyTH3aVdsq8c9bZuNjXMzJuYXOg2JE9yqArmqN1kQNf4w1UZX6GzNwEkH1lSPtCZyeybg/71qcu6TWDjJScwuFgp2LNjFj2T2bI2NuyXiOANOYVjBQiayrnAsevWn+6blSabhs2d6e0BBD2ptshGg0dqeoCWRdQfBM9ASIGMWkFsy+L+YVOvUvl+ROakpV7rNWc8wQhL3WjcBsbVqRCCJ+MTTiQsqXTHtXCx8sG7pXARQKBcu+L87IHvMnA3vvpExaECPeOzUp1FDMxljUN3rOfRtvvOCOfNVHjnRJSQnRF1tbvM9vDePfpxwSY/BExAxb55BKx/EnRj5wa9UajOIjheMqy7uyrYIsMnZofa1oUwu6v7wml26EKqXInRRrshBWMO2V8GMpBIPIljVfNPvWNX/hYk4WDkEbzb5jQHuB0V7gHVP5g9sD/kVzXcoFs90bqUaANIZ5MNRmiuNec/PJ3o83XnvBcTWXhBqP3tpN8957byCZb3SlQ6N7XQAE1R/ENi3kO//4sfysWtq/Mwt2j3aVwsgkkcEiMhYaakOtgFILuo0ufaXZE2cOhJEWgCQW2BuhTMwmm/ZknzHXz7j1gc4Ov00dimLMuARQ85vnXFeq9E6e+sbewN7huY5IOdgHvZwUxHvKga5TNC+Ttr/ecMOFb51X6NTM1fwin3QotCxbU+wP9a+znpI8Bk/EDPZcEjvStj0h1VoYmAsAyMaVY70R5F9VY0Ul0mEk46cBoKsLcl6hU2+89pKFzZnU/P4wiEnsOxFlZt2YSautZRTPXF6641B32Y2buxhZ/Vm/5JLz6kX0xZQrX9FfNhqAJBr7syyzcR0hSUjYWC0/+feVm1BFSXO7pzKVSmbDoova6j1aG0SxJSIxFlGnXKJQ67Nbl3/rN89cfZ53yuf+I/z94nfc2pBqWLi9EmgQFDPblKNExehNm70tLVu7p3K+VDKPLXpb2yRV/1PNbDW0JBb7SO7Y1rlSlKP4qe0cn/XazMwhtBf4ULZRiv2QFHPCk6szl3/jP15gPmswjr7ZlFFKiASzjw1jScaxtXGobX0KSzadqn76q0UXnTyv0KnXtmyhDr9Nzbj1gc6BSH+3Ie2KsZIzBjgtHCLj+ABw8vSXWwDQRh5t7a41AFcKwOKpeYVOnWtp4ceWvndKo6z/BgtL2saCeF9BF+wowdrIShTr/Otu/d5Aqbv7kPewiv00F55X6NRczMnXLyttPfXmb+V6ovhqJVWlznOEZdZ7q3iBIHrKFZ0W9PojXPrNk4vnz59X6NRzMddyMSc90NIgNBElGRCPVi8YCCLrevK8dR+/9Gy6clVcLeQ0awKYmEAMAnNC49DGGofk2cGvZ1xxbKS1ISHEPo2fYOqVkv2GPnTGnd/deLB4/5DWAyhfMsygYi4nW24p/dtQlHq9NvT4Eem0IsbeAzSRGgi0IWMmZT15/6YbLv5Cqb/bo3zJnLrywSfDOL6nMeWNGV8Y4JRgSkXBJ4Z/JsQkw1ythCXZsLUMZnqKCgX7+OL8J5sz3nm9QaQBqcC0T78/KZ1SWwPztZkrv/HVieyuPugGpdrNFa9qy86pP2aZdPFhMKMSG01Eiseg/S0zCyLblPZkOS4/Vmb9vum3fHf989e855jIjbohTX1sCGMU8VkIIIBsmbHsgaeeXHzh03VKnlKOI8tERASSEKbSNzDFa/Rmp1T2x2EcagsrsQ+8by3brOeIIKau/lTdWc9194S5YskeatdzyCpi8wqdmn1f5L/QOfjKFauvHrLmTZrx5KSMp5LEcnRrEETDKEkJNStN6Ycfv+Giq15+59dfGCT+VNp1CWNQFMwwja5DntH/nGBP2xTzTh5aEiFmrqj6uoUAfSe2MQxDAmKfft9Vkq2xgTVm/pzCqvJ+FPFfGgsYiZJQzImEls5lj428TylhP6YYGNSxBpGisR/cSEGyPuWirxyu6hPeDU022uBI8bLQaE5y8F1YZtPgpWVfIL9fTm+9MBuktgjp1BljhhMxAlCfcjEUxdDWgFAr3vFeKp2kGz2htpeHFky/7XtfPhyDHYe8R5JzOUnVYPXk0vnzpODPZF15ev9QyAzwWBCTGQwwZz1HDIb6BQKmCEGuHcWF1Yi2WNN2bcXbPRH9J6Sss3aEGVTLZEyQNI7ntAwzKa1kb//Afafd+f33HMThk+/71NrdTbVEcWv3VM7lAOT2dGUT0qQ60hru9hdk3hD2+BBqkSuIylGsiUjt5XeNJ4WM7a7E2BgBHcaKPwqYY4mgDtRPMLNNKQlt+C/a1rVMyxw3Lryf1Et8qrUszsVcuy9aevfK4WEZUQKAxxddfm7Wje7KKjWrJwhh2Vqxl4QLNL745EqB2NiDctLMbLIZT24P7HvOXL76vtG0nxlUyufElJYtNLd1KiNfsqMRcbliUd706ANHpzhzgiExjaFPc2V8Kkg9/CfGv//zsjWbJ9wCdreGtVXu/aGrz/NOSTd/QkhaLCXLfVnDOL9g3MIay+LqHSV74/hXrctLry3lcyJXLNldNLvQaUY77Of99zUPxdErPRucZiBPD8lpsWROcrQ5rk7KjOMKgBiaLRQRhmK7LYrE3ZszL7TPbe80RPsCxBNkDRsX5l+bcuS/ZT3nzN5ykFRRxrKGib9sRjmiXBHnvlj//K/rXzyV5qxatQfju/6686eaVP00z+rZrg1nMuRpguUJUJiccRN3aA1BG4PYANZqy9VCMrMggNmVQtUpB5uDaPYZtxYfK+ZyUh2up8yXSqZmDacXir8oXvOac6aLkwoppRZJApXjQ2AN++16YBpSrtxeib44447iw8lPO/E938+0Rk+fxLGYFUucJW0wh4lPloiaUq4EsQdrGbG2iAxzX4UtAJaWKKEhLRGxYBICTEhAHCGy1rLW1nEyY7og4mrholRKGMd2AO3tBa5mRHyoreHJRfPnuYo/n/HEaX3lyHKNtjgcAgCzqxTpmC8nFtuNkOdEkmZ6llocLr+8zvXAghAbjUhb6IRwsgCBwSLpwx7DjRPXSmrMDCYSccYVaou1v55z85rX1eanR5b3xkU0se+L0giIlUT/pOVvbutUHk1wwJ7CGxkbHl50Rf2Rbv+nlZAfgRUIYn1YrUEJgicdSCVgrYGONQLLYMAQJyfDSRZH44gpDGYmkK2WQaWnJJRUaEhJvNBXvqxlRfHrtUBPu1PNXUsve4cBoEzlr0LL3rTk/mcmNww9/Mp/rhTy+eig4WkuJ9a2bKGa0KZgqmhtL8VE4A2LLn1LxuHP1rn2xL5ybHF444JhThoQCSAmEkyAqNZgefRyEXMioGTwEyASVrrKgScVwBaDYWQicp4loR6BCX6WTqW/cULh3rCWDVKtivfsdZcfG6XNPUcovNFog9BahMZaIq5oEpWySg8wiwFDsleKwR5puK9OU6/leAcx9UqB7bFjdkQm1Scs+lnHg8KV5ZTbW4lQH0wvlMYlvI6Pvr3p+HTDbY6w7xvU0R5Z8Et6MVtOmlWYCSQI0hUCrhIQQiC0ApU4DAl4Rhr5WxL2Z9Kj3/y29fxN+XzejO6pfF9RoaC7r7/4tmMa09e90N8XCiaV0DUgEgRBgCABEiKxKaFBkJAkACsgCNBsodlAGyA2BgzEDATEXAaobIjLxDygmLdJ8F9DFi9sTze/YDn86xHGbtbkbnVN2H/asvt2EIE3LLnk5kmuvWEo0DUe4fCe9QhXkjCspDwp4CgJJS2sYQwGMET8vGXuioV6rOKl1gHeE2cVvvjcaAnY2q4tNC/pohi2JYXW7sQUSDy2I9SAgLAWQlbDiGGuhh2d5PmU8L0MywAgbCIpA07QOHMiNiJHEhxBop4oOUFBgBQEAUIWhCyFiBGDtEZkKrEA+p5e8q6ep5aIfsNRfRATmPbBoE3AgTNAkki6jiJXCcEQCKIKAmOf72fV5Ri7XhrzO+aGDbJS98dpn/tcONaBV7PjMQf6aCQqWb/kiruPyZgF2wYrLAFrq603NQqLqn9sgq1QjfG0i4/HzloKYbdmn+ro1vDgRvKXZGaeBCkiSCEgBMFYi0DbicwUmQFLDAaBBJH0lIQrBQwDg1GkBeJnLYvHLGV+4SL4zZYQ3efcWaqMBkzWYq2Y2zqV27taeH+6JYaDMHyf/gi4UfjMD12ic5ViRwpK/NAIDtFAgLmKrTixA652C1lmgG31Z9X/MxxsqnxbAjOZeVcBESGJZ9VQVyXR5ARpO5QgZF0HQhKsMRgMdGhJdhvQIyzlLyzh0eny+U20GyXR4bep+hdPpdlHP83AXHuwNeJdtLemmZuWvO8kjf4WS2YKmOosRD2I6i2JhrJMN1iIesXIEnM2EiIlQZ4wSGlJqeaoz5OsHQAOgxwlBAkBiKR1K8FylCQnCa4jWKJdbobBCGODILY41CGYqyNLDO4VRD+NCL+pi+JfVqhpw2m3/vvAgSC7Ui7hiHb/t63dUznXsvetYLT7hx1IspUrFmVLV5dzXCbjvKb8jFNf3poKpEq51nqRdTxW5GhmT0O6ILgK0o1IulZYr84YF9AeM9IENBIwmYG0a3G2cGRLoC3vrePiAPwOO1KQtvZFYvWdWIjnlY23SUY/U9Q7pOr7lOYB6GgwTU442mdEDpm0J4ZOKNwbjPM7qb3dp9FcE42BjAit3TRiBcCokj3ULRojr+7F+S82pZwP9FfisSZpDsoFOYKQ9RwIIQBmWMOI2CDQAGljLHHEQEwQiYslrvpqAiVdGwOGaNAI0SvZ9kjmHcpiWw9jR28qtT0tnW2S5Y4M07bTP33346NR0YeSDaVaR9TwVe3bBHYO0gHVZSi5nfsd5gLYtGOGPLm5OaZCwa6/LndCveMuZdKXa8tqwmoWzBaEuAoLBCdT/IKIkn4KGrtblKoYXVISI4VIAGCNlwgEgZmgjQVZC2PpuzsEXfOam7/xh5E0zGGho/fFCeVKCa/+hJ/LOlHdRwTstfWendwbhJgospardYSMo5J4oy1CbQCGrp4KMe+d4qZqEY8oGfOptXdTFd1V24SJAWpMuVTR3DOow8VnrPzWl4vFnMxXLeElEUCNT6ppwvpPXHZp1uib6pQ8ZTAKoK3RBFK1ngEGDHgYkB205te5jhgIo09Byk0O8DawnQXik+pSKYAZkbaItIFlmOpBi4R3O7DvtwzjSJJ1aQfbynF+xvIHSzVLOKwCYAahlJQqAeDZxRe+Acq2O64810RAGGsNSsZCiQGTzIVyQ8oVgdaItcVBwyKGVUoQgE0vDg6+8dzP/uD5F/y3ZfpN+kRHO2dXpHMurHlV2oYnZjxXERG0NghMDGNFksUmWFnQ/rV2Gk9KGEsDFQrOPn3Zt5+G7x8enmUk8wkAXddf2Joh9XEh9QVKAP2RMYkL3Um+WYZxpZD1KYHeQX1PDLysKeW8eTCKDQ4yPzDM3OA5FMdmx2Cg3zTjrm89uotrLBblnN9+9yQj9VkG9FphzWsgcEraTaUVMbSxCIyBNtYSYKt+aN8Wyhw1ZFynJ4juaF1eWsh+m5r4kuSILon/Wnrhka8gvZDgfCijRLovDJgJlljKkS6CiXiS58qKNlvB+sM7YrGu2ZOdxtqjtbFENMy22wMTBoGhTVopqSG36YDeMu32+3/7B/+y1Cu6yzGN0oLYdeNVx8dUnp2OBl8HIV5tSbamlWj0JCG2QBTHiIxlAkx1XQvVSqXVDNQIQeqoxjT+uy/4YOvyNV+aUAEkEzEFUAH2oavP86ZlJ31ACyxOe+LowUoMWGOISCbAKenPZ2btKaVcSQi1eSDSlYVPAwOtrvdkSqhjBgNtSZBgBqQAUo7EUGQOODBYhsk4Ulqonq1Gv/XVyx/41aMLZjtzVq3T7O+sCY/WnvIH/7KjwjiYCe2eU3bV2WldmZERmOI5DqwFQs0IbQSG0VIo1eAqDMTRdkP0pa1G3f66Zat7QRMQhH3fF+2t3VTz888s/Nd3Ka/8iToHM8qBQWCtBrEcCfJq3XOT0p4YiM2fjKVF05avLnX4vjom3vTrjIvZ/eXYiERg7AhiY2zFkPiJK+hfYmv5gAOktdZzpbAkBrdBXXD2p+97qLYvYrTnWtu1hUYr0v/Sf1/z5KAy3ZA6WzG/BtAzWfDxWc9DEMQ7CPpLfeHQF2be+cMXJiIPwO6JxoYlF53tsWlPe6n/ZUgjCLUG73rwVfPUaUcokAtt+Ct/GQxueP3nSlsZoKcX5785KZN+Z0850AAnyZiFnlLvqi3l6AoL9qamU1/cNhRqqiVrDFM1/X22IVK19ZRZW1cJAeEYHcXvO3Vl6d5qxcpgDGaAmQn5fLW4tGc/0PPX5NIDbmqa9eqmYzBYe/odX/tzjUsaKUA6ZFqPZEnT+utyJ6SluEkQ3pt2BPXHsSUSySQlcwKMGbBgSwA1ZlwaivkZw3Ttqbfc/8NaafTJ63LtU+o9f3sQx4BwmC0sW9OYdmRfxfxHy8oH3/zk4vxvsq46ayjSw4E57UlUIp2w4nvhX6QQ0NYYIFkoyMxWEFHGVdSr9eLTlxVXFnM5Od7G3JF9Q7WBkN2Vc0I640Y2MW288aIPpqy4pc6hpr4gZAasGGVjIjPrjOsozQJg/ZnnjPHfuKLUV5t4eez6+W9u9vihMDKak4MlZraeUmQstvR59dMHEOopYeVPHqFBG7BIaG1m4E4CrhRCZKzdU8mo6vtB6Mu6TvNQGA8XfCwzSxI2m3bkjohvP/2W+xfujcfZZ/m1GkfWYq4d6/cPWADMIORzgkol8+jiS18+SdjPplzx9qEohjF2p0vYxd+yJUE0KZ2icmA39LO+5swVa34KAI8uWODMWbUqfuTay4+b7MTrSMZHhHq4X4gFYDxHqSDUbz311uJD62+6Yqang3WCY7IgliTIQMdrvNbMBeVnlk2uUwu3lwOzmwIwAHiCdMXw6yWJBc0Z773byxWTwEgiBrNgNg2ZjOoP9X2rf/nfVxQ6kw7wiXjXgThgX09IZruW5C9ulPqRtKPe3l8JjbaasdvwW7V8oLMpR3hC2p5IL380DF9z5oo1P+3w25Tv+2J2T4/lXE6mneB+z8WUWBsrQDUYZxrSnuoL45Wn3lp8iBk0SM7LkxZ2MgxOyqOMvg9kf+mFGffmnkBvTUlF2LU9npI5M+nEyt546oo1V2wLwhXZlCsTTk7bakFe9ZbLusmjSy8956jvP7zoivqDWat8SAVQzCWB9mdXnzfl90sv/PokR34D1h7ZG5QNEaSA2GWdATOMINCkjKe0dh4xMc497ZbVS/N3lirJmphO3Y61gkol0328WHFEhs7tjwINEjKpfrPJeo7aFsS/3p7ZcuMTfs4lAmdseLJHSR2RGJycoNqxfbApnlm4t1dD3pT2pNhjsJwgByvaHO15b9uw+N1Xn7ZszZLeKPqAksKmlByeTyMitaMc6TrXOW+KU/lJx8LLjhpr/cJhEwAzU75UMhsXzX/bUY3Nj9R58tKhODI6mXaRu6MMMHTWc6QiEQxWwo//eLv3upNve+BXtfUFtQeiQqdev/iid9WnU9f1l2MtIFQy6cWspKTAmIEQ5tKReDwbDZ4CihLmjIilMCDE26cXSlGH36a6Z4X39JWjdXXuKKOvxKI/1MaTavmjSy+bNn1Z8e4+izdrUtvqXCW5OutGBNVbCXWdo151rGs7Hlky/5UjZp0PrwCKuZwkIt6w5IoPNGWc7yvwK3qCWBOUFLQHtDRSMjWlldKx7qzE4uyTVhQ/feWqVXFN6wng2tqAdddcclKdsvdEpmyZSVSrxRAEk3ZdUTbiA7OXl57t8NtUa3spBgAt6CTNBlzdOpR4ILEFSHqN8vmSAXkfs6OgIQJRrBl1SmRSXP4C+76YtWzNjysVPtca0dWYdpWtMqNEpAYqoXalmdaseO36pedPP5RCGK8AKF8qmVyxKIeUuMHqiKM40sRQPGLBBSdtSqY+5Ugh1EB/FF97wvIH506/bfX62oR8DZ4xg0rd3dThX5bKuvGDaajGWBNDJH6fmPWkVEr1lM2Xz1ixevUwfibw3QsWOETO8UZLgJNysoQDQG4GgK3YYrmYk9NW3PdwOeLVjSlXco1q3lmDloOB1s1pNa+r0n0VAMy444Gn/hKErx8Mvf9szqQVM+uqIqihUBvFdFyTcH76zDXnvyYZzTp4IYhxIh4AwOJ1/5X1bMWJrAZxFT8PB1k2UkpqTDuybMyPeq171inLSncyg2qaPjKpWdveJvOlkjmmEn6xMePMGowjLQgyoSRgMp5S20K7cUBP/WixtpWkeiPnZKOjyNqXxWySEtVOamFn731XC/u+LxzXW1IO435HsmDGngv9KtpmJC1/5sYLTuRcTp5zZ2nH/d5xb+kPwq9MyqSVAJkEnkKWY20YYoqX9v7vY9df+EYqdOpHF8x2DoMFJPc9SfSnMiZqJiEIxBpgI9hCElNjypNC0PZtMX/wlJvXvGXOsnuf6vDbFBH2KEpzNXd4+rqLPtyU9i7vKYeaa72gltmREiGjElE8/5w776zkaltJ8nkBAEaFLRlPprS1tjpTnAQcyL8Oa3ihYNtbu+nkm7/259jw0mzKTdqXdrUCii2x68o6HWMVlUrm0bsXOO0ATlm+5l+3heynPCWTNhm2kiArkbERUN8gnR+sv37+O+esWhcfjCWMSwBExOz74pW3PLCFhfNegrRNdRkn5XmSlQOSYrDfBN8a0HbOjFtWf6m63lKMRmIVizlJhU79+KLLz5Up567eMDIAyeHWF4LJeEL2RfTRM5cVn0iCdCLA2t5/peJZrmIQK1vt5iS2Fixo825+03AxJ6fdWvrC9rLpbEw5avcpfCLIgYrWkzLuG55YfOGH5ly5Kl734g8k53Jy+rL7PtkXhVcIRSbjKmGZtRQkYm2sQeQ0KfPNJxe+83I6CHc0/lUFhYIFEU5btnp1MKTf1K/Fwhet+/ZBp352f8MRp067+ZvvnrniwT/WDmy0pMX3fZHLl2znDQuOTrnhGlAktTVUG1vXYNOQ8VRPuXL/nJWr95hSrC2QCigz21oJUZ1iJWaKrQGJeMvI/1dzRQBjyMorB6ytKEnY3RWBSA4GkU0JWrFx4QUnzl61TqOlhTv8NjVj+Te/2hfqN2jQs03plDJgLYiEMYzYMGfTqa92XX/JR6i6L++A+4L2h2Ye7XC5ygeNlXLXBvdKyOH0dd/7Sb0n2/rCipFgSSAYZptxHRHFdtMWm5n92sxxQ2hv592XpPm+r96s/7vrSApOiXRoLQsS1ZJsWWD6rGWl7t3vsSbI392QW3S066zsLSdjs7sjt/qUI/ui6Kety0v/VCMWa7/bce1FRxzr8ZfqXfddPWHAqE5kCqFsfcqTPWHw8dZlaz69vxnzAVERxVxO5lpaCK3djK5kFmBfXEmN4t2w5MK7jvS8j+6olDURqYSYA0tBVkjX9hv72lnL7//t7t0DtYGG3y2+7BWS9NMeRW6CugSkIGKjh0xkT2656zsvjjLrQJzLCbSU+Kko/8usUq8eDLWh3Zp+maGbMlJtGQo+dMat3/lCTQgj7+XpxZctcgWWQUSyEhtDxEKATGM2rTaXyx87Y1npM/vcoXqwVES+VDJUKGjKlwwVCnZfhz+cbF03/9JJrvPRnkqlyhVVm+rBpj7lyH6rF81afv9vR1uM0V7dmCilbm12rGuTaRUCMyQRelL1vT9vnNE3hlpxCckG3xipBZFBLCXtuX6NWA6GxqYcb8XDN75neFVmvpTsxmDfF6euuPfWSiD+ybJ4rjHjSGIylgEdxlawcyEAQleJD3kMOJjWk3mFTv3EwtyZjS7uDrUxRkBStZvIwuiGdErtKJvvzFr2wGfGHJCu9hGltJ2lkgpm7T0xLIREzE7Ple3tlVrLyGhK0+G3qRnLvr4h1Li5wfMkLJvdEzRtwHVKZht1cPfIVZk1NNfht6mWO7/a+dewfPZQhP/TkPEUASKwhpWlE1/wF6SpADved1hOqAB83xddLS3c4V/W5LgoCcHpSMckubpUxgqTdlJqIDLP96Uz7/d9X6xF5+jWNLzB0cxOlF9SrU+t2hi1DVW0Ntb9zC10mmIuJ8sntt3SO2Qer0upUVHRYBDryRn1T92L3n1VDUnV/n1eoVNzLidfe/t3tpxyy/3n74iDpUoq21iXlYEX3/aywqpKMZeT423xnEgB0FysFYVCwU4NB7+e9dRJ5Vjr2nA2M1tXSgFrhypRmD+ncM+O1u5uKhRGXdBBVCqZuxcscLREa2gNgNp8G7MkCceaLQCwtxXHtUOZc+WVsRDmvdYgUoL3cEVJghZbT8oV66+94JRktdqI12LVXBKDpt9cWj5AmVf9PqT5Mz9VXEkA50sl+5K7oI5qG8ojN8z3m9OZ/z00pOPa4J1N3usCCOgBrc8/8/Zv/ab2upAxkBcBwMyj4+MYOD42uqr8yW5nhy2y8dBmYJdXWo0Zvzr8NnXKijW/K0e8OJt2JTBqgmYzKSfrKvpkIthdX9BAyTAZF3M5OfOWr6x/zSe/8sAemetLJYCa33/s+gvOmSSs3x8E2iI5/OpLdaxDKSrHdOGMlaUf8762EFa12hg1vd5JO2yEIRZU2xFd3Xb71/HeX41Ma7ltzV3bA/NQfcpRdk9XRKE2LBGfXJWcHUug7PuiY6ITsf0pxeWKJfvjxQsaPZL3eCCyhgWqL20QAjbtKNkT6StOX7n6249WX5qwt89c29VCAOCaaJaSu7qMaokRYLt5f+5zLeYmgTL23jcUmS0pKXbdW8pMlpkIaH4il3NrO/PGSlIPdK3NIRdAKZcTROBsimZmPTVtKNSWSIik3wom66VkfxB9dOZtq79W7cGJ9/WZW7uTObY0B7MMG/BI+ptAiUMWm4FkVnk891koFCxyOTH9tnv/GkXq/UKliER15xkSklVbC0vUHJzsTt4/x/ISCmB4UsTgFSnXARHHzDBEpJu8tOqvxDe1rix9lv02NZ7DrxVuHvrM1Z4Bzoj1ri/pYU4WtEbS2QokE/7jRgmlkunwfXX67d/4fk8oP9eU9hTDRmBoImhYYoaqJ2I3SUZ8+psXwNyqaQvm58ph/KdMXdrLukpOyTQ4PQGvPG3lAzeP1vi0FyybvKZqa+UkCTo2ji2oViuuNvSH2hgFbAdqC133434LBVPM5WTvZn19byVaf1S2zsumXZVNC6cxLYks3zf75tV/+psqyu+TtAPw6ptX/ezZzZUztht706Arf9zTF15+2or7FrPvC+zHxvFae2BG981q9KQQTHqkeQhBIGBARaY30dLCfgmAAO5qKfG8e+8NtLZvHoijK7ab+LNbjP38UBjPPfWP9goGqPZ+zEN9TczLPAH2fV+8sVDoA3Bz9Q+qD3JAWqRInyXIhd1lDJZZCknGmF5dr/sPlN0qVDNXuq30VwBfxWG8JrQ7ujYPgK4Wxoh+0f1FVQTGrz9x2aNHs55VDndZbWzSjpQDsX1s+ooHZ9NBxknm5K0aI+nvalI1YVsTJ3QjScJIHuS2Wd8nFMBGqM2EmIkMY7gNFJBE7IA3A4A9SD+d3O/Ebkk87GTcQV+t3QQQZ4Khu8gmr5YZPjALowQRMfePjBf/P11/8zdcW5O86ffv+slghddNydQ5YEQMmJSn3NACFvbemsv4hwAm6MqV8lZo9+29lfhHk+tSbtqRMhD0zI6Qrpi28ls/qvH2+Mc1QQF9BGB48oYLP9K19KJ3+LmcWyXrxD9O6HAIgfccHJ6Ihtl/XPsICx1+m+JiTvJLPGh+KK7/ByJMHwia8RSmAAAAAElFTkSuQmCC`,
  openai: `data:image/png;base64,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`,
  google: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAX+UlEQVR42u1de3CcV3X/nXPvtw9pZcsvOW9K88BjQ0mQnJaQspJNmAw0zYtViEPSgZJAKbSlMKQPwmo7aUlbaGegpSQNaRlIQrVNoJQy1HlIm0JIiJWEpDYhBIILDvgtWdK+vnvP6R/frizbemtlyYnvzDfSSLv73Xt+5/k797sLnBwnxyt50Ik0WT08X0IWyO/IHDH/zPq8Ild/KUC1nycBmKuws1nq7+9nAOjsLAjlILP6jCy4vz899n7koEsNFFpiQuf+dJr3trVpdz7vJ/r/rs0bVwQirUrSbJQCMDMAqKr3nqoQHk1qabD1288enPAemYwBgJ58XnOYHaAvSwAUoP502nQWCn68du5Or08xmtepwfkEfR2A8wA6A9A2BZYborghAlO0BFFFqAqolkAYgmK3AD9n4IcEetZ7PN2GpueoUCiPtxDsyBDyeVksy6DF1HZkMkTjNH13V/vZlmkzgEsUtJGAV6WsAQPwAJwonCo8FKKAHiU0AoiJYABYJlgiGBA8FMPOKwE/IdXHiOgBNfrwqq3bfnaEZSwCELTYgh/avHFVCLqcIdcA9KZma5oBoCyCqihU1RNBVUEAESiaM008d9XDN1JAFQSFgojIxJkR5+hto94PQbVPhe6t2sp/nfrAM6OLAQQdT1eDTIbrgt+zeeN5Vul9IL222ZpTBUDRC7yIBwAiIgDcyCkooNAII8tsmgxDFSh5/wJU/tUFuKvtvwd+UQeCJohDJyQA4xezt6vjNcT4KIO2pKxpKoqg6iOhg4jpeM0pAkMAIGGMSTJjxLvdUPn8bod/WFcY2BdlYqDZZl9LBoDxWv9i+vWtrUHsYwA+1Gxsatg5eKgDyNAiJwMKCKASENuUYYx4+T+B3rrqwSf+GQD60mnbVSi4EwqA3kzG1FPJfZva3xEw39ZkzdmHnIcT9XQctX1WVgH1cWabIEbJy0MVqX5kbd/T39cseCHqiAURQF1jnku3r15rzKfiln7HqaIssiQ0fkYWoaotgTVVLyOh93+2um/gs/XUtZEuiRbK5ex68xt+sykwX0gF9tzBqvMKEFFDg+qCD1H1ltm0GMaI8185OCjvP3tgYKiRAZoaKnyACJC9m9rfF2PzGSaKlcQ7AtkTlSxTQAnqW621Re+fPFQN33nmI0//KAtwIyppaqDwQYDu6+q4LRWzN484D68qTMR4GQyFumZjrBP9ZdG7607pe7KvrnDz+VxupPD3b+64szVmbx4OnRdAXy7CrxURXPEiBKwicIoARTa7uC6onicjB92/aeMXW2P2+gNheEIE2lnGAolHpF9xROXyMx7a9mCjgjHPS/iZDFMOsm9T+50rAnv9wdCFBLIvN+EnDDNBh0OPy854aNuDmk7bRmVCZq5v7Eyn7au/+U2/Z3PHX6+MxT54wIWOQMHCV69QQIUIEhVQEEL0O0WkqKLGkM5XEURVksYwKQZHvfvtU/oG+jWdttTAomxOE6zn+b/s6rhpRczePuyckwVyO5FgVVSJDRPHiBBwlM/SUbdTKLwCoSqqIpA6kTeHuamqTxhjVOVAuaKXrf2fbY82WvhzAqA3A9Odh9/d2f6mhDV9XpVDgLmxwldVFRBRgpkTTHCqGHVSVNKfkuhOML2kwH4ClWvCbybFaoBOV9JXk9JZLdYETBHJV41IPqIZJAai6puMMV51X0n82099eOB7CyH8WQOgAPcA+PBbf6PVO7ctZs2ri843NNWM6GcyLdbAiaLk/Y8J2ArFg0bMk61tj/+M8piyCHr+0nPia8MVr6qqXkjApSC8JWXtWh+BKBHvN3H8E1XfbI1xIruL3r/9tL4nBxZK+LMHoFYB7t7UcffKINhyMPL7tjGCh4CAZdbwiPNKiq8T4c6RUfPQWY89VjritfVO1p49Y/PvB9DZ1qYTtRp3pdtXxw0uJ+KbksZc6FVR9P4YPmpM+KovVVz1bWv7nv7+QhJxswKgLvw9m9ozLdb2jnrvtEHCF1WfNMYQgFD8V8XrX6/uH3h8/L0BAPm8AtMTYvX0uL8/zZ1tbVqnDRSgA5s7uhl8S7PlDUPOQ2vFolf1KWtMKPqzQ6G87azCtv9daOHPGIAswMgCH37odcvDePyZGJvTK150vtxOnZNvDQJT9P75UP3H1jw08B9HaHkDulPjOCoBoLt+q70pUeSPM+NmQ8RlL9WUNbGKyM4iy6Wnbx147ngIf8YA1LX/l5va/3ZVEPvogTD0TGTmpfWAMoBl1lAxdF8ctsU/PmvrjgOajUBdqCbIeCJtX1f7Wy3zF5bHgjMGw/CFsBq+re2Rp390vLphMwJAo2JN9667+NzgzPLTohT3UaZN8/H3hsABE0LRj6x66Im/O1o4C1xPENJpQ4WC29nVfvZqa//qQAUfP/ORx4+r8GcEQL2xsv9d677Q8tLK9xxE1TOTmatTEIUGDBiQqzi5vq1/278t1o6E8U2jurLRcd4rRNMRUESQ0rfi51grz1T+55TE6MOnga0SrES15yx9vgXEEKHs5Jq1/dvuW8gUb6bxrScLLNauuekAMETw4Vbzd7aVP+yqzoXfX2lH//NXoKMBKOFmDIICSqrSbI05WHE3nl4YuHNbe3vQMTAQ4hU8zBTCJyKIPoqV4sztcNTsy4aCM4sUO3cIflczZF8CFAjq3Ms0BZa0BoEZCt2nT+0fuO2k8KdjQ/sjcKrF4ErbTG3ewbNR0qKFaSuj5d0/RLxjL7RkI8MlnbK6bbHWDDn3aJs0/4lmMqZ9YMDh5JgSgKhkV90CgY45K1Zo1QAGaL76RTRd/tPIv4QG4AlBUENEFfElFtxEhYLD+ryeCFvHFw2AerOh9BDOJqY3SRlH7lKj2k6aikXiot1I3fA8uLUSWcNRIKiqLLOGq6KfXtX3xPa+BnLpL18L6Iz+btReapsRdwJ/TN5PERBaDBD86jCW3fgcgnUHoaN27P8KSNwwDzr384D1UwpwZ6HgT4p9egCk5m3eiuliLCu0bEHNDqnrXkBi0y5olRFBJppkJgg+s/LBgaH+dJpPup5pABjLfh7AclFciCoAnYbzYQUcAY7RdOkupK59ARpzGlQDc8i7fXHRf1GA+guFBXI9Skv7mo0F5KO/hWJfawM6JQyhRDOgHajmdooWsV87iGU3PudTrypByua+ZYWBfchkeOGeSCFd2tfk41g6ec2YsNspCWAYfsLXTeWSihamrcL2+h8i9p019+u3QcjkgfzCaH+md+nuuNuzHVTIkZtxJdzXB9vVBRc+YO60Lfy74TAcEWbF+6tCA0sUevlFcL5bR6txqObaGub/s1nlXI7kzX8xdC6z+SoBHD0CsIQ2ZBC8iSdjvjzyN30fX35XpldNvpv8lBbQ2TnW7nsNPI7tfM/sxoKEGgzj8ZrwmWhh3I8Ynwxs04aIHRcsJQBUHGyM4ct0CYC7pnVBdS3VPiScp9NqUMx+RRoVbgw8VivqGAvk/w0CEVd2ANUsYEmZgHcVa0D0qwCQ7yaZOgj3RJMvlrBaldaoB8bVwLPLrkJAoc8CAPYueOrJBGIa+7lELlUL7xmqZ1yY3bcsUs0js6KjAYjMgoNVBKS8n70+qUKZwa4M52FeBABsf4Xm/hS5ISJa2WztmvFKPjEA+dpGW6vLbAykCp1L58tEHOtgNajurd30FVp8EakKQCYhhBUAkJ1JJUxekzC1YDp71DXKR3S0ZRjFk7UuhE0A8twMADs2TGUBteENzJxDmY5ZXwW/wCue71coiA3YUmzGXJDRebgMOvzJ21e8fHZJz7NKh59kF8lkFaSDzjkDivoDgviGBOxJAKLa0M6GDVVQGW7ONUAUOZhSaEHTSQAQbaT36qYHIBO5HvU07GoknM6BPvYCENBa8bG2iVKvV5gDIlUPgVZrmSamrQNiNtwnihFjMGvxE4FEIDYBY9S/GgCw4RUcC4hIfAiojALA+vVHSvRoALRW3+8n1r1kamnlHFIvBIASvR7AeIZ1AQNdlHbXVKYRF8YfvjJH/69EDBVXAWEQQO1EtUkAqB8LQ10ok+qu2qYVnYPXI3hABW8EMNZhW8BAR/X1YqwzMe8LM9pvM11KzgZEdFBSy/dPVJQeE4T7+8f2Cv0QppbIzv7G7KsEQ/h1/RZWEkFUF9QKKNqtSvWf879AdWPQeaiFEluo6L7OQRyaCNNj6ejDK3pmzqUfEQUuFJdIrLlr/zlp4Lmv1TptDWvI53KRYlT2Hfxx84qW9khgIYDGPCdITEYorKoG19lE08dcZdQTZrkjXKHMDE/4eS5HUu9hTAlAnbkUwZNcrkWE2WRAIMSpipdcSm4ZvogfG11+DfDcV3syWT3WA87f7z/292eVADy1UKbVdevIe4hpTkdgUo2WgeJ5AOjHsbT8sQBkohcE7P43rNrdQYzWzqQvrDWTjVMVhcppyB5qN3upGc2m+rYLv3TlGTnkdiGbZeRyDY8H2aw2tCW5Y0e01p+sGGCodKmT+s7pWYbgKIUhwrOTvcZOhFqtgzVUfQDfQwyXwUGmsgQPQgwCIsHnRzbgc8X1MARKScVTKtHiRqs3gpBNZ/tNYQEaM0ebdSMAzeWgm/7yNRuIzXoflpUw+wcRicj4SlkBeabm3qUwIyqiv/Z3xdaaCenkwmfEKcSgBPjDwTfi74uvQ4IEMXh4MEvZKUF/r/3r164u9BQ8dOnXBBFjSSqCd5p40gIy+9ilqmxiEHG/KAfLfwAAuQlo+ckAiNxQ4L7lRlFhhj26IlYAAkKcKng6XI0bBjuxtXImVlC1VghQVJQ5L6Y5tkaHS38GgmbymaV9gIcq5TOQS7O6DMANvloF5qD9CggHAUAYePRmGkZWuVanTA8A5SCaBVMXXlDRR02iJu+xKovAUMSoit7iObhx8Dex07eglavwR1VuRMS+GIqJBR/ouOfqC/LdeZ/pzZilKv9MHgwiLZtDN8aaUqeLq3rM4UwNItQP2nwYANKTfMbkH1zbH6pK94APS9WDECOHKgi5Qx3IDrdDwUiSg5vYu5CKggKOK+sd63szsXFRe0lq/yV/q21s7c0+rGjt+MzZh1+wceWiU4cH6v5/tgB4AIilwvvdCPYaC+OUNE5V/NS14L0H34x7SudgOYdg1J6ynjwYsS+G3jbHOhLefyrfnffp/vSSs4J0DwyINKwMf8rGm9aIq8pctF8VamIJUvFP9fnUD6BKkyUKPJUJaS8MXYQDAtzDTUCCqv7hyhm4YTCNp91qrOTKMS5nisKG3WjVB03Bh9rvueL9ha6Ca7/9pmDJCD+rtpAj1/UXB24I4qnrw/KoJ+I5KQkRhAxDlf8dOZJ0z+QZ5NToZiKSJab0j5VRlG4vbTB/MHiRDmsMLRTCzU45iJTYV5znePCPF3z5qmsG3ndHmO5LL3rTpv2mbUEhR64zt+/XOWj+nHcVIZ1rbaFKZIwrFYtqTS8ATJV683RIvqM3Y+it1R99YP8b7/4nPZ8ScBKDwM/FhRMIXlm9kkmYL7d/+fItha6Cy/RmzGLFhPabtgUDd3SE6ez+15pY6mvE1KziIl5pbsObeJJE/TcKf5r8aTarjCnqlGlRzm9fr1DQ3aO/clu8XB5lyyRK8+gZE8EJIGo4Gbu7/StXfSTfnfcg6HHNjhSUzmbtwB0d4aZbBy+0yeatZOwpPizLXIqucetjH1ZVrf3s+Kp6cp2cSWrWmzH/3p33F9xzxW2xluTN4XDFE8/vqIJava0mGbArh18qDfEf7bgxfwCa5VouLAsm+J60KeSiZ5PfktUtmizdTmRTPiwLEfM8luRtImXC4vDD/Z9YvhlZmVL7Z2QBAJDP5EWzWSYbfNKNVneauGFA5ycgIoKA3GjVB8ng+qZW/W77vVdcDsoJKCfQLDfUNWWznM6mLQhayBXc+V9495qOf7v68+HaR+8ml0x5VxbieZ57RAz1IcTQrYAiM4NO4IwXl+nNmHx33r/hniuvtE2x+6XiHLQxux5U1Ju4MSCCOrlfnP7NwJb7Hh9/7zF3mMuN61hNremZfIb3bN9DBXRKnQRc35tJNUFvIKKbOcFnueKoxPZfRckDWyJZcAVQMwftFx8kW0xYHPmPvltarpiIep4XAONBaL/7yi8FyxPvCocrjqhRp+JGFmWaYuzLoQD0dYW/M4B9+LHufOlobc5s2EF7tu+hsQZGP9C2oU1rIB2z8At6M+eQ+AwD7zFNsXOk6iFV74nZqBmGHf4NJHd/AMathpqRWYKgCrYKoKxMb+i7Of58NgtqOADIRv754vO2LS/bxBMcmLN9xQktwJFlJhlAvUCq7seieACqWzVGTz4l5ufonv40k/N7M2uM+PNIcRGY3wLoxaYpaNKqh696TwAfznQMlIfB1dOR/OUHEZReD+VhHNGdnHrWLkimbHV06Ja+W1pvnehBjMYAAAC9GYPuvL/g7iveaBNBvwoMnOd5pG2T4KBCBOLAMsUY6hRSdkVV3UmkL6rSS0R0QCGl2kKSCloB0CkEPR2Es8jwak5YQBRS9hARH/U1JlIYA3AZKhaJvTcgPnhZ5I7gpgyV9cDrSiPfO7ctdfHBB/OSz2dkumfD5g4AgHQ2bQu5gmu/+8r32pb4P7tS6Ehr23kbn7aIgoRUmQwzWQYZHicTGsfPovZVDAJ1CnWiSvBQJQLx9E/7RA0r5SKCwUvQtPe9IElATWkSl6RCJgBEi6ELL3zkE8t+MFPfPw722Y+dhZ2Szqbtd//gW9tOefu5iWBZ/M1jZt3wQTTmLgSqIiqhFwlFpCoiVS8S+uj3UERCr1GdgXqrnolmIvw6iATSOHzTD+CSz8KU1sG4tTVrOApwYm9swvhq8d2FTyzvy/Sq+dwHZ9ccmnMuv7OwUzO9GfPgtfc9sPay804PWuIbJfThfD5zRpU0iGqnHXLta8QO/z4m7MPftjTnYkGSkNhuhC3fAYdrYCvnARSOgQRQaJuag7A0fGv/La2fSWfVfvOD5Ge/pHkWNejOMPJ5ecO9V/9rrCV2QzhcdQSY+QlgqQwGKITCIX7gaiT2XVuTfdUFTS22MjJyV/8tLb8bBV3M2O83DoDxvD5B2++96g7bEr/RDVeOyjJO5FHb82VGYA9tRHLP77t4fK0NS8P3PvznLddF6SZ0LsJvDABjIChApO1fufqTNmn/xJc9VKShKeqiDmUVc0jiwToT+/F7v9g5/Nr35Hpqe5dp7txY4zRUQejJEnI56bj3qpsoMJ8hpriv+Fk/6L3kZK8qxMQmEYerHvr0QPc3Php1oOYn/BlzQTOEUpHLaaY3Y7Zde/8dUi5vFi/PB6mYhaqfN3e0eMJ3JmGZGFVXKr1/IPONj2Y/odwI4TcWgNp88915n86m7cC7/vM7eqD8JlcKv8iJwFBgWRUOemI8MakaPSUdpOJWQtkuFd008M6v3p7pzZhcjrQRwm+sC5qENwKA9nuufAcH5jZOBGdLMYR48TPPzY+75EUBNcnAaOihop/VwaFbBt734FC9AG18iF+wxUSMZL4771//L5e3xlL2Ywp8yCSClC86qOiSSVlrGg8Tt4YMwVfct31V//ypd93/yNEKdeIAMIE1dHzpt1+jgf0IMV9nkrZJyh7ivK/VWcfZKlRUSYhgOWFBBLiK+z5BP72t+/4vA1GXLp/JC2hhXOfxW+w4awCAX7v3ivNi1twEwRaTCE4FDhNmEQExGWk2rzmoQgUgJcBwjIljBr7kIKIFEG4v7eD7duTy1YXU+sUBoD5qXH59YRvvv2KVls3lMHoNQBebZNAEAFL1UCeRayBSqEYEg459Qw9NJuTo/6q1L/TR2kKZmJhiBmQYUnWQUH5CTN8guK880f21705kscenzFuMcRQQANB+7xVng+gtIL6EFBvBdJZJ2GiWolBfu0THvp75GK6IameVmOiqbyrX0EMqfkgJOxR4BKJbY9Z+d6zZc9hCBcfxYMHFz0LqC8/0yvjUbn1vJhV3so7gLwDx6wh0HqBnAGgDsIyY4mT4CHKyZjEVAg6BaJ9CX4LiRTDtINVnvbgdT235+ktHx6f1mfWaW6hNAEsegKOsIo1+7uzplAkF0psxG0thq8TQKmqaSTlg4xgAxKuQBlWYsAhxQ6nThgcLXROmjJTOpk3bhjZdyOB6YgJwDL+UpXRPPwPA+Mb6bN3cnu17aKkI/MQBYHLCA+jJEnqATH7HEfPPZ9YregD05Ooc7clDYk+Ok2NJj/8HGf3HRAF6eTUAAAAASUVORK5CYII=`,
  meta: `data:image/png;base64,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`,
  huggingface: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAj3UlEQVR42u2debRlV13nP7+9z3Tn+4Z6Va8qVUllghBCgBDigKIBbSbJagaFtWxsW3sxiIit0trqUmjsVpGmtRXtpU0rItINgko3TQMGFMQECCFkqqRIqIz1XlW94c73nnP2/vUf57xXtyqV5NWQIvSqvdZdr+rec8/Z+/f9zb/f3hfOjXPj3Dg3zo1z49w4N86Nc+PcODfOjbM65Ntx0qp6wnmLiJ4D4MwTevoF4EXEP8r1duo6BfTRrj0HwGMT3ZQc7R7juniK0PljgCKALa/zTzYpkScR4U1B86NEL4l3KeRPxenliFwAuh10EZXZcv45MAbtI/IwyEGM3AX2LmC/iNx3Ail50kiGPNkIr6o1yJ+P56XA96F6MTaMTunmPuuC2YeRfwDzaeBGEelMPZdvNRDyJCL8peBfh3evwYQXHXf5gNERoX9Pl8HDEaOlCuODA1QEVU+YhFR3x1S2d2hcEFHZVSWsASTHAuLuA/kYxnxQRL78ZJAI+RYR304R/ip8/jPAKzFBtbwkpbNvyPINjqXrAw7/k6N/sE42cOQYlAg5bu6KQ0iJxBK1U2au9Gy/JmPxhSHzz4W4WSttAfhcMcHHgHeJyA1TQJx1GyHfAq5XEVFV3Qv+V/H+X2CCAIBJp8d9H0u5630Bhz4fkREDhqicqRFQU5jTEy3FKKgrzTLg8Bgc9W0j9rwi55IfE7Z/ZwwUQLvcY4MPl0DctDHHsykNcra5vgThZ/H5L2GCOUDp3NHh1t9zHPhIQm8lIcASUjCsV3AeIMeQYSXEisOaEcY4FMH7kMxXUc1xqnhijAiBKVboHUxQLBMWnj3msp9yXPqvYqBeSIRPMeaPgF8TkfVpCf3/AgBVDUQkV9Wn4f17Meb5BcevdPjqO3Lu/P0Kqa8QIxgLuQevnlDGVELHTCWjEiYk0YBA6hiJEMkxpbrwanFq8b5L7jzDLKI3SelNQkZ5ghIS2EJCMg8ZjoWn97j6ncqe6ypTtuI24F+KyE0bc/62B0D1s4HI9+eq+gp8/ieYYAYYc9f7hnzpFyIGqzUSETCQOzCMacYT5mqOViUitiFiSp2v4AHVR1FBG2oKUDzej+mnGSt9x9ooYuwSjATY8lkZKRe9fMB3/X5AbXcFCPB+iDFvEpE/Oxt2Qc6S2vlp1P8eYmC01OXzr3fc87d1YkJsAFleEH6+NmSxaahHVZAI1UIF+SlTyyPM77Qh1s11bYRzxhRgOD9mdTDm4W5AL6sRisUYGDtIWn2++/cyLn5dDdhweX9FRH5j2m592wCwEc2WxP9V4B2Asvz5Dp96tWG43CQJwOfgyJitDDi/LVTjGmhArkyR8jQnU/61JRheRxzuj7h/PWLi6kS2sBFjMq54fZfnvbcGJi6f/F4R+aknEgR5gnX+O4FfBnK++eEun3lNFeMTggDSHBLbZ+9symy1gRBuEv6JkkstpcIaSF2fB9ZSlvp1rEQYC4Pcs/cHOrzwryuE1ai8+r+JyE8+UepInkDi/zLwTiDj7j/p8Ll/3SA0MQJk3jFf7XLhXEhs62T+iSX8iYAIBIzkHBl0uWclJvc1ghBGmbJ4TZeXfDoibMQlCL8lIr/4RBhmeYJ0/qtAPwyS8Y0/7fKZH2+QmEKnO805f6bD7lYTpyFOvzXh4AbgoYFR1mPfIccgaxOGMMpg8Ts6vOyzCTYJSxDeKCJ/dKZdVDmDxDci4lX1Srz7AsbWePCTHT7x4iqRLYnvMy6a67PYaJJ7i0cfw6SePSBCA5nrs+9QRncyU4KgXPDiNV70iRreRRibAd8rIjeeyWDNnMm8fZEi9n+GsXW6d3X41D+PCDY43+dcMt9nsdki8/Zx/JmzmwvIvBKYOk/bHtGK18gyqIRw7/9pc+NbBxjrS+/oA6ramlrzkwOADY8H/NvBXIlPB3zqFQY3rmKkIP5Fsx0W6i0yZ3iyDUHIVTFS4ykLIbVwnTwTaqHhq7/b4P6PdSmc4YvBv6vkfvOkAGBK71+D158HMm5464TDdzSIAsicsrPZYbHZIvdPPuIfCwKEps5TFyzWDPEOYhty/Y9HjJeHBQjmJ1X1e8o12yeDBKiqCt79NsZaDn2xx61/WKcSCHkOjajLnnYd5wOe7BVbATJVKmGDi2ZHOJ9hBcadGl98U1ak+FSA395IY39LASi53wMvx9jvBT/mH99gMRR6X2TMJfOClRj3+CZfFbwvcm96hsDayOV5v0VqCULmYb7eZnutR5pDJYD9H61x8PohiALfAfxw6XTYbwkApRHyqhri818H4O4/HXDw1vqm6tnVGlGNGmSP72p6D2LAVBVb80ioeH86zFHc00TF/UxVEWFr91RA1bJnJiIyA7wHKxE3vNUAk+IK/4uqGjKdKDnLEmDKqPCfYYJn4rMRX3t7RCwW56AaDNjZTPBetsL5puqZpMLNX0/4/A01Dh8OMLVTXJuCBIqpeg48EPG5L9b46i0J3oFJFPVbUEW5QhTU2dOekHlHaGDp1irf/Mi4XP4zgJeUtY1TloLgtLMsPnsDJoB7/3LAyv0zVANIc895rYzAFFHuYwCgHqTquf6LdX7ngzM8dDjEeWhWPa/9wS5v/uE11MmWOUVL4ncHlnd9YIZP3lBjODYYgcv3TnjH649w6d4UPxGMPA4I3sN8vcrB3oCxaxJKwK2/CXtfNS5T2G8C/uZ0bIE5RfWzEXTtBfMCEMedfxgSiMV7qIUDZmvVQq88jtqpKF+7rcJb37PAfUshUaBUYmWUGt79wVn++KNtTMWflDrywL977zzv/0QL9UI1Ke55090Jb3n3AuvrFrH6+HbGAYFJ2Nl05N4RChy8qcrhr2SA4P3zVfXikhbmbKqg4nsueznGJnT29Vi+MSYsg5qFuiM0heF93Dhcef8nmowzoVHVIvvsIbDKTMPxF59qsrocYsLHJ9gGoDffVuH6m2rsmHMgRw37XNOx/8GIv/37OlLZoo3xCrO1mIodoQKeiHs/4IAcY2LgVadDy1MFoJy6vhyAez/sSDUGA6GMma2GJ6SWMYW0qqJiMAayvuWehyOSSMnd0csEiEJY6VoOHAxgCwAogFVuvy8qajty9FUAJIQW7jgQQS6ImZrXRu1hWi9JCYA1FeYqGZkr4uEDfx3i86y86cs25OVUomNzGupnEbHPBXIe+F8BIYLzSivJSIL4EUk2AQ6vw4Hl4rXaARGMVULrS6+1ePWHhvWeoTc0iEA11tL93tqoREqaC72hsN4zjNKj+t4rVGIFUwIqAivdYk73LcGR7rHzVhSDMFcXDBmBgc59ESs3p+UFz1TV80qHRM6GES4fkl+FCeoMl4as3hwSAqlCu+IQCQqKTnHYWq8AwBSYy/I6zobYnTHXPnvIV/ZVaNRy1nuGV39/j8UdKdffWKdZ81y0J4VUNr766BMTIBWuuXzEU/akXLiYcdUzRtzw1SpfvC2hWSvqDS+4aljWBgx0+rC8dpTzD61BaKFVL/SWIDgPlTAhtmMyQjwBD1/v2Xa1w9ga8FzgwZKh/dkBwLmrsAEc+VKfSTZLYsG6CfV4Q/1McYTCcFIsUqR4VxUzHKHjCj/2si433Z3wv/+xzo++qMs73nIIDLzxh7qkuRAGW1uWESAT9izm/M1vPkRS8VDz/Mj39Xjtryzytf0JP/uaNZ539RA/NNhAYTg+2vKysbzBuABgus03sAH1OOXICAyGpb+3XPlvPUWt7ZnAR8+WG6oluz0TgJWbEzwGD8SBUAkCvB6X6ZSCq5xStJsUAEgcok6o1Rx/8G8O8QNXD3nJdw7QVHATQxAoUagnHeqogyRRNBfcakCj6XnPWw5zx4GY667todmGShIIg1LPb2rywvhMs1DxN6CZTDg89AQY1u80uHyMDULwzzyGNk8UAFPRr8HnFxYAfG2CpYkqJGEfY9p4faRzPtMopGBUqs56BVo1RD2aCUmivOa6DowM5EIQlBX2U6jXiBQgiFDcZyxccmHKJU+ZoIPCrhSE9TBTL+Y1nBydV7tWBijHsV0U1AHFAIP7Ybxsqe0CuGAqKSknU7Y8aQkoIr/1GUxjAYD+PabQfB6SIChWdwIAAgu7t8FoUqy+EpctJEWKQD34buEZiZx+tUjk2H/7VNCJYM1xRLXlvIZlhqESH/WKpq8UFSpBhhUP1PC+ynh5TG0XeJ3H0AJWn2gvqFjWOG6CmQWvZIOZ0jFV4iDBYE/oL264OfUq1JNNOzBNJGuPJdyZLHoZ4VjiT88LijnVq6X4PMr8Q6uEppDJHMfg/l75YQuocQp8c2pxQJIkQEQ2GpH30vIuHmvGjzsH73mEinoUP+t0sqI69f0tgboRAT5ahrT4qIJIgpbNX+O1De6pstFvelYCscnEb+ijTWoJitnsGDj1ZLIp2nQwYOseseDc1oEoqp9SSFS9yKo6dwYqH4UYBdiyIK8Y0tVil04R0SVnLxkXxxngMHGEqU41UZ1eoVoFxhPhp9+9QH9oeO0PdLn2OUMacw5Swaeyqa6muVq1fAE2AFtxTLqGz36uwUc/W+dIx/JHv7DMwjaHZqej5kSxZgS+aNxy43jqQ3v2ABiNPJVKhrEJNvSbAJxiQmo6i9npWW7/Zsxq1/K1/Ql7dmS86toe131vj+07SgHLBJwUjoqAhIqExSQ6KwGf+EyD//npBnfeF296kcurAQs7cjQ7jU4A1aITe0MmTJQClQ29cDYAKFZZqUyAIiUrZkjR5m3IXP0oL5/CMr3QqHpaNc9oYohDZWk14Hc+MMtffLLJd10x4gevGXDJ7ozF2RwbKeTC0uGAbz4c8ukvVfn8LVXuWwqJQ6VZ9WUqR2k3HPjT8KykdDRyTTZVrq0UPrXLc2w4Opv1gD7edTG2TdjuA3UEQ+ZylACwxwQxW/ANNnz3Wt2zOJdz/3JAaCEKlKShdAaWv/pcg7/5hzqzTc/8TE6r5ukPDYc7lpWOJcuFSqy0634ztzZJhQt25My3HTg5WVY7SvgAAe3jNUC0hqBUFl05+XWgfyr2Lzh5KVQBBqArwB6ae0OWbixa/SZ5H68JoQEVRchRQqR0STyPDG42I2vEK9hYee5lY77w9QpiFO+K4DSwSrteXDqeCPc+GJH7wr2MAqWeKIpO7ecoW0Az4YqLJ1RaDj8wmwnZY0h8/JwMEJiNCDhDCQgFuhOD84oAAZbWRY3yWytA5wmXgI3ym4g4dZP7gWfRviwgxxMawyhvYyVjfdRjZWDJvRCYETMVR6tSJZCYfCq0LfozpWBXCgQy4YVXD/njj7cK72XaXVfIFIZAEir1kph9DyNXOOIix7KgMcqLnjs4ljU3nrvhfjqdyvkIeJ2wMhjQGQXk3mLNhO2NnMwLuTYIgSAcUNm5QZmDIjI5lY65U0rGqaolH9+G4TpmrxxjqCMKuVPuWTnCUm87RcZE8CgP9x3NqM/F8xMqUbMscucMszHjbIA1IUlUMZFNdOLlkovHXHvVkI9/oU6r4XGuYMp1hW2hcl2k3JoL35gITuDamkNU+LuJIXAQl3sDBiPh2U+Z8F3PHuFHpgjEAuMYZiMGkxGKoRYn1IIYpwGBgf6kwz0rSi9tAhaD4FAO9TMqYY/AGHIPs0+xVBYK5Iz9+tQu/SccACMiqWbjGwCYeUadkBT1FXJiDvbOK3rxy5KeRTAS0E/b3LrU5+k7+lRCw91HJqwMK3gtNlyHZsLu9opub7RFJXjTK9f53M1V8rxQJX2FH6k53uiEnQPDLVXHy63l6sDzn3MhyITrE8d/dIaDqVADvApvefUaQezRkYWAjANrXQ52a3htowhWcrZVe1w0n9BPM25btnhfJ5RCMhRKJRoxyuaKwASYuXwMbKig28o80EnT05yk/rcikqrqizD2NwBo7I3Ydo0jB8TK5qEA1kzY1VyiFnXJ1WMB5+vsP+y5c2nC8mAGowmWEEuA9zW+sdoyB7vrPrP+wgsn/NLrVhgODR2FtzYc/35s2DkoGPDKkeE3YsevA8HIkufCtX3LfzfKnornoXXLz7xqlWuuKlLPEojjmys97u8cfW5AgGjCwcEMdyyN2X8IvK9jKRq0GtGQnc0VjBlv2o1Cx+Vc+JoQCIsklnuHqr6tbMs3J1MZC06C+Bs7Xn4E9R/CBOCzMau3phg7QKhvatkcxwXtHrvbC6R5yoG1dQ72mlgCRlmTIUVaOgdCMynb1mMiQu5ba5h20leJmq98UZf1VPjyh2Z4/brFlT5/4AX1wo8OithHjRII5ALnrVt+LVS+8JpV3vCadfzQqAmN0Bl2ebjfIBaDU7CSIgK5jwiBzmRmc1tTTs55zXXOb7cIgoTArHFgPSIUg+YQirJ+xyrV3cK2ZwWI3QH8lqruFZE3liBs6fQWOQnOd6r6dLz/EsYkHPy7Nb7wU5b1uyoYAjY6RwTIyLlsfp352jy5h8Dm7D/cY3kwQ1Du5FKEWtTnsu2QO8ftSyHOV3HAtuoaFy+0NPdG6p70y1XC98/BgaiYcKhgtQDEg3El9RV0V4q8eh1e0ENHpuhjCyTnzuU+6+N2sSfADrlsuycwcOcyDLM6gpYnTwg766tcON8kdwGBhaXuGvtXG4Qcba8sZN4zc/mQ7/mvsP276yVD/5yI/Ket7iPYKgCFv+HdZzD2Wjr71virK2N8Wi3cNX/U51cUj7Ct2uXShRqZs1gBZcStBzNGWbPgPM152rYO87U5FHios8q9a21CDGrGXLkzJ7F1nyqmpjAQ+EoVvlyDe2LoFXUDEg91D+el8JwRXD1AZxzaL/L+EgiM8x63PBwimpDhuXiux2KjVdSpBwe54/A2IglwCvVonct3VIAYrxBYx12HeqwO2yVIpdtaau/MQ1AZ8spbHc2LauDHYJ4uIt/cilcUbFH1eFV9FiLXAo4bf1bI0ipxCHmmRKZP5i2eKiGCoBweJswNuszXZpg4JbYV9s5l3L48QTTGYImCdtG2qNCuxgTrKWhC5hMO9dbYM6PGqOhQkAD4/j48vw9rAQxMYQwjhaqHpiuyMWOD9E2RH9Myf7Pczcm1QQBEJmWmOhVE2LjI4iiISblo3mBNTOqU2AqH++usDJuboWUOCANCcjLfIAoN41GVL71tnRf+lQNTBV4L/Iet1IiDLRpqD+57EAuT1R5Ln4+JBPLMs6u5yu4Zw3Ay4chwwHI3xtMkkIi7j3hC26GZtJg4pZ3U2dVc54FOhMHjdYihQa6QhBXma+ss9RNCgeVezPbGkNjWJC/Lkv2S62olwTd8dy9FJW1Dps2UTz/O+iwNEoLS5pxXGxHZFplTrBFyX+SyMpQLm2PqUZOJUyIrdMaH2L9SI5BiK5VhxHmNMfP1nGooHFhbYak3RyiGpc/F5MMxQTUAnnds+86Z8IK8FhWwyXpKPsyLcxnImaulJGaWWjzPRbOzXLmzSy2+n1xzrCbsO2QYpl0iK+TesKtdoR72cVg6owxjCpsgatjZDLEyRoDUV3lgLUXEbZ6XZabc21SKVybF/zc+m6qtI5LzwFqO8xVEIDQjtrciUFMqEs/aUPAEtOI+O5oxqYfYCv30CHceijFaI9OcZrLK0xdTLphrUY22kdh55mo5noIWWd+TrqeA4N3CVtMSWwdAZaXgvvPq1HZbcsBIyH1rVSZ+iABjZ6lG53Hljhl2t+/H0UF9gzsPWUZZvyhLUeH8mRzB8XCvRnfcJbaFLq1GNXbUx6QKocChQZ21QbdIbRxnuU50mNl0OiE0cLjf5dCwQSCQqrKrNaYSVMk8xAF0xkdYHtQw5Fwwo4jEhAKDdJ07l0PUt3CMuWDmCE/fUaEetUidKdfa4/61ClYicqC+G5KFsiom3a26olsHwNp7i79RzO4XZ2SAtUJn3OLOpRGTfG2TkE4b7G3v5rIdq2AOkuU17ljOmOQdBGhVGsxVeuQ+Zt9yyMpwjdAo3ht2tSMSOyhapiVk/0rEKOuUIDx+oktRQgP9dJ17VxMCKbo06kGfHfUKzguh8RwZPMS+5SpeExZrPepxDQFGWYfblw2Za2Ftj6dtH7O7tUDuK0XHtFXGWYfbljO6kxbGFuprz0vTzVNfjLm/dEHNmQCg0GPe/SgA67f12f+RiMgU6csAoTuZ4+sHLQe7S1gzxgiMXchMspcrF5U4XGaUz3DnMkxcn1ACds9YRMZ4X2XfoYTepFOqiSoXzqY4skLd+Bq3LVvGeZ9Q5DFBUCAUYZz3uGM5xPtq+f6EC+c91iQYge54nTsPtRCtE5ghO2diArFM3Bq3H/JMXJN61OEZO5R2pU3qDIEpjlN4uHOEWw4GDCezhAjqIBbh7r+M6dw9KsuuL1LVHRtdEqcMwLFd0LwcyPnyLzpGKxWMQK6KlwGenMw3uXt1G3csDRmk60TWkXuoBDu5YkfMbHKYft5i/+GUiR9Rj+pcODMgJ8VhyVyOSNHcO1drcV6rT6qKEZjkdfYtO3IdYkVOCIECViDzQ/YtK5mrYQQydeyd7dNKGmS+vJ+zOCrkpOyZSakEFSZuwL5DOcN8htnKGpfviIiCJs5DaB29cYfblifcs7YNpzU8E7ys4TTHGOgfrnLTr+RAijHbgVdupVIWbC1OyK/CBBFuMuLQjWHhATllsd5ldxuGmWNtmLIyqLM6nqVzMGVHo8/udoCTKoG0eer2EQdW1nioH7E+WmdbbZGFRotKVPSDNKJ26RoKzgt72lUm2RqHhrOEAr2syb1HVrlkW4ScYN6Fkc64+8iYflZ8J1VlV727uUHQSKEi56p1nrGQYcRTTxqAcGTQpZPOsKfRY89MeYSNQO4G3Leas9SvkRNQNX3m62NmKpZqlHHfaoflwSyxCEufN/gsw4Qh+OcBf/B4hnhrADjZhUXJRwE+tUXIiWOmaqlHdayFdsWz2BxysLfCUrfJQ70Wa8M+e+d6zFRr4CvsnYvY0exgZIbcgxLQjIPNjrRppSfEXLLgccurrI5miERYGraZHXaYr80es/HjqNEdcHjUIpIil7NQ7bJ3rrq5QfDo9ZZWtViHKwvK7coMz9k5oRLWS67NWRl0ObCaMHItAknZU19jZysgCmbxaqhYaFf6HBx4rFr8yOJSiwkFmN+KK2q2aIBHBUnaGdWdAzxgJeCB9ZxB1i8SMd4Q2ToXzra4YrHHTLLGyFW5/VCNB9eHqHicWqrhLFGQbPJFrsXreNidAlrh4m0VkmBYRKVYHupYnE+PmXlhKyY81LEEWJxCLRxx0VyMEj+iEATFoVC5Tne9JVTCFk4tqjn3rw2583CTsQuZSw5y5WKfC+aaBKaBK6Wpl/V4sOMIjMUBtQsyws19VelWsg1mSwYYvob3OVDhsjcbMhRjoZ+2uP2gcGSwhpUBYhTVgHo0y2ULVS6dX6EejPnGeoXVQYfAFGphui9IHmWKxT4tJTIVLpjJcDgs0E8rDNNRmd7QTd3fTzMGWVKGjY7zZ3JCm+BUH/X+clxfUKZKYGC5d5h7ugmNsM9Tty1z2Y42tXAWVYsxHiNDDvePcNtBzzBrYgzkeC7/mQAoOyXMzVuhcfC4Tl0x9oNfBbNA1vdTjavCIK9x++GAqh2z2DzEXA1i2yY0Mdvr25ipjDk86FEJbdmyvvXC7EZreDNJqARDsryBEtBPQxoJm5sGVJT+xKCEeKAeDGjGCbk/+eepQjWKuWy2w0K9SmDOK5NvE9K8z5GB52C3wsg3sURTak3IOtOK7qatBGPBFtxUB9lFGDsPjLnnz4sqr3fQTjpcMBOT+pylXsw9azEH1sbMVtbZ1fQ0kjlCk7DYTMqU88m3JRS1BSWxI9K8ARi876NUjuFh57tAtVQnvoiwT7I/bEP1NZNZWpXi4c5nrI9HLPdyjowShIiFqnJpPSOwjgNrE7qTNiHCNz7guPyt46JLzj8b+NjjqaAt1gNkDozB+5x0vSiu5Aoz1ZxmpUXqYKaScd5kwIPrnsOjOQ6PchaqfS6aSzBSPa2TUVQNzgdTxen4BHW6+GgXg57eSSZ5sYMG50bsX8lZGdcQhPnqgD3tCbWogmpUbOQY9VkbF2Y7XXdlogRg8QwWZIIBKBgTM3OFo/tw4XU8sF6lFq3RSlo4H1KL2jx1YcLOcYeHugFrIxhmI9pJlfQUaKIoVoRRnjPMa6U8psQBiG4EZUWCOLIxisNgGWYVstwT2lNvkrQGupOcziRjodJnV0toxJVCzXmwxrMyPMJD3QahhYmHuSvD0gYomPUzAcAG1e7CuTWsneGKX1C++ckJRmKcr3DHMuxud9jeiLGSoBrTTGJqcYrTFJFa6TKeCvcLiLLSn5BplRBI7IR2pdhhEcrRMuFs1ZGsTXC+SuoTjgx67GpXitjiFJqwcg/1uMbV5/UxJsESFXCLI/cjHlrzPNBpIpKU7exjLv85ylqfAF/aig2Qx5f+zWrYHwM/CWTc/PYe//TrTaomAIHUKVU7ZKGRsq0eENsKRoLNPhItbdPJQOBRYiMMsw63PByBVgp/33ZZbAwRaWFN8Z53XTwjlnpVMtcoOXjMMxYzkqBRRNRbfPqGVFG2VUdS2HqnGeNswuF+zqGBZeIKzsfDUDO+57d6XPG2Nh7B8DDwNKC30c5zOgBsZNf3AF8FZoGM297T44a3Jfi8SmwLWXHOE8iYVpIyV/O0kogwqGCw+BIIv4Uk7UZjVOq63Lns6KczGKOIKRpCcz9NrKPSFZQbDLQ8naMRdblsuyW0tc1z6R5p4mWzmrdx7uhmqx6ONO/SGw9Y6VdYG9fIiQmtIFqoHRsP+O73THjqG1vlmdQB8DoR+fOtlCVPtib8EuDj5VQz1m4bcePPOe7/VBUlJgJMUByK6tURmxEzFU8z8VSigEogGBMVuyg3fXE5TlAV7zPWRn3uWwsZ5w0Cu3HQKmXj47Gz3/huVkpOiGx+pxoO2DPjaCdVjDn6Cxsy1cWjZT0YzfB+yCgX+mOhN4HVMWQ+wUhEYIujNous/5gLXj7imncFtC6tFf14NgB+V0TeekZrwseBcB3wvlISFJjw8GfH7PtD5cGPhwzHFezG2c8lGKo5BojtgCiIqQY94lCx0iAwBmNTVGtkzjHOJnTGAf0swEqAtTDKYeGKHgtXR3TvGjFcynCpwU0sYhQTeYKa0ry4RmPviOV/FA7eNEMlKDYXOM2ph552khFHMaEJEOmh3pE6i9MhaR4yzGIm+YjUNYrGMrEEFjQvwHU4qtURe16R8bQ3CwvXVEuW2LAy7xaRnz+ZIy7l5LzBTRAuBd4DvGTq4wmDh1IOfDjnwIeFQ1+MGBMTYAkoNzFIuRNFj+64KDwXXzb1FoaiSP0W4KXkXPSyHtf+j4igmpQ8m+FdsQ0SAbGKsVIk0DC44YDP/ljG/o/UiAgJTNGY6z2obrjDGYpHiQr7IMXesI36sPdFCTMnJzEpO56Xcv6rlL2vCqgsxlPGFuBe4JdF5EMb6eetbtQ7ac/kuLP/XwK8GfTFU7cqpt25a8KDn1Du/zis3BIxXLVlpCrYE+QzdarcmJcH0LfPH/OsX814yk/Ujob4PgMTnthw5znGBuVcJtzzl0Nu/veG1TsTPCEGc8xzp1VYcdy9YoqYluq8Y/6ZKef/kLLrpQHNizbOEJ2+wz7gvwB/LiK9U+kNPaXA6PijfFX1+4CfwLsXlRHztBubMemkdO6wrN4yZPXWgMH9MZ19AybrET5PEC3Oa5awQ/tiz9xVhvNeqiy+IMRG8dSi3wn8RaH+8nrZGiiFtxEMyy7lp+D9+zCmXT5/xKF/ynnwExkrt1RYv31Euh7jXRXEYYIx8VxK+9IatfPHzD3DMXNFldbljqgRH6diKDZQmX8APgh8SET6xzPmWRuqaqePaVHVRVV9g6r+X3X5uj5yeFXNVXWkqj3NhkOddCc6Xs11vJZpNhyo6kBV3XHfu1tVX7n1eY0vU3WfPMGzx6ra1Www1PFappPupHxmr5xTfoJnq6pzqnqTqr5dVZ95Ahqc1r6PMwJEqfemfwHpPOCFwHPw/jvBX4wJmluPA/IBxtwE5kPA+0VkMAW2PEbmaPp3aa7D+9eBPg9jF07i2TkmOAB8BdyXwH5WRL523B4Jwxk4S/pMH1288Ztdj/ixNVXdA1wKXAFcWORKfFLG2o5ih0kfWMaYW4Cvicg9J7I9p6AiF4ArgWeVKmobpuhMwjACM6TYZH0EuKt87ReR9ASMdkZ/8EeeQPW00amjp6obpwB1p8Jpp0uwqTV4vp2Or3+Mxchxvoc+SnHojP4M4ZTKkBOUCY8vzejU87/tfpvy3Dg3zo1z49w4N86Nc+PcODfOjXPj3Dg3ntzj/wEq1ZOEnZDtbAAAAABJRU5ErkJggg==`,
  uber: `data:image/png;base64,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`,
  tesla: `data:image/png;base64,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`,
  replit: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAEGUlEQVR42u2dT2sbRxiHn3e0u7Ls2iopNYVCD+2lHyJGza3n0kJ77EfooeAWiqJTAz3k3k+QS845uoZ8h55MIRAIMTGV7cjW7mreHtYySUqhdXekyP49MOxNg+aZP7s7P2ZBCCGEEEIIIcRCsdQVeOI6DFwa/6Hh9wZkqevZG5D5AjrSSo0AB5v3zOGQcPc5/XHLdfSBu9uMRyPim3XeaAHzhvDv6E2Ouz8G44tZ9O3oFlqsz4N5DMEOzXh4ZNOfP/yVySpKsLYbnyHGAb2XRfFooxd2ytKZJWqSjkFRGKdn8fFpWX7+wSecMcJXSUJo9dcGdGxEPM67uxvrtnM88el5TawinqKc18TjiU/fWQ+31/Puro2IDOjcyBFwMfzxIZ2TJ8Xva5l9fFaDWcuS36zXib0Mzmr/Y+uj8lMbNQNuVUZB243j4+dsgr1XOwFbwN2JYbUTwG41da/WGhC4Jqzqfei1EYAECAmQACEBEiAkQAKEBEiAkAAJEBJwEwUoprA8Adbf5sTwF5kRcblYmAAD92ZLsnbsQd4lAJU70cFTFV65UmIXERXzxKWtdms3t7PPzIeEZwfTe51JMdhat52yJNmm/MV0Z3mAWU1e3aKyuYzE7A3IPttn9n+3PtPFUr6id97v/uDwZYz+fsuxlNeq7ARsFm08K87vvBsYj0uMIo2EtvNIKxvMuqTE+gX+Z6TfKdf2OsH7s4inkt12HslSTg2/Dejc2adexGJ2+D2b3cPu07WCzSqm3SNuM4+ULLtp4OxTLyC3aYCPj8gxqiridboRAEDl+Hnt1dZGuB29u2uj6U8+IOMKnS35g5jR9IxUhfm1mfPNLu6CLGVpsk55NfUI/o0PyWyf2VU6m56Er96zWskjSUAL85/eBelJWEiABAgJkAAhARIgJEAChARIgJAACbj+uAQsreU9M6LhL/rbnHDFN9NhAT0kdT6nuZbN1uSrWaFkxYlAlXcJjj2wEbUP6LxVe8LzTXlLvynvAIe3qLqH5Hm43JJMRsewoqB7OvHHk6q850MCI2ZX+S3FUv7jX7uMpTgPjzpvYSxlQecFvVblIoNZAPdbDGZlbTc+Q8wPWH85Lh5t9GynLB0P6Y5McSAPMJt5Vm/xwn7hZBFrcFvRxHbXgItw7vjb7u7WOjvHL30K5IlPTWmmG6PKj8jnCzOJ86FtrW1Zq1NPE87NTp7419XUIpAnPy+oae2m0YsmI6TzghZ5XpCehIUESICQAAkQEiABQgIkQEiABAgJkAAhATdVwDJexLsEAMs4L6ilfM7KC1jKeUEt5nOWRZKP+Dw7oLdZzDflSfwRHzg985X9iM+qnhfUej7n2gh4VQKkDWbdvwYfckt5V6JPGS5rBPxtXUj7B9TrhRBCCCGEEEL8e/4CxH4Uymdo6lgAAAAASUVORK5CYII=`,
  github: `data:image/png;base64,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`
};
const brandImg = (uri, name)=>`<img src="${uri}" alt="${esc(name)} logo" loading="eager" decoding="async">`;
const LOGO = {};
COMPANIES.forEach(c=>{
  if(UPLOADED_BRAND_IMG[c.k]) LOGO[c.k]=brandImg(UPLOADED_BRAND_IMG[c.k], c.n);
  else if(c.svg) LOGO[c.k]=c.svg;
});
function mono(name){ return `<b class="mono-l">${esc(name.replace(/[^A-Za-z0-9]/g,"").slice(0,1))}</b>`; }
function logoTile(k, name){ return `<span class="clogo" data-c="${k}" title="${esc(name)}">${LOGO[k]||mono(name)}</span>`; }
let logosLoading=false;
async function loadLogos(){
  if(logosLoading) return; logosLoading=true;
  await Promise.all(COMPANIES.filter(c=>c.ic).map(async c=>{
    if(UPLOADED_BRAND_IMG[c.k]){
      LOGO[c.k] = brandImg(UPLOADED_BRAND_IMG[c.k], c.n);
      $$(`.clogo[data-c="${c.k}"]`).forEach(el=>el.innerHTML=LOGO[c.k]);
      return;
    }
    for(const name of c.ic){
      try{
        const m = await import(`https://cdn.jsdelivr.net/npm/@iconify-icons/logos@2.0.2/${name}.js/+esm`);
        const d = m && (m.default||m);
        if(d && d.body){ LOGO[c.k] = `<svg viewBox="${d.left||0} ${d.top||0} ${d.width||16} ${d.height||16}" aria-hidden="true">${d.body}</svg>`; break; }
      }catch(e){}
    }
    if(LOGO[c.k]) $$(`.clogo[data-c="${c.k}"]`).forEach(el=>el.innerHTML=LOGO[c.k]);
  }));
}
let tlCo="all";
function renderCoRow(){
  const cnt={}; REC.forEach(r=>{ const cs=coOf(r); if(!cs.length) cnt.other=(cnt.other||0)+1; cs.forEach(c=>cnt[c.k]=(cnt[c.k]||0)+1); });
  const chip=(k,name,logo)=>`<button type="button" class="co ${k===tlCo?"on":""}" data-co="${k}" aria-pressed="${k===tlCo}">${logo}<span>${esc(name)}</span><i>${k==="all"?REC.length:(cnt[k]||0)}</i></button>`;
  const top=COMPANIES.filter(c=>c.top), rest=COMPANIES.filter(c=>!c.top&&cnt[c.k]);
  $("#tlco").innerHTML = chip("all","Everyone","") + top.map(c=>chip(c.k,c.n,logoTile(c.k,c.n))).join("") + '<span class="co-sep"></span>' + rest.map(c=>chip(c.k,c.n,logoTile(c.k,c.n))).join("") + chip("other","Others",'<span class="clogo plain">+</span>');
}
$("#tlco").addEventListener("click",e=>{ const b=e.target.closest("[data-co]"); if(!b) return; tlCo=b.dataset.co; renderCoRow(); renderTimeline(); });
const coMatch = r => tlCo==="all" ? true : tlCo==="other" ? coOf(r).length===0 : coOf(r).some(c=>c.k===tlCo);

const SCOPES = [["all","All records"],["agents","AI agents"],["other-ai","Other AI"],["automation","Automation"]];
let tlScope="all", tlQ="";
$("#tlseg").innerHTML = SCOPES.map(([k,l])=>`<button type="button" data-k="${k}" aria-pressed="${k==="all"}">${l}</button>`).join("");
$("#tlseg").addEventListener("click",e=>{const b=e.target.closest("button"); if(!b) return; tlScope=b.dataset.k; $$("#tlseg button").forEach(x=>x.setAttribute("aria-pressed",x===b)); renderTimeline();});
$("#tlq").addEventListener("input",e=>{tlQ=e.target.value.toLowerCase(); renderTimeline();});
const WHO = {};
function whoFor(id){ if(!WHO[id]) WHO[id] = Math.random()<.5?"Joe":"Jill"; return WHO[id]; }
const sourceHost = u => { try{ return new URL(u).hostname.replace(/^www\./,""); }catch(e){ return "source"; } };
const shortSentence = t => { const s=String(t||"").trim(); const m=s.match(/^.*?[.!?](\s|$)/); return (m?m[0]:s).trim(); };
function sourcePreview(r){
  if(r.img) return `<figure class="thumb-card"><img src="${esc(r.img)}" alt="${esc(r.imgAlt||r.t)}"><figcaption class="cap"><b>Source visual</b><p>${esc(r.imgCaption||'From the cited source.')}</p></figcaption></figure>`;
  return ``;
}
function questionCards(r){
  const what = r.t;
  const how = shortSentence(r.cause || r.sum || 'Still being investigated.');
  const conclusion = shortSentence(r.impact || r.limits || r.lesson || r.rca || 'Evidence is still limited.');
  return `<div class="qa-grid">
    <div class="qa"><span>What happened?</span><p>${esc(what)}</p></div>
    <div class="qa"><span>How did it happen?</span><p>${esc(how)}</p></div>
    <div class="qa"><span>What can we conclude?</span><p>${esc(conclusion)}</p></div>
  </div>`;
}
function shareIcons(){
  return {
    x:`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.77 7.74L23 22h-6.1l-4.78-6.26L6.64 22H3.5l7.24-8.27L1.4 2h6.24l4.32 5.7L18.9 2Zm-1.07 18h1.69L6.72 3.9H4.9L17.83 20Z"/></svg>`,
    linkedin:`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.94 8.5H3.56V20h3.38V8.5ZM5.25 3A1.97 1.97 0 1 0 5.3 6.94 1.97 1.97 0 0 0 5.25 3Zm5.2 5.5H7.24V20h3.21v-6.03c0-1.6.3-3.16 2.3-3.16 1.96 0 1.99 1.83 1.99 3.26V20H18V13.4c0-3.24-.7-5.73-4.48-5.73-1.81 0-3.02 1-3.5 1.94h-.05V8.5Z"/></svg>`,
    email:`<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 6.5h18v11H3z" stroke="currentColor" stroke-width="1.7"/><path d="m4 7 8 6 8-6" stroke="currentColor" stroke-width="1.7"/></svg>`,
    copy:`<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.7"/><rect x="5" y="5" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.7"/></svg>`
  };
}
function shareBox(r){
  const I=shareIcons();
  const x=`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText(r))}&url=${encodeURIComponent(r.u)}`;
  const li=`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(r.u)}`;
  const em=`mailto:?subject=${encodeURIComponent(shareText(r))}&body=${encodeURIComponent(shareBody(r))}`;
  return `<div class="sharebox"><b>Post this incident</b><div class="share-row">
    <a class="share-btn" href="${esc(x)}" target="_blank" rel="noopener" aria-label="Post on X">${I.x}</a>
    <a class="share-btn" href="${esc(li)}" target="_blank" rel="noopener" aria-label="Share on LinkedIn">${I.linkedin}</a>
    <a class="share-btn" href="${esc(em)}" aria-label="Share by email">${I.email}</a>
    <button class="share-btn" type="button" data-share="copy" data-id="${r.id}" aria-label="Copy summary and source">${I.copy}</button>
  </div></div>`;
}
function entryHTML(r){
  const who = whoFor(r.id);
  return `<article class="ent" id="r-${r.id}">
    <div><time>${esc(r.when||'Undated')}</time><span class="org">${coOf(r).map(c=>logoTile(c.k,c.n)).join("")}${esc(r.org)}</span></div>
    <div class="ent-main">
      <div>
        <span class="kind"><b>${esc(r.kind)}</b><i></i>${esc(r.set)}</span>
        <h4>${esc(r.t)}</h4>
        <div class="ent-meta"><span>${esc(r.tag)}</span><a href="${esc(r.u)}" target="_blank" rel="noopener">${esc(r.src)} ↗</a></div>
        <div class="ent-grid">${sourcePreview(r)}</div>
        <details class="thr"><summary><i>+</i>Evidence & timeline</summary><p class="sum">${esc(r.sum)}</p>${r.th&&r.th.length?`<ol>${r.th.map(t=>`<li><span>${esc(t[0])}</span><b>${esc(t[1])}</b>${esc(t[2])}</li>`).join("")}</ol>`:""}<p class="rca">${esc(r.rca)}</p></details>
      </div>
      <aside class="ent-summary">
        <div class="at-glance"><div class="at-glance-h"><b>At a glance</b><span>PLAIN LANGUAGE</span></div>${questionCards(r)}</div>
        <div class="ent-actions">
          <button class="joe" type="button" data-joe="${r.id}" data-who="${who}"><i></i>Ask ${who}</button>
          ${shareBox(r)}
        </div>
      </aside>
    </div></article>`;
}
function renderTimeline(){
  const rows = REC.filter(r=>(tlScope==="all"||r.scope===tlScope) && coMatch(r) && (!tlQ || (r.t+" "+r.sum+" "+r.org+" "+r.tag+" "+r.set).toLowerCase().includes(tlQ)));
  const groups = {};
  rows.forEach(r=>{const y=r.d?r.d.slice(0,4):"Undated"; (groups[y]=groups[y]||[]).push(r);});
  const years = Object.keys(groups).sort((a,b)=>a==="Undated"?1:b==="Undated"?-1:b.localeCompare(a));
  $("#yidx").innerHTML = years.map((y,i)=>`<a href="#" data-y="${y}" class="${i===0?"on":""}">${y}<span>${groups[y].length}</span></a>`).join("");
  $("#tlist").innerHTML = years.length ? years.map(y=>`<div class="yr" id="y-${y}"><h3>${y}</h3><span class="sl">/</span><span class="c">${groups[y].length} record${groups[y].length>1?"s":""}</span><hr></div>`+groups[y].sort((a,b)=>b.d.localeCompare(a.d)).map(entryHTML).join("")).join("") : `<div class="empty">No records match. Try another word, or report what you found on GitHub.</div>`;
}
$("#yidx").addEventListener("click",e=>{const a=e.target.closest("a"); if(!a) return; e.preventDefault(); $$("#yidx a").forEach(x=>x.classList.toggle("on",x===a)); const t=document.getElementById("y-"+a.dataset.y); t&&t.scrollIntoView({behavior:"smooth"});});
function openRecord(id){
  tlScope="all"; tlCo="all"; renderCoRow(); tlQ=""; $("#tlq").value=""; $$("#tlseg button").forEach(x=>x.setAttribute("aria-pressed",x.dataset.k==="all"));
  renderTimeline(); go("timeline",{keepScroll:true});
  const el=document.getElementById("r-"+id); if(!el) return;
  const d=el.querySelector("details"); if(d) d.open=true;
  el.classList.add("flash"); setTimeout(()=>el.classList.remove("flash"),2500);
  setTimeout(()=>el.scrollIntoView({behavior:"smooth",block:"start"}),30);
}
renderCoRow(); renderTimeline();

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

/* ================= TRENDS ================= */
const css = n => getComputedStyle(document.body).getPropertyValue(n).trim();
// Published data and legacy calculations come from the backend.
const {months, raw, roll, idx, fut, futMonths, cumReal, cumLab, lastV} = archive.analytics;
const mkey = (y,m)=>`${y}-${String(m+1).padStart(2,"0")}`;
const dated = AGENTS.filter(r=>r.d);

let range=[months.length-12, months.length-1], showMoments=true, showSplit=false, ttab="micro", mtag=null;

function smooth(pts){ if(pts.length<2) return ""; let d=`M${pts[0][0]},${pts[0][1]}`; for(let i=0;i<pts.length-1;i++){const [x0,y0]=pts[i],[x1,y1]=pts[i+1],cx=(x0+x1)/2; d+=` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;} return d; }
function band(xs,lo,hi){ const top=xs.map((x,i)=>[x,hi[i]]), bot=xs.map((x,i)=>[x,lo[i]]).reverse(); return smooth(top)+" L"+bot.map(p=>p.join(",")).join(" L")+"Z"; }

const TT = [["micro","Microtrends"],["impact","Rogue Index"],["narrative","Narrative"],["compare","Comparison"]];
$("#ttabs").innerHTML = TT.map(([k,l])=>`<button class="ttab" role="tab" data-k="${k}" aria-selected="${k===ttab}">${l}</button>`).join("");
$("#ttabs").addEventListener("click",e=>{const b=e.target.closest(".ttab"); if(!b) return; ttab=b.dataset.k; $$("#ttabs .ttab").forEach(x=>x.setAttribute("aria-selected",x===b)); renderTrendPanel();});
$("#qupd").textContent = "Last updated " + (latest ? latest.when.replace(/^Reported /,"") : "");

// Indicators use the same published revision as the chart and records.
(function(){
  const i=archive.analytics.indicators;
  const ms = (k,arr,on)=>`<div class="kirow"><span>${k}</span><div class="kopts">${arr.map(a=>`<i class="${a===on?"on":""}">${a}</i>`).join("")}</div></div>`;
  $("#kirows").innerHTML =
    ms("Growth",["Growing","Steady","Declining"],i.growth)+
    ms("Speed",["Steady","Rising","Surging"],i.speed)+
    ms("Volatility",["Low","Medium","High"],i.volatility)+
    ms("Setting",["Training","Evals","Real"],i.setting)+
    ms("Disclosure",["Full","Partial","None"],i.disclosure)+
    ms("Forecast",["Growing","Steady","Declining"],i.forecast);
  $("#kistage").textContent=i.stage;
})();

function axisY(ch,x0,x1,ys,scale,fmt){return ys.map(v=>`<line x1="${x0}" x2="${x1}" y1="${scale(v)}" y2="${scale(v)}" stroke="${css("--line")}" stroke-dasharray="3 5"/><text x="${x0-10}" y="${scale(v)+4}" text-anchor="end" font-size="11" fill="${css("--muted")}">${fmt?fmt(v):v}</text>`).join("");}

function renderImpact(){
  const W=900,H=340,L=46,R=18,T=20,B=40;
  const all=[...months,...futMonths], n=all.length;
  const x=i=>L+i*(W-L-R)/(n-1), y=v=>T+(1-v/100)*(H-T-B);
  const a=range[0], b=range[1];
  const sel = idx.slice(a,b+1);
  const dPct = sel[sel.length-1]-sel[0];
  const accent=css("--accent"), muted=css("--muted");
  let g = axisY(null,L,W-R,[0,20,40,60,80,100],y);
  const fx0=x(months.length-1);
  g += `<rect x="${fx0}" y="${T}" width="${W-R-fx0}" height="${H-T-B}" fill="${css("--panel-2")}" opacity=".42"/><text x="${W-R-8}" y="${T+16}" text-anchor="end" font-size="11" fill="${muted}">Illustrative scenario</text>`;
  // range shade
  g += `<rect x="${x(a)}" y="${T}" width="${x(b)-x(a)}" height="${H-T-B}" fill="${accent}" opacity=".05"/>`;
  const xs=fut.map((_,i)=>x(months.length+i)); const x0=[fx0,...xs], last=idx[idx.length-1];
  g += `<path d="${band(x0,[last,...fut.map(f=>y(f.lo))].map((v,i)=>i===0?y(v):v),[last,...fut.map(f=>y(f.hi))].map((v,i)=>i===0?y(v):v))}" fill="${accent}" opacity=".16"/>`;
  g += `<path d="${band(x0,[y(last),...fut.map(f=>y(f.lo2))],[y(last),...fut.map(f=>y(f.hi2))])}" fill="${accent}" opacity=".28"/>`;
  g += `<path d="${smooth([[fx0,y(last)],...fut.map((f,i)=>[xs[i],y(f.c)])])}" fill="none" stroke="${accent}" stroke-width="1.4" stroke-dasharray="4 5"/>`;
  if(showSplit){
    g += `<path d="${smooth(archive.analytics.realOnly.map((v,i)=>[x(i),y(v)]))}" fill="none" stroke="${css("--s2")}" stroke-width="2"/>`;
  }
  g += `<path d="${smooth(idx.map((v,i)=>[x(i),y(v)]))}" fill="none" stroke="${accent}" stroke-width="1.9"/>`;
  if(showMoments){
    months.forEach(([yy,mm],mi)=>{const same=dated.filter(r=>r.d.startsWith(mkey(yy,mm))); if(!same.length) return;
      const cy=y(idx[mi]); const rr=same.some(isReal)?3.2:2.6;
      g+=`<circle cx="${x(mi)}" cy="${cy}" r="${rr}" fill="${css("--panel")}" stroke="${accent}" stroke-width="1.2"><title>${same.length} incident${same.length>1?"s":""} · ${MON[mm]} ${yy}</title></circle>`;
    });
  }
  [0,4,8,12,16,20,24].forEach(i=>{ if(i<n){const [yy,mm]=all[i]; g+=`<text x="${x(i)}" y="${H-12}" text-anchor="middle" font-size="11" fill="${muted}">${MON[mm]} ${yy}</text>`;}});
  g += `<g id="hov" style="display:none"><line id="hl" y1="${T}" y2="${H-B}" stroke="${accent}" stroke-dasharray="3 4"/><circle id="hc" r="5" fill="${css("--panel")}" stroke="${accent}" stroke-width="2"/></g>`;
  $("#tpanel").innerHTML = `
    <div class="tph"><div><h3>Rogue Index</h3><p>Observed incident pressure from the record, impact-weighted over a rolling 3-month window. The shaded extension is an illustrative scenario, not a forecast.</p></div>
      <div style="display:flex;gap:24px;align-items:flex-start"><span class="delta"><b class="${dPct<0?"neg":""}">${dPct>=0?"+":""}${dPct} pts</b><span>Selected timeline</span></span></div></div>
    <div class="chartbox" id="cb"><svg viewBox="0 0 ${W} ${H}" id="impsvg" role="img" aria-label="Rogue Index by month with an illustrative estimate">${g}</svg><div class="tip" id="tip" hidden></div></div>
    <div class="range" id="rng"><div class="rail"></div><div class="fill" id="rfill"></div>
      <input type="range" id="r0" min="0" max="${months.length-1}" value="${a}" aria-label="Range start">
      <input type="range" id="r1" min="0" max="${months.length-1}" value="${b}" aria-label="Range end"></div>
    <div class="toggles">
      <button class="tg" type="button" id="tgm" aria-pressed="${showMoments}"><i></i>Show key moments</button>
      <button class="tg" type="button" id="tgs" aria-pressed="${showSplit}"><i></i>Show real-world only</button>
    </div>`;
  const fillR=()=>{const p0=+$("#r0").value/(months.length-1)*100,p1=+$("#r1").value/(months.length-1)*100; const f=$("#rfill"); f.style.left=`calc(${(W-L-R)/W*0+Math.min(p0,p1)}% )`; f.style.width=`${Math.abs(p1-p0)}%`;};
  fillR();
  const onR=()=>{let v0=+$("#r0").value,v1=+$("#r1").value; if(v0>v1){[v0,v1]=[v1,v0];} if(v1-v0<1){v1=Math.min(months.length-1,v0+1);} range=[v0,v1]; renderImpact();};
  $("#r0").addEventListener("change",onR); $("#r1").addEventListener("change",onR);
  $("#r0").addEventListener("input",fillR); $("#r1").addEventListener("input",fillR);
  $("#tgm").onclick=()=>{showMoments=!showMoments; renderImpact();};
  $("#tgs").onclick=()=>{showSplit=!showSplit; renderImpact();};
  const svg=$("#impsvg"), tip=$("#tip"), box=$("#cb");
  svg.addEventListener("pointermove",ev=>{
    const rc=svg.getBoundingClientRect(), px=(ev.clientX-rc.left)/rc.width*W;
    let i=Math.round((px-L)/((W-L-R)/(n-1))); i=Math.max(0,Math.min(n-1,i));
    const isF=i>=months.length, v=isF?fut[i-months.length].c:idx[i], [yy,mm]=all[i];
    $("#hov").style.display=""; $("#hl").setAttribute("x1",x(i)); $("#hl").setAttribute("x2",x(i)); $("#hc").setAttribute("cx",x(i)); $("#hc").setAttribute("cy",y(v));
    const inM = isF?[]:dated.filter(r=>r.d.startsWith(mkey(yy,mm)));
    tip.hidden=false; tip.innerHTML=`<small>${isF?"Estimate":"Rogue Index"}</small><b>${v}</b><small>${MON[mm]} ${yy}</small>${inM.length?`<em>${inM.length} incident${inM.length>1?"s":""}: ${esc(inM[0].t)}</em>`:""}`;
    const bx=box.getBoundingClientRect(); tip.style.left=(x(i)/W*bx.width)+"px"; tip.style.top=(y(v)/H*bx.height-14)+"px";
  });
  svg.addEventListener("pointerleave",()=>{$("#hov").style.display="none"; tip.hidden=true;});
}

function renderNarrative(){
  const tot=dated.length, ent=archive.analytics.narrative;
  const [lead,leadN]=ent[0], pct=Math.round(leadN/tot*100), others=ent.slice(1,4);
  const W=560,H=520,cx=280,cy=260, accent=css("--accent");
  let g=`<circle cx="${cx}" cy="${cy}" r="236" fill="${css("--panel-2")}"/>`;
  for(let i=0;i<60;i++){const a=i/60*Math.PI*2-Math.PI/2, r1=178, r2=i%5===0?196:190; g+=`<line x1="${cx+r1*Math.cos(a)}" y1="${cy+r1*Math.sin(a)}" x2="${cx+r2*Math.cos(a)}" y2="${cy+r2*Math.sin(a)}" stroke="${css("--line-2")}" stroke-width="1.4"/>`;}
  g+=`<circle cx="${cx}" cy="${cy}" r="150" fill="${css("--panel")}" stroke="${css("--line")}"/>`;
  const rA=132, ang=pct/100*Math.PI*2, a0=-Math.PI/2, a1=a0+ang;
  g+=`<circle cx="${cx}" cy="${cy}" r="${rA}" fill="none" stroke="${css("--panel-3")}" stroke-width="22"/>`;
  g+=`<defs><linearGradient id="ng" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".35"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>`;
  g+=`<path d="M${cx+rA*Math.cos(a0)},${cy+rA*Math.sin(a0)} A${rA},${rA} 0 ${ang>Math.PI?1:0} 1 ${cx+rA*Math.cos(a1)},${cy+rA*Math.sin(a1)}" fill="none" stroke="url(#ng)" stroke-width="22" stroke-linecap="round"/>`;
  g+=`<text x="${cx}" y="${cy-44}" text-anchor="middle" font-size="14" fill="${css("--ink-2")}">${lead}</text><text x="${cx}" y="${cy+28}" text-anchor="middle" font-size="84" font-weight="300" fill="${accent}" style="font-family:var(--display);letter-spacing:-.04em">${pct}<tspan font-size="26" dy="-40">%</tspan></text><text x="${cx}" y="${cy+62}" text-anchor="middle" font-size="12.5" fill="${css("--muted")}">broke the story first</text>`;
  const pos=[[78,120],[470,110],[96,420]];
  others.forEach(([k,v],i)=>{const [bx,by]=pos[i]; g+=`<circle cx="${bx}" cy="${by}" r="58" fill="${css("--panel-3")}" stroke="${css("--line-2")}"/><text x="${bx}" y="${by-12}" text-anchor="middle" font-size="12" fill="${css("--ink-2")}">${k}</text><text x="${bx}" y="${by+26}" text-anchor="middle" font-size="36" font-weight="300" fill="${css("--ink")}" style="font-family:var(--display)">${Math.round(v/tot*100)}<tspan font-size="13" dy="-16">%</tspan></text>`;});
  // ribbon: when each record appeared, colored by who broke it
  const RW=900,RH=90, first=new Date("2025-01-01"), end=new Date("2026-10-01"), sx=d=>20+(new Date(d)-first)/(end-first)*(RW-40);
  let rb=`<line x1="20" x2="${RW-20}" y1="45" y2="45" stroke="${css("--line-2")}"/>`;
  const col={"Lab & vendor":accent,"News":css("--s2"),"Research":css("--good"),"Government":css("--ink-2"),"Social & blogs":"#C9A227"};
  dated.forEach(r=>{const t=archive.analytics.sourceTypes[r.id]; rb+=`<circle cx="${sx(r.d)}" cy="${isReal(r)?30:60}" r="6" fill="${col[t]}" opacity=".9"><title>${esc(r.when+" · "+r.t+" · "+t)}</title></circle>`;});
  ["2025-01-01","2025-07-01","2026-01-01","2026-07-01"].forEach(d=>{const dd=new Date(d); rb+=`<text x="${sx(d)}" y="${RH-2}" text-anchor="middle" font-size="11" fill="${css("--muted")}">${MON[dd.getUTCMonth()]} ${dd.getUTCFullYear()}</text>`;});
  rb+=`<text x="20" y="18" font-size="11" fill="${css("--muted")}">Real world</text><text x="20" y="${RH-18}" font-size="11" fill="${css("--muted")}" opacity="0">.</text>`;
  $("#tpanel").innerHTML = `<div class="tph"><div><h3>Narrative</h3><p>Who breaks agent incidents first, from each record's first source.</p></div></div>
    <div class="narr"><div class="chartbox"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of incidents first reported by each source type">${g}</svg></div>
      <div class="lead"><h4>Lead source</h4><p>${esc(lead)} broke ${pct}% of the ${tot} dated agent incidents. Most of these are labs' own misbehavior reports. News tends to follow when an incident reaches outside systems.</p>
      <div class="mixl" style="margin-top:18px">${Object.entries(col).map(([k,c])=>`<span><i style="background:${c}"></i>${k}</span>`).join("")}</div></div></div>
    <div class="chartbox" style="margin-top:10px"><svg viewBox="0 0 ${RW} ${RH}" role="img" aria-label="Each agent incident over time, colored by the source that broke it; top row real world, bottom row labs and research">${rb}</svg></div>
    <p class="note">Top row: real-world incidents. Bottom row: training, evaluation and research. Hover a dot for the record.</p>`;
}

/* ================= MICROTRENDS: who · with what · did what ================= */
// Curated from each record's sources. "sys" only names a model or product when the source names it;
// unnamed internal systems are labeled as such.
const MAP = archive.microtrends;
const TODAY = Date.parse(archive.analytics.microtrends_as_of+"T00:00:00Z");
const WINDOWS = [["30","30 days"],["60","60 days"],["90","90 days"],["365","1 year"],["all","All time"]];
const PIVOTS = [["co","Company"],["sys","Model or agent"],["act","What it did"]];
let MX = {vb:null, win:"365", scope:"agents", setting:"any", pivot:"act", sel:{co:[],sys:[],act:[]}, hover:null};
const coKey = name => { const c=COMPANIES.find(c=>c.re.test(name)); return c?c.k:""; };
function mxRows(){
  return REC.filter(r=>{
    const m=MAP[r.id]; if(!m) return false;
    if(MX.scope==="agents" && r.scope!=="agents") return false;
    if(MX.setting==="real" && !isReal(r)) return false;
    if(MX.setting==="lab" && isReal(r)) return false;
    if(MX.win!=="all"){ if(!r.d) return false; const t=Date.parse(r.d+"T00:00:00Z"); if(TODAY-t > (+MX.win)*864e5 || t>TODAY) return false; }
    return true;
  });
}
const cosOf = r => Array.from(new Set(MAP[r.id].p.map(x=>x[0])));
const syssOf = r => Array.from(new Set(MAP[r.id].p.map(x=>x[1])));
function selMatch(r){
  const s=MX.sel;
  if(s.co.length && !cosOf(r).some(c=>s.co.includes(c))) return false;
  if(s.sys.length && !syssOf(r).some(c=>s.sys.includes(c))) return false;
  if(s.act.length && !s.act.includes(MAP[r.id].act)) return false;
  return true;
}
const selCount = () => MX.sel.co.length+MX.sel.sys.length+MX.sel.act.length;
function countBy(rows, fn){ const c={}; rows.forEach(r=>[].concat(fn(r)).forEach(k=>c[k]=(c[k]||0)+1)); return Object.entries(c).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])); }
function mxConclusion(rows, all){
  const win = WINDOWS.find(w=>w[0]===MX.win)[1].toLowerCase();
  const period = MX.win==="all" ? "Across the whole record" : `In the last ${win}`;
  if(!rows.length) return `${period}, nothing matches this path yet.`;
  const co=countBy(rows,cosOf), sy=countBy(rows,syssOf), ac=countBy(rows,r=>MAP[r.id].act), ca=countBy(rows,r=>MAP[r.id].cat);
  const real=rows.filter(isReal).length, cred=rows.filter(r=>MAP[r.id].cat==="Credentials"||/credential/i.test(MAP[r.id].act)).length;
  const noun = MX.scope==="agents"?"agent incident":"incident";
  let s = `${period}, <b>${rows.length}</b> ${noun}${rows.length>1?"s":""}${selCount()?` ${rows.length>1?"match":"matches"} this path (of ${all.length})`:""}. `;
  s += `<b>${esc(co[0][0])}</b> appears in ${co[0][1]}${co.length>1?`, then ${esc(co[1][0])} (${co[1][1]})`:""}. `;
  s += `Most often through <b>${esc(sy[0][0])}</b>, and the most common behavior is <b>${esc(ac[0][0].toLowerCase())}</b> (${ac[0][1]}). `;
  s += `${real} reached the real world. `;
  if(cred) s += `Credentials were exposed or misused in <b>${cred}</b>. `;
  else s += `Most exposure was ${esc(ca[0][0].toLowerCase())}. `;
  return s;
}
function mxLayout(all){
  // Rings from the filtered window (all), so the map grows as the record grows.
  const co=countBy(all,cosOf), sy=countBy(all,syssOf), ac=countBy(all,r=>MAP[r.id].act);
  const W=880,H=880,cx=440,cy=440, R1=118,R2=232,R3=340;
  const pos={}, ang={};
  co.forEach(([k],i)=>{ const a=-Math.PI/2+i/co.length*Math.PI*2; ang["co|"+k]=a; });
  // systems sit near their company
  const sysAng = sy.map(([k])=>{ let sx=0,sy2=0; all.forEach(r=>MAP[r.id].p.forEach(([c,s])=>{ if(s===k){ const a=ang["co|"+c]; sx+=Math.cos(a); sy2+=Math.sin(a);} })); return [k,Math.atan2(sy2,sx)]; }).sort((a,b)=>a[1]-b[1]);
  const spread=(list)=>{ const n=list.length, out={}; if(!n) return out; const step=Math.PI*2/n;
    let sx=0,sy2=0; list.forEach(([k,a],i)=>{ sx+=Math.cos(a-i*step); sy2+=Math.sin(a-i*step); }); const off=Math.atan2(sy2,sx);
    list.forEach(([k],i)=>out[k]=off+i*step); return out; };
  const sA=spread(sysAng);
  const actAng = ac.map(([k])=>{ let sx=0,sy2=0; all.forEach(r=>{ if(MAP[r.id].act===k) syssOf(r).forEach(s=>{ sx+=Math.cos(sA[s]); sy2+=Math.sin(sA[s]); }); }); return [k,Math.atan2(sy2,sx)]; }).sort((a,b)=>a[1]-b[1]);
  const aA=spread(actAng);
  const node=(ring,k,a,R,n)=>{ pos[ring+"|"+k]={ring,k,a,x:cx+R*Math.cos(a),y:cy+R*Math.sin(a),n}; };
  co.forEach(([k,n])=>node("co",k,ang["co|"+k],R1,n));
  sy.forEach(([k,n])=>node("sys",k,sA[k],R2,n));
  ac.forEach(([k,n])=>node("act",k,aA[k],R3,n));
  return {W,H,cx,cy,R1,R2,R3,pos,co,sy,ac};
}
function renderMicro(){
  const all=mxRows(), rows=all.filter(selMatch), L=mxLayout(all);
  const acc=css("--accent"), s2=css("--s2"), ink=css("--ink"), ink2=css("--ink-2"), muted=css("--muted"), line=css("--line"), line2=css("--line-2"), panel=css("--panel");
  const active = new Set(); rows.forEach(r=>{ cosOf(r).forEach(k=>active.add("co|"+k)); syssOf(r).forEach(k=>active.add("sys|"+k)); active.add("act|"+MAP[r.id].act); });
  const isSel = (ring,k)=>MX.sel[ring].includes(k);
  const dim = selCount()>0;
  let g=`<defs><filter id="mxglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter></defs>`;
  [[L.R1,"Companies"],[L.R2,"Models and agents"],[L.R3,"What it did"]].forEach(([R,lab])=>{
    g+=`<circle cx="${L.cx}" cy="${L.cy}" r="${R}" fill="none" stroke="${line2}" stroke-dasharray="2 6"/>`;
  });
  // edges
  const edge=(a,b,col,on,w)=>{ const mx=(a.x+b.x)/2+(L.cx-(a.x+b.x)/2)*.18, my=(a.y+b.y)/2+(L.cy-(a.y+b.y)/2)*.18;
    return `<path d="M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${w}" stroke-opacity="${on?.85:(dim?.06:.22)}" stroke-linecap="round"/>`; };
  const E={};
  all.forEach(r=>{ const on=rows.includes(r)&&dim; MAP[r.id].p.forEach(([c,s])=>{ const k1="co|"+c+">sys|"+s, k2="sys|"+s+">act|"+MAP[r.id].act; E[k1]=E[k1]||{a:L.pos["co|"+c],b:L.pos["sys|"+s],n:0,on:false,col:s2}; E[k1].n++; E[k1].on=E[k1].on||on; E[k2]=E[k2]||{a:L.pos["sys|"+s],b:L.pos["act|"+MAP[r.id].act],n:0,on:false,col:acc}; E[k2].n++; E[k2].on=E[k2].on||on; }); });
  Object.values(E).sort((x,y)=>x.on-y.on).forEach(e=>{ if(e.a&&e.b) g+=edge(e.a,e.b,e.col,e.on,Math.min(4,1+e.n*.45)); });
  // nodes
  const maxN=Math.max(1,...Object.values(L.pos).map(p=>p.n));
  Object.values(L.pos).forEach(p=>{
    const key=p.ring+"|"+p.k, on=!dim||active.has(key), sel=isSel(p.ring,p.k);
    const r=p.ring==="co"?19+7*p.n/maxN:p.ring==="sys"?12+9*p.n/maxN:12+10*p.n/maxN;
    const col=p.ring==="co"?ink2:p.ring==="sys"?s2:acc;
    const out = 1, below = p.ring!=="act", lx=below?p.x:p.x+Math.cos(p.a)*(r+10), ly=below?p.y+r+17:p.y+Math.sin(p.a)*(r+10);
    const anchor = below||Math.abs(Math.cos(p.a))<.3?"middle":(Math.cos(p.a)>0?"start":"end");
    const dy = below?0:(Math.abs(Math.cos(p.a))<.3 ? (Math.sin(p.a)>0?15:-5) : 5);
    const logo = p.ring==="co" && UPLOADED_BRAND_IMG[coKey(p.k)];
    g+=`<g class="mxn" data-ring="${p.ring}" data-k="${esc(p.k)}" style="cursor:pointer;opacity:${on?1:.18}">`;
    if(sel) g+=`<circle cx="${p.x}" cy="${p.y}" r="${r+7}" fill="${col}" opacity=".35" filter="url(#mxglow)"/>`;
    g+=`<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${p.ring==="co"?"#fff":panel}" stroke="${sel?col:(p.ring==="co"?line2:col)}" stroke-width="${sel?2.4:1.3}"/>`;
    if(logo) g+=`<image href="${logo}" x="${p.x-r*.58}" y="${p.y-r*.58}" width="${r*1.16}" height="${r*1.16}" preserveAspectRatio="xMidYMid meet"/>`;
    else g+=`<text x="${p.x}" y="${p.y+4}" text-anchor="middle" font-size="${p.ring==="co"?15:13}" font-weight="600" fill="${p.ring==="co"?"#1F1611":col}">${p.ring==="co"?esc(p.k.replace(/[^A-Za-z0-9]/g,"").slice(0,1)):p.n}</text>`;
    if(p.ring==="co") g+=`<circle cx="${p.x+r*.72}" cy="${p.y-r*.72}" r="10" fill="${ink}"/><text x="${p.x+r*.72}" y="${p.y-r*.72+4.5}" text-anchor="middle" font-size="12" font-weight="600" fill="${css("--bg")}">${p.n}</text>`;
    g+=`<text x="${lx}" y="${ly+dy}" text-anchor="${anchor}" font-size="${p.ring==="co"?16:15}" font-weight="${sel?600:500}" fill="${sel?ink:ink2}">${esc(p.k)}</text></g>`;
  });
  // left list (pivot)
  const pv=MX.pivot, list = pv==="co"?L.co:pv==="sys"?L.sy:L.ac;
  const universe = Array.from(new Set(REC.filter(r=>MAP[r.id]&&(MX.scope==="all"||r.scope==="agents")).flatMap(r=>pv==="co"?cosOf(r):pv==="sys"?syssOf(r):[MAP[r.id].act])));
  const cnt=Object.fromEntries(list); const items=universe.sort((a,b)=>(cnt[b]||0)-(cnt[a]||0)||a.localeCompare(b));
  const leftHTML = items.map(k=>{ const n=cnt[k]||0, sel=isSel(pv,k);
    return `<button type="button" class="mxi ${sel?"on":""} ${n?"":"none"}" data-ring="${pv}" data-k="${esc(k)}" ${n?"":"disabled"}>${pv==="co"?logoTile(coKey(k),k):`<i class="dot k-${pv}"></i>`}<span>${esc(k)}</span><b>${n||"No hits"}</b></button>`; }).join("");
  // right panel
  const chips = ["co","sys","act"].flatMap(ring=>MX.sel[ring].map(k=>`<button type="button" class="mxchip k-${ring}" data-ring="${ring}" data-k="${esc(k)}">${esc(k)} <span aria-hidden="true">×</span></button>`)).join("");
  const mini=(title,arr,ring)=>`<div class="mxmini"><h5>${title}</h5>${arr.slice(0,5).map(([k,n])=>`<div><i class="dot k-${ring}"></i><span>${esc(k)}</span><b>${n}</b></div>`).join("")||'<p class="none">None</p>'}</div>`;
  const expl = countBy(rows,r=>MAP[r.id].cat);
  // incidents
  const inc = rows.slice().sort((a,b)=>(b.d||"").localeCompare(a.d||""));
  $("#tpanel").innerHTML = `
  <div class="tph"><div><h3>Microtrends</h3><p>Which company, with which model or agent, did what. Pick anything on the left or on the map to trace its path. The map grows as the record grows.</p></div></div>
  <div class="mxbar">
    <div class="seg" role="group" aria-label="Time window">${WINDOWS.map(([k,l])=>`<button type="button" data-win="${k}" aria-pressed="${MX.win===k}">${l}</button>`).join("")}</div>
    <div class="seg" role="group" aria-label="Setting">${[["any","Anywhere"],["real","Real world"],["lab","Lab"]].map(([k,l])=>`<button type="button" data-set="${k}" aria-pressed="${MX.setting===k}">${l}</button>`).join("")}</div>
    <div class="seg" role="group" aria-label="Scope">${[["agents","AI agents"],["all","All AI"]].map(([k,l])=>`<button type="button" data-scope="${k}" aria-pressed="${MX.scope===k}">${l}</button>`).join("")}</div>
  </div>
  <div class="mxgrid">
    <aside class="mxleft">
      <div class="mxpiv" role="group" aria-label="Start from">${PIVOTS.map(([k,l])=>`<button type="button" data-piv="${k}" aria-pressed="${pv===k}">${l}</button>`).join("")}</div>
      <div class="mxlist">${leftHTML||'<p class="none">No incidents in this window.</p>'}</div>
    </aside>
    <div class="mxmap chartbox">${all.length?`<div class="mxzoom" role="group" aria-label="Zoom"><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="fit" aria-label="Reset zoom">Fit</button><span id="mxzl">${Math.round(L.W/(MX.vb?MX.vb[2]:L.W)*100)}%</span></div><svg viewBox="${(MX.vb||[0,0,L.W,L.H]).join(" ")}" id="mxsvg" role="img" aria-label="Map linking companies to models and agents to what they did">${g}</svg>`:`<div class="mxempty">No ${MX.scope==="agents"?"agent ":""}incidents in this window yet. Try a longer window.</div>`}<div class="tip" id="mxtip" hidden></div><div class="mxlegend"><span><i class="dot k-co"></i>Companies, center</span><span><i class="dot k-sys"></i>Models and agents</span><span><i class="dot k-act"></i>What it did, outer ring</span><span>Line weight = number of incidents</span></div></div>
    <aside class="mxright">
      <div class="mxsel"><div class="mxsel-h"><b>Your path</b>${selCount()?'<button type="button" id="mxclear">Clear</button>':""}</div>${chips||'<p class="none">Nothing picked. Showing everything in this window.</p>'}</div>
      <div class="mxconc"><span>What this tells us</span><p>${mxConclusion(rows, all)}</p></div>
      ${mini("Companies",countBy(rows,cosOf),"co")}${mini("Models and agents",countBy(rows,syssOf),"sys")}${mini("What it did",countBy(rows,r=>MAP[r.id].act),"act")}
      <div class="mxmini"><h5>What was exposed</h5>${expl.map(([k,n])=>`<div><i class="dot k-exp"></i><span>${esc(k)}</span><b>${n}</b></div>`).join("")||'<p class="none">None</p>'}</div>
    </aside>
  </div>
  <div class="mxinc">
    <div class="mxinc-h"><b>${inc.length} incident${inc.length===1?"":"s"} on this path</b><span>Open any one on the timeline</span></div>
    ${inc.map(r=>`<a href="#" class="mxrow" data-rec="${r.id}"><span class="d">${esc((r.when||"Undated").replace(/^Reported /,""))}</span><span class="c">${cosOf(r).map(c=>logoTile(coKey(c),c)).join("")}${esc(cosOf(r).join(" · "))}</span><span class="t">${esc(r.t)}</span><span class="m">${esc(syssOf(r).join(" · "))}</span><span class="a"><i class="dot k-act"></i>${esc(MAP[r.id].act)}</span><span class="e">${esc(MAP[r.id].exp)}</span><span class="go">→</span></a>`).join("")||'<p class="none" style="padding:16px 0">Nothing here yet.</p>'}
  </div>`;
  const toggle=(ring,k)=>{ const arr=MX.sel[ring]; const i=arr.indexOf(k); if(i>=0) arr.splice(i,1); else { if(selCount()>=5) return; arr.push(k); } renderMicro(); };
  $("#tpanel").onclick=e=>{
    const t=e.target.closest("[data-win],[data-set],[data-scope],[data-piv],.mxi,.mxchip,#mxclear,.mxrow");
    if(!t) { const n=e.target.closest(".mxn"); if(n) toggle(n.dataset.ring,n.dataset.k); return; }
    if(t.dataset.win){ MX.win=t.dataset.win; MX.vb=null; renderMicro(); }
    else if(t.dataset.set){ MX.setting=t.dataset.set; MX.vb=null; renderMicro(); }
    else if(t.dataset.scope){ MX.scope=t.dataset.scope; MX.sel={co:[],sys:[],act:[]}; MX.vb=null; renderMicro(); }
    else if(t.dataset.piv){ MX.pivot=t.dataset.piv; renderMicro(); }
    else if(t.id==="mxclear"){ MX.sel={co:[],sys:[],act:[]}; renderMicro(); }
    else if(t.classList.contains("mxrow")){ e.preventDefault(); openRecord(t.dataset.rec); }
    else if(t.dataset.ring) toggle(t.dataset.ring,t.dataset.k);
  };
  const svg=$("#mxsvg"), tip=$("#mxtip");
  if(svg){
    const full=[0,0,L.W,L.H]; if(!MX.vb) MX.vb=full.slice();
    const apply=()=>{ svg.setAttribute("viewBox",MX.vb.map(v=>v.toFixed(1)).join(" ")); const z=$("#mxzl"); if(z) z.textContent=Math.round(L.W/MX.vb[2]*100)+"%"; };
    const zoomAt=(f,px,py)=>{ // f<1 zooms in; px,py in svg units
      let [x,y,w,h]=MX.vb; const nw=Math.min(L.W,Math.max(L.W/5,w*f)), nh=nw*L.H/L.W, k=nw/w;
      x=px-(px-x)*k; y=py-(py-y)*k;
      x=Math.max(-L.W*.1,Math.min(L.W*1.1-nw,x)); y=Math.max(-L.H*.1,Math.min(L.H*1.1-nh,y));
      MX.vb=[x,y,nw,nh]; apply(); };
    const toSvg=(cx,cy)=>{ const r=svg.getBoundingClientRect(); return [MX.vb[0]+(cx-r.left)/r.width*MX.vb[2], MX.vb[1]+(cy-r.top)/r.height*MX.vb[3]]; };
    $(".mxzoom").onclick=e=>{ const b=e.target.closest("[data-zoom]"); if(!b) return; e.stopPropagation();
      const c=[MX.vb[0]+MX.vb[2]/2, MX.vb[1]+MX.vb[3]/2];
      if(b.dataset.zoom==="in") zoomAt(.75,c[0],c[1]); else if(b.dataset.zoom==="out") zoomAt(1/.75,c[0],c[1]); else { MX.vb=full.slice(); apply(); } };
    svg.addEventListener("wheel",e=>{ e.preventDefault(); const [px,py]=toSvg(e.clientX,e.clientY); zoomAt(e.deltaY<0?.88:1/.88,px,py); },{passive:false});
    let drag=null;
    svg.addEventListener("pointerdown",e=>{ drag={x:e.clientX,y:e.clientY,vb:MX.vb.slice(),moved:false}; });
    svg.addEventListener("pointermove",e=>{ if(!drag) return; const dx=e.clientX-drag.x, dy=e.clientY-drag.y; if(!drag.moved && Math.hypot(dx,dy)<5) return;
      if(!drag.moved){ drag.moved=true; svg.setPointerCapture(e.pointerId); svg.classList.add("panning"); }
      const r=svg.getBoundingClientRect(); MX.vb=[drag.vb[0]-dx/r.width*drag.vb[2], drag.vb[1]-dy/r.height*drag.vb[3], drag.vb[2], drag.vb[3]]; apply(); });
    const end=e=>{ if(drag&&drag.moved){ svg.classList.remove("panning"); svg.__justPanned=true; setTimeout(()=>svg.__justPanned=false,0); } drag=null; };
    svg.addEventListener("pointerup",end); svg.addEventListener("pointercancel",end);
    svg.addEventListener("click",e=>{ if(svg.__justPanned){ e.stopPropagation(); } },true);
  }
  if(svg){
    svg.addEventListener("pointermove",ev=>{ const n=ev.target.closest(".mxn"); if(!n){tip.hidden=true;return;}
      const ring=n.dataset.ring,k=n.dataset.k, rs=all.filter(r=>ring==="co"?cosOf(r).includes(k):ring==="sys"?syssOf(r).includes(k):MAP[r.id].act===k);
      const other = ring==="act"? `${new Set(rs.flatMap(cosOf)).size} companies · ${new Set(rs.flatMap(syssOf)).size} models or agents` : ring==="co"? `${new Set(rs.flatMap(syssOf)).size} models or agents · ${new Set(rs.map(r=>MAP[r.id].act)).size} behaviors` : `${new Set(rs.flatMap(cosOf)).size} companies · ${new Set(rs.map(r=>MAP[r.id].act)).size} behaviors`;
      tip.hidden=false; tip.innerHTML=`<small>${ring==="co"?"Company":ring==="sys"?"Model or agent":"What it did"}</small><b>${rs.length}</b><small>${esc(k)}</small><em>${other}<br>Click to pick</em>`;
      const bx=$(".mxmap").getBoundingClientRect(); tip.style.left=(ev.clientX-bx.left)+"px"; tip.style.top=(ev.clientY-bx.top-14)+"px"; });
    svg.addEventListener("pointerleave",()=>tip.hidden=true);
  }
}

function renderCompare(){
  const W=900,H=360,L=46,R=18,T=20,B=40, n=months.length+6;
  const PR=archive.analytics.comparison.real, PL=archive.analytics.comparison.lab;
  const mxv=Math.max(...PR.map(q=>q.hi),...PL.map(q=>q.hi))*1.08;
  const x=i=>L+i*(W-L-R)/(n-1), y=v=>T+(1-v/mxv)*(H-T-B);
  const a=css("--accent"), s2=css("--s2");
  const step=Math.max(5,Math.ceil(mxv/5/5)*5); const ticks=[0,step,step*2,step*3,step*4,step*5].filter(v=>v<=mxv);
  let g=axisY(null,L,W-R,ticks,y);
  const fx0=x(months.length-1);
  g+=`<rect x="${fx0}" y="${T}" width="${W-R-fx0}" height="${H-T-B}" fill="${css("--panel-2")}" opacity=".42"/><text x="${fx0+10}" y="${T+16}" font-size="11" fill="${css("--muted")}">Illustrative scenario</text>`;
  [[cumLab,s2,PL],[cumReal,a,PR]].forEach(([arr,col,p])=>{
    const xs=[fx0,...p.map((_,i)=>x(months.length+i))], last=arr[arr.length-1];
    g+=`<path d="${band(xs,[y(last),...p.map(q=>y(Math.max(0,q.lo)))],[y(last),...p.map(q=>y(q.hi))])}" fill="${col}" opacity=".2"/>`;
    g+=`<path d="${smooth([[fx0,y(last)],...p.map((q,i)=>[xs[i+1],y(q.c)])])}" fill="none" stroke="${col}" stroke-width="1.4" stroke-dasharray="4 5"/>`;
    g+=`<path d="${smooth(arr.map((v,i)=>[x(i),y(v)]))}" fill="none" stroke="${col}" stroke-width="2.6"/>`;
  });
  [0,6,12,18].forEach(i=>{const [yy,mm]=months[i]; g+=`<text x="${x(i)}" y="${H-12}" text-anchor="middle" font-size="11" fill="${css("--muted")}">${MON[mm]} ${yy}</text>`;});
  const ch=arr=>{const b=arr[arr.length-7]||0, e=arr[arr.length-1]; return b?Math.round((e-b)/b*100):100;};
  $("#tpanel").innerHTML = `<div class="tph"><div><h3>Comparison</h3><p>Cumulative agent incidents in the record: real world vs training, evaluation and research.</p></div>
    <div class="legend"><span class="lh">Series</span><span class="lh">6-mo change</span>
      <span class="dot"><i style="background:${a}"></i>Real world</span><b style="background:${a}">+${ch(cumReal)}%</b>
      <span class="dot"><i style="background:${s2}"></i>Labs &amp; research</span><b style="background:${s2}">+${ch(cumLab)}%</b></div></div>
    <div class="chartbox"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative agent incidents, real world versus labs and research, with an illustrative estimate">${g}</svg></div>`;
}
function renderTrendPanel(){ const tr=document.querySelector(".trends"); if(tr) tr.classList.toggle("wide", ttab==="micro"); ({impact:renderImpact,narrative:renderNarrative,micro:renderMicro,compare:renderCompare})[ttab](); }

/* ================= JOE IT ================= */
const PLAIN = [
  [/boundary/i,"Went somewhere it wasn't allowed"],
  [/unapproved (actions|activity)/i,"Did things nobody approved"],
  [/instruction integrity/i,"Followed instructions it shouldn't have"],
  [/credential/i,"Mishandled a password or key"],
  [/prompt injection/i,"Got tricked by hidden instructions"],
  [/unauthori/i,"Got into a system without permission"],
  [/data exposure|privacy|data processing/i,"Let private data out"],
  [/destructive/i,"Deleted something important"],
  [/malicious/i,"Was used by attackers"],
  [/coordination/i,"Teamed up with other agents on its own"],
  [/publishing/i,"Published things on its own"],
  [/fabricat|inaccurate|interpretation/i,"Made things up"],
  [/discriminat|bias|unequal|unfair|proxy/i,"Treated people unfairly"],
  [/unsafe physical|safety-system|overreliance/i,"Failed at a safety-critical moment"],
  [/impersonation/i,"Was used to impersonate someone"],
  [/misidentif|classification/i,"Got people wrong"],
  [/unsafe output/i,"Said harmful things"]
];
const plain = t => (PLAIN.find(([re])=>re.test(t))||[0,t])[1];
const firstSentence = t => { const m = String(t).match(/^.*?[.!?](\s|$)/); return (m?m[0]:t).trim(); };
function wrap(text, max){ const w=String(text).split(/\s+/), out=[]; let line=""; w.forEach(x=>{ if((line+" "+x).trim().length>max){ if(line) out.push(line); line=x; } else line=(line+" "+x).trim(); }); if(line) out.push(line); return out; }

const MONS={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function pdate(t){ const m=String(t).match(/(\d{1,2})?[^A-Za-z0-9]*?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})/); if(m) return Date.UTC(+m[3],MONS[m[2].toLowerCase()],m[1]?+m[1]:15); return null; }
const shortDate = t => String(t).replace(/·.*$/,"").replace(/ onward/,"+").trim();
let J = null, joeTimer=null, joeReturn=null;
function joeLayout(r){
  const real=isReal(r), W=940, H=230, base=128;
  const th=(r.th||[]).map(t=>({date:t[0], title:t[1], text:t[2]}));
  const wallX = real?210:W-250;
  const [x0,x1] = real?[wallX+80,W-80]:[250,wallX-70];
  let xs;
  const ds=th.map(e=>pdate(e.date));
  if(th.length===1) xs=[(x0+x1)/2];
  else if(ds.every(d=>d!==null) && ds[ds.length-1]>ds[0]){
    xs=ds.map(d=>x0+(d-ds[0])/(ds[ds.length-1]-ds[0])*(x1-x0));
    for(let i=1;i<xs.length;i++) if(xs[i]-xs[i-1]<150){ xs=null; break; }
  }
  if(!xs) xs=th.map((_,i)=>x0+i*(x1-x0)/Math.max(1,th.length-1));
  const steps=[{x:62, date:"", title:"The task begins", text:`${r.kind} · ${r.org} · ${r.set.toLowerCase()}.`}].concat(th.map((e,i)=>Object.assign(e,{x:xs[i]})));
  return {real,W,H,base,wallX,steps};
}
function joeSVG(r,L){
  const acc=css("--accent"), ink=css("--ink"), ink2=css("--ink-2"), muted=css("--muted"), line=css("--line-2"), bad=css("--bad"), bg=css("--panel");
  const {real,W,H,base,wallX,steps}=L;
  let g=`<defs>
    <linearGradient id="jw" x1="0" x2="1"><stop offset="0" stop-color="${bad}" stop-opacity="0"/><stop offset="1" stop-color="${bad}" stop-opacity=".12"/></linearGradient>
    <linearGradient id="jwall" x1="0" x2="1"><stop offset="0" stop-color="${real?bad:ink2}" stop-opacity="0"/><stop offset=".5" stop-color="${real?bad:ink2}" stop-opacity="${real?.35:.18}"/><stop offset="1" stop-color="${real?bad:ink2}" stop-opacity="0"/></linearGradient></defs>`;
  if(real) g+=`<rect x="${wallX}" y="8" width="${W-wallX}" height="${H-16}" rx="18" fill="url(#jw)"/>`;
  g+=`<rect x="${wallX-9}" y="14" width="18" height="${H-28}" fill="url(#jwall)"/>`;
  g+=`<text x="${wallX-18}" y="30" text-anchor="end" font-size="12.5" fill="${muted}">In the lab</text><text x="${wallX+18}" y="30" font-size="12.5" fill="${real?bad:muted}" ${real?'':'opacity=".6"'}>Out in the world</text>`;
  g+=`<line x1="40" x2="${W-40}" y1="${base}" y2="${base}" stroke="${line}" stroke-width="1.5" stroke-dasharray="1 6" stroke-linecap="round"/>`;
  g+=`<line id="jprog" x1="${steps[0].x}" x2="${steps[0].x}" y1="${base}" y2="${base}" stroke="${acc}" stroke-width="2.5" stroke-linecap="round" style="transition:x2 .7s ease"/>`;
  if(!real) g+=`<text x="${(wallX+W)/2+10}" y="${base+5}" text-anchor="middle" font-size="13" fill="${muted}" opacity=".7">never got this far</text>`;
  steps.forEach((s,i)=>{
    const lines=wrap(s.title, 22).slice(0,3);
    g+=`<g class="jev" data-i="${i}" style="cursor:pointer">
      <rect x="${s.x-80}" y="${base-70}" width="160" height="140" fill="transparent"/>
      ${s.date?`<text x="${s.x}" y="${base-26}" text-anchor="middle" font-size="12" fill="${muted}">${esc(shortDate(s.date))}</text>`:""}
      <circle class="jhalo" cx="${s.x}" cy="${base}" r="14" fill="${acc}" opacity="0"/>
      <circle class="jdot" cx="${s.x}" cy="${base}" r="${i===0?0:6}" fill="${bg}" stroke="${line}" stroke-width="2"/>
      ${lines.map((l,k)=>`<text class="jlab" x="${s.x}" y="${base+34+k*18}" text-anchor="middle" font-size="14.5" fill="${ink2}">${esc(l)}</text>`).join("")}
    </g>`;
  });
  g+=`<g id="jorb" style="transition:transform .7s cubic-bezier(.4,.1,.2,1)" transform="translate(${steps[0].x},${base})"><circle r="17" fill="${bg}" stroke="${acc}" stroke-width="1.5"/><use href="#mark" x="-12" y="-12" width="24" height="24"/></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="What happened, step by step">${g}</svg>`;
}
function setJoeStep(i){
  const L=J.L; i=Math.max(0,Math.min(L.steps.length-1,i)); J.i=i;
  const s=L.steps[i], acc=css("--accent"), line=css("--line-2"), ink=css("--ink"), ink2=css("--ink-2");
  $("#jorb").setAttribute("transform",`translate(${s.x},${L.base})`);
  $("#jprog").setAttribute("x2", s.x);
  $$("#joe-flow .jev").forEach(g=>{ const k=+g.dataset.i, on=k===i, past=k<i;
    const d=g.querySelector(".jdot"); d.setAttribute("stroke", on||past?acc:line); d.setAttribute("fill", past?acc:css("--panel"));
    g.querySelector(".jhalo").setAttribute("opacity", on&&k>0?.18:0);
    g.querySelectorAll(".jlab").forEach(t=>{ t.setAttribute("fill", on?ink:ink2); t.setAttribute("font-weight", on?"500":"400"); }); });
  $("#joe-now").innerHTML = `<span>${i===0?"Start":esc(s.date)}</span>${esc(s.text)}`;
  $("#joe-count").textContent = `${i+1} / ${L.steps.length}`;
  $("#joe-play").setAttribute("aria-label", joeTimer?"Pause":"Play");
  $("#joe-play").innerHTML = joeTimer ? '<svg viewBox="0 0 24 24"><rect x="7" y="6" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="13.5" y="6" width="3.5" height="12" rx="1" fill="currentColor"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
}
function stopJoe(){ if(joeTimer){ clearInterval(joeTimer); joeTimer=null; } }
function playJoe(){ stopJoe(); const n=J.L.steps.length; if(J.i>=n-1) J.i=0;
  joeTimer=setInterval(()=>{ if(J.i>=n-1){ stopJoe(); setJoeStep(J.i); return; } setJoeStep(J.i+1); if(J.i>=n-1){ stopJoe(); setJoeStep(J.i);} }, 1900); setJoeStep(J.i); }
function openJoe(id, who){
  const r=BYID[id]; J={r, i:0, L:joeLayout(r)}; joeReturn=document.activeElement;
  const real=isReal(r), unknown=/not /i.test(r.loss||"");
  $("#joe-who").textContent = `${who||"Joe"}, the short version`;
  $("#joe-title").textContent = r.t;
  $("#joe-meta").innerHTML = `${esc(r.when)}<i></i>${esc(r.org)}<i></i><b class="${real?"hot":"cool"}">${real?"Reached the real world":"Stayed in the lab"}</b>`;
  $("#joe-flow").innerHTML = joeSVG(r, J.L);
  $("#joe-facts").innerHTML = `
    <div><span>What broke</span><b>${esc(plain(r.tag))}</b><p>${esc(firstSentence(r.cause||r.sum))}</p></div>
    <div><span>What it hit</span><b>${esc(r.impact||r.tag)}</b><p>${esc(firstSentence(r.limits||""))}</p></div>
    <div><span>Cost</span><b class="${unknown?"dim":""}">${esc(r.loss||"Not disclosed")}</b><p>${unknown?"Unknown isn't the same as zero.":"As reported in the sources."}</p></div>`;
  $("#joe-lesson").innerHTML = r.lesson?`<span>Takeaway</span><q>${esc(r.lesson)}</q>`:"";
  $("#joe-srcs").innerHTML = (r.srcs&&r.srcs.length?r.srcs:[[r.org,"Original source",r.u,r.when]]).map(s=>`<a href="${esc(s[2])}" target="_blank" rel="noopener"><span>${esc(s[0].split(" · ")[0])}${s[3]?` · ${esc(s[3])}`:""}</span>${esc(s[1])} ↗</a>`).join("");
  $("#joe").hidden=false; document.body.style.overflow="hidden";
  setJoeStep(0); $("#joe-close").focus();
  if(!window.matchMedia("(prefers-reduced-motion: reduce)").matches) setTimeout(()=>{ if(!$("#joe").hidden) playJoe(); }, 500);
}
function closeJoe(){ stopJoe(); $("#joe").hidden=true; document.body.style.overflow=""; joeReturn&&joeReturn.focus&&joeReturn.focus(); }
document.addEventListener("click",e=>{ const b=e.target.closest("[data-joe]"); if(b){ e.preventDefault(); openJoe(b.dataset.joe, b.dataset.who); } });
$("#joe-close").addEventListener("click",closeJoe);
$("#joe").addEventListener("click",e=>{ if(e.target.id==="joe") closeJoe(); });
document.addEventListener("keydown",e=>{ if($("#joe").hidden) return;
  if(e.key==="Escape") closeJoe();
  if(e.key==="ArrowRight"){ stopJoe(); setJoeStep(J.i+1); }
  if(e.key==="ArrowLeft"){ stopJoe(); setJoeStep(J.i-1); } });
$("#joe-play").addEventListener("click",()=>{ if(joeTimer){ stopJoe(); setJoeStep(J.i); } else playJoe(); });
$("#joe-prev").addEventListener("click",()=>{ stopJoe(); setJoeStep(J.i-1); });
$("#joe-next").addEventListener("click",()=>{ stopJoe(); setJoeStep(J.i+1); });
$("#joe-flow").addEventListener("click",e=>{ const g=e.target.closest(".jev"); if(g){ stopJoe(); setJoeStep(+g.dataset.i); } });
$("#joe-record").addEventListener("click",()=>{ const id=J.r.id; closeJoe(); openRecord(id); });

/* ================= MISSION ================= */
const PHASES=[{id:"ignition",n:"01",name:"Ignition",live:true},{id:"liftoff",n:"02",name:"Liftoff"},{id:"orbit",n:"03",name:"Orbit"},{id:"escape",n:"04",name:"Escape velocity"},{id:"interplanetary",n:"05",name:"Interplanetary"}];
const IGN=[{name:"The record",d:"Verified agent incidents, sourced.",s:"live",l:"Live"},{name:"Ask",d:"Questions answered from the record.",s:"live",l:"Live"},{name:"Attack library",d:"Open catalogue of attacks on agents.",s:"",l:"Opening"},{name:"Signals",d:"Chatter from X and Reddit, labeled.",s:"",l:"Building"},{name:"Dispatch",d:"One email. Every Monday.",s:"",l:"Building"}];
const LOCK='<svg class="lock" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.6"/></svg>';
let ph="ignition";
function renderPhases(){
  $("#track").innerHTML=PHASES.map(p=>`<button class="step ${p.live?"":"locked"}" role="tab" id="tab-${p.id}" data-id="${p.id}" aria-selected="${p.id===ph}"><span class="n">${p.n}${p.live?"":LOCK}</span><span class="nm">${p.name}</span><span class="stt ${p.live?"live":""}">${p.live?'<i class="pulse"></i>In flight':"Locked"}</span></button>`).join("");
  const p=PHASES.find(x=>x.id===ph);
  $("#stage").innerHTML = p.live ? `<div class="card"><div class="ph"><div><span class="eyebrow">Phase 01 · In flight</span><h3>Open the record<span class="dotp">.</span></h3><p>Track what agents do in the wild. Make it free.</p></div><div style="display:flex;flex-direction:column;align-items:flex-end;justify-content:flex-end;gap:8px"><div class="bars">${IGN.map(x=>`<i class="${x.s==="live"?"on":""}"></i>`).join("")}</div><span class="eyebrow">${IGN.filter(x=>x.s).length} of ${IGN.length} live</span></div></div>${IGN.map((x,i)=>`<div class="row"><span class="i">0${i+1}</span><b>${x.name}</b><span class="d">${x.d}</span><span class="pill ${x.s}">${x.l}</span></div>`).join("")}</div>`
    : `<div class="card lockpanel">${LOCK}<span class="eyebrow">Phase ${p.n}</span><h3>${p.name}</h3><p>Locked. Opens after Ignition.</p></div>`;
}
$("#track").addEventListener("click",e=>{const b=e.target.closest(".step"); if(b){ph=b.dataset.id; renderPhases();}});
renderPhases();

/* ---------- boot ---------- */
setMode(document.body.getAttribute("data-mode")||"dark");
go((location.hash||"").replace("#","")||"ask",{});
})().catch(()=>{
  const message=document.createElement("p");
  message.className="note";
  message.setAttribute("role","alert");
  message.textContent="The archive is unavailable. Please reload the page shortly.";
  document.querySelector("main").replaceChildren(message);
});
