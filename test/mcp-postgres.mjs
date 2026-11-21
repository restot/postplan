// Requires a disposable database. This creates fixtures without deleting existing data.
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mock} from 'node:test';
import {createServer} from 'node:http';
assert.ok(process.env.MCP_TEST_DATABASE_URL, 'Set MCP_TEST_DATABASE_URL to a disposable database');
process.env.DATABASE_URL = process.env.MCP_TEST_DATABASE_URL;
process.env.POSTPLAN_SESSION_SECRET = 'mcp-postgres-test-only';
const {pool, initDb} = await import('../node_modules/postplan/src/db.js');
const {initReviewDb} = await import('../node_modules/postplan/src/review.js');
const {initMcpDb} = await import('../node_modules/postplan/src/mcp-auth.js');
const {createApp} = await import('../node_modules/postplan/src/api.js');
const {config} = await import('../node_modules/postplan/src/config.js');
const {createSessionCookie} = await import('../node_modules/postplan/src/web-auth.js');
const {S3Client} = await import('@aws-sdk/client-s3');
const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const hash = value => createHash('sha256').update(value).digest('hex');
let server, base, port, phase='initialization';
async function start() {
  server = createServer().listen(port || 0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  config.publicBaseUrl = base;
  // Do not reuse an idle client socket across this test's immediate same-port restart.
  server.on('request', (_req, res) => res.setHeader('Connection', 'close'));
  server.on('request', createApp());
}
const form = (path, values, headers={}) => fetch(`${base}${path}`, {method:'POST',redirect:'manual',headers:{origin:'null','content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(values)});
const json = async response => { const value=await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; };
const extract = (html, name) => { const match=html.match(new RegExp(`name="${name}" value="([^"]+)"`)); assert.ok(match, `Missing ${name}`); return match[1]; };
try {
  await initDb(); await initReviewDb(); await initMcpDb(); await initMcpDb();
  await start();
  const owner=randomUUID(), outsider=randomUUID();
  await pool.query('INSERT INTO accounts(id,name) VALUES($1,$2),($3,$4)', [owner,'MCP owner',outsider,'Other account']);
  const cookie = createSessionCookie({accountId:owner,accountName:'MCP owner'}).split(';')[0];
  const register = async (extra={}) => json(await fetch(`${base}/register`, {method:'POST',headers:{origin:'null','content-type':'application/json'},body:JSON.stringify({client_name:'Grok <script>alert(1)</script>',redirect_uris:['https://grok.com/example-callback'],token_endpoint_auth_method:'none',...extra})}));
  const client=await register();
  phase='OAuth authorization and token exchange';
  const foreign=await register({client_name:'Other client'});
  const secretClient=await register({client_name:'Claude',redirect_uris:['https://claude.ai/api/mcp/auth_callback'],token_endpoint_auth_method:'client_secret_post'});
  assert.ok(secretClient.client_secret);
  const stored=(await pool.query('SELECT metadata FROM mcp_clients WHERE id=$1',[secretClient.client_id])).rows[0].metadata;
  assert.ok(!JSON.stringify(stored).includes(secretClient.client_secret), 'Client secret must be encrypted at rest');
  const verifier='a'.repeat(64), challenge=createHash('sha256').update(verifier).digest('base64url');
  async function authorization(extra={}) {
    const params={client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',code_challenge:challenge,code_challenge_method:'S256',resource:`${base}/mcp`,state:'state-roundtrip',...extra};
    return fetch(`${base}/authorize?${new URLSearchParams(params)}`,{redirect:'manual',headers:{origin:'null'}});
  }
  assert.equal((await authorization({redirect_uri:'https://evil.test/callback'})).status,400);
  assert.match((await authorization({resource:'https://evil.test/mcp'})).headers.get('location'), /error=invalid_target/);
  assert.match((await authorization({code_challenge_method:'plain'})).headers.get('location'), /error=invalid_request/);
  async function grant(authClient=client) {
    const begun=await authorization({client_id:authClient.client_id,redirect_uri:authClient.redirect_uris[0]}); assert.equal(begun.status,302);
    const consent=begun.headers.get('location');
    const signedOut=await fetch(`${base}${consent}`,{redirect:'manual',headers:{origin:'null'}}); assert.equal(signedOut.status,302);
    const page=await fetch(`${base}${consent}`,{headers:{cookie,origin:'null'}});
    assert.equal(page.headers.get('referrer-policy'),'same-origin');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok(page.headers.get('content-security-policy').includes(`form-action 'self' ${new URL(authClient.redirect_uris[0]).origin};`));
    const html=await page.text(); assert.ok(!html.includes('<script>alert(1)</script>'));
    const values={request:extract(html,'request'),approval:extract(html,'approval'),decision:'allow'};
    assert.equal((await form('/mcp/consent', {...values,approval:'tampered'}, {cookie,origin:base})).status,403);
    assert.equal((await form('/mcp/consent',values,{cookie,origin:'https://evil.test'})).status,403);
    assert.equal((await form('/mcp/consent',values,{cookie,origin:'null'})).status,403);
    const denied=await form('/mcp/consent',{...values,decision:'deny'},{cookie,origin:base});
    assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'),'access_denied');
    const approved=await form('/mcp/consent',values,{cookie,origin:base}); assert.equal(approved.status,302);
    const callback=new URL(approved.headers.get('location'));
    assert.equal(callback.origin,new URL(authClient.redirect_uris[0]).origin); assert.equal(callback.searchParams.get('state'),'state-roundtrip');
    assert.equal(callback.searchParams.get('iss'),`${base}/`);
    assert.equal((await form('/mcp/consent',values,{cookie,origin:base})).status,400);
    return callback.searchParams.get('code');
  }
  const code=await grant();
  const exchange={grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:verifier,redirect_uri:client.redirect_uris[0],resource:`${base}/mcp`};
  for(const change of [{code_verifier:'b'.repeat(64)},{client_id:foreign.client_id},{redirect_uri:'https://evil.test/callback'},{resource:'https://evil.test/mcp'}]) {
    const bad=await form('/token',{...exchange,...change}); assert.equal(bad.status,400);
  }
  const tokens=await json(await form('/token',exchange)); assert.ok(tokens.refresh_token); assert.equal(tokens.token_type,'Bearer');
  assert.equal((await form('/token',exchange)).status,400);
  const confidential={...exchange,client_id:secretClient.client_id,redirect_uri:secretClient.redirect_uris[0],code:await grant(secretClient)};
  assert.equal((await form('/token',confidential)).status,400);
  assert.equal((await form('/token',{...confidential,client_secret:'wrong'})).status,400);
  const secretTokens=await json(await form('/token',{...confidential,client_secret:secretClient.client_secret}));
  const claude=await connect(secretTokens.access_token,'https://claude.ai');
  assert.ok((await claude.listTools()).tools.some(tool=>tool.name==='publish_report'));
  await claude.close();
  for(const origin of ['null','https://evil.test','https://claude.ai.evil.test']) {
    assert.equal((await fetch(`${base}/mcp`,{headers:{origin,authorization:`Bearer ${secretTokens.access_token}`}})).status,403);
  }
  await json(await form('/revoke',{client_id:secretClient.client_id,client_secret:secretClient.client_secret,token:secretTokens.access_token}));
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${secretTokens.access_token}`}})).status,401);
  const expiredCode=await grant();
  await pool.query('UPDATE mcp_codes SET expires_at=now()-interval \'1 second\' WHERE code_hash=$1',[hash(expiredCode)]);
  assert.equal((await form('/token',{...exchange,code:expiredCode})).status,400);
  assert.equal((await fetch(`${base}/api/me`,{headers:{authorization:`Bearer ${tokens.access_token}`}})).status,401,'MCP token must not authorize the unrestricted REST API');
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${tokens.refresh_token}`}})).status,401);
  const objects=new Map();
  mock.method(S3Client.prototype,'send',async command=>{
    if(command.input.Body!==undefined) {objects.set(command.input.Key,command.input.Body);return {};}
    return {Body:(async function*(){yield Buffer.from(objects.get(command.input.Key));})()};
  });
  async function connect(accessToken, origin) {
    const sdk=new Client({name:'mcp-smoke-client',version:'1.0.0'});
    await sdk.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{authorization:`Bearer ${accessToken}`,...(origin ? {origin} : {})}}}));
    return sdk;
  }
  let sdk=await connect(tokens.access_token);
  phase='SDK tool calls';
  const tools=(await sdk.listTools()).tools;
  assert.deepEqual(tools.map(t=>t.name).sort(),['get_report','get_report_skill','list_comments','list_reports','publish_report','unpublish_report']);
  assert.ok(tools.every(t=>t.annotations?.openWorldHint===false || t.name==='publish_report'));
  const skill=await sdk.callTool({name:'get_report_skill',arguments:{}});
  assert.match(skill.content[0].text,/dark\s+Material 3/); assert.match(skill.content[0].text,/public to anyone with the link/);
  assert.ok(!skill.content[0].text.includes('postplan upload'), 'Remote instructions must not require a shell');
  assert.equal((await sdk.listResources()).resources[0].uri,'postplan://skills/post-report');
  assert.match((await sdk.readResource({uri:'postplan://skills/post-report'})).contents[0].text,/publish_report/);
  assert.equal((await sdk.getPrompt({name:'post-report'})).messages[0].role,'user');
  const call=async(name,args={})=>{
    const result=await sdk.callTool({name,arguments:args}); assert.ok(!result.isError,JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  assert.deepEqual(await call('list_reports'),[]);
  const invalid=await sdk.callTool({name:'publish_report',arguments:{html:'<iframe src="https://evil.test"></iframe>'}}); assert.equal(invalid.isError,true);
  const report=await call('publish_report',{html:'<!doctype html><html><title>MCP report</title><body><h1>Published by MCP</h1></body></html>',description:'MCP integration test'});
  assert.equal(report.versionNumber,1); assert.equal(report.publicUrl,`${base}/d/${report.draftId}`);
  assert.equal((await call('list_reports'))[0].draftId,report.draftId);
  assert.match((await call('get_report',{draftId:report.draftId})).html,/Published by MCP/);
  const next=await call('publish_report',{draftId:report.draftId,html:'<!doctype html><title>MCP report v2</title><h1>Updated</h1>'}); assert.equal(next.versionNumber,2);
  assert.match((await call('get_report',{draftId:report.draftId,version:1})).html,/Published by MCP/);
  const foreignDraft=randomUUID();
  await pool.query('INSERT INTO drafts(id,account_id,title) VALUES($1,$2,$3)',[foreignDraft,outsider,'Foreign report']);
  assert.equal((await sdk.callTool({name:'get_report',arguments:{draftId:foreignDraft}})).isError,true);
  assert.equal((await sdk.callTool({name:'publish_report',arguments:{draftId:foreignDraft,html:'<title>Not mine</title>'}})).isError,true);
  await pool.query('INSERT INTO review_comments(id,draft_id,version_id,author_id,author_name,body,anchor) SELECT $1,id,current_version_id,$2,$3,$4,$5 FROM drafts WHERE id=$6',[randomUUID(),outsider,'Reviewer','Private owner-visible feedback',{type:'text',quote:'Updated',selector:'h1',prefix:'',suffix:''},report.draftId]);
  assert.equal((await call('list_comments',{draftId:report.draftId}))[0].body,'Private owner-visible feedback');
  assert.equal((await sdk.callTool({name:'unpublish_report',arguments:{draftId:report.draftId,confirmTitle:'wrong'}})).isError,true);
  assert.equal((await sdk.callTool({name:'unpublish_report',arguments:{draftId:foreignDraft,confirmTitle:'Foreign report'}})).isError,true);
  assert.ok((await call('unpublish_report',{draftId:report.draftId,confirmTitle:'MCP report v2'})).ok);
  assert.equal((await pool.query('SELECT deleted_at FROM drafts WHERE id=$1',[report.draftId])).rows[0].deleted_at instanceof Date,true);
  await sdk.close();
  phase='restart persistence';
  await new Promise(resolve=>server.close(resolve)); await start();
  sdk=await connect(tokens.access_token); await sdk.close();
  phase='expiration, refresh rotation and revocation';
  await pool.query('UPDATE mcp_tokens SET expires_at=now()-interval \'1 second\' WHERE access_hash=$1',[hash(tokens.access_token)]);
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${tokens.access_token}`}})).status,401);
  const refresh={grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:`${base}/mcp`};
  for(const change of [{client_id:foreign.client_id},{resource:'https://evil.test/mcp'},{scope:'admin'}]) assert.equal((await form('/token',{...refresh,...change})).status,400);
  const rotated=await json(await form('/token',refresh));
  assert.notEqual(rotated.refresh_token,tokens.refresh_token);
  sdk=await connect(rotated.access_token); await sdk.close();
  assert.equal((await form('/token',refresh)).status,400,'Refresh reuse must fail');
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${rotated.access_token}`}})).status,401,'Reuse must revoke the entire grant');
  const second=await json(await form('/token',{...exchange,code:await grant()}));
  await json(await form('/revoke',{client_id:client.client_id,token:second.refresh_token,token_type_hint:'refresh_token'}));
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${second.access_token}`}})).status,401);
  const third=await json(await form('/token',{...exchange,code:await grant()}));
  await pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=(SELECT api_key_id FROM mcp_tokens WHERE access_hash=$1)',[hash(third.access_token)]);
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${third.access_token}`}})).status,401,'Dashboard revocation applies immediately');
  const parallelCode=await grant();
  const parallel=await Promise.all([form('/token',{...exchange,code:parallelCode}),form('/token',{...exchange,code:parallelCode})]);
  assert.deepEqual(parallel.map(res=>res.status).sort(),[200,400]);
  console.log('PASS: OAuth consent/CSRF/escaping, client/redirect/resource/PKCE binding, atomic code use, encrypted client secrets, token separation/expiry, refresh rotation/reuse, restart persistence, revocation, SDK tools/prompts/resources, upload/versioning, ownership, private comments and confirmed unpublish');
} catch(error) {
  console.error(`MCP PostgreSQL smoke failed during ${phase}`);
  throw error;
} finally {
  mock.restoreAll(); if(server) await new Promise(resolve=>server.close(resolve)); await pool.end();
}
