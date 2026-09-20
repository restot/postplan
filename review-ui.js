// Runs inside the opaque draft frame. Only locator metadata crosses to the trusted UI.
export function reviewChild(port) {
  let picking=false;
  let highlighted,previousOutline,previousPriority,highlightTimer;
  function clearHighlight() {
    clearTimeout(highlightTimer);
    if(highlighted) {
      if(previousOutline) highlighted.style.setProperty('outline',previousOutline,previousPriority);
      else highlighted.style.removeProperty('outline');
      highlighted=null;
    }
  }
  function highlight(element,duration=0) {
    clearHighlight();
    highlighted=element;
    previousOutline=element.style.getPropertyValue('outline');
    previousPriority=element.style.getPropertyPriority('outline');
    element.style.setProperty('outline','3px solid #e88c30','important');
    if(duration) highlightTimer=setTimeout(clearHighlight,duration);
  }
  function selector(element) {
    const parts=[];
    for(let e=element;e && e.nodeType===1;e=e.parentElement) {
      const tag=e.localName;
      const siblings=e.parentElement?[...e.parentElement.children].filter(s=>s.localName===tag):[e];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(e)+1})`);
    }
    return parts.join(' > ');
  }
  function send(element,quote,type,prefix='',suffix='') {
    if(!element || !quote.trim() || quote.length>2000) return;
    const path=selector(element);
    if(path.length>1000) return;
    highlight(element);
    port.postMessage({type:'review.anchor',anchor:{type,quote,selector:path,prefix,suffix}});
  }
  function selection() {
    const selected=window.getSelection();
    if(!selected?.rangeCount || selected.isCollapsed) return;
    const range=selected.getRangeAt(0);
    const element=range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;
    if(!element || ['SCRIPT','STYLE','INPUT','TEXTAREA'].includes(element.tagName)) return;
    const before=document.createRange();before.selectNodeContents(element);before.setEnd(range.startContainer,range.startOffset);
    const after=document.createRange();after.selectNodeContents(element);after.setStart(range.endContainer,range.endOffset);
    send(element,range.toString(),'text',before.toString().slice(-200),after.toString().slice(0,200));
  }
  document.addEventListener('pointerup',()=>setTimeout(selection,0));
  document.addEventListener('keyup',selection);
  document.addEventListener('selectionchange',()=>{clearTimeout(selection.timer);selection.timer=setTimeout(selection,200);});
  document.addEventListener('click',event=>{
    if(!picking) return;
    picking=false;event.preventDefault();event.stopImmediatePropagation();
    const element=event.target;
    send(element,(element.textContent||element.getAttribute('alt')||element.localName).trim().slice(0,2000),'element');
  },true);
  port.addEventListener('message',({data})=>{
    if(data?.type==='review.pick') { picking=true;return; }
    if(data?.type==='review.clear') { clearHighlight();return; }
    if(data?.type!=='review.locate') return;
    try {
      const a=data.anchor,element=document.querySelector(a.selector);
      const text=element && (element.textContent||element.getAttribute('alt')||element.localName);
      if(!element || !text.includes(a.quote)) throw new Error('Anchor no longer matches this document');
      element.scrollIntoView({block:'center',behavior:'smooth'});
      highlight(element,2500);
      port.postMessage({type:'review.located'});
    } catch { port.postMessage({type:'review.missing'}); }
  });
  port.start();
}

// Runs only in the nonce-protected parent. Frame messages never trigger an authenticated request.
export function mountReview(draftId,version,send) {
  const panel=document.getElementById('review-panel');
  const status=document.getElementById('review-status');
  const quote=document.getElementById('review-anchor');
  const input=document.getElementById('review-body');
  const submit=document.getElementById('review-submit');
  const list=document.getElementById('review-list');
  const more=document.getElementById('review-more');
  const identity=document.getElementById('review-identity');
  const signIn=document.getElementById('review-sign-in');
  const versions=document.getElementById('review-version');
  const versionsStatus=document.getElementById('review-versions-status');
  let signedIn=false;
  let anchor=null,offset=0;
  const endpoint=`/review-api/drafts/${encodeURIComponent(draftId)}/comments`;
  const message=text=>{status.textContent=text;};
  async function loadVersions() {
    versions.disabled=true;versionsStatus.textContent='Loading versions…';
    try {
      const response=await fetch(`/review-api/drafts/${encodeURIComponent(draftId)}/versions`);
      if(!response.ok) throw new Error(`Unable to load versions (${response.status}). Press Refresh.`);
      const rows=await response.json();
      versions.replaceChildren();
      for(const row of rows) {
        const option=document.createElement('option');option.value=String(row.version);
        option.textContent=`v${row.version}${row.current?' · latest':''} · ${new Date(row.created_at).toLocaleString()}`;
        versions.append(option);
      }
      versions.value=String(version);versions.disabled=false;
      versionsStatus.textContent=`Viewing version ${version}`;
    } catch(error) {versionsStatus.textContent=error.message;}
  }
  versions.onchange=()=>{
    if(versions.value===String(version)) return;
    if(input.value.trim() && !window.confirm('Leave this version and discard your unposted comment?')) {versions.value=String(version);return;}
    location.assign(`/d/${encodeURIComponent(draftId)}/v/${encodeURIComponent(versions.value)}?review=1`);
  };
  async function request(url,options) {
    const response=await fetch(url,options);
    if(response.status===401) {
      signedIn=false;identity.textContent='Not signed in';signIn.hidden=false;submit.disabled=true;
      throw new Error('Sign in to read and add comments, then press Refresh.');
    }
    if(!response.ok) throw new Error(`Comments request failed (${response.status})`);
    return response.json();
  }
  function render(c) {
    const item=document.createElement('article');
    const heading=document.createElement('strong');
    heading.textContent=`${c.author_name} · v${c.version} · ${new Date(c.created_at).toLocaleString()}`;
    const location=document.createElement('button');location.type='button';
    location.textContent=`${c.anchor.type}: “${c.anchor.quote}”`;
    location.onclick=()=>{
      if(c.version!==version) { message(`This comment refers to version ${c.version}. Open that version to locate it.`);return; }
      send({type:'review.locate',anchor:c.anchor});
    };
    const text=document.createElement('p');text.textContent=c.body;
    const link=document.createElement('a');link.href=`/d/${encodeURIComponent(draftId)}/v/${c.version}`;link.textContent=`Open version ${c.version}`;
    item.append(heading,location,text,link);list.append(item);
  }
  async function load(reset=false) {
    try {
      if(reset) {
        offset=0;list.replaceChildren();more.hidden=true;
        signedIn=false;submit.disabled=true;identity.textContent='Checking sign-in…';
        const session=await request('/review-api/session');
        signedIn=true;identity.textContent=`Signed in as ${session.name}`;signIn.hidden=true;submit.disabled=false;
      }
      const comments=await request(endpoint+'?offset='+offset);
      comments.forEach(render);offset+=comments.length;more.hidden=comments.length<100;
      message(offset?'':'No comments yet.');
    } catch(error) {
      if(identity.textContent==='Checking sign-in…') {identity.textContent='Unable to check sign-in. Press Refresh.';signIn.hidden=false;}
      message(error.message);
    }
  }
  document.getElementById('review-toggle').onclick=()=>{
    panel.hidden=!panel.hidden;
    if(!panel.hidden) {loadVersions();load(true);}
  };
  document.getElementById('review-close').onclick=()=>{panel.hidden=true;};
  document.getElementById('review-pick').onclick=()=>{send({type:'review.pick'});message('Tap an element in the document.');};
  document.getElementById('review-refresh').onclick=()=>{loadVersions();load(true);};
  more.onclick=()=>load();
  submit.onclick=async()=>{
    if(!anchor || !input.value.trim()) {message('Select text or pick an element, then write a comment.');return;}
    submit.disabled=true;
    try {
      await request(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:input.value,anchor,version})});
      send({type:'review.clear'});
      input.value='';anchor=null;quote.textContent='Select text in the page, or pick an element.';
      await load(true);
    } catch(error) {message(error.message);}
    finally {submit.disabled=!signedIn;}
  };
  if(new URLSearchParams(location.search).get('review')==='1') {panel.hidden=false;loadVersions();load(true);}
  return data=>{
    if(data.type==='review.missing') {message('Anchor no longer matches this document. The saved quote is shown below.');return;}
    if(data.type!=='review.anchor') return;
    const a=data.anchor;
    if(!a || !['text','element'].includes(a.type) || !['quote','selector','prefix','suffix'].every(k=>typeof a[k]==='string') || !a.quote.trim() || a.quote.length>2000 || a.selector.length>1000 || a.prefix.length>200 || a.suffix.length>200) return;
    anchor={type:a.type,quote:a.quote,selector:a.selector,prefix:a.prefix,suffix:a.suffix};
    quote.textContent=`${a.type}: “${a.quote}”`;
    message('Anchor selected. Open Comments to write your feedback.');
  };
}

export const reviewMarkup=`<button id="review-toggle" type="button">Comments</button><aside id="review-panel" aria-label="Review comments" hidden>
  <header><strong>Review comments</strong><button id="review-close" type="button" aria-label="Close comments">Close</button></header>
  <label for="review-version">Version</label><select id="review-version" disabled aria-describedby="review-versions-status"></select><p id="review-versions-status" role="status"></p>
  <p>Comments are shared with signed-in reviewers. Your name will be visible.</p>
  <p id="review-identity" role="status">Checking sign-in…</p><a id="review-sign-in" href="/auth/sign-in" target="_blank" rel="noopener">Sign in</a> <button id="review-refresh" type="button">Refresh</button>
  <p id="review-anchor">Select text in the page, or pick an element.</p><button id="review-pick" type="button">Pick element</button>
  <label for="review-body">Comment</label><textarea id="review-body" maxlength="4000" rows="3"></textarea>
  <button id="review-submit" type="button" disabled>Post comment</button><p id="review-status" role="status"></p>
  <div id="review-list"></div><button id="review-more" type="button" hidden>Load more</button></aside>`;
export const reviewStyle=`#review-toggle{position:fixed;right:16px;top:12px;z-index:2;box-shadow:0 2px 12px #0003}#review-panel{position:fixed;right:0;top:56px;bottom:0;width:min(370px,90vw);box-sizing:border-box;overflow:auto;background:#faf9f6;color:#20242b;padding:18px;box-shadow:-4px 0 20px #0002;font:14px/1.5 system-ui;z-index:3}#review-panel[hidden]{display:none}#review-panel header{display:flex;justify-content:space-between;align-items:center}#review-panel button,#review-toggle{border:1px solid #b8bec6;background:#fff;color:#20242b;border-radius:7px;padding:8px 12px;cursor:pointer;font:inherit}#review-panel label,#review-panel textarea{display:block;width:100%;box-sizing:border-box;margin:8px 0}#review-panel textarea{font:16px system-ui;padding:8px}#review-panel article{border-top:1px solid #ccd0d5;padding:16px 0;overflow-wrap:anywhere}#review-panel article strong,#review-panel article button{display:block;margin-bottom:8px}#review-panel article p,#review-anchor{white-space:pre-wrap;overflow-wrap:anywhere}#review-panel a{color:#245b9b}#review-panel #review-submit{background:#244b45;color:white}#review-panel button:disabled{opacity:.45;cursor:not-allowed}#review-version{width:100%;box-sizing:border-box;padding:8px;font:16px system-ui;border:1px solid #b8bec6;border-radius:7px;background:#fff;color:#20242b}#review-status{color:#65502b}@media(max-width:600px){#review-panel{top:auto;left:0;bottom:0;width:100%;max-height:52%;border-top:1px solid #ccd0d5}}`;
