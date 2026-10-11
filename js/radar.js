/* Live Radar uses an independently refreshed API, never the archive's samples. */
window.mountRadar=function({archive,openRecord}){
  const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const names={x:'X',reddit:'Reddit',linkedin:'LinkedIn',wild:'Web'};
  const colors={x:'var(--ink)',reddit:'#d94b17',linkedin:'#0a66c2',wild:'var(--accent)'};
  let mode=null,active=false,source='all',sort='popular',search='',cursor=null,posts=[],selected=null,detail=null,serial=0,detailSerial=0,publication=null;
  let sampleReady=false,queryTimer;
  let liveSources=[],publicEnabled=false;
  const date=value=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const spark=values=>{const max=Math.max(1,...values),points=values.map((v,i)=>`${i*74/(values.length-1)},${23-v/max*20}`).join(' ');return `<svg width="78" height="26" viewBox="0 0 78 26" aria-hidden="true"><polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.6"/></svg>`;};
  const route=(kind,id)=>`${location.origin}${location.pathname}#signals/${kind}/${encodeURIComponent(id)}`;
  const companyLogos={'Anthropic':'anthropic','OpenAI':'openai','Google':'google','Meta':'meta','Hugging Face':'huggingface','Replit':'replit','GitHub':'github','Tesla':'tesla','Uber':'uber'};
  const xLogo='<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.043 9.19L24 22.846h-7.406l-5.8-7.584-6.642 7.584H.47l8.603-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.49h2.039L6.487 3.24H4.3l13.311 17.403Z"/></svg>';
  function sourceIcon(post){
    if(post.platform==='x'&&post.author_avatar)return `<a href="${esc(post.author_url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(post.author_name)} on X"><img class="radar-avatar" src="${esc(post.author_avatar)}" alt="" referrerpolicy="no-referrer"></a>`;
    if(post.platform==='x')return xLogo;
    const company=companyLogos[post.company];
    if(company)return `<img class="radar-company-icon" src="/assets/logos/${company}.png" alt="About ${esc(post.company)}" title="About ${esc(post.company)}">`;
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>';
  }
  function text(post){
    const chars=Array.from(post.text),entities=[...(post.entities||[])].sort((a,b)=>a.start-b.start);let out='',at=0;
    for(const e of entities){if(e.start<at||e.end>chars.length||e.end<=e.start)continue;
      out+=esc(chars.slice(at,e.start).join(''))+`<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.display||chars.slice(e.start,e.end).join(''))}</a>`;at=e.end;}
    return out+esc(chars.slice(at).join(''));
  }
  function filters(){
    $('#sigseg').innerHTML=[['all','All'],['x','X'],['reddit','Reddit'],['wild','Web']].map(([id,name])=>{
      const connected=id==='all'||liveSources.some(s=>s.platform===id&&s.enabled);
      return `<button type="button" data-source="${id}" aria-pressed="${source===id}" ${connected?'':'disabled'}>${name}${connected?'':' · Not connected'}</button>`;
    }).join('');
  }
  function emptyFeed(){
    if(search)return 'No current signals match your search. Try another term or clear the search.';
    if(!liveSources.some(s=>s.enabled))return 'No automatic sources are connected yet.';
    if(!publicEnabled)return 'Collection is in a private pilot. Signals are not public yet.';
    const sources=liveSources.filter(s=>s.enabled&&(source==='all'||s.platform===source));
    if(!sources.length)return 'This source is not connected yet.';
    if(sources.every(s=>s.publication_mode==='private'))return 'This source is in a private pilot. Its signals are not public yet.';
    const paused=sources.filter(s=>pauseReason(s));
    if(paused.length)return esc(paused.map(s=>`${names[s.platform]}: ${pauseReason(s)}.`).join(' '))+' Saved items remain available; new collection will resume after this is resolved.';
    return 'No current chatter yet. Radar checks connected sources every hour for relevant posts, discussions and news.';
  }
  function pauseReason(s){
    if(s.manual_pause)return 'collection paused for review';
    if(s.resume_after&&Date.parse(s.resume_after)>Date.now())return 'collection rate limited until '+date(s.resume_after);
    if(s.last_error==='spend-budget-exhausted')return 'collection paused: spending allowance reached';
    if(s.last_error==='spend-budget-unavailable')return 'collection paused: spending allowance needs renewal';
    if(s.last_error==='daily-budget-exhausted')return 'collection paused: daily allowance reached';
    if(s.last_error&&!['collection-backlog','partial-source-extraction'].includes(s.last_error))return 'collection interrupted';
    return '';
  }
  function sourceStatus(s){
    const paused=pauseReason(s);
    if(paused)return paused+(s.last_success?'; last completed collection '+date(s.last_success):'');
    if(s.last_error==='collection-backlog')return 'catching up';
    if(s.last_error==='partial-source-extraction')return 'updated '+date(s.last_success)+'; some pages unavailable';
    return s.last_complete?'collection completed '+date(s.last_complete):s.last_success?'checked '+date(s.last_success):'awaiting first collection';
  }
  function renderFeed(){
    const focusedPost=document.activeElement.matches("[data-post]")?document.activeElement.dataset.post:null;
    posts=posts.filter(p=>p.saved||Date.parse(p.display_until)>Date.now()).map(p=>{
      if(Date.parse(p.display_until)>Date.now())return p;
      return {...p,source_current:false,author_verified:false,engagement:null};
    });
    $('#feed').innerHTML=posts.length?posts.map(p=>`<article class="post ${selected?.kind==='post'&&selected.id===p.id?'sel':''}" data-post="${p.id}" tabindex="0" aria-label="Select signal from ${esc(p.author_name)}">
      <span class="src radar-source-icon">${sourceIcon(p)}</span>
      <div><div class="top">${p.author_url?`<a href="${esc(p.author_url)}" target="_blank" rel="noopener noreferrer"><b>${esc(p.author_name)}</b>${p.platform==='x'&&p.author_verified?'<span class="radar-verified" title="Verified account on X; claims remain unverified" aria-label="Verified account on X">✓</span>':''}${p.author_handle!==p.author_name?` <span class="h">${esc(p.author_handle)}</span>`:''}</a>`:`<b>${esc(p.author_name)}</b>`}
      <span class="t"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${date(p.posted_at)}${p.edited?' · Edited':''}</a>${p.platform==='x'?` · <a class="radar-x-link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">View on X ${xLogo}</a>`:''}</span></div>
      ${p.platform==='wild'?`<h3 class="radar-headline radar-preview"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.text.split(/\n\s*\n/)[0])}</a></h3>`:`<p class="radar-preview">${text(p)}</p>`}<div class="ft"><span class="st ${p.record_id?'lnk':'unv'}">${p.record_id?'Linked':'Unverified'}</span>
      ${p.saved?`<span class="note">${p.source_current?'Saved':'Saved copy'} · Last checked ${date(p.checked_at)}${p.source_current?'':' · Refresh pending'}</span>`:''}
      ${p.platform==='x'&&p.engagement!==null?`<span class="radar-likes">${Number(p.engagement).toLocaleString()} likes</span>`:''}
      <a class="radar-original" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${p.platform==='wild'?'View full source':'Read full post'} ↗</a>
      </div></div></article>`).join(''):
      `<p class="radar-empty">${emptyFeed()}</p>`;
    if(focusedPost)Array.from($('#feed').children).find(p=>p.dataset.post===focusedPost)?.focus({preventScroll:true});
    $('#radar-more').hidden=!cursor;
  }
  function renderDetail(data){
    detail=data;const p=data.post,mix=data.platforms,total=Object.values(mix).reduce((a,b)=>a+b,0);
    $('#sigdetail').innerHTML=`<span class="eyebrow">Signal detail</span><h3>${esc(data.cluster?.title||'Post from '+p.author_name)}</h3>
      <span class="st ${p.record_id?'lnk':'unv'}">${p.record_id?'Linked':'Unverified'}</span>
      <div class="mix">${Object.entries(mix).filter(([,n])=>n).map(([s,n])=>`<i style="flex:${n};background:${colors[s]}"></i>`).join('')}</div>
      <div class="mixl">${Object.entries(mix).filter(([,n])=>n).map(([s,n])=>`<span><i style="background:${colors[s]}"></i>${names[s]} ${Math.round(n/total*100)}%</span>`).join('')}</div>
      <p class="note">Source mix and distinct accounts · last 72 hours</p>
      <div class="kv"><div><span>First seen</span><b>${data.first_seen?date(data.first_seen.at)+' on '+names[data.first_seen.platform]:'—'}</b></div>
      <div><span>Velocity</span><b>${data.velocity.posts} posts in 24 h · ${esc(data.velocity.trend)}</b></div>
      <div><span>Distinct accounts</span><b>${data.authors} on ${Object.values(mix).filter(Boolean).length} platforms</b></div></div>
      <div class="radar-provenance"><b>Where it’s coming from</b><p class="note">Reviewed primary sources first, then related posts.</p>
      ${data.sources.map(s=>`<div class="radar-source"><span class="radar-source-kind">${esc(s.kind)}</span><div><b>${esc(s.name)}</b><small>${esc(names[s.platform])} · ${date(s.posted_at)}</small></div><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>`).join('')}
      <p class="note">${data.reshares} reshares folded in</p></div>
      <div class="radar-actions">${p.record_id?`<button type="button" data-radar-record="${esc(p.record_id)}">Open record ↗</button>`:''}
      </div>`;
  }
  async function loadDetail(kind,id){
    selected={kind,id};const n=++detailSerial;detail=null;$('#sigdetail').innerHTML='<p class="note">Loading source detail…</p>';
    try{
      const response=await fetch(`/api/radar/${kind==='post'?'posts':'clusters'}/${encodeURIComponent(id)}`,{cache:'no-store'});
      if(!response.ok)throw new Error('unavailable');const value=await response.json();if(n!==detailSerial)return;
      renderDetail(value);renderFeed();
    }catch{if(n===detailSerial){detail=null;$('#sigdetail').innerHTML='<p class="note">This signal is unavailable or no longer published.</p>';}}
  }
  async function load(append=false){
    const n=++serial;$('#radar-label').textContent='Refreshing…';
    const params=new URLSearchParams({source,q:search,sort});if(append&&cursor)params.set('cursor',cursor);
    try{
      const response=await fetch('/api/radar?'+params,{cache:'no-store'});if(!response.ok)throw new Error('unavailable');
      const data=await response.json();if(n!==serial)return;
      if(data.version!=='radar-v1')throw new Error('version');mode=data.mode;
      if(mode==='sample'){
        if(!sampleReady){window.renderRadarSamples({archive,openRecord});sampleReady=true;}
        $('#radar-label').textContent='X and Reddit are sample posts';return;
      }
      liveSources=data.sources;publicEnabled=data.published;
      $('#radar-tools').hidden=false;filters();
      publication=data.publication_id;posts=append?[...new Map([...posts,...data.posts].map(p=>[p.id,p])).values()]:data.posts;cursor=data.next_cursor;
      const connected=liveSources.filter(s=>s.enabled).length;
      $('#radar-label').textContent=!connected?'Not connected':data.published?'Updates automatically':'Private pilot';
      $('#radar-cluster-label').textContent=!connected?'Not connected':data.clusters.length?'Live':'Waiting for signals';
      $('#radar-coverage').textContent=connected?`${connected} automatic source${connected===1?'':'s'} connected · Discovery and source refresh every hour · Page updates every hour`:'Page updates every hour · Automatic collection needs a connected source';
      $('#radar-source-status').textContent=data.sources.length?data.sources.filter(s=>s.enabled).map(s=>`${s.platform==='x'?names.x:s.name||names[s.platform]}${s.publication_mode==='private'?' (private pilot)':''}: ${sourceStatus(s)}`).join(' · '):'No live sources are enabled.';
      $('#clusters').innerHTML=data.clusters.length?data.clusters.map(c=>`<button class="clu radar-cluster" data-cluster="${c.id}" data-expires="${c.expires_at}" type="button"><b>${esc(c.title)}</b>${spark(c.hourly)}<small>${c.posts} posts · ${c.authors} accounts · ${esc(c.state)}${c.record_id?' · Linked':''}<br>${c.first_seen?'Since '+date(c.first_seen.at)+' · ':''}${c.named.length?esc(c.named.slice(0,3).join(', ')):'No named entities'}</small></button>`).join(''):'<p class="radar-empty">Topics appear when at least three related posts from two accounts are found.</p>';
      renderFeed();
      if(selected)await loadDetail(selected.kind,selected.id);else $('#sigdetail').innerHTML='<p class="note">Open a source to read more, or select a signal to explore related chatter.</p>';
    }catch{
      if(n!==serial)return;posts=[];detail=null;detailSerial++;$('#feed').innerHTML='<p class="radar-empty" role="status">Radar is unavailable. Try refreshing shortly.</p>';
      $('#clusters').innerHTML='';$('#sigdetail').innerHTML='';$('#radar-label').textContent='Unavailable';$('#radar-source-status').textContent='Source status is unavailable.';$('#radar-coverage').textContent='';$('#radar-more').hidden=true;
    }
  }
  $('#sigseg').addEventListener('click',e=>{const b=e.target.closest('[data-source]');if(!b)return;source=b.dataset.source;cursor=null;selected=null;void load();});
  $('#radar-search').addEventListener('input',e=>{clearTimeout(queryTimer);queryTimer=setTimeout(()=>{search=e.target.value.trim();cursor=null;selected=null;void load();},250);});
  $('#radar-sort').addEventListener('change',e=>{sort=e.target.value;cursor=null;selected=null;void load();});
  $('#radar-refresh').addEventListener('click',()=>{void load();});$('#radar-more').addEventListener('click',()=>{void load(true);});
  function select(e){if(e.target.closest('a,button'))return;const p=e.target.closest('[data-post]');if(p){history.replaceState(null,'',route('post',p.dataset.post));void loadDetail('post',p.dataset.post);}}
  $('#feed').addEventListener('click',select);$('#feed').addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-post]')){e.preventDefault();select(e);}});
  $('#clusters').addEventListener('click',e=>{const c=e.target.closest('[data-cluster]');if(c){history.replaceState(null,'',route('cluster',c.dataset.cluster));void loadDetail('cluster',c.dataset.cluster);}});
  $('#sigdetail').addEventListener('click',e=>{
    const record=e.target.closest('[data-radar-record]');if(record){if(detail?.publication_id===archive.publication.id)openRecord(record.dataset.radarRecord);else location.href=location.pathname+'?publication='+encodeURIComponent(detail?.publication_id||publication)+'#timeline/'+encodeURIComponent(record.dataset.radarRecord);return;}
  });
  setInterval(()=>{
    if(mode!=='live')return;
    document.querySelectorAll('[data-cluster][data-expires]').forEach(c=>{if(Date.parse(c.dataset.expires)<=Date.now())c.remove();});
    const expired=detail?.expires_at&&Date.parse(detail.expires_at)<=Date.now();
    if(expired){detail=null;$('#sigdetail').innerHTML='<p class="note">Source verification expired. Waiting for the next update.</p>';}
    if(posts.some(p=>p.source_current!==false&&Date.parse(p.display_until)<=Date.now()))renderFeed();
  },1000);
  setInterval(()=>{if(active&&mode==='live'&&!document.hidden)void load();},3600000);
  document.addEventListener('visibilitychange',()=>{if(active&&!document.hidden)void load();});
  return {activate(routeSelection){active=true;if(routeSelection)selected=routeSelection;void load();},deactivate(){active=false;}};
};
