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
