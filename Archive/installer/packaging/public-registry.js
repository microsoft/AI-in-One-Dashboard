#!/usr/bin/env node
// @ts-check
/**
 * Points package-lock.json files at the public npm registry. Run in CI before "npm ci": the
 * locks may resolve through Microsoft's internal mirror of it, which GitHub's runners can't reach.
 * The packages and their integrity hashes are the same.
 *
 * Usage: node packaging/public-registry.js <package-lock.json>...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { publicRegistry } from './registry.js';

const files = process.argv.slice(2);
if (!files.length) throw new Error('Name the package-lock.json files to rewrite.');
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const after = publicRegistry(before);
  writeFileSync(file, after, 'utf8');
  process.stdout.write(`${file}: ${before === after ? 'already public' : 'now uses the public registry'}\n`);
}
