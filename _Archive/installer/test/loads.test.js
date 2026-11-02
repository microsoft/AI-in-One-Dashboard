// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../src/http.js';
import { classifyFailure, conditionMet, failedCards, fillRerun, loadCards, RERUN } from '../src/loads.js';
import { createUi } from '../src/ui.js';
import { PIPELINE_TEMPLATE } from '../src/sources.js';
import { ensureSparkSettings, PIPELINE_NAME } from '../src/steps/fabric.js';
import { BUSY_RETRIES, BUSY_WAIT_MS, dependencyOrder, evaluate, rerunFailed, rerunSteps, runParameters } from '../src/steps/rerun.js';
import {
  AUDIT_ACTIVITY,
  buildPipeline,
  findActivity,
  LICENSED_ACTIVITY,
  ORG_ACTIVITY,
  ORG_BRANCH,
  PIPELINE_VERSION,
  REFRESH_ACTIVITY,
  SESSION_TAG,
} from '../src/transform/pipeline.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const here = dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(readFileSync(join(here, '..', '..', PIPELINE_TEMPLATE), 'utf8'));

const WS = 'f0000000-0000-0000-0000-000000000000';
const id = (/** @type {number} */ n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ids = {
  auditIngester: id(1),
  licensedUsers: id(2),
  dataCheck: id(3),
  orgData: id(4),
  refreshModel: id(5),
};
const modules = { orgData: true };
/** @param {Partial<import('../src/transform/pipeline.js').PipelineSettings>} [more] */
const build = (more = {}) => buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules, semanticModelId: 'model-1', ...more });

/** Every activity, nested ones included. @param {any[]} activities @returns {any[]} */
const all = (activities) =>
  activities.flatMap((a) => [a, ...all([...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])])]);

/** "Run_X: Succeeded" style runs, as activityRuns returns them. @param {Record<string, string | [string, any]>} spec */
const runsOf = (spec) =>
  new Map(Object.entries(spec).map(([name, s]) => {
    const [status, error] = Array.isArray(s) ? s : [s, undefined];
    return [name, { activityName: name, status, error, attempts: 1 }];
  }));

const BUSY = { errorCode: 'RequestExecutionFailed', message: 'Failed to create Livy session. Error: [TooManyRequestsForCapacity] You have hit a spark compute limit.' };

/* ---------- Pipeline ---------- */

test('pipeline: every notebook shares one Spark session, nested ones too', () => {
  const notebooks = all(build().properties.activities).filter((a) => a.type === 'TridentNotebook');
  assert.deepEqual(notebooks.map((a) => a.name).sort(), [AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_ACTIVITY, REFRESH_ACTIVITY].sort());
  for (const nb of notebooks) assert.equal(nb.typeProperties.sessionTag, SESSION_TAG, nb.name);
  assert.match(SESSION_TAG, /^[A-Za-z0-9_]+$/, 'letters, digits and underscores only');
  assert.ok(PIPELINE_VERSION >= 1);
});

test('pipeline: the model refresh runs last, once the audit log has loaded and lane 2 has finished', () => {
  const acts = build().properties.activities;
  const refresh = findActivity(acts, REFRESH_ACTIVITY);
  assert.equal(acts.at(-1).name, REFRESH_ACTIVITY);
  assert.equal(refresh.typeProperties.notebookId, ids.refreshModel);
  assert.equal(refresh.typeProperties.parameters.SEMANTIC_MODEL_ID.value, 'model-1');
  const others = acts.filter((/** @type {any} */ a) => a.name !== REFRESH_ACTIVITY);
  const leaves = others.filter((/** @type {any} */ a) => !others.some((/** @type {any} */ b) => b.dependsOn?.some((/** @type {any} */ d) => d.activity === a.name)));
  assert.deepEqual(refresh.dependsOn.map((/** @type {any} */ d) => d.activity).sort(), leaves.map((/** @type {any} */ a) => a.name).sort());
  assert.deepEqual(refresh.dependsOn, [
    { activity: AUDIT_ACTIVITY, dependencyConditions: ['Succeeded'] },
    { activity: ORG_BRANCH, dependencyConditions: ['Completed'] },
  ]);

  const { refreshModel: _, ...without } = ids;
  const noModel = buildPipeline(template, { workspaceId: WS, notebookIds: without, modules });
  assert.equal(findActivity(noModel.properties.activities, REFRESH_ACTIVITY), undefined, 'no model, no refresh step');
});

/* ---------- Cards ---------- */

test('classifyFailure names the usual reasons in plain words', () => {
  assert.equal(classifyFailure({ errorCode: '430', message: 'x' }).kind, 'capacity');
  assert.equal(classifyFailure(BUSY).kind, 'capacity');
  assert.equal(classifyFailure({ message: 'AADSTS7000215: Invalid client secret' }).kind, 'signIn');
  assert.equal(classifyFailure({ errorCode: '2011', message: 'Forbidden' }).kind, 'signIn');
  assert.equal(classifyFailure({ message: 'The activity timed out' }).kind, 'timeout');
  const lag = classifyFailure({ errorCode: '2011', message: "RuntimeError: The refresh ended as Failed. Table 'copilot_interactions_curated' is not in database" });
  assert.equal(lag.kind, 'notSynced');
  assert.ok(lag.fix.includes(RERUN));
  const other = classifyFailure({ message: 'KeyError: tenant\n  at line 3' });
  assert.equal(other.kind, 'other');
  assert.equal(other.text, 'It stopped with an error: KeyError: tenant');
  assert.equal(classifyFailure(null).text, 'It stopped without saying why.');
  assert.ok(other.fix.includes(RERUN));
});

test('conditionMet follows Fabric dependency rules', () => {
  assert.equal(conditionMet('Succeeded', ['Succeeded']), true);
  assert.equal(conditionMet('Failed', ['Succeeded']), false);
  assert.equal(conditionMet('Failed', ['Completed']), true);
  assert.equal(conditionMet(undefined, ['Completed']), false);
  assert.equal(conditionMet(undefined, ['Completed', 'Skipped']), true);
  assert.equal(conditionMet('TimedOut', ['Failed']), true);
});

test('loadCards: one card per source, in plain words; a switched-off source is left out, and a step that never started says what it waited for', () => {
  const acts = build().properties.activities;
  const cards = loadCards(
    runsOf({
      [AUDIT_ACTIVITY]: 'Succeeded',
      [LICENSED_ACTIVITY]: ['Failed', BUSY],
      [ORG_BRANCH]: 'Succeeded',
      [ORG_ACTIVITY]: 'Succeeded',
      [REFRESH_ACTIVITY]: 'Succeeded',
    }),
    acts,
  );
  assert.deepEqual(cards.map((c) => [c.name, c.state]), [
    ['Copilot audit log', 'ok'],
    ['Licensed users', 'failed'],
    ['Org data', 'ok'],
    ['AI in One model refresh', 'ok'],
  ]);
  assert.equal(cards[1].kind, 'capacity');
  assert.ok(cards[1].fix[0].includes(RERUN));
  assert.deepEqual(failedCards(cards).map((c) => c.activity), [LICENSED_ACTIVITY]);

  const stopped = loadCards(
    runsOf({
      [AUDIT_ACTIVITY]: ['Failed', { message: 'AADSTS7000215: Invalid client secret' }],
      [LICENSED_ACTIVITY]: 'Succeeded',
      [ORG_BRANCH]: 'Succeeded',
    }),
    acts,
  );
  const by = Object.fromEntries(stopped.map((c) => [c.activity, c]));
  assert.equal(by[AUDIT_ACTIVITY].kind, 'signIn');
  assert.equal(by[ORG_ACTIVITY], undefined, 'its condition chose the empty branch');
  assert.equal(by[ORG_BRANCH], undefined, 'a condition is not a source');
  assert.equal(by[REFRESH_ACTIVITY].state, 'skipped');
  assert.match(by[REFRESH_ACTIVITY].reason ?? '', /waits for: Copilot audit log\./);
  assert.deepEqual(failedCards(stopped).map((c) => c.activity), [AUDIT_ACTIVITY]);
});

test('fillRerun capitalises the instruction at the start of a sentence', () => {
  assert.equal(fillRerun(`${RERUN}. Or wait.`, 'run "x rerun-failed"'), 'Run "x rerun-failed". Or wait.');
  assert.equal(fillRerun(`Fix it. ${RERUN}.`, 'run it'), 'Fix it. Run it.');
  assert.equal(fillRerun(`Fix it, then ${RERUN}.`, 'run it'), 'Fix it, then run it.');
});

test('terminal: a failed load shows its reason and what to do; a step that never ran says it was skipped', () => {
  /** @type {string[]} */
  const out = [];
  createUi({ write: (s) => out.push(s) }).loads([
    { activity: LICENSED_ACTIVITY, name: 'Licensed users', state: 'failed', reason: "Fabric's capacity was too busy to start it.", fix: ['Run it again later.'], attempts: 3 },
    { activity: REFRESH_ACTIVITY, name: 'AI in One model refresh', state: 'skipped', reason: "It didn't run, because it waits for: Copilot audit log.", fix: [] },
  ]);
  const text = out.join('');
  assert.match(text, /✗ Licensed users: failed \(3 attempts\)/);
  assert.match(text, /capacity was too busy to start it/);
  assert.match(text, /Run it again later\./);
  assert.match(text, /! AI in One model refresh: skipped/);
});

/* ---------- Rerun ---------- */

test('evaluate reads the expressions the pipeline uses', () => {
  const p = { EnableOrgDataPull: true, AuditMode: 'Backfill', BackfillDays: 90 };
  assert.equal(evaluate('@pipeline().parameters.EnableOrgDataPull', p), true);
  assert.equal(evaluate("@equals(pipeline().parameters.AuditMode, 'backfill')", p), true);
  assert.equal(evaluate("@if(equals(pipeline().parameters.AuditMode,'incremental'), 1, pipeline().parameters.BackfillDays)", p), 90);
  assert.equal(evaluate('@and(true, not(false))', p), true);
  assert.equal(evaluate('@or(false, false)', p), false);
  assert.equal(evaluate("@string('it''s')", p), "it's");
  assert.throws(() => evaluate('@pipeline().RunId', p), /can't fill in pipeline\(\)\.RunId/);
  assert.throws(() => evaluate('@pipeline().parameters.Nope', p), /no parameter Nope/);
  assert.throws(() => evaluate('@concat(1)', p), /can't evaluate concat/);
});

test('dependencyOrder puts each step after what it waits for', () => {
  const order = dependencyOrder([
    { name: 'c', dependsOn: [{ activity: 'b' }] },
    { name: 'b', dependsOn: [{ activity: 'a' }] },
    { name: 'a' },
  ]).map((a) => a.name);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('rerunSteps reruns the failed load and the model refresh that waited for it, but not what worked', async () => {
  const doc = build();
  const params = runParameters(doc, /** @type {any} */ ({ firstRun: undefined }), 'job-1');
  const runs = runsOf({
    [AUDIT_ACTIVITY]: ['Failed', BUSY],
    [LICENSED_ACTIVITY]: 'Succeeded',
    [ORG_BRANCH]: 'Succeeded',
    [ORG_ACTIVITY]: 'Succeeded',
  });
  /** @type {string[]} */
  const ran = [];
  /** @type {Record<string, any>} */
  const given = {};
  const result = await rerunSteps(doc.properties.activities, runs, params, async (a, parameters) => {
    ran.push(a.name);
    given[a.name] = parameters;
    return { status: 'Succeeded' };
  });
  assert.deepEqual(ran, [AUDIT_ACTIVITY, REFRESH_ACTIVITY]);
  assert.deepEqual(result.reran, ran);
  assert.equal(given[AUDIT_ACTIVITY]?.MODE?.value, 'incremental', 'expressions are filled in from the run parameters');
  assert.equal(given[AUDIT_ACTIVITY]?.BACKFILL_DAYS?.value, 30);
  assert.equal(given[REFRESH_ACTIVITY]?.SEMANTIC_MODEL_ID?.value, 'model-1');
  assert.equal(result.runs.get(AUDIT_ACTIVITY).status, 'Succeeded');
});

test('rerunSteps runs a condition branch, and marks steps whose loads still fail as skipped', async () => {
  const doc = build();
  const params = runParameters(doc, /** @type {any} */ ({}), 'job-1');
  const runs = runsOf({
    [AUDIT_ACTIVITY]: ['Failed', BUSY],
    [LICENSED_ACTIVITY]: 'Succeeded',
    [ORG_BRANCH]: 'Failed',
    [ORG_ACTIVITY]: ['Failed', { message: 'Forbidden' }],
  });
  /** @type {string[]} */
  const ran = [];
  const result = await rerunSteps(doc.properties.activities, runs, params, async (a) => {
    ran.push(a.name);
    return a.name === AUDIT_ACTIVITY ? { status: 'Failed', error: BUSY } : { status: 'Succeeded' };
  });
  assert.deepEqual(ran, [AUDIT_ACTIVITY, ORG_ACTIVITY], 'the condition is evaluated and its branch run');
  assert.equal(result.runs.get(ORG_BRANCH).status, 'Succeeded');
  assert.equal(result.runs.get(REFRESH_ACTIVITY).status, 'Skipped');
});

test('rerunSteps refreshes the model again after rerunning a licence load it reads, though the refresh waits on it only through lane 2', async () => {
  const doc = build();
  const runs = runsOf({
    [AUDIT_ACTIVITY]: 'Succeeded',
    [LICENSED_ACTIVITY]: ['Failed', BUSY],
    [ORG_BRANCH]: 'Succeeded',
    [ORG_ACTIVITY]: 'Succeeded',
    [REFRESH_ACTIVITY]: 'Succeeded',
  });
  /** @type {string[]} */
  const ran = [];
  await rerunSteps(doc.properties.activities, runs, runParameters(doc, /** @type {any} */ ({}), 'job-1'), async (a) => {
    ran.push(a.name);
    return { status: 'Succeeded' };
  });
  assert.deepEqual(ran, [LICENSED_ACTIVITY, REFRESH_ACTIVITY]);
});

test('runParameters uses the first load history for the first-load job', () => {
  const doc = build();
  const config = /** @type {any} */ ({ firstRun: { jobId: 'job-1' }, history: { days: 30 } });
  assert.equal(runParameters(doc, config, 'job-1').AuditMode, 'backfill');
  assert.equal(runParameters(doc, config, 'job-1').BackfillDays, 30);
  assert.equal(runParameters(doc, config, 'job-2').AuditMode, 'incremental');
  assert.equal(runParameters(doc, config, 'job-2').EnableOrgDataPull, true, 'org data is always on');
});

/** A workspace whose latest pipeline run left the audit log unloaded, so the model refresh never ran. */
function failedRun() {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config, sleeps } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  const pipe = fabric.add('DataPipeline', PIPELINE_NAME, build({ workspaceId: 'ws-1' }));
  config.fabric.pipelineId = pipe.id;
  fabric.jobList.push({ id: 'j-1', status: 'Failed', startTimeUtc: '2026-06-01T02:00:00', endTimeUtc: '2026-06-01T03:00:00' });
  const ran = (/** @type {string} */ activityName, /** @type {string} */ status = 'Succeeded', /** @type {any} */ error = undefined) => ({
    activityName,
    activityType: activityName.startsWith('Conditionally_') ? 'IfCondition' : 'TridentNotebook',
    status,
    activityRunStart: '2026-06-01T02:00:00Z',
    error,
  });
  fabric.activityRuns['j-1'] = [ran(AUDIT_ACTIVITY, 'Failed', BUSY), ran(LICENSED_ACTIVITY), ran(ORG_BRANCH), ran(ORG_ACTIVITY)];
  // A test that starts more jobs than it planned for fails instead of polling forever.
  const getJob = fabric.api.getJob;
  fabric.api.getJob = async () => {
    if (!fabric.jobs.length) throw new Error('no job status left in the fake');
    return getJob();
  };
  return { fabric, ui, ctx, config, sleeps };
}

test('rerun-failed: a busy capacity is waited out, then the model refresh runs', async () => {
  const { fabric, ui, ctx, sleeps } = failedRun();
  // The audit log: busy, then loads. The model refresh runs first time.
  fabric.jobs.push({ status: 'Failed', failureReason: BUSY }, { status: 'Completed' }, { status: 'Completed' });
  const result = await rerunFailed(ctx);
  assert.deepEqual(result.reran, [AUDIT_ACTIVITY, REFRESH_ACTIVITY]);
  assert.deepEqual(result.failed, []);
  assert.ok(sleeps.includes(BUSY_WAIT_MS));
  const text = ui.text();
  assert.match(text, /capacity is busy\. Trying again in 5 minutes/);
  assert.match(text, /Copilot audit log: loaded/);
  assert.match(text, /AI in One model refresh: loaded/);
  assert.match(text, /Now, by source/);
  const runs = fabric.calls.filter((c) => c.startsWith('runJob'));
  assert.equal(runs.length, 3, 'one extra start for the busy retry');
  assert.match(runs[2], /^runJob RunNotebook/, 'the model refresh is a notebook');
});

test('rerun-failed gives up after the busy retries and says so', async () => {
  const { fabric, ctx } = failedRun();
  for (let i = 0; i <= BUSY_RETRIES; i++) fabric.jobs.push({ status: 'Failed', failureReason: BUSY });
  const result = await rerunFailed(ctx);
  assert.deepEqual(result.reran, [AUDIT_ACTIVITY]);
  assert.deepEqual(result.failed, [AUDIT_ACTIVITY]);
});

test("rerun-failed doesn't run anything while the pipeline is running", async () => {
  const { fabric, ui, ctx } = failedRun();
  fabric.jobList.push({ id: 'j-2', status: 'InProgress', startTimeUtc: '2026-06-01T11:30:00' });
  assert.deepEqual(await rerunFailed(ctx), { reran: [], failed: [] });
  assert.deepEqual(fabric.calls, []);
  assert.match(ui.text(), /pipeline is running/);
});

/* ---------- Shared Spark session ---------- */

test('ensureSparkSettings turns on high concurrency for pipelines once', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureSparkSettings(ctx);
  assert.deepEqual(fabric.calls, ['updateSparkSettings {"highConcurrency":{"notebookPipelineRunEnabled":true}}']);
  assert.equal(fabric.spark.highConcurrency.notebookInteractiveRunEnabled, true, 'other settings are left alone');
  await ensureSparkSettings(ctx);
  assert.equal(fabric.calls.length, 1, 'already on');
  assert.match(ui.text(), /share one Spark session/);
});

test('ensureSparkSettings only warns when it may not change the setting', async () => {
  const fabric = fakeFabric();
  fabric.failures.updateSparkSettings = [new HttpError('Forbidden', { status: 403, method: 'PATCH', url: '/spark/settings' })];
  const ui = fakeUi();
  const { ctx } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureSparkSettings(ctx);
  assert.match(ui.text(), /needs the workspace Admin role/);
  assert.match(ui.text(), /High concurrency/);
});
