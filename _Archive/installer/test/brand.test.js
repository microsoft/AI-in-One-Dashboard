// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const installer = join(here, '..');
const self = fileURLToPath(import.meta.url);

/** Other products' names, and the GitHub "latest release" link, which is a dashboard release here. */
const OTHER_PRODUCTS = /Analytics ?Hub|AnalyticsHub|analytics[-_]hub|ANALYTICS_HUB|ValueLens|vlens|AH_ROOT|AH_NODE|Cowork|Viva|Workday|Defender|Dataverse|Resource Graph|Rayfin|Agent Evaluator|Consumption Central|consumption|releases\/latest/i;
/** A relative link into a docs/ folder, which AI in One doesn't have. */
const DOCS_LINK = /\]\(docs\/|['"`]docs\//;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === 'node_modules' ? [] : walk(path)) : [path];
  });
}

/** @param {Buffer} data */
const isBinary = (data) => data.subarray(0, 8000).includes(0);

/**
 * Lines of a file to check, with their 1-based numbers. Skips the README's maintainers section, which
 * names the installer this one was ported from on purpose.
 * @param {string} file
 * @returns {[number, string][]}
 */
function lines(file) {
  const data = readFileSync(file);
  if (isBinary(data)) return [];
  const all = data.toString('utf8').split(/\r?\n/).map((line, i) => /** @type {[number, string]} */ ([i + 1, line]));
  if (file !== join(installer, 'README.md')) return all;
  let skipping = false;
  return all.filter(([, line]) => {
    if (/^## /.test(line)) skipping = /^## For maintainers\s*$/.test(line);
    return !skipping;
  });
}

const files = () => [
  ...['src', 'bin', 'assets', 'packaging'].flatMap((d) => walk(join(installer, d))),
  ...['README.md', 'CHANGELOG.md'].map((f) => join(installer, f)).filter((f) => existsSync(f)),
  ...walk(here).filter((f) => f !== self),
];

test('no other product is named in what ships, its docs or its tests', () => {
  const hits = files().flatMap((file) => lines(file)
    .filter(([, line]) => OTHER_PRODUCTS.test(line))
    .map(([n, line]) => `${relative(installer, file).replace(/\\/g, '/')}:${n}: ${line.trim().slice(0, 120)}`));
  assert.deepEqual(hits, []);
});

test('no relative links into a docs folder', () => {
  const hits = files().flatMap((file) => lines(file)
    .filter(([, line]) => DOCS_LINK.test(line))
    .map(([n, line]) => `${relative(installer, file).replace(/\\/g, '/')}:${n}: ${line.trim().slice(0, 120)}`));
  assert.deepEqual(hits, []);
});

test('the checks catch what they should, and skip only the README maintainers section', () => {
  for (const s of ['Analytics Hub', 'analyticshub', 'analytics-hub', 'ANALYTICS_HUB_X', 'ValueLens', 'vlens', 'AH_ROOT', 'Viva Insights', 'Resource Graph', 'credit consumption', 'releases/latest']) {
    assert.match(s, OTHER_PRODUCTS, s);
  }
  assert.doesNotMatch('AI in One', OTHER_PRODUCTS);
  for (const s of ['[x](docs/a.md)', "'docs/a.md'", '"docs/a"', '`docs/a`']) assert.match(s, DOCS_LINK, s);
  assert.doesNotMatch('https://learn.microsoft.com/docs/x', DOCS_LINK);
  assert.ok(files().some((f) => basename(f) === 'fakes.js'), 'the tests are scanned');
  assert.ok(!files().includes(self), 'but not this file');
});
