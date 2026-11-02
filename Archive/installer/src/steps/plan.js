// @ts-check
/**
 * Checks the tenant, then asks every question up front so the rest of the
 * install can run unattended.
 */
import { randomBytes } from 'node:crypto';
import { collectedLabels, notebooksFor, permissionsFor } from '../catalog.js';
import { allowsAction, armLocation, validateVaultName } from '../clients/azure.js';
import { APP_ROLES, CONSENT_ROLES } from '../clients/graph.js';
import { HttpError } from '../http.js';
import { inCloudShell } from '../launch.js';
import { c } from '../ui.js';
import { MODEL_NAME, secretMode } from '../config.js';
import { MODEL_TEMPLATE } from '../transform/model.js';
import { adminPack, canWriteSecrets, checkExistingApp, MAX_SECRET_DAYS, NOTEBOOK_SECRET_DAYS, notebookSecretDays, reportAppCheck, ResumeLater, writeAdminPack } from './identity.js';
import { askAdvanced, asksAdvanced } from './advanced.js';
import { DEFAULT_LAKEHOUSE_NAME, describeSchedule, displayNames, freeName, hasSchemas, modelKey, noSchemasMessage, PIPELINE_NAME, stoppedRunItem } from './fabric.js';
import { connectionName, MODEL_UPDATE_NOTE } from './model.js';
import { reportsWanted } from './report.js';
import { accessReview, planAccess } from './access.js';
import { BIG_CAPACITY_SEATS, copilotSeats, LARGE_TENANT_SEATS, seatCount } from '../seats.js';

/** @typedef {import('../install.js').Ctx} Ctx */

export const APP_NAME = 'AI in One (Fabric)';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string} v */
export const isGuid = (v) => GUID.test(v.trim());

/** Fabric item names for a Lakehouse: letter first, then letters, digits, underscores. @param {string} v */
export function validateLakehouseName(v) {
  if (v.length > 123) return 'Use 123 characters or fewer.';
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? true : 'Start with a letter, then use only letters, numbers and underscores. That\'s a Fabric rule for Lakehouse names.';
}

/**
 * The name to give the Lakehouse. Fabric won't take spaces or hyphens, so they become underscores.
 * @param {string} v
 */
export const lakehouseNameFrom = (v) => v.trim().replace(/[\s-]+/g, '_');

/**
 * A valid name for a new Lakehouse that no Lakehouse in the workspace has.
 * @param {string[]} taken  Lakehouse names already in the workspace.
 */
export const validateNewLakehouseName = (taken) => (/** @type {string} */ v) => {
  const name = lakehouseNameFrom(v);
  const ok = validateLakehouseName(name);
  if (ok !== true) return ok;
  return taken.some((t) => t.toLowerCase() === name.toLowerCase())
    ? `There's already a Lakehouse called ${name} here, so choose another name for the new one.`
    : true;
};

/** @param {string} v */
export function validateTime(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? true : 'Use 24-hour HH:MM, e.g. 02:00.';
}

/** @param {Ctx} ctx */
export async function editSchedule(ctx) {
  const schedule = ctx.config.schedule;
  const values = await ctx.ui.form('Schedule', [
    { id: 'frequency', label: 'Frequency', default: schedule.frequency, choices: [{ name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }] },
    { id: 'weekday', label: 'Day (weekly schedules only)', default: schedule.weekday, choices: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ name: d, value: d })) },
    { id: 'time', label: `Time (${schedule.timeZone}, 24-hour)`, default: schedule.time, validate: validateTime },
  ]);
  if (!values) throw Object.assign(new Error('Changes cancelled'), { name: 'SettingsCancelled' });
  schedule.frequency = /** @type {'daily' | 'weekly'} */ (values.frequency);
  schedule.weekday = values.weekday;
  schedule.time = values.time;
}

/**
 * Premium Per User (PP), Embedded (A) and EM capacities can't host Fabric items.
 * @param {{ sku?: string }} capacity
 */
export const runsFabric = (capacity) => !/^(PP|A|EM)\d/i.test(String(capacity.sku ?? ''));

/**
 * F64 and up, or a Premium P capacity: what a large tenant usually runs on, so the tenant size starts at large.
 * A trial capacity (FTL<n>) counts as the F<n> it matches; a trial SKU without a size, such as FT1, doesn't.
 * @param {{ sku?: string }} capacity
 */
export function largeCapacity(capacity) {
  const m = /^(P|F|FTL)(\d+)$/i.exec(String(capacity.sku ?? ''));
  return !!m && (m[1].toUpperCase() === 'P' || Number(m[2]) >= 64);
}

/**
 * @typedef {object} Preflight
 * @property {any[]} capacities  Active capacities the user can use.
 * @property {any[]} subscriptions  Enabled Azure subscriptions.
 * @property {string[]} roles  Directory role names.
 * @property {boolean} canConsent
 * @property {boolean | undefined} canCreateApps  undefined when the policy can't be read.
 * @property {Record<string, { enabled?: boolean, delegateToCapacity?: boolean }>} [tenantSettings]  Only for Fabric administrators.
 * @property {number} [seats]  Assigned Microsoft 365 Copilot seats; undefined when they can't be read.
 * @property {boolean} [concealedNames]  Microsoft 365 reports conceal user names; undefined when it can't be read.
 */

/**
 * The tenant size a new install, or one with no size saved, starts at: large on F64 or larger, or
 * with more than 10,000 Copilot seats assigned.
 * @param {{ sku?: string } | undefined} capacity
 * @param {number} [seats]
 * @returns {'standard' | 'large'}
 */
export const defaultScale = (capacity, seats) => ((capacity && largeCapacity(capacity)) || (seats ?? 0) > LARGE_TENANT_SEATS ? 'large' : 'standard');

/**
 * What to tell someone whose tenant size or capacity looks too small for the seats assigned. Says
 * which step changes it, and how to carry on when policy rules the change out.
 * @param {{ seats?: number, capacity?: { sku?: string, displayName?: string }, scale?: 'standard' | 'large' }} opts
 * @returns {string[]}
 */
export function sizingWarnings({ seats, capacity, scale }) {
  if (!seats) return [];
  /** @type {string[]} */
  const out = [];
  const n = seatCount(seats);
  if (seats >= BIG_CAPACITY_SEATS && capacity && !largeCapacity(capacity)) {
    out.push(
      `${n} Copilot seats are assigned and the capacity ${capacity.displayName ?? ''} is ${capacity.sku ?? 'an unknown size'}, below F64. ` +
        'In Fabric placement, choose an F64 or larger capacity, or ask your capacity admin for one. If your organisation\'s policy keeps you on this capacity, setup still works, but loads take longer and may hit their time limits.',
    );
  }
  if (seats > LARGE_TENANT_SEATS && scale === 'standard') {
    out.push(
      `${n} Copilot seats are assigned, but the tenant size is "Up to 10,000". In Fabric placement, under the advanced settings, choose "More than 10,000" so the pipeline gives its slow steps longer time limits.`,
    );
  }
  return out.map((s) => s.replace(/ {2,}/g, ' '));
}

/**
 * Tenant settings the semantic model and the report rely on, and what breaks without them.
 * @type {{ name: string, title: string, effect: string, reports?: boolean }[]}
 */
export const POWER_BI_SETTINGS = [
  {
    name: 'ServicePrincipalAccessPermissionAPIs',
    title: 'Service principals can call Fabric public APIs',
    effect: 'The model\'s connection signs in as the app registration, so the model can\'t refresh without it.',
  },
  {
    name: 'CustomVisualsTenant',
    title: 'Allow visuals created using the Power BI SDK',
    effect: 'The report\'s histogram, box and whisker, funnel, network graph and Power Slicer visuals stay blank without it.',
    reports: true,
  },
];

/**
 * Settings that look switched off. A setting delegated to capacity admins may still be on there.
 * @param {Preflight['tenantSettings']} settings
 * @param {{ reports?: boolean }} [opts]  reports: include the settings only the report needs.
 */
export function blockedSettings(settings, opts = {}) {
  if (!settings) return [];
  return POWER_BI_SETTINGS.filter((s) => (opts.reports || !s.reports) && settings[s.name]?.enabled === false && !settings[s.name]?.delegateToCapacity);
}

/**
 * Where concealed names are turned off, or checked by hand. Only a Global Administrator can change it:
 * https://learn.microsoft.com/microsoft-365/admin/activity-reports/activity-reports
 */
export const CONCEALED_NAMES_SETTING =
  'Microsoft 365 admin center > Settings > Org settings > Services > Reports, "Conceal user, group, and site names in all reports"';

/**
 * Whether Microsoft 365 reports conceal user names; undefined when it can't be read, as without a
 * reports reader or admin role. GET /admin/reportSettings, displayConcealedNames:
 * https://learn.microsoft.com/graph/api/adminreportsettings-get
 * @param {{ graph: Pick<import('../clients/graph.js').GraphApi, 'reportSettings'> }} api
 * @returns {Promise<boolean | undefined>}
 */
export async function concealedNames(api) {
  try {
    const value = (await api.graph.reportSettings())?.displayConcealedNames;
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to say about concealed names: nothing when they're off.
 * @param {boolean | undefined} concealed
 * @returns {string | undefined}
 */
export function concealedNamesNote(concealed) {
  if (concealed === false) return undefined;
  return concealed
    ? `Microsoft 365 reports conceal user names, so the dashboard gets hashed user names until it's turned off. A Global Administrator can turn it off: ${CONCEALED_NAMES_SETTING}.`
    : `Couldn't check whether Microsoft 365 reports conceal user names. If they do, the dashboard gets hashed user names. To check by hand, open ${CONCEALED_NAMES_SETTING}.`;
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<Preflight>}
 */
export async function preflight(ctx) {
  const { ui, api, user } = ctx;
  ui.heading('Checking your tenant');
  ui.ok(`Signed in as ${user.upn} (tenant ${user.tenantId})`);

  const roles = await api.graph.myDirectoryRoles().catch(() => []);
  const roleIds = new Set(roles.map((r) => r.roleTemplateId));
  const canConsent = Object.keys(CONSENT_ROLES).some((id) => roleIds.has(id));
  const appAdmin = Object.keys(APP_ROLES).some((id) => roleIds.has(id));
  /** @type {boolean | undefined} */
  let canCreateApps = canConsent || appAdmin ? true : undefined;
  if (canCreateApps === undefined) canCreateApps = await api.graph.usersCanRegisterApps().catch(() => undefined);

  if (canConsent) ui.ok(`You can grant admin consent (${roles.filter((r) => CONSENT_ROLES[/** @type {keyof typeof CONSENT_ROLES} */ (r.roleTemplateId)]).map((r) => r.displayName).join(', ')})`);
  else ui.warn('You can\'t grant admin consent for Microsoft Graph. The installer will give you a link for a Global Administrator or Privileged Role Administrator to approve.');
  if (!ctx.config.app.appId && canCreateApps === false) {
    ui.warn('Users in this tenant can\'t register apps and you have no app admin role. Choose "Use an app registration I already have", or get an admin pack for an admin to register it.');
  }

  const capacities = (await api.fabric.listCapacities()).filter((cap) => cap.state === 'Active' && runsFabric(cap));
  if (!capacities.length) {
    ui.fail('No active Fabric capacity you can use.');
    throw new Error('Start a Fabric trial, or ask a capacity admin to make you a contributor on an F2 or larger capacity, then run the installer again.');
  }
  ui.ok(`${capacities.length} active Fabric ${capacities.length === 1 ? 'capacity' : 'capacities'}`);

  /** @type {any[]} */
  let subscriptions = [];
  try {
    subscriptions = (await api.arm.listSubscriptions()).filter((s) => s.state === 'Enabled');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
  }
  if (!subscriptions.length && !ctx.config.keyVault.uri && secretMode(ctx.config) !== 'notebook') {
    if (ctx.useKeyVault) {
      ui.fail('No Azure subscription you can use, so no Key Vault.');
      throw new Error('--key-vault needs an Azure subscription in this tenant. Ask for Contributor on one, or leave out --key-vault to keep the client secret in the notebooks.');
    }
    // The client secret can go in the notebooks instead of Key Vault.
    ui.info('No Azure subscription you can use, so no Key Vault: the client secret goes in the notebooks.');
    if (ui.yes && !ctx.secretInNotebook && !defaultsToNoVault(ctx)) {
      throw new Error(
        'With no Azure subscription there\'s no Key Vault for the app secret. Add --no-key-vault to keep it in the notebooks, where anyone with a role in the workspace can read it, or ask for Contributor on a subscription.',
      );
    }
  }
  if (subscriptions.length) ui.ok(`${subscriptions.length} Azure ${subscriptions.length === 1 ? 'subscription' : 'subscriptions'} for Key Vault`);

  const seats = await copilotSeats(api);
  if (seats) ui.ok(`${seatCount(seats)} Microsoft 365 Copilot ${seats === 1 ? 'seat' : 'seats'} assigned`);

  /** @type {Preflight['tenantSettings']} */
  let tenantSettings;
  try {
    tenantSettings = Object.fromEntries((await api.fabric.tenantSettings()).map((s) => [s.settingName, s]));
  } catch {
    // Only Fabric administrators can read them.
  }
  if (ctx.sources.modelFile) {
    for (const s of blockedSettings(tenantSettings, { reports: true })) {
      ui.warn(`The tenant setting "${s.title}" is off. ${s.effect}`);
      ui.note('A Fabric administrator can switch it on in the admin portal, under Tenant settings.');
    }
  }

  const concealed = await concealedNames(api);
  const note = concealedNamesNote(concealed);
  if (concealed === false) ui.ok('Microsoft 365 reports show user names');
  else if (concealed) ui.warn(/** @type {string} */ (note));
  else ui.note(/** @type {string} */ (note));

  return { capacities, subscriptions, roles: roles.map((r) => r.displayName), canConsent, canCreateApps, tenantSettings, seats, concealedNames: concealed };
}

/** The audit history the first load can pull. */
export const HISTORY_CHOICES = [
  { name: '30 days (quickest; you can load more later)', value: 30 },
  { name: '90 days', value: 90 },
  { name: '180 days (the default; the most the audit log keeps by default)', value: 180 },
];

/** How long a load of history takes: no more precise than this, as it depends on the tenant. */
const LOAD_TIME = 'It can take from under an hour to several hours in a large tenant';

/**
 * What reloading `days` days of history runs: the pipeline, once.
 * @param {number} days
 */
const pipelineReloadChoice = (days) => `Runs the pipeline once with ${days} days of history. ${LOAD_TIME}; the scheduled runs carry on after it.`;

/**
 * Repair or change, once the history has loaded: offers to reload more of it after setup. Only
 * more than is loaded is offered. The answer goes on `ctx.reloadHistoryDays`; the install record
 * keeps the old number until the reload has started.
 * @param {Ctx} ctx
 * @param {(days: number) => string} [describe]  Each reload choice's description.
 */
export async function askMoreHistory(ctx, describe = pipelineReloadChoice) {
  const { ui, config } = ctx;
  delete ctx.reloadHistoryDays;
  const current = config.history.days;
  const more = HISTORY_CHOICES.filter((ch) => ch.value > current);
  if (!more.length) {
    ui.ok(`Audit history: ${current} days loaded, the most the installer loads`);
    return;
  }
  const days = await ui.select(
    `Load more audit history? ${current} days are loaded now.`,
    [
      { name: `Keep ${current} days (the usual runs carry on from here)`, value: 0 },
      ...more.map((ch) => ({
        name: `Reload ${ch.value} days after setup`,
        value: ch.value,
        description: describe(ch.value),
      })),
    ],
    0,
  );
  if (days) ctx.reloadHistoryDays = days;
}

/**
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} [section]
 */
export async function plan(ctx, pre, section) {
  const { ui, config, api, sources } = ctx;
  const advanced = () => !!section || asksAdvanced(ctx);
  const editing = (/** @type {string} */ id) => !section || section === id;
  // The model and the report are always deployed, from the checkout's Power BI template.
  config.semanticModel.enabled = !!sources.modelFile;

  if (editing('data')) {
    ui.heading('What it collects');
    for (const label of collectedLabels(config.modules)) ui.info(`  - ${label}`);
    if (!config.semanticModel.enabled) {
      ui.note(`This checkout has no "${MODEL_TEMPLATE.split('/').pop()}", so the installer won't deploy the semantic model or the report.`);
    }
    if (!section) {
      await askAdvanced(ctx, 'who can view, audit history, tenant size, the Lakehouse name, the new Key Vault\'s details, the schedule and the first load');
    }
  }

  if (editing('access')) {
    if (config.semanticModel.enabled) await planAccess(ctx);
  }

  if (editing('schedule')) {
    if (config.firstRun?.status !== 'Completed') {
      delete ctx.reloadHistoryDays;
      if (advanced()) config.history.days = await ui.select('How much audit history should the first load pull?', HISTORY_CHOICES, config.history.days);
    } else {
      await askMoreHistory(ctx);
    }
  }

  const currentCapacity = () => pre.capacities.find((cap) => cap.id === config.fabric.capacityId);
  if (editing('placement')) {
    ui.heading('Fabric');
    ui.note(CAPACITY_HINT);
    const capacityChoices = pre.capacities.map((cap) => ({ name: capacityLabel(cap), value: cap.id }));
    config.fabric.capacityId = await ui.select(
      'Which capacity should run it?',
      capacityChoices,
      pre.capacities.some((cap) => cap.id === config.fabric.capacityId) ? config.fabric.capacityId : pre.capacities[0].id,
    );
    const capacity = currentCapacity();
    const scale = config.scale ?? defaultScale(capacity, pre.seats);
    config.scale = !advanced()
      ? scale
      : await ui.select(
        'How many people are in the tenant?',
        [
          { name: 'Up to 10,000', value: 'standard' },
          { name: 'More than 10,000 (longer time limits; best on F64 or larger)', value: 'large' },
        ],
        scale,
      );
    for (const w of sizingWarnings({ seats: pre.seats, capacity, scale: config.scale })) ui.warn(w);
    if (config.fabric.workspaceId) {
      ui.ok(`Workspace: ${config.fabric.workspaceName ?? config.fabric.workspaceId}`);
    } else {
      const workspaces = (await api.fabric.listWorkspaces()).filter((w) => w.type === 'Workspace');
      const choice = await ui.select(
        'Workspace',
        [{ name: 'Create a new workspace', value: '' }, ...workspaces.map((w) => ({ name: `Use "${w.displayName}"`, value: w.id }))],
        '',
      );
      if (choice) {
        config.fabric.workspaceId = choice;
        config.fabric.workspaceName = workspaces.find((w) => w.id === choice)?.displayName;
      } else {
        const taken = new Set(workspaces.map((w) => w.displayName.toLowerCase()));
        config.fabric.workspaceName = await ui.input('New workspace name', {
          default: config.fabric.workspaceName ?? uniqueName(DEFAULT_WORKSPACE_NAME, taken),
          validate: (v) => (!v.trim() ? 'Required' : taken.has(v.trim().toLowerCase()) ? 'A workspace with that name exists.' : true),
        });
      }
    }
    if (!config.fabric.lakehouseId) await planLakehouse(ctx, advanced());
    await reserveNames(ctx);
  }

  if (editing('identity')) {
    const capacity = currentCapacity();
    ui.heading('App registration');
    /** Ask for the secret of an app the user brought, once the Key Vault section says where it goes. */
    let askSecret = false;
    let packWanted = false;
    if (config.app.appId) {
      ui.ok(`Using ${config.app.displayName ?? 'app'} (${config.app.appId})`);
      askSecret = !!section && !!config.app.existing && !config.keyVault.secretSetAt && !ctx.pendingSecret;
    } else {
      const blocked = pre.canCreateApps === false || !pre.canConsent || !!config.app.adminPack;
      const mode = await ui.select(
        'The notebooks sign in to Microsoft Graph as an app.',
        [
          { name: `Create "${APP_NAME}" (recommended)`, value: 'new' },
          { name: 'Use an app registration I already have', value: 'existing' },
          ...(blocked
            ? [{ name: 'An admin will register the app for me', value: 'admin', description: 'You get an admin pack: a Cloud Shell script and portal steps for an admin, who sends you back the client ID.' }]
            : []),
        ],
        config.app.adminPack || (pre.canCreateApps === false && !ui.yes) ? 'admin' : 'new',
      );
      if (mode === 'existing') {
        config.app.existing = true;
        await askAppId(ctx, pre);
        askSecret = true;
      } else if (mode === 'admin') {
        config.app.existing = true;
        packWanted = true;
      } else {
        config.app.existing = false;
      }
    }

    ui.heading('Key Vault for the app secret');
    const location = capacity ? armLocation(capacity.region) : 'westeurope';
    if (config.keyVault.uri) {
      ui.ok(`Using ${config.keyVault.name} (${config.keyVault.uri})`);
    } else if (secretMode(config) === 'notebook' && !ctx.secretInNotebook && !ui.yes) {
      const keep = await ui.select(
        'Last time you chose no Key Vault: the client secret is in the notebooks.',
        [
          { name: 'Keep it in the notebooks', value: 'keep', description: 'No Key Vault. Anyone with a role in the workspace can read it.' },
          { name: 'Use Key Vault instead', value: 'vault', description: 'The notebooks read it from the vault at run time, so workspace roles don\'t expose it.' },
        ],
        'keep',
      );
      if (keep === 'vault') {
        delete config.keyVault.mode;
        // The secret was in the notebooks, not a vault: the new vault needs one written.
        delete config.keyVault.secretSetAt;
        delete config.keyVault.handoff;
        await planKeyVault(ctx, pre, location);
      }
    } else if (secretMode(config) === 'notebook') {
      ui.info('No Key Vault: the client secret is in the notebooks, where anyone with a role in the workspace can read it.');
    } else if (defaultsToNoVault(ctx)) {
      await chooseSecretHome(ctx, pre, location);
    } else {
      await planKeyVault(ctx, pre, location);
    }
    if (secretMode(config) === 'notebook' && !config.app.existing && advanced()) {
      const days = await ui.input(`Days before the client secret expires (1 to ${MAX_SECRET_DAYS}). Each install, repair or update replaces it.`, {
        default: String(notebookSecretDays(config)),
        validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= MAX_SECRET_DAYS ? true : `A whole number from 1 to ${MAX_SECRET_DAYS}.`),
      });
      if (Number(days) === NOTEBOOK_SECRET_DAYS) delete config.app.secretDays;
      else config.app.secretDays = Number(days);
    }

    if (packWanted) askSecret = await planAdminPack(ctx, pre);
    if (askSecret && secretMode(config) !== 'keyvault-admin') {
      ctx.pendingSecret = await ui.secret(
        secretMode(config) === 'notebook'
          ? 'Client secret value (not the secret ID). It is written into the notebooks.'
          : 'Client secret value (not the secret ID). It goes straight to Key Vault.',
      );
    }
  }

  if (editing('schedule')) {
    if (section && ui.web) await editSchedule(ctx);
    else if (advanced()) {
      ui.heading('Schedule');
      const freq = await ui.select(
        'How often should the pipeline run?',
        [
          { name: 'Daily (recommended)', value: 'daily' },
          { name: 'Weekly', value: 'weekly' },
        ],
        config.schedule.frequency,
      );
      config.schedule.frequency = /** @type {'daily' | 'weekly'} */ (freq);
      if (freq === 'weekly') {
        config.schedule.weekday = await ui.select(
          'Which day?',
          ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ name: d, value: d })),
          config.schedule.weekday,
        );
      }
      config.schedule.time = await ui.input(`Time (${config.schedule.timeZone}, 24-hour)`, { default: config.schedule.time, validate: validateTime });
    }

    ctx.runFirstLoad = config.firstRun?.status === 'Completed' ? false : !advanced() || (await ui.confirm('Run the first load as soon as setup finishes?', true));
  }
}

/**
 * The Lakehouse: a new one, or one the workspace already has with schemas turned on. AI in One's
 * notebooks write their tables to the dbo schema, so a Lakehouse without schemas can't be used.
 * @param {Ctx} ctx
 * @param {boolean} askName  Ask for the new Lakehouse's name.
 */
async function planLakehouse(ctx, askName) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const ws = f.workspaceId;
  const lakehouses = ws ? await api.fabric.listItems(ws, 'Lakehouse') : [];
  const resumed = stoppedRunItem(f, 'Lakehouse', lakehouses);
  const wasExisting = !!f.existingLakehouse;
  delete f.existingLakehouse;
  if (resumed) {
    f.lakehouseName = String(resumed.displayName);
    return;
  }
  for (;;) {
    const choice = ws && lakehouses.length
      ? await ui.select(
        'Lakehouse',
        [
          { name: 'Create a new Lakehouse (recommended)', value: '', description: 'With schemas turned on, which AI in One\'s notebooks need.' },
          ...lakehouses.map((lh) => ({ name: `Use "${lh.displayName}"`, value: String(lh.id), description: 'Only one with schemas turned on. Uninstall leaves it.' })),
        ],
        '',
      )
      : '';
    if (!choice) break;
    const lh = await api.fabric.getLakehouse(/** @type {string} */ (ws), choice);
    const name = String(lh?.displayName ?? lakehouses.find((x) => x.id === choice)?.displayName ?? choice);
    if (hasSchemas(lh)) {
      f.lakehouseId = choice;
      f.lakehouseName = name;
      f.existingLakehouse = true;
      ui.ok(`Lakehouse: ${name}, which has schemas turned on`);
      return;
    }
    ui.warn(noSchemasMessage(name));
    if (ui.yes) throw new Error(noSchemasMessage(name));
  }
  const taken = displayNames(lakehouses);
  const suggested = freeName(wasExisting ? DEFAULT_LAKEHOUSE_NAME : f.lakehouseName ?? DEFAULT_LAKEHOUSE_NAME, taken);
  const typed = askName ? await ui.input('Lakehouse name', { default: suggested, validate: validateNewLakehouseName(taken) }) : suggested;
  f.lakehouseName = lakehouseNameFrom(typed);
  if (f.lakehouseName !== typed.trim()) ui.note(`Fabric doesn't allow spaces or hyphens in Lakehouse names, so it'll be called ${f.lakehouseName}.`);
}

/**
 * Where the client secret goes: a new vault, one the user has, or no vault (the notebooks).
 * A vault the user can't write secrets to can still be used: a vault admin adds the secret.
 * No vault is recommended when the user can't create a vault or write to the one they chose.
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} location
 */
export async function planKeyVault(ctx, pre, location) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  if (ctx.secretInNotebook && (await confirmNotebookMode(ctx))) return;
  if (!pre.subscriptions.length) {
    ui.info('With no Azure subscription, there\'s nowhere to create a Key Vault for the client secret.');
    if (await confirmNotebookMode(ctx)) return;
    throw new Error('Key Vault needs an Azure subscription in this tenant. Ask for Contributor on one, or run the installer again and choose no Key Vault.');
  }
  kv.subscriptionId = await ui.select(
    'Azure subscription',
    pre.subscriptions.map((s) => ({ name: `${s.displayName} (${s.subscriptionId})`, value: s.subscriptionId })),
    pre.subscriptions.some((s) => s.subscriptionId === kv.subscriptionId) ? kv.subscriptionId : pre.subscriptions[0].subscriptionId,
  );
  const subscriptionId = /** @type {string} */ (kv.subscriptionId);

  const vaults = await api.arm.listVaults(subscriptionId).catch(() => []);
  let askGroup = asksAdvanced(ctx);
  for (;;) {
    const choice = await ui.select(
      'Vault',
      [
        { name: 'Create a new Key Vault', value: '' },
        ...vaults.map((v) => ({ name: `Use "${v.name}" (${v.location})`, value: v.id })),
        { name: NO_VAULT_NAME, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
      ],
      kv.existing && vaults.some((v) => v.id === kv.id) ? /** @type {string} */ (kv.id) : '',
    );
    if (choice === NOTEBOOK) {
      if (await confirmNotebookMode(ctx)) return;
      continue;
    }
    delete kv.mode;
    if (choice) {
      const v = vaults.find((x) => x.id === choice);
      kv.existing = true;
      kv.id = v.id;
      kv.name = v.name;
      kv.resourceGroup = v.id.split('/')[4];
      kv.location = v.location;
      if (!(await canWriteSecrets(ctx, v))) {
        ui.warn(
          `You can't write secrets to ${v.name}: that needs Key Vault Secrets Officer${v.properties?.enableRbacAuthorization ? '' : ' or an access policy with secret set'}, and you can't give it to yourself.`,
        );
        const how = await ui.select(
          'How should the client secret get there?',
          [
            { name: `${NO_VAULT_NAME} (recommended)`, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
            { name: 'A vault admin will add the secret for me', value: 'keyvault-admin', description: 'You get the exact steps to send them. You only need to read the secret.' },
            { name: 'Pick another vault', value: 'other' },
          ],
          // With --yes, no vault takes --no-key-vault, so the vault admin is the answer that needs no flag.
          ui.yes ? 'keyvault-admin' : NOTEBOOK,
        );
        if (how === 'other') continue;
        if (how === NOTEBOOK) {
          if (await confirmNotebookMode(ctx)) return;
          continue;
        }
        kv.mode = 'keyvault-admin';
        ui.note('Once the app registration exists, the installer shows the steps to send the vault admin, then carries on when you say the secret is there.');
      }
    } else {
      kv.existing = false;
      await askResourceGroup(ctx, subscriptionId, askGroup);
      // Contributor on just the resource group is enough for the vault, so roles are checked where it goes.
      const group = await api.arm.getResourceGroup(subscriptionId, /** @type {string} */ (kv.resourceGroup)).catch(() => null);
      const scope = group ? `/subscriptions/${subscriptionId}/resourceGroups/${kv.resourceGroup}` : `/subscriptions/${subscriptionId}`;
      const perms = await api.arm.permissions(scope).catch(() => null);
      // Unknown permissions aren't a no: the vault step reports a real failure.
      if (perms && !allowsAction(perms, 'Microsoft.KeyVault/vaults/write')) {
        ui.warn(`You can't create a Key Vault in ${group ? kv.resourceGroup : 'this subscription'}: that needs Contributor there.`);
        const how = await ui.select(
          'Where should the client secret go?',
          [
            { name: `${NO_VAULT_NAME} (recommended)`, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
            { name: 'Pick a vault or resource group', value: 'other' },
          ],
          NOTEBOOK,
        );
        if (how === NOTEBOOK && (await confirmNotebookMode(ctx))) return;
        if (ui.yes) throw new Error(`You can't create a Key Vault in ${group ? kv.resourceGroup : 'this subscription'}. Add --no-key-vault to keep the client secret in the notebooks, or ask for Contributor there.`);
        askGroup = true;
        continue;
      }
      kv.location = asksAdvanced(ctx) ? await ui.input('Azure region', { default: kv.location ?? location }) : kv.location ?? location;
      const suggested = kv.name ?? `ai-in-one-${randomBytes(3).toString('hex')}`;
      kv.name = asksAdvanced(ctx) ? await ui.input('Vault name (globally unique)', { default: suggested, validate: validateVaultName }) : suggested;
      const available = await api.arm.checkVaultName(subscriptionId, kv.name);
      if (!available.nameAvailable) throw new Error(`Key Vault name "${kv.name}" is taken: ${available.message ?? 'choose another'}.`);
      kv.rbac = !!perms && allowsAction(perms, 'Microsoft.Authorization/roleAssignments/write');
      if (!kv.rbac) ui.note('You can\'t assign Azure roles here, so the vault will use access policies instead of Azure RBAC.');
    }
    if (kv.mode !== 'keyvault-admin') delete kv.handoff;
    break;
  }
  if (asksAdvanced(ctx)) kv.secretName = await ui.input('Secret name', { default: kv.secretName, validate: (v) => (/^[0-9a-zA-Z-]{1,127}$/.test(v) ? true : 'Letters, digits and hyphens only.') });
}

const NOTEBOOK = 'notebook';
const NO_VAULT_NAME = 'No Key Vault: keep the secret in the notebooks';
const NO_VAULT_DESCRIPTION = 'Nothing in Azure. Anyone with a role in the workspace can read the secret; Key Vault avoids that.';

/**
 * Whether the secret's home is still open and no Key Vault is the default: a new install that
 * hasn't picked a vault, without --key-vault.
 * @param {Ctx} ctx
 */
export function defaultsToNoVault(ctx) {
  const kv = ctx.config.keyVault;
  if (ctx.useKeyVault) return false;
  return !kv.uri && !kv.mode && !kv.name && !kv.id && !kv.subscriptionId;
}

/**
 * A new install: no Key Vault by default, or Key Vault.
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} location
 */
async function chooseSecretHome(ctx, pre, location) {
  const { ui } = ctx;
  const where = ctx.secretInNotebook
    ? NOTEBOOK
    : await ui.select(
        'Where should the app\'s client secret go?',
        [
          { name: `${NO_VAULT_NAME} (default)`, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
          { name: 'Azure Key Vault', value: 'keyvault', description: 'Needs an Azure subscription where you can create or use a vault. The notebooks read the secret at run time, so workspace roles don\'t expose it.' },
        ],
        NOTEBOOK,
      );
  if (where === NOTEBOOK && (await confirmNotebookMode(ctx, true))) return;
  await planKeyVault(ctx, pre, location);
}

/** The resource group a new vault goes in, unless the user names another. */
export const DEFAULT_RESOURCE_GROUP = 'rg-ai-in-one';

/**
 * The resource group for a new vault. Someone with Contributor on a resource group but not the
 * subscription can't create groups, so they're asked for one that exists.
 * @param {Ctx} ctx
 * @param {string} subscriptionId
 * @param {boolean} [askFirst]  Ask even when the saved or default group would do.
 */
async function askResourceGroup(ctx, subscriptionId, askFirst = asksAdvanced(ctx)) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  for (let ask = askFirst; ; ask = true) {
    const name = kv.resourceGroup ?? DEFAULT_RESOURCE_GROUP;
    kv.resourceGroup = (ask ? await ui.input('Resource group (created if missing)', { default: name }) : name).trim();
    if (await api.arm.getResourceGroup(subscriptionId, kv.resourceGroup).catch(() => null)) return;
    const perms = await api.arm.permissions(`/subscriptions/${subscriptionId}`).catch(() => null);
    if (!perms || allowsAction(perms, 'Microsoft.Resources/subscriptions/resourceGroups/write')) return;
    ui.warn(`There's no resource group called ${kv.resourceGroup} that you can see, and you can't create one in this subscription. Give the name of one you have Contributor on.`);
    if (ui.yes) return;
  }
}

/**
 * Shows what no Key Vault means, then asks. Returns true when the user agrees.
 * With --yes, --no-key-vault (or --secret-in-notebook) is the agreement, or no Key Vault being the default.
 * @param {Ctx} ctx
 * @param {boolean} [byDefault]  No Key Vault is the default here, so --yes takes it.
 */
async function confirmNotebookMode(ctx, byDefault = false) {
  const { ui, config } = ctx;
  ui.warn('No Key Vault: the client secret is written into the notebooks as plain text.');
  ui.info('  - Anyone with a role in the workspace, Viewer included, or anyone a notebook is shared with, can read it');
  ui.info('    and use it to read your tenant\'s data through Microsoft Graph.');
  ui.info('  - It is copied into notebook run snapshots, exports and deployment pipelines. The installer won\'t write it');
  ui.info('    into a workspace that is connected to Git.');
  ui.info(`  - It lasts ${notebookSecretDays(config)} days. Each install, repair or update replaces it and removes the old one.`);
  ui.info('Key Vault avoids this: the notebooks read the secret from the vault at run time, so a workspace role doesn\'t expose it.');
  const ok = ui.yes ? !!ctx.secretInNotebook || byDefault : await ui.confirm('Keep the client secret in the notebooks, with no Key Vault?', true);
  if (ui.yes && !ok) ui.note('With --yes, add --no-key-vault to choose this.');
  if (!ok) return false;
  config.keyVault.mode = 'notebook';
  delete config.keyVault.handoff;
  return true;
}

/**
 * Asks for the client ID of an app the user brought, and checks it has what the install needs
 * before anything is created.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'canConsent'>} pre
 */
export async function askAppId(ctx, pre) {
  const { ui, config } = ctx;
  for (;;) {
    config.app.appId = (
      await ui.input('Application (client) ID', { default: config.app.appId, validate: (v) => (isGuid(v) ? true : 'Paste the GUID from the app\'s Overview page.') })
    ).trim();
    for (;;) {
      const check = await checkExistingApp(ctx, ctx.liveApi ?? ctx.api);
      if (check.displayName) config.app.displayName = check.displayName;
      if (reportAppCheck(ctx, check, pre)) return;
      if (ui.yes) {
        if (!check.found) throw new Error(`No app registration with ID ${config.app.appId} in this tenant.`);
        ui.warn('Carrying on. Data the missing permissions cover won\'t load until an admin fixes them.');
        return;
      }
      const next = await ui.select(
        'What next?',
        [
          { name: 'Check again', value: 'again', description: 'Once an admin has fixed it.' },
          { name: 'Enter a different client ID', value: 'other' },
          ...(check.found ? [{ name: 'Carry on anyway', value: 'go', description: 'Data the missing permissions cover won\'t load until they\'re fixed.' }] : []),
        ],
        'again',
      );
      if (next === 'go') {
        ui.warn('Carrying on with the app as it is.');
        return;
      }
      if (next === 'other') break;
    }
  }
}

/**
 * Writes the admin pack for someone who can't register apps or grant consent, then waits for
 * the client ID. Returns true when the user still needs to paste the secret.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'canConsent'>} pre
 */
export async function planAdminPack(ctx, pre) {
  const { ui, config } = ctx;
  const kv = config.keyVault;
  const file = writeAdminPack(ctx);
  config.app.adminPack = file;
  ui.heading('Admin pack');
  ui.warn('An admin needs to register the app. Send them this file:');
  ui.info(file);
  ui.info('Or they can run this in Azure Cloud Shell (Bash):');
  for (const line of adminPack(ctx).script) ui.info(`  ${line}`);
  ctx.save();
  if (ui.yes) throw new ResumeLater('Stopped until an admin has registered the app. Once they send you its client ID, run the installer again without --yes.');
  const next = await ui.select(
    'Has the admin sent you the client ID?',
    [
      { name: 'Yes, enter it now', value: 'go' },
      { name: 'Stop and resume later', value: 'stop', description: 'Your answers are saved. Run the installer again once you have it.' },
    ],
    'go',
  );
  if (next === 'stop') throw new ResumeLater(`Stopped until an admin has registered the app. Send them ${file}, then run the installer again.`);
  await askAppId(ctx, pre);
  if (secretMode(config) === 'keyvault-admin' && kv.name) {
    if (await ui.confirm(`Did the admin's script also put the client secret in ${kv.name}?`, true)) {
      kv.handoff = { ...kv.handoff, confirmedAt: ctx.now().toISOString() };
      kv.secretSetAt = kv.handoff.confirmedAt;
    }
    return false;
  }
  return true;
}

/**
 * @param {string} base
 * @param {Set<string>} taken  Lower-case names.
 */
export function uniqueName(base, taken) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Names a new install suggests. Existing installs keep the names in their record. */
export const DEFAULT_WORKSPACE_NAME = 'AI in One';
export { DEFAULT_LAKEHOUSE_NAME };

export const CAPACITY_HINT = 'F64 or larger is recommended for more than 10,000 people; small or trial capacities work but loads are slower.';

/**
 * A capacity as a choice: its name, then the SKU and region when Fabric gives them.
 * @param {{ displayName?: string, id: string, sku?: string, region?: string }} cap
 */
export function capacityLabel(cap) {
  const about = [cap.sku, cap.region].filter(Boolean).join(', ');
  return `${cap.displayName ?? cap.id}${about ? ` (${about})` : ''}`;
}

/**
 * The name to start from: the default when `name` is the default or a numbered copy of it,
 * otherwise `name`, which someone chose.
 * @param {string | undefined} name
 * @param {string} base
 */
const startFrom = (name, base) => (!name || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ _]\\d+$`, 'i').test(name) ? base : name);

/**
 * Picks names for the Fabric items the install will create that no item already in the
 * workspace has, so the install never touches anything it didn't create.
 * @param {Ctx} ctx
 */
export async function reserveNames(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const sm = config.semanticModel;
  const ws = f.workspaceId;
  const list = async (/** @type {string} */ type) => (ws ? /** @type {any[]} */ (await api.fabric.listItems(ws, type)) : []);
  const [notebookItems, pipelineItems, modelItems, reportItems] = await Promise.all([list('Notebook'), list('DataPipeline'), list('SemanticModel'), list('Report')]);
  const [notebookNames, pipelineNames, modelNames, reportNames] = [notebookItems, pipelineItems, modelItems, reportItems].map(displayNames);
  /** @type {string[]} */
  const renamed = [];
  /**
   * Keeps the name of an item a run that stopped part-way created, so it's used again, not renamed.
   * @param {string} key @param {any[]} items @param {string} wanted @param {string[]} taken
   */
  const pick = (key, items, wanted, taken) => {
    const resumed = stoppedRunItem(f, key, items);
    if (resumed) return String(resumed.displayName);
    const name = freeName(wanted, taken);
    if (name !== wanted) renamed.push(wanted);
    taken.push(name);
    return name;
  };

  f.notebookNames ??= {};
  for (const nb of notebooksFor(config.modules, { semanticModel: !!sm.enabled })) {
    if (!f.notebooks[nb.key]) f.notebookNames[nb.key] = pick(`Notebook:${nb.key}`, notebookItems, startFrom(f.notebookNames[nb.key], nb.displayName), notebookNames);
  }
  if (!f.pipelineId) f.pipelineName = pick('DataPipeline', pipelineItems, startFrom(f.pipelineName, PIPELINE_NAME), pipelineNames);
  if (sm.enabled && !sm.id) sm.name = pick(`SemanticModel:${modelKey(config, sm)}`, modelItems, startFrom(sm.name, MODEL_NAME), modelNames);
  for (const w of reportsWanted(ctx)) {
    if (!w.model.report?.id) w.model.report = { ...w.model.report, name: pick(`Report:${modelKey(config, w.model)}`, reportItems, startFrom(w.model.report?.name, w.name), reportNames) };
  }

  if (renamed.length) {
    ui.note(
      `The workspace already has ${renamed.map((n) => `"${n}"`).join(', ')}, not from this install. They're left as they are; AI in One's own items get the names shown in the plan.`,
    );
  }
}

/**
 * @typedef {{ kind: string, name: string, detail?: string, isNew: boolean }} ReviewItem
 * @typedef {{ who: string, what: string, where: string, detail?: string }} ReviewGrant
 * @typedef {{ what: string, where: string, detail?: string }} ReviewRun
 * @typedef {{ what: string, detail?: string, url: string }} ReviewCost
 * @typedef {{ creates: ReviewItem[], grants: ReviewGrant[], runsOn: ReviewRun[], costs?: ReviewCost[] }} PlanReview
 */

export const PRICING = {
  fabric: 'https://azure.microsoft.com/pricing/details/microsoft-fabric/',
  keyVault: 'https://azure.microsoft.com/pricing/details/key-vault/',
};

/**
 * What the install adds to the bill, each with where its prices are. No prices here: they change
 * and differ by region and agreement.
 * @param {import('../config.js').InstallConfig} config
 * @returns {ReviewCost[]}
 */
export function planCosts(config) {
  /** @type {ReviewCost[]} */
  const costs = [
    { what: 'Fabric capacity', detail: 'Runs the notebooks, pipeline, semantic model and report. Billed by capacity size; a trial capacity is free while it lasts.', url: PRICING.fabric },
  ];
  if (secretMode(config) !== 'notebook') costs.push({ what: 'Azure Key Vault', detail: 'Holds the app\'s client secret. Billed to your Azure subscription.', url: PRICING.keyVault });
  return costs;
}

/**
 * What the plan creates, who it gives access to what, and where it runs: the record a
 * reviewer reads before saying go ahead.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'capacities' | 'subscriptions' | 'canConsent'>} [pre]
 * @returns {PlanReview}
 */
export function planReview(ctx, pre) {
  const { config, user } = ctx;
  const f = config.fabric;
  const kv = config.keyVault;
  const sm = config.semanticModel;
  const appName = config.app.appId ? config.app.displayName ?? config.app.appId : APP_NAME;
  const notebooks = notebooksFor(config.modules, { semanticModel: !!sm.enabled });
  const workspace = `Workspace ${f.workspaceName ?? f.workspaceId}`;

  const mode = secretMode(config);
  /** @type {ReviewItem[]} */
  const creates = [
    {
      kind: 'App registration',
      name: appName,
      isNew: !config.app.appId,
      detail:
        config.app.adminPack && !config.app.appId
          ? 'An admin registers it from the admin pack and sends you its client ID.'
          : mode === 'notebook'
            ? config.app.existing
              ? 'Yours. A client secret you paste is written into the notebooks; no Key Vault.'
              : `Its client secret is written into the notebooks, lasts ${notebookSecretDays(config)} days and is replaced on each install, repair or update. No Key Vault.`
            : mode === 'keyvault-admin'
              ? `${config.app.existing ? 'Yours. ' : ''}A vault admin adds its client secret to Key Vault.`
              : config.app.existing
                ? 'Yours. A client secret you paste goes straight to Key Vault.'
                : 'Signs in to Microsoft Graph for the notebooks, with a client secret kept in Key Vault.',
    },
    mode === 'notebook'
      ? {
          kind: 'Client secret',
          name: 'In the notebooks (no Key Vault)',
          // Every install, repair or update writes a fresh secret.
          isNew: true,
          detail: 'Anyone with a role in the workspace, Viewer included, can read it; also in run snapshots, exports and deployment pipelines. Key Vault avoids that.',
        }
      : {
          kind: 'Key Vault',
          name: kv.name ?? 'Not chosen',
          isNew: !kv.existing && !kv.uri,
          detail: [
            kv.existing || kv.uri ? undefined : `In resource group ${kv.resourceGroup}, ${kv.location}, using ${kv.rbac ? 'Azure RBAC' : 'access policies'}.`,
            `Holds the secret "${kv.secretName}".`,
            mode === 'keyvault-admin' ? 'A vault admin adds it; you get their steps.' : undefined,
          ]
            .filter(Boolean)
            .join(' '),
        },
    { kind: 'Workspace', name: f.workspaceName ?? f.workspaceId ?? 'Not chosen', isNew: !f.workspaceId },
    f.existingLakehouse
      ? { kind: 'Lakehouse', name: f.lakehouseName ?? f.lakehouseId ?? 'Not chosen', isNew: false, detail: 'Yours, with schemas turned on. Uninstall leaves it.' }
      : { kind: 'Lakehouse', name: f.lakehouseName ?? DEFAULT_LAKEHOUSE_NAME, isNew: !f.lakehouseId, detail: 'With schemas turned on: the notebooks write their tables to its dbo schema.' },
    {
      kind: 'Notebooks',
      name: `${notebooks.length} notebooks`,
      isNew: notebooks.some((nb) => !f.notebooks[nb.key]),
      detail: notebooks.map((nb) => f.notebookNames?.[nb.key] ?? nb.displayName).join(', '),
    },
    { kind: 'Pipeline', name: f.pipelineName ?? PIPELINE_NAME, isNew: !f.pipelineId, detail: `Runs the notebooks ${describeSchedule(config.schedule)}.` },
  ];
  if (sm.enabled) {
    creates.push({ kind: 'Semantic model', name: sm.name, isNew: !sm.id, ...(sm.id ? { detail: MODEL_UPDATE_NOTE } : {}) });
    creates.push({
      kind: 'Connection',
      name: sm.connectionName ?? (f.workspaceId ? connectionName(f.workspaceId) : 'AI in One SQL connection'),
      isNew: !sm.connectionId,
      detail: 'Lets the model read the Lakehouse, with a second client secret that only the connection holds.',
    });
    for (const w of reportsWanted(ctx)) {
      creates.push({ kind: 'Report', name: w.model.report?.name ?? w.name, isNew: !w.model.report?.id, detail: `From the Power BI template, reading ${w.model.name}.` });
    }
  }
  const access = sm.enabled ? accessReview(config, `Semantic model ${sm.name} in workspace ${f.workspaceName ?? f.workspaceId}`) : { creates: [], grants: [] };
  creates.push(...access.creates);

  const appWho = `${appName} (app)`;
  /** @type {ReviewGrant[]} */
  const grants = [
    {
      who: appWho,
      what: `Microsoft Graph application permissions: ${permissionsFor(config.modules).join(', ')}`,
      where: 'Your tenant, through admin consent',
      detail: pre && !pre.canConsent ? 'You can\'t grant it yourself. You get a link for a Global Administrator or Privileged Role Administrator to approve.' : undefined,
    },
  ];
  if (!kv.uri && mode === 'keyvault-admin') {
    grants.push({
      who: `${user.upn} (you)`,
      what: kv.rbac === false ? 'An access policy with secret get and list' : 'Key Vault Secrets User, or an access policy with secret get and list if the vault doesn\'t use Azure RBAC',
      where: `Key Vault ${kv.name}`,
      detail: 'Read only, so scheduled runs can read the secret. Only when you don\'t have it already; if you can\'t give it to yourself, the vault admin\'s steps include it.',
    });
  } else if (!kv.uri && mode === 'keyvault') {
    grants.push({
      who: `${user.upn} (you)`,
      what: kv.existing
        ? 'Key Vault Secrets Officer, or an access policy with secret get, list and set if the vault doesn\'t use Azure RBAC'
        : kv.rbac === false
          ? 'An access policy with secret get, list and set'
          : 'Key Vault Secrets Officer, so you can write the secret',
      where: `Key Vault ${kv.name}`,
      detail: kv.existing ? 'Only when you don\'t have it already.' : undefined,
    });
  }
  if (sm.enabled) grants.push({ who: appWho, what: 'Viewer', where: workspace, detail: 'So the semantic model can read the Lakehouse.' });
  grants.push(...access.grants);

  const capacity = pre?.capacities.find((cap) => cap.id === f.capacityId);
  const subscription = pre?.subscriptions.find((s) => s.subscriptionId === kv.subscriptionId);
  /** @type {ReviewRun[]} */
  const runsOn = [
    {
      what: sm.enabled ? 'Notebooks, pipeline, semantic model and report' : 'Notebooks and pipeline',
      where: capacity ? `Fabric capacity ${capacity.displayName} (${capacity.sku}, ${capacity.region})` : `Fabric capacity ${f.capacityId ?? 'not chosen'}`,
    },
    ...(mode === 'notebook' ? [] : [{ what: 'Key Vault', where: `Azure subscription ${subscription?.displayName ?? kv.subscriptionId ?? 'already chosen'}`, detail: 'Standard tier.' }]),
    {
      what: 'Scheduled runs',
      where: `${describeSchedule(config.schedule)}, as ${user.upn}`,
      detail: mode === 'notebook' ? 'The schedule\'s owner refreshes the model; the secret is in the notebooks.' : 'The schedule\'s owner reads the secret and refreshes the model.',
    },
  ];
  if (ctx.runFirstLoad) runsOn.push({ what: 'First load', where: `${config.history.days} days of audit history, straight after setup` });
  if (ctx.reloadHistoryDays) runsOn.push({ what: 'History reload', where: reloadLine(ctx.reloadHistoryDays), detail: reloadDetail(ctx.reloadHistoryDays) });
  return { creates, grants, runsOn, costs: planCosts(config) };
}

/** @param {number} days */
export const reloadLine = (days) => `Reload ${days} days of history after setup`;

/**
 * How long a reload takes, roughly.
 * @param {number} _days
 */
export const reloadDetail = (_days) => `One pipeline run. ${LOAD_TIME}; the scheduled runs carry on after it.`;

/**
 * Prints the plan and asks to go ahead.
 * @param {Ctx} ctx
 * @param {Preflight} [pre]
 */
export async function confirmPlan(ctx, pre) {
  const { ui, config } = ctx;
  const f = config.fabric;
  ui.heading('Ready to set up');
  ui.info(`Data:        ${collectedLabels(config.modules).join(', ')}`);
  ui.info(`Workspace:   ${f.workspaceName ?? f.workspaceId} ${f.workspaceId ? '' : c.dim('(new)')}`);
  ui.info(`Lakehouse:   ${f.lakehouseName} ${f.existingLakehouse ? c.dim('(yours)') : f.lakehouseId ? '' : c.dim('(new)')}`.trimEnd());
  ui.info(`App:         ${config.app.appId ? config.app.appId : `${APP_NAME} ${c.dim('(new)')}`}`);
  const kvMode = secretMode(config);
  if (kvMode === 'notebook') ui.info(`Secret:      in the notebooks ${c.dim(`(no Key Vault: anyone with a role in the workspace can read it; lasts ${notebookSecretDays(config)} days)`)}`);
  else if (kvMode === 'keyvault-admin') ui.info(`Key Vault:   ${config.keyVault.name} ${c.dim('(a vault admin adds the secret)')}`);
  else ui.info(`Key Vault:   ${config.keyVault.name} ${config.keyVault.existing || config.keyVault.uri ? '' : c.dim(`(new, ${config.keyVault.rbac ? 'Azure RBAC' : 'access policies'})`)}`);
  ui.info(`Schedule:    ${config.schedule.frequency === 'weekly' ? `${config.schedule.weekday}s` : 'Daily'} at ${config.schedule.time} ${config.schedule.timeZone}`);
  const seats = pre?.seats ? c.dim(` (${seatCount(pre.seats)} Copilot seats assigned)`) : '';
  ui.info(`Tenant size: ${config.scale === 'large' ? 'large (more than 10,000 people)' : 'standard (up to 10,000 people)'}${seats}`);
  const capacity = pre?.capacities.find((cap) => cap.id === f.capacityId);
  for (const w of sizingWarnings({ seats: pre?.seats, capacity, scale: config.scale })) ui.warn(w);
  if (config.semanticModel.enabled) {
    const sm = config.semanticModel;
    ui.info(`Power BI:    ${sm.name} ${sm.id ? '' : c.dim('(new)')}`.trimEnd());
    const reports = reportsWanted(ctx).map((w) => `${w.model.report?.name ?? w.name} ${w.model.report?.id ? '' : c.dim('(new)')}`.trimEnd());
    if (reports.length) ui.info(`Report:      ${reports.join(', ')}`);
  }
  if (ctx.runFirstLoad) ui.info(`First load:  ${config.history.days} days of history, straight after setup`);
  if (ctx.reloadHistoryDays) ui.info(`History:     ${reloadLine(ctx.reloadHistoryDays)} ${c.dim(`(${reloadDetail(ctx.reloadHistoryDays)})`)}`);
  ui.review(planReview(ctx, pre));
  ui.note(keepAwake());
  return ui.confirm('Go ahead?', true);
}

/** Said before Go ahead: a PC that sleeps stops the setup part way. */
export const KEEP_AWAKE = 'Keep this PC plugged in and awake until setup finishes.';
/** The same in Azure Cloud Shell, where closing the tab ends the session. */
export const KEEP_CLOUD_SHELL_OPEN = 'Keep this Cloud Shell tab open until setup finishes.';
/** @param {NodeJS.ProcessEnv} [env] */
export const keepAwake = (env = process.env) => (inCloudShell(env) ? KEEP_CLOUD_SHELL_OPEN : KEEP_AWAKE);
