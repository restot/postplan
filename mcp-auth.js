import {randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv} from 'node:crypto';
import express from 'express';
import {mcpAuthRouter, createOAuthMetadata, mcpAuthMetadataRouter} from '@modelcontextprotocol/sdk/server/auth/router.js';
import {InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {pool, withTransaction} from './db.js';
import {config} from './config.js';
import {readSession, signToken, verifyToken} from './web-auth.js';

export const MCP_SCOPE = 'postplan:reports';
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export async function initMcpDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS mcp_clients (
    id TEXT PRIMARY KEY, metadata JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS mcp_codes (
    code_hash TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
    client_id TEXT NOT NULL REFERENCES mcp_clients(id), api_key_id TEXT NOT NULL REFERENCES api_keys(id),
    challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS mcp_tokens (
    access_hash TEXT PRIMARY KEY, refresh_hash TEXT UNIQUE NOT NULL,
    client_id TEXT NOT NULL REFERENCES mcp_clients(id), api_key_id TEXT NOT NULL REFERENCES api_keys(id),
    resource TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
  )`);
}

function encryptSecret(value) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm', createHash('sha256').update(config.sessionSecret).digest(), iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
function decryptSecret(value) {
  const bytes=Buffer.from(value,'base64url');
  const cipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(config.sessionSecret).digest(),bytes.subarray(0,12));
  cipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');
}

function safeRedirect(value) {
  const url=new URL(value);
  return !url.hash && !url.username && !url.password && (url.protocol==='https:' ||
    (url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)));
}
function checkResource(resource, expected) {
  if(resource && resource.href!==expected) throw new InvalidTargetError('This grant is only valid for the Postplan MCP endpoint.');
}
function checkScopes(scopes) {
  if(scopes?.some(scope=>scope!==MCP_SCOPE)) throw new InvalidScopeError('Unsupported Postplan scope.');
}

async function issueTokens(db, grant) {
  const access=token(), refresh=token();
  await db.query(`INSERT INTO mcp_tokens(access_hash,refresh_hash,client_id,api_key_id,resource,expires_at,refresh_expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '30 days')`,
  [hash(access),hash(refresh),grant.client_id,grant.api_key_id,grant.resource]);
  return {access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:MCP_SCOPE};
}

export function createMcpProvider(resource) {
  return {
    clientsStore: {
      async registerClient(client) {
        if(!client.redirect_uris?.length || client.redirect_uris.length>10 || !client.redirect_uris.every(safeRedirect)) throw new InvalidClientMetadataError('Use HTTPS redirect URIs without credentials or fragments. Loopback HTTP is supported.');
        if(!['none','client_secret_post'].includes(client.token_endpoint_auth_method || 'client_secret_post')) throw new InvalidClientMetadataError('Use none or client_secret_post authentication.');
        if((client.client_name?.length || 0)>200) throw new InvalidClientMetadataError('Client name is too long.');
        const metadata={...client};
        if(metadata.client_secret) { metadata.encrypted_secret=encryptSecret(metadata.client_secret); delete metadata.client_secret; }
        await pool.query('INSERT INTO mcp_clients(id,metadata) VALUES($1,$2)',[client.client_id,metadata]);
        return client;
      },
      async getClient(id) {
        const row=(await pool.query('SELECT metadata FROM mcp_clients WHERE id=$1',[id])).rows[0];
        if(!row) return undefined;
        const client={...row.metadata};
        if(client.encrypted_secret) {
          try {client.client_secret=decryptSecret(client.encrypted_secret);} catch {return undefined;}
          delete client.encrypted_secret;
        }
        return client;
      }
    },
    async authorize(client, params, res) {
      checkResource(params.resource,resource); checkScopes(params.scopes);
      if(!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError('Invalid S256 challenge.');
      const request=signToken({purpose:'mcp-request',requestId:randomUUID(),clientId:client.client_id,
        redirectUri:params.redirectUri,challenge:params.codeChallenge,state:params.state,resource},config.sessionSecret,600);
      res.redirect(`/mcp/consent?request=${encodeURIComponent(request)}`);
    },
    async challengeForAuthorizationCode(client, code) {
      const row=(await pool.query(`SELECT challenge FROM mcp_codes WHERE code_hash=$1 AND client_id=$2
        AND consumed_at IS NULL AND expires_at>now()`,[hash(code),client.client_id])).rows[0];
      if(!row) throw new InvalidGrantError('Invalid or expired authorization code.');
      return row.challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      checkResource(requestedResource,resource);
      return withTransaction(async db=>{
        const grant=(await db.query(`UPDATE mcp_codes c SET consumed_at=now() FROM api_keys k
          WHERE c.code_hash=$1 AND c.client_id=$2 AND c.redirect_uri=$3 AND c.resource=$4
          AND c.consumed_at IS NULL AND c.expires_at>now() AND k.id=c.api_key_id AND k.revoked_at IS NULL
          RETURNING c.*`,[hash(code),client.client_id,redirectUri,resource])).rows[0];
        if(!grant) throw new InvalidGrantError('Invalid, expired or already used authorization code.');
        return issueTokens(db,grant);
      });
    },
    async exchangeRefreshToken(client, refresh, scopes, requestedResource) {
      checkResource(requestedResource,resource); checkScopes(scopes);
      const result=await withTransaction(async db=>{
        const grant=(await db.query(`SELECT t.* FROM mcp_tokens t JOIN api_keys k ON k.id=t.api_key_id
          WHERE t.refresh_hash=$1 AND t.client_id=$2 AND t.resource=$3 AND k.revoked_at IS NULL
          FOR UPDATE OF t`,[hash(refresh),client.client_id,resource])).rows[0];
        if(!grant || grant.refresh_expires_at.getTime()<=Date.now()) return null;
        if(grant.revoked_at) {
          // Reuse of a rotated refresh token invalidates the whole connection.
          await db.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[grant.api_key_id]);
          return null;
        }
        await db.query('UPDATE mcp_tokens SET revoked_at=now() WHERE access_hash=$1',[grant.access_hash]);
        return issueTokens(db,grant);
      });
      if(!result) throw new InvalidGrantError('Invalid, expired or reused refresh token.');
      return result;
    },
    async verifyAccessToken(access) {
      const grant=(await pool.query(`SELECT t.*,k.account_id,a.name AS account_name FROM mcp_tokens t
        JOIN api_keys k ON k.id=t.api_key_id JOIN accounts a ON a.id=k.account_id
        WHERE t.access_hash=$1 AND t.resource=$2 AND t.revoked_at IS NULL
        AND t.expires_at>now() AND k.revoked_at IS NULL`,[hash(access),resource])).rows[0];
      if(!grant) throw new InvalidTokenError('Invalid, expired or revoked Postplan MCP token.');
      return {token:access,clientId:grant.client_id,scopes:[MCP_SCOPE],expiresAt:Math.floor(grant.expires_at.getTime()/1000),resource:new URL(resource),
        extra:{accountId:grant.account_id,accountName:grant.account_name,apiKeyId:grant.api_key_id}};
    },
    async revokeToken(client, request) {
      await pool.query(`UPDATE api_keys SET revoked_at=now() WHERE id IN (
        SELECT api_key_id FROM mcp_tokens WHERE client_id=$1 AND (access_hash=$2 OR refresh_hash=$2))`,[client.client_id,hash(request.token)]);
    }
  };
}

const escape = value => String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function registerMcpAuth(app, issuer, resource) {
  const provider=createMcpProvider(resource.href);
  const rateLimit={keyGenerator:()=> 'postplan-oauth'};
  const options={provider,issuerUrl:issuer,resourceServerUrl:resource,scopesSupported:[MCP_SCOPE],resourceName:'Postplan reports',
    authorizationOptions:{rateLimit},tokenOptions:{rateLimit},clientRegistrationOptions:{rateLimit},revocationOptions:{rateLimit}};
  // Advertise issuer response support alongside the SDK's standard metadata.
  const metadata={...createOAuthMetadata(options),authorization_response_iss_parameter_supported:true,
    revocation_endpoint_auth_methods_supported:['client_secret_post','none']};
  app.use(mcpAuthMetadataRouter({...options,oauthMetadata:metadata}));
  app.use(mcpAuthRouter(options));
  app.get('/mcp/consent',async(req,res,next)=>{
    try {
      const csp="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
      res.setHeader('Content-Security-Policy',csp);
      // no-referrer makes native form POSTs send Origin:null, failing consent.
      // same-origin preserves it and omits referrers to other origins.
      res.setHeader('Referrer-Policy','same-origin');
      const session=readSession(req);
      if(!session) return res.redirect(`/auth/sign-in?next=${encodeURIComponent(req.originalUrl)}`);
      const request=typeof req.query.request==='string' ? req.query.request : '';
      const params=verifyToken(request,config.sessionSecret);
      if(params?.purpose!=='mcp-request' || params.resource!==resource.href) return res.status(400).send('Authorization request expired. Start again from your MCP client.');
      const client=await provider.clientsStore.getClient(params.clientId);
      if(!client || !client.redirect_uris.includes(params.redirectUri)) return res.status(400).send('Unknown client or redirect.');
      // Browsers also apply form-action to the redirect after approval.
      res.setHeader('Content-Security-Policy',csp.replace("form-action 'self'",`form-action 'self' ${new URL(params.redirectUri).origin}`));
      const approval=signToken({purpose:'mcp-consent',requestHash:hash(request),accountId:session.accountId},config.sessionSecret,600);
      res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Postplan</title>
        <style>:root{color-scheme:dark}body{font:16px system-ui;background:#141218;color:#e6e0e9;max-width:40rem;margin:10vh auto;padding:24px}button{font:inherit;padding:12px 24px;margin:8px;border:0;border-radius:24px;background:#d0bcff;color:#381e72}code{overflow-wrap:anywhere}</style>
        <h1>Connect Postplan</h1><p>Signed in as ${escape(session.accountName||'Postplan user')}.</p>
        <p><strong>${escape(client.client_name||'Unnamed MCP client')}</strong> requests access to your reports.</p>
        <p>This client name is supplied by its developer, not verified by Postplan.</p>
        <p>It can publish public reports, read and update your reports, read comments visible to your account, and unpublish reports after confirmation. It cannot run commands or access other services.</p>
        <p>Reports are public to anyone with the link. Private comments remain private.</p>
        <p>Return to <code>${escape(params.redirectUri)}</code>. Approve only if you started this connection and trust that destination.</p>
        <form method="post" action="/mcp/consent"><input type="hidden" name="request" value="${escape(request)}"><input type="hidden" name="approval" value="${escape(approval)}">
        <button name="decision" value="allow">Allow access</button><button name="decision" value="deny">Cancel</button></form></html>`);
    } catch(error) {next(error);}
  });
  app.post('/mcp/consent',(req,res,next)=>{
    if(req.get('origin')!==issuer.origin) return res.status(403).send('Same-origin approval required.');
    next();
  },express.urlencoded({extended:false,limit:'16kb'}),async(req,res,next)=>{
    try {
      const session=readSession(req), params=verifyToken(req.body.request,config.sessionSecret), approval=verifyToken(req.body.approval,config.sessionSecret);
      if(!session || approval?.purpose!=='mcp-consent' || approval.accountId!==session.accountId || approval.requestHash!==hash(req.body.request||'')) return res.status(403).send('Invalid consent.');
      if(params?.purpose!=='mcp-request' || params.resource!==resource.href) return res.status(400).send('Authorization request expired.');
      const client=await provider.clientsStore.getClient(params.clientId);
      if(!client || !client.redirect_uris.includes(params.redirectUri)) return res.status(400).send('Unknown client or redirect.');
      const callback=new URL(params.redirectUri);
      callback.searchParams.set('iss',issuer.href);
      if(params.state!==undefined) callback.searchParams.set('state',params.state);
      if(req.body.decision!=='allow') {callback.searchParams.set('error','access_denied');return res.redirect(callback.href);}
      const code=token(), keyId=randomUUID();
      try {
        await withTransaction(async db=>{
          // The grant uses an inert API-key record for attribution and dashboard revocation.
          // Its random credential is never issued. MCP access tokens cannot call /api.
          await db.query('INSERT INTO api_keys(id,account_id,name,key_hash) VALUES($1,$2,$3,$4)',[keyId,session.accountId,`MCP: ${client.client_name||'MCP client'}`,hash(token())]);
          await db.query(`INSERT INTO mcp_codes(code_hash,request_id,client_id,api_key_id,challenge,redirect_uri,resource,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 minutes')`,[hash(code),params.requestId,params.clientId,keyId,params.challenge,params.redirectUri,resource.href]);
        });
      } catch(error) {if(error.code==='23505') return res.status(400).send('Authorization already completed.');throw error;}
      callback.searchParams.set('code',code);
      res.redirect(callback.href);
    } catch(error) {next(error);}
  });
  return provider;
}
