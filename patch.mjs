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
  ['import express from "express";', 'import express from "express";\nimport { withPreviewMetadata } from "./preview.js";'],
  ['app.use("/api", express.json({ limit: process.env.UPLOAD_BODY_LIMIT || "2mb" }));', 'app.use("/api", requireAuth, express.json({ limit: Number(process.env.UPLOAD_BODY_LIMIT || Infinity) }));'],
  ['"/api/uploads", uploadIpRateLimit, optionalUploadAuth, uploadKeyRateLimit', '"/api/uploads", uploadIpRateLimit, uploadKeyRateLimit'],
  ['async function optionalUploadAuth(req, _res, next) {\n  req.auth = (await optionalAuth(req)) || publicUploadAuth;\n  next();\n}\n\n', ''],
  ['res.type("html").send(html);', 'res.type("html").send(req.path.endsWith("/raw") || req.path === "/raw" ? html : withPreviewMetadata(html, draft));'],
  ['"script-src \'none\'",', '"sandbox allow-scripts allow-popups",\n    "script-src \'unsafe-inline\' https:",'],
  ['"style-src \'unsafe-inline\'",', '"style-src \'unsafe-inline\' https:",\n    "font-src https: data:",'],
  ['// blocking script execution, cross-origin network requests, and form posts.\n// Uploaded drafts are already external-script/-form/-iframe free (see\n// validateHtml) and live on isolated per-draft origins.', '// allowing scripts in an opaque origin, without storage, API fetches or forms.'],
  ['process.env.UPLOAD_IP_RATE_LIMIT_MAX || 60', 'process.env.UPLOAD_IP_RATE_LIMIT_MAX || Infinity'],
  ['process.env.UPLOAD_RATE_LIMIT_MAX || 30', 'process.env.UPLOAD_RATE_LIMIT_MAX || Infinity']
]);
copyFileSync(new URL('./preview.js', import.meta.url), new URL('src/preview.js', root));
console.log(`Patched Postplan ${pkg.version} in ${fileURLToPath(root)}`);
