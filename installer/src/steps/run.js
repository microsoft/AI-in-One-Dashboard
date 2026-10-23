// @ts-check
/**
 * Runs the pipeline and the data check, and reports on them. The data check isn't in the pipeline:
 * it runs after the first load, after `run`, and on `check`.
 */
import { isTransientNetworkError } from '../auth.js';
import { commandLine } from '../launch.js';
import { failedCards, fillRerun, loadCards } from '../loads.js';
import { DATA_CHECK_FILE } from '../transform/notebook.js';
import { AUDIT_ACTIVITY, firstRunParameters, REFRESH_ACTIVITY } from '../transform/pipeline.js';
import { formatDuration } from '../ui.js';
import { modelDeployed } from './fabric.js';
import { modelRefreshes } from './model.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../loads.js').LoadCard} LoadCard */

/** Job states after which Fabric does no more work. */
export const TERMINAL = new Set(['Completed', 'Failed', 'Cancelled', 'Deduped', 'Duplicate', 'NotFound', 'OwnerUserMissing', 'DeadLettered']);

export const POLL_MS = 30_000;

/** Polls in a row that may fail on a network blip before watching a job gives up: 20 minutes at POLL_MS. */
export const NETWORK_LOSSES = 40;

/** Fabric sends job times without a zone; they are UTC. @param {string | null | undefined} t */
export function utc(t) {
  if (!t) return undefined;
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`);
}

/** @param {string} url */
export const jobIdFrom = (url) => /** @type {string} */ (new URL(url, 'https://x').pathname.split('/').filter(Boolean).pop());

/**
 * Polls a job until it ends or `timeoutMs` passes. Returns the last job instance seen.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {string} label
 * @param {{ pollMs?: number, timeoutMs?: number }} [opts]
 */
export async function waitForJob(ctx, url, label, opts = {}) {
  const progress = ctx.ui.progress(label);
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 3_600_000);
  /** @type {any} */
  let job;
  let lost = 0;
  try {
    for (;;) {
      try {
        job = await ctx.api.fabric.getJob(url);
        lost = 0;
      } catch (err) {
        // A network blip on this PC doesn't stop the job in Fabric, so keep watching.
        if (!isTransientNetworkError(err)) throw err;
        if (++lost > NETWORK_LOSSES) {
          throw new Error(`Lost the connection while watching the ${label.toLowerCase()}. It carries on in Fabric: check on it with "${commandLine('status')}". (${/** @type {Error} */ (err).message})`, { cause: err });
        }
        progress.update('Connection lost, trying again');
        await ctx.sleep(opts.pollMs ?? POLL_MS);
        continue;
      }
      progress.update(job?.status ?? 'Unknown');
      if (TERMINAL.has(job?.status)) break;
      if (Date.now() > deadline) break;
      await ctx.sleep(opts.pollMs ?? POLL_MS);
    }
  } finally {
    progress.done();
  }
  return job;
}

/** What Fabric says when a capacity is too busy to start another notebook. */
export const CAPACITY_BUSY = /TooManyRequestsForCapacity|(?:code|status)[\s:'"=-]{0,6}430\b/i;

/**
 * Whether an error is Fabric turning work away because the capacity is busy.
 * @param {{ errorCode?: unknown, message?: unknown } | null | undefined} e
 */
export const capacityBusy = (e) => !!e && (String(e.errorCode ?? '') === '430' || CAPACITY_BUSY.test(`${e.errorCode ?? ''} ${e.message ?? ''}`));

/** Times work turned away by a busy capacity is tried again, and how long to wait first. */
export const BUSY_RETRIES = 2;
export const BUSY_WAIT_MS = 5 * 60_000;

/**
 * @param {Ctx} ctx
 * @param {string} again  The command that starts the work again.
 */
function busyNote(ctx, again) {
  ctx.ui.note('Fabric\'s capacity was too busy to start a notebook. Nothing is lost.');
  ctx.ui.note(`Wait a few minutes, then run "${commandLine(again)}" again.`);
}

/**
 * @param {Ctx} ctx
 * @param {any} job
 * @param {string} what
 * @param {string} [again]  The command to suggest when a busy capacity turned the job away.
 */
function reportJob(ctx, job, what, again) {
  const { ui } = ctx;
  const start = utc(job?.startTimeUtc);
  const end = utc(job?.endTimeUtc);
  const took = start && end ? ` in ${formatDuration(end.getTime() - start.getTime())}` : '';
  switch (job?.status) {
    case 'Completed':
      ui.ok(`${what} finished${took}`);
      return true;
    case 'Failed':
      ui.fail(`${what} failed${took}`);
      if (again && capacityBusy(job.failureReason)) busyNote(ctx, again);
      else if (job.failureReason?.message) ui.info(String(job.failureReason.message).slice(0, 1200));
      return false;
    default:
      if (TERMINAL.has(job?.status)) ui.warn(`${what} ended with status ${job.status}`);
      else ui.warn(`${what} is still running (${job?.status ?? 'unknown'}). Check later with "${commandLine('status')}".`);
      return false;
  }
}

/**
 * @typedef {object} RunResult
 * @property {string} [jobId]
 * @property {boolean} [started]  This call started the run; false when one was already going.
 * @property {string} [status]  The job's status. NotStarted when it didn't wait.
 * @property {boolean} [ok]  The run completed and none of its loads failed.
 * @property {boolean} [declined]  Asked whether to start it, the person answered no, so nothing started.
 * @property {string[]} [failed]  The activities that failed. Each leaves an install partly set up.
 */

/**
 * Roughly how long loading the audit history takes. It depends on the tenant, the days asked for and
 * the capacity, so it gives a range rather than a figure.
 * @param {number} days
 */
export function firstLoadEstimate(days) {
  return `Loading ${days} days of history can take from under an hour to several hours in a large tenant. `;
}

/** A run that started longer ago than this is stuck, not running. */
const STUCK_MS = 24 * 3_600_000;

/**
 * Starts the pipeline. With `backfillDays` it reloads that much audit history and rebuilds the curated table.
 * It doesn't start a run while another is going: two at once overload a small capacity.
 * @param {Ctx} ctx
 * @param {{ backfillDays?: number, wait?: boolean, first?: boolean }} opts
 * @returns {Promise<RunResult>}
 */
export async function runPipeline(ctx, opts) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.pipelineId) throw new Error('There is no pipeline yet. Run the installer first.');
  const running = (await api.fabric.listJobs(f.workspaceId, f.pipelineId).catch(() => [])).find((j) => {
    const started = utc(j.startTimeUtc);
    return (j.status === 'InProgress' || j.status === 'NotStarted') && !(started && ctx.now().getTime() - started.getTime() > STUCK_MS);
  });
  if (running) {
    ui.warn('The pipeline is already running, so this didn\'t start another.');
    ui.note(`Check on it with "${commandLine('status')}". Once it has finished, run "${commandLine('run')}" to start a new run.`);
    return { jobId: running.id, status: running.status, ok: false, started: false };
  }
  const days = opts.backfillDays;
  const parameters = days ? firstRunParameters(days) : undefined;
  const startedAt = ctx.now().toISOString();
  const url = await api.fabric.runJob(f.workspaceId, f.pipelineId, 'Pipeline', parameters ? { parameters } : undefined);
  const jobId = jobIdFrom(url);
  if (opts.first) {
    config.firstRun = { jobId, status: 'NotStarted', startedAt };
    ctx.save();
  }
  if (!days) ui.ok('Started the pipeline');
  else if (opts.first) ui.ok(`Started the first load: ${days} days of audit history`);
  else ui.ok(`Started the pipeline with ${days} days of audit history`);
  if (!opts.wait) {
    ui.note(`It runs in Fabric. Check on it with "${commandLine('status')}".`);
    return { jobId, status: 'NotStarted', started: true };
  }
  ui.note(`${days ? firstLoadEstimate(days) : ''}${ui.web ? 'You can close this window' : 'You can press Ctrl+C'}; the run carries on in Fabric.`);
  const job = await waitForJob(ctx, url, 'Pipeline');
  const ok = reportJob(ctx, job, 'Pipeline');
  const runs = TERMINAL.has(job?.status) ? await activityRuns(ctx, jobId, { startTimeUtc: job.startTimeUtc ?? startedAt, endTimeUtc: job.endTimeUtc }) : null;
  const cards = runs ? await reportLoads(ctx, runs) : [];
  const failed = failedCards(cards);
  if (!failed.length && capacityBusy(job?.failureReason)) busyNote(ctx, 'run');
  else if (!failed.length && job?.status === 'Failed') {
    ui.note(`To see why, open ${f.pipelineName ?? 'the pipeline'} in Fabric and look at its latest run. Then run "${commandLine('run')}" again.`);
  }
  if (opts.first) {
    config.firstRun = { ...config.firstRun, status: firstRunStatus(config, job?.status, runs), finishedAt: TERMINAL.has(job?.status) ? ctx.now().toISOString() : undefined };
    ctx.save();
  }
  return {
    jobId,
    started: true,
    status: job?.status,
    ok: ok && !failed.length,
    failed: failed.map((r) => r.activity),
  };
}

/**
 * The pipeline's activities as saved in Fabric, or undefined when Fabric can't say.
 * @param {Ctx} ctx
 * @returns {Promise<any[] | undefined>}
 */
export async function pipelineActivities(ctx) {
  const f = ctx.config.fabric;
  if (!f.workspaceId || !f.pipelineId) return undefined;
  const doc = await ctx.api.fabric.getPipelineDefinition(f.workspaceId, f.pipelineId).catch(() => null);
  return Array.isArray(doc?.properties?.activities) ? doc.properties.activities : undefined;
}

/**
 * Shows one card per source: whether it loaded and, if not, why and what to do.
 * @param {Ctx} ctx
 * @param {Map<string, any> | null} runs
 * @param {any[]} [activities]  The definition; fetched when not given.
 * @returns {Promise<LoadCard[]>}
 */
export async function reportLoads(ctx, runs, activities) {
  if (!runs) return [];
  const cards = loadCards(runs, activities ?? (await pipelineActivities(ctx)));
  const rerun = `run "${commandLine('rerun-failed')}"`;
  for (const card of cards) {
    card.fix = card.fix.map((t) => fillRerun(t, rerun));
    // So the web page shows the load as failing the install, not as waiting.
    if (card.state === 'failed') card.counted = true;
  }
  if (cards.length) ctx.ui.loads(cards);
  return cards;
}

/**
 * The last attempt of each activity in one pipeline run, with how many attempts it took, or null
 * when Fabric can't say.
 * @param {Ctx} ctx
 * @param {string} jobId
 * @param {{ startTimeUtc?: string | null, endTimeUtc?: string | null }} job
 * @returns {Promise<Map<string, any> | null>}
 */
export async function activityRuns(ctx, jobId, job) {
  const start = utc(job.startTimeUtc) ?? ctx.now();
  const end = utc(job.endTimeUtc) ?? ctx.now();
  const at = (/** @type {any} */ r) => utc(r.activityRunStart)?.getTime() || 0;
  try {
    const runs = await ctx.api.fabric.queryActivityRuns(
      /** @type {string} */ (ctx.config.fabric.workspaceId),
      jobId,
      new Date(start.getTime() - 3_600_000),
      new Date(end.getTime() + 3_600_000),
    );
    /** @type {Map<string, any>} */
    const last = new Map();
    for (const r of [...runs].sort((a, b) => at(a) - at(b))) {
      last.set(r.activityName, { ...r, attempts: (last.get(r.activityName)?.attempts ?? 0) + 1 });
    }
    return last;
  } catch {
    return null;
  }
}

/**
 * Whether a run loaded the history: the audit log load succeeded, and so did the model refresh when
 * the model is deployed.
 * @param {import('../config.js').InstallConfig} config
 * @param {Map<string, any>} runs
 */
export function loadedBy(config, runs) {
  const needed = [AUDIT_ACTIVITY];
  if (modelDeployed(config)) needed.push(REFRESH_ACTIVITY);
  return needed.every((name) => runs.get(name)?.status === 'Succeeded');
}

/**
 * The first load's status to record. A pipeline job can complete with failed loads, so 'Completed'
 * is kept only when its activity runs prove the history loaded; otherwise it is 'Incomplete' and the
 * next run offers the first load again.
 * @param {import('../config.js').InstallConfig} config
 * @param {string | undefined} status
 * @param {Map<string, any> | null} runs
 */
export function firstRunStatus(config, status, runs) {
  return status === 'Completed' && !(runs && loadedBy(config, runs)) ? 'Incomplete' : status;
}

/**
 * Whether the history has loaded. A first load that failed only in other loads did load it, so it is
 * marked completed. Installs from before the installer tracked the first load count any completed run.
 * @param {Ctx} ctx
 */
export async function historyLoaded(ctx) {
  const { config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.pipelineId) return false;
  const first = config.firstRun;
  if (first?.status === 'Completed') return true;
  if (first?.jobId) {
    const runs = await activityRuns(ctx, first.jobId, { startTimeUtc: first.startedAt, endTimeUtc: first.finishedAt });
    if (!runs || !loadedBy(config, runs)) return false;
    config.firstRun = { ...first, status: 'Completed' };
    ctx.save();
    return true;
  }
  return (await api.fabric.listJobs(f.workspaceId, f.pipelineId).catch(() => [])).some((j) => j.status === 'Completed');
}

/**
 * What `run` starts: the first load, with the history, until a run has loaded it; then the usual
 * incremental run. Asking for history days always loads that much.
 * @param {Ctx} ctx
 * @param {{ backfillDays?: number, wait: boolean }} opts
 * @returns {Promise<{ backfillDays?: number, wait: boolean, first?: boolean }>}
 */
export async function chooseLoad(ctx, opts) {
  const loaded = await historyLoaded(ctx);
  if (opts.backfillDays) return { ...opts, first: !loaded };
  if (loaded) return opts;
  return { ...opts, backfillDays: ctx.config.history.days, first: true };
}

/** @param {import('../config.js').InstallConfig} config */
const dataCheckName = (config) => config.fabric.notebookNames?.dataCheck ?? 'the data check notebook';

/**
 * Runs the data check notebook and reads back the summary it leaves in the Lakehouse.
 * @param {Ctx} ctx
 * @returns {Promise<any>} The summary; false when the check failed, saying how to run it again; null when it isn't
 *   deployed, didn't finish or left no summary, which only warns.
 */
export async function runDataCheck(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const notebookId = f.notebooks.dataCheck;
  if (!f.workspaceId || !f.lakehouseId || !notebookId) {
    ui.warn('The data check notebook isn\'t deployed.');
    return null;
  }
  /** @type {any} */
  let job;
  for (let attempt = 0; ; attempt++) {
    const url = await api.fabric.runJob(f.workspaceId, notebookId, 'RunNotebook');
    job = await waitForJob(ctx, url, 'Data check', { pollMs: 15_000, timeoutMs: 45 * 60_000 });
    // Straight after a run, the pipeline's Spark session can hold the capacity for a few minutes.
    if (job?.status !== 'Failed' || !capacityBusy(job.failureReason) || attempt >= BUSY_RETRIES) break;
    ui.warn(`Data check: Fabric's capacity is still busy. Trying again in ${BUSY_WAIT_MS / 60_000} minutes.`);
    await ctx.sleep(BUSY_WAIT_MS);
  }
  if (!reportJob(ctx, job, 'Data check', 'check')) {
    if (job?.status !== 'Failed') return null;
    // A busy capacity's note already says to run it again.
    if (!capacityBusy(job.failureReason)) ui.info(`Run "${commandLine('check')}" to try it again.`);
    return false;
  }
  const summary = await api.oneLake.readJson(f.workspaceId, f.lakehouseId, DATA_CHECK_FILE).catch(() => null);
  if (!summary) {
    ui.note(`Open ${dataCheckName(config)} in Fabric to see its results.`);
    return null;
  }
  printDataCheck(ctx, summary);
  return summary;
}

/**
 * The `check` command: runs the data check on its own, without the pipeline.
 * @param {Ctx} ctx
 */
export async function checkData(ctx) {
  const f = ctx.config.fabric;
  if (!f.workspaceId || !f.lakehouseId || !f.notebooks.dataCheck) throw new Error('There is no data check notebook yet. Run the installer first.');
  ctx.ui.note('It reads each table in the Lakehouse and usually takes a few minutes.');
  return runDataCheck(ctx);
}

/**
 * Whether a pipeline run ended after the data check, so the tables may have changed since.
 * @param {any[]} jobs
 * @param {string | undefined} checkedAt
 */
export function ranSince(jobs, checkedAt) {
  const at = Date.parse(checkedAt ?? '');
  if (Number.isNaN(at)) return false;
  return jobs.some((j) => (j.status === 'Completed' || j.status === 'Failed') && (utc(j.endTimeUtc)?.getTime() ?? 0) > at);
}

const TABLE_LABELS = /** @type {const} */ ({
  licensed: 'Licensed users',
  audit: 'Copilot audit log',
  org: 'Org data',
});

/**
 * @param {Ctx} ctx
 * @param {any} summary
 */
export function printDataCheck(ctx, summary) {
  const { ui } = ctx;
  const tables = summary?.tables ?? {};
  for (const [key, label] of Object.entries(TABLE_LABELS)) {
    const t = tables[key];
    if (!t) {
      if (key === 'licensed' || key === 'audit') ui.warn(`${label}: no table yet`);
      else ui.note(`${label}: not loaded`);
      continue;
    }
    const rows = Number(t.rows ?? 0).toLocaleString('en-GB');
    const range = t.from && t.to ? `, ${String(t.from).slice(0, 10)} to ${String(t.to).slice(0, 10)}` : '';
    (t.rows ? ui.ok : ui.warn)(`${label}: ${rows} rows${range}`);
    if (key === 'audit' && !t.rows) ui.note('No Copilot activity was found in the audit log yet. It appears after people use Copilot and the pipeline runs again.');
    if (key === 'org' && t.rows) printDepartmentCoverage(ctx, Number(t.rows), t.withDepartment);
  }
  printIdentityMatch(ctx, summary?.identity);
}

/** Below this share of people with a department, by-department views leave most people out. */
export const LOW_DEPARTMENT_COVERAGE = 0.8;

/**
 * Says how many people in the org data have a department, and how to fill the gaps when few do.
 * @param {Ctx} ctx
 * @param {number} people
 * @param {number | undefined} withDepartment  Missing when the data check predates this count.
 */
function printDepartmentCoverage(ctx, people, withDepartment) {
  const { ui } = ctx;
  if (withDepartment === undefined || withDepartment === null) return;
  const n = (/** @type {number} */ v) => v.toLocaleString('en-GB');
  const have = Number(withDepartment);
  const line = `Org data: ${n(have)} of ${n(people)} people have a department`;
  if (have / people >= LOW_DEPARTMENT_COVERAGE) {
    ui.ok(line);
    return;
  }
  ui.warn(line);
  ui.note('Views by department leave out everyone without one. Fill in Department on users in Microsoft Entra ID');
  ui.note('(or the HR system that feeds it). The next pipeline run picks it up.');
}

/**
 * Says whether licences match Copilot activity. With no match, the report shows no activity by licensed users.
 * @param {Ctx} ctx
 * @param {{ licensed?: number, audit?: number, matched?: number, masked?: number } | null | undefined} identity
 */
function printIdentityMatch(ctx, identity) {
  const { ui, config } = ctx;
  if (!identity) return;
  const licensed = Number(identity.licensed ?? 0);
  const audit = Number(identity.audit ?? 0);
  const matched = Number(identity.matched ?? 0);
  const masked = Number(identity.masked ?? 0);
  if (!licensed || !audit) return;
  const n = (/** @type {number} */ v) => v.toLocaleString('en-GB');
  if (masked * 2 >= licensed) {
    ui.warn(`Licensed users: ${n(masked)} of ${n(licensed)} user names are hidden, so no licence matches Copilot activity`);
    ui.note('A Global Administrator can show them: in the Microsoft 365 admin center, go to Settings > Org settings > Services > Reports');
    ui.note('and untick "Conceal user, group, and site names in all reports". The next pipeline run picks it up.');
  } else if (!matched) {
    ui.warn(`Licensed users: none of the ${n(audit)} people using Copilot match a licensed user`);
    ui.note(`Open ${dataCheckName(config)} in Fabric to compare the user names in both tables.`);
  } else {
    ui.ok(`Licensed users: ${n(matched)} of ${n(audit)} people using Copilot have a licence`);
  }
}

/**
 * @param {Ctx} ctx
 */
export async function status(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.pipelineId) {
    ui.warn('Nothing is installed yet.');
    return;
  }
  ui.heading('AI in One');
  ui.info(`Workspace: ${f.workspaceName ?? f.workspaceId}`);
  ui.info(`Lakehouse: ${f.lakehouseName ?? f.lakehouseId}`);
  ui.info(`Pipeline:  ${f.pipelineName ?? f.pipelineId}`);
  const sm = config.semanticModel;
  if (sm?.id) ui.info(`Model:     ${sm.name}${sm.bound ? '' : ' (not connected to the Lakehouse yet)'}`);
  if (sm?.report?.id) ui.info(`Report:    ${sm.report.name ?? sm.name}`);
  expiry(ctx, 'Client secret', config.app.secretExpires);
  if (sm?.connectionId) expiry(ctx, 'Model connection secret', sm.secretExpires);

  ui.heading('Recent runs');
  const jobs = (await api.fabric.listJobs(f.workspaceId, f.pipelineId))
    .sort((a, b) => String(b.startTimeUtc ?? '').localeCompare(String(a.startTimeUtc ?? '')))
    .slice(0, 5);
  if (!jobs.length) ui.note('No runs yet.');
  for (const job of jobs) {
    const start = utc(job.startTimeUtc);
    const end = utc(job.endTimeUtc);
    const when = start ? start.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not started';
    const took = start && end ? `, ${formatDuration(end.getTime() - start.getTime())}` : '';
    const line = `${when}  ${job.status}${took}  ${job.invokeType ?? ''}`.trimEnd();
    if (job.status === 'Completed') ui.ok(line);
    else if (job.status === 'Failed') {
      ui.fail(line);
      if (job.failureReason?.message) ui.note(String(job.failureReason.message).slice(0, 400));
    } else ui.info(line);
  }
  const latest = jobs[0];
  if (latest && TERMINAL.has(latest.status)) {
    const runs = await activityRuns(ctx, latest.id, latest);
    if (runs?.size) {
      ui.heading('Latest run, by source');
      const failed = failedCards(await reportLoads(ctx, runs));
      if (!failed.length && capacityBusy(latest.failureReason)) busyNote(ctx, 'run');
    } else if (capacityBusy(latest.failureReason)) busyNote(ctx, 'run');
  }

  if (config.firstRun?.jobId && !TERMINAL.has(config.firstRun.status ?? '') && config.firstRun.status !== 'Incomplete') {
    const job = jobs.find((j) => j.id === config.firstRun?.jobId);
    if (job && TERMINAL.has(job.status)) {
      const runs = job.status === 'Completed' ? await activityRuns(ctx, job.id, job) : null;
      config.firstRun = { ...config.firstRun, status: firstRunStatus(config, job.status, runs), finishedAt: utc(job.endTimeUtc)?.toISOString() };
      ctx.save();
    }
  }

  if (sm?.id) {
    const refreshes = await modelRefreshes(ctx, sm).catch(() => null);
    if (refreshes) {
      ui.heading('Model refreshes');
      if (!refreshes.length) ui.note('No refreshes yet.');
      for (const r of refreshes) {
        const start = utc(r.startTime);
        const end = utc(r.endTime);
        const when = start ? start.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not started';
        const took = start && end ? `, ${formatDuration(end.getTime() - start.getTime())}` : '';
        const state = r.extendedStatus ?? r.status ?? 'Unknown';
        const line = `${when}  ${state}${took}  ${r.refreshType ?? ''}`.trimEnd();
        if (state === 'Completed') ui.ok(line);
        else if (state === 'Failed') {
          ui.fail(line);
          if (r.serviceExceptionJson) ui.note(String(r.serviceExceptionJson).slice(0, 400));
        } else ui.info(line);
      }
    }
  }

  if (f.lakehouseId) {
    const summary = await api.oneLake.readJson(f.workspaceId, f.lakehouseId, DATA_CHECK_FILE).catch(() => null);
    if (summary) {
      ui.heading(`Last data check${summary.checkedAt ? ` (${String(summary.checkedAt).slice(0, 16).replace('T', ' ')} UTC)` : ''}`);
      if (ranSince(jobs, summary.checkedAt)) {
        ui.warn('The pipeline has run since this check, so these results may be out of date.');
        ui.note(`Run "${commandLine('check')}" to check the data again.`);
      }
      printDataCheck(ctx, summary);
    } else if (f.notebooks.dataCheck && jobs.some((j) => j.status === 'Completed')) {
      ui.heading('Data check');
      ui.note(`It hasn't run yet. Run "${commandLine('check')}" to see what the pipeline loaded.`);
    }
  }
}

/**
 * @param {Ctx} ctx
 * @param {string} label
 * @param {string | undefined} expires
 */
function expiry(ctx, label, expires) {
  if (!expires) return;
  const days = Math.floor((Date.parse(expires) - ctx.now().getTime()) / 86_400_000);
  const msg = `${label} expires ${expires.slice(0, 10)} (${days} days)`;
  if (days < 30) ctx.ui.warn(`${msg}. Run "${commandLine('rotate-secret')}".`);
  else ctx.ui.info(msg);
}
