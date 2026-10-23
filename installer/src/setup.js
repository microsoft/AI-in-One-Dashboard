// @ts-check
/** Category editing keeps unapproved choices separate from deployed IDs and checkpoints. */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { collectedLabels } from './catalog.js';
import { archiveConfig, loadConfig, removeFile, saveConfig } from './config.js';
import { armErrors } from './clients/azure.js';
import { plan, preflight, confirmPlan } from './steps/plan.js';
import { isResumeLater } from './steps/identity.js';

/** @typedef {import('./install.js').Ctx} Ctx */
/** @typedef {import('./config.js').InstallConfig} InstallConfig */

export const SETUP_SECTIONS = ['data', 'placement', 'access', 'identity', 'schedule'];
const draftFile = (/** @type {string} */ file) => `${file}.draft.json`;
const recordRevision = (/** @type {string} */ file) => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'new';

/**
 * The settings categories, in the order plan() asks them. Data collection is information only.
 * @param {InstallConfig} config
 */
export function setupCategories(config) {
  const done = new Set(config.setup?.completed ?? []);
  const entry = (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ summary) => ({ id, title, summary, complete: done.has(id) });
  return [
    entry('data', 'Data collection', collectedLabels(config.modules).join(', ')),
    entry('placement', 'Fabric placement', `${config.fabric.workspaceName ?? 'Choose workspace'}; capacity: ${config.fabric.capacityId ?? 'not set'}`),
    entry('access', 'Viewer access', config.access?.groupName ?? config.access?.groupId ?? 'Choose who can view'),
    entry('identity', 'Identity and secrets', `${config.app.displayName ?? config.app.appId ?? 'App registration'}; ${config.keyVault.mode === 'notebook' ? 'secret in notebooks' : config.keyVault.name ?? 'Key Vault'}`),
    entry('schedule', 'Schedule and loading', `${config.schedule.frequency}, ${config.schedule.time} ${config.schedule.timeZone}; ${config.history.days} days`),
  ];
}

/**
 * Retain error codes through explanatory wrappers; never require the browser to parse error prose.
 * @param {unknown} err
 * @param {InstallConfig} [_config]  Kept for the callers; every category is Fabric's now.
 */
export function setupRecovery(err, _config) {
  const e = /** @type {{ body?: unknown, cause?: unknown, message?: string, operations?: unknown }} */ (err ?? {});
  const source = e.cause ?? e;
  const cause = /** @type {{ body?: unknown, message?: string, operations?: unknown }} */ (source);
  const errors = armErrors(cause.body ?? source);
  const codes = errors.map((x) => x.code).filter(Boolean).join(', ');
  const text = `${codes} ${e.message ?? ''} ${cause.message ?? ''} ${JSON.stringify(cause.operations ?? [])}`;
  let section;
  let label;
  if (/region|location|capacity|quota|SkuNotAvailable|NotAvailableForSubscription|SubscriptionIsOverQuota/i.test(text)) {
    section = 'placement';
    label = 'Change region or capacity';
  }
  return { section, label, code: codes || undefined };
}

/** @param {Ctx} ctx */
export function restoreSetupDraft(ctx) {
  const file = draftFile(ctx.file);
  if (!existsSync(file)) return true;
  const { config } = loadConfig(file);
  // An approved draft that a synced folder kept locked last time: the record already has its choices.
  if (config.setup?.approved) {
    removeFile(file);
    return true;
  }
  if (config.tenantId && config.tenantId !== ctx.user.tenantId) throw new Error('The saved setup draft belongs to a different tenant. Sign in to that tenant to resume it.');
  if (config.setup?.baseRevision !== recordRevision(ctx.file)) return false;
  replaceConfig(ctx.config, config);
  ctx.runFirstLoad = config.setup?.runFirstLoad;
  ctx.reloadHistoryDays = config.setup?.reloadHistoryDays;
  return true;
}

/** @param {InstallConfig} target @param {InstallConfig} source */
function replaceConfig(target, source) {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
  Object.assign(target, structuredClone(source));
}

/**
 * First-load and history-reload choices apply to one deployment, so they stay out of the install record.
 * @param {NonNullable<InstallConfig['setup']>} setup
 */
function oneOff(setup) {
  delete setup.runFirstLoad;
  delete setup.reloadHistoryDays;
  return setup;
}

/** @param {InstallConfig} before @param {InstallConfig} after */
function changedCategories(before, after) {
  const old = setupCategories(before);
  const values = (/** @type {InstallConfig} */ config) => ({
    data: [config.modules],
    placement: [config.fabric.capacityId, config.fabric.workspaceName, config.fabric.lakehouseName, config.scale],
    access: config.access,
    identity: [config.app, config.keyVault],
    schedule: [config.schedule, config.history, config.setup?.runFirstLoad, config.setup?.reloadHistoryDays],
  });
  const previousValues = values(before);
  const nextValues = values(after);
  return setupCategories(after).flatMap((cat) => {
    const previous = old.find((x) => x.id === cat.id);
    if (JSON.stringify(Reflect.get(previousValues, cat.id)) === JSON.stringify(Reflect.get(nextValues, cat.id))) return [];
    return [previous?.summary !== cat.summary
      ? `${cat.title}: ${previous?.summary ?? 'not set'} -> ${cat.summary}`
      : `${cat.title}: settings updated; review the deployment plan before approving.`];
  });
}

/**
 * A persistent overview is the navigation root, including after planning/validation errors.
 * Each category uses the same planner as terminal setup, without replaying unrelated answers.
 * @param {Ctx} ctx
 */
export async function reviewSetup(ctx) {
  if (!restoreSetupDraft(ctx)) {
    ctx.ui.heading('Setup draft conflict');
    const choice = await ctx.ui.select('The install record changed after this draft was saved. Keep the newer deployed IDs and archive the older draft?', [
      { name: 'Use the latest install record and archive the older draft', value: 'record' },
      { name: 'Keep both files and stop', value: 'stop' },
    ], 'record');
    if (choice === 'stop') return false;
    try {
      archiveConfig(draftFile(ctx.file));
    } catch (err) {
      // The next checkpoint replaces it with the latest record, so a locked draft can't block setup.
      ctx.ui.warn(`Couldn't archive the older draft (${/** @type {Error} */ (err).message}). It will be replaced by a draft of the latest install record.`);
    }
  }
  const baseRevision = recordRevision(ctx.file);
  const baseline = structuredClone(ctx.config);
  const deployed = !!ctx.config.fabric.lakehouseId;
  ctx.config.setup ??= { completed: deployed ? setupCategories(ctx.config).map((cat) => cat.id) : [] };
  // One-off answers: a restored draft carries them for this session; the install record never does.
  oneOff(ctx.config.setup);
  ctx.runFirstLoad ??= ctx.config.firstRun?.status !== 'Completed';
  baseline.setup = { ...(baseline.setup ?? { completed: [] }), runFirstLoad: ctx.runFirstLoad, reloadHistoryDays: ctx.reloadHistoryDays };
  if (ctx.config.app.existing && !ctx.config.keyVault.secretSetAt && !ctx.pendingSecret) {
    ctx.config.setup.completed = ctx.config.setup.completed.filter((id) => id !== 'identity');
  }
  let notice = deployed ? 'Existing resources are reused where safe. Editing settings never deletes them.' : '';
  let selected = ctx.setupSection;
  let retry = ctx.setupRetry;
  const realSave = ctx.save;
  const realUi = ctx.ui;
  let approved = false;
  const checkpoint = () => {
    ctx.config.setup = {
      completed: ctx.config.setup?.completed ?? [], runFirstLoad: ctx.runFirstLoad, reloadHistoryDays: ctx.reloadHistoryDays, baseRevision,
    };
    saveConfig(draftFile(ctx.file), ctx.config);
  };
  ctx.save = checkpoint;
  ctx.ui = new Proxy(realUi, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== 'function' || !['input', 'select', 'confirm', 'checkbox', 'secret', 'form'].includes(String(name))) return value;
      return (...args) => { checkpoint(); return value.apply(target, args); };
    },
  });
  try {
    for (;;) {
      checkpoint();
      ctx.ui.heading('Setup settings');
      const categories = setupCategories(ctx.config);
      const choice = selected ?? (retry ? 'deploy' : await ctx.ui.settings(categories, { notice, changes: changedCategories(baseline, ctx.config) }));
      selected = undefined;
      retry = false;
      notice = '';
      if (choice === 'close') {
        ctx.ui.note('Setup choices are saved as a draft. Open setup again to continue; deployed resources have not been removed.');
        return false;
      }
      if (choice !== 'deploy' && !categories.some((cat) => cat.id === choice)) {
        notice = 'That category isn\'t one of the settings. Choose one from the list.';
        continue;
      }
      const before = structuredClone(ctx.config);
      const answers = { pendingSecret: ctx.pendingSecret, runFirstLoad: ctx.runFirstLoad, reloadHistoryDays: ctx.reloadHistoryDays };
      let planned = false;
      try {
        // Refresh before every edit and retry, never use the rewind API cache for live availability.
        const pre = await preflight(ctx);
        if (choice !== 'deploy') {
          ctx.advanced = true;
          ctx.ui.beginSection();
          await plan(ctx, pre, choice);
          planned = true;
          const completed = new Set(ctx.config.setup?.completed);
          completed.add(choice);
          ctx.config.setup = { completed: [...completed] };
          checkpoint();
          continue;
        }
        const missing = categories.filter((cat) => !cat.complete);
        if (missing.length) throw new Error(`Review these categories first: ${missing.map((cat) => cat.title).join(', ')}.`);
        if (!pre.capacities.some((cap) => cap.id === ctx.config.fabric.capacityId)) {
          throw new Error('Review Fabric placement: the selected capacity is no longer active or accessible.');
        }
        checkpoint();
        const go = await confirmPlan(ctx, pre);
        if (!go) continue;
        if (recordRevision(ctx.file) !== baseRevision) throw new Error('The install record changed while you edited this draft. Save and close, then reopen setup to keep the latest deployed IDs and resolve the draft conflict.');
        // Marked first so a draft a synced folder keeps locked is cleaned up next run, not treated as a conflict.
        saveConfig(draftFile(ctx.file), { ...ctx.config, setup: { ...ctx.config.setup, completed: ctx.config.setup?.completed ?? [], approved: true } });
        ctx.config.setup = oneOff({ ...ctx.config.setup, completed: ctx.config.setup?.completed ?? [] });
        realSave();
        approved = true;
        if (!removeFile(draftFile(ctx.file))) ctx.ui.note('The approved setup draft is locked by another program; it will be cleaned up next time.');
        return true;
      } catch (err) {
        if (/** @type {Error} */ (err)?.name === 'ExitPromptError' || isResumeLater(err)) throw err;
        const cancelled = /** @type {Error} */ (err)?.name === 'SettingsCancelled';
        if (cancelled || planned) {
          replaceConfig(ctx.config, before);
          Object.assign(ctx, answers);
        }
        notice = cancelled ? 'Changes cancelled. Your previous choices are unchanged.' : String(/** @type {Error} */ (err)?.message ?? err);
        ctx.ui.warn(notice);
        checkpoint();
      } finally {
        ctx.ui.endSection();
      }
    }
  } finally {
    if (!approved) checkpoint();
    ctx.save = realSave;
    ctx.ui = realUi;
  }
}
