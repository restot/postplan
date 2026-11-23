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
export function mountReview(draftId,version,send,apexReviewUrl=null) {
  const toggle=document.getElementById('review-toggle');
  const closeBtn=document.getElementById('review-close');
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
  const accessBox=document.getElementById('review-access');
  const accessInput=document.getElementById('review-access-input');
  const accessSave=document.getElementById('review-access-save');
  const accessStatus=document.getElementById('review-access-status');
  const accessError=document.getElementById('review-access-error');
  let signedIn=false;
  let anchor=null,offset=0,generation=0;
  const endpoint=`/review-api/drafts/${encodeURIComponent(draftId)}/comments`;
  const accessEndpoint=`/review-api/drafts/${encodeURIComponent(draftId)}/access`;
  const message=text=>{status.textContent=text;};
  function setOpen(open, {moveFocus=false}={}) {
    panel.hidden=!open;
    document.body.classList.toggle('review-open',open);
    toggle.setAttribute('aria-expanded',String(open));
    if(moveFocus) (open?closeBtn:toggle).focus();
  }
  async function loadAccess(attempt) {
    accessBox.hidden=true;
    accessError.hidden=true;
    accessError.textContent='';
    if(!signedIn) return;
    try {
      const response=await fetch(accessEndpoint);
      if(attempt!==generation) return;
      if(response.status===401 || response.status===403 || response.status===404) return;
      if(!response.ok) throw new Error(`Unable to load access settings (${response.status}). Press Refresh.`);
      const data=await response.json();
      if(attempt!==generation) return;
      const allowed=Array.isArray(data.allowed)?data.allowed:[];
      accessInput.value=allowed.join('\n');
      accessStatus.textContent=allowed.length?`Restricted · ${allowed.length} rule${allowed.length===1?'':'s'} (owner always has access)`:'Public · anyone with this link';
      accessBox.hidden=false;
    } catch(error) {
      if(attempt!==generation) return;
      accessError.textContent=error?.message || 'Unable to load access settings. Press Refresh.';
      accessError.hidden=false;
    }
  }
  accessSave.onclick=async()=>{
    accessSave.disabled=true;
    accessStatus.textContent='Saving…';
    try {
      const response=await fetch(accessEndpoint,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({allowed:accessInput.value})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(data.error||`Unable to update access (${response.status})`);
      const allowed=Array.isArray(data.allowed)?data.allowed:[];
      accessInput.value=allowed.join('\n');
      accessStatus.textContent=allowed.length?`Saved · restricted to ${allowed.length} rule${allowed.length===1?'':'s'}`:'Saved · public (anyone with this link)';
    } catch(error) {accessStatus.textContent=error.message;}
    finally {accessSave.disabled=false;}
  };
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
    const visibility=document.createElement('p');
    visibility.textContent=c.published_at?'Published · anyone with this link':'Private · author and report owner only';
    const link=document.createElement('a');link.href=`/d/${encodeURIComponent(draftId)}/v/${c.version}`;link.textContent=`Open version ${c.version}`;
    item.append(heading,visibility,location,text,link);
    if(c.can_publish && !c.published_at) {
      const publish=document.createElement('button');publish.type='button';publish.textContent='Publish';publish.dataset.publish=c.id;
      publish.onclick=async()=>{
        if(!window.confirm('Publish this comment? Anyone with the report link will be able to read your comment and name.')) return;
        publish.disabled=true;
        try {
          await request(`${endpoint}/${encodeURIComponent(c.id)}/publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
          await load(true);
        } catch(error) {message(error.message);publish.disabled=false;}
      };
      item.append(publish);
    }
    list.append(item);
  }
  async function load(reset=false) {
    const attempt=reset?++generation:generation;
    try {
      if(reset) {
        offset=0;list.replaceChildren();more.hidden=true;
        signedIn=false;submit.disabled=true;signIn.hidden=true;identity.textContent='Checking sign-in…';
        const response=await fetch('/review-api/session');
        if(attempt!==generation) return;
        if(response.ok) {
          const session=await response.json();
          if(attempt!==generation) return;
          signedIn=true;identity.textContent=`Signed in as ${session.name}`;submit.disabled=false;
          void loadAccess(attempt);
        } else if(response.status===401) {identity.textContent='Not signed in';signIn.hidden=false;accessBox.hidden=true;accessError.hidden=true;}
        else throw new Error(`Unable to check sign-in (${response.status}). Press Refresh.`);
      }
      const comments=await request(endpoint+'?offset='+offset);
      if(attempt!==generation) return;
      comments.forEach(render);offset+=comments.length;more.hidden=comments.length<100;
      message(offset?'':signedIn?'No comments visible to you yet.':'No published comments yet. Sign in to read private feedback or add a comment.');
    } catch(error) {
      if(attempt!==generation) return;
      if(identity.textContent==='Checking sign-in…') {identity.textContent='Unable to check sign-in. Press Refresh.';signIn.hidden=false;}
      message(error.message);
    }
  }
  toggle.onclick=()=>{
    if(apexReviewUrl) {location.assign(apexReviewUrl);return;}
    setOpen(panel.hidden,{moveFocus:true});
    if(!panel.hidden) {loadVersions();load(true);}
  };
  closeBtn.onclick=()=>{setOpen(false,{moveFocus:true});};
  panel.addEventListener('keydown',event=>{if(event.key==='Escape' && !panel.hidden) {event.preventDefault();setOpen(false,{moveFocus:true});}});
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
  if(new URLSearchParams(location.search).get('review')==='1') {setOpen(true);loadVersions();load(true);}
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

export const reviewMarkup=`<button id="review-toggle" type="button" aria-expanded="false" aria-controls="review-panel">Comments</button><aside id="review-panel" aria-label="Review comments" hidden>
  <header><strong>Review comments</strong><button id="review-close" type="button" aria-label="Close comments">Close</button></header>
  <label for="review-version">Version</label><select id="review-version" disabled aria-describedby="review-versions-status"></select><p id="review-versions-status" role="status"></p>
  <section id="review-access" hidden><label for="review-access-input">Access (leave blank for public)</label><textarea id="review-access-input" rows="2" placeholder="@workspace.email, my-friend@email.com" aria-describedby="review-access-status"></textarea><button id="review-access-save" type="button">Save access</button><p id="review-access-status" role="status"></p></section><p id="review-access-error" role="status" hidden></p>
  <p>New comments are private to their author and the report owner. Publish makes a comment and your name visible to anyone who can view this report.</p>
  <p id="review-identity" role="status">Checking sign-in…</p><a id="review-sign-in" href="/auth/sign-in" target="_blank" rel="noopener">Sign in</a> <button id="review-refresh" type="button">Refresh</button>
  <p id="review-anchor">Select text in the page, or pick an element.</p><button id="review-pick" type="button">Pick element</button>
  <label for="review-body">Comment</label><textarea id="review-body" maxlength="4000" rows="3"></textarea>
  <button id="review-submit" type="button" disabled>Save private comment</button><p id="review-status" role="status"></p>
  <div id="review-list"></div><button id="review-more" type="button" hidden>Load more</button></aside>`;
export const reviewStyle=`#review-toggle{position:fixed;right:16px;top:12px;z-index:2;box-shadow:0 2px 12px #0003}body.review-open #review-toggle{display:none}#review-panel{flex:0 0 min(370px,45vw);width:min(370px,45vw);height:100%;box-sizing:border-box;overflow:auto;background:#faf9f6;color:#20242b;padding:18px;border-left:1px solid #ccd0d5;box-shadow:-4px 0 20px #0001;font:14px/1.5 system-ui;z-index:3}#review-panel[hidden]{display:none}#review-panel header{display:flex;justify-content:space-between;align-items:center}#review-panel button,#review-toggle{border:1px solid #b8bec6;background:#fff;color:#20242b;border-radius:7px;padding:8px 12px;cursor:pointer;font:inherit}#review-panel label,#review-panel textarea{display:block;width:100%;box-sizing:border-box;margin:8px 0}#review-panel textarea{font:16px system-ui;padding:8px}#review-panel article{border-top:1px solid #ccd0d5;padding:16px 0;overflow-wrap:anywhere}#review-panel article strong,#review-panel article button{display:block;margin-bottom:8px}#review-panel article p,#review-anchor{white-space:pre-wrap;overflow-wrap:anywhere}#review-panel a{color:#245b9b}#review-panel #review-submit{background:#244b45;color:white}#review-panel button:disabled{opacity:.45;cursor:not-allowed}#review-access{border-top:1px solid #ccd0d5;border-bottom:1px solid #ccd0d5;padding:10px 0;margin:12px 0}#review-access-status{color:#495057;margin:6px 0 0}#review-version{width:100%;box-sizing:border-box;padding:8px;font:16px system-ui;border:1px solid #b8bec6;border-radius:7px;background:#fff;color:#20242b}#review-status{color:#65502b}@media(max-width:600px){body{flex-direction:column}#postplan-frame{width:100%;height:auto;flex:1 1 0;min-height:0}#review-panel{flex:0 0 50%;width:100%;height:auto;max-height:52%;border-left:0;border-top:1px solid #ccd0d5;box-shadow:0 -4px 20px #0001}}`;
