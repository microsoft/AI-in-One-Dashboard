// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCli } from '../src/cli.js';
import { fabricApi } from '../src/clients/fabric.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { createClient, HttpError } from '../src/http.js';
import { powerBiApi } from '../src/clients/powerbi.js';
import { finishUpdate, loadState, runCommand } from '../src/install.js';
import { confirmReloaded, deployModel, MODEL_UPDATE_NOTE, needsDataReset, pendingReloads, refreshModel, settleReloads } from '../src/steps/model.js';
import { planReview } from '../src/steps/plan.js';
import { createWebUi } from '../src/web-ui.js';
import { fakeCtx, fakeFabric, fakeGraph, fakePowerBi, fakeUi, httpError } from './fakes.js';

/** Fabric turning down an update it can only make by clearing the model's data, as a call error and as a failed operation. */
const RESETS = {
  http: () => new HttpError('The request requires options', { status: 400, method: 'POST', url: 'https://x', code: 'RequiredOptionsMissing' }),
  operation: () => new Error('Fabric operation failed (RequiredOptionsMissing): Dataset schema change requires allowPurgeData'),
};

/** A deployed, bound model whose definition is about to change. @param {{ answers?: any[], yes?: boolean }} [o] */
function deployed(o = {}) {
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  const ui = fakeUi({ answers: o.answers, yes: o.yes });
  const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, powerBi: powerBi.api, ui: ui.ui });
  const sm = t.config.semanticModel;
  sm.enabled = true;
  const item = fabric.add('SemanticModel', 'AI in One', 'v1');
  Object.assign(sm, { id: item.id, name: item.displayName, signature: 'old', bound: true });
  const deploy = () => deployModel(t.ctx, sm, { signature: 'new', definition: () => 'v2' });
  return { ...t, fabric, powerBi, ui, sm, item, deploy };
}

test('a model update keeps its data by default: no purge option unless Fabric asks for one', async () => {
  const t = deployed({ yes: true });
  await t.deploy();
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), ['updateSemanticModel AI in One']);
  assert.equal(t.item.content, 'v2');
  assert.deepEqual(t.sm.reload, { since: '2026-06-01T12:00:00.000Z' }, 'owed a reload, data kept');
  assert.deepEqual(t.ui.asked, []);
});

for (const [kind, reset] of Object.entries(RESETS)) {
  test(`${kind}: --yes alone never clears a model's data; the model is left as it was and the run stops`, async () => {
    const t = deployed({ yes: true });
    t.fabric.failures.updateSemanticModel = [reset()];
    assert.ok(needsDataReset(reset()));
    await assert.rejects(t.deploy(), /AI in One wasn't changed.*--allow-model-reset/s);
    assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), ['updateSemanticModel AI in One'], 'never retried with purge');
    assert.equal(t.item.content, 'v1');
    assert.equal(t.sm.signature, 'old', 'the next run tries again');
    assert.equal(t.sm.bound, true);
    assert.equal(t.sm.reload, undefined, 'Fabric changed nothing, so nothing is owed');
    assert.match(t.ui.text(), /can't apply this version of AI in One and keep its data.*show no data/s);
    assert.deepEqual(t.ui.asked, []);
  });

  test(`${kind}: declining the reset leaves the model as it was`, async () => {
    const t = deployed({ answers: [false] });
    t.fabric.failures.updateSemanticModel = [reset()];
    await assert.rejects(t.deploy(), /wasn't changed/);
    assert.equal(t.ui.asked.length, 1);
    assert.match(t.ui.asked[0], /Clear AI in One's data and reload it now\?/);
    assert.equal(t.fabric.calls.filter((c) => c.includes('allowPurgeData')).length, 0);
    assert.equal(t.item.content, 'v1');
    assert.equal(t.sm.signature, 'old');
  });

  test(`${kind}: agreeing to the reset, asked or by --allow-model-reset, clears and records the model for a reload`, async () => {
    const asked = deployed({ answers: [true] });
    asked.fabric.failures.updateSemanticModel = [reset()];
    await asked.deploy();
    assert.deepEqual(asked.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), ['updateSemanticModel AI in One', 'updateSemanticModel AI in One allowPurgeData']);
    assert.equal(asked.item.content, 'v2');
    assert.equal(asked.sm.bound, false);
    assert.deepEqual(asked.sm.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true });

    const flag = deployed({ yes: true });
    flag.ctx.allowModelReset = true;
    flag.fabric.failures.updateSemanticModel = [reset()];
    await flag.deploy();
    assert.deepEqual(flag.ui.asked, []);
    assert.ok(flag.fabric.calls.includes('updateSemanticModel AI in One allowPurgeData'));
    assert.match(flag.ui.text(), /--allow-model-reset allows/);
    assert.equal(flag.sm.reload?.cleared, true);
  });
}

test('any other update error is passed on without asking or purging', async () => {
  const t = deployed({ answers: [true] });
  t.fabric.failures.updateSemanticModel = [httpError(500, 'Internal')];
  await assert.rejects(t.deploy(), /Internal/);
  assert.deepEqual(t.ui.asked, []);
  assert.equal(t.fabric.calls.filter((c) => c.includes('allowPurgeData')).length, 0);
  assert.equal(t.sm.signature, 'old');
});

test('a model a stopped run created is updated with the same consent rule', async () => {
  const setup = (/** @type {{ answers?: any[], yes?: boolean }} */ o) => {
    const fabric = fakeFabric();
    const ui = fakeUi(o);
    const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: ui.ui });
    t.config.semanticModel.enabled = true;
    const item = fabric.add('SemanticModel', 'AI in One', 'half-made', 'AI in One: Copilot adoption. Deployed by the AI in One installer. (ref cc33)');
    t.config.fabric.pendingItems = { 'SemanticModel:main': { name: 'AI in One', ref: 'cc33' } };
    fabric.failures.updateSemanticModel = [RESETS.operation()];
    return { ...t, fabric, ui, item, deploy: () => deployModel(t.ctx, t.config.semanticModel, { signature: 's', definition: () => 'v2' }) };
  };
  const yes = setup({ yes: true });
  await assert.rejects(yes.deploy(), /wasn't changed/);
  assert.equal(yes.item.content, 'half-made');
  assert.equal(yes.fabric.calls.filter((c) => c.includes('allowPurgeData')).length, 0);
  assert.equal(yes.fabric.calls.filter((c) => c.startsWith('createSemanticModel')).length, 0, 'not created again');

  const ok = setup({ answers: [true] });
  await ok.deploy();
  assert.ok(ok.fabric.calls.includes('updateSemanticModel AI in One allowPurgeData'));
  assert.equal(ok.item.content, 'v2');
  assert.equal(ok.config.semanticModel.reload?.cleared, true);
  assert.equal(yes.config.semanticModel.reload, undefined);
});

test('an unchanged model is not updated, and a new one is created, not updated', async () => {
  const t = deployed();
  t.sm.signature = undefined;
  await t.deploy();
  t.fabric.calls.length = 0;
  delete t.sm.reload;
  await t.deploy();
  assert.deepEqual(t.fabric.calls.filter((c) => /SemanticModel /.test(c)), []);
  assert.equal(t.sm.reload, undefined);

  const fabric = fakeFabric();
  const n = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: fakeUi().ui });
  n.config.semanticModel.enabled = true;
  await deployModel(n.ctx, n.config.semanticModel, { signature: 's', definition: () => 'v1' });
  assert.deepEqual(fabric.calls.filter((c) => /SemanticModel /.test(c)), ['createSemanticModel AI in One']);
  assert.equal(n.config.semanticModel.reload, undefined, 'a new model has nothing to reload');
});

test('declining a reset keeps an obligation an earlier run left', async () => {
  const t = deployed({ answers: [false] });
  t.sm.reload = { since: '2026-05-31T09:00:00.000Z', cleared: true };
  t.fabric.failures.updateSemanticModel = [RESETS.http()];
  await assert.rejects(t.deploy(), /wasn't changed/);
  assert.deepEqual(t.sm.reload, { since: '2026-05-31T09:00:00.000Z', cleared: true });
});

/** A model this run replaced (and so cleared), connected again as the update's later steps do. */
async function replacedAndBound() {
  const t = deployed({ answers: [true] });
  t.fabric.failures.updateSemanticModel = [RESETS.http()];
  await t.deploy();
  t.sm.bound = true;
  return t;
}

test('update: "Up to date" only once the replaced model is reloaded, which takes the obligation back', async () => {
  const t = await replacedAndBound();
  assert.equal(await finishUpdate(t.ctx), true);
  assert.ok(t.powerBi.calls.some((c) => c.startsWith(`refresh ${t.sm.id}`)));
  assert.ok(t.powerBi.calls.some((c) => c.startsWith('getRefresh ')), 'followed to the end');
  assert.match(t.ui.text(), /Up to date/);
  assert.equal(t.sm.reload, undefined);
});

test('update: a failed refresh is reported, not "Up to date", and the model stays owed a reload', async () => {
  const t = await replacedAndBound();
  t.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
  assert.equal(await finishUpdate(t.ctx), false);
  const text = t.ui.text();
  assert.doesNotMatch(text, /Up to date/);
  assert.match(text, /AI in One has no data until a refresh finishes/);
  assert.match(text, /The update isn't finished: the model wasn't reloaded\. Fix the problem above, then run ".*refresh", or ".*update" again\./);
  assert.equal(t.sm.reload?.cleared, true);
});

test('update: a replaced model that can\'t be refreshed is reported, not "Up to date"', async () => {
  const t = await replacedAndBound();
  t.sm.bound = false;
  assert.equal(await finishUpdate(t.ctx), false);
  assert.ok(!t.powerBi.calls.some((c) => c.startsWith('refresh ')));
  assert.doesNotMatch(t.ui.text(), /Up to date/);
  assert.match(t.ui.text(), /AI in One needs reloading after its update, but isn't connected to its data/);
  assert.equal(t.sm.reload?.cleared, true);
});

test('update without waiting: the refresh started is success, but said as still reloading, not "Up to date"', async () => {
  const t = await replacedAndBound();
  assert.equal(await finishUpdate(t.ctx, { wait: false }), true);
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith('getRefresh ')).length, 0);
  const text = t.ui.text();
  assert.doesNotMatch(text, /Up to date/);
  assert.match(text, /Updated\. AI in One is still reloading: reports on it can show no data or miss new columns until that finishes/);
  assert.equal(t.sm.reload?.cleared, true, 'kept until a refresh is seen to finish');
});

test('update on the page says the same: still reloading, or not finished, never "Up to date" early', async () => {
  for (const [wait, outcome] of /** @type {const} */ ([[false, 'reloading'], [true, 'failed']])) {
    const t = await replacedAndBound();
    const web = createWebUi({ now: () => 1000 });
    t.ctx.ui = web;
    if (outcome === 'failed') t.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
    assert.equal(await finishUpdate(t.ctx, { wait }), outcome !== 'failed');
    const lines = web.history().filter((/** @type {any} */ e) => e.type === 'line').map((/** @type {any} */ e) => `${e.kind}: ${e.text}`);
    assert.ok(!lines.some((l) => /Up to date/.test(l)), lines.join('\n'));
    if (outcome === 'reloading') assert.ok(lines.some((l) => /^ok: Updated\. AI in One is still reloading/.test(l)), lines.join('\n'));
    else assert.ok(lines.some((l) => /^fail: The update isn't finished: the model wasn't reloaded/.test(l)), lines.join('\n'));
  }
});

test('update with nothing replaced still refreshes, and is up to date', async () => {
  const t = deployed();
  assert.equal(await finishUpdate(t.ctx), true);
  assert.ok(t.powerBi.calls.some((c) => c.startsWith(`refresh ${t.sm.id}`)));
});

test('update: after a step that failed, not "Up to date", even once the model reloads', async () => {
  const t = await replacedAndBound();
  assert.equal(await finishUpdate(t.ctx, { failed: true }), false);
  assert.ok(t.powerBi.calls.some((c) => c.startsWith(`refresh ${t.sm.id}`)), 'the model still reloads');
  assert.equal(t.sm.reload, undefined);
  assert.match(t.ui.text(), /✗ The update isn't finished: a step above failed\. Fix what it says, then run ".*update" again\./);
  assert.doesNotMatch(t.ui.text(), /Up to date|Updated\./);

  const reloading = await replacedAndBound();
  assert.equal(await finishUpdate(reloading.ctx, { wait: false, failed: true }), false);
  assert.match(reloading.ui.text(), /a step above failed/);
  assert.match(reloading.ui.text(), /! AI in One is still reloading/);
  assert.doesNotMatch(reloading.ui.text(), /Up to date|Updated\./);
});

test('refresh: only the installer\'s own refresh, finished cleanly, takes the obligation back', async () => {
  const failed = await replacedAndBound();
  failed.powerBi.states.push({ status: 'Unknown' }, { status: 'Failed', extendedStatus: 'Failed' });
  assert.equal((await refreshModel(failed.ctx, { wait: true })).ok, false);
  assert.deepEqual(failed.sm.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true }, 'its failed refresh is forgotten, so the next run requests another');

  const done = await replacedAndBound();
  done.powerBi.states.push({ status: 'Unknown' }, { status: 'Completed', extendedStatus: 'Completed' });
  assert.equal((await refreshModel(done.ctx, { wait: true })).ok, true);
  assert.equal(done.sm.reload, undefined);

  // Following a refresh someone else started, which may load only some tables: then its own.
  const followed = await replacedAndBound();
  followed.powerBi.failures.refresh = [httpError(409, 'A refresh is in progress')];
  followed.powerBi.history.push({ requestId: 'theirs', status: 'Unknown', startTime: '2026-06-01T12:30:00Z' });
  assert.equal((await refreshModel(followed.ctx, { wait: true })).ok, true);
  assert.deepEqual(followed.powerBi.calls.filter((c) => /^(refresh|getRefresh) /.test(c)), [`refresh ${followed.sm.id} full`, 'getRefresh theirs', `refresh ${followed.sm.id} full`, 'getRefresh request-1']);
  assert.match(followed.ui.text(), /still needs a full reload after its update, so refreshing it again/);
  assert.equal(followed.sm.reload, undefined);

  // Busy again: once only, and the model stays owed, so the waited refresh isn't a success.
  const busy = await replacedAndBound();
  busy.powerBi.failures.refresh = [httpError(409, 'A refresh is in progress'), httpError(409, 'A refresh is in progress')];
  busy.powerBi.history.push({ requestId: 'theirs', status: 'Unknown', startTime: '2026-06-01T12:30:00Z' });
  assert.equal((await refreshModel(busy.ctx, { wait: true })).ok, false);
  assert.match(busy.ui.text(), /still needs a full reload after its update, but other refreshes kept running/);
  assert.equal(busy.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 2);
  assert.deepEqual(busy.sm.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true });
  busy.powerBi.failures.refresh = [httpError(409, 'A refresh is in progress'), httpError(409, 'A refresh is in progress')];
  assert.deepEqual(await settleReloads(busy.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: false, pending: [] });
  assert.equal(busy.sm.reload?.cleared, true);
});

test('settleReloads: a load still running leaves the model pending; waiting, that is not finished', async () => {
  const t = await replacedAndBound();
  const reachable = () => true;
  assert.deepEqual(await settleReloads(t.ctx, { wait: false, load: 'running', reachable }), { ok: true, pending: ['AI in One'] });
  assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'running', reachable }), { ok: false, pending: ['AI in One'] });
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 0, 'no refresh competes with the load');
  assert.match(t.ui.text(), /still reloading, so this couldn't confirm it finished/);
});

test('settleReloads after a finished load: the load\'s refreshes never count, so the installer reloads the model itself', async () => {
  const reachable = () => true;
  const loaded = await replacedAndBound();
  loaded.powerBi.history.push({ requestId: 'pipeline', status: 'Completed', startTime: '2026-06-01T12:30:00Z' });
  assert.deepEqual(await settleReloads(loaded.ctx, { wait: true, load: 'done', reachable }), { ok: true, pending: [] });
  assert.deepEqual(loaded.powerBi.calls.filter((c) => /^(refresh|getRefresh) /.test(c)), [`refresh ${loaded.sm.id} full`, 'getRefresh request-1'], 'the pipeline\'s refresh is never even checked');
  assert.match(loaded.ui.text(), /has no data until it reloads after its update, so refreshing it now/);
  assert.equal(loaded.sm.reload, undefined);

  const failed = await replacedAndBound();
  failed.powerBi.history.push({ requestId: 'pipeline', status: 'Completed', startTime: '2026-06-01T12:30:00Z' });
  failed.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
  assert.equal((await settleReloads(failed.ctx, { wait: true, load: 'done', reachable })).ok, false);
  assert.equal(failed.sm.reload?.cleared, true);
});

test('loadState: how far a pipeline run got with reloading the model', () => {
  assert.equal(loadState({ jobId: 'j', status: 'Completed', started: true }), 'done');
  assert.equal(loadState({ jobId: 'j', status: 'Failed', started: true }), 'none');
  assert.equal(loadState({ jobId: 'j', status: 'Cancelled', started: true }), 'none');
  assert.equal(loadState({ jobId: 'j', status: 'NotStarted', started: true }), 'running');
  assert.equal(loadState({ jobId: 'j', status: 'InProgress', started: false }), 'running');
});

/** Writes the record on every save, as the installer does, so a new context can read it back. */
function persisted(/** @type {{ ctx: any, config: any }} */ t) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-reload-'));
  const file = join(dir, 'aio-install.json');
  t.ctx.save = () => saveConfig(file, t.config);
  t.ctx.save();
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a reload owed after a failed refresh survives the record being saved and read back, and the next run reloads it', async () => {
  const t = deployed({ answers: [true] });
  const record = persisted(t);
  try {
    t.fabric.failures.updateSemanticModel = [RESETS.http()];
    await t.deploy();
    t.sm.bound = true;
    t.ctx.save();
    t.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
    assert.equal(await finishUpdate(t.ctx), false);

    const { config } = loadConfig(record.file);
    assert.deepEqual(config.semanticModel.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true }, 'its failed refresh is forgotten');
    const powerBi = t.powerBi;
    powerBi.calls.length = 0;
    // Its own record of the failed request is the only history: that never counts as the reload.
    powerBi.history.push({ requestId: 'request-1', status: 'Completed', startTime: '2026-06-01T12:00:01Z' });
    const ui = fakeUi();
    const next = fakeCtx({ config, fabric: t.fabric.api, graph: fakeGraph().api, powerBi: powerBi.api, ui: ui.ui, now: new Date('2026-06-01T13:00:00Z') });
    next.ctx.save = () => saveConfig(record.file, config);
    // Unchanged definition: no update request, but the saved obligation is still met.
    t.fabric.calls.length = 0;
    await deployModel(next.ctx, config.semanticModel, { signature: 'new', definition: () => 'v2' });
    assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), []);
    assert.deepEqual(await settleReloads(next.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
    assert.equal(powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
    assert.match(ui.text(), /AI in One has no data until it reloads after its update, so refreshing it now/);
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined, 'taken back on disk too');
  } finally {
    record.cleanup();
  }
});

test('the reload is recorded before each request that can change the model, so an unknown outcome is still owed one', async () => {
  const definition = { parts: [{ path: 'model.bim', payload: Buffer.from('{}').toString('base64'), payloadType: 'InlineBase64' }] };
  const t = deployed({ answers: [true] });
  const record = persisted(t);
  try {
    /** @type {{ method: string, purge: boolean, owed: any }[]} */
    const seen = [];
    const http = createClient({
      baseUrl: 'https://fabric.invalid/v1',
      getToken: async () => 'offline',
      sleep: async () => {},
      fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ options) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        seen.push({ method: options.method, purge: !!body?.options?.allowPurgeData, owed: loadConfig(record.file).config.semanticModel.reload ?? null });
        if (options.method === 'GET') return new Response(JSON.stringify({ errorCode: 'Forbidden', message: 'Polling denied' }), { status: 403 });
        if (!body.options?.allowPurgeData) return new Response(JSON.stringify({ errorCode: 'RequiredOptionsMissing', message: 'Needs reset' }), { status: 400 });
        return new Response(null, { status: 202, headers: { Location: 'https://fabric.invalid/v1/operations/purge' } });
      }),
    });
    t.fabric.api.updateSemanticModel = fabricApi(http).updateSemanticModel;
    await assert.rejects(deployModel(t.ctx, t.sm, { signature: 'new', definition: () => definition }), /Polling denied/);
    assert.deepEqual(seen.map((s) => [s.method, s.purge, s.owed]), [
      ['POST', false, { since: '2026-06-01T12:00:00.000Z', unsettled: true }],
      ['POST', true, { since: '2026-06-01T12:00:00.000Z', unsettled: true, cleared: true }],
      ['GET', false, { since: '2026-06-01T12:00:00.000Z', unsettled: true, cleared: true }],
    ]);
    assert.equal(t.sm.signature, 'old', 'the outcome is unknown, so the next run sends it again');
    assert.match(t.ui.text(), /AI in One's data may have been cleared\. Run the installer again once the problem below is fixed: it applies the update again and then reloads the data/);
    assert.deepEqual(loadConfig(record.file).config.semanticModel.reload, { since: '2026-06-01T12:00:00.000Z', unsettled: true, cleared: true });
  } finally {
    record.cleanup();
  }
});

test('a refresh that ran before the change settled never counts as its reload, even when its start looks later', async () => {
  const definition = { parts: [{ path: 'model.bim', payload: Buffer.from('{}').toString('base64'), payloadType: 'InlineBase64' }] };
  const t = deployed({ answers: [true] });
  const record = persisted(t);
  try {
    let posts = 0;
    const http = createClient({
      baseUrl: 'https://fabric.invalid/v1',
      getToken: async () => {
        // While the purge request is being sent: another refresh reads the old definition and finishes.
        if (posts === 1) t.powerBi.history.unshift({ requestId: 'old-definition', status: 'Completed', startTime: '2026-06-01T12:00:01Z', endTime: '2026-06-01T12:00:02Z' });
        return 'offline';
      },
      sleep: async () => {},
      fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ options) => {
        const body = JSON.parse(options.body);
        posts++;
        if (!body.options?.allowPurgeData) return new Response(JSON.stringify({ errorCode: 'RequiredOptionsMissing', message: 'Needs reset' }), { status: 400 });
        return new Response(null, { status: 200 });
      }),
    });
    t.fabric.api.updateSemanticModel = fabricApi(http).updateSemanticModel;
    await deployModel(t.ctx, t.sm, { signature: 'new', definition: () => definition });
    t.sm.bound = true;
    t.ctx.save();
    // The clock didn't move, so by start time alone the old refresh would count.
    assert.deepEqual(loadConfig(record.file).config.semanticModel.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true });
    assert.equal(await confirmReloaded(t.ctx, t.sm), false);
    assert.ok(loadConfig(record.file).config.semanticModel.reload);
    t.powerBi.calls.length = 0;
    assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
    assert.deepEqual(t.powerBi.calls.filter((c) => c.startsWith('refresh ')), [`refresh ${t.sm.id} full`], 'reloaded after the change');
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined);
  } finally {
    record.cleanup();
  }
});

test('a refresh the installer didn\'t request never counts, even when its start is after the change', async () => {
  const t = deployed({ answers: [true] });
  t.fabric.failures.updateSemanticModel = [RESETS.http()];
  await t.deploy();
  t.sm.bound = true;
  assert.deepEqual(t.sm.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true });
  t.powerBi.history.push({ requestId: 'pipeline', status: 'Completed', startTime: '2026-06-01T12:30:00Z' });
  assert.equal(await confirmReloaded(t.ctx, t.sm), false);
  assert.deepEqual(t.powerBi.calls, [], 'not even listed or checked');
  assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'done', reachable: () => true }), { ok: true, pending: [] });
  const calls = /** @type {string[]} */ (t.powerBi.calls);
  assert.equal(calls.filter((c) => c.startsWith('refresh ')).length, 1);
  assert.equal(t.sm.reload, undefined);
});

/** A refresh that ends Completed, but with a calculated table that wasn't calculated. */
const WARNED = { status: 'Completed', extendedStatus: 'Completed', messages: [{ type: 'Warning', message: 'A calculated table could not be calculated.' }] };

test('a refresh whose details report problems never counts as the reload, even when the history says Completed', async () => {
  const t = await replacedAndBound();
  const record = persisted(t);
  try {
    // The history shows each refresh only as Completed.
    const refresh = t.powerBi.api.refresh;
    t.powerBi.api.refresh = async (/** @type {any[]} */ ...a) => {
      const id = await /** @type {any} */ (refresh)(...a);
      t.powerBi.history.unshift({ requestId: id, status: 'Completed', startTime: '2026-06-01T12:00:01Z' });
      return id;
    };
    t.powerBi.states.push(WARNED);
    assert.equal(await finishUpdate(t.ctx), false);
    assert.match(t.ui.text(), /parts of it weren't calculated/);
    assert.doesNotMatch(t.ui.text(), /Up to date/);
    const saved = loadConfig(record.file).config.semanticModel.reload;
    assert.equal(saved?.cleared, true);
    assert.equal(saved?.ours, undefined, 'its refresh with problems is forgotten, so never counts');

    // A new run: that refresh still doesn't count, so it refreshes again and checks the details.
    const { config } = loadConfig(record.file);
    const next = fakeCtx({ config, fabric: t.fabric.api, graph: fakeGraph().api, powerBi: t.powerBi.api, ui: fakeUi().ui });
    next.ctx.save = () => saveConfig(record.file, config);
    t.powerBi.calls.length = 0;
    t.powerBi.states.push(WARNED);
    assert.deepEqual(await settleReloads(next.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: false, pending: [] });
    assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
    assert.equal(loadConfig(record.file).config.semanticModel.reload?.cleared, true);

    t.powerBi.calls.length = 0;
    assert.deepEqual(await settleReloads(next.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
    assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 1);
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined, 'taken back only after a clean one');
  } finally {
    record.cleanup();
  }
});

test('only the installer\'s own refresh, by its own details, is checked as the reload', async () => {
  // Clean whole-model and table refreshes from a load: none of them is the installer's.
  const theirs = await replacedAndBound();
  theirs.powerBi.history.push({ requestId: 'table', status: 'Completed', startTime: '2026-06-01T12:40:00Z' }, { requestId: 'pipeline', status: 'Completed', startTime: '2026-06-01T12:30:00Z' });
  assert.equal(await confirmReloaded(theirs.ctx, theirs.sm), false);
  assert.deepEqual(theirs.powerBi.calls, []);

  /** A model whose own reload refresh was started and not waited for. @param {any} [state] */
  const started = async (state) => {
    const t = await replacedAndBound();
    assert.equal((await refreshModel(t.ctx, { wait: false })).ok, true);
    assert.equal(t.sm.reload?.ours, 'request-1');
    if (state) t.powerBi.states.push(state);
    return t;
  };
  const warned = await started(WARNED);
  assert.equal(await confirmReloaded(warned.ctx, warned.sm), false);
  assert.deepEqual(warned.sm.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true }, 'forgotten, so the next run requests another');

  const running = await started({ status: 'Unknown' });
  assert.equal(await confirmReloaded(running.ctx, running.sm), false);
  assert.equal(running.sm.reload?.ours, 'request-1', 'still running: checked again later');

  const missing = await started();
  missing.powerBi.api.getRefresh = async () => { throw httpError(404, 'Not found'); };
  assert.equal(await confirmReloaded(missing.ctx, missing.sm), false, 'no details, no proof');
  assert.equal(missing.sm.reload?.ours, 'request-1');

  const clean = await started();
  assert.equal(await confirmReloaded(clean.ctx, clean.sm), true);
  assert.deepEqual(clean.powerBi.calls.filter((c) => c.startsWith('getRefresh ')), ['getRefresh request-1']);
  assert.equal(clean.sm.reload, undefined);
});

/**
 * Power BI behind the real client: a model of two tables, cleared by the update, that a refresh
 * loads, all of them or only the `objects` it names, when it finishes cleanly.
 * @param {{ ctx: any, powerBi: any }} t
 */
function powerBiService(t) {
  /** @type {Record<string, boolean>} */
  const tables = { FactAlpha: false, FactBeta: false };
  /** @type {Map<string, { status: string, objects?: string[], messages: any[] }>} */
  const runs = new Map();
  /** @type {string[]} newest first */
  const order = [];
  /** @type {any[]} */
  const posts = [];
  /** @type {any[]} What the installer's next refreshes end as. */
  const outcomes = [];
  let n = 0;
  let busy = 0;
  /** A refresh someone else ran. @param {string} id @param {{ status?: string, objects?: string[], messages?: any[] }} [o] */
  const ran = (id, o = {}) => {
    const r = { status: o.status ?? 'Completed', objects: o.objects, messages: o.messages ?? [] };
    runs.set(id, r);
    order.unshift(id);
    if (r.status === 'Completed' && !r.messages.length) for (const k of r.objects ?? Object.keys(tables)) tables[k] = true;
  };
  const json = (/** @type {any} */ body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const http = createClient({
    baseUrl: 'https://powerbi.invalid/v1.0/myorg',
    getToken: async () => 'offline',
    sleep: async () => {},
    fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ options) => {
      const path = new URL(url).pathname;
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        if (busy > 0) {
          busy--;
          return json({ error: { code: 'Conflict', message: 'A refresh is in progress' } }, 409);
        }
        const id = `own-${++n}`;
        ran(id, outcomes.shift() ?? {});
        return new Response(null, { status: 202, headers: { location: `${path}/${id}` } });
      }
      const id = path.split('/').pop() ?? '';
      if (id === 'refreshes') return json({ value: order.map((requestId) => ({ requestId, status: runs.get(requestId)?.status, startTime: '2026-06-01T12:30:00Z' })) });
      const r = runs.get(id);
      if (!r) return json({ error: { code: 'NotFound', message: 'Not found' } }, 404);
      return json({ requestId: id, type: 'Full', status: r.status, extendedStatus: r.status, objects: (r.objects ?? []).map((table) => ({ table })), messages: r.messages });
    }),
  });
  const api = powerBiApi(http);
  Object.assign(t.powerBi.api, { refresh: api.refresh, getRefresh: api.getRefresh, refreshes: api.refreshes });
  t.ctx.sleep = async () => {};
  return { tables, posts, outcomes, ran, setBusy: (/** @type {number} */ k) => { busy = k; } };
}

const WHOLE_MODEL = { type: 'full', commitMode: 'transactional', applyRefreshPolicy: true, retryCount: 1 };

test('scope: a clean refresh of one table after the change never retires the reload; the installer reloads the whole model', async () => {
  const t = await replacedAndBound();
  const record = persisted(t);
  try {
    const pbi = powerBiService(t);
    pbi.ran('table-only', { objects: ['FactAlpha'] });
    assert.equal(await confirmReloaded(t.ctx, t.sm), false);
    assert.deepEqual(pbi.posts, []);
    assert.ok(loadConfig(record.file).config.semanticModel.reload, 'still owed on disk');
    assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'done', reachable: () => true }), { ok: true, pending: [] });
    assert.deepEqual(pbi.posts, [WHOLE_MODEL], 'one whole-model request, no objects');
    assert.deepEqual(pbi.tables, { FactAlpha: true, FactBeta: true });
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined);
  } finally {
    record.cleanup();
  }
});

test('scope: after its own full refresh fails, later clean table refreshes never retire the reload, in a new run either', async () => {
  const t = await replacedAndBound();
  const record = persisted(t);
  try {
    const pbi = powerBiService(t);
    pbi.outcomes.push({ messages: [{ type: 'Warning', message: 'A calculated table could not be calculated.' }] });
    assert.equal(await finishUpdate(t.ctx), false);
    for (const id of ['a1', 'a2', 'a3']) pbi.ran(id, { objects: ['FactAlpha'] });
    assert.deepEqual(pbi.tables, { FactAlpha: true, FactBeta: false });

    const { config } = loadConfig(record.file);
    assert.deepEqual(config.semanticModel.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true });
    const next = fakeCtx({ config, fabric: t.fabric.api, graph: fakeGraph().api, powerBi: t.powerBi.api, ui: fakeUi().ui });
    next.ctx.save = () => saveConfig(record.file, config);
    next.ctx.sleep = async () => {};
    assert.equal(await confirmReloaded(next.ctx, config.semanticModel), false);
    assert.ok(loadConfig(record.file).config.semanticModel.reload);
    assert.deepEqual(await settleReloads(next.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
    assert.deepEqual(pbi.posts, [WHOLE_MODEL, WHOLE_MODEL]);
    assert.deepEqual(pbi.tables, { FactAlpha: true, FactBeta: true });
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined);
  } finally {
    record.cleanup();
  }
});

test('scope: following a busy table refresh never retires the reload; its own whole-model refresh does, or it stays owed', async () => {
  const t = await replacedAndBound();
  const record = persisted(t);
  try {
    const pbi = powerBiService(t);
    pbi.ran('table-only', { objects: ['FactAlpha'] });
    pbi.setBusy(1);
    assert.equal((await refreshModel(t.ctx, { wait: true })).ok, true);
    assert.deepEqual(pbi.posts, [WHOLE_MODEL, WHOLE_MODEL], 'followed, then its own');
    assert.deepEqual(pbi.tables, { FactAlpha: true, FactBeta: true });
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined);

    const busy = await replacedAndBound();
    const saved = persisted(busy);
    try {
      const svc = powerBiService(busy);
      svc.ran('table-only', { objects: ['FactAlpha'] });
      svc.setBusy(2);
      assert.equal(await finishUpdate(busy.ctx), false);
      assert.match(busy.ui.text(), /The update isn't finished: the model wasn't reloaded\. Fix the problem above, then run ".*refresh", or ".*update" again\./);
      assert.doesNotMatch(busy.ui.text(), /Up to date/);
      assert.deepEqual(svc.tables, { FactAlpha: true, FactBeta: false });
      assert.deepEqual(loadConfig(saved.file).config.semanticModel.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true });
    } finally {
      saved.cleanup();
    }

    // The refresh command, waiting, busy twice: not a success, and the model stays owed.
    const cmd = await replacedAndBound();
    const cmdSaved = persisted(cmd);
    try {
      const svc = powerBiService(cmd);
      svc.ran('table-only', { objects: ['FactAlpha'] });
      svc.setBusy(2);
      assert.equal(await runCommand(cmd.ctx, 'refresh', { wait: true }), false);
      assert.match(cmd.ui.text(), /other refreshes kept running, so it couldn't start one/);
      assert.deepEqual(svc.tables, { FactAlpha: true, FactBeta: false });
      assert.deepEqual(loadConfig(cmdSaved.file).config.semanticModel.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true });
    } finally {
      cmdSaved.cleanup();
    }
  } finally {
    record.cleanup();
  }
});

test('scope: its own refresh, not waited for, retires the reload in a later run once its details are clean', async () => {
  const t = await replacedAndBound();
  const record = persisted(t);
  try {
    const pbi = powerBiService(t);
    assert.equal(await finishUpdate(t.ctx, { wait: false }), true);
    assert.match(t.ui.text(), /still reloading/);
    const { config } = loadConfig(record.file);
    assert.equal(config.semanticModel.reload?.ours, 'own-1');
    pbi.ran('table-only', { objects: ['FactAlpha'] });
    const next = fakeCtx({ config, fabric: t.fabric.api, graph: fakeGraph().api, powerBi: t.powerBi.api, ui: fakeUi().ui });
    next.ctx.save = () => saveConfig(record.file, config);
    assert.deepEqual(await settleReloads(next.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
    assert.deepEqual(pbi.posts, [WHOLE_MODEL], 'no second refresh');
    assert.equal(loadConfig(record.file).config.semanticModel.reload, undefined);
  } finally {
    record.cleanup();
  }
});
test('a change that may not have finished is applied again before anything counts as its reload', async () => {
  const t = deployed({ answers: [true] });
  await t.deploy();
  t.sm.bound = true;
  t.sm.reload = { since: '2026-06-01T12:00:00.000Z', unsettled: true, cleared: true };
  t.powerBi.history.push({ requestId: 'later', status: 'Completed', startTime: '2026-06-01T12:30:00Z' });
  assert.equal(await confirmReloaded(t.ctx, t.sm), false);
  t.powerBi.calls.length = 0;
  assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: false, pending: [] });
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith('refresh ')).length, 0);
  assert.match(t.ui.text(), /AI in One's last update may not have finished, so it can't be reloaded yet/);
  // A refresh on its own (the refresh command) doesn't settle it either.
  assert.equal((await refreshModel(t.ctx, { wait: true })).ok, true);
  assert.equal(t.sm.reload?.unsettled, true);

  // The same version, unchanged: applied again all the same, then reloaded.
  t.fabric.calls.length = 0;
  await t.deploy();
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), ['updateSemanticModel AI in One']);
  assert.match(t.ui.text(), /last update may not have finished, so applying it again/);
  assert.deepEqual(t.sm.reload, { since: '2026-06-01T12:00:00.000Z', cleared: true });
  t.sm.bound = true;
  assert.deepEqual(await settleReloads(t.ctx, { wait: true, load: 'none', reachable: () => true }), { ok: true, pending: [] });
  assert.equal(t.sm.reload, undefined);
});

test('pendingReloads: only the installer\'s own model, deployed and owed a reload, is reloaded', () => {
  const { config } = fakeCtx();
  const owed = () => pendingReloads(config).map((m) => m.id);
  config.semanticModel.reload = { since: '2026-06-01T12:00:00.000Z', unsettled: true };
  assert.deepEqual(owed(), [], 'never deployed, so there is nothing to reload');
  config.semanticModel.id = 'sm-1';
  assert.deepEqual(owed(), ['sm-1']);
  delete config.semanticModel.reload;
  assert.deepEqual(owed(), [], 'deployed, but owed nothing');
});
test('--allow-model-reset: only with install, update or access, and not with --ui', () => {
  assert.equal(parseCli(['update', '--yes', '--allow-model-reset']).allowModelReset, true);
  assert.equal(parseCli(['install']).allowModelReset, false);
  assert.equal(parseCli(['update', '--yes']).allowModelReset, false);
  assert.throws(() => parseCli(['refresh', '--allow-model-reset']), /goes with install, update or access/);
  assert.throws(() => parseCli(['--ui', '--allow-model-reset']), /--ui/);
});

test('the plan says an existing model may need its data cleared, and a new one doesn\'t', () => {
  const t = deployed();
  const existing = planReview(t.ctx).creates.find((c) => c.kind === 'Semantic model');
  assert.equal(existing?.detail, MODEL_UPDATE_NOTE);
  assert.match(MODEL_UPDATE_NOTE, /asked before it's cleared/);
  delete t.sm.id;
  const fresh = planReview(t.ctx).creates.find((c) => c.kind === 'Semantic model');
  assert.equal(fresh?.isNew, true);
  assert.equal(fresh?.detail, undefined);
});
