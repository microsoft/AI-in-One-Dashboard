// @ts-check
/** How the installer was started, so messages name the command people actually run. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { REPO, TAG_PREFIX } from './update-check.js';

/** Set by AIInOneInstaller.exe, which runs the installer with the Node.js it carries. */
export const EXE_ENV = 'AI_IN_ONE_EXE';
export const EXE_NAME = 'AIInOneInstaller.exe';
/**
 * Set by install.ps1 and the command it leaves behind: `pwsh` on Windows, where they run the same
 * download as the exe, and `cloudshell` in Azure Cloud Shell, where they run the release's source.
 */
export const LAUNCHER_ENV = 'AI_IN_ONE_LAUNCHER';
/** This installer's version. */
const VERSION = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
/**
 * Where an installer release's install.ps1 is. It names the release, as the launchers do, because the
 * repo's latest release needn't be an installer release.
 * @param {string} version
 */
export const scriptUrl = (version) => `https://github.com/${REPO}/releases/download/${TAG_PREFIX}${version}/install.ps1`;
/** The PowerShell one-liner that downloads and starts this installer's release again. */
export const SCRIPT_URL = scriptUrl(VERSION);
export const SCRIPT_COMMAND = `irm ${SCRIPT_URL} | iex`;
/** The command install.ps1 leaves behind, as typed in PowerShell. */
export const SCRIPT_SHIM = '& $env:LOCALAPPDATA\\AIInOne\\aio-install.cmd';
/** The command install.ps1 leaves behind in Azure Cloud Shell, for Bash or PowerShell. */
export const CLOUD_SHELL_SHIM = '~/.ai-in-one/aio-install';
/** `1` makes the installer and install.ps1 treat this shell as Azure Cloud Shell, `0` as not. */
export const CLOUD_SHELL_ENV = 'AI_IN_ONE_CLOUD_SHELL';
/** `1` makes install.ps1 run the installer with the Node.js installed on the PC instead of the zip's. */
export const INSTALLED_NODE_ENV = 'AI_IN_ONE_USE_INSTALLED_NODE';

/**
 * Whether this runs in Azure Cloud Shell, which has no browser, signs in with a code, and ends a
 * session after 20 minutes without input.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function inCloudShell(env = process.env) {
  if (env[CLOUD_SHELL_ENV] === '1') return true;
  if (env[CLOUD_SHELL_ENV] === '0') return false;
  return env[LAUNCHER_ENV] === 'cloudshell' || /^cloud-shell/i.test(env.AZUREPS_HOST_ENVIRONMENT ?? '') || !!env.ACC_CLOUD;
}

/**
 * Whether Cloud Shell keeps files between sessions. It does only with a storage account, which
 * mounts ~/clouddrive; without one (or when policy stops the mount) the session is ephemeral.
 * @param {string} [home]
 */
export const cloudShellKeepsFiles = (home = homedir()) => existsSync(join(home, 'clouddrive'));

/**
 * Said at the end of a run in Cloud Shell without a storage account, where the install record goes
 * when the session ends or times out.
 * @param {string} file  The install record.
 * @param {string} [home]
 */
export function cloudShellRecordMessage(file, home = homedir()) {
  const rel = relative(home, file);
  const path = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
  return `This Cloud Shell has no storage account, so ${basename(file)} goes when the session ends or times out. Download it now: in Cloud Shell's toolbar choose Manage files > Download and enter ${path}. To carry on in a new session, upload it with Manage files > Upload, then run the installer again.`;
}

/**
 * Cloud Shell's Manage files > Upload puts files in the home folder. When the install record isn't
 * where the installer looks but an uploaded one is, move it there, so running the installer again
 * carries on instead of setting up a second copy. Moved rather than copied, so an old upload isn't
 * picked up again after uninstall.
 * @param {string} file  Where the installer looks for the install record.
 * @param {string} [home]
 * @returns {string | undefined}  The uploaded file it moved.
 */
export function adoptUploadedRecord(file, home = homedir()) {
  const uploaded = join(home, basename(file));
  if (existsSync(file) || uploaded === file || !existsSync(uploaded)) return undefined;
  mkdirSync(dirname(file), { recursive: true });
  try {
    renameSync(uploaded, file);
  } catch {
    copyFileSync(uploaded, file);
    unlinkSync(uploaded);
  }
  return uploaded;
}

/**
 * How the installer was started: the downloaded exe, the PowerShell launcher on Windows or in
 * Azure Cloud Shell, or Node.js from a clone.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'exe' | 'pwsh' | 'cloudshell' | 'node'}
 */
export function launcher(env = process.env) {
  if (env[EXE_ENV] === '1') return 'exe';
  if (env[LAUNCHER_ENV] === 'pwsh') return 'pwsh';
  if (env[LAUNCHER_ENV] === 'cloudshell') return 'cloudshell';
  return 'node';
}

/**
 * Whether the installer was started from the downloaded exe.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const fromExe = (env = process.env) => launcher(env) === 'exe';

/**
 * Whether the installer runs from the release download on Windows, with its own Node.js and the
 * app already built: through the exe or the PowerShell launcher.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const bundled = (env = process.env) => ['exe', 'pwsh'].includes(launcher(env));

/**
 * The command to run the installer with, optionally followed by its arguments.
 * @param {string} [args]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function commandLine(args = '', env = process.env) {
  const how = launcher(env);
  const name = how === 'exe' ? EXE_NAME : how === 'pwsh' ? SCRIPT_SHIM : how === 'cloudshell' ? CLOUD_SHELL_SHIM : 'aio-install';
  return args ? `${name} ${args}` : name;
}

/**
 * Where the installer prints its messages and the wizard link.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function installerWindow(env = process.env) {
  const how = launcher(env);
  return how === 'exe' ? 'the installer window' : how === 'pwsh' ? 'the PowerShell window' : how === 'cloudshell' ? 'Cloud Shell' : 'your terminal';
}

/**
 * The PowerShell install command, keeping the runtime selected by the launcher.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [command]  The download command, by default this release's.
 */
const powerShellCommand = (env, command = SCRIPT_COMMAND) =>
  env[INSTALLED_NODE_ENV] === '1' ? `$env:${INSTALLED_NODE_ENV} = '1'; ${command}` : command;

/**
 * How to start the installer again once it has stopped.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function reopenHint(env = process.env) {
  const how = launcher(env);
  if (how === 'exe') return `To open it again, run ${EXE_NAME}.`;
  if (how === 'pwsh') {
    const again = env[INSTALLED_NODE_ENV] === '1' ? `"${powerShellCommand(env)}"` : 'the install command';
    return `To open it again, run ${SCRIPT_SHIM} in PowerShell, or ${again} again.`;
  }
  if (how === 'cloudshell') return `To run it again, run ${CLOUD_SHELL_SHIM} in Cloud Shell.`;
  return 'To open it again, run aio-install --ui in your terminal.';
}

/**
 * How to get a newer installer, after "Installer x.y.z is available." The PowerShell launchers
 * download the newer release's install.ps1, since this release's would start this version again.
 * @param {{ version: string, url: string }} update  The newer release, and its page.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function updateHint(update, env = process.env) {
  const how = launcher(env);
  const command = `irm ${scriptUrl(update.version)} | iex`;
  if (how === 'cloudshell') return `Run "${command}" in Cloud Shell's PowerShell, then install to repair or change.`;
  return how === 'pwsh'
    ? `Close the installer and run "${powerShellCommand(env, command)}" in PowerShell, then choose Repair or change.`
    : `Download it from ${update.url}, then choose Repair or change.`;
}
