// @ts-check
/**
 * Wires the clients together and runs each command.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkTokens, createCredential, createTokenProvider, decodeJwt } from './auth.js';
import { notebooksFor, permissionsFor } from './catalog.js';
import { armApi, keyVaultApi } from './clients/azure.js';
import { fabricApi, scheduleBody } from './clients/fabric.js';
import { CONSENT_ROLES, graphApi } from './clients/graph.js';
import { ONELAKE_URL, oneLakeApi } from './clients/onelake.js';
import { powerBiApi } from './clients/powerbi.js';
import { DEFAULT_CONFIG_FILE, saveConfig, secretMode, targetOf } from './config.js';
import { createClient, defaultSleep } from './http.js';
import { commandLine } from './launch.js';
import { paxInstall, runPaxCommand } from './pax/flow.js';
import { confirmPaxPlan, paxPlan, paxPreflight } from './pax/plan.js';
import { paxPreview } from './pax/preview.js';
import { checkPrereqs } from './prereqs.js';
import { reviewSetup } from './setup.js';
import { accessCommand, accessSummaryLines, ensureViewerGroup, grantModelAccess, shareReport } from './steps/access.js';
import {
  DEFAULT_LAKEHOUSE_NAME,
  describeSchedule,
  ensureLakehouse,
  ensureNotebooks,
  ensurePipeline,
  ensureSchedule,
  ensureSparkSettings,
  ensureVaultEndpoint,
  ensureWorkspace,
  modelDeployed,
  notebookSettings,
  PIPELINE_NAME,
  pipelineSettings,
} from './steps/fabric.js';
import { fabricUninstall } from './steps/fabric-uninstall.js';
import { ensureApp, ensureConsent, ensureKeyVault, newSecret, notebookSecretDays } from './steps/identity.js';
import { ensureModelConnection, ensureSemanticModel, modelUrl, pendingReloads, refreshModel, rotateModelSecret, settleReloads, verifyModel } from './steps/model.js';
import { nextSteps, stepsLeftTitle } from './steps/next-steps.js';
import { confirmPlan, plan, preflight } from './steps/plan.js';
import { ensureReports, reportsOn, reportsSummary } from './steps/report.js';
import { rerunFailed } from './steps/rerun.js';
import { checkData, chooseLoad, runDataCheck, runPipeline, status, TERMINAL } from './steps/run.js';
import { buildModel, loadTemplateModel, MODEL_TEMPLATE } from './transform/model.js';
import { prepareNotebook, serialiseNotebook } from './transform/notebook.js';
import { buildPipeline } from './transform/pipeline.js';
import { loadTemplateReport, reportDefinition } from './transform/report.js';
import { c } from './ui.js';

/** Why deploy-app and --environment-id don't go with the Fabric route. */
export const APP_NEEDS_PAX = 'The AI in One app reads the files PAX writes, so it comes with the PAX route only. To set that up, run the installer with --target pax and a new install record.';

/**
 * @typedef {object} Apis
 * @property {import('./clients/fabric.js').FabricApi} fabric
 * @property {import('./clients/graph.js').GraphApi} graph
 * @property {import('./clients/azure.js').ArmApi} arm  Azure Resource Manager, for the Key Vault when there is one.
 * @property {import('./clients/azure.js').KeyVaultApi} keyVault
 * @property {import('./clients/onelake.js').OneLakeApi} oneLake
 * @property {import('./clients/powerbi.js').PowerBiApi} powerBi
 *
 * @typedef {{ id: string, upn: string, tenantId: string, displayName?: string }} User
 *
 * @typedef {object} Ctx
 * @property {import('./ui.js').Ui} ui
 * @property {import('./config.js').InstallConfig} config
 * @property {string} file
 * @property {() => void} save  Writes the install record.
 * @property {Apis} api
 * @property {User} user
 * @property {import('./sources.js').Sources} sources
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => Date} now
 * @property {string} [pendingSecret]  A secret the user pasted, held in memory until it is in Key Vault or the notebooks.
 * @property {boolean} [secretInNotebook]  --no-key-vault (or --secret-in-notebook): keep the secret in the notebooks instead of Key Vault.
 * @property {boolean} [useKeyVault]  --key-vault: keep the secret in Key Vault. Without it, a new install keeps it in the notebooks by default.
 * @property {boolean} [allowModelReset]  --allow-model-reset: when Fabric can't update a model and keep its data, clear it and reload it without asking. --yes alone never does.
 * @property {Apis} [liveApi]  While the plan's answers can be rewound, the clients without the cache, for checks the user repeats.
 * @property {boolean} [runFirstLoad]
 * @property {boolean} [advanced]  The plan's "Change the advanced settings?" answer. With false, those settings keep their saved value or default.
 * @property {number} [reloadHistoryDays]  Repair or change: reload this many days of audit history after setup.
 * @property {{ sp: any, roles: { id: string, value: string }[], key: string }} [graphRoles]  Graph's service principal and the app roles for the permissions in key.
 * @property {string} [configFile]  The install record's path.
 * @property {(resource: import('./auth.js').Resource) => Promise<string>} [getToken]  The signed-in user's tokens, for tools the installer runs.
 * @property {'browser' | 'device-code' | 'azure-cli'} [method]  How the user signed in, for a second sign-in that asks for other permissions.
 * @property {string} [environmentId]  --environment-id: the Power Platform environment for the AI in One app.
 * @property {import('./pax/ps.js').RunPwsh} [runPwsh]  Runs PowerShell 7 on this PC, for the PAX route. Tests pass a fake.
 * @property {NodeJS.ProcessEnv} [env]  Where the PAX route's local state lives (LOCALAPPDATA). process.env when absent.
 * @property {import('./clients/graph.js').SitesApi} [sites]  SharePoint, signed in again with Sites.FullControl.All to give the PAX app access to its site. Made when first needed; tests pass a fake.
 * @property {string} [setupSection] Open this settings category directly after a failure.
 * @property {boolean} [setupRetry] Revalidate saved choices without reopening every question.
 */

/**
 * Signs in once and builds a client for each API.
 * @param {{ tenantId?: string, method?: 'browser' | 'device-code' | 'azure-cli', ui: import('./ui.js').Ui, debug?: (m: string) => void, checkTokens?: boolean }} opts
 *   checkTokens: get a token for every API first, so a sign-in that can't reach one fails before anything changes.
 * @returns {Promise<{ api: Apis, user: User, getToken: (resource: import('./auth.js').Resource) => Promise<string> }>}
 */
export async function connect(opts) {
  const credential = createCredential({ tenantId: opts.tenantId, method: opts.method, print: (m) => opts.ui.line(m) });
  const getToken = createTokenProvider(credential, { debug: opts.debug });
  /**
   * @param {string} baseUrl
   * @param {import('./auth.js').Resource} resource
   */
  const client = (baseUrl, resource) => createClient({ baseUrl, getToken: () => getToken(resource), debug: opts.debug });
  /** @type {Apis} */
  const api = {
    fabric: fabricApi(client('https://api.fabric.microsoft.com/v1', 'fabric')),
    graph: graphApi(client('https://graph.microsoft.com/v1.0', 'graph')),
    arm: armApi(client('https://management.azure.com', 'arm')),
    keyVault: keyVaultApi(client('https://vault.azure.net', 'keyVault')),
    oneLake: oneLakeApi(client(ONELAKE_URL, 'storage')),
    powerBi: powerBiApi(client('https://api.powerbi.com/v1.0/myorg', 'powerbi')),
  };
  if (opts.checkTokens) await checkTokens(getToken);
  const claims = decodeJwt(await getToken('graph'));
  const me = await api.graph.me();
  return { api, user: { id: me.id, upn: me.userPrincipalName, displayName: me.displayName, tenantId: claims.tid }, getToken };
}

/**
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, file: string, api: Apis, user: User, sources: import('./sources.js').Sources, sleep?: (ms: number) => Promise<void>, now?: () => Date, getToken?: (resource: import('./auth.js').Resource) => Promise<string>, method?: 'browser' | 'device-code' | 'azure-cli', runPwsh?: import('./pax/ps.js').RunPwsh, env?: NodeJS.ProcessEnv }} o
 * @returns {Ctx}
 */
export function createCtx(o) {
  if (o.config.tenantId && o.user.tenantId && o.config.tenantId !== o.user.tenantId) {
    throw new Error(`The install record is for tenant ${o.config.tenantId}, but you signed in to ${o.user.tenantId}. Use --tenant ${o.config.tenantId}.`);
  }
  o.config.tenantId = o.user.tenantId;
  return {
    ui: o.ui,
    config: o.config,
    file: o.file,
    save: () => saveConfig(o.file, o.config),
    api: o.api,
    user: o.user,
    sources: o.sources,
    sleep: o.sleep ?? defaultSleep,
    now: o.now ?? (() => new Date()),
    configFile: o.file,
    ...(o.getToken ? { getToken: o.getToken } : {}),
    ...(o.method ? { method: o.method } : {}),
    ...(o.runPwsh ? { runPwsh: o.runPwsh } : {}),
    ...(o.env ? { env: o.env } : {}),
  };
}

/** Whether the signed-in user can grant admin consent for Graph application permissions. @param {Ctx} ctx */
export async function canConsent(ctx) {
  const roles = await ctx.api.graph.myDirectoryRoles().catch(() => []);
  return roles.some((r) => r.roleTemplateId in CONSENT_ROLES);
}

/**
 * The same clients, except that a call made again with the same arguments gets the first call's
 * answer. Going back runs the plan's questions again from the start: this keeps that quick, and
 * keeps the lists the same as the first time. A call that fails isn't kept.
 * @param {Apis} api
 * @returns {Apis}
 */
export function memoApi(api) {
  /** @type {Map<string, Promise<unknown>>} */
  const seen = new Map();
  const copy = (/** @type {unknown} */ v) => {
    try {
      return structuredClone(v);
    } catch {
      return v;
    }
  };
  /** @param {string} client @param {string} name @param {unknown[]} args */
  const keyOf = (client, name, args) => {
    if (args.some((a) => typeof a === 'function')) return undefined;
    try {
      return `${client}.${name}(${JSON.stringify(args)})`;
    } catch {
      return undefined;
    }
  };
  /** @param {string} client @param {object} target */
  const wrap = (client, target) =>
    new Proxy(target, {
      get(t, name, receiver) {
        const fn = Reflect.get(t, name, receiver);
        if (typeof fn !== 'function' || typeof name !== 'string') return fn;
        return (/** @type {unknown[]} */ ...args) => {
          const key = keyOf(client, name, args);
          if (key === undefined) return fn.apply(t, args);
          let p = seen.get(key);
          if (!p) {
            const result = fn.apply(t, args);
            if (!result || typeof result.then !== 'function') return result;
            const mine = Promise.resolve(result);
            seen.set(key, mine);
            mine.catch(() => {
              if (seen.get(key) === mine) seen.delete(key);
            });
            p = mine;
          }
          return p.then(copy);
        };
      },
    });
  return /** @type {Apis} */ (Object.fromEntries(Object.entries(api).map(([client, v]) => [client, v && typeof v === 'object' ? wrap(client, v) : v])));
}

/**
 * Runs the questions in `fn`, and runs them again from the start each time the user goes back.
 * The web UI gives the earlier answers again by itself, so it stops at the question before the
 * one the user was on. The config and the answers kept on `ctx` are put back first, and the API
 * calls are reused. The terminal can't go back, so there `fn` just runs.
 * @template T
 * @param {Ctx} ctx
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function rewindable(ctx, fn) {
  const ui = /** @type {{ begin?: () => void, end?: () => void }} */ (/** @type {unknown} */ (ctx.ui));
  if (!ui.begin || !ui.end) return fn();
  // save() writes this object, so it's put back in place rather than replaced.
  const config = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (ctx.config));
  const snapshot = structuredClone(config);
  const { pendingSecret, runFirstLoad, reloadHistoryDays } = ctx;
  const real = ctx.api;
  ctx.api = memoApi(real);
  ctx.liveApi = real;
  ui.begin();
  try {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (/** @type {Error | undefined} */ (err)?.name !== 'GoBack') throw err;
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, structuredClone(snapshot));
        ctx.pendingSecret = pendingSecret;
        ctx.runFirstLoad = runFirstLoad;
        ctx.reloadHistoryDays = reloadHistoryDays;
      }
    }
  } finally {
    ctx.api = real;
    delete ctx.liveApi;
    ui.end();
  }
}

/**
 * Full set-up, or a repair when the install record already has IDs.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 * @returns {Promise<boolean>} false when a step failed and the install carried on, or the first load or model refresh it
 *   waited for didn't leave a working model.
 */
export async function install(ctx, opts) {
  const { ui, config } = ctx;
  const pax = targetOf(config) === 'pax';
  let go;
  /** @type {import('./steps/plan.js').Preflight | undefined} */
  let pre;
  if (ui.web) {
    go = await reviewSetup(ctx);
    if (go) pre = pax ? await paxPreflight(ctx) : await preflight(ctx);
  } else if (pax) {
    const checked = await paxPreflight(ctx);
    pre = checked;
    go = await rewindable(ctx, async () => {
      await paxPlan(ctx, checked);
      ctx.save();
      return confirmPaxPlan(ctx, checked);
    });
  } else {
    pre = await preflight(ctx);
    const checked = pre;
    go = await rewindable(ctx, async () => {
      await plan(ctx, checked);
      ctx.save();
      return confirmPlan(ctx, checked);
    });
  }
  if (!go) {
    ui.warn('Stopped before changing anything. Your answers are saved for next time.');
    return true;
  }
  if (pax) return paxInstall(ctx, { ...opts, pre });

  const sm = config.semanticModel;
  const withModel = !!sm.enabled;
  const withReports = reportsOn(config);
  const withAccess = withModel && !!config.access;
  // Once, straight after the report is published and before the long first load.
  const withShare = withAccess && withReports && config.access?.reportShared !== true;
  const titles = [
    'Key Vault',
    'App registration',
    'Microsoft Graph permissions',
    'Workspace and Lakehouse',
    ...(withModel ? ['Semantic model'] : []),
    ...(withReports ? ['Power BI report'] : []),
    'Notebooks, pipeline and schedule',
    ...(withAccess ? ['Viewer access'] : []),
    ...(withShare ? ['Share the report'] : []),
    ...(ctx.runFirstLoad ? ['First load'] : ctx.reloadHistoryDays ? ['Reload audit history'] : withModel ? ['Model refresh'] : []),
  ];
  let n = 0;
  const step = (/** @type {string} */ title) => ui.step(++n, titles.length, title);

  step('Key Vault');
  await ensureKeyVault(ctx);
  step('App registration');
  await ensureApp(ctx);
  step('Microsoft Graph permissions');
  const consented = await ensureConsent(ctx, /** @type {import('./steps/plan.js').Preflight} */ (pre));
  step('Workspace and Lakehouse');
  await ensureWorkspace(ctx);
  await ensureLakehouse(ctx);
  const vaultReachable = await ensureVaultEndpoint(ctx);
  if (withModel) {
    step('Semantic model');
    await ensureSemanticModel(ctx);
    await ensureModelConnection(ctx);
  }
  // A step that fails and lets the install carry on leaves it partly set up. One that only warns doesn't.
  let stepsOk = true;
  if (withReports) {
    step('Power BI report');
    stepsOk = (await ensureReports(ctx)) && stepsOk;
  }
  step('Notebooks, pipeline and schedule');
  // With no Key Vault, each install or repair gives the notebooks a new client secret.
  await ensureNotebooks(ctx, { rotate: true });
  await ensureSparkSettings(ctx);
  await ensurePipeline(ctx);
  await ensureSchedule(ctx);
  if (withAccess) {
    step('Viewer access');
    if (await ensureViewerGroup(ctx)) await grantModelAccess(ctx, fabricViewerModels(config));
  }
  if (withShare) {
    step('Share the report');
    await shareReport(ctx);
  }

  let ok = true;
  // The pipeline refreshes the model as its last step. When it can't, a model owed a reload is refreshed on its own.
  /** @type {import('./steps/model.js').LoadState} */
  let load = 'none';
  if (ctx.runFirstLoad) {
    step('First load');
    const later = commandLine(`run --backfill-days ${config.history.days}`);
    if (!consented) {
      ui.warn(`Skipped until admin consent is granted. Then run: ${later}`);
    } else if (!vaultReachable) {
      ui.warn(`Skipped until the private endpoint to ${config.keyVault.name} is approved. Then run: ${later}`);
    } else {
      if (modelDeployed(config)) ui.note(`The pipeline refreshes ${sm.name} as its last step.`);
      const result = await runPipeline(ctx, { backfillDays: config.history.days, wait: opts.wait, first: true });
      load = loadState(result);
      if (result.status === 'Completed') {
        // A run completes even when a load in it failed.
        if (result.failed?.length) stepsOk = false;
        if ((await runDataCheck(ctx)) === false) stepsOk = false;
        if (modelDeployed(config)) ok = (await verifyModel(ctx)).ok;
      }
      if (opts.wait && config.firstRun?.status !== 'Completed') ok = false;
    }
  } else if (ctx.reloadHistoryDays) {
    step('Reload audit history');
    const days = ctx.reloadHistoryDays;
    const later = commandLine(`run --backfill-days ${days}`);
    if (!consented) {
      ui.warn(`Skipped until admin consent is granted. Then run: ${later}`);
    } else if (!vaultReachable) {
      ui.warn(`Skipped until the private endpoint to ${config.keyVault.name} is approved. Then run: ${later}`);
    } else {
      if (modelDeployed(config)) ui.note(`The pipeline refreshes ${sm.name} as its last step.`);
      const result = await runPipeline(ctx, { backfillDays: days, wait: opts.wait });
      load = loadState(result);
      if (result.started) {
        config.history.days = days;
        ctx.save();
      }
      if (result.status === 'Completed') {
        if (result.failed?.length) stepsOk = false;
        if ((await runDataCheck(ctx)) === false) stepsOk = false;
        if (modelDeployed(config)) ok = (await verifyModel(ctx)).ok;
      } else if (opts.wait) ok = false;
    }
  } else if (withModel) {
    step('Model refresh');
    ok = await restoreModel(ctx, { wait: opts.wait });
    load = 'refreshed';
  }
  const reloads = await settleReloads(ctx, { wait: opts.wait, load, reachable: fabricReachable(config) });
  if (!reloads.ok) notFinished(ctx, 'install');
  ok = reloads.ok && ok && stepsOk;
  await summary(ctx, { ok, pending: reloads.pending, concealedNames: pre?.concealedNames });
  return ok;
}

/**
 * How far a pipeline run got with reloading the model it refreshes as its last step.
 * @param {import('./steps/run.js').RunResult} result
 * @returns {import('./steps/model.js').LoadState}
 */
export function loadState(result) {
  if (result.status === 'Completed') return 'done';
  // Failed, cancelled and the like: it won't refresh it.
  if (TERMINAL.has(/** @type {string} */ (result.status))) return 'none';
  // Started and not waited for, or another run is going: either refreshes it when it finishes.
  return 'running';
}

/**
 * The model, when it's deployed and reads the Lakehouse.
 * @param {import('./config.js').InstallConfig} config
 * @returns {import('./config.js').ModelConfig[]}
 */
function deployedModels(config) {
  return modelDeployed(config) ? [config.semanticModel] : [];
}

/** @param {string[]} names */
const joinNames = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The model the viewer group needs Build on: once it's deployed, bound to its connection or not yet.
 * @param {import('./config.js').InstallConfig} config
 * @returns {import('./steps/access.js').ModelRef[]}
 */
export function fabricViewerModels(config) {
  const ws = config.fabric.workspaceId;
  const sm = config.semanticModel;
  if (!ws || !sm.enabled || !sm.id) return [];
  return [{ workspaceId: ws, datasetId: sm.id, name: sm.name }];
}

/**
 * Refreshes the model, when it reads the Lakehouse.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean }} opts
 * @returns {Promise<{ ok: boolean, status?: string }>}
 */
async function refreshDeployedModel(ctx, opts) {
  if (modelDeployed(ctx.config)) return refreshModel(ctx, opts);
  ctx.ui.warn(`Skipped: ${ctx.config.semanticModel.name} isn't connected to the Lakehouse yet.`);
  return { ok: false };
}

/**
 * Refreshes the model and, when it waits, checks it answers queries. Not waiting, it's enough that
 * the refresh started; a model owed a reload is settled after (see settleReloads).
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 * @returns {Promise<boolean>}
 */
async function restoreModel(ctx, opts) {
  const refreshed = await refreshDeployedModel(ctx, { wait: opts.wait });
  if (!refreshed.ok) return !opts.wait;
  return opts.wait ? (await verifyModel(ctx)).ok : true;
}

/**
 * Whether a refresh can reach a Fabric model: deployed and reading the Lakehouse.
 * @param {import('./config.js').InstallConfig} config
 */
function fabricReachable(config) {
  const ids = new Set(deployedModels(config).map((m) => m.id));
  return (/** @type {import('./config.js').ModelConfig} */ m) => ids.has(m.id);
}

/**
 * Pushes the notebooks, pipeline, semantic model and report from this checkout over the deployed ones.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean }} [opts]
 */
export async function update(ctx, opts = {}) {
  const { ui, config } = ctx;
  if (!config.fabric.workspaceId || !config.fabric.lakehouseId) throw new Error('Nothing is installed yet. Run the installer first.');
  const sm = config.semanticModel;
  ui.heading('Updating AI in One');
  ui.note(`From ${ctx.sources.dir}`);
  await ensureKeyVault(ctx);
  await ensureApp(ctx);
  await ensureConsent(ctx, { canConsent: await canConsent(ctx) });
  await ensureWorkspace(ctx);
  await ensureLakehouse(ctx);
  await ensureVaultEndpoint(ctx);
  if (sm.enabled) {
    await ensureSemanticModel(ctx, { force: true });
    await ensureModelConnection(ctx);
  }
  // As in install: a step that fails and lets the update carry on leaves it unfinished.
  let stepsOk = true;
  if (reportsOn(config)) stepsOk = (await ensureReports(ctx)) && stepsOk;
  await ensureNotebooks(ctx, { force: true });
  await ensureSparkSettings(ctx);
  await ensurePipeline(ctx, { force: true });
  await ensureSchedule(ctx);
  return finishUpdate(ctx, { ...opts, failed: !stepsOk });
}

/**
 * The end of an update: refreshes the model so it loads its data with the new definitions.
 * "Up to date" only once a model owed a reload has finished reloading and no step failed; not
 * waiting, the refresh started is success, but said as such.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean, failed?: boolean }} [opts]  failed: a step before this failed, and the update carried on.
 * @returns {Promise<boolean>}
 */
export async function finishUpdate(ctx, opts = {}) {
  const { ui, config } = ctx;
  const wait = opts.wait ?? true;
  let ok = true;
  if (modelDeployed(config)) {
    ui.note('The model refreshes now, to load its data with the new definitions.');
    const refreshed = await refreshDeployedModel(ctx, { wait });
    if (!refreshed.ok) ok = false;
    else if (wait && !(await verifyModel(ctx)).ok) return false;
  }
  const reloads = await settleReloads(ctx, { wait, load: modelDeployed(config) ? 'refreshed' : 'none', reachable: fabricReachable(config) });
  if (!ok || !reloads.ok) {
    notFinished(ctx, 'update');
    return false;
  }
  if (opts.failed) {
    ui.fail(`The update isn't finished: a step above failed. Fix what it says, then run "${commandLine('update')}" again.`);
    if (reloads.pending.length) ui.warn(reloadingNote(reloads.pending));
    return false;
  }
  if (reloads.pending.length) {
    ui.ok(`Updated. ${reloadingNote(reloads.pending)}`);
    return true;
  }
  ui.ok('Up to date. The next scheduled run uses the new versions.');
  return true;
}

/** @param {string[]} names */
function reloadingNote(names) {
  return `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} still reloading: reports on ${names.length === 1 ? 'it' : 'them'} can show no data or miss new columns until that finishes. Check with "${commandLine('status')}".`;
}

/** @param {Ctx} ctx @param {'install' | 'update'} what */
function notFinished(ctx, what) {
  const cleared = pendingReloads(ctx.config).filter((m) => m.reload?.cleared).map((m) => m.name);
  if (cleared.length) ctx.ui.warn(`${joinNames(cleared)} ${cleared.length === 1 ? 'has' : 'have'} no data until a refresh finishes.`);
  ctx.ui.fail(`The ${what} isn't finished: the model wasn't reloaded. Fix the problem above, then run "${commandLine('refresh')}", or "${commandLine(what)}" again.`);
}

/**
 * Starts the pipeline: the first load until one has loaded the history, then the usual run.
 * A backfill rebuilds the audit table with just the days it loads, so one with fewer days than
 * are loaded asks first; under --yes it doesn't start.
 * @param {Ctx} ctx
 * @param {{ backfillDays?: number, wait: boolean }} opts
 * @returns {Promise<import('./steps/run.js').RunResult>}
 */
export async function run(ctx, opts) {
  const { ui, config } = ctx;
  const load = await chooseLoad(ctx, opts);
  const days = opts.backfillDays;
  const current = config.history.days;
  if (!load.first && days && days < current) {
    ui.warn(`This rebuilds the audit table with ${days} days of history, so the ${current} days loaded now drop to ${days}.`);
    if (!(await ui.confirm(`Reload only ${days} days?`, false))) {
      ui.note(`Nothing started. To keep the history you have, run "${commandLine(`run --backfill-days ${current}`)}" or more.`);
      // Under --yes nobody was asked, so the run it was told to start counts as not done.
      return { started: false, ok: false, declined: !ui.yes };
    }
  }
  const result = await runPipeline(ctx, load);
  // The table now holds the days this run loads, fewer or more than before.
  if (result.started && days) {
    config.history.days = days;
    ctx.save();
  }
  if (result.status === 'Completed') await runDataCheck(ctx);
  return result;
}

export { status };

/**
 * Refreshes the semantic model now.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 */
export async function refresh(ctx, opts) {
  if (!ctx.config.semanticModel.id) throw new Error('There is no semantic model yet. Run the installer first.');
  return refreshModel(ctx, opts);
}

/**
 * Prints what the signed-in user has and lacks for an install. Changes nothing.
 * @param {Ctx} ctx
 */
export async function showPrereqs(ctx) {
  ctx.ui.heading('Prerequisites');
  ctx.ui.ok(`Signed in as ${ctx.user.upn} (tenant ${ctx.user.tenantId})`);
  const items = await checkPrereqs(ctx);
  ctx.ui.prereqs(items);
  return items;
}

/**
 * Runs one command against a signed-in context.
 * @param {Ctx} ctx
 * @param {string} command
 * @param {{ wait: boolean, backfillDays?: number }} opts
 * @returns {Promise<boolean>} false when a step failed, or a run or refresh it waited for didn't succeed.
 */
export async function runCommand(ctx, command, opts) {
  // prereqs works before anything is installed, and its checklist covers both routes.
  if (command !== 'install' && command !== 'prereqs' && targetOf(ctx.config) === 'pax') return runPaxCommand(ctx, command, opts);
  switch (command) {
    case 'install':
      return install(ctx, opts);
    case 'update':
      return (await update(ctx, opts)) !== false;
    case 'run': {
      const result = await run(ctx, opts);
      return !opts.wait || !!result.ok || !!result.declined;
    }
    case 'rerun-failed':
      return !(await rerunFailed(ctx)).failed.length;
    case 'check': {
      const checked = !!(await checkData(ctx));
      if (!modelDeployed(ctx.config)) return checked;
      return (await verifyModel(ctx)).ok && checked;
    }
    case 'refresh': {
      const result = await refresh(ctx, opts);
      return !opts.wait || result.ok;
    }
    case 'status':
      await status(ctx);
      return true;
    case 'rotate-secret':
      await rotateSecret(ctx);
      return true;
    case 'uninstall':
      await fabricUninstall(ctx);
      return true;
    case 'prereqs':
      await showPrereqs(ctx);
      return true;
    case 'access':
      await accessCommand(ctx, fabricViewerModels(ctx.config));
      return true;
    case 'deploy-app':
      throw new Error(APP_NEEDS_PAX);
    default:
      throw new Error(`Unknown command "${command}".`);
  }
}

/** @param {Ctx} ctx */
export async function rotateSecret(ctx) {
  const { ui, config } = ctx;
  const mode = secretMode(config);
  if (!config.app.appId || (mode === 'notebook' ? !config.fabric.workspaceId : !config.keyVault.uri)) throw new Error('Nothing is installed yet. Run the installer first.');
  const sm = config.semanticModel;
  ui.heading('New client secret');
  ui.info(`App: ${config.app.displayName ?? config.app.appId}`);
  if (mode === 'notebook') ui.info('Secret: in the notebooks (no Key Vault)');
  else ui.info(`Key Vault: ${config.keyVault.name}, secret ${config.keyVault.secretName}`);
  if (sm.connectionId) ui.info(`Connection: ${sm.connectionName}, used by ${sm.name}`);
  if (mode === 'notebook') {
    ui.note(
      config.app.existing
        ? 'You paste the new secret, and the notebooks are rewritten with it. Then delete the old one from the app\'s Certificates & secrets page.'
        : `A new secret, valid for ${notebookSecretDays(config)} days, is written into the notebooks, then the old one is removed from the app, so copies of it in run snapshots, exports or Git stop working.`,
    );
    if (!(await ui.confirm(`Create a new secret and rewrite the notebooks${sm.connectionId ? ', and replace the connection\'s' : ''}?`, true))) return;
    await ensureNotebooks(ctx, { force: true });
    if (sm.connectionId) await rotateModelSecret(ctx);
    ui.note('Anyone with a role in the workspace can read the secret in the notebooks. Key Vault avoids that: run the installer again and choose Use Key Vault instead.');
    return;
  }
  if (mode === 'keyvault-admin') {
    if (!(await ui.confirm(`Show the steps for a vault admin to replace the secret in ${config.keyVault.name}${sm.connectionId ? ', and replace the connection\'s' : ''}?`, true))) return;
  } else {
    ui.note('The notebooks\' old secret keeps working until it expires. Delete it from the app\'s Certificates & secrets page once a run has succeeded.');
    if (!(await ui.confirm(`Create new secrets and replace the one in Key Vault${sm.connectionId ? ' and the connection\'s' : ''}?`, true))) return;
  }
  await newSecret(ctx);
  if (sm.connectionId) await rotateModelSecret(ctx);
}

/**
 * Prints where everything is and what to do next.
 * @param {Ctx} ctx
 * @param {{ ok?: boolean, pending?: string[], concealedNames?: boolean }} [opts]  ok false when a step above failed, so the heading doesn't say it is all set up;
 *   pending: models still reloading after their update; concealedNames: the tenant check found that Microsoft 365 reports conceal
 *   user names, so a card says how to show them.
 */
export async function summary(ctx, opts = {}) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);

  if (opts.ok === false) {
    ui.heading('AI in One is partly set up');
    ui.warn('A step above didn\'t finish. Fix what it says, then run the installer again: it picks up where it stopped.');
    if (opts.pending?.length) ui.warn(reloadingNote(opts.pending));
  } else if (opts.pending?.length) {
    ui.heading('AI in One is set up, still reloading');
    ui.warn(reloadingNote(opts.pending));
  } else {
    ui.heading('AI in One is set up');
  }
  const left = nextSteps(config, ctx.user, { concealedNames: opts.concealedNames });
  if (left.length) ui.nextSteps(stepsLeftTitle(left), left);
  ui.info(`Workspace:  ${f.workspaceName}  ${c.dim(`https://app.fabric.microsoft.com/groups/${ws}`)}`);
  ui.info(`Lakehouse:  ${f.lakehouseName}`);
  ui.info(`Pipeline:   ${f.pipelineName ?? PIPELINE_NAME}, ${describeSchedule(config.schedule)}`);
  const mode = secretMode(config);
  const expires = config.app.secretExpires ? `, expires ${config.app.secretExpires.slice(0, 10)}` : '';
  const expiresOn = config.app.secretExpires ? ` on ${config.app.secretExpires.slice(0, 10)}` : '';
  if (mode === 'notebook') ui.info(`Secret:     in the notebooks${expires}  ${c.dim('No Key Vault: anyone with a role in the workspace can read it. Each install, repair or update replaces it.')}`);
  else ui.info(`Secret:     ${config.keyVault.name} / ${config.keyVault.secretName}${expires}${mode === 'keyvault-admin' ? c.dim('  Added by a vault admin.') : ''}`);
  if (config.keyVault.private) ui.info(`            ${c.dim('Private vault, reached through a managed private endpoint. Spark sessions take a few minutes longer to start.')}`);

  const sm = config.semanticModel;
  if (sm.enabled && sm.id) {
    ui.info(`Model:      ${sm.name}  ${c.dim(modelUrl(ws, sm.id))}`);
    if (sm.connectionName) ui.info(`            ${c.dim(`Reads the Lakehouse through "${sm.connectionName}"${sm.secretExpires ? `, whose secret expires ${sm.secretExpires.slice(0, 10)}` : ''}.`)}`);
    reportsSummary(ctx);

    const group = config.access?.groupId ? config.access : undefined;
    ui.heading('Next steps');
    if (group) {
      // Sharing the report with the group is asked before the first load, and is a card above until it's done.
      const built = !!group.grantedModels?.includes(sm.id);
      ui.info(`1. ${accessSummaryLines(config).join(' ')}`);
      ui.info(built
        ? `   The group has Build on ${sm.name}. Keep viewers off workspace roles.`
        : `   The group still needs Build on ${sm.name}: run "${commandLine('access')}" and choose "Give the group Build on the model again". Keep viewers off workspace roles.`);
    } else {
      ui.info(`1. Share the report: in the workspace, choose … (More options) next to ${sm.report?.name ?? 'it'}, then Manage permissions, and add people or a group.`);
      ui.info(`   They also need Build on ${sm.name}, from its Manage permissions page. Keep viewers off workspace roles.`);
    }
    if (mode === 'notebook') {
      ui.info('2. Scheduled runs refresh the model as you, the schedule\'s owner. Anyone with a role in the workspace can');
      ui.info(`   read the client secret in the notebooks. Repair or run "${commandLine('rotate-secret')}" before it expires${expiresOn}.`);
    } else {
      ui.info('2. Scheduled runs read the Key Vault secret as you, the schedule\'s owner, and refresh the model');
      ui.info('   as you. Anyone who takes over the pipeline needs "get" on the secret and Contributor on the workspace.');
    }
    ui.info(`3. Keep ${c.bold(DEFAULT_CONFIG_FILE)}. It holds no secrets; re-run the installer with it to change or repair the set-up.`);
    return;
  }

  const lakehouse = await api.fabric.getLakehouse(ws, /** @type {string} */ (f.lakehouseId)).catch(() => null);
  const sql = lakehouse?.properties?.sqlEndpointProperties;
  ui.heading('Connect Power BI');
  ui.info(c.bold(/** @type {string} */ (MODEL_TEMPLATE.split('/').pop())));
  ui.info(`  Fabric SQL Endpoint:  ${sql?.connectionString ?? c.dim('still provisioning; copy it from the Lakehouse\'s SQL analytics endpoint settings')}`);
  ui.info(`  Lakehouse Database:   ${f.lakehouseName}`);

  ui.heading('Next steps');
  ui.info('1. Open the template in Power BI Desktop with the values above, then publish it to this workspace.');
  ui.info('2. Set a scheduled refresh on the model in Power BI to run after the pipeline, or run the installer again from the full download: it deploys the model and refreshes it after each load.');
  ui.note('   See "5. Schedule + secure the Service refresh" in Classic Editions/3. Fabric/README.md.');
  if (mode === 'notebook') {
    ui.info('3. Anyone with a role in the workspace can read the client secret in the notebooks. Repair or run');
    ui.info(`   "${commandLine('rotate-secret')}" before it expires${expiresOn}.`);
  } else {
    ui.info('3. Scheduled runs read the Key Vault secret as you, the schedule\'s owner. Anyone who edits the');
    ui.info('   pipeline or takes over the schedule needs "get" on the secret first.');
  }
  ui.info(`4. Keep ${c.bold(DEFAULT_CONFIG_FILE)}. It holds no secrets; re-run the installer with it to change or repair the set-up.`);
}

/**
 * Writes what the installer would deploy, with placeholder IDs where none are known. No sign-in.
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, sources: import('./sources.js').Sources, outDir: string, now?: Date }} o
 */
export function preview(o) {
  if (targetOf(o.config) === 'pax') {
    paxPreview(o);
    return;
  }
  const { ui, config, sources } = o;
  const out = resolve(o.outDir);
  const fake = (/** @type {number} */ n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const f = config.fabric;
  const sm = config.semanticModel;
  const withModel = sm.enabled !== false && !!sources.modelFile;
  /** @type {Ctx} */
  const ctx = /** @type {any} */ ({
    config: {
      ...config,
      app: { ...config.app, appId: config.app.appId ?? fake(1) },
      keyVault: { ...config.keyVault, uri: config.keyVault.uri ?? `https://${config.keyVault.name ?? 'your-vault'}.vault.azure.net/` },
      fabric: {
        ...f,
        workspaceId: f.workspaceId ?? fake(2),
        lakehouseId: f.lakehouseId ?? fake(3),
        lakehouseName: f.lakehouseName ?? DEFAULT_LAKEHOUSE_NAME,
        notebooks: { ...f.notebooks },
      },
      semanticModel: withModel ? { ...sm, enabled: true, id: sm.id ?? fake(4), bound: true } : { ...sm, enabled: false },
    },
    user: { tenantId: config.tenantId ?? fake(0) },
  });

  mkdirSync(join(out, 'notebooks'), { recursive: true });
  let n = 10;
  for (const nb of notebooksFor(config.modules, { semanticModel: withModel })) {
    const prepared = prepareNotebook(sources.notebooks[nb.key], notebookSettings(ctx, nb));
    writeFileSync(join(out, 'notebooks', `${nb.displayName}.ipynb`), serialiseNotebook(prepared), 'utf8');
    ctx.config.fabric.notebooks[nb.key] = ctx.config.fabric.notebooks[nb.key] ?? fake(n++);
  }
  const pipeline = buildPipeline(sources.pipeline, pipelineSettings(ctx.config));
  writeFileSync(join(out, 'pipeline-content.json'), `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');
  writeFileSync(join(out, 'schedule.json'), `${JSON.stringify(scheduleBody(config.schedule, o.now), null, 2)}\n`, 'utf8');
  writeFileSync(
    join(out, 'graph-permissions.txt'),
    `Microsoft Graph application permissions for the app registration:\n${permissionsFor(config.modules).map((p) => `  ${p}\n`).join('')}`,
    'utf8',
  );
  if (withModel) {
    const file = /** @type {string} */ (sources.modelFile);
    const bim = buildModel(loadTemplateModel(file), {
      server: sm.server ?? 'your-endpoint.datawarehouse.fabric.microsoft.com',
      database: /** @type {string} */ (ctx.config.fabric.lakehouseName),
    });
    writeFileSync(join(out, 'model.bim'), `${JSON.stringify(bim, null, 2)}\n`, 'utf8');
    for (const p of reportDefinition(loadTemplateReport(file), /** @type {string} */ (ctx.config.semanticModel.id)).parts) {
      const path = join(out, 'report', ...p.path.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(p.payload, 'base64'));
    }
  }

  ui.heading('Preview written');
  ui.info(out);
  ui.note(`Notebooks, pipeline-content.json, schedule.json${withModel ? ', model.bim, the report (report folder)' : ''} and graph-permissions.txt, with placeholder IDs where none are known yet.`);
}
