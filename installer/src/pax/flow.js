// @ts-check
/**
 * The PAX route once the plan has a go-ahead: the set-up steps, then each command after it. The
 * questions are in plan.js. Each step leaves what's already right alone, so a repair or change
 * runs the same steps as a new install.
 */
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONSENT_ROLES } from '../clients/graph.js';
import { DEFAULT_CONFIG_FILE } from '../config.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';
import { APP_NAME, deployTheApp, removeTheApp } from '../managed-app/flow.js';
import { accessCommand, accessSummaryLines, ensureViewerGroup } from '../steps/access.js';
import { adoptedItems, createdItems, deleteAppRegistration, deleteItems, listOf } from '../steps/fabric-uninstall.js';
import { ensureConsent } from '../steps/identity.js';
import { modelUrl } from '../steps/model.js';
import { nextSteps, stepsLeftTitle } from '../steps/next-steps.js';
import { reportUrl } from '../steps/report.js';
import { c } from '../ui.js';
import { daysLeft, ensureCredential, ensurePaxApp, removePaxCredentials, RENEW_DAYS } from './identity.js';
import { defaultLocalFolder, KEPT_DIRS, paxFiles, runDir, stateRoot, TASK_NAME } from './names.js';
import { ensurePaxTools, runPwshOf } from './pc.js';
import { filesLabel, taskLogon } from './plan.js';
import { connectModel, deployPaxModel, ensurePaxWorkspace, ensureRefreshSchedule, FIRST_REFRESH_MS, forgetMissingModel, localGuidance, paxViewerAccess, refreshPaxModel } from './report.js';
import { checkAccess, taskInfo } from './scripts.js';
import { describeCheck, ensureSiteAccess, folderLabel, revokeSiteGrant, sizeOf } from './site.js';
import { describeRun, describeStopped, ensureTask, logonOf, noDataYet, noPasswordWarning, readLastRun, removeTask, staleRun, startRun, waitForRun } from './task.js';
import { writeWrapper } from './wrapper.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../config.js').InstallConfig} InstallConfig */
/** @typedef {import('../config.js').PaxConfig} PaxConfig */
/** @typedef {import('./scripts.js').AccessCheck} AccessCheck */
/** @typedef {import('./task.js').LastRun} LastRun */

/** How long install and run wait for a PAX run: a little over the task's 4-hour limit, so a run the limit stops shows as stopped. */
export const RUN_WAIT_MS = 255 * 60_000;

/** @param {unknown} err */
const gone = (err) => err instanceof HttpError && err.status === 404;

/** @param {InstallConfig} config */
function paxOf(config) {
  const pax = config.pax;
  if (!pax) throw new Error('The install record has no PAX setup.');
  return pax;
}

/** The report reads the files from SharePoint. @param {InstallConfig} config */
export const withReport = (config) => config.pax?.destination === 'sharepoint' && !!config.semanticModel.enabled;
/** @param {InstallConfig} config */
export const withApp = (config) => !!config.pax && config.pax.deployApp !== false;
/** @param {InstallConfig} config */
export const withAccess = (config) => !!config.access && (withReport(config) || withApp(config));

/** Whether the signed-in user can grant admin consent for Graph application permissions. @param {Ctx} ctx */
async function canConsent(ctx) {
  const roles = await ctx.api.graph.myDirectoryRoles().catch(() => []);
  return roles.some((r) => r.roleTemplateId in CONSENT_ROLES);
}

/** An ISO time, to the minute. @param {string | null | undefined} iso */
const utc = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'unknown');

/** How the task signs in as the app, in words. @param {PaxConfig} pax */
const credentialLabel = (pax) => (pax.credentialType === 'secret' ? 'a client secret, protected for you on this PC' : 'a certificate in your certificate store');

/** @param {PaxConfig} pax */
const credentialExpires = (pax) => (pax.credentialType === 'secret' ? pax.secretExpires : pax.certificateExpires);

/**
 * The set-up's steps, in order.
 * @param {InstallConfig} config
 */
export function setUpTitles(config) {
  return [
    'PAX and Python',
    'App registration',
    'Microsoft Graph permissions',
    config.pax?.destination === 'local' ? 'Local folder' : 'SharePoint site access',
    'Scheduled task',
    ...(withReport(config) ? ['Workspace, semantic model and report'] : []),
    ...(withAccess(config) ? ['Viewer access'] : []),
    ...(withApp(config) ? [`The ${APP_NAME} app`] : []),
  ];
}

/**
 * The steps install and update share: PAX, the app registration and its credential, consent, the
 * folder, the task, then the report, viewer access and the app when they're chosen.
 * @param {Ctx} ctx
 * @param {{ step: (title: string) => void, canConsent: boolean }} o
 * @returns {Promise<{ consented: boolean, site: { ok: boolean, check?: AccessCheck }, stepsOk: boolean }>}
 *   stepsOk: false when a step failed and the set-up carried on.
 */
async function setUp(ctx, o) {
  const { ui, config } = ctx;
  const { step } = o;
  const pax = paxOf(config);
  let stepsOk = true;

  step('PAX and Python');
  const probe = await ensurePaxTools(ctx);
  step('App registration');
  await ensurePaxApp(ctx);
  await ensureCredential(ctx, { certificates: probe.certificates !== false });
  step('Microsoft Graph permissions');
  const consented = await ensureConsent(ctx, { canConsent: o.canConsent });
  step(pax.destination === 'local' ? 'Local folder' : 'SharePoint site access');
  const site = await ensureSiteAccess(ctx, { consented });
  if (consented && !site.ok) stepsOk = false;
  step('Scheduled task');
  await ensureTask(ctx);
  if (withReport(config)) {
    step('Workspace, semantic model and report');
    try {
      await ensurePaxWorkspace(ctx);
      const { reportOk } = await deployPaxModel(ctx);
      if (!reportOk) stepsOk = false;
      if (config.semanticModel.bound) await ensureRefreshSchedule(ctx);
    } catch (err) {
      ui.fail(`The report isn't set up: ${/** @type {Error} */ (err).message}`);
      ui.info('The task still loads the files each day. Fix the problem, then run the installer again.');
      stepsOk = false;
    }
  }
  if (withAccess(config)) {
    step('Viewer access');
    if (withReport(config)) await paxViewerAccess(ctx);
    else await ensureViewerGroup(ctx);
  }
  if (withApp(config)) {
    step(`The ${APP_NAME} app`);
    const app = await deployTheApp(ctx, { env: ctx.env }, { environmentId: ctx.environmentId });
    if (!app.ok) stepsOk = false;
  }
  return { consented, site, stepsOk };
}

/**
 * Sets up the PAX route, once the plan has a go-ahead, then starts the first load, a reload of the
 * history, or connects the model to the files on a repair.
 * @param {Ctx} ctx
 * @param {{ wait: boolean, pre?: { canConsent: boolean } }} opts
 * @returns {Promise<boolean>}  false when a step failed and the set-up carried on, or the run it waited for failed.
 */
export async function paxInstall(ctx, opts) {
  const { ui, config } = ctx;
  const pax = paxOf(config);
  const sm = config.semanticModel;
  const reloadDays = ctx.runFirstLoad ? undefined : ctx.reloadHistoryDays;
  const refreshModel = !ctx.runFirstLoad && !reloadDays && withReport(config) && !!pax.firstRunStartedAt;
  const titles = [
    ...setUpTitles(config),
    ...(ctx.runFirstLoad ? ['First load'] : reloadDays ? ['Reload audit history'] : refreshModel ? ['Model refresh'] : []),
  ];
  let n = 0;
  const step = (/** @type {string} */ title) => ui.step(++n, titles.length, title);

  const { consented, site, stepsOk } = await setUp(ctx, { step, canConsent: opts.pre?.canConsent ?? (await canConsent(ctx)) });
  const blocked = !consented ? 'admin consent is granted' : !site.ok ? `the app can write to ${filesLabel(pax)}` : undefined;

  let ok = true;
  if (ctx.runFirstLoad || reloadDays) {
    step(ctx.runFirstLoad ? 'First load' : 'Reload audit history');
    const days = reloadDays ?? config.history.days;
    const later = commandLine(`run --backfill-days ${days}`);
    if (blocked) ui.warn(`Skipped until ${blocked}. Then run: ${later}`);
    else ok = await loadHistory(ctx, { days, wait: opts.wait });
  } else if (refreshModel) {
    step('Model refresh');
    if (blocked) ui.warn(`Skipped until ${blocked}. Then run: ${commandLine('check')}`);
    else if (opts.wait) ok = await connectModel(ctx, { check: site.check });
    else ui.note(`Run "${commandLine('check')}" to refresh ${sm.name} and check it has the files.`);
  }
  ok = ok && stepsOk;
  paxSummary(ctx, { ok });
  return ok;
}

/**
 * Has the task load `days` of history again, now, and with wait, waits for it and connects the
 * model to the files. While a run is going nothing changes: that run may be loading the history
 * itself, and keeps its progress in the file a new request would replace.
 * @param {Ctx} ctx
 * @param {{ days: number, wait: boolean }} o
 * @returns {Promise<boolean>}  false when the run it waited for didn't start, failed or didn't leave a working model.
 */
async function loadHistory(ctx, o) {
  const { ui, config } = ctx;
  const started = await startRun(ctx, {
    seed: true,
    prepare: () => {
      if (config.history.days === o.days) return;
      config.history.days = o.days;
      ctx.save();
      // The script reads how many days to load from its settings.
      writeWrapper(config, { env: ctx.env });
    },
  });
  if (!started.started) {
    ui.info(`Once it has, run: ${commandLine(`run --backfill-days ${o.days}`)}`);
    return !o.wait;
  }
  if (!o.wait) {
    ui.note(
      `PAX loads ${o.days} days of audit history in the background. Run "${commandLine('status')}" to see how it's going${
        withReport(config) ? `, then "${commandLine('check')}" once it has finished, to connect ${config.semanticModel.name} to the files` : ''
      }.`,
    );
    return true;
  }
  return afterRun(ctx, await waitForRun(ctx, started.at, RUN_WAIT_MS));
}

/**
 * Prints how a run went, and when the task has found no Copilot interactions yet, says so.
 * @param {Ctx} ctx
 * @param {LastRun} run
 */
function showRun(ctx, run) {
  const { ui, config } = ctx;
  const [first, ...rest] = describeRun(run);
  if (run.status === 'failed') ui.fail(first);
  else if (run.status === 'warning') ui.warn(first);
  else if (run.status === 'running') ui.info(first);
  else ui.ok(first);
  for (const line of rest) ui.info(line);
  if (run.noData && run.status !== 'failed' && run.status !== 'running') ui.info(noDataYet(withReport(config) ? config.semanticModel.name : undefined));
}

/**
 * Prints a run that stopped before it could say how it went, and what to do.
 * @param {import('../ui.js').Ui} ui
 * @param {LastRun} run
 */
function showStopped(ui, run) {
  const [first, ...rest] = describeStopped(run);
  ui.warn(first);
  for (const line of rest) ui.info(line);
}

/**
 * Says how the run went and, when it worked and the files go to SharePoint, refreshes the model on
 * them. Until the task finds some Copilot interactions there are no files, which isn't a failure.
 * @param {Ctx} ctx
 * @param {LastRun | undefined} run  undefined when it was still going.
 * @returns {Promise<boolean>}
 */
async function afterRun(ctx, run) {
  const { ui, config } = ctx;
  if (!run) {
    ui.warn(`The run hasn't finished yet. Run "${commandLine('status')}" later to see how it went.`);
    return false;
  }
  showRun(ctx, run);
  if (run.status === 'failed') return false;
  if (run.noData) return true;
  return withReport(config) ? connectModel(ctx) : true;
}

/**
 * Where everything is and what's left to do.
 * @param {Ctx} ctx
 * @param {{ ok: boolean }} o  ok: false when a step above failed, so the heading doesn't say it's all set up.
 */
export function paxSummary(ctx, o) {
  const { ui, config } = ctx;
  const pax = paxOf(config);
  const sm = config.semanticModel;
  const ws = config.fabric.workspaceId;
  if (o.ok) ui.heading('AI in One is set up');
  else {
    ui.heading('AI in One is partly set up');
    ui.warn('A step above didn\'t finish. Fix what it says, then run the installer again: it picks up where it stopped.');
  }
  const left = nextSteps(config, ctx.user);
  if (left.length) ui.nextSteps(stepsLeftTitle(left), left);
  ui.info(`Files:      ${filesLabel(pax)}`);
  ui.info(`Task:       ${TASK_NAME}, daily at ${pax.runAt}, ${taskLogon(pax)}`);
  const expires = credentialExpires(pax);
  ui.info(`Sign-in:    ${credentialLabel(pax)}${expires ? `, until ${expires.slice(0, 10)}` : ''}`);
  ui.info(`            ${c.dim(`To replace it, run the installer again in its last month, or run "${commandLine('rotate-secret')}".`)}`);
  if (ws && withReport(config) && sm.id) {
    ui.info(`Model:      ${sm.name}  ${c.dim(modelUrl(ws, sm.id))}`);
    if (sm.report?.id) ui.info(`Report:     ${sm.report.name}  ${c.dim(reportUrl(ws, sm.report.id))}`);
  }
  if (config.managedApp?.url) ui.info(`App:        ${APP_NAME}  ${c.dim(config.managedApp.url)}`);
  for (const line of accessSummaryLines(config)) ui.info(line);
  localGuidance(ctx);
  ui.info(`Keep ${c.bold(DEFAULT_CONFIG_FILE)}. It holds no secrets; re-run the installer with it to change or repair the set-up.`);
}

/** The commands that work before the task is in place. */
const BEFORE_TASK = new Set(['access', 'deploy-app', 'uninstall']);

/**
 * Runs one command on a PAX install.
 * @param {Ctx} ctx
 * @param {string} command
 * @param {{ wait: boolean, backfillDays?: number }} opts
 * @returns {Promise<boolean>}  false when a step failed, or a run or refresh it waited for didn't succeed.
 */
export async function runPaxCommand(ctx, command, opts) {
  const { config } = ctx;
  const pax = paxOf(config);
  if (!pax.taskRegisteredAt && !BEFORE_TASK.has(command)) throw new Error('Nothing is installed yet. Run the installer first.');
  switch (command) {
    case 'update':
      return update(ctx, opts);
    case 'run':
      return runNow(ctx, opts);
    case 'status':
      await paxStatus(ctx);
      return true;
    case 'check':
      return checkFiles(ctx);
    case 'refresh':
      return refresh(ctx, opts);
    case 'access':
      await access(ctx);
      return true;
    case 'rotate-secret':
      await rotateCredential(ctx);
      return true;
    case 'deploy-app':
      return deployApp(ctx);
    case 'rerun-failed':
      throw new Error(`rerun-failed is for the Fabric route. To run PAX again now, run: ${commandLine('run')}`);
    case 'uninstall':
      await uninstall(ctx);
      return true;
    default:
      throw new Error(`Unknown command "${command}".`);
  }
}

/**
 * Runs the set-up's steps again with this copy of the installer: PAX, the task's script, the model
 * and report from its template, and the app from its build.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 */
async function update(ctx, opts) {
  const { ui, config } = ctx;
  const pax = paxOf(config);
  ui.heading('Updating AI in One');
  ui.note(`From ${ctx.sources.dir}`);
  const titles = setUpTitles(config);
  let n = 0;
  const step = (/** @type {string} */ title) => ui.step(++n, titles.length, title);
  const { consented, site, stepsOk } = await setUp(ctx, { step, canConsent: await canConsent(ctx) });
  let ok = stepsOk;
  if (opts.wait && withReport(config) && consented && site.ok && pax.firstRunStartedAt) ok = (await connectModel(ctx, { check: site.check })) && ok;
  if (ok) ui.ok('Up to date. The next scheduled run uses the new versions.');
  else paxSummary(ctx, { ok });
  return ok;
}

/**
 * The run command: starts the task now. With --backfill-days, the run loads that much history again.
 * @param {Ctx} ctx
 * @param {{ wait: boolean, backfillDays?: number }} opts
 */
async function runNow(ctx, opts) {
  const { ui, config } = ctx;
  const days = opts.backfillDays;
  if (days) {
    const current = config.history.days;
    if (days < current) {
      ui.warn(`This loads the audit history again with ${days} days, so the ${current} days in the files now drop to ${days}.`);
      if (!(await ui.confirm(`Reload only ${days} days?`, false))) {
        ui.note(`Nothing started. To keep the history you have, run "${commandLine(`run --backfill-days ${current}`)}" or more.`);
        // Under --yes nobody was asked, so the run it was told to start counts as not done.
        return !opts.wait || !ui.yes;
      }
    }
    return loadHistory(ctx, { days, wait: opts.wait });
  }
  const started = await startRun(ctx);
  if (!started.started) return true;
  if (!opts.wait) {
    ui.note(`Run "${commandLine('status')}" to see how it's going.`);
    return true;
  }
  return afterRun(ctx, await waitForRun(ctx, started.at, RUN_WAIT_MS));
}

/**
 * The status command: the task, its sign-in, the last run, and where the files, model and app are.
 * @param {Ctx} ctx
 */
async function paxStatus(ctx) {
  const { ui, config } = ctx;
  const pax = paxOf(config);
  const sm = config.semanticModel;
  const ws = config.fabric.workspaceId;
  ui.heading('AI in One');
  ui.info(`Files:    ${filesLabel(pax)}`);
  const info = await taskInfo(runPwshOf(ctx));
  if (!info.exists) ui.warn(`The scheduled task "${TASK_NAME}" isn't there. Run the installer again to put it back.`);
  else {
    // The task as Windows has it now: the user may have set it to run while signed out since.
    const logon = logonOf(info);
    ui.info(`Task:     ${TASK_NAME}, daily at ${pax.runAt}, ${taskLogon({ ...pax, logonType: logon })}${info.state && info.state !== 'Ready' ? ` (${info.state})` : ''}`);
    if (logon === 'S4U') ui.warn(noPasswordWarning(pax.credentialType));
    if (info.nextRunTime) ui.info(`          Next run ${utc(info.nextRunTime)}`);
    if (info.state === 'Disabled') ui.warn(`The task is turned off. Turn it on again in Task Scheduler, or run the installer again.`);
  }
  const expires = credentialExpires(pax);
  if (expires) {
    const left = daysLeft(expires, ctx.now());
    const line = `Sign-in:  ${credentialLabel(pax)}, until ${expires.slice(0, 10)}`;
    if (left < 0) ui.warn(`${line}. It has expired, so the task can't sign in: run "${commandLine('rotate-secret')}".`);
    else if (left < RENEW_DAYS) ui.warn(`${line}. Run "${commandLine('rotate-secret')}" to replace it before then.`);
    else ui.info(line);
  }
  if (ws && withReport(config) && sm.id) ui.info(`Model:    ${sm.name}  ${c.dim(modelUrl(ws, sm.id))}`);
  if (config.managedApp?.url) ui.info(`App:      ${APP_NAME}  ${c.dim(config.managedApp.url)}`);
  const run = readLastRun(ctx.env);
  if (run && staleRun(run, info)) showStopped(ui, run);
  else if (run) showRun(ctx, run);
  else ui.info(`The task hasn't run yet.${info.exists && info.nextRunTime ? ` Its first run is at ${utc(info.nextRunTime)}, or start it now: ${commandLine('run')}` : ''}`);
}

/**
 * The check command: are the files where the report and the app read them, and, when they're in
 * SharePoint, does the model load them. Before the task has found any Copilot interactions there
 * are no files, which it says, and isn't a failure.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}
 */
async function checkFiles(ctx) {
  const { ui, config } = ctx;
  const pax = paxOf(config);
  ui.heading('Checking the files');
  const last = readLastRun(ctx.env);
  // Only then does it need the task, which it looks at with PowerShell.
  if (last?.status === 'running' && staleRun(last, await taskInfo(runPwshOf(ctx)))) showStopped(ui, last);
  /** @type {{ name: string, size?: number, changed?: string }[]} */
  let found = [];
  /** @type {AccessCheck | undefined} */
  let check;
  if (pax.destination === 'local') {
    const folder = pax.localFolder ?? defaultLocalFolder();
    for (const name of paxFiles(pax)) {
      try {
        const st = statSync(join(folder, name));
        found.push({ name, size: st.size, changed: st.mtime.toISOString() });
      } catch {
        // Not there yet.
      }
    }
  } else {
    check = await checkAccess(runPwshOf(ctx), ctx.env);
    if (!check.ok) {
      ui.warn(describeCheck(check));
      ui.info('Run the installer again to fix the app\'s access to the folder.');
      return false;
    }
    ui.ok(`The app can write to ${filesLabel(pax)}`);
    found = (check.files ?? []).filter((f) => f.exists).map((f) => ({ name: f.name, size: f.size, changed: f.lastModified }));
  }
  if (!found.length && last?.noData) {
    ui.warn(noDataYet(withReport(config) ? config.semanticModel.name : undefined));
    return true;
  }
  if (listFiles(ctx, pax, found)) return false;
  return withReport(config) ? connectModel(ctx, { check }) : true;
}

/**
 * Lists the files the task writes, and says which aren't there.
 * @param {Ctx} ctx
 * @param {PaxConfig} pax
 * @param {{ name: string, size?: number, changed?: string }[]} found
 * @returns {boolean}  Whether any are missing.
 */
function listFiles(ctx, pax, found) {
  const { ui } = ctx;
  let missing = false;
  for (const name of paxFiles(pax)) {
    const f = found.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (f) ui.ok(`${name}: ${sizeOf(f.size)}, changed ${utc(f.changed)}`);
    else {
      ui.warn(`${name} isn't there yet`);
      missing = true;
    }
  }
  if (missing) ui.info(`Once "${commandLine('status')}" shows a run has worked, run "${commandLine('check')}" again.`);
  return missing;
}

/**
 * The refresh command. A model its owner hasn't signed in yet is signed in first.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 */
async function refresh(ctx, opts) {
  const { ui, config } = ctx;
  const sm = config.semanticModel;
  if (!withReport(config) || !sm.id || !config.fabric.workspaceId) throw new Error('There is no semantic model yet. Run the installer first.');
  if (await forgetMissingModel(ctx)) return connectModel(ctx);
  if (!sm.bound) {
    ui.note(`${sm.name} isn't signed in to SharePoint yet, so that comes first.`);
    return connectModel(ctx);
  }
  const r = await refreshPaxModel(ctx, { timeoutMs: opts.wait ? FIRST_REFRESH_MS : 0 });
  return !opts.wait || r.ok;
}

/**
 * The access command: the viewer group, Build on the model, and the app shared with the group.
 * @param {Ctx} ctx
 */
async function access(ctx) {
  const { config } = ctx;
  const sm = config.semanticModel;
  const ws = config.fabric.workspaceId;
  await accessCommand(ctx, ws && withReport(config) && sm.id ? [{ workspaceId: ws, datasetId: sm.id, name: sm.name }] : []);
  const app = config.managedApp;
  const groupId = config.access?.groupId;
  if (app?.appId && groupId && !app.sharedWith?.includes(groupId)) await deployTheApp(ctx, { env: ctx.env }, { environmentId: ctx.environmentId });
}

/**
 * The rotate-secret command: a new certificate, or a new client secret where the PC can't make
 * one. The old one comes off the app once the task's script has signed in with the new one.
 * @param {Ctx} ctx
 */
async function rotateCredential(ctx) {
  const { ui, config } = ctx;
  const pax = paxOf(config);
  const what = pax.credentialType === 'secret' ? 'client secret' : 'certificate';
  ui.heading(`New ${what}`);
  ui.info(`App: ${config.app.displayName ?? config.app.appId}`);
  const expires = credentialExpires(pax);
  if (expires) ui.info(`The task's ${what} lasts until ${expires.slice(0, 10)}.`);
  ui.note(`The task signs in with the new one from its next run. The old one comes off the app once the new one has worked.`);
  if (!(await ui.confirm(`Replace the task's ${what}?`, true))) return;
  await ensureCredential(ctx, { force: true });
  await ensureSiteAccess(ctx, { consented: pax.destination === 'local' || !!pax.site?.checkedAt });
}

/**
 * The deploy-app command: deploys the app again from this copy of the installer, even when its
 * build hasn't changed. Running it means you want the app, so it turns the app step on first, and
 * later updates keep the app up to date whether or not this deploy works.
 * @param {Ctx} ctx
 */
async function deployApp(ctx) {
  const { ui, config } = ctx;
  const pax = paxOf(config);
  ui.heading(`The ${APP_NAME} app`);
  if (!pax.deployApp) {
    pax.deployApp = true;
    ctx.save();
  }
  const r = await deployTheApp(ctx, { env: ctx.env }, { force: true, environmentId: ctx.environmentId });
  if (r.url) ui.info(`App: ${APP_NAME}  ${c.dim(r.url)}`);
  return r.state === 'deployed' || r.state === 'up-to-date';
}

/**
 * Uninstalls the PAX route: the task, the app, the site grant, the credential, the report and the
 * local state. The app registration goes only when the installer made it and the user agrees.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether it went ahead.
 */
async function uninstall(ctx) {
  const { ui, config, api } = ctx;
  const pax = paxOf(config);
  const f = config.fabric;
  const env = ctx.env;
  ui.heading('Uninstalling AI in One');
  ui.info(`This removes the scheduled task "${TASK_NAME}", its sign-in and its working files on this PC${config.managedApp?.appId ? `, the ${APP_NAME} app` : ''}${
    pax.site?.grantId ? ', the app registration\'s access to the SharePoint site' : ''
  }${f.workspaceId ? ' and the report' : ''}. The files the task wrote stay.`);
  if (!(await ui.confirm('Uninstall AI in One?', true))) {
    ui.note('Nothing was removed.');
    return false;
  }
  try {
    await removeTask(ctx);
  } catch (err) {
    ui.warn(`Couldn't remove the scheduled task "${TASK_NAME}": ${/** @type {Error} */ (err).message}. Delete it in Task Scheduler.`);
  }
  if (config.managedApp) await removeTheApp(ctx, { env });
  await revokeSiteGrant(ctx);
  const appGone = await deleteAppRegistration(ctx);
  await removePaxCredentials(ctx, { keepApp: !appGone });

  /** @type {string[]} */
  let keptAdopted = [];
  if (f.workspaceId) {
    const name = f.workspaceName ?? f.workspaceId;
    if (f.createdWorkspace) {
      if (await ui.confirm(`Delete workspace "${name}" and the report and model in it?`, true)) {
        try {
          await api.fabric.deleteWorkspace(f.workspaceId);
          ui.ok(`Deleted workspace "${name}"`);
        } catch (err) {
          if (!gone(err)) ui.warn(`Couldn't delete workspace "${name}": ${/** @type {Error} */ (err).message}. Delete it in Power BI.`);
          else ui.ok(`Workspace "${name}" was already gone`);
        }
      } else ui.note(`Left workspace "${name}" alone.`);
    } else {
      const items = createdItems(config);
      if (items.length && (await ui.confirm(`Delete ${listOf(items.map((i) => `the ${i.kind} "${i.name}"`))} from workspace "${name}"? The workspace and everything else in it stay.`, true))) {
        await deleteItems(ctx, f.workspaceId, items);
      }
      const adopted = adoptedItems(config);
      const named = adopted.map((i) => `the ${i.kind} "${i.name}"`);
      // Published from Power BI Desktop, not made by the installer: kept unless the user says otherwise, and always under --yes.
      if (adopted.length && (await ui.confirm(`Delete ${listOf(named)} too? ${adopted.length === 1 ? 'It was' : 'They were'} published from Power BI Desktop, not made by the installer.`, false))) {
        await deleteItems(ctx, f.workspaceId, adopted);
      } else keptAdopted = named;
    }
  }

  for (const dir of [runDir(env), join(stateRoot(env), KEPT_DIRS[0])]) rmSync(dir, { recursive: true, force: true });
  ui.ok('Removed PAX and the task\'s working files from this PC');

  const left = [
    !appGone && config.app.appId && `the app registration${config.app.displayName ? ` "${config.app.displayName}"` : ''}`,
    config.access?.groupId && `the viewer group${config.access.groupName ? ` "${config.access.groupName}"` : ''}`,
    ...keptAdopted,
    pax.destination === 'local' ? `the files in ${pax.localFolder ?? defaultLocalFolder()}` : pax.site && `the files in ${folderLabel(pax.site)}`,
  ].filter((s) => typeof s === 'string');
  if (left.length) ui.note(`Left alone: ${listOf(left)}. Remove them yourself if nothing else uses them.`);
  ui.note('The install record still names what was removed. Move it aside before installing again.');
  return true;
}
