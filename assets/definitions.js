(() => {
  'use strict';
  const glossary = window.AIO_CONTENT?.glossary;
  if (!glossary) throw new Error('The glossary is required for inline definitions.');
  const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const escape = value => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const terms = new Map();
  for (const item of glossary) {
    if (item.inline === false) continue;
    for (const label of [item.term, ...(item.inline || [])]) {
      const key = label.toLowerCase();
      if (terms.has(key)) throw new Error(`Duplicate inline definition: ${label}`);
      terms.set(key, slug(item.term));
    }
  }
  const pattern = new RegExp(`\\b(?:${[...terms.keys()].sort((a, b) => b.length - a.length)
    .map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
  const prose = new Set(['p', 'li', 'dt', 'dd', 'td']);
  const excluded = new Set(['a', 'button', 'summary', 'nav', 'label', 'select', 'option', 'pre', 'code', 'script', 'style', 'svg', 'textarea', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  function render(text, seen = new Set(), encoded = false) {
    let html = '';
    let start = 0;
    const encode = encoded ? value => value : escape;
    for (const match of text.matchAll(pattern)) {
      const id = terms.get(match[0].toLowerCase());
      html += encode(text.slice(start, match.index));
      html += seen.has(id) ? encode(match[0])
        : `<button class="definition-term" type="button" data-definition-term="${id}" aria-describedby="definition-tooltip">${encode(match[0])}</button>`;
      seen.add(id);
      start = match.index + match[0].length;
    }
    return html + encode(text.slice(start));
  }
  function decorateHtml(html) {
    const stack = [];
    return html.split(/(<[^>]+>)/g).map(part => {
      if (part.startsWith('<')) {
        const tag = part.match(/^<(\/?)([a-z][a-z0-9]*)\b/i);
        if (!tag) return part;
        const name = tag[2].toLowerCase();
        if (tag[1]) {
          const index = stack.findLastIndex(entry => entry.name === name);
          if (index >= 0) stack.length = index;
        } else if (!voidTags.has(name) && !part.endsWith('/>')) {
          stack.push({ name, seen: new Set(), excluded: excluded.has(name) || /\bid="glossary"/.test(part) ||
            /\bdata-no-definitions(?:\s|=|>)/.test(part) || /\bclass="[^"]*\b(?:eyebrow|sr-only)\b/.test(part) });
        }
        return part;
      }
      if (stack.some(entry => entry.excluded)) return part;
      const block = stack.findLast(entry => prose.has(entry.name));
      return block ? render(part, block.seen, true) : part;
    }).join('');
  }
  function enhance(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const seenByBlock = new Map();
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent || parent.closest([...excluded, '[data-no-definitions]', '#glossary', '.eyebrow', '.sr-only'].join(','))) continue;
      const block = parent.closest([...prose].join(','));
      if (!block) continue;
      if (!seenByBlock.has(block)) seenByBlock.set(block, new Set(
        [...block.querySelectorAll('[data-definition-term]')].map(button => button.dataset.definitionTerm)));
      const html = render(node.textContent, seenByBlock.get(block));
      if (!html.includes('data-definition-term=')) continue;
      const template = document.createElement('template');
      template.innerHTML = html;
      node.replaceWith(template.content);
    }
  }
  window.AIO_INLINE_DEFINITIONS = { html: text => render(text), decorateHtml, enhance };
})();
