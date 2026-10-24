// @ts-check
/**
 * The AI in One app's step: the pinned managed apps CLI (`ms`), the one CLI command each step runs,
 * and the flow that deploys the app's build and shares it with the viewer group. Nothing runs the
 * real CLI: createCli gets a fake spawn (a fake `ms` that keeps its accounts and apps in memory), and
 * the steps get a fake runner. LOCALAPPDATA, the build and the CLI's package are temp folders. The
 * first tests read the real app folder, so the installer and the app stay in step.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { routeMismatch } from '../src/cli.js';
import { emptyConfig, emptyPax } from '../src/config.js';
import { APP_NEEDS_PAX, runCommand } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import {
  CLI_PACKAGE,
  CLI_PACKAGE_DIR,
  cliBin,
  COMMAND_TIMEOUT_MS,
  createCli,
  DEPLOY_TIMEOUT_MS,
  installedVersion,
  MIN_NODE,
  nodeOk,
  parseJson,
  pinnedVersion,
} from '../src/managed-app/cli.js';
import { ADMIN_STEPS, CLI_APP_ID, deployAgain, explain, LINKS, notReady } from '../src/managed-app/errors.js';
import { APP_NAME, buildHash, deployTheApp, NOT_READY_NAMES, removeTheApp, whyNot } from '../src/managed-app/flow.js';
import {
  APP_CONFIG,
  authStatus,
  BUILD_PATH,
  createApp,
  deleteApp,
  deployApp,
  isGuid,
  login,
  playUrl,
  readAppConfig,
  shareApp,
  stripBom,
  switchAccount,
  verifyShare,
} from '../src/managed-app/steps.js';
import { paxSummary, runPaxCommand, setUpTitles, withApp } from '../src/pax/flow.js';
import { managedAppDir } from '../src/pax/names.js';
import { VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { nextSteps } from '../src/steps/next-steps.js';
import { fakeCtx, fakeUi } from './fakes.js';

/** @typedef {import('../src/managed-app/cli.js').CliResult} CliResult */
/** @typedef {import('../src/managed-app/cli.js').RunCli} RunCli */
/** @typedef {import('../src/managed-app/cli.js').RunOptions} RunOptions */
/** @typedef {import('../src/managed-app/errors.js').Problem} Problem */
/** @typedef {import('../src/managed-app/errors.js').Failure} Failure */
/** @typedef {import('../src/config.js').InstallConfig} InstallConfig */
/** @typedef {import('../src/config.js').ManagedAppConfig} ManagedAppConfig */

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const INSTALLER = join(REPO, 'installer');
const APP = join(REPO, 'app');

/** The signed-in user, as fakeCtx has them, and someone else. */
const USER = 'admin@contoso.com';
const OTHER_USER = 'someone@contoso.com';
/** The viewer group, and another group. */
const GROUP = '00000000-0000-0000-0000-000000000001';
const GROUP_2 = '00000000-0000-0000-0000-000000000002';
/** The developer environment the fake CLI picks, and another one. */
const DEV_ENV = '00000000-0000-0000-0000-0000000000e1';
const OTHER_ENV = '00000000-0000-0000-0000-0000000000e2';
/** The nth app the fake CLI makes. @param {number} n */
const appId = (n) => `00000000-0000-0000-0000-0000000000a${n}`;
/** An app deployed before, whose settings aren't on this PC. */
const OLD_APP = '00000000-0000-0000-0000-0000000000b1';
/** Where people open an app. @param {string} id */
const playUri = (id) => `https://apps.contoso.com/play/${id}`;
/** fakeCtx's clock. */
const DEPLOYED_AT = '2026-06-01T12:00:00.000Z';

/** Without the colour codes a terminal gets. @param {string} s */
const plain = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * A folder for one test, removed after it.
 * @param {import('node:test').TestContext} t
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes a file, and the folders it's in. @param {string} file @param {string} text */
function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A build of the app, as Vite makes it. @param {string} dir */
function makeDist(dir) {
  put(join(dir, 'index.html'), '<!doctype html><title>AI in One</title><script src="./assets/app.js"></script>');
  put(join(dir, 'assets', 'app.js'), 'console.log("v1");');
  return dir;
}

/**
 * A package that pins the CLI, as installer/managed-cli does, with the CLI "installed" in it: just its
 * package.json, as nothing here runs it.
 * @param {string} dir
 * @param {{ pinned?: string, installed?: string | null }} [o]  installed: null when it isn't installed. The pinned version when absent.
 */
function cliPackage(dir, o = {}) {
  const pinned = o.pinned ?? pinnedVersion();
  put(join(dir, 'package.json'), JSON.stringify({ name: 'aio-managed-cli', private: true, dependencies: { [CLI_PACKAGE]: pinned } }));
  const installed = o.installed === undefined ? pinned : o.installed;
  if (installed !== null) {
    put(join(dir, 'node_modules', '@microsoft', 'managed-apps-cli', 'package.json'), JSON.stringify({ name: CLI_PACKAGE, version: installed }));
  }
  return dir;
}

/** Every file under a folder, as sorted paths with forward slashes. @param {string} dir */
const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .map((rel) => rel.replaceAll('\\', '/'))
    .sort();

/** @param {string} file */
const readJson = (file) => JSON.parse(stripBom(readFileSync(file, 'utf8')));

/** The install record's app part. @param {InstallConfig} config */
const appRecord = (config) => /** @type {ManagedAppConfig} */ (config.managedApp);

/**
 * What a fake CLI command does: its exit code and what it prints.
 * @typedef {object} Output
 * @property {number | null} [code]  0 when absent. null: a signal stopped it.
 * @property {string | string[]} [stdout]  In chunks.
 * @property {string | string[]} [stderr]
 * @property {Error} [error]  An 'error' event, before it closes.
 * @property {boolean} [hang]  It runs until it's killed.
 * @property {Error} [throws]  spawn itself throws.
 */

/** What a command prints with --json, and its exit code. @param {number} code @param {Record<string, any>} body @returns {Output} */
const json = (code, body) => ({ code, stdout: `${JSON.stringify(body, null, 2)}\n` });

/**
 * A child process with the streams createCli reads. kill() closes it with no exit code, as a signal does.
 * @param {boolean} piped  false for stdio: 'inherit', where the parent gets no streams.
 * @returns {any}
 */
function fakeChild(piped) {
  const stream = () => {
    /** @type {any} */
    const s = new EventEmitter();
    s.setEncoding = (/** @type {string} */ encoding) => {
      s.encoding = encoding;
    };
    return s;
  };
  /** @type {any} */
  const child = new EventEmitter();
  child.stdout = piped ? stream() : null;
  child.stderr = piped ? stream() : null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', null));
    return true;
  };
  return child;
}

/**
 * A spawn that records each call and plays back the Output `answer` gives for it, once createCli has
 * its listeners on.
 * @param {(argv: string[], options: any) => Output} answer
 */
function scriptedSpawn(answer) {
  /** @type {{ command: string, argv: string[], options: any, child: any }[]} */
  const calls = [];
  const spawn = /** @type {any} */ (
    (/** @type {string} */ command, /** @type {string[]} */ argv, /** @type {any} */ options) => {
      const out = answer(argv, options);
      if (out.throws) throw out.throws;
      const child = fakeChild(options.stdio !== 'inherit');
      calls.push({ command, argv, options, child });
      setImmediate(() => {
        for (const chunk of [out.stdout ?? []].flat()) child.stdout?.emit('data', chunk);
        for (const chunk of [out.stderr ?? []].flat()) child.stderr?.emit('data', chunk);
        if (out.error) child.emit('error', out.error);
        if (!out.hang) child.emit('close', out.code === undefined ? 0 : out.code);
      });
      return child;
    }
  );
  return { spawn, calls };
}

/**
 * A stand-in for the managed apps CLI behind createCli: the accounts it's signed in with, the apps it
 * made, and what each command prints with --json. `fail` scripts a command's next outputs instead, by
 * its first words, such as 'app deploy'.
 * @param {object} [o]
 * @param {string[]} [o.accounts]  The accounts it has: [USER] when absent. None: it was never signed in, so `auth status` exits 3.
 * @param {string | null} [o.active]  The account it's on: the first when absent, none when null.
 * @param {string} [o.loginAs]  Who a browser sign-in signs in as: the account asked for when absent.
 * @param {boolean} [o.loginSignsIn]  false: the browser closes without signing in.
 * @param {boolean} [o.initPrintsIds]  false: init prints no IDs, only ms.config.json has them.
 * @param {boolean} [o.deployPrintsUrl]  false: deploy prints no link, `app play` has it.
 * @param {any[]} [o.deployWarnings]
 * @param {boolean} [o.shareShowsUp]  false: the share list doesn't show a share yet.
 * @param {any[]} [o.shareWarnings]  What a share that partly worked says.
 * @param {Record<string, Output[]>} [o.fail]
 */
function fakeMs(o = {}) {
  const accounts = [...(o.accounts ?? [USER])];
  let active = o.active === null ? undefined : (o.active ?? accounts[0]);
  /** @type {Map<string, { environmentId: string, shared: string[] }>} */
  const apps = new Map();
  let made = 0;
  /** @type {{ key: string, args: string[], cwd: string | undefined, onScreen: boolean, jsonFlags: boolean, env: NodeJS.ProcessEnv, dist?: string[] }[]} */
  const calls = [];

  /** @param {string[]} argv @param {any} options @returns {Output} */
  const answer = (argv, options) => {
    const onScreen = options.stdio === 'inherit';
    const jsonFlags = argv.slice(-3).join(' ') === '--non-interactive --json --no-color';
    const args = argv.slice(1, jsonFlags ? -3 : undefined);
    const key = args[1] === 'share' && args[2] === 'list' ? 'app share list' : args.slice(0, 2).join(' ');
    /** @type {(typeof calls)[number]} */
    const call = { key, args, cwd: options.cwd, onScreen, jsonFlags, env: options.env };
    calls.push(call);
    const scripted = o.fail?.[key]?.shift();
    if (scripted) return scripted;
    const flag = (/** @type {string} */ name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const file = options.cwd ? join(options.cwd, APP_CONFIG) : undefined;
    const settings = file && existsSync(file) ? readJson(file) : undefined;
    const app = settings ? apps.get(settings.appId) : undefined;
    switch (key) {
      case 'auth status':
        if (!accounts.length) return json(3, { success: false, errorMessage: 'Not signed in. Run ms auth login.' });
        return json(0, {
          success: true,
          signedIn: !!active,
          ...(active ? { activeAccount: { username: active } } : {}),
          accounts: accounts.map((username) => ({ username })),
        });
      case 'auth switch': {
        const want = flag('--account');
        if (!want || !accounts.includes(want)) return json(1, { success: false, errorMessage: `There's no account ${want}.` });
        active = want;
        return json(0, { success: true });
      }
      case 'auth login': {
        if (o.loginSignsIn === false) return { code: 0 };
        const who = o.loginAs ?? flag('--account') ?? USER;
        if (!accounts.includes(who)) accounts.push(who);
        active = who;
        return { code: 0 };
      }
      case 'app init': {
        if (settings) return json(1, { success: false, errorMessage: 'ms.config.json already exists in this folder.' });
        const id = appId(++made);
        const environmentId = flag('--environment-id') ?? DEV_ENV;
        apps.set(id, { environmentId, shared: [] });
        const config = { appId: id, environmentId, appDisplayName: flag('--display-name'), buildPath: flag('--build-path') };
        writeFileSync(join(options.cwd, APP_CONFIG), JSON.stringify(config, null, 2));
        return json(0, o.initPrintsIds === false ? { success: true } : { success: true, appId: id, environmentId });
      }
      case 'app deploy':
        if (!settings) return json(1, { success: false, errorMessage: 'There is no ms.config.json here. Run ms app init.' });
        if (!app) return json(6, { success: false, errorMessage: `App ${settings.appId} was not found.` });
        call.dist = filesUnder(join(options.cwd, 'dist'));
        return {
          ...json(0, {
            success: true,
            appId: settings.appId,
            ...(o.deployPrintsUrl === false ? {} : { appPlayUri: playUri(settings.appId) }),
            warnings: o.deployWarnings ?? [],
          }),
          stderr: 'Packing ./dist\nUploading\n',
        };
      case 'app share':
        if (!app) return json(1, { success: false, errorMessage: 'There is no app here.' });
        for (const principal of args[2].split(',')) if (!app.shared.includes(principal)) app.shared.push(principal);
        return json(0, { success: true, partialFailure: !!o.shareWarnings?.length, warnings: o.shareWarnings ?? [] });
      case 'app share list':
        if (!app) return json(1, { success: false, errorMessage: 'There is no app here.' });
        return json(0, {
          success: true,
          results: [{ value: (o.shareShowsUp === false ? [] : app.shared).map((id) => ({ principalObjectId: id.toUpperCase(), access: 'play' })) }],
        });
      case 'app play':
        if (!settings) return json(1, { success: false, errorMessage: 'There is no app here.' });
        return json(0, { success: true, url: playUri(settings.appId) });
      case 'app delete': {
        const id = flag('--app') ?? '';
        if (!apps.has(id)) return json(6, { success: false, errorMessage: `App ${id} was not found.` });
        apps.delete(id);
        return json(0, { success: true, existed: true });
      }
      default:
        return json(1, { success: false, errorMessage: `Unknown command: ${args.join(' ')}` });
    }
  };
  const { spawn } = scriptedSpawn(answer);
  return { spawn, calls, apps, commands: () => calls.map((c) => c.key) };
}

/** The CLI's answers when the tenant isn't ready for managed apps: app creation with the CLI is off, */
const CREATE_APPS_OFF = json(1, {
  success: false,
  errorCode: 'EnvironmentPermissionDenied',
  errorMessage: "You don't have permission to create an app in this environment. Ask your admin to grant you the required permission.",
  errorData: { serverMessage: 'The user does not have the required privilege in this environment.' },
});
/** external artifacts are off, */
const EXTERNAL_ARTIFACTS_OFF = json(1, {
  success: false,
  errorMessage: 'The deployment was refused.',
  errorData: { errorCode: 'CodeAppOperationNotAllowedInEnvironment', serverMessage: 'Code app operations are not allowed in this environment.' },
});
/** or both. */
const BOTH_OFF = json(1, {
  success: false,
  errorMessage: 'The request was refused.',
  errorData: { errorCode: 'InsufficientPrivilege', serverMessage: 'ExternalArtifactDeploymentDisabled' },
});
/** The CLI's sign-in expired between two commands. */
const EXPIRED = json(3, { success: false, errorMessage: 'Your sign-in session has expired. Run ms auth login.' });

/**
 * A PAX install with the app step on: a temp LOCALAPPDATA, the app's build in the sources, the pinned
 * CLI "installed" in a temp package, and createCli running a fake `ms`.
 * @param {import('node:test').TestContext} t
 * @param {object} [o]
 * @param {ReturnType<typeof fakeMs>} [o.ms]
 * @param {boolean} [o.yes]
 * @param {any[]} [o.answers]
 * @param {string[]} [o.yesTo]
 * @param {{ groupId?: string, groupName?: string } | null} [o.access]  The viewer group: none when null.
 * @param {'local'} [o.destination]  The files stay on this PC.
 * @param {string | null} [o.installed]  The CLI version installed: the pinned one when absent.
 * @param {string} [o.nodeVersion]
 */
function appSetup(t, o = {}) {
  const tmp = tempDir(t);
  const env = { LOCALAPPDATA: join(tmp, 'local') };
  const distDir = makeDist(join(tmp, 'build'));
  const cliDir = cliPackage(join(tmp, 'managed-cli'), { installed: o.installed });
  const ms = o.ms ?? fakeMs();
  const { ui, text, asked } = fakeUi({ yes: o.yes, answers: o.answers, yesTo: o.yesTo });
  const config = emptyConfig();
  config.target = 'pax';
  config.pax = emptyPax();
  if (o.destination === 'local') {
    config.pax.destination = 'local';
    config.pax.localFolder = join(tmp, 'AI in One');
  }
  if (o.access !== null) config.access = o.access ?? { groupId: GROUP, groupName: VIEWER_GROUP_NAME };
  const { ctx, saves } = fakeCtx({ ui, config, sources: /** @type {any} */ ({ dir: tmp, appDist: distDir }) });
  ctx.env = env;
  /** @type {import('../src/managed-app/flow.js').AppDeps} */
  const deps = { run: createCli({ cliDir, spawn: ms.spawn, node: 'node' }).run, cliDir, nodeVersion: o.nodeVersion ?? `v${MIN_NODE}`, env };
  return { tmp, env, distDir, cliDir, ms, ctx, config, deps, appDir: managedAppDir(env), asked, saves, out: () => plain(text()) };
}

// The real app folder.

test('real app: the installer pins the managed apps CLI version the app is built with', () => {
  const pinned = pinnedVersion();
  assert.match(pinned, /^\d+\.\d+\.\d+$/, 'an exact version, so every install runs the CLI it was tested with');
  const app = readJson(join(APP, 'package.json'));
  const listed = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].map((s) => app[s]?.[CLI_PACKAGE]).filter(Boolean);
  assert.ok(listed.length, `app/package.json lists ${CLI_PACKAGE}`);
  for (const version of listed) assert.equal(version, pinned);
  assert.equal(readJson(join(APP, 'package-lock.json')).packages[`node_modules/${CLI_PACKAGE}`]?.version, pinned, "app/package-lock.json's CLI");
});

test("real app: the CLI's lock file holds the pinned version, its engines are MIN_NODE, and cliBin is its bin", () => {
  const dir = join(INSTALLER, 'managed-cli');
  assert.equal(CLI_PACKAGE_DIR, dir);
  const lock = readJson(join(dir, 'package-lock.json'));
  assert.equal(lock.packages['']?.dependencies?.[CLI_PACKAGE], pinnedVersion());
  const entry = lock.packages[`node_modules/${CLI_PACKAGE}`];
  assert.equal(entry?.version, pinnedVersion());
  assert.equal(entry.engines?.node, `>=${MIN_NODE}`, 'MIN_NODE is the pinned CLI\'s engines.node');
  assert.equal(cliBin(dir), join(dir, 'node_modules', ...CLI_PACKAGE.split('/'), ...String(entry.bin?.ms).split('/')));
});

test("real app: APP_NAME and BUILD_PATH are the README's `ms app init` name and build path", (t) => {
  const readme = readFileSync(join(APP, 'README.md'), 'utf8');
  const init = readme.match(/^\s*(?:npx\s+)?ms app init\b([^\r\n]*)/m);
  if (!init) {
    t.skip('app/README.md has no `ms app init` line to check against');
    return;
  }
  assert.equal(init[1].match(/-n\s+"([^"]+)"/)?.[1], APP_NAME);
  assert.equal(init[1].match(/-b\s+(\S+)/)?.[1], BUILD_PATH);
  assert.match(init[1], /--repo none/);
});

test("real app: git ignores the app's tenant settings (APP_CONFIG) and its build", () => {
  const lines = readFileSync(join(APP, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
  assert.ok(lines.includes(APP_CONFIG) || lines.includes(`/${APP_CONFIG}`), `app/.gitignore has ${APP_CONFIG}`);
  assert.ok(lines.some((line) => /^\/?dist\/?$/.test(line)), 'app/.gitignore has dist');
  assert.ok(existsSync(join(APP, 'index.html')), 'the page Vite builds into dist/index.html');
});

// cli.js

test('cliBin: the pinned package\'s dist/Bin.js, in the package that pins it by default', () => {
  const dir = join(tmpdir(), 'aio-app-not-made');
  assert.equal(cliBin(dir), join(dir, 'node_modules', '@microsoft', 'managed-apps-cli', 'dist', 'Bin.js'));
  assert.equal(cliBin(), cliBin(CLI_PACKAGE_DIR));
});

test('pinnedVersion and installedVersion: read the package and what npm installed in it', (t) => {
  const tmp = tempDir(t);
  const ok = cliPackage(join(tmp, 'ok'), { pinned: '1.2.3' });
  assert.equal(pinnedVersion(ok), '1.2.3');
  assert.equal(installedVersion(ok), '1.2.3');
  const older = cliPackage(join(tmp, 'older'), { pinned: '1.2.3', installed: '1.0.0' });
  assert.equal(installedVersion(older), '1.0.0');
  const missing = cliPackage(join(tmp, 'missing'), { pinned: '1.2.3', installed: null });
  assert.equal(pinnedVersion(missing), '1.2.3');
  assert.equal(installedVersion(missing), undefined);
  put(join(tmp, 'broken', 'node_modules', '@microsoft', 'managed-apps-cli', 'package.json'), '{ not json');
  assert.equal(installedVersion(join(tmp, 'broken')), undefined);
  assert.equal(installedVersion(join(tmp, 'nothing')), undefined);
  assert.throws(() => pinnedVersion(join(tmp, 'nothing')), { code: 'ENOENT' });
});

test(`nodeOk: ${MIN_NODE} or later, by major, minor and patch`, () => {
  /** @type {[string, boolean][]} */
  const cases = [
    [`v${MIN_NODE}`, true],
    [MIN_NODE, true],
    ['v24.11.1', true],
    ['v24.12.0', true],
    ['v25.0.0', true],
    ['v100.0.0', true],
    ['v24.10.0', false],
    ['v24.10.99', false],
    ['v23.99.99', false],
    ['v22.20.0', false],
    ['v20.19.5', false],
    // Pre-release and nightly builds count as their version: only the first three numbers are read.
    ['v24.11.0-rc.1', true],
    ['v25.0.0-nightly20260101abcdef', true],
    ['v24.10.0-rc.1', false],
    // Missing parts count as 0.
    ['v24.11', true],
    ['v24', false],
    // Anything else isn't new enough.
    ['garbage', false],
    ['', false],
    ['v', false],
    ['vv24.11.0', false],
  ];
  for (const [version, ok] of cases) assert.equal(nodeOk(version), ok, version);
  assert.equal(nodeOk('v18.0.0', '18.0.0'), true);
  assert.equal(nodeOk('v17.9.9', '18.0.0'), false);
  assert.equal(nodeOk('v20.0.0', 'v20.0.1'), false);
});

test('createCli: runs `node <Bin.js> ...` with the JSON flags, no shell, and the env added to this process\'s', async () => {
  const before = { ...process.env };
  const { spawn, calls } = scriptedSpawn(() => json(0, { success: true, signedIn: false }));
  const cliDir = join(tmpdir(), 'aio-app-not-made');
  const { run, bin } = createCli({ cliDir, spawn, node: 'node-24', env: { LOCALAPPDATA: join(cliDir, 'local'), AIO_APP_TEST: '1' } });
  assert.equal(bin, cliBin(cliDir));
  const untrusted = 'Viewers"; rm -rf / & echo %PATH% $(whoami) `id` | more > out.txt';
  const r = await run(['app', 'share', untrusted, '--access', 'play'], { cwd: join(cliDir, 'app') });
  assert.equal(calls.length, 1);
  const [{ command, argv, options, child }] = calls;
  assert.equal(command, 'node-24');
  assert.deepEqual(argv, [bin, 'app', 'share', untrusted, '--access', 'play', '--non-interactive', '--json', '--no-color']);
  assert.equal(options.cwd, join(cliDir, 'app'));
  assert.ok(!('shell' in options), 'no shell, so no argument is ever parsed by one');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.LOCALAPPDATA, join(cliDir, 'local'));
  assert.equal(options.env.AIO_APP_TEST, '1');
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'LOCALAPPDATA') assert.equal(options.env[key], value, key);
  }
  assert.deepEqual({ ...process.env }, before, "process.env isn't changed");
  assert.equal(child.stdout.encoding, 'utf8');
  assert.equal(child.stderr.encoding, 'utf8');
  assert.deepEqual(r, { ok: true, exitCode: 0, data: { success: true, signedIn: false }, stdout: json(0, { success: true, signedIn: false }).stdout, stderr: '' });
});

test('createCli: by default runs the pinned package\'s CLI with this Node.js', async () => {
  const { spawn, calls } = scriptedSpawn(() => json(0, { success: true }));
  const { run, bin } = createCli({ spawn });
  await run(['auth', 'status']);
  assert.equal(bin, cliBin(CLI_PACKAGE_DIR));
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].argv[0], bin);
  assert.equal(calls[0].options.cwd, undefined);
});

test('createCli: on screen it hands over the terminal, without the JSON flags, and reads no JSON', async () => {
  const { spawn, calls } = scriptedSpawn((argv) => ({ code: argv.includes('bad@contoso.com') ? 1 : 0 }));
  const { run, bin } = createCli({ cliDir: join(tmpdir(), 'aio-app-not-made'), spawn });
  const r = await run(['auth', 'login', '--account', USER], { onScreen: true });
  assert.deepEqual(calls[0].argv, [bin, 'auth', 'login', '--account', USER]);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(calls[0].options.windowsHide, false);
  assert.deepEqual(r, { ok: true, exitCode: 0, data: undefined, stdout: '', stderr: '' });
  const bad = await run(['auth', 'login', '--account', 'bad@contoso.com'], { onScreen: true });
  assert.deepEqual(bad, { ok: false, exitCode: 1, data: undefined, error: 'The CLI stopped with exit code 1.', stdout: '', stderr: '' });
});

test('createCli: reads the JSON from stdout, or stderr, and success: false fails even with exit 0', async () => {
  /** @type {Output[]} */
  const outputs = [
    { stdout: ['Checking...\n{\n  "success": true,', '\n  "appId": "a"\n}\n'] },
    { code: 1, stdout: 'Deploying\n', stderr: '{"success":false,"errorMessage":"  Upload failed.  ","errorData":{"serverMessage":"No."}}\n' },
    json(0, { success: false, errorMessage: 'It said no.' }),
    json(0, { success: true, errorData: { note: 'kept' } }),
    json(1, { success: true }),
  ];
  const { spawn } = scriptedSpawn(() => /** @type {Output} */ (outputs.shift()));
  const { run } = createCli({ cliDir: join(tmpdir(), 'aio-app-not-made'), spawn });

  const split = await run(['app', 'deploy']);
  assert.equal(split.ok, true);
  assert.deepEqual(split.data, { success: true, appId: 'a' });
  assert.equal(split.error, undefined);

  const onStderr = await run(['app', 'deploy']);
  assert.equal(onStderr.ok, false);
  assert.equal(onStderr.exitCode, 1);
  assert.deepEqual(onStderr.data, { success: false, errorMessage: '  Upload failed.  ', errorData: { serverMessage: 'No.' } });
  assert.equal(onStderr.error, 'Upload failed.');
  assert.deepEqual(onStderr.errorData, { serverMessage: 'No.' });
  assert.equal(onStderr.stdout, 'Deploying\n');

  const refused = await run(['app', 'deploy']);
  assert.equal(refused.ok, false);
  assert.equal(refused.exitCode, 0);
  assert.equal(refused.error, 'It said no.');

  const noted = await run(['app', 'deploy']);
  assert.equal(noted.ok, true);
  assert.deepEqual(noted.errorData, { note: 'kept' }, 'errorData is passed on even when it worked');

  const exit1 = await run(['app', 'deploy']);
  assert.equal(exit1.ok, false, 'a non-zero exit fails, whatever the JSON says');
  assert.equal(exit1.error, 'The CLI stopped with exit code 1.');
});

test('createCli: the error is the CLI\'s message, else the end of stderr, else the exit code', async () => {
  /** @type {Output[]} */
  const outputs = [
    { code: 2, stdout: '{"success":false,"errorMessage":"   ","errorCode":"X"}', stderr: 'one\r\n\r\n  two  \r\nthree\nfour\nfive\nsix\nseven\n\n' },
    { code: 2, stdout: '{"success":false,"errorMessage":{"text":"not a string"}}', stderr: 'only line' },
    { code: 4 },
    { code: null },
  ];
  const { spawn } = scriptedSpawn(() => /** @type {Output} */ (outputs.shift()));
  const { run } = createCli({ cliDir: join(tmpdir(), 'aio-app-not-made'), spawn });
  assert.equal((await run(['app', 'deploy'])).error, 'three\nfour\nfive\nsix\nseven');
  assert.equal((await run(['app', 'deploy'])).error, 'only line');
  assert.equal((await run(['app', 'deploy'])).error, 'The CLI stopped with exit code 4.');
  const killed = await run(['app', 'deploy']);
  assert.deepEqual(killed, { ok: false, exitCode: null, data: undefined, error: 'The CLI stopped.', stdout: '', stderr: '' });
});

test("createCli: a CLI that can't start says so, once", async () => {
  const { spawn: throwing } = scriptedSpawn(() => ({ throws: new Error('spawn EACCES') }));
  const first = await createCli({ cliDir: join(tmpdir(), 'aio-app-not-made'), spawn: throwing }).run(['auth', 'status']);
  assert.deepEqual(first, { ok: false, exitCode: null, data: undefined, error: "Couldn't start the managed apps CLI: spawn EACCES", stdout: '', stderr: '' });

  const { spawn: erroring } = scriptedSpawn(() => ({ error: new Error('spawn node ENOENT'), code: -4058, stdout: '{"success":true}' }));
  const second = await createCli({ cliDir: join(tmpdir(), 'aio-app-not-made'), spawn: erroring }).run(['auth', 'status']);
  assert.deepEqual(second, {
    ok: false,
    exitCode: null,
    data: undefined,
    error: "Couldn't start the managed apps CLI: spawn node ENOENT",
    stdout: '{"success":true}',
    stderr: '',
  }, "the 'close' after the 'error' doesn't change it");
});

test('createCli: a command still running after 5 minutes is killed, and says so', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, calls } = scriptedSpawn(() => ({ hang: true, stdout: 'Waiting\n' }));
  const { run } = createCli({ cliDir: join(tmpdir(), 'aio-app-not-made'), spawn });
  const pending = run(['app', 'share', 'list']);
  t.mock.timers.tick(COMMAND_TIMEOUT_MS - 1);
  assert.equal(calls[0].child.killed, false);
  t.mock.timers.tick(1);
  assert.equal(calls[0].child.killed, true);
  assert.deepEqual(await pending, {
    ok: false,
    exitCode: null,
    data: undefined,
    error: "It didn't finish within 5 minutes, so it was stopped.",
    stdout: 'Waiting\n',
    stderr: '',
    timedOut: true,
  });
});

test('createCli: a deploy gets 30 minutes, and a time-out is explained as one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, calls } = scriptedSpawn(() => ({ hang: true }));
  const { run } = createCli({ cliDir: join(tmpdir(), 'aio-app-not-made'), spawn });
  const pending = deployApp(run, { appDir: join(tmpdir(), 'aio-app-not-made') });
  t.mock.timers.tick(COMMAND_TIMEOUT_MS);
  assert.equal(calls[0].child.killed, false, 'not at 5 minutes');
  t.mock.timers.tick(DEPLOY_TIMEOUT_MS - COMMAND_TIMEOUT_MS);
  assert.equal(calls[0].child.killed, true);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? undefined : r.problem, {
    who: 'you',
    what: `It took too long, so it was stopped. Run ${deployAgain()}: it picks up where it stopped.`,
    message: "It didn't finish within 30 minutes, so it was stopped.",
  });
});

test('createCli: the time limit is cleared when the command ends, can be changed, and 0 means none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, calls } = scriptedSpawn((argv) => (argv.includes('hang') ? { hang: true } : json(0, { success: true })));
  const { run } = createCli({ cliDir: join(tmpdir(), 'aio-app-not-made'), spawn, timeoutMs: 2 * 60_000 });

  assert.equal((await run(['auth', 'status'])).ok, true);
  t.mock.timers.tick(DEPLOY_TIMEOUT_MS);
  assert.equal(calls[0].child.killed, false, "a finished command's timer doesn't fire");

  const slow = run(['hang']);
  t.mock.timers.tick(2 * 60_000);
  assert.equal(calls[1].child.killed, true);
  assert.equal((await slow).error, "It didn't finish within 2 minutes, so it was stopped.");

  const unlimited = run(['hang'], { timeoutMs: 0 });
  t.mock.timers.tick(DEPLOY_TIMEOUT_MS * 10);
  assert.equal(calls[2].child.killed, false);
  calls[2].child.emit('close', 0);
  assert.equal((await unlimited).ok, true);
});

test('createCli: keeps the last million characters of each stream, where the JSON and the errors are', async () => {
  const big = 'x'.repeat(1_000_000);
  const { spawn } = scriptedSpawn(() => ({ stdout: [`${big}\n`, '{"success":true,"appId":"a"}'], stderr: [big, '\nlast line'] }));
  const r = await createCli({ cliDir: join(tmpdir(), 'aio-app-not-made'), spawn }).run(['app', 'deploy']);
  assert.equal(r.stdout.length, 1_000_000);
  assert.ok(r.stdout.endsWith('\n{"success":true,"appId":"a"}'));
  assert.deepEqual(r.data, { success: true, appId: 'a' });
  assert.equal(r.stderr.length, 1_000_000);
  assert.ok(r.stderr.endsWith('x\nlast line'));
});

test('parseJson: the object the CLI printed, with output before or after it', () => {
  assert.equal(parseJson(undefined), undefined);
  assert.equal(parseJson(''), undefined);
  assert.equal(parseJson(' \r\n '), undefined);
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('\uFEFF{"a":1}'), { a: 1 }, 'a BOM');
  assert.deepEqual(parseJson('{\r\n  "a": 1\r\n}\r\n'), { a: 1 }, 'pretty, with CRLF');
  assert.deepEqual(parseJson('Packing\r\nUploading\r\n{\r\n  "success": true,\r\n  "nested": {\r\n    "b": [1, 2]\r\n  }\r\n}\r\n'), { success: true, nested: { b: [1, 2] } });
  assert.deepEqual(parseJson('{"a":1}\nDone in 3s.'), { a: 1 }, 'output after it');
  assert.deepEqual(parseJson('Before\n{\n  "a": 1\n}\nDone.\n'), { a: 1 }, 'pretty, between other output');
  assert.deepEqual(parseJson('{"step":1}\n{"step":2}\n'), { step: 2 }, 'the last one');
  assert.equal(parseJson('[{"a":1}]'), undefined, 'an array');
  assert.equal(parseJson('42'), undefined);
  assert.equal(parseJson('null'), undefined);
  assert.equal(parseJson('"text"'), undefined);
  assert.equal(parseJson('Error: {"a":1}'), undefined, 'a { mid-line');
  assert.equal(parseJson('{not json}\n{also not'), undefined);
});

// steps.js, each with a fake runner.

/** A folder the steps are pointed at but nothing makes. */
const NOT_MADE = join(tmpdir(), 'aio-app-not-made');

/**
 * A runner that records each command and gives what `answer` returns for it, over an exit 0 that
 * printed nothing.
 * @param {(args: string[], options: RunOptions | undefined) => Partial<CliResult>} [answer]
 */
function fakeRun(answer = () => ({})) {
  /** @type {{ args: string[], options: RunOptions | undefined }[]} */
  const calls = [];
  /** @type {RunCli} */
  const run = async (args, options) => {
    calls.push({ args, options });
    return { ok: true, exitCode: 0, data: undefined, stdout: '', stderr: '', ...answer(args, options) };
  };
  return { run, calls };
}

/** What a command that worked printed. @param {Record<string, any>} data @returns {Partial<CliResult>} */
const printed = (data) => ({ data });

/**
 * A command that failed, as createCli returns it.
 * @param {number | null} exitCode
 * @param {string} [error]
 * @param {Partial<CliResult>} [more]
 * @returns {Partial<CliResult>}
 */
const failedWith = (exitCode, error, more = {}) => ({ ok: false, exitCode, ...(error ? { error } : {}), ...more });

/** A step's problem, when it failed. @param {{ ok: boolean, problem?: Problem }} r */
const problemOf = (r) => (r.ok ? undefined : r.problem);

/** What explain says to a failure it doesn't recognise. */
const GENERIC = { who: 'you', what: `Run ${deployAgain()}. If it fails the same way, open an issue with the message above.`, link: LINKS.issues };
/** What it says when the CLI couldn't reach Microsoft. */
const NETWORK = { who: 'you', what: `It couldn't reach Microsoft. Check your connection or proxy, then run ${deployAgain()}.` };

/** Output, a line per entry, as the UI writes it. @param {...string} ls */
const outLines = (...ls) => ls.map((l) => `${l}\n`).join('');

test('authStatus: who the CLI is signed in as, and the accounts it has', async () => {
  /** @type {[Record<string, any> | undefined, { signedIn: boolean, account?: string, accounts: string[] }][]} */
  const cases = [
    [
      { success: true, signedIn: true, activeAccount: { username: USER }, accounts: [{ username: USER }, { username: OTHER_USER }] },
      { signedIn: true, account: USER, accounts: [USER, OTHER_USER] },
    ],
    [{ success: true, signedIn: false, accounts: [{ username: USER }] }, { signedIn: false, accounts: [USER] }],
    [{ success: true, signedIn: false, activeAccount: { username: USER }, accounts: [] }, { signedIn: false, account: USER, accounts: [] }],
    [{ success: true, signedIn: true, accounts: [{ username: USER }] }, { signedIn: false, accounts: [USER] }],
    [undefined, { signedIn: false, accounts: [] }],
    [
      { success: true, signedIn: 'yes', activeAccount: { username: 42 }, accounts: [{ username: OTHER_USER }, { username: 7 }, null, 'text', {}] },
      { signedIn: false, accounts: [OTHER_USER] },
    ],
    [{ success: true, signedIn: true, activeAccount: { username: USER }, accounts: { username: USER } }, { signedIn: true, account: USER, accounts: [] }],
  ];
  for (const [data, expected] of cases) {
    const { run, calls } = fakeRun(() => ({ data }));
    assert.deepEqual(await authStatus(run), { ok: true, ...expected }, JSON.stringify(data));
    assert.deepEqual(calls, [{ args: ['auth', 'status'], options: undefined }]);
  }
});

test('authStatus: a CLI never signed in exits 3, which is nobody signed in; other failures say who fixes them', async () => {
  assert.deepEqual(await authStatus(fakeRun(() => failedWith(3, 'Not signed in. Run ms auth login.')).run), { ok: true, signedIn: false, accounts: [] });
  const r = await authStatus(fakeRun(() => failedWith(5, 'getaddrinfo ENOTFOUND login.microsoftonline.com')).run);
  assert.equal(r.ok, false);
  assert.deepEqual(problemOf(r), { ...NETWORK, message: 'getaddrinfo ENOTFOUND login.microsoftonline.com' });
  assert.equal(r.ok ? undefined : r.result?.exitCode, 5, "the CLI's result is kept");
});

test('switchAccount and login: the account to use, with the sign-in on screen', async () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(await switchAccount(run, USER), { ok: true });
  assert.deepEqual(await login(run, { account: USER }), { ok: true });
  assert.deepEqual(await login(run, {}), { ok: true });
  assert.deepEqual(calls, [
    { args: ['auth', 'switch', '--account', USER], options: undefined },
    { args: ['auth', 'login', '--account', USER], options: { onScreen: true } },
    { args: ['auth', 'login'], options: { onScreen: true } },
  ]);
  const refused = fakeRun(() => failedWith(1, 'The browser sign-in was cancelled.'));
  assert.deepEqual(problemOf(await switchAccount(refused.run, OTHER_USER)), { ...GENERIC, message: 'The browser sign-in was cancelled.' });
  assert.deepEqual(problemOf(await login(refused.run, { account: USER })), { ...GENERIC, message: 'The browser sign-in was cancelled.' });
});

test('createApp: `app init` for the build in ./dist, in the app folder, in the environment only when one is named', async () => {
  const { run, calls } = fakeRun(() => printed({ success: true, appId: appId(1), environmentId: DEV_ENV }));
  assert.deepEqual(await createApp(run, { appDir: NOT_MADE, displayName: APP_NAME }), { ok: true, appId: appId(1), environmentId: DEV_ENV });
  await createApp(run, { appDir: NOT_MADE, displayName: APP_NAME, environmentId: OTHER_ENV });
  await createApp(run, { appDir: NOT_MADE, displayName: APP_NAME, environmentId: '' });
  const init = ['app', 'init', '--repo', 'none', '--display-name', 'AI in One', '--build-type', 'none', '--build-path', './dist'];
  assert.deepEqual(calls, [
    { args: init, options: { cwd: NOT_MADE } },
    { args: [...init, '--environment-id', OTHER_ENV], options: { cwd: NOT_MADE } },
    { args: init, options: { cwd: NOT_MADE } },
  ]);
});

test("createApp: the app's ID and environment, from what init printed or the ms.config.json it wrote", async (t) => {
  const dir = tempDir(t);
  put(
    join(dir, APP_CONFIG),
    `\uFEFF${JSON.stringify({ appId: appId(2), environmentId: OTHER_ENV, appDisplayName: APP_NAME, buildPath: BUILD_PATH }, null, 2).replaceAll('\n', '\r\n')}\r\n`,
  );
  /** @param {Record<string, any>} data @param {string} [environmentId] */
  const create = (data, environmentId) => createApp(fakeRun(() => ({ data })).run, { appDir: dir, displayName: APP_NAME, environmentId });
  assert.deepEqual(await create({ success: true }), { ok: true, appId: appId(2), environmentId: OTHER_ENV }, 'the file, with a BOM and CRLF');
  assert.deepEqual(await create({ success: true, appId: appId(1), environmentId: DEV_ENV }), { ok: true, appId: appId(1), environmentId: DEV_ENV }, 'what it printed first');
  assert.deepEqual(await create({ success: true, appId: appId(1) }), { ok: true, appId: appId(1), environmentId: OTHER_ENV });
  rmSync(join(dir, APP_CONFIG));
  assert.deepEqual(await create({ success: true, appId: appId(1) }, DEV_ENV), { ok: true, appId: appId(1), environmentId: DEV_ENV }, 'the environment it was given');
});

test('createApp: an app made without an ID or environment it can read says to delete it; a folder that has an app is updated', async () => {
  const notSaved = { who: 'you', what: "The app was made, but its ID wasn't saved. Delete it at managedapps.cloud.microsoft, then run it again." };
  /** @type {Record<string, any>[]} */
  const outputs = [
    { success: true },
    { success: true, appId: 'my-app', environmentId: DEV_ENV },
    { success: true, appId: appId(1) },
    { success: true, appId: appId(1), environmentId: 42 },
    { success: true, appId: appId(1), environmentId: '' },
  ];
  for (const data of outputs) {
    const r = await createApp(fakeRun(() => ({ data })).run, { appDir: NOT_MADE, displayName: APP_NAME });
    assert.deepEqual(problemOf(r), notSaved, JSON.stringify(data));
    assert.equal(r.ok ? undefined : r.result?.ok, true, 'the CLI said it worked');
  }
  const twice = await createApp(fakeRun(() => failedWith(1, 'ms.config.json already exists in this folder.')).run, { appDir: NOT_MADE, displayName: APP_NAME });
  assert.deepEqual(problemOf(twice), {
    who: 'you',
    what: `The app's folder already has an app. Run ${deployAgain()} to update that app.`,
    message: 'ms.config.json already exists in this folder.',
  });
});

test('deployApp: `app deploy` with 30 minutes to finish, the link it printed, and its warnings as text', async () => {
  const { run, calls } = fakeRun(() =>
    printed({ success: true, appPlayUri: playUri(appId(1)), warnings: ['The bundle is large.', { message: 'No icon.' }, { code: 'W1' }, ''] }),
  );
  assert.deepEqual(await deployApp(run, { appDir: NOT_MADE }), {
    ok: true,
    playUrl: playUri(appId(1)),
    warnings: ['The bundle is large.', 'No icon.', '{"code":"W1"}'],
  });
  assert.deepEqual(calls, [{ args: ['app', 'deploy'], options: { cwd: NOT_MADE, timeoutMs: DEPLOY_TIMEOUT_MS } }]);
  const odd = fakeRun(() => printed({ success: true, appPlayUri: { href: playUri(appId(1)) }, warnings: 'The bundle is large.' }));
  assert.deepEqual(await deployApp(odd.run, { appDir: NOT_MADE }), { ok: true, warnings: [] });
  assert.deepEqual(await deployApp(fakeRun().run, { appDir: NOT_MADE }), { ok: true, warnings: [] }, 'nothing printed');
  const failed = fakeRun(() =>
    failedWith(1, 'Upload failed.', { errorData: { serverMessage: '  The package is too large.  ', stderrTail: 'Retrying the upload\n', stdoutTail: '   ' } }),
  );
  assert.deepEqual(problemOf(await deployApp(failed.run, { appDir: NOT_MADE })), {
    ...GENERIC,
    message: 'Upload failed.',
    details: 'The package is too large.\nRetrying the upload',
  });
});

test("shareApp: shares the app to play with everyone listed, and says what it couldn't share", async () => {
  const { run, calls } = fakeRun(() =>
    printed({
      success: true,
      partialFailure: true,
      warnings: [{ input: 'nobody@contoso.com', reason: 'No such user.' }, { input: GROUP_2 }, { reason: 'Something else.' }, 'Plain text.', { input: '', reason: 'Empty input.' }],
    }),
  );
  assert.deepEqual(await shareApp(run, { appDir: NOT_MADE, principals: [GROUP, GROUP_2, 'nobody@contoso.com'] }), {
    ok: true,
    partial: true,
    rejected: ['nobody@contoso.com', GROUP_2],
    warnings: ['nobody@contoso.com: No such user.', GROUP_2, 'Something else.', 'Plain text.', 'Empty input.'],
  });
  assert.deepEqual(calls, [{ args: ['app', 'share', `${GROUP},${GROUP_2},nobody@contoso.com`, '--access', 'play'], options: { cwd: NOT_MADE } }]);
  assert.deepEqual(await shareApp(fakeRun().run, { appDir: NOT_MADE, principals: [GROUP] }), { ok: true, partial: false, rejected: [], warnings: [] });
  const policy = fakeRun(() => failedWith(1, 'Sharing is blocked by an environment or tenant policy.'));
  assert.deepEqual(problemOf(await shareApp(policy.run, { appDir: NOT_MADE, principals: [GROUP] })), {
    who: 'Power Platform admin',
    what: 'A policy blocks sharing apps in this environment. Allow it, or deploy to another environment with --environment-id.',
    link: LINKS.share,
    message: 'Sharing is blocked by an environment or tenant policy.',
  });
});

test("verifyShare: the object IDs the app's share list lacks, in any case", async () => {
  const mixed = '00000000-0000-0000-0000-0000000000Cd';
  const { run, calls } = fakeRun(() =>
    printed({
      success: true,
      results: [
        { value: [{ principalObjectId: mixed.toUpperCase(), access: 'play' }, { principalObjectId: 42 }, null, 'text'] },
        { value: 'not a list' },
        null,
        { value: [{ principalObjectId: GROUP }] },
      ],
    }),
  );
  assert.deepEqual(await verifyShare(run, { appDir: NOT_MADE, ids: [mixed.toLowerCase(), GROUP, GROUP_2, 'nobody@contoso.com'] }), { ok: true, missing: [GROUP_2] });
  assert.deepEqual(calls, [{ args: ['app', 'share', 'list', '--access', 'play'], options: { cwd: NOT_MADE } }]);

  const none = fakeRun();
  assert.deepEqual(await verifyShare(none.run, { appDir: NOT_MADE, ids: ['nobody@contoso.com', ''] }), { ok: true, missing: [] });
  assert.deepEqual(none.calls, [], 'no object ID to look for, so no command');
  assert.deepEqual(await verifyShare(fakeRun(() => printed({ success: true })).run, { appDir: NOT_MADE, ids: [GROUP, GROUP_2] }), { ok: true, missing: [GROUP, GROUP_2] });
  assert.deepEqual(problemOf(await verifyShare(fakeRun(() => failedWith(5)).run, { appDir: NOT_MADE, ids: [GROUP] })), NETWORK);
});

test("playUrl: the app's link from `app play`, without a browser", async () => {
  const { run, calls } = fakeRun(() => printed({ success: true, url: playUri(appId(1)) }));
  assert.deepEqual(await playUrl(run, { appDir: NOT_MADE }), { ok: true, url: playUri(appId(1)) });
  assert.deepEqual(calls, [{ args: ['app', 'play', '--no-browser'], options: { cwd: NOT_MADE } }]);
  assert.deepEqual(problemOf(await playUrl(fakeRun(() => printed({ success: true, url: 42 })).run, { appDir: NOT_MADE })), GENERIC, 'no link');
  assert.deepEqual(problemOf(await playUrl(fakeRun(() => failedWith(6, 'App was not found.')).run, { appDir: NOT_MADE })), { ...GENERIC, message: 'App was not found.' });
});

test('deleteApp: deletes the app by ID in its environment, and one already gone is fine', async () => {
  const { run, calls } = fakeRun(() => printed({ success: true, existed: true }));
  assert.deepEqual(await deleteApp(run, { appId: appId(1), environmentId: DEV_ENV, cwd: NOT_MADE }), { ok: true, existed: true });
  assert.deepEqual(await deleteApp(run, { appId: appId(1) }), { ok: true, existed: true });
  assert.deepEqual(calls, [
    { args: ['app', 'delete', '--force', '--app', appId(1), '--environment-id', DEV_ENV], options: { cwd: NOT_MADE } },
    { args: ['app', 'delete', '--force', '--app', appId(1)], options: { cwd: undefined } },
  ]);
  assert.deepEqual(await deleteApp(fakeRun(() => failedWith(6, `App ${appId(1)} was not found.`)).run, { appId: appId(1) }), { ok: true, existed: false }, 'exit 6');
  assert.deepEqual(await deleteApp(fakeRun(() => printed({ success: true, existed: false })).run, { appId: appId(1) }), { ok: true, existed: false });
  assert.deepEqual(await deleteApp(fakeRun().run, { appId: appId(1) }), { ok: true, existed: true }, "deleted, unless it says it wasn't there");
  const refused = fakeRun(() => failedWith(1, "You don't have permission to delete this app."));
  assert.deepEqual(problemOf(await deleteApp(refused.run, { appId: appId(1) })), { ...GENERIC, message: "You don't have permission to delete this app." });
});

test("readAppConfig: the ID, environment and name in ms.config.json, or nothing when the folder isn't an app", (t) => {
  const tmp = tempDir(t);
  /** @param {string} name @param {string} text */
  const folder = (name, text) => {
    put(join(tmp, name, APP_CONFIG), text);
    return join(tmp, name);
  };
  const body = { appId: appId(1), environmentId: DEV_ENV, appDisplayName: APP_NAME, buildPath: BUILD_PATH };
  const read = { appId: appId(1), environmentId: DEV_ENV, displayName: APP_NAME, config: body };
  assert.deepEqual(readAppConfig(folder('plain', JSON.stringify(body))), read);
  assert.deepEqual(readAppConfig(folder('bom', `\uFEFF${JSON.stringify(body, null, 2).replaceAll('\n', '\r\n')}\r\n`)), read, 'a BOM and CRLF');
  const unnamed = { appId: appId(1), environmentId: DEV_ENV, appDisplayName: 7 };
  assert.deepEqual(readAppConfig(folder('unnamed', JSON.stringify(unnamed))), { appId: appId(1), environmentId: DEV_ENV, config: unnamed });
  /** @type {[string, string][]} */
  const bad = [
    ['broken', '{ "appId": '],
    ['null', 'null'],
    ['list', JSON.stringify([body])],
    ['no-id', JSON.stringify({ environmentId: DEV_ENV })],
    ['empty-id', JSON.stringify({ appId: '', environmentId: DEV_ENV })],
    ['number-id', JSON.stringify({ appId: 1, environmentId: DEV_ENV })],
    ['no-env', JSON.stringify({ appId: appId(1) })],
    ['number-env', JSON.stringify({ appId: appId(1), environmentId: 1 })],
  ];
  for (const [name, text] of bad) assert.equal(readAppConfig(folder(name, text)), undefined, name);
  assert.equal(readAppConfig(join(tmp, 'nothing')), undefined, 'no folder');
});

test('isGuid and stripBom', () => {
  assert.equal(isGuid(GROUP), true);
  assert.equal(isGuid(CLI_APP_ID.toUpperCase()), true);
  /** @type {unknown[]} */
  const notGuids = [`{${GROUP}}`, ` ${GROUP}`, `${GROUP}\n`, GROUP.replaceAll('-', ''), GROUP.slice(1), `g${GROUP.slice(1)}`, '', undefined, null, 42, {}];
  for (const value of notGuids) assert.equal(isGuid(value), false, JSON.stringify(value));
  assert.equal(stripBom('\uFEFF{}'), '{}');
  assert.equal(stripBom('\uFEFF\uFEFF{}'), '\uFEFF{}', 'one BOM');
  assert.equal(stripBom('{}\uFEFF'), '{}\uFEFF', 'only at the start');
  assert.equal(stripBom(''), '');
});

// errors.js

/** What explain says to a sign-in that didn't work. */
const SIGN_IN = { who: 'you', what: `Your sign-in didn't work or has expired. Run ${deployAgain()}, and sign in when it asks.` };

test('notReady: the admin settings a failure says are off, from its message, its codes and the server message only', () => {
  /** @type {[Failure, string[]][]} */
  const cases = [
    [{ error: "You don't have permission to create an app in this environment." }, ['createApps']],
    [{ error: 'Ask your admin to grant you the required permission.' }, ['createApps']],
    [{ error: 'Refused.', data: { errorCode: 'EnvironmentPermissionDenied' } }, ['createApps']],
    [{ error: 'Refused.', errorData: { errorCode: 'InsufficientPrivilege' } }, ['createApps']],
    [{ errorData: { serverMessage: 'The user does not have the required privilege.' } }, ['createApps']],
    [{ error: 'External artifacts are turned off for this environment.' }, ['externalArtifacts']],
    [{ error: 'Refused.', data: { errorCode: 'ExternalArtifactDeploymentDisabled' } }, ['externalArtifacts']],
    [{ errorData: { errorCode: 'CodeAppOperationNotAllowedInEnvironment' } }, ['externalArtifacts']],
    [{ errorData: { serverMessage: 'Set AllowExternalArtifactDeployment to true.' } }, ['externalArtifacts']],
    [{ error: 'insufficientprivilege', errorData: { serverMessage: 'EXTERNAL ARTIFACT deployment is off.' } }, ['createApps', 'externalArtifacts']],
    [{ error: 'Upload failed.' }, []],
    [{}, []],
    [{ data: { errorCode: 42 }, errorData: { errorCode: ['InsufficientPrivilege'], serverMessage: { text: 'external artifact' } } }, []],
    [{ errorData: 'InsufficientPrivilege' }, []],
    [{ data: { errorMessage: 'You need permission to create an app.' }, errorData: { stderrTail: 'InsufficientPrivilege' } }, []],
  ];
  for (const [result, expected] of cases) assert.deepEqual(notReady(result), expected, JSON.stringify(result));
});

test("notReady and explain: the fake CLI's answers for a tenant that isn't ready, read through createCli", async () => {
  const outputs = [CREATE_APPS_OFF, EXTERNAL_ARTIFACTS_OFF, BOTH_OFF, EXPIRED, json(1, { success: false, errorMessage: 'Upload failed.' })];
  const { spawn } = scriptedSpawn(() => /** @type {Output} */ (outputs.shift()));
  const { run } = createCli({ cliDir: NOT_MADE, spawn, node: 'node' });

  const createOff = await run(['app', 'init']);
  assert.deepEqual(notReady(createOff), ['createApps']);
  assert.deepEqual(explain('init', createOff), {
    ...ADMIN_STEPS.createApps,
    message: "You don't have permission to create an app in this environment. Ask your admin to grant you the required permission.",
    details: 'The user does not have the required privilege in this environment.',
  });
  const artifactsOff = await run(['app', 'deploy']);
  assert.deepEqual(notReady(artifactsOff), ['externalArtifacts']);
  assert.deepEqual(explain('deploy', artifactsOff), {
    ...ADMIN_STEPS.externalArtifacts,
    message: 'The deployment was refused.',
    details: 'Code app operations are not allowed in this environment.',
  });
  const bothOff = await run(['app', 'init']);
  assert.deepEqual(notReady(bothOff), ['createApps', 'externalArtifacts']);
  assert.deepEqual(explain('init', bothOff), { ...ADMIN_STEPS.createApps, message: 'The request was refused.', details: 'ExternalArtifactDeploymentDisabled' }, 'the first one');
  const expired = await run(['app', 'deploy']);
  assert.deepEqual(notReady(expired), []);
  assert.deepEqual(explain('deploy', expired), { ...SIGN_IN, message: 'Your sign-in session has expired. Run ms auth login.' });
  const other = await run(['app', 'deploy']);
  assert.deepEqual(notReady(other), []);
  assert.deepEqual(explain('deploy', other), { ...GENERIC, message: 'Upload failed.' });
});

test('explain: who fixes each failure the CLI reports, and how', () => {
  const again = deployAgain();
  const envNotFound = { who: 'you', what: "That environment wasn't found. Check --environment-id, or leave it out to use your own developer environment." };
  const checkGroup = { who: 'you', what: 'Check the viewer group is in your organisation, then share the app with it at managedapps.cloud.microsoft.', link: LINKS.share };
  const busy = { who: 'you', what: `The service is busy. Wait a few minutes, then run ${again}.` };
  /** @type {[Failure, Omit<Problem, 'message' | 'details'>][]} */
  const cases = [
    [
      { exitCode: 1, error: 'AADSTS53003: Access has been blocked by Conditional Access policies.' },
      {
        who: 'Entra admin',
        what: `Conditional Access blocked the sign-in. Allow the managed apps CLI (app ID ${CLI_APP_ID}) in the policy, or sign in from a device it allows.`,
      },
    ],
    [
      { exitCode: null, error: "It didn't finish within 30 minutes, so it was stopped.", timedOut: true },
      { who: 'you', what: `It took too long, so it was stopped. Run ${again}: it picks up where it stopped.` },
    ],
    [{ exitCode: 3, error: 'Unauthorized.' }, SIGN_IN],
    [{ exitCode: 1, error: 'Your sign-in session has expired.' }, SIGN_IN],
    [{ exitCode: 1, error: 'You are NOT signed in.' }, SIGN_IN],
    [{ exitCode: 1, error: 'Run ms auth login first.' }, SIGN_IN],
    [{ exitCode: 1, error: 'Ask your admin to grant you the required permission.' }, ADMIN_STEPS.createApps],
    [{ exitCode: 1, error: 'Refused.', errorData: { errorCode: 'ExternalArtifactDeploymentDisabled' } }, ADMIN_STEPS.externalArtifacts],
    [
      { exitCode: 1, error: 'Failed to resolve a developer environment for you.' },
      { who: 'you', what: `Your developer environment couldn't be found. Run ${again} again, or add --environment-id with an environment you can make apps in.` },
    ],
    [{ exitCode: 1, error: `Environment ${OTHER_ENV} was not found.` }, envNotFound],
    [{ exitCode: 1, error: 'The environment you named is not found.' }, envNotFound],
    [{ exitCode: 1, error: 'ms.config.json already exists in this folder.' }, { who: 'you', what: `The app's folder already has an app. Run ${again} to update that app.` }],
    [
      { exitCode: 1, error: 'An app named AI in One already exists.' },
      {
        who: 'you',
        what: 'An app with that name already exists in the environment. Rename or delete the other one at managedapps.cloud.microsoft, then run it again.',
        link: LINKS.portal,
      },
    ],
    [
      { exitCode: 1, error: 'Sharing is blocked by an environment or tenant policy.' },
      { who: 'Power Platform admin', what: 'A policy blocks sharing apps in this environment. Allow it, or deploy to another environment with --environment-id.', link: LINKS.share },
    ],
    [{ exitCode: 1, error: 'The sharing request was rejected.' }, checkGroup],
    [{ exitCode: 1, error: 'The sharing limit for this app has been reached.' }, checkGroup],
    [{ exitCode: 5 }, NETWORK],
    [{ exitCode: 1, error: 'Could not reach the service.' }, NETWORK],
    [{ exitCode: 1, error: 'getaddrinfo ENOTFOUND login.microsoftonline.com' }, NETWORK],
    [{ exitCode: 1, error: 'read ECONNRESET' }, NETWORK],
    [{ exitCode: 1, error: 'connect ETIMEDOUT 10.0.0.1:443' }, NETWORK],
    [{ exitCode: 1, error: 'getaddrinfo EAI_AGAIN contoso.com' }, NETWORK],
    [{ exitCode: 1, error: 'A network error occurred.' }, NETWORK],
    [{ exitCode: 1, error: 'The service is temporarily unavailable.' }, busy],
    [{ exitCode: 1, error: '  Too many requests.  \n' }, busy],
    [{ exitCode: 1, error: 'Request failed with status 429.' }, busy],
    [{ exitCode: 1, error: 'HTTP 503' }, busy],
    [{ exitCode: 1, error: 'Something else went wrong.' }, GENERIC],
    [{ exitCode: 1 }, GENERIC],
  ];
  for (const [result, fix] of cases) {
    const message = (result.error ?? '').trim();
    assert.deepEqual(explain('deploy', result), { ...fix, ...(message ? { message } : {}) }, JSON.stringify(result));
  }
});

test('explain: what comes first when a failure fits more than one', () => {
  /** @param {Failure} result */
  const fixFor = (result) => {
    const { message, details, ...fix } = explain('deploy', result);
    return fix;
  };
  assert.equal(fixFor({ exitCode: 3, error: 'AADSTS53003: blocked.', timedOut: true }).who, 'Entra admin', 'Conditional Access');
  assert.match(fixFor({ exitCode: 3, error: 'Not signed in.', timedOut: true }).what, /^It took too long/, 'then a timeout');
  assert.deepEqual(fixFor({ exitCode: 3, error: "You don't have permission to create an app." }), SIGN_IN, 'then the sign-in');
  assert.deepEqual(fixFor({ exitCode: 5, error: 'Ask your admin to grant you the required permission.' }), ADMIN_STEPS.createApps, 'then the tenant settings');
  assert.match(fixFor({ exitCode: 1, error: 'Failed to resolve a developer environment: environment not found.' }).what, /^Your developer environment/);
  assert.equal(fixFor({ exitCode: 5, error: 'Sharing is blocked by an environment or tenant policy. Too many requests.' }).who, 'Power Platform admin', 'before the network');
});

test("explain: the details are the server's words, and only the message is matched", () => {
  assert.deepEqual(
    explain('deploy', { exitCode: 1, error: ' Upload failed. ', errorData: { serverMessage: ' Too large. ', stderrTail: '\nRetrying the upload\n', stdoutTail: 7 } }),
    { ...GENERIC, message: 'Upload failed.', details: 'Too large.\nRetrying the upload' },
  );
  assert.deepEqual(explain('deploy', { exitCode: 1, error: ' ', errorData: 'Too large.' }), GENERIC, 'no message, and details only from an object');
  assert.deepEqual(
    explain('deploy', { exitCode: 1, error: 'Upload failed.', errorData: { stderrTail: 'getaddrinfo ENOTFOUND login.microsoftonline.com' } }),
    { ...GENERIC, message: 'Upload failed.', details: 'getaddrinfo ENOTFOUND login.microsoftonline.com' },
  );
});

test('errors: deploy-app runs the step again, the admin steps name who does them, and the links are https', () => {
  assert.equal(deployAgain(), commandLine('deploy-app'));
  assert.match(deployAgain(), / deploy-app$/);
  for (const [name, link] of Object.entries(LINKS)) assert.match(link, /^https:\/\/\S+$/, name);
  assert.equal(LINKS.portal, 'https://managedapps.cloud.microsoft/');
  assert.equal(isGuid(CLI_APP_ID), true);
  assert.deepEqual(Object.keys(NOT_READY_NAMES).sort(), ['createApps', 'externalArtifacts']);
  for (const key of /** @type {const} */ (['createApps', 'externalArtifacts'])) {
    assert.equal(ADMIN_STEPS[key].who, 'Power Platform admin');
    assert.equal(ADMIN_STEPS[key].link, LINKS.cliSetting);
  }
  assert.equal(ADMIN_STEPS.licences.who, 'Microsoft 365 admin');
  assert.equal(ADMIN_STEPS.licences.link, LINKS.licensing);
});

// flow.js

/** A Node.js older than the CLI needs. */
const OLD_NODE = `${Number(MIN_NODE.split('.')[0]) - 1}.99.0`;
const NO_BUILD = {
  why: 'This copy of the installer has no build of the app.',
  steps: ['Use AIInOneInstaller.exe, which carries it. Or build it from a clone: in app, run npm ci, then npm run build.', `Then run: ${deployAgain()}`],
};
/** The notes after a first deploy, when the files go to SharePoint. */
const FIRST_NOTES = [
  `    Each person who opens it needs Power Apps Premium or Copilot Credits: ${ADMIN_STEPS.licences.link}`,
  '    In the app, viewers choose Change data and pick the CSV files from the AI in One folder in SharePoint, so they need read access to it.',
];
const DEPLOYING = '    Deploying the AI in One app. It takes a few minutes.';
/** @param {string} id */
const live = (id) => `  ✓ The AI in One app is live: ${playUri(id)}`;
const SHARED = `  ✓ Shared the app with ${VIEWER_GROUP_NAME}`;

test('whyNot: no build, then an older Node.js, then a CLI not installed or not the pinned one, in that order', (t) => {
  const tmp = tempDir(t);
  const distDir = makeDist(join(tmp, 'build'));
  const cliDir = cliPackage(join(tmp, 'cli'), { pinned: '2.0.0' });
  const node = `v${MIN_NODE}`;
  const then = `Then run: ${deployAgain()}`;
  assert.equal(whyNot({ distDir, cliDir, nodeVersion: node }), undefined, 'all good');

  assert.deepEqual(whyNot({ distDir: undefined, cliDir: NOT_MADE, nodeVersion: `v${OLD_NODE}` }), NO_BUILD, 'first');
  assert.deepEqual(whyNot({ distDir: join(tmp, 'nothing'), cliDir, nodeVersion: node }), NO_BUILD);
  put(join(tmp, 'no-index', 'assets', 'app.js'), '');
  assert.deepEqual(whyNot({ distDir: join(tmp, 'no-index'), cliDir, nodeVersion: node }), NO_BUILD, 'a build has index.html');

  const oldNode = {
    why: `The managed apps CLI needs Node.js ${MIN_NODE} or later, and this is ${OLD_NODE}.`,
    steps: [`Use AIInOneInstaller.exe, which carries a new enough Node.js, or install it from ${LINKS.node}.`, then],
  };
  assert.deepEqual(whyNot({ distDir, cliDir: NOT_MADE, nodeVersion: `v${OLD_NODE}` }), oldNode, 'before the CLI is read');
  assert.deepEqual(whyNot({ distDir: undefined, cliDir: NOT_MADE, nodeVersion: OLD_NODE, needBuild: false }), oldNode, 'removing needs no build');
  assert.equal(whyNot({ distDir: undefined, cliDir, nodeVersion: node, needBuild: false }), undefined);

  const install = 'Use AIInOneInstaller.exe, which carries it. Or install it in a clone: npm ci --ignore-scripts --omit=dev --prefix installer/managed-cli';
  const missing = cliPackage(join(tmp, 'missing'), { pinned: '2.0.0', installed: null });
  assert.deepEqual(whyNot({ distDir, cliDir: missing, nodeVersion: node }), { why: "The managed apps CLI isn't installed here.", steps: [install, then] });
  for (const installed of ['1.9.0', '2.0.1']) {
    const dir = cliPackage(join(tmp, installed), { pinned: '2.0.0', installed });
    assert.deepEqual(whyNot({ distDir, cliDir: dir, nodeVersion: node }), { why: `The managed apps CLI here is ${installed}, and the installer needs 2.0.0.`, steps: [install, then] });
  }
});

test("buildHash: each file's path and contents, in path order, so it changes only when the build does", (t) => {
  const tmp = tempDir(t);
  const dist = makeDist(join(tmp, 'build'));
  const expected = createHash('sha256');
  for (const rel of ['assets/app.js', 'index.html']) expected.update(rel).update('\0').update(readFileSync(join(dist, ...rel.split('/')))).update('\0');
  const hash = buildHash(dist);
  assert.equal(hash, expected.digest('hex'));
  assert.equal(buildHash(dist), hash, 'stable');
  assert.equal(buildHash(makeDist(join(tmp, 'copy'))), hash, 'the same build in another folder');

  utimesSync(join(dist, 'index.html'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  mkdirSync(join(dist, 'empty'));
  assert.equal(buildHash(dist), hash, 'file times and empty folders are not the build');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("v2");');
  assert.notEqual(buildHash(dist), hash, 'a file changed');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("v1");');
  assert.equal(buildHash(dist), hash, 'and changed back');

  const renamed = join(tmp, 'renamed');
  put(join(renamed, 'index.html'), readFileSync(join(dist, 'index.html'), 'utf8'));
  put(join(renamed, 'assets', 'main.js'), 'console.log("v1");');
  assert.notEqual(buildHash(renamed), hash, 'a file renamed');
  writeFileSync(join(dist, 'robots.txt'), '');
  assert.notEqual(buildHash(dist), hash, 'an empty file added');
  mkdirSync(join(tmp, 'none'));
  assert.equal(buildHash(join(tmp, 'none')), createHash('sha256').digest('hex'), 'no files');
});

test('deployTheApp: a first deploy makes the app, deploys the build, shares it with the viewer group and records it', async (t) => {
  const s = appSetup(t);
  assert.equal(s.appDir, join(s.tmp, 'local', 'AIInOne', 'managed-app'));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });

  assert.deepEqual(s.ms.commands(), ['auth status', 'app init', 'app deploy', 'app share', 'app share list']);
  const [status, init, deploy, share, list] = s.ms.calls;
  assert.deepEqual(init.args, ['app', 'init', '--repo', 'none', '--display-name', APP_NAME, '--build-type', 'none', '--build-path', BUILD_PATH]);
  assert.deepEqual(deploy.args, ['app', 'deploy']);
  assert.deepEqual(share.args, ['app', 'share', GROUP, '--access', 'play']);
  assert.deepEqual(list.args, ['app', 'share', 'list', '--access', 'play']);
  assert.equal(status.cwd, undefined);
  for (const call of [init, deploy, share, list]) assert.equal(call.cwd, s.appDir, call.key);
  assert.ok(s.ms.calls.every((c) => c.jsonFlags && !c.onScreen), 'off screen, with --json');
  assert.deepEqual(deploy.dist, ['assets/app.js', 'index.html'], 'the build, as deployed');
  assert.deepEqual(s.ms.apps.get(appId(1)), { environmentId: DEV_ENV, shared: [GROUP] });

  assert.deepEqual(filesUnder(s.appDir), ['dist/assets/app.js', 'dist/index.html', APP_CONFIG]);
  assert.deepEqual(readJson(join(s.appDir, APP_CONFIG)), { appId: appId(1), environmentId: DEV_ENV, appDisplayName: APP_NAME, buildPath: BUILD_PATH });
  assert.deepEqual(appRecord(s.config), {
    appId: appId(1),
    environmentId: DEV_ENV,
    buildHash: buildHash(s.distDir),
    deployedAt: DEPLOYED_AT,
    url: playUri(appId(1)),
    sharedWith: [GROUP],
  });
  assert.ok(s.saves() > 0);
  assert.equal(s.out(), outLines(`  ✓ Made the app AI in One in environment ${DEV_ENV}`, DEPLOYING, live(appId(1)), SHARED, ...FIRST_NOTES));
  assert.deepEqual(s.asked, []);
});

test('deployTheApp: an unchanged build already shared is up to date, with no CLI command; force deploys it again', async (t) => {
  const s = appSetup(t);
  await deployTheApp(s.ctx, s.deps);
  appRecord(s.config).skipped = { why: 'An older reason.', steps: [] };
  const before = s.ms.calls.length;
  let mark = s.out().length;
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'up-to-date', url: playUri(appId(1)) });
  assert.equal(s.ms.calls.length, before, 'no command');
  assert.equal(s.out().slice(mark), outLines(`  ✓ The AI in One app is up to date: ${playUri(appId(1))}`));
  assert.equal(appRecord(s.config).skipped, undefined, 'nothing left to do');

  mark = s.out().length;
  assert.deepEqual(await deployTheApp(s.ctx, s.deps, { force: true }), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app deploy', 'app share', 'app share list'], 'no second init');
  assert.equal(s.ms.apps.size, 1);
  assert.equal(s.out().slice(mark), outLines(DEPLOYING, live(appId(1)), SHARED), 'no notes after the first deploy');
});

test('deployTheApp: a new build is deployed to the same app, without the old files', async (t) => {
  const s = appSetup(t);
  await deployTheApp(s.ctx, s.deps);
  rmSync(join(s.distDir, 'assets', 'app.js'));
  put(join(s.distDir, 'assets', 'app-2.js'), 'console.log("v2");');
  const before = s.ms.calls.length;
  const mark = s.out().length;
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app deploy', 'app share', 'app share list']);
  const deploys = s.ms.calls.filter((c) => c.key === 'app deploy');
  assert.deepEqual(deploys[1].dist, ['assets/app-2.js', 'index.html']);
  assert.deepEqual(filesUnder(join(s.appDir, 'dist')), ['assets/app-2.js', 'index.html']);
  assert.equal(appRecord(s.config).buildHash, buildHash(s.distDir));
  assert.equal(s.out().slice(mark), outLines(DEPLOYING, live(appId(1)), SHARED));
});

test('deployTheApp: a new viewer group gets the app shared with it, without deploying it again', async (t) => {
  const s = appSetup(t);
  await deployTheApp(s.ctx, s.deps);
  s.config.access = { groupId: GROUP_2, groupName: 'Copilot report viewers' };
  const before = s.ms.calls.length;
  const mark = s.out().length;
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app share', 'app share list']);
  assert.deepEqual(s.ms.calls[before + 1].args, ['app', 'share', GROUP_2, '--access', 'play']);
  assert.deepEqual(appRecord(s.config).sharedWith, [GROUP_2]);
  assert.equal(s.out().slice(mark), outLines('  ✓ Shared the app with Copilot report viewers'));
});

test('deployTheApp: with no viewer group the app is deployed but not shared; a group with no name is "the viewer group"', async (t) => {
  const s = appSetup(t, { access: null });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands(), ['auth status', 'app init', 'app deploy']);
  assert.equal(appRecord(s.config).sharedWith, undefined);
  assert.equal(s.out(), outLines(`  ✓ Made the app AI in One in environment ${DEV_ENV}`, DEPLOYING, live(appId(1)), ...FIRST_NOTES));

  s.config.access = { groupId: GROUP };
  const before = s.ms.calls.length;
  const mark = s.out().length;
  assert.equal((await deployTheApp(s.ctx, s.deps)).state, 'deployed');
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app share', 'app share list']);
  assert.equal(s.out().slice(mark), outLines('  ✓ Shared the app with the viewer group'));
});

test('deployTheApp: --environment-id makes the new app there, and an app already elsewhere stays where it is', async (t) => {
  const s = appSetup(t);
  assert.deepEqual(await deployTheApp(s.ctx, s.deps, { environmentId: OTHER_ENV }), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.calls[1].args.slice(-2), ['--environment-id', OTHER_ENV]);
  assert.equal(appRecord(s.config).environmentId, OTHER_ENV);
  assert.ok(s.out().startsWith(outLines(`  ✓ Made the app AI in One in environment ${OTHER_ENV}`)));

  let mark = s.out().length;
  assert.equal((await deployTheApp(s.ctx, s.deps, { environmentId: DEV_ENV })).state, 'up-to-date');
  assert.equal(
    s.out().slice(mark),
    outLines(`  ! The app is already in environment ${OTHER_ENV}. --environment-id is for a new app only, so it stays there.`, `  ✓ The AI in One app is up to date: ${playUri(appId(1))}`),
  );
  mark = s.out().length;
  await deployTheApp(s.ctx, s.deps, { environmentId: OTHER_ENV.toUpperCase() });
  assert.equal(s.out().slice(mark), outLines(`  ✓ The AI in One app is up to date: ${playUri(appId(1))}`), 'the same environment, in any case');
  assert.equal(s.ms.apps.get(appId(1))?.environmentId, OTHER_ENV);
});

test("deployTheApp: the app in this PC's ms.config.json is the one deployed, even when the record names another", async (t) => {
  const s = appSetup(t);
  await deployTheApp(s.ctx, s.deps);
  Object.assign(appRecord(s.config), { appId: OLD_APP, environmentId: OTHER_ENV });
  const before = s.ms.calls.length;
  const mark = s.out().length;
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app deploy', 'app share', 'app share list']);
  assert.deepEqual(appRecord(s.config), {
    appId: appId(1),
    environmentId: DEV_ENV,
    buildHash: buildHash(s.distDir),
    deployedAt: DEPLOYED_AT,
    url: playUri(appId(1)),
    sharedWith: [GROUP],
  });
  assert.equal(
    s.out().slice(mark),
    outLines(`  ! This PC's app settings are for app ${appId(1)}, not ${OLD_APP} as recorded, so ${appId(1)} is deployed.`, DEPLOYING, live(appId(1)), SHARED, ...FIRST_NOTES),
  );

  // A new install record on the same PC: the app's folder is taken up without a word.
  const fresh = appSetup(t, { ms: s.ms });
  put(join(fresh.appDir, APP_CONFIG), readFileSync(join(s.appDir, APP_CONFIG), 'utf8'));
  const fromHere = s.ms.calls.length;
  assert.deepEqual(await deployTheApp(fresh.ctx, fresh.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands().slice(fromHere), ['auth status', 'app deploy', 'app share', 'app share list']);
  assert.equal(appRecord(fresh.config).appId, appId(1));
  assert.doesNotMatch(fresh.out(), /^ {2}! /m);
});

test("deployTheApp: when this PC lacks the recorded app's settings, a new app is made in the same environment, and the old one named", async (t) => {
  const s = appSetup(t);
  s.config.managedApp = { appId: OLD_APP, environmentId: OTHER_ENV, url: playUri(OLD_APP), buildHash: 'old', deployedAt: '2026-01-01T00:00:00.000Z', sharedWith: [GROUP] };
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands(), ['auth status', 'app init', 'app deploy', 'app share', 'app share list']);
  assert.deepEqual(s.ms.calls[1].args.slice(-2), ['--environment-id', OTHER_ENV], "the recorded app's environment");
  assert.deepEqual(appRecord(s.config), {
    appId: appId(1),
    environmentId: OTHER_ENV,
    buildHash: buildHash(s.distDir),
    deployedAt: DEPLOYED_AT,
    url: playUri(appId(1)),
    sharedWith: [GROUP],
  });
  assert.equal(
    s.out(),
    outLines(
      `  ! This PC doesn't have the settings for the app deployed before (${OLD_APP}), so a new app is made. Delete the old one at ${LINKS.portal}.`,
      `  ✓ Made the app AI in One in environment ${OTHER_ENV}`,
      DEPLOYING,
      live(appId(1)),
      SHARED,
      ...FIRST_NOTES,
    ),
  );
});

test('deployTheApp: when the files stay on this PC, the note says which folder to pick them from', async (t) => {
  const s = appSetup(t, { destination: 'local' });
  await deployTheApp(s.ctx, s.deps);
  assert.ok(s.out().endsWith(outLines(`    In the app, choose Change data and pick the CSV files from ${join(s.tmp, 'AI in One')}.`)), s.out());
});

/** What the step says when the tenant isn't ready. @param {string} names */
const notReadyLines = (names) => [
  `  ! The AI in One app can't be deployed until a Power Platform admin turns on ${names}. The report works without it.`,
  `    The summary has a message to send them. Then run: ${deployAgain()}`,
];

test("deployTheApp: with app creation off it isn't a failure: it names the setting, the install finishes, and the summary asks an admin", async (t) => {
  const s = appSetup(t, { ms: fakeMs({ fail: { 'app init': [CREATE_APPS_OFF] } }) });
  const r = await deployTheApp(s.ctx, s.deps);
  assert.deepEqual(r, { ok: true, state: 'not-ready' }, 'ok, so the set-up carries on to the summary');
  assert.deepEqual(s.ms.commands(), ['auth status', 'app init']);
  assert.deepEqual(appRecord(s.config), { missing: ['createApps'] });
  assert.equal(s.out(), outLines(...notReadyLines(NOT_READY_NAMES.createApps)));
  assert.doesNotMatch(s.out(), /✗/);

  const cards = nextSteps(s.config, s.ctx.user);
  assert.deepEqual(
    cards.map((c) => c.id),
    ['app-settings'],
  );
  const [card] = cards;
  assert.equal(card.title, 'Ask for managed apps to be turned on');
  assert.equal(card.who, 'A Power Platform admin');
  assert.equal(card.why, `The AI in One app can't be deployed until these settings are on. The report works without it. Once they're on, run ${deployAgain()}.`);
  assert.equal(card.link, LINKS.cliSetting);
  assert.equal(card.linkText, 'Managed apps settings');
  assert.deepEqual(card.steps, [ADMIN_STEPS.createApps.what]);
  assert.ok(String(card.message).includes(`\n1. ${ADMIN_STEPS.createApps.what}\n`));
  assert.ok(String(card.message).endsWith(`Thanks\n${USER}`));

  const mark = s.out().length;
  paxSummary(s.ctx, { ok: r.ok });
  const summary = s.out().slice(mark);
  assert.ok(summary.startsWith('\nAI in One is set up\n'), summary);
  assert.doesNotMatch(summary, /partly/);
  for (const l of ['  1 step left', '  1. Ask for managed apps to be turned on  A Power Platform admin', `     a. ${ADMIN_STEPS.createApps.what}`]) {
    assert.ok(summary.includes(`${l}\n`), l);
  }
  assert.doesNotMatch(summary, /App: /, 'no link yet');

  // The admin turns it on; deploy-app runs the step again.
  const before = s.ms.calls.length;
  assert.deepEqual(await deployTheApp(s.ctx, s.deps, { force: true }), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app init', 'app deploy', 'app share', 'app share list']);
  assert.equal(appRecord(s.config).missing, undefined);
  assert.deepEqual(nextSteps(s.config, s.ctx.user), []);
});

test('deployTheApp: with external artifacts off the deploy stops, not the install, and the app made is kept for the next run', async (t) => {
  const s = appSetup(t, { ms: fakeMs({ fail: { 'app deploy': [EXTERNAL_ARTIFACTS_OFF] } }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'not-ready' });
  assert.deepEqual(s.ms.commands(), ['auth status', 'app init', 'app deploy']);
  assert.deepEqual(appRecord(s.config), { appId: appId(1), environmentId: DEV_ENV, missing: ['externalArtifacts'] });
  assert.equal(s.out(), outLines(`  ✓ Made the app AI in One in environment ${DEV_ENV}`, DEPLOYING, ...notReadyLines(NOT_READY_NAMES.externalArtifacts)));
  assert.deepEqual(nextSteps(s.config, s.ctx.user)[0].steps, [ADMIN_STEPS.externalArtifacts.what]);

  const before = s.ms.calls.length;
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app deploy', 'app share', 'app share list'], 'the same app: no second init');
  assert.equal(appRecord(s.config).missing, undefined);
});

test('deployTheApp: with both settings off it names both, and the card lists both steps', async (t) => {
  const s = appSetup(t, { ms: fakeMs({ fail: { 'app init': [BOTH_OFF] } }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'not-ready' });
  assert.deepEqual(appRecord(s.config).missing, ['createApps', 'externalArtifacts']);
  assert.equal(s.out(), outLines(...notReadyLines(`${NOT_READY_NAMES.createApps} and ${NOT_READY_NAMES.externalArtifacts}`)));
  assert.deepEqual(nextSteps(s.config, s.ctx.user)[0].steps, [ADMIN_STEPS.createApps.what, ADMIN_STEPS.externalArtifacts.what]);
});

test('deployTheApp: a setting turned off after a deploy keeps the live link, and replaces the reason it was skipped', async (t) => {
  /** @type {Record<string, Output[]>} */
  const fail = {};
  const s = appSetup(t, { ms: fakeMs({ fail }) });
  await deployTheApp(s.ctx, s.deps);
  appRecord(s.config).skipped = { why: 'An older reason.', steps: [] };
  fail['app deploy'] = [EXTERNAL_ARTIFACTS_OFF];
  assert.deepEqual(await deployTheApp(s.ctx, s.deps, { force: true }), { ok: true, state: 'not-ready', url: playUri(appId(1)) });
  const record = appRecord(s.config);
  assert.deepEqual(record.missing, ['externalArtifacts']);
  assert.equal(record.skipped, undefined);
  assert.equal(record.url, playUri(appId(1)));
});

test("deployTheApp: without the app's build it says so and skips, running and making nothing", async (t) => {
  const s = appSetup(t);
  s.ctx.sources = /** @type {any} */ ({ dir: s.tmp });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'skipped' });
  assert.deepEqual(s.ms.calls, []);
  assert.equal(existsSync(s.env.LOCALAPPDATA), false, 'nothing made');
  assert.equal(s.out(), outLines(`  ! Skipped the AI in One app: ${NO_BUILD.why}`, ...NO_BUILD.steps.map((x) => `    ${x}`)));
  assert.deepEqual(appRecord(s.config), { skipped: NO_BUILD });
  assert.ok(s.saves() > 0);
  assert.deepEqual(nextSteps(s.config, s.ctx.user), [{ id: 'app-skipped', title: 'Finish the AI in One app', why: NO_BUILD.why, who: 'You', steps: NO_BUILD.steps }]);

  const noIndex = appSetup(t);
  rmSync(join(noIndex.distDir, 'index.html'));
  assert.deepEqual(await deployTheApp(noIndex.ctx, noIndex.deps), { ok: true, state: 'skipped' });
  assert.deepEqual(appRecord(noIndex.config).skipped, NO_BUILD, 'a build has index.html');
});

test('deployTheApp: an older Node.js leaves an up-to-date app alone, and skips a new build, keeping its live link and dropping the ask for settings', async (t) => {
  const s = appSetup(t);
  await deployTheApp(s.ctx, s.deps);
  const old = { ...s.deps, nodeVersion: `v${OLD_NODE}` };
  const before = s.ms.calls.length;
  let mark = s.out().length;
  assert.deepEqual(await deployTheApp(s.ctx, old), { ok: true, state: 'up-to-date', url: playUri(appId(1)) }, 'nothing to do needs no CLI');
  assert.equal(s.out().slice(mark), outLines(`  ✓ The AI in One app is up to date: ${playUri(appId(1))}`));

  put(join(s.distDir, 'assets', 'app-2.js'), 'console.log("v2");');
  appRecord(s.config).missing = ['createApps'];
  mark = s.out().length;
  assert.deepEqual(await deployTheApp(s.ctx, old), { ok: true, state: 'skipped', url: playUri(appId(1)) });
  assert.equal(s.ms.calls.length, before);
  const why = `The managed apps CLI needs Node.js ${MIN_NODE} or later, and this is ${OLD_NODE}.`;
  assert.equal(
    s.out().slice(mark),
    outLines(`  ! Skipped the AI in One app: ${why}`, `    Use AIInOneInstaller.exe, which carries a new enough Node.js, or install it from ${LINKS.node}.`, `    Then run: ${deployAgain()}`),
  );
  const record = appRecord(s.config);
  assert.equal(record.missing, undefined);
  assert.equal(record.skipped?.why, why);
  assert.equal(record.url, playUri(appId(1)));
  assert.deepEqual(
    nextSteps(s.config, s.ctx.user).map((c) => c.id),
    ['app-skipped'],
  );
});

test("deployTheApp: a CLI that isn't installed, or isn't the pinned version, skips the app", async (t) => {
  /** @type {[string | null, string][]} */
  const cases = [
    [null, "The managed apps CLI isn't installed here."],
    ['0.0.0-old', `The managed apps CLI here is 0.0.0-old, and the installer needs ${pinnedVersion()}.`],
  ];
  for (const [installed, why] of cases) {
    const s = appSetup(t, { installed });
    assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'skipped' });
    assert.deepEqual(s.ms.calls, []);
    assert.equal(appRecord(s.config).skipped?.why, why);
  }
});

test("deployTheApp: with --yes and the CLI not signed in, it skips without opening a browser", async (t) => {
  const s = appSetup(t, { yes: true, ms: fakeMs({ accounts: [] }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'skipped' });
  assert.deepEqual(s.ms.commands(), ['auth status']);
  assert.equal(existsSync(s.appDir), false, 'nothing made');
  const skipped = {
    why: `The managed apps CLI isn't signed in as ${USER}, and --yes doesn't open a browser.`,
    steps: [`Run ${deployAgain()} without --yes, and sign in when it asks.`],
  };
  assert.deepEqual(appRecord(s.config).skipped, skipped);
  assert.equal(s.out(), outLines(`  ! Skipped the AI in One app: ${skipped.why}`, `    ${skipped.steps[0]}`));
});

test("deployTheApp: a CLI never signed in opens a browser sign-in for the installer's account, on screen", async (t) => {
  const s = appSetup(t, { ms: fakeMs({ accounts: [] }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands(), ['auth status', 'auth login', 'auth status', 'app init', 'app deploy', 'app share', 'app share list']);
  const signIn = s.ms.calls[1];
  assert.deepEqual(signIn.args, ['auth', 'login', '--account', USER]);
  assert.equal(signIn.onScreen, true);
  assert.equal(signIn.jsonFlags, false);
  assert.equal(s.out().split('\n')[0], `    Sign in to the managed apps CLI as ${USER}. A browser opens.`);
  assert.deepEqual(s.asked, []);
});

test('deployTheApp: an account the CLI already has is switched to, in any case; the one it is on is used as it is', async (t) => {
  const s = appSetup(t, { ms: fakeMs({ accounts: [OTHER_USER, 'Admin@Contoso.com'] }) });
  assert.equal((await deployTheApp(s.ctx, s.deps)).state, 'deployed');
  assert.deepEqual(s.ms.commands().slice(0, 4), ['auth status', 'auth switch', 'auth status', 'app init']);
  assert.deepEqual(s.ms.calls[1].args, ['auth', 'switch', '--account', 'Admin@Contoso.com']);
  assert.doesNotMatch(s.out(), /Sign in/);

  const same = appSetup(t, { ms: fakeMs({ accounts: ['ADMIN@contoso.com'] }) });
  assert.equal((await deployTheApp(same.ctx, same.deps)).state, 'deployed');
  assert.deepEqual(same.ms.commands().slice(0, 2), ['auth status', 'app init']);
});

test('deployTheApp: a browser sign-in as someone else asks before deploying as them', async (t) => {
  const question = `The CLI signed in as ${OTHER_USER}, not ${USER}. Deploy the app as ${OTHER_USER}?`;
  const s = appSetup(t, { ms: fakeMs({ accounts: [], loginAs: OTHER_USER }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'skipped' });
  assert.deepEqual(s.asked, [question]);
  assert.deepEqual(s.ms.commands(), ['auth status', 'auth login', 'auth status']);
  assert.deepEqual(appRecord(s.config).skipped, {
    why: `The managed apps CLI signed in as ${OTHER_USER}, not ${USER}.`,
    steps: [`Run ${deployAgain()}, and sign in as ${USER} when it asks.`],
  });

  const yes = appSetup(t, { yesTo: [question], ms: fakeMs({ accounts: [], loginAs: OTHER_USER }) });
  assert.deepEqual(await deployTheApp(yes.ctx, yes.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.equal(appRecord(yes.config).skipped, undefined);
});

test("deployTheApp: a browser that closes without signing in skips the app; a sign-in that fails is a failure", async (t) => {
  const closed = appSetup(t, { ms: fakeMs({ accounts: [], loginSignsIn: false }) });
  assert.deepEqual(await deployTheApp(closed.ctx, closed.deps), { ok: true, state: 'skipped' });
  assert.deepEqual(closed.asked, []);
  assert.deepEqual(appRecord(closed.config).skipped, {
    why: "The managed apps CLI didn't sign in.",
    steps: [`Run ${deployAgain()}, and sign in as ${USER} when it asks.`],
  });

  const failed = appSetup(t, { ms: fakeMs({ accounts: [], fail: { 'auth login': [{ code: 1 }] } }) });
  assert.deepEqual(await deployTheApp(failed.ctx, failed.deps), { ok: false, state: 'failed' });
  assert.deepEqual(failed.ms.commands(), ['auth status', 'auth login']);
  assert.deepEqual(appRecord(failed.config).skipped, {
    why: 'The last attempt to deploy it failed: The CLI stopped with exit code 1.',
    steps: [GENERIC.what, `More: ${LINKS.issues}`],
  });
  assert.ok(failed.out().includes(outLines('  ✗ The AI in One app: The CLI stopped with exit code 1.', `    ${GENERIC.what}`, `    ${LINKS.issues}`)), failed.out());
});

test('deployTheApp: a sign-in Conditional Access blocks says an Entra admin allows the CLI', async (t) => {
  const blocked = json(1, { success: false, errorMessage: 'AADSTS53003: Access has been blocked by Conditional Access policies.' });
  const s = appSetup(t, { ms: fakeMs({ fail: { 'auth status': [blocked] } }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed' });
  assert.deepEqual(s.ms.commands(), ['auth status']);
  const skipped = /** @type {{ why: string, steps: string[] }} */ (appRecord(s.config).skipped);
  assert.equal(skipped.why, 'The last attempt to deploy it failed: AADSTS53003: Access has been blocked by Conditional Access policies.');
  assert.equal(skipped.steps.length, 2);
  assert.match(skipped.steps[0], /^Ask your Entra admin: Conditional Access blocked the sign-in\./);
  assert.ok(skipped.steps[0].includes(CLI_APP_ID));
  assert.equal(skipped.steps[1], `Then run: ${deployAgain()}`);
  assert.match(s.out(), /^ {2}✗ The AI in One app: AADSTS53003: /);
  assert.match(s.out(), /\n {4}Who fixes it: your Entra admin\.\r?\n/);
});

const EXPIRED_AGAIN = "    The managed apps CLI's sign-in expired. Sign in again; a browser opens.";

test('deployTheApp: a sign-in that expires on the way is renewed in the browser, and the step runs once more', async (t) => {
  const s = appSetup(t, { ms: fakeMs({ fail: { 'app init': [EXPIRED], 'app deploy': [EXPIRED], 'app share': [EXPIRED] } }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands(), [
    'auth status',
    'app init',
    'auth login',
    'app init',
    'app deploy',
    'auth login',
    'app deploy',
    'app share',
    'auth login',
    'app share',
    'app share list',
  ]);
  for (const signIn of s.ms.calls.filter((c) => c.key === 'auth login')) {
    assert.deepEqual(signIn.args, ['auth', 'login', '--account', USER]);
    assert.equal(signIn.onScreen, true);
  }
  assert.equal(
    s.out(),
    outLines(EXPIRED_AGAIN, `  ✓ Made the app AI in One in environment ${DEV_ENV}`, DEPLOYING, EXPIRED_AGAIN, live(appId(1)), EXPIRED_AGAIN, SHARED, ...FIRST_NOTES),
  );
});

test("deployTheApp: with --yes an expired sign-in fails the step, and a sign-in that fails keeps the first failure", async (t) => {
  const expiredWhy = 'The last attempt to deploy it failed: Your sign-in session has expired. Run ms auth login.';
  const yes = appSetup(t, { yes: true, ms: fakeMs({ fail: { 'app deploy': [EXPIRED] } }) });
  assert.deepEqual(await deployTheApp(yes.ctx, yes.deps), { ok: false, state: 'failed' });
  assert.deepEqual(yes.ms.commands(), ['auth status', 'app init', 'app deploy'], 'no browser');
  assert.deepEqual(appRecord(yes.config), { appId: appId(1), environmentId: DEV_ENV, skipped: { why: expiredWhy, steps: [SIGN_IN.what] } });
  assert.ok(yes.out().endsWith(outLines('  ✗ The AI in One app: Your sign-in session has expired. Run ms auth login.', `    ${SIGN_IN.what}`)), yes.out());

  const s = appSetup(t, { ms: fakeMs({ fail: { 'app deploy': [EXPIRED], 'auth login': [{ code: 1 }] } }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed' });
  assert.deepEqual(s.ms.commands(), ['auth status', 'app init', 'app deploy', 'auth login']);
  assert.equal(appRecord(s.config).skipped?.why, expiredWhy);
});

test("deployTheApp: any other failure fails the step: the CLI's words, the server's, what to do and where to ask", async (t) => {
  const said = `Upload failed: ${'x'.repeat(400)}\nat line two`;
  const failing = json(1, { success: false, errorMessage: said, errorData: { serverMessage: 'The package is too large.' } });
  const s = appSetup(t, { ms: fakeMs({ fail: { 'app deploy': [failing] } }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed' });
  const skipped = /** @type {{ why: string, steps: string[] }} */ (appRecord(s.config).skipped);
  assert.equal(skipped.why, `The last attempt to deploy it failed: ${`Upload failed: ${'x'.repeat(400)}`.slice(0, 300)}`, 'its first line, cut short');
  assert.deepEqual(skipped.steps, [GENERIC.what, `More: ${LINKS.issues}`]);
  assert.equal(appRecord(s.config).missing, undefined);
  assert.equal(
    s.out(),
    outLines(`  ✓ Made the app AI in One in environment ${DEV_ENV}`, DEPLOYING, `  ✗ The AI in One app: ${said}`, '    The package is too large.', `    ${GENERIC.what}`, `    ${LINKS.issues}`),
  );
  assert.deepEqual(
    nextSteps(s.config, s.ctx.user).map((c) => c.id),
    ['app-skipped'],
  );
});

test("deployTheApp: a share a policy refuses leaves the app live but unshared, says who allows it, and the next run shares it", async (t) => {
  const refused = json(1, { success: false, errorMessage: 'Sharing is blocked by an environment or tenant policy.' });
  const s = appSetup(t, { ms: fakeMs({ fail: { 'app share': [refused] } }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed', url: playUri(appId(1)) });
  const what = 'A policy blocks sharing apps in this environment. Allow it, or deploy to another environment with --environment-id.';
  assert.deepEqual(appRecord(s.config).skipped, {
    why: `The app is live, but it isn't shared with ${VIEWER_GROUP_NAME}, so nobody else can open it.`,
    steps: [`Ask your Power Platform admin: ${what}`, `Then run: ${deployAgain()}`],
  });
  assert.equal(appRecord(s.config).sharedWith, undefined);
  assert.equal(
    s.out(),
    outLines(
      `  ✓ Made the app AI in One in environment ${DEV_ENV}`,
      DEPLOYING,
      live(appId(1)),
      `  ! Couldn't share the app with ${VIEWER_GROUP_NAME}: Sharing is blocked by an environment or tenant policy.`,
      `    ${what}`,
      ...FIRST_NOTES,
    ),
  );

  const before = s.ms.calls.length;
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app share', 'app share list'], 'shared, not deployed again');
  assert.equal(appRecord(s.config).skipped, undefined);
  assert.deepEqual(appRecord(s.config).sharedWith, [GROUP]);
});

test("deployTheApp: a share that hasn't shown up yet isn't a failure; it says where to check, and the next run shares it again", async (t) => {
  const s = appSetup(t, { ms: fakeMs({ shareShowsUp: false }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.equal(appRecord(s.config).skipped, undefined, 'no card in the summary');
  assert.equal(appRecord(s.config).sharedWith, undefined, 'not recorded');
  assert.ok(
    s.out().includes(outLines(`  ! Shared the app with ${VIEWER_GROUP_NAME}, but couldn't see it in the app's sharing yet. It can take a few minutes. Check it at ${LINKS.portal}.`)),
    s.out(),
  );
  assert.doesNotMatch(s.out(), /✗/);
  assert.deepEqual(nextSteps(s.config, s.ctx.user), []);

  const before = s.ms.calls.length;
  assert.equal((await deployTheApp(s.ctx, s.deps)).state, 'deployed');
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app share', 'app share list'], 'shared again, not deployed again');
});

test("deployTheApp: the CLI's warnings on a deploy or share are shown", async (t) => {
  const s = appSetup(t, { ms: fakeMs({ deployWarnings: ['The bundle is large.'], shareWarnings: [{ input: 'nobody@contoso.com', reason: 'No such user.' }] }) });
  assert.equal((await deployTheApp(s.ctx, s.deps)).state, 'deployed');
  const out = s.out();
  assert.ok(out.includes(outLines(DEPLOYING, '  ! The bundle is large.', live(appId(1)))), out);
  assert.ok(out.includes(outLines('  ! nobody@contoso.com: No such user.', SHARED)), out);
});

test("deployTheApp: when the deploy doesn't print the app's link it asks for it, and does without one it can't get", async (t) => {
  const s = appSetup(t, { ms: fakeMs({ deployPrintsUrl: false }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: playUri(appId(1)) });
  assert.deepEqual(s.ms.commands(), ['auth status', 'app init', 'app deploy', 'app play', 'app share', 'app share list']);
  const play = s.ms.calls[3];
  assert.deepEqual(play.args, ['app', 'play', '--no-browser']);
  assert.equal(play.cwd, s.appDir);
  assert.equal(appRecord(s.config).url, playUri(appId(1)));

  const noLink = json(1, { success: false, errorMessage: 'The app has no link yet.' });
  const without = appSetup(t, { ms: fakeMs({ deployPrintsUrl: false, fail: { 'app play': [noLink] } }) });
  assert.deepEqual(await deployTheApp(without.ctx, without.deps), { ok: true, state: 'deployed' });
  assert.equal(appRecord(without.config).url, undefined);
  assert.ok(without.out().includes('  ✓ The AI in One app is live\n'));
  assert.doesNotMatch(without.out(), /✗/, 'a missing link is not a failure');
});

test('deployTheApp: without LOCALAPPDATA it stops before running anything', async (t) => {
  const s = appSetup(t);
  await assert.rejects(deployTheApp(s.ctx, { ...s.deps, env: {} }), /LOCALAPPDATA is not set/);
  assert.deepEqual(s.ms.calls, []);
});

test('removeTheApp: deletes the app, then its folder on this PC and its part of the record', async (t) => {
  const s = appSetup(t);
  await deployTheApp(s.ctx, s.deps);
  const before = s.ms.calls.length;
  const mark = s.out().length;
  assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: true, removed: true });
  assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app delete']);
  const del = s.ms.calls[before + 1];
  assert.deepEqual(del.args, ['app', 'delete', '--force', '--app', appId(1), '--environment-id', DEV_ENV]);
  assert.equal(del.cwd, s.appDir);
  assert.equal(s.ms.apps.size, 0);
  assert.equal(existsSync(s.appDir), false);
  assert.equal(s.config.managedApp, undefined);
  assert.equal(s.out().slice(mark), outLines('  ✓ Deleted the AI in One app'));
});

test("removeTheApp: an app that's already gone is fine, with or without its folder on this PC", async (t) => {
  const s = appSetup(t);
  s.config.managedApp = { appId: OLD_APP, environmentId: OTHER_ENV, url: playUri(OLD_APP) };
  assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: true, removed: false });
  assert.deepEqual(s.ms.commands(), ['auth status', 'app delete']);
  assert.deepEqual(s.ms.calls[1].args, ['app', 'delete', '--force', '--app', OLD_APP, '--environment-id', OTHER_ENV]);
  assert.equal(s.ms.calls[1].cwd, undefined, 'no folder to run it in');
  assert.equal(s.config.managedApp, undefined);
  assert.equal(s.out(), outLines('  ✓ The AI in One app was already gone'));
});

test('removeTheApp: with no app recorded it removes the folder and the record, running nothing', async (t) => {
  const s = appSetup(t);
  put(join(s.appDir, 'dist', 'index.html'), '');
  s.config.managedApp = { missing: ['createApps'] };
  assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: true, removed: false });
  assert.deepEqual(s.ms.calls, []);
  assert.equal(existsSync(s.appDir), false);
  assert.equal(s.config.managedApp, undefined);
  assert.ok(s.saves() > 0);
  assert.equal(s.out(), '');
});

test('removeTheApp: after an interrupted init, it deletes the app that the folder on this PC names', async (t) => {
  for (const record of [undefined, /** @type {ManagedAppConfig} */ ({ missing: [] })]) {
    const s = appSetup(t);
    await deployTheApp(s.ctx, s.deps);
    s.config.managedApp = record;
    const before = s.ms.calls.length;
    const mark = s.out().length;
    assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: true, removed: true });
    assert.deepEqual(s.ms.commands().slice(before), ['auth status', 'app delete']);
    assert.deepEqual(s.ms.calls[before + 1].args, ['app', 'delete', '--force', '--app', appId(1), '--environment-id', DEV_ENV]);
    assert.equal(s.ms.apps.size, 0);
    assert.equal(existsSync(s.appDir), false);
    assert.equal(s.config.managedApp, undefined);
    assert.equal(s.out().slice(mark), outLines('  ✓ Deleted the AI in One app'));
  }

  const stuck = appSetup(t, { nodeVersion: `v${OLD_NODE}` });
  put(join(stuck.appDir, APP_CONFIG), JSON.stringify({ appId: appId(1), environmentId: DEV_ENV }));
  delete stuck.config.managedApp;
  assert.deepEqual(await removeTheApp(stuck.ctx, stuck.deps), { ok: false, removed: false });
  assert.deepEqual(stuck.ms.calls, []);
  assert.equal(existsSync(join(stuck.appDir, APP_CONFIG)), true, 'the file that names the app stays');
  const why = `The managed apps CLI needs Node.js ${MIN_NODE} or later, and this is ${OLD_NODE}.`;
  assert.equal(stuck.out(), outLines(`  ! The AI in One app (${appId(1)}) is still there: ${why} Delete it at ${LINKS.portal}.`));
});

test("removeTheApp: an app it can't delete from here stays in the record, with where to delete it", async (t) => {
  const recorded = () => /** @type {ManagedAppConfig} */ ({ appId: appId(1), environmentId: DEV_ENV, url: playUri(appId(1)) });
  /** @param {string} why */
  const still = (why) => outLines(`  ! The AI in One app (${appId(1)}) is still there: ${why} Delete it at ${LINKS.portal}.`);
  const network = json(5, { success: false, errorMessage: 'getaddrinfo ENOTFOUND api.contoso.com' });
  const denied = json(1, { success: false, errorMessage: "You don't have permission to delete this app." });
  /** @type {[string, Parameters<typeof appSetup>[1], string, string[]][]} */
  const cases = [
    ['an older Node.js', { nodeVersion: `v${OLD_NODE}` }, `The managed apps CLI needs Node.js ${MIN_NODE} or later, and this is ${OLD_NODE}.`, []],
    ['--yes, signed out', { yes: true, ms: fakeMs({ accounts: [] }) }, `The managed apps CLI isn't signed in as ${USER}, and --yes doesn't open a browser.`, ['auth status']],
    ['no network', { ms: fakeMs({ fail: { 'auth status': [network] } }) }, NETWORK.what, ['auth status']],
    ['no permission', { ms: fakeMs({ fail: { 'app delete': [denied] } }) }, "You don't have permission to delete this app.", ['auth status', 'app delete']],
  ];
  for (const [name, o, why, commands] of cases) {
    const s = appSetup(t, o);
    put(join(s.appDir, APP_CONFIG), '{}');
    s.config.managedApp = recorded();
    assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: false, removed: false }, name);
    assert.deepEqual(s.ms.commands(), commands, name);
    assert.deepEqual(s.config.managedApp, recorded(), `${name}: the record keeps it`);
    assert.equal(existsSync(join(s.appDir, APP_CONFIG)), true, `${name}: and its folder`);
    assert.equal(s.out(), still(why), name);
  }
});

// The PAX route and the command line.

test('PAX route: the app step is on by default and comes last; off when turned off, and never on the Fabric route', () => {
  const fabric = emptyConfig();
  assert.equal(withApp(fabric), false);
  const pax = emptyConfig();
  pax.target = 'pax';
  pax.pax = emptyPax();
  assert.equal(pax.pax.deployApp, true, 'on by default');
  assert.equal(withApp(pax), true);
  assert.equal(setUpTitles(pax).at(-1), `The ${APP_NAME} app`);
  pax.pax.deployApp = false;
  assert.equal(withApp(pax), false);
  assert.equal(setUpTitles(pax).includes(`The ${APP_NAME} app`), false);
});

test("PAX route: the summary's app cards come only with the app step on, and never on the Fabric route", () => {
  /** @param {InstallConfig} config */
  const withAppState = (config) => {
    config.managedApp = { missing: ['createApps'], skipped: { why: 'No build.', steps: ['Build it.'] } };
    return config;
  };
  const user = { upn: USER };
  assert.deepEqual(nextSteps(withAppState(emptyConfig()), user), [], 'Fabric');
  const pax = withAppState(emptyConfig());
  pax.target = 'pax';
  pax.pax = emptyPax();
  assert.deepEqual(
    nextSteps(pax, user).map((c) => c.id),
    ['app-settings', 'app-skipped'],
  );
  pax.pax.deployApp = false;
  assert.deepEqual(nextSteps(pax, user), [], 'the app step turned off');
});

test('deploy-app: on the Fabric route it says the app comes with PAX, and so does --environment-id', async (t) => {
  const { ctx } = fakeCtx({ sources: /** @type {any} */ ({ dir: tempDir(t) }) });
  await assert.rejects(runCommand(ctx, 'deploy-app', { wait: false }), { message: APP_NEEDS_PAX });
  assert.equal(routeMismatch('fabric', { command: 'deploy-app' }), APP_NEEDS_PAX);
  assert.equal(routeMismatch('fabric', { command: 'install', environmentId: DEV_ENV }), `--environment-id is for the AI in One app. ${APP_NEEDS_PAX}`);
  assert.equal(routeMismatch('fabric', { command: 'install' }), undefined);
  assert.equal(routeMismatch('pax', { command: 'deploy-app', environmentId: DEV_ENV }), undefined);
});

test('deploy-app: on the PAX route it runs the app step by itself, before anything else is installed, and turns the step on', async (t) => {
  const tmp = tempDir(t);
  const { ui, text } = fakeUi();
  const config = emptyConfig();
  config.target = 'pax';
  config.pax = emptyPax();
  config.pax.deployApp = false;
  const { ctx, saves } = fakeCtx({ ui, config, sources: /** @type {any} */ ({ dir: tmp }) });
  ctx.env = { LOCALAPPDATA: join(tmp, 'local') };
  assert.equal(await runCommand(ctx, 'deploy-app', { wait: false }), false, 'skipped is not done');
  assert.equal(
    plain(text()),
    outLines('', `The ${APP_NAME} app`, `  ! Skipped the AI in One app: ${NO_BUILD.why}`, ...NO_BUILD.steps.map((x) => `    ${x}`)),
  );
  assert.equal(config.pax.deployApp, true, 'the next update keeps the app up to date');
  assert.deepEqual(appRecord(config).skipped, NO_BUILD);
  assert.ok(saves() > 0);
  assert.equal(existsSync(join(tmp, 'local')), false);
  await assert.rejects(runPaxCommand(ctx, 'status', { wait: false }), { message: 'Nothing is installed yet. Run the installer first.' });
});
