// @ts-check
/**
 * The PAX route's semantic model and report. They're built from the SharePoint edition's Power BI
 * template, with its file parameters set to the files the scheduled task uploads, and published to
 * a Power BI workspace, which needs no capacity. The model's owner signs it in to the files once,
 * then Power BI refreshes it each day after the task's run.
 */
import { join } from 'node:path';
import { semanticModelDefinition } from '../clients/fabric.js';
import { REPORT_NAME } from '../config.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';
import { ensureViewerGroup, grantModelAccess, shareReport } from '../steps/access.js';
import { byName, displayNames, freeName, noteRenamed } from '../steps/fabric.js';
import { deployModel, modelSettingsUrl, REFRESH_FINAL, REFRESH_POLL_MS, verifyModel } from '../steps/model.js';
import { DEFAULT_WORKSPACE_NAME } from '../steps/plan.js';
import { deployReport } from '../steps/report.js';
import { AGENT365_PARAMETER, loadTemplateModel, PBISM, setMParameter } from '../transform/model.js';
import { formatDuration } from '../ui.js';
import { DEFAULT_RUN_AT, FILES } from './names.js';
import { runPwshOf } from './pc.js';
import { checkAccess } from './scripts.js';
import { describeCheck, fileUrl, folderLabel } from './site.js';
import { noDataYet, readLastRun } from './task.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../config.js').InstallConfig} InstallConfig */
/** @typedef {import('../config.js').PaxSite} PaxSite */
/** @typedef {import('./scripts.js').AccessCheck} AccessCheck */

/** The template's parameters for the Interactions and Users files. Agent 365's is AGENT365_PARAMETER. */
export const INTERACTIONS_PARAMETER = 'Copilot Interactions File';
export const ORG_DATA_PARAMETER = 'Org Data File';
/** How long the installer follows the model's first refresh. */
export const FIRST_REFRESH_MS = 30 * 60_000;
/** Power BI refreshes the model this many hours after the task's run time, each day. The second catches a run that started late. */
export const REFRESH_AFTER_HOURS = [4, 10];
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * @typedef {object} PaxModelUrls
 * @property {string} interactions
 * @property {string} users
 * @property {string} agent365  Blank when the Agent 365 file is off. The template then shows no agents.
 */

/**
 * The addresses of the files in the SharePoint folder, as the report reads them.
 * @param {InstallConfig} config
 * @returns {PaxModelUrls}
 */
export function paxModelUrls(config) {
  const pax = config.pax;
  const site = pax?.site;
  if (pax?.destination !== 'sharepoint' || !site) throw new Error('The installer publishes the report only when the files go to a SharePoint folder.');
  return {
    interactions: fileUrl(site, FILES.interactions),
    users: fileUrl(site, FILES.users),
    agent365: pax.agent365 ? fileUrl(site, FILES.agent365) : '',
  };
}

/**
 * The model to deploy: the template's, with the files' addresses in its parameters. The template
 * is never modified.
 * @param {import('../transform/model.js').ModelBim} template
 * @param {PaxModelUrls} urls
 * @returns {import('../transform/model.js').ModelBim}
 */
export function buildPaxModel(template, urls) {
  const model = structuredClone(template.model);
  setMParameter(model, INTERACTIONS_PARAMETER, urls.interactions);
  setMParameter(model, ORG_DATA_PARAMETER, urls.users);
  if (urls.agent365) setMParameter(model, AGENT365_PARAMETER, urls.agent365);
  return { compatibilityLevel: template.compatibilityLevel, model };
}

/** What the model's definition is built from. deployModel adds the definition's hash. @param {PaxModelUrls} urls */
export const paxSignature = (urls) => `pax;${urls.interactions};${urls.users};${urls.agent365}`;

/** @param {unknown} err */
const isGone = (err) => err instanceof HttpError && (err.status === 404 || err.code === 'ItemNotFound' || err.code === 'WorkspaceNotFound');

/**
 * Whether the workspace turned the model down as a Fabric item, as one without a capacity may,
 * rather than failing for a reason a later run gets past, such as sign-in or throttling.
 * @param {unknown} err
 */
export function workspaceRefused(err) {
  if (err instanceof HttpError) return err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status);
  return err instanceof Error && /^Fabric operation failed/.test(err.message);
}

/**
 * The workspace for the model and report: the one in the install record, or a new one. A new one
 * has no capacity, since the PAX route's model needs no more than Power BI Pro.
 * @param {Ctx} ctx
 */
export async function ensurePaxWorkspace(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (f.workspaceId) {
    /** @type {any} */
    let ws;
    try {
      ws = await api.fabric.getWorkspace(f.workspaceId);
    } catch (err) {
      if (!isGone(err)) throw err;
      throw new Error(`Workspace ${f.workspaceName ?? f.workspaceId} no longer exists, or you can't see it. Remove "workspaceId" from the install record to create a new one.`);
    }
    f.workspaceName = ws?.displayName ?? f.workspaceName;
    if (ws?.capacityId) f.capacityId = ws.capacityId;
    else delete f.capacityId;
    ctx.save();
    ui.ok(`Workspace "${f.workspaceName ?? f.workspaceId}"`);
    return;
  }
  const name = f.workspaceName ?? DEFAULT_WORKSPACE_NAME;
  /** @type {any} */
  let ws;
  try {
    ws = await api.fabric.createWorkspace(name);
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) throw new Error(`There's a workspace called "${name}" already. Run install again and choose it, or another name.`);
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      throw new Error("You can't create Power BI workspaces in this tenant. Ask a Power BI admin to let you, or for a workspace you can publish to, then run install again and choose it.");
    }
    throw err;
  }
  Object.assign(f, { workspaceId: ws.id, workspaceName: ws.displayName ?? name, createdWorkspace: true });
  delete f.capacityId;
  ctx.save();
  ui.ok(`Created workspace "${f.workspaceName}"`);
}

/**
 * Takes on a model and report published from Power BI Desktop under the model's name. Ones that
 * were in the workspace before the model went to Power BI Desktop are never taken on.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  false when there's no such model yet.
 */
async function adoptPublished(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const before = new Set(sm.preexisting ?? []);
  const fresh = (/** @type {any[]} */ items) => items.filter((i) => !before.has(i.id));
  const model = byName(fresh(await api.fabric.listItems(ws, 'SemanticModel')), sm.name);
  if (!model) return false;
  const report = byName(fresh(await api.fabric.listItems(ws, 'Report')), sm.name);
  sm.id = model.id;
  delete sm.refreshTimes;
  sm.adopted = true;
  // Desktop's sign-in stays in Desktop. Power BI needs one of its own.
  sm.bound = false;
  if (report) sm.report = { id: report.id, name: report.displayName, modelId: model.id, adopted: true };
  ctx.save();
  ui.ok(`Found ${model.displayName}${report ? ` and the ${report.displayName} report` : ''}, published from Power BI Desktop`);
  return true;
}

/**
 * Sends the model to Power BI Desktop: gives it a name no model or report in the workspace has,
 * and notes what's there already, so only what the user publishes next is taken on.
 * @param {Ctx} ctx
 */
async function goToDesktop(ctx) {
  const { config, api } = ctx;
  const sm = config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const models = await api.fabric.listItems(ws, 'SemanticModel');
  const there = [...models, ...(await api.fabric.listItems(ws, 'Report'))];
  const wanted = sm.name;
  sm.name = freeName(wanted, displayNames(there));
  sm.preexisting = there.map((i) => i.id);
  sm.desktop = true;
  ctx.save();
  // The refused create has already said what the model would be called, going by the models alone.
  if (sm.name !== freeName(wanted, displayNames(models))) noteRenamed(ctx, wanted, sm.name);
}

/**
 * Forgets the recorded model when it's no longer in the workspace (someone deleted it), so the
 * steps that make or find a model run again instead of Power BI calls that get a 404.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  true when the model was gone and has been forgotten.
 */
export async function forgetMissingModel(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = config.fabric.workspaceId;
  if (!sm.id || !ws) return false;
  const models = await api.fabric.listItems(ws, 'SemanticModel');
  if (models.some((m) => m.id === sm.id)) return false;
  ui.warn(`${sm.name} isn't in "${config.fabric.workspaceName ?? DEFAULT_WORKSPACE_NAME}" any more.`);
  delete sm.id;
  delete sm.bound;
  delete sm.report;
  delete sm.refreshTimes;
  delete sm.reload;
  delete sm.adopted;
  ctx.save();
  return true;
}

/**
 * Deploys the model from the SharePoint edition's template and publishes the report on it. When
 * the workspace won't take the model from the installer, it's published from Power BI Desktop
 * instead, once the first load has written the files (see connectModel).
 * @param {Ctx} ctx
 * @returns {Promise<{ deployed: boolean, reportOk: boolean }>}  deployed: false when the model is to be published from
 *   Power BI Desktop. reportOk: false when the report on it failed to publish.
 */
export async function deployPaxModel(ctx) {
  const { ui, config, sources } = ctx;
  const sm = config.semanticModel;
  sm.enabled = true;
  const file = sources.paxModelFile;
  if (!file) throw new Error('This copy of the installer has no SharePoint edition Power BI template (a .pbit with "PBI-SharePoint" in its name) to build the model from.');
  if (sm.desktop && sm.id && !(await forgetMissingModel(ctx))) {
    ui.ok(`Semantic model ${sm.name} is in place. It was published from Power BI Desktop, so the installer leaves it as it is.`);
    return { deployed: true, reportOk: true };
  }
  if (sm.desktop && (await adoptPublished(ctx))) return { deployed: true, reportOk: true };

  const urls = paxModelUrls(config);
  const signature = paxSignature(urls);
  const before = sm.id;
  // Only the template changed: the model reads the same files, so it keeps its sign-in.
  const keepSignIn = !!before && !!sm.bound && String(sm.signature ?? '').startsWith(`${signature};`);
  try {
    await deployModel(ctx, sm, { signature, definition: () => semanticModelDefinition(buildPaxModel(loadTemplateModel(file), urls), PBISM) });
  } catch (err) {
    if (sm.id || !workspaceRefused(err)) throw err;
    ui.warn(`The workspace didn't take the model from the installer: ${/** @type {Error} */ (err).message}`);
    await goToDesktop(ctx);
    ui.info('You publish it from Power BI Desktop instead. The steps come once the first load has written the files.');
    return { deployed: false, reportOk: true };
  }
  if (keepSignIn && sm.id === before) sm.bound = true;
  // A model made again, after the old one was deleted, has none of its refresh schedule.
  if (sm.id !== before) delete sm.refreshTimes;
  delete sm.desktop;
  ctx.save();
  try {
    await deployReport(ctx, { model: sm, file, name: REPORT_NAME });
  } catch (err) {
    ui.fail(`The ${sm.report?.name ?? REPORT_NAME} report wasn't published: ${/** @type {Error} */ (err).message}`);
    ui.info(`Fix the problem, then run "${commandLine('update')}".`);
    return { deployed: true, reportOk: false };
  }
  return { deployed: true, reportOk: true };
}

/**
 * The template's parameters and what to enter for them, one line each.
 * @param {{ interactions: string, users: string, agent365: string }} values
 */
export const parameterLines = (values) => [
  `${INTERACTIONS_PARAMETER}: ${values.interactions}`,
  `${ORG_DATA_PARAMETER}: ${values.users}`,
  `${AGENT365_PARAMETER}: ${values.agent365 || '(leave it blank)'}`,
];

/** @param {Ctx} ctx @param {string[]} steps */
function showSteps(ctx, steps) {
  steps.forEach((s, i) => ctx.ui.info(`  ${i + 1}. ${s}`));
}

/**
 * The clicks that publish the model and report from Power BI Desktop.
 * @param {InstallConfig} config
 * @param {string} [template]  The SharePoint edition's .pbit.
 */
export function desktopSteps(config, template) {
  return [
    `Open ${template ? `"${template}"` : 'the SharePoint edition\'s .pbit ("AIO Dashboard - Rollup Edition - PBI-SharePoint")'} in Power BI Desktop.`,
    `When it asks for the parameters, enter these, then choose Load: ${parameterLines(paxModelUrls(config)).join('; ')}.`,
    'When it asks how to connect to SharePoint, choose "Organizational account", sign in and choose Connect.',
    `Once it has loaded, save it as "${config.semanticModel.name}", choose Publish and pick the workspace "${config.fabric.workspaceName ?? DEFAULT_WORKSPACE_NAME}".`,
  ];
}

/**
 * Has the user publish the model and report from Power BI Desktop, then finds them.
 * @param {Ctx} ctx
 */
async function publishFromDesktop(ctx) {
  const { ui, config, sources } = ctx;
  const sm = config.semanticModel;
  if (await adoptPublished(ctx)) return;
  ui.info(`The workspace didn't take ${sm.name} from the installer, so publish it from Power BI Desktop:`);
  showSteps(ctx, desktopSteps(config, sources.paxModelFile));
  const done = await ui.select(
    'Have you published it?',
    [
      { name: "I've published it", value: true, description: 'The installer finds it in the workspace.' },
      { name: 'Later', value: false, description: `Run "${commandLine('check')}" once you have.` },
    ],
    false,
  );
  if (!done) return;
  if (!(await adoptPublished(ctx))) ui.warn(`There's no ${sm.name} in "${config.fabric.workspaceName ?? DEFAULT_WORKSPACE_NAME}" yet. Run "${commandLine('check')}" once it's published.`);
}

/**
 * The clicks that sign the model in to the files.
 * @param {InstallConfig} config
 */
export function signInSteps(config) {
  const sm = config.semanticModel;
  const site = config.pax?.site;
  return [
    `Open ${modelSettingsUrl(/** @type {string} */ (config.fabric.workspaceId), /** @type {string} */ (sm.id))}`,
    'Expand "Data source credentials".',
    'For each data source, choose "Edit credentials", set the authentication method to OAuth2 and the privacy level to Organizational, then choose "Sign in".',
    `Sign in as someone who can open the files in ${site ? folderLabel(site) : 'the SharePoint folder'}: usually you.`,
  ];
}

/**
 * Asks the model's owner to sign it in to the files, in Power BI. SharePoint takes only a person's
 * sign-in, or an app's certificate, which a Power BI connection can't hold.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether they say it's done.
 */
async function signIn(ctx) {
  const { ui, config } = ctx;
  const sm = config.semanticModel;
  ui.info(`${sm.name} reads the files in SharePoint with the sign-in of someone who can open them. Power BI takes it only on the model's settings page, so sign it in once:`);
  showSteps(ctx, signInSteps(config));
  const done = await ui.select(
    'Have you signed it in?',
    [
      { name: "I've signed it in", value: true, description: 'The installer refreshes it now.' },
      { name: 'Skip for now', value: false, description: `Run "${commandLine('check')}" once you have.` },
    ],
    false,
  );
  if (!done) {
    ui.note(`${sm.name} can't load the files until it's signed in. Run "${commandLine('check')}" once it is.`);
    return false;
  }
  sm.bound = true;
  ctx.save();
  return true;
}

/**
 * @typedef {object} PaxRefresh
 * @property {boolean} ok  It completed.
 * @property {string} [status]  Power BI's last word on it.
 * @property {boolean} [running]  It was still going when the installer stopped waiting.
 * @property {boolean} [credentials]  It failed for want of the model's sign-in.
 * @property {string} [error]
 */

/** @param {any} entry */
function refreshError(entry) {
  const raw = entry?.serviceExceptionJson;
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return String([parsed.errorCode, parsed.errorDescription].filter(Boolean).join(': ') || raw).slice(0, 600);
  } catch {
    return String(raw).slice(0, 600);
  }
}

const CREDENTIALS = /credential|oauth|unauthori[sz]ed|forbidden/i;

/**
 * Power BI refusing a refresh because one is running: 409, or 400 with a message that says so
 * ("Another refresh request is already executing").
 * @param {HttpError} err
 */
const refreshConflict = (err) => err.status === 409 || (err.status === 400 && /already executing|another refresh|in progress/i.test(err.message));

/**
 * The newest refresh Power BI lists as running. It lists one as Unknown; older entries may be
 * refreshes that finished.
 * @param {any[]} history
 */
const newestRunning = (history) =>
  history.filter((e) => e.status === 'Unknown').sort((a, b) => (Date.parse(b.startTime) || 0) - (Date.parse(a.startTime) || 0))[0];

/**
 * Refreshes the model with a plain refresh, which works in a workspace without a capacity, unlike
 * the enhanced refresh the Fabric route uses, and follows it in the model's refresh history. Each
 * refresh counts towards Power BI Pro's 8 a day.
 * @param {Ctx} ctx
 * @param {{ timeoutMs: number }} o
 * @returns {Promise<PaxRefresh>}
 */
export async function refreshPaxModel(ctx, o) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const id = /** @type {string} */ (sm.id);
  if (sm.reload?.unsettled) {
    ui.warn(`${sm.name}'s last update may not have finished, so it isn't refreshed now. Run "${commandLine('update')}" to apply it again.`);
    return { ok: false };
  }
  const askedAt = ctx.now().getTime();
  let since = askedAt - 60_000;
  let requestId = '';
  for (let attempt = 1; ; attempt++) {
    try {
      requestId = await api.powerBi.startRefresh(ws, id);
      ui.info(`Refreshing ${sm.name}. The first load of a large history can take a while.`);
      break;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.status === 400 && CREDENTIALS.test(err.message)) {
        ui.fail(`Power BI won't refresh ${sm.name}: it isn't signed in to the files`);
        sm.bound = false;
        ctx.save();
        return { ok: false, status: 'Failed', credentials: true, error: err.message };
      }
      if (!refreshConflict(err)) throw err;
      const running = newestRunning(await api.powerBi.refreshes(ws, id, 5));
      if (running) {
        requestId = running.requestId ?? '';
        since = Math.min(since, Date.parse(running.startTime) || since);
        ui.info(`${sm.name} is refreshing already. Following that refresh.`);
        break;
      }
      // The refresh Power BI ran into has finished since, or isn't listed yet.
      if (attempt === 2) throw err;
    }
  }
  const progress = ui.progress('Refresh');
  const polls = Math.max(1, Math.ceil(o.timeoutMs / REFRESH_POLL_MS));
  /** @type {any} */
  let entry;
  for (let i = 0; i < polls; i++) {
    const history = await api.powerBi.refreshes(ws, id, 5);
    entry = (requestId && history.find((e) => e.requestId === requestId)) || history.find((e) => Date.parse(e.startTime) >= since);
    const state = entry?.status ?? 'NotStarted';
    if (REFRESH_FINAL.has(state)) break;
    progress.update(state === 'Unknown' ? 'in progress' : state);
    if (i < polls - 1) await ctx.sleep(REFRESH_POLL_MS);
  }
  const waited = progress.done();
  const status = entry?.status;
  if (status === 'Completed') {
    const took = Date.parse(entry.endTime) - Date.parse(entry.startTime);
    ui.ok(`Refreshed ${sm.name} (${formatDuration(Number.isFinite(took) && took >= 0 ? took : waited)})`);
    delete sm.reload;
    ctx.save();
    return { ok: true, status };
  }
  if (status && REFRESH_FINAL.has(status)) {
    const error = refreshError(entry);
    const credentials = CREDENTIALS.test(error);
    ui.fail(`${sm.name}'s refresh ${status === 'Failed' ? 'failed' : `ended: ${status}`}`);
    if (error) ui.info(error);
    if (credentials) {
      sm.bound = false;
      ctx.save();
    }
    return { ok: false, status, credentials, error };
  }
  ui.warn(`${sm.name} is still refreshing. Check later with "${commandLine('status')}".`);
  return { ok: false, status: status ?? 'NotStarted', running: true };
}

/**
 * When Power BI refreshes the model each day: some hours after the task's run, on the hour or
 * half hour.
 * @param {string} runAt  HH:mm.
 * @returns {string[]}  HH:mm, earliest first.
 */
export function refreshTimes(runAt) {
  const [h, m] = String(runAt).split(':').map(Number);
  const start = (Number.isInteger(h) ? h : 2) * 60 + (Number.isInteger(m) ? m : 0);
  const times = REFRESH_AFTER_HOURS.map((after) => {
    const at = (Math.ceil((start + after * 60) / 30) * 30) % (24 * 60);
    return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
  });
  return [...new Set(times)].sort();
}

/** @param {unknown} time  H:mm or HH:mm. */
const hhmm = (time) => String(time).replace(/^(\d):/, '0$1:');

/**
 * Has Power BI refresh the model each day after the task's run, unless its live schedule is
 * already on at those times in the PC's time zone. Power BI turns a schedule off by itself, after
 * four failed refreshes in a row or two months with nobody opening the report, so this reads it.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}
 */
export async function ensureRefreshSchedule(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const runAt = config.pax?.runAt ?? DEFAULT_RUN_AT;
  const times = refreshTimes(runAt);
  if (!sm.id) return false;
  const zone = config.pax?.timeZone ?? 'UTC';
  /** @type {any} */
  let live = null;
  try {
    live = await api.powerBi.refreshSchedule(ws, sm.id);
  } catch {
    // Setting it says what's wrong, if anything is.
  }
  const liveTimes = (Array.isArray(live?.times) ? live.times.map(hhmm) : []).sort().join(',');
  if (live?.enabled === true && liveTimes === times.join(',') && live.localTimeZoneId === zone) {
    if (sm.refreshTimes?.join(',') !== times.join(',')) {
      sm.refreshTimes = times;
      ctx.save();
    }
    return true;
  }
  if (live?.enabled === false && sm.refreshTimes) {
    ui.warn(`Power BI had turned off the daily refresh of ${sm.name}. It does that after four refreshes in a row fail, or when nobody opens the report for two months. Turning it back on.`);
  }
  try {
    await api.powerBi.setRefreshSchedule(ws, sm.id, { enabled: true, days: WEEK, times, localTimeZoneId: zone, notifyOption: 'MailOnFailure' });
  } catch (err) {
    ui.warn(`Couldn't have Power BI refresh ${sm.name} each day: ${/** @type {Error} */ (err).message}`);
    ui.info(`Open ${modelSettingsUrl(ws, sm.id)}, expand "Refresh", turn on "Configure a refresh schedule" and add ${times.join(' and ')} (${zone}).`);
    return false;
  }
  sm.refreshTimes = times;
  ctx.save();
  ui.ok(`Power BI refreshes ${sm.name} at ${times.join(' and ')} each day (${zone}), after the task's run at ${runAt}`);
  return true;
}

/**
 * Signs the model in when it isn't, and refreshes it. When the refresh fails for want of the
 * sign-in, asks once more.
 * @param {Ctx} ctx
 * @returns {Promise<PaxRefresh | null>}  null when the model isn't signed in.
 */
async function signInAndRefresh(ctx) {
  const sm = ctx.config.semanticModel;
  for (let attempt = 1; ; attempt++) {
    if (!sm.bound && !(await signIn(ctx))) return null;
    const r = await refreshPaxModel(ctx, { timeoutMs: FIRST_REFRESH_MS });
    if (!r.credentials || attempt === 2) return r;
    ctx.ui.info('Power BI needs the model signed in again.');
  }
}

/**
 * Once the files are in the SharePoint folder: publishes the model from Power BI Desktop when the
 * workspace wouldn't take it from the installer, has its owner sign it in, refreshes it, has Power
 * BI refresh it each day, and asks it a test query.
 * @param {Ctx} ctx
 * @param {{ check?: AccessCheck }} [o]  check: the script's access check, when it has just run.
 * @returns {Promise<boolean>}  true when the model loaded the files and answers queries, or when
 *   there are no files because the task hasn't found any Copilot interactions yet.
 */
export async function connectModel(ctx, o = {}) {
  const { ui, config } = ctx;
  const pax = config.pax;
  const sm = config.semanticModel;
  const site = pax?.site;
  if (pax?.destination !== 'sharepoint' || !site) return false;
  const check = o.check ?? (await checkAccess(runPwshOf(ctx), ctx.env));
  if (!check.ok) {
    ui.warn(`Couldn't look at the files in ${folderLabel(site)}. ${describeCheck(check)}`);
    return false;
  }
  const wanted = [FILES.interactions, FILES.users, ...(pax.agent365 ? [FILES.agent365] : [])];
  const missing = wanted.filter((name) => !check.files?.some((f) => f.exists && f.name.toLowerCase() === name.toLowerCase()));
  if (missing.length === wanted.length && readLastRun(ctx.env)?.noData) {
    ui.warn(noDataYet(sm.name));
    return true;
  }
  if (missing.length) {
    ui.warn(`${missing.join(' and ')} ${missing.length === 1 ? "isn't" : "aren't"} in ${folderLabel(site)} yet, so ${sm.name} has nothing to load.`);
    ui.info(`Once "${commandLine('status')}" shows the first run finished, run "${commandLine('check')}".`);
    return false;
  }
  await forgetMissingModel(ctx);
  if (sm.desktop && !sm.id) await publishFromDesktop(ctx);
  if (!sm.id) {
    if (!sm.desktop) ui.warn(`${sm.name} isn't deployed. Run "${commandLine('update')}".`);
    return false;
  }
  const r = await signInAndRefresh(ctx);
  if (!r || (!r.ok && !r.running)) return false;
  await ensureRefreshSchedule(ctx);
  if (!r.ok) return false;
  return (await verifyModel(ctx)).ok;
}

/**
 * Gives the viewer group Build on the model and has the user share the report with it.
 * @param {Ctx} ctx
 */
export async function paxViewerAccess(ctx) {
  const { ui, config } = ctx;
  const sm = config.semanticModel;
  const group = await ensureViewerGroup(ctx);
  if (!group) return;
  if (!sm.id) {
    ui.note(`${sm.name} isn't published yet. Once it is, run "${commandLine('access')}" to give "${group.displayName}" access.`);
    return;
  }
  await grantModelAccess(ctx, [{ workspaceId: /** @type {string} */ (config.fabric.workspaceId), datasetId: sm.id, name: sm.name }]);
  await shareReport(ctx);
  if (!config.fabric.capacityId) ui.note('The workspace has no capacity, so each viewer needs a Power BI Pro or Premium Per User licence.');
}

/**
 * When the files stay on this PC: how to open the report on them in Power BI Desktop.
 * @param {Ctx} ctx
 */
export function localGuidance(ctx) {
  const { ui, config, sources } = ctx;
  const pax = config.pax;
  if (pax?.destination !== 'local' || !pax.localFolder) return;
  const folder = pax.localFolder;
  const file = sources.rollupModelFile;
  ui.info('The files stay on this PC, so open the report on them in Power BI Desktop:');
  showSteps(ctx, [
    `Open ${file ? `"${file}"` : 'the Rollup Edition .pbit ("AIO Dashboard - Rollup Edition") from the AI in One repository'} in Power BI Desktop.`,
    `When it asks for the parameters, enter these, then choose Load: ${parameterLines({
      interactions: join(folder, FILES.interactions),
      users: join(folder, FILES.users),
      agent365: pax.agent365 ? join(folder, FILES.agent365) : '',
    }).join('; ')}.`,
    'Save it. Choose Refresh in Desktop after each day\'s run to see the new data.',
  ]);
}
