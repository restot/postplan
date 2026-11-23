import { readFileSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('./node_modules/postplan/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root)));
if (pkg.version !== '0.0.4') throw new Error('Patch requires Postplan 0.0.4');
function patch(file, replacements) {
  const path = new URL(file, root);
  let source = readFileSync(path, 'utf8');
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error(`Upstream contract changed: ${file}: ${before}`);
    source = source.replace(before, after);
  }
  writeFileSync(path, source);
}

patch('src/config.js', [['Number(process.env.MAX_HTML_BYTES || 512 * 1024)', 'Number(process.env.MAX_HTML_BYTES || Infinity)']]);
patch('src/storage.js', [
  ['getHtmlObject(key)', 'getHtmlObject(key, maxBytes = Infinity)'],
  ['streamToString(result.Body)', 'streamToString(result.Body, maxBytes)'],
  ['streamToString(stream)', 'streamToString(stream, maxBytes)'],
  ['  const chunks = [];', '  const chunks = [];\n  let bytes = 0;'],
  ['    chunks.push(Buffer.from(chunk));', '    const part = Buffer.from(chunk).subarray(0, maxBytes - bytes);\n    chunks.push(part);\n    bytes += part.length;\n    if (bytes >= maxBytes) break;']
]);
patch('src/ids.js', [
  ['import { customAlphabet }', 'import { randomUUID } from "node:crypto";\nimport { customAlphabet }'],
  ['const draftId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);\n', ''],
  ['return draftId();', 'return randomUUID();']
]);
patch('src/public-url.js', [['/^[a-z0-9]{12}$/', '/^(?:[a-z0-9]{12}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/']]);
patch('src/server.js', [['import { createApp }', 'import { initReviewDb } from "./review.js";\nimport { createApp }'], ['await initDb();', 'await initDb();\n  await initReviewDb();']]);
patch('bin/postplan.js', [['program.exitOverride();', `registerReviewCommands(program, readAuth, (draftId) => {
  const drafts = readDrafts();
  for (const [file, draft] of Object.entries(drafts.files || {})) {
    if (draft.draftId === draftId) delete drafts.files[file];
  }
  writeJson(DRAFTS_PATH, drafts, 0o600);
});
program.exitOverride();`]]);
// Keep the executable shebang first.
patch('bin/postplan.js', [
  ['#!/usr/bin/env node', '#!/usr/bin/env node\nimport { collectAccessOption, registerReviewCommands } from "../src/review-cli.js";'],
  ['.option("--description <text>", "Set a short description for the draft")', '.option("--description <text>", "Set a short description for the draft")\n  .option("--allow <rule>", "Restrict access to an email (friend@email.com) or domain (@workspace.email); repeatable", collectAccessOption, [])\n  .option("--public", "Remove access restrictions and make the draft public")'],
  ['    const payload = {\n      html,\n      filename: path.basename(resolvedFile),\n      draftId,\n      description: options.description,', `    if (options.public && options.allow.length) {
      throw new CliError("Use either --allow or --public, not both.");
    }

    const payload = {
      html,
      filename: path.basename(resolvedFile),
      draftId,
      description: options.description,
      ...(options.public ? { access: [] } : options.allow.length ? { access: options.allow } : {}),`],
  ['    const response = await fetch(`${apiUrl}/api/uploads`, {\n      method: "POST",\n      headers,\n      body: JSON.stringify(payload)\n    });\n\n    const body = await response.json();\n    if (!response.ok) {\n      const details = body.errors?.length ? `\\n- ${body.errors.join("\\n- ")}` : "";\n      throw new CliError(`${body.error || "Upload failed."}${details}`);\n    }', `    const explicitAccess = Boolean(options.public || options.allow.length);
    const uploadEndpoint = explicitAccess ? \`\${apiUrl}/api/uploads/with-access\` : \`\${apiUrl}/api/uploads\`;
    const response = await fetch(uploadEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (explicitAccess && response.status === 404) {
        throw new CliError("This Postplan server does not support access restrictions. Nothing was uploaded.");
      }
      const details = body.errors?.length ? \`\\n- \${body.errors.join("\\n- ")}\` : "";
      throw new CliError(\`\${body.error || \`Upload failed (\${response.status}).\`}\${details}\`);
    }
    if (options.allow.length && (!body.access?.restricted || !Array.isArray(body.access.allowed) || !body.access.allowed.length)) {
      throw new CliError("Server did not confirm access restrictions.");
    }
    if (options.public && body.access?.restricted !== false) {
      throw new CliError("Server did not confirm public access.");
    }`],
  ['    console.log(`Version: ${body.versionNumber}`);', `    console.log(\`Version: \${body.versionNumber}\`);
    if (body.access?.restricted) {
      console.log(\`Access: restricted (\${body.access.allowed.join(", ")})\`);
    }`],
  ['const disabled = draft.disabled ? " · disabled" : "";', 'const disabled = draft.disabled ? " · disabled" : "";\n      const restricted = draft.restricted ? ` · restricted (${(draft.allowedAccess || []).join(", ")})` : "";'],
  ['      console.log(`  ${repo} · ${version} · ${count} · updated ${timeAgo(draft.updatedAt)}${disabled}`);', '      console.log(`  ${repo} · ${version} · ${count} · updated ${timeAgo(draft.updatedAt)}${disabled}${restricted}`);']
]);
patch('bin/postplan.js', [['const POSTPLAN_DIR = path.join(os.homedir(), ".postplan");', 'const POSTPLAN_DIR = process.env.POSTPLAN_CONFIG_DIR || path.join(os.homedir(), ".postplan");']]);
patch('src/html-policy.js', [
  ['"base",\n  "link"', '"base"'],
  ['new Set(["", "text/javascript", "application/javascript"])', 'new Set(["", "text/javascript", "application/javascript", "module", "importmap", "application/ld+json", "application/json"])'],
  ['options.maxBytes ?? 512 * 1024', 'options.maxBytes ?? Infinity'],
  ['        if (attributes.has("src")) {\n          errors.push("External script sources are not allowed.");\n        }\n', ''],
  ['        if (name.startsWith("on")) {\n          errors.push(`Blocked inline event handler attribute "${name}" found.`);\n        }\n', '']
]);
patch('src/api.js', [
  ['pool, publicUploadAuth, withTransaction', 'pool, withTransaction'],
  ['import express from "express";', 'import express from "express";\nimport { getPreviewImage } from "./preview.js";\nimport { registerReviewRoutes } from "./review.js";\nimport { renderStorageWrapper, withStorageBridge } from "./browser-storage.js";'],
  ['registerWebRoutes(app);', 'registerReviewRoutes(app);\n  registerWebRoutes(app);'],
  ['app.use("/api", express.json({ limit: process.env.UPLOAD_BODY_LIMIT || "2mb" }));', 'app.use("/api", requireAuth, express.json({ limit: Number(process.env.UPLOAD_BODY_LIMIT || Infinity) }));'],
  ['"/api/uploads", uploadIpRateLimit, optionalUploadAuth, uploadKeyRateLimit', '"/api/uploads", uploadIpRateLimit, uploadKeyRateLimit'],
  ['async function optionalUploadAuth(req, _res, next) {\n  req.auth = (await optionalAuth(req)) || publicUploadAuth;\n  next();\n}\n\n', ''],
  ['res.type("html").send(html);', `if (req.path.endsWith("/raw") || req.path === "/raw") return res.type("html").send(html);
  {
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.query["postplan-frame"] === "1") {
      return res.type("html").send(withStorageBridge(html, draft.id));
    }
    const versionPath = '/d/' + draft.id + '/v/' + version.version_number;
    const apexReviewUrl = getDraftIdFromRequest(req) ? getHomeUrlForRequest(req) + versionPath + '?review=1' : null;
    const wrapper = renderStorageWrapper(html, draft, versionPath, Number(version.version_number), getHomeUrlForRequest(req) + versionPath + '/preview.png?theme=1', apexReviewUrl);
    res.setHeader("Content-Security-Policy", wrapper.csp);
    return res.type("html").send(wrapper.html);
  }`],
  ['"script-src \'none\'",', '"sandbox allow-scripts allow-popups allow-downloads",\n    "script-src \'unsafe-inline\' https:",'],
  ['"style-src \'unsafe-inline\'",', '"style-src \'unsafe-inline\' https:",\n    "font-src https: data:",'],
  ['// blocking script execution, cross-origin network requests, and form posts.\n// Uploaded drafts are already external-script/-form/-iframe free (see\n// validateHtml) and live on isolated per-draft origins.', '// allowing scripts in an opaque origin, without storage, API fetches or forms.'],
  ['process.env.UPLOAD_IP_RATE_LIMIT_MAX || 60', 'process.env.UPLOAD_IP_RATE_LIMIT_MAX || Infinity'],
  ['process.env.UPLOAD_RATE_LIMIT_MAX || 30', 'process.env.UPLOAD_RATE_LIMIT_MAX || Infinity'],
  ['registerReviewRoutes(app);', `app.get(['/d/:draftId/preview.png', '/d/:draftId/v/:versionNumber/preview.png'], async (req, res) => {
    const versionNumber = req.params.versionNumber === undefined ? undefined : Number(req.params.versionNumber);
    if (versionNumber !== undefined && (!Number.isInteger(versionNumber) || versionNumber < 1 || versionNumber > 2147483647)) return res.sendStatus(404);
    const result = await findPublicDraftVersion(req.params.draftId, versionNumber);
    if (!result.draft || !result.version) return res.sendStatus(404);
    // Check public access before every cache lookup, including old versions.
    const png = await getPreviewImage(result.draft, result.version, getHtmlObject);
    res.setHeader('Cache-Control', 'no-store');
    return res.type('png').send(png);
  });
  registerReviewRoutes(app);`]
]);
patch('src/server.js', [
  ['import { initReviewDb }', 'import { initAccessDb } from "./access.js";\nimport { initMcpDb } from "./mcp-auth.js";\nimport { initReviewDb }'],
  ['await initReviewDb();', 'await initReviewDb();\n  await initAccessDb();\n  await initMcpDb();']
]);
patch('src/api.js', [
  ['import express from "express";', 'import express from "express";\nimport { ACCESS_JSON_LIMIT, checkDraftAccess, createAccessWriteLimiter, normalizeAccessRules, registerAccessRoutes, renderRestrictedGate } from "./access.js";\nimport { readSession } from "./web-auth.js";\nimport { registerMcpRoutes } from "./mcp.js";'],
  ['app.use("/api", requireAuth, express.json({ limit: Number(process.env.UPLOAD_BODY_LIMIT || Infinity) }));', 'const accessWriteLimit = createAccessWriteLimiter();\n  app.put("/api/drafts/:draftId/access", requireAuth, express.json({ limit: ACCESS_JSON_LIMIT }));\n  app.use("/api", requireAuth, express.json({ limit: Number(process.env.UPLOAD_BODY_LIMIT || Infinity) }));'],
  ['app.post("/api/uploads", uploadIpRateLimit, uploadKeyRateLimit, async (req, res, next) => {', 'const uploadReport = async (req, res, next) => {'],
  ['      const { html, filename, metadata = {}, draftId, description } = req.body || {};', `      const { html, filename, metadata = {}, draftId, description, access } = req.body || {};
      let accessRules;
      if (access !== undefined) {
        const parsedAccess = normalizeAccessRules(access);
        if (!parsedAccess.ok) {
          return res.status(422).json({ ok: false, error: parsedAccess.error, errors: [parsedAccess.error] });
        }
        accessRules = parsedAccess.rules;
      }`],
  [`          await client.query(
            \`
              INSERT INTO drafts (id, account_id, title, description, repo_org, repo_name, repo_host)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
            \`,
            [
              draft.id,
              req.auth.account_id,
              title,
              cleanText(description, 1000),
              cleanText(metadata.repoOrg),
              cleanText(metadata.repoName),
              cleanText(metadata.repoHost)
            ]
          );`, `          await client.query(
            \`
              INSERT INTO drafts (id, account_id, title, description, repo_org, repo_name, repo_host, allowed_access)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            \`,
            [
              draft.id,
              req.auth.account_id,
              title,
              cleanText(description, 1000),
              cleanText(metadata.repoOrg),
              cleanText(metadata.repoName),
              cleanText(metadata.repoHost),
              accessRules ?? []
            ]
          );`],
  [`        await client.query(
          \`
            UPDATE drafts
            SET current_version_id = $1,
                title = $2,
                description = COALESCE($3, description),
                repo_org = COALESCE($4, repo_org),
                repo_name = COALESCE($5, repo_name),
                repo_host = COALESCE($6, repo_host),
                updated_at = now()
            WHERE id = $7
          \`,
          [
            versionId,
            title,
            cleanText(description, 1000),
            cleanText(metadata.repoOrg),
            cleanText(metadata.repoName),
            cleanText(metadata.repoHost),
            draft.id
          ]
        );`, `        const updatedDraft = await client.query(
          \`
            UPDATE drafts
            SET current_version_id = $1,
                title = $2,
                description = COALESCE($3, description),
                repo_org = COALESCE($4, repo_org),
                repo_name = COALESCE($5, repo_name),
                repo_host = COALESCE($6, repo_host),
                allowed_access = COALESCE($7, allowed_access),
                updated_at = now()
            WHERE id = $8
            RETURNING allowed_access
          \`,
          [
            versionId,
            title,
            cleanText(description, 1000),
            cleanText(metadata.repoOrg),
            cleanText(metadata.repoName),
            cleanText(metadata.repoHost),
            accessRules ?? null,
            draft.id
          ]
        );
        const effectiveAccess = Array.isArray(updatedDraft.rows?.[0]?.allowed_access)
          ? updatedDraft.rows[0].allowed_access
          : (accessRules ?? []);
        const restricted = effectiveAccess.length > 0;
        const apexBase = getHomeUrlForRequest(req);`],
  [`          publicUrl: getDraftPublicUrl({
            draftId: draft.id,
            publicBaseUrl: config.publicBaseUrl,
            requestBaseUrl: getRequestBaseUrl(req)
          }),
          rawUrl: getDraftRawUrl({
            draftId: draft.id,
            publicBaseUrl: config.publicBaseUrl,
            requestBaseUrl: getRequestBaseUrl(req)
          }),
          warnings: validation.warnings`, `          publicUrl: restricted
            ? \`\${apexBase}/d/\${draft.id}\`
            : getDraftPublicUrl({
                draftId: draft.id,
                publicBaseUrl: config.publicBaseUrl,
                requestBaseUrl: getRequestBaseUrl(req)
              }),
          rawUrl: restricted
            ? \`\${apexBase}/d/\${draft.id}/raw\`
            : getDraftRawUrl({
                draftId: draft.id,
                publicBaseUrl: config.publicBaseUrl,
                requestBaseUrl: getRequestBaseUrl(req)
              }),
          access: {
            restricted,
            allowed: effectiveAccess
          },
          warnings: validation.warnings`],
  ['  });\n\n  app.delete("/api/drafts/:draftId",', `  };
  const requireExplicitAccess = (req, res, next) => {
    if (req.body?.access === undefined) {
      const error = "The access field is required on /api/uploads/with-access. Pass [] to make the report public.";
      return res.status(422).json({ ok: false, error, errors: [error] });
    }
    next();
  };
  app.post("/api/uploads", uploadIpRateLimit, uploadKeyRateLimit, uploadReport);
  app.post("/api/uploads/with-access", uploadIpRateLimit, uploadKeyRateLimit, requireExplicitAccess, uploadReport);

  app.delete("/api/drafts/:draftId",`],
  [`    const result = await findPublicDraftVersion(req.params.draftId, versionNumber);
    if (!result.draft || !result.version) return res.sendStatus(404);
    // Check public access before every cache lookup, including old versions.`, `    const result = await findPublicDraftVersion(req.params.draftId, versionNumber);
    if (!result.draft) return res.sendStatus(404);
    // Check access before version existence or cache lookup, preventing version-existence oracles and stale policy races.
    const access = await checkDraftAccess(result.draft, readSession(req)?.accountId || null);
    if (!access.ok) {
      res.setHeader('Cache-Control', 'no-store');
      return res.sendStatus(access.status);
    }
    if (!result.version) return res.sendStatus(404);`],
  ['  registerReviewRoutes(app);', '  registerAccessRoutes(app, { writeLimit: accessWriteLimit });\n  const { listComments } = registerReviewRoutes(app);\n  registerMcpRoutes(app, { uploadReport, listComments });'],
  ['  registerWebRoutes(app);', '  registerWebRoutes(app, { accessWriteLimit });'],
  [`  const { draft, version } = await findPublicDraftVersion(draftId, versionNumber);
  if (!draft || !version) {
    return res.status(404).type("html").send(renderNotFound());
  }

  const html = await getHtmlObject(version.object_key);`, `  const { draft, version } = await findPublicDraftVersion(draftId, versionNumber);
  if (!draft) {
    return res.status(404).type("html").send(renderNotFound());
  }

  const isRaw = req.path.endsWith("/raw") || req.path === "/raw";
  const isFrame = req.query["postplan-frame"] === "1";
  const isSubdomain = Boolean(getDraftIdFromRequest(req));
  if (isSubdomain && !isRaw && !isFrame && ((Array.isArray(draft.allowed_access) && draft.allowed_access.length > 0) || req.query?.review === "1")) {
    const versionSuffix = versionNumber ? \`/v/\${encodeURIComponent(String(versionNumber))}\` : "";
    const reviewQuery = req.query?.review === "1" ? "?review=1" : "";
    return res.redirect(302, \`\${getHomeUrlForRequest(req)}/d/\${encodeURIComponent(draft.id)}\${versionSuffix}\${reviewQuery}\`);
  }

  let session = null;
  let viewerAccountId = null;
  if (isRaw && /^Bearer\\s+/i.test(req.get("authorization") || "")) {
    const apiAuth = await optionalAuth(req);
    viewerAccountId = apiAuth?.account_id || null;
  } else {
    session = readSession(req);
    viewerAccountId = session?.accountId || null;
  }
  const access = await checkDraftAccess(draft, viewerAccountId);
  if (!access.ok) {
    if (isRaw || isFrame) {
      return res.status(access.status).type("text/plain").send(access.error);
    }
    return renderRestrictedGate(req, res, {
      status: access.status,
      session,
      draftId: draft.id,
      versionNumber,
      homeUrl: getHomeUrlForRequest(req),
      isDraftSubdomain: isSubdomain
    });
  }

  if (!version) {
    return res.status(404).type("html").send(renderNotFound());
  }

  const html = await getHtmlObject(version.object_key);`],
  [`async function findPublicDraftVersion(draftId, versionNumber) {
  const draftResult = await pool.query(
    \`
      SELECT *
      FROM drafts
      WHERE id = $1
        AND deleted_at IS NULL
        AND disabled_at IS NULL
      LIMIT 1
    \`,
    [draftId]
  );

  const draft = draftResult.rows[0] || null;
  if (!draft) return { draft: null, version: null };

  const versionResult = versionNumber
    ? await pool.query(
        \`
          SELECT *
          FROM draft_versions
          WHERE draft_id = $1 AND version_number = $2
          LIMIT 1
        \`,
        [draft.id, versionNumber]
      )
    : await pool.query("SELECT * FROM draft_versions WHERE id = $1 LIMIT 1", [
        draft.current_version_id
      ]);

  return { draft, version: versionResult.rows[0] || null };
}`, `async function findPublicDraftVersion(draftId, versionNumber) {
  // Read the active draft policy and requested version in one PostgreSQL snapshot
  // so a concurrent version upload that adds restrictions cannot be paired with an older public policy.
  const result = await pool.query(
    \`
      SELECT
        d.id,
        d.account_id,
        d.title,
        d.description,
        d.current_version_id,
        d.allowed_access,
        v.id AS version_id,
        v.version_number,
        v.object_key,
        v.content_hash
      FROM drafts d
      LEFT JOIN draft_versions v
        ON v.draft_id = d.id
       AND (($2::integer IS NULL AND v.id = d.current_version_id) OR v.version_number = $2)
      WHERE d.id = $1
        AND d.deleted_at IS NULL
        AND d.disabled_at IS NULL
      LIMIT 1
    \`,
    [draftId, versionNumber ?? null]
  );
  const row = result.rows[0] || null;
  if (!row) return { draft: null, version: null };
  const draft = {
    id: row.id,
    account_id: row.account_id,
    title: row.title,
    description: row.description,
    current_version_id: row.current_version_id,
    allowed_access: row.allowed_access
  };
  const version =
    row.version_number !== null && row.version_number !== undefined
      ? {
          id: row.version_id,
          version_number: row.version_number,
          object_key: row.object_key,
          content_hash: row.content_hash
        }
      : null;
  return { draft, version };
}`]
]);
patch('src/drafts.js', [
  ['import { getDraftPublicUrl, getDraftRawUrl } from "./public-url.js";', 'import { getDraftPublicUrl, getDraftRawUrl, getHomeUrl } from "./public-url.js";'],
  ['        d.disabled_at,', '        d.disabled_at,\n        d.allowed_access,'],
  [`    disabled: Boolean(row.disabled_at),
    publicUrl: getDraftPublicUrl({
      draftId: row.id,
      publicBaseUrl: config.publicBaseUrl,
      requestBaseUrl
    }),
    rawUrl: getDraftRawUrl({
      draftId: row.id,
      publicBaseUrl: config.publicBaseUrl,
      requestBaseUrl
    })`, `    disabled: Boolean(row.disabled_at),
    allowedAccess: Array.isArray(row.allowed_access) ? row.allowed_access : [],
    restricted: Boolean(row.allowed_access?.length),
    publicUrl: row.allowed_access?.length
      ? \`\${getHomeUrl({ publicBaseUrl: config.publicBaseUrl, requestBaseUrl })}/d/\${row.id}\`
      : getDraftPublicUrl({
          draftId: row.id,
          publicBaseUrl: config.publicBaseUrl,
          requestBaseUrl
        }),
    rawUrl: row.allowed_access?.length
      ? \`\${getHomeUrl({ publicBaseUrl: config.publicBaseUrl, requestBaseUrl })}/d/\${row.id}/raw\`
      : getDraftRawUrl({
          draftId: row.id,
          publicBaseUrl: config.publicBaseUrl,
          requestBaseUrl
        })`],
  [`      description: draft.description,
      publicUrl: getDraftPublicUrl({
        draftId: draft.id,
        publicBaseUrl: config.publicBaseUrl,
        requestBaseUrl
      })`, `      description: draft.description,
      allowedAccess: Array.isArray(draft.allowed_access) ? draft.allowed_access : [],
      restricted: Boolean(draft.allowed_access?.length),
      publicUrl: draft.allowed_access?.length
        ? \`\${getHomeUrl({ publicBaseUrl: config.publicBaseUrl, requestBaseUrl })}/d/\${draft.id}\`
        : getDraftPublicUrl({
            draftId: draft.id,
            publicBaseUrl: config.publicBaseUrl,
            requestBaseUrl
          })`]
]);
patch('src/web.js', [
  ['import { config } from "./config.js";', 'import express from "express";\nimport { config } from "./config.js";\nimport { ACCESS_FORM_LIMIT, createAccessWriteLimiter, setDraftAccess } from "./access.js";'],
  ['export function registerWebRoutes(app) {', 'export function registerWebRoutes(app, { accessWriteLimit = createAccessWriteLimiter() } = {}) {'],
  [`      res.type("html").send(
        renderDraftDetail({
          session,
          draft: result.draft,
          versions: result.versions
        })
      );`, `      res.setHeader("Referrer-Policy", "same-origin");
      res.type("html").send(
        renderDraftDetail({
          session,
          draft: result.draft,
          versions: result.versions,
          accessSaved: req.query.saved === "1"
        })
      );`],
  [`  app.get("/cli/auth",`, `  app.post("/dashboard/drafts/:draftId/access", ...web, accessWriteLimit, express.urlencoded({ extended: false, limit: ACCESS_FORM_LIMIT }), async (req, res, next) => {
    try {
      const session = readSession(req);
      if (!session) {
        return res.type("html").send(renderSignIn({ next: \`/dashboard/drafts/\${encodeURIComponent(req.params.draftId)}\` }));
      }
      if (req.get("origin") !== webOrigin()) {
        return res.status(403).type("html").send(renderAuthError({ message: "Same-origin form submission required." }));
      }
      if (!req.is("application/x-www-form-urlencoded")) {
        return res.status(415).type("html").send(renderAuthError({ message: "Form submission required." }));
      }
      if (typeof req.body?.allowed !== "string") {
        const result = await getAccountDraftWithVersions(session.accountId, req.params.draftId, {
          requestBaseUrl: getRequestBaseUrl(req)
        });
        if (!result) return next();
        res.setHeader("Referrer-Policy", "same-origin");
        return res.status(422).type("html").send(
          renderDraftDetail({
            session,
            draft: result.draft,
            versions: result.versions,
            accessError: "Missing access field."
          })
        );
      }
      const updated = await setDraftAccess(req.params.draftId, session.accountId, req.body.allowed, { allowEmptyString: true });
      if (updated.ok) {
        return res.redirect(303, \`/dashboard/drafts/\${encodeURIComponent(req.params.draftId)}?saved=1\`);
      }
      if (updated.status === 404) return next();
      const result = await getAccountDraftWithVersions(session.accountId, req.params.draftId, {
        requestBaseUrl: getRequestBaseUrl(req)
      });
      if (!result) return next();
      res.setHeader("Referrer-Policy", "same-origin");
      return res.status(updated.status).type("html").send(
        renderDraftDetail({
          session,
          draft: result.draft,
          versions: result.versions,
          accessError: updated.error,
          accessInput: req.body.allowed
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/cli/auth",`]
]);
patch('src/render-web.js', [
  ['export function renderDraftDetail({ session, draft, versions }) {', 'export function renderDraftDetail({ session, draft, versions, accessSaved = false, accessError = null, accessInput = null }) {\n  const allowedList = Array.isArray(draft.allowedAccess) ? draft.allowedAccess : [];\n  const accessText = accessInput !== null ? accessInput : allowedList.join("\\n");'],
  [`        <table>
          <tr><th>Version</th><th>Commit</th><th>Ref</th><th>Published</th></tr>
          \${rows}
        </table>`, `        <section style="margin:24px 0;padding:16px;background:#fff;border:1px solid #e5e7eb;border-radius:10px">
          <h2 style="margin-top:0">Access control \${draft.restricted ? '<span class="pill">restricted</span>' : '<span class="pill">public</span>'}</h2>
          <p class="muted small">Leave blank so anyone with the link can view this report, or restrict access to verified emails (<code>my-friend@email.com</code>) and domains (<code>@workspace.email</code>). You always retain access as owner.</p>
          <form method="post" action="/dashboard/drafts/\${escapeHtml(draft.draftId)}/access">
            <textarea name="allowed" rows="3" placeholder="@workspace.email&#10;my-friend@email.com" style="display:block;width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:14px ui-monospace,SFMono-Regular,monospace;margin:10px 0">\${escapeHtml(accessText)}</textarea>
            <button class="button" type="submit">Save access</button>
            \${accessSaved ? '<span class="small muted" style="margin-left:10px">Saved.</span>' : ''}
            \${accessError ? \`<p class="small" style="color:#b91c1c;margin-bottom:0">\${escapeHtml(accessError)}</p>\` : ''}
          </form>
        </section>
        <table>
          <tr><th>Version</th><th>Commit</th><th>Ref</th><th>Published</th></tr>
          \${rows}
        </table>`],
  ['.pill { font-size: 11px; border-radius: 999px; padding: 2px 8px; margin-left: 6px; }', '.pill { font-size: 11px; border-radius: 999px; padding: 2px 8px; margin-left: 6px; background: #e5e7eb; color: #374151; }'],
  ['${draft.disabled ? \'<span class="pill warn">disabled</span>\' : ""}', '${draft.disabled ? \'<span class="pill warn">disabled</span>\' : ""}${draft.restricted ? \'<span class="pill">restricted</span>\' : ""}']
]);
copyFileSync(new URL('./skills/post-report/MCP.md', import.meta.url), new URL('src/post-report-mcp.md', root));
for (const file of ['mcp.js', 'mcp-auth.js', 'access.js']) copyFileSync(new URL('./'+file, import.meta.url), new URL('src/'+file, root));
copyFileSync(new URL('./preview.js', import.meta.url), new URL('src/preview.js', root));
cpSync(new URL('./fonts/', import.meta.url), new URL('src/fonts/', root), {recursive:true});
copyFileSync(new URL('./browser-storage.js', import.meta.url), new URL('src/browser-storage.js', root));
for (const file of ['review.js', 'review-ui.js', 'review-cli.js']) copyFileSync(new URL('./'+file, import.meta.url), new URL('src/'+file, root));
console.log(`Patched Postplan ${pkg.version} in ${fileURLToPath(root)}`);
