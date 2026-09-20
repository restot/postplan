// Run only against a disposable test database, never the homelab database.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
assert.ok(process.env.REVIEW_TEST_DATABASE_URL,'Set REVIEW_TEST_DATABASE_URL to a disposable database');
process.env.DATABASE_URL=process.env.REVIEW_TEST_DATABASE_URL;
process.env.POSTPLAN_SESSION_SECRET='postgres-test-only';
const {pool,initDb}=await import('../node_modules/postplan/src/db.js');
const {initReviewDb}=await import('../node_modules/postplan/src/review.js');
const {createApp}=await import('../node_modules/postplan/src/api.js');
const {config}=await import('../node_modules/postplan/src/config.js');
const {createSessionCookie}=await import('../node_modules/postplan/src/web-auth.js');
let server;
try {
  await initDb();await initReviewDb();await initReviewDb();
  const owner=randomUUID(),friend=randomUUID(),draft=randomUUID(),key=randomUUID();
  await pool.query('INSERT INTO accounts(id,name) VALUES($1,$2),($3,$4)',[owner,'Owner',friend,'Friend']);
  await pool.query('INSERT INTO api_keys(id,account_id,name,key_hash) VALUES($1,$2,$3,$4)',[key,owner,'Test key',createHash('sha256').update(key).digest('hex')]);
  await pool.query('INSERT INTO drafts(id,account_id,title) VALUES($1,$2,$3)',[draft,owner,'Fixture']);
  const versionId=randomUUID();
  await pool.query('INSERT INTO draft_versions(id,draft_id,version_number,object_key,content_hash,file_size,created_by_api_key_id) VALUES($1,$2,1,$3,$4,1,$5)',[versionId,draft,'fixture','hash',key]);
  async function start() {
    server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    config.publicBaseUrl=`http://127.0.0.1:${server.address().port}`;return config.publicBaseUrl;
  }
  let base=await start();
  const cookie=createSessionCookie({accountId:friend,accountName:'Friend'}).split(';')[0];
  const body={body:'Please change this',version:1,anchor:{type:'text',quote:'Hello',selector:'h1',prefix:'',suffix:' world'}};
  const post=(data=body)=>fetch(`${base}/review-api/drafts/${draft}/comments`,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await post({...body,version:2})).status,404);
  const response=await post();assert.equal(response.status,201);
  const comment=await response.json();assert.equal(comment.author_id,friend);assert.equal(comment.version,1);
  await new Promise(r=>server.close(r));base=await start();
  const list=await fetch(`${base}/api/drafts/${draft}/comments`,{headers:{authorization:`Bearer ${key}`}});
  assert.equal(list.status,200);assert.deepEqual((await list.json())[0],comment);
  await pool.query('UPDATE drafts SET disabled_at=now() WHERE id=$1',[draft]);
  assert.equal((await post()).status,404);
  assert.equal((await fetch(`${base}/review-api/drafts/${draft}/comments`,{headers:{cookie}})).status,404);
  console.log('PASS: PostgreSQL schema idempotency, version binding, author persistence across app restart, disabled-draft denial');
} finally {if(server)await new Promise(r=>server.close(r));await pool.end();}
