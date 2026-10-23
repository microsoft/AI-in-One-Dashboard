// @ts-check
/**
 * The install's verdict. A step that fails (✗) and lets the install carry on leaves it partly set up; one that only
 * warns, or recovers when it's tried again, doesn't.
 */
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig } from '../src/config.js';
import { createCtx, install, update } from '../src/install.js';
import { AUDIT_ACTIVITY, LICENSED_ACTIVITY } from '../src/transform/pipeline.js';
import { fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, realSources } from './fakes.js';

const forbidden = async () => {
  throw new Error('Forbidden');
};

/** A notebook run Fabric turned away because the capacity was busy. */
const busy = { status: 'Failed', failureReason: { errorCode: 'TooManyRequestsForCapacity', message: 'The capacity is too busy.' } };

/** @param {string} message A notebook run that failed. */
const failed = (message) => ({ status: 'Failed', failureReason: { errorCode: 'NotebookFailed', message } });

/** A load the source turned away. */
const refused = { status: 'Failed', error: { errorCode: '403', message: 'Forbidden' } };
/** A load Fabric didn't start because the capacity was busy. */
const turnedAway = { status: 'Failed', error: { errorCode: 'TooManyRequestsForCapacity', message: 'The capacity is too busy.' } };

/** fakes.js makes one folder for install records per run; each install here keeps its record in it under its own name. */
const RECORD_DIR = dirname(fakeCtx().ctx.file);
let records = 0;

/**
 * @typedef {object} Run
 * @property {boolean} [report]  Publishing the report fails.
 * @property {object[]} [check]  The data check's runs end like these, then Completed.
 * @property {Record<string, { status: string, error?: object }[]>} [loads]  Loads that don't simply succeed: each one's
 *   attempts in the pipeline run, in order. The run itself completes.
 * @property {number} [reload]  Reload this many days of audit history instead of the first load.
 */

/**
 * A new Fabric install, run to the end through the real install record, waiting on the first load or the reload.
 * @param {import('node:test').TestContext} t
 * @param {Run} [o]
 */
async function runInstall(t, o = {}) {
  const file = join(RECORD_DIR, `verdict-${++records}.json`);
  const prefix = `${basename(file, '.json')}.`;
  t.after(() => {
    for (const name of readdirSync(RECORD_DIR)) if (name.startsWith(prefix)) rmSync(join(RECORD_DIR, name), { force: true });
  });
  const config = loadConfig(file).config;
  config.tenantId = 'tenant-1';
  Object.assign(config.fabric, { workspaceId: 'ws-1', workspaceName: 'AI in One', lakehouseId: 'lh-1', lakehouseName: 'CopilotAnalytics' });
  Object.assign(config.app, { appId: 'app-1', objectId: 'obj-1', servicePrincipalId: 'sp-1' });
  config.keyVault.mode = 'notebook';
  config.semanticModel.enabled = true;
  // A reload is a repair or change, once the first load has completed, offered only for more history than is loaded.
  if (o.reload) {
    config.firstRun = { jobId: 'job-0', status: 'Completed' };
    config.history.days = 30;
  }
  saveConfig(file, config);

  const fabric = fakeFabric();
  fabric.api.listCapacities = async () => [{ id: 'cap-f', displayName: 'AI in One', sku: 'F64', region: 'West US 3', state: 'Active' }];
  if (o.report) fabric.failures.createReport = [new Error('Report publish failed')];
  const checkRuns = [...(o.check ?? [])];
  const completed = { status: 'Completed', startTimeUtc: '2026-06-01T12:01:00Z', endTimeUtc: '2026-06-01T14:00:00Z' };
  // The fake's getJob takes no URL; this one tells the data check apart by it.
  fabric.api.getJob = /** @type {any} */ (
    async (/** @type {string} */ url) => {
      const item = url.split('/items/')[1]?.split('/')[0];
      if (item && item === config.fabric.notebooks.dataCheck) return { ...completed, ...checkRuns.shift() };
      return { id: 'job-1', ...completed };
    }
  );
  const loads = Object.entries(o.loads ?? {});
  const failing = new Set(loads.filter(([, attempts]) => attempts.at(-1)?.status !== 'Succeeded').map(([name]) => name));
  fabric.api.queryActivityRuns = async () => [
    ...(fabric.items.find((i) => i.type === 'DataPipeline')?.content.properties.activities ?? []).map((/** @type {any} */ a) => ({
      activityName: a.name,
      // An If fails with the load in it.
      status: [...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])].some((/** @type {{ name: string }} */ i) => failing.has(i.name))
        ? 'Failed'
        : 'Succeeded',
      activityRunStart: '2026-06-01T12:01:00Z',
    })).filter((/** @type {{ activityName: string }} */ r) => !loads.some(([name]) => name === r.activityName)),
    ...loads.flatMap(([activityName, attempts]) => attempts.map((a, i) => ({ activityName, activityRunStart: `2026-06-01T12:0${i + 2}:00Z`, ...a }))),
  ];
  const graph = fakeAzureGraph();
  graph.applications.push({ id: 'obj-1', appId: 'app-1', displayName: 'AI in One (Fabric)' });
  const powerBi = fakePowerBi();
  const ui = fakeUi();
  if (o.reload) {
    const select = ui.ui.select;
    ui.ui.select = /** @type {any} */ (
      async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) =>
        message.startsWith('Load more audit history?') ? o.reload : select(message, choices, def)
    );
  }
  let sleeps = 0;
  const ctx = createCtx({
    ui: ui.ui,
    config,
    file,
    api: /** @type {any} */ ({
      fabric: { ...fabric.api, tenantSettings: forbidden },
      graph: {
        ...graph.api,
        subscribedSkus: forbidden,
        myDirectoryRoles: async () => [],
        usersCanRegisterApps: async () => true,
        ensureRequiredAccess: async () => false,
        findGroupByName: async (/** @type {string} */ name) => ({ id: 'group-1', displayName: name }),
        getGroup: async (/** @type {string} */ id) => ({ id, displayName: 'AI in One Viewers' }),
        appRoleAssignments: async () => (await graph.api.graphServicePrincipal()).appRoles.map((r) => ({ resourceId: 'graph-sp', appRoleId: r.id })),
      },
      powerBi: { ...powerBi.api, datasetUsers: async () => [], addDatasetUser: async () => null },
      arm: { listSubscriptions: async () => [] },
      keyVault: {},
      oneLake: {
        readJson: async () => null,
        readText: async () => null,
        createDirectory: async () => {},
        writeFile: async () => {},
      },
    }),
    user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
    sources: realSources(),
    sleep: async () => {
      if (++sleeps > 300) throw new Error('The install is stuck waiting.');
    },
    now: () => new Date('2026-06-01T12:00:00Z'),
  });
  if (!o.reload) ctx.runFirstLoad = true;
  const ok = await install(ctx, { wait: true });
  const text = ui.text();
  if (o.reload) {
    assert.match(text, /Reload audit history/);
    assert.equal(config.history.days, o.reload);
  } else if (!o.loads?.[AUDIT_ACTIVITY]) assert.equal(config.firstRun?.status, 'Completed', 'the history loaded, whatever else failed');
  return { ok, text, ctx, ui, fabric, config };
}

/** @param {{ ok: boolean, text: string }} run */
function setUp({ ok, text }) {
  assert.equal(ok, true, text);
  assert.match(text, /AI in One is set up/);
  assert.doesNotMatch(text, /partly set up/);
}

/** @param {{ ok: boolean, text: string }} run */
function partlySetUp({ ok, text }) {
  assert.equal(ok, false);
  assert.match(text, /AI in One is partly set up/);
  assert.match(text, /A step above didn't finish\. Fix what it says, then run the installer again/);
  assert.doesNotMatch(text, /AI in One is set up/);
}

test('install: a first load where every step and load succeeds is set up', async (t) => {
  const run = await runInstall(t);
  setUp(run);
  assert.doesNotMatch(run.text, /✗/);
});

test('install: a report that fails to publish leaves it partly set up', async (t) => {
  const run = await runInstall(t, { report: true });
  assert.match(run.text, /✗ The AI in One report wasn't published: Report publish failed/);
  partlySetUp(run);
});

test('install: a data check that fails leaves it partly set up; one that only warns, or waits out a busy capacity, does not', async (t) => {
  const run = await runInstall(t, { check: [failed('Table not found.')] });
  assert.match(run.text, /✗ Data check failed/);
  assert.match(run.text, /Run ".*check" to try it again\./);
  partlySetUp(run);

  const warned = await runInstall(t, { check: [{ status: 'Cancelled' }] });
  assert.match(warned.text, /! Data check ended with status Cancelled/);
  assert.doesNotMatch(warned.text, /✗/);
  setUp(warned);

  const retried = await runInstall(t, { check: [busy] });
  assert.match(retried.text, /Data check: Fabric's capacity is still busy\. Trying again in 5 minutes\./);
  assert.match(retried.text, /✓ Data check finished/);
  assert.doesNotMatch(retried.text, /✗/);
  setUp(retried);
});

test('install: a load other than the audit log that fails in a run that completes leaves it partly set up, on the first load and on a reload', async (t) => {
  for (const reload of [undefined, 90]) {
    const run = await runInstall(t, { loads: { [LICENSED_ACTIVITY]: [refused] }, reload });
    assert.match(run.text, /✗ Licensed users: failed/);
    assert.match(run.text, /then run ".*rerun-failed"\./);
    partlySetUp(run);
  }
});

test('install: an audit log load that fails leaves the first load to do again, and the install partly set up', async (t) => {
  const run = await runInstall(t, { loads: { [AUDIT_ACTIVITY]: [refused] } });
  assert.match(run.text, /✗ Copilot audit log: failed/);
  assert.equal(run.config.firstRun?.status, 'Incomplete', 'the next run offers the first load again');
  partlySetUp(run);
});
test("install: a load that failed on a busy capacity counts; one that loads when it's tried again doesn't", async (t) => {
  const run = await runInstall(t, { loads: { [LICENSED_ACTIVITY]: [turnedAway] } });
  assert.match(run.text, /✗ Licensed users: failed/);
  assert.match(run.text, /Fabric's capacity was too busy to start it\./);
  partlySetUp(run);

  for (const reload of [undefined, 90]) {
    const retried = await runInstall(t, { loads: { [LICENSED_ACTIVITY]: [refused, { status: 'Succeeded' }] }, reload });
    assert.match(retried.text, /✓ Licensed users \(2 attempts\)/);
    assert.doesNotMatch(retried.text, /✗ Licensed users/);
    setUp(retried);
  }
});

test('update: a step that fails leaves it not finished, never "Up to date"', async (t) => {
  const run = await runInstall(t);
  setUp(run);
  let from = run.ui.text().length;
  const since = () => run.ui.text().slice(from);
  assert.equal(await update(run.ctx, { wait: true }), true);
  assert.match(since(), /Up to date/);

  from = run.ui.text().length;
  /** @type {import('../src/config.js').ReportConfig} */ (run.config.semanticModel.report).signature = 'from an older version';
  // The fake's updateReport has no scripted failures; ctx has its own copy of the fake's methods.
  /** @type {any} */ (run.ctx.api.fabric).updateReport = async () => {
    throw new Error('Report update failed');
  };
  assert.equal(await update(run.ctx, { wait: true }), false);
  assert.match(since(), /✗ The AI in One report wasn't published: Report update failed/);
  assert.match(since(), /✗ The update isn't finished: a step above failed\. Fix what it says, then run ".*update" again\./);
  assert.doesNotMatch(since(), /Up to date|Updated\./);
});
