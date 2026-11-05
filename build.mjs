import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderSetup } from './setup.mjs';
import { renderItRunbook } from './it-runbook.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const stylesheet = `assets/styles.css?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'styles.css'))).digest('hex').slice(0, 12)}`;
const appScript = `assets/app.js?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'app.js'))).digest('hex').slice(0, 12)}`;
const kitchenScript = `assets/mini-kitchen.js?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'mini-kitchen.js'))).digest('hex').slice(0, 12)}`;
const kitchenContractScript = `assets/mini-kitchen-contract.js?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'mini-kitchen-contract.js'))).digest('hex').slice(0, 12)}`;
const setupScript = `assets/setup.js?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'setup.js'))).digest('hex').slice(0, 12)}`;
const contentScript = `assets/content.js?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'content.js'))).digest('hex').slice(0, 12)}`;
const catalogScript = `assets/catalog.js?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'catalog.js'))).digest('hex').slice(0, 12)}`;
const definitionScript = `assets/definitions.js?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'definitions.js'))).digest('hex').slice(0, 12)}`;
const navigationScript = `assets/setup-navigation.js?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'setup-navigation.js'))).digest('hex').slice(0, 12)}`;
const itRequestScript = `assets/it-request.js?v=${createHash('sha256').update(fs.readFileSync(path.join(root, 'assets', 'it-request.js'))).digest('hex').slice(0, 12)}`;
const starScreenshots = Object.fromEntries(['unstarred', 'starred'].map(state => {
  const file = `assets/github-${state}-control.png`;
  return [state, `${file}?v=${createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 12)}`];
}));
const context = { window: {}, URL, URLSearchParams };
for (const file of ['content.js', 'catalog.js', 'definitions.js', 'setup-navigation.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(root, 'assets', file), 'utf8'), context, { filename: file });
}
const content = context.window.AIO_CONTENT;
const release = context.window.AIO_RELEASE;
const inlineDefinitions = context.window.AIO_INLINE_DEFINITIONS;
const navigation = context.window.AIO_SETUP_NAVIGATION;
if (!content?.tour.length || !release?.templates.length) throw new Error('The report content and download catalog are required.');
const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, ' ').replace(/\s+/g, ' ').trim();
const collectionLabels = text => text.replace(/\bfirst collection\b(?! \(seed\))/gi, match => `${match} (seed)`)
  .replace(/\bupdate existing history\b(?! \(append\))/gi, match => `${match} (append)`);
const teamUrl = 'https://microsoft.github.io/Analytics-Hub/team/';
const team = `<a href="${teamUrl}">Microsoft Copilot Analytics Team</a>`;
const referenceLinks = {
  'mini-kitchen': 'get-started.html',
  'power bi desktop': 'https://www.microsoft.com/en-us/download/details.aspx?id=58494',
  'powershell 7': 'https://aka.ms/PowerShell',
  'powershell 7 or later': 'https://aka.ms/PowerShell',
  'python 3.10': 'https://www.python.org/downloads/',
  'python 3.10 or later': 'https://www.python.org/downloads/',
  'microsoft copilot analytics team': teamUrl
};
function linkReferences(html) {
  const excluded = new Set(['a', 'pre', 'code', 'summary', 'button', 'script', 'style']);
  const stack = [];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  return html.split(/(<[^>]+>)/g).map(part => {
    if (part.startsWith('<')) {
      const tag = part.match(/^<(\/?)([a-z][a-z0-9]*)\b/i);
      if (tag) {
        const name = tag[2].toLowerCase();
        if (tag[1]) {
          const index = stack.findLastIndex(entry => entry.name === name);
          if (index >= 0) stack.length = index;
        } else if (!voidTags.has(name) && !part.endsWith('/>')) {
          stack.push({ name, excluded: excluded.has(name) || /\bdata-no-auto-link(?:\s|=|>)/.test(part) });
        }
      }
      return part;
    }
    if (stack.some(entry => entry.excluded)) return part;
    return part.replace(/\b(?:Mini-Kitchen|Power BI Desktop|PowerShell 7(?: or later)?|Python 3\.10(?: or later)?|Microsoft Copilot Analytics team)\b/gi, label => {
      const href = referenceLinks[label.toLowerCase()];
      return `<a href="${href}"${/^https:\/\//.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
    });
  }).join('');
}
function paxModalLinks(html) {
  return html.replace(/<a\b([^>]+)>([\s\S]*?)<\/a>/g, (original, attributes, text) => {
    const href = attributes.match(/\bhref="([^"]+)"/)?.[1];
    if (href !== 'https://aka.ms/PAX-Prerelease' || /\bdata-pax-repository\b/.test(attributes)) return original;
    return `<a${attributes} data-open-pax aria-haspopup="dialog" aria-controls="pax-dialog">${text.replace(/<svg\b[\s\S]*?<\/svg>/g, '').replace(/<span class="sr-only"> \(opens a new tab\)<\/span>/g, '')}</a>`;
  });
}
const icon = name => {
  const paths = {
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
    play: '<path d="m9 5 11 7-11 7Z"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
    chart: '<path d="M4 20h17M7 16v-5m6 5V4m6 12V8"/>',
    people: '<circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3m2-16a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 4v2"/>',
    agent: '<rect x="4" y="6" width="16" height="14" rx="4"/><path d="M12 2v4M8 11v2m8-2v2m-8 3h8"/>',
    book: '<path d="M12 5C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2Zm0 0v16"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    check: '<path d="m5 12 5 5L20 6"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.arrow}</svg>`;
};
const external = (label, href, cls = 'text-link', showNewTab = false) => `<a class="${cls}" href="${e(href)}" target="_blank" rel="noopener noreferrer">${e(label)}${icon('external')}<span class="sr-only"> (opens a new tab)</span></a>${showNewTab ? '<span class="external-tab-note" aria-hidden="true">(opens a new tab)</span>' : ''}`;
const button = (label, href, kind = 'primary', symbol = 'arrow') => `<a class="button button-${kind}" href="${e(href)}">${e(label)}${icon(symbol)}</a>`;
const miniKitchenStart = '<a href="get-started.html">Mini-Kitchen</a>';
function productLogo(product) {
  const dimensions = { pax: [1857, 954], 'mini-kitchen': [216, 214] }[product];
  if (!dimensions) throw new Error(`Unknown product logo: ${product}`);
  return `<span class="product-logo" aria-hidden="true"><img src="assets/${product}-logo.png" width="${dimensions[0]}" height="${dimensions[1]}" alt="" decoding="async"></span>`;
}
function editionLogo(edition) {
  const asset = { sharepoint: 'sharepoint', local: 'csv', fabric: 'fabric', 'pax-fabric': 'fabric', sample: 'power-bi' }[edition];
  if (!asset) throw new Error(`Unknown edition logo: ${edition}`);
  return `<span class="edition-logo" aria-hidden="true"><img src="assets/edition-icons/${asset}.svg" width="40" height="40" alt="" decoding="async"></span>`;
}
const readyDataButton = (id, caption) => `<a href="setup-open.html" class="button button-secondary setup-next kitchen-continue" data-setup-next aria-labelledby="${id}-continue-label" aria-describedby="${id}-ready-hint"><span id="${id}-ready-hint" class="kitchen-ready-caption">${e(caption)}</span><span id="${id}-continue-label" data-setup-next-label>Continue with ready data</span></a>`;
const resource = id => release.downloads.find(item => item.id === id);
const dl = (id, label) => {
  const item = resource(id);
  if (!item) throw new Error(`Unknown download: ${id}`);
  return `<a class="text-link" href="${e(item.href)}">${e(label || item.title)}${icon('download')}</a>`;
};
const eyebrow = text => `<p class="eyebrow">${e(text)}</p>`;
const pageHead = (tag, title, lead) => `<section class="page-head"><div class="container">${eyebrow(tag)}<h1>${title}</h1><p class="lead">${lead}</p></div></section>`;
const note = (title, text, tone = 'info') => `<div class="notice notice-${tone}">${icon(tone === 'privacy' ? 'shield' : 'book')}<div><strong>${title}</strong><p>${text}</p></div></div>`;
const searchAttr = (id, title) => `id="${id}" data-search-title="${e(title)}"`;
const brand = `<span class="brand-mark"><img src="assets/brand-mark.svg" width="42" height="42" alt=""></span>`;
const policy = 'Use individual reporting only if your organization\'s privacy and employee-reporting policies allow it. Check with your privacy or HR team if you are unsure.';
const watchButton = href => `<a class="button button-secondary walkthrough-button" href="${href}"><span aria-hidden="true">&#128250;</span>Watch the walkthrough</a>`;
const glossaryButton = (label = 'Open metric glossary') => `<a class="button button-secondary" href="learn.html#glossary" data-open-glossary aria-haspopup="dialog">${icon('book')}${e(label)}</a>`;
const guideTabs = (active) => `<nav class="container guide-tabs" aria-label="User Guide sections">${[['tour', 'user-guide.html', 'Report tour'], ['learn', 'learn.html', 'Read the numbers'], ['help', 'help.html', 'Help']].map(([id, href, label]) => `<a href="${href}" ${id === active ? 'aria-current="page"' : ''}>${label}</a>`).join('')}<a href="learn.html#glossary" data-open-glossary aria-haspopup="dialog">${icon('book')}Metric glossary</a></nav>`;
const guideHead = (active, title, lead) => pageHead('User Guide', title, lead) + guideTabs(active);
const auditReference = { label: 'Microsoft Learn: Copilot audit records', href: 'https://learn.microsoft.com/en-us/purview/audit-copilot#common-properties-in-copilot-audit-logs', note: 'Source context. AIO applies its own prompt selection and counting rules.' };
const usageReference = { label: 'Microsoft Learn: why usage-report counts differ', href: 'https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-usage#whats-the-difference-between-the-user-activity-table-and-audit-log', note: 'Comparison only. Official usage-report populations and calculations are not AIO definitions.' };
const rlsReference = { label: 'Microsoft Learn: Power BI row-level security', href: 'https://learn.microsoft.com/en-us/fabric/security/service-admin-row-level-security#use-rls-with-workspaces-in-power-bi', note: 'Platform guidance. Reporting hierarchy and All data viewers are roles supplied by AIO.' };
const syncReference = { label: 'Microsoft Learn: SQL analytics endpoint synchronization', href: 'https://learn.microsoft.com/en-us/fabric/data-engineering/sql-analytics-endpoint-metadata-sync#schema-change-detection-and-metadata-sync', note: 'Platform context. Synchronization is separate from AIO readiness checks and Power BI refresh.' };
const termReferences = new Map([
  ['Prompts', auditReference], ['Audit coverage', usageReference],
  ['Active licensed users', usageReference], ['Inactive licensed users', usageReference],
  ['Reporting hierarchy role', rlsReference], ['All data viewers role', rlsReference],
  ['Power BI Import', { label: 'Microsoft Learn: Import-mode refresh', href: 'https://learn.microsoft.com/en-us/power-bi/connect-data/refresh-data#semantic-models-in-import-mode', note: 'Power BI refresh updates the imported copy; it does not replace source collection.' }],
  ['Prepared inputs', { label: 'Microsoft Learn: Lakehouse SQL analytics endpoint', href: 'https://learn.microsoft.com/en-us/fabric/data-engineering/lakehouse-sql-analytics-endpoint#what-you-can-do', note: 'Platform context only. AIO still requires the matching files or tables for its chosen edition.' }],
  ['Fabric OneLake notebook readiness', syncReference], ['Fabric OneLake PAX readiness', syncReference]
]);
for (const item of content.glossary) item.reference = termReferences.get(item.term);
function definedText(value) {
  return inlineDefinitions.html(value);
}
function glossarySection() {
  const categories = [...new Set(content.glossary.map(item => item.category))];
  return `<section class="section section-tinted" ${searchAttr('glossary', 'Plain-English metric glossary')}><div class="container"><div class="section-heading horizontal"><div>${eyebrow('Find the meaning')}<h2>A glossary you can scan.</h2><p>Jump to a topic or search across all definitions. Your place stays highlighted as you read.</p></div><label class="search-field">${icon('search')}<input type="search" id="glossary-search" placeholder="Search a metric or question" aria-label="Search metric glossary"></label></div><div class="glossary-browser"><nav class="topic-nav" aria-label="Glossary topics"><a href="#glossary" data-glossary-bookmark>Glossary overview</a>${categories.map(c => `<a href="#glossary-topic-${slug(c)}" data-glossary-bookmark>${e(c)}</a>`).join('')}</nav><div><p class="result-count" id="glossary-count">${content.glossary.length} definitions</p><div id="glossary-list">${categories.map(category => `<section class="glossary-group" id="glossary-topic-${slug(category)}" data-glossary-group="${e(category)}" aria-labelledby="glossary-heading-${slug(category)}"><h3 id="glossary-heading-${slug(category)}" tabindex="-1">${e(category)}</h3>${content.glossary.filter(i => i.category === category).map(item => `<details class="glossary-item" id="term-${slug(item.term)}" data-category="${e(item.category)}" data-search="${e(`${item.term} ${item.definition} ${item.category} ${item.aliases || ''}`.toLowerCase())}"><summary>${e(item.term)}</summary><p>${e(item.definition)}</p>${item.reference ? `<p class="definition-reference">${external(item.reference.label, item.reference.href)}<span>${e(item.reference.note)}</span></p>` : ''}</details>`).join('')}</section>`).join('')}</div><p class="empty-state" id="glossary-empty" hidden>No matching definition. Try a shorter word, or <a href="help.html">visit Help</a>.</p></div></div></div></section>`;
}
const helpTopics = [
  { category: 'Setup', title: 'Getting started', description: 'Choose a connection, try the sample or collect your own data.', icon: 'layers' },
  { category: 'Troubleshooting', title: 'Fix a problem', description: 'Start here when the report is blank, a button will not respond or an export looks incomplete.', icon: 'book' },
  { category: 'Data', title: 'Understand the numbers', description: 'Make sense of activity, license information and differences between reports.', icon: 'chart' },
  { category: 'Privacy', title: 'Privacy and access', description: 'Understand hidden detail, group size and who can see the data.', icon: 'shield' },
  { category: 'Refresh', title: 'Keep data current', description: 'Update the source data and keep Power BI refresh running in the right order.', icon: 'clock' }
];
function setupVideo() {
  return `<div class="video-facade" data-youtube="${e(release.setupVideo.embed)}"><button class="video-play" aria-label="Play AI-in-One setup walkthrough on YouTube"><img src="assets/setup-video-poster.jpg" alt="AI-in-One setup walkthrough" width="480" height="360" loading="lazy"><span>${icon('play')}Watch the setup walkthrough</span></button></div><p class="image-caption">${external('Watch on YouTube', release.setupVideo.href)}</p>`;
}
function overviewVideo(inHero = false) {
  const dimensions = inHero ? ' class="hero-overview" width="1600" height="987" playsinline' : '';
  return `<video${dimensions} controls preload="none" poster="${e(release.video.poster)}" aria-label="AI-in-One v2.0 overview with captions"><source src="${e(release.video.href)}" type="video/mp4">Your browser cannot play this video. <a href="${e(release.video.href)}" target="_blank" rel="noopener noreferrer">Open the overview video in a new tab</a>.</video>${inHero ? '' : '<p class="image-caption">Captioned report overview. The written guide and report tour explain the current metrics.</p>'}`;
}
function renderCollectionOptions() {
  return content.collectionHelp.map(item => {
    const id = `kitchen-collection-${item.value}`;
    return `<div class="kitchen-collection-option"><input type="radio" name="kitchen-run" id="${id}" value="${item.value}" required aria-labelledby="${id}-title" aria-describedby="${id}-description"><div class="kitchen-collection-option-copy"><div class="kitchen-collection-title-row"><label for="${id}" id="${id}-title"><strong>${e(item.term)}</strong></label><button type="button" class="kitchen-collection-help" data-definition-term="${item.id}" aria-label="Learn about ${e(item.term)}" aria-describedby="definition-tooltip">${icon('info')}</button></div><label for="${id}" id="${id}-description" class="kitchen-collection-description">${e(item.description)}</label></div></div>`;
  }).join('');
}
function miniKitchenPanel({ choices, prepare, open, share, editionMatrix }) {
  return `<div id="mini-kitchen" class="setup-launch" data-mini-kitchen data-mini-kitchen-src="https://microsoft.github.io/PAX-Cookbook/mini-kitchen/">
    <section class="section container setup-launch-panel" aria-labelledby="setup-launch-title" data-no-auto-link>
      ${eyebrow('Setup Guide')}<h1 id="setup-launch-title">Set up <span class="gradient-text">AI-in-One.</span></h1>
      <p class="lead">Choose an edition, prepare data, connect and share your report.</p>
      <aside class="setup-tool-callouts" aria-label="About PAX and Mini-Kitchen">
        <div class="setup-tool-callout" id="setup-about-pax">${productLogo('pax')}<div><h2>PAX</h2><p>Portable Audit eXporter is the PowerShell script you or IT run to collect and prepare Copilot activity, people and licensing data.</p></div></div>
        <div class="setup-tool-callout" id="setup-about-mini-kitchen">${productLogo('mini-kitchen')}<div><h2>Mini-Kitchen</h2><p>Builds a ready-to-copy PAX command from your dates, people and storage choices. It does not collect data.</p></div></div>
      </aside>
      ${editionMatrix}
      <p id="kitchen-status" class="kitchen-status" role="status" tabindex="-1"></p>
      <noscript><p>This guided setup needs JavaScript. The IT setup reference is available from the site footer.</p></noscript>
      <div class="button-row setup-launch-actions"><button type="button" class="button button-primary" id="kitchen-configure" aria-controls="kitchen-builder" aria-haspopup="dialog" aria-expanded="false">Start setup ${icon('arrow')}</button></div>
    </section>
    <dialog id="kitchen-builder" class="kitchen-modal" aria-labelledby="kitchen-builder-title" aria-describedby="kitchen-modal-context" data-no-auto-link>
      <header class="kitchen-modal-header"><div class="kitchen-modal-brand"><img class="kitchen-brand-mark" src="assets/brand-mark.svg" width="36" height="36" alt=""><div><h2 id="kitchen-builder-title" tabindex="-1">AI-in-One setup</h2><p id="kitchen-modal-context"></p></div></div><button type="button" class="icon-button" id="kitchen-close" aria-label="Close AI-in-One setup">&times;</button></header>
      <div class="kitchen-modal-toolbar">
        <div class="kitchen-progress-group"><p id="kitchen-progress" aria-live="polite">Step 1 · Choose</p><ol id="kitchen-steps" aria-label="AI-in-One setup progress"></ol><h3 id="kitchen-screen-title" class="sr-only">Choose your edition</h3></div>
        <div class="kitchen-save-option" hidden><button type="button" class="button button-secondary" id="kitchen-open-full" aria-describedby="kitchen-handoff-why" hidden>${productLogo('mini-kitchen')}Continue in Full Mini-Kitchen ${icon('external')}</button><p id="kitchen-handoff-why">Take your choices to a new tab; save a recipe there.</p><p id="kitchen-handoff-requirement" role="status" hidden></p><button type="button" class="text-button" id="kitchen-retry-connection" hidden>Retry connection</button></div>
      </div>
      <div class="kitchen-modal-body">
        <section id="kitchen-choices" class="kitchen-native-screen" data-setup-native="choices" aria-labelledby="kitchen-choices-title" hidden>${choices}</section>
        <section id="kitchen-prepare" class="kitchen-native-screen" data-setup-native="prepare" aria-labelledby="kitchen-prepare-title" hidden><div class="kitchen-screen-content">${prepare}</div></section>
        <section id="kitchen-open" class="kitchen-native-screen" data-setup-native="open" aria-labelledby="kitchen-open-title" hidden><div class="kitchen-screen-content">${open}</div></section>
        <section id="kitchen-share" class="kitchen-native-screen" data-setup-native="share" aria-labelledby="kitchen-share-title" hidden><div class="kitchen-screen-content">${share}</div></section>
        <p id="kitchen-loading" role="status" hidden>Opening your guided command builder...</p><div id="kitchen-viewport" class="kitchen-modal-viewport" hidden></div>
      </div>
      <footer class="kitchen-modal-footer"><div class="kitchen-modal-navigation">
        <button type="button" class="button button-secondary" id="kitchen-back" disabled>Back</button>
        <div class="setup-walkthrough-info"><a class="setup-walkthrough-link" href="${e(release.setupVideo.href)}" target="_blank" rel="noopener noreferrer" aria-describedby="setup-video-summary">Watch the setup video ${icon('external')}</a><span id="setup-video-summary">15 min · YouTube · New tab</span></div>
        <div class="kitchen-next-actions"><div class="kitchen-next-messages"><p id="kitchen-modal-status" role="status"></p><p id="kitchen-command-warning" class="kitchen-copy-reminder" hidden>${icon('check')}<span>Copy or save your command before closing.</span></p><p id="kitchen-next-reason" role="status"></p></div><div class="kitchen-forward-buttons"><button type="button" class="button button-secondary" id="kitchen-copy-command" aria-describedby="kitchen-modal-status" hidden>Copy PAX Command</button><button type="button" class="button button-primary" id="kitchen-next" aria-describedby="kitchen-next-reason kitchen-modal-status" disabled>Next</button></div></div>
      </div></footer>
    </dialog>
    <dialog id="kitchen-discard" class="kitchen-discard" aria-labelledby="kitchen-discard-title" aria-describedby="kitchen-discard-message" data-no-auto-link>
      ${productLogo('mini-kitchen')}<h2 id="kitchen-discard-title">Keep your setup?</h2><p id="kitchen-discard-message">Closing clears your choices and any command. A copied command stays on your clipboard.</p>
      <div class="kitchen-discard-actions"><button type="button" class="button button-primary" id="kitchen-keep-building">Keep working here ${icon('arrow')}</button><button type="button" class="text-button kitchen-discard-button" id="kitchen-confirm-discard">Discard and close</button></div>
      <div class="kitchen-discard-save"><h3>Save for later</h3><p id="kitchen-save-reason">Open your current choices—finished or unfinished—in full Mini-Kitchen, then save a recipe there.</p><button type="button" class="button button-secondary" id="kitchen-save-before-close" aria-describedby="kitchen-save-reason" hidden>${productLogo('mini-kitchen')}Continue in Mini-Kitchen ${icon('external')}</button><p id="kitchen-discard-connection" role="status" hidden></p><button type="button" class="text-button" id="kitchen-discard-retry" hidden>Retry connection</button></div><p id="kitchen-discard-status" role="status"></p>
    </dialog>
    <dialog id="kitchen-finish" class="kitchen-finish" aria-labelledby="kitchen-finish-title" aria-describedby="kitchen-finish-message" closedby="none" data-no-auto-link>
      <header class="kitchen-finish-header"><h2 id="kitchen-finish-title">Keep your PAX command</h2><button type="button" class="icon-button" id="kitchen-finish-x" aria-label="Close completed setup">&times;</button></header>
      <p id="kitchen-finish-message">Copy your command or save a text file before closing. Closing clears your setup.</p>
      <div class="kitchen-finish-actions"><button type="button" class="button button-primary" id="kitchen-finish-copy">Copy PAX Command</button><button type="button" class="button button-secondary" id="kitchen-finish-save">Save to text file</button></div>
      <p id="kitchen-finish-status" role="status"></p>
      <footer class="kitchen-finish-footer"><button type="button" class="button button-secondary" id="kitchen-finish-close">Close</button></footer>
    </dialog>
  </div>`;
}
function kitchenPanel(compact = false) {
  return `<div class="kitchen-panel${compact ? ' compact' : ''}" data-no-auto-link>${productLogo('mini-kitchen')}<div>${eyebrow('From your choices to report data')}<h3>Mini-Kitchen</h3><p>Need data for AI-in-One? Its guided Mini-Kitchen builds the PAX command from your dates, people and destination, so you do not have to write it yourself. You or IT then run PAX to prepare the data.</p><div class="button-row">${button('Set up AIO with Mini-Kitchen', 'get-started.html')}${external('Full Mini-Kitchen: saved recipes and other dashboards', release.pax.href)}</div><p class="action-purpose">Stay with the AIO guide for this report. The full site is optional when you want to save a reusable recipe or configure other dashboards.</p></div></div>`;
}

function heroActions() {
  return `<nav class="hero-actions" aria-label="Start exploring AI-in-One"><a class="button button-primary" href="get-started.html" aria-describedby="hero-action-reasons"><span aria-hidden="true">&#128640;</span>Setup Guide</a><a class="button button-secondary" href="explore.html" aria-describedby="hero-action-reasons"><span aria-hidden="true">&#129517;</span>Explore dashboard</a><a class="button button-secondary walkthrough-button" href="#watch" aria-describedby="hero-action-reasons"><span aria-hidden="true">&#128250;</span>Watch walkthrough</a></nav><p id="hero-action-reasons" class="action-purpose">Set up your own report, browse its pages before collecting data, or watch how the setup works.</p>`;
}

function home() {
  return `<section class="hero"><div class="hero-layout container"><div class="hero-copy">${eyebrow('AI-in-One / v2.0')}<h1>Your Copilot story.<br><span class="gradient-text">The whole picture.</span></h1><p class="lead">See how people use Microsoft 365 Copilot, Copilot Chat and agents. Find the patterns. Start better conversations.</p>${heroActions()}<div class="hero-proof"><span>${icon('check')}Free &amp; open source</span><span>${icon('shield')}Team-level by default</span><span>${icon('chart')}One connected view</span></div></div><div class="hero-stage"><div class="stage-label"><span class="status-dot"></span>What's New in AI-in-One<span class="tiny-tag">Video overview</span></div><div class="product-frame">${overviewVideo(true)}</div><div class="stage-note">${icon('people')}Your teams. Your context. Your next conversation.<span>Fictional example data</span></div></div></div></section>
  <div class="trust-band"><div class="container trust-inner"><span>Built by the ${team}</span><span>Part of ${external('Analytics Hub', 'https://aka.ms/Analytics-Hub')}</span><span>Your data stays in your environment</span></div></div>
  <section class="section section-tinted" ${searchAttr('watch', 'Watch the setup walkthrough')}><div class="container two-columns align-center"><div>${eyebrow('See how it comes together')}<h2>Set up AI-in-One.<br>Follow the walkthrough.</h2><p class="lead">Watch the setup steps, then follow the written guide at your own pace.</p><div class="button-row">${button('Open the Setup Guide', 'get-started.html')}</div></div><div>${setupVideo()}</div></div></section>
  <section class="section container" ${searchAttr('questions', 'Questions the dashboard answers')}><div class="section-heading">${eyebrow('Start with a question')}<h2>Less hunting for data.<br>More knowing where to look.</h2><p>One connected view of adoption, habits and agent engagement. Not another disconnected seat count.</p></div><div class="question-grid">
  <a class="question-card" href="explore.html?page=explorer"><span class="icon-tile blue">${icon('people')}</span><h3>Who is using Copilot?</h3><p>Explore a department, a manager's team or the whole company. Your selected teams and dates carry across the report, so you can compare views without starting over.</p><span class="card-link">Start with Explorer ${icon('arrow')}</span></a>
  <a class="question-card" href="explore.html?page=m365-habit"><span class="icon-tile purple">${icon('clock')}</span><h3>Is it becoming a habit?</h3><p>Look beyond the first try. Understand active days, repeat use and the weekly rhythm.</p><span class="card-link">Explore habits ${icon('arrow')}</span></a>
  <a class="question-card" href="explore.html?page=agent-health"><span class="icon-tile teal">${icon('agent')}</span><h3>Which agents deserve attention?</h3><p>Find the agents people come back to, understand their audience and plan a conversation with their owners.</p><span class="card-link">Look at agent health ${icon('arrow')}</span></a></div></section>
  <section class="section section-tinted" ${searchAttr('highlights', 'Dashboard highlights')}><div class="container"><div class="section-heading horizontal"><div>${eyebrow('A closer look')}<h2>Follow the question.<br>Not the navigation.</h2></div><div class="section-aside"><p>Here are a few starting points. Explore the full report tour for more questions, views and examples.</p><a class="text-link" href="explore.html">Explore all report views ${icon('arrow')}</a></div></div><div class="showcase" data-showcase><div class="showcase-tabs" role="tablist" aria-label="Dashboard highlights">
  <button role="tab" id="highlight-overview" aria-selected="true" aria-controls="highlight-panel" data-image="01-copilot-usage-explorer.png" data-title="Your organization, in focus." data-description="Find a team, choose your dates and bring people, prompts, sessions and agents into one view.">01 <span>See the whole picture</span>${icon('arrow')}</button>
  <button role="tab" id="highlight-agents" aria-selected="false" aria-controls="highlight-panel" tabindex="-1" data-image="10-agent-details.png" data-title="Every agent has a story." data-description="Understand an agent's reach, activity and repeat users. Keep the team and dates you selected.">02 <span>Go deeper on agents</span>${icon('arrow')}</button>
  <button role="tab" id="highlight-license" aria-selected="false" aria-controls="highlight-panel" tabindex="-1" data-image="02-license-prioritization.png" data-title="A better licensing conversation." data-description="Compare teams using clear activity patterns. Consider role, need, cost and feedback alongside the numbers.">03 <span>Find where to focus</span>${icon('arrow')}</button></div><div class="showcase-content" id="highlight-panel" role="tabpanel" aria-labelledby="highlight-overview"><div class="showcase-heading"><h3>Your organization, in focus.</h3><p>Find a team, choose your dates and bring people, prompts, sessions and agents into one view.</p></div><img id="showcase-image" src="assets/screenshots/01-copilot-usage-explorer.png" alt="Copilot Usage Explorer with fictional data" loading="lazy" width="1280" height="792"></div></div></div></section>
  <section class="section container" ${searchAttr('journey', 'From data to a conversation')}><div class="section-heading centered">${eyebrow('From data to a conversation')}<h2>A clear path from the start.</h2><p>A simple setup guide, with the right tools for each step.</p></div><div class="journey"><article><span class="step-number">01</span><h3>Choose your path</h3><p>Connect data in Fabric OneLake, SharePoint or a local folder. Or try fictional sample data first.</p></article><article><span class="step-number">02</span><h3>Bring your data together</h3><p>Use ${miniKitchenStart} to get PAX and prepare CSV files or Fabric OneLake tables. Fabric OneLake notebook collection is a separate option.</p></article><article><span class="step-number">03</span><h3>Share with confidence</h3><p>Choose reporting detail that fits your policies, set viewer access and refresh after data preparation finishes.</p></article></div><div class="centered button-row">${button('Follow the setup guide', 'get-started.html')}${button('Try sample data first', 'get-started.html#sample', 'secondary')}</div></section>
  <section class="section container" ${searchAttr('responsible-reporting', 'Responsible interpretation and privacy')}><div class="privacy-feature"><div>${eyebrow('Context matters')}<h2>Useful insights.<br>Responsible interpretation.</h2><p class="lead">Activity is a starting point for a conversation. It is not a measure of employee performance, answer quality or time saved.</p><div class="button-row">${button('Understand privacy and access', 'learn.html#privacy', 'secondary', 'shield')}</div></div><div class="privacy-cards"><article>${icon('people')}<div><h3>Team-level reporting by default</h3><p>The default Minimum Group Size is 3 eligible people, not 3 active users. A setting of 1 enables individual activity only when your organization's policies permit it.</p></div></article><article>${icon('shield')}<div><h3>Access is a separate control</h3><p>Row-level security limits whose data viewers see. A grouping threshold does not replace permissions or anonymize your data.</p></div></article><article>${icon('book')}<div><h3>No mystery metrics</h3><p>Plain-English definitions explain prompts, sessions, overlapping groups and recorded license history.</p></div></article></div></div></section>
  <section class="section container"><div class="final-cta"><div>${eyebrow('Your next step')}<h2>Make the first view your own.</h2><p>Use the setup guide to choose your data route and connect the report. Already know what you need? Go straight to the templates, sample files and guides.</p></div><div class="button-row">${button('Set up AI-in-One', 'get-started.html')}${button('Just need a download?', 'downloads.html', 'secondary', 'download')}</div></div></section>`;
}

function setup(step) {
  return renderSetup({ e, icon, productLogo, editionLogo, eyebrow, pageHead, button, external, dl, note, release, policy, miniKitchenPanel, collectionOptions: renderCollectionOptions(), reference, navigation }, step);
}

function overviewHighlights() {
  return `<section class="section container feature-story" ${searchAttr('new-explorer', 'What is new: a connected Explorer')}><div class="feature-story-copy">${eyebrow('What is new in v2.0')}<h2>Your question sets the direction.</h2><p class="lead">Copilot Usage Explorer brings people, prompts, sessions and agents into one starting view. Choose a manager or department, set your dates and carry those selections through the report.</p><a class="text-link" href="user-guide.html?page=explorer">See Explorer in the User Guide ${icon('arrow')}</a></div><button class="screenshot-button" data-zoom="assets/screenshots/01-copilot-usage-explorer.png" data-title="Copilot Usage Explorer" aria-label="Enlarge Explorer screenshot"><img src="assets/screenshots/01-copilot-usage-explorer.png" alt="Copilot Usage Explorer with fictional data" width="1280" height="792" loading="lazy"><span>${icon('search')}Take a closer look</span></button></section>
  <section class="section section-tinted" ${searchAttr('new-agents', 'What is new: agent context and comparisons')}><div class="container feature-story reverse"><img class="feature-image" src="assets/screenshots/10-agent-details.png" alt="Agent Details report with fictional data" width="1280" height="792" loading="lazy"><div class="feature-story-copy">${eyebrow('More context, less guesswork')}<h2>Understand the audience.<br>Explain the activity.</h2><div class="feature-notes"><div><h3>Deeper agent context</h3><p>Explore audience, repeat use, catalog information, creator and developer details, and clear review signals.</p></div><div><h3>Clearer comparisons</h3><p>Read prompts beside sessions, see the month used for habit summaries, and compare paid and free activity in context.</p></div><div><h3>Responsible detail</h3><p>Team-level reporting remains the default. Recorded license history adds context without claiming exact assignment dates.</p></div></div><a class="text-link" href="user-guide.html?page=agent-details">Explore Agent Details ${icon('arrow')}</a></div></div></section>
  <section class="section container" ${searchAttr('overview-video', 'Dashboard overview video')}><div class="section-heading horizontal"><div>${eyebrow('Watch the dashboard overview')}<h2>See the experience.</h2></div><div class="section-aside"><p>A general introduction for anyone, whether or not you used an earlier version.</p>${dl('whats-new', "Download What's New in v2.0 (PDF)")}</div></div>${overviewVideo()}</section>
  <section class="section container" ${searchAttr('setup-walkthrough', 'Setup walkthrough and data connections')}><div class="soft-cta"><div><h2>Ready to make it yours?</h2><p>Fabric OneLake, SharePoint and Local CSV share the report experience. Start with the Setup Guide to choose a route and watch the separate setup walkthrough.</p></div>${button('Open the Setup Guide', 'get-started.html')}</div></section>`;
}
function overview() {
  const markup = home();
  const split = markup.indexOf('<div class="trust-band">');
  if (split < 0) throw new Error('Overview hero boundary is missing.');
  return markup.slice(0, split).replace("What's New in AI-in-One", 'AI-in-One dashboard overview') +
    `<nav class="container overview-tabs" role="tablist" aria-label="Overview sections"><a id="overview-tab" href="#overview-content" role="tab" aria-controls="overview-content" aria-selected="true">Overview</a><a id="whats-new-tab" href="#whats-new" role="tab" aria-controls="whats-new" aria-selected="false" tabindex="-1">What's New in v2.0</a></nav><div id="overview-content" role="tabpanel" aria-labelledby="overview-tab" data-overview-panel>${markup.slice(split)}</div><div id="whats-new" role="tabpanel" aria-labelledby="whats-new-tab" data-overview-panel hidden>${overviewHighlights()}</div>`;
}

function tourPanel(p) {
  const calculationNotes = p.technical?.length ? `<details class="tour-calculation-note"><summary>How this is calculated</summary><ul>${p.technical.map(text => `<li>${definedText(text)}</li>`).join('')}</ul></details>` : '';
  const visual = p.image
    ? `<button class="screenshot-button" data-zoom="${e(p.image)}" data-title="${e(p.title)}" aria-label="Enlarge ${e(p.title)} screenshot"><img src="${e(p.image)}" alt="${e(p.title)}, fictional example data" width="1280" height="792"><span>${icon('search')}Enlarge screenshot</span></button><p class="image-caption">Fictional example data. Screenshots show individual detail; templates default to team-level reporting with Minimum Group Size 3.</p>`
    : `<div class="glossary-preview">${icon('book')}<h3>A definition, right when you need it.</h3><p>The in-report Metric Glossary &amp; Guide filters definitions by page.</p>${glossaryButton('Browse the glossary')}</div>`;
  return `<div class="tour-heading">${eyebrow(p.area)}<h2>${e(p.title)}</h2><p class="question-line">${e(p.question)}</p></div>
  <div class="tour-reading-layout"><div class="tour-visual">${visual}</div><div class="tour-explanation"><p class="tour-summary">${definedText(p.summary)}</p><div class="tour-notes"><article><h3>What to look for</h3><ul>${p.bullets.map(b => `<li>${definedText(b)}</li>`).join('')}</ul></article><article class="tip-card"><p class="eyebrow">TRY THIS</p><p>${definedText(p.tip)}</p></article></div>${calculationNotes}${p.caution ? note('Read it in context', definedText(p.caution)) : ''}<p class="definition-hint">Blue terms with a dashed underline open a short definition on hover, focus or tap. The glossary opens here without leaving your place.</p>${glossaryButton()}</div></div>
  <div class="tour-controls"><button class="button button-secondary" data-tour-prev ${p.number === 1 ? 'disabled' : ''}>Previous view</button><span>${p.number} / ${content.tour.length}</span><button class="button button-primary" data-tour-next ${p.number === content.tour.length ? 'disabled' : ''}>Next view ${icon('arrow')}</button></div>`;
}
function explore() {
  return guideHead('tour', 'Find your question.<br><span class="gradient-text">Explore the report.</span>', 'Choose a view, take your time with the screenshot, and read the explanation alongside it. Use the glossary whenever a term needs context.') + `
  <section class="container tour-layout" ${searchAttr('report-tour', 'Explore report views')}><aside class="tour-rail"><label class="search-field">${icon('search')}<input id="tour-search" type="search" placeholder="Find a view or question" aria-label="Find a report view"></label><nav aria-label="Report views" id="tour-nav">${content.tour.map(p => `<a href="#${e(p.id)}" data-tour="${e(p.id)}">${e(p.title)}</a>`).join('')}</nav><p class="empty-state" id="tour-empty" hidden>No matching view. Try "agents", "habit" or "license".</p></aside><div id="tour-detail" class="tour-detail" aria-live="polite">${tourPanel(content.tour[0])}</div></section>
  ${content.tour.map(p => `<template id="tour-template-${e(p.id)}">${tourPanel(p)}</template>`).join('')}
  <noscript><section class="section container"><h2>Complete report tour</h2>${content.tour.map(p => `<article class="section" id="${e(p.id)}"><h2>${e(p.title)}</h2><p>${e(p.question)}</p>${p.image ? `<img src="${e(p.image)}" alt="${e(p.title)}, fictional data" loading="lazy" width="1280" height="792">` : ''}<p>${e(p.summary)}</p><ul>${p.bullets.map(b => `<li>${e(b)}</li>`).join('')}</ul>${p.technical?.length ? `<details class="tour-calculation-note"><summary>How this is calculated</summary><ul>${p.technical.map(text => `<li>${e(text)}</li>`).join('')}</ul></details>` : ''}<p><strong>Try this:</strong> ${e(p.tip)}</p><p><strong>Context:</strong> ${e(p.caution)}</p></article>`).join('')}</section></noscript>
  <section class="section container" ${searchAttr('report-video', 'Watch the report overview')}><div class="section-heading"><h2>See the report in motion.</h2><p>A captioned introduction to the experience, alongside the detailed screenshot tour above.</p></div>${overviewVideo()}</section>
  <section class="section container"><div class="soft-cta"><div><h2>Ready to try it yourself?</h2><p>The fictional sample needs Power BI Desktop, not tenant collection permissions.</p></div>${button('Try sample data', 'get-started.html#sample')}</div></section>`;
}

function historyIllustration() {
  return `<figure class="license-story" aria-labelledby="history-caption"><div class="story-person">${icon('people')}<strong>One person, recorded over time</strong><span>Illustrative example</span></div><div class="observation-row"><div class="observation free"><span>Monday's collection</span><strong>Recorded as unlicensed</strong><p>Collection showed no Microsoft 365 Copilot license.</p></div><div class="observation paid"><span>Friday's collection</span><strong>Recorded as licensed</strong><p>Collection showed a Microsoft 365 Copilot license.</p></div></div><div class="observation-gap"><span></span><p>A change happened somewhere in between.<br><strong>The exact assignment time is not known.</strong></p><span></span></div><div class="history-outcomes"><div>${icon('people')}<strong>1 person</strong><span>in the overall total</span></div><div>${icon('layers')}<strong>Both license groups</strong><span>can include this person in the same period</span></div></div><figcaption id="history-caption">Collection records observations, not a complete license-assignment log. Without history, the report uses the supplied snapshot.</figcaption></figure>`;
}
function learn() {
  return guideHead('learn', 'Read the numbers.<br><span class="gradient-text">Keep the context.</span>', 'Plain-English guidance to help you explain what the report shows, what it does not, and who should see it.') + `
  <nav class="container jump-nav" aria-label="Learning topics"><a href="#reading">Read the report</a><a href="#privacy">Privacy and access</a><a href="#history">License history</a><a href="#glossary">Metric glossary</a></nav>
  <section class="section container" ${searchAttr('reading', 'How to read the report')}><div class="editorial-list"><article><span>${icon('people')}</span><div><h2>People, prompts and sessions are different.</h2><p>One person can send several prompts in a conversation and return to it later. The same person can also use chat and agents. Adding daily counts or experience groups can count that person more than once.</p></div></article><article><span>${icon('clock')}</span><div><h2>Habit summaries focus on one completed month.</h2><p>Look at the month named on the habit page. If your selected dates end in October, the habit summary describes September. Other activity tables may cover your entire selected date range, so their totals will not necessarily match that one-month summary.</p></div></article><article><span>${icon('chart')}</span><div><h2>Activity starts a conversation. It does not give a verdict.</h2><p>More sessions could mean useful work, retries or a difficult task. Scores and inferred use cases do not measure employee performance, answer quality or actual time saved.</p></div></article></div></section>
  <section class="section section-tinted" ${searchAttr('privacy', 'Minimum Group Size and row-level security')}><div class="container"><div class="section-heading">${eyebrow('Share responsibly')}<h2>What you display.<br>Who can see it.</h2><p>Minimum Group Size and row-level security do different jobs. Set up both.</p></div><div class="two-columns"><article class="panel"><h3>Minimum Group Size</h3><div class="thresholds"><div><strong>3</strong><span>Default<br>team-level reporting</span></div><div><strong>1</strong><span>Individual activity<br>when your policies permit</span></div></div><p>The threshold counts eligible people in the selected group, including those with no activity. A team of 20 with two active users can show aggregate results at the default setting; a team of two cannot.</p><p>${policy}</p><p>This is a display rule, not anonymization. Govern access to the underlying data, exports and Power BI model permissions separately.</p><details><summary>How to change the setting</summary><p>At first template load, enter Minimum Group Size before selecting Load. Later, use Home &gt; Transform data &gt; Manage parameters &gt; Minimum Group Size. Apply changes and clear old filters.</p><img src="assets/screenshots/minimum-group-size-first-load.png" alt="Initial template dialog with Minimum Group Size set to 3" loading="lazy"></details></article>
  <article class="panel"><h3>Row-level security (RLS)</h3><p>These are the <strong>two named security roles</strong> included in the Power BI model, not titles or job descriptions. Your report owner adds people or security groups to them.</p><div class="role-definition"><span class="tiny-label">Power BI role name</span><h4><code>Reporting hierarchy</code></h4><p>Viewers see themselves and their valid direct and indirect reports. If a viewer's sign-in does not match the directory, this role gives them no data.</p></div><div class="role-definition"><span class="tiny-label">Power BI role name</span><h4><code>All data viewers</code></h4><p>Members can see the whole dataset. Use this role only where full access is appropriate under your policies. Adding the same person to Reporting hierarchy does not restrict that full access.</p></div><p>In Power BI Service, open the semantic model &gt; Security, assign members, and Save. Share as Viewer or app consumer and test real viewer accounts. Workspace administrators and contributors are not restricted in the same way.</p></article></div>${note('Protect the source too.', 'Report roles do not protect CSV files, notebooks, SQL or Fabric OneLake access. Give each source and refresh account only the access it needs.', 'privacy')}</div></section>
  <section class="section container" ${searchAttr('history', 'What license history can and cannot tell you')}><div class="two-columns align-center"><div>${eyebrow('Understand license history')}<h2>When we saw a license.<br>Not when it was assigned.</h2><p>If collection records someone without a license on Monday and with a license on Friday, we know their recorded status changed. We do not know exactly when it changed between those collections.</p><p>When history is retained, the report can use those recorded states to group activity. The person still counts once in the overall total, but may appear in both paid and free groups during the selected period. Do not add those groups to find the total number of people.</p><p>Without recorded history, you see the supplied snapshot. Missing license information stays <strong>Unknown</strong>; it is not treated as "unlicensed." Organization and reporting relationships use the latest person information supplied.</p></div>${historyIllustration()}</div></section>
  ${glossarySection()}
  <section class="section container"><div class="soft-cta"><div><h2>Prefer a guide you can keep?</h2><p>Read the interpretation guide or use the storyboard for a leadership conversation.</p></div><div class="button-row">${dl('interpretation')}${dl('storyboard')}</div></div></section>`;
}

const downloadGroups = [
  ['pax-script', 'PAX PowerShell script', 'Download PAX directly, then run it on your approved collection computer. Your browser controls the download folder; no repository visit is needed.'],
  ['sample-data', 'Try fictional sample data', 'Explore AIO before asking IT to collect your organization’s data. Use all three files with the Local CSV template and extract the activity ZIP first.'],
  ['guides', 'Guides and presentations', 'Use the interpretation guide to explain the numbers, and the storyboard to walk colleagues through the report.'],
  ['fabric-onelake-notebooks', 'Fabric OneLake notebooks', 'Your data team uses these to collect and prepare data inside Fabric. They belong to the notebook edition, not the separate PAX Tables route.'],
  ['advanced', 'Advanced data preparation', 'For IT processing existing exports into report-ready data. For an ordinary AIO collection, use the guided Mini-Kitchen instead.']
];
function downloads() {
  return pageHead('Downloads', 'Your next step.<br><span class="gradient-text">The files to get there.</span>', 'Templates, sample data and practical guides, organized around what you want to do.') + `
  <nav class="container jump-nav" aria-label="Download topics"><a href="#templates">Report templates</a>${downloadGroups.map(([id, title]) => `<a href="#${id}">${e(title)}</a>`).join('')}<a href="#pax">PAX tools</a></nav>
  <section class="section container" ${searchAttr('templates', 'Download report templates')}><div class="section-heading"><h2>Start with your data connection.</h2><p>Download a template and open it in Power BI Desktop. The report experience is the same; the source connection is different.</p></div><div class="template-list">${release.templates.map(t => `<article class="template-row" id="${e(t.id)}"><div class="template-symbol">${editionLogo(t.id)}</div><div class="template-description"><h3>${e(t.title)}</h3><p>${e(t.subtitle)}</p><p class="muted">${e(t.bestFor)}</p><details><summary>Data and refresh details</summary><p>${e(t.source)}</p><p>${e(t.refresh)}</p><p>${e(t.note)}</p></details></div><div class="template-actions">${t.status === 'available' ? button('Download template', t.href, 'primary', 'download') : '<span class="availability-label">Coming soon</span>'}<a href="get-started.html#${e(t.id)}">Setup instructions</a><span class="file-meta">Power BI template &middot; v${e(release.version)}</span></div></article>`).join('')}</div></section>
  <section class="section section-tinted" ${searchAttr('resources', 'Guides, sample data and notebook downloads')}><div class="container"><div class="section-heading horizontal"><div>${eyebrow('Resources by topic')}<h2>Find what you need.</h2></div><label class="search-field">${icon('search')}<input type="search" id="download-search" placeholder="Find a guide, sample or notebook" aria-label="Search downloads"></label></div>${downloadGroups.map(([id, title, text]) => `<section class="download-topic" id="${id}" data-download-group><div class="topic-heading"><h3>${e(title)}</h3><p>${e(text)}</p></div><div class="resource-list">${release.downloads.filter(item => item.group === title).map(item => `<article class="resource-row" id="download-${e(item.id)}" data-search="${e(`${item.title} ${item.description} ${item.kind} ${item.group}`.toLowerCase())}"><span class="file-type">${e(item.kind)}</span><div><h4>${e(item.title)}</h4><p>${e(item.description)}</p></div><a class="icon-button" href="${e(item.href)}" aria-label="Download ${e(item.title)}">${icon('download')}</a></article>`).join('')}</div></section>`).join('')}<p class="empty-state" id="downloads-empty" hidden>No matching download. Try "sample", "guide" or "notebook".</p></div></section>
  <section class="section container" ${searchAttr('pax', 'Get PAX through Mini-Kitchen')}>${kitchenPanel()}</section>`;
}

function help() {
  const shortcuts = [
    ['The report is blank', `#help-${slug('Why can a viewer open the report but see no data?')}`],
    ['I need data from IT', 'setup-reference.html#it-request'],
    ['Refresh needs attention', '#topic-refresh']
  ];
  return guideHead('help', 'Find the right answer.<br><span class="gradient-text">Get back to your work.</span>', 'Choose a topic or search all the answers. Practical guidance for setup, missing data, privacy and refresh.') + `
  <section class="container help-entry"><label class="search-field search-large">${icon('search')}<input id="help-search" type="search" placeholder="Search all help, for example blank report or missing names" aria-label="Search all help topics"></label><div class="help-shortcuts"><span>Common starting points</span>${shortcuts.map(([title, href]) => `<a href="${href}">${title}${icon('arrow')}</a>`).join('')}</div></section>
  <section class="section container help-browser" ${searchAttr('answers', 'Browse help by topic')}><nav class="help-topic-nav" aria-label="Help topics"><p class="eyebrow">Choose a topic</p>${helpTopics.map((topic, i) => `<button data-help-category="${topic.category}" aria-pressed="${i === 0}" class="${i === 0 ? 'active' : ''}" aria-controls="help-results">${icon(topic.icon)}<span>${e(topic.title)}</span><small>${content.faqs.filter(item => item.category === topic.category).length}</small></button>`).join('')}<button data-help-category="All" aria-pressed="false" aria-controls="help-results">${icon('search')}<span>All topics</span><small>${content.faqs.length}</small></button><a class="text-link" href="setup-reference.html">IT setup &amp; permissions ${icon('arrow')}</a></nav>
  <div id="help-results"><p id="help-results-status" class="result-count" aria-live="polite"></p>${helpTopics.map(topic => `<section class="help-topic-panel" id="topic-${topic.category.toLowerCase()}" data-help-topic="${topic.category}"><div class="help-topic-heading">${icon(topic.icon)}<div><h2>${e(topic.title)}</h2><p>${e(topic.description)}</p></div></div><div class="faq-list">${content.faqs.filter(item => item.category === topic.category).map(item => `<details class="faq" id="help-${slug(item.q)}" data-category="${e(item.category)}" data-search="${e(`${item.q} ${item.a} ${topic.title}`.toLowerCase())}"><summary>${e(item.q)}</summary><div><p>${e(item.a)}</p>${item.category === 'Setup' ? '<a class="text-link" href="get-started.html">Open the simple setup guide</a>' : item.category === 'Refresh' ? '<a class="text-link" href="setup-reference.html#recurring">First collection and ongoing updates</a>' : ''}</div></details>`).join('')}</div></section>`).join('')}<p class="empty-state" id="help-empty" hidden>No matching answer. Try a shorter phrase or contact the team below.</p></div></section>
  <section class="section section-tinted" ${searchAttr('contact', 'Contact the team or request IT help')}><div class="container support-strip"><div>${eyebrow('A person can help too')}<h2>Still stuck?</h2><p>Tell the ${team} which connection you use, what you were trying to do and the error message. Remove names, tenant details and other private information.</p><div class="button-row">${button('Meet the team', teamUrl, 'secondary')}${external('Report a product issue', 'https://github.com/microsoft/AI-in-One-Dashboard/issues/new/choose')}</div></div><div><h3>Need help from your IT team?</h3><p>Prepare a note to copy into your company's normal request channel, or share the deployment instructions.</p><a class="text-link" href="setup-reference.html#it-request">Prepare a note for IT ${icon('arrow')}</a><a class="text-link" href="setup-reference.html#permissions">IT setup &amp; permissions ${icon('arrow')}</a></div></div></section>
  <section class="section container">${note('Report security concerns privately.', 'Do not post vulnerabilities or sensitive logs in a public issue. Follow <a href="https://aka.ms/SECURITY.md" target="_blank" rel="noopener noreferrer">Microsoft security reporting guidance</a>.', 'privacy')}</section>`;
}
function privacy() {
  return pageHead('Privacy', 'A public guide.<br><span class="gradient-text">Not a data collection service.</span>', 'This website helps you understand and set up AI-in-One. It does not connect to your Microsoft 365 tenant or process your report data.') + `
  <section class="container prose" ${searchAttr('website-privacy', 'Website privacy and external resources')}><h2>What this site does</h2><p>Pages, screenshots and download links are publicly hosted. Report screenshots use fictional data; the star instructions show the public GitHub repository. Search runs in your browser. We do not request file uploads, tenant credentials or Microsoft 365 sign-in.</p><p>The star counter requests the public repository's star count from GitHub without sending credentials. Starring happens on GitHub in a separate tab; this site never signs you in or adds a star on your behalf.</p>
  <h2>Browser storage</h2><p>The site can remember your light or dark theme on your device. Setup pages remember only your edition and collection choice for this tab, not a recipe or command. The command builder holds its entries only while its popup is open. Closing it discards those entries and the command.</p><p>If you choose to continue on the full Mini-Kitchen website, the builder passes your current entries directly to that new tab. They are not put in the address or saved as a recipe by AIO. The full Mini-Kitchen website has its own recipe features.</p><p>No analytics, session replay, advertising trackers or tracking cookies are added by this site. Do not put credentials, tenant data or private file paths in URLs.</p>
  <h2>Hosting, downloads and videos</h2><p>GitHub Pages hosts the website and may process ordinary request metadata under its policies. Downloads come from GitHub-hosted project files. External sites have their own privacy policies.</p><p>The YouTube setup video is not loaded until you select Play; it then uses YouTube's privacy-enhanced embed. The report overview video is hosted by GitHub and loads when played. Video providers may process network information when you play their content.</p><h2>Your report and source data</h2><p>Data collection and reporting happen in your environment using PAX, Fabric OneLake and Power BI. They have their own permissions, logs and storage. Microsoft does not receive access to the data you load simply because you use this template.</p><p>Minimum Group Size controls display detail; it does not anonymize the data. Report security roles do not protect direct access to source files or tables.</p><h2>Responsible use</h2><p>Your organization is responsible for lawful collection, employee-reporting policies, privacy, access, retention, export and sharing. Audit telemetry should not be the only source used for licensing decisions or complete usage reporting. Compare it with the Microsoft 365 admin center and Viva Insights where appropriate.</p><p>The report does not measure employee performance, actual time saved, response quality or business outcomes. AI-in-One is currently available in English.</p><h2>Related policies</h2><p>${external('Microsoft Privacy Statement', 'https://privacy.microsoft.com/privacystatement')} &middot; ${external('GitHub Privacy Statement', 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement')}</p><p>AI-in-One is free and open source under the MIT license. Software and documentation are provided as-is, without warranty.</p></section>`;
}
function whatsNew() {
  return overview();
}

function reference() {
  return renderItRunbook({ e, icon, eyebrow, pageHead, external, button, dl, release, searchAttr });
}

const pages = [
  ['index.html', 'Overview', 'Understand Microsoft Copilot adoption and agent engagement in your organization.', overview],
  ...navigation.pages.map(page => [page.file, 'AI-in-One guided setup', 'Choose, prepare data, build a command, connect and share in one guided popup.', () => setup(page.step)]),
  ['user-guide.html', 'User Guide', 'Explore report views, understand the metrics and get practical help.', explore],
  ['explore.html', 'Explore', 'Find the report view that answers your question.', explore],
  ['learn.html', 'Learn', 'Understand metrics, privacy, security roles and license history.', learn],
  ['downloads.html', 'Downloads', 'Direct templates, sample data, guides and Fabric OneLake resources.', downloads],
  ['help.html', 'Help', 'Practical answers for setup, data, access and refresh.', help],
  ['privacy.html', 'Privacy', 'How this public guide and your reporting environment handle privacy.', privacy],
  ['whats-new.html', "What's New", 'See what is new in AI-in-One v2.0 and watch the walkthroughs.', whatsNew],
  ['setup-reference.html', 'IT deployment runbook', 'App registrations, exact permissions, collection commands, report connections and acceptance checks for IT.', reference]
];
const nav = [['index.html', 'Overview'], ['get-started.html', 'Setup Guide'], ['user-guide.html', 'User Guide']];
const aliases = { 'explore.html': 'user-guide.html', 'whats-new.html': 'index.html' };
const sectionFor = file => ['index.html', 'whats-new.html'].includes(file) ? 'index.html'
  : [...navigation.pages.map(page => page.file), 'setup-reference.html', 'downloads.html'].includes(file) ? 'get-started.html'
    : ['user-guide.html', 'explore.html', 'learn.html', 'help.html'].includes(file) ? 'user-guide.html' : '';
const index = [];
for (const [file, title, description, render] of pages) {
  const body = inlineDefinitions.decorateHtml(linkReferences(collectionLabels(render())))
    .replace(/href="(get-started\.html(?:\?[^"#]*)?(?:#[^"]*)?)"/g, (original, href) => {
      const url = navigation.resolveLegacy(new URL(href.replaceAll('&amp;', '&'), 'https://microsoft.github.io/AI-in-One-Dashboard/'));
      return `href="${e(url.pathname.split('/').pop() + url.search + url.hash)}"`;
    })
    .replaceAll('explore.html', 'user-guide.html').replaceAll('href="whats-new.html"', 'href="index.html#whats-new"');
  if (!aliases[file]) index.push({ title, text: plain(body), summary: description, href: file, type: 'Page' });
  const sections = /<section\b([^>]*\bdata-search-title="[^"]+"[^>]*)>([\s\S]*?)<\/section>/g;
  for (const match of body.matchAll(sections)) {
    const id = match[1].match(/\bid="([^"]+)"/)?.[1];
    const heading = match[1].match(/\bdata-search-title="([^"]+)"/)?.[1];
    if (id && heading && !aliases[file]) index.push({ title: plain(heading), text: plain(match[2]), summary: plain(match[2]).slice(0, 180), href: navigation.pages.some(page => page.step === id) ? file : `${file}#${id}`, type: 'Section' });
  }
  const html = `<!doctype html>
<html lang="en" data-page="${file.replace('.html', '')}" data-section="${sectionFor(file).replace('.html', '')}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script src="assets/theme.js"></script>${navigation.pages.some(page => page.file === file) ? `<script src="${navigationScript}"></script>` : ''}
<title>${e(title)} | AI-in-One v2.0</title><meta name="description" content="${e(description)}"><meta name="color-scheme" content="light dark"><meta property="og:title" content="${e(title)} | AI-in-One v2.0"><meta property="og:description" content="${e(description)}"><meta property="og:type" content="website">
<link rel="canonical" href="https://microsoft.github.io/AI-in-One-Dashboard/${(aliases[file] || file).replace(/^index\.html$/, '')}"><link rel="icon" href="assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${stylesheet}"><script defer src="${contentScript}"></script><script defer src="${definitionScript}"></script><script defer src="${catalogScript}"></script><script defer src="assets/search-index.js"></script><script defer src="${appScript}"></script>${navigation.pages.some(page => page.file === file) ? `<script defer src="${setupScript}"></script><script defer src="${kitchenContractScript}"></script><script defer src="${kitchenScript}"></script>` : ''}${file === 'setup-reference.html' ? `<script defer src="${itRequestScript}"></script>` : ''}
</head><body><a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header"><div class="header-inner container"><a class="brand" href="index.html" aria-label="AI-in-One home">${brand}<span>AI-in-One<small>MICROSOFT COPILOT ANALYTICS</small></span></a><button class="icon-button menu-toggle" id="menu-toggle" aria-label="Open navigation" aria-expanded="false" aria-controls="primary-nav">${icon('menu')}</button><nav id="primary-nav" class="primary-nav" aria-label="Primary">${nav.map(([href, label]) => `<a href="${href}" ${href === sectionFor(file) ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav><div class="header-actions">${external('Analytics Hub', 'https://aka.ms/Analytics-Hub', 'hub-button')}<a class="repo-star-button" id="repo-star-toggle" href="https://github.com/microsoft/AI-in-One-Dashboard" target="_blank" rel="noopener noreferrer" aria-haspopup="dialog" aria-controls="repo-star-dialog" aria-label="Support AI-in-One: see how to star the repository"><span class="repo-star-art" aria-hidden="true"><span class="repo-star-symbol">&#11088;</span><span class="repo-star-spark repo-star-spark-one">&#10022;</span><span class="repo-star-spark repo-star-spark-two">&#10022;</span></span><span class="repo-star-label">Star</span><span id="repo-star-count" class="repo-star-count" title="Open GitHub to see the current star count" aria-label="Open GitHub to see the current star count">&mdash;</span></a><a class="icon-button" href="learn.html#glossary" data-open-glossary aria-label="Open metric glossary" aria-haspopup="dialog">${icon('book')}</a><button class="icon-button" id="site-search-toggle" aria-label="Search the whole site" aria-expanded="false" aria-controls="site-search-dialog">${icon('search')}</button><button class="icon-button" id="theme-toggle" aria-label="Switch color theme">${icon('sun')}</button></div></div></header>
<div class="preview-band"><div class="container"><span class="release-badge">AI-in-One v${e(release.version)}</span><span>Copilot and agent adoption analytics</span><a href="index.html#whats-new">What's New in v2.0 ${icon('arrow')}</a></div></div>
<main id="main">${body}</main>
<footer class="site-footer"><div class="container footer-grid"><div><a class="brand" href="index.html">${brand}<span>AI-in-One</span></a><p>Understand adoption.<br>Ask better questions.<br>Make the next conversation count.</p><p>From the ${team}.</p></div><div><h2>Set up the report</h2><a href="get-started.html">Setup Guide</a><a href="setup-reference.html">IT setup &amp; permissions</a><a href="downloads.html">Templates and downloads</a>${miniKitchenStart}</div><div><h2>Use the report</h2><a href="user-guide.html">User Guide and report tour</a><a href="learn.html">Read the numbers</a><a href="learn.html#glossary" data-open-glossary aria-haspopup="dialog">Metric glossary</a><a href="help.html">Help</a></div><div><h2>More from the team</h2><a href="index.html#whats-new">What's New in v2.0</a>${external('Analytics Hub', 'https://aka.ms/Analytics-Hub')}${external('AI-in-One source repository', 'https://github.com/microsoft/AI-in-One-Dashboard/tree/main')}${external('PAX v2.0 repository', release.pax.repository)}<a href="privacy.html">Website privacy</a></div></div><div class="container footer-bottom"><span>&copy; Microsoft Corporation &middot; MIT licensed &middot; Provided as-is.</span><span>No tenant data is collected by this website.</span></div></footer>
<dialog id="site-search-dialog" class="search-dialog" aria-labelledby="site-search-title"><div class="search-dialog-header"><h2 id="site-search-title">Find your next step.</h2><button class="icon-button" id="close-search" aria-label="Close site search">&times;</button></div><label class="search-field search-large">${icon('search')}<input id="site-search-input" type="search" placeholder="Search templates, setup, metrics or help" aria-label="Search the entire site" autocomplete="off"></label><p class="search-hint" id="site-search-status" aria-live="polite">Search everything. Matching downloads appear first.</p><div id="site-search-results"></div></dialog>
<dialog id="image-dialog" class="image-dialog" aria-label="Enlarged report screenshot"><div class="dialog-toolbar"><strong id="dialog-title">Report screenshot</strong><button class="icon-button" id="close-dialog" aria-label="Close screenshot">&times;</button></div><img id="dialog-image" alt=""><p>Fictional example data. Not connected to your organization.</p></dialog>
<dialog id="repo-star-dialog" class="star-dialog" aria-labelledby="repo-star-title" aria-describedby="repo-star-intro">
<button type="button" class="star-dialog-close" id="repo-star-close" aria-label="Close star instructions">&times;</button>
<div class="star-dialog-body">
<div class="star-hero" aria-hidden="true"><span class="star-hero-spark star-hero-spark-one">&#10022;</span><span class="star-hero-emoji">&#x1F31F;</span><span class="star-hero-spark star-hero-spark-two">&#10022;</span></div>
<h2 id="repo-star-title">Help AI-in-One shine.</h2>
<p id="repo-star-intro">Finding AIO useful? A GitHub star is a simple way to support the project.</p>
<p class="star-benefits">Stars show interest in AIO and can help more people discover it, bringing new users, feedback and contributors. Starring also saves the repository in your GitHub starred list.</p>
<p id="repo-star-status" class="star-count-note" role="status">Loading the public GitHub star count&hellip;</p>
<section class="star-howto" aria-labelledby="repo-star-howto">
<h3 id="repo-star-howto">Add your star on GitHub</h3>
<ol><li>Click the button below to open the AI-in-One repository. Sign in on GitHub if asked.</li><li>On GitHub, find the star control at the top right. Use the examples below to see whether to click it.</li></ol>
<a class="button button-primary star-repo-action" href="https://github.com/microsoft/AI-in-One-Dashboard" target="_blank" rel="noopener noreferrer" aria-describedby="repo-star-new-tab">Open AI-in-One on GitHub ${icon('external')}</a>
<p id="repo-star-new-tab" class="star-new-tab">Opens in a new tab. Your place on this site stays open.</p>
<p class="star-already-warning"><strong>Already see a filled yellow star and &ldquo;Starred&rdquo;?</strong><span>Do not click it again. Clicking <strong>Starred</strong> removes your star. Only click it if you want to unstar the repository.</span></p>
<div class="star-state-grid">
<figure class="star-state"><figcaption>If you see &ldquo;Star&rdquo;</figcaption><img src="${starScreenshots.unstarred}" width="138" height="72" alt="Example GitHub control showing an empty outline star and the word Star." loading="lazy"><p>Outline star.<br>Click once on GitHub to add your star.</p></figure>
<figure class="star-state"><figcaption>If you see &ldquo;Starred&rdquo;</figcaption><img src="${starScreenshots.starred}" width="174" height="72" alt="Example GitHub control showing a filled yellow star and the word Starred." loading="lazy"><p>Filled yellow star.<br>Leave it as it is to keep your star.</p></figure>
</div>
</section>
</div>
</dialog>
<dialog id="glossary-dialog" class="glossary-dialog" aria-labelledby="glossary-dialog-title"><div class="glossary-dialog-header"><div><h2 id="glossary-dialog-title">Metric glossary</h2><p>Definitions for this AIO report. Microsoft reference links provide background, not equivalent formulas.</p></div><button class="icon-button" id="close-glossary" aria-label="Close metric glossary">&times;</button><div class="glossary-dialog-search"></div></div><div class="glossary-dialog-body" tabindex="-1">${file === 'learn.html' ? '' : glossarySection()}</div></dialog>
<div id="definition-tooltip" class="definition-tooltip" role="tooltip" popover="manual"><strong></strong><p></p></div><div id="live-status" class="sr-only" aria-live="polite"></div></body></html>`;
  fs.writeFileSync(path.join(root, file), navigation.pages.some(page => page.file === file) ? paxModalLinks(html) : html);
}
for (const item of [...release.templates.filter(t => t.status === 'available'), ...release.downloads]) {
  index.push({ title: item.title, text: [item.title, item.description, item.subtitle, item.source, item.group, item.kind, item.id].filter(Boolean).join(' '), summary: item.description || item.subtitle, href: item.href, type: 'Download', format: item.kind || 'Power BI template' });
}
for (const item of content.glossary) index.push({ title: item.term, text: `${item.term} ${item.definition} ${item.aliases}`, summary: item.definition, href: `learn.html#term-${slug(item.term)}`, type: 'Definition' });
for (const item of content.faqs) index.push({ title: item.q, text: `${item.q} ${item.a}`, summary: item.a, href: `help.html#help-${slug(item.q)}`, type: 'Help' });
for (const item of content.tour) index.push({ title: item.title, text: `${item.title} ${item.question} ${item.summary} ${item.bullets.join(' ')} ${item.tip} ${item.caution}`, summary: item.question, href: `user-guide.html?page=${item.id}`, type: 'Report view' });
fs.writeFileSync(path.join(root, 'assets', 'search-index.js'), `window.AIO_SEARCH = ${JSON.stringify(index).replace(/</g, '\\u003c')};\n`);
fs.writeFileSync(path.join(root, '404.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found | AI-in-One</title><script src="/AI-in-One-Dashboard/assets/theme.js"></script><link rel="icon" href="/AI-in-One-Dashboard/assets/favicon.svg"><link rel="stylesheet" href="/AI-in-One-Dashboard/${stylesheet}"></head><body><main class="page-head"><div class="container"><p class="eyebrow">A different path</p><h1>This page is not here.</h1><p class="lead">Let's get you back to the report.</p><div class="button-row"><a class="button button-primary" href="/AI-in-One-Dashboard/">Return to AI-in-One</a></div></div></main></body></html>`);
fs.writeFileSync(path.join(root, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.filter(([file]) => !aliases[file]).map(([file]) => `<url><loc>https://microsoft.github.io/AI-in-One-Dashboard/${file === 'index.html' ? '' : file}</loc></url>`).join('')}</urlset>`);
console.log(`Built ${pages.length} pages, 404, sitemap and ${index.length} searchable entries.`);
