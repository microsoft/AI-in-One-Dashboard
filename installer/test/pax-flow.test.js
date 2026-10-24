// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { NOTEBOOKS, NOTEBOOKS_DIR } from '../src/catalog.js';
import { emptyConfig, emptyPax, loadConfig, saveConfig, targetOf, TARGETS } from '../src/config.js';
import { adoptedItems, createdItems } from '../src/steps/fabric-uninstall.js';
import { commandLine } from '../src/launch.js';
import { paxInstall, paxSummary, runPaxCommand, setUpTitles, withAccess, withApp, withReport } from '../src/pax/flow.js';
import { defaultLocalFolder, FILES, lastRunPath, PAX_APP_NAME, paxFiles, runDir, secretPath, seedRequestPath, stateRoot, TASK_NAME, wrapperPath } from '../src/pax/names.js';
import {
  chooseTarget,
  confirmPaxPlan,
  filesLabel,
  PAX_NEEDS_WINDOWS,
  paxCollected,
  paxPlan,
  paxPlanReview,
  paxPreflight,
  showPc,
  taskLogon,
  validateFolder,
  validateLocalFolder,
} from '../src/pax/plan.js';
import { PROBE, START_TASK_SCRIPT, TASK_INFO_SCRIPT, UNREGISTER_TASK_SCRIPT } from '../src/pax/scripts.js';
import { noDataYet } from '../src/pax/task.js';
import { reviewSetup, setupCategories, setupRecovery } from '../src/setup.js';
import { APP_DIST, DEFAULT_SOURCE_DIR, findPaxModelTemplate, findRollupTemplate, loadSources, PIPELINE_TEMPLATE } from '../src/sources.js';
import { nextSteps } from '../src/steps/next-steps.js';
import { fakeUi } from './fakes.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TENANT = '00000000-0000-0000-0000-000000000001';
const APP_ID = '00000000-0000-0000-0000-000000000002';
const THUMB = '0123456789ABCDEF0123456789ABCDEF01234567';
const SITE = { url: 'https://contoso.sharepoint.com/sites/AIinOne', host: 'contoso.sharepoint.com', path: '/sites/AIinOne', library: 'Documents', folder: 'AI in One' };
const SITE_ADDRESS = SITE.url;
const FOLDER_LABEL = `Documents/AI in One in ${SITE_ADDRESS}`;
const GLOBAL_ADMIN = { roleTemplateId: '62e90394-69f5-4237-9190-012177145e10', displayName: 'Global Administrator' };
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
const PRE = /** @type {any} */ ({ canConsent: true, canCreateApps: true, pc: { probe: FULL_PROBE } });
const PWSH_MISSING = "PowerShell 7 isn't installed (pwsh.exe wasn't found).";

/** @param {string} s */
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');

/**
 * A temp folder, removed when the test ends.
 * @param {import('node:test').TestContext} t
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-pax-flow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A PAX install's ctx, with fakes for Graph, Fabric, SharePoint, PowerShell and the clock. Its
 * LOCALAPPDATA is a temp folder.
 * @param {import('node:test').TestContext} t
 * @param {any} [o]
 */
function paxCtx(t, o = {}) {
  const dir = tempDir(t);
  const env = { LOCALAPPDATA: join(dir, 'LocalAppData') };
  const fake = fakeUi({ yes: o.yes, answers: o.answers, yesTo: o.yesTo });
  /** @type {any} */
  const config = { ...emptyConfig(), target: 'pax', tenantId: TENANT, ...o.config, pax: { ...emptyPax(), ...o.pax } };
  /** @type {any} */
  const calls = { saves: 0, started: 0, unregistered: 0, revoked: [], deletedApps: [], deletedWorkspaces: [], removedKeys: [], deletedCerts: [], requests: [] };
  let clock = NOW.getTime();
  const graph = {
    myDirectoryRoles: async () => o.roles ?? [],
    usersCanRegisterApps: async () => o.canCreateApps ?? true,
    subscribedSkus: async () => {
      throw new Error('Not in this test');
    },
    /** @param {string} id @param {string[]} keyIds */
    removeCertificates: async (id, keyIds) => {
      calls.removedKeys.push({ id, keyIds });
      return keyIds.length;
    },
    listPasswords: async () => [],
    removePassword: async () => undefined,
    /** @param {string} id */
    deleteApplication: async (id) => {
      calls.deletedApps.push(id);
    },
    /** @param {string} appId */
    findApplication: async (appId) => (o.applications ?? [{ id: 'object-1', appId: APP_ID, displayName: PAX_APP_NAME }]).find((/** @type {any} */ a) => a.appId === appId) ?? null,
    resolvePrincipal: async () => null,
  };
  const fabric = {
    tenantSettings: async () => {
      throw new Error('Not in this test');
    },
    listWorkspaces: async () => o.workspaces ?? [],
    /** @param {string} id */
    deleteWorkspace: async (id) => {
      calls.deletedWorkspaces.push(id);
    },
  };
  /** @param {any} result */
  const ok = (result) => ({ result, stdout: '', stderr: '', code: 0 });
  /** @param {any} req */
  const runPwsh = async (req) => {
    calls.requests.push(req);
    if (o.pwshMissing) throw new Error(PWSH_MISSING);
    if (req.command === PROBE || req.script === PROBE) return ok(o.probe ?? FULL_PROBE);
    if (req.script === TASK_INFO_SCRIPT) return ok((typeof o.taskInfo === 'function' ? o.taskInfo() : o.taskInfo) ?? { exists: true, state: 'Ready' });
    if (req.script === START_TASK_SCRIPT) {
      calls.started++;
      o.onStart?.();
      return ok({ ok: true });
    }
    if (req.script === UNREGISTER_TASK_SCRIPT) {
      calls.unregistered++;
      return ok({ removed: true });
    }
    if (typeof req.script === 'string' && req.script.includes('-DeleteKey')) {
      calls.deletedCerts.push(req.script);
      return ok({ removed: true });
    }
    if (req.file === wrapperPath(env) && req.args?.includes('-CheckAccess')) {
      return o.check ? ok(o.check) : { result: null, stdout: '', stderr: 'pwsh: boom', code: 1 };
    }
    throw new Error(`No fake for this PowerShell call: ${JSON.stringify(req).slice(0, 120)}`);
  };
  const ctx = {
    ui: fake.ui,
    config,
    file: join(dir, 'aio-install.json'),
    save: () => {
      calls.saves++;
    },
    api: { graph, fabric },
    user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: TENANT },
    sources: { dir, notebooks: {}, pipeline: {}, ...o.sources },
    /** @param {number} ms */
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
    method: 'browser',
    runFirstLoad: o.runFirstLoad,
    runPwsh,
    env,
    sites: {
      /** @param {string} id @param {string} grantId */
      permission: async (id, grantId) => ({ id: grantId, roles: ['write'], grantedToIdentitiesV2: [{ application: { id: o.grantAppId ?? APP_ID } }] }),
      /** @param {string} id @param {string} grantId */
      revoke: async (id, grantId) => {
        calls.revoked.push([id, grantId]);
      },
    },
  };
  return {
    ctx: /** @type {import('../src/install.js').Ctx} */ (/** @type {unknown} */ (ctx)),
    config,
    env,
    dir,
    fake,
    calls,
    out: () => strip(fake.text()),
  };
}

/**
 * Writes last-run.json as the task's script does, with a BOM.
 * @param {NodeJS.ProcessEnv} env
 * @param {any} run
 */
function writeLastRun(env, run) {
  const file = lastRunPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `\uFEFF${JSON.stringify(run)}`, 'utf8');
}

/**
 * Stops any real HTTP call for the rest of the test.
 * @param {import('node:test').TestContext} t
 */
function noFetch(t) {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (
    async () => {
      throw new Error('No HTTP in this test');
    }
  );
  t.after(() => {
    globalThis.fetch = real;
  });
}

/** @param {any} c */
const cfg = (c) => /** @type {any} */ ({ ...emptyConfig(), ...c });
/** @param {boolean} enabled */
const model = (enabled) => ({ ...emptyConfig().semanticModel, enabled });
const ACCESS = { groupId: 'group-1', groupName: 'AI in One Viewers' };

test('withReport: only a SharePoint install with the model turned on gets the report', () => {
  assert.equal(withReport(cfg({ pax: emptyPax(), semanticModel: model(true) })), true);
  assert.equal(withReport(cfg({ pax: emptyPax(), semanticModel: model(false) })), false);
  assert.equal(withReport(cfg({ pax: { ...emptyPax(), destination: 'local' }, semanticModel: model(true) })), false);
  assert.equal(withReport(cfg({ semanticModel: model(true) })), false, 'a Fabric record has no PAX report');
});

test('withApp: on for PAX unless deployApp is false, never for Fabric', () => {
  assert.equal(withApp(cfg({ pax: emptyPax() })), true);
  assert.equal(withApp(cfg({ pax: { ...emptyPax(), deployApp: undefined } })), true);
  assert.equal(withApp(cfg({ pax: { ...emptyPax(), deployApp: false } })), false);
  assert.equal(withApp(cfg({})), false);
});

test('withAccess: needs an access section and the report or the app', () => {
  const noApp = { ...emptyPax(), deployApp: false };
  assert.equal(withAccess(cfg({ pax: noApp, semanticModel: model(true), access: ACCESS })), true);
  assert.equal(withAccess(cfg({ pax: emptyPax(), semanticModel: model(false), access: ACCESS })), true);
  assert.equal(withAccess(cfg({ pax: noApp, semanticModel: model(false), access: ACCESS })), false);
  assert.equal(withAccess(cfg({ pax: emptyPax(), semanticModel: model(true) })), false);
  assert.equal(withAccess(cfg({ access: ACCESS, semanticModel: model(true) })), false);
});

test('setUpTitles: the five base steps, then the report, viewer access and the app as chosen', () => {
  const base = ['PAX and Python', 'App registration', 'Microsoft Graph permissions'];
  assert.deepEqual(setUpTitles(cfg({ pax: { ...emptyPax(), deployApp: false } })), [...base, 'SharePoint site access', 'Scheduled task']);
  assert.deepEqual(setUpTitles(cfg({ pax: { ...emptyPax(), destination: 'local', deployApp: false }, access: ACCESS })), [
    ...base,
    'Local folder',
    'Scheduled task',
  ]);
  const all = setUpTitles(cfg({ pax: emptyPax(), semanticModel: model(true), access: ACCESS }));
  assert.deepEqual(all.slice(0, 7), [...base, 'SharePoint site access', 'Scheduled task', 'Workspace, semantic model and report', 'Viewer access']);
  assert.equal(all.length, 8);
  assert.match(all[7], /AI in One app/);
  const appOnly = setUpTitles(cfg({ pax: { ...emptyPax(), destination: 'local' } }));
  assert.equal(appOnly.length, 6);
  assert.equal(appOnly[3], 'Local folder');
  assert.match(appOnly[5], /AI in One app/);
});

/** The PC checks that stop the install at its first step, before anything is set up. */
const STOPS = [
  {
    name: 'PowerShell 7 is missing',
    o: { pwshMissing: true },
    message: /^PowerShell 7 isn't installed\. Install it from \S+, then run the installer again\.$/,
  },
  {
    name: 'the PC is not Windows',
    o: { probe: { ...FULL_PROBE, isWindows: false, os: 'Ubuntu 24.04' } },
    message: 'The PAX route runs on Windows. This is Ubuntu 24.04. Run the installer on a Windows PC or server.',
  },
  {
    name: 'the execution policy blocks scripts',
    o: { probe: { ...FULL_PROBE, executionPolicy: 'AllSigned', policies: { CurrentUser: 'AllSigned' } } },
    message: /^PowerShell's execution policy is AllSigned \(CurrentUser scope\)\. With AllSigned, only signed scripts can run/,
  },
  {
    name: 'PowerShell is too old',
    o: { probe: { ...FULL_PROBE, version: '5.1.22621' } },
    message: /^PowerShell 5\.1\.22621 is too old\. Install PowerShell 7 from \S+, then run the installer again\.$/,
  },
  {
    name: "Task Scheduler's commands are missing",
    o: { probe: { ...FULL_PROBE, scheduledTasks: false } },
    message: "Task Scheduler's PowerShell commands aren't available. They come with Windows. Ask IT whether they're blocked on this PC.",
  },
  {
    name: 'Python is missing under --yes',
    o: { yes: true, probe: { ...FULL_PROBE, python: null } },
    message:
      'Python 3.10 or later isn\'t installed. Install it for your account from https://www.python.org/downloads/windows/, then run the installer again. Or run the installer without --yes, and it offers to install Python with winget.',
  },
];

for (const stop of STOPS) {
  test(`paxInstall: stops at step 1 when ${stop.name}`, async (t) => {
    noFetch(t);
    const { ctx, out, calls } = paxCtx(t, { runFirstLoad: true, ...stop.o });
    await assert.rejects(paxInstall(ctx, { wait: false, pre: { canConsent: true } }), { message: stop.message });
    assert.match(out(), /\[1\/7\] PAX and Python/);
    assert.doesNotMatch(out(), /\[2\/7\]/);
    assert.equal(calls.started, 0);
  });
}

test('paxInstall: without --yes, declining winget for Python stops at step 1 too', async (t) => {
  noFetch(t);
  const { ctx, out, fake } = paxCtx(t, { answers: [false], probe: { ...FULL_PROBE, python: null } });
  await assert.rejects(paxInstall(ctx, { wait: false, pre: { canConsent: true } }), {
    message: "Python 3.10 or later isn't installed. Install it for your account from https://www.python.org/downloads/windows/, then run the installer again.",
  });
  assert.ok(fake.asked.includes('Install Python 3.13 for your account only, with winget?'), fake.asked.join(' | '));
  assert.match(out(), /\[1\/6\] PAX and Python/, 'the default PAX install has six steps without a first load');
});

test('paxInstall: the step count covers the report, viewer access, the app and the first load', async (t) => {
  noFetch(t);
  const all = paxCtx(t, { runFirstLoad: true, pwshMissing: true, config: { semanticModel: model(true), access: ACCESS } });
  await assert.rejects(paxInstall(all.ctx, { wait: false, pre: { canConsent: true } }));
  assert.match(all.out(), /\[1\/9\] PAX and Python/);
  const few = paxCtx(t, { pwshMissing: true, pax: { destination: 'local', deployApp: false } });
  await assert.rejects(paxInstall(few.ctx, { wait: false, pre: { canConsent: true } }));
  assert.match(few.out(), /\[1\/5\] PAX and Python/);
});

test('paxSummary: a SharePoint install that worked', (t) => {
  const { ctx, out } = paxCtx(t, {
    pax: { site: SITE, certificateExpires: '2027-06-01T00:00:00Z', deployApp: false },
    config: { app: { ...emptyConfig().app, appId: APP_ID, displayName: PAX_APP_NAME } },
  });
  paxSummary(ctx, { ok: true });
  const text = out();
  assert.match(text, /AI in One is set up/);
  assert.doesNotMatch(text, /partly set up/);
  assert.ok(text.includes(`Files:      ${FOLDER_LABEL}`), text);
  assert.ok(text.includes(`Task:       ${TASK_NAME}, daily at 02:00, while you are signed in`), text);
  assert.ok(text.includes('Sign-in:    a certificate in your certificate store, until 2027-06-01'), text);
  assert.ok(text.includes(commandLine('rotate-secret')), text);
  assert.match(text, /Keep aio-install\.json\. It holds no secrets/);
  assert.doesNotMatch(text, /Power BI Desktop/);
});

test('paxSummary: a local install that stopped part way, with a client secret and the app', (t) => {
  const { ctx, out } = paxCtx(t, {
    pax: { destination: 'local', localFolder: 'C:\\Data\\AI in One', credentialType: 'secret', signedOut: true },
    config: { managedApp: { url: 'https://apps.powerapps.com/play/e/env-1/a/app-1' } },
  });
  paxSummary(ctx, { ok: false });
  const text = out();
  assert.match(text, /AI in One is partly set up/);
  assert.match(text, /A step above didn't finish\. Fix what it says, then run the installer again: it picks up where it stopped\./);
  assert.ok(text.includes('Files:      C:\\Data\\AI in One'), text);
  assert.ok(text.includes('whether or not you are signed in, once you give Windows your password in Task Scheduler'), text);
  assert.ok(text.includes('Sign-in:    a client secret, protected for you on this PC'), text);
  assert.doesNotMatch(text, /Sign-in: .*until/);
  assert.match(text, /App: {8}AI in One.*https:\/\/apps\.powerapps\.com\/play\/e\/env-1\/a\/app-1/);
  assert.match(text, /The files stay on this PC, so open the report on them in Power BI Desktop/);
  assert.ok(text.includes(join('C:\\Data\\AI in One', FILES.interactions)), text);
});

const NOTHING_YET = 'Nothing is installed yet. Run the installer first.';
const REGISTERED = { taskRegisteredAt: '2026-05-01T00:00:00.000Z' };

test('runPaxCommand: needs a PAX section, and the task for the commands that use it', async (t) => {
  const { ctx, config } = paxCtx(t);
  for (const command of ['status', 'run', 'check', 'refresh', 'update', 'rotate-secret']) {
    await assert.rejects(runPaxCommand(ctx, command, { wait: false }), { message: NOTHING_YET }, command);
  }
  delete config.pax;
  await assert.rejects(runPaxCommand(ctx, 'uninstall', { wait: false }), { message: 'The install record has no PAX setup.' });
});

test('runPaxCommand: rerun-failed points to run; prereqs and unknown commands are refused', async (t) => {
  const { ctx } = paxCtx(t, { pax: REGISTERED });
  await assert.rejects(runPaxCommand(ctx, 'rerun-failed', { wait: false }), {
    message: `rerun-failed is for the Fabric route. To run PAX again now, run: ${commandLine('run')}`,
  });
  await assert.rejects(runPaxCommand(ctx, 'prereqs', { wait: false }), { message: 'Unknown command "prereqs".' });
  await assert.rejects(runPaxCommand(ctx, 'bogus', { wait: false }), { message: 'Unknown command "bogus".' });
});

test('run: starts the task, records the first run and points to status', async (t) => {
  const { ctx, calls, config, out } = paxCtx(t, { pax: REGISTERED });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: false }), true);
  assert.equal(calls.started, 1);
  assert.equal(config.pax.firstRunStartedAt, NOW.toISOString());
  assert.ok(calls.saves >= 1);
  assert.match(out(), /Started the scheduled task$/m);
  assert.ok(out().includes(`Run "${commandLine('status')}" to see how it's going.`), out());
});

test('run: keeps the time of the first run', async (t) => {
  const first = '2026-05-02T02:00:00.000Z';
  const { ctx, config, calls } = paxCtx(t, { pax: { ...REGISTERED, firstRunStartedAt: first } });
  await runPaxCommand(ctx, 'run', { wait: false });
  assert.equal(calls.started, 1);
  assert.equal(config.pax.firstRunStartedAt, first);
});

test('run: leaves a run that is going already alone', async (t) => {
  const { ctx, calls, out } = paxCtx(t, { pax: REGISTERED, taskInfo: { exists: true, state: 'Running' } });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: false }), true);
  assert.equal(calls.started, 0);
  assert.match(out(), /A run is going already\.$/m);
});

test('run: a missing task says to repair it', async (t) => {
  const { ctx } = paxCtx(t, { pax: REGISTERED, taskInfo: { exists: false } });
  await assert.rejects(runPaxCommand(ctx, 'run', { wait: false }), {
    message: `The scheduled task "${TASK_NAME}" isn't there. Run install again to repair it.`,
  });
});

test('run --backfill-days: fewer days than the files hold asks first, and No starts nothing', async (t) => {
  const { ctx, calls, config, env, out, fake } = paxCtx(t, { pax: REGISTERED });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: false, backfillDays: 30 }), true);
  assert.ok(fake.asked.includes('Reload only 30 days?'), fake.asked.join(' | '));
  assert.equal(calls.started, 0);
  assert.equal(config.history.days, 180);
  assert.equal(existsSync(seedRequestPath(env)), false);
  const text = out();
  assert.ok(text.includes('This loads the audit history again with 30 days, so the 180 days in the files now drop to 30.'), text);
  assert.ok(text.includes(`Nothing started. To keep the history you have, run "${commandLine('run --backfill-days 180')}" or more.`), text);
});

test('run --backfill-days: under --yes and waiting, the reload nobody agreed to counts as not done', async (t) => {
  const { ctx, calls } = paxCtx(t, { yes: true, pax: REGISTERED });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: true, backfillDays: 30 }), false);
  assert.equal(calls.started, 0);
});

test('run --backfill-days: the full history asks the run to load it again', async (t) => {
  const { ctx, calls, config, env, out } = paxCtx(t, { pax: { ...REGISTERED, firstRunStartedAt: '2026-05-02T02:00:00.000Z' } });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: false, backfillDays: 180 }), true);
  assert.equal(readFileSync(seedRequestPath(env), 'utf8'), `${NOW.toISOString()}\n`);
  assert.equal(calls.started, 1);
  assert.equal(config.pax.firstRunStartedAt, NOW.toISOString(), 'a history run counts as the first run again');
  const text = out();
  assert.match(text, /Started the scheduled task: it loads the history again/);
  assert.ok(text.includes(`PAX loads 180 days of audit history in the background. Run "${commandLine('status')}" to see how it's going.`), text);
  assert.doesNotMatch(text, /once it has finished/);
});

test('run --backfill-days: with the report, the note says to run check once it has finished', async (t) => {
  const { ctx, out } = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, config: { semanticModel: { ...model(true), name: 'Contoso PAX model' } } });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: false, backfillDays: 180 }), true);
  assert.ok(out().includes(`, then "${commandLine('check')}" once it has finished, to connect Contoso PAX model to the files.`), out());
});

test('run --backfill-days: while a run is going, nothing changes until it finishes', async (t) => {
  const { ctx, calls, config, env, out } = paxCtx(t, { pax: REGISTERED, taskInfo: { exists: true, state: 'Running' }, config: { history: { ...emptyConfig().history, days: 90 } } });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: false, backfillDays: 180 }), true);
  assert.equal(calls.started, 0);
  assert.equal(existsSync(seedRequestPath(env)), false, 'the run may be loading the history, and keeps its progress in that file');
  assert.equal(config.history.days, 90, 'the days stay as they are until the reload starts');
  const text = out();
  assert.ok(text.includes("A run is going already, so the history can't be loaded again until it finishes."), text);
  assert.ok(text.includes(`Once it has, run: ${commandLine('run --backfill-days 180')}`), text);
});

test('run --backfill-days --wait: while a run is going, the reload it waited for never started', async (t) => {
  const { ctx, calls, env } = paxCtx(t, { pax: REGISTERED, taskInfo: { exists: true, state: 'Running' } });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: true, backfillDays: 180 }), false);
  assert.equal(calls.started, 0);
  assert.equal(existsSync(seedRequestPath(env)), false);
});

test('run --wait: waits for the run and says how it went', async (t) => {
  const { ctx, env, out } = paxCtx(t, { pax: { ...REGISTERED, destination: 'local' } });
  writeLastRun(env, { mode: 'daily', status: 'ok', startedAt: NOW.toISOString(), finishedAt: '2026-06-01T12:20:00.000Z' });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: true }), true);
  assert.match(out(), /The last daily run worked\. It started 2026-06-01 12:00 UTC and finished 2026-06-01 12:20 UTC\./);
});

test('run --wait: a failed run returns false', async (t) => {
  const { ctx, env, out } = paxCtx(t, { pax: { ...REGISTERED, destination: 'local' } });
  writeLastRun(env, { mode: 'daily', status: 'failed', startedAt: NOW.toISOString(), finishedAt: '2026-06-01T12:05:00.000Z', message: 'PAX could not sign in.' });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: true }), false);
  assert.match(out(), /✗ The last daily run failed\./);
  assert.match(out(), /PAX could not sign in\./);
});

test('run --wait: a run still going when the wait ends says to check status later', async (t) => {
  let reads = 0;
  const { ctx, calls, out } = paxCtx(t, {
    pax: { ...REGISTERED, destination: 'local' },
    taskInfo: () => (reads++ === 0 ? { exists: true, state: 'Ready' } : { exists: true, state: 'Running' }),
  });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: true }), false);
  assert.equal(calls.started, 1);
  assert.ok(reads > 2, 'it polled the task with the fake clock');
  assert.ok(out().includes(`The run hasn't finished yet. Run "${commandLine('status')}" later to see how it went.`), out());
});

test('status: the live task, its sign-in and the last run with its counts', async (t) => {
  const { ctx, env, dir, out } = paxCtx(t, {
    pax: { ...REGISTERED, site: SITE, certificateExpires: '2026-06-20T00:00:00Z' },
    taskInfo: { exists: true, state: 'Disabled', logonType: 'S4U', nextRunTime: '2026-06-02T02:00:00Z' },
  });
  const metrics = join(dir, 'metrics.json');
  writeFileSync(metrics, `\uFEFF${JSON.stringify({ metrics: { TotalRecordsFetched: 12345, TotalStructuredRows: 678 } })}`, 'utf8');
  writeLastRun(env, {
    mode: 'daily',
    status: 'warning',
    startedAt: '2026-06-01T02:00:00Z',
    finishedAt: '2026-06-01T02:30:00Z',
    message: 'Some records were skipped.',
    metrics,
    warnings: ['The Agent 365 file was empty.'],
    log: 'C:\\Logs\\run.log',
  });
  assert.equal(await runPaxCommand(ctx, 'status', { wait: false }), true);
  const text = out();
  assert.ok(text.includes(`Files:    ${FOLDER_LABEL}`), text);
  assert.ok(text.includes(`Task:     ${TASK_NAME}, daily at 02:00, whether or not you are signed in, without your password (Disabled)`), text);
  assert.match(text, /The task is set to run without your password \("Do not store password"\), so it can't use its certificate/);
  assert.ok(text.includes('Next run 2026-06-02 02:00 UTC'), text);
  assert.ok(text.includes('The task is turned off. Turn it on again in Task Scheduler, or run the installer again.'), text);
  assert.ok(text.includes(`Sign-in:  a certificate in your certificate store, until 2026-06-20. Run "${commandLine('rotate-secret')}" to replace it before then.`), text);
  assert.match(text, /! The last daily run worked, with warnings\. It started 2026-06-01 02:00 UTC and finished 2026-06-01 02:30 UTC\./);
  assert.ok(text.includes('Some records were skipped.'), text);
  assert.ok(text.includes('PAX read 12,345 audit records into 678 rows.'), text);
  assert.ok(text.includes('Warning: The Agent 365 file was empty.'), text);
  assert.ok(text.includes('Its log: C:\\Logs\\run.log'), text);
  assert.doesNotMatch(text, /hasn't run yet/);
});

test('status: an expired client secret, and a task that has not run yet', async (t) => {
  const { ctx, out } = paxCtx(t, {
    pax: { ...REGISTERED, destination: 'local', localFolder: 'C:\\Data', credentialType: 'secret', secretExpires: '2026-05-01T00:00:00Z' },
    taskInfo: { exists: true, state: 'Ready', logonType: 'Interactive', nextRunTime: '2026-06-02T02:00:00Z' },
  });
  assert.equal(await runPaxCommand(ctx, 'status', { wait: false }), true);
  const text = out();
  assert.ok(text.includes('Files:    C:\\Data'), text);
  assert.match(text, /Task: {5}AI in One - PAX refresh, daily at 02:00, while you are signed in$/m);
  assert.ok(
    text.includes(`Sign-in:  a client secret, protected for you on this PC, until 2026-05-01. It has expired, so the task can't sign in: run "${commandLine('rotate-secret')}".`),
    text,
  );
  assert.ok(text.includes(`The task hasn't run yet. Its first run is at 2026-06-02 02:00 UTC, or start it now: ${commandLine('run')}`), text);
  assert.doesNotMatch(text, /without your password/);
});

test('status: a task set to run signed out with its password, the app, and a run that is going', async (t) => {
  const { ctx, env, out } = paxCtx(t, {
    pax: { ...REGISTERED, site: SITE, signedOut: true, certificateExpires: '2027-06-01T00:00:00Z' },
    config: { managedApp: { url: 'https://apps.powerapps.com/play/e/env-1/a/app-1' } },
    taskInfo: { exists: true, state: 'Running', logonType: 'Password' },
  });
  writeLastRun(env, { mode: 'seed', status: 'running', startedAt: '2026-06-01T11:00:00Z' });
  assert.equal(await runPaxCommand(ctx, 'status', { wait: false }), true);
  const text = out();
  assert.ok(text.includes(`${TASK_NAME}, daily at 02:00, whether or not you are signed in (Running)`), text);
  assert.ok(text.includes('Sign-in:  a certificate in your certificate store, until 2027-06-01'), text);
  assert.doesNotMatch(text, /rotate-secret/);
  assert.match(text, /App: {6}.*AI in One.*https:\/\/apps\.powerapps\.com\/play\/e\/env-1\/a\/app-1/);
  assert.ok(text.includes('A history (seed) run is going: it started 2026-06-01 11:00 UTC.'), text);
});

test('status: the live task wins over the record, and no logon type reads as signed in only', async (t) => {
  const { ctx, out } = paxCtx(t, { pax: { ...REGISTERED, site: SITE, logonType: 'Password' } });
  await runPaxCommand(ctx, 'status', { wait: false });
  assert.match(out(), /Task: {5}AI in One - PAX refresh, daily at 02:00, while you are signed in$/m);
  const signedOut = paxCtx(t, { pax: { ...REGISTERED, site: SITE, signedOut: true } });
  await runPaxCommand(signedOut.ctx, 'status', { wait: false });
  assert.ok(signedOut.out().includes('whether or not you are signed in, once you give Windows your password in Task Scheduler'), signedOut.out());
});

test('status: a missing task says to run the installer again', async (t) => {
  const { ctx, out } = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, taskInfo: { exists: false } });
  assert.equal(await runPaxCommand(ctx, 'status', { wait: false }), true);
  const text = out();
  assert.ok(text.includes(`The scheduled task "${TASK_NAME}" isn't there. Run the installer again to put it back.`), text);
  assert.doesNotMatch(text, /Task: {5}/);
  assert.match(text, /The task hasn't run yet\.$/m);
});

test('status: a history run that stopped before it finished says how far it got, and that the next run carries on', async (t) => {
  const { ctx, env, out } = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, taskInfo: { exists: true, state: 'Ready' } });
  writeLastRun(env, { mode: 'seed', status: 'running', startedAt: '2026-06-01T02:00:00Z', seed: { from: '2025-12-03', loaded: '2026-02-01', done: false, window: 30 } });
  assert.equal(await runPaxCommand(ctx, 'status', { wait: false }), true);
  const text = out();
  assert.ok(
    text.includes(
      "! The last history (seed) run stopped before it finished. It started 2026-06-01 02:00 UTC, and probably reached the task's 4-hour limit, or stopped when you signed out or the PC shut down.",
    ),
    text,
  );
  assert.ok(text.includes('It had loaded the history from 2025-12-03 to 2026-02-01. The next run carries on from there.'), text);
  assert.ok(text.includes(`To run it now: ${commandLine('run')}`), text);
  assert.doesNotMatch(text, /is going/);
});

test('status and check: a history stuck on one day says so from the second stop, and names the PAX logs', async (t) => {
  const log = 'C:\\Users\\ana\\AppData\\Local\\AI in One\\PAX\\logs\\run-20260601-020000.log';
  const stuck = { mode: 'seed', status: 'running', startedAt: '2026-06-01T02:00:00Z', log, seed: { from: '2025-12-03', next: '2026-02-02', loaded: '2026-02-01', done: false, window: 1, stops: 0 } };
  const first = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, taskInfo: { exists: true, state: 'Ready' } });
  writeLastRun(first.env, stuck);
  await runPaxCommand(first.ctx, 'status', { wait: false });
  assert.ok(first.out().includes('It had loaded the history from 2025-12-03 to 2026-02-01. The next run carries on from there.'), first.out());
  assert.doesNotMatch(first.out(), /stuck/);

  const message =
    "The history is stuck at 2026-02-02: the last 2 runs stopped while they loaded that one day. Each run tries it again. PAX's logs are in C:\\Users\\ana\\AppData\\Local\\AI in One\\PAX\\logs\\pax.";
  const second = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, taskInfo: { exists: true, state: 'Ready' } });
  writeLastRun(second.env, { ...stuck, seed: { ...stuck.seed, stops: 1 } });
  await runPaxCommand(second.ctx, 'status', { wait: false });
  assert.ok(second.out().includes(message), second.out());
  assert.ok(second.out().includes(`To run it now: ${commandLine('run')}`), second.out());
  assert.doesNotMatch(second.out(), /carries on from there/);

  const wide = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, taskInfo: { exists: true, state: 'Ready' } });
  writeLastRun(wide.env, { ...stuck, seed: { ...stuck.seed, window: 2, stops: 1 } });
  await runPaxCommand(wide.ctx, 'status', { wait: false });
  assert.doesNotMatch(wide.out(), /stuck/, 'only a one-day window can be stuck');

  const check = paxCtx(t, { pax: { ...REGISTERED, destination: 'local' }, taskInfo: { exists: true, state: 'Ready' } });
  check.config.pax.localFolder = join(check.dir, 'Not there');
  writeLastRun(check.env, { ...stuck, seed: { ...stuck.seed, stops: 4 } });
  await runPaxCommand(check.ctx, 'check', { wait: false });
  assert.ok(check.out().includes(message.replace('the last 2 runs', 'the last 5 runs')), check.out());
});

test('status: a daily run that stopped, and one with nothing loaded yet', async (t) => {
  const daily = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, taskInfo: { exists: true, state: 'Ready' } });
  writeLastRun(daily.env, { mode: 'daily', status: 'running', startedAt: '2026-06-01T02:00:00Z' });
  await runPaxCommand(daily.ctx, 'status', { wait: false });
  assert.match(daily.out(), /! The last daily run stopped before it finished\./);
  assert.ok(daily.out().includes('The next run loads those days again.'), daily.out());
  const seed = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, taskInfo: { exists: true, state: 'Disabled' } });
  writeLastRun(seed.env, { mode: 'seed', status: 'running', startedAt: '2026-06-01T02:00:00Z', seed: { from: '2025-12-03', loaded: null, done: false } });
  await runPaxCommand(seed.ctx, 'status', { wait: false });
  assert.ok(seed.out().includes('The next run carries on loading the history from where it stopped.'), seed.out());
  const queued = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, taskInfo: { exists: true, state: 'Queued' } });
  writeLastRun(queued.env, { mode: 'daily', status: 'running', startedAt: '2026-06-01T02:00:00Z' });
  await runPaxCommand(queued.ctx, 'status', { wait: false });
  assert.match(queued.out(), /A daily run is going: it started 2026-06-01 02:00 UTC\./, 'a queued task is about to run, not stopped');
});

test('status: a history run that is going, or failed, says how far it has got', async (t) => {
  const going = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, taskInfo: { exists: true, state: 'Running' } });
  writeLastRun(going.env, { mode: 'seed', status: 'running', startedAt: '2026-06-01T02:00:00Z', seed: { from: '2025-12-03', loaded: '2026-01-01', done: false } });
  await runPaxCommand(going.ctx, 'status', { wait: false });
  assert.ok(going.out().includes('So far it has loaded the history from 2025-12-03 to 2026-01-01.'), going.out());
  const failed = paxCtx(t, { pax: { ...REGISTERED, site: SITE } });
  writeLastRun(failed.env, {
    mode: 'seed',
    status: 'failed',
    startedAt: '2026-06-01T02:00:00Z',
    finishedAt: '2026-06-01T03:00:00Z',
    message: 'PAX failed with exit code 40.',
    seed: { from: '2025-12-03', loaded: '2026-01-01', done: false },
  });
  await runPaxCommand(failed.ctx, 'status', { wait: false });
  assert.ok(failed.out().includes('It had loaded the history from 2025-12-03 to 2026-01-01. The next run carries on from there.'), failed.out());
  const paused = paxCtx(t, { pax: { ...REGISTERED, site: SITE } });
  writeLastRun(paused.env, {
    mode: 'seed',
    status: 'ok',
    startedAt: '2026-06-01T02:00:00Z',
    finishedAt: '2026-06-01T05:30:00Z',
    message: 'Loaded the history to 2026-03-02. The next run carries on from there.',
    seed: { from: '2025-12-03', loaded: '2026-03-02', done: false },
  });
  await runPaxCommand(paused.ctx, 'status', { wait: false });
  assert.ok(paused.out().includes(`To carry on now, run: ${commandLine('run')}`), paused.out());
  const done = paxCtx(t, { pax: { ...REGISTERED, site: SITE } });
  writeLastRun(done.env, { mode: 'seed', status: 'ok', startedAt: '2026-06-01T02:00:00Z', finishedAt: '2026-06-01T05:30:00Z', seed: { from: '2025-12-03', loaded: '2026-05-31', done: true } });
  await runPaxCommand(done.ctx, 'status', { wait: false });
  assert.doesNotMatch(done.out(), /carry on|carries on|So far/);
});

test('status: a run that found no Copilot interactions says there is no data yet', async (t) => {
  const { ctx, env, out } = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, config: { semanticModel: { ...model(true), name: 'AI in One' } } });
  writeLastRun(env, {
    mode: 'seed',
    status: 'warning',
    startedAt: '2026-06-01T02:00:00Z',
    finishedAt: '2026-06-01T02:40:00Z',
    noData: true,
    message: 'PAX found no Copilot interactions in the last 180 days.',
    seed: { from: '2025-12-03', loaded: '2026-05-31', done: true },
  });
  assert.equal(await runPaxCommand(ctx, 'status', { wait: false }), true);
  const text = out();
  assert.match(text, /! The last history \(seed\) run worked, with warnings\./);
  assert.ok(text.includes(noDataYet('AI in One')), text);
  assert.ok(noDataYet('AI in One').endsWith(`Then run "${commandLine('check')}" to connect AI in One to them.`));
  assert.ok(!noDataYet().includes('check'), 'without the report there is nothing to connect');
});

test('run --wait: a run that found no Copilot interactions is not a failure, and leaves the model alone', async (t) => {
  noFetch(t);
  const { ctx, env, out, calls } = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, config: { semanticModel: { ...model(true), id: 'm1', name: 'AI in One' } } });
  writeLastRun(env, { mode: 'daily', status: 'ok', startedAt: NOW.toISOString(), finishedAt: '2026-06-01T12:05:00.000Z', noData: true });
  assert.equal(await runPaxCommand(ctx, 'run', { wait: true }), true);
  assert.ok(out().includes(noDataYet('AI in One')), out());
  assert.equal(calls.requests.filter((r) => r.args?.includes('-CheckAccess')).length, 0, 'no check of the folder, and no refresh');
});

test('refresh: a model that was deleted from the workspace is forgotten, with no raw 404', async (t) => {
  const files = [{ name: FILES.interactions, exists: true, size: 10 }, { name: FILES.users, exists: true, size: 10 }];
  const { ctx, config, out } = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, check: { ok: true, files }, config: { semanticModel: { ...model(true), id: 'm1', name: 'AI in One', bound: true } } });
  config.fabric = { ...config.fabric, workspaceId: 'ws1', workspaceName: 'Copilot Reporting' };
  /** @type {any} */ (ctx.api.fabric).listItems = async () => [];
  assert.equal(await runPaxCommand(ctx, 'refresh', { wait: false }), false);
  assert.equal(config.semanticModel.id, undefined);
  assert.ok(out().includes('AI in One isn\'t in "Copilot Reporting" any more.'), out());
  assert.ok(out().includes(`AI in One isn't deployed. Run "${commandLine('update')}".`), out());
});

/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('check: a local folder with every file lists them, without PowerShell', async (t) => {
  const { ctx, config, dir, out, calls } = paxCtx(t, { pax: { ...REGISTERED, destination: 'local', agent365: true } });
  const folder = join(dir, 'Files');
  mkdirSync(folder);
  config.pax.localFolder = folder;
  for (const name of paxFiles(config.pax)) writeFileSync(join(folder, name), 'x'.repeat(3000));
  assert.equal(await runPaxCommand(ctx, 'check', { wait: false }), true);
  const text = out();
  assert.match(text, /Checking the files/);
  for (const name of [FILES.interactions, FILES.users, FILES.agent365]) {
    assert.match(text, new RegExp(`✓ ${esc(name)}: 3 KB, changed \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC`));
  }
  assert.equal(calls.requests.length, 0);
});

test('check: a local folder without the files yet', async (t) => {
  const { ctx, config, dir, out } = paxCtx(t, { pax: { ...REGISTERED, destination: 'local' } });
  config.pax.localFolder = join(dir, 'Not there');
  assert.equal(await runPaxCommand(ctx, 'check', { wait: false }), false);
  const text = out();
  assert.ok(text.includes(`${FILES.interactions} isn't there yet`), text);
  assert.ok(text.includes(`${FILES.users} isn't there yet`), text);
  assert.doesNotMatch(text, /AIO_Agent365/);
  assert.ok(text.includes(`Once "${commandLine('status')}" shows a run has worked, run "${commandLine('check')}" again.`), text);
});

test('check: SharePoint, when the check itself fails', async (t) => {
  const { ctx, env, calls, out } = paxCtx(t, { pax: { ...REGISTERED, site: SITE } });
  assert.equal(await runPaxCommand(ctx, 'check', { wait: false }), false);
  assert.equal(calls.requests[0].file, wrapperPath(env));
  const text = out();
  assert.ok(text.includes("Running the check didn't work: pwsh: boom"), text);
  assert.ok(text.includes("Run the installer again to fix the app's access to the folder."), text);
});

test('check: SharePoint lists the files the app sees, matching their names in any case', async (t) => {
  const files = [
    { name: FILES.interactions.toUpperCase(), exists: true, size: 5 * 1024 * 1024 + 100, lastModified: '2026-06-01T02:30:00Z' },
    { name: FILES.users.toLowerCase(), exists: true, size: 100, lastModified: '2026-06-01T02:31:00Z' },
  ];
  const { ctx, out } = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, check: { ok: true, files } });
  assert.equal(await runPaxCommand(ctx, 'check', { wait: false }), true);
  const text = out();
  assert.ok(text.includes(`The app can write to ${FOLDER_LABEL}`), text);
  assert.ok(text.includes(`${FILES.interactions}: 5.0 MB, changed 2026-06-01 02:30 UTC`), text);
  assert.ok(text.includes(`${FILES.users}: 1 KB, changed 2026-06-01 02:31 UTC`), text);
});

test('check: SharePoint, with a file the task has not written yet', async (t) => {
  const files = [
    { name: FILES.interactions, exists: true, size: 2048, lastModified: '2026-06-01T02:30:00Z' },
    { name: FILES.users, exists: false },
  ];
  const { ctx, out } = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, check: { ok: true, files } });
  assert.equal(await runPaxCommand(ctx, 'check', { wait: false }), false);
  const text = out();
  assert.ok(text.includes(`${FILES.interactions}: 2 KB, changed 2026-06-01 02:30 UTC`), text);
  assert.ok(text.includes(`${FILES.users} isn't there yet`), text);
});

test('check: before the task has found any Copilot interactions, says there is no data yet, which is not a failure', async (t) => {
  noFetch(t);
  const local = paxCtx(t, { pax: { ...REGISTERED, destination: 'local' } });
  local.config.pax.localFolder = join(local.dir, 'Not there');
  writeLastRun(local.env, { mode: 'seed', status: 'warning', startedAt: '2026-06-01T02:00:00Z', finishedAt: '2026-06-01T02:40:00Z', noData: true });
  assert.equal(await runPaxCommand(local.ctx, 'check', { wait: false }), true);
  assert.ok(local.out().includes(noDataYet()), local.out());
  assert.doesNotMatch(local.out(), /isn't there yet/);
  assert.equal(local.calls.requests.length, 0);

  const files = [{ name: FILES.interactions, exists: false }, { name: FILES.users, exists: false }];
  const sp = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, check: { ok: true, files }, config: { semanticModel: { ...model(true), id: 'm1', name: 'AI in One' } } });
  writeLastRun(sp.env, { mode: 'daily', status: 'ok', startedAt: '2026-06-01T02:00:00Z', finishedAt: '2026-06-01T02:10:00Z', noData: true });
  assert.equal(await runPaxCommand(sp.ctx, 'check', { wait: false }), true, 'no refresh of a model with nothing to load');
  assert.ok(sp.out().includes(noDataYet('AI in One')), sp.out());

  const some = paxCtx(t, { pax: { ...REGISTERED, site: SITE }, check: { ok: true, files: [{ name: FILES.interactions, exists: true, size: 10 }, { name: FILES.users, exists: false }] } });
  writeLastRun(some.env, { mode: 'daily', status: 'ok', startedAt: '2026-06-01T02:00:00Z', finishedAt: '2026-06-01T02:10:00Z', noData: true });
  assert.equal(await runPaxCommand(some.ctx, 'check', { wait: false }), false, 'a file that is there means some data');
  assert.ok(some.out().includes(`${FILES.users} isn't there yet`), some.out());
});

test('check: a run that stopped before it finished says so before the files', async (t) => {
  const { ctx, env, config, dir, out, calls } = paxCtx(t, { pax: { ...REGISTERED, destination: 'local' }, taskInfo: { exists: true, state: 'Ready' } });
  config.pax.localFolder = join(dir, 'Not there');
  writeLastRun(env, { mode: 'seed', status: 'running', startedAt: '2026-06-01T02:00:00Z', seed: { from: '2025-12-03', loaded: '2026-01-01', done: false } });
  assert.equal(await runPaxCommand(ctx, 'check', { wait: false }), false);
  const text = out();
  assert.ok(text.indexOf('stopped before it finished') < text.indexOf(`${FILES.interactions} isn't there yet`), text);
  assert.ok(text.includes('It had loaded the history from 2025-12-03 to 2026-01-01. The next run carries on from there.'), text);
  assert.deepEqual(calls.requests.map((r) => r.script), [TASK_INFO_SCRIPT]);
  const going = paxCtx(t, { pax: { ...REGISTERED, destination: 'local' }, taskInfo: { exists: true, state: 'Running' } });
  going.config.pax.localFolder = join(going.dir, 'Not there');
  writeLastRun(going.env, { mode: 'seed', status: 'running', startedAt: '2026-06-01T02:00:00Z' });
  await runPaxCommand(going.ctx, 'check', { wait: false });
  assert.doesNotMatch(going.out(), /stopped before/);
});

const GRANTED_SITE = { ...SITE, id: 'site-1', grantId: 'grant-1', grantedByInstaller: true };
const PAX_APP = { appId: APP_ID, objectId: 'object-1', displayName: PAX_APP_NAME };
const REVOKE_PROMPT = `Take away the app's access to ${SITE_ADDRESS}? You sign in again, with Sites.FullControl.All.`;
const DELETE_APP_PROMPT = `Delete the app registration "${PAX_APP_NAME}" too? Only do this if nothing else uses it. Entra keeps it under Deleted applications for 30 days.`;

/**
 * An installed PAX route's working files on this PC.
 * @param {NodeJS.ProcessEnv} env
 */
function stateFiles(env) {
  const dirs = [runDir(env), join(stateRoot(env), 'pax')];
  for (const d of dirs) mkdirSync(d, { recursive: true });
  writeFileSync(secretPath(env), 'protected', 'utf8');
  return dirs;
}

test('uninstall: No removes nothing', async (t) => {
  const { ctx, config, env, calls, out, fake } = paxCtx(t, {
    answers: [false],
    pax: { ...REGISTERED, site: GRANTED_SITE },
    config: { app: { ...emptyConfig().app, ...PAX_APP }, fabric: { ...emptyConfig().fabric, workspaceId: 'ws-1' } },
  });
  const dirs = stateFiles(env);
  assert.equal(await runPaxCommand(ctx, 'uninstall', { wait: false }), true, 'declining is not a failure');
  assert.deepEqual(fake.asked, ['Uninstall AI in One?']);
  const text = out();
  assert.ok(
    text.includes(
      `This removes the scheduled task "${TASK_NAME}", its sign-in and its working files on this PC, the app registration's access to the SharePoint site and the report. The files the task wrote stay.`,
    ),
    text,
  );
  assert.match(text, /Nothing was removed\./);
  assert.equal(calls.unregistered, 0);
  assert.equal(calls.revoked.length + calls.deletedApps.length + calls.deletedCerts.length, 0);
  for (const d of dirs) assert.ok(existsSync(d));
  assert.equal(config.pax.taskRegisteredAt, REGISTERED.taskRegisteredAt);
});

test('uninstall: saying no keeps the site grant and the app registration, and takes the key off it', async (t) => {
  const { ctx, config, env, calls, out, fake } = paxCtx(t, {
    answers: [true, false, false],
    pax: { ...REGISTERED, site: GRANTED_SITE, certificateKeyId: 'key-1', certificateThumbprint: THUMB, logonType: 'Interactive' },
    config: { app: { ...emptyConfig().app, ...PAX_APP }, access: ACCESS },
  });
  const dirs = stateFiles(env);
  assert.equal(await runPaxCommand(ctx, 'uninstall', { wait: false }), true);
  assert.deepEqual(fake.asked, ['Uninstall AI in One?', REVOKE_PROMPT, DELETE_APP_PROMPT]);
  assert.equal(calls.unregistered, 1);
  assert.equal(config.pax.taskRegisteredAt, undefined);
  assert.equal(config.pax.logonType, undefined);
  assert.deepEqual(calls.revoked, []);
  assert.equal(config.pax.site.grantId, 'grant-1', 'the grant stays in the record');
  assert.deepEqual(calls.deletedApps, []);
  assert.deepEqual(calls.removedKeys, [{ id: 'object-1', keyIds: ['key-1'] }]);
  assert.equal(calls.deletedCerts.length, 1);
  assert.ok(calls.deletedCerts[0].includes(THUMB));
  for (const d of dirs) assert.equal(existsSync(d), false, d);
  const text = out();
  assert.ok(text.includes(`Removed the scheduled task "${TASK_NAME}"`), text);
  assert.ok(text.includes(`The app's access to ${SITE_ADDRESS} stays. An admin can take it away with:`), text);
  assert.ok(text.includes('Took the replaced key off the app'), text);
  assert.ok(text.includes("Removed the task's certificate and secret from this PC"), text);
  assert.ok(text.includes(`The app registration ${PAX_APP_NAME} stays. To set this up again: ${commandLine('install --target pax')}`), text);
  assert.ok(text.includes("Removed PAX and the task's working files from this PC"), text);
  assert.ok(
    text.includes(
      `Left alone: the app registration "${PAX_APP_NAME}", the viewer group "AI in One Viewers" and the files in ${FOLDER_LABEL}. Remove them yourself if nothing else uses them.`,
    ),
    text,
  );
  assert.ok(text.includes('The install record still names what was removed. Move it aside before installing again.'), text);
});

test('uninstall: saying yes takes away the site grant and deletes the app registration and workspace', async (t) => {
  const { ctx, config, calls, out, fake } = paxCtx(t, {
    answers: [true, true, true, true],
    pax: { ...REGISTERED, site: { ...GRANTED_SITE }, certificateKeyId: 'key-1', certificateThumbprint: THUMB },
    config: {
      app: { ...emptyConfig().app, ...PAX_APP },
      fabric: { ...emptyConfig().fabric, workspaceId: 'ws-1', workspaceName: 'Contoso PAX', createdWorkspace: true },
    },
  });
  assert.equal(await runPaxCommand(ctx, 'uninstall', { wait: false }), true);
  assert.deepEqual(fake.asked, ['Uninstall AI in One?', REVOKE_PROMPT, DELETE_APP_PROMPT, 'Delete workspace "Contoso PAX" and the report and model in it?']);
  assert.deepEqual(calls.revoked, [['site-1', 'grant-1']]);
  assert.equal(config.pax.site.grantId, undefined);
  assert.equal(config.pax.site.grantedByInstaller, undefined);
  assert.deepEqual(calls.deletedApps, ['object-1']);
  assert.deepEqual(calls.removedKeys, [], 'no keys to take off an app that is gone');
  assert.ok(calls.deletedCerts.some((/** @type {string} */ s) => s.includes(THUMB)));
  assert.equal(config.pax.certificateThumbprint, undefined);
  assert.deepEqual(calls.deletedWorkspaces, ['ws-1']);
  const text = out();
  assert.ok(text.includes(`Took away the app's access to ${SITE_ADDRESS}`), text);
  assert.ok(text.includes(`Deleted the app registration "${PAX_APP_NAME}"`), text);
  assert.ok(text.includes('Deleted workspace "Contoso PAX"'), text);
  assert.doesNotMatch(text, /stays\. To set this up again/);
  assert.ok(text.includes(`Left alone: the files in ${FOLDER_LABEL}.`), text);
});

test("uninstall: a recorded grant or app object that isn't the app's stays, and isn't asked about again", async (t) => {
  const { ctx, config, calls, out, fake } = paxCtx(t, {
    answers: [true, true],
    pax: { ...REGISTERED, site: { ...GRANTED_SITE }, certificateKeyId: 'key-1', certificateThumbprint: THUMB },
    config: { app: { ...emptyConfig().app, ...PAX_APP } },
    grantAppId: '00000000-0000-0000-0000-000000000009',
    applications: [{ id: 'object-9', appId: APP_ID, displayName: PAX_APP_NAME }],
  });
  assert.equal(await runPaxCommand(ctx, 'uninstall', { wait: false }), true);
  assert.deepEqual(fake.asked, ['Uninstall AI in One?', REVOKE_PROMPT], 'the app registration is not offered');
  assert.deepEqual(calls.revoked, []);
  assert.equal(config.pax.site.grantId, undefined);
  assert.deepEqual(calls.deletedApps, []);
  const text = out();
  assert.ok(text.includes(`The permission the install record names on ${SITE_ADDRESS} (grant-1) isn't the app's, so the installer left it alone`), text);
  assert.ok(text.includes(`The app registration with app ID ${APP_ID} isn't the one the installer made`), text);
});

test('uninstall: a grant the installer did not give, and an app it did not make, are not asked about', async (t) => {
  const { ctx, calls, out, fake } = paxCtx(t, {
    answers: [true],
    pax: { ...REGISTERED, site: { ...SITE, id: 'site-1', grantId: 'grant-1' } },
    config: { app: { ...emptyConfig().app, ...PAX_APP, existing: true } },
  });
  assert.equal(await runPaxCommand(ctx, 'uninstall', { wait: false }), true);
  assert.deepEqual(fake.asked, ['Uninstall AI in One?']);
  assert.deepEqual(calls.revoked, []);
  assert.deepEqual(calls.deletedApps, []);
  const text = out();
  assert.ok(text.includes(`The installer didn't give the app its access to ${SITE_ADDRESS}, so it stays. An admin can take it away with:`), text);
  assert.ok(text.includes(`The app registration ${PAX_APP_NAME} stays.`), text);
});

test('uninstall: a local install leaves its folder alone, and a declined workspace stays', async (t) => {
  const { ctx, calls, out, fake } = paxCtx(t, {
    answers: [true, false],
    pax: { ...REGISTERED, destination: 'local', localFolder: 'C:\\Data\\AI in One' },
    config: { fabric: { ...emptyConfig().fabric, workspaceId: 'ws-1', workspaceName: 'Contoso PAX', createdWorkspace: true } },
  });
  assert.equal(await runPaxCommand(ctx, 'uninstall', { wait: false }), true);
  assert.deepEqual(fake.asked, ['Uninstall AI in One?', 'Delete workspace "Contoso PAX" and the report and model in it?']);
  assert.deepEqual(calls.deletedWorkspaces, []);
  const text = out();
  assert.ok(text.includes('Left workspace "Contoso PAX" alone.'), text);
  assert.ok(text.includes('Left alone: the files in C:\\Data\\AI in One.'), text);
});

const ADOPTED_MODEL = {
  ...emptyConfig().semanticModel,
  id: 'm1',
  name: 'AI in One',
  desktop: true,
  adopted: true,
  report: { id: 'r1', name: 'AI in One', modelId: 'm1', adopted: true },
};
const ADOPTED_PROMPT = 'Delete the report "AI in One" and the semantic model "AI in One" too? They were published from Power BI Desktop, not made by the installer.';

/** @param {any} t @param {{ answers?: boolean[], yes?: boolean }} o */
function adoptedUninstall(t, o) {
  const s = paxCtx(t, {
    ...o,
    pax: { ...REGISTERED, destination: 'local', localFolder: 'C:\\Data\\AI in One' },
    config: { fabric: { ...emptyConfig().fabric, workspaceId: 'ws-1', workspaceName: 'Contoso PAX' }, semanticModel: { ...ADOPTED_MODEL } },
  });
  /** @type {string[]} */
  const deleted = [];
  /** @type {any} */ (s.ctx.api.fabric).deleteItem = async (/** @type {string} */ ws, /** @type {string} */ id) => {
    deleted.push(`${ws}/${id}`);
  };
  return { ...s, deleted };
}

test('uninstall: items it took on are asked about on their own, and stay under --yes', async (t) => {
  const { ctx, out, fake, deleted, calls } = adoptedUninstall(t, { yes: true });
  assert.equal(await runPaxCommand(ctx, 'uninstall', { wait: false }), true);
  assert.deepEqual(fake.asked, ['Uninstall AI in One?', ADOPTED_PROMPT], 'no "made by the installer" question for them');
  assert.deepEqual(deleted, []);
  assert.deepEqual(calls.deletedWorkspaces, []);
  const text = out();
  assert.ok(text.includes('Left alone: the report "AI in One", the semantic model "AI in One" and the files in C:\\Data\\AI in One.'), text);
});

test('uninstall: saying yes to the items it took on deletes them', async (t) => {
  const { ctx, out, fake, deleted } = adoptedUninstall(t, { answers: [true, true] });
  assert.equal(await runPaxCommand(ctx, 'uninstall', { wait: false }), true);
  assert.deepEqual(fake.asked, ['Uninstall AI in One?', ADOPTED_PROMPT]);
  assert.deepEqual(deleted, ['ws-1/r1', 'ws-1/m1'], 'the report before its model');
  const text = out();
  assert.ok(text.includes('Deleted the report "AI in One"'), text);
  assert.doesNotMatch(text, /Left alone: [^\n]*semantic model/);
});

test('createdItems and adoptedItems: an item is on one list or the other', () => {
  const config = emptyConfig();
  config.semanticModel = { ...ADOPTED_MODEL, report: { id: 'r1', name: 'AI in One', modelId: 'm1' } };
  assert.deepEqual(createdItems(config).map((i) => i.id), ['r1']);
  assert.deepEqual(adoptedItems(config).map((i) => i.id), ['m1']);
});

test('validateFolder: a folder path in the document library', () => {
  for (const v of ['', '  ', '/', '\\']) assert.equal(validateFolder(v), 'Required', JSON.stringify(v));
  for (const ch of ['"', '*', ':', '<', '>', '?', '|', '#', '%', '\\']) {
    assert.equal(validateFolder(`Reports${ch}AI`), 'Leave out these characters: " * : < > ? | # % \\', ch);
  }
  for (const v of ['Reports//AI', 'Reports/./AI', '../AI', 'Reports/..']) assert.equal(validateFolder(v), 'Give each folder in the path a name.', v);
  assert.equal(validateFolder('/Reports/AI in One/'), true);
  assert.equal(validateFolder('AI in One'), true);
  assert.equal(validateFolder('A'.repeat(300)), true, 'no length limit is coded');
});

test('validateLocalFolder: a full path on this PC', () => {
  assert.equal(validateLocalFolder('C:\\Data\\AI in One'), true);
  assert.equal(validateLocalFolder('  d:/Data  '), true, 'it trims first');
  assert.equal(validateLocalFolder('\\\\server\\share\\AI in One'), true);
  for (const v of ['Data\\AI', 'C:', 'C:Data', '\\\\server', '/home/admin/AI']) {
    assert.equal(validateLocalFolder(v), 'Use a full path, such as C:\\Data\\AI in One.', v);
  }
  for (const ch of ['"', '*', '?', '<', '>', '|', ':']) {
    assert.equal(validateLocalFolder(`C:\\Data\\A${ch}B`), 'Leave out these characters: " * ? < > | :', ch);
  }
  assert.equal(validateLocalFolder(`C:\\${'A'.repeat(300)}`), true, 'no length limit is coded');
});

test('filesLabel and paxCollected: the folder and the data, in words', () => {
  assert.equal(filesLabel({ ...emptyPax(), destination: 'local', localFolder: 'C:\\Data' }), 'C:\\Data');
  assert.equal(filesLabel({ ...emptyPax(), destination: 'local' }), defaultLocalFolder());
  assert.equal(filesLabel({ ...emptyPax(), site: SITE }), FOLDER_LABEL);
  assert.equal(filesLabel(emptyPax()), 'A SharePoint folder, not chosen yet');
  assert.deepEqual(paxCollected(emptyPax()), ['Copilot interactions', 'users and their licences']);
  assert.deepEqual(paxCollected({ ...emptyPax(), agent365: true }), ['Copilot interactions', 'users and their licences', 'Agent 365']);
});

test('taskLogon: how the task signs in, in words', () => {
  const p = emptyPax();
  assert.equal(taskLogon(p), 'while you are signed in');
  assert.equal(taskLogon({ ...p, logonType: 'Interactive' }), 'while you are signed in');
  assert.equal(taskLogon({ ...p, logonType: 'Password' }), 'whether or not you are signed in');
  assert.equal(taskLogon({ ...p, logonType: 'S4U' }), 'whether or not you are signed in, without your password');
  assert.equal(taskLogon({ ...p, signedOut: true }), 'whether or not you are signed in, once you give Windows your password in Task Scheduler');
  assert.equal(taskLogon({ ...p, signedOut: true, logonType: 'Password' }), 'whether or not you are signed in');
});

test('showPc: lists what the PC has', () => {
  const { ui, text } = fakeUi();
  showPc(ui, /** @type {any} */ ({ probe: FULL_PROBE }), 'win32');
  const shown = strip(text());
  assert.match(shown, /Checking this PC/);
  assert.ok(shown.includes('✓ PowerShell 7: PowerShell 7.4.6'), shown);
  assert.ok(shown.includes('✓ Python 3.10 or later: Python 3.12.1 (C:\\Python\\python.exe)'), shown);
  assert.ok(shown.includes('✓ A Windows PC or server: Microsoft Windows 11'), shown);
  showPc(fakeUi().ui, /** @type {any} */ ({ probe: FULL_PROBE }), 'linux');
});

test('showPc: stops with what is missing, by platform', () => {
  const missing = /** @type {any} */ ({ error: PWSH_MISSING });
  assert.throws(() => showPc(fakeUi().ui, missing, 'linux'), {
    message: "This PC can't run the scheduled task yet. Missing: A Windows PC or server; PowerShell 7. Fix them, then run the installer again.",
  });
  assert.throws(() => showPc(fakeUi().ui, missing, 'win32'), {
    message: "This PC can't run the scheduled task yet. Missing: PowerShell 7. Fix it, then run the installer again.",
  });
  showPc(fakeUi().ui, /** @type {any} */ ({ probe: { ...FULL_PROBE, python: null, certificates: false } }), 'win32');
});

test('paxPreflight: a Global Administrator who can register apps', async (t) => {
  const { ctx, out } = paxCtx(t, { roles: [GLOBAL_ADMIN] });
  const pre = /** @type {any} */ (await paxPreflight(ctx));
  assert.equal(pre.canConsent, true);
  assert.equal(pre.canCreateApps, true);
  assert.deepEqual(pre.roles, ['Global Administrator']);
  assert.equal(pre.pc.probe.user, 'CONTOSO\\admin');
  const text = out();
  assert.match(text, /Checking your tenant/);
  assert.ok(text.includes(`Signed in as admin@contoso.com (tenant ${TENANT})`), text);
  assert.ok(text.includes('You can grant admin consent (Global Administrator)'), text);
  assert.match(text, /Checking this PC/);
});

test('paxPreflight: no admin role, and users cannot register apps', async (t) => {
  const { ctx, out } = paxCtx(t, { canCreateApps: false });
  const pre = await paxPreflight(ctx);
  assert.equal(pre.canConsent, false);
  assert.equal(pre.canCreateApps, false);
  const text = out();
  assert.ok(
    text.includes("You can't grant admin consent for Microsoft Graph. The installer will give you a link for a Global Administrator or Privileged Role Administrator to approve."),
    text,
  );
  assert.ok(text.includes(`Users in this tenant can't register apps and you have no app admin role. Ask an admin to create "${PAX_APP_NAME}" with you as an owner`), text);
});

test('paxPreflight: stops when PowerShell 7 is missing', async (t) => {
  const { ctx } = paxCtx(t, { pwshMissing: true });
  await assert.rejects(paxPreflight(ctx), { message: /Missing: .*PowerShell 7/ });
});

const ADVANCED = 'Change the advanced settings?';
const WHERE = 'Where should the scheduled task put the files?';

test('paxPlan: the default SharePoint plan', async (t) => {
  const { ctx, config, out, fake } = paxCtx(t, { answers: [false, 'sharepoint', SITE.url] });
  await paxPlan(ctx, PRE);
  assert.equal(fake.asked[0], ADVANCED);
  assert.ok(fake.asked.includes(WHERE));
  assert.ok(fake.asked.some((q) => /^Deploy .*app\?$/.test(q)), fake.asked.join(' | '));
  assert.ok(!fake.asked.includes('Also collect the Agent 365 file?'));
  assert.equal(config.pax.destination, 'sharepoint');
  assert.equal(config.pax.site.url, SITE.url);
  assert.equal(config.pax.site.library, 'Documents');
  assert.equal(config.pax.site.folder, 'AI in One');
  assert.equal(config.pax.agent365, false);
  assert.equal(config.pax.deployApp, true);
  assert.equal(config.pax.runAt, '02:00');
  assert.equal(config.semanticModel.enabled, false);
  assert.ok(out().includes("This copy of the installer has no SharePoint Power BI template, so it won't publish the report."), out());
  assert.equal(config.access?.groupName, 'AI in One Viewers');
  assert.equal(config.app.existing, false);
  assert.equal(config.history.days, 180);
  assert.equal(ctx.runFirstLoad, true);
});

test('paxPlan: the advanced settings', async (t) => {
  const answers = [true, true, 'sharepoint', SITE.url, ' Shared Documents ', ' /Reports/AI in One/ ', false, 'new', 30, '05:30', true, false];
  const { ctx, config, fake } = paxCtx(t, { answers });
  await paxPlan(ctx, PRE);
  assert.ok(fake.asked.includes('Also collect the Agent 365 file?'), fake.asked.join(' | '));
  assert.equal(config.pax.agent365, true);
  assert.equal(config.pax.site.library, 'Shared Documents');
  assert.equal(config.pax.site.folder, 'Reports/AI in One');
  assert.equal(config.pax.deployApp, false);
  assert.equal(config.access, undefined);
  assert.equal(config.history.days, 30);
  assert.equal(config.pax.runAt, '05:30');
  assert.equal(config.pax.signedOut, true);
  assert.equal(ctx.runFirstLoad, false);
});

test('paxPlan: a local folder', async (t) => {
  const { ctx, config, out, fake } = paxCtx(t, { answers: [false, 'local', ' C:\\Data\\AI in One '] });
  await paxPlan(ctx, PRE);
  assert.ok(fake.asked.includes('Folder for the files'), fake.asked.join(' | '));
  assert.equal(config.pax.destination, 'local');
  assert.equal(config.pax.localFolder, 'C:\\Data\\AI in One');
  const text = out();
  assert.ok(text.includes('Nothing is published: you open the report on these files in Power BI Desktop.'), text);
  assert.ok(text.includes('In it, you choose Change data and pick the files from C:\\Data\\AI in One.'), text);
});

test('paxPlan: with the SharePoint template, the report goes to the workspace chosen', async (t) => {
  const workspaces = [
    { id: 'ws-1', displayName: 'Contoso Reports', type: 'Workspace' },
    { id: 'ws-2', displayName: 'My workspace', type: 'Personal' },
  ];
  const { ctx, config, fake } = paxCtx(t, { answers: [false, 'sharepoint', SITE.url, 'ws-1'], workspaces, sources: { paxModelFile: 'x.pbit' } });
  await paxPlan(ctx, PRE);
  assert.ok(fake.asked.includes('Power BI workspace for the report'), fake.asked.join(' | '));
  assert.equal(config.fabric.workspaceId, 'ws-1');
  assert.equal(config.fabric.workspaceName, 'Contoso Reports');
  assert.equal(config.semanticModel.enabled, true);
});

test('paxPlan: under --yes, a new SharePoint setup needs the site in the record', async (t) => {
  const { ctx } = paxCtx(t, { yes: true });
  await assert.rejects(paxPlan(ctx, PRE), {
    message:
      'A new SharePoint setup needs the site. Add "pax": { "site": { "url": "https://<tenant>.sharepoint.com/sites/<site>" } } to the install record, or run without --yes.',
  });
  const withSite = paxCtx(t, { yes: true, pax: { site: { ...SITE } } });
  await paxPlan(withSite.ctx, PRE);
  assert.equal(withSite.config.pax.site.url, SITE.url);
  assert.equal(withSite.config.pax.destination, 'sharepoint');
});

test('paxPlanReview: a SharePoint plan asks for Sites.Selected on one site, never Sites.ReadWrite.All', (t) => {
  const { ctx } = paxCtx(t, { pax: { site: SITE, signedOut: true }, runFirstLoad: true, config: { access: ACCESS } });
  const review = /** @type {any} */ (paxPlanReview(ctx, PRE));
  const json = JSON.stringify(review);
  assert.doesNotMatch(json, /Sites\.ReadWrite\.All/);
  assert.match(review.grants[0].what, /^Microsoft Graph application permissions: .*\bSites\.Selected\b/);
  assert.equal(review.grants[0].detail, undefined);
  const site = review.grants.find((/** @type {any} */ g) => g.what === 'Write (Sites.Selected)');
  assert.equal(site.where, `SharePoint site ${SITE_ADDRESS}, and no other`);
  const task = review.creates.find((/** @type {any} */ c) => c.kind === 'Scheduled task');
  assert.equal(task.name, TASK_NAME);
  assert.equal(task.detail, 'Runs PAX each day at 02:00, loading the last 7 days, then uploads the files.');
  assert.deepEqual(review.runsOn[0], {
    what: 'Scheduled task',
    where: 'This PC, as CONTOSO\\admin, each day at 02:00',
    detail: 'Runs whether or not you are signed in, once you give Windows your password in Task Scheduler.',
  });
  assert.ok(review.runsOn.some((/** @type {any} */ r) => r.what === 'First load'));
  const kinds = review.creates.map((/** @type {any} */ c) => c.kind);
  for (const kind of ['App registration', 'Certificate', 'PAX', 'Scheduled task', 'SharePoint folder', 'Managed app']) assert.ok(kinds.includes(kind), kind);
  assert.ok(!kinds.includes('Python'));
  assert.deepEqual(
    review.costs.map((/** @type {any} */ c) => c.what),
    ['Power Apps Premium or Copilot Credits'],
  );
});

test('paxPlanReview: a local plan without consent, a certificate or Python, and with the report off', (t) => {
  const { ctx } = paxCtx(t, { pax: { destination: 'local', localFolder: 'C:\\Data', deployApp: false, runAt: '05:30' } });
  const pre = /** @type {any} */ ({ canConsent: false, pc: { probe: { ...FULL_PROBE, python: null, certificates: false } } });
  const review = /** @type {any} */ (paxPlanReview(ctx, pre));
  assert.doesNotMatch(JSON.stringify(review), /Sites\.ReadWrite\.All/);
  assert.ok(!review.grants.some((/** @type {any} */ g) => g.what === 'Write (Sites.Selected)'), 'no site grant for a local folder');
  assert.equal(review.grants.length, 1);
  assert.equal(review.grants[0].what, 'Microsoft Graph application permissions: AuditLogsQuery.Read.All, User.Read.All, Organization.Read.All');
  assert.match(review.grants[0].detail, /Global Administrator or Privileged Role Administrator/);
  const kinds = review.creates.map((/** @type {any} */ c) => c.kind);
  assert.ok(kinds.includes('Client secret') && kinds.includes('Folder') && kinds.includes('Python'), kinds.join(', '));
  assert.ok(!kinds.includes('Managed app') && !kinds.includes('Certificate'));
  const task = review.creates.find((/** @type {any} */ c) => c.kind === 'Scheduled task');
  assert.equal(task.detail, 'Runs PAX each day at 05:30, loading the last 7 days, then copies the files to the folder.');
  assert.equal(review.runsOn[0].detail, 'Runs while you are signed in.');
  assert.deepEqual(review.costs, []);
});

test('confirmPaxPlan: shows the plan and asks to go ahead', async (t) => {
  const { ctx, out, fake } = paxCtx(t, { pax: { site: SITE, signedOut: true }, runFirstLoad: true, answers: [false] });
  assert.equal(await confirmPaxPlan(ctx, PRE), false);
  assert.equal(fake.asked.at(-1), 'Go ahead?');
  const text = out();
  assert.match(text, /Ready to set up/);
  assert.ok(text.includes('Data:        Copilot interactions, users and their licences'), text);
  assert.ok(text.includes(`Files:       ${FOLDER_LABEL}`), text);
  assert.ok(text.includes(`Task:        ${TASK_NAME}, daily at 02:00, also while you are signed out (new)`), text);
  assert.ok(text.includes(`Entra app:   ${PAX_APP_NAME} (new)`), text);
  assert.match(text, /App: {9}.*AI in One.* \(new\)/);
  assert.ok(text.includes('First load:  180 days of history, straight after setup'), text);
  const kept = paxCtx(t, { pax: { site: SITE, deployApp: false, taskRegisteredAt: NOW.toISOString() }, config: { app: { ...emptyConfig().app, ...PAX_APP } } });
  assert.equal(await confirmPaxPlan(kept.ctx, PRE), true, 'yes by default');
  const keptText = kept.out();
  assert.match(keptText, /Task: {8}AI in One - PAX refresh, daily at 02:00$/m);
  assert.match(keptText, /Entra app: {3}AI in One \(PAX\)$/m);
  assert.match(keptText, /App: {9}not deployed/);
  assert.doesNotMatch(keptText, /First load/);
});

test('chooseTarget: Fabric by default, PAX when chosen', async () => {
  const fabric = fakeUi();
  assert.equal(await chooseTarget(fabric.ui), 'fabric');
  assert.deepEqual(fabric.asked, ['Where should AI in One get its data?']);
  assert.equal(await chooseTarget(fakeUi({ answers: ['pax'] }).ui), 'pax');
});

test('PAX_NEEDS_WINDOWS: says where the installer has to run', () => {
  assert.equal(PAX_NEEDS_WINDOWS, 'With PAX, Task Scheduler on a Windows PC or server runs PAX each day. Run the installer on that PC.');
});

test('setupCategories: the PAX sections, in words', () => {
  const config = cfg({
    target: 'pax',
    pax: { ...emptyPax(), site: SITE, agent365: true, signedOut: true, runAt: '05:30' },
    access: ACCESS,
    app: { displayName: PAX_APP_NAME },
    setup: { completed: ['data', 'identity'] },
  });
  assert.deepEqual(setupCategories(config), [
    { id: 'data', title: 'Data collection', summary: 'Copilot interactions, users and their licences, Agent 365', complete: true },
    { id: 'placement', title: 'Where the files go', summary: `${FOLDER_LABEL}; the AI in One app`, complete: false },
    { id: 'access', title: 'Viewer access', summary: 'AI in One Viewers', complete: false },
    { id: 'identity', title: 'App registration', summary: PAX_APP_NAME, complete: true },
    { id: 'schedule', title: 'Schedule and loading', summary: 'Daily at 05:30, also while signed out; 180 days', complete: false },
  ]);
  const local = setupCategories(cfg({ target: 'pax', pax: { ...emptyPax(), destination: 'local', localFolder: 'C:\\Data', deployApp: false } }));
  assert.deepEqual(
    local.map((c) => c.summary),
    ['Copilot interactions, users and their licences', 'C:\\Data', 'Choose who can view', `Create ${PAX_APP_NAME}`, 'Daily at 02:00; 180 days'],
  );
  assert.equal(setupCategories(cfg({ target: 'pax' }))[1].summary, 'A SharePoint folder, not chosen yet; the AI in One app', 'no PAX section yet: its defaults');
  assert.equal(setupCategories(cfg({}))[1].title, 'Fabric placement');
});

test('setupRecovery: a PAX placement error points at where the files go; capacity errors are for Fabric', () => {
  const pax = cfg({ target: 'pax', pax: emptyPax() });
  const placement = { section: 'placement', label: 'Change where the files go', code: undefined };
  assert.deepEqual(setupRecovery(new Error('There is no library called Reports in that SharePoint site.'), pax), placement);
  assert.deepEqual(setupRecovery(new Error('You have no workspace called Contoso Reports.'), pax), placement);
  assert.deepEqual(setupRecovery(new Error('Wrapped', { cause: new Error("You can't create Power BI workspaces.") }), pax), placement);
  const none = { section: undefined, label: undefined, code: undefined };
  assert.deepEqual(setupRecovery(new Error('No capacity in this region.'), pax), none);
  assert.deepEqual(setupRecovery(new Error('Graph said no.'), pax), none);
  assert.deepEqual(setupRecovery(new Error('No capacity in this region.'), cfg({})), { section: 'placement', label: 'Change region or capacity', code: undefined });
});

/**
 * A ui for reviewSetup: settings answers from a queue and records what it was shown.
 * @param {any} fake
 * @param {string[]} choices
 */
function settingsUi(fake, choices) {
  /** @type {{ categories: any[], state: any }[]} */
  const shown = [];
  const ui = {
    ...fake.ui,
    /** @param {any[]} categories @param {any} state */
    settings: async (categories, state) => {
      shown.push({ categories, state });
      return choices.shift() ?? 'close';
    },
  };
  return { ui: /** @type {any} */ (ui), shown };
}

test('reviewSetup: a new PAX setup checks the tenant and this PC, and asks for every section first', async (t) => {
  const { ctx, fake, out } = paxCtx(t, { roles: [GLOBAL_ADMIN] });
  const { ui, shown } = settingsUi(fake, ['deploy', 'close']);
  ctx.ui = ui;
  assert.equal(await reviewSetup(ctx), false);
  assert.equal(ctx.ui, ui, 'the real ui is put back');
  assert.equal(shown.length, 2);
  assert.deepEqual(
    shown[0].categories.map((/** @type {any} */ c) => [c.id, c.complete]),
    [['data', false], ['placement', false], ['access', false], ['identity', false], ['schedule', false]],
  );
  const notice = 'Review these categories first: Data collection, Where the files go, Viewer access, App registration, Schedule and loading.';
  assert.equal(shown[1].state.notice, notice);
  const text = out();
  assert.ok(text.includes(`Signed in as admin@contoso.com (tenant ${TENANT})`), text);
  assert.match(text, /Checking this PC/);
  assert.ok(text.includes(notice), text);
  assert.equal(ctx.runFirstLoad, true);
  assert.equal(existsSync(`${ctx.file}.draft.json`), true, 'the choices wait in a draft');
  assert.equal(existsSync(ctx.file), false, 'the install record is not written');
});

test('reviewSetup: a PAX install that is set up opens with every section done', async (t) => {
  const { ctx, fake } = paxCtx(t, { pax: { ...REGISTERED, firstRunStartedAt: '2026-05-01T00:05:00.000Z' } });
  const { ui, shown } = settingsUi(fake, ['close']);
  ctx.ui = ui;
  assert.equal(await reviewSetup(ctx), false);
  assert.ok(shown[0].categories.every((/** @type {any} */ c) => c.complete));
  assert.equal(shown[0].state.notice, 'Existing resources are reused where safe. Editing settings never deletes them.');
  assert.equal(ctx.runFirstLoad, false, 'the first load has run');
});

test('emptyPax, TARGETS and targetOf: the PAX defaults, and Fabric when the record says nothing', () => {
  assert.deepEqual(emptyPax(), { destination: 'sharepoint', windowDays: 7, runAt: '02:00', agent365: false, deployApp: true, credentialType: 'certificate' });
  assert.notEqual(emptyPax(), emptyPax(), 'a new object each time');
  const config = emptyConfig();
  assert.equal(config.target, 'fabric');
  assert.equal(config.pax, undefined);
  assert.equal(config.history.days, 180);
  assert.deepEqual(TARGETS, ['fabric', 'pax']);
  assert.equal(targetOf(cfg({ target: 'pax' })), 'pax');
  assert.equal(targetOf(cfg({ target: undefined })), 'fabric');
});

test('loadConfig and saveConfig: a PAX record keeps its target, its PAX section and fields it does not know', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'aio-install.json');
  const missing = loadConfig(file);
  assert.equal(missing.existed, false);
  assert.equal(missing.config.target, 'fabric');
  writeFileSync(
    file,
    JSON.stringify({ version: 1, target: 'pax', pax: { destination: 'local', localFolder: 'C:\\Data', runAt: '05:30', site: SITE }, laterField: { keep: 1 } }),
    'utf8',
  );
  const { config, existed } = loadConfig(file);
  assert.equal(existed, true);
  assert.equal(targetOf(config), 'pax');
  assert.deepEqual(config.pax, { ...emptyPax(), destination: 'local', localFolder: 'C:\\Data', runAt: '05:30', site: SITE });
  assert.deepEqual(/** @type {any} */ (config).laterField, { keep: 1 });
  /** @type {any} */ (config.pax).taskRegisteredAt = NOW.toISOString();
  saveConfig(file, config);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.target, 'pax');
  assert.equal(raw.pax.taskRegisteredAt, NOW.toISOString());
  assert.equal(raw.pax.windowDays, 7);
  assert.deepEqual(raw.laterField, { keep: 1 });
  const again = loadConfig(file).config;
  assert.equal(again.target, 'pax');
  assert.equal(again.pax?.runAt, '05:30');
  assert.equal(again.pax?.site?.url, SITE.url);
  const fabric = join(dir, 'fabric.json');
  writeFileSync(fabric, JSON.stringify({ version: 1 }), 'utf8');
  const old = loadConfig(fabric).config;
  assert.equal(old.target, 'fabric', 'a record from before --target is a Fabric one');
  assert.equal(old.pax, undefined);
});

test('loadConfig and saveConfig: refuse another target, another version and a secret', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'aio-install.json');
  writeFileSync(file, JSON.stringify({ version: 1, target: 'onprem' }), 'utf8');
  assert.throws(() => loadConfig(file), { message: `${file} is for an install on onprem; this installer sets up AI in One on Fabric or with PAX.` });
  writeFileSync(file, JSON.stringify({ version: 2, target: 'pax' }), 'utf8');
  assert.throws(() => loadConfig(file), { message: `${file} has version 2; this installer reads version 1.` });
  writeFileSync(file, JSON.stringify({ version: 1, target: 'pax', pax: { clientSecret: 'x' } }), 'utf8');
  assert.throws(() => loadConfig(file), { message: 'Refusing to keep a secret in the install record.' });
  const other = join(dir, 'new.json');
  assert.throws(() => saveConfig(other, cfg({ target: 'pax', pax: { ...emptyPax(), password: 'x' } })), { message: 'Refusing to keep a secret in the install record.' });
  assert.equal(existsSync(other), false);
});

test('nextSteps: a PAX install with the app deployed, on SharePoint or a local folder, has nothing left', () => {
  assert.deepEqual(nextSteps(cfg({ target: 'pax', pax: { ...emptyPax(), site: SITE }, managedApp: {} })), []);
  assert.deepEqual(nextSteps(cfg({ target: 'pax', pax: { ...emptyPax(), destination: 'local', localFolder: 'C:\\Data' }, access: ACCESS, managedApp: {} })), []);
});

test('nextSteps: a PAX report on SharePoint waits to be shared with the group', () => {
  const config = cfg({ target: 'pax', pax: { ...emptyPax(), site: SITE }, access: ACCESS, semanticModel: { ...model(true), report: { id: 'report-1' } } });
  const steps = nextSteps(config, { tenantId: TENANT });
  assert.deepEqual(steps.map((s) => s.id), ['share-report']);
  assert.equal(steps[0].title, 'Share the report with AI in One Viewers');
  assert.equal(steps[0].who, 'You');
  config.access = { ...ACCESS, reportShared: true };
  assert.deepEqual(nextSteps(config), []);
});

test('nextSteps: a PAX app that is not ready asks for the settings, or says how to finish it', () => {
  const missing = cfg({ target: 'pax', pax: { ...emptyPax(), site: SITE }, managedApp: { missing: ['createApps', 'licences'] } });
  const [settings, ...rest] = nextSteps(missing, { upn: 'admin@contoso.com' });
  assert.equal(rest.length, 0);
  assert.equal(settings.id, 'app-settings');
  assert.equal(settings.title, 'Ask for managed apps to be turned on');
  assert.equal(settings.who, 'A Power Platform admin');
  const adminSteps = settings.steps ?? [];
  assert.equal(adminSteps.length, 2);
  assert.match(adminSteps[0], /Allow app creation with the Copilot Managed Runtime CLI/);
  assert.match(adminSteps[1], /Power Apps Premium or Copilot Credits/);
  assert.ok(settings.why.includes(commandLine('deploy-app')), settings.why);
  assert.match(String(settings.message), /Could you turn on managed apps for me/);
  const skipped = cfg({
    target: 'pax',
    pax: { ...emptyPax(), destination: 'local', localFolder: 'C:\\Data' },
    managedApp: { skipped: { why: 'This copy of the installer has no build of the app.', steps: ['Build the app, then deploy it.'] } },
  });
  assert.deepEqual(nextSteps(skipped), [
    { id: 'app-skipped', title: 'Finish the AI in One app', why: 'This copy of the installer has no build of the app.', who: 'You', steps: ['Build the app, then deploy it.'] },
  ]);
});

test('nextSteps: no app steps when the app is off, or on Fabric', () => {
  const managedApp = { missing: ['createApps'], skipped: { why: 'Skipped.', steps: [] } };
  assert.deepEqual(nextSteps(cfg({ target: 'pax', pax: { ...emptyPax(), deployApp: false }, managedApp })), []);
  assert.deepEqual(nextSteps(cfg({ target: 'fabric', managedApp })), []);
});

const PAX_TEMPLATE = 'AIO Dashboard - Rollup Edition - PBI-SharePoint - 2026-06-25.pbit';
const ROLLUP_TEMPLATE = 'AIO Dashboard - Rollup Edition - 2026-06-25.pbit';

test('findPaxModelTemplate and findRollupTemplate: the newest of each at the root, nothing else', (t) => {
  const root = tempDir(t);
  assert.equal(findPaxModelTemplate(root), undefined);
  assert.equal(findRollupTemplate(root), undefined);
  assert.equal(findPaxModelTemplate(join(root, 'missing')), undefined);
  for (const name of [
    'AIO Dashboard - Rollup Edition - PBI-SharePoint - 2026-03-01.pbit',
    PAX_TEMPLATE,
    'AIO Dashboard - Rollup Edition - PBI-SharePoint - 2026-07-01.pbix',
    'AIO Dashboard - Rollup Edition - 2026-03-01.pbit',
    ROLLUP_TEMPLATE,
    'PBI-SharePoint notes.txt',
    'AIO Dashboard - Fabric Edition - 2026-09-01.pbit',
  ]) {
    writeFileSync(join(root, name), '');
  }
  const sub = join(root, 'Classic Editions');
  mkdirSync(sub);
  writeFileSync(join(sub, 'AIO Dashboard - Rollup Edition - PBI-SharePoint - 2026-12-31.pbit'), '');
  writeFileSync(join(sub, 'AIO Dashboard - Rollup Edition - 2026-12-31.pbit'), '');
  assert.equal(findPaxModelTemplate(root), PAX_TEMPLATE);
  assert.equal(findRollupTemplate(root), ROLLUP_TEMPLATE, 'not the SharePoint one');
});

test('findPaxModelTemplate and findRollupTemplate: the templates in this checkout', () => {
  const pax = findPaxModelTemplate(DEFAULT_SOURCE_DIR);
  const rollup = findRollupTemplate(DEFAULT_SOURCE_DIR);
  assert.match(String(pax), /PBI-SharePoint.*\.pbit$/);
  assert.match(String(rollup), /Rollup Edition.*\.pbit$/);
  assert.doesNotMatch(String(rollup), /SharePoint/);
});

/**
 * A source folder with only what loadSources reads.
 * @param {import('node:test').TestContext} t
 */
function sourceRoot(t) {
  const root = tempDir(t);
  const files = [join(root, PIPELINE_TEMPLATE), ...NOTEBOOKS.map((nb) => join(root, nb.dir ?? NOTEBOOKS_DIR, nb.file))];
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}', 'utf8');
  }
  return root;
}

test('loadSources: the PAX templates when they are there, and the app only once it is built', (t) => {
  const root = sourceRoot(t);
  const bare = loadSources(root);
  assert.ok(!('paxModelFile' in bare) && !('rollupModelFile' in bare) && !('appDist' in bare), Object.keys(bare).join(', '));
  writeFileSync(join(root, PAX_TEMPLATE), '');
  writeFileSync(join(root, ROLLUP_TEMPLATE), '');
  mkdirSync(join(root, 'app', 'dist'), { recursive: true });
  const notBuilt = loadSources(root);
  assert.equal(notBuilt.paxModelFile, join(root, PAX_TEMPLATE));
  assert.equal(notBuilt.rollupModelFile, join(root, ROLLUP_TEMPLATE));
  assert.equal(notBuilt.appDist, undefined, 'an empty app/dist is not a build');
  writeFileSync(join(root, 'app', 'dist', 'index.html'), '<!doctype html>', 'utf8');
  assert.equal(loadSources(root).appDist, join(root, APP_DIST));
});

test('loadSources: names what is missing', (t) => {
  const root = tempDir(t);
  const pipeline = join(root, PIPELINE_TEMPLATE);
  assert.throws(() => loadSources(root), { message: `No pipeline template at ${pipeline}. Point --source at the root of the AI-in-One-Dashboard repo.` });
  mkdirSync(dirname(pipeline), { recursive: true });
  writeFileSync(pipeline, '{}', 'utf8');
  const nb = NOTEBOOKS[0];
  assert.throws(() => loadSources(root), { message: `Missing notebook ${join(root, nb.dir ?? NOTEBOOKS_DIR, nb.file)}.` });
});
