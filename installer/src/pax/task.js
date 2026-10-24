// @ts-check
/**
 * The PAX route's scheduled task: registering it, starting a run, waiting for one and reading
 * how the last one went, and removing it. The task runs as the user who installs it, by default
 * only while they're signed in. Running it while they're signed out is their choice in Task
 * Scheduler, where Windows asks for their password; the installer never sees it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { commandLine } from '../launch.js';
import { lastRunPath, runDir, seedRequestPath, TASK_NAME, wrapperPath } from './names.js';
import { runPwshOf } from './pc.js';
import { registerTask, startTask, TASK_NOT_RUN, TASK_RUNNING, taskInfo, unregisterTask } from './scripts.js';
import { taskArguments, writeTaskXml } from './wrapper.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('./scripts.js').TaskInfo} TaskInfo */

/** How often the installer looks to see whether a run has finished. */
export const POLL_MS = 15_000;

/**
 * last-run.json, which the task's script writes when a run starts and again when it ends.
 * @typedef {object} LastRun
 * @property {string} startedAt
 * @property {string | null} [finishedAt]
 * @property {'running' | 'ok' | 'warning' | 'failed'} status
 * @property {'seed' | 'daily' | null} [mode]
 * @property {number | null} [exitCode]  PAX's.
 * @property {number} [attempts]
 * @property {string} [paxVersion]
 * @property {string} [destination]
 * @property {string[]} [files]  The files it published.
 * @property {string | null} [metrics]  PAX's metrics JSON.
 * @property {string} [log]
 * @property {string[]} [warnings]
 * @property {string | null} [message]
 */

/** @param {Ctx} ctx */
function paxOf(ctx) {
  const pax = ctx.config.pax;
  if (!pax) throw new Error('The install record has no PAX setup.');
  return pax;
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
/** The account part of DOMAIN\user. @param {unknown} name */
const account = (name) => String(name ?? '').split('\\').pop();

/**
 * What the task should be, from the install record.
 * @param {Ctx} ctx
 */
export function taskSpec(ctx) {
  const pax = paxOf(ctx);
  if (!pax.userSid || !pax.pwsh) throw new Error("The install record doesn't say which account and PowerShell the task uses. Run install again to repair it.");
  return { sid: pax.userSid, userName: pax.userName, pwsh: pax.pwsh, runAt: pax.runAt, wrapper: wrapperPath(ctx.env), workingDir: runDir(ctx.env), env: ctx.env };
}

/**
 * Whether the registered task already runs the script as it should, as the same account, at the
 * same time. When it does the installer leaves it alone, since registering it again would set it
 * back to run only while the user is signed in.
 * @param {TaskInfo} info
 * @param {ReturnType<typeof taskSpec>} spec
 */
export function taskMatches(info, spec) {
  if (!info.exists || info.state === 'Disabled') return false;
  const user = same(info.userId, spec.sid) || (!!spec.userName && (same(info.userId, spec.userName) || same(account(info.userId), account(spec.userName))));
  return (
    user &&
    same(info.execute, spec.pwsh) &&
    same(info.arguments, taskArguments(spec.wrapper)) &&
    same(info.workingDir, spec.workingDir) &&
    String(info.startBoundary ?? '').slice(11, 16) === spec.runAt
  );
}

/**
 * How the task signs in, in the install record's terms.
 * @param {TaskInfo} info
 * @returns {'Interactive' | 'Password' | 'S4U'}
 */
export const logonOf = (info) => (info.logonType === 'Password' || info.logonType === 'S4U' ? info.logonType : 'Interactive');

/** @param {'Interactive' | 'Password' | 'S4U' | undefined} logon */
export const describeLogon = (logon) =>
  logon === 'Password' ? 'whether or not you are signed in' : logon === 'S4U' ? 'whether or not you are signed in, without your password' : 'while you are signed in';

/**
 * Why a task set to "Do not store password" can't sign in, and what to do about it.
 * @param {'certificate' | 'secret' | undefined} credentialType
 */
export const noPasswordWarning = (credentialType) =>
  `The task is set to run without your password ("Do not store password"), so it can't use its ${credentialType === 'secret' ? 'protected client secret' : 'certificate'}. In Task Scheduler, untick that box on the task's General tab, then type your password when Windows asks.`;

/**
 * What the user does in Task Scheduler to have the task run while they're signed out.
 * @param {'certificate' | 'secret'} credentialType
 */
export const signedOutSteps = (credentialType) => [
  'Open Task Scheduler: press Windows+R, type taskschd.msc and press Enter.',
  `In Task Scheduler Library, double-click "${TASK_NAME}".`,
  `On the General tab, choose "Run whether user is logged on or not". Leave "Do not store password" unticked: without your password the task can't use its ${credentialType === 'secret' ? 'protected client secret' : 'certificate'}.`,
  'Click OK, then type your Windows password when Windows asks for it. Windows keeps it, not the installer.',
  `Then run "${commandLine('status')}": it shows how the task signs in.`,
];

/**
 * Shows how the task signs in, and what to do when that isn't what the user chose.
 * @param {Ctx} ctx
 */
function explainLogon(ctx) {
  const { ui } = ctx;
  const pax = paxOf(ctx);
  if (pax.logonType === 'S4U') {
    ui.warn(noPasswordWarning(pax.credentialType));
    return;
  }
  if (pax.signedOut && pax.logonType !== 'Password') {
    ui.info("You chose to have it run while you're signed out too. Windows needs your password for that, which it asks for itself:");
    signedOutSteps(pax.credentialType).forEach((s, i) => ui.info(`  ${i + 1}. ${s}`));
    return;
  }
  if (pax.logonType !== 'Password') ui.note("When this PC is off or you're signed out at that time, it runs when you next sign in.");
}

/**
 * The "Scheduled task" step: registers the task, or leaves it as it is when it already matches.
 * @param {Ctx} ctx
 */
export async function ensureTask(ctx) {
  const { ui } = ctx;
  const pax = paxOf(ctx);
  const runPwsh = runPwshOf(ctx);
  const spec = taskSpec(ctx);
  const before = await taskInfo(runPwsh);
  if (taskMatches(before, spec)) {
    pax.logonType = logonOf(before);
    pax.taskRegisteredAt ??= ctx.now().toISOString();
    ctx.save();
    ui.ok(`The scheduled task "${TASK_NAME}" is set up: daily at ${pax.runAt}, ${describeLogon(pax.logonType)}`);
  } else {
    const wasSignedOut = before.exists && logonOf(before) !== 'Interactive';
    await registerTask(runPwsh, writeTaskXml({ ...spec, now: ctx.now() }));
    const after = await taskInfo(runPwsh);
    if (!after.exists) throw new Error(`Windows didn't keep the scheduled task "${TASK_NAME}".`);
    pax.logonType = logonOf(after);
    pax.taskRegisteredAt = ctx.now().toISOString();
    ctx.save();
    ui.ok(`${before.exists ? 'Updated' : 'Registered'} the scheduled task "${TASK_NAME}": daily at ${pax.runAt}, as ${pax.userName ?? 'you'}, ${describeLogon(pax.logonType)}`);
    if (wasSignedOut) ui.warn("Updating it set it back to run only while you're signed in.");
  }
  explainLogon(ctx);
}

/**
 * Starts the task now. With seed, the run loads the whole history again: the script finds the
 * request file, and deletes it once that run has worked.
 * @param {Ctx} ctx
 * @param {{ seed?: boolean }} [o]
 * @returns {Promise<{ started: boolean, at: Date }>}  started: false when a run was going already.
 */
export async function startRun(ctx, o = {}) {
  const { ui } = ctx;
  const runPwsh = runPwshOf(ctx);
  const info = await taskInfo(runPwsh);
  if (!info.exists) throw new Error(`The scheduled task "${TASK_NAME}" isn't there. Run install again to repair it.`);
  if (o.seed) {
    const file = seedRequestPath(ctx.env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${ctx.now().toISOString()}\n`, 'utf8');
  }
  const at = ctx.now();
  if (info.state === 'Running') {
    ui.note(`A run is going already.${o.seed ? ' The next one loads the history again.' : ''}`);
    return { started: false, at };
  }
  await startTask(runPwsh);
  const pax = paxOf(ctx);
  if (o.seed || !pax.firstRunStartedAt) {
    pax.firstRunStartedAt = at.toISOString();
    ctx.save();
  }
  ui.ok(`Started the scheduled task${o.seed ? ': it loads the history again' : ''}`);
  return { started: true, at };
}

/**
 * last-run.json, or undefined when there isn't one yet.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {LastRun | undefined}
 */
export function readLastRun(env) {
  const file = lastRunPath(env);
  if (!existsSync(file)) return undefined;
  try {
    const run = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return run && typeof run === 'object' && typeof run.startedAt === 'string' ? run : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The counts in PAX's metrics JSON for a run, when it wrote one.
 * @param {LastRun | undefined} run
 * @returns {{ records?: number, rows?: number } | undefined}
 */
export function readMetrics(run) {
  if (!run?.metrics || !existsSync(run.metrics)) return undefined;
  try {
    const m = JSON.parse(readFileSync(run.metrics, 'utf8').replace(/^\uFEFF/, ''))?.metrics ?? {};
    const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return { records: num(m.TotalRecordsFetched), rows: num(m.TotalStructuredRows) };
  } catch {
    return undefined;
  }
}

/** Slack for clocks that round to the second. */
const SLACK_MS = 5_000;
/** @param {number} code */
const hex = (code) => `0x${(code >>> 0).toString(16).toUpperCase()}`;

/**
 * Waits for the run that started at `since` to finish, up to `waitMs`. Returns it, or undefined
 * when it's still going. When the task ran but its script never wrote how it went, which happens
 * when PowerShell couldn't start it, says so as a failed run.
 * @param {Ctx} ctx
 * @param {Date} since
 * @param {number} waitMs
 * @returns {Promise<LastRun | undefined>}
 */
export async function waitForRun(ctx, since, waitMs) {
  const runPwsh = runPwshOf(ctx);
  const from = since.getTime() - SLACK_MS;
  const until = ctx.now().getTime() + waitMs;
  /** @param {LastRun | undefined} r */
  const ours = (r) => !!r && Date.parse(r.startedAt) >= from;
  const bar = ctx.ui.progress('PAX is loading the audit log');
  try {
    for (;;) {
      let run = readLastRun(ctx.env);
      if (ours(run) && run?.status !== 'running') return run;
      const info = await taskInfo(runPwsh);
      const ended = info.state !== 'Running' && info.state !== 'Queued' && !!info.lastRunTime && Date.parse(info.lastRunTime) >= from;
      if (ended && info.lastTaskResult !== TASK_RUNNING && info.lastTaskResult !== TASK_NOT_RUN) {
        run = readLastRun(ctx.env);
        if (ours(run) && run?.status !== 'running') return run;
        const code = Number(info.lastTaskResult ?? 1);
        if (run && ours(run)) {
          return {
            ...run,
            status: 'failed',
            exitCode: code,
            message: `The task stopped before the run finished (result ${hex(code)}). It may have reached its 4-hour limit, or been ended in Task Scheduler.`,
          };
        }
        return {
          startedAt: String(info.lastRunTime),
          status: 'failed',
          exitCode: code,
          message: `The task ran, but its script stopped before it could start PAX (result ${hex(code)}). To see why, run it yourself in PowerShell 7: pwsh -NoProfile -File "${wrapperPath(ctx.env)}"`,
        };
      }
      if (ctx.now().getTime() + POLL_MS > until) return undefined;
      bar.update(ours(run) ? `${run?.mode === 'seed' ? 'loading the history' : 'loading the last few days'}, started ${String(run?.startedAt).slice(11, 16)} UTC` : 'starting');
      await ctx.sleep(POLL_MS);
    }
  } finally {
    bar.done();
  }
}

/**
 * How a run went, as lines for the user.
 * @param {LastRun} run
 */
export function describeRun(run) {
  const when = (/** @type {string | null | undefined} */ iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'unknown');
  const kind = run.mode === 'seed' ? 'history (seed) run' : run.mode === 'daily' ? 'daily run' : 'run';
  /** @type {string[]} */
  const lines = [];
  if (run.status === 'running') {
    lines.push(`A ${kind} is going: it started ${when(run.startedAt)}.`);
    return lines;
  }
  const how = run.status === 'ok' ? 'worked' : run.status === 'warning' ? 'worked, with warnings' : 'failed';
  lines.push(`The last ${kind} ${how}. It started ${when(run.startedAt)} and finished ${when(run.finishedAt)}.`);
  if (run.message) lines.push(run.message);
  const m = readMetrics(run);
  if (m?.records !== undefined) lines.push(`PAX read ${m.records.toLocaleString('en-GB')} audit records${m.rows !== undefined ? ` into ${m.rows.toLocaleString('en-GB')} rows` : ''}.`);
  for (const w of run.warnings ?? []) lines.push(`Warning: ${w}`);
  if (run.log) lines.push(`Its log: ${run.log}`);
  return lines;
}

/**
 * Uninstall: removes the task.
 * @param {Ctx} ctx
 */
export async function removeTask(ctx) {
  const r = await unregisterTask(runPwshOf(ctx));
  ctx.ui.ok(r.removed ? `Removed the scheduled task "${TASK_NAME}"` : `The scheduled task "${TASK_NAME}" was gone already`);
  const pax = ctx.config.pax;
  if (pax) {
    delete pax.taskRegisteredAt;
    delete pax.logonType;
    ctx.save();
  }
}
