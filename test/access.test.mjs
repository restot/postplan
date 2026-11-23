import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test, before, after, afterEach, mock } from 'node:test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1/test';
process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:9000';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_S3_BUCKET_NAME = 'test';
process.env.POSTPLAN_PUBLIC_BASE_URL = 'https://postplan.test';
process.env.POSTPLAN_SESSION_SECRET = 'access-unit-test-secret';

const { createApp } = await import('../node_modules/postplan/src/api.js');
const { pool } = await import('../node_modules/postplan/src/db.js');
const { config } = await import('../node_modules/postplan/src/config.js');
const { createSessionCookie } = await import('../node_modules/postplan/src/web-auth.js');
const { normalizeAccessRules, emailMatchesAccessRules } = await import('../node_modules/postplan/src/access.js');
const { S3Client } = await import('@aws-sdk/client-s3');

let server, base;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
  mock.restoreAll();
  config.publicBaseUrl = 'https://postplan.test';
});
after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });

const cookieFor = (accountId, accountName, email = null) =>
  createSessionCookie({ accountId, accountName, email }).split(';')[0];

test('normalizeAccessRules validates, deduplicates and rejects blank/separator-only entries', () => {
  assert.deepEqual(
    normalizeAccessRules('@Workspace.Email, my-friend@Email.COM\n@workspace.email'),
    { ok: true, rules: ['@workspace.email', 'my-friend@email.com'] }
  );
  assert.deepEqual(normalizeAccessRules([]), { ok: true, rules: [] });
  assert.deepEqual(normalizeAccessRules('   ', { allowEmptyString: true }), { ok: true, rules: [] });
  // Non-empty arrays with blank/separator entries and empty strings without allowEmptyString must fail.
  for (const bad of [
    '',
    '   ',
    ',,,',
    [''],
    ['   '],
    [','],
    ['@workspace.email', '  '],
    ['workspace.email'],
    ['@localhost'],
    ['@*.workspace.email'],
    ['@bad..com'],
    ['user@'],
    ['a@b@c.com'],
    ['user@localhost'],
    ['.lead@example.com'],
    ['trail.@example.com'],
    ['two..dots@example.com']
  ]) {
    assert.equal(normalizeAccessRules(bad).ok, false, `Expected invalid: ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeAccessRules(',,,', { allowEmptyString: true }).ok, false);
  const tooMany = Array.from({ length: 101 }, (_, i) => `user${i}@example.com`);
  assert.equal(normalizeAccessRules(tooMany).ok, false);
});

test('emailMatchesAccessRules enforces exact domain and exact email matches', () => {
  const rules = ['@workspace.email', 'my-friend@email.com'];
  assert.equal(emailMatchesAccessRules('alice@workspace.email', rules), true);
  assert.equal(emailMatchesAccessRules('ALICE@WORKSPACE.EMAIL', rules), true);
  assert.equal(emailMatchesAccessRules('my-friend@email.com', rules), true);
  assert.equal(emailMatchesAccessRules('MY-FRIEND@email.com', rules), true);
  assert.equal(emailMatchesAccessRules('alice@evilworkspace.email', rules), false);
  assert.equal(emailMatchesAccessRules('alice@sub.workspace.email', rules), false);
  assert.equal(emailMatchesAccessRules('other-friend@email.com', rules), false);
  assert.equal(emailMatchesAccessRules('not-an-email', rules), false);
  assert.equal(emailMatchesAccessRules(null, rules), false);
});

test('restricted draft gates page, frame, raw (session + bearer), preview PNG and missing versions in one snapshot', async () => {
  const html = '<!doctype html><html><head><title>Secret Roadmap</title></head><body><h1>Confidential</h1></body></html>';
  const baseRow = {
    id: 'restricted12',
    account_id: 'owner-acct',
    current_version_id: 'v1',
    title: 'Secret Roadmap',
    description: 'Internal Q4 plan',
    allowed_access: ['@workspace.email', 'my-friend@email.com']
  };
  const verifiedEmails = {
    'teammate-acct': ['alice@workspace.email'],
    'friend-acct': ['my-friend@email.com'],
    'outsider-acct': ['stranger@other.com'],
    'unverified-acct': []
  };
  const apiKeys = {
    'owner-key': { id: 'k-owner', account_id: 'owner-acct', name: 'Owner CLI', account_name: 'Owner' },
    'teammate-key': { id: 'k-team', account_id: 'teammate-acct', name: 'Team CLI', account_name: 'Alice' },
    'outsider-key': { id: 'k-out', account_id: 'outsider-acct', name: 'Out CLI', account_name: 'Outsider' }
  };
  let findCalls = 0;
  mock.method(pool, 'query', async (sql, args) => {
    if (sql.includes('LEFT JOIN draft_versions')) {
      findCalls++;
      const requested = args[1];
      if (requested === 99) return { rows: [{ ...baseRow, version_id: null, version_number: null, object_key: null, content_hash: null }] };
      return { rows: [{ ...baseRow, version_id: 'v1', version_number: requested || 1, object_key: 'k1', content_hash: 'h1' }] };
    }
    if (sql.includes('FROM api_keys')) {
      const { createHash } = await import('node:crypto');
      const match = Object.entries(apiKeys).find(([token]) => createHash('sha256').update(token).digest('hex') === args[0]);
      return { rows: match ? [match[1]] : [] };
    }
    if (sql.includes('UPDATE api_keys')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM identities')) {
      assert.match(sql, /email_verified IS TRUE/);
      return { rows: (verifiedEmails[args[0]] || []).map(email => ({ email })) };
    }
    return { rows: [] };
  });
  mock.method(S3Client.prototype, 'send', async () => ({ Body: (async function* () { yield Buffer.from(html); })() }));

  // Anonymous visitor gets 401 on existing and missing versions alike (no version-existence oracle), in one DB query.
  const anon = await fetch(`${base}/d/restricted12`);
  assert.equal(anon.status, 401);
  assert.equal(findCalls, 1);
  const anonBody = await anon.text();
  assert.match(anonBody, /Restricted report/);
  assert.match(anonBody, /\/auth\/sign-in\?next=%2Fd%2Frestricted12/);
  assert.doesNotMatch(anonBody, /Secret Roadmap|Internal Q4|workspace\.email|my-friend|Confidential|og:image/);
  assert.equal(anon.headers.get('x-postplan-draft-id'), null);
  assert.equal((await fetch(`${base}/d/restricted12/v/99`)).status, 401);
  assert.equal((await fetch(`${base}/d/restricted12/v/99/preview.png`)).status, 401);
  assert.equal((await fetch(`${base}/d/restricted12/raw`)).status, 401);
  assert.equal((await fetch(`${base}/d/restricted12?postplan-frame=1`)).status, 401);
  assert.equal((await fetch(`${base}/d/restricted12/preview.png`)).status, 401);

  // Signed-in outsider and unverified user get 403 (even on missing version 99) without leaking draft metadata or allowlist.
  for (const [id, email] of [['outsider-acct', 'stranger@other.com'], ['unverified-acct', 'spoof@workspace.email']]) {
    const cookie = cookieFor(id, 'Outsider', email);
    const denied = await fetch(`${base}/d/restricted12`, { headers: { cookie } });
    assert.equal(denied.status, 403);
    const deniedBody = await denied.text();
    assert.match(deniedBody, /Access denied/);
    assert.doesNotMatch(deniedBody, /Secret Roadmap|my-friend|Confidential/);
    if (id === 'outsider-acct') assert.doesNotMatch(deniedBody, /workspace\.email/);
    assert.equal((await fetch(`${base}/d/restricted12/v/99`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/d/restricted12/v/99/preview.png`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/d/restricted12/raw`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/d/restricted12?postplan-frame=1`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/d/restricted12/preview.png`, { headers: { cookie } })).status, 403);
  }

  // Domain member, exact-email friend and draft owner all get full access (and 404 for genuinely missing version 99).
  for (const [id, email] of [
    ['teammate-acct', 'alice@workspace.email'],
    ['friend-acct', 'my-friend@email.com'],
    ['owner-acct', 'owner@personal.org']
  ]) {
    const cookie = cookieFor(id, 'Authorized', email);
    const ok = await fetch(`${base}/d/restricted12`, { headers: { cookie } });
    assert.equal(ok.status, 200, id);
    assert.match(await ok.text(), /Secret Roadmap/);
    assert.equal(await (await fetch(`${base}/d/restricted12/raw`, { headers: { cookie } })).text(), html);
    assert.equal((await fetch(`${base}/d/restricted12/preview.png`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/d/restricted12/v/99`, { headers: { cookie } })).status, 404);
  }

  // REST Bearer keys work on /raw with owner + verified-email checks (never expanded by browser cookies).
  assert.equal(await (await fetch(`${base}/d/restricted12/raw`, { headers: { authorization: 'Bearer owner-key' } })).text(), html);
  assert.equal(await (await fetch(`${base}/d/restricted12/raw`, { headers: { authorization: 'Bearer teammate-key' } })).text(), html);
  assert.equal((await fetch(`${base}/d/restricted12/raw`, { headers: { authorization: 'Bearer outsider-key', cookie: cookieFor('owner-acct', 'Owner') } })).status, 403);
  assert.equal((await fetch(`${base}/d/restricted12/raw`, { headers: { authorization: 'Bearer invalid-key', cookie: cookieFor('owner-acct', 'Owner') } })).status, 401);
});

test('restricted draft gates versions, comments and comment writes for unauthorized viewers', async () => {
  const draft = { id: 'restricted12', account_id: 'owner-acct', allowed_access: ['@workspace.email'] };
  mock.method(pool, 'query', async (sql, args) => {
    if (sql.includes('api_keys')) return { rows: [{ id: 'k', account_id: args[0] ? 'outsider-acct' : 'owner-acct' }] };
    if (sql.includes('AS current')) return { rows: [{ version: 1, created_at: '2026-10-01T00:00:00Z', current: true, account_id: draft.account_id, allowed_access: draft.allowed_access }] };
    if (sql.includes('FROM drafts')) return { rows: [draft] };
    if (sql.includes('FROM identities')) return { rows: args[0] === 'teammate-acct' ? [{ email: 'bob@workspace.email' }] : [{ email: 'outsider@gmail.com' }] };
    if (sql.includes('FROM review_comments')) return { rows: [] };
    return { rows: [] };
  });

  assert.equal((await fetch(`${base}/review-api/drafts/restricted12/versions`)).status, 401);
  assert.equal((await fetch(`${base}/review-api/drafts/restricted12/versions`, { headers: { cookie: cookieFor('outsider-acct', 'Out') } })).status, 403);
  const okVersions = await fetch(`${base}/review-api/drafts/restricted12/versions`, { headers: { cookie: cookieFor('teammate-acct', 'Bob') } });
  assert.equal(okVersions.status, 200);
  assert.deepEqual(Object.keys((await okVersions.json())[0]).sort(), ['created_at', 'current', 'version']);

  assert.equal((await fetch(`${base}/review-api/drafts/restricted12/comments`)).status, 401);
  assert.equal((await fetch(`${base}/review-api/drafts/restricted12/comments`, { headers: { cookie: cookieFor('outsider-acct', 'Out') } })).status, 403);
  assert.equal((await fetch(`${base}/review-api/drafts/restricted12/comments`, { headers: { cookie: cookieFor('teammate-acct', 'Bob') } })).status, 200);
  assert.equal((await fetch(`${base}/api/drafts/restricted12/comments`, { headers: { authorization: 'Bearer outsider' } })).status, 403);

  const postRes = await fetch(`${base}/review-api/drafts/restricted12/comments`, {
    method: 'POST',
    headers: { cookie: cookieFor('outsider-acct', 'Out'), origin: 'https://postplan.test', 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Hi', version: 1, anchor: { type: 'text', quote: 'Hi', selector: 'body > h1:nth-of-type(1)', prefix: '', suffix: '' } })
  });
  assert.equal(postRes.status, 403);
});

test('owner access updates enforce ownership SQL, content-type, required fields, max-rule form size and wildcard apex origin', async () => {
  let stored = ['@workspace.email'];
  mock.method(pool, 'query', async (sql, args) => {
    if (sql.includes('api_keys')) return { rows: [{ id: 'k', account_id: 'owner-acct', name: 'CLI', account_name: 'Owner' }] };
    if (sql.includes('UPDATE drafts SET allowed_access')) {
      assert.match(sql, /WHERE id=\$1 AND account_id=\$2 AND deleted_at IS NULL/);
      if (args[1] !== 'owner-acct') return { rows: [], rowCount: 0 };
      stored = args[2];
      return { rows: [{ id: args[0], allowed_access: stored }], rowCount: 1 };
    }
    if (sql.includes('FROM drafts')) return { rows: [{ id: 'abcdefghijkl', account_id: 'owner-acct', allowed_access: stored, title: 'My Report' }] };
    if (sql.includes('FROM draft_versions')) return { rows: [{ id: 'v1', version_number: 1, created_at: '2026-10-01T00:00:00Z' }] };
    return { rows: [] };
  });

  const ownerCookie = cookieFor('owner-acct', 'Owner', 'owner@workspace.email');
  const otherCookie = cookieFor('other-acct', 'Other', 'other@workspace.email');

  assert.equal((await fetch(`${base}/review-api/drafts/abcdefghijkl/access`)).status, 401);
  assert.equal((await fetch(`${base}/review-api/drafts/abcdefghijkl/access`, { headers: { cookie: otherCookie } })).status, 403);
  assert.deepEqual(await (await fetch(`${base}/review-api/drafts/abcdefghijkl/access`, { headers: { cookie: ownerCookie } })).json(), { restricted: true, allowed: ['@workspace.email'] });

  // Wildcard publicBaseUrl resolves apex origin for sidebar PUT and review writes.
  config.publicBaseUrl = 'https://*.postplan.test';
  const wildcardPut = await fetch(`${base}/review-api/drafts/abcdefghijkl/access`, {
    method: 'PUT',
    headers: { cookie: ownerCookie, origin: 'https://postplan.test', 'content-type': 'application/json' },
    body: JSON.stringify({ allowed: '@workspace.email, my-friend@email.com' })
  });
  assert.equal(wildcardPut.status, 200);
  config.publicBaseUrl = 'https://postplan.test';

  // REST PUT rejects blank array entries and empty string, accepts explicit [].
  assert.equal((await fetch(`${base}/api/drafts/abcdefghijkl/access`, {
    method: 'PUT',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ allowed: ['   '] })
  })).status, 422);
  assert.equal((await fetch(`${base}/api/drafts/abcdefghijkl/access`, {
    method: 'PUT',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ allowed: '' })
  })).status, 422);
  const apiPut = await fetch(`${base}/api/drafts/abcdefghijkl/access`, {
    method: 'PUT',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ allowed: [] })
  });
  assert.equal(apiPut.status, 200);
  assert.equal((await apiPut.json()).restricted, false);

  // Dashboard form POST enforces same-origin, form content-type, required allowed field, and 100 long rules.
  stored = ['@workspace.email'];
  assert.equal((await fetch(`${base}/dashboard/drafts/abcdefghijkl/access`, {
    method: 'POST',
    headers: { cookie: ownerCookie, origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'allowed=@workspace.email',
    redirect: 'manual'
  })).status, 403);
  assert.equal((await fetch(`${base}/dashboard/drafts/abcdefghijkl/access`, {
    method: 'POST',
    headers: { cookie: ownerCookie, origin: 'https://postplan.test', 'content-type': 'application/json' },
    body: JSON.stringify({}),
    redirect: 'manual'
  })).status, 415);
  assert.equal((await fetch(`${base}/dashboard/drafts/abcdefghijkl/access`, {
    method: 'POST',
    headers: { cookie: ownerCookie, origin: 'https://postplan.test', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'other=1',
    redirect: 'manual'
  })).status, 422);
  assert.deepEqual(stored, ['@workspace.email'], 'Missing field must not clear existing restrictions');

  const maxRules = Array.from({ length: 100 }, (_, i) => `${'a'.repeat(50)}${i}@${'b'.repeat(60)}.${'c'.repeat(60)}.example.com`);
  const dashMax = await fetch(`${base}/dashboard/drafts/abcdefghijkl/access`, {
    method: 'POST',
    headers: { cookie: ownerCookie, origin: 'https://postplan.test', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ allowed: maxRules.join('\n') }),
    redirect: 'manual'
  });
  assert.equal(dashMax.status, 303);
  assert.equal(stored.length, 100);
});

test('wildcard subdomain redirects restricted and review-mode navigations to apex preserving version and review query', async () => {
  config.publicBaseUrl = 'https://*.postplan.test';
  mock.method(pool, 'query', async () => ({
    rows: [{ id: 'abcdefghijkl', account_id: 'owner-acct', current_version_id: 'v2', title: 'Secret', allowed_access: ['@workspace.email'], version_id: 'v2', version_number: 2, object_key: 'k2', content_hash: 'h2' }]
  }));
  const getWithHost = path => new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { headers: { host: 'abcdefghijkl.postplan.test' } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
  const res = await getWithHost('/v/2?review=1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://postplan.test/d/abcdefghijkl/v/2?review=1');

  // Public wildcard subdomain also redirects ?review=1 to apex and wires the Comments button to apex.
  mock.restoreAll();
  mock.method(pool, 'query', async () => ({
    rows: [{ id: 'abcdefghijkl', account_id: 'owner-acct', current_version_id: 'v2', title: 'Public', allowed_access: [], version_id: 'v2', version_number: 2, object_key: 'k2', content_hash: 'h2' }]
  }));
  mock.method(S3Client.prototype, 'send', async () => ({ Body: (async function* () { yield Buffer.from('<!doctype html><title>Public</title><p>Hi</p>'); })() }));
  const pubReview = await getWithHost('/v/2?review=1');
  assert.equal(pubReview.status, 302);
  assert.equal(pubReview.headers.location, 'https://postplan.test/d/abcdefghijkl/v/2?review=1');
  const pubNormal = await getWithHost('/v/2');
  assert.equal(pubNormal.status, 200);
  assert.match(pubNormal.text, /https:\/\/postplan\.test\/d\/abcdefghijkl\/v\/2\?review=1/);
});

test('POST /api/uploads/with-access rejects missing access field before any storage or DB write', async () => {
  let s3Calls = 0;
  let dbWrites = 0;
  mock.method(pool, 'query', async sql => {
    if (sql.includes('api_keys')) return { rows: [{ id: 'k', account_id: 'owner-acct', name: 'CLI', account_name: 'Owner' }], rowCount: 1 };
    if (/INSERT|UPDATE/i.test(sql) && !sql.includes('api_keys')) dbWrites++;
    return { rows: [], rowCount: 0 };
  });
  mock.method(S3Client.prototype, 'send', async () => { s3Calls++; return {}; });
  const missing = await fetch(`${base}/api/uploads/with-access`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ html: '<!doctype html><title>No ACL</title><p>Hi</p>' })
  });
  assert.equal(missing.status, 422);
  assert.match((await missing.json()).error, /access field is required/);
  assert.equal(s3Calls, 0);
  assert.equal(dbWrites, 0);
});

test('CLI upload --allow uses /api/uploads/with-access, fails closed on older servers, and rejects empty --allow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'postplan-access-cli-'));
  const htmlPath = join(dir, 'report.html');
  writeFileSync(htmlPath, '<!doctype html><title>CLI</title><p>Hello</p>');
  const runCli = (apiUrl, ...args) => promisify(execFile)(
    process.execPath,
    ['node_modules/postplan/bin/postplan.js', ...args],
    { cwd: new URL('..', import.meta.url), env: { ...process.env, POSTPLAN_CONFIG_DIR: dir, POSTPLAN_API_URL: apiUrl, POSTPLAN_API_KEY: 'test-key' } }
  );

  // 1) Older server only implements /api/uploads (returns 404 on /api/uploads/with-access).
  let oldUploads = 0;
  const oldServer = createServer((req, res) => {
    if (req.url === '/api/uploads') {
      oldUploads++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, draftId: 'leaked123456', versionNumber: 1, publicUrl: 'http://old/d/leaked123456' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => oldServer.once('listening', resolve));
  const oldBase = `http://127.0.0.1:${oldServer.address().port}`;

  // 2) Current server handling /api/uploads/with-access and /api/drafts/:id/access.
  const seenRequests = [];
  let stored = ['@workspace.email'];
  const newServer = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seenRequests.push({ method: req.method, url: req.url, body });
      if (req.url === '/api/uploads/with-access') {
        stored = body.access;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, draftId: 'abcdefghijkl', versionNumber: 1,
          publicUrl: 'https://postplan.test/d/abcdefghijkl',
          rawUrl: 'https://postplan.test/d/abcdefghijkl/raw',
          access: { restricted: stored.length > 0, allowed: stored }
        }));
        return;
      }
      if (req.url === '/api/drafts/abcdefghijkl/access') {
        if (req.method === 'PUT') stored = body.allowed;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, draftId: 'abcdefghijkl', restricted: stored.length > 0, allowed: stored }));
        return;
      }
      res.writeHead(404).end();
    });
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => newServer.once('listening', resolve));
  const newBase = `http://127.0.0.1:${newServer.address().port}`;

  try {
    // Mixed-version safety: --allow against old server must fail without uploading or writing drafts.json.
    await assert.rejects(
      runCli(oldBase, 'upload', htmlPath, '--allow', '@workspace.email'),
      /does not support access restrictions\. Nothing was uploaded/
    );
    assert.equal(oldUploads, 0);
    assert.equal(existsSync(join(dir, 'drafts.json')), false);

    // Empty or delimiter-only --allow must fail before any request.
    await assert.rejects(runCli(newBase, 'upload', htmlPath, '--allow', ''), /Invalid empty --allow value/);
    await assert.rejects(runCli(newBase, 'upload', htmlPath, '--allow', ' , '), /Invalid empty --allow value/);
    await assert.rejects(runCli(newBase, 'upload', htmlPath, '--allow', '@workspace.email', '--public'), /Use either --allow or --public/);

    // Successful restricted upload and access CLI commands.
    const up = await runCli(newBase, 'upload', htmlPath, '--allow', '@workspace.email', '--allow', 'my-friend@email.com');
    assert.match(up.stdout, /Access: restricted \(@workspace\.email, my-friend@email\.com\)/);
    assert.equal(seenRequests[0].url, '/api/uploads/with-access');
    assert.deepEqual(seenRequests[0].body.access, ['@workspace.email', 'my-friend@email.com']);

    const view = await runCli(newBase, 'access', 'abcdefghijkl');
    assert.match(view.stdout, /Restricted \(2\): @workspace\.email, my-friend@email\.com/);
    const pub = await runCli(newBase, 'access', 'abcdefghijkl', '--public');
    assert.match(pub.stdout, /Public \(anyone with the link\)/);
    assert.deepEqual(stored, []);
  } finally {
    await Promise.all([
      new Promise(resolve => oldServer.close(resolve)),
      new Promise(resolve => newServer.close(resolve))
    ]);
    rmSync(dir, { recursive: true, force: true });
  }
});
