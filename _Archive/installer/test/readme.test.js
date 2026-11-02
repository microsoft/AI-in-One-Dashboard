// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(installer, '..');
const { version } = JSON.parse(readFileSync(join(installer, 'package.json'), 'utf8'));
/** A release tag with its version. The bare `installer-v` prefix, as in `?q=installer-v`, isn't one. */
const PIN = /installer-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/g;

/** @param {string} text */
const pins = (text) => [...text.matchAll(PIN)].map((m) => m[1]);

test('installer/README.md pins the release this package is', () => {
  const found = pins(readFileSync(join(installer, 'README.md'), 'utf8'));
  assert.ok(found.length > 0, 'it links at least one installer release');
  assert.deepEqual([...new Set(found)], [version]);
});

test('the repo READMEs pin the same release, where they pin one', () => {
  for (const file of [join(repo, 'README.md'), join(repo, 'Classic Editions', '3. Fabric', 'README.md')]) {
    if (!existsSync(file)) continue;
    for (const v of pins(readFileSync(file, 'utf8'))) assert.equal(v, version, file);
  }
});

test('only a tag with a version counts as a pin', () => {
  assert.deepEqual(pins('`installer-v` tags, ?q=installer-v&expanded=true'), []);
  assert.deepEqual(pins('download/installer-v0.1.0/install.ps1 and installer-v1.2.3-beta.1 too'), ['0.1.0', '1.2.3-beta.1']);
});
