// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from '../packaging/signing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const skip = process.platform !== 'win32' || !existsSync(CSC) ? 'needs Windows and the .NET Framework C# compiler' : false;
/** The installer's user guide, which the launchers and the release notes link to. */
const README = join(HERE, '..', 'README.md');

/**
 * The anchors GitHub gives a Markdown file's headings: lower case, punctuation dropped, spaces as hyphens.
 * @param {string} md
 */
function headingAnchors(md) {
  const prose = md.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  return new Set([...prose.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)]
    .map((m) => m[1].toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')));
}

/** @returns {string} */
function readReadme() {
  assert.ok(existsSync(README), 'installer/README.md, the user guide the launchers link to, is missing');
  return readFileSync(README, 'utf8');
}

test('launcher: quotes arguments, refuses unsafe entries, unpacks past 260 characters, waits for a held unpack and keeps the PC awake', { skip }, () => {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'aiol-'));
  try {
    const exe = join(dir, 'check.exe');
    const sources = [join(HERE, '..', 'packaging', 'launcher', 'Launcher.cs'), join(HERE, 'launcher-check.cs')];
    const built = spawnSync(CSC, ['/nologo', '/target:exe', `/out:${exe}`, '/main:LauncherCheck', '/reference:System.IO.Compression.dll', ...sources], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const res = spawnSync(exe, [dir], { encoding: 'utf8', windowsHide: true });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^ok$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher: stays awake while the installer runs, and lets the PC sleep again after', () => {
  const src = readFileSync(join(HERE, '..', 'packaging', 'launcher', 'Launcher.cs'), 'utf8');
  const run = src.slice(src.indexOf('private static int Run('), src.indexOf('private static void Unpack('));
  const on = run.indexOf('KeepAwake(true);');
  const start = run.indexOf('Process.Start(psi)');
  const off = run.indexOf('KeepAwake(false);');
  assert.ok(on > 0 && on < start, 'turned on before the installer starts');
  assert.ok(off > start && /finally\s*\{\s*KeepAwake\(false\);/.test(run), 'reset in a finally block, after it exits');
  assert.match(src, /SetThreadExecutionState\(on \? AwakeFlags : EsContinuous\)/);
});

test('launcher: a node.exe blocked by device policy says what to do, with links that exist', () => {
  const src = readFileSync(join(HERE, '..', 'packaging', 'launcher', 'Launcher.cs'), 'utf8');
  assert.match(src, /try \{ started = Process\.Start\(psi\); \}\s*catch \(Win32Exception e\)\s*\{\s*if \(!BlockedByPolicy\(e\.NativeErrorCode\)\) throw;\s*throw new InvalidOperationException\(PolicyMessage\(psi\.FileName\)\);/);
  const doc = readReadme();
  assert.match(doc, /^## IT-approved Node\.js$/m, '#it-approved-nodejs');
  assert.match(doc, /^## Locked-down tenant \/ Azure Cloud Shell$/m, '#locked-down-tenant--azure-cloud-shell');
  assert.doesNotMatch(src, /ExecutionPolicy|Bypass|Run anyway|Keep anyway|AllSigned/i);
});

test('launcher: every section the launchers and release notes link to is in the user guide', () => {
  const cs = readFileSync(join(HERE, '..', 'packaging', 'launcher', 'Launcher.cs'), 'utf8');
  const ps = readFileSync(join(HERE, '..', 'packaging', 'launcher', 'install.ps1'), 'utf8');
  const notes = [true, false].flatMap((signed) => [undefined, '1.2.3', '1.2.3-rc.1']
    .map((version) => releaseNotes({ repo: 'octo/hub', sha256: '0'.repeat(64), signed, version })));
  const links = new Set([
    ...[...cs.matchAll(/Docs \+ "#([\w-]+)/g)].map((m) => m[1]),
    ...[...ps.matchAll(/(?:README\.md|\$docs)#([\w-]+)/g)].map((m) => m[1]),
    ...notes.flatMap((n) => [...n.matchAll(/README\.md#([\w-]+)/g)].map((m) => m[1])),
  ]);
  for (const a of ['it-approved-nodejs', 'locked-down-tenant--azure-cloud-shell', 'without-the-exe', 'from-powershell']) assert.ok(links.has(a), a);
  for (const text of [cs, ps, ...notes]) assert.doesNotMatch(text, /docs\/INSTALL\.md/);
  const anchors = headingAnchors(readReadme());
  for (const a of links) assert.ok(anchors.has(a), `installer/README.md has no heading for #${a}`);
});

test('launcher: headings get the anchors GitHub gives them', () => {
  const md = '# AI in One installer\n## From PowerShell\n## IT-approved Node.js\n## Locked-down tenant / Azure Cloud Shell ##\n```\n# not a heading\n```\n';
  assert.deepEqual([...headingAnchors(md)], ['ai-in-one-installer', 'from-powershell', 'it-approved-nodejs', 'locked-down-tenant--azure-cloud-shell']);
});

test('launcher: a held unpack folder is retried on both errors Windows gives, not a failed start', () => {
  const src = readFileSync(join(HERE, '..', 'packaging', 'launcher', 'Launcher.cs'), 'utf8');
  const unpack = src.slice(src.indexOf('private static void Unpack('), src.indexOf('internal static readonly int[] MoveWaits'));
  assert.match(unpack, /MoveIntoPlace\(partial, root, MoveWaits\);\s*\}/);
  const move = src.slice(src.indexOf('internal static void MoveIntoPlace('), src.indexOf('internal static string BusyMessage('));
  assert.match(move, /catch \(IOException e\) \{ failure = e; \}\s*catch \(UnauthorizedAccessException e\) \{ failure = e; \}/);
  assert.ok(move.indexOf('File.Exists(marker)') < move.indexOf('Thread.Sleep('), 'checks for a copy that finished first before each wait');
});
