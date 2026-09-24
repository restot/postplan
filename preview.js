import { parse, serialize } from 'parse5';
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

export function withPreviewMetadata(html, draft, previewUrl) {
  const document = parse(html);
  const root = document.childNodes.find(node => node.tagName === 'html');
  const head = root.childNodes.find(node => node.tagName === 'head');
  const meta = name => head.childNodes.find(node => node.tagName === 'meta' && node.attrs.some(attr => ['name', 'property'].includes(attr.name) && attr.value.toLowerCase() === name));
  const image = meta('og:image')?.attrs.find(attr => attr.name === 'content')?.value.trim();
  const defaults = {
    'og:type': 'article',
    'og:title': draft.title || 'Postplan draft',
    'og:description': draft.description || draft.title || 'Shared HTML document',
    'twitter:card': previewUrl || image ? 'summary_large_image' : 'summary',
    ...((image || previewUrl) ? {'og:image': image || previewUrl, 'twitter:image': image || previewUrl} : {}),
    ...(!image && previewUrl ? {'og:image:type':'image/png', 'og:image:width':'1200', 'og:image:height':'630', 'og:image:alt':draft.title || 'Postplan report preview'} : {})
  };
  for (const [name, content] of Object.entries(defaults)) {
    const existing = meta(name);
    if (existing?.attrs.find(attr => attr.name === 'content')?.value.trim()) continue;
    if (existing) head.childNodes.splice(head.childNodes.indexOf(existing), 1);
    head.childNodes.push({nodeName:'meta',tagName:'meta',namespaceURI:'http://www.w3.org/1999/xhtml',attrs:[{name:name.startsWith('og:')?'property':'name',value:name},{name:'content',value:content}],childNodes:[],parentNode:head});
  }
  return serialize(document);
}

export const PREVIEW_HTML_BYTES = 256 * 1024;
const fontPath = fileURLToPath(new URL('./fonts/NotoSans-Regular.ttf', import.meta.url));
const clean = (value, limit) => {
  const text = String(value || '').slice(0, 4096).replace(/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};
const escaped = value => value.replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[char]));
const excluded = new Set(['script', 'style', 'svg', 'template', 'noscript']);
function textOf(node) {
  const parts = [], stack = [node];
  let length = 0;
  while (stack.length && length < 4096) {
    const current = stack.pop();
    if (excluded.has(current.tagName) || current.attrs?.some(a => a.name === 'hidden' || (a.name === 'aria-hidden' && a.value === 'true'))) continue;
    if (current.nodeName === '#text') { parts.push(current.value.slice(0, 4096 - length)); length += current.value.length; }
    else for (let i = (current.childNodes?.length || 0) - 1; i >= 0; i--) stack.push(current.childNodes[i]);
  }
  return clean(parts.join(' '), 300);
}

export function previewCardData(html, draft, version) {
  const document = parse(Buffer.from(html).subarray(0, PREVIEW_HTML_BYTES).toString('utf8'));
  const metadata = {}, headings = [], stack = [document];
  let title = '';
  while (stack.length) {
    const node = stack.pop();
    if (excluded.has(node.tagName) || node.attrs?.some(a => a.name === 'hidden' || (a.name === 'aria-hidden' && a.value === 'true'))) continue;
    if (node.tagName === 'title' && !title) title = textOf(node);
    if (node.tagName === 'meta') {
      const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
      const name = (attrs.property || attrs.name || '').toLowerCase();
      if (['og:title', 'og:description', 'description'].includes(name) && !metadata[name]) metadata[name] = clean(attrs.content, 300);
    }
    if (['h1', 'h2'].includes(node.tagName) && headings.length < 3) {
      const text = textOf(node);
      if (text) headings.push(text);
    }
    for (let i = (node.childNodes?.length || 0) - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return {
    title: clean(metadata['og:title'] || title || headings[0] || draft.title || 'Postplan report', 180),
    description: clean(metadata['og:description'] || metadata.description || draft.description || 'A shared document, ready for review.', 240),
    headings: headings.map(text => clean(text, 90)),
    version: Number(version)
  };
}

// Conservative glyph widths keep the fixed template readable without HTML layout.
function lines(value, size, count) {
  let remaining = clean(value, 300);
  const result = [];
  while (remaining && result.length < count) {
    let width = 0, end = 0;
    for (const char of remaining) {
      const em = /[MW@%]/.test(char) ? 1 : /[A-Z]/.test(char) ? .75 : /[il.,'! :;]/.test(char) ? .32 : /[^\u0000-\u024f]/.test(char) ? 1 : .65;
      if (width + em * size > 1050) break;
      width += em * size; end += char.length;
    }
    if (end < remaining.length) {
      const space = remaining.lastIndexOf(' ', end);
      if (space > end / 2) end = space;
    }
    let line = remaining.slice(0, end).trim();
    remaining = remaining.slice(end).trim();
    if (remaining && result.length === count - 1) line = line.slice(0, -1) + '…';
    result.push(line);
  }
  return result;
}

export function previewCardSvg(data) {
  const text = (value, size, y, count, color) => lines(value, size, count).map((line, i) => `<text x="72" y="${y + i * (size + 12)}" font-size="${size}" fill="${color}">${escaped(line)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#14191c"/><rect width="10" height="630" fill="#b7efcf"/>
<g font-family="Noto Sans"><text x="72" y="77" font-size="22" letter-spacing="3" fill="#b7efcf">POSTPLAN / SHARED REPORT</text>
${text(data.title, 48, 169, 3, '#f4f6f5')}
${text(data.description, 25, 379, 2, '#b9c3c4')}
<path d="M72 460H1128" stroke="#374448"/>
${text((data.headings || []).slice(0, 3).map(value => clean(value, 90)).join(' · '), 21, 503, 1, '#b7efcf')}
<text x="72" y="580" font-size="20" fill="#a5b1b4">Read the report. Join the review.</text>
<text x="1128" y="580" text-anchor="end" font-size="20" fill="#a5b1b4">VERSION ${Number.isInteger(data.version) && data.version > 0 ? data.version : 1}</text></g></svg>`;
}

export function renderPreviewPng(data) {
  return new Resvg(previewCardSvg(data), {font:{loadSystemFonts:false, fontFiles:[fontPath], defaultFontFamily:'Noto Sans'}}).render().asPng();
}

const images = new Map();
export async function getPreviewImage(draft, version, loadHtml) {
  const key = JSON.stringify([draft.id, version.id, version.object_key, version.content_hash, version.version_number, draft.title, draft.description]);
  if (images.has(key)) return images.get(key);
  const html = await loadHtml(version.object_key, PREVIEW_HTML_BYTES);
  const png = renderPreviewPng(previewCardData(html, draft, Number(version.version_number)));
  // Fixed-size images and a bounded FIFO cache; request query strings never enter the key.
  if (images.size >= 32) images.delete(images.keys().next().value);
  images.set(key, png);
  return png;
}
