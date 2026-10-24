// @ts-check
/**
 * The PAX route's checks and questions. As on the Fabric route, they all come first so the rest of
 * the install can run by itself: the tenant, then this PC, then what to collect, where the files
 * go, who can view, the app registration and when the task runs. Then the plan, for a go-ahead.
 */
import { APP_ROLES, CONSENT_ROLES } from '../clients/graph.js';
import { emptyPax, REPORT_NAME } from '../config.js';
import { ADMIN_STEPS, LINKS } from '../managed-app/errors.js';
import { copilotSeats, seatCount } from '../seats.js';
import { accessReview, planAccess, VIEWER_GROUP_NAME } from '../steps/access.js';
import { askAdvanced, asksAdvanced } from '../steps/advanced.js';
import {
  askAppId,
  askMoreHistory,
  blockedSettings,
  DEFAULT_WORKSPACE_NAME,
  HISTORY_CHOICES,
  keepAwake,
  reloadLine,
  uniqueName,
  validateTime,
} from '../steps/plan.js';
import { c } from '../ui.js';
import { AGENT365_PERMISSIONS, OWN_APP, paxPermissions } from './identity.js';
import { CERT_MONTHS, CERT_SUBJECT, defaultLocalFolder, PAX_APP_NAME, paxFiles, SEED_WINDOW_DAYS, SP_FOLDER, TASK_NAME } from './names.js';
import { checkPc, pcRows } from './pc.js';
import { loadRelease } from './release.js';
import { refreshTimes } from './report.js';
import { folderLabel, parseSiteUrl, restoreCommands, revokeCommands, siteAddress } from './site.js';
import { describeLogon } from './task.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../config.js').PaxConfig} PaxConfig */
/** @typedef {import('../config.js').PaxSite} PaxSite */
/** @typedef {import('./pc.js').PcCheck} PcCheck */
/** @typedef {import('../steps/plan.js').PlanReview} PlanReview */
/** @typedef {import('../steps/plan.js').ReviewItem} ReviewItem */
/** @typedef {import('../steps/plan.js').ReviewGrant} ReviewGrant */
/** @typedef {import('../steps/plan.js').ReviewRun} ReviewRun */
/** @typedef {import('../steps/plan.js').ReviewCost} ReviewCost */
/** @typedef {import('../steps/plan.js').Preflight & { pc?: PcCheck }} PaxPreflight */

export const POWER_BI_PRICING = 'https://www.microsoft.com/power-platform/products/power-bi/pricing';
/** The app people open in the browser. */
const THE_APP = 'the AI in One app';
/** The library the files go to when the site's address doesn't name one. */
const DEFAULT_LIBRARY = 'Documents';
/**
 * How a load of history goes, and how long it takes: no more precise than this, as it depends on
 * the tenant.
 */
const SEED_HOW = `PAX loads it ${SEED_WINDOW_DAYS} days at a time, oldest first. It can take from under an hour to several hours in a large tenant, where a run that reaches the task's 4-hour limit carries on at the next one`;

/** What the task collects, in words. @param {{ agent365?: boolean }} pax */
export const paxCollected = (pax) => ['Copilot interactions', 'users and their licences', ...(pax.agent365 ? ['Agent 365'] : [])];

/** Where the files go, in words. @param {PaxConfig} pax */
export const filesLabel = (pax) =>
  pax.destination === 'local' ? pax.localFolder ?? defaultLocalFolder() : pax.site ? folderLabel(pax.site) : 'A SharePoint folder, not chosen yet';

/**
 * Checks the tenant, then this PC. The PC's check starts first: PowerShell takes a few seconds.
 * @param {Ctx} ctx
 * @returns {Promise<PaxPreflight>}
 */
export async function paxPreflight(ctx) {
  const { ui, api, user, config, sources } = ctx;
  const pcCheck = checkPc(ctx);
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
  if (!config.app.appId && canCreateApps === false) {
    ui.warn(`Users in this tenant can't register apps and you have no app admin role. Ask an admin to create "${PAX_APP_NAME}" with you as an owner, then choose "${OWN_APP}".`);
  }

  const seats = await copilotSeats(api);
  if (seats) ui.ok(`${seatCount(seats)} Microsoft 365 Copilot ${seats === 1 ? 'seat' : 'seats'} assigned`);

  /** @type {PaxPreflight['tenantSettings']} */
  let tenantSettings;
  try {
    tenantSettings = Object.fromEntries((await api.fabric.tenantSettings()).map((s) => [s.settingName, s]));
  } catch {
    // Only Fabric administrators can read them.
  }
  // The model reads the files with your sign-in, so only the report's own setting matters here.
  if (sources.paxModelFile && config.pax?.destination !== 'local') {
    for (const s of blockedSettings(tenantSettings, { reports: true }).filter((s) => s.reports)) {
      ui.warn(`The tenant setting "${s.title}" is off. ${s.effect}`);
      ui.note('A Fabric administrator can switch it on in the admin portal, under Tenant settings.');
    }
  }

  const pc = await pcCheck;
  showPc(ui, pc);
  return { capacities: [], subscriptions: [], roles: roles.map((r) => r.displayName), canConsent, canCreateApps, tenantSettings, seats, pc };
}

/**
 * Shows what this PC has for the scheduled task, and stops when it can't run it. Python can wait
 * when winget can install it; without the certificate command the task uses a client secret.
 * @param {import('../ui.js').Ui} ui
 * @param {PcCheck} pc
 * @param {NodeJS.Platform} [platform]
 */
export function showPc(ui, pc, platform) {
  ui.heading('Checking this PC');
  /** @type {Map<string, string[]>} */
  const unknown = new Map();
  /** @type {string[]} */
  const missing = [];
  for (const row of pcRows(pc, platform)) {
    if (row.status === 'met') ui.ok(`${row.label}: ${row.detail}`);
    else if (row.status === 'unknown') unknown.set(row.detail, [...(unknown.get(row.detail) ?? []), row.label]);
    else if (row.id === 'python' && pc.probe?.winget) {
      ui.warn(`${row.label}: ${row.detail}`);
      ui.info(row.howTo);
    } else if (row.optional) {
      ui.note(`${row.label}: ${row.detail} ${row.howTo}`);
    } else {
      ui.fail(`${row.label}: ${row.detail}`);
      ui.info(row.howTo);
      missing.push(row.label);
    }
  }
  for (const [detail, labels] of unknown) ui.warn(`${labels.join(', ')}: ${detail}`);
  if (unknown.size) ui.note('The installer checks again before it sets up the task.');
  if (missing.length) {
    throw new Error(`This PC can't run the scheduled task yet. Missing: ${missing.join('; ')}. Fix ${missing.length === 1 ? 'it' : 'them'}, then run the installer again.`);
  }
}

/** A folder path in a document library, such as "AI in One" or "Reports/AI in One". */
const cleanFolder = (/** @type {string} */ v) =>
  v
    .trim()
    .replace(/^[\\/]+|[\\/]+$/g, '')
    .split('/')
    .map((part) => part.trim())
    .join('/');

/** @param {string} v */
export function validateFolder(v) {
  const folder = cleanFolder(v);
  if (!folder) return 'Required';
  if (/["*:<>?|#%\\]/.test(folder)) return 'Leave out these characters: " * : < > ? | # % \\';
  if (folder.split('/').some((part) => !part || part === '.' || part === '..')) return 'Give each folder in the path a name.';
  return true;
}

/**
 * A library's name, or the last part of its address. The report decodes the files' addresses,
 * so a # or % in them would break it.
 * @param {string} v
 */
export function validateLibrary(v) {
  const library = v.trim();
  if (!library) return 'Required';
  if (/["*:<>?|#%\\/]/.test(library)) return 'Leave out these characters: " * : < > ? | # % / \\';
  return true;
}

/**
 * Why the report can't read the site's library or folder, which can come from a pasted link.
 * @param {PaxSite} site
 */
function folderProblem(site) {
  const library = validateLibrary(site.library ?? '');
  if (library !== true) return `The report can't use the library "${site.library ?? ''}" (${library}).`;
  const folder = validateFolder(site.folder || SP_FOLDER);
  if (folder !== true) return `The report can't use the folder "${site.folder}" (${folder}).`;
  return '';
}

/** @param {string} v */
export function validateLocalFolder(v) {
  const path = v.trim();
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(path)) return 'Use a full path, such as C:\\Data\\AI in One.';
  if (/["*?<>|]/.test(path) || path.indexOf(':', 2) !== -1) return 'Leave out these characters: " * ? < > | :';
  return true;
}

/**
 * Points the site at another library or folder. Another library is another drive, and either
 * change means the app's write access is checked again.
 * @param {PaxSite} site
 * @param {string} library
 * @param {string} folder
 */
function moveFolder(site, library, folder) {
  if (String(site.library ?? '').toLowerCase() !== library.toLowerCase()) {
    delete site.driveId;
    delete site.driveWebUrl;
  }
  if (site.library !== library || site.folder !== folder) delete site.checkedAt;
  site.library = library;
  site.folder = folder;
}

/** The site's own address, from the install record, where it may be a link to a folder. @param {PaxSite} site */
function recordedSite(site) {
  if (site.host) return siteAddress(site);
  try {
    return parseSiteUrl(site.url).url;
  } catch {
    return String(site.url ?? '');
  }
}

/** @param {string} v */
function checkSiteUrl(v) {
  try {
    parseSiteUrl(v);
    return true;
  } catch (err) {
    return /** @type {Error} */ (err).message;
  }
}

/**
 * The SharePoint site, library and folder.
 * @param {Ctx} ctx
 * @param {PaxConfig} pax
 * @param {boolean} advanced
 */
async function chooseSite(ctx, pax, advanced) {
  const { ui } = ctx;
  if (ui.yes && !pax.site?.url) {
    throw new Error(
      'A new SharePoint setup needs the site. Add "pax": { "site": { "url": "https://<tenant>.sharepoint.com/sites/<site>" } } to the install record, or run without --yes.',
    );
  }
  const answer = await ui.input("SharePoint site address (or the folder's address)", { default: pax.site?.url, validate: checkSiteUrl });
  const parsed = parseSiteUrl(answer);
  const old = pax.site;
  if (old && recordedSite(old).toLowerCase() === parsed.url.toLowerCase()) {
    Object.assign(old, { url: parsed.url, host: parsed.host, path: parsed.path });
    moveFolder(old, parsed.library ?? old.library ?? DEFAULT_LIBRARY, parsed.folder ?? old.folder ?? SP_FOLDER);
  } else {
    if (old?.grantId && old.grantedByInstaller) {
      ui.warn(`The app keeps its write access to ${siteAddress(old)} until it's taken away. A SharePoint or Global Administrator can run:`);
      for (const line of revokeCommands(old)) ui.info(`  ${line}`);
    } else if (old?.grantId && old.previousRoles?.length) {
      ui.warn(`The app keeps write access to ${siteAddress(old)} until it's put back to ${old.previousRoles.join(', ')}. A SharePoint or Global Administrator can run:`);
      for (const line of restoreCommands(old, old.previousRoles)) ui.info(`  ${line}`);
    }
    pax.site = { url: parsed.url, host: parsed.host, path: parsed.path, library: parsed.library ?? DEFAULT_LIBRARY, folder: parsed.folder ?? SP_FOLDER };
  }
  const site = /** @type {PaxSite} */ (pax.site);
  const problem = folderProblem(site);
  if (problem) ui.warn(`${problem} Type the library and folder instead.`);
  if (advanced || problem) {
    const library = (await ui.input('Document library', { default: site.library, validate: validateLibrary })).trim();
    const folder = cleanFolder(await ui.input('Folder in the library', { default: site.folder, validate: validateFolder }));
    moveFolder(site, library, folder);
  }
  ui.ok(`Files: ${folderLabel(site)}`);
}

/**
 * The Power BI workspace for the report: one the user has, or a new one.
 * @param {Ctx} ctx
 */
async function chooseWorkspace(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (f.workspaceId) {
    ui.ok(`Power BI workspace: ${f.workspaceName ?? f.workspaceId}`);
    return;
  }
  /** @type {any[]} */
  let workspaces = [];
  try {
    workspaces = (await api.fabric.listWorkspaces()).filter((w) => w.type === 'Workspace');
  } catch (err) {
    ui.warn(`Couldn't list your workspaces (${/** @type {Error} */ (err).message}), so the report goes in a new one.`);
  }
  const choice = workspaces.length
    ? await ui.select(
      'Power BI workspace for the report',
      [{ name: 'Create a new workspace', value: '' }, ...workspaces.map((w) => ({ name: `Use "${w.displayName}"`, value: String(w.id) }))],
      '',
    )
    : '';
  if (choice) {
    f.workspaceId = choice;
    f.workspaceName = workspaces.find((w) => w.id === choice)?.displayName;
    return;
  }
  const taken = new Set(workspaces.map((w) => String(w.displayName).toLowerCase()));
  f.workspaceName = await ui.input('New workspace name', {
    default: f.workspaceName ?? uniqueName(DEFAULT_WORKSPACE_NAME, taken),
    validate: (v) => (!v.trim() ? 'Required' : taken.has(v.trim().toLowerCase()) ? 'A workspace with that name exists.' : true),
  });
}

/**
 * The PAX route's questions, or one section's when the browser edits it.
 * @param {Ctx} ctx
 * @param {PaxPreflight} pre
 * @param {string} [section]
 */
export async function paxPlan(ctx, pre, section) {
  const { ui, config, sources } = ctx;
  const pax = (config.pax ??= emptyPax());
  const advanced = () => !!section || asksAdvanced(ctx);
  const editing = (/** @type {string} */ id) => !section || section === id;
  // The report needs the files in SharePoint, and the checkout's SharePoint Power BI template.
  const modelOn = () => pax.destination === 'sharepoint' && !!sources.paxModelFile;
  config.semanticModel.enabled = modelOn();

  if (editing('data')) {
    ui.heading('What it collects');
    ui.info('  - Copilot interactions, from the Purview audit log');
    ui.info('  - Users and their licences, from Microsoft Entra ID');
    if (!section) {
      await askAdvanced(ctx, 'the Agent 365 file, audit history, who can view, the library and folder, when the task runs, and the first load');
    }
    if (advanced()) {
      ui.note(`The Agent 365 file lists your organisation's agents. Reading it as an app needs ${AGENT365_PERMISSIONS.join(' and ')}, and is in preview.`);
      pax.agent365 = await ui.confirm('Also collect the Agent 365 file?', !!pax.agent365);
    } else if (pax.agent365) {
      ui.info('  - Agents, from Agent 365');
    }
  }

  if (editing('placement')) {
    ui.heading('Where the files go');
    const destination = await ui.select(
      'Where should the scheduled task put the files?',
      [
        { name: 'A SharePoint folder (recommended)', value: 'sharepoint', description: 'The report and the AI in One app read them from there.' },
        { name: 'A folder on this PC', value: 'local', description: 'Only you can open them, in Power BI Desktop or the AI in One app. No report is published.' },
      ],
      pax.destination,
    );
    pax.destination = /** @type {PaxConfig['destination']} */ (destination);
    if (pax.destination === 'sharepoint') {
      await chooseSite(ctx, pax, advanced());
    } else {
      pax.localFolder = (await ui.input('Folder for the files', { default: pax.localFolder ?? defaultLocalFolder(), validate: validateLocalFolder })).trim();
      ui.note('Nothing is published: you open the report on these files in Power BI Desktop.');
      if (config.semanticModel.id) ui.note(`${config.semanticModel.name} stays in Power BI, no longer refreshed. Delete it there if you don't need it.`);
    }

    config.semanticModel.enabled = modelOn();
    if (config.semanticModel.enabled) await chooseWorkspace(ctx);
    else if (pax.destination === 'sharepoint') ui.note('This copy of the installer has no SharePoint Power BI template, so it won\'t publish the report.');

    ui.note(`${THE_APP[0].toUpperCase()}${THE_APP.slice(1)} shows the same data in the browser. Each person who opens it needs Power Apps Premium or Copilot Credits: ${ADMIN_STEPS.licences.link}`);
    ui.note(
      pax.destination === 'local'
        ? `In it, you choose Change data and pick the files from ${pax.localFolder}.`
        : 'In it, viewers choose Change data and pick the files from the SharePoint folder, so they need read access to it. The installer doesn\'t give that.',
    );
    ui.note('If the tenant isn\'t ready for it, the installer says what an admin needs to turn on, and finishes without it.');
    pax.deployApp = await ui.confirm(`Deploy ${THE_APP}?`, pax.deployApp !== false);
  }

  if (editing('access')) {
    if (config.semanticModel.enabled || pax.deployApp) await planAccess(ctx);
  }

  if (editing('identity')) {
    ui.heading('App registration');
    if (config.app.appId) {
      ui.ok(`Using ${config.app.displayName ?? 'app'} (${config.app.appId})`);
    } else {
      const mode = await ui.select(
        'The scheduled task signs in to Microsoft Graph and SharePoint as an app.',
        [
          { name: `Create "${PAX_APP_NAME}" (recommended)`, value: 'new' },
          { name: OWN_APP, value: 'existing', description: 'You need to be one of its owners: the installer adds the task\'s certificate to it.' },
        ],
        pre.canCreateApps === false && !ui.yes ? 'existing' : 'new',
      );
      config.app.existing = mode === 'existing';
      if (config.app.existing) await askAppId(ctx, pre);
    }
  }

  if (editing('schedule')) {
    const web = !!section && ui.web;
    if (!web && (advanced() || pax.firstRunStartedAt)) ui.heading('Schedule');
    if (!pax.firstRunStartedAt) {
      delete ctx.reloadHistoryDays;
      if (advanced()) config.history.days = await ui.select('How much audit history should the first (seed) run load?', HISTORY_CHOICES, config.history.days);
    } else {
      await askMoreHistory(ctx, (days) => `Straight after setup, the task loads ${days} days again. Then the daily runs carry on.`);
    }
    if (web) {
      const values = await ui.form('Schedule', [
        { id: 'runAt', label: 'Time the task runs each day (this PC\'s time, 24-hour)', default: pax.runAt, validate: validateTime },
        {
          id: 'signedOut',
          label: 'Also run while you are signed out',
          default: pax.signedOut ? 'yes' : 'no',
          choices: [
            { name: 'Yes', value: 'yes' },
            { name: 'No', value: 'no' },
          ],
        },
      ]);
      if (!values) throw Object.assign(new Error('Changes cancelled'), { name: 'SettingsCancelled' });
      pax.runAt = values.runAt;
      pax.signedOut = values.signedOut === 'yes';
    } else if (advanced()) {
      pax.runAt = await ui.input('Time the task runs each day (this PC\'s time, 24-hour)', { default: pax.runAt, validate: validateTime });
      ui.note('When this PC is off or you\'re signed out at that time, it runs when you next sign in.');
      pax.signedOut = await ui.confirm(
        'Also run while you are signed out? Windows asks for your password in Task Scheduler; the installer never sees it.',
        !!pax.signedOut,
      );
    }
    ctx.runFirstLoad = pax.firstRunStartedAt ? false : !advanced() || (await ui.confirm('Run the first load as soon as setup finishes?', true));
  }
}

/** The pinned PAX version, or undefined when this copy of the installer has none. */
function pinnedVersion() {
  try {
    return loadRelease().version;
  } catch {
    return undefined;
  }
}

/**
 * How the task signs in, in words.
 * @param {PaxConfig} pax
 */
export const taskLogon = (pax) =>
  pax.signedOut && pax.logonType !== 'Password'
    ? 'whether or not you are signed in, once you give Windows your password in Task Scheduler'
    : describeLogon(pax.logonType);

/**
 * What happens to the app's access to a site the files no longer go to: the installer offers to
 * take back access it gave or raised, and an admin's stays.
 * @param {PaxSite} site
 */
function leavingDetail(site) {
  const where = `The files no longer go to ${siteAddress(site)}`;
  if (site.grantedByInstaller) return `${where}, so the installer offers to take back the app's access there.`;
  if (site.previousRoles?.length) return `${where}, so the installer offers to put the app's access there back to ${site.previousRoles.join(', ')}.`;
  return `${where}. The installer didn't give the app its access there, so it stays, and you get the commands an admin can use to take it away.`;
}

/**
 * What the PAX plan creates, who it gives access to what, and where it runs: the record a reviewer
 * reads before saying go ahead.
 * @param {Ctx} ctx
 * @param {Pick<PaxPreflight, 'canConsent' | 'pc'>} [pre]
 * @returns {PlanReview}
 */
export function paxPlanReview(ctx, pre) {
  const { config, user } = ctx;
  const pax = config.pax ?? emptyPax();
  const sm = config.semanticModel;
  const f = config.fabric;
  const site = pax.destination === 'sharepoint' ? pax.site : undefined;
  const appName = config.app.appId ? config.app.displayName ?? config.app.appId : PAX_APP_NAME;
  const appWho = `${appName} (app)`;
  const secret = pax.credentialType === 'secret' || pre?.pc?.probe?.certificates === false;
  const files = paxFiles(pax).join(', ');
  const version = pinnedVersion();
  const group = config.access?.groupName ?? VIEWER_GROUP_NAME;

  /** @type {ReviewItem[]} */
  const creates = [
    {
      kind: 'App registration',
      name: appName,
      isNew: !config.app.appId,
      detail: `${config.app.existing ? 'Yours. ' : ''}The scheduled task signs in as it to read the audit log and Entra ID${site ? ', and to write to the SharePoint folder' : ''}.`,
    },
    secret
      ? {
          kind: 'Client secret',
          name: 'On this PC, for your account only',
          isNew: !pax.secretKeyId,
          detail: 'Windows protects it so that only your account on this PC can read it. Used when this PC can\'t make a certificate.',
        }
      : {
          kind: 'Certificate',
          name: CERT_SUBJECT,
          isNew: !pax.certificateThumbprint,
          detail: `In your account's certificate store, valid for ${CERT_MONTHS} months; the installer renews it when it's close to expiring. Only its public key goes on the app registration.`,
        },
    {
      kind: 'PAX',
      name: version ? `PAX ${version}` : 'PAX',
      isNew: !version || pax.version !== version,
      detail: `The Purview audit log processor, downloaded from its GitHub release and checked against the SHA-256 hash this installer pins, into %LOCALAPPDATA%\\AIInOne\\pax\\${version ?? '<version>'}.`,
    },
    {
      kind: 'Scheduled task',
      name: TASK_NAME,
      isNew: !pax.taskRegisteredAt,
      detail: `Runs PAX each day at ${pax.runAt}, loading the last ${pax.windowDays} days, then ${site ? 'uploads the files' : 'copies the files to the folder'}.`,
    },
    site
      ? { kind: 'SharePoint folder', name: folderLabel(site), isNew: !site.checkedAt, detail: `Holds ${files}. The task's script uploads them as the app.` }
      : { kind: 'Folder', name: filesLabel(pax), isNew: !pax.taskRegisteredAt, detail: `Holds ${files}, on this PC only.` },
  ];
  if (!pre?.pc?.probe?.python && pre?.pc?.probe?.winget) {
    creates.push({ kind: 'Python', name: 'Python 3.13, for your account', isNew: true, detail: 'Installed with winget, only if you say yes when the installer offers it.' });
  }
  const workspace = f.workspaceName ?? f.workspaceId ?? 'Not chosen';
  if (sm.enabled) {
    creates.push({ kind: 'Workspace', name: workspace, isNew: !f.workspaceId, ...(f.workspaceId ? {} : { detail: 'A Power BI workspace, with no capacity.' }) });
    creates.push({
      kind: 'Semantic model',
      name: sm.name,
      isNew: !sm.id,
      detail: `Reads the files from the SharePoint folder with your sign-in. Power BI refreshes it at ${refreshTimes(pax.runAt).join(' and ')}.`,
    });
    creates.push({ kind: 'Report', name: sm.report?.name ?? REPORT_NAME, isNew: !sm.report?.id, detail: `From the Power BI template, reading ${sm.name}.` });
  }
  const access = sm.enabled ? accessReview(config, `Semantic model ${sm.name} in workspace ${workspace}`) : { creates: [], grants: [] };
  if (pax.deployApp && !sm.enabled) access.creates = accessReview(config, '').creates;
  creates.push(...access.creates);
  if (pax.deployApp) {
    creates.push({
      kind: 'Managed app',
      name: THE_APP,
      isNew: !config.managedApp?.appId,
      detail: 'A Copilot managed app that shows the same data in the browser, from the files people pick in it.',
    });
  }

  const wanted = paxPermissions(pax);
  const dropped = config.app.appId ? (config.app.permissions ?? []).filter((p) => !wanted.includes(p)) : [];
  const leaving = pax.destination === 'local' && pax.site?.grantId && !pax.site.left ? pax.site : undefined;
  const graphDetail = [
    pre && !pre.canConsent ? 'You can\'t grant it yourself. You get a link for a Global Administrator or Privileged Role Administrator to approve.' : '',
    dropped.length && config.app.existing ? `It no longer needs ${dropped.join(', ')}. You can remove them from your app registration.` : '',
    dropped.length && !config.app.existing ? `Takes away ${dropped.join(', ')}, which this setup no longer needs.` : '',
    leaving ? leavingDetail(leaving) : '',
  ].filter(Boolean);
  /** @type {ReviewGrant[]} */
  const grants = [
    {
      who: appWho,
      what: `Microsoft Graph application permissions: ${wanted.join(', ')}`,
      where: 'Your tenant, through admin consent',
      detail: graphDetail.length ? graphDetail.join(' ') : undefined,
    },
  ];
  if (site) {
    grants.push({
      who: appWho,
      what: 'Write (Sites.Selected)',
      where: `SharePoint site ${siteAddress(site)}, and no other`,
      detail: site.grantId ? undefined : 'Giving it takes an admin\'s consent. If you can\'t, you get the commands for a SharePoint or Global Administrator to run.',
    });
  }
  grants.push(...access.grants);
  if (pax.deployApp && config.access) {
    grants.push({
      who: `${group} (group)`,
      what: 'Open the app',
      where: THE_APP,
      detail: site ? 'To see data in it, they also need read access to the SharePoint folder, which the installer doesn\'t give.' : 'The files are on this PC, so only you can load them.',
    });
  }

  /** @type {ReviewRun[]} */
  const runsOn = [
    {
      what: 'Scheduled task',
      where: `This PC, as ${pax.userName ?? pre?.pc?.probe?.user ?? user.upn}, each day at ${pax.runAt}`,
      detail: `Runs ${taskLogon(pax)}.`,
    },
  ];
  if (sm.enabled) runsOn.push({ what: 'Semantic model and report', where: `Power BI workspace ${workspace}`, detail: `Refreshed at ${refreshTimes(pax.runAt).join(' and ')} each day.` });
  if (pax.deployApp) runsOn.push({ what: 'The AI in One app', where: 'Copilot managed apps, in your Power Platform developer environment' });
  if (ctx.runFirstLoad) runsOn.push({ what: 'First load', where: `${config.history.days} days of audit history, on this PC straight after setup`, detail: `${SEED_HOW}.` });
  if (ctx.reloadHistoryDays) {
    runsOn.push({
      what: 'History reload',
      where: reloadLine(ctx.reloadHistoryDays),
      detail: `Straight after setup. ${SEED_HOW}. The files stay as they are until it has all loaded, then the daily runs carry on.`,
    });
  }

  /** @type {ReviewCost[]} */
  const costs = [];
  if (sm.enabled) {
    costs.push({ what: 'Power BI Pro or Premium Per User', detail: 'For you to publish and share the report, and for each viewer unless the workspace is on a capacity.', url: POWER_BI_PRICING });
  }
  if (pax.deployApp) costs.push({ what: 'Power Apps Premium or Copilot Credits', detail: 'For each person who opens the AI in One app.', url: LINKS.licensing });
  return { creates, grants, runsOn, costs };
}

/**
 * Prints the PAX plan and asks to go ahead.
 * @param {Ctx} ctx
 * @param {PaxPreflight} [pre]
 */
export async function confirmPaxPlan(ctx, pre) {
  const { ui, config } = ctx;
  const pax = config.pax ?? emptyPax();
  const sm = config.semanticModel;
  const isNew = c.dim('(new)');
  ui.heading('Ready to set up');
  ui.info(`Data:        ${paxCollected(pax).join(', ')}`);
  ui.info(`Files:       ${filesLabel(pax)}`);
  ui.info(`Task:        ${`${TASK_NAME}, daily at ${pax.runAt}${pax.signedOut ? ', also while you are signed out' : ''} ${pax.taskRegisteredAt ? '' : isNew}`.trimEnd()}`);
  ui.info(`Entra app:   ${config.app.appId ? config.app.displayName ?? config.app.appId : `${PAX_APP_NAME} ${isNew}`}`);
  if (sm.enabled) ui.info(`Power BI:    ${`${sm.name} in ${config.fabric.workspaceName ?? config.fabric.workspaceId} ${sm.id ? '' : isNew}`.trimEnd()}`);
  ui.info(`App:         ${pax.deployApp ? `${THE_APP} ${config.managedApp?.appId ? '' : isNew}`.trimEnd() : c.dim('not deployed')}`);
  if (ctx.runFirstLoad) ui.info(`First load:  ${config.history.days} days of history, straight after setup`);
  if (ctx.reloadHistoryDays) ui.info(`History:     ${reloadLine(ctx.reloadHistoryDays)}`);
  ui.review(paxPlanReview(ctx, pre));
  ui.note(keepAwake(ctx.env));
  return ui.confirm('Go ahead?', true);
}

/** Why a PAX install stops on a PC that isn't Windows. */
export const PAX_NEEDS_WINDOWS = 'With PAX, Task Scheduler on a Windows PC or server runs PAX each day. Run the installer on that PC.';

/**
 * A new install's first question: where AI in One gets its data.
 * @param {import('../ui.js').Ui} ui
 * @returns {Promise<import('../config.js').Target>}
 */
export async function chooseTarget(ui) {
  const target = await ui.select(
    'Where should AI in One get its data?',
    [
      {
        name: 'Fabric',
        value: 'fabric',
        description: 'Notebooks in a Fabric workspace load the audit log each day. Needs a Fabric capacity (F2 or larger, or a trial).',
      },
      {
        name: 'PAX, on this Windows PC',
        value: 'pax',
        description: 'A scheduled task on this PC runs PAX each day and puts the files in a SharePoint folder, for the report and the AI in One app. No capacity.',
      },
    ],
    'fabric',
  );
  return /** @type {import('../config.js').Target} */ (target);
}
