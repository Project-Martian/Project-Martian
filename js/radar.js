/* Live Radar uses an independently refreshed API, never the archive's samples. */
window.mountRadar=function({archive,openRecord}){
  const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const names={x:'X',reddit:'Reddit',linkedin:'LinkedIn',wild:'News and disclosures'};
  const colors={x:'var(--ink)',reddit:'#d94b17',linkedin:'#0a66c2',wild:'var(--accent)'};
  let mode=null,active=false,source='all',search='',cursor=null,posts=[],selected=null,detail=null,serial=0,detailSerial=0,publication=null;
  let sampleReady=false,intakeEnabled=false,queryTimer,shareExpires=0;
  const clearShare=()=>{if($('#radar-share-dialog').open)$('#radar-share-dialog').close();$('#radar-share-text').value='';shareExpires=0;};
  const date=value=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const spark=values=>{const max=Math.max(1,...values),points=values.map((v,i)=>`${i*74/(values.length-1)},${23-v/max*20}`).join(' ');return `<svg width="78" height="26" viewBox="0 0 78 26" aria-hidden="true"><polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.6"/></svg>`;};
  const route=(kind,id)=>`${location.origin}${location.pathname}#signals/${kind}/${encodeURIComponent(id)}`;
  function text(post){
    const chars=Array.from(post.text),entities=[...(post.entities||[])].sort((a,b)=>a.start-b.start);let out='',at=0;
    for(const e of entities){if(e.start<at||e.end>chars.length||e.end<=e.start)continue;
      out+=esc(chars.slice(at,e.start).join(''))+`<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(chars.slice(e.start,e.end).join(''))}</a>`;at=e.end;}
    return out+esc(chars.slice(at).join(''));
  }
  function filters(){
    $('#sigseg').innerHTML=[['all','All'],['x','X'],['reddit','Reddit'],['linkedin','LinkedIn'],['wild','In the wild']].map(([id,name])=>
      `<button type="button" data-source="${id}" aria-pressed="${source===id}" ${id==='linkedin'?'disabled title="LinkedIn API feed is not enabled"':''}>${name}</button>`).join('');
  }
  function renderFeed(){
    posts=posts.filter(p=>Date.parse(p.display_until)>Date.now());
    $('#feed').innerHTML=posts.length?posts.map(p=>`<article class="post ${selected?.kind==='post'&&selected.id===p.id?'sel':''}" data-post="${p.id}" tabindex="0" aria-label="Select signal from ${esc(p.author_name)}">
      <span class="src ${p.platform==='reddit'?'r':p.platform==='wild'?'w':'x'}">${p.author_avatar?`<img class="radar-avatar" src="${esc(p.author_avatar)}" alt="" referrerpolicy="no-referrer">`:p.platform==='reddit'?'r/':p.platform==='x'?'𝕏':'●'}</span>
      <div><div class="top">${p.author_url?`<a href="${esc(p.author_url)}" target="_blank" rel="noopener noreferrer"><b>${esc(p.author_name)}</b> <span class="h">${esc(p.author_handle)}</span></a>`:`<b>${esc(p.author_name)}</b>`}
      <a class="t" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${date(p.posted_at)}</a></div>
      <p>${text(p)}</p><div class="ft"><span class="st ${p.record_id?'lnk':'unv'}">${p.record_id?'Linked':'Unverified'}</span>
      <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${p.platform==='x'?'View on X':'Open on '+(p.platform==='wild'?'source':names[p.platform])} ↗</a>
      ${p.engagement===null?'':`<span class="eng">${Number(p.engagement).toLocaleString()} ${p.platform==='reddit'?'score':'likes'}</span>`}</div></div></article>`).join(''):
      '<p class="radar-empty">No published signals match these filters.</p>';
    $('#radar-more').hidden=!cursor;
  }
  function renderDetail(data){
    detail=data;const p=data.post,mix=data.platforms,total=Object.values(mix).reduce((a,b)=>a+b,0);
    $('#sigdetail').innerHTML=`<span class="eyebrow">Signal detail</span><h3>${esc(data.cluster?.title||'Report from '+p.author_name)}</h3>
      <span class="st ${p.record_id?'lnk':'unv'}">${p.record_id?'Linked':'Unverified'}</span>
      <div class="mix">${Object.entries(mix).filter(([,n])=>n).map(([s,n])=>`<i style="flex:${n};background:${colors[s]}"></i>`).join('')}</div>
      <div class="mixl">${Object.entries(mix).filter(([,n])=>n).map(([s,n])=>`<span><i style="background:${colors[s]}"></i>${names[s]} ${Math.round(n/total*100)}%</span>`).join('')}</div>
      <p class="note">Source mix and distinct accounts · last 72 hours</p>
      <div class="kv"><div><span>First seen</span><b>${data.first_seen?date(data.first_seen.at)+' on '+names[data.first_seen.platform]:'—'}</b></div>
      <div><span>Velocity</span><b>${data.velocity.posts} posts in 24 h · ${esc(data.velocity.trend)}</b></div>
      <div><span>Distinct accounts</span><b>${data.authors} on ${Object.values(mix).filter(Boolean).length} platforms</b></div></div>
      <div class="radar-provenance"><b>Where it’s coming from</b><p class="note">Reviewed primary sources first, then reports.</p>
      ${data.sources.map(s=>`<div class="radar-source"><span class="radar-source-kind">${esc(s.kind)}</span><div><b>${esc(s.name)}</b><small>${esc(names[s.platform])} · ${date(s.posted_at)}</small></div><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>`).join('')}
      <p class="note">${data.reshares} reshares folded in</p></div>
      <div class="radar-actions">${p.record_id?`<button type="button" data-radar-record="${esc(p.record_id)}">Open record ↗</button>`:''}
      <button type="button" data-radar-share>Share signal</button>${intakeEnabled?'<button type="button" data-radar-report>Report</button>':''}</div>`;
  }
  async function loadDetail(kind,id){
    selected={kind,id};const n=++detailSerial;detail=null;$('#sigdetail').innerHTML='<p class="note">Loading source detail…</p>';
    try{
      const response=await fetch(`/api/radar/${kind==='post'?'posts':'clusters'}/${encodeURIComponent(id)}`,{cache:'no-store'});
      if(!response.ok)throw new Error('unavailable');const value=await response.json();if(n!==detailSerial)return;
      renderDetail(value);renderFeed();
    }catch{if(n===detailSerial){detail=null;clearShare();$('#sigdetail').innerHTML='<p class="note">This signal is unavailable or no longer published.</p>';}}
  }
  async function load(append=false){
    const n=++serial;$('#radar-label').textContent='Refreshing…';
    const params=new URLSearchParams({source,q:search});if(append&&cursor)params.set('cursor',cursor);
    try{
      const response=await fetch('/api/radar?'+params,{cache:'no-store'});if(!response.ok)throw new Error('unavailable');
      const data=await response.json();if(n!==serial)return;
      if(data.version!=='radar-v1')throw new Error('version');mode=data.mode;
      if(mode==='sample'){
        if(!sampleReady){window.renderRadarSamples({archive,openRecord});sampleReady=true;}
        $('#radar-label').textContent='X and Reddit are sample posts';return;
      }
      intakeEnabled=data.intake_enabled;$('#radar-tools').hidden=false;$('#radar-send').hidden=!data.intake_enabled;$('#radar-cluster-label').textContent='Live';filters();
      publication=data.publication_id;posts=append?[...new Map([...posts,...data.posts].map(p=>[p.id,p])).values()]:data.posts;cursor=data.next_cursor;
      $('#radar-label').textContent=data.published?'Published signals':'Private pilot · not published';
      $('#radar-source-status').textContent=data.sources.length?data.sources.map(s=>`${names[s.platform]}: ${!s.enabled?'disabled':s.last_error?'needs attention':s.last_success?'checked '+date(s.last_success):'awaiting first collection'}`).join(' · '):'No live sources are enabled.';
      $('#clusters').innerHTML=data.clusters.length?data.clusters.map(c=>`<button class="clu radar-cluster" data-cluster="${c.id}" data-expires="${c.expires_at}" type="button"><b>${esc(c.title)}</b>${spark(c.hourly)}<small>${c.posts} posts · ${c.authors} accounts · ${esc(c.state)}${c.record_id?' · Linked':''}<br>${c.first_seen?'Since '+date(c.first_seen.at)+' · ':''}${c.named.length?esc(c.named.slice(0,3).join(', ')):'No named entities'}</small></button>`).join(''):'<p class="radar-empty">No clusters meet the five-post, three-account minimum.</p>';
      renderFeed();
      if(selected)await loadDetail(selected.kind,selected.id);else if(posts[0])await loadDetail('post',posts[0].id);else $('#sigdetail').innerHTML='<p class="note">Select a published signal to trace its sources.</p>';
    }catch{
      if(n!==serial)return;posts=[];detail=null;detailSerial++;$('#feed').innerHTML='<p class="radar-empty" role="status">Radar is unavailable. Try refreshing shortly.</p>';
      $('#clusters').innerHTML='';$('#sigdetail').innerHTML='';$('#radar-label').textContent='Unavailable';$('#radar-more').hidden=true;
    }
  }
  $('#sigseg').addEventListener('click',e=>{const b=e.target.closest('[data-source]');if(!b)return;source=b.dataset.source;cursor=null;selected=null;void load();});
  $('#radar-search').addEventListener('input',e=>{clearTimeout(queryTimer);queryTimer=setTimeout(()=>{search=e.target.value.trim();cursor=null;selected=null;void load();},250);});
  $('#radar-refresh').addEventListener('click',()=>{void load();});$('#radar-more').addEventListener('click',()=>{void load(true);});
  function select(e){if(e.target.closest('a,button'))return;const p=e.target.closest('[data-post]');if(p){history.replaceState(null,'',route('post',p.dataset.post));void loadDetail('post',p.dataset.post);}}
  $('#feed').addEventListener('click',select);$('#feed').addEventListener('keydown',e=>{if(e.key==='Enter')select(e);});
  $('#clusters').addEventListener('click',e=>{const c=e.target.closest('[data-cluster]');if(c){history.replaceState(null,'',route('cluster',c.dataset.cluster));void loadDetail('cluster',c.dataset.cluster);}});
  $('#sigdetail').addEventListener('click',e=>{
    const record=e.target.closest('[data-radar-record]');if(record){if(detail?.publication_id===archive.publication.id)openRecord(record.dataset.radarRecord);else location.href=location.pathname+'?publication='+encodeURIComponent(detail?.publication_id||publication)+'#timeline/'+encodeURIComponent(record.dataset.radarRecord);return;}
    if(!detail)return;
    if(e.target.closest('[data-radar-report]')){$('#radar-report-id').value=detail.post.id;$('#radar-report-status').textContent='Reports are reviewed privately.';$('#radar-report-dialog').showModal();}
    if(e.target.closest('[data-radar-share]')){
      shareExpires=Date.parse(detail.expires_at);
      const url=route(selected.kind,selected.id);
      $('#radar-share-text').value=`${detail.cluster?.title||'Agent-security report'} — reported by ${detail.post.author_handle||detail.post.author_name}. Unverified chatter.\n${url}`;
      $('#radar-share-status').textContent='Review the draft. Posting is your choice.';
      $('#radar-linkedin-share').href='https://www.linkedin.com/sharing/share-offsite/?url='+encodeURIComponent(url);$('#radar-share-dialog').showModal();
    }
  });
  $('#radar-x-share').addEventListener('click',e=>{e.currentTarget.href='https://x.com/intent/tweet?text='+encodeURIComponent($('#radar-share-text').value);});
  $('#radar-copy-share').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#radar-share-text').value);$('#radar-share-status').textContent='Copied. Paste the draft into your LinkedIn share.';}catch{$('#radar-share-status').textContent='Clipboard access was denied.';}});
  $('#radar-send').addEventListener('click',()=>{$('#radar-submit-status').textContent='LinkedIn links are private tips. They are not published automatically.';$('#radar-submit-dialog').showModal();});
  for(const kind of ['submit','report']){
    $(`#radar-${kind}-form`).addEventListener('submit',async e=>{
      e.preventDefault();const form=e.currentTarget,button=form.querySelector('button[type=submit]');button.disabled=true;
      const content=Object.fromEntries(new FormData(form));if(!content.contact)delete content.contact;
      try{const response=await fetch('/api/radar/'+(kind==='submit'?'submissions':'reports'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(content)});
        const result=await response.json();if(!response.ok)throw new Error(result.detail||'Intake unavailable.');
        $(`#radar-${kind}-status`).textContent=result.message+' Receipt: '+result.receipt;form.reset();
      }catch(error){$(`#radar-${kind}-status`).textContent=error.message;}finally{button.disabled=false;}
    });
  }
  document.querySelectorAll('[data-radar-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  setInterval(()=>{
    if(mode!=='live')return;
    if(shareExpires&&shareExpires<=Date.now())clearShare();
    document.querySelectorAll('[data-cluster][data-expires]').forEach(c=>{if(Date.parse(c.dataset.expires)<=Date.now())c.remove();});
    const expired=detail?.expires_at&&Date.parse(detail.expires_at)<=Date.now();
    if(expired){detail=null;$('#sigdetail').innerHTML='<p class="note">Source verification expired. Refreshing…</p>';if($('#radar-share-dialog').open){$('#radar-share-dialog').close();$('#radar-share-text').value='';}}
    if(posts.some(p=>Date.parse(p.display_until)<=Date.now()))renderFeed();
  },1000);
  setInterval(()=>{if(active&&mode==='live'&&!document.hidden)void load();},30000);
  document.addEventListener('visibilitychange',()=>{if(active&&!document.hidden)void load();});
  return {activate(routeSelection){active=true;if(routeSelection)selected=routeSelection;void load();},deactivate(){active=false;}};
};
