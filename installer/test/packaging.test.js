// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { NOTEBOOKS, NOTEBOOKS_DIR } from '../src/catalog.js';
import { DEFAULT_SOURCE_DIR, PIPELINE_TEMPLATE } from '../src/sources.js';
import { MODEL_TEMPLATE } from '../src/transform/model.js';
import {
  EXE_NAME, MAX_NATIVE_PATH, MAX_PAYLOAD_PATH, MIN_NODE, MIRROR_REGISTRY, PUBLIC_REGISTRY, SOURCE_ROOT, fileVersion, installerFile, leakedIds,
  localIds, nodeVersionOk, payloadId, prunable, publicRegistry, sourceFiles, sourcePaths, tooLong,
} from '../packaging/payload.js';
import { SCRIPT_NAME, ZIP_NAME } from '../packaging/script.js';

const CLASSIC = 'Classic Editions/3. Fabric';
const EXE = 'AIInOneInstaller.exe';
const ARCHIVED = /(^|\/)archive\/|Archived Templates/i;
const WORKFLOWS = ['installer-tests.yml', 'installer-exe.yml'];

/** @param {string} rel  Relative to the repo root. */
const repoFile = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
/** @param {string} s */
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('packaging: ships every file the installer deploys, and nothing archived', () => {
  const files = sourceFiles();
  assert.ok(files.includes(`${CLASSIC}/pipelines/CopilotAdoptionPipeline.DataPipeline/pipeline-content.json`));
  assert.ok(files.includes(`${CLASSIC}/AI-in-One Dashboard - Fabric.pbit`));
  assert.ok(files.includes(`${CLASSIC}/notebooks/Copilot_Audit_Log_Direct_Ingester.ipynb`));
  assert.ok(files.includes('installer/assets/notebooks/AIO_Data_Check.ipynb'));
  // Taken from the lists the installer deploys from, so the two can't drift.
  assert.ok(files.includes(PIPELINE_TEMPLATE.replaceAll('\\', '/')));
  assert.ok(files.includes(MODEL_TEMPLATE));
  for (const nb of NOTEBOOKS) assert.ok(files.includes(posix.join(nb.dir ?? NOTEBOOKS_DIR, nb.file)), nb.file);
  assert.equal(files.length, NOTEBOOKS.length + 2, 'the notebooks, the pipeline and the Power BI template');
  assert.equal(new Set(files).size, files.length, 'no file twice');
  assert.equal(files.filter((f) => f.startsWith(`${CLASSIC}/notebooks/`)).length, 3, 'the Classic notebooks');
  assert.equal(files.filter((f) => f.startsWith('installer/assets/notebooks/')).length, 2, "the installer's own notebooks");
  for (const f of files) {
    assert.ok(!f.includes('\\'), f);
    assert.doesNotMatch(f, ARCHIVED);
    assert.ok(existsSync(join(DEFAULT_SOURCE_DIR, f)), `${f} is missing`);
  }
  assert.deepEqual(tooLong(files.map((f) => `${SOURCE_ROOT}/${f}`)), []);
});

test('packaging: Cloud Shell checks out the installer and the same files the payload carries', () => {
  assert.deepEqual(sourcePaths(), ['/installer/', ...sourceFiles().map((f) => `/${f}`)]);
});

test('packaging: ships the installer code and its own notebooks, not its tests or tooling', () => {
  for (const f of ['bin/aio-install.js', 'src/cli.js', 'src/web/index.html', 'assets/notebooks/AIO_Data_Check.ipynb', 'package.json', 'package-lock.json', 'README.md']) {
    assert.ok(installerFile(f), f);
  }
  for (const f of ['test/cli.test.js', 'packaging/build-exe.js', 'jsconfig.json', '.gitignore', 'aio-install.json']) assert.ok(!installerFile(f), f);
  // build-exe.js stages these with the installer rather than copying them twice.
  for (const f of sourceFiles().filter((s) => s.startsWith('installer/'))) assert.ok(installerFile(f.slice('installer/'.length)), f);
});

test('packaging: builds with, and runs on, Node.js 22.13 or later, which the dependencies need', () => {
  assert.deepEqual([...MIN_NODE], [22, 13]);
  for (const v of ['22.13.0', '22.20.1', '23.0.0', '24.11.1']) assert.ok(nodeVersionOk(v), v);
  for (const v of ['22.12.0', '20.19.0', '18.20.0']) assert.ok(!nodeVersionOk(v), v);
});

test('packaging: payload IDs change with the content', () => {
  assert.equal(payloadId('0.2.0', 'abcdef0123456789'), '0.2.0-abcdef0123');
  assert.notEqual(payloadId('0.2.0', 'abcdef0123456789'), payloadId('0.2.0', 'abcdef0124456789'));
});

test('packaging: file versions take four numbers', () => {
  assert.equal(fileVersion('0.2.0'), '0.2.0.0');
  assert.equal(fileVersion('1.10.3-beta.1'), '1.10.3.0');
  assert.throws(() => fileVersion('1.2'), /file version/);
  assert.throws(() => fileVersion('1.x.0'), /file version/);
  assert.throws(() => fileVersion('1.2.70000'), /file version/);
});

test('packaging: long paths are caught, with a tighter limit for native binaries', () => {
  const ok = 'f/installer/src/cli.js';
  const long = `f/installer/node_modules/${'x'.repeat(MAX_PAYLOAD_PATH)}`;
  const addon = `f/installer/node_modules/${'x'.repeat(MAX_NATIVE_PATH)}/a.node`;
  const deepJs = `f/installer/node_modules/${'x'.repeat(MAX_NATIVE_PATH)}/a.js`;
  assert.ok(MAX_NATIVE_PATH < MAX_PAYLOAD_PATH);
  assert.deepEqual(tooLong([ok, long, addon, deepJs]), [long, addon]);
  assert.deepEqual(tooLong([ok, 'node/node.exe'], { max: 10, native: 100 }), [ok]);
});

test('packaging: source maps in installed packages are left out, and nothing else', () => {
  for (const f of ['f/installer/node_modules/a/index.js.map', 'f/installer/node_modules/@s/b/build/x.d.ts.map']) assert.ok(prunable(f), f);
  for (const f of [
    'f/installer/node_modules/a/index.js',
    'f/installer/node_modules/a/map.js',
    'f/installer/src/web/app.js.map',
    'f/x.map',
    'node/node.exe',
    'node/LICENSE',
    ...sourceFiles().map((s) => `${SOURCE_ROOT}/${s}`),
  ]) {
    assert.ok(!prunable(f), f);
  }
});

test('packaging: IDs from local settings are caught, public ones are not', () => {
  const graph = '00000003-0000-0000-C000-000000000000';
  const ws = 'aaaa1111-1111-2222-3333-444455556666';
  const ids = localIds([`workspace: ${ws.toUpperCase()}\napp: ${graph}`], [graph]);
  assert.deepEqual([...ids], [ws]);
  assert.deepEqual(leakedIds(`const a="${ws}";const b="${graph}";const c="${ws}"`, ids), [ws]);
  assert.deepEqual(leakedIds('nothing here', ids), []);
});

test('packaging: lock files are pointed at the public registry', () => {
  const lock = JSON.stringify({ packages: { 'node_modules/a': { resolved: `${MIRROR_REGISTRY}a/-/a-1.0.0.tgz` } } });
  assert.equal(JSON.parse(publicRegistry(lock)).packages['node_modules/a'].resolved, `${PUBLIC_REGISTRY}a/-/a-1.0.0.tgz`);
  assert.equal(publicRegistry(publicRegistry(lock)), publicRegistry(lock));
});

test('packaging: the lock-file rewrite loads before npm ci', () => {
  // CI runs public-registry.js before installing dependencies, so neither it nor what it imports
  // may reach the installer source (which imports npm packages).
  for (const file of ['public-registry.js', 'registry.js']) {
    const src = readFileSync(new URL(`../packaging/${file}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(imports.filter((s) => !s.startsWith('node:') && s !== './registry.js'), [], `${file} imports more than Node.js built-ins`);
  }
});

test('packaging: the exe takes the name the workflow and the signing pipeline use', () => {
  // From src/launch.js, which the installer shares with the launchers.
  assert.equal(EXE_NAME, EXE);
});

test('packaging: the workflow uploads, and the signing pipeline signs, the files the build writes', () => {
  const yml = repoFile('.github/workflows/installer-exe.yml');
  for (const name of [EXE, `${EXE}.sha256`, ZIP_NAME, `${ZIP_NAME}.sha256`, SCRIPT_NAME]) {
    assert.match(yml, new RegExp(`^ {12}\\$\\{\\{ runner\\.temp \\}\\}\\\\exe\\\\${literal(name)}$`, 'm'), `uploads ${name}`);
  }
  const sign = readFileSync(new URL('../packaging/sign-installer.azure-pipelines.yml', import.meta.url), 'utf8');
  assert.match(sign, new RegExp(`^ +Pattern: ${literal(EXE)}$`, 'm'));
});

test('packaging: changes to the installer, the files it deploys or the workflows run the workflows', () => {
  for (const f of sourceFiles()) assert.ok(f.startsWith('installer/') || f.startsWith(`${CLASSIC}/`), `nothing runs the workflows when ${f} changes`);
  for (const name of WORKFLOWS) {
    const yml = repoFile(`.github/workflows/${name}`);
    for (const p of ['installer/**', `${CLASSIC}/**`, `!${CLASSIC}/archive/**`, `.github/workflows/${name}`]) {
      assert.match(yml, new RegExp(`^ +- '${literal(p)}'$`, 'm'), `${name} runs on ${p}`);
    }
  }
});

test('packaging: an installer tag builds the installer alone, and only drafts its release', () => {
  const yml = repoFile('.github/workflows/installer-exe.yml');
  assert.match(yml, /^ {4}tags: \['installer-v\*'\]$/m);
  assert.ok(yml.includes(`if ($env:TAG -ne "installer-v$version")`), 'the tag must match package.json');
  assert.match(yml, /gh release create "\$TAG" /);
  // The repo's Latest release is the dashboard's.
  assert.match(yml, / --draft --latest=false /);
  assert.doesNotMatch(yml, /--draft=false|--latest(=true)?\s*\\?$/m);
  // No app to build yet.
  for (const name of WORKFLOWS) assert.doesNotMatch(repoFile(`.github/workflows/${name}`), /\bapp\/|working-directory: '?app'?$|managed-apps|npm run build(?!:exe)/m, name);
});
