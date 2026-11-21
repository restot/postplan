import assert from 'node:assert/strict';
import {test, before, after, mock} from 'node:test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1/test';
process.env.POSTPLAN_PUBLIC_BASE_URL = 'https://postplan.test';
process.env.POSTPLAN_SESSION_SECRET = 'mcp-unit-test-only';
const {createApp} = await import('../node_modules/postplan/src/api.js');
const {pool} = await import('../node_modules/postplan/src/db.js');
let server, base;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });

test('MCP challenges unauthenticated clients before parsing report bodies', async () => {
  const response = await fetch(`${base}/mcp`, {method:'POST', headers:{'content-type':'application/json'}, body:'{not-json'});
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /resource_metadata="https:\/\/postplan.test\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('MCP publishes OAuth discovery with PKCE and dynamic registration', async () => {
  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resource.resource, 'https://postplan.test/mcp');
  assert.deepEqual(resource.authorization_servers, ['https://postplan.test/']);
  const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
  const metadata = await response.json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.registration_endpoint, 'https://postplan.test/register');
  assert.equal(metadata.token_endpoint, 'https://postplan.test/token');
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('MCP consent requires sign-in and rejects cross-origin approval', async () => {
  const response = await fetch(`${base}/mcp/consent?request=invalid`, {redirect:'manual'});
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/auth\/sign-in\?next=/);
  const approval = await fetch(`${base}/mcp/consent`, {method:'POST',headers:{origin:'https://evil.test','content-type':'application/x-www-form-urlencoded'},body:'request=invalid'});
  assert.equal(approval.status, 403);
});

test('MCP rejects unsafe redirect registrations without contacting a database', async () => {
  for (const redirect of ['http://evil.test/callback', 'javascript:alert(1)', 'https://grok.com/callback#fragment', 'https://user:pass@grok.com/callback']) {
    const response = await fetch(`${base}/register`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:[redirect],token_endpoint_auth_method:'none'})});
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_client_metadata');
  }
});

test('OAuth consent navigation accepts opaque and external origins without bypassing sign-in', async () => {
  for (const origin of ['null','https://shoo.dev','https://www.grok.com','https://another-client.test']) {
    const response=await fetch(`${base}/mcp/consent?request=invalid`,{redirect:'manual',headers:{origin}});
    assert.equal(response.status,302,origin);
    assert.match(response.headers.get('location'),/^\/auth\/sign-in\?next=/);
    assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }
});

test('OAuth discovery is cross-origin while protocol connections reject untrusted origins', async () => {
  const metadata=await fetch(`${base}/.well-known/oauth-authorization-server`,{headers:{origin:'null'}});
  assert.equal(metadata.status,200);
  assert.equal(metadata.headers.get('access-control-allow-origin'),'*');
  for (const origin of ['null','https://evil.test']) {
    for (const path of ['/mcp','/mcp/']) {
      for (const method of ['GET','POST','DELETE']) {
        const response=await fetch(`${base}${path}`,{method,headers:{origin}});
        assert.equal(response.status,403,`${method} ${path} ${origin}`);
      }
    }
  }
  const allowed=await fetch(`${base}/mcp`,{headers:{origin:'https://grok.com'}});
  assert.equal(allowed.status,401);
});

test('OAuth consent submission still rejects opaque, external and missing origins', async () => {
  for (const origin of ['null','https://grok.com','https://claude.ai','https://evil.test',undefined]) {
    const headers={'content-type':'application/x-www-form-urlencoded'};
    if(origin!==undefined) headers.origin=origin;
    const response=await fetch(`${base}/mcp/consent`,{method:'POST',headers,body:'request=invalid'});
    assert.equal(response.status,403);
  }
});

test('Claude MCP origins reach bearer authentication without trusting lookalike origins', async () => {
  for (const path of ['/mcp','/mcp/']) {
    for (const method of ['GET','POST','DELETE']) {
      const response=await fetch(`${base}${path}`,{method,headers:{origin:'https://claude.ai'}});
      assert.equal(response.status,401,`${method} ${path}`);
      assert.match(response.headers.get('www-authenticate'),/^Bearer /);
    }
  }
  for (const origin of ['http://claude.ai','https://claude.ai.evil.test','https://evil.claude.ai','https://claude.ai:444']) {
    assert.equal((await fetch(`${base}/mcp`,{headers:{origin}})).status,403,origin);
  }
});

test('OAuth endpoints validate cross-origin requests using OAuth rules instead of MCP origin rules', async () => {
  const registration=await fetch(`${base}/register`,{method:'POST',headers:{origin:'null','content-type':'application/json'},body:JSON.stringify({redirect_uris:['http://evil.test/callback'],token_endpoint_auth_method:'none'})});
  assert.equal(registration.status,400);
  assert.equal((await registration.json()).error,'invalid_client_metadata');
  for (const path of ['/authorize','/token','/revoke']) {
    const response=await fetch(`${base}${path}`,{method:'POST',headers:{origin:'null','content-type':'application/x-www-form-urlencoded'},body:''});
    assert.equal(response.status,400,path);
    assert.equal((await response.json()).error,'invalid_request');
  }
});

test('consent referrer policy preserves the Origin header on same-origin form submissions', async () => {
  const response=await fetch(`${base}/mcp/consent?request=invalid`,{redirect:'manual'});
  assert.equal(response.headers.get('referrer-policy'),'same-origin');
});

test('opt-in MCP diagnostics record request outcomes without credentials or content', async () => {
  const logged=mock.method(console,'info',()=>{});
  const previous=process.env.POSTPLAN_MCP_DIAGNOSTICS;
  try {
    delete process.env.POSTPLAN_MCP_DIAGNOSTICS;
    await fetch(`${base}/mcp`);
    assert.equal(logged.mock.callCount(),0);
    process.env.POSTPLAN_MCP_DIAGNOSTICS='1';
    const response=await fetch(`${base}/mcp?secret-query=must-not-log`,{method:'POST',headers:{
      origin:'https://untrusted.test/private-origin',authorization:'Bearer must-not-log',cookie:'session=must-not-log',
      'user-agent':'Claude-User private-agent-must-not-log','content-type':'application/json',accept:'application/json, text/event-stream'
    },body:'{"privateReport":"must-not-log"}'});
    assert.equal(response.status,403);
    assert.equal(logged.mock.callCount(),1);
    assert.deepEqual(JSON.parse(logged.mock.calls[0].arguments[0]),{
      event:'postplan_mcp_request',method:'POST',status:403,origin:'untrusted',agent:'anthropic',
      hasBearer:true,authenticated:false,acceptJson:true,acceptSse:true
    });
    await fetch(`${base}/mcp`,{headers:{origin:'https://claude.ai'}});
    const allowed=JSON.parse(logged.mock.calls[1].arguments[0]);
    assert.equal(allowed.status,401);assert.equal(allowed.origin,'https://claude.ai');assert.equal(allowed.hasBearer,false);
  } finally {
    logged.mock.restore();
    if(previous===undefined) delete process.env.POSTPLAN_MCP_DIAGNOSTICS;
    else process.env.POSTPLAN_MCP_DIAGNOSTICS=previous;
  }
});
