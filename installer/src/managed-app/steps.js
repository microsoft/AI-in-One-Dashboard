// @ts-check
/**
 * Each step of putting the AI in One app live, as one CLI command. Every step takes the runner from
 * cli.js and returns what happened, and none of them asks anything: flow.js asks, then calls these.
 * A failed step says who fixes it (errors.js).
 *
 * The app is deployed as it's built: the installer carries app/dist, so the app's folder holds that
 * and ms.config.json, with no package.json and no build command (--build-type none).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOY_TIMEOUT_MS } from './cli.js';
import { explain } from './errors.js';

/** @typedef {import('./cli.js').RunCli} RunCli */
/** @typedef {import('./cli.js').CliResult} CliResult */
/** @typedef {import('./errors.js').Problem} Problem */
/** @typedef {{ ok: false, problem: Problem, result?: CliResult }} Failed */

export const APP_CONFIG = 'ms.config.json';
/** Where the built app sits inside the app's folder. */
export const BUILD_PATH = './dist';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** @param {unknown} value @returns {value is string} */
export const isGuid = (value) => typeof value === 'string' && GUID.test(value);

/** @param {string} text */
export const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * @param {string} step
 * @param {CliResult} result
 * @returns {Failed}
 */
const failed = (step, result) => ({ ok: false, problem: explain(step, result), result });

/**
 * Who's signed in to the CLI. A CLI that's never been signed in exits 3.
 * @param {RunCli} run
 * @returns {Promise<{ ok: true, signedIn: boolean, account?: string, accounts: string[] } | Failed>}
 */
export async function authStatus(run) {
  const result = await run(['auth', 'status']);
  if (!result.ok) return result.exitCode === 3 ? { ok: true, signedIn: false, accounts: [] } : failed('auth', result);
  const data = result.data ?? {};
  const accounts = Array.isArray(data.accounts) ? data.accounts.map((/** @type {any} */ a) => a?.username).filter((/** @type {unknown} */ u) => typeof u === 'string') : [];
  const account = typeof data.activeAccount?.username === 'string' ? data.activeAccount.username : undefined;
  return { ok: true, signedIn: Boolean(data.signedIn && account), ...(account ? { account } : {}), accounts };
}

/**
 * Makes an account the CLI already has the active one.
 * @param {RunCli} run
 * @param {string} account
 * @returns {Promise<{ ok: true } | Failed>}
 */
export async function switchAccount(run, account) {
  const result = await run(['auth', 'switch', '--account', account]);
  return result.ok ? { ok: true } : failed('auth', result);
}

/**
 * Signs in, on screen: a browser opens.
 * @param {RunCli} run
 * @param {{ account?: string }} options
 * @returns {Promise<{ ok: true } | Failed>}
 */
export async function login(run, { account }) {
  const result = await run(['auth', 'login', ...(account ? ['--account', account] : [])], { onScreen: true });
  return result.ok ? { ok: true } : failed('login', result);
}

/**
 * Makes the folder a managed app that deploys the built files in ./dist, in your developer environment
 * unless you name another. The CLI refuses a folder that already has ms.config.json.
 * @param {RunCli} run
 * @param {{ appDir: string, displayName: string, environmentId?: string }} options
 * @returns {Promise<{ ok: true, appId: string, environmentId: string } | Failed>}
 */
export async function createApp(run, { appDir, displayName, environmentId }) {
  const args = [
    'app', 'init', '--repo', 'none', '--display-name', displayName,
    '--build-type', 'none', '--build-path', BUILD_PATH,
    ...(environmentId ? ['--environment-id', environmentId] : []),
  ];
  const result = await run(args, { cwd: appDir });
  if (!result.ok) return failed('init', result);
  const config = readAppConfig(appDir);
  const appId = result.data?.appId ?? config?.appId;
  const environment = result.data?.environmentId ?? config?.environmentId ?? environmentId;
  if (!isGuid(appId) || typeof environment !== 'string' || !environment) {
    return { ok: false, problem: { who: 'you', what: 'The app was made, but its ID wasn\'t saved. Delete it at managedapps.cloud.microsoft, then run it again.' }, result };
  }
  return { ok: true, appId, environmentId: environment };
}

/**
 * Packs ./dist, uploads it and waits for it to go live.
 * @param {RunCli} run
 * @param {{ appDir: string }} options
 * @returns {Promise<{ ok: true, playUrl?: string, warnings: string[] } | Failed>}
 */
export async function deployApp(run, { appDir }) {
  const result = await run(['app', 'deploy'], { cwd: appDir, timeoutMs: DEPLOY_TIMEOUT_MS });
  if (!result.ok) return failed('deploy', result);
  const playUrl = typeof result.data?.appPlayUri === 'string' ? result.data.appPlayUri : undefined;
  return { ok: true, ...(playUrl ? { playUrl } : {}), warnings: textsOf(result.data?.warnings) };
}

/**
 * Lets people and groups open the app. That doesn't give them the data: they also need the files.
 * @param {RunCli} run
 * @param {{ appDir: string, principals: string[] }} options  Emails, or user or group object IDs.
 * @returns {Promise<{ ok: true, partial: boolean, rejected: string[], warnings: string[] } | Failed>}  rejected: the
 *   entries the CLI named as not shared.
 */
export async function shareApp(run, { appDir, principals }) {
  const result = await run(['app', 'share', principals.join(','), '--access', 'play'], { cwd: appDir });
  if (!result.ok) return failed('share', result);
  const list = Array.isArray(result.data?.warnings) ? result.data.warnings : [];
  const warnings = list.map((/** @type {any} */ w) => (w && typeof w === 'object' ? [w.input, w.reason].filter(Boolean).join(': ') : String(w)));
  const rejected = list.map((/** @type {any} */ w) => w?.input).filter((/** @type {unknown} */ input) => typeof input === 'string' && input);
  return { ok: true, partial: Boolean(result.data?.partialFailure), rejected, warnings };
}

/**
 * Which of the object IDs the app isn't shared with yet.
 * @param {RunCli} run
 * @param {{ appDir: string, ids: string[] }} options
 * @returns {Promise<{ ok: true, missing: string[] } | Failed>}
 */
export async function verifyShare(run, { appDir, ids }) {
  const wanted = ids.filter(isGuid);
  if (!wanted.length) return { ok: true, missing: [] };
  const result = await run(['app', 'share', 'list', '--access', 'play'], { cwd: appDir });
  if (!result.ok) return failed('share', result);
  const shared = new Set();
  for (const page of Array.isArray(result.data?.results) ? result.data.results : []) {
    for (const entry of Array.isArray(page?.value) ? page.value : []) {
      if (typeof entry?.principalObjectId === 'string') shared.add(entry.principalObjectId.toLowerCase());
    }
  }
  return { ok: true, missing: wanted.filter((id) => !shared.has(id.toLowerCase())) };
}

/**
 * The app's link, without opening a browser.
 * @param {RunCli} run
 * @param {{ appDir: string }} options
 * @returns {Promise<{ ok: true, url: string } | Failed>}
 */
export async function playUrl(run, { appDir }) {
  const result = await run(['app', 'play', '--no-browser'], { cwd: appDir });
  if (!result.ok || typeof result.data?.url !== 'string') return failed('play', result);
  return { ok: true, url: result.data.url };
}

/**
 * Deletes the app. It doesn't need the app's folder. One that's already gone isn't an error.
 * @param {RunCli} run
 * @param {{ appId: string, environmentId?: string, cwd?: string }} options
 * @returns {Promise<{ ok: true, existed: boolean } | Failed>}
 */
export async function deleteApp(run, { appId, environmentId, cwd }) {
  const result = await run(['app', 'delete', '--force', '--app', appId, ...(environmentId ? ['--environment-id', environmentId] : [])], { cwd });
  if (!result.ok) return result.exitCode === 6 ? { ok: true, existed: false } : failed('delete', result);
  return { ok: true, existed: result.data?.existed !== false };
}

/**
 * The app's ID, environment and name from ms.config.json, when the folder is an app.
 * @param {string} appDir
 * @returns {{ appId: string, environmentId: string, displayName?: string, config: Record<string, any> } | undefined}
 */
export function readAppConfig(appDir) {
  try {
    const config = JSON.parse(stripBom(readFileSync(join(appDir, APP_CONFIG), 'utf8')));
    if (typeof config?.appId !== 'string' || !config.appId || typeof config.environmentId !== 'string') return undefined;
    return {
      appId: config.appId,
      environmentId: config.environmentId,
      ...(typeof config.appDisplayName === 'string' ? { displayName: config.appDisplayName } : {}),
      config,
    };
  } catch {
    return undefined;
  }
}

/** @param {unknown} list */
function textsOf(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === 'string' ? item : typeof item?.message === 'string' ? item.message : JSON.stringify(item)))
    .filter(Boolean);
}
