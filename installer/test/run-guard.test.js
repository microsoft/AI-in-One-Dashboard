// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/install.js';
import { createUi } from '../src/ui.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const pipelineRun = (/** @type {number} */ days) => `runJob Pipeline {"parameters":{"AuditMode":"backfill","BackfillDays":${days}}}`;

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

test('run --backfill-days with fewer days than are loaded warns, asks, and on no starts nothing', async () => {
  const { ctx, config, ui, saves, runs } = setup({ answers: [false] });
  assert.deepEqual(await run(ctx, { wait: false, backfillDays: 90 }), { started: false, ok: false, declined: true });
  assert.deepEqual(ui.asked, ['Reload only 90 days?']);
  assert.deepEqual(runs(), []);
  assert.equal(config.history.days, 180);
  assert.equal(saves(), 0);
  const text = ui.text();
  assert.match(text, /This rebuilds the audit table with 90 days of history, so the 180 days loaded now drop to 90\./);
  assert.match(text, /Nothing started\. To keep the history you have, run ".*run --backfill-days 180" or more\./);
});

test('run --backfill-days with fewer days: yes starts the pipeline with them, and the history drops to them', async () => {
  const { ctx, config, ui, saves, runs } = setup({ answers: [true] });
  const result = await run(ctx, { wait: false, backfillDays: 90 });
  assert.equal(result.started, true);
  assert.deepEqual(ui.asked, ['Reload only 90 days?']);
  assert.deepEqual(runs(), [pipelineRun(90)]);
  assert.equal(config.history.days, 90);
  assert.ok(saves() >= 1);
  assert.equal(config.firstRun?.jobId, 'job-0', 'not a first load');
  assert.match(ui.text(), /Started the pipeline with 90 days of audit history/);
});

test('run --backfill-days with fewer days under --yes starts nothing: the question takes its default, no', async () => {
  /** @type {string[]} */
  const out = [];
  const { ctx, config, runs } = setup({ ui: createUi({ yes: true, write: (s) => out.push(s) }) });
  assert.deepEqual(await run(ctx, { wait: false, backfillDays: 30 }), { started: false, ok: false, declined: false });
  assert.deepEqual(runs(), []);
  assert.equal(config.history.days, 180);
  assert.match(out.join(''), /run --backfill-days 180" or more\./);
});

test('run --backfill-days with as many days as are loaded, or more, asks nothing and the history follows the run', async () => {
  for (const days of [180, 365]) {
    const { ctx, config, ui, runs } = setup();
    const result = await run(ctx, { wait: false, backfillDays: days });
    assert.equal(result.started, true);
    assert.deepEqual(ui.asked, [], `${days} days`);
    assert.deepEqual(runs(), [pipelineRun(days)]);
    assert.equal(config.history.days, days);
  }
});

test('run --backfill-days on a first load asks nothing, even with fewer days than the record says', async () => {
  const { ctx, config, ui, runs } = setup({ loaded: false });
  const result = await run(ctx, { wait: false, backfillDays: 90 });
  assert.equal(result.started, true);
  assert.deepEqual(ui.asked, []);
  assert.deepEqual(runs(), [pipelineRun(90)]);
  assert.equal(config.history.days, 90);
  assert.equal(config.firstRun?.status, 'NotStarted', 'recorded as the first load');
  assert.match(ui.text(), /Started the first load: 90 days of audit history/);
});

test('run --backfill-days counts a completed pipeline run as history loaded when the record has no first load', async () => {
  const { ctx, config, fabric, ui, runs } = setup({ loaded: false, answers: [false] });
  fabric.jobList.push({ id: 'job-0', status: 'Completed' });
  assert.equal((await run(ctx, { wait: false, backfillDays: 90 })).started, false);
  assert.deepEqual(ui.asked, ['Reload only 90 days?']);
  assert.deepEqual(runs(), []);
  assert.equal(config.history.days, 180);
});
