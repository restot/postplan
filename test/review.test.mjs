import {test, before, after, afterEach, mock} from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL='postgres://test:test@localhost/test';
process.env.POSTPLAN_SESSION_SECRET='test-only-session-secret';
process.env.POSTPLAN_PUBLIC_BASE_URL='https://postplan.test';
const {createApp}=await import('../node_modules/postplan/src/api.js');
const {pool}=await import('../node_modules/postplan/src/db.js');
const {createSessionCookie}=await import('../node_modules/postplan/src/web-auth.js');
let server,base;
const cookie=createSessionCookie({accountId:'friend',accountName:'Friend'}).split(';')[0];
const payload={body:'Change this heading',version:1,anchor:{type:'text',quote:'Hello',selector:'body > h1:nth-of-type(1)',prefix:'',suffix:' world'}};
before(async()=>{server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
afterEach(()=>mock.restoreAll());
after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
const post=(body=payload,headers={})=>fetch(base+'/review-api/drafts/abcdefghijkl/comments',{method:'POST',headers:{cookie,origin:'https://postplan.test','content-type':'application/json',...headers},body:JSON.stringify(body)});
test('public version list exposes only version dates and latest flag; unavailable drafts return 404',async()=>{
  const versions=[{version:2,created_at:'2026-09-20T00:00:00Z',current:true},{version:1,created_at:'2026-09-19T00:00:00Z',current:false}];
  mock.method(pool,'query',async(sql,args)=>{
    assert.match(sql,/deleted_at IS NULL/);assert.match(sql,/disabled_at IS NULL/);
    assert.match(sql,/ORDER BY v.version_number DESC/);
    assert.doesNotMatch(sql,/SELECT \*|object_key|git_commit|author|email/);
    assert.deepEqual(args,['abcdefghijkl']);return {rows:versions};
  });
  const res=await fetch(base+'/review-api/drafts/abcdefghijkl/versions');
  assert.equal(res.status,200);assert.deepEqual(await res.json(),versions);
  mock.restoreAll();mock.method(pool,'query',async()=>({rows:[]}));
  assert.equal((await fetch(base+'/review-api/drafts/abcdefghijkl/versions')).status,404);
});
test('session status returns authenticated name without email',async()=>{
  const res=await fetch(base+'/review-api/session',{headers:{cookie}});
  assert.equal(res.status,200);assert.deepEqual(await res.json(),{name:'Friend'});
  assert.equal((await fetch(base+'/review-api/session')).status,401);
});
test('comments require sign-in and same-origin JSON writes',async()=>{
  assert.equal((await post(payload,{cookie:''})).status,401);
  assert.equal((await post(payload,{origin:'null'})).status,403);
  assert.equal((await post(payload,{origin:'https://evil.test'})).status,403);
  assert.equal((await post(payload,{'content-type':'text/plain'})).status,415);
});
test('comments reject empty bodies, invalid anchors and versions',async()=>{
  for(const body of [{...payload,body:''},{...payload,body:'x'.repeat(4001)},{...payload,version:0},{...payload,anchor:{}},{...payload,anchor:{...payload.anchor,quote:'x'.repeat(2001)}}]) assert.equal((await post(body)).status,422);
});
test('author comes from session, comment is bound to an existing public draft version',async()=>{
  let parameters;
  mock.method(pool,'query',async(sql,args)=>{
    assert.match(sql,/INSERT INTO review_comments/);parameters=args;
    return {rows:[{id:'1',author_id:'friend',author_name:'Friend',body:args[4],anchor:JSON.parse(args[5]),version:1}]};
  });
  const res=await post({...payload,author_id:'owner',author_name:'Forged'});
  assert.equal(res.status,201);assert.equal((await res.json()).author_name,'Friend');
  assert.equal(parameters[2],'friend');assert.equal(parameters[3],'Friend');
  mock.restoreAll();mock.method(pool,'query',async()=>({rows:[]}));
  assert.equal((await post()).status,404);
});
test('CLI reads pass the bearer identity and ownership into the visibility filter',async()=>{
  mock.method(pool,'query',async(sql,args)=>{
    if(sql.includes('api_keys')) return {rows:[{id:'key',account_id:'owner'}]};
    if(sql.includes('FROM drafts')) return {rows:[{id:'abcdefghijkl',account_id:'owner'}]};
    assert.match(sql,/c\.published_at IS NOT NULL/);assert.match(sql,/c\.author_id=\$3/);
    assert.deepEqual(args,['abcdefghijkl',0,'owner',true]);
    return {rows:[{id:'1',author_name:'Friend',body:payload.body,anchor:payload.anchor,version:1,published_at:null,can_publish:false}]};
  });
  const res=await fetch(base+'/api/drafts/abcdefghijkl/comments',{headers:{authorization:'Bearer test'}});
  assert.equal(res.status,200);assert.equal((await res.json())[0].author_name,'Friend');
  mock.restoreAll();mock.method(pool,'query',async sql=>({rows:sql.includes('api_keys')?[{id:'key',account_id:'other'}]:[]}));
  assert.equal((await fetch(base+'/api/drafts/abcdefghijkl/comments',{headers:{authorization:'Bearer test'}})).status,404);
});
test('anonymous readers get the published-only filter and uncacheable responses',async()=>{
  mock.method(pool,'query',async(sql,args)=>{
    if(sql.includes('FROM drafts')) return {rows:[{id:'abcdefghijkl',account_id:'owner'}]};
    assert.match(sql,/c\.published_at IS NOT NULL/);assert.match(sql,/c\.author_id=\$3/);
    assert.match(sql,/can_publish/);assert.deepEqual(args,['abcdefghijkl',0,null,false]);
    return {rows:[]};
  });
  const res=await fetch(base+'/review-api/drafts/abcdefghijkl/comments');
  assert.equal(res.status,200);assert.deepEqual(await res.json(),[]);
  assert.match(res.headers.get('cache-control'),/no-store/);
});
test('browser authors see their private comments without gaining report-owner privileges',async()=>{
  mock.method(pool,'query',async(sql,args)=>{
    if(sql.includes('FROM drafts')) return {rows:[{id:'abcdefghijkl',account_id:'owner'}]};
    assert.match(sql,/c\.published_at IS NOT NULL/);assert.match(sql,/c\.author_id=\$3/);
    assert.deepEqual(args,['abcdefghijkl',100,'friend',false]);return {rows:[]};
  });
  assert.equal((await fetch(base+'/review-api/drafts/abcdefghijkl/comments?offset=100',{headers:{cookie}})).status,200);
});
test('saving ignores forged publication fields and creates a private comment',async()=>{
  mock.method(pool,'query',async(sql,args)=>{
    assert.match(sql,/RETURNING[^]*published_at/);
    assert.doesNotMatch(sql,/INSERT INTO review_comments \([^)]*published_at/);
    return {rows:[{id:'1',author_id:'friend',published_at:null}]};
  });
  const res=await post({...payload,published_at:'2026-01-01T00:00:00Z',can_publish:false});
  assert.equal(res.status,201);const body=await res.json();
  assert.equal(body.published_at,null);assert.equal(body.can_publish,true);
});
const commentId='cd84805d-8b2d-4a64-98bd-a9844c25a770';
const publish=(id=commentId,headers={})=>fetch(`${base}/review-api/drafts/abcdefghijkl/comments/${id}/publish`,{method:'POST',headers:{cookie,origin:'https://postplan.test','content-type':'application/json',...headers},body:'{}'});
test('publishing requires sign-in, same-origin JSON and a valid comment ID',async()=>{
  assert.equal((await publish(commentId,{cookie:''})).status,401);
  assert.equal((await publish(commentId,{origin:'null'})).status,403);
  assert.equal((await publish(commentId,{origin:'https://evil.test'})).status,403);
  assert.equal((await publish(commentId,{'content-type':'text/plain'})).status,415);
  assert.equal((await publish('not-a-uuid')).status,422);
});
test('publish is bound to author, draft and availability, and is idempotent',async()=>{
  mock.method(pool,'query',async(sql,args)=>{
    assert.match(sql,/UPDATE review_comments/);assert.match(sql,/c\.author_id=\$3/);
    assert.match(sql,/c\.draft_id=\$1/);assert.match(sql,/c\.id=\$2/);
    assert.match(sql,/deleted_at IS NULL/);assert.match(sql,/disabled_at IS NULL/);
    assert.match(sql,/COALESCE\(c\.published_at,now\(\)\)/);
    assert.deepEqual(args,['abcdefghijkl',commentId,'friend']);
    return {rows:[{id:commentId,published_at:'2026-09-24T00:00:00Z'}]};
  });
  const res=await publish();assert.equal(res.status,200);assert.ok((await res.json()).published_at);
  mock.restoreAll();mock.method(pool,'query',async()=>({rows:[]}));
  assert.equal((await publish()).status,404);
});
