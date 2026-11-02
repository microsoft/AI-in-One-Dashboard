// @ts-check
import assert from 'node:assert/strict';
import fs, { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { collectedLabels } from '../src/catalog.js';
import { archiveConfig, emptyConfig, loadConfig, removeFile, saveConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { restoreSetupDraft, reviewSetup, SETUP_SECTIONS, setupCategories, setupRecovery } from '../src/setup.js';
import { parseForm } from '../src/ui.js';
import { createWebUi } from '../src/web-ui.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi } from './fakes.js';

/** fakes.js makes one folder for install records per run; each test's record goes in it under its own name. */
const RECORD_DIR = dirname(fakeCtx().ctx.file);
let records = 0;

/**
 * A deployed install, with every settings category reviewed, saved as a real install record.
 * @param {import('node:test').TestContext} t
 */
function fixture(t) {
  const arm = fakeArm();
  const fabric = fakeFabric();
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  const ui = createWebUi();
  const config = emptyConfig();
  config.tenantId = 'tenant-1';
  config.fabric.capacityId = 'cap-f';
  config.fabric.workspaceName = 'AI in One';
  config.setup = { completed: setupCategories(config).map((cat) => cat.id), runFirstLoad: false };
  const { ctx } = fakeCtx({ config, ui, arm: arm.api, fabric: fabric.api, graph: { ...graph.api, usersCanRegisterApps: async () => true }, powerBi: powerBi.api });
  ctx.file = join(RECORD_DIR, `setup-${++records}.json`);
  const prefix = `${basename(ctx.file, '.json')}.`;
  t.after(() => {
    for (const name of readdirSync(RECORD_DIR)) if (name.startsWith(prefix)) rmSync(join(RECORD_DIR, name), { force: true });
  });
  ctx.save = () => saveConfig(ctx.file, config);
  ctx.save();
  return { ctx, config, ui, arm, fabric, graph, powerBi, draft: `${ctx.file}.draft.json` };
}

/**
 * Answer on the next tick so createWebUi has finished registering the open question.
 * @param {ReturnType<typeof createWebUi>} ui
 * @param {(event: import('../src/web-ui.js').UiEvent) => unknown} reply
 */
function respond(ui, reply) {
  /** @type {string[]} */
  const asked = [];
  ui.subscribe((e) => {
    if (e.type !== 'prompt') return;
    asked.push(e.message);
    setImmediate(() => {
      const value = reply(e);
      const result = ui.answer(e.id, value);
      assert.equal(result.ok, true, `${e.message}: ${result.error}`);
    });
  });
  return asked;
}

/** @param {import('../src/web-ui.js').UiEvent} e */
const closeOnly = (e) => {
  if (e.kind === 'settings') return 'close';
  throw new Error(`Unexpected question: ${e.message}`);
};

/**
 * A new session (fresh ctx) on the same install record, as the next repair would start.
 * @param {ReturnType<typeof fixture>} f
 * @param {(event: import('../src/web-ui.js').UiEvent) => unknown} [reply]
 */
function reopen(f, reply = closeOnly) {
  const config = loadConfig(f.ctx.file).config;
  const ui = createWebUi();
  const { ctx } = fakeCtx({ config, ui, arm: f.arm.api, fabric: f.fabric.api, graph: f.ctx.api.graph, powerBi: f.powerBi.api });
  ctx.file = f.ctx.file;
  ctx.save = () => saveConfig(ctx.file, config);
  respond(ui, reply);
  return { ctx, config, ui };
}

test('settings forms validate types, options, disabled choices and each field on the server', () => {
  const fields = [
    { id: 'region', label: 'Region', default: 'a', choices: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b', disabled: true }] },
    { id: 'name', label: 'Name', default: '', validate: (/** @type {string} */ v) => v.trim() ? /** @type {const} */ (true) : 'Required' },
  ];
  assert.match(parseForm([], fields).error ?? '', /Fill in/);
  assert.match(parseForm({ region: 'b', name: 'ok' }, fields).error ?? '', /Region/);
  assert.match(parseForm({ region: 'a', name: '' }, fields).error ?? '', /Required/);
  assert.match(parseForm({ region: 1, name: 'ok' }, fields).error ?? '', /Region/);
  assert.deepEqual(parseForm({ region: 'a', name: 'ok', extra: 'ignored' }, fields).value, { region: 'a', name: 'ok' });
  assert.match(parseForm({ region: 'changed' }, [{ id: 'region', label: 'Region', default: 'original', readOnly: 'Already deployed' }]).error ?? '', /Already deployed/);
});

test('web settings and forms expose no validators, reject invalid values and support category cancellation', async () => {
  const ui = createWebUi();
  const settings = ui.settings([{ id: 'placement', title: 'Fabric placement', summary: 'AI in One; capacity: cap-f', complete: true }], { changes: [] });
  let event = ui.history().at(-1);
  assert.equal(ui.answer(event?.id, 'arbitrary').ok, false);
  ui.answer(event?.id, 'placement');
  assert.equal(await settings, 'placement');
  ui.beginSection();
  const form = ui.form('Schedule', [{ id: 'time', label: 'Time', default: '02:00', validate: (v) => v ? true : 'Required' }]);
  event = ui.history().at(-1);
  assert.equal(event?.settingsBack, true);
  assert.equal('validate' in event?.fields[0], false);
  assert.equal(ui.answer(event?.id, { time: '' }).ok, false);
  assert.equal(ui.cancelSection(), true);
  await assert.rejects(form, { name: 'SettingsCancelled' });
  ui.endSection();
  assert.equal(ui.cancelSection(), false);
});

test('failure recovery sends region, capacity and quota failures to Fabric placement, and nothing else anywhere', () => {
  const config = emptyConfig();
  const error = new HttpError('Locked', { method: 'POST', url: 'https://api.fabric.microsoft.com', status: 409,
    body: { error: { code: 'RegionDoesNotAllowProvisioning', message: 'Locked' } } });
  const region = setupRecovery(new Error('Creating the workspace failed', { cause: error }), config);
  assert.equal(region.section, 'placement');
  assert.equal(region.label, 'Change region or capacity');
  assert.match(region.code ?? '', /RegionDoesNotAllowProvisioning/);
  assert.equal(setupRecovery(new Error('The capacity is paused'), config).section, 'placement');
  assert.equal(setupRecovery(new Error('InsufficientQuota'), config).section, 'placement');
  assert.deepEqual(setupRecovery(new Error('RequestDisallowedByPolicy'), config), { section: undefined, label: undefined, code: undefined });
  assert.equal(setupRecovery(new Error('Unknown failure'), config).section, undefined);
});

test('a saved draft resumes without overwriting the deployed record; cancel restores the whole category', async (t) => {
  const f = fixture(t);
  const { ctx, config, ui, draft } = f;
  const original = readFileSync(ctx.file, 'utf8');
  let visits = 0;
  respond(ui, (e) => {
    if (e.kind === 'settings') return visits++ ? 'close' : 'schedule';
    if (e.kind === 'select') return e.default;
    if (e.kind === 'form') return { frequency: 'weekly', weekday: 'Monday', time: '05:00' };
    if (e.kind === 'confirm') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), false);
  assert.equal(config.schedule.frequency, 'weekly');
  assert.equal(readFileSync(ctx.file, 'utf8'), original, 'the install record is untouched');
  assert.equal(loadConfig(draft).config.schedule.time, '05:00');

  let restored = false;
  const resumed = reopen(f, (e) => {
    if (e.kind === 'settings') {
      if (restored) return 'close';
      restored = true;
      assert.match(e.categories.find((/** @type {any} */ c) => c.id === 'schedule').summary, /^weekly, 05:00 UTC; 180 days$/);
      return 'schedule';
    }
    if (e.kind === 'select') return 0;
    if (e.kind === 'form') return null;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(resumed.config.schedule.frequency, 'daily', 'the record still has the deployed schedule');
  assert.equal(await reviewSetup(resumed.ctx), false);
  assert.equal(resumed.config.schedule.frequency, 'weekly', 'the draft came back');
  assert.equal(resumed.config.schedule.time, '05:00');
  assert.equal(resumed.config.history.days, 180, 'the history answer given before the cancel is undone too');
  assert.ok(existsSync(draft));
  assert.equal(readFileSync(ctx.file, 'utf8'), original);
});

test('a validation failure keeps the overview open and checks the capacity again for the next retry', async (t) => {
  const { ctx, ui, fabric } = fixture(t);
  ctx.setupRetry = true;
  const list = fabric.api.listCapacities;
  let lists = 0;
  let paused = true;
  fabric.api.listCapacities = async () => {
    lists++;
    const other = { id: 'cap-2', displayName: 'Other', sku: 'F8', region: 'West US 3', state: 'Active' };
    return [...(await list()).map((cap) => (paused && cap.id === 'cap-f' ? { ...cap, state: 'Paused' } : cap)), other];
  };
  let visits = 0;
  respond(ui, (e) => {
    if (e.kind === 'settings') {
      assert.match(e.notice, /the selected capacity is no longer active or accessible/);
      visits++;
      paused = false;
      return 'deploy';
    }
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unrelated question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), true);
  assert.equal(visits, 1);
  assert.ok(lists >= 2, 'the capacities are listed again, not taken from the first try');
});

test('fresh setup refuses deployment until required categories have been reviewed', async (t) => {
  const { ctx, config, ui } = fixture(t);
  delete config.fabric.lakehouseId;
  delete config.setup;
  ctx.setupRetry = true;
  respond(ui, (e) => {
    assert.equal(e.kind, 'settings');
    assert.match(e.notice, /Review these categories first: Data collection, Fabric placement, Viewer access, Identity and secrets, Schedule and loading\./);
    return 'close';
  });
  assert.equal(await reviewSetup(ctx), false);
});

test('newer deployment IDs are never overwritten by an older draft; conflict resolution archives it', async (t) => {
  const { ctx, config, ui, draft } = fixture(t);
  respond(ui, () => 'close');
  await reviewSetup(ctx);
  config.fabric.workspaceId = 'new-workspace-from-terminal';
  config.fabric.lakehouseId = 'new-lakehouse-from-terminal';
  ctx.save();
  assert.equal(restoreSetupDraft(ctx), false);
  assert.equal(config.fabric.workspaceId, 'new-workspace-from-terminal');
  const conflictUi = createWebUi();
  ctx.ui = conflictUi;
  respond(conflictUi, (e) => {
    if (e.kind === 'select') {
      assert.match(e.message, /install record changed/);
      return 0;
    }
    return 'close';
  });
  await reviewSetup(ctx);
  assert.equal(config.fabric.lakehouseId, 'new-lakehouse-from-terminal');
  assert.ok(existsSync(draft), 'a new draft uses the latest deployment state');
  assert.equal(loadConfig(draft).config.fabric.workspaceId, 'new-workspace-from-terminal');
  const archived = readdirSync(RECORD_DIR).filter((name) => name.startsWith(`${basename(draft, '.json')}.`) && /\.\d{8}-\d{6}\.json$/.test(name));
  assert.equal(archived.length, 1, 'the older draft is kept beside it');
});

const locked = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

test('draft delete and archive retry while a synced folder holds the file, and give up without throwing', () => {
  const file = join(RECORD_DIR, 'locked.json.draft.json');
  let tries = 0;
  /** @type {number[]} */
  const waits = [];
  const wait = (/** @type {number} */ ms) => { waits.push(ms); };
  assert.equal(removeFile(file, { unlink: () => { if (++tries < 3) throw locked(); }, wait }), true);
  assert.equal(tries, 3);
  assert.equal(removeFile(file, { unlink: () => { throw locked(); }, wait, tries: 4 }), false);
  assert.equal(removeFile(file), true, 'a file that is already gone is removed');
  assert.throws(() => removeFile(file, { unlink: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }), /EIO/);
  tries = 0;
  /** @type {string[]} */
  const moved = [];
  const to = archiveConfig(file, new Date(2026, 0, 2, 3, 4, 5), { rename: (_from, dest) => { if (++tries < 2) throw locked(); moved.push(dest); }, wait });
  assert.deepEqual(moved, [to]);
  assert.match(to, /locked\.json\.draft\.20260102-030405\.json$/);
});

test('a locked draft after approval does not block the next deployment with a false record conflict', async (t) => {
  const { ctx, ui, draft } = fixture(t);
  ctx.setupRetry = true;
  const realUnlink = fs.unlinkSync;
  const lockDraft = t.mock.method(fs, 'unlinkSync', (/** @type {fs.PathLike} */ path) => {
    if (String(path) === draft) throw locked();
    return realUnlink(path);
  });
  syncBuiltinESMExports();
  t.after(() => { lockDraft.mock.restore(); syncBuiltinESMExports(); });
  respond(ui, (e) => {
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), true);
  assert.equal(existsSync(draft), true, 'the locked draft stays behind');
  assert.equal(loadConfig(draft).config.setup?.approved, true);
  lockDraft.mock.restore();
  syncBuiltinESMExports();

  const nextUi = createWebUi();
  ctx.ui = nextUi;
  ctx.setupRetry = true;
  respond(nextUi, (e) => {
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), true, 'no "install record changed" loop and no conflict prompt');
  assert.equal(existsSync(draft), false);
});

test('an approved deployment keeps its first-load and reload choices out of the install record', async (t) => {
  const f = fixture(t);
  f.ctx.setupRetry = true;
  f.ctx.reloadHistoryDays = 90;
  respond(f.ui, (e) => {
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(f.ctx), true);
  assert.equal(f.ctx.reloadHistoryDays, 90, 'this deployment still runs the reload');
  const saved = loadConfig(f.ctx.file).config.setup;
  assert.ok(saved);
  assert.equal('runFirstLoad' in saved, false);
  assert.equal('reloadHistoryDays' in saved, false);

  const next = reopen(f);
  assert.equal(await reviewSetup(next.ctx), false);
  assert.equal(next.ctx.reloadHistoryDays, undefined, 'a later repair does not repeat the reload');
});

test('a new session ignores first-load and reload choices an install record saved earlier', async (t) => {
  const f = fixture(t);
  f.config.firstRun = { jobId: 'job-1', status: 'Completed' };
  f.config.setup = { completed: setupCategories(f.config).map((cat) => cat.id), runFirstLoad: true, reloadHistoryDays: 90 };
  f.ctx.save();
  const done = reopen(f);
  await reviewSetup(done.ctx);
  assert.equal(done.ctx.runFirstLoad, false, 'the first load already completed');
  assert.equal(done.ctx.reloadHistoryDays, undefined);
  assert.equal(loadConfig(`${f.ctx.file}.draft.json`).config.setup?.reloadHistoryDays, undefined);

  rmSync(`${f.ctx.file}.draft.json`);
  f.config.firstRun = { jobId: 'job-1', status: 'Incomplete' };
  delete f.config.setup;
  f.ctx.save();
  const incomplete = reopen(f);
  await reviewSetup(incomplete.ctx);
  assert.equal(incomplete.ctx.runFirstLoad, true, 'a record from before browser setup still finishes its first load');
});

test('setupCategories: the five Fabric categories in planning order, and where the secret lives', () => {
  const config = emptyConfig();
  const summary = (/** @type {string} */ id) => setupCategories(config).find((cat) => cat.id === id)?.summary;
  assert.deepEqual(setupCategories(config).map((cat) => cat.id), SETUP_SECTIONS);
  assert.deepEqual(SETUP_SECTIONS, ['data', 'placement', 'access', 'identity', 'schedule']);
  assert.ok(setupCategories(config).every((cat) => !cat.complete), 'nothing is reviewed in a new install');
  assert.equal(summary('data'), collectedLabels(config.modules).join(', '));
  assert.match(String(summary('data')), /Org data/, 'org data is always collected');
  assert.equal(summary('placement'), 'Choose workspace; capacity: not set');
  assert.equal(summary('access'), 'Choose who can view');
  assert.equal(summary('identity'), 'App registration; Key Vault');
  assert.equal(summary('schedule'), 'daily, 02:00 UTC; 180 days');

  config.keyVault.mode = 'notebook';
  assert.equal(summary('identity'), 'App registration; secret in notebooks', 'no Key Vault by default');
  config.setup = { completed: ['data'] };
  assert.deepEqual(setupCategories(config).filter((cat) => cat.complete).map((cat) => cat.id), ['data']);
});
