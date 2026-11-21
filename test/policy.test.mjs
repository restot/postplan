import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateHtml } from '../node_modules/postplan/src/html-policy.js';
import { config } from '../node_modules/postplan/src/config.js';
import sourceMap from 'source-map-js';

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

test('source-map dependency rejects malicious indexed offsets before processing mappings', () => {
  const section = (line, map = {version:3,sources:['input.js'],names:[],mappings:'AAAA'}) =>
    ({version:3,sections:[{offset:{line,column:0},map}]});
  for (const line of [10_000_001, Infinity, NaN, -1, 1.5, '4']) {
    assert.throws(() => new sourceMap.SourceMapConsumer(section(line)), /Section offset/);
  }
  assert.throws(() => new sourceMap.SourceMapConsumer(section(6_000_000,section(6_000_000))), /Section offset/);
});

test('source-map dependency preserves valid indexed mappings', () => {
  const consumer = new sourceMap.SourceMapConsumer({version:3,sections:[{
    offset:{line:12,column:0},map:{version:3,sources:['input.js'],names:[],mappings:'AAAA'}
  }]});
  const mappings=[];
  consumer.eachMapping(mapping => mappings.push(mapping));
  assert.equal(mappings.length,1);
  assert.equal(mappings[0].generatedLine,13);
  assert.equal(mappings[0].source,'input.js');
  assert.equal(mappings[0].originalLine,1);
});
