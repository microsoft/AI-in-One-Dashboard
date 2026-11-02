// @ts-check
// Unit tests for the PAX route's generated PowerShell, the scheduled task's wrapper script and the
// scheduled task itself. Nothing here runs PowerShell scripts, PAX or Task Scheduler: PowerShell is
// only asked to parse text (Parser::ParseInput) or read an XML file, and everything else is faked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';

import { emptyConfig, emptyPax } from '../src/config.js';
import { commandLine } from '../src/launch.js';
import { loadRelease } from '../src/pax/release.js';
import { createRunPwsh, DEFAULT_TIMEOUT_MS, firstError, parseResult, psHashtable, psQuote, psValue, RESULT_PREFIX, scriptText } from '../src/pax/ps.js';
import * as S from '../src/pax/scripts.js';
import { describeLogon, describeRun, ensureTask, logonOf, noPasswordWarning, POLL_MS, readLastRun, readMetrics, removeTask, signedOutSteps, startRun, taskMatches, taskSpec, waitForRun } from '../src/pax/task.js';
import { INSTALLER_VERSION, loadTemplate, nextRun, renderWrapper, taskArguments, taskXml, TEMPLATE_FILE, wrapperSettings, writeTaskXml, writeWrapper } from '../src/pax/wrapper.js';
import * as N from '../src/pax/names.js';
import { fakeCtx, fakeUi } from './fakes.js';

/** @typedef {import('../src/pax/ps.js').PwshRun} PwshRun */
/** @typedef {import('../src/pax/ps.js').PwshResult} PwshResult */
/** @typedef {import('../src/pax/ps.js').RunPwsh} RunPwsh */
/** @typedef {import('node:test').TestContext} TestContext */
/** @typedef {import('../src/pax/scripts.js').TaskInfo} TaskInfo */

const PAX = loadRelease();
const TENANT = '00000000-0000-0000-0000-000000000001';
const APP_ID = '00000000-0000-0000-0000-000000000002';
const DRIVE = 'b!00000000-0000-0000-0000-000000000003';
const THUMB = 'A1'.repeat(20);
const SID = 'S-1-5-21-1000000000-1000000000-1000000000-1001';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' };
const SECRET = 'not-a-real-secret';
const SECRET_PATH = 'C:\\Users\\ana\\AppData\\Local\\AIInOne\\pax-run\\client-secret.dpapi';
const ANSI = /\u001b\[[0-9;]*m/g;
const TEMPLATE = loadTemplate(TEMPLATE_FILE);
/** The template with Windows or Unix line endings, as LF text. */
const TPL = TEMPLATE.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
/** Every character PowerShell reads as a single-quote string delimiter. */
const QUOTES = "'\u2018\u2019\u201A\u201B";
const ODD_XML = "C:\\Users\\O'Brien\\AppData\\Local\\AIInOne\\pax-run\\task [1] $(x) `y \u2018z\u2019 é 日本.xml";
/** Values that would run a command if they were written into a script without proper quoting. */
const HOSTILE = [
  "x'; Remove-Item C:\\nope; '",
  'x$(Remove-Item C:\\nope)y',
  "a`$(Remove-Item C:\\nope)`' b`\"c``",
  'say "$(Remove-Item C:\\nope)" now',
  '\u2018; Remove-Item C:\\nope; \u2019 \u201A; Remove-Item C:\\nope; \u201B',
  '\u201C$(Remove-Item C:\\nope)\u201D',
  "it's O\u2019Brien's \u2018quoted\u2019 folder",
  'Ångström 日本語 ü é — & | ; < > @{a=1} ${env:PATH} %TEMP%',
];

/** @param {TestContext} t */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-pax-scripts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** @param {string} dir */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => statSync(join(dir, f)).isFile()).sort();
}

/**
 * An install record that has finished the PAX setup.
 * @param {Record<string, unknown>} [over] fields to change in the pax record
 * @param {Record<string, string | undefined>} [env]
 * @returns {any}
 */
function paxConfig(over = {}, env = WIN_ENV) {
  const config = /** @type {any} */ (emptyConfig());
  config.tenantId = TENANT;
  config.app = { ...config.app, appId: APP_ID };
  config.pax = {
    ...emptyPax(),
    site: { url: 'https://contoso.sharepoint.com/sites/AIinOne', host: 'contoso.sharepoint.com', path: '/sites/AIinOne', library: 'Documents', folder: N.SP_FOLDER, driveId: DRIVE },
    certificateThumbprint: THUMB,
    version: PAX.version,
    script: join(N.paxDir(PAX.version, env), PAX.file),
    sha256: PAX.sha256,
    pythonDir: 'C:\\Python313',
    pwsh: PWSH,
    userSid: SID,
    userName: 'CONTOSO\\ana',
    ...over,
  };
  return config;
}

/** What a script prints when it works: some chatter, then its result line. */
function printed(/** @type {unknown} */ value, code = 0) {
  const stdout = `WARNING: something chatty\r\n${RESULT_PREFIX}${JSON.stringify(value)}\r\n`;
  return /** @type {PwshResult} */ ({ code, stdout, stderr: '', result: parseResult(stdout) });
}

/** What a script gives when it fails before its result line. */
function failed(/** @type {string} */ stderr, code = 1) {
  return /** @type {PwshResult} */ ({ code, stdout: '', stderr, result: undefined });
}

/** @param {(run: PwshRun, n: number) => PwshResult | Promise<PwshResult>} answer */
function recorder(answer) {
  /** @type {PwshRun[]} */
  const runs = [];
  /** @type {RunPwsh} */
  const runPwsh = async (run) => {
    runs.push(run);
    return answer(run, runs.length - 1);
  };
  return { runPwsh, runs };
}

/** Reads a single-quoted PowerShell string the way PowerShell's tokenizer does. */
function unquote(/** @type {string} */ q) {
  assert.ok(q.length >= 2 && QUOTES.includes(q[0]) && QUOTES.includes(q[q.length - 1]), `not a single-quoted string: ${q}`);
  let out = '';
  for (let i = 1; i < q.length - 1; i++) {
    if (QUOTES.includes(q[i])) {
      assert.ok(i + 1 < q.length - 1 && QUOTES.includes(q[i + 1]), `the string ends early at ${i}: ${q}`);
      out += q[i + 1];
      i++;
    } else out += q[i];
  }
  return out;
}

/** @typedef {{ exe: string, args: string[], options: any, child: any, file: string | undefined, bytes: Buffer | undefined }} SpawnCall */

/**
 * A child_process.spawn stand-in that records each call and lets the test play the child's output.
 * @param {(call: SpawnCall) => unknown} play
 */
function fakeSpawn(play) {
  /** @type {SpawnCall[]} */
  const calls = [];
  /** @type {any} */
  const spawn = (/** @type {string} */ exe, /** @type {string[]} */ args, /** @type {any} */ options) => {
    /** @type {any} */
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
      return true;
    };
    const i = args.indexOf('-File');
    const file = i >= 0 ? args[i + 1] : undefined;
    const call = { exe, args, options, child, file, bytes: file && existsSync(file) ? readFileSync(file) : undefined };
    calls.push(call);
    setImmediate(() => {
      Promise.resolve()
        .then(() => play(call))
        .catch((e) => child.emit('error', e));
    });
    return child;
  };
  return { spawn, calls };
}

/**
 * Writes the child's output in chunks, then closes it.
 * @param {any} child
 * @param {{ stdout?: string | Buffer | (string | Buffer)[], stderr?: string | Buffer | (string | Buffer)[], code?: number | null }} [o]
 */
async function finish(child, o = {}) {
  for (const [stream, data] of /** @type {[PassThrough, any][]} */ ([[child.stdout, o.stdout], [child.stderr, o.stderr]])) {
    for (const chunk of [data ?? []].flat()) {
      stream.write(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    stream.end();
  }
  await Promise.all([finished(child.stdout), finished(child.stderr)]);
  child.emit('close', o.code === undefined ? 0 : o.code);
}

// ---- Parsing (never running) PowerShell -------------------------------------------------------
// The scripts go to PowerShell base64-encoded on stdin, one per line, and come back as one line per
// finding: "<n> <kind> <fields>", text fields base64-encoded. The command has no double quotes, so
// Windows command-line quoting can't change it.

const L = 'System.Management.Automation.Language';
const PARSE = [
  'function Emit([string]$s) { [Console]::Out.WriteLine($s) }',
  "function Enc($v) { if ($null -eq $v) { return '' }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v)) }",
  "function Digest([string]$s) { $h = [Security.Cryptography.SHA256]::Create(); -join @($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString('x2') }) }",
  `function ParseOne([string]$b, [int]$n) { $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)); $tokens = $null; $errs = $null; ` +
    `$a = [${L}.Parser]::ParseInput($text, [ref]$tokens, [ref]$errs); ` +
    `foreach ($e in @($errs)) { Emit ('' + $n + ' E ' + (Enc ('' + $e.Extent.StartLineNumber + ': ' + $e.Message))) }; ` +
    `$all = @($a.FindAll({ $true }, $true)); Emit ('' + $n + ' T ' + (Digest (@($all | ForEach-Object { $_.GetType().Name }) -join ','))); ` +
    `$rv = '-'; if ($a.ScriptRequirements -and $a.ScriptRequirements.RequiredPSVersion) { $rv = [string]$a.ScriptRequirements.RequiredPSVersion }; Emit ('' + $n + ' R ' + $rv); ` +
    `$pn = ''; if ($a.ParamBlock) { $pn = @($a.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) -join ',' }; Emit ('' + $n + ' P ' + (Enc $pn)); ` +
    `foreach ($c in @($all | Where-Object { $_ -is [${L}.CommandAst] })) { $g = @(); $loop = 0; $fn = ''; $k = $c; $u = $c.Parent; ` +
    `while ($u) { if ($u -is [${L}.IfStatementAst]) { $hit = $false; foreach ($cl in $u.Clauses) { if ([object]::ReferenceEquals($cl.Item2, $k)) { $g += $cl.Item1.Extent.Text; $hit = $true } }; ` +
    `if (-not $hit -and [object]::ReferenceEquals($u.ElseClause, $k)) { $g += ('-not ' + $u.Clauses[0].Item1.Extent.Text) } }; ` +
    `if ($u -is [${L}.LoopStatementAst]) { $loop = 1 }; if ($u -is [${L}.FunctionDefinitionAst] -and -not $fn) { $fn = $u.Name }; $k = $u; $u = $u.Parent }; ` +
    `Emit ('' + $n + ' C ' + (Enc ($c.GetCommandName())) + ' ' + (Enc $fn) + ' ' + (Enc ($g -join [char]31)) + ' ' + $loop + ' ' + $c.Extent.StartOffset + ' ' + (Enc $c.Extent.Text)) }; ` +
    `foreach ($q in @($all | Where-Object { $_ -is [${L}.StringConstantExpressionAst] })) { Emit ('' + $n + ' S ' + $q.StringConstantType + ' ' + (Enc $q.Value)) }; ` +
    `foreach ($q in @($all | Where-Object { $_ -is [${L}.ExpandableStringExpressionAst] })) { Emit ('' + $n + ' X ' + (Enc $q.Value)) }; ` +
    `$sa = $a.Find({ param($q) $q -is [${L}.AssignmentStatementAst] -and [string]$q.Left -eq '$Settings' }, $true); ` +
    `if ($sa) { $ht = $sa.Find({ param($q) $q -is [${L}.HashtableAst] }, $true); foreach ($kv in $ht.KeyValuePairs) { $v1 = $kv.Item2.GetPureExpression(); ` +
    `$qt = '-'; if ($v1 -is [${L}.StringConstantExpressionAst]) { $qt = [string]$v1.StringConstantType }; $val = '?'; try { $val = [string]$v1.SafeGetValue() } catch { $val = '?' }; ` +
    `Emit ('' + $n + ' V ' + (Enc $kv.Item1.Value) + ' ' + $v1.GetType().Name + ' ' + $qt + ' ' + (Enc $val)) } } }`,
  '$n = 0',
  "foreach ($b in @([Console]::In.ReadToEnd() -split '\\s+' | Where-Object { $_ })) { try { ParseOne $b $n } catch { Emit ('' + $n + ' Z ' + (Enc $_.Exception.Message)) }; $n++ }",
].join('; ');

/** @type {string[] | undefined} */
let shells;
/** Windows PowerShell 5.1 (on Windows) and PowerShell 7, whichever this machine has. */
function powerShells() {
  if (shells) return shells;
  shells = [];
  if (process.platform === 'win32') {
    const winPs = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(winPs)) shells.push(winPs);
  }
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '1'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status === 0) shells.push('pwsh');
  return shells;
}
const pwshShell = () => powerShells().find((s) => s === 'pwsh');

/**
 * @typedef {{ name: string, fn: string, guards: string[], loop: boolean, offset: number, text: string }} Cmd
 * @typedef {{ errors: string[], hash: string, requires: string, params: string[], commands: Cmd[], strings: { type: string, value: string }[], expandable: string[], settings: { key: string, type: string, quote: string, value: string }[], fatal: string[] }} Shape
 */
const unb64 = (/** @type {string | undefined} */ s) => Buffer.from(s ?? '', 'base64').toString('utf8');
/** @type {Map<string, Shape>} */
const shapeCache = new Map();

/** Parses each text in one PowerShell process and returns what its syntax tree holds. */
function parseAll(/** @type {string} */ exe, /** @type {string[]} */ texts) {
  const missing = [...new Set(texts)].filter((x) => !shapeCache.has(`${exe}\0${x}`));
  if (missing.length) {
    const input = missing.map((x) => Buffer.from(x.replace(/^\uFEFF/, ''), 'utf8').toString('base64')).join('\n') + '\n';
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', PARSE], { input, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `${exe} couldn't run the parser: ${r.error?.message ?? ''} ${r.stderr}`);
    /** @type {Shape[]} */
    const shapes = missing.map(() => ({ errors: [], hash: '', requires: '', params: [], commands: [], strings: [], expandable: [], settings: [], fatal: [] }));
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [n, kind, ...f] = line.split(' ');
      const s = shapes[Number(n)];
      assert.ok(s, `odd parser output: ${line}`);
      if (kind === 'E') s.errors.push(unb64(f[0]));
      else if (kind === 'T') s.hash = f[0];
      else if (kind === 'R') s.requires = f[0];
      else if (kind === 'P') s.params = unb64(f[0]).split(',').filter(Boolean);
      else if (kind === 'C') s.commands.push({ name: unb64(f[0]), fn: unb64(f[1]), guards: unb64(f[2]).split('\x1f').filter(Boolean), loop: f[3] === '1', offset: Number(f[4]), text: unb64(f[5]) });
      else if (kind === 'S') s.strings.push({ type: f[0], value: unb64(f[1]) });
      else if (kind === 'X') s.expandable.push(unb64(f[0]));
      else if (kind === 'V') s.settings.push({ key: unb64(f[0]), type: f[1], quote: f[2], value: unb64(f[3]) });
      else if (kind === 'Z') s.fatal.push(unb64(f[0]));
      else assert.fail(`odd parser output: ${line}`);
    }
    missing.forEach((x, i) => {
      assert.deepEqual(shapes[i].fatal, [], `${exe} couldn't parse a script`);
      assert.ok(shapes[i].hash, `${exe} gave no syntax tree for a script`);
      shapeCache.set(`${exe}\0${x}`, shapes[i]);
    });
  }
  return texts.map((x) => /** @type {Shape} */ (shapeCache.get(`${exe}\0${x}`)));
}

/** Parses the texts in every PowerShell this machine has (or only PowerShell 7); skips without one. */
function parseEach(/** @type {TestContext} */ t, /** @type {string[]} */ texts, pwshOnly = false) {
  const pwsh = pwshShell();
  const exes = pwshOnly ? (pwsh ? [pwsh] : []) : powerShells();
  if (!exes.length) t.skip('needs PowerShell');
  return exes.map((exe) => ({ exe, shapes: parseAll(exe, texts) }));
}

const commandNames = (/** @type {Shape} */ s) => [...new Set(s.commands.map((c) => c.name))].sort();

// ---- ps.js ------------------------------------------------------------------------------------

test('psQuote: single-quotes a value and doubles every character PowerShell reads as a single quote', () => {
  assert.equal(psQuote(''), "''");
  assert.equal(psQuote('plain'), "'plain'");
  assert.equal(psQuote("O'Brien"), "'O''Brien'");
  assert.equal(psQuote('\u2018a\u2019 \u201Ab\u201B'), "'\u2018\u2018a\u2019\u2019 \u201A\u201Ab\u201B\u201B'");
  assert.equal(psQuote('$(x) `y "z" \u201Cw\u201D'), "'$(x) `y \"z\" \u201Cw\u201D'");
});

test('psQuote: every hostile value reads back unchanged, as one string', () => {
  for (const value of [...HOSTILE, ODD_XML, "'", "''", '\u2019', 'a\u201B']) assert.equal(unquote(psQuote(value)), value);
});

test('psQuote: refuses a value that is not a string or holds a line break', () => {
  assert.throws(() => psQuote(/** @type {any} */ (5)), { name: 'TypeError', message: 'psQuote takes a string.' });
  assert.throws(() => psQuote(/** @type {any} */ (undefined)), { name: 'TypeError' });
  for (const value of ['a\nb', 'a\rb', 'a\r\nb', 'a\0b', "x'\nRemove-Item C:\\nope\n'"]) {
    assert.throws(() => psQuote(value), { message: 'A value written into a PowerShell script cannot hold a line break.' });
  }
});

test('psValue: writes each kind of value as a PowerShell constant', () => {
  assert.equal(psValue(null), '$null');
  assert.equal(psValue(undefined), '$null');
  assert.equal(psValue(true), '$true');
  assert.equal(psValue(false), '$false');
  assert.equal(psValue(30), '30');
  assert.equal(psValue(-1.5), '-1.5');
  assert.equal(psValue("it's"), "'it''s'");
  assert.equal(psValue(['a', 1, true, null]), "@('a', 1, $true, $null)");
  for (const n of [NaN, Infinity, -Infinity]) assert.throws(() => psValue(n), { message: 'A number written into a PowerShell script must be finite.' });
  assert.throws(() => psValue({ a: 1 }), { name: 'TypeError', message: "Can't write a object into a PowerShell script." });
  assert.throws(() => psValue(() => 1), { name: 'TypeError', message: "Can't write a function into a PowerShell script." });
  assert.throws(() => psValue(['ok', 'a\nb']), /line break/);
});

test('psHashtable: writes an ordered hashtable, one setting a line, and refuses unsafe names', () => {
  assert.equal(
    psHashtable({ Name: "O'Brien", Days: 7, On: true, Off: false, None: null }),
    "[ordered]@{\n    Name = 'O''Brien'\n    Days = 7\n    On = $true\n    Off = $false\n    None = $null\n}",
  );
  assert.equal(psHashtable({}), '[ordered]@{\n\n}');
  for (const key of ['1A', 'a-b', 'a b', '', '$x', 'a;b', "a'", 'x = 1; Remove-Item C:\\nope; $y']) {
    assert.throws(() => psHashtable({ [key]: 'v' }), { message: `"${key}" can't be a PowerShell setting name.` });
  }
  assert.throws(() => psHashtable({ Ok: 'a\nb' }), /line break/);
});

test('scriptText: gives exactly one BOM and CRLF line endings', () => {
  assert.equal(scriptText('a\nb\r\nc'), '\uFEFFa\r\nb\r\nc');
  assert.equal(scriptText('\uFEFFa\r\n'), '\uFEFFa\r\n');
  assert.equal(scriptText(''), '\uFEFF');
  assert.equal(scriptText(scriptText('x\ny')), '\uFEFFx\r\ny');
});

test('parseResult: reads the last AIO-RESULT line and nothing else', () => {
  assert.equal(RESULT_PREFIX, 'AIO-RESULT ');
  assert.deepEqual(parseResult('WARNING: x\r\nAIO-RESULT {"a":1}\r\nmore chatter\r\n'), { a: 1 });
  assert.deepEqual(parseResult('AIO-RESULT {"a":1}\nAIO-RESULT {"a":2}\n'), { a: 2 });
  assert.deepEqual(parseResult('AIO-RESULT "Zo\u00EB"\r\n'), 'Zo\u00EB');
  assert.equal(parseResult('AIO-RESULT null\n'), null);
  assert.equal(parseResult('nothing to see\n'), undefined);
  assert.equal(parseResult(''), undefined);
  assert.equal(parseResult('AIO-RESULT {not json\n'), undefined);
  assert.equal(parseResult('AIO-RESULT {"a":1}\nAIO-RESULT {cut short\n'), undefined);
});

test('firstError: picks the first line of stderr, else of stdout, else the exit code', () => {
  const r = (/** @type {number} */ code, /** @type {string} */ stdout, /** @type {string} */ stderr) => /** @type {PwshResult} */ ({ code, stdout, stderr, result: undefined });
  assert.equal(firstError(r(1, 'out\n', '\r\n  Access is denied.  \r\nAt line:3\r\n')), 'Access is denied.');
  assert.equal(firstError(r(1, '\n\n  first out \nsecond\n', '')), 'first out');
  assert.equal(firstError(r(7, '', '')), 'exit code 7');
});

test('createRunPwsh: runs a script from a temporary file with -NoProfile -NonInteractive and no execution-policy switch', async () => {
  const stdout = `hello\r\n${RESULT_PREFIX}{"ok":true}\r\n`;
  const { spawn, calls } = fakeSpawn((c) => finish(c.child, { stdout, stderr: 'careful\r\n' }));
  const script = "$x = '\u00E9'\nWrite-Output $x";
  const r = await createRunPwsh({ spawn })({ script, args: ['-Seed', 'two words'] });
  assert.deepEqual(r, { code: 0, stdout, stderr: 'careful\r\n', result: { ok: true } });
  assert.equal(calls.length, 1);
  const [c] = calls;
  const file = String(c.file);
  assert.equal(c.exe, 'pwsh');
  assert.deepEqual(c.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file, '-Seed', 'two words']);
  assert.match(relative(tmpdir(), file), /^aio-ps-[^\\/]+[\\/]aio\.ps1$/);
  assert.equal(c.bytes?.toString('utf8'), scriptText(script), 'the file holds the script with a BOM and CRLF');
  assert.ok(!existsSync(dirname(file)), 'the temporary folder is removed');
  assert.equal(c.options.windowsHide, true);
  assert.equal(c.options.shell, false);
  assert.ok(!c.args.some((a) => /ExecutionPolicy|Bypass/i.test(a)));
});

test('createRunPwsh: passes extra environment variables, drops PSExecutionPolicyPreference and keeps the secret off the command line', async () => {
  const { spawn, calls } = fakeSpawn((c) => finish(c.child));
  await createRunPwsh({ spawn })({ script: 'Write-Output 1', env: { AIO_SECRET: SECRET, PSExecutionPolicyPreference: 'Unrestricted', psexecutionpolicypreference: 'Unrestricted' } });
  const env = calls[0].options.env;
  assert.equal(env.AIO_SECRET, SECRET);
  assert.deepEqual(Object.keys(env).filter((k) => k.toLowerCase() === 'psexecutionpolicypreference'), []);
  const kept = Object.keys(process.env).find((k) => k.toLowerCase() !== 'psexecutionpolicypreference' && k !== 'AIO_SECRET');
  if (kept) assert.equal(env[kept], process.env[kept], 'the rest of the environment is passed on');
  assert.ok(!calls[0].args.join(' ').includes(SECRET));
  assert.ok(!calls[0].bytes?.toString('utf8').includes(SECRET));
});

test('createRunPwsh: runs a -Command (which wins over a script) or a -File, and refuses a run with nothing to run', async () => {
  const { spawn, calls } = fakeSpawn((c) => finish(c.child, { stdout: 'x\n' }));
  const run = createRunPwsh({ exe: 'C:\\PS 7\\pwsh.exe', spawn });
  await run({ command: 'Get-Date' });
  await run({ command: '1', script: 'Remove-Item C:\\nope' });
  await run({ file: 'C:\\Users\\ana\\Run-AIO-PAX.ps1', args: ['-CheckAccess'] });
  const base = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  assert.deepEqual(
    calls.map((c) => [c.exe, c.args]),
    [
      ['C:\\PS 7\\pwsh.exe', [...base, '-Command', 'Get-Date']],
      ['C:\\PS 7\\pwsh.exe', [...base, '-Command', '1']],
      ['C:\\PS 7\\pwsh.exe', [...base, '-File', 'C:\\Users\\ana\\Run-AIO-PAX.ps1', '-CheckAccess']],
    ],
  );
  await assert.rejects(async () => run({}), { message: 'No PowerShell script to run.' });
  assert.equal(calls.length, 3, 'nothing was started');
});

test('createRunPwsh: explains a missing PowerShell 7, passes other spawn errors on and cleans up either way', async () => {
  const enoent = fakeSpawn((c) => c.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
  await assert.rejects(createRunPwsh({ exe: 'C:\\nope\\pwsh.exe', spawn: enoent.spawn })({ script: '1' }), { message: "PowerShell 7 isn't installed (C:\\nope\\pwsh.exe wasn't found)." });
  assert.ok(!existsSync(dirname(String(enoent.calls[0].file))), 'the temporary folder is removed');
  const eacces = fakeSpawn((c) => c.child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
  await assert.rejects(createRunPwsh({ spawn: eacces.spawn })({ command: '1' }), { message: 'spawn EACCES' });
  const killed = fakeSpawn((c) => finish(c.child, { stdout: 'partial', code: null }));
  assert.deepEqual(await createRunPwsh({ spawn: killed.spawn })({ command: '1' }), { code: 1, stdout: 'partial', stderr: '', result: undefined });
});

test('createRunPwsh: stops PowerShell when it runs past its time limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, calls } = fakeSpawn(() => undefined);
  const run = createRunPwsh({ spawn });
  const tick = async (/** @type {number} */ ms) => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(ms);
  };
  assert.equal(DEFAULT_TIMEOUT_MS, 300000);
  const first = assert.rejects(run({ command: '1' }), { message: 'PowerShell took longer than 300 seconds, so it was stopped.' });
  await tick(DEFAULT_TIMEOUT_MS - 1);
  assert.equal(calls[0].child.killed, false);
  await tick(1);
  assert.equal(calls[0].child.killed, true);
  await first;
  const second = assert.rejects(run({ script: 'Start-Sleep 9', timeoutMs: 1500 }), { message: 'PowerShell took longer than 2 seconds, so it was stopped.' });
  await tick(1500);
  await second;
  assert.equal(calls[1].child.killed, true);
  assert.ok(!existsSync(dirname(String(calls[1].file))), 'the temporary folder is removed');
});

test('createRunPwsh: keeps at most about 4 MiB of output', async () => {
  const mib = 'a'.repeat(1 << 20);
  const { spawn } = fakeSpawn((c) => finish(c.child, { stdout: Array(6).fill(mib), stderr: Array(6).fill(mib) }));
  const r = await createRunPwsh({ spawn })({ command: '1' });
  for (const s of [r.stdout, r.stderr]) assert.ok(s.length >= 4 << 20 && s.length < 5 << 20, `kept ${s.length} characters`);
});

// A UTF-8 character split across two chunks must not turn into U+FFFD (a non-ASCII user name would
// then never match the task's account).
test('createRunPwsh: keeps UTF-8 text whole when a character is split across output chunks', async () => {
  const out = Buffer.from(`${RESULT_PREFIX}${JSON.stringify({ user: 'CONTOSO\\Zo\u00EB', dir: 'C:\\日本' })}\r\n`);
  const a = out.indexOf(0xc3) + 1;
  const b = out.indexOf(0xe6) + 1;
  const err = Buffer.from('\u00C9chec\r\n');
  const { spawn } = fakeSpawn((c) => finish(c.child, { stdout: [out.subarray(0, a), out.subarray(a, b), out.subarray(b)], stderr: [err.subarray(0, 1), err.subarray(1)] }));
  const r = await createRunPwsh({ spawn })({ command: '1' });
  assert.ok(!r.stdout.includes('\uFFFD'), `garbled: ${r.stdout}`);
  assert.equal(r.stdout, out.toString('utf8'));
  assert.deepEqual(r.result, { user: 'CONTOSO\\Zo\u00EB', dir: 'C:\\日本' });
  assert.equal(r.stderr, '\u00C9chec\r\n');
});

// ---- scripts.js -------------------------------------------------------------------------------

/** @type {[string, string][]} */
const SCRIPTS = [
  ['PROBE', S.PROBE],
  ['registerTaskScript', S.registerTaskScript(ODD_XML)],
  ['START_TASK_SCRIPT', S.START_TASK_SCRIPT],
  ['TASK_INFO_SCRIPT', S.TASK_INFO_SCRIPT],
  ['UNREGISTER_TASK_SCRIPT', S.UNREGISTER_TASK_SCRIPT],
  ['makeCertificateScript', S.makeCertificateScript()],
  ['inspectCertificateScript', S.inspectCertificateScript(THUMB)],
  ['removeCertificateScript', S.removeCertificateScript(THUMB)],
  ['protectSecretScript', S.protectSecretScript(SECRET_PATH)],
  ['INSTALL_PYTHON_SCRIPT', S.INSTALL_PYTHON_SCRIPT],
];

/** The commands each script runs ('' is a call through a variable, such as & $pwsh). @type {Record<string, string[]>} */
const COMMANDS = {
  PROBE: ['', 'ConvertTo-Json', 'Get-ChildItem', 'Get-Command', 'Get-ExecutionPolicy', 'Get-TimeZone', 'Join-Path', 'Select-Object', 'Sort-Object', 'Split-Path', 'Test-Path', 'Test-Python'],
  registerTaskScript: ['ConvertTo-Json', 'Get-Content', 'Register-ScheduledTask'],
  START_TASK_SCRIPT: ['ConvertTo-Json', 'Start-ScheduledTask'],
  TASK_INFO_SCRIPT: ['ConvertTo-IsoTime', 'ConvertTo-Json', 'Get-ScheduledTask', 'Get-ScheduledTaskInfo'],
  UNREGISTER_TASK_SCRIPT: ['ConvertTo-Json', 'Get-ScheduledTask', 'Unregister-ScheduledTask'],
  makeCertificateScript: ['ConvertTo-IsoTime', 'ConvertTo-Json', 'Get-Date', 'Get-Item', 'New-SelfSignedCertificate'],
  inspectCertificateScript: ['ConvertTo-IsoTime', 'ConvertTo-Json', 'Get-Item', 'Test-Path'],
  removeCertificateScript: ['ConvertTo-Json', 'Remove-Item', 'Test-Path'],
  protectSecretScript: ['ConvertFrom-SecureString', 'ConvertTo-Json', 'ConvertTo-SecureString', 'New-Item', 'Set-Content', 'Split-Path'],
  INSTALL_PYTHON_SCRIPT: ['ConvertTo-Json', 'winget'],
};

const SCRIPT_DENY = [
  /Bypass/i, /Unrestricted/i, /PSExecutionPolicyPreference/i, /Set-ExecutionPolicy/i, /(?<![\w-])-ExecutionPolicy/i,
  /Invoke-Expression/i, /\biex\b/i, /ScriptBlock\]::Create/i, /EncodedCommand/i, /Start-Process/i,
  /Highest/i, /NT AUTHORITY/i, /S-1-5-18/, /\bSYSTEM\b/, /LocalMachine\\My/i,
];

test('scripts: no generated script changes or works round the execution policy, or asks for more rights', () => {
  for (const [name, text] of SCRIPTS) for (const re of SCRIPT_DENY) assert.doesNotMatch(text, re, `${name} matches ${re}`);
  for (const [name, text] of SCRIPTS.filter(([n]) => n !== 'PROBE')) assert.doesNotMatch(text, /ExecutionPolicy/i, name);
  assert.doesNotMatch(S.PROBE.replace(/Get-ExecutionPolicy|\$\w+\.ExecutionPolicy\b|\bexecutionPolicy\s*=/g, ''), /ExecutionPolicy/i, 'the probe only reads the policy');
  assert.doesNotMatch(S.registerTaskScript(ODD_XML), /-(User|Password|RunLevel|Principal)\b/i, 'the task is registered from its XML alone');
  assert.ok(!S.PROBE.includes('"'), 'the probe runs as a -Command, so it has no double quotes');
});

test('scripts: each script stops on the first error and prints compact JSON result lines', () => {
  for (const [name, text] of SCRIPTS) {
    const stop = name === 'INSTALL_PYTHON_SCRIPT' ? 'Continue' : 'Stop';
    assert.ok(text.startsWith(`$ErrorActionPreference = '${stop}'`), `${name} starts with $ErrorActionPreference = '${stop}'`);
    assert.match(text, /\$ProgressPreference = 'SilentlyContinue'/, name);
    const lines = [...text.matchAll(/'AIO-RESULT ' \+ \(/g)].length;
    assert.ok(lines >= 1, `${name} prints a result line`);
    assert.equal([...text.matchAll(/ConvertTo-Json -Compress -Depth 5 -EscapeHandling EscapeNonAscii\)/g)].length, lines, name);
  }
});

test('scripts: every generated script parses cleanly in each PowerShell and runs only its own commands', (t) => {
  for (const { exe, shapes } of parseEach(t, SCRIPTS.map(([, s]) => s))) {
    shapes.forEach((shape, i) => {
      const name = SCRIPTS[i][0];
      assert.deepEqual(shape.errors, [], `${name} in ${exe}`);
      assert.deepEqual(commandNames(shape), [...COMMANDS[name]].sort(), `${name} in ${exe}`);
    });
    assert.ok(shapes[1].strings.some((s) => s.type === 'SingleQuoted' && s.value === ODD_XML), `the XML path stays one string in ${exe}`);
    assert.ok(!shapes[1].commands.some((c) => c.name === 'x'), `$(x) in the path isn't run in ${exe}`);
  }
});

test('scripts: hostile paths stay string constants in the task and secret scripts', (t) => {
  /** @type {[string, (v: string) => string][]} */
  const builders = [['registerTaskScript', S.registerTaskScript], ['protectSecretScript', S.protectSecretScript]];
  for (const [name, build] of builders) {
    for (const { exe, shapes } of parseEach(t, [build('C:\\plain\\file.txt'), ...HOSTILE.map(build)])) {
      const [benign, ...rest] = shapes;
      rest.forEach((shape, i) => {
        const what = `${name}(${JSON.stringify(HOSTILE[i])}) in ${exe}`;
        assert.deepEqual(shape.errors, [], what);
        assert.equal(shape.hash, benign.hash, `${what} has the same syntax tree`);
        assert.deepEqual(commandNames(shape), commandNames(benign), what);
        assert.deepEqual(shape.expandable, benign.expandable, what);
        assert.ok(shape.strings.some((s) => s.type === 'SingleQuoted' && s.value === HOSTILE[i]), `${what} keeps the value as one string`);
      });
    }
  }
});

test("scripts: the certificate is a non-exportable RSA key in the user's own store that lasts the months asked for", () => {
  const text = S.makeCertificateScript(6);
  assert.ok(text.includes(`New-SelfSignedCertificate -Subject ${psQuote(N.CERT_SUBJECT)} -FriendlyName ${psQuote(N.PAX_APP_NAME)} -CertStoreLocation 'Cert:\\CurrentUser\\My'`));
  for (const flag of ["-Provider 'Microsoft Software Key Storage Provider'", '-KeyAlgorithm RSA', '-KeyLength 2048', '-HashAlgorithm SHA256', '-KeyExportPolicy NonExportable', '-KeyUsage DigitalSignature', '-NotBefore $from', '-NotAfter $from.AddMonths(6).AddDays(-1)']) {
    assert.ok(text.includes(flag), flag);
  }
  assert.ok(S.makeCertificateScript().includes(`$from.AddMonths(${N.CERT_MONTHS}).AddDays(-1)`));
  assert.ok(S.makeCertificateScript(1).includes('$from.AddMonths(1).AddDays(-1)'));
  for (const bad of [0, 13, 1.5, -1, NaN]) assert.throws(() => S.makeCertificateScript(bad), { message: 'A certificate lasts 1 to 12 months.' });
});

test("scripts: the certificate scripts take only a real thumbprint and work in the user's own store", () => {
  for (const build of [S.inspectCertificateScript, S.removeCertificateScript]) {
    for (const bad of ['', 'A1'.repeat(19), 'A1'.repeat(21), `${'A1'.repeat(19)}G1`, `${THUMB}'; Remove-Item C:\\nope; '`]) {
      assert.throws(() => build(bad), { message: `"${bad}" isn't a certificate thumbprint.` });
    }
    assert.ok(build(THUMB).includes(THUMB));
    assert.match(build(THUMB), /Cert:\\CurrentUser\\My/);
  }
  assert.match(S.removeCertificateScript(THUMB), /Remove-Item -LiteralPath \$path -DeleteKey/);
});

test('scripts: the client secret reaches PowerShell only through the environment and is kept with DPAPI', async () => {
  const text = S.protectSecretScript(SECRET_PATH);
  assert.ok(text.includes("if (-not $env:AIO_SECRET) { throw 'No secret was passed.' }"));
  assert.match(text, /ConvertTo-SecureString/);
  assert.match(text, /ConvertFrom-SecureString/);
  assert.doesNotMatch(text, /-Key\b|-SecureKey\b/, 'no key of its own: DPAPI ties it to the user');
  assert.ok(text.includes(`$file = ${psQuote(SECRET_PATH)}`));
  assert.ok(text.includes('Set-Content -LiteralPath $file -Value $protected -Encoding utf8NoBOM -NoNewline'));
  const { runPwsh, runs } = recorder(() => printed({ file: SECRET_PATH }));
  await S.protectSecret(runPwsh, SECRET_PATH, SECRET);
  assert.deepEqual(runs, [{ script: text, env: { AIO_SECRET: SECRET } }]);
  assert.ok(!text.includes(SECRET));
});

test('scripts: Python is installed from winget for the current user only, without prompts', () => {
  assert.match(S.INSTALL_PYTHON_SCRIPT, /& winget install --id Python\.Python\.3\.\d+ --exact --source winget --scope user --silent --accept-source-agreements --accept-package-agreements/);
  assert.doesNotMatch(S.INSTALL_PYTHON_SCRIPT, /--scope machine|RunAs|-Verb/i);
});

test('scripts: the task scripts all address the one task in the root folder', () => {
  const task = `-TaskName ${psQuote(N.TASK_NAME)} -TaskPath '\\'`;
  for (const text of [S.registerTaskScript(ODD_XML), S.START_TASK_SCRIPT, S.TASK_INFO_SCRIPT, S.UNREGISTER_TASK_SCRIPT]) assert.ok(text.includes(task));
  assert.ok(S.registerTaskScript(ODD_XML).includes(`Get-Content -Raw -LiteralPath ${psQuote(ODD_XML)}`));
  assert.ok(S.registerTaskScript(ODD_XML).includes(`Register-ScheduledTask ${task} -Xml $xml -Force`));
  assert.equal(S.TASK_RUNNING, 0x41301);
  assert.equal(S.TASK_NOT_RUN, 0x41303);
});

test('checkPolicy: lets the refresh go ahead under any execution policy that runs local scripts', () => {
  for (const policy of ['RemoteSigned', 'Unrestricted', 'Bypass', 'Undefined']) {
    assert.deepEqual(S.checkPolicy(/** @type {any} */ ({ languageMode: 'FullLanguage', executionPolicy: policy, policies: {} })), { ok: true, title: `PowerShell's execution policy is ${policy}` });
  }
  assert.deepEqual(S.checkPolicy(/** @type {any} */ ({ languageMode: 'FullLanguage' })), { ok: true, title: "PowerShell's execution policy is Undefined" });
});

test('checkPolicy: stops when an application control policy limits PowerShell, whatever the execution policy', () => {
  for (const mode of ['ConstrainedLanguage', 'RestrictedLanguage', 'NoLanguage']) {
    assert.deepEqual(S.checkPolicy(/** @type {any} */ ({ languageMode: mode, executionPolicy: 'RemoteSigned', policies: {} })), {
      ok: false,
      title: `PowerShell runs in ${mode} mode on this PC`,
      detail: "An application control policy (such as App Control for Business or AppLocker) limits PowerShell here, so the scheduled task's script would fail.",
      howTo: ['Ask IT whether the PAX refresh can run on this PC, or run the installer on a PC or server where PowerShell runs in full language mode.'],
    });
  }
});

test('checkPolicy: stops under AllSigned or Restricted, names the scope and never suggests working round it', () => {
  /** @type {Record<string, string>} */
  const why = { AllSigned: 'only signed scripts can run', Restricted: "scripts can't run" };
  /** @type {[string, Record<string, string>, string][]} */
  const cases = [
    ['AllSigned', { MachinePolicy: 'AllSigned', LocalMachine: 'RemoteSigned' }, 'MachinePolicy'],
    ['Restricted', { MachinePolicy: 'Undefined', UserPolicy: 'Restricted' }, 'UserPolicy'],
    ['AllSigned', { MachinePolicy: 'Undefined', UserPolicy: 'Undefined', Process: 'Undefined', CurrentUser: 'AllSigned', LocalMachine: 'RemoteSigned' }, 'CurrentUser'],
    ['Restricted', { Process: 'Restricted', LocalMachine: 'Restricted' }, 'Process'],
    ['Restricted', {}, 'LocalMachine'],
  ];
  for (const [policy, policies, scope] of cases) {
    const r = S.checkPolicy(/** @type {any} */ ({ languageMode: 'FullLanguage', executionPolicy: policy, policies }));
    const lead = `With ${policy}, ${why[policy]}, so the scheduled task couldn't run the refresh script.`;
    const expected = scope === 'MachinePolicy' || scope === 'UserPolicy'
      ? { ok: false, title: `PowerShell's execution policy is ${policy}, set by Group Policy`, detail: `${lead} The installer doesn't change the policy or work round it.`, howTo: ['Ask IT to allow local scripts (RemoteSigned) for your account on this PC, or run the installer on a PC or server where they are allowed.'] }
      : { ok: false, title: `PowerShell's execution policy is ${policy} (${scope} scope)`, detail: `${lead} The installer doesn't change the policy for you.`, howTo: ['To let local scripts run for your account only, run this yourself in PowerShell 7, then run the installer again:', 'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned', "If your organisation doesn't allow that, ask IT."] };
    assert.deepEqual(r, expected, `${policy} from ${scope}`);
    assert.doesNotMatch(JSON.stringify(r), /Bypass|Unrestricted|-Scope (Process|LocalMachine)/i);
  }
});

test('probe: runs the probe as a -Command and returns what it found, or says why it could not', async () => {
  const found = { languageMode: 'FullLanguage', executionPolicy: 'RemoteSigned', policies: { LocalMachine: 'RemoteSigned' } };
  const { runPwsh, runs } = recorder(() => printed(found));
  assert.deepEqual(await S.probe(runPwsh), found);
  assert.deepEqual(runs, [{ command: S.PROBE, timeoutMs: 120000 }]);
  /** @type {[PwshResult, string][]} */
  const bad = [
    [failed("The term 'Get-TimeZone' is not recognized.\r\n"), "The term 'Get-TimeZone' is not recognized."],
    [printed({}), 'WARNING: something chatty'],
    [printed({ languageMode: 5 }), 'WARNING: something chatty'],
    [failed('', 9), 'exit code 9'],
  ];
  for (const [answer, why] of bad) await assert.rejects(S.probe(recorder(() => answer).runPwsh), { message: `PowerShell 7 couldn't check this PC: ${why}` });
});

test('scripts: each run helper runs its script, returns its result and explains a failure', async () => {
  /** @type {[string, (r: RunPwsh) => Promise<unknown>, string, PwshRun][]} */
  const helpers = [
    ['registerTask', (r) => S.registerTask(r, ODD_XML), 'Registering the scheduled task', { script: S.registerTaskScript(ODD_XML) }],
    ['startTask', (r) => S.startTask(r), 'Starting the scheduled task', { script: S.START_TASK_SCRIPT }],
    ['taskInfo', (r) => S.taskInfo(r), 'Reading the scheduled task', { script: S.TASK_INFO_SCRIPT }],
    ['unregisterTask', (r) => S.unregisterTask(r), 'Removing the scheduled task', { script: S.UNREGISTER_TASK_SCRIPT }],
    ['makeCertificate', (r) => S.makeCertificate(r, 6), 'Making the certificate', { script: S.makeCertificateScript(6) }],
    ['inspectCertificate', (r) => S.inspectCertificate(r, THUMB), 'Reading the certificate', { script: S.inspectCertificateScript(THUMB) }],
    ['removeCertificate', (r) => S.removeCertificate(r, THUMB), 'Removing the certificate', { script: S.removeCertificateScript(THUMB) }],
    ['protectSecret', (r) => S.protectSecret(r, SECRET_PATH, SECRET), 'Protecting the client secret', { script: S.protectSecretScript(SECRET_PATH), env: { AIO_SECRET: SECRET } }],
    ['installPython', (r) => S.installPython(r), 'Installing Python', { script: S.INSTALL_PYTHON_SCRIPT, timeoutMs: 900000 }],
  ];
  /** @type {[PwshResult, string][]} */
  const failures = [
    [failed('Access is denied.\r\nAt line:1 char:1\r\n'), 'Access is denied.'],
    [/** @type {PwshResult} */ ({ code: 0, stdout: 'WARNING: no result\r\n', stderr: '', result: undefined }), 'WARNING: no result'],
    [printed(null), 'WARNING: something chatty'],
    [failed('', 5), 'exit code 5'],
  ];
  for (const [name, call, what, run] of helpers) {
    const ok = recorder(() => printed({ ok: 1 }));
    assert.deepEqual(await call(ok.runPwsh), { ok: 1 }, name);
    assert.deepEqual(ok.runs, [run], name);
    assert.deepEqual(await call(recorder(() => printed({ ok: 2 }, 3)).runPwsh), { ok: 2 }, `${name} goes by the result line, not the exit code`);
    for (const [answer, why] of failures) await assert.rejects(call(recorder(() => answer).runPwsh), { message: `${what} failed: ${why}` }, name);
  }
});

test('checkAccess: runs the wrapper with -CheckAccess and returns its result, or why it failed', async () => {
  const good = { ok: true, site: 'AI in One' };
  const ok = recorder(() => printed(good));
  assert.deepEqual(await S.checkAccess(ok.runPwsh, WIN_ENV), good);
  assert.deepEqual(ok.runs, [{ file: N.wrapperPath(WIN_ENV), args: ['-CheckAccess'], timeoutMs: 180000 }]);
  assert.deepEqual(await S.checkAccess(recorder(() => failed('The token request failed.\r\n')).runPwsh, WIN_ENV), { ok: false, step: 'Running the check', error: 'The token request failed.' });
  assert.deepEqual(await S.checkAccess(recorder(() => failed('', 3)).runPwsh, WIN_ENV), { ok: false, step: 'Running the check', error: 'exit code 3' });
});

test('checkAccess: the script it runs is the written wrapper, which checks access before anything starts PAX', async (t) => {
  const env = { LOCALAPPDATA: tempDir(t) };
  const file = writeWrapper(paxConfig({}, env), { env });
  /** @type {string[]} */
  const seen = [];
  await S.checkAccess(recorder((run) => (seen.push(readFileSync(String(run.file), 'utf8')), printed({ ok: true }))).runPwsh, env);
  assert.deepEqual(seen, [readFileSync(file, 'utf8')]);
  for (const { shapes: [shape] } of parseEach(t, seen, true)) {
    assert.deepEqual(shape.errors, []);
    assert.deepEqual(shape.params, ['Seed', 'CheckAccess']);
    assert.equal(shape.requires, '7.0');
    const top = shape.commands.filter((c) => !c.fn);
    const check = top.find((c) => c.name === 'Test-SiteAccess');
    const pax = firstPaxRun(shape);
    assert.ok(check && pax);
    assert.deepEqual(check.guards, ['$CheckAccess']);
    assert.ok(check.offset < pax.offset);
  }
});

// PowerShell writes redirected output in the console's code page, so a result line with non-ASCII
// text (a user name, a folder) would reach the installer garbled unless the line escapes it or the
// script first sets [Console]::OutputEncoding to UTF-8.
test('scripts: every AIO-RESULT line reaches the installer intact whatever the console code page', () => {
  /** @type {string[]} */
  const unsafe = [];
  for (const [name, text] of /** @type {[string, string][]} */ ([...SCRIPTS, ['Run-AIO-PAX.ps1.template', TEMPLATE]])) {
    for (const m of text.matchAll(/'AIO-RESULT ' \+ \([\s\S]*?ConvertTo-Json[^\r\n]*/g)) {
      if (/-EscapeHandling\s+EscapeNonAscii/.test(m[0])) continue;
      if (/\[Console\]::OutputEncoding\s*=[^\r\n]*UTF8/i.test(text.slice(0, m.index))) continue;
      unsafe.push(name);
    }
  }
  assert.deepEqual([...new Set(unsafe)], [], 'these print non-ASCII text in the console code page, so the installer reads it garbled');
});

// ---- wrapper.js and the wrapper template --------------------------------------------------------

const SETTINGS = wrapperSettings(paxConfig(), { env: WIN_ENV, version: '9.9.9' });
const RENDERED = renderWrapper(TEMPLATE, SETTINGS);

/** Renders with hostile values in every place a setting comes from. @returns {{ settings: Record<string, unknown>, text: string }[]} */
function hostileRenders() {
  const sharepoint = HOSTILE.map((h) => {
    const env = { LOCALAPPDATA: `C:\\Users\\${h}` };
    const site = { url: `https://contoso.sharepoint.com/sites/${h}`, host: h, path: `/sites/${h}`, library: h, folder: h, driveId: h };
    const settings = wrapperSettings(paxConfig({ site, certificateThumbprint: h, script: `C:\\PAX\\${h}.ps1`, sha256: h, pythonDir: `C:\\Python ${h}`, version: h }, env), { env, version: h });
    return { settings, text: renderWrapper(TEMPLATE, settings) };
  });
  const local = HOSTILE.map((h) => {
    const env = { LOCALAPPDATA: `D:\\${h}` };
    const over = { destination: 'local', site: undefined, localFolder: `D:\\Reports\\${h}`, credentialType: 'secret', secretExpires: h, agent365: true, windowDays: 3 };
    const settings = wrapperSettings(paxConfig(over, env), { env });
    return { settings, text: renderWrapper(TEMPLATE, settings) };
  });
  return [...sharepoint, ...local];
}

test('wrapper template: has one settings marker, no other placeholder, and reads only the settings the installer writes', () => {
  assert.equal(TPL.split('\n').filter((l) => l.trim() === '# {{SETTINGS}}').length, 1);
  assert.deepEqual([...TPL.matchAll(/\{\{\s*([\w.-]*)\s*\}\}/g)].map((m) => m[1]), ['SETTINGS']);
  const keys = Object.keys(SETTINGS);
  const used = [...new Set([...TPL.matchAll(/\$Settings\.(\w+)/g)].map((m) => m[1]))];
  assert.deepEqual(used.filter((k) => !keys.includes(k)), [], 'every setting the script reads is written');
  assert.deepEqual(keys.filter((k) => !used.includes(k)), [], 'every setting written is read');
});

test('renderWrapper: puts the quoted settings in place of the marker, with one BOM and CRLF line endings', () => {
  const expected = TPL.split('\n').map((l) => (l.trim() === '# {{SETTINGS}}' ? `$Settings = ${psHashtable(SETTINGS)}` : l)).join('\n');
  assert.equal(RENDERED, scriptText(expected));
  assert.ok(RENDERED.startsWith('\uFEFF'));
  assert.equal(RENDERED.indexOf('\uFEFF', 1), -1);
  assert.doesNotMatch(RENDERED, /(?<!\r)\n/);
  assert.doesNotMatch(RENDERED, /\{\{\s*[\w.-]*\s*\}\}/);
  for (const [key, value] of Object.entries(SETTINGS)) assert.ok(RENDERED.includes(`\r\n    ${key} = ${psValue(value)}\r\n`), key);
  assert.ok(RENDERED.includes(`\r\n    TenantId = '${TENANT}'\r\n`));
  assert.ok(RENDERED.includes('\r\n    Agent365 = $false\r\n'));
});

test('renderWrapper: needs exactly one marker line and refuses unsafe setting names and values', () => {
  const marker = (/** @type {number} */ n) => ({ message: `The script template must have one "# {{SETTINGS}}" line; it has ${n}.` });
  assert.throws(() => renderWrapper('Write-Output 1', {}), marker(0));
  assert.throws(() => renderWrapper('# {{SETTINGS}}\n# {{SETTINGS}}', {}), marker(2));
  assert.throws(() => renderWrapper("Write-Output 'x' # {{SETTINGS}}", {}), marker(0));
  assert.equal(renderWrapper('\uFEFFa\r\n   # {{SETTINGS}}  \r\nb', { X: 1 }), '\uFEFFa\r\n$Settings = [ordered]@{\r\n    X = 1\r\n}\r\nb');
  assert.throws(() => renderWrapper(TEMPLATE, { ...SETTINGS, Folder: 'a\r\nRemove-Item C:\\nope' }), /line break/);
  assert.throws(() => renderWrapper(TEMPLATE, { 'Bad-Name': 'x' }), { message: `"Bad-Name" can't be a PowerShell setting name.` });
});

test('wrapperSettings: writes every setting the script needs, in order, from the install record', () => {
  const config = paxConfig();
  const expected = {
    TenantId: TENANT, ClientId: APP_ID, CredentialType: 'certificate', CertificateThumbprint: THUMB,
    SecretFile: N.secretPath(WIN_ENV), SecretExpires: '', PaxScript: config.pax.script, PaxSha256: PAX.sha256.toUpperCase(), PaxVersion: PAX.version,
    PythonDir: 'C:\\Python313', InstallerVersion: '9.9.9', StateDir: N.runDir(WIN_ENV), Destination: 'sharepoint',
    SiteHost: 'contoso.sharepoint.com', SitePath: '/sites/AIinOne', Library: 'Documents', DriveId: DRIVE, Folder: N.SP_FOLDER,
    LocalFolder: '', SeedDays: emptyConfig().history.days, WindowDays: N.WINDOW_DAYS, SeedWindowDays: N.SEED_WINDOW_DAYS, Agent365: false,
  };
  const s = wrapperSettings(config, { env: WIN_ENV, version: '9.9.9' });
  assert.deepEqual(s, expected);
  assert.deepEqual(Object.keys(s), Object.keys(expected));
  assert.equal(wrapperSettings(config, { env: WIN_ENV }).InstallerVersion, INSTALLER_VERSION);
  assert.equal(SETTINGS.PaxSha256, PAX.sha256.toUpperCase(), 'Get-FileHash gives upper-case hex');
});

test('wrapperSettings: follows the credential, destination, folder and window choices', () => {
  const secret = wrapperSettings(paxConfig({ credentialType: 'secret', secretExpires: '2027-06-01T00:00:00.000Z' }), { env: WIN_ENV });
  assert.deepEqual([secret.CredentialType, secret.CertificateThumbprint, secret.SecretExpires, secret.SecretFile], ['secret', '', '2027-06-01T00:00:00.000Z', N.secretPath(WIN_ENV)]);
  assert.equal(wrapperSettings(paxConfig({ credentialType: 'secret', certificateThumbprint: undefined }), { env: WIN_ENV }).SecretExpires, '');
  const local = wrapperSettings(paxConfig({ destination: 'local', localFolder: 'D:\\Reports\\AI in One', site: undefined }), { env: WIN_ENV });
  assert.deepEqual([local.Destination, local.LocalFolder, local.SiteHost, local.SitePath, local.Library, local.DriveId, local.Folder], ['local', 'D:\\Reports\\AI in One', '', '', '', '', '']);
  const bare = wrapperSettings(paxConfig({ site: { host: 'contoso.sharepoint.com', library: 'Shared Documents' }, agent365: true, windowDays: 3, pythonDir: undefined }), { env: WIN_ENV });
  assert.deepEqual([bare.SitePath, bare.DriveId, bare.Folder, bare.Agent365, bare.WindowDays, bare.PythonDir], ['', '', N.SP_FOLDER, true, 3, '']);
  const config = paxConfig({ windowDays: undefined });
  config.history.days = 90;
  const days = wrapperSettings(config, { env: WIN_ENV });
  assert.deepEqual([days.SeedDays, days.WindowDays], [90, N.WINDOW_DAYS]);
});

test('wrapperSettings: says what the install record is missing', () => {
  const missing = (/** @type {string} */ what) => ({ message: `The install record has no ${what} yet, so the task's script can't be written.` });
  assert.throws(() => wrapperSettings({ ...paxConfig(), pax: undefined }, { env: WIN_ENV }), { message: 'The install record has no PAX setup.' });
  assert.throws(() => wrapperSettings(paxConfig({ site: undefined }), { env: WIN_ENV }), { message: 'The install record has no SharePoint site yet.' });
  assert.throws(() => wrapperSettings({ ...paxConfig(), tenantId: undefined }, { env: WIN_ENV }), missing('tenant'));
  const noApp = paxConfig();
  noApp.app.appId = undefined;
  assert.throws(() => wrapperSettings(noApp, { env: WIN_ENV }), missing('app registration'));
  /** @type {[Record<string, unknown>, string][]} */
  const cases = [
    [{ certificateThumbprint: undefined }, 'certificate'],
    [{ script: undefined }, 'PAX download'],
    [{ sha256: '' }, 'PAX hash'],
    [{ version: undefined }, 'PAX version'],
    [{ site: { library: 'Documents' } }, 'site host'],
    [{ site: { host: 'contoso.sharepoint.com' } }, 'library'],
    [{ destination: 'local', site: undefined }, 'local folder'],
  ];
  for (const [over, what] of cases) assert.throws(() => wrapperSettings(paxConfig(over), { env: WIN_ENV }), missing(what), what);
  assert.throws(() => wrapperSettings(paxConfig(), { env: {} }), { message: 'LOCALAPPDATA is not set. The PAX setup runs on Windows.' });
});

test('renderWrapper: the wrapper parses cleanly in PowerShell 7 and every setting stays a constant, even with hostile values', (t) => {
  const renders = [{ settings: /** @type {Record<string, unknown>} */ (SETTINGS), text: RENDERED }, ...hostileRenders()];
  for (const { shapes } of parseEach(t, renders.map((r) => r.text), true)) {
    const [benign] = shapes;
    shapes.forEach((shape, i) => {
      const { settings } = renders[i];
      assert.deepEqual(shape.errors, [], `render ${i}`);
      assert.equal(shape.hash, benign.hash, `render ${i} has the same syntax tree`);
      assert.deepEqual(commandNames(shape), commandNames(benign), `render ${i}`);
      assert.deepEqual(shape.expandable, benign.expandable, `render ${i}`);
      assert.deepEqual(shape.settings.map((v) => v.key), Object.keys(settings), `render ${i}`);
      for (const v of shape.settings) {
        const value = settings[v.key];
        if (typeof value === 'string') assert.deepEqual([v.type, v.quote, v.value], ['StringConstantExpressionAst', 'SingleQuoted', value], `${v.key} in render ${i}`);
        else if (typeof value === 'number') assert.deepEqual([v.type, v.value], ['ConstantExpressionAst', String(value)], `${v.key} in render ${i}`);
        else assert.deepEqual([v.type, v.value], ['VariableExpressionAst', value ? 'True' : 'False'], `${v.key} in render ${i}`);
      }
    });
  }
});

const SP = "$Settings.Destination -eq 'sharepoint'";

/** The rendered wrapper's syntax tree in PowerShell 7, or undefined (and the test skipped) without it. @param {TestContext} t */
function wrapperShape(t) {
  return parseEach(t, [RENDERED], true)[0]?.shapes[0];
}

/** The first command in the script's main flow that runs PAX: loading the history, or the daily window. @param {Shape} shape */
function firstPaxRun(shape) {
  return shape.commands.find((c) => c.fn === '' && (c.name === 'Invoke-Seed' || c.name === 'Invoke-Window'));
}

/** The lines of the template's function with this name, as LF text. @param {string} name */
function templateFunction(name) {
  const m = new RegExp(`\\nfunction ${name}\\b[^\\n]*\\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(TPL);
  assert.ok(m, `the template has a function ${name}`);
  return m[1];
}

test('wrapper template: runs PAX as the app with -Rollup and -SkipVersionCheck, keeping its metrics and log, a window of days at a time', () => {
  const block = /\n {4}\$paxArgs = @\{\n([\s\S]*?)\n {4}\}\n/.exec(TPL);
  assert.ok(block, 'the PAX arguments');
  const args = Object.fromEntries(block[1].split('\n').map((line) => {
    const m = /^ +(\w+) += (.+)$/.exec(line);
    assert.ok(m, line);
    return [m[1], m[2]];
  }));
  assert.deepEqual(args, {
    Auth: "'AppRegistration'",
    TenantId: '$Settings.TenantId',
    ClientId: '$Settings.ClientId',
    StartDate: '(Format-Day $Start)',
    EndDate: '(Format-Day $End)',
    Rollup: '$true',
    SkipVersionCheck: '$true',
    EmitMetricsJson: '$true',
    MetricsPath: '$metrics',
    OutputPathLog: '$PaxLogDir',
  });
  const added = [...new Set([...TPL.matchAll(/\$paxArgs\.(\w+) = /g)].map((m) => m[1]))].sort();
  assert.deepEqual(added, ['AppendAgent365Info', 'AppendFile', 'AppendUserInfo', 'AutoCompleteness', 'ClientCertificateStoreLocation', 'ClientCertificateThumbprint', 'ClientSecret', 'IncludeAgent365Info', 'IncludeUserInfo', 'OutputPath', 'OutputPathAgent365Info', 'OutputPathUserInfo']);
  for (const line of [
    '$Today = $RunStarted.ToUniversalTime().Date',
    '$start = $Today.AddDays(-[int]$Settings.WindowDays)',
    '$from = $Today.AddDays(-[int]$Settings.SeedDays)',
    "$progress = [ordered]@{ from = $from; next = $from; window = [int]$Settings.SeedWindowDays; loading = $false; done = $false; found = $false; rows = $null; stops = 0 }",
    "$Day.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)",
    "$metrics = Join-Path $LogDir ('pax-metrics-{0}-{1}.json' -f $Stamp, $Result.attempts)",
    'if ($AutoCompleteness) { $paxArgs.AutoCompleteness = $true }',
    '$paxArgs.ClientSecret = Get-ClientSecretText',
    '$paxArgs.ClientCertificateThumbprint = $Settings.CertificateThumbprint',
    "$paxArgs.ClientCertificateStoreLocation = 'CurrentUser'",
    "$env:PAX_NONINTERACTIVE = '1'",
    '& $Settings.PaxScript @paxArgs *>> $RunLog',
    'if (Test-Path -LiteralPath $metrics) { $Result.metrics = $metrics }',
    '$RunLog = Join-Path $LogDir "run-$Stamp.log"',
  ]) assert.ok(TPL.includes(line), line);
  assert.match(TPL, /\n {4}log {9}= \$RunLog\n/, 'the result names the run log');
  assert.match(TPL, /\n {4}metrics {5}= \$null\n/);
});

test('wrapper template: each window appends to copies of the files PAX loaded so far, and exit code 10 runs PAX once more with -AutoCompleteness', (t) => {
  for (const line of [
    "$interactions = Join-Path $DataDir 'AIO_Interactions.csv'",
    "$mode = if ($seedRequested -or -not ((Test-Path -LiteralPath $interactions) -or (Test-Path -LiteralPath $NoDataFile))) { 'seed' } else { 'daily' }",
    '$seedRequested = $Seed -or (Test-Path -LiteralPath $SeedRequest)',
    '$copy = Join-Path $WorkDir $s.File',
    '$append = Test-Path -LiteralPath $copy',
    "'Interactions' { if ($append) { $paxArgs.AppendFile = $copy; $appended = $true } else { $paxArgs.OutputPath = $WorkDir } }",
    '$run = Invoke-Window $DataDir $start $Today',
    '$run = Invoke-Window $SeedDir $progress.next $end',
  ]) assert.ok(TPL.includes(line), line);
  const init = templateFunction('Initialize-WorkDir');
  assert.match(init, /\$stable = Join-Path \$From \$s\.File\n\s+if \(Test-Path -LiteralPath \$stable\) \{ Copy-Item -LiteralPath \$stable -Destination \(Join-Path \$WorkDir \$s\.File\) -Force \}/);
  assert.equal(TPL.match(/\$run\.Code -eq 10\b/g)?.length, 1);
  assert.ok(templateFunction('Complete-Seed').includes('Remove-Item -LiteralPath $SeedRequest -Force -ErrorAction SilentlyContinue'), 'the request goes once the history has loaded');
  assert.equal(TPL.match(/Remove-Item -LiteralPath \$SeedRequest\b/g)?.length, 1);
  const shape = wrapperShape(t);
  if (!shape) return;
  const pax = shape.commands.filter((c) => c.name === 'Invoke-Pax');
  assert.deepEqual(pax.map((c) => [c.text, c.fn, c.guards, c.loop]), [
    ['Invoke-Pax $Start $End', 'Invoke-Window', [], false],
    ['Invoke-Pax $Start $End -AutoCompleteness', 'Invoke-Window', ['$run.Code -eq 10'], false],
  ]);
  const fresh = shape.commands.filter((c) => c.name === 'Initialize-WorkDir');
  assert.deepEqual(fresh.map((c) => [c.text, c.fn, c.guards, c.loop]), [
    ['Initialize-WorkDir $Dir', 'Invoke-Window', [], false],
    ['Initialize-WorkDir $Dir', 'Invoke-Window', ['$run.Code -eq 10'], false],
  ]);
  assert.ok(fresh[0].offset < pax[0].offset && pax[0].offset < fresh[1].offset && fresh[1].offset < pax[1].offset, 'each PAX run starts from fresh copies');
  const runs = shape.commands.filter((c) => /^&\s*\$Settings\.PaxScript\b/.test(c.text));
  assert.deepEqual(runs.map((c) => [c.fn, c.loop]), [['Invoke-Pax', false]], 'PAX runs in one place');
  const windows = shape.commands.filter((c) => c.name === 'Invoke-Window');
  assert.deepEqual(windows.map((c) => [c.text, c.fn, c.guards, c.loop]), [
    ['Invoke-Window $SeedDir $progress.next $end', 'Invoke-Seed', [], true],
    ['Invoke-Window $DataDir $start $Today', '', ["-not $mode -eq 'seed'"], false],
  ]);
  assert.deepEqual(shape.commands.filter((c) => c.name === 'Invoke-Seed').map((c) => [c.fn, c.guards]), [['', ["$mode -eq 'seed'"]]]);
});

test('wrapper template: on a new PC it downloads the SharePoint copies before PAX appends to them, and keeps a download only when all of it arrived', (t) => {
  assert.ok(TPL.includes('$local = Join-Path $DataDir $s.File'));
  assert.ok(TPL.includes('if (-not (Test-Path -LiteralPath $local) -and (Receive-RemoteFile $s.File $local)) {'));
  const receive = templateFunction('Receive-RemoteFile');
  for (const line of [
    "Invoke-RestMethod -Uri (Get-DriveItemUri $Name '') -Headers (Get-AuthHeader)",
    'if ((Get-HttpStatus $_) -eq 404) { return $false }',
    '$size = [long]$item.size',
    'if ($size -le 0) {',
    "$partial = $Target + '.download'",
    "Invoke-WebRequest -Uri (Get-DriveItemUri $Name 'content') -Headers (Get-AuthHeader) -OutFile $partial",
    '$got = (Get-Item -LiteralPath $partial).Length',
    'if ($got -ne $size) { throw "The download of $Name stopped short: $got of $size bytes arrived." }',
    'Move-Item -LiteralPath $partial -Destination $Target -Force',
    'Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue',
  ]) assert.ok(receive.includes(line), line);
  assert.doesNotMatch(receive, /-OutFile \$Target/, 'never straight into the file later runs append to');
  assert.ok(receive.indexOf('} finally {') > receive.indexOf('Move-Item -LiteralPath $partial'), 'the partial file goes whatever happens');
  assert.ok(TPL.indexOf('Receive-RemoteFile $s.File $local') < TPL.indexOf('$mode = if ($seedRequested'), 'the mode is chosen after the download');
  const shape = wrapperShape(t);
  if (!shape) return;
  const get = shape.commands.filter((c) => c.name === 'Receive-RemoteFile');
  // A daily run on a new PC appends to the SharePoint copies; a first load fetches them to hold them back.
  assert.deepEqual(get.map((c) => [c.fn, c.guards, c.loop]), [['Get-PublishedFiles', [SP], true], ['', ['-not $seedRequested', SP], true]]);
  const fetch = shape.commands.filter((c) => c.name === 'Get-PublishedFiles');
  assert.deepEqual(fetch.map((c) => [c.fn, c.guards]), [['Invoke-Seed', ["-not (Test-Path -LiteralPath (Join-Path $DataDir 'AIO_Interactions.csv'))", '-not $progress']]]);
  const main = get.find((c) => c.fn === '');
  const firstInit = shape.commands.find((c) => c.name === 'Initialize-WorkDir');
  const firstPax = firstPaxRun(shape);
  assert.ok(main && firstInit && firstPax && main.offset < firstPax.offset);
});

test('wrapper template: reaches Graph only by path in the one library, with no search, nothing tenant-wide and no broad permission', (t) => {
  const deny = [/ExecutionPolicy/i, /Bypass/i, /Sites\.(ReadWrite|FullControl|Manage|Read)\.All/i, /Files\.(ReadWrite|Read)\.All/i, /\/search\b/i, /\$batch/i, /getAllSites/i, /\/sites\/root\b/i, /\/beta\//i, /Invoke-Expression|\biex\b/i];
  for (const text of [TPL, RENDERED, ...hostileRenders().map((r) => r.text)]) for (const re of deny) assert.doesNotMatch(text, re);
  const uris = [...new Set([...TPL.matchAll(/-Uri (\([^)]*\)|\S+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(uris, [
    '$children', '$session.uploadUrl', '$siteUri', '$uri',
    "('https://graph.microsoft.com/v1.0/sites/{0}/drives' -f $site.id)",
    "(Get-DriveItemUri $Name '')", "(Get-DriveItemUri $Name 'content')", "(Get-DriveItemUri $Name 'createUploadSession')", "(Get-DriveItemUri $s.File '')",
    "(Get-DriveItemUri 'aio-access-check.txt' '')", "(Get-DriveItemUri 'aio-access-check.txt' 'content')",
  ].sort());
  const address = templateFunction('Get-DriveItemUri');
  assert.ok(address.includes("$path = ($segments | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'"));
  assert.ok(address.includes("'https://graph.microsoft.com/v1.0/drives/{0}/root:/{1}:/{2}' -f $Settings.DriveId, $path, $Action"));
  assert.match(TPL, /\n {8}scope {6}= 'https:\/\/graph\.microsoft\.com\/\.default'\n/, 'the app asks only for what it was granted');
  const shape = wrapperShape(t);
  if (!shape) return;
  const allowed = [
    /^https:\/\/login\.microsoftonline\.com\/\{0\}\/oauth2\/v2\.0\/token$/,
    /^https:\/\/graph\.microsoft\.com\/\.default$/,
    /^https:\/\/graph\.microsoft\.com\/v1\.0\/sites\/\{0\}(:\/\{1\}|\/drives)?$/,
    /^https:\/\/graph\.microsoft\.com\/v1\.0\/drives\/\{0\}\/root(:\/\{1\}(:\/(\{2\}|children))?|\/children)$/,
  ];
  const urls = shape.strings.filter((s) => s.value.includes('://')).map((s) => s.value);
  assert.ok(urls.length >= 6, 'the addresses are string constants');
  for (const url of urls) assert.ok(allowed.some((re) => re.test(url)), `an unexpected address: ${url}`);
  assert.deepEqual(shape.expandable.filter((x) => x.includes('://')), []);
  const web = shape.commands.filter((c) => /^Invoke-(RestMethod|WebRequest)$/.test(c.name));
  assert.deepEqual([...new Set(web.map((c) => c.fn))].sort(), ['Get-GraphToken', 'Receive-RemoteFile', 'Send-RemoteFile', 'Test-SiteAccess']);
  for (const c of web) {
    if (c.fn === 'Get-GraphToken') assert.match(c.text, /-Uri \$uri /);
    else if (c.text.includes('$session.uploadUrl')) assert.doesNotMatch(c.text, /Get-AuthHeader|Authorization/);
    else assert.match(c.text, /-Headers \(Get-AuthHeader\)/, c.text);
  }
});

test('wrapper template: uploads each file whole or in upload-session chunks of a size Graph takes, without sending the token to the upload URL', () => {
  const chunk = /\$ChunkSize = (\d+)KB \* (\d+)/.exec(TPL);
  assert.ok(chunk);
  const size = Number(chunk[1]) * 1024 * Number(chunk[2]);
  assert.equal(size % (320 * 1024), 0, 'a multiple of 320 KiB');
  assert.ok(size > 0 && size <= 60 * 1024 * 1024, 'at most 60 MiB');
  assert.equal(/\$SimpleUploadLimit = (\d+)MB/.exec(TPL)?.[1], '250');
  const send = templateFunction('Send-RemoteFile');
  for (const line of [
    'if ($size -le $SimpleUploadLimit) {',
    "Invoke-RestMethod -Method Put -Uri (Get-DriveItemUri $Name 'content') -Headers (Get-AuthHeader) -InFile $Path -ContentType 'text/csv'",
    `Invoke-RestMethod -Method Post -Uri (Get-DriveItemUri $Name 'createUploadSession') -Headers (Get-AuthHeader) -ContentType 'application/json' -Body '{"item":{"@microsoft.graph.conflictBehavior":"replace"}}'`,
    'while ($offset -lt $size) {',
    "$range = 'bytes {0}-{1}/{2}' -f $offset, ($offset + $read - 1), $size",
    "Invoke-RestMethod -Method Put -Uri $session.uploadUrl -Headers @{ 'Content-Range' = $range } -Body $chunk -ContentType 'application/octet-stream'",
    '$offset += $read',
  ]) assert.ok(send.includes(line), line);
});

test('wrapper template: loads Agent 365 only when chosen, and a local folder gets copies instead of uploads', (t) => {
  const rows = [...TPL.matchAll(/\[pscustomobject\]@\{ Name = '(\w+)'; File = '([^']+)'; Pattern = '([^']+)'; Wanted = ([^}]+?) \}/g)].map((m) => m.slice(1));
  assert.deepEqual(rows, [
    ['Interactions', N.FILES.interactions, '*_Interactions.csv', '$true'],
    ['Users', N.FILES.users, '*_Users.csv', '$true'],
    ['Agent365', N.FILES.agent365, 'Agent365_*.csv', '[bool]$Settings.Agent365'],
  ]);
  const uses = TPL.match(/\$Streams\b/g)?.length ?? 0;
  const wanted = TPL.match(/@\(\$Streams \| Where-Object Wanted\)/g)?.length ?? 0;
  assert.ok(wanted >= 5);
  assert.equal(uses, wanted + 1, 'every use of the streams skips the ones not chosen');
  assert.ok(renderWrapper(TEMPLATE, wrapperSettings(paxConfig({ agent365: true }), { env: WIN_ENV })).includes('\r\n    Agent365 = $true\r\n'));
  assert.ok(RENDERED.includes('\r\n    Agent365 = $false\r\n'));
  const access = templateFunction('Test-SiteAccess');
  const early = access.indexOf("if ($Settings.Destination -ne 'sharepoint') {");
  assert.ok(early >= 0 && early < access.indexOf('Get-GraphToken'), 'the access check signs in only for SharePoint');
  const shape = wrapperShape(t);
  if (!shape) return;
  const where = (/** @type {string} */ name) => shape.commands.filter((c) => c.name === name).map((c) => [c.fn, c.guards]);
  assert.deepEqual(where('Send-RemoteFile'), [['Publish-Files', [SP]]]);
  assert.deepEqual(where('Receive-RemoteFile'), [['Get-PublishedFiles', [SP]], ['', ['-not $seedRequested', SP]]]);
  assert.deepEqual(where('Test-SiteAccess'), [['', ['$CheckAccess']]]);
  assert.deepEqual(where('Get-GraphToken').filter(([fn]) => fn !== 'Test-SiteAccess'), [['', [SP]], ['', [SP, '$publishFrom']]]);
  const copies = shape.commands.filter((c) => c.name === 'Copy-Item' && c.fn === 'Publish-Files');
  assert.deepEqual(copies.map((c) => [c.guards, c.text.includes('$Settings.LocalFolder')]), [[[`-not ${SP}`], true]]);
});

test('wrapper template: checks the PAX hash before it runs PAX, prunes old logs and always saves the result where the installer reads it', (t) => {
  assert.ok(TPL.includes('$hash = (Get-FileHash -LiteralPath $Settings.PaxScript -Algorithm SHA256).Hash'));
  assert.ok(TPL.includes('if ($hash -ne $Settings.PaxSha256) { throw '));
  assert.ok(TPL.includes("$env:PATH = $Settings.PythonDir + [IO.Path]::PathSeparator + $env:PATH"));
  assert.equal(/\$KeepLogs = (\d+)/.exec(TPL)?.[1], '30');
  assert.ok(templateFunction('Remove-OldFiles').includes('Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepLogs |'));
  assert.match(TPL, /\n\} finally \{\n {4}Clear-WorkDir\n {4}Remove-OldFiles \$LogDir 'run-\*\.log'\n {4}Remove-OldFiles \$LogDir 'pax-metrics-\*\.json'\n {4}Remove-OldFiles \$PaxLogDir '\*'\n {4}Save-Result\n\}\nexit \$exitCode\n*$/);
  assert.ok(TPL.includes("$DataDir = Join-Path $Settings.StateDir 'data'"));
  assert.ok(TPL.includes("$LogDir = Join-Path $Settings.StateDir 'logs'"));
  assert.ok(TPL.includes("$LastRunFile = Join-Path $LogDir 'last-run.json'"));
  assert.ok(TPL.includes("$SeedRequest = Join-Path $Settings.StateDir 'seed.request'"));
  assert.ok(TPL.includes("$SeedDir = Join-Path $Settings.StateDir 'seed'"));
  assert.ok(TPL.includes("$NoDataFile = Join-Path $Settings.StateDir 'no-interactions.json'"));
  assert.equal(SETTINGS.StateDir, N.runDir(WIN_ENV));
  assert.equal(relative(N.runDir(WIN_ENV), N.dataDir(WIN_ENV)), 'data');
  assert.equal(relative(N.runDir(WIN_ENV), N.lastRunPath(WIN_ENV)), join('logs', 'last-run.json'));
  assert.equal(relative(N.runDir(WIN_ENV), N.seedRequestPath(WIN_ENV)), 'seed.request');
  const shape = wrapperShape(t);
  if (!shape) return;
  const hash = shape.commands.filter((c) => c.name === 'Get-FileHash');
  const firstPax = firstPaxRun(shape);
  assert.deepEqual(hash.map((c) => [c.fn, c.guards]), [['', []]]);
  assert.ok(firstPax && hash[0].offset < firstPax.offset);
  assert.ok(shape.commands.filter((c) => c.name === 'Save-Result' && c.fn === '').length >= 3, 'the result is saved as the run starts, picks its mode and ends');
});

test('writeWrapper: writes the rendered wrapper only under the given LOCALAPPDATA, as UTF-8 with a BOM and CRLF', (t) => {
  const tmp = tempDir(t);
  const env = { LOCALAPPDATA: join(tmp, "Local O'Brien $(x) é") };
  const config = paxConfig({}, env);
  const file = writeWrapper(config, { env, version: '9.9.9' });
  assert.equal(file, N.wrapperPath(env));
  assert.deepEqual(filesUnder(tmp), [relative(tmp, file)]);
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  assert.equal(text, renderWrapper(TEMPLATE, wrapperSettings(config, { env, version: '9.9.9' })));
  assert.doesNotMatch(text, /(?<!\r)\n/);
  assert.ok(text.includes(`\r\n    StateDir = ${psQuote(N.runDir(env))}\r\n`));
  const template = 'Write-Output 1\n# {{SETTINGS}}\n';
  assert.equal(writeWrapper(config, { env, template }), file);
  assert.equal(readFileSync(file, 'utf8'), renderWrapper(template, wrapperSettings(config, { env })));
  assert.ok(readFileSync(file, 'utf8').includes(`InstallerVersion = ${psQuote(INSTALLER_VERSION)}`));
  assert.deepEqual(filesUnder(tmp), [relative(tmp, file)], 'it writes over the old one');
});

test('writeWrapper: writes no script when the install record is missing something', (t) => {
  const tmp = tempDir(t);
  const env = { LOCALAPPDATA: tmp };
  assert.throws(() => writeWrapper({ ...paxConfig({}, env), tenantId: undefined }, { env }), /no tenant yet/);
  assert.throws(() => writeWrapper(paxConfig({ sha256: undefined }, env), { env }), /no PAX hash yet/);
  assert.deepEqual(filesUnder(tmp), []);
});

// ---- nextRun, taskArguments, taskXml and writeTaskXml -------------------------------------------

const NOW = new Date(2026, 5, 1, 12, 0, 0);
const TASK_SPEC = { sid: SID, pwsh: PWSH, runAt: '02:00', now: NOW, env: WIN_ENV };
const ENTITIES = /** @type {Record<string, string>} */ ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' });
const unxml = (/** @type {string} */ s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ENTITIES[e]);

/** The text of the one element with this name. @param {string} xml @param {string} name */
function tag(xml, name) {
  const all = [...xml.matchAll(new RegExp(`<${name}(?: [^>]*)?>([^<]*)</${name}>`, 'g'))];
  assert.equal(all.length, 1, `one <${name}>`);
  return unxml(all[0][1]);
}

/** Checks the XML is well formed: tags balanced, one root, attributes quoted, text escaped. @param {string} xml */
function assertWellFormed(xml) {
  const decl = '<?xml version="1.0" encoding="UTF-16"?>';
  assert.ok(xml.startsWith(decl));
  const body = xml.slice(decl.length);
  const tags = [...body.matchAll(/<(\/?)([A-Za-z][\w]*)((?: [A-Za-z]+="[^"<>&]*")*)>/g)];
  assert.equal(tags.length, body.split('<').length - 1, 'every < starts a tag');
  for (const text of body.split(/<[^>]*>/)) assert.match(text, /^(?:[^<>&"']|&(?:lt|gt|amp|quot|apos);)*$/, `escaped text: ${text}`);
  /** @type {string[]} */
  const open = [];
  let roots = 0;
  for (const [, close, name] of tags) {
    if (close) assert.equal(open.pop(), name, `</${name}> closes the open tag`);
    else {
      if (!open.length) roots++;
      open.push(name);
    }
  }
  assert.deepEqual(open, [], 'every tag is closed');
  assert.equal(roots, 1);
}

/** Reads values from task XML files with PowerShell's XML parser. No double quotes, for Windows PowerShell's command line. */
const READ_XML = [
  "function Enc($v) { if ($null -eq $v) { return '' }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v)) }",
  '$n = 0',
  "foreach ($b in @([Console]::In.ReadToEnd() -split '\\s+' | Where-Object { $_ })) { try { " +
    '$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)); $d = [xml]::new(); $f = [IO.File]::OpenRead($p); try { $d.Load($f) } finally { $f.Dispose() }; ' +
    '$t = $d.DocumentElement; $pr = $t.Principals.Principal; $tr = $t.Triggers.CalendarTrigger; $st = $t.Settings; $x = $t.Actions.Exec; ' +
    "$v = [ordered]@{ root = $t.LocalName; ns = $t.NamespaceURI; version = $t.GetAttribute('version'); encoding = $d.FirstChild.Encoding; uri = $t.RegistrationInfo.URI; author = $t.RegistrationInfo.Author; " +
    'user = $pr.UserId; logon = $pr.LogonType; level = $pr.RunLevel; start = $tr.StartBoundary; days = $tr.ScheduleByDay.DaysInterval; ' +
    'available = $st.StartWhenAvailable; limit = $st.ExecutionTimeLimit; instances = $st.MultipleInstancesPolicy; command = $x.Command; arguments = $x.Arguments; dir = $x.WorkingDirectory }; ' +
    "foreach ($k in @($v.Keys)) { [Console]::Out.WriteLine('' + $n + ' ' + $k + ' ' + (Enc $v[$k])) } " +
    "} catch { [Console]::Out.WriteLine('' + $n + ' error ' + (Enc $_.Exception.Message)) }; $n++ }",
].join('; ');

/** @param {string} exe @param {string[]} files */
function readTaskXml(exe, files) {
  const input = files.map((f) => Buffer.from(f, 'utf8').toString('base64')).join('\n') + '\n';
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', READ_XML], { input, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(r.status, 0, `${exe} couldn't read the XML: ${r.error?.message ?? ''} ${r.stderr}`);
  /** @type {Record<string, string>[]} */
  const out = files.map(() => ({}));
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [n, key, value] = line.split(' ');
    assert.ok(out[Number(n)], `odd output: ${line}`);
    out[Number(n)][key] = unb64(value);
  }
  return out;
}

test('nextRun: the next time the clock reads HH:mm, today or tomorrow', () => {
  const before = NOW.getTime();
  assert.deepEqual(nextRun('13:30', NOW), new Date(2026, 5, 1, 13, 30, 0));
  assert.deepEqual(nextRun('02:00', NOW), new Date(2026, 5, 2, 2, 0, 0));
  assert.deepEqual(nextRun('12:00', NOW), new Date(2026, 5, 2, 12, 0, 0), 'now itself is too late');
  assert.deepEqual(nextRun('12:00', new Date(2026, 5, 1, 11, 59, 59, 999)), new Date(2026, 5, 1, 12, 0, 0));
  assert.deepEqual(nextRun('12:00', new Date(2026, 5, 1, 12, 0, 0, 1)), new Date(2026, 5, 2, 12, 0, 0));
  assert.deepEqual(nextRun('00:00', new Date(2026, 11, 31, 23, 0, 0)), new Date(2027, 0, 1, 0, 0, 0));
  assert.deepEqual(nextRun('23:59', new Date(2026, 1, 28, 23, 59, 30)), new Date(2026, 2, 1, 23, 59, 0));
  assert.deepEqual(nextRun(N.DEFAULT_RUN_AT, new Date(2026, 5, 1, 0, 0, 0)), new Date(2026, 5, 1, 2, 0, 0));
  assert.equal(NOW.getTime(), before, 'now is left as it was');
  for (const bad of ['2:00', '24:00', '12:60', '12:5', ' 02:00', '02:00 ', '', '02-00', '0200', '02:00:00', '\u0660\u0662:\u0660\u0660', '02:00\n']) {
    assert.throws(() => nextRun(bad, NOW), { message: `"${bad}" isn't a time. Use HH:mm, such as ${N.DEFAULT_RUN_AT}.` }, JSON.stringify(bad));
  }
});

test('taskArguments: runs the script with -File, hidden and non-interactive, and no execution policy switch', () => {
  const file = 'C:\\Users\\ana\\AppData\\Local\\AIInOne\\pax-run\\Run-AIO-PAX.ps1';
  assert.equal(taskArguments(file), `-NoProfile -NonInteractive -WindowStyle Hidden -File "${file}"`);
  assert.equal(taskArguments(ODD_XML), `-NoProfile -NonInteractive -WindowStyle Hidden -File "${ODD_XML}"`);
  assert.doesNotMatch(taskArguments(file), /ExecutionPolicy|Bypass|-Command|-EncodedCommand/i);
});

test('taskXml: a daily task at runAt that catches up, runs as the user while signed in without raised rights, for at most 4 hours', () => {
  const xml = taskXml(TASK_SPEC);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r\n'));
  assert.ok(xml.endsWith('</Task>\r\n'));
  assert.doesNotMatch(xml, /(?<!\r)\n/);
  assertWellFormed(xml);
  /** @type {[string, string][]} */
  const expected = [
    ['Date', '2026-06-01T12:00:00'],
    ['Author', 'AI in One installer'],
    ['URI', `\\${N.TASK_NAME}`],
    ['StartBoundary', '2026-06-02T02:00:00'],
    ['DaysInterval', '1'],
    ['UserId', SID],
    ['LogonType', 'InteractiveToken'],
    ['RunLevel', 'LeastPrivilege'],
    ['MultipleInstancesPolicy', 'IgnoreNew'],
    ['StartWhenAvailable', 'true'],
    ['ExecutionTimeLimit', 'PT4H'],
    ['Command', PWSH],
    ['Arguments', taskArguments(N.wrapperPath(WIN_ENV))],
    ['WorkingDirectory', N.runDir(WIN_ENV)],
  ];
  for (const [name, value] of expected) assert.equal(tag(xml, name), value, name);
  assert.equal(xml.match(/<Enabled>true<\/Enabled>/g)?.length, 2, 'the trigger and the task are on');
  assert.match(xml, /<Principal id="Author">/);
  assert.match(xml, /<Actions Context="Author">/);
  assert.equal(xml.match(/<Exec>/g)?.length, 1, 'one action');
  assert.equal(xml.match(/<CalendarTrigger>/g)?.length, 1, 'one trigger');
  assert.doesNotMatch(xml, /ExecutionPolicy|Bypass|HighestAvailable|S4U|<LogonType>Password|ServiceAccount|S-1-5-18/i);
  assert.equal(tag(taskXml({ ...TASK_SPEC, runAt: '23:15' }), 'StartBoundary'), '2026-06-01T23:15:00');
  const given = taskXml({ ...TASK_SPEC, wrapper: 'D:\\x\\Run.ps1', workingDir: 'D:\\x', env: {} });
  assert.deepEqual([tag(given, 'Arguments'), tag(given, 'WorkingDirectory')], [taskArguments('D:\\x\\Run.ps1'), 'D:\\x']);
});

test("taskXml: escapes paths for XML and refuses a SID, path or time it can't use", () => {
  const pwsh = "C:\\Tools & More\\<x>\\O'Brien\\pwsh.exe";
  const wrapper = "C:\\R&D\\<odd> 'name'\\Run-AIO-PAX.ps1";
  const workingDir = "C:\\R&D\\<odd> 'name'";
  const xml = taskXml({ ...TASK_SPEC, pwsh, wrapper, workingDir });
  assertWellFormed(xml);
  assert.ok(xml.includes('<Command>C:\\Tools &amp; More\\&lt;x&gt;\\O&apos;Brien\\pwsh.exe</Command>'));
  assert.ok(xml.includes('<Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -File &quot;C:\\R&amp;D\\&lt;odd&gt; &apos;name&apos;\\Run-AIO-PAX.ps1&quot;</Arguments>'));
  assert.deepEqual([tag(xml, 'Command'), tag(xml, 'Arguments'), tag(xml, 'WorkingDirectory')], [pwsh, taskArguments(wrapper), workingDir]);
  const sid = (/** @type {string} */ s) => ({ message: `"${s}" isn't a Windows account SID.` });
  for (const bad of ['', 'S-1-5', 'CONTOSO\\ana', 'S-1-5-21-1&<x>', `${SID}\n`, ` ${SID}`, 's-1-5-21-1']) {
    assert.throws(() => taskXml({ ...TASK_SPEC, sid: bad }), sid(bad), JSON.stringify(bad));
  }
  const path = (/** @type {string} */ what, /** @type {string} */ p) => ({ message: `The task's ${what} path "${p}" can't be used.` });
  assert.throws(() => taskXml({ ...TASK_SPEC, pwsh: '' }), path('pwsh', ''));
  assert.throws(() => taskXml({ ...TASK_SPEC, pwsh: 'C:\\a"b\\pwsh.exe' }), path('pwsh', 'C:\\a"b\\pwsh.exe'));
  assert.throws(() => taskXml({ ...TASK_SPEC, wrapper: 'C:\\a\r\nb.ps1' }), path('script', 'C:\\a\r\nb.ps1'));
  assert.throws(() => taskXml({ ...TASK_SPEC, workingDir: 'C:\\a\0b' }), path('folder', 'C:\\a\0b'));
  assert.throws(() => taskXml({ ...TASK_SPEC, runAt: '2am' }), { message: `"2am" isn't a time. Use HH:mm, such as ${N.DEFAULT_RUN_AT}.` });
  assert.throws(() => taskXml({ ...TASK_SPEC, env: {} }), { message: 'LOCALAPPDATA is not set. The PAX setup runs on Windows.' });
});

test('writeTaskXml: writes the definition beside the script as UTF-16 with a byte order mark, only under LOCALAPPDATA', (t) => {
  const tmp = tempDir(t);
  const env = { LOCALAPPDATA: tmp };
  const spec = { ...TASK_SPEC, env };
  const file = writeTaskXml(spec);
  assert.equal(file, join(N.runDir(env), 'task.xml'));
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(bytes.subarray(2).toString('utf16le'), taskXml(spec));
  const dir = join(tmp, "R&D 'x' [1] $(x) é 日本");
  const odd = writeTaskXml({ ...spec, workingDir: dir });
  assert.equal(odd, join(dir, 'task.xml'));
  assert.equal(readFileSync(odd).subarray(2).toString('utf16le'), taskXml({ ...spec, workingDir: dir }));
  assert.deepEqual(filesUnder(tmp), [relative(tmp, file), relative(tmp, odd)].sort());
});

test('writeTaskXml: Windows PowerShell and PowerShell 7 read the written XML back with every value intact', (t) => {
  const exes = powerShells();
  if (!exes.length) return t.skip('needs PowerShell');
  const tmp = tempDir(t);
  const env = { LOCALAPPDATA: join(tmp, "Local & 'odd' [1] $(x) é 日本") };
  const pwsh = "C:\\Tools & <More>\\O'Brien \u2018q\u2019 日本\\pwsh.exe";
  const wrapper = "C:\\R&D\\<odd> 'name' $(x) `y\\Run-AIO-PAX.ps1";
  const files = [writeTaskXml({ ...TASK_SPEC, env }), writeTaskXml({ ...TASK_SPEC, env, pwsh, wrapper, workingDir: join(tmp, "R&D 'x' [1] $(x) é 日本"), runAt: '23:45' })];
  const want = (/** @type {string} */ command, /** @type {string} */ script, /** @type {string} */ dir, /** @type {string} */ start) => ({
    root: 'Task', ns: 'http://schemas.microsoft.com/windows/2004/02/mit/task', version: '1.4', encoding: 'UTF-16', uri: `\\${N.TASK_NAME}`, author: 'AI in One installer',
    user: SID, logon: 'InteractiveToken', level: 'LeastPrivilege', start, days: '1', available: 'true', limit: 'PT4H', instances: 'IgnoreNew',
    command, arguments: taskArguments(script), dir,
  });
  for (const exe of exes) {
    assert.deepEqual(readTaskXml(exe, files), [
      want(PWSH, N.wrapperPath(env), N.runDir(env), '2026-06-02T02:00:00'),
      want(pwsh, wrapper, join(tmp, "R&D 'x' [1] $(x) é 日本"), '2026-06-01T23:45:00'),
    ], exe);
  }
});

// ---- task.js: the scheduled task ----------------------------------------------------------------

const TASK = `"${N.TASK_NAME}"`;
const SIGNED_IN_NOTE = "note: When this PC is off or you're signed out at that time, it runs when you next sign in.";
const NO_LOCALAPPDATA = { message: 'LOCALAPPDATA is not set. The PAX setup runs on Windows.' };

/**
 * A registered task that runs the wrapper just as the install record says.
 * @param {Record<string, string | undefined>} env
 * @param {Partial<TaskInfo>} [over]
 * @returns {TaskInfo}
 */
function matchingTask(env, over = {}) {
  return {
    exists: true,
    state: 'Ready',
    logonType: 'Interactive',
    userId: SID,
    execute: PWSH,
    arguments: taskArguments(N.wrapperPath(env)),
    workingDir: N.runDir(env),
    startBoundary: '2026-06-02T02:00:00',
    lastRunTime: null,
    lastTaskResult: S.TASK_NOT_RUN,
    nextRunTime: '2026-06-02T01:00:00.0000000Z',
    ...over,
  };
}

/**
 * Task Scheduler held in memory. It answers the installer's scripts by their exact text, so any
 * other script fails the test, and nothing reaches Windows.
 * @param {Record<string, string | undefined>} env
 * @param {TaskInfo | undefined} task  The registered task, if there is one.
 */
function fakeScheduler(env, task) {
  const xmlFile = join(N.runDir(env), 'task.xml');
  const register = S.registerTaskScript(xmlFile);
  /** @type {Record<string, string>} */
  const names = { [S.TASK_INFO_SCRIPT]: 'info', [register]: 'register', [S.START_TASK_SCRIPT]: 'start', [S.UNREGISTER_TASK_SCRIPT]: 'unregister' };
  const state = {
    /** @type {TaskInfo | undefined} */
    task: task,
    /** @type {string[]} The task XML each registration read. */
    registered: [],
    starts: 0,
    /** Whether Windows keeps a task it registers. */
    keep: true,
    /** @type {{ info?: PwshResult, register?: PwshResult, start?: PwshResult, unregister?: PwshResult }} */
    fail: {},
    /** @type {(() => void) | undefined} Runs as the task is read, as if the run did something meanwhile. */
    onInfo: undefined,
  };
  const { runPwsh, runs } = recorder((run) => {
    assert.deepEqual(Object.keys(run), ['script'], 'task scripts run with the default timeout');
    switch (names[run.script ?? ''] ?? '') {
      case 'info':
        state.onInfo?.();
        return state.fail.info ?? printed(state.task ?? { exists: false });
      case 'register': {
        if (state.fail.register) return state.fail.register;
        const bytes = readFileSync(xmlFile);
        assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'the XML Register-ScheduledTask reads is UTF-16 with a byte order mark');
        const xml = bytes.subarray(2).toString('utf16le');
        state.registered.push(xml);
        // Windows reports the account by name, not by the SID the XML gives.
        const info = { userId: 'ana', execute: tag(xml, 'Command'), arguments: tag(xml, 'Arguments'), workingDir: tag(xml, 'WorkingDirectory'), startBoundary: tag(xml, 'StartBoundary') };
        state.task = state.keep ? { ...matchingTask(env), ...info, nextRunTime: null } : undefined;
        return printed({ ok: true, state: 'Ready' });
      }
      case 'start':
        if (state.fail.start) return state.fail.start;
        state.starts++;
        if (state.task) state.task = { ...state.task, state: 'Running' };
        return printed({ ok: true });
      case 'unregister': {
        if (state.fail.unregister) return state.fail.unregister;
        const removed = !!state.task;
        state.task = undefined;
        return printed({ removed });
      }
      default:
        assert.fail(`The task's code ran a script it shouldn't:\n${run.script}`);
    }
  });
  return { runPwsh, runs, state, ran: () => runs.map((r) => names[r.script ?? ''] ?? '?') };
}

/**
 * The ctx the task's code gets: the install record, a temp LOCALAPPDATA, Task Scheduler held in
 * memory, a clock that moves only when the code sleeps, and a UI that records what it says.
 * @param {TestContext} t
 * @param {{ pax?: Record<string, unknown>, task?: (env: Record<string, string>) => TaskInfo }} [o]
 */
function taskCtx(t, o = {}) {
  const tmp = tempDir(t);
  const env = { LOCALAPPDATA: tmp };
  const sched = fakeScheduler(env, o.task?.(env));
  /** @type {string[]} */
  const said = [];
  /** @type {{ label: string, updates: string[], done: number }[]} */
  const bars = [];
  const { ui } = fakeUi();
  ui.ok = (s) => void said.push(`ok: ${s}`);
  ui.warn = (s) => void said.push(`warn: ${s}`);
  ui.info = (s) => void said.push(`info: ${s}`);
  ui.note = (s) => void said.push(`note: ${s}`);
  ui.progress = (label) => {
    const bar = { label, updates: /** @type {string[]} */ ([]), done: 0 };
    bars.push(bar);
    return {
      update: (/** @type {string} */ status) => void bar.updates.push(status),
      done: () => {
        bar.done++;
        return 0;
      },
    };
  };
  const { ctx, config, sleeps, saves } = fakeCtx({ ui, config: paxConfig(o.pax, env) });
  let clock = NOW.getTime();
  ctx.env = env;
  ctx.runPwsh = sched.runPwsh;
  ctx.now = () => new Date(clock);
  ctx.sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
  };
  return { ctx, config, pax: /** @type {any} */ (config.pax), env, tmp, sched, said, bars, sleeps, saves, tick: (/** @type {number} */ ms) => void (clock += ms) };
}

/**
 * Writes last-run.json as the wrapper does, or any text in its place.
 * @param {Record<string, string>} env @param {unknown} run @param {string} [bom]
 */
function writeLastRun(env, run, bom = '') {
  const file = N.lastRunPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof run === 'string' ? run : `${bom}${JSON.stringify(run, null, 2)}\r\n`, 'utf8');
}

/** @param {Partial<TaskInfo>} over */
const overText = (over) => `${Object.keys(over)} = ${JSON.stringify(Object.values(over))}`;

test('taskSpec: the task the install record and the given LOCALAPPDATA describe', () => {
  const { ctx } = fakeCtx({ config: paxConfig() });
  ctx.env = WIN_ENV;
  assert.deepEqual(taskSpec(ctx), { sid: SID, userName: 'CONTOSO\\ana', pwsh: PWSH, runAt: N.DEFAULT_RUN_AT, wrapper: N.wrapperPath(WIN_ENV), workingDir: N.runDir(WIN_ENV), env: WIN_ENV });
  const repair = { message: "The install record doesn't say which account and PowerShell the task uses. Run install again to repair it." };
  for (const over of [{ userSid: undefined }, { pwsh: undefined }, { userSid: '' }, { pwsh: '' }]) {
    const { ctx: c } = fakeCtx({ config: paxConfig(over) });
    c.env = WIN_ENV;
    assert.throws(() => taskSpec(c), repair, JSON.stringify(over));
  }
  ctx.env = {};
  assert.throws(() => taskSpec(ctx), NO_LOCALAPPDATA);
  /** @type {any} */ (ctx.config).pax = undefined;
  assert.throws(() => taskSpec(ctx), { message: 'The install record has no PAX setup.' });
});

test('taskMatches: the registered task matches by SID, DOMAIN\\name or account name in any case, however it signs in', () => {
  const { ctx } = fakeCtx({ config: paxConfig() });
  ctx.env = WIN_ENV;
  const spec = taskSpec(ctx);
  /** @type {Partial<TaskInfo>[]} */
  const same = [
    {},
    { userId: 'CONTOSO\\ana' },
    { userId: 'ana' },
    { userId: 'contoso\\ANA' },
    { userId: SID.toLowerCase() },
    { execute: PWSH.toUpperCase() },
    { arguments: taskArguments(N.wrapperPath(WIN_ENV)).toLowerCase() },
    { workingDir: N.runDir(WIN_ENV).toUpperCase() },
    { startBoundary: '2027-01-15T02:00:00+01:00' },
    { state: 'Running' },
    { state: 'Queued' },
    { logonType: 'Password' },
    { logonType: 'S4U' },
    { lastRunTime: '2026-06-01T01:00:00.0000000Z', lastTaskResult: 1 },
  ];
  for (const over of same) assert.equal(taskMatches(matchingTask(WIN_ENV, over), spec), true, overText(over));
});

test('taskMatches: spots drift in the program, its arguments, the folder, the time or the account, and a missing or disabled task', () => {
  const { ctx } = fakeCtx({ config: paxConfig() });
  ctx.env = WIN_ENV;
  const spec = taskSpec(ctx);
  const wrapper = N.wrapperPath(WIN_ENV);
  /** @type {Partial<TaskInfo>[]} */
  const drift = [
    { exists: false },
    { state: 'Disabled' },
    { userId: 'CONTOSO\\bob' },
    { userId: 'bob' },
    { userId: 'S-1-5-18' },
    { userId: 'S-1-5-21-1000000000-1000000000-1000000000-1002' },
    { userId: '' },
    { userId: undefined },
    { execute: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    { execute: 'pwsh.exe' },
    { execute: undefined },
    { arguments: `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${wrapper}"` },
    { arguments: `-NoProfile -NonInteractive -File "${wrapper}"` },
    { arguments: taskArguments(join(N.runDir(WIN_ENV), 'old', N.WRAPPER_FILE)) },
    { arguments: '' },
    { workingDir: N.stateRoot(WIN_ENV) },
    { workingDir: undefined },
    { startBoundary: '2026-06-02T03:00:00' },
    { startBoundary: '2026-06-02T02:01:00' },
    { startBoundary: '02:00' },
    { startBoundary: undefined },
  ];
  for (const over of drift) assert.equal(taskMatches(matchingTask(WIN_ENV, over), spec), false, overText(over));
  assert.equal(taskMatches(matchingTask(WIN_ENV, { userId: 'ana' }), { ...spec, userName: undefined }), false, 'without a user name only the SID matches');
  assert.equal(taskMatches(matchingTask(WIN_ENV), { ...spec, runAt: '03:00' }), false);
  assert.equal(taskMatches(matchingTask(WIN_ENV), { ...spec, pwsh: 'D:\\PowerShell\\7\\pwsh.exe' }), false);
  assert.equal(taskMatches(matchingTask(WIN_ENV), { ...spec, wrapper: join(N.runDir(WIN_ENV), 'Other.ps1') }), false);
  assert.equal(taskMatches(matchingTask(WIN_ENV), { ...spec, workingDir: N.dataDir(WIN_ENV) }), false);
});

test('logonOf and describeLogon: Password and S4U run while signed out; anything else only while the user is signed in', () => {
  /** @type {[string | undefined, string][]} */
  const cases = [
    ['Password', 'Password'],
    ['S4U', 'S4U'],
    ['Interactive', 'Interactive'],
    ['InteractiveOrPassword', 'Interactive'],
    ['Group', 'Interactive'],
    ['ServiceAccount', 'Interactive'],
    ['None', 'Interactive'],
    ['password', 'Interactive'],
    ['', 'Interactive'],
    [undefined, 'Interactive'],
  ];
  for (const [logonType, want] of cases) assert.equal(logonOf({ exists: true, logonType }), want, String(logonType));
  assert.equal(logonOf({ exists: false }), 'Interactive');
  assert.equal(describeLogon('Interactive'), 'while you are signed in');
  assert.equal(describeLogon(undefined), 'while you are signed in');
  assert.equal(describeLogon('Password'), 'whether or not you are signed in');
  assert.equal(describeLogon('S4U'), 'whether or not you are signed in, without your password');
});

test('signedOutSteps: the user sets signed-out runs in Task Scheduler, where Windows asks for the password and keeps it', () => {
  const steps = signedOutSteps('certificate');
  assert.equal(steps.length, 5);
  assert.match(steps[0], /taskschd\.msc/);
  assert.equal(steps[1], `In Task Scheduler Library, double-click ${TASK}.`);
  assert.match(steps[2], /choose "Run whether user is logged on or not"\. Leave "Do not store password" unticked: without your password the task can't use its certificate\.$/);
  assert.match(steps[3], /type your Windows password when Windows asks for it\. Windows keeps it, not the installer\.$/);
  assert.equal(steps[4], `Then run "${commandLine('status')}": it shows how the task signs in.`);
  const secret = signedOutSteps('secret');
  assert.deepEqual(
    secret.map((s, i) => s === steps[i]),
    [true, true, false, true, true],
  );
  assert.match(secret[2], /can't use its protected client secret\.$/);
  assert.doesNotMatch([...steps, ...secret].join('\n'), /ExecutionPolicy|Bypass|schtasks|\/RP\b|-Password/i);
  assert.match(noPasswordWarning('certificate'), /^The task is set to run without your password \("Do not store password"\), so it can't use its certificate\. /);
  assert.match(noPasswordWarning('secret'), /so it can't use its protected client secret\. /);
  assert.equal(noPasswordWarning(undefined), noPasswordWarning('certificate'));
});

test('ensureTask: registers the task from the XML it writes beside the script, then leaves the matching task alone', async (t) => {
  const c = taskCtx(t);
  await ensureTask(c.ctx);
  const at = c.ctx.now();
  assert.deepEqual(c.sched.ran(), ['info', 'register', 'info']);
  assert.deepEqual(c.sched.state.registered, [taskXml({ ...taskSpec(c.ctx), now: at })]);
  assert.equal(tag(c.sched.state.registered[0], 'StartBoundary'), '2026-06-02T02:00:00');
  assert.deepEqual(filesUnder(c.tmp), [join('AIInOne', 'pax-run', 'task.xml')]);
  assert.equal(c.pax.logonType, 'Interactive');
  assert.equal(c.pax.taskRegisteredAt, at.toISOString());
  assert.equal(c.saves(), 1);
  assert.deepEqual(c.said, [`ok: Registered the scheduled task ${TASK}: daily at 02:00, as CONTOSO\\ana, while you are signed in`, SIGNED_IN_NOTE]);

  c.tick(86_400_000);
  c.said.length = 0;
  await ensureTask(c.ctx);
  assert.deepEqual(c.sched.ran(), ['info', 'register', 'info', 'info'], 'a task that matches is not registered again');
  assert.equal(c.sched.state.registered.length, 1);
  assert.equal(c.pax.taskRegisteredAt, at.toISOString(), 'it keeps when the task was registered');
  assert.equal(c.saves(), 2);
  assert.deepEqual(c.said, [`ok: The scheduled task ${TASK} is set up: daily at 02:00, while you are signed in`, SIGNED_IN_NOTE]);

  const n = taskCtx(t, { pax: { userName: undefined, runAt: '23:45' } });
  await ensureTask(n.ctx);
  assert.equal(tag(n.sched.state.registered[0], 'StartBoundary'), '2026-06-01T23:45:00');
  assert.deepEqual(n.said, [`ok: Registered the scheduled task ${TASK}: daily at 23:45, as you, while you are signed in`, SIGNED_IN_NOTE]);
});

test('ensureTask: registers a drifted task again, and says so when that undid running while signed out', async (t) => {
  const c = taskCtx(t, { task: (env) => matchingTask(env, { startBoundary: '2026-06-02T03:00:00', lastRunTime: '2026-06-01T02:00:00.0000000Z', lastTaskResult: 0 }) });
  await ensureTask(c.ctx);
  assert.deepEqual(c.sched.ran(), ['info', 'register', 'info']);
  assert.equal(tag(c.sched.state.registered[0], 'StartBoundary').slice(11), '02:00:00');
  assert.deepEqual(c.said, [`ok: Updated the scheduled task ${TASK}: daily at 02:00, as CONTOSO\\ana, while you are signed in`, SIGNED_IN_NOTE]);

  const d = taskCtx(t, { pax: { signedOut: true, logonType: 'Password' }, task: (env) => matchingTask(env, { logonType: 'Password', execute: 'C:\\Old\\pwsh.exe' }) });
  await ensureTask(d.ctx);
  assert.equal(tag(d.sched.state.registered[0], 'Command'), PWSH);
  assert.equal(d.pax.logonType, 'Interactive');
  assert.deepEqual(d.said, [
    `ok: Updated the scheduled task ${TASK}: daily at 02:00, as CONTOSO\\ana, while you are signed in`,
    "warn: Updating it set it back to run only while you're signed in.",
    "info: You chose to have it run while you're signed out too. Windows needs your password for that, which it asks for itself:",
    ...signedOutSteps('certificate').map((s, i) => `info:   ${i + 1}. ${s}`),
  ]);

  const s = taskCtx(t, { task: (env) => matchingTask(env, { logonType: 'S4U', state: 'Disabled' }) });
  await ensureTask(s.ctx);
  assert.deepEqual(s.said.slice(1), ["warn: Updating it set it back to run only while you're signed in.", SIGNED_IN_NOTE]);
});

test('ensureTask: leaves a task the user set to run while signed out as it is, and records how it signs in', async (t) => {
  const p = taskCtx(t, { pax: { signedOut: true }, task: (env) => matchingTask(env, { logonType: 'Password', userId: 'CONTOSO\\ana' }) });
  await ensureTask(p.ctx);
  assert.deepEqual(p.sched.ran(), ['info']);
  assert.equal(p.pax.logonType, 'Password');
  assert.equal(p.pax.taskRegisteredAt, p.ctx.now().toISOString());
  assert.deepEqual(p.said, [`ok: The scheduled task ${TASK} is set up: daily at 02:00, whether or not you are signed in`]);

  for (const credentialType of /** @type {const} */ (['certificate', 'secret'])) {
    const s = taskCtx(t, { pax: { credentialType }, task: (env) => matchingTask(env, { logonType: 'S4U' }) });
    await ensureTask(s.ctx);
    assert.deepEqual(s.sched.ran(), ['info']);
    assert.equal(s.pax.logonType, 'S4U');
    assert.deepEqual(s.said, [`ok: The scheduled task ${TASK} is set up: daily at 02:00, whether or not you are signed in, without your password`, `warn: ${noPasswordWarning(credentialType)}`]);
  }

  // Chosen, but not set in Task Scheduler yet: the steps again.
  const w = taskCtx(t, { pax: { signedOut: true, credentialType: 'secret' }, task: (env) => matchingTask(env) });
  await ensureTask(w.ctx);
  assert.deepEqual(w.sched.ran(), ['info']);
  assert.deepEqual(w.said, [
    `ok: The scheduled task ${TASK} is set up: daily at 02:00, while you are signed in`,
    "info: You chose to have it run while you're signed out too. Windows needs your password for that, which it asks for itself:",
    ...signedOutSteps('secret').map((s, i) => `info:   ${i + 1}. ${s}`),
  ]);
});

test("ensureTask: stops with the reason when the record is incomplete, or Task Scheduler can't be read, refuses the task or doesn't keep it", async (t) => {
  const a = taskCtx(t, { pax: { userSid: undefined } });
  await assert.rejects(ensureTask(a.ctx), { message: "The install record doesn't say which account and PowerShell the task uses. Run install again to repair it." });
  assert.deepEqual(a.sched.ran(), []);

  const denied = failed('Get-ScheduledTask : Access is denied.\r\nAt line:3 char:9');
  const b = taskCtx(t);
  b.sched.state.fail.info = denied;
  await assert.rejects(ensureTask(b.ctx), { message: `Reading the scheduled task failed: ${firstError(denied)}` });
  assert.equal(firstError(denied), 'Get-ScheduledTask : Access is denied.');

  const r = taskCtx(t);
  r.sched.state.fail.register = failed('Register-ScheduledTask : Access is denied.');
  await assert.rejects(ensureTask(r.ctx), { message: 'Registering the scheduled task failed: Register-ScheduledTask : Access is denied.' });
  assert.equal(r.pax.logonType, undefined);
  assert.equal(r.pax.taskRegisteredAt, undefined);
  assert.equal(r.saves(), 0);
  assert.deepEqual(r.said, []);

  const k = taskCtx(t);
  k.sched.state.keep = false;
  await assert.rejects(ensureTask(k.ctx), { message: `Windows didn't keep the scheduled task ${TASK}.` });
  assert.deepEqual(k.sched.ran(), ['info', 'register', 'info']);
  assert.equal(k.saves(), 0);
});

test('startRun: starts the task and records the first run; with seed it leaves the request the script looks for', async (t) => {
  const c = taskCtx(t, { task: (env) => matchingTask(env) });
  const first = await startRun(c.ctx);
  assert.deepEqual(first, { started: true, at: c.ctx.now() });
  assert.deepEqual(c.sched.ran(), ['info', 'start']);
  assert.equal(c.pax.firstRunStartedAt, first.at.toISOString());
  assert.equal(c.saves(), 1);
  assert.deepEqual(c.said, ['ok: Started the scheduled task']);
  assert.deepEqual(filesUnder(c.tmp), []);

  c.tick(60_000);
  c.sched.state.task = matchingTask(c.env);
  assert.equal((await startRun(c.ctx)).started, true);
  assert.equal(c.pax.firstRunStartedAt, first.at.toISOString(), 'a later run leaves the first one recorded');
  assert.equal(c.saves(), 1);

  c.tick(60_000);
  c.sched.state.task = matchingTask(c.env);
  const seed = await startRun(c.ctx, { seed: true });
  assert.deepEqual(seed, { started: true, at: c.ctx.now() });
  assert.equal(readFileSync(N.seedRequestPath(c.env), 'utf8'), `${seed.at.toISOString()}\n`);
  assert.equal(c.pax.firstRunStartedAt, seed.at.toISOString());
  assert.equal(c.saves(), 2);
  assert.deepEqual(c.said.slice(-1), ['ok: Started the scheduled task: it loads the history again']);
  assert.deepEqual(filesUnder(c.tmp), [relative(c.tmp, N.seedRequestPath(c.env))]);
  assert.equal(c.sched.state.starts, 3);
});

test("startRun: doesn't start a run that's going already, or change anything for it; a missing task stops it", async (t) => {
  const c = taskCtx(t, { task: (env) => matchingTask(env, { state: 'Running' }) });
  let prepared = 0;
  assert.deepEqual(await startRun(c.ctx), { started: false, at: c.ctx.now() });
  assert.deepEqual(await startRun(c.ctx, { seed: true, prepare: () => prepared++ }), { started: false, at: c.ctx.now() });
  assert.deepEqual(c.said, ['note: A run is going already.', "note: A run is going already, so the history can't be loaded again until it finishes."]);
  assert.deepEqual(c.sched.ran(), ['info', 'info']);
  // The run that's going keeps its progress loading the history in the request file.
  assert.deepEqual(filesUnder(c.tmp), [], 'no seed request while a run is going');
  assert.equal(prepared, 0);
  assert.equal(c.pax.firstRunStartedAt, undefined);
  assert.equal(c.saves(), 0);

  // While a run is loading the history, its progress stays as it is.
  const progress = `${JSON.stringify({ from: '2026-01-01', next: '2026-03-02', window: 30, loading: true })}\n`;
  mkdirSync(dirname(N.seedRequestPath(c.env)), { recursive: true });
  writeFileSync(N.seedRequestPath(c.env), progress, 'utf8');
  await startRun(c.ctx, { seed: true });
  assert.equal(readFileSync(N.seedRequestPath(c.env), 'utf8'), progress);

  // Once the task can start, prepare runs before the request is written and the task started.
  const p = taskCtx(t, { task: (env) => matchingTask(env) });
  /** @type {string[]} */
  const order = [];
  const start = await startRun(p.ctx, { seed: true, prepare: () => order.push(`prepare ${existsSync(N.seedRequestPath(p.env))} ${p.sched.state.starts}`) });
  assert.equal(start.started, true);
  assert.deepEqual(order, ['prepare false 0']);
  assert.equal(p.sched.state.starts, 1);

  const m = taskCtx(t);
  await assert.rejects(startRun(m.ctx, { seed: true }), { message: `The scheduled task ${TASK} isn't there. Run install again to repair it.` });
  assert.deepEqual(filesUnder(m.tmp), [], 'no seed request for a task that is not there');

  const f = taskCtx(t, { task: (env) => matchingTask(env) });
  f.sched.state.fail.start = failed('Start-ScheduledTask : The task is disabled.');
  await assert.rejects(startRun(f.ctx), { message: 'Starting the scheduled task failed: Start-ScheduledTask : The task is disabled.' });
  assert.equal(f.pax.firstRunStartedAt, undefined);
  assert.deepEqual(f.said, []);
});

test('readLastRun: reads last-run.json with or without a byte order mark, and nothing from a missing, broken or odd file', (t) => {
  const tmp = tempDir(t);
  const env = { LOCALAPPDATA: tmp };
  assert.equal(readLastRun(env), undefined);
  const run = {
    startedAt: '2026-06-01T02:00:00.1234567Z',
    finishedAt: '2026-06-01T02:10:00.7654321Z',
    status: 'ok',
    mode: 'daily',
    exitCode: 0,
    attempts: 1,
    paxVersion: PAX.version,
    destination: 'sharepoint',
    files: N.paxFiles(emptyPax()),
    metrics: null,
    log: join(N.runDir(env), 'logs', 'run.log'),
    warnings: [],
    message: null,
  };
  writeLastRun(env, run);
  assert.deepEqual(readLastRun(env), run);
  writeLastRun(env, run, '\uFEFF');
  assert.deepEqual(readLastRun(env), run);
  for (const odd of ['', '{', 'null', '[]', '"2026-06-01T02:00:00Z"', '{"startedAt":20260601}', '{"status":"ok"}', '\uFEFF']) {
    writeLastRun(env, odd);
    assert.equal(readLastRun(env), undefined, JSON.stringify(odd));
  }
  assert.throws(() => readLastRun({}), NO_LOCALAPPDATA);
  assert.deepEqual(filesUnder(tmp), [relative(tmp, N.lastRunPath(env))]);
});

test("readMetrics: the record and row counts in PAX's metrics JSON, when the run has one", (t) => {
  const tmp = tempDir(t);
  const metrics = join(tmp, "PAX metrics 'x' é 日本.json");
  const run = { startedAt: '2026-06-01T02:00:00Z', status: /** @type {const} */ ('ok'), metrics };
  assert.equal(readMetrics(undefined), undefined);
  assert.equal(readMetrics({ ...run, metrics: null }), undefined);
  assert.equal(readMetrics({ ...run, metrics: undefined }), undefined);
  assert.equal(readMetrics(run), undefined, 'no file yet');
  writeFileSync(metrics, `\uFEFF${JSON.stringify({ metrics: { TotalRecordsFetched: 1234567, TotalStructuredRows: 89012, Other: 3 } })}`, 'utf8');
  assert.deepEqual(readMetrics(run), { records: 1234567, rows: 89012 });
  /** @type {[string, unknown][]} */
  const cases = [
    ['{"metrics":{"TotalRecordsFetched":0}}', { records: 0, rows: undefined }],
    ['{"metrics":{"TotalRecordsFetched":"12","TotalStructuredRows":null}}', { records: undefined, rows: undefined }],
    ['{"metrics":{"TotalRecordsFetched":1e400,"TotalStructuredRows":-1}}', { records: undefined, rows: -1 }],
    ['{"TotalRecordsFetched":5}', { records: undefined, rows: undefined }],
    ['{}', { records: undefined, rows: undefined }],
    ['null', { records: undefined, rows: undefined }],
    ['{', undefined],
    ['', undefined],
  ];
  for (const [text, want] of cases) {
    writeFileSync(metrics, text, 'utf8');
    assert.deepEqual(readMetrics(run), want, text);
  }
});

test('describeRun: tells the user how the last run went, with its counts, message, warnings and log', (t) => {
  const tmp = tempDir(t);
  const metrics = join(tmp, 'metrics.json');
  writeFileSync(metrics, JSON.stringify({ metrics: { TotalRecordsFetched: 1234567, TotalStructuredRows: 89012 } }), 'utf8');
  const startedAt = '2026-06-01T02:00:07.1234567Z';
  assert.deepEqual(describeRun({ startedAt, status: 'running', mode: 'seed' }), ['A history (seed) run is going: it started 2026-06-01 02:00 UTC.']);
  assert.deepEqual(describeRun({ startedAt, status: 'running', mode: 'daily', message: 'not shown', warnings: ['not shown'] }), ['A daily run is going: it started 2026-06-01 02:00 UTC.']);
  assert.deepEqual(
    describeRun({ startedAt, finishedAt: '2026-06-01T02:12:59Z', status: 'ok', mode: 'daily', metrics, warnings: ['Agent 365 had no rows.', 'Second one.'], log: 'C:\\x\\run.log', message: null }),
    [
      'The last daily run worked. It started 2026-06-01 02:00 UTC and finished 2026-06-01 02:12 UTC.',
      'PAX read 1,234,567 audit records into 89,012 rows.',
      'Warning: Agent 365 had no rows.',
      'Warning: Second one.',
      'Its log: C:\\x\\run.log',
    ],
  );
  assert.deepEqual(describeRun({ startedAt, finishedAt: '2026-06-01T05:00:00Z', status: 'warning', mode: 'seed' }), [
    'The last history (seed) run worked, with warnings. It started 2026-06-01 02:00 UTC and finished 2026-06-01 05:00 UTC.',
  ]);
  writeFileSync(metrics, JSON.stringify({ metrics: { TotalRecordsFetched: 12 } }), 'utf8');
  assert.deepEqual(describeRun({ startedAt, finishedAt: null, status: 'failed', message: 'PAX stopped: exit code 2.', metrics, warnings: [] }), [
    'The last run failed. It started 2026-06-01 02:00 UTC and finished unknown.',
    'PAX stopped: exit code 2.',
    'PAX read 12 audit records.',
  ]);
  assert.deepEqual(describeRun({ startedAt: '', status: 'failed', metrics: join(tmp, 'missing.json') }), ['The last run failed. It started unknown and finished unknown.']);
});

test('waitForRun: polls every POLL_MS, showing progress, until the run that started since has finished', async (t) => {
  assert.equal(POLL_MS, 15_000);
  const c = taskCtx(t, { task: (env) => matchingTask(env, { state: 'Running' }) });
  const since = c.ctx.now();
  const iso = (/** @type {number} */ ms) => new Date(since.getTime() + ms).toISOString();
  writeLastRun(c.env, { startedAt: iso(-86_400_000), finishedAt: iso(-86_000_000), status: 'ok', mode: 'daily' });
  // A clock that rounds to the second may put the start a little before since.
  const running = { startedAt: iso(-3_000), status: 'running', mode: 'seed' };
  const done = { ...running, finishedAt: iso(40_000), status: 'ok', exitCode: 0 };
  const sleep = c.ctx.sleep;
  c.ctx.sleep = async (ms) => {
    await sleep(ms);
    if (c.sleeps.length === 1) writeLastRun(c.env, running);
    if (c.sleeps.length === 3) writeLastRun(c.env, done);
  };
  assert.deepEqual(await waitForRun(c.ctx, since, 3_600_000), done);
  assert.deepEqual(c.sleeps, [POLL_MS, POLL_MS, POLL_MS]);
  assert.deepEqual(c.sched.ran(), ['info', 'info', 'info']);
  const loading = `loading the history, started ${running.startedAt.slice(11, 16)} UTC`;
  assert.deepEqual(c.bars, [{ label: 'PAX is loading the audit log', updates: ['starting', loading, loading], done: 1 }]);

  // A run that started before since, beyond the slack, isn't this one.
  const o = taskCtx(t, { task: (env) => matchingTask(env, { state: 'Running' }) });
  writeLastRun(o.env, { ...done, startedAt: iso(-6_000) });
  assert.equal(await waitForRun(o.ctx, since, 0), undefined);
});

test('waitForRun: gives up once waitMs has passed while the run is still going, and returns nothing', async (t) => {
  const c = taskCtx(t, { task: (env) => matchingTask(env, { state: 'Running' }) });
  const since = c.ctx.now();
  writeLastRun(c.env, { startedAt: since.toISOString(), status: 'running', mode: 'daily' });
  assert.equal(await waitForRun(c.ctx, since, 60_000), undefined);
  assert.deepEqual(c.sleeps, [POLL_MS, POLL_MS, POLL_MS, POLL_MS]);
  assert.equal(c.ctx.now().getTime() - since.getTime(), 60_000);
  assert.deepEqual(c.bars, [{ label: 'PAX is loading the audit log', updates: Array(4).fill(`loading the last few days, started ${since.toISOString().slice(11, 16)} UTC`), done: 1 }]);

  const q = taskCtx(t, { task: (env) => matchingTask(env, { state: 'Queued' }) });
  assert.equal(await waitForRun(q.ctx, q.ctx.now(), 0), undefined);
  assert.deepEqual(q.sleeps, []);
  assert.deepEqual(q.bars, [{ label: 'PAX is loading the audit log', updates: [], done: 1 }]);
});

test("waitForRun: a task that ended without its script saying how the run went is a failed run, with the task's result code", async (t) => {
  // PowerShell couldn't start the script, so this run wrote no last-run.json.
  const a = taskCtx(t);
  const since = a.ctx.now();
  const lastRunTime = new Date(since.getTime() + 2_000).toISOString();
  a.sched.state.task = matchingTask(a.env, { lastRunTime, lastTaskResult: 2147942402 });
  writeLastRun(a.env, { startedAt: new Date(since.getTime() - 86_400_000).toISOString(), status: 'ok' });
  assert.deepEqual(await waitForRun(a.ctx, since, 3_600_000), {
    startedAt: lastRunTime,
    status: 'failed',
    exitCode: 2147942402,
    message: `The task ran, but its script stopped before it could start PAX (result 0x80070002). To see why, run it yourself in PowerShell 7: pwsh -NoProfile -File "${N.wrapperPath(a.env)}"`,
  });
  assert.deepEqual(a.sleeps, []);
  assert.deepEqual(a.bars.map((b) => b.done), [1]);

  // The run started, but the task ended before it finished, for example at its time limit.
  const b = taskCtx(t);
  const running = { startedAt: since.toISOString(), status: 'running', mode: 'daily', log: join(N.runDir(b.env), 'logs', 'run.log') };
  writeLastRun(b.env, running);
  b.sched.state.task = matchingTask(b.env, { lastRunTime: since.toISOString(), lastTaskResult: 267014 });
  assert.deepEqual(await waitForRun(b.ctx, since, 3_600_000), {
    ...running,
    status: 'failed',
    exitCode: 267014,
    message: 'The task stopped before the run finished (result 0x41306). It may have reached its 4-hour limit, or been ended in Task Scheduler.',
  });
  b.sched.state.task = matchingTask(b.env, { lastRunTime: since.toISOString(), lastTaskResult: -2147024894 });
  assert.match(String((await waitForRun(b.ctx, since, 0))?.message), /\(result 0x80070002\)/);

  // The run wrote how it went just as the task ended.
  const d = taskCtx(t);
  const ok = { ...running, status: 'ok', finishedAt: new Date(since.getTime() + 60_000).toISOString(), exitCode: 0 };
  writeLastRun(d.env, running);
  d.sched.state.task = matchingTask(d.env, { lastRunTime: since.toISOString(), lastTaskResult: 0 });
  d.sched.state.onInfo = () => writeLastRun(d.env, ok);
  assert.deepEqual(await waitForRun(d.ctx, since, 0), ok);

  // Not ended yet: no result, still running, queued, or the task's last run was before this one.
  /** @type {Partial<TaskInfo>[]} */
  const going = [
    { lastTaskResult: S.TASK_NOT_RUN },
    { lastTaskResult: S.TASK_RUNNING },
    { state: 'Running', lastTaskResult: 1 },
    { state: 'Queued', lastTaskResult: 1 },
    { lastRunTime: new Date(since.getTime() - 10_000).toISOString(), lastTaskResult: 1 },
    { lastRunTime: null, lastTaskResult: 1 },
  ];
  for (const over of going) {
    const e = taskCtx(t, { task: (env) => matchingTask(env, { lastRunTime: since.toISOString(), ...over }) });
    assert.equal(await waitForRun(e.ctx, since, 0), undefined, overText(over));
  }

  const f = taskCtx(t);
  f.sched.state.fail.info = failed('Get-ScheduledTask : The RPC server is unavailable.');
  await assert.rejects(waitForRun(f.ctx, since, 3_600_000), { message: 'Reading the scheduled task failed: Get-ScheduledTask : The RPC server is unavailable.' });
  assert.deepEqual(f.bars.map((x) => x.done), [1], 'the progress line is cleared');
});

test('removeTask: unregisters the task and forgets when it was registered and how it signed in', async (t) => {
  const c = taskCtx(t, { pax: { taskRegisteredAt: '2026-05-01T00:00:00.000Z', logonType: 'Password' }, task: (env) => matchingTask(env) });
  await removeTask(c.ctx);
  assert.deepEqual(c.sched.ran(), ['unregister']);
  assert.deepEqual(c.said, [`ok: Removed the scheduled task ${TASK}`]);
  assert.equal('taskRegisteredAt' in c.pax, false);
  assert.equal('logonType' in c.pax, false);
  assert.equal(c.pax.userSid, SID, 'the rest of the record stays');
  assert.equal(c.saves(), 1);
  await removeTask(c.ctx);
  assert.deepEqual(c.said.slice(1), [`ok: The scheduled task ${TASK} was gone already`]);
  assert.equal(c.saves(), 2);
  assert.deepEqual(filesUnder(c.tmp), []);

  const n = taskCtx(t);
  n.config.pax = undefined;
  await removeTask(n.ctx);
  assert.deepEqual(n.said, [`ok: The scheduled task ${TASK} was gone already`]);
  assert.equal(n.saves(), 0);

  const f = taskCtx(t, { pax: { taskRegisteredAt: '2026-05-01T00:00:00.000Z' }, task: (env) => matchingTask(env) });
  f.sched.state.fail.unregister = failed('Unregister-ScheduledTask : Access is denied.');
  await assert.rejects(removeTask(f.ctx), { message: 'Removing the scheduled task failed: Unregister-ScheduledTask : Access is denied.' });
  assert.equal(f.pax.taskRegisteredAt, '2026-05-01T00:00:00.000Z');
  assert.equal(f.saves(), 0);
  assert.deepEqual(f.said, []);
});

// ---- names.js -------------------------------------------------------------------------------------

test('names: everything the PAX route keeps sits under LOCALAPPDATA\\AIInOne, in the folders the launchers keep', () => {
  const env = { LOCALAPPDATA: join(tmpdir(), 'aio-pax-names-never-made', "Local 'x' é 日本") };
  const root = join(env.LOCALAPPDATA, 'AIInOne');
  const run = join(root, 'pax-run');
  assert.equal(N.stateRoot(env), root);
  /** @type {[string, string][]} */
  const paths = [
    [N.paxDir(PAX.version, env), join(root, 'pax', PAX.version)],
    [N.runDir(env), run],
    [N.managedAppDir(env), join(root, 'managed-app')],
    [N.wrapperPath(env), join(run, N.WRAPPER_FILE)],
    [N.secretPath(env), join(run, N.SECRET_FILE)],
    [N.lastRunPath(env), join(run, 'logs', 'last-run.json')],
    [N.seedRequestPath(env), join(run, 'seed.request')],
    [N.dataDir(env), join(run, 'data')],
  ];
  for (const [got, want] of paths) {
    assert.equal(got, want);
    const rel = relative(root, got);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `${got} is under ${root}`);
    assert.ok(/** @type {readonly string[]} */ (N.KEPT_DIRS).includes(rel.split(/[\\/]/)[0]), `${rel} is in a folder the launchers keep`);
  }
  assert.deepEqual([...N.KEPT_DIRS], ['pax', 'pax-run', 'managed-app']);
  assert.equal(existsSync(join(tmpdir(), 'aio-pax-names-never-made')), false, 'working out a path makes no folder');
  /** @type {((env: NodeJS.ProcessEnv) => string)[]} */
  const all = [N.stateRoot, N.runDir, N.managedAppDir, N.wrapperPath, N.secretPath, N.lastRunPath, N.seedRequestPath, N.dataDir, (e) => N.paxDir(PAX.version, e)];
  for (const bad of [{}, { LOCALAPPDATA: '' }]) for (const f of all) assert.throws(() => f(bad), NO_LOCALAPPDATA);
  assert.equal(N.defaultLocalFolder(), join(homedir(), 'Documents', N.SP_FOLDER));
});

test('names: the launchers keep the same folders when they remove old versions', () => {
  const words = (/** @type {string | undefined} */ list) => [...(list ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const ps = readFileSync(new URL('../packaging/launcher/install.ps1', import.meta.url), 'utf8');
  const cs = readFileSync(new URL('../packaging/launcher/Launcher.cs', import.meta.url), 'utf8');
  assert.deepEqual(words(ps.match(/\$Kept = @\(([^)]*)\)/)?.[1]), [...N.KEPT_DIRS], 'install.ps1 $Kept');
  assert.deepEqual(words(cs.match(/KeptDirs = \{([^}]*)\}/)?.[1]), [...N.KEPT_DIRS], 'Launcher.cs KeptDirs');
});

test('names: the task writes Interactions and Users, and Agent 365 only when it was chosen', () => {
  assert.deepEqual(N.FILES, { interactions: 'AIO_Interactions.csv', users: 'AIO_Users.csv', agent365: 'AIO_Agent365.csv' });
  const two = ['AIO_Interactions.csv', 'AIO_Users.csv'];
  assert.deepEqual(N.paxFiles(undefined), two);
  assert.deepEqual(N.paxFiles({}), two);
  assert.deepEqual(N.paxFiles({ agent365: false }), two);
  assert.deepEqual(N.paxFiles(emptyPax()), two);
  assert.deepEqual(N.paxFiles({ ...emptyPax(), agent365: true }), [...two, 'AIO_Agent365.csv']);
});

test('names: the names the task, the app, its certificate and the SharePoint folder share, and the defaults', () => {
  assert.equal(N.TASK_NAME, 'AI in One - PAX refresh');
  assert.equal(N.PAX_APP_NAME, 'AI in One (PAX)');
  assert.equal(N.CERT_SUBJECT, `CN=${N.PAX_APP_NAME}`);
  assert.equal(N.SP_FOLDER, 'AI in One');
  assert.equal(N.WRAPPER_FILE, 'Run-AIO-PAX.ps1');
  assert.equal(N.SECRET_FILE, 'client-secret.dpapi');
  assert.equal(N.DEFAULT_RUN_AT, '02:00');
  assert.equal(N.WINDOW_DAYS, 7);
  assert.equal(N.CERT_MONTHS, 12);
  const pax = emptyPax();
  assert.equal(pax.runAt, N.DEFAULT_RUN_AT);
  assert.equal(pax.windowDays, N.WINDOW_DAYS);
});
