import {test} from 'node:test';
import assert from 'node:assert/strict';
import {storageOperation, renderStorageWrapper, withStorageBridge} from '../browser-storage.js';

test('storage is draft-scoped and rejects arbitrary operations and oversized values', () => {
  const values = new Map([['postplan_session', 'private']]);
  const store = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  storageOperation(store,'draft-a',{op:'setItem',key:'pick',value:'yes'});
  assert.equal(storageOperation(store,'draft-a',{op:'getItem',key:'pick'}),'yes');
  assert.equal(storageOperation(store,'draft-b',{op:'getItem',key:'pick'}),null);
  assert.equal(storageOperation(store,'draft-a',{op:'getItem',key:'postplan_session'}),null);
  assert.throws(()=>storageOperation(store,'draft-a',{op:'clear',key:'pick'}));
  assert.throws(()=>storageOperation(store,'draft-a',{op:'setItem',key:'pick',value:'x'.repeat(1024*1024)}));
  assert.equal(storageOperation(store,'draft-a',{op:'getItem',key:'pick'}),'yes');
  storageOperation(store,'draft-a',{op:'removeItem',key:'pick'});
  assert.equal(storageOperation(store,'draft-a',{op:'getItem',key:'pick'}),null);
  assert.equal(values.get('postplan_session'),'private');
});

test('wrapper never renders uploaded scripts in the trusted origin', () => {
  const html='<meta name="postplan-storage" content="browser"><title>Example</title><script>globalThis.untrusted=true</script>';
  const result=renderStorageWrapper(html,{id:'abcdefghijkl',title:'<script>bad</script>'},'/d/abcdefghijkl');
  assert.ok(!result.html.includes('globalThis.untrusted'));
  assert.ok(!result.html.includes('<title><script>'));
  assert.match(result.html,/sandbox="allow-scripts allow-popups allow-downloads"/);
  assert.match(result.csp,/script-src 'nonce-/);
  assert.match(result.csp,/frame-ancestors 'none'/);
  assert.ok(!result.csp.includes('unsafe-inline'));
  const framed=withStorageBridge(html,'abcdefghijkl');
  assert.ok(framed.indexOf('postplan.storage.ready')<framed.indexOf('globalThis.untrusted'));
});
