(function(){
  const root=document.querySelector('#v-blog');
  const list=root.querySelector('#blog-posts');
  const status=root.querySelector('#blog-status');
  const empty=root.querySelector('#blog-empty');
  const more=root.querySelector('#blog-more');
  const refresh=root.querySelector('#blog-refresh');
  const count=root.querySelector('#blog-count');
  const dateFormat=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
  const seen=new Set();
  let loaded=false, busy=false, next=0;

  function postCard(post){
    const article=document.createElement('article');
    article.className='blog-post';
    if(post.image_url){
      const image=document.createElement('img');
      image.src=post.image_url;image.alt='';image.loading='lazy';image.referrerPolicy='no-referrer';
      article.append(image);
    }
    const body=document.createElement('div');body.className='blog-post-body';
    const time=document.createElement('time');time.dateTime=post.published_at;time.textContent=dateFormat.format(new Date(post.published_at));
    const title=document.createElement('h3');
    const link=document.createElement('a');link.href=post.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=post.title;
    title.append(link);body.append(time,title);
    if(post.subtitle){const summary=document.createElement('p');summary.textContent=post.subtitle;body.append(summary);}
    const read=document.createElement('a');read.className='blog-read';read.href=post.url;read.target='_blank';read.rel='noopener noreferrer';read.textContent='Read on Substack ↗';
    read.setAttribute('aria-label','Read '+post.title+' on Substack');body.append(read);article.append(body);
    return article;
  }

  async function load(reset){
    if(busy || (!reset && next===null))return;
    busy=true;refresh.disabled=true;more.disabled=true;root.setAttribute('aria-busy','true');
    if(reset){seen.clear();list.replaceChildren();next=0;loaded=false;empty.hidden=true;more.hidden=true;count.textContent='Published posts';}
    status.textContent=reset?'Loading posts from Substack…':'Loading older posts…';
    try{
      const response=await fetch('/api/blog?offset='+next,{cache:'no-store'});
      if(!response.ok)throw new Error('unavailable');
      const data=await response.json();
      for(const post of data.posts){if(!seen.has(post.id)){list.append(postCard(post));seen.add(post.id);}}
      next=data.next_offset;loaded=true;more.hidden=next===null;
      empty.hidden=seen.size!==0;
      count.textContent=seen.size+' '+(seen.size===1?'post':'posts')+(next!==null?' loaded':'');
      status.textContent=seen.size?'Newest first · Checked '+dateFormat.format(new Date(data.fetched_at))+' (UTC)':'';
    }catch{
      status.textContent='Posts could not be loaded from Substack. Try again in a moment.';
    }finally{busy=false;refresh.disabled=false;more.disabled=false;root.setAttribute('aria-busy','false');}
  }
  refresh.addEventListener('click',()=>load(true));
  more.addEventListener('click',()=>load(false));
  window.ProjectMartianBlog={activate(){if(!loaded)void load(true);}};
})();
