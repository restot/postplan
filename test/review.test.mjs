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
test('CLI reads require ownership and return anchored author-attributed comments',async()=>{
  mock.method(pool,'query',async sql=>({rows:sql.includes('api_keys')?[{id:'key',account_id:'owner'}]:sql.includes('SELECT id FROM drafts')?[{id:'abcdefghijkl'}]:[{id:'1',author_name:'Friend',body:payload.body,anchor:payload.anchor,version:1}]}));
  const res=await fetch(base+'/api/drafts/abcdefghijkl/comments',{headers:{authorization:'Bearer test'}});
  assert.equal(res.status,200);assert.equal((await res.json())[0].author_name,'Friend');
  mock.restoreAll();mock.method(pool,'query',async sql=>({rows:sql.includes('api_keys')?[{id:'key',account_id:'other'}]:[]}));
  assert.equal((await fetch(base+'/api/drafts/abcdefghijkl/comments',{headers:{authorization:'Bearer test'}})).status,404);
});
