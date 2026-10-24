// @ts-check
/**
 * Writing PowerShell safely, and running it. A value only reaches a script as a single-quoted
 * literal or an environment variable, never as code. Scripts run from a file with -File, under
 * the execution policy as it is: nothing here passes -ExecutionPolicy, and the child doesn't
 * inherit a policy override from this process.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The characters PowerShell takes as a single quote. */
const SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g;
export const RESULT_PREFIX = 'AIO-RESULT ';

/**
 * A single-quoted PowerShell string. Inside one only a quote is special, and doubling it escapes
 * it. PowerShell also ends a string at a typographic single quote, so those are doubled too.
 * @param {string} value
 */
export function psQuote(value) {
  if (typeof value !== 'string') throw new TypeError('psQuote takes a string.');
  if (/[\0\r\n]/.test(value)) throw new Error('A value written into a PowerShell script cannot hold a line break.');
  return `'${value.replace(SINGLE_QUOTES, (q) => q + q)}'`;
}

/**
 * A value as a PowerShell literal: a quoted string, a number, $true, $false, $null or an array.
 * @param {unknown} value
 * @returns {string}
 */
export function psValue(value) {
  if (value === null || value === undefined) return '$null';
  if (typeof value === 'boolean') return value ? '$true' : '$false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('A number written into a PowerShell script must be finite.');
    return String(value);
  }
  if (typeof value === 'string') return psQuote(value);
  if (Array.isArray(value)) return `@(${value.map(psValue).join(', ')})`;
  throw new TypeError(`Can't write a ${typeof value} into a PowerShell script.`);
}

/**
 * An ordered hashtable literal, one key a line.
 * @param {Record<string, unknown>} values
 */
export function psHashtable(values) {
  const lines = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error(`"${key}" can't be a PowerShell setting name.`);
    return `    ${key} = ${psValue(value)}`;
  });
  return `[ordered]@{\n${lines.join('\n')}\n}`;
}

/**
 * A script as Windows PowerShell and pwsh both read it: UTF-8 with a byte order mark, CRLF.
 * @param {string} text
 */
export const scriptText = (text) => `\uFEFF${text.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n')}`;

/**
 * The JSON on the last line that starts with AIO-RESULT, or undefined.
 * @param {string} stdout
 */
export function parseResult(stdout) {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(RESULT_PREFIX));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch {
    return undefined;
  }
}

/**
 * @typedef {object} PwshRun
 * @property {string} [script]  Written to a temporary .ps1 file and run with -File.
 * @property {string} [file]  An existing script, run with -File.
 * @property {string} [command]  Run with -Command. Only for checks that must work whatever the execution policy.
 * @property {string[]} [args]  After the script's path.
 * @property {Record<string, string>} [env]  Extra environment variables, such as a secret.
 * @property {number} [timeoutMs]
 *
 * @typedef {object} PwshResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {any} [result]  The AIO-RESULT line's JSON.
 *
 * @typedef {(run: PwshRun) => Promise<PwshResult>} RunPwsh
 */

const MAX_OUTPUT = 4 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs PowerShell 7 with no profile and no prompts, without a shell in between.
 * @param {{ exe?: string, spawn?: typeof spawn }} [o]  exe: pwsh's full path once it's known.
 * @returns {RunPwsh}
 */
export function createRunPwsh(o = {}) {
  const exe = o.exe ?? 'pwsh';
  const start = o.spawn ?? spawn;
  return async (run) => {
    /** @type {string | undefined} */
    let tmp;
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
    if (run.command !== undefined) {
      args.push('-Command', run.command);
    } else {
      let file = run.file;
      if (run.script !== undefined) {
        tmp = mkdtempSync(join(tmpdir(), 'aio-ps-'));
        file = join(tmp, 'aio.ps1');
        writeFileSync(file, scriptText(run.script));
      }
      if (!file) throw new Error('No PowerShell script to run.');
      args.push('-File', file, ...(run.args ?? []));
    }
    /** @type {Record<string, string | undefined>} */
    const env = { ...process.env, ...(run.env ?? {}) };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psexecutionpolicypreference') delete env[key];
    try {
      return await new Promise((resolve, reject) => {
        const child = start(exe, args, { env, windowsHide: true, shell: false });
        let stdout = '';
        let stderr = '';
        const timeoutMs = run.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`PowerShell took longer than ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.`));
        }, timeoutMs);
        // Whole characters, even when one is split between two chunks.
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (d) => {
          if (stdout.length < MAX_OUTPUT) stdout += d;
        });
        child.stderr?.on('data', (d) => {
          if (stderr.length < MAX_OUTPUT) stderr += d;
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(/** @type {any} */ (err).code === 'ENOENT' ? new Error(`PowerShell 7 isn't installed (${exe} wasn't found).`) : err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, stdout, stderr, result: parseResult(stdout) });
        });
      });
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/**
 * The first error line PowerShell printed, for a message.
 * @param {PwshResult} r
 */
export const firstError = (r) => (r.stderr || r.stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? `exit code ${r.code}`;
