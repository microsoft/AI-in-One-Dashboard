// @ts-check
/**
 * What the installer deploys on the Fabric path: the Classic Fabric edition's notebooks, the
 * installer's own refresh and data-check notebooks, and the Graph application permissions they need.
 */

/** Microsoft Graph's application ID. Same in every tenant. */
export const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

/** @typedef {'core' | 'orgData'} ModuleId */

/**
 * @typedef {object} ModuleInfo
 * @property {ModuleId} id
 * @property {string} label
 * @property {string} description
 * @property {boolean} required
 * @property {boolean} defaultOn
 * @property {string[]} permissions  Graph application permissions (by value).
 * @property {string | null} pipelineParameter  The pipeline's Enable* switch.
 */

/** @type {Record<ModuleId, ModuleInfo>} */
export const MODULES = {
  core: {
    id: 'core',
    label: 'Copilot usage and licences',
    description: 'From the Microsoft 365 audit log and your Copilot licences. Shows who uses Copilot Chat and agents, in which apps and how often.',
    required: true,
    defaultOn: true,
    permissions: ['AuditLogsQuery.Read.All', 'Reports.Read.All'],
    pipelineParameter: null,
  },
  orgData: {
    id: 'orgData',
    label: 'Org data',
    description: 'From Microsoft Entra ID. Adds each person\'s department, job title and country, so you can compare teams.',
    required: true,
    defaultOn: true,
    permissions: ['User.Read.All'],
    pipelineParameter: 'EnableOrgDataPull',
  },
};

/** Modules that change the semantic model. */
export const MODEL_MODULES = /** @type {const} */ (['core', 'orgData']);

/** Always collected: the dashboard is built on them. Shown locked on the Data sources screen. */
export const ESSENTIAL_MODULES = /** @type {const} */ (['core', 'orgData']);

/**
 * Modules the Data sources screen can switch on, in order. None yet: an Agent 365 load on the
 * Fabric path is a follow-up.
 * @type {readonly never[]}
 */
export const OPTIONAL_MODULES = [];

/** @typedef {'auditIngester' | 'licensedUsers' | 'orgData' | 'dataCheck' | 'refreshModel'} NotebookKey */

/**
 * A text change the installer makes to its copy of a notebook. `find` must occur exactly once.
 * @typedef {{ find: string, replace: string }} NotebookPatch
 */

/**
 * @typedef {object} NotebookInfo
 * @property {NotebookKey} key
 * @property {string} file  File name in `dir`.
 * @property {string} [dir]  Folder under the source folder. Defaults to {@link NOTEBOOKS_DIR}.
 * @property {string} displayName  Item name in the Fabric workspace.
 * @property {ModuleId} module
 * @property {boolean} credentials  Has TENANT_ID / CLIENT_ID / CLIENT_SECRET to fill in.
 * @property {string[]} parameters  Assignments the pipeline overrides; the cell holding them is tagged `parameters`.
 * @property {string | null} placeholder  Notebook-ID placeholder in the pipeline template.
 * @property {boolean} [semanticModel]  Only deployed with the semantic model.
 * @property {Record<string, string>} [values]  String settings the installer's copy always has.
 * @property {Record<string, string>} [expressions]  Python expressions the installer's copy always has, e.g. `True`.
 * @property {NotebookPatch[]} [patches]
 */

/** The Classic Fabric edition, which the installer deploys from, under the source folder. */
export const SETUP_DIR = 'Classic Editions/3. Fabric';
export const NOTEBOOKS_DIR = `${SETUP_DIR}/notebooks`;
/** The installer's own notebooks, under the source folder. */
export const ASSETS_DIR = 'installer/assets/notebooks';

/** @type {NotebookInfo[]} */
export const NOTEBOOKS = [
  {
    key: 'auditIngester',
    file: 'Copilot_Audit_Log_Direct_Ingester.ipynb',
    displayName: 'Copilot_Audit_Log_Direct_Ingester',
    module: 'core',
    credentials: true,
    parameters: ['MODE', 'BACKFILL_DAYS'],
    placeholder: 'REPLACE_WITH_AUDIT_LOG_NOTEBOOK_ID',
  },
  {
    key: 'licensedUsers',
    file: 'Copilot_Licensed_Users_Direct_Ingester.ipynb',
    displayName: 'Copilot_Licensed_Users_Direct_Ingester',
    module: 'core',
    credentials: true,
    parameters: [],
    placeholder: 'REPLACE_WITH_LICENSED_USERS_NOTEBOOK_ID',
  },
  {
    key: 'dataCheck',
    file: 'AIO_Data_Check.ipynb',
    dir: ASSETS_DIR,
    displayName: 'AIO_Data_Check',
    module: 'core',
    credentials: false,
    parameters: [],
    placeholder: null,
  },
  {
    key: 'orgData',
    file: 'Copilot_Org_Data_Direct_Ingester.ipynb',
    displayName: 'Copilot_Org_Data_Direct_Ingester',
    module: 'orgData',
    credentials: true,
    parameters: [],
    placeholder: 'REPLACE_WITH_ORG_DATA_NOTEBOOK_ID',
  },
  {
    key: 'refreshModel',
    file: 'AIO_Refresh_Model.ipynb',
    dir: ASSETS_DIR,
    displayName: 'AIO_Refresh_Model',
    module: 'core',
    credentials: false,
    parameters: ['WORKSPACE_ID', 'SEMANTIC_MODEL_ID', 'TIMEOUT_MINUTES'],
    placeholder: null,
    semanticModel: true,
  },
];

/** @typedef {{ orgData: boolean }} ModuleChoice */

/** @returns {ModuleChoice} */
export function defaultModules() {
  return { orgData: MODULES.orgData.defaultOn };
}

/**
 * Org data is always on, whatever a record says: the model's org table reads dbo.copilot_org_data,
 * so the refresh fails without it.
 * @param {Partial<ModuleChoice> | undefined} choice
 * @returns {ModuleChoice}
 */
export function normaliseModules(choice) {
  return { ...defaultModules(), ...(choice ?? {}), orgData: true };
}

/**
 * Names of the data being collected: the essentials, then the ticked extras.
 * @param {ModuleChoice} modules
 * @returns {string[]}
 */
export function collectedLabels(modules) {
  return [...ESSENTIAL_MODULES, ...OPTIONAL_MODULES.filter((id) => modules[id])].map((id) => MODULES[id].label);
}

/**
 * @param {ModuleChoice} modules
 * @returns {ModuleId[]}
 */
export function enabledModules(modules) {
  /** @type {ModuleId[]} */
  const out = ['core'];
  if (modules.orgData) out.push('orgData');
  return out;
}

/**
 * Notebooks to deploy for the chosen modules, in deployment order.
 * @param {ModuleChoice} modules
 * @param {{ semanticModel?: boolean }} [opts]
 * @returns {NotebookInfo[]}
 */
export function notebooksFor(modules, opts = {}) {
  const on = new Set(enabledModules(modules));
  return NOTEBOOKS.filter((nb) => on.has(nb.module) && (!nb.semanticModel || opts.semanticModel));
}

/**
 * Graph application permissions the app registration needs, de-duplicated and sorted.
 * Org data's User.Read.All is always included, because org data is always collected.
 * @param {ModuleChoice} modules
 * @returns {string[]}
 */
export function permissionsFor(modules) {
  const set = new Set([...MODULES.core.permissions, ...MODULES.orgData.permissions]);
  for (const id of enabledModules(modules)) for (const p of MODULES[id].permissions) set.add(p);
  return [...set].sort();
}

/**
 * The PAX route's Graph application permissions: what PAX reads with app-only sign-in for -Rollup
 * and the Users file, and Sites.Selected for the task's own upload to the one site the app is given.
 */
export const PAX_PERMISSIONS = ['AuditLogsQuery.Read.All', 'User.Read.All', 'Organization.Read.All', 'Sites.Selected'];
/** The Agent 365 catalogue, read app-only. It's in preview, so a tenant may not have them yet. */
export const AGENT365_PERMISSIONS = ['CopilotPackages.Read.All', 'Application.Read.All'];

/**
 * The Graph application permissions for a PAX setup. Files kept in a folder on the PC go to no
 * site, so that setup has no Sites.Selected.
 * @param {{ agent365?: boolean, destination?: string } | undefined} pax
 */
export const paxPermissions = (pax) => [
  ...(pax?.destination === 'local' ? PAX_PERMISSIONS.filter((p) => p !== 'Sites.Selected') : PAX_PERMISSIONS),
  ...(pax?.agent365 ? AGENT365_PERMISSIONS : []),
];
