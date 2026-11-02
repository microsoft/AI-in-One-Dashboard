// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PIPELINE_TEMPLATE } from '../src/sources.js';
import {
  AUDIT_ACTIVITY,
  buildPipeline,
  chainLanes,
  findActivity,
  firstRunParameters,
  LANE_ORDER,
  LICENSED_ACTIVITY,
  ORG_ACTIVITY,
  ORG_BRANCH,
  ORG_PARAMETER,
  REFRESH_ACTIVITY,
  RETRY_INTERVAL_SECONDS,
  retryPolicy,
  RUN_PARAMETERS,
  SCALE_PROFILES,
  scaleProfile,
  SESSION_TAG,
} from '../src/transform/pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The Classic Fabric edition's pipeline, which the installer deploys from. */
const template = JSON.parse(readFileSync(join(here, '..', '..', PIPELINE_TEMPLATE), 'utf8'));

const WS = 'f0000000-0000-0000-0000-000000000000';
const MODEL = 'm0000000-0000-0000-0000-000000000000';
const ids = {
  auditIngester: '00000000-0000-0000-0000-00000000000a',
  licensedUsers: '00000000-0000-0000-0000-00000000000b',
  orgData: '00000000-0000-0000-0000-00000000000c',
  dataCheck: '00000000-0000-0000-0000-00000000000d',
  refreshModel: '00000000-0000-0000-0000-00000000000e',
};
const modules = { orgData: true };

/** @param {Partial<import('../src/transform/pipeline.js').PipelineSettings>} [over] */
const build = (over = {}) => buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules, ...over });

/** @param {any} doc */
const names = (doc) => doc.properties.activities.map((/** @type {any} */ a) => a.name);
/** @param {any} activity */
const after = (activity) => (activity.dependsOn ?? []).map((/** @type {any} */ d) => `${d.activity}:${d.dependencyConditions.join(',')}`);

/**
 * Every notebook activity, including those inside If Condition branches.
 * @param {any[]} activities
 * @returns {any[]}
 */
const notebooks = (activities) => activities.flatMap((a) => [
  ...(a.type === 'TridentNotebook' ? [a] : []),
  ...notebooks([...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])]),
]);

/** A d.hh:mm:ss time limit in minutes. @param {string} t */
const limitMinutes = (t) => {
  const [, d, h, m] = /** @type {RegExpExecArray} */ (/^(\d+)\.(\d{2}):(\d{2}):\d{2}$/.exec(t));
  return (Number(d) * 24 + Number(h)) * 60 + Number(m);
};

test('the template: the audit log, licences and org data loads, with org data in a switchable branch', () => {
  assert.deepEqual(names(template), [AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_BRANCH]);
  assert.equal(findActivity(template.properties.activities, ORG_ACTIVITY).typeProperties.notebookId, 'REPLACE_WITH_ORG_DATA_NOTEBOOK_ID', 'found inside the branch');
  assert.equal(findActivity(template.properties.activities, 'Nope'), undefined);
  assert.ok(template.properties.parameters[ORG_PARAMETER]);
});

test('IDs are filled in everywhere, org data is always switched on, and the template is untouched', () => {
  const before = JSON.stringify(template);
  const off = structuredClone(template);
  off.properties.parameters[ORG_PARAMETER].defaultValue = false;
  for (const doc of [build(), buildPipeline(off, { workspaceId: WS, notebookIds: ids, modules })]) {
    assert.deepEqual(names(doc), [AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_BRANCH], 'no refresh step without a semantic model');
    assert.doesNotMatch(JSON.stringify(doc), /REPLACE_WITH_/);
    const acts = doc.properties.activities;
    assert.equal(findActivity(acts, AUDIT_ACTIVITY).typeProperties.notebookId, ids.auditIngester);
    assert.equal(findActivity(acts, LICENSED_ACTIVITY).typeProperties.notebookId, ids.licensedUsers);
    assert.equal(findActivity(acts, ORG_ACTIVITY).typeProperties.notebookId, ids.orgData);
    for (const nb of notebooks(acts)) assert.equal(nb.typeProperties.workspaceId, WS, nb.name);
    assert.deepEqual(Object.keys(doc.properties.parameters).sort(), ['AuditMode', 'BackfillDays', ORG_PARAMETER]);
    assert.equal(doc.properties.parameters[ORG_PARAMETER].defaultValue, true, "the model's org table reads it");
  }
  assert.equal(JSON.stringify(template), before);
  assert.equal(off.properties.parameters[ORG_PARAMETER].defaultValue, false, 'the copy it was given is untouched too');
});

test('a template or notebook the pipeline needs that is missing is an error', () => {
  const { orgData, ...noOrg } = ids;
  assert.throws(() => build({ notebookIds: noOrg }), /Pipeline still has placeholders: REPLACE_WITH_ORG_DATA_NOTEBOOK_ID/);
  const { refreshModel, ...noRefresh } = ids;
  assert.throws(() => build({ notebookIds: noRefresh, semanticModelId: MODEL }), /The semantic model refresh notebook has not been deployed/);
  assert.doesNotThrow(() => build({ notebookIds: noRefresh }), 'not needed without a semantic model');

  assert.throws(() => buildPipeline({ properties: {} }, { workspaceId: WS, notebookIds: ids, modules }), /Pipeline template has no activities/);
  const noSwitch = structuredClone(template);
  delete noSwitch.properties.parameters[ORG_PARAMETER];
  assert.throws(() => buildPipeline(noSwitch, { workspaceId: WS, notebookIds: ids, modules }), /missing the EnableOrgDataPull parameter/);
  const noAudit = structuredClone(template);
  noAudit.properties.activities = noAudit.properties.activities.filter((/** @type {any} */ a) => a.name !== AUDIT_ACTIVITY);
  assert.throws(() => buildPipeline(noAudit, { workspaceId: WS, notebookIds: ids, modules }), /Pipeline template is missing Run_Audit_Log_Ingester/);
});

test('the audit load takes its mode and days from pipeline parameters, which default to an incremental load', () => {
  const doc = build();
  const audit = findActivity(doc.properties.activities, AUDIT_ACTIVITY);
  assert.deepEqual(audit.typeProperties.parameters, {
    MODE: { value: { value: '@pipeline().parameters.AuditMode', type: 'Expression' }, type: 'string' },
    BACKFILL_DAYS: { value: { value: '@pipeline().parameters.BackfillDays', type: 'Expression' }, type: 'int' },
  }, 'nothing else: its window size stays as the notebook has it');
  assert.deepEqual(doc.properties.parameters.AuditMode, { type: 'String', defaultValue: 'incremental' });
  assert.deepEqual(doc.properties.parameters.BackfillDays, { type: 'Int', defaultValue: 30 });
  assert.equal(build({ backfillDays: 90 }).properties.parameters.BackfillDays.defaultValue, 90);
  assert.deepEqual(RUN_PARAMETERS.BackfillDays, { type: 'Int', defaultValue: 30 }, 'the shared default is untouched');
  for (const name of [LICENSED_ACTIVITY, ORG_ACTIVITY]) assert.deepEqual(findActivity(doc.properties.activities, name).typeProperties.parameters ?? {}, {}, `${name} takes none`);
});

test('the first run, and a reload, backfills: it replaces the audit rows from its first day on and keeps older rows', () => {
  assert.deepEqual(firstRunParameters(180), { AuditMode: 'backfill', BackfillDays: 180 });
  assert.deepEqual(firstRunParameters(30), { AuditMode: 'backfill', BackfillDays: 30 });
});

test('a standard tenant keeps the template time limits; a large one gets longer ones for the loads and the refresh', () => {
  const timeout = (/** @type {any} */ doc, /** @type {string} */ name) => findActivity(doc.properties.activities, name).policy.timeout;
  const minutes = (/** @type {any} */ doc) => findActivity(doc.properties.activities, REFRESH_ACTIVITY).typeProperties.parameters.TIMEOUT_MINUTES;

  for (const scale of /** @type {const} */ ([undefined, 'standard'])) {
    const doc = build({ scale, semanticModelId: MODEL });
    for (const name of [AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_ACTIVITY]) {
      assert.equal(timeout(doc, name), findActivity(template.properties.activities, name).policy.timeout, `${name} (${scale})`);
    }
    assert.equal(timeout(doc, AUDIT_ACTIVITY), '0.02:00:00');
    assert.equal(timeout(doc, REFRESH_ACTIVITY), '0.03:00:00');
    assert.deepEqual(minutes(doc), { value: 170, type: 'int' });
  }

  const large = build({ scale: 'large', semanticModelId: MODEL });
  assert.equal(timeout(large, AUDIT_ACTIVITY), '0.06:00:00');
  assert.equal(timeout(large, LICENSED_ACTIVITY), '0.00:30:00');
  assert.equal(timeout(large, ORG_ACTIVITY), '0.01:00:00');
  assert.equal(timeout(large, REFRESH_ACTIVITY), '0.05:00:00');
  assert.deepEqual(minutes(large), { value: 290, type: 'int' });
  assert.deepEqual(findActivity(large.properties.activities, AUDIT_ACTIVITY).typeProperties.parameters, findActivity(build().properties.activities, AUDIT_ACTIVITY).typeProperties.parameters, 'the size changes only time limits');

  assert.equal(scaleProfile(undefined), SCALE_PROFILES.standard);
  assert.equal(scaleProfile('large'), SCALE_PROFILES.large);
  assert.deepEqual(SCALE_PROFILES.standard.timeouts, {});
  for (const profile of Object.values(SCALE_PROFILES)) {
    assert.ok(profile.refresh.minutes < limitMinutes(profile.refresh.timeout), 'the notebook stops waiting before the step times out');
  }
});

test('lanes: the audit log loads in lane 1 while licences, then org data, load in lane 2', () => {
  const acts = build().properties.activities;
  assert.deepEqual(LANE_ORDER, [LICENSED_ACTIVITY, ORG_BRANCH]);
  assert.deepEqual(after(findActivity(acts, AUDIT_ACTIVITY)), []);
  assert.deepEqual(after(findActivity(acts, LICENSED_ACTIVITY)), []);
  assert.deepEqual(after(findActivity(acts, ORG_BRANCH)), [`${LICENSED_ACTIVITY}:Completed`], 'whether the licence load succeeded or failed');
  assert.ok(template.properties.activities.every((/** @type {any} */ a) => !a.dependsOn?.length), 'the template runs all three at once');

  /** @type {any[]} */
  const orgOnly = [{ name: AUDIT_ACTIVITY, dependsOn: [] }, { name: ORG_BRANCH, dependsOn: [{ activity: 'x', dependencyConditions: ['Succeeded'] }] }];
  chainLanes(orgOnly);
  assert.deepEqual(orgOnly[1].dependsOn, [], 'a missing step is skipped over');
  assert.deepEqual(orgOnly[0].dependsOn, [], 'lane 1 is left alone');
});

test('the refresh step comes last: after the audit log loaded and lane 2 had its turn', () => {
  const doc = build({ semanticModelId: MODEL });
  assert.deepEqual(names(doc), [AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_BRANCH, REFRESH_ACTIVITY]);
  const refresh = findActivity(doc.properties.activities, REFRESH_ACTIVITY);
  assert.equal(refresh.type, 'TridentNotebook');
  assert.deepEqual(after(refresh), [`${AUDIT_ACTIVITY}:Succeeded`, `${ORG_BRANCH}:Completed`]);
  assert.equal(refresh.typeProperties.notebookId, ids.refreshModel);
  assert.equal(refresh.typeProperties.workspaceId, WS);
  assert.deepEqual(refresh.typeProperties.parameters.WORKSPACE_ID, { value: WS, type: 'string' });
  assert.deepEqual(refresh.typeProperties.parameters.SEMANTIC_MODEL_ID, { value: MODEL, type: 'string' });
  assert.equal(refresh.policy.retry, 0, 'a refresh is not retried within the run');
  assert.match(refresh.description, /Refreshes the AI in One semantic model/);

  const noOrg = structuredClone(template);
  noOrg.properties.activities = noOrg.properties.activities.filter((/** @type {any} */ a) => a.name !== ORG_BRANCH);
  const short = buildPipeline(noOrg, { workspaceId: WS, notebookIds: ids, modules, semanticModelId: MODEL });
  assert.deepEqual(after(findActivity(short.properties.activities, REFRESH_ACTIVITY)), [`${AUDIT_ACTIVITY}:Succeeded`, `${LICENSED_ACTIVITY}:Completed`], 'after the last lane 2 step there is');
});

test('every notebook, in a branch or not, shares one Spark session', () => {
  assert.match(SESSION_TAG, /^[A-Za-z0-9_]+$/, 'letters, digits and underscores only');
  assert.equal(SESSION_TAG, 'ai_in_one');
  const tagged = notebooks(build({ semanticModelId: MODEL }).properties.activities);
  assert.deepEqual(tagged.map((a) => a.name).sort(), [AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_ACTIVITY, REFRESH_ACTIVITY].sort());
  for (const a of tagged) assert.equal(a.typeProperties.sessionTag, SESSION_TAG, a.name);
  assert.equal(findActivity(build().properties.activities, ORG_BRANCH).typeProperties.sessionTag, undefined, 'only notebooks are tagged');
});

test('retries: a load of an hour or more retries twice, a shorter one three times, 5 minutes apart', () => {
  assert.equal(RETRY_INTERVAL_SECONDS, 300);
  assert.deepEqual(retryPolicy('0.02:00:00'), { retry: 2, retryIntervalInSeconds: 300 });
  assert.deepEqual(retryPolicy('0.01:00:00'), { retry: 2, retryIntervalInSeconds: 300 });
  assert.deepEqual(retryPolicy('1.00:00:00'), { retry: 2, retryIntervalInSeconds: 300 });
  assert.deepEqual(retryPolicy('0.00:59:59'), { retry: 3, retryIntervalInSeconds: 300 });
  assert.deepEqual(retryPolicy('0.00:15:00'), { retry: 3, retryIntervalInSeconds: 300 });
  assert.deepEqual(retryPolicy('00:30:00'), { retry: 3, retryIntervalInSeconds: 300 });
  assert.deepEqual(retryPolicy(undefined), { retry: 2, retryIntervalInSeconds: 300 }, 'no time limit counts as long');

  const policy = (/** @type {any} */ doc, /** @type {string} */ name) => findActivity(doc.properties.activities, name).policy;
  const standard = build();
  assert.deepEqual([AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_ACTIVITY].map((n) => policy(standard, n).retry), [2, 3, 3]);
  const large = build({ scale: 'large' });
  assert.deepEqual([AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_ACTIVITY].map((n) => policy(large, n).retry), [2, 3, 2], 'the org load runs for up to an hour in a large tenant');
  for (const doc of [standard, large]) {
    for (const n of [AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_ACTIVITY]) {
      assert.equal(policy(doc, n).retryIntervalInSeconds, 300, n);
      assert.equal(policy(doc, n).secureInput, false, `${n} keeps the template's other settings`);
    }
  }
});

test('the description says what the installer built', () => {
  const withModel = build({ semanticModelId: MODEL }).properties.description;
  assert.match(withModel, /^Created by the AI in One installer\./);
  assert.match(withModel, /Lane 1 loads the audit log, then refreshes the semantic model\./);
  assert.match(withModel, /Lane 2 loads licences, then org data; a load that fails doesn't stop the next or the model refresh/);
  assert.match(withModel, /Each load retries up to 3 times, 5 minutes apart\./);
  assert.match(withModel, /The first run overrides them with AuditMode=backfill\./);
  const without = build().properties.description;
  assert.match(without, /Lane 1 loads the audit log\./);
  assert.doesNotMatch(without, /semantic model/);
});
