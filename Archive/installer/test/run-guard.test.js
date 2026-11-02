// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/install.js';
import { createUi } from '../src/ui.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const pipelineRun = (/** @type {number} */ days) => `runJob Pipeline {"parameters":{"AuditMode":"backfill","BackfillDays":${days}}}`;
const keepsOlder = (/** @type {number} */ days) => new RegExp(`This loads the last ${days} days of audit history again and keeps the older days\\.`);

/**
 * An install with a pipeline and, unless `loaded` is false, 180 days of history loaded.
 * @param {{ answers?: any[], ui?: import('../src/ui.js').Ui, loaded?: boolean }} [o]
 */
function setup(o = {}) {
  const fabric = fakeFabric();
  const u = fakeUi({ answers: o.answers });
  const { ctx, config, saves } = fakeCtx({ fabric: fabric.api, ui: o.ui ?? u.ui });
  config.fabric.pipelineId = 'pl-1';
  config.history.days = 180;
  if (o.loaded ?? true) config.firstRun = { jobId: 'job-0', status: 'Completed', startedAt: '2026-05-01T00:00:00Z' };
  const runs = () => fabric.calls.filter((c) => c.startsWith('runJob'));
  return { ctx, config, fabric, ui: u, saves, runs };
}

test('run --backfill-days with fewer days than are loaded starts without asking, and the older days stay loaded', async () => {
  const { ctx, config, ui, saves, runs } = setup();
  const result = await run(ctx, { wait: false, backfillDays: 90 });
  assert.equal(result.started, true);
  assert.equal('declined' in result, false);
  assert.deepEqual(ui.asked, []);
  assert.deepEqual(runs(), [pipelineRun(90)]);
  assert.equal(config.history.days, 180, 'the deepest load counts');
  assert.ok(saves() >= 1);
  assert.equal(config.firstRun?.jobId, 'job-0', 'not a first load');
  const text = ui.text();
  assert.match(text, keepsOlder(90));
  assert.match(text, /Started the pipeline with 90 days of audit history/);
  assert.doesNotMatch(text, /drop to|Nothing started/);
});

test('run --backfill-days with fewer days starts under --yes too', async () => {
  /** @type {string[]} */
  const out = [];
  const { ctx, config, runs } = setup({ ui: createUi({ yes: true, write: (s) => out.push(s) }) });
  const result = await run(ctx, { wait: false, backfillDays: 30 });
  assert.equal(result.started, true);
  assert.deepEqual(runs(), [pipelineRun(30)]);
  assert.equal(config.history.days, 180);
  assert.match(out.join(''), keepsOlder(30));
});

test('run --backfill-days with as many days as are loaded, or more, adds no note and the history follows the run', async () => {
  for (const days of [180, 365]) {
    const { ctx, config, ui, runs } = setup();
    const result = await run(ctx, { wait: false, backfillDays: days });
    assert.equal(result.started, true);
    assert.deepEqual(ui.asked, [], `${days} days`);
    assert.deepEqual(runs(), [pipelineRun(days)]);
    assert.equal(config.history.days, days);
    assert.doesNotMatch(ui.text(), /keeps the older days/);
  }
});

test('run --backfill-days on a first load asks nothing and sets the history, even to fewer days than the record says', async () => {
  const { ctx, config, ui, runs } = setup({ loaded: false });
  const result = await run(ctx, { wait: false, backfillDays: 90 });
  assert.equal(result.started, true);
  assert.deepEqual(ui.asked, []);
  assert.deepEqual(runs(), [pipelineRun(90)]);
  assert.equal(config.history.days, 90);
  assert.equal(config.firstRun?.status, 'NotStarted', 'recorded as the first load');
  assert.match(ui.text(), /Started the first load: 90 days of audit history/);
  assert.doesNotMatch(ui.text(), /keeps the older days/);
});

test('run --backfill-days counts a completed pipeline run as history loaded when the record has no first load', async () => {
  const { ctx, config, fabric, ui, runs } = setup({ loaded: false });
  fabric.jobList.push({ id: 'job-0', status: 'Completed' });
  assert.equal((await run(ctx, { wait: false, backfillDays: 90 })).started, true);
  assert.deepEqual(ui.asked, []);
  assert.deepEqual(runs(), [pipelineRun(90)]);
  assert.equal(config.history.days, 180, 'a reload, so the deepest load counts');
  assert.equal(config.firstRun, undefined, 'not recorded as a first load');
  assert.match(ui.text(), keepsOlder(90));
});

test('run --backfill-days leaves the history as it is when the pipeline is already running', async () => {
  const { ctx, config, fabric, runs } = setup();
  fabric.jobList.push({ id: 'job-1', status: 'InProgress', startTimeUtc: '2026-06-01T11:00:00Z' });
  assert.equal((await run(ctx, { wait: false, backfillDays: 365 })).started, false);
  assert.deepEqual(runs(), []);
  assert.equal(config.history.days, 180);
});
