// @ts-check
/**
 * The install record, `aio-install.json`. It holds IDs and choices so a
 * re-run picks up where the last one stopped. It never holds a secret.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normaliseModules } from './catalog.js';

export const CONFIG_VERSION = 1;
export const DEFAULT_CONFIG_FILE = 'aio-install.json';

/** @typedef {'Admin' | 'Member' | 'Contributor' | 'Viewer'} WorkspaceRole */

/**
 * @typedef {object} InstallConfig
 * @property {number} version
 * @property {Target} [target]  Where AI in One gets its data. Fabric when absent.
 * @property {PaxConfig} [pax]  The PAX setup. Only on the PAX target.
 * @property {ManagedAppConfig} [managedApp]  The AI in One app. Only on the PAX target.
 * @property {string} [tenantId]
 * @property {import('./catalog.js').ModuleChoice} modules  What the notebooks collect. Org data is always on.
 * @property {{ days: number }} history
 * @property {import('./transform/pipeline.js').TenantScale} [scale]  How the loads are sized. Standard when absent.
 * @property {{ frequency: 'daily' | 'weekly', time: string, weekday: string, timeZone: string }} schedule
 * @property {{ appId?: string, objectId?: string, servicePrincipalId?: string, displayName?: string, secretExpires?: string, secretKeyId?: string, retiredSecretKeyIds?: string[], pendingSecretKeyIds?: string[], secretAttempts?: { ref: string, at: string }[], existing?: boolean, adminPack?: string, secretDays?: number }} app  The Entra app registration the notebooks, or on the PAX target the scheduled task, sign in as. pendingSecretKeyIds: notebook secrets created by a run that hadn't finished writing them. secretAttempts: notebook secrets asked of Entra whose key ID isn't saved yet; the ref is in the secret's name. secretDays: how long a secret kept in the notebooks lasts (--secret-days). 90 when absent.
 * @property {{ subscriptionId?: string, resourceGroup?: string, name?: string, id?: string, uri?: string, location?: string, secretName: string, existing?: boolean, rbac?: boolean, private?: boolean, secretSetAt?: string, mode?: SecretMode, handoff?: SecretHandoff } & import('./steps/secrets.js').SecretSlot} keyVault  The secret* fields track the app secrets made for the vault (see steps/secrets.js); previousSecretKeyIds are replaced ones left on the app until they expire.
 * @property {{ capacityId?: string, workspaceId?: string, workspaceName?: string, lakehouseId?: string, lakehouseName?: string, existingLakehouse?: boolean, notebooks: Partial<Record<import('./catalog.js').NotebookKey, string>>, notebookNames?: Partial<Record<import('./catalog.js').NotebookKey, string>>, notebookHashes?: Partial<Record<import('./catalog.js').NotebookKey, string>>, pipelineId?: string, pipelineName?: string, pipelineModules?: string, pipelineVersion?: number, scheduleId?: string, vaultEndpointId?: string, secretInNotebooks?: boolean, createdWorkspace?: boolean, appRole?: { workspaceId: string, principalId: string, role: WorkspaceRole, previous?: WorkspaceRole }, pendingItems?: Record<string, { name: string, ref: string, at?: string, operation?: string }> }} fabric  existingLakehouse: the user chose a schema-enabled Lakehouse they already had, so uninstall leaves it. appRole: the workspace role the installer gave the app's service principal, in which workspace, and the role it had before when the installer raised one, so uninstall takes away only that. pendingItems: the name and description ref of each item being created, and when, so a run stopped mid-create finds that item again and nothing else. operation: Fabric's URL for the create once it accepted it, to ask how it went.
 * @property {{ jobId?: string, status?: string, startedAt?: string, finishedAt?: string }} [firstRun]
 * @property {SemanticModelConfig} semanticModel
 * @property {AccessConfig} [access]  Who can view AI in One. Absent until the installer has set it up.
 * @property {{ completed: string[], runFirstLoad?: boolean, reloadHistoryDays?: number, baseRevision?: string, approved?: boolean }} [setup] Browser setup draft progress; never contains secrets. runFirstLoad and reloadHistoryDays are kept only in the draft, never in the install record.
 */

/**
 * Where AI in One gets its data.
 * - `fabric`: notebooks in a Fabric workspace load it into a Lakehouse.
 * - `pax`: PAX, run each day by a scheduled task on a Windows PC, writes CSV files to a SharePoint
 *   folder (or a local folder) that the report and the AI in One app read.
 * @typedef {'fabric' | 'pax'} Target
 */
export const TARGETS = /** @type {const} */ (['fabric', 'pax']);

/**
 * The PAX setup.
 * @typedef {object} PaxConfig
 * @property {'sharepoint' | 'local'} destination  Where the files go.
 * @property {PaxSite} [site]  The SharePoint site, library and folder.
 * @property {string} [localFolder]  The folder the files are copied to, when they stay on this PC.
 * @property {number} windowDays  Days each daily run loads.
 * @property {string} runAt  When the task runs each day, HH:mm local time.
 * @property {boolean} [signedOut]  The user chose to have the task run while they're signed out. Windows holds their password, never the installer.
 * @property {'Interactive' | 'Password' | 'S4U'} [logonType]  How the registered task signs in: Interactive while the user is signed in, Password or S4U once it runs while they're signed out.
 * @property {boolean} agent365  Also load the Agent 365 file.
 * @property {boolean} deployApp  Deploy the AI in One app.
 * @property {'certificate' | 'secret'} credentialType  How the task signs in as the app.
 * @property {string} [certificateThumbprint]  In the user's personal certificate store.
 * @property {string} [certificateExpires]
 * @property {string} [certificateKeyId]  The certificate's key on the app registration.
 * @property {string} [secretKeyId]  When the task signs in with a secret, kept protected for the user on this PC.
 * @property {string} [secretExpires]
 * @property {string[]} [retiredKeyIds]  Replaced certificates or secrets still to take off the app.
 * @property {string[]} [retiredThumbprints]  Replaced certificates still to delete from the user's certificate store.
 * @property {string} [version]  The PAX release the task runs.
 * @property {string} [script]  Where it is.
 * @property {string} [sha256]
 * @property {string} [pythonDir]  The folder of the Python the installer checked.
 * @property {string} [pwsh]  PowerShell 7's full path.
 * @property {string} [userSid]  The account the task runs as.
 * @property {string} [userName]
 * @property {string} [timeZone]  Windows' name for the PC's time zone.
 * @property {string} [taskRegisteredAt]
 * @property {string} [firstRunStartedAt]  When the installer started the first (seed) run.
 */

/**
 * @typedef {object} PaxSite
 * @property {string} url  The site's own address.
 * @property {string} [host]  Such as contoso.sharepoint.com.
 * @property {string} [path]  Such as /sites/AIinOne. Empty for the root site.
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [webUrl]
 * @property {string} library  The document library's name.
 * @property {string} [driveId]
 * @property {string} [driveWebUrl]
 * @property {string} folder  The folder in the library.
 * @property {string} [grantId]  The app's write permission on the site, so uninstall can take it away.
 * @property {boolean} [grantedByInstaller]  The installer gave that permission, rather than an admin.
 * @property {string} [checkedAt]  When the app last showed it can write to the folder.
 */

/**
 * The AI in One app, deployed as a Copilot managed app.
 * @typedef {object} ManagedAppConfig
 * @property {string} [appId]
 * @property {string} [url]  Where people open it.
 * @property {string} [environmentId]
 * @property {string} [deployedAt]
 * @property {string} [buildHash]  A hash of the build that was deployed.
 * @property {string[]} [sharedWith]  The groups it's shared with.
 * @property {('createApps' | 'externalArtifacts')[]} [missing]  The tenant settings the last attempt found turned off.
 * @property {{ why: string, steps: string[] }} [skipped]  Why the last attempt didn't deploy it, and what to do.
 */

/** @returns {PaxConfig} */
export function emptyPax() {
  return { destination: 'sharepoint', windowDays: 7, runAt: '02:00', agent365: false, deployApp: true, credentialType: 'certificate' };
}

/** @param {InstallConfig} config @returns {Target} */
export const targetOf = (config) => config.target ?? 'fabric';

/**
 * The one Entra group whose members can view AI in One.
 * @typedef {object} AccessConfig
 * @property {string} [groupId]
 * @property {string} [groupName]
 * @property {boolean} [createdGroup]  The installer created the group, rather than being given one.
 * @property {string} [contact]  Who people ask for access. Defaults to the installer.
 * @property {string} [requestUrl]  Optional link for access requests, e.g. a My Access package or a form.
 * @property {string[]} [grantedModels]  Semantic model IDs the group has Build (ReadExplore) on.
 * @property {boolean} [reportShared]  The user said the AI in One report is shared with the group, so its members can open it.
 */

/**
 * Where the app's client secret lives and who puts it there.
 * - `keyvault`: the installer writes it to Key Vault (the default when absent).
 * - `keyvault-admin`: a vault admin writes it to Key Vault; the user only needs read access.
 * - `notebook`: no Key Vault. The installer writes it into the notebooks as plain text, where anyone
 *   with a role in the workspace can read it. It lasts 90 days by default and every install, repair
 *   or update replaces it.
 * @typedef {'keyvault' | 'keyvault-admin' | 'notebook'} SecretMode
 */

/**
 * The vault admin handoff. It never holds the secret value.
 * @typedef {object} SecretHandoff
 * @property {string} [shownAt]  When the admin steps were last shown.
 * @property {string} [adminEmail]  The admin who was added as an owner of the app, if any.
 * @property {string} [confirmedAt]  When the user said the admin had added the secret.
 * @property {boolean} [grantRead]  The user couldn't give themselves read access, so the admin is asked to.
 */

/** @param {InstallConfig} config @returns {SecretMode} */
export const secretMode = (config) => config.keyVault?.mode ?? 'keyvault';

/**
 * A semantic model the installer deploys and refreshes.
 * @typedef {object} ModelConfig
 * @property {string} [id]
 * @property {string} name
 * @property {string} [signature]  What the deployed definition was built from.
 * @property {boolean} [bound]  Reads the Lakehouse through the installer's connection. On the PAX target: its owner signed it in to its SharePoint files.
 * @property {ModelReload} [reload]  Owed a reload: its definition was, or may have been, replaced and no refresh has finished since.
 * @property {ReportConfig} [report]  The report published on the model.
 */

/**
 * Recorded before a request that can change a model's definition; taken back only once the
 * installer's own whole-model refresh, requested after the change settled, finishes cleanly.
 * @typedef {object} ModelReload
 * @property {string} since  When the change last settled, or, while `unsettled`, when the request was made.
 * @property {boolean} [cleared]  Fabric was allowed to clear its data, so it shows nothing until then.
 * @property {boolean} [unsettled]  The request may or may not have changed the model; the next run applies it again before reloading.
 * @property {string} [ours]  The whole-model refresh the installer requested after the change settled, which can be its reload. Cleared when it ends badly.
 */

/**
 * A Power BI report published from a template and bound to one of the installer's models.
 * @typedef {object} ReportConfig
 * @property {string} [id]
 * @property {string} name
 * @property {string} [signature]  A hash of the template's report files when it was published.
 * @property {string} [modelId]  The model it reads.
 */

/**
 * The semantic model and report built from the Fabric edition's Power BI template, and the
 * connection the model reads the Lakehouse through. On the PAX target they're built from the
 * SharePoint edition's template instead, and read the files in the SharePoint folder.
 * @typedef {object} SemanticModelConfig
 * @property {boolean} [enabled]
 * @property {string} [id]
 * @property {string} name
 * @property {string} [server]  SQL analytics endpoint the model points at.
 * @property {string} [database]
 * @property {string} [signature]  What the deployed definition was built from.
 * @property {string} [connectionId]
 * @property {string} [connectionName]
 * @property {string} [secretKeyId]  The app secret that only the connection holds.
 * @property {string} [secretExpires]
 * @property {{ ref: string, at: string }[]} [secretAttempts]  Connection secrets asked of Entra, key ID not saved yet (see steps/secrets.js).
 * @property {string[]} [pendingSecretKeyIds]  Connection secrets made but not yet confirmed in use.
 * @property {string[]} [retiredSecretKeyIds]  Replaced connection secrets still to remove from the app.
 * @property {boolean} [bound]  Reads the Lakehouse through the connection. On the PAX target: its owner signed it in to its SharePoint files.
 * @property {ModelReload} [reload]  Owed a reload: its definition was, or may have been, replaced and no refresh has finished since.
 * @property {ReportConfig} [report]  The AI in One report.
 * @property {boolean} [desktop]  PAX target: the workspace didn't take the model from the installer, so it was published from Power BI Desktop. The installer leaves its definition as it is.
 * @property {string[]} [refreshTimes]  PAX target: the times, HH:mm, the installer set Power BI to refresh it each day.
 */

// Names for items a new install creates. An existing install keeps the names saved in its record.
export const MODEL_NAME = 'AI in One';
export const REPORT_NAME = 'AI in One';

/** @returns {InstallConfig} */
export function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    target: 'fabric',
    modules: normaliseModules(undefined),
    history: { days: 180 },
    schedule: { frequency: 'daily', time: '02:00', weekday: 'Sunday', timeZone: 'UTC' },
    app: {},
    keyVault: { secretName: 'ai-in-one-client-secret' },
    fabric: { notebooks: {} },
    semanticModel: { name: MODEL_NAME },
  };
}

/**
 * @param {string} file
 * @returns {{ config: InstallConfig, existed: boolean }}
 */
export function loadConfig(file) {
  if (!existsSync(file)) {
    const config = emptyConfig();
    remember(config, file, null, JSON.stringify(config));
    return { config, existed: false };
  }
  /** @type {string} */
  let text;
  /** @type {any} */
  let raw;
  try {
    text = readFileSync(file, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  const config = normaliseConfig(raw, file);
  remember(config, file, text, JSON.stringify(config));
  return { config, existed: true };
}

/**
 * A record as read from disk, with the defaults for anything it doesn't have yet. Fields this
 * installer doesn't know are left as they are and not used.
 * @param {any} raw
 * @param {string} file
 * @returns {InstallConfig}
 */
function normaliseConfig(raw, file) {
  if (raw.version !== CONFIG_VERSION) throw new Error(`${file} has version ${raw.version}; this installer reads version ${CONFIG_VERSION}.`);
  if (raw.target !== undefined && !TARGETS.includes(raw.target)) {
    throw new Error(`${file} is for an install on ${raw.target}; this installer sets up AI in One on Fabric or with PAX.`);
  }
  const base = emptyConfig();
  /** @type {InstallConfig} */
  const config = {
    ...base,
    ...raw,
    target: raw.target ?? 'fabric',
    modules: normaliseModules(raw.modules),
    history: { ...base.history, ...(raw.history ?? {}) },
    schedule: { ...base.schedule, ...(raw.schedule ?? {}) },
    app: { ...(raw.app ?? {}) },
    keyVault: { ...base.keyVault, ...(raw.keyVault ?? {}) },
    fabric: { ...base.fabric, ...(raw.fabric ?? {}), notebooks: { ...(raw.fabric?.notebooks ?? {}) } },
    semanticModel: { ...base.semanticModel, ...(raw.semanticModel ?? {}) },
    ...(raw.access ? { access: { ...raw.access, grantedModels: [...(raw.access.grantedModels ?? [])] } } : {}),
    ...(raw.pax ? { pax: { ...emptyPax(), ...raw.pax, ...(raw.pax.site ? { site: { ...raw.pax.site } } : {}) } } : {}),
    ...(raw.managedApp ? { managedApp: { ...raw.managedApp } } : {}),
  };
  assertNoSecrets(config);
  return config;
}

/**
 * For each record loadConfig returned, by file: the text it last read or wrote there (null when there was
 * no file), and the record as it stood then. Another command can write the record meanwhile, such as
 * access while an install waits hours for its first load; saveConfig merges what it changed.
 * @type {WeakMap<object, Map<string, { read: string | null, base: string }>>}
 */
const lastSeen = new WeakMap();

/** @param {object} config @param {string} file @param {string | null} read @param {string} base */
function remember(config, file, read, base) {
  let files = lastSeen.get(config);
  if (!files) lastSeen.set(config, (files = new Map()));
  files.set(resolve(file), { read, base });
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A three-way merge, field by field: each side keeps what only it changed since `base`. When both changed
 * the same field to different values, `ours` wins, as the later save. A field one side removed and the
 * other left alone stays removed. Lists are merged whole.
 * @param {any} base
 * @param {any} ours
 * @param {any} theirs
 * @returns {any}
 */
function mergeRecord(base, ours, theirs) {
  if (isDeepStrictEqual(ours, base)) return theirs;
  if (isDeepStrictEqual(theirs, base) || isDeepStrictEqual(ours, theirs)) return ours;
  if (!isRecord(ours) || !isRecord(theirs)) return ours;
  const was = isRecord(base) ? base : {};
  /** @type {Record<string, any>} */
  const merged = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const value = mergeRecord(was[key], ours[key], theirs[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Brings the record in memory up to date with what was saved, changing only the fields the merge changed,
 * in place, so code holding part of it (a `const sm = config.semanticModel`, say) sees them too.
 * @param {Record<string, any>} live
 * @param {Record<string, any>} ours  What `live` held, as JSON.
 * @param {Record<string, any>} merged
 */
function adopt(live, ours, merged) {
  for (const key of Object.keys(ours)) if (!Object.hasOwn(merged, key)) delete live[key];
  for (const [key, value] of Object.entries(merged)) {
    if (isDeepStrictEqual(value, ours[key])) continue;
    const held = live[key];
    if (isRecord(value) && isRecord(ours[key]) && isRecord(held)) adopt(held, ours[key], value);
    else if (Array.isArray(value) && Array.isArray(held)) held.splice(0, held.length, ...value);
    else live[key] = value;
  }
}

/**
 * What to save when another command has written the record since `config` last read or wrote it: both
 * sets of changes, merged. Undefined when nobody else has written it, or what's there can't be read as a
 * record, so the save writes `config` as it is.
 * @param {string} file
 * @param {InstallConfig} config
 * @param {{ read: string | null, base: string }} last
 * @param {(ms: number) => void} wait
 * @returns {{ ours: Record<string, any>, merged: Record<string, any> } | undefined}
 */
function mergeTheirs(file, config, last, wait) {
  for (let attempt = 1; ; attempt++) {
    /** @type {any} */
    let theirs;
    try {
      const disk = readFileSync(file, 'utf8');
      if (disk === last.read) return undefined;
      theirs = JSON.parse(disk);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return undefined;
      // Half-written or held open: the other command may be writing it in place (see saveConfig). Give it
      // a moment; if it still can't be read, this command's own changes are saved rather than lost.
      if (attempt >= 3) return undefined;
      wait(100 * attempt);
      continue;
    }
    try {
      theirs = JSON.parse(JSON.stringify(normaliseConfig(theirs, file)));
    } catch {
      return undefined;
    }
    const ours = JSON.parse(JSON.stringify(config));
    return { ours, merged: mergeRecord(JSON.parse(last.base), ours, theirs) };
  }
}

/** Errors Windows gives while a sync client, indexer or antivirus briefly holds the file open. */
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** @param {number} ms */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes atomically so an interrupted run never leaves a half-written file.
 * In a OneDrive-synced folder the rename can fail for a moment while the file
 * is being synced, so it's retried. If it still fails, the record is written
 * in place so the run's progress isn't lost. Either way it is read back, so a
 * step is only counted as done once its record is really on disk.
 * For a record from loadConfig, another command may have saved the same file
 * since this one last read or wrote it (access while an install waits on
 * its first load): their changes are merged in, field by field, and the record
 * in memory gets them too.
 * @param {string} file
 * @param {InstallConfig} config
 * @param {{ rename?: (from: string, to: string) => void, wait?: (ms: number) => void, tries?: number, read?: (file: string) => string }} [io]
 */
export function saveConfig(file, config, io = {}) {
  assertNoSecrets(config);
  const { rename = renameSync, wait = pause, tries = 8, read = (/** @type {string} */ f) => readFileSync(f, 'utf8') } = io;
  const last = lastSeen.get(config)?.get(resolve(file));
  const merge = last ? mergeTheirs(file, config, last, wait) : undefined;
  if (merge) assertNoSecrets(merge.merged);
  const text = `${JSON.stringify(merge ? merge.merged : config, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  let renamed = false;
  for (let attempt = 1; ; attempt++) {
    try {
      rename(tmp, file);
      renamed = true;
      break;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
      if (!LOCKED.has(code)) throw err;
      if (attempt >= tries) break;
      wait(Math.min(100 * attempt, 500));
    }
  }
  if (!renamed) {
    writeFileSync(file, text, 'utf8');
    try {
      unlinkSync(tmp);
    } catch {
      // A leftover .tmp is harmless; the next save overwrites it.
    }
  }
  if (read(file) !== text) {
    throw new Error(`The install record ${file} didn't save: it reads back different from what was written. Check the folder isn't read-only or full, then run the installer again.`);
  }
  if (!last) return;
  if (merge) adopt(config, merge.ours, merge.merged);
  remember(config, file, text, text);
}

/**
 * Sets an install record aside so the next install starts fresh. It's renamed beside itself, as
 * `aio-install.<yyyyMMdd-HHmmss>.json`, so nothing in it is lost.
 * A synced folder can hold the file for a moment, so the rename is retried like saveConfig's.
 * @param {string} file
 * @param {Date} [now]
 * @param {{ rename?: (from: string, to: string) => void, wait?: (ms: number) => void, tries?: number }} [io]
 * @returns {string} where the record went
 */
export function archiveConfig(file, now = new Date(), io = {}) {
  const { rename = renameSync, wait = pause, tries = 8 } = io;
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const base = file.replace(/\.json$/i, '');
  let to = `${base}.${stamp}.json`;
  for (let i = 2; existsSync(to); i++) to = `${base}.${stamp}-${i}.json`;
  retryLocked(() => rename(file, to), wait, tries);
  return to;
}

/**
 * Deletes a file, retrying while a sync client, indexer or antivirus holds it.
 * @param {string} file
 * @param {{ unlink?: (file: string) => void, wait?: (ms: number) => void, tries?: number }} [io]
 * @returns {boolean} false if it is still locked; the caller can leave it for the next run
 */
export function removeFile(file, io = {}) {
  const { unlink = unlinkSync, wait = pause, tries = 8 } = io;
  try {
    retryLocked(() => unlink(file), wait, tries);
    return true;
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
    if (code === 'ENOENT') return true;
    if (LOCKED.has(code)) return false;
    throw err;
  }
}

/** @param {() => void} fn @param {(ms: number) => void} wait @param {number} tries */
function retryLocked(fn, wait, tries) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
      if (!LOCKED.has(code) || attempt >= tries) throw err;
      wait(Math.min(100 * attempt, 500));
    }
  }
}

/** @param {unknown} config */
function assertNoSecrets(config) {
  const text = JSON.stringify(config);
  if (/"(secret|secretText|clientSecret|password)"\s*:/i.test(text)) {
    throw new Error('Refusing to keep a secret in the install record.');
  }
}
