#!/usr/bin/env node
// @ts-check
/**
 * Builds AIInOneInstaller.exe: one file a customer downloads and double-clicks. It holds Node.js,
 * the installer and the files it deploys, and unpacks them under %LOCALAPPDATA%\AIInOne the first
 * time it runs.
 *
 * Next to it go the same payload as AIInOneInstaller.zip, and install.ps1, which downloads that
 * zip, checks it and runs it from PowerShell, for organisations that block downloaded exes.
 *
 * Usage: npm run build:exe -- [--out <dir>] [--keep] [--release] [--repo <owner/name>]
 *   --out <dir>   Where to write the exe (default ./dist-exe)
 *   --repo <name> The repo whose releases install.ps1 downloads from (default $GITHUB_REPOSITORY,
 *                 then microsoft/AI-in-One-Dashboard)
 *   --keep        Keep the working folder, to look at what went into the payload
 *   --release     Fail rather than warn when something a published download needs is missing
 *
 * Needs Windows, the installer's dependencies (npm ci), and the .NET Framework C# compiler that
 * ships with Windows.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  EXE_NAME, MIN_NODE, SOURCE_ROOT, fileVersion, installerFile, leakedIds, localIds, nodeVersionOk, payloadId, prunable, sourceFiles, sourcePaths,
  tooLong,
} from './payload.js';
import { SCRIPT_NAME, ZIP_NAME, installScript } from './script.js';
import { sha256File, sha256Line } from './signing.js';
import { REPO as GITHUB_REPO } from '../src/update-check.js';

const INSTALLER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(INSTALLER, '..');
const LAUNCHER = join(INSTALLER, 'packaging', 'launcher');

const { values: opts } = parseArgs({
  options: { out: { type: 'string' }, keep: { type: 'boolean' }, release: { type: 'boolean' }, repo: { type: 'string', default: process.env.GITHUB_REPOSITORY || GITHUB_REPO } },
});

/** @param {string} m */
const step = (m) => process.stdout.write(`\n▸ ${m}\n`);
/** @param {string} m */
const warn = (m) => {
  if (opts.release) throw new Error(m);
  process.stdout.write(`  ! ${m}\n`);
};

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, shell?: boolean }} [o]
 */
function run(cmd, args, o = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...o });
  if (res.error) throw res.error;
  if (res.status) throw new Error(`${[cmd, ...args].join(' ')} failed with exit code ${res.status}.`);
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
const git = (args, cwd = INSTALLER) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const REPO = resolve(git(['rev-parse', '--show-toplevel']).trim());

/**
 * The files under a folder that git tracks or would commit, relative to it. Files marked
 * skip-worktree hold a developer's own settings, so the build takes them as committed.
 * @param {string} dir
 * @returns {{ rel: string, read: () => Buffer }[]}
 */
function tracked(dir) {
  const prefix = relative(REPO, dir).replaceAll('\\', '/');
  /** @param {string} out */
  const lines = (out) => out.split('\0').filter(Boolean);
  const files = [
    ...lines(git(['ls-files', '-v', '-z', '--', prefix], REPO)).map((line) => ({ tag: line[0], path: line.slice(2) })),
    ...lines(git(['ls-files', '-z', '--others', '--exclude-standard', '--', prefix], REPO)).map((path) => ({ tag: '?', path })),
  ]
    .filter(({ tag, path }) => tag === 'S' || existsSync(join(REPO, path)))
    .map(({ tag, path }) => ({
      rel: path.slice(prefix.length + 1),
      read: tag === 'S'
        ? () => execFileSync('git', ['show', `HEAD:${path}`], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 })
        : () => readFileSync(join(REPO, path)),
    }));
  if (!files.length) throw new Error(`git lists no files under ${dir}.`);
  return files;
}

/**
 * @param {string} file
 * @param {string | Buffer} body
 */
function put(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/**
 * Every file under a folder, relative to it, with forward slashes.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll('\\', '/'));
}

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** @param {string} file */
const readIf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

if (process.platform !== 'win32') throw new Error('The exe builds on Windows only.');
if (!nodeVersionOk()) throw new Error(`Build with Node.js ${MIN_NODE.join('.')} or later; the exe ships the Node.js that builds it. This is ${process.versions.node}.`);
const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const TAR = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe');
for (const tool of [CSC, TAR]) if (!existsSync(tool)) throw new Error(`Can't find ${tool}.`);
if (!existsSync(join(INSTALLER, 'node_modules'))) throw new Error(`Run "npm ci" in ${INSTALLER} first.`);

const version = String(readJson(join(INSTALLER, 'package.json')).version);
const commit = git(['rev-parse', 'HEAD']).trim();
const outDir = resolve(opts.out ?? join(INSTALLER, 'dist-exe'));
const work = mkdtempSync(join(realpathSync.native(tmpdir()), 'aiox-'));
const stage = join(work, 'stage');
const stagedInstaller = join(stage, SOURCE_ROOT, 'installer');

try {
  step(`Staging the installer (${version}, ${commit.slice(0, 7)})`);
  for (const f of tracked(INSTALLER)) if (installerFile(f.rel)) put(join(stagedInstaller, f.rel), f.read());
  run('npm ci --omit=dev --no-audit --no-fund', [], { cwd: stagedInstaller, shell: true });

  step('Staging the notebooks, pipeline and Power BI template');
  for (const rel of sourceFiles()) {
    const to = join(stage, SOURCE_ROOT, rel);
    // The installer's own notebooks came with it.
    if (rel.startsWith('installer/')) {
      if (!existsSync(to)) throw new Error(`The staged installer has no ${rel}. Does git track it?`);
      continue;
    }
    const from = join(SOURCE, rel);
    if (!existsSync(from)) throw new Error(`Missing ${from}.`);
    put(to, readFileSync(from));
  }
  const { loadSources } = await import(pathToFileURL(join(stagedInstaller, 'src', 'sources.js')).href);
  const sources = loadSources();
  if (resolve(sources.dir) !== resolve(stage, SOURCE_ROOT)) throw new Error(`The staged installer reads its templates from ${sources.dir}.`);
  for (const key of ['notebooks', 'pipeline', 'modelFile']) {
    if (!sources[key]) throw new Error(`The staged installer can't find its ${key}.`);
  }

  step('Adding Node.js and the licences');
  put(join(stage, 'node', 'node.exe'), readFileSync(process.execPath));
  const nodeLicense = join(dirname(process.execPath), 'LICENSE');
  if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(stage, 'node', 'LICENSE'));
  else {
    warn(`No LICENSE next to ${process.execPath}; pointing to Node.js's licence online instead.`);
    put(join(stage, 'node', 'LICENSE'), `Node.js ${process.version} is licensed under the MIT License, with the third-party licences listed at\nhttps://github.com/nodejs/node/blob/${process.version}/LICENSE\n`);
  }
  copyFileSync(join(SOURCE, 'LICENSE.md'), join(stage, 'LICENSE.txt'));

  step('Leaving out source maps');
  let pruned = 0;
  for (const rel of walk(stage)) {
    if (!prunable(rel)) continue;
    rmSync(join(stage, rel));
    pruned++;
  }
  process.stdout.write(`  ${pruned} files left out\n`);

  step('Checking the payload');
  const files = walk(stage);
  const long = tooLong(files);
  if (long.length) throw new Error(`These paths are too long to unpack and run safely (see MAX_PAYLOAD_PATH in payload.js):\n  ${long.join('\n  ')}`);
  // IDs already in the repo, such as Microsoft Graph's, are public.
  const committed = git(['grep', '-I', '-h', '-o', '-i', '-E', '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'HEAD', '--', ':/']).split('\n');
  const own = readdirSync(INSTALLER).filter((f) => /^aio-install.*\.json$/i.test(f)).map((f) => readIf(join(INSTALLER, f)));
  const ids = localIds(own, committed.map((l) => l.replace(/^HEAD:/, '').trim()));
  for (const rel of files) {
    if (/^node\/|\/node_modules\//.test(rel)) continue;
    const leaked = leakedIds(readFileSync(join(stage, rel), 'latin1'), ids);
    if (leaked.length) throw new Error(`${rel} holds IDs from this computer's own settings: ${leaked.join(', ')}.`);
  }
  process.stdout.write(`  ${files.length} files, none from this computer's settings\n`);

  step('Packing');
  const zip = join(work, 'payload.zip');
  run(TAR, ['-a', '-c', '-f', zip, '-C', stage, 'node', SOURCE_ROOT, 'LICENSE.txt']);
  const zipHash = createHash('sha256').update(readFileSync(zip)).digest('hex');
  const id = payloadId(version, zipHash);
  writeFileSync(join(work, 'payload-id.txt'), id, 'utf8');
  for (const f of ['Launcher.cs', 'app.manifest']) copyFileSync(join(LAUNCHER, f), join(work, f));
  writeFileSync(join(work, 'AssemblyInfo.cs'), [
    'using System.Reflection;',
    '[assembly: AssemblyTitle("AI in One installer")]',
    '[assembly: AssemblyDescription("Sets up the AI in One Dashboard in Microsoft Fabric.")]',
    '[assembly: AssemblyProduct("AI in One")]',
    '[assembly: AssemblyCompany("Microsoft Corporation")]',
    '[assembly: AssemblyCopyright("Copyright (c) Microsoft Corporation. MIT License.")]',
    `[assembly: AssemblyVersion("${fileVersion(version)}")]`,
    `[assembly: AssemblyFileVersion("${fileVersion(version)}")]`,
    `[assembly: AssemblyInformationalVersion("${version}+${commit.slice(0, 7)}")]`,
    '',
  ].join('\r\n'), 'utf8');
  mkdirSync(outDir, { recursive: true });
  const exe = join(outDir, EXE_NAME);
  run(CSC, [
    '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${exe}`, '/win32manifest:app.manifest',
    '/reference:System.IO.Compression.dll',
    '/resource:payload.zip,payload.zip', '/resource:payload-id.txt,payload-id.txt',
    'Launcher.cs', 'AssemblyInfo.cs',
  ], { cwd: work });
  const hash = sha256File(exe);
  writeFileSync(`${exe}.sha256`, sha256Line(hash), 'utf8');
  const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
  process.stdout.write(`\n✓ ${exe}\n  ${mb(readFileSync(exe).length)}, payload ${id}\n  sha256 ${hash}\n`);

  // The same payload for install.ps1, which unpacks it to the same folder the exe would.
  const zipOut = join(outDir, ZIP_NAME);
  copyFileSync(zip, zipOut);
  writeFileSync(`${zipOut}.sha256`, sha256Line(zipHash, ZIP_NAME), 'utf8');
  const zipSize = readFileSync(zip).length;
  // In Azure Cloud Shell, install.ps1 checks out just the installer and the files it deploys from
  // this commit instead, and gets Node.js this version if Cloud Shell's is too old.
  const script = installScript(readFileSync(join(LAUNCHER, SCRIPT_NAME), 'utf8'), {
    version, sha256: zipHash, id, repo: opts.repo, sizeMb: zipSize / 1024 / 1024, commit, nodeVersion: process.versions.node, sourcePaths: sourcePaths(),
  });
  writeFileSync(join(outDir, SCRIPT_NAME), script, 'ascii');
  process.stdout.write(`✓ ${zipOut}\n  ${mb(zipSize)}, sha256 ${zipHash}\n✓ ${join(outDir, SCRIPT_NAME)}, downloading from ${opts.repo}\n`);
} finally {
  if (opts.keep) process.stdout.write(`\nWorking folder: ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
}
