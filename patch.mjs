import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
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
patch('src/ids.js', [
  ['import { customAlphabet }', 'import { randomUUID } from "node:crypto";\nimport { customAlphabet }'],
  ['const draftId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);\n', ''],
  ['return draftId();', 'return randomUUID();']
]);
patch('src/public-url.js', [['/^[a-z0-9]{12}$/', '/^(?:[a-z0-9]{12}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/']]);
patch('src/server.js', [['import { createApp }', 'import { initReviewDb } from "./review.js";\nimport { createApp }'], ['await initDb();', 'await initDb();\n  await initReviewDb();']]);
patch('bin/postplan.js', [['program.exitOverride();', 'registerReviewCommands(program, readAuth);\nprogram.exitOverride();']]);
// Keep the executable shebang first.
patch('bin/postplan.js', [['#!/usr/bin/env node', '#!/usr/bin/env node\nimport { registerReviewCommands } from "../src/review-cli.js";']]);
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
  ['import express from "express";', 'import express from "express";\nimport { registerReviewRoutes } from "./review.js";\nimport { renderStorageWrapper, withStorageBridge } from "./browser-storage.js";'],
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
    const wrapper = renderStorageWrapper(html, draft, '/d/' + draft.id + '/v/' + version.version_number, Number(version.version_number));
    res.setHeader("Content-Security-Policy", wrapper.csp);
    return res.type("html").send(wrapper.html);
  }`],
  ['"script-src \'none\'",', '"sandbox allow-scripts allow-popups allow-downloads",\n    "script-src \'unsafe-inline\' https:",'],
  ['"style-src \'unsafe-inline\'",', '"style-src \'unsafe-inline\' https:",\n    "font-src https: data:",'],
  ['// blocking script execution, cross-origin network requests, and form posts.\n// Uploaded drafts are already external-script/-form/-iframe free (see\n// validateHtml) and live on isolated per-draft origins.', '// allowing scripts in an opaque origin, without storage, API fetches or forms.'],
  ['process.env.UPLOAD_IP_RATE_LIMIT_MAX || 60', 'process.env.UPLOAD_IP_RATE_LIMIT_MAX || Infinity'],
  ['process.env.UPLOAD_RATE_LIMIT_MAX || 30', 'process.env.UPLOAD_RATE_LIMIT_MAX || Infinity']
]);
copyFileSync(new URL('./preview.js', import.meta.url), new URL('src/preview.js', root));
copyFileSync(new URL('./browser-storage.js', import.meta.url), new URL('src/browser-storage.js', root));
for (const file of ['review.js', 'review-ui.js', 'review-cli.js']) copyFileSync(new URL('./'+file, import.meta.url), new URL('src/'+file, root));
console.log(`Patched Postplan ${pkg.version} in ${fileURLToPath(root)}`);
