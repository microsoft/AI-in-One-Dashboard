// @ts-check
/**
 * Runs the Copilot managed apps CLI (`ms`) pinned in installer/managed-cli, never a global one, so every
 * install runs the version this code was tested with. It runs as `node <cli>/dist/Bin.js`: no shell and
 * no npx. Off screen it adds --non-interactive --json --no-color and reads the JSON the CLI prints. On
 * screen it hands over the terminal, for a sign-in only the CLI can do.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The small package that pins the CLI, with its own lock file. The exe carries it installed. */
export const CLI_PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'managed-cli');
export const CLI_PACKAGE = '@microsoft/managed-apps-cli';

/** The oldest Node.js the pinned CLI runs on: its package.json's engines. A test keeps them in step. */
export const MIN_NODE = '24.11.0';

/** Most commands take seconds. A sign-in on screen waits for a person. */
export const COMMAND_TIMEOUT_MS = 5 * 60_000;
/** A deploy packs the app, then uploads it and waits for it to go live. */
export const DEPLOY_TIMEOUT_MS = 30 * 60_000;

/** How much of each stream is kept: the end, where the JSON and the errors are. */
const OUTPUT_CAP = 1_000_000;

/** @param {string} [dir] */
export const cliBin = (dir = CLI_PACKAGE_DIR) => join(dir, 'node_modules', '@microsoft', 'managed-apps-cli', 'dist', 'Bin.js');

/**
 * The CLI version the package pins.
 * @param {string} [dir]
 * @returns {string}
 */
export function pinnedVersion(dir = CLI_PACKAGE_DIR) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies[CLI_PACKAGE];
}

/**
 * The CLI version installed there, or undefined.
 * @param {string} [dir]
 * @returns {string | undefined}
 */
export function installedVersion(dir = CLI_PACKAGE_DIR) {
  try {
    return JSON.parse(readFileSync(join(dir, 'node_modules', '@microsoft', 'managed-apps-cli', 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

/**
 * Whether this Node.js is new enough for the CLI.
 * @param {string} version  Such as v24.11.0.
 * @param {string} [min]
 */
export function nodeOk(version, min = MIN_NODE) {
  const parts = (/** @type {string} */ v) => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const have = parts(version);
  const need = parts(min);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0);
  }
  return true;
}

/**
 * @typedef {object} CliResult
 * @property {boolean} ok  It exited 0, and its JSON didn't say success: false.
 * @property {number | null} exitCode  3 is sign-in, 5 is network, 6 is not found.
 * @property {Record<string, any> | undefined} data  The JSON it printed.
 * @property {string} [error]  What went wrong, in the CLI's words when it said.
 * @property {any} [errorData]  The CLI's details, such as the server's message.
 * @property {string} stdout
 * @property {string} stderr  Warnings, and progress.
 * @property {boolean} [timedOut]
 */

/**
 * @typedef {object} RunOptions
 * @property {string} [cwd]
 * @property {boolean} [onScreen]  Give the CLI the terminal, without the JSON flags.
 * @property {number} [timeoutMs]
 */

/** @typedef {(args: string[], options?: RunOptions) => Promise<CliResult>} RunCli */

/**
 * @param {object} [options]
 * @param {string} [options.cliDir]
 * @param {NodeJS.ProcessEnv} [options.env]  Added to this process's.
 * @param {typeof nodeSpawn} [options.spawn]
 * @param {string} [options.node]  The Node.js that runs the CLI.
 * @param {number} [options.timeoutMs]
 * @returns {{ run: RunCli, bin: string }}
 */
export function createCli({ cliDir = CLI_PACKAGE_DIR, env = {}, spawn = nodeSpawn, node = process.execPath, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const bin = cliBin(cliDir);
  /** @type {RunCli} */
  const run = (args, { cwd, onScreen = false, timeoutMs: limit = timeoutMs } = {}) => new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @param {CliResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };

    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(node, onScreen ? [bin, ...args] : [bin, ...args, '--non-interactive', '--json', '--no-color'], {
        cwd,
        env: { ...process.env, ...env },
        stdio: onScreen ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        windowsHide: !onScreen,
      });
    } catch (err) {
      finish({ ok: false, exitCode: null, data: undefined, error: `Couldn't start the managed apps CLI: ${/** @type {Error} */ (err).message}`, stdout, stderr });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout = keepEnd(stdout + chunk); });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr = keepEnd(stderr + chunk); });
    if (limit > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, limit);
    }
    child.on('error', (err) => finish({ ok: false, exitCode: null, data: undefined, error: `Couldn't start the managed apps CLI: ${err.message}`, stdout, stderr }));
    child.on('close', (code) => {
      if (timedOut) {
        finish({ ok: false, exitCode: code, data: undefined, error: `It didn't finish within ${Math.round(limit / 60_000)} minutes, so it was stopped.`, stdout, stderr, timedOut: true });
        return;
      }
      const data = onScreen ? undefined : parseJson(stdout) ?? parseJson(stderr);
      const ok = code === 0 && data?.success !== false;
      finish({
        ok,
        exitCode: code,
        data,
        ...(ok ? {} : { error: errorText(data, stderr, code) }),
        ...(data?.errorData !== undefined ? { errorData: data.errorData } : {}),
        stdout,
        stderr,
      });
    });
  });
  return { run, bin };
}

/**
 * The JSON object the CLI printed, or undefined. It prints one, pretty or on one line, sometimes after
 * other output, so this tries the whole text, then each line that starts with `{`, last first.
 * @param {string | undefined} text
 * @returns {Record<string, any> | undefined}
 */
export function parseJson(text) {
  const trimmed = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!trimmed) return undefined;
  const whole = asObject(trimmed);
  if (whole) return whole;
  /** @type {number[]} */
  const starts = [];
  for (let at = trimmed.indexOf('{'); at >= 0; at = trimmed.indexOf('{', at + 1)) {
    if (at === 0 || trimmed[at - 1] === '\n') starts.push(at);
  }
  for (const start of starts.reverse()) {
    const rest = trimmed.slice(start);
    const end = rest.indexOf('\n}');
    for (const candidate of [end >= 0 ? rest.slice(0, end + 2) : '', rest.split('\n', 1)[0], rest]) {
      const parsed = candidate && asObject(candidate.trim());
      if (parsed) return parsed;
    }
  }
  return undefined;
}

/** @param {string} text */
function asObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {Record<string, any> | undefined} data
 * @param {string} stderr
 * @param {number | null} code
 */
function errorText(data, stderr, code) {
  if (typeof data?.errorMessage === 'string' && data.errorMessage.trim()) return data.errorMessage.trim();
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length) return lines.slice(-5).join('\n');
  return code === null ? 'The CLI stopped.' : `The CLI stopped with exit code ${code}.`;
}

/** @param {string} text */
const keepEnd = (text) => (text.length > OUTPUT_CAP ? text.slice(-OUTPUT_CAP) : text);
