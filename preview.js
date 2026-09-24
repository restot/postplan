import { parse, serialize } from 'parse5';
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { parse as parseCss } from 'css-tree';
import Color from 'color';

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
const defaultTheme = {background:'#14191c', text:'#f4f6f5', accent:'#b7efcf', muted:'#b9c3c4', border:'#374448'};
const themeTokens = {
  background:['--background', '--background-color', '--bg', '--bg-color', '--surface', '--md-surface', '--md-sys-color-surface'],
  text:['--text', '--text-color', '--foreground', '--on-surface', '--md-on-surface', '--md-sys-color-on-surface'],
  accent:['--accent', '--accent-color', '--primary', '--primary-color', '--md-primary', '--md-sys-color-primary'],
  muted:['--muted', '--text-muted', '--text-secondary', '--on-surface-variant', '--md-on-surface-variant', '--md-sys-color-on-surface-variant'],
  border:['--line', '--border', '--border-color', '--outline-variant', '--md-outline-variant', '--md-sys-color-outline-variant']
};

function colorHex(value, background = defaultTheme.background) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const color = Color(value.trim()).rgb(), alpha = color.alpha();
    if (!alpha) return null;
    const backdrop = Color(background).rgb().array();
    return Color.rgb(color.array().slice(0, 3).map((channel, i) => channel * alpha + backdrop[i] * (1 - alpha))).hex().toLowerCase();
  } catch { return null; }
}

function safeTheme(values = {}) {
  const background = colorHex(values.background) || defaultTheme.background;
  const contrast = color => Color(color).contrast(Color(background));
  const readable = contrast('#14191c') > contrast('#f4f6f5') ? '#14191c' : '#f4f6f5';
  const textColor = colorHex(values.text, background) || readable;
  const text = contrast(textColor) >= 4.5 ? textColor : readable;
  const accentColor = colorHex(values.accent, background) || defaultTheme.accent;
  const mutedColor = colorHex(values.muted, background) || colorHex('rgba(' + Color(text).array().join(',') + ',.7)', background);
  return {
    background, text,
    accent:contrast(accentColor) >= 3 ? accentColor : text,
    muted:contrast(mutedColor) >= 3 ? mutedColor : text,
    border:colorHex(values.border, background) || colorHex('rgba(' + Color(text).array().join(',') + ',.22)', background)
  };
}

// Match only static compound selectors for document elements, not interactive states.
function selectorRank(selector, element) {
  const attrs = Object.fromEntries(element.attrs.map(attr => [attr.name, attr.value]));
  const rank = [0, 0, 0];
  for (const part of selector.children) {
    if (part.type === 'TypeSelector' && part.name === '*') continue;
    if (part.type === 'TypeSelector' && part.name.toLowerCase() === element.tagName) rank[2]++;
    else if (part.type === 'IdSelector' && part.name === attrs.id) rank[0]++;
    else if (part.type === 'ClassSelector' && (attrs.class || '').split(/\s+/).includes(part.name)) rank[1]++;
    else if (part.type === 'PseudoClassSelector' && part.name === 'root' && element.tagName === 'html') rank[1]++;
    else return null;
  }
  return rank;
}

function themeFromDocument(document) {
  const html = document.childNodes.find(node => node.tagName === 'html');
  const body = html.childNodes.find(node => node.tagName === 'body');
  const targets = [html, body, {tagName:'a', attrs:[]}];
  const styles = targets.map(() => new Map());
  let budget = 64 * 1024, order = 0, themeColor;
  const apply = (declarations, target, specificity, inline = 0) => {
    for (const declaration of declarations) {
      if (declaration.type !== 'Declaration') continue;
      let property = declaration.property;
      if (!property.startsWith('--')) property = property.toLowerCase();
      if (property === 'background') property = 'background-color';
      if (!property.startsWith('--') && !['background-color', 'color'].includes(property)) continue;
      let value = declaration.value.value;
      if (typeof value !== 'string' || value.length > 512) continue;
      value = value.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ').trim();
      const important = declaration.important === true || String(declaration.important).toLowerCase() === 'important';
      if (declaration.important && !important) continue;
      const rank = [Number(important), inline, ...specificity, order++];
      const old = styles[target].get(property);
      const different = old ? rank.findIndex((part, i) => part !== old.rank[i]) : -1;
      if (!old || (different >= 0 && rank[different] > old.rank[different])) styles[target].set(property, {value, rank});
    }
  };
  const stack = [document];
  while (stack.length) {
    const node = stack.pop();
    const attrs = Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value]));
    if (node.tagName === 'meta' && attrs.name?.toLowerCase() === 'theme-color' && !attrs.media) themeColor ||= attrs.content;
    if (node.tagName === 'style' && budget > 0 && (!attrs.type || attrs.type === 'text/css') && (!attrs.media || ['all','screen'].includes(attrs.media))) {
      const cssBytes = Buffer.from(node.childNodes[0]?.value || '').subarray(0, budget);
      const css = cssBytes.toString('utf8');
      budget -= cssBytes.length;
      try {
        const sheet = parseCss(css, {parseValue:false, parseAtrulePrelude:false});
        for (const rule of sheet.children) {
          // Ignore @media, @import, @supports, nested selectors and other conditional rules.
          if (rule.type !== 'Rule' || rule.prelude?.type !== 'SelectorList') continue;
          for (let target = 0; target < targets.length; target++) {
            for (const selector of rule.prelude.children) {
              const rank = selectorRank(selector, targets[target]);
              if (rank) apply(rule.block.children, target, rank);
            }
          }
        }
      } catch { /* An invalid stylesheet must not break a public preview. */ }
    }
    if (excluded.has(node.tagName)) continue;
    for (let i = (node.childNodes?.length || 0) - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  for (let target = 0; target < 2; target++) {
    const inline = targets[target].attrs.find(attr => attr.name === 'style')?.value;
    if (inline) {
      try { apply(parseCss(inline.slice(0, 4096), {context:'declarationList', parseValue:false}).children, target, [0,0,0], 1); }
      catch { /* Ignore malformed inline declarations. */ }
    }
  }
  const resolve = (value, variables, depth = 0) => {
    if (!value || depth > 12) return null;
    const variable = value.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/);
    if (!variable) return value;
    return resolve(variables.get(variable[1]), variables, depth + 1) || resolve(variable[2], variables, depth + 1);
  };
  // Custom properties are computed before inheritance, not re-resolved in the child scope.
  const scopes = [];
  for (let target = 0; target < targets.length; target++) {
    const variables = new Map(scopes[target - 1]);
    for (const [name, declaration] of styles[target]) if (name.startsWith('--')) variables.set(name, declaration.value);
    scopes.push(new Map([...variables].map(([name, value]) => [name, resolve(value, variables)])));
  }
  const property = (target, name, background) => colorHex(resolve(styles[target].get(name)?.value, scopes[target]), background);
  const token = (role, background) => themeTokens[role].map(name => colorHex(scopes[1].get(name), background)).find(Boolean);
  const rootBackground = property(0, 'background-color');
  const background = property(1, 'background-color', rootBackground || defaultTheme.background) || rootBackground || token('background') || defaultTheme.background;
  return safeTheme({
    background,
    text:property(1, 'color', background) || property(0, 'color', background) || token('text', background),
    accent:token('accent', background) || property(2, 'color', background) || colorHex(themeColor, background),
    muted:token('muted', background),
    border:token('border', background)
  });
}
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
    version: Number(version),
    theme: themeFromDocument(document)
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
  const theme = safeTheme(data.theme || defaultTheme);
  const text = (value, size, y, count, color) => lines(value, size, count).map((line, i) => `<text x="72" y="${y + i * (size + 12)}" font-size="${size}" fill="${color}">${escaped(line)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${theme.background}"/><rect width="10" height="630" fill="${theme.accent}"/>
<g font-family="Noto Sans"><text x="72" y="77" font-size="22" letter-spacing="3" fill="${theme.accent}">POSTPLAN / SHARED REPORT</text>
${text(data.title, 48, 169, 3, theme.text)}
${text(data.description, 25, 379, 2, theme.muted)}
<path d="M72 460H1128" stroke="${theme.border}"/>
${text((data.headings || []).slice(0, 3).map(value => clean(value, 90)).join(' · '), 21, 503, 1, theme.accent)}
<text x="72" y="580" font-size="20" fill="${theme.muted}">Read the report. Join the review.</text>
<text x="1128" y="580" text-anchor="end" font-size="20" fill="${theme.muted}">VERSION ${Number.isInteger(data.version) && data.version > 0 ? data.version : 1}</text></g></svg>`;
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
