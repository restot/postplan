import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parse} from 'parse5';
import * as preview from '../preview.js';

function metas(html) {
  const head=parse(html).childNodes.find(n=>n.tagName==='html').childNodes.find(n=>n.tagName==='head');
  return Object.fromEntries(head.childNodes.filter(n=>n.tagName==='meta').map(n=>{
    const attrs=Object.fromEntries(n.attrs.map(a=>[a.name,a.value]));
    return [attrs.property||attrs.name,attrs.content];
  }));
}
const url='https://postplan.test/d/abcdefghijkl/v/2/preview.png';
test('missing image metadata gets a version-pinned PNG and large Twitter card',()=>{
  const result=metas(preview.withPreviewMetadata('<title>Report</title>',{title:'Report'},url));
  assert.equal(result['og:image'],url);assert.equal(result['og:image:type'],'image/png');
  assert.equal(result['og:image:width'],'1200');assert.equal(result['og:image:height'],'630');
  assert.equal(result['twitter:image'],url);assert.equal(result['twitter:card'],'summary_large_image');
});
test('authored image metadata is preserved and blank image fields get the fallback',()=>{
  const custom='https://example.test/custom.png';
  const result=metas(preview.withPreviewMetadata(`<meta property="og:image" content="${custom}"><meta name="twitter:card" content="summary">`,{title:'Report'},url));
  assert.equal(result['og:image'],custom);assert.equal(result['og:image:width'],undefined);
  assert.equal(result['twitter:image'],custom);assert.equal(result['twitter:card'],'summary');
  assert.equal(metas(preview.withPreviewMetadata('<meta property="og:image" content=" ">',{title:'Report'},url))['og:image'],url);
});
test('card text comes from bounded HTML metadata and headings, never scripts or arbitrary SVG',()=>{
  assert.equal(typeof preview.previewCardData,'function');
  const data=preview.previewCardData('<title>Old title</title><meta property="og:title" content="Chosen &amp; title"><meta name="description" content="HTML summary"><h2>First section</h2><script>secret-script-text</script><svg><text>secret-svg-text</text></svg><h2>Second section</h2>',{title:'New title',description:'Fallback'},1);
  assert.equal(data.title,'Chosen & title');assert.equal(data.description,'HTML summary');
  assert.deepEqual(data.headings,['First section','Second section']);assert.equal(data.version,1);
  assert.doesNotMatch(JSON.stringify(data),/New title|secret-script-text|secret-svg-text/);
});
test('renderer only interpolates escaped bounded text into fixed-size SVG',()=>{
  assert.equal(typeof preview.previewCardSvg,'function');
  const svg=preview.previewCardSvg({title:'</text><image href="file:///etc/passwd"/>',description:'<script>alert(1)</script> & test',headings:['Hello\u0000 world'],version:2});
  assert.match(svg,/width="1200" height="630"/);
  assert.doesNotMatch(svg,/<image|<script|<foreignObject|<!ENTITY|\u0000/);
  assert.match(svg,/&lt;/);assert.match(svg,/&amp;/);
  const long=preview.previewCardSvg({title:'W'.repeat(10000),description:'word '.repeat(10000),headings:['h'.repeat(10000)],version:1});
  assert.ok(long.length<10000);assert.match(long,/…/);
});
test('programmatic card renders to a 1200 by 630 PNG without a browser',async()=>{
  assert.equal(typeof preview.renderPreviewPng,'function');
  const png=await preview.renderPreviewPng({title:'Review the release',description:'A programmatic preview',headings:['Plan','Verification'],version:2});
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),1200);assert.equal(png.readUInt32BE(20),630);
  assert.ok(png.length>10000);assert.ok(png.length<500000);
});
test('only the bounded HTML prefix contributes text and hidden content is skipped',()=>{
  const html='<title>Public</title><h2 hidden>Hidden</h2><h2 aria-hidden="true">Also hidden</h2><h2>Visible</h2>'+' '.repeat(preview.PREVIEW_HTML_BYTES)+'<meta property="og:title" content="Outside limit">';
  const data=preview.previewCardData(html,{},1);
  assert.equal(data.title,'Public');assert.deepEqual(data.headings,['Visible']);
});
test('preview cache is bounded and mutable metadata fallback invalidates cached output',async()=>{
  let reads=0;
  const load=async(key,limit)=>{reads++;assert.equal(limit,256*1024);return '<p>No metadata</p>';};
  const draft={id:'cache-test',title:'First'},version={id:'cache-v1',object_key:'cache-key',version_number:1};
  const first=await preview.getPreviewImage(draft,version,load);
  assert.deepEqual(await preview.getPreviewImage(draft,version,load),first);assert.equal(reads,1);
  const changed=await preview.getPreviewImage({...draft,title:'Second'},version,load);
  assert.notDeepEqual(changed,first);assert.equal(reads,2);
  for(let i=0;i<32;i++) await preview.getPreviewImage({...draft,id:`cache-${i}`},version,load);
  await preview.getPreviewImage(draft,version,load);assert.equal(reads,35);
});

const themeOf = html => preview.previewCardData(html, {}, 1).theme;
test('summary cards inherit the onboarding Material colors through body CSS variables',()=>{
  const theme=themeOf(`<style>:root{--surface:#141218;--text:#e6e0e9;--primary:#d0bcff;--muted:#cac4d0;--line:#49454f}body{background:var(--surface);color:var(--text)}a{color:var(--primary)}</style><h1>Guide</h1>`);
  assert.deepEqual(theme,{background:'#141218',text:'#e6e0e9',accent:'#d0bcff',muted:'#cac4d0',border:'#49454f'});
  const svg=preview.previewCardSvg({title:'Guide',version:1,theme});
  assert.match(svg,/<rect width="1200" height="630" fill="#141218"/);
  assert.match(svg,/fill="#d0bcff"/);assert.match(svg,/fill="#e6e0e9"/);
  assert.doesNotMatch(svg,/#b7efcf|#14191c/);
});
test('Material-prefixed tokens, variable aliases and fallback values are resolved',()=>{
  const theme=themeOf(`<style>:root{--md-surface:#141218;--md-on-surface:#e6e0e9;--md-primary:var(--brand);--brand:#d0bcff;--md-on-surface-variant:#cac4d0;--md-outline-variant:#49454f}body{background:var(--missing,var(--md-surface));color:var(--md-on-surface)}</style>`);
  assert.deepEqual(theme,{background:'#141218',text:'#e6e0e9',accent:'#d0bcff',muted:'#cac4d0',border:'#49454f'});
});
test('CSS comments are ignored and inherited variables retain their computed root values',()=>{
  assert.equal(themeOf('<style>body{background:#fff /* note */}</style>').background,'#ffffff');
  assert.equal(themeOf('<style>:root{--bg:white;background:var(--bg)}body{--bg:black}</style>').background,'#ffffff');
  assert.equal(themeOf('<style>:root{--a:white;--bg:var(--a)}body{--a:black;background:var(--bg)}</style>').background,'#ffffff');
});
test('static cascade respects importance, specificity, source order and inline body colors',()=>{
  const theme=themeOf(`<html class="dark"><head><style>:root{--brand:blue}html.dark{--brand:purple}body{background:white;color:black}body.report{background:#eeeeee}body{background:yellow!important;color:red}body{color:green}a{color:var(--brand)}</style><style>body{color:navy}</style></head><body class="report" style="background:#fafafa;color:#222222"></body></html>`);
  assert.equal(theme.background,'#ffff00');assert.equal(theme.text,'#222222');assert.equal(theme.accent,'#800080');
  assert.equal(themeOf('<style>body.report{background:#eee}body{background:#fff}</style><body class="report">').background,'#eeeeee');
  assert.equal(themeOf('<style>body{background:#fff}body{background:#eee}</style>').background,'#eeeeee');
  assert.equal(themeOf('<style>body{background:white;background:black!IMPORTANT}</style>').background,'#000000');
});
test('light pages use readable text, supported color syntax and composited alpha',()=>{
  const theme=themeOf('<style>html{background:white}body{background:rgba(255,0,0,.1);color:rgb(20 20 20);--accent:hsl(240 100% 25%);--muted:rgba(0,0,0,.7)}</style>');
  assert.equal(theme.background,'#ffe6e6');assert.equal(theme.text,'#141414');assert.equal(theme.accent,'#000080');
  assert.equal(themeOf('<style>body{background:white}</style>').text,'#14191c');
});
test('theme-color supplies a safe accent when no inline accent is available',()=>{
  const theme=themeOf('<meta name="theme-color" content="#8b4513"><style>body{background:#fff;color:#111}</style>');
  assert.equal(theme.accent,'#8b4513');
});
test('conditional and unrelated CSS cannot replace the static document palette',()=>{
  const theme=themeOf(`<style>body{background:#fff;color:#111;--accent:navy}.card{background:red}body:hover{background:blue}@media print{body{background:black}}@media(prefers-color-scheme:dark){:root{--accent:red}}@supports(display:grid){body{background:green}}</style><style media="print">body{background:black}</style><div class="card"></div>`);
  assert.equal(theme.background,'#ffffff');assert.equal(theme.text,'#111111');assert.equal(theme.accent,'#000080');
});
test('malformed, cyclic or external CSS falls back without injecting SVG or fetching assets',()=>{
  const theme=themeOf(`<link rel="stylesheet" href="http://127.0.0.1/private"><style>@import url(file:///etc/passwd);:root{--accent:var(--cycle);--cycle:var(--accent);--muted:url(file:///etc/passwd)}body{background:url(http://127.0.0.1/private);color:expression(alert(1))}</style>`);
  for(const color of Object.values(theme)) assert.match(color,/^#[0-9a-f]{6}$/);
  const svg=preview.previewCardSvg({title:'Safe',theme:{background:'"/><image href="file:///etc/passwd"/>',text:'url(file:///etc/passwd)',accent:'url(https://example.test/image.svg)',muted:'var(--x)',border:'<script>'}});
  assert.doesNotMatch(svg,/<image|<script|url\(|file:|example\.test|var\(/);
  assert.doesNotThrow(()=>preview.renderPreviewPng({title:'Safe',theme}));
  assert.doesNotThrow(()=>themeOf('<style>'+':is('.repeat(2000)+'</style>'));
});
test('CSS extraction is bounded and does not include styles outside the HTML prefix',()=>{
  const theme=themeOf('<style>body{background:white;color:black}</style>'+' '.repeat(preview.PREVIEW_HTML_BYTES)+'<style>body{background:blue}</style>');
  assert.equal(theme.background,'#ffffff');assert.equal(theme.text,'#000000');
  const cssLimited=themeOf('<style>body{background:#111;color:#eee}/*'+'x'.repeat(64*1024)+'*/body{background:white}</style>');
  assert.equal(cssLimited.background,'#111111');
});
test('the same card content renders differently for different report palettes',()=>{
  const render=css=>preview.renderPreviewPng(preview.previewCardData(`<style>${css}</style><title>Same report</title>`,{},1));
  assert.notDeepEqual(render('body{background:#141218;color:#e6e0e9;--accent:#d0bcff}'),render('body{background:#fff;color:#222;--accent:navy}'));
});
