#!/usr/bin/env node
// @ts-check
/**
 * Checks AIInOneInstaller.exe's signature, then writes or checks its .sha256 and writes the
 * release notes. Run it on the exe that gets published, after any signing, because signing
 * changes the hash.
 *
 * Usage: node packaging/finish-exe.js <exe> [--require-signed] [--check-hash] [--notes <file>] [--repo <owner/name>] [--version <x.y.z>]
 *   --require-signed  Fail if the exe isn't signed by Microsoft Corporation (--publisher to change)
 *   --check-hash      Check the .sha256 next to the exe instead of writing it
 *   --notes <file>    Write the release notes there, for the repo in --repo or $GITHUB_REPOSITORY
 *   --version <x.y.z> The release's installer version, for the PowerShell command in the notes, or
 *                     x.y.z-rc.N for a release candidate (default: this checkout's installer/package.json)
 *
 * A signature that's there but broken, from someone else or untimestamped always fails. Needs
 * Windows to read the signature.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PUBLISHER, RELEASE_VERSION, checkSignature, parseSha256, releaseNotes, sha256File, sha256Line } from './signing.js';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'require-signed': { type: 'boolean' },
    'check-hash': { type: 'boolean' },
    publisher: { type: 'string', default: PUBLISHER },
    notes: { type: 'string' },
    repo: { type: 'string', default: process.env.GITHUB_REPOSITORY },
    version: { type: 'string' },
  },
});

const inActions = process.env.GITHUB_ACTIONS === 'true';
/**
 * @param {string} m
 * @returns {never}
 */
function fail(m) {
  process.stderr.write(`${inActions ? '::error::' : '✗ '}${m}\n`);
  process.exit(1);
}

if (positionals.length !== 1) fail('Give the path to the exe.');
const exe = resolve(positionals[0]);
if (!existsSync(exe)) fail(`Can't find ${exe}.`);
if (process.platform !== 'win32') fail('Reading the signature needs Windows.');

/** @returns {import('./signing.js').Signature} */
function readSignature() {
  const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:FINISH_EXE; '
    + '[pscustomobject]@{ status = [string]$s.Status; signer = $s.SignerCertificate.Subject; timestamper = $s.TimeStamperCertificate.Subject } | ConvertTo-Json -Compress';
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, FINISH_EXE: exe },
  });
  if (res.error) throw res.error;
  if (res.status) fail(`Get-AuthenticodeSignature failed: ${res.stderr.trim()}`);
  return JSON.parse(res.stdout);
}

const sig = readSignature();
const verdict = checkSignature(sig, { publisher: opts.publisher });
if (verdict.signed && !verdict.ok) fail(`${basename(exe)} can't be published: ${verdict.problems.join('; ')}.`);
if (!verdict.signed) {
  const m = `${basename(exe)} isn't signed, so Edge and SmartScreen will warn people who download it.`;
  if (opts['require-signed']) fail(m);
  process.stdout.write(`${inActions ? '::warning::' : '! '}${m}\n`);
} else {
  process.stdout.write(`✓ Signed by ${opts.publisher}, timestamped by ${sig.timestamper}\n`);
}

const hash = sha256File(exe);
const hashFile = `${exe}.sha256`;
if (opts['check-hash']) {
  const listed = existsSync(hashFile) ? parseSha256(readFileSync(hashFile, 'utf8')) : undefined;
  if (!listed) fail(`${basename(hashFile)} is missing or holds no SHA-256.`);
  if (listed !== hash) fail(`${basename(hashFile)} says ${listed}, but the exe's SHA-256 is ${hash}.`);
  process.stdout.write(`✓ ${basename(hashFile)} matches\n`);
} else {
  writeFileSync(hashFile, sha256Line(hash, basename(exe)), 'utf8');
  process.stdout.write(`✓ Wrote ${basename(hashFile)}\n`);
}
process.stdout.write(`  sha256 ${hash}\n`);

if (opts.notes) {
  if (!opts.repo) fail('--notes needs --repo or $GITHUB_REPOSITORY.');
  // The version names the release, whose install.ps1 the notes link to.
  const version = opts.version ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (!RELEASE_VERSION.test(version)) fail(`"${version}" isn't an x.y.z or x.y.z-rc.N version.`);
  writeFileSync(opts.notes, releaseNotes({ repo: opts.repo, sha256: hash, signed: verdict.signed, publisher: opts.publisher, version }), 'utf8');
  process.stdout.write(`✓ Wrote the release notes to ${opts.notes}\n`);
}

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `signed=${verdict.signed}\nsha256=${hash}\n`);
