// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { NOTEBOOKS, NOTEBOOKS_DIR } from '../src/catalog.js';
import { otherRoute, version } from '../src/cli.js';
import { emptyConfig, emptyPax } from '../src/config.js';
import { APP_NEEDS_PAX, runCommand } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import { WRAPPER_FILE } from '../src/pax/names.js';
import { PAX_NEEDS_WINDOWS } from '../src/pax/plan.js';
import { PROBE } from '../src/pax/scripts.js';
import { PIPELINE_TEMPLATE } from '../src/sources.js';
import { fakeUi } from './fakes.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TENANT = '00000000-0000-0000-0000-000000000001';
const ENV_ID = '00000000-0000-0000-0000-000000000002';
const NOTHING_YET = 'Nothing is installed yet. Run the installer first.';
const PWSH_MISSING = "PowerShell 7 isn't installed (pwsh.exe wasn't found).";
const FULL_PROBE = {
  languageMode: 'FullLanguage',
  isWindows: true,
  os: 'Microsoft Windows 11',
  version: '7.4.6',
  executionPolicy: 'RemoteSigned',
  python: { version: '3.12.1', major: 3, minor: 12, exe: 'C:\\Python\\python.exe', dir: 'C:\\Python' },
  winget: true,
  scheduledTasks: true,
  certificates: true,
  user: 'CONTOSO\\admin',
  sid: 'S-1-5-21-1',
};

/** @param {string} s */
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');

/**
 * A temp folder, removed when the test ends.
 * @param {import('node:test').TestContext} t
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-pax-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A folder with just the files loadSources needs: the pipeline template and the notebooks. It has
 * no report template and no app build.
 * @param {string} dir
 */
function sourceRoot(dir) {
  const root = join(dir, 'repo');
  for (const file of [join(root, PIPELINE_TEMPLATE), ...NOTEBOOKS.map((nb) => join(root, nb.dir ?? NOTEBOOKS_DIR, nb.file))]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}', 'utf8');
  }
  return root;
}

/**
 * Writes an install record and returns its path.
 * @param {string} dir
 * @param {string} name
 * @param {any} record
 */
function writeRecord(dir, name, record) {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`, 'utf8');
  return file;
}

/** @param {string} dir */
const paxRecord = (dir) =>
  writeRecord(dir, 'pax.json', { target: 'pax', tenantId: TENANT, pax: { destination: 'local', localFolder: join(dir, 'files'), taskRegisteredAt: NOW.toISOString() } });
/** @param {string} dir */
const fabricRecord = (dir) => writeRecord(dir, 'fabric.json', { target: 'fabric', tenantId: TENANT });

const CLI_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js')).href;
/** The child's exit code when main() gets as far as signing in. */
const SIGN_IN_EXIT = 99;
/**
 * The child process's script. It calls main() with each argument list in turn and prints what each
 * returned and wrote. main() notes "Signing in…" just before it signs in: that note ends the child
 * there, so no test can sign in. fetch is stubbed out too.
 */
const CHILD = [
  "const { calls, platform, cli } = JSON.parse(process.env.AIO_TEST_MAIN ?? '{}');",
  'const write = process.stdout.write.bind(process.stdout);',
  "let out = '';",
  "let err = '';",
  '/** @param {any[]} rest */',
  "const done = (rest) => { const cb = rest.find((x) => typeof x === 'function'); if (cb) cb(); return true; };",
  'process.stdout.write = (chunk, ...rest) => {',
  '  const s = String(chunk);',
  `  if (/Signing in|Azure CLI sign-in/.test(s)) process.exit(${SIGN_IN_EXIT});`,
  '  out += s;',
  '  return done(rest);',
  '};',
  'process.stderr.write = (chunk, ...rest) => {',
  '  err += String(chunk);',
  '  return done(rest);',
  '};',
  "if (platform) Object.defineProperty(process, 'platform', { value: platform });",
  "globalThis.fetch = async () => { throw new Error('No network in this test.'); };",
  'const { main } = await import(cli);',
  'const results = [];',
  'for (const argv of calls) {',
  "  out = '';",
  "  err = '';",
  '  results.push({ code: await main(argv), out, err });',
  '}',
  'write(JSON.stringify(results), () => process.exit(0));',
].join('\n');

const execFileAsync = promisify(execFile);

/**
 * The child's environment: its profile folders in dir, no launcher, not Cloud Shell, no colour.
 * @param {string} dir
 */
function childEnv(dir) {
  const drop = new Set(['AI_IN_ONE_LAUNCHER', 'AI_IN_ONE_EXE', 'AI_IN_ONE_CLOUD_SHELL', 'NODE_TEST_CONTEXT', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'NO_COLOR', 'FORCE_COLOR']);
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!drop.has(name.toUpperCase())) env[name] = value;
  return {
    ...env,
    AI_IN_ONE_CLOUD_SHELL: '0',
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    LOCALAPPDATA: join(dir, 'LocalAppData'),
    APPDATA: join(dir, 'AppData'),
    USERPROFILE: join(dir, 'home'),
    HOME: join(dir, 'home'),
  };
}

/**
 * Calls main() once for each argument list, in a child process with childEnv(dir) and, when given,
 * that process.platform.
 * @param {string} dir
 * @param {string[][]} calls
 * @param {{ platform?: NodeJS.Platform }} [o]
 * @returns {Promise<{ code: number, out: string, err: string }[]>}
 */
async function runMain(dir, calls, o = {}) {
  const env = { ...childEnv(dir), AIO_TEST_MAIN: JSON.stringify({ calls, platform: o.platform, cli: CLI_URL }) };
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', CHILD], { env, timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(String(stdout));
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === SIGN_IN_EXIT) assert.fail(`main() went on to sign in.\n${e.stdout}\n${e.stderr}`);
    throw err;
  }
}

/**
 * The message main() printed for an error, from its "✗" line.
 * @param {{ err: string }} r
 */
const failure = (r) => /^✗ (.*)$/m.exec(strip(r.err))?.[1];

test('main: preview --target pax writes the task\'s files without signing in or writing a record', async (t) => {
  const dir = tempDir(t);
  const root = sourceRoot(dir);
  const file = join(dir, 'aio-install.json');
  const out = join(dir, 'preview');
  const local = paxRecord(dir);
  const localOut = join(dir, 'preview-local');
  const [fresh, fromRecord] = await runMain(dir, [
    ['preview', '--target', 'pax', '--config', file, '--source', root, '--out', out],
    ['preview', '--config', local, '--source', root, '--out', localOut],
  ]);

  assert.equal(fresh.code, 0, fresh.err);
  assert.equal(strip(fresh.err), '');
  const text = strip(fresh.out);
  assert.match(text, new RegExp(`^AI in One installer ${version().replace(/\./g, '\\.')}\\n`));
  assert.match(text, /Preview written/);
  assert.doesNotMatch(text, /Install record:/);
  assert.equal(existsSync(file), false, 'preview writes no install record');
  // No SharePoint report template in this source folder, so no model or report.
  assert.deepEqual(readdirSync(out).sort(), [WRAPPER_FILE, 'graph-permissions.txt', 'task.xml'].sort());
  const permissions = readFileSync(join(out, 'graph-permissions.txt'), 'utf8');
  assert.match(permissions, /^ {2}Sites\.Selected$/m);
  assert.match(permissions, /write permission on https:\/\/your-tenant\.sharepoint\.com\/sites\/AIinOne alone/);
  assert.doesNotMatch(permissions, /Sites\.ReadWrite\.All/);

  // The record's route needs no --target, and its local folder has no site to name or ask for.
  assert.equal(fromRecord.code, 0, fromRecord.err);
  assert.deepEqual(readdirSync(localOut).sort(), [WRAPPER_FILE, 'graph-permissions.txt', 'task.xml'].sort());
  const localPermissions = readFileSync(join(localOut, 'graph-permissions.txt'), 'utf8');
  assert.doesNotMatch(localPermissions, /write permission on/);
  assert.doesNotMatch(localPermissions, /Sites\./);
});

test('main: a record for one route refuses --target for the other, before anything else', async (t) => {
  const dir = tempDir(t);
  const root = sourceRoot(dir);
  const pax = paxRecord(dir);
  const fabric = fabricRecord(dir);
  // A record from before --target was added is a Fabric one.
  const older = writeRecord(dir, 'older.json', { tenantId: TENANT });
  const before = [pax, fabric, older].map((f) => readFileSync(f, 'utf8'));
  const out = join(dir, 'preview');
  const results = await runMain(dir, [
    ['status', '--target', 'fabric', '--config', pax, '--source', root],
    ['install', '--target', 'fabric', '--config', pax, '--source', root],
    ['status', '--target', 'pax', '--config', fabric, '--source', root],
    ['preview', '--target', 'pax', '--config', fabric, '--source', root, '--out', out],
    ['install', '--target', 'pax', '--config', older, '--source', root],
  ]);

  const expected = [otherRoute(pax, 'pax'), otherRoute(pax, 'pax'), otherRoute(fabric, 'fabric'), otherRoute(fabric, 'fabric'), otherRoute(older, 'fabric')];
  assert.deepEqual(
    results.map((r) => [r.code, failure(r)]),
    expected.map((m) => [1, m]),
  );
  assert.match(expected[0], /^.+pax\.json is the install record for AI in One with PAX\. Leave out --target to use it, or add --config with a new file name/);
  assert.match(expected[2], /fabric\.json is the install record for AI in One on Fabric\./);
  for (const r of results) assert.doesNotMatch(strip(r.out), /AI in One installer|Install record:/, 'it stops before the banner');
  assert.equal(existsSync(out), false, 'no preview either');
  assert.deepEqual(
    [pax, fabric, older].map((f) => readFileSync(f, 'utf8')),
    before,
    'the records are untouched',
  );
});

test('main: a Fabric record refuses deploy-app and --environment-id: the app comes with PAX', async (t) => {
  const dir = tempDir(t);
  const root = sourceRoot(dir);
  const fabric = fabricRecord(dir);
  const results = await runMain(dir, [
    ['deploy-app', '--config', fabric, '--source', root],
    ['deploy-app', '--environment-id', ENV_ID, '--config', fabric, '--source', root],
    ['install', '--environment-id', ENV_ID, '--config', fabric, '--source', root],
    ['access', '--environment-id', ENV_ID, '--config', fabric, '--source', root],
  ]);
  const withId = `--environment-id is for the AI in One app. ${APP_NEEDS_PAX}`;
  assert.deepEqual(
    results.map((r) => [r.code, failure(r)]),
    [
      [1, APP_NEEDS_PAX],
      [1, APP_NEEDS_PAX],
      [1, withId],
      [1, withId],
    ],
  );
  assert.match(APP_NEEDS_PAX, /--target pax and a new install record/);
});

test('main: a PAX record refuses rerun-failed and the options that are only for Fabric', async (t) => {
  const dir = tempDir(t);
  const root = sourceRoot(dir);
  const pax = paxRecord(dir);
  const results = await runMain(dir, [
    ['rerun-failed', '--config', pax, '--source', root],
    ['install', '--key-vault', '--config', pax, '--source', root],
    ['install', '--no-key-vault', '--config', pax, '--source', root],
    ['rotate-secret', '--secret-days', '30', '--config', pax, '--source', root],
  ]);
  assert.deepEqual(
    results.map((r) => [r.code, failure(r)]),
    [
      [1, `rerun-failed is for the Fabric route. To run PAX again now, run: ${commandLine('run', {})}`],
      [1, '--key-vault is for the Fabric route. This install uses PAX.'],
      [1, '--no-key-vault is for the Fabric route. This install uses PAX.'],
      [1, '--secret-days is for the Fabric route. This install uses PAX.'],
    ],
  );
  assert.equal(commandLine('run', {}), 'aio-install run');
});

test('main: PAX commands other than install and preview need an install record', async (t) => {
  const dir = tempDir(t);
  const root = sourceRoot(dir);
  const file = join(dir, 'aio-install.json');
  const results = await runMain(dir, [
    ['status', '--target', 'pax', '--config', file, '--source', root],
    ['run', '--target', 'pax', '--config', file, '--source', root],
    ['deploy-app', '--target', 'pax', '--config', file, '--source', root],
  ]);
  const message = `No install record at ${file}. Run the installer first, or pass --config.`;
  assert.deepEqual(
    results.map((r) => [r.code, failure(r)]),
    [
      [1, message],
      [1, message],
      [1, message],
    ],
  );
  assert.equal(existsSync(file), false);
});

test('main: a PAX install stops off Windows before it signs in, and preview still works there', async (t) => {
  const dir = tempDir(t);
  const root = sourceRoot(dir);
  const file = join(dir, 'aio-install.json');
  const pax = paxRecord(dir);
  const before = readFileSync(pax, 'utf8');
  const out = join(dir, 'preview');
  const [fresh, repair, preview] = await runMain(
    dir,
    [
      ['install', '--target', 'pax', '--yes', '--config', file, '--source', root],
      ['install', '--config', pax, '--source', root],
      ['preview', '--config', pax, '--source', root, '--out', out],
    ],
    { platform: 'linux' },
  );
  assert.deepEqual([fresh.code, failure(fresh)], [1, PAX_NEEDS_WINDOWS]);
  assert.deepEqual([repair.code, failure(repair)], [1, PAX_NEEDS_WINDOWS]);
  assert.match(PAX_NEEDS_WINDOWS, /Windows/);
  assert.equal(existsSync(file), false, 'no record for the install that stopped');
  assert.equal(readFileSync(pax, 'utf8'), before);
  assert.equal(preview.code, 0, preview.err);
  assert.ok(existsSync(join(out, WRAPPER_FILE)));
});

/**
 * A PAX install's ctx. Graph and Fabric calls are recorded; Graph answers no roles and that users
 * can register apps, and everything else fails as if offline. PowerShell answers only the PC check.
 * @param {import('node:test').TestContext} t
 * @param {{ pax?: any, pwshMissing?: boolean }} [o]
 */
function paxCtx(t, o = {}) {
  const dir = tempDir(t);
  const fake = fakeUi();
  /** @type {any} */
  const config = { ...emptyConfig(), target: 'pax', tenantId: TENANT, pax: { ...emptyPax(), ...o.pax } };
  /** @type {{ saves: number, pwsh: any[], graph: string[], fabric: string[] }} */
  const calls = { saves: 0, pwsh: [], graph: [], fabric: [] };
  /**
   * An API whose methods record their names and return the given answer, or fail.
   * @param {string[]} log
   * @param {Record<string, any>} answers
   */
  const api = (log, answers) =>
    new Proxy(
      {},
      {
        get: (_, name) => async () => {
          log.push(String(name));
          if (String(name) in answers) return answers[String(name)];
          throw new Error(`${String(name)} is offline in this test.`);
        },
      },
    );
  /** @param {any} req */
  const runPwsh = async (req) => {
    calls.pwsh.push(req);
    if (o.pwshMissing) throw new Error(PWSH_MISSING);
    if (req.command === PROBE) return { result: FULL_PROBE, stdout: '', stderr: '', code: 0 };
    throw new Error(`No fake for this PowerShell call: ${JSON.stringify(req).slice(0, 120)}`);
  };
  const ctx = {
    ui: fake.ui,
    config,
    file: join(dir, 'aio-install.json'),
    save: () => {
      calls.saves++;
    },
    api: { graph: api(calls.graph, { myDirectoryRoles: [], usersCanRegisterApps: true }), fabric: api(calls.fabric, {}) },
    user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: TENANT },
    sources: { dir, notebooks: {}, pipeline: {} },
    sleep: async () => {},
    now: () => NOW,
    method: 'browser',
    runPwsh,
    env: { LOCALAPPDATA: join(dir, 'LocalAppData') },
  };
  return {
    ctx: /** @type {import('../src/install.js').Ctx} */ (/** @type {unknown} */ (ctx)),
    config,
    calls,
    out: () => strip(fake.text()),
  };
}

test('runCommand: on PAX, prereqs checks this PC and the PAX rows, not the task or Fabric', async (t) => {
  // With the task in place, runPaxCommand would refuse prereqs: it goes to the checklist instead.
  const { ctx, calls, out } = paxCtx(t, { pax: { taskRegisteredAt: NOW.toISOString() } });
  assert.equal(await runCommand(ctx, 'prereqs', { wait: false }), true);
  const text = out();
  assert.match(text, /Prerequisites/);
  assert.match(text, /Signed in as admin@contoso\.com \(tenant 00000000-0000-0000-0000-000000000001\)/);
  for (const row of ['✓ A Windows PC or server', '✓ PowerShell 7', '✓ Python 3.10 or later', '✓ Task Scheduler', '? A SharePoint site you own (optional)']) {
    assert.ok(text.includes(`  ${row}\n`), `${row}\n${text}`);
  }
  assert.doesNotMatch(text, /Fabric capacity|Key Vault|show user names/);
  assert.deepEqual(
    calls.pwsh.map((r) => r.command),
    [PROBE],
    'one look at this PC',
  );
  assert.deepEqual(calls.fabric, ['tenantSettings'], 'only the report\'s tenant setting');
  assert.equal(calls.saves, 0, 'prereqs changes nothing');
});

test('runCommand: on PAX, install checks the tenant and this PC first, and stops without PowerShell 7', async (t) => {
  const { ctx, calls, out } = paxCtx(t, { pwshMissing: true });
  await assert.rejects(runCommand(ctx, 'install', { wait: false }), { message: /^This PC can't run the scheduled task yet\. Missing: .*PowerShell 7/ });
  const text = out();
  assert.match(text, /Checking your tenant[\s\S]*Checking this PC/);
  assert.deepEqual(calls.fabric, ['tenantSettings'], 'no Fabric capacity or workspace checks');
  assert.equal(calls.saves, 0, 'nothing saved before the plan');
});

test('runCommand: on PAX, the other commands are the PAX ones, which need the task first', async (t) => {
  const { ctx, config, calls } = paxCtx(t);
  for (const command of ['update', 'run', 'check', 'refresh', 'status', 'rotate-secret', 'rerun-failed']) {
    await assert.rejects(runCommand(ctx, command, { wait: false }), { message: NOTHING_YET }, command);
  }
  config.pax.taskRegisteredAt = NOW.toISOString();
  await assert.rejects(runCommand(ctx, 'rerun-failed', { wait: false }), { message: `rerun-failed is for the Fabric route. To run PAX again now, run: ${commandLine('run')}` });
  await assert.rejects(runCommand(ctx, 'bogus', { wait: false }), { message: 'Unknown command "bogus".' });
  assert.deepEqual(calls, { saves: 0, pwsh: [], graph: [], fabric: [] }, 'refused before any call');
});
