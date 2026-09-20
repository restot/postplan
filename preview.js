import { parse, serialize } from 'parse5';

export function withPreviewMetadata(html, draft) {
  const document = parse(html);
  const root = document.childNodes.find(node => node.tagName === 'html');
  const head = root.childNodes.find(node => node.tagName === 'head');
  const defaults = {
    'og:type': 'article',
    'og:title': draft.title || 'Postplan draft',
    'og:description': draft.description || draft.title || 'Shared HTML document',
    'twitter:card': 'summary'
  };
  for (const [name, content] of Object.entries(defaults)) {
    if (head.childNodes.some(node => node.tagName === 'meta' && node.attrs.some(attr => ['name', 'property'].includes(attr.name) && attr.value.toLowerCase() === name))) continue;
    head.childNodes.push({nodeName:'meta',tagName:'meta',namespaceURI:'http://www.w3.org/1999/xhtml',attrs:[{name:name.startsWith('og:')?'property':'name',value:name},{name:'content',value:content}],childNodes:[],parentNode:head});
  }
  return serialize(document);
}
