import {randomBytes} from 'node:crypto';
import {parse, serialize} from 'parse5';
import {withPreviewMetadata} from './preview.js';
import {reviewChild, mountReview, reviewMarkup, reviewStyle} from './review-ui.js';

function headOf(document) {
  return document.childNodes.find(node=>node.tagName==='html').childNodes.find(node=>node.tagName==='head');
}

export function storageOperation(store, draftId, request) {
  const {op,key,value}=request;
  if(typeof key!=='string' || !key.length || key.length>256) throw new Error('Invalid storage key');
  if(!['getItem','setItem','removeItem'].includes(op)) throw new Error('Invalid storage operation');
  const storageKey=`postplan:draft-storage:v1:${draftId}`;
  const entries=JSON.parse(store.getItem(storageKey) || '[]');
  if(!Array.isArray(entries)) throw new Error('Saved storage is invalid');
  const items=new Map(entries);
  if(op==='getItem') return items.get(key)??null;
  if(op==='setItem') {
    if(typeof value!=='string' || value.length>1024*1024) throw new Error('Storage value too large or invalid');
    items.set(key,value);
  } else items.delete(key);
  const encoded=JSON.stringify([...items]);
  if(new TextEncoder().encode(encoded).length>1024*1024) throw new Error('Draft storage exceeds 1 MiB');
  store.setItem(storageKey,encoded);
  return null;
}

function hostBridge(draftId, capability, frameUrl, operate, mount, version) {
  const frame=document.getElementById('postplan-frame');
  let reviewPort;
  const review=mount(draftId,version,data=>reviewPort?.postMessage(data));
  let connected=false;
  window.addEventListener('message',event=>{
    const m=event.data;
    if(connected || event.source!==frame.contentWindow || event.origin!=='null'
      || !m || m.type!=='postplan.storage.ready' || m.capability!==capability
      || m.draftId!==draftId || event.ports.length!==1) return;
    connected=true;
    const port=event.ports[0];
    reviewPort=port;
    port.onmessage=({data})=>{
      if(typeof data?.type==='string' && data.type.startsWith('review.')) {review(data);return;}
      if(!data || !Number.isSafeInteger(data.id)) return;
      try { port.postMessage({id:data.id,value:operate(localStorage,draftId,data)}); }
      catch(error) { port.postMessage({id:data.id,error:error.name==='QuotaExceededError'?'Browser storage is full':error.message}); }
    };
    port.postMessage({ready:true});
    // A navigated document must never inherit the previous document's storage port.
    let initialLoad=true;
    frame.addEventListener('load',()=>{
      if(initialLoad) initialLoad=false;
      else {port.close();reviewPort=null;}
    });
  });
  frame.src=frameUrl+'#'+capability;
}

function childBridge(draftId, review) {
  const channel=new MessageChannel();
  review(channel.port1);
  const pending=new Map();
  let sequence=0;
  let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  // The API may be unused by a document; avoid an unhandled rejected promise.
  ready.catch(()=>{});
  const timer=setTimeout(()=>readyReject(new Error('Open the canonical draft URL to save choices')),5000);
  channel.port1.onmessage=({data})=>{
    if(data?.ready){clearTimeout(timer);readyResolve();return;}
    const request=pending.get(data?.id);
    if(!request) return;
    pending.delete(data.id);clearTimeout(request.timer);
    if(data.error) request.reject(new Error(data.error));else request.resolve(data.value);
  };
  function request(op,key,value) {
    return ready.then(()=>new Promise((resolve,reject)=>{
      const id=++sequence;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Storage request timed out'));},5000);
      pending.set(id,{resolve,reject,timer});
      channel.port1.postMessage({id,op,key,value});
    }));
  }
  window.postplan=Object.freeze({storage:Object.freeze({
    getItem:key=>request('getItem',key),
    setItem:(key,value)=>request('setItem',key,value),
    removeItem:key=>request('removeItem',key)
  })});
  if(window.parent!==window) window.parent.postMessage({type:'postplan.storage.ready',draftId,capability:location.hash.slice(1)},'*',[channel.port2]);
}

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const literal=value=>JSON.stringify(value).replace(/</g,'\\u003c');

export function withStorageBridge(html,draftId) {
  const document=parse(html);
  const head=headOf(document);
  const source=`(${childBridge.toString()})(${literal(draftId)},${reviewChild.toString()});`;
  const script={nodeName:'script',tagName:'script',namespaceURI:'http://www.w3.org/1999/xhtml',attrs:[],childNodes:[],parentNode:head};
  script.childNodes.push({nodeName:'#text',value:source,parentNode:script});
  head.childNodes.unshift(script);
  return serialize(document);
}

export function renderStorageWrapper(html,draft,path,version=1) {
  const nonce=randomBytes(24).toString('base64');
  const capability=randomBytes(24).toString('hex');
  const preview=headOf(parse(withPreviewMetadata(html,draft))).childNodes
    .filter(n=>n.tagName==='meta').map(n=>{
      const name=n.attrs.find(a=>a.name==='property'||a.name==='name')?.value;
      const content=n.attrs.find(a=>a.name==='content')?.value;
      return /^(og:|twitter:)/.test(name||'') && content!==undefined
        ? `<meta ${name.startsWith('og:')?'property':'name'}="${escape(name)}" content="${escape(content)}">`:'';
    }).join('');
  const script=`(${hostBridge.toString()})(${literal(draft.id)},${literal(capability)},${literal(path+'?postplan-frame=1')},${storageOperation.toString()},${mountReview.toString()},${literal(version)});`;
  return {
    csp:`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    html:`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(draft.title||'Postplan draft')}</title>${preview}<style nonce="${nonce}">html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}${reviewStyle}</style></head><body><iframe id="postplan-frame" title="${escape(draft.title||'Postplan draft')}" sandbox="allow-scripts allow-popups allow-downloads" referrerpolicy="no-referrer"></iframe>${reviewMarkup}<noscript>JavaScript is needed for comments and saved selections. <a href="${escape(path+'/raw')}">Read the document</a></noscript><script nonce="${nonce}">${script}</script></body></html>`
  };
}
