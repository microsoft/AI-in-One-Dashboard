// @ts-check
/**
 * `rerun-failed`: runs again only the loads that failed in the latest pipeline run, and the steps
 * that were skipped because of them, one at a time in the pipeline's order. Fabric can't rerun a
 * pipeline from its failed step, so each notebook is started on its own.
 */
import { commandLine } from '../launch.js';
import { conditionMet, failedCards, loadLabel } from '../loads.js';
import { buildPipeline, firstRunParameters, REFRESH_ACTIVITY } from '../transform/pipeline.js';
import { pipelineSettings } from './fabric.js';
import { activityRuns, BUSY_RETRIES, BUSY_WAIT_MS, capacityBusy, jobIdFrom, loadedBy, reportLoads, TERMINAL, utc, waitForJob } from './run.js';

/** @typedef {import('../install.js').Ctx} Ctx */

/**
 * The steps whose output an activity reads: the model refresh reads every step it waits for,
 * directly or through the steps before it. It waits on the licence load only through lane 2's chain.
 * @param {any} a
 * @param {Map<string, any>} byName  Top-level activities by name.
 * @returns {string[]}
 */
function readsFrom(a, byName) {
  if (a.name !== REFRESH_ACTIVITY) return [];
  /** @type {Set<string>} */
  const seen = new Set();
  const visit = (/** @type {any} */ x) => {
    for (const d of x?.dependsOn ?? []) {
      if (seen.has(d.activity)) continue;
      seen.add(d.activity);
      visit(byName.get(d.activity));
    }
  };
  visit(a);
  return [...seen];
}
/** Times a step turned away by a busy capacity is tried again, and how long to wait first. */
export { BUSY_RETRIES, BUSY_WAIT_MS };
const STUCK_MS = 24 * 3_600_000;

/**
 * Evaluates the few pipeline expressions the AI in One pipeline uses: `pipeline().parameters.X`,
 * `if`, `equals`, `not`, `and`, `or`, `string`, and number, string and boolean literals.
 * @param {string} text  With or without the leading `@`.
 * @param {Record<string, any>} params
 * @returns {any}
 */
export function evaluate(text, params) {
  const src = text.replace(/^@/, '');
  let i = 0;
  const ws = () => {
    while (/\s/.test(src[i] ?? '')) i++;
  };
  const expect = (/** @type {string} */ ch) => {
    ws();
    if (src[i] !== ch) throw new Error(`Can't read the pipeline expression "${text}".`);
    i++;
  };
  /** @returns {any} */
  const value = () => {
    ws();
    if (src[i] === "'") {
      let out = '';
      for (i++; i < src.length; i++) {
        if (src[i] === "'" && src[i + 1] === "'") out += src[i++];
        else if (src[i] === "'") break;
        else out += src[i];
      }
      i++;
      return out;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!id) throw new Error(`Can't read the pipeline expression "${text}".`);
    i += id[0].length;
    const name = id[0];
    if (name === 'true' || name === 'false') return name === 'true';
    expect('(');
    /** @type {any[]} */
    const args = [];
    ws();
    if (src[i] !== ')') {
      for (;;) {
        args.push(value());
        ws();
        if (src[i] === ',') i++;
        else break;
      }
    }
    expect(')');
    if (name === 'pipeline') {
      const path = /^\.([A-Za-z]+)(?:\.([A-Za-z0-9_]+))?/.exec(src.slice(i));
      if (!path) throw new Error(`Can't read the pipeline expression "${text}".`);
      i += path[0].length;
      if (path[1] === 'parameters' && path[2]) {
        if (!(path[2] in params)) throw new Error(`The pipeline has no parameter ${path[2]}.`);
        return params[path[2]];
      }
      throw new Error(`The rerun can't fill in pipeline().${path[1]}.`);
    }
    switch (name) {
      case 'if':
        return args[0] ? args[1] : args[2];
      case 'equals':
        return String(args[0]).toLowerCase() === String(args[1]).toLowerCase();
      case 'not':
        return !args[0];
      case 'and':
        return args.every(Boolean);
      case 'or':
        return args.some(Boolean);
      case 'string':
        return String(args[0]);
      default:
        throw new Error(`The rerun can't evaluate ${name}() in "${text}".`);
    }
  };
  const out = value();
  ws();
  if (i < src.length) throw new Error(`Can't read the pipeline expression "${text}".`);
  return out;
}

/**
 * A notebook parameter's value: typed Expression objects and `@` strings are evaluated.
 * @param {any} v
 * @param {Record<string, any>} params
 */
const resolve = (v, params) => {
  if (v && typeof v === 'object' && v.type === 'Expression') return evaluate(String(v.value), params);
  if (typeof v === 'string' && v.startsWith('@') && !v.startsWith('@@')) return evaluate(v, params);
  return v;
};

/**
 * The activities in an order that runs every one after what it depends on.
 * @param {any[]} activities
 */
export function dependencyOrder(activities) {
  const byName = new Map(activities.map((a) => [a.name, a]));
  /** @type {any[]} */
  const out = [];
  const seen = new Set();
  const visit = (/** @type {any} */ a) => {
    if (seen.has(a.name)) return;
    seen.add(a.name);
    for (const d of a.dependsOn ?? []) if (byName.has(d.activity)) visit(byName.get(d.activity));
    out.push(a);
  };
  activities.forEach(visit);
  return out;
}

/** @param {any} a */
const branch = (a, /** @type {boolean} */ which) => (which ? a.typeProperties?.ifTrueActivities : a.typeProperties?.ifFalseActivities) ?? [];

/**
 * @typedef {object} StepResult
 * @property {'Succeeded' | 'Failed'} status
 * @property {{ errorCode?: string, message?: string }} [error]
 */

/**
 * @typedef {(activity: any, parameters: Record<string, { value: any, type: string }> | undefined) => Promise<StepResult>} Execute
 */

/**
 * Works out what to run again and runs it, step by step. A step reruns when it didn't succeed and
 * what it waits for now holds. The model refresh also reruns, even after succeeding, when a step it
 * waits for, directly or through lane 2, freshly reran, because it reads what they load. A step
 * whose dependencies still fail is marked skipped.
 * @param {any[]} activities  Top-level activities of the pipeline.
 * @param {Map<string, any>} runs  The last attempt of each activity in the run being repaired.
 * @param {Record<string, any>} params  The run's pipeline parameters.
 * @param {Execute} execute
 * @param {(name: string) => void} [onStart]
 * @returns {Promise<{ runs: Map<string, any>, reran: string[] }>}
 */
export async function rerunSteps(activities, runs, params, execute, onStart = () => {}) {
  const merged = new Map(runs);
  const byName = new Map(activities.map((a) => [a.name, a]));
  /** @type {string[]} */
  const reran = [];
  const statusOf = (/** @type {string} */ name) => merged.get(name)?.status ?? 'Skipped';
  const set = (/** @type {any} */ a, /** @type {StepResult | { status: 'Skipped' }} */ r) =>
    merged.set(a.name, { activityName: a.name, activityType: a.type, status: r.status, error: 'error' in r ? r.error : undefined, attempts: 1 });

  /** @param {any} a @returns {Promise<StepResult>} */
  const runOne = async (a) => {
    onStart(a.name);
    const parameters = a.typeProperties?.parameters
      ? Object.fromEntries(Object.entries(a.typeProperties.parameters).map(([k, p]) => [k, { value: resolve(/** @type {any} */ (p).value, params), type: /** @type {any} */ (p).type ?? 'string' }]))
      : undefined;
    const result = await execute(a, parameters);
    set(a, result);
    reran.push(a.name);
    return result;
  };

  for (const a of dependencyOrder(activities)) {
    const deps = a.dependsOn ?? [];
    const met = deps.every((/** @type {any} */ d) => conditionMet(statusOf(d.activity), d.dependencyConditions ?? ['Succeeded']));
    const freshInput = readsFrom(a, byName).some((n) => reran.includes(n) && statusOf(n) === 'Succeeded');
    const isOk = statusOf(a.name) === 'Succeeded';
    if (isOk && !freshInput) continue;
    if (!met) {
      if (!isOk) set(a, { status: 'Skipped' });
      continue;
    }
    if (a.type === 'IfCondition') {
      const on = !!resolve(a.typeProperties?.expression, params);
      let failed = false;
      for (const inner of dependencyOrder(branch(a, on))) {
        if (failed) set(inner, { status: 'Skipped' });
        else if ((await runOne(inner)).status !== 'Succeeded') failed = true;
      }
      set(a, { status: failed ? 'Failed' : 'Succeeded' });
      reran.push(a.name);
    } else {
      await runOne(a);
    }
  }
  return { runs: merged, reran };
}

/**
 * The pipeline parameters the run had: the definition's defaults, with the first load's history.
 * @param {any} definition
 * @param {import('../config.js').InstallConfig} config
 * @param {string} jobId
 */
export function runParameters(definition, config, jobId) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, p] of Object.entries(definition?.properties?.parameters ?? {})) out[k] = /** @type {any} */ (p)?.defaultValue;
  return config.firstRun?.jobId === jobId ? { ...out, ...firstRunParameters(config.history.days) } : out;
}

/**
 * The `rerun-failed` command.
 * @param {Ctx} ctx
 * @returns {Promise<{ reran: string[], failed: string[] }>}
 */
export async function rerunFailed(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.pipelineId) throw new Error('There is no pipeline yet. Run the installer first.');
  const ws = f.workspaceId;
  const jobs = (await api.fabric.listJobs(ws, f.pipelineId)).sort((a, b) => String(b.startTimeUtc ?? '').localeCompare(String(a.startTimeUtc ?? '')));
  const running = jobs.find((j) => {
    const started = utc(j.startTimeUtc);
    return (j.status === 'InProgress' || j.status === 'NotStarted') && !(started && ctx.now().getTime() - started.getTime() > STUCK_MS);
  });
  if (running) {
    ui.warn('The pipeline is running, so this didn\'t rerun anything.');
    ui.note(`Once it has finished, run "${commandLine('status')}" to see how it went.`);
    return { reran: [], failed: [] };
  }
  const latest = jobs.find((j) => TERMINAL.has(j.status));
  if (!latest) {
    ui.note(`The pipeline hasn't run yet. Run "${commandLine('run')}" to start it.`);
    return { reran: [], failed: [] };
  }
  const runs = await activityRuns(ctx, latest.id, latest);
  if (!runs) throw new Error('Fabric didn\'t say how the latest run went. Try again in a few minutes.');

  /** @type {any} */
  let definition = await api.fabric.getPipelineDefinition(ws, f.pipelineId).catch(() => null);
  if (!Array.isArray(definition?.properties?.activities)) definition = buildPipeline(ctx.sources.pipeline, pipelineSettings(config));
  const activities = definition.properties.activities;
  const params = runParameters(definition, config, latest.id);

  const when = utc(latest.startTimeUtc)?.toISOString().replace('T', ' ').slice(0, 16);
  ui.heading(`Rerunning what didn't load in the run${when ? ` from ${when} UTC` : ''}`);

  const result = await rerunSteps(activities, runs, params, makeExecutor(ctx));
  if (!result.reran.length) {
    ui.ok('Nothing to rerun: every load in the latest run worked, or was switched off.');
    return { reran: [], failed: [] };
  }
  ui.heading('Now, by source');
  const failed = failedCards(await reportLoads(ctx, result.runs, activities));
  if (config.firstRun?.jobId === latest.id && config.firstRun?.status !== 'Completed' && loadedBy(config, result.runs)) {
    config.firstRun = { ...config.firstRun, status: 'Completed' };
    ctx.save();
  }
  return { reran: result.reran, failed: failed.map((c) => c.activity) };
}

/**
 * Runs one notebook as its own job and waits for it, trying again while Fabric's capacity is too
 * busy to start it.
 * @param {Ctx} ctx
 * @returns {Execute}
 */
export function makeExecutor(ctx) {
  const { ui, api } = ctx;
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  return async (a, parameters) => {
    const label = loadLabel(a.name);
    if (a.type !== 'TridentNotebook') {
      ui.warn(`${label}: the installer can't rerun a ${a.type} step. Run the pipeline again instead.`);
      return { status: 'Failed', error: { message: `Can't rerun a ${a.type} step on its own.` } };
    }
    for (let attempt = 0; ; attempt++) {
      const url = await api.fabric.runJob(ws, a.typeProperties.notebookId, 'RunNotebook', parameters ? { parameters } : undefined);
      const done = await waitForJob(ctx, url, label);
      if (done?.status === 'Completed') {
        ui.ok(`${label}: loaded`);
        return { status: 'Succeeded' };
      }
      const error = done?.failureReason ?? { message: TERMINAL.has(done?.status) ? `It ended with status ${done?.status}.` : `It is still running (job ${jobIdFrom(url)}).` };
      if (capacityBusy(error) && attempt < BUSY_RETRIES) {
        ui.warn(`${label}: Fabric's capacity is busy. Trying again in ${BUSY_WAIT_MS / 60_000} minutes.`);
        await ctx.sleep(BUSY_WAIT_MS);
        continue;
      }
      ui.fail(`${label}: failed`);
      return { status: 'Failed', error };
    }
  };
}
