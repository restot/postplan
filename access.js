import express from 'express';
import {pool, withTransaction} from './db.js';
import {config} from './config.js';
import {readSession} from './web-auth.js';
import {getHomeUrl} from './public-url.js';
import {createRateLimiter} from './rate-limit.js';

const DOMAIN_RE=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOCAL_RE=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const MAX_RULES=100;

export const ACCESS_JSON_LIMIT='64kb';
export const ACCESS_FORM_LIMIT='128kb';

export function sqlDraftAccessClause(viewerParam, draftAlias='d') {
  return `(
    cardinality(${draftAlias}.allowed_access) = 0
    OR (${viewerParam}::text IS NOT NULL AND ${draftAlias}.account_id = ${viewerParam}::text)
    OR (${viewerParam}::text IS NOT NULL AND EXISTS (
      SELECT 1 FROM identities i
      WHERE i.account_id = ${viewerParam}::text
        AND i.email IS NOT NULL
        AND i.email_verified IS TRUE
        AND position('@' IN lower(trim(i.email))) > 1
        AND position('@' IN substring(lower(trim(i.email)) FROM position('@' IN lower(trim(i.email))) + 1)) = 0
        AND (
          lower(trim(i.email)) = ANY(${draftAlias}.allowed_access)
          OR substring(lower(trim(i.email)) FROM position('@' IN lower(trim(i.email)))) = ANY(${draftAlias}.allowed_access)
        )
    ))
  )`;
}

export function getConfiguredApexOrigin() {
  if(!config.publicBaseUrl) return null;
  try { return new URL(getHomeUrl({publicBaseUrl:config.publicBaseUrl,requestBaseUrl:''})).origin; }
  catch { return null; }
}

export async function initAccessDb() {
  const existing=await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'drafts' AND column_name = 'allowed_access'
     LIMIT 1`
  );
  if(existing.rowCount) return;
  await withTransaction(async client=>{
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("ALTER TABLE drafts ADD COLUMN IF NOT EXISTS allowed_access TEXT[] NOT NULL DEFAULT '{}'");
  });
}

export function normalizeAccessRules(input, {allowEmptyString=false}={}) {
  const rules=[], seen=new Set();
  const addTokens=(parts, sourceLabel)=>{
    if(!parts.length) return {ok:false,error:`Empty access rule${sourceLabel?` "${sourceLabel}"`:''}. Pass [] or leave the field blank to make the report public.`};
    for(const part of parts) {
      const value=part.trim().toLowerCase();
      if(value.length>254) return {ok:false,error:`Access rule is too long: ${part}`};
      if(value.startsWith('@')) {
        const domain=value.slice(1);
        if(!DOMAIN_RE.test(domain)) return {ok:false,error:`Invalid domain rule "${part}". Use @workspace.email.`};
      } else {
        const at=value.indexOf('@');
        if(at<=0 || at!==value.lastIndexOf('@')) return {ok:false,error:`Invalid access rule "${part}". Use @workspace.email for a domain or friend@email.com for an email.`};
        const local=value.slice(0,at), domain=value.slice(at+1);
        if(local.length>64 || !LOCAL_RE.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !DOMAIN_RE.test(domain)) {
          return {ok:false,error:`Invalid email rule "${part}". Use friend@email.com.`};
        }
      }
      if(!seen.has(value)) { seen.add(value); rules.push(value); }
      if(rules.length>MAX_RULES) return {ok:false,error:`At most ${MAX_RULES} access rules are allowed per report.`};
    }
    return {ok:true};
  };

  if(Array.isArray(input)) {
    if(!input.length) return {ok:true,rules:[]};
    for(const item of input) {
      if(typeof item!=='string') return {ok:false,error:'Each access rule must be a string.'};
      const parts=item.split(/[\s,;]+/).filter(Boolean);
      const added=addTokens(parts,item);
      if(!added.ok) return added;
    }
    return {ok:true,rules};
  }
  if(typeof input==='string') {
    if(!input.trim()) {
      if(allowEmptyString) return {ok:true,rules:[]};
      return {ok:false,error:'Empty access rule string. Pass [] to make the report public.'};
    }
    const parts=input.split(/[\s,;]+/).filter(Boolean);
    const added=addTokens(parts,input);
    if(!added.ok) return added;
    return {ok:true,rules};
  }
  return {ok:false,error:'Access rules must be an array or list of emails and @domains.'};
}

export function emailMatchesAccessRules(email, rules) {
  if(typeof email!=='string' || !Array.isArray(rules) || !rules.length) return false;
  const normalized=email.trim().toLowerCase();
  const at=normalized.indexOf('@');
  if(at<=0 || at!==normalized.lastIndexOf('@')) return false;
  const domain=normalized.slice(at);
  return rules.some(rule=>{
    if(typeof rule!=='string') return false;
    const target=rule.trim().toLowerCase();
    return target.startsWith('@') ? domain===target : normalized===target;
  });
}

export async function checkDraftAccess(draft, viewerAccountId) {
  const rules=Array.isArray(draft?.allowed_access) ? draft.allowed_access.filter(Boolean) : [];
  const owner=Boolean(viewerAccountId && draft?.account_id && draft.account_id===viewerAccountId);
  if(!rules.length) return {ok:true,restricted:false,owner};
  if(owner) return {ok:true,restricted:true,owner:true};
  if(!viewerAccountId) return {ok:false,status:401,restricted:true,owner:false,error:'Sign in to view this restricted report.'};
  const result=await pool.query(
    'SELECT email FROM identities WHERE account_id=$1 AND email IS NOT NULL AND email_verified IS TRUE',
    [viewerAccountId]
  );
  if(result.rows.some(row=>emailMatchesAccessRules(row.email,rules))) {
    return {ok:true,restricted:true,owner:false};
  }
  return {ok:false,status:403,restricted:true,owner:false,error:'Your account does not have access to this report.'};
}

export async function setDraftAccess(draftId, accountId, input, options={}) {
  const parsed=normalizeAccessRules(input,options);
  if(!parsed.ok) return {ok:false,status:422,error:parsed.error};
  const result=await pool.query(
    `UPDATE drafts SET allowed_access=$3,updated_at=now()
     WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL
     RETURNING id,allowed_access`,
    [draftId,accountId,parsed.rules]
  );
  if(!result.rowCount) return {ok:false,status:404,error:'Draft not found.'};
  const allowed=result.rows[0].allowed_access||[];
  return {ok:true,draftId:result.rows[0].id,restricted:allowed.length>0,allowed};
}

export async function getDraftAccessForOwner(draftId, accountId) {
  const result=await pool.query(
    'SELECT id,account_id,allowed_access FROM drafts WHERE id=$1 AND deleted_at IS NULL AND disabled_at IS NULL',
    [draftId]
  );
  const draft=result.rows[0];
  if(!draft) return {ok:false,status:404,error:'Draft not found.'};
  if(draft.account_id!==accountId) return {ok:false,status:403,error:'Only the report owner can view or edit access rules.'};
  const allowed=Array.isArray(draft.allowed_access)?draft.allowed_access:[];
  return {ok:true,draftId:draft.id,restricted:allowed.length>0,allowed};
}

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function renderRestrictedGate(req, res, {status, session, draftId, versionNumber, homeUrl, isDraftSubdomain=false}) {
  const defaultPath=`/d/${encodeURIComponent(draftId)}${versionNumber?`/v/${encodeURIComponent(String(versionNumber))}`:''}`;
  const query=req.query?.review==='1'?'?review=1':'';
  const nextPath=isDraftSubdomain
    ? `${defaultPath}${query}`
    : (typeof req.originalUrl==='string' && req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//') && !req.originalUrl.includes('\\')
      ? req.originalUrl
      : defaultPath);
  const originPrefix=isDraftSubdomain && homeUrl ? homeUrl.replace(/\/$/,'') : '';
  const signInHref=`${originPrefix}/auth/sign-in?next=${encodeURIComponent(nextPath)}`;
  const signOutAction=`${originPrefix}/auth/sign-out`;
  const formAction=originPrefix ? `'self' ${new URL(homeUrl).origin}` : "'self'";
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action ${formAction}`);
  if(status===401) {
    return res.status(401).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in required — Postplan</title><style>:root{color-scheme:dark}body{font:16px/1.6 system-ui,-apple-system,sans-serif;background:#141218;color:#e6e0e9;max-width:34rem;margin:14vh auto;padding:24px}h1{font-size:28px;margin:0 0 12px}p{color:#cac4d0;margin:0 0 20px}a.button{display:inline-block;padding:12px 24px;border-radius:24px;background:#d0bcff;color:#381e72;text-decoration:none;font-weight:600}</style></head><body><h1>Restricted report</h1><p>This report has restricted access. Sign in with an authorized account to view it.</p><a class="button" href="${escapeHtml(signInHref)}">Continue with Shoo</a></body></html>`);
  }
  const accountLabel=session?.email || session?.accountName || 'your current account';
  return res.status(403).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access denied — Postplan</title><style>:root{color-scheme:dark}body{font:16px/1.6 system-ui,-apple-system,sans-serif;background:#141218;color:#e6e0e9;max-width:34rem;margin:14vh auto;padding:24px}h1{font-size:28px;margin:0 0 12px}p{color:#cac4d0;margin:0 0 20px}.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}a.button,button{display:inline-block;padding:12px 22px;border-radius:24px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;border:0}a.button{background:#d0bcff;color:#381e72}button.secondary{background:#2b2930;color:#e6e0e9;border:1px solid #938f99}</style></head><body><h1>Access denied</h1><p>Signed in as <strong>${escapeHtml(accountLabel)}</strong>. This account does not have access to this report.</p><div class="actions"><a class="button" href="${escapeHtml(signInHref)}">Sign in with another account</a><form method="post" action="${escapeHtml(signOutAction)}"><button class="secondary" type="submit">Sign out</button></form></div></body></html>`);
}

export function createAccessWriteLimiter() {
  return createRateLimiter({
    windowMs:60_000,
    max:30,
    keyPrefix:'access-write',
    key:req=>req.auth?.account_id || readSession(req)?.accountId || 'anonymous'
  });
}

export function registerAccessRoutes(app, {writeLimit=createAccessWriteLimiter()}={}) {
  app.get('/api/drafts/:draftId/access',async(req,res,next)=>{
    try {
      const result=await getDraftAccessForOwner(req.params.draftId,req.auth.account_id);
      if(!result.ok) return res.status(result.status).json({ok:false,error:result.error});
      res.json(result);
    } catch(error) { next(error); }
  });
  app.put('/api/drafts/:draftId/access',writeLimit,async(req,res,next)=>{
    try {
      const result=await setDraftAccess(req.params.draftId,req.auth.account_id,req.body?.allowed);
      if(!result.ok) return res.status(result.status).json({ok:false,error:result.error});
      res.json(result);
    } catch(error) { next(error); }
  });
  const sameOriginJson=(req,res,next)=>{
    const apexOrigin=getConfiguredApexOrigin();
    if(!apexOrigin || req.get('origin')!==apexOrigin) return res.status(403).json({error:'Same-origin request required'});
    if(!req.is('application/json')) return res.status(415).json({error:'JSON required'});
    next();
  };
  app.get('/review-api/drafts/:draftId/access',async(req,res,next)=>{
    try {
      const session=readSession(req);
      if(!session) return res.status(401).json({error:'Sign in required'});
      const result=await getDraftAccessForOwner(req.params.draftId,session.accountId);
      if(!result.ok) return res.status(result.status).json({error:result.error});
      res.json({restricted:result.restricted,allowed:result.allowed});
    } catch(error) { next(error); }
  });
  app.put('/review-api/drafts/:draftId/access',sameOriginJson,writeLimit,express.json({limit:ACCESS_JSON_LIMIT}),async(req,res,next)=>{
    try {
      const session=readSession(req);
      if(!session) return res.status(401).json({error:'Sign in required'});
      const result=await setDraftAccess(req.params.draftId,session.accountId,req.body?.allowed,{allowEmptyString:true});
      if(!result.ok) return res.status(result.status).json({error:result.error});
      res.json({restricted:result.restricted,allowed:result.allowed});
    } catch(error) { next(error); }
  });
}
