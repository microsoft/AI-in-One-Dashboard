// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askMoreHistory, HISTORY_CHOICES, reloadDetail, reloadLine } from '../src/steps/plan.js';
import { fakeCtx, fakeUi } from './fakes.js';

/** A ui that records each select's choices and answers with `answer`, or the default. @param {any} [answer] */
function selectUi(answer) {
  const fake = fakeUi();
  /** @type {{ message: string, choices: any[], def: any }[]} */
  const selects = [];
  fake.ui.select = async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) => {
    selects.push({ message, choices, def });
    return answer === undefined ? def : answer;
  };
  return { ...fake, selects };
}

const LOAD_TIME = 'It can take from under an hour to several hours in a large tenant';

test('askMoreHistory: offers only more than is loaded, and leaves the record alone until the reload starts', async () => {
  const s = selectUi(90);
  const { ctx, config } = fakeCtx({ ui: s.ui });
  config.history.days = 30;
  await askMoreHistory(ctx);
  assert.equal(s.selects.length, 1);
  assert.equal(s.selects[0].message, 'Load more audit history? 30 days are loaded now.');
  assert.deepEqual(s.selects[0].choices.map((c) => c.value), [0, 90, 180]);
  assert.deepEqual(s.selects[0].choices.map((c) => c.name), ['Keep 30 days (the usual runs carry on from here)', 'Reload 90 days after setup', 'Reload 180 days after setup']);
  assert.equal(s.selects[0].choices[2].description, `Runs the pipeline once with 180 days of history. ${LOAD_TIME}; the scheduled runs carry on after it.`);
  assert.equal(s.selects[0].def, 0, 'keeping what is loaded is the default');
  assert.equal(ctx.reloadHistoryDays, 90);
  assert.equal(config.history.days, 30, 'saved only once the reload has started');

  const keep = selectUi();
  const k = fakeCtx({ ui: keep.ui });
  k.config.history.days = 90;
  k.ctx.reloadHistoryDays = 180;
  await askMoreHistory(k.ctx);
  assert.deepEqual(keep.selects[0].choices.map((c) => c.value), [0, 180]);
  assert.equal(k.ctx.reloadHistoryDays, undefined, 'Keep is the default, and clears an earlier answer');

  const most = selectUi();
  const m = fakeCtx({ ui: most.ui });
  m.config.history.days = 180;
  m.ctx.reloadHistoryDays = 180;
  await askMoreHistory(m.ctx);
  assert.equal(most.selects.length, 0, 'nothing more to offer at 180 days');
  assert.match(most.text(), /Audit history: 180 days loaded, the most the installer loads/);
  assert.equal(m.ctx.reloadHistoryDays, undefined);
});

test('askMoreHistory: each reload choice is described by the caller when it says how', async () => {
  const s = selectUi();
  const { ctx, config } = fakeCtx({ ui: s.ui });
  config.history.days = 90;
  await askMoreHistory(ctx, (days) => `Reloads ${days} days.`);
  assert.deepEqual(s.selects[0].choices.map((c) => c.description), [undefined, 'Reloads 180 days.']);
});

test('reloadLine and reloadDetail describe the reload for the plan summary', () => {
  assert.deepEqual(HISTORY_CHOICES.map((c) => c.value), [30, 90, 180]);
  assert.match(HISTORY_CHOICES[0].name, /quickest; you can load more later/);
  assert.match(HISTORY_CHOICES[2].name, /the default; the most the audit log keeps by default/);
  assert.equal(reloadLine(90), 'Reload 90 days of history after setup');
  assert.equal(reloadDetail(180), `One pipeline run. ${LOAD_TIME}; the scheduled runs carry on after it.`);
});
