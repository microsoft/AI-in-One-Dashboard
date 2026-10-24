// @ts-check
/** The names and places the PAX path shares with its scheduled task and its script. */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PAX_APP_NAME = 'AI in One (PAX)';
export const TASK_NAME = 'AI in One - PAX refresh';
/** The folder the files go to, in the SharePoint library or under the local folder's parent. */
export const SP_FOLDER = 'AI in One';
export const FILES = /** @type {const} */ ({
  interactions: 'AIO_Interactions.csv',
  users: 'AIO_Users.csv',
  agent365: 'AIO_Agent365.csv',
});
/** The files the task writes, by the install's choices. @param {{ agent365?: boolean } | undefined} pax */
export const paxFiles = (pax) => [FILES.interactions, FILES.users, ...(pax?.agent365 ? [FILES.agent365] : [])];
export const WRAPPER_FILE = 'Run-AIO-PAX.ps1';
export const SECRET_FILE = 'client-secret.dpapi';
export const DEFAULT_RUN_AT = '02:00';
/** Days each daily run loads. They overlap the last run's, and PAX drops the rows the file already has. */
export const WINDOW_DAYS = 7;
/**
 * Days the first load (the seed) loads with each run of PAX, oldest first. Each run of PAX reads
 * the users from Entra again, so smaller windows cost more; a window that stops at the task's time
 * limit is loaded again in halves.
 */
export const SEED_WINDOW_DAYS = 30;
export const CERT_SUBJECT = `CN=${PAX_APP_NAME}`;
/** How long a new certificate lasts. */
export const CERT_MONTHS = 12;
const HOME_FOLDER = 'AIInOne';
/**
 * The folders under %LOCALAPPDATA%\AIInOne that hold the install rather than a copy of the
 * installer, so the launchers keep them when they remove other versions. Launcher.cs (KeptDirs)
 * and install.ps1 ($Kept) list the same folders.
 */
export const KEPT_DIRS = /** @type {const} */ (['pax', 'pax-run', 'managed-app']);

/**
 * %LOCALAPPDATA%\AIInOne, where the exe unpacks and the PAX path keeps its state.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function stateRoot(env = process.env) {
  const base = env.LOCALAPPDATA;
  if (!base) throw new Error('LOCALAPPDATA is not set. The PAX setup runs on Windows.');
  return join(base, HOME_FOLDER);
}

/** Where a PAX version is kept. @param {string} version @param {NodeJS.ProcessEnv} [env] */
export const paxDir = (version, env) => join(stateRoot(env), KEPT_DIRS[0], version);
/** The scheduled task's script, its local data, logs and the protected secret. @param {NodeJS.ProcessEnv} [env] */
export const runDir = (env) => join(stateRoot(env), KEPT_DIRS[1]);
/** The managed app's settings, such as ms.config.json. @param {NodeJS.ProcessEnv} [env] */
export const managedAppDir = (env) => join(stateRoot(env), KEPT_DIRS[2]);
/** @param {NodeJS.ProcessEnv} [env] */
export const wrapperPath = (env) => join(runDir(env), WRAPPER_FILE);
/** @param {NodeJS.ProcessEnv} [env] */
export const secretPath = (env) => join(runDir(env), SECRET_FILE);
/** @param {NodeJS.ProcessEnv} [env] */
export const lastRunPath = (env) => join(runDir(env), 'logs', 'last-run.json');
/**
 * Left by "run --backfill-days": the task's next run loads the history again, and then deletes it.
 * While the history loads, the script keeps its progress here, so a run that stops carries on.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const seedRequestPath = (env) => join(runDir(env), 'seed.request');
/** The local data the daily runs append to. @param {NodeJS.ProcessEnv} [env] */
export const dataDir = (env) => join(runDir(env), 'data');
/** The default local folder, when the files stay on this PC. */
export const defaultLocalFolder = () => join(homedir(), 'Documents', SP_FOLDER);
