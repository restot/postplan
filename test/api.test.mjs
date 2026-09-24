import assert from 'node:assert/strict';
import { test, before, after, afterEach, mock } from 'node:test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1/test';
process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:9000';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_S3_BUCKET_NAME = 'test';
process.env.POSTPLAN_PUBLIC_BASE_URL = 'https://postplan.test';
const { createApp } = await import('../node_modules/postplan/src/api.js');
const { pool } = await import('../node_modules/postplan/src/db.js');
const { S3Client } = await import('@aws-sdk/client-s3');
let server, base;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => mock.restoreAll());
after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });

test('rejects anonymous uploads before parsing large bodies', async () => {
  const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({html: 'x'.repeat(3*1024*1024)}) });
  assert.equal(res.status, 401);
});

test('authenticated requests exceed the former JSON limit', async () => {
  mock.method(pool, 'query', async () => ({rows:[{id:'test-key',account_id:'test'}],rowCount:1}));
  const res = await fetch(`${base}/api/uploads`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer test'}, body:JSON.stringify({html:'',padding:'x'.repeat(3*1024*1024)}) });
  assert.equal(res.status, 422);
  assert.match(JSON.stringify(await res.json()), /empty/);
});

test('canonical links provide preview metadata and sandboxed JavaScript, raw stays exact', async () => {
  const html = '<!doctype html><html><head><title>Preview &amp; test</title></head><body><script>document.body.dataset.ready="yes"</script></body></html>';
  mock.method(pool, 'query', async sql => ({ rows: sql.includes('FROM drafts') ? [{id:'abcdefghijkl',current_version_id:'v1',title:'Preview & test',description:'A "shared" report'}] : [{version_number:1,object_key:'test'}] }));
  mock.method(S3Client.prototype, 'send', async () => ({Body: (async function*(){yield Buffer.from(html);})()}));
  const res = await fetch(`${base}/d/abcdefghijkl`, {headers:{'User-Agent':'Slackbot-LinkExpanding 1.0'}});
  assert.equal(res.status,200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp,/script-src 'nonce-/);
  assert.doesNotMatch(csp,/allow-same-origin/);
  const body = await res.text();
  assert.match(body,/property="og:title" content="Preview &amp; test"/);
  assert.match(body,/property="og:description" content="A &quot;shared&quot; report"/);
  assert.match(body,/property="og:image" content="https:\/\/postplan.test\/d\/abcdefghijkl\/v\/1\/preview.png\?theme=1"/);
  assert.match(body,/id="review-toggle"/);
  assert.match(body,/sandbox="allow-scripts allow-popups allow-downloads"/);
  assert.doesNotMatch(body,/<script>document.body.dataset.ready="yes"<\/script>/);
  assert.equal(await (await fetch(`${base}/d/abcdefghijkl/raw`)).text(),html);
});

test('public version previews return PNG, cache only after active-draft checks, and never read comments',async()=>{
  let available=true,reads=0;
  mock.method(pool,'query',async(sql,args)=>{
    assert.doesNotMatch(sql,/review_comments|accounts|api_keys/);
    if(sql.includes('FROM drafts')) {
      assert.match(sql,/deleted_at IS NULL/);assert.match(sql,/disabled_at IS NULL/);
      return {rows:available?[{id:'previewtest1',current_version_id:'preview-v2',title:'A report'}]:[]};
    }
    const v=args[1]||2;
    return {rows:[{id:`preview-v${v}`,version_number:v,object_key:`preview-${v}`,content_hash:`hash-${v}`} ]};
  });
  mock.method(S3Client.prototype,'send',async command=>{reads++;return {Body:(async function*(){yield Buffer.from(`<title>Version ${command.input.Key}</title><meta name="description" content="Programmatic image"><h2>Review notes</h2>`);})()};});
  const current=await fetch(`${base}/d/previewtest1/preview.png`);
  assert.equal(current.status,200);assert.match(current.headers.get('content-type'),/^image\/png/);
  assert.match(current.headers.get('cache-control'),/no-store/);
  const bytes=Buffer.from(await current.arrayBuffer());assert.equal(bytes.readUInt32BE(16),1200);
  const same=await fetch(`${base}/d/previewtest1/v/2/preview.png`);assert.deepEqual(Buffer.from(await same.arrayBuffer()),bytes);assert.equal(reads,1);
  const query=await fetch(`${base}/d/previewtest1/v/2/preview.png?random=ignored`);assert.deepEqual(Buffer.from(await query.arrayBuffer()),bytes);assert.equal(reads,1);
  const older=await fetch(`${base}/d/previewtest1/v/1/preview.png`);assert.equal(older.status,200);assert.notDeepEqual(Buffer.from(await older.arrayBuffer()),bytes);assert.equal(reads,2);
  available=false;
  assert.equal((await fetch(`${base}/d/previewtest1/v/2/preview.png`)).status,404);assert.equal(reads,2);
});
test('preview routes reject invalid or missing versions before rendering',async()=>{
  mock.method(pool,'query',async()=>({rows:[]}));
  for(const version of ['0','-1','abc','2147483648','1.5']) assert.equal((await fetch(`${base}/d/abcdefghijkl/v/${version}/preview.png`)).status,404);
  assert.equal((await fetch(`${base}/d/missing/preview.png`)).status,404);
  mock.method(pool,'query',async sql=>({rows:sql.includes('FROM drafts')?[{id:'abcdefghijkl',current_version_id:'missing'}]:[]}));
  assert.equal((await fetch(`${base}/d/abcdefghijkl/v/42/preview.png`)).status,404);
});
test('preview HTML reads stop at the prefix limit without limiting normal raw reads',async()=>{
  const {getHtmlObject}=await import('../node_modules/postplan/src/storage.js');
  let chunks=0;
  mock.method(S3Client.prototype,'send',async()=>({Body:(async function*(){for(let i=0;i<4;i++){chunks++;yield Buffer.from('12345678');}})()}));
  assert.equal(await getHtmlObject('test',10),'1234567812');assert.equal(chunks,2);
  chunks=0;assert.equal((await getHtmlObject('test')).length,32);assert.equal(chunks,4);
});

test('opt-in wrapper keeps untrusted code in a sandboxed frame and raw bytes unchanged', async () => {
  const html='<meta name="postplan-storage" content="browser"><title>Picks</title><script>globalThis.untrustedMarker=true</script>';
  mock.method(pool,'query',async sql=>({rows:sql.includes('FROM drafts')?[{id:'abcdefghijkl',current_version_id:'v1',title:'Picks'}]:[{version_number:1,object_key:'test'}]}));
  mock.method(S3Client.prototype,'send',async()=>({Body:(async function*(){yield Buffer.from(html);})()}));
  const res=await fetch(`${base}/d/abcdefghijkl`);
  assert.equal(res.status,200);
  assert.match(res.headers.get('content-security-policy'),/script-src 'nonce-/);
  assert.equal(res.headers.get('referrer-policy'),'no-referrer');
  assert.doesNotMatch(await res.text(),/untrustedMarker/);
  const frame=await fetch(`${base}/d/abcdefghijkl?postplan-frame=1`);
  assert.match(frame.headers.get('content-security-policy'),/sandbox allow-scripts allow-popups allow-downloads/);
  assert.doesNotMatch(frame.headers.get('content-security-policy'),/allow-same-origin/);
  const framed=await frame.text();
  assert.match(framed,/postplan.storage.ready/);
  assert.match(framed,/untrustedMarker/);
  assert.equal(await (await fetch(`${base}/d/abcdefghijkl/raw`)).text(),html);
});
