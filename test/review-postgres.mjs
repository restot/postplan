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
  await initDb();
  // Simulate an existing pre-privacy schema without deleting any data.
  await pool.query(`CREATE TABLE IF NOT EXISTS review_comments (
    id UUID PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES drafts(id),version_id TEXT NOT NULL REFERENCES draft_versions(id),
    author_id TEXT NOT NULL REFERENCES accounts(id),author_name TEXT NOT NULL,body TEXT NOT NULL,
    anchor JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const owner=randomUUID(),friend=randomUUID(),other=randomUUID(),draft=randomUUID(),key=randomUUID(),friendKey=randomUUID(),otherKey=randomUUID();
  await pool.query('INSERT INTO accounts(id,name) VALUES($1,$2),($3,$4),($5,$6)',[owner,'Owner',friend,'Friend',other,'Other']);
  for(const [token,account] of [[key,owner],[friendKey,friend],[otherKey,other]]) await pool.query('INSERT INTO api_keys(id,account_id,name,key_hash) VALUES($1,$2,$3,$4)',[token,account,'Test key',createHash('sha256').update(token).digest('hex')]);
  await pool.query('INSERT INTO drafts(id,account_id,title) VALUES($1,$2,$3)',[draft,owner,'Fixture']);
  const versionId=randomUUID();
  await pool.query('INSERT INTO draft_versions(id,draft_id,version_number,object_key,content_hash,file_size,created_by_api_key_id) VALUES($1,$2,1,$3,$4,1,$5)',[versionId,draft,'fixture','hash',key]);
  await pool.query('UPDATE drafts SET current_version_id=$1 WHERE id=$2',[versionId,draft]);
  const legacyId=randomUUID(),anchor={type:'text',quote:'Hello',selector:'h1',prefix:'',suffix:' world'};
  await pool.query('INSERT INTO review_comments(id,draft_id,version_id,author_id,author_name,body,anchor) VALUES($1,$2,$3,$4,$5,$6,$7)',[legacyId,draft,versionId,friend,'Friend','Existing comment',anchor]);
  await initReviewDb();await initReviewDb();
  assert.equal((await pool.query('SELECT published_at FROM review_comments WHERE id=$1',[legacyId])).rows[0].published_at,null);
  async function start() {
    server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    config.publicBaseUrl=`http://127.0.0.1:${server.address().port}`;return config.publicBaseUrl;
  }
  let base=await start();
  const versions=await fetch(`${base}/review-api/drafts/${draft}/versions`);
  assert.equal(versions.status,200);
  const rows=await versions.json();assert.equal(rows.length,1);assert.equal(rows[0].version,1);assert.equal(rows[0].current,true);
  assert.deepEqual(Object.keys(rows[0]).sort(),['created_at','current','version']);
  const cookies=Object.fromEntries([[friend,'Friend'],[owner,'Owner'],[other,'Other']].map(([id,name])=>[id,createSessionCookie({accountId:id,accountName:name}).split(';')[0]]));
  const cookie=cookies[friend];
  const body={body:'Please change this',version:1,anchor};
  const post=(data=body)=>fetch(`${base}/review-api/drafts/${draft}/comments`,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await post({...body,version:2})).status,404);
  const response=await post({...body,published_at:'2020-01-01T00:00:00Z'});assert.equal(response.status,201);
  const comment=await response.json();assert.equal(comment.author_id,friend);assert.equal(comment.version,1);
  assert.equal(comment.published_at,null);assert.equal(comment.can_publish,true);
  const list=(headers={},offset=0)=>fetch(`${base}/review-api/drafts/${draft}/comments?offset=${offset}`,{headers});
  const cli=(token,headers={})=>fetch(`${base}/api/drafts/${draft}/comments`,{headers:{authorization:`Bearer ${token}`,...headers}});
  for(const headers of [{},{cookie:cookies[other]},{cookie:'postplan_session=invalid'}]) assert.deepEqual(await (await list(headers)).json(),[]);
  for(const id of [friend,owner]) {
    const res=await list({cookie:cookies[id]});assert.match(res.headers.get('cache-control'),/no-store/);
    const visible=await res.json();assert.equal(visible.length,2);assert.equal(visible[0].can_publish,id===friend);
  }
  for(const token of [key,friendKey]) assert.equal((await (await cli(token)).json()).length,2);
  assert.deepEqual(await (await cli(otherKey,{cookie:cookies[owner]})).json(),[]);
  const publish=(id,actor=friend,draftId=draft)=>fetch(`${base}/review-api/drafts/${draftId}/comments/${id}/publish`,{method:'POST',headers:{cookie:cookies[actor],origin:base,'content-type':'application/json'},body:'{}'});
  for(const actor of [owner,other]) assert.equal((await publish(comment.id,actor)).status,404);
  assert.equal((await publish(comment.id,friend,randomUUID())).status,404);
  const published=await publish(comment.id);assert.equal(published.status,200);
  const timestamp=(await published.json()).published_at;assert.ok(timestamp);
  assert.equal((await (await publish(comment.id)).json()).published_at,timestamp);
  for(const headers of [{},{cookie:cookies[other]}]) {
    const visible=await (await list(headers)).json();assert.deepEqual(visible.map(c=>c.id),[comment.id]);assert.equal(visible[0].can_publish,false);
    assert.deepEqual(await (await list(headers,1)).json(),[]);
  }
  assert.deepEqual((await (await cli(otherKey)).json()).map(c=>c.id),[comment.id]);
  await initReviewDb();
  assert.equal((await pool.query('SELECT published_at FROM review_comments WHERE id=$1',[comment.id])).rows[0].published_at.toISOString(),timestamp);
  await new Promise(r=>server.close(r));base=await start();
  assert.equal((await (await cli(key)).json()).length,2);
  assert.deepEqual((await (await list()).json()).map(c=>c.id),[comment.id]);
  for(const column of ['disabled_at','deleted_at']) {
    await pool.query(`UPDATE drafts SET ${column}=now() WHERE id=$1`,[draft]);
    assert.equal((await post()).status,404);assert.equal((await publish(legacyId)).status,404);
    assert.equal((await fetch(`${base}/review-api/drafts/${draft}/versions`)).status,404);
    for(const headers of [{},{cookie}]) assert.equal((await list(headers)).status,404);
    assert.equal((await cli(key)).status,404);
    await pool.query(`UPDATE drafts SET ${column}=NULL WHERE id=$1`,[draft]);
  }
  console.log('PASS: PostgreSQL legacy-private migration, author/owner/outsider/anonymous matrix, bearer-cookie separation, author-only idempotent publish, visibility-before-pagination, restart persistence and unavailable draft denial');
} finally {if(server)await new Promise(r=>server.close(r));await pool.end();}
