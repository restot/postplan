import {randomUUID} from 'node:crypto';
import express from 'express';
import {pool} from './db.js';
import {config} from './config.js';
import {readSession} from './web-auth.js';
import {createRateLimiter} from './rate-limit.js';

export async function initReviewDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS review_comments (
    id UUID PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    version_id TEXT NOT NULL REFERENCES draft_versions(id),
    author_id TEXT NOT NULL REFERENCES accounts(id),
    author_name TEXT NOT NULL,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
    anchor JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS review_comments_draft_order ON review_comments(draft_id, created_at, id)`);
}

function validAnchor(anchor) {
  return anchor && ['text','element'].includes(anchor.type)
    && typeof anchor.quote==='string' && anchor.quote.trim().length>0 && anchor.quote.length<=2000
    && typeof anchor.selector==='string' && anchor.selector.length>0 && anchor.selector.length<=1000
    && ['prefix','suffix'].every(key=>typeof anchor[key]==='string' && anchor[key].length<=200);
}

export function registerReviewRoutes(app) {
  // Draft versions are public. Exclude owner-only metadata from this list.
  app.get('/review-api/drafts/:draftId/versions',async(req,res,next)=>{
    try {
      const result=await pool.query(`SELECT v.version_number AS version,v.created_at,v.id=d.current_version_id AS current
        FROM draft_versions v JOIN drafts d ON d.id=v.draft_id
        WHERE d.id=$1 AND d.deleted_at IS NULL AND d.disabled_at IS NULL
        ORDER BY v.version_number DESC`,[req.params.draftId]);
      if(!result.rows.length) return res.status(404).json({error:'Draft not found'});
      res.json(result.rows);
    } catch(error) { next(error); }
  });
  const signedIn=(req,res,next)=>{
    req.reviewer=readSession(req);
    if(!req.reviewer) return res.status(401).json({error:'Sign in to read or add comments'});
    next();
  };
  app.use('/review-api',signedIn);
  app.get('/review-api/session',(req,res)=>res.json({name:req.reviewer.accountName||'Reviewer'}));
  const limit=createRateLimiter({windowMs:60_000,max:30,keyPrefix:'review',key:req=>req.reviewer.accountId});
  async function list(req,res,next) {
    try {
      const offset=String(req.query.offset??'0');
      if(!/^\d{1,7}$/.test(offset)) return res.status(422).json({error:'Invalid offset'});
      const owner=req.auth?.account_id;
      const draft=await pool.query(`SELECT id FROM drafts WHERE id=$1 AND deleted_at IS NULL AND disabled_at IS NULL${owner?' AND account_id=$2':''}`,owner?[req.params.draftId,owner]:[req.params.draftId]);
      if(!draft.rows.length) return res.status(404).json({error:'Draft not found'});
      const result=await pool.query(`SELECT c.id,c.author_id,c.author_name,c.body,c.anchor,c.created_at,v.version_number AS version
        FROM review_comments c JOIN draft_versions v ON v.id=c.version_id
        WHERE c.draft_id=$1 ORDER BY c.created_at,c.id LIMIT 100 OFFSET $2`,[req.params.draftId,Number(offset)]);
      res.json(result.rows);
    } catch(error) { next(error); }
  }
  app.get('/review-api/drafts/:draftId/comments',list);
  // /api already requires a bearer key. Unlike browser collaboration, CLI access is owner-only.
  app.get('/api/drafts/:draftId/comments',list);
  app.post('/review-api/drafts/:draftId/comments',(req,res,next)=>{
    if(!config.publicBaseUrl || req.get('origin')!==new URL(config.publicBaseUrl).origin) return res.status(403).json({error:'Same-origin request required'});
    if(!req.is('application/json')) return res.status(415).json({error:'JSON required'});
    next();
  },limit,express.json({limit:'32kb'}),async(req,res,next)=>{
    try {
      const {body,anchor,version}=req.body||{};
      if(typeof body!=='string' || !body.trim() || body.length>4000 || !Number.isSafeInteger(version) || version<1 || !validAnchor(anchor)) return res.status(422).json({error:'A comment, anchor and positive draft version are required'});
      const clean={type:anchor.type,quote:anchor.quote,selector:anchor.selector,prefix:anchor.prefix,suffix:anchor.suffix};
      const result=await pool.query(`INSERT INTO review_comments (id,draft_id,version_id,author_id,author_name,body,anchor)
        SELECT $7,d.id,v.id,$3,$4,$5,$6::jsonb FROM drafts d JOIN draft_versions v ON v.draft_id=d.id
        WHERE d.id=$1 AND v.version_number=$2 AND d.deleted_at IS NULL AND d.disabled_at IS NULL
        RETURNING id,author_id,author_name,body,anchor,created_at`,
        [req.params.draftId,version,req.reviewer.accountId,req.reviewer.accountName||'Reviewer',body.trim(),JSON.stringify(clean),randomUUID()]);
      if(!result.rows.length) return res.status(404).json({error:'Draft version not found'});
      res.status(201).json({...result.rows[0],version});
    } catch(error) { next(error); }
  });
}
