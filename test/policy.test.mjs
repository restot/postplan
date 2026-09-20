import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateHtml } from '../node_modules/postplan/src/html-policy.js';
import { config } from '../node_modules/postplan/src/config.js';

test('server and CLI default to no application HTML size cap', () => {
  assert.equal(config.maxHtmlBytes, Infinity);
  const result = validateHtml('<title>Large draft</title>' + 'x'.repeat(3 * 1024 * 1024));
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('accepts inline, module, external scripts and event handlers', () => {
  const result = validateHtml(`<title>Interactive</title>
    <link rel="stylesheet" href="https://example.com/style.css">
    <script>globalThis.ready = true</script>
    <script type="module" src="https://example.com/module.js"></script>
    <button onclick="this.textContent='Done'">Run</button>`);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('retains restrictions on frames, forms, redirects and unsafe URLs', () => {
  for (const html of ['<iframe></iframe>', '<form></form>', '<meta http-equiv="refresh" content="0">', '<a href="javascript:alert(1)">X</a>']) {
    assert.equal(validateHtml(html).ok, false, html);
  }
});

test('accepts crawler-readable Open Graph metadata unchanged', () => {
  const result = validateHtml('<title>Preview</title><meta property="og:title" content="Preview"><meta property="og:description" content="Shared report"><meta property="og:image" content="https://example.com/preview.png">');
  assert.equal(result.ok, true);
  assert.equal(result.title, 'Preview');
});
