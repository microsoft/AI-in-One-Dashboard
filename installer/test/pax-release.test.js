// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig, emptyPax } from '../src/config.js';
import { checkPc, ensurePaxTools, pcRows, PWSH_URL, PYTHON_URL } from '../src/pax/pc.js';
import { ensurePax, loadRelease, RELEASE_FILE, sha256 } from '../src/pax/release.js';
import { INSTALL_PYTHON_SCRIPT, PROBE } from '../src/pax/scripts.js';
import { fakeUi } from './fakes.js';

/** @typedef {import('../src/pax/scripts.js').Probe} Probe */
/** @typedef {import('../src/pax/ps.js').PwshRun} PwshRun */
/** @typedef {import('../src/pax/ps.js').PwshResult} PwshResult */
/** @typedef {import('../src/prereqs.js').Prereq} Prereq */

const PINNED = loadRelease();
const RAW = JSON.parse(readFileSync(RELEASE_FILE, 'utf8'));

/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A temp folder that stands in for %LOCALAPPDATA%, removed after the test.
 * @param {import('node:test').TestContext} t
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-pax-rel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** @param {Promise<unknown>} p */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return /** @type {Error} */ (err);
  }
  assert.fail('expected it to throw');
}

/**
 * A stand-in for fetch that answers every request with `body`, or throws it when it's an Error.
 * @param {string | Error} body
 * @param {number} [status]
 */
function fakeFetch(body, status = 200) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  const fetch = /** @type {typeof globalThis.fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {any} */ url, /** @type {any} */ init) => {
        calls.push({ url: String(url), init });
        if (body instanceof Error) throw body;
        return new Response(body, { status });
      }
    )
  );
  return { fetch, calls };
}

/**
 * The pinned release, but pinned to `body`, so a test can download "PAX" without the real file.
 * @param {string} body
 * @returns {import('../src/pax/release.js').PaxRelease}
 */
const releaseFor = (body) => ({ ...PINNED, sha256: sha256(Buffer.from(body)) });

/**
 * Where PAX goes under a LOCALAPPDATA.
 * @param {string} localAppData
 * @param {import('../src/pax/release.js').PaxRelease} release
 */
const paxFile = (localAppData, release) => join(localAppData, 'AIInOne', 'pax', release.version, release.file);

/**
 * A copy of the pinned release file with some fields changed.
 * @param {string} dir
 * @param {string} name
 * @param {Record<string, unknown>} change
 */
function releaseFile(dir, name, change) {
  const file = join(dir, `${name}.json`);
  const r = { ...RAW, ...change };
  for (const [k, v] of Object.entries(change)) if (v === undefined) delete r[k];
  writeFileSync(file, JSON.stringify(r));
  return file;
}

test('loadRelease: pins one PAX version, its GitHub release asset and its SHA-256', () => {
  const r = loadRelease();
  assert.deepEqual(r, RAW);
  assert.match(r.version, /^\d+\.\d+\.\d+$/);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.ok(r.tag.endsWith(r.version), `the tag ${r.tag} is version ${r.version}'s`);
  assert.ok(r.file.includes(r.version), `the file ${r.file} is version ${r.version}'s`);
  assert.equal(r.url, `https://github.com/microsoft/PAX/releases/download/${r.tag}/${r.file}`);
  assert.doesNotMatch(r.url, /\/latest\//, 'not whatever is newest');
  assert.equal(r.releaseUrl, `https://github.com/microsoft/PAX/releases/tag/${r.tag}`);
  assert.ok(Number.isInteger(r.size) && r.size > 0);
});

test("loadRelease: refuses a file that doesn't pin one release", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(loadRelease(releaseFile(dir, 'control', {})), RAW, 'an unchanged copy loads');
  /** @type {[string, Record<string, unknown>][]} */
  const bad = [
    ['newest version', { version: 'latest' }],
    ['newest asset', { url: `https://github.com/microsoft/PAX/releases/${'latest'}/download/${RAW.file}` }],
    ['another repo', { url: `https://github.com/contoso/PAX/releases/download/${RAW.tag}/${RAW.file}` }],
    ['another tag', { url: `https://github.com/microsoft/PAX/releases/download/purview-v0.0.1/${RAW.file}` }],
    ['plain http', { url: RAW.url.replace('https:', 'http:') }],
    ['upper-case hash', { sha256: RAW.sha256.toUpperCase() }],
    ['short hash', { sha256: RAW.sha256.slice(1) }],
    ['no hash', { sha256: undefined }],
    ['not a script', { file: 'PAX.zip', url: `https://github.com/microsoft/PAX/releases/download/${RAW.tag}/PAX.zip` }],
    ['a path', { file: '../PAX.ps1', url: `https://github.com/microsoft/PAX/releases/download/${RAW.tag}/../PAX.ps1` }],
    ['size as text', { size: String(RAW.size) }],
    ['no size', { size: undefined }],
  ];
  for (const [name, change] of bad) {
    const file = releaseFile(dir, name.replace(/\W+/g, '-'), change);
    assert.throws(() => loadRelease(file), { message: `${file} doesn't pin a PAX release.` }, name);
  }
});

test('sha256: lower-case hex of the bytes', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('ensurePax: saves a download whose SHA-256 matches under AIInOne\\pax\\<version>', async (t) => {
  const tmp = tempDir(t);
  const body = 'Write-Output "PAX"\r\n';
  const release = releaseFor(body);
  const { fetch, calls } = fakeFetch(body);
  const got = await ensurePax({ release, fetch, env: { LOCALAPPDATA: tmp } });
  const path = paxFile(tmp, release);
  assert.deepEqual(got, { path, version: release.version, sha256: release.sha256, downloaded: true });
  assert.equal(readFileSync(path, 'utf8'), body, 'saved byte for byte');
  assert.deepEqual(readdirSync(join(tmp, 'AIInOne', 'pax', release.version)), [release.file], 'no partial download is left');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, release.url);
  assert.equal(calls[0].init?.redirect, 'follow', "GitHub's asset links redirect");
});

test("ensurePax: refuses a download whose SHA-256 doesn't match, and saves nothing", async (t) => {
  const tmp = tempDir(t);
  const release = releaseFor('PAX as tested');
  const { fetch } = fakeFetch('PAX, changed');
  const err = await rejection(ensurePax({ release, fetch, env: { LOCALAPPDATA: tmp } }));
  assert.equal(
    err.message,
    `The PAX file from ${release.url} isn't the one this installer was tested with (SHA-256 ${sha256(Buffer.from('PAX, changed'))}, expected ${release.sha256}), so it wasn't saved or run.`,
  );
  assert.deepEqual(readdirSync(tmp), [], 'not even a folder is left');
});

test('ensurePax: by default downloads the pinned release and holds it to the pinned hash', async (t) => {
  const tmp = tempDir(t);
  const { fetch, calls } = fakeFetch('not PAX');
  const err = await rejection(ensurePax({ fetch, env: { LOCALAPPDATA: tmp } }));
  assert.deepEqual(
    calls.map((c) => c.url),
    [PINNED.url],
  );
  assert.match(err.message, new RegExp(`expected ${PINNED.sha256}\\), so it wasn't saved or run\\.$`));
  assert.equal(existsSync(paxFile(tmp, PINNED)), false);
});

test('ensurePax: reuses a copy whose SHA-256 matches, without downloading it again', async (t) => {
  const tmp = tempDir(t);
  const body = 'PAX as tested';
  const release = releaseFor(body);
  const path = paxFile(tmp, release);
  mkdirSync(join(tmp, 'AIInOne', 'pax', release.version), { recursive: true });
  writeFileSync(path, body);
  const { fetch, calls } = fakeFetch(new Error('no network in this test'));
  const got = await ensurePax({ release, fetch, env: { LOCALAPPDATA: tmp } });
  assert.deepEqual(got, { path, version: release.version, sha256: release.sha256, downloaded: false });
  assert.equal(calls.length, 0);
});

test("ensurePax: doesn't trust a copy that was changed, and replaces it with the pinned file", async (t) => {
  const tmp = tempDir(t);
  const body = 'PAX as tested';
  const release = releaseFor(body);
  const path = paxFile(tmp, release);
  mkdirSync(join(tmp, 'AIInOne', 'pax', release.version), { recursive: true });
  writeFileSync(path, 'PAX, edited on this PC');
  writeFileSync(`${path}.download`, 'half a file from an earlier try');
  const { fetch, calls } = fakeFetch(body);
  const got = await ensurePax({ release, fetch, env: { LOCALAPPDATA: tmp } });
  assert.equal(got.downloaded, true);
  assert.equal(calls.length, 1);
  assert.equal(readFileSync(path, 'utf8'), body);
  assert.deepEqual(readdirSync(join(tmp, 'AIInOne', 'pax', release.version)), [release.file]);
});

test("ensurePax: a changed copy isn't trusted, and a download that doesn't match doesn't replace it", async (t) => {
  const tmp = tempDir(t);
  const release = releaseFor('PAX as tested');
  const path = paxFile(tmp, release);
  mkdirSync(join(tmp, 'AIInOne', 'pax', release.version), { recursive: true });
  writeFileSync(path, 'PAX, edited on this PC');
  const { fetch, calls } = fakeFetch('PAX, changed on the way');
  const err = await rejection(ensurePax({ release, fetch, env: { LOCALAPPDATA: tmp } }));
  assert.equal(calls.length, 1, 'the changed copy sent it to download again');
  assert.match(err.message, /isn't the one this installer was tested with/);
  assert.equal(readFileSync(path, 'utf8'), 'PAX, edited on this PC', 'the bad download was not written');
  assert.deepEqual(readdirSync(join(tmp, 'AIInOne', 'pax', release.version)), [release.file]);
});

test('ensurePax: says what GitHub answered, and how to get the file by hand', async (t) => {
  const tmp = tempDir(t);
  const { fetch } = fakeFetch('Not Found', 404);
  const err = await rejection(ensurePax({ release: PINNED, fetch, env: { LOCALAPPDATA: tmp } }));
  assert.equal(
    err.message,
    `Couldn't download PAX ${PINNED.version}: GitHub answered 404. If this PC can't reach GitHub, download ${PINNED.file} from ${PINNED.releaseUrl}, save it as ${paxFile(tmp, PINNED)} and run the installer again.`,
  );
  assert.deepEqual(readdirSync(tmp), []);
});

test("ensurePax: says why it couldn't reach GitHub, and how to get the file by hand", async (t) => {
  const tmp = tempDir(t);
  const { fetch } = fakeFetch(new Error('getaddrinfo ENOTFOUND github.com'));
  const err = await rejection(ensurePax({ release: PINNED, fetch, env: { LOCALAPPDATA: tmp } }));
  assert.equal(
    err.message,
    `Couldn't download PAX ${PINNED.version}: getaddrinfo ENOTFOUND github.com. If this PC can't reach GitHub, download ${PINNED.file} from ${PINNED.releaseUrl}, save it as ${paxFile(tmp, PINNED)} and run the installer again.`,
  );
  assert.deepEqual(readdirSync(tmp), []);
});

test('ensurePax: needs LOCALAPPDATA, and downloads nothing without it', async () => {
  const { fetch, calls } = fakeFetch('PAX');
  const err = await rejection(ensurePax({ release: releaseFor('PAX'), fetch, env: {} }));
  assert.equal(err.message, 'LOCALAPPDATA is not set. The PAX setup runs on Windows.');
  assert.equal(calls.length, 0);
});

/**
 * What PowerShell 7 reports on a Windows PC that has everything.
 * @param {Partial<Probe>} [over]
 * @returns {Probe}
 */
function probeOf(over = {}) {
  const dir = 'C:\\Users\\alex\\AppData\\Local\\Programs\\Python\\Python312';
  return {
    version: '7.4.6',
    edition: 'Core',
    languageMode: 'FullLanguage',
    executionPolicy: 'RemoteSigned',
    policies: { MachinePolicy: 'Undefined', UserPolicy: 'Undefined', Process: 'Undefined', CurrentUser: 'Undefined', LocalMachine: 'RemoteSigned' },
    isWindows: true,
    os: 'Microsoft Windows NT 10.0.26100.0',
    sid: 'S-1-5-21-1000000001-1000000002-1000000003-1001',
    user: 'CONTOSO\\alex',
    timeZone: 'GMT Standard Time',
    pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    python: { version: '3.12.4', major: 3, minor: 12, exe: `${dir}\\python.exe`, dir },
    pythonOlder: null,
    winget: true,
    scheduledTasks: true,
    certificates: true,
    ...over,
  };
}

/**
 * A probe whose execution policy is `policy`, set at `scope` and nowhere else.
 * @param {string} policy
 * @param {string} scope
 */
function withPolicy(policy, scope) {
  /** @type {Record<string, string>} */
  const policies = { MachinePolicy: 'Undefined', UserPolicy: 'Undefined', Process: 'Undefined', CurrentUser: 'Undefined', LocalMachine: 'Undefined' };
  policies[scope] = policy;
  return probeOf({ executionPolicy: policy, policies });
}

/** @param {Prereq[]} rows @param {string} id */
function row(rows, id) {
  const r = rows.find((x) => x.id === id);
  assert.ok(r, `no ${id} row`);
  return r;
}

/** Each row's status, by id. @param {Prereq[]} rows */
const statuses = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.status]));

test('pcRows: a Windows PC with everything meets every row', () => {
  const p = probeOf();
  const rows = pcRows({ probe: p }, 'linux');
  assert.deepEqual(
    rows.map((r) => r.id),
    ['windows', 'pwsh', 'execution-policy', 'python', 'task-scheduler', 'certificate'],
  );
  assert.deepEqual(statuses(rows), {
    windows: 'met',
    pwsh: 'met',
    'execution-policy': 'met',
    python: 'met',
    'task-scheduler': 'met',
    certificate: 'met',
  });
  assert.equal(row(rows, 'windows').detail, 'Microsoft Windows NT 10.0.26100.0', "the probe's answer counts, not the platform");
  assert.equal(row(rows, 'pwsh').detail, 'PowerShell 7.4.6');
  assert.equal(row(rows, 'execution-policy').detail, "PowerShell's execution policy is RemoteSigned");
  assert.equal(row(rows, 'python').detail, `Python 3.12.4 (${p.python?.exe})`);
  assert.equal(row(rows, 'task-scheduler').detail, 'Available.');
  assert.equal(row(rows, 'certificate').detail, 'New-SelfSignedCertificate is available.');
  assert.deepEqual(
    rows.filter((r) => r.optional).map((r) => r.id),
    ['certificate'],
    'a client secret stands in for the certificate',
  );
  for (const r of rows) assert.ok(r.label && r.neededFor && r.howTo, `${r.id} explains itself`);
});

test("pcRows: without PowerShell 7 the rest can't be checked", () => {
  const error = "PowerShell 7 isn't installed (pwsh wasn't found).";
  const rows = pcRows({ error }, 'win32');
  assert.deepEqual(statuses(rows), {
    windows: 'met',
    pwsh: 'missing',
    'execution-policy': 'unknown',
    python: 'unknown',
    'task-scheduler': 'unknown',
    certificate: 'unknown',
  });
  assert.equal(row(rows, 'windows').detail, 'Windows');
  assert.equal(row(rows, 'pwsh').detail, "PowerShell 7 isn't installed.");
  assert.equal(row(rows, 'pwsh').howTo, `Install PowerShell 7: ${PWSH_URL}`);
  for (const id of ['execution-policy', 'python', 'task-scheduler', 'certificate']) {
    assert.equal(row(rows, id).detail, `Couldn't check: ${error}`, id);
  }
  assert.equal(row(rows, 'execution-policy').howTo, 'Allow local scripts (RemoteSigned) for your account, or ask IT.');
});

test("pcRows: a check that failed another way leaves PowerShell unknown, not missing", () => {
  const error = "PowerShell 7 couldn't check this PC: Access is denied.";
  const rows = pcRows({ error }, 'win32');
  assert.equal(row(rows, 'pwsh').status, 'unknown');
  assert.equal(row(rows, 'pwsh').detail, `Couldn't check: ${error}`);
});

test('pcRows: PowerShell older than 7 is too old', () => {
  for (const version of ['5.1.22621.4391', '6.2.7']) {
    const rows = pcRows({ probe: probeOf({ version, edition: version.startsWith('5') ? 'Desktop' : 'Core' }) }, 'win32');
    assert.equal(row(rows, 'pwsh').status, 'missing', version);
    assert.equal(row(rows, 'pwsh').detail, `PowerShell ${version} is too old.`);
  }
  assert.equal(row(pcRows({ probe: probeOf({ version: '7.5.0' }) }, 'win32'), 'pwsh').detail, 'PowerShell 7.5.0');
});

test('pcRows: no Python, or only one older than 3.10', () => {
  const none = pcRows({ probe: probeOf({ python: null }) }, 'win32');
  assert.equal(row(none, 'python').status, 'missing');
  assert.equal(row(none, 'python').detail, 'Not found.');
  assert.equal(
    row(none, 'python').howTo,
    `The installer offers to install Python 3.13 for your account with winget. Or install it from ${PYTHON_URL}`,
  );
  const old = pcRows({ probe: probeOf({ python: null, pythonOlder: '3.8.10', winget: false }) }, 'win32');
  assert.equal(row(old, 'python').status, 'missing');
  assert.equal(row(old, 'python').detail, 'Only Python 3.8.10 was found, which is too old.');
  assert.equal(row(old, 'python').howTo, `Install it from ${PYTHON_URL}`, 'no winget, no offer');
});

test('pcRows: AllSigned or Restricted fails the execution policy row, and says who can change it', () => {
  const local = row(pcRows({ probe: withPolicy('AllSigned', 'LocalMachine') }, 'win32'), 'execution-policy');
  assert.equal(local.status, 'missing');
  assert.equal(
    local.detail,
    "PowerShell's execution policy is AllSigned (LocalMachine scope). With AllSigned, only signed scripts can run, so the scheduled task couldn't run the refresh script. The installer doesn't change the policy for you.",
  );
  assert.match(local.howTo, /run this yourself in PowerShell 7.*Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned/);

  const user = row(pcRows({ probe: withPolicy('Restricted', 'CurrentUser') }, 'win32'), 'execution-policy');
  assert.equal(user.status, 'missing');
  assert.match(user.detail, /^PowerShell's execution policy is Restricted \(CurrentUser scope\)\. With Restricted, scripts can't run,/);

  const gpo = row(pcRows({ probe: withPolicy('AllSigned', 'MachinePolicy') }, 'win32'), 'execution-policy');
  assert.equal(gpo.status, 'missing');
  assert.equal(
    gpo.detail,
    "PowerShell's execution policy is AllSigned, set by Group Policy. With AllSigned, only signed scripts can run, so the scheduled task couldn't run the refresh script. The installer doesn't change the policy or work round it.",
  );
  assert.equal(gpo.howTo, 'Ask IT to allow local scripts (RemoteSigned) for your account on this PC, or run the installer on a PC or server where they are allowed.');
  assert.doesNotMatch(gpo.howTo, /Set-ExecutionPolicy/, 'Group Policy wins over anything the user sets');

  const userGpo = row(pcRows({ probe: withPolicy('Restricted', 'UserPolicy') }, 'win32'), 'execution-policy');
  assert.match(userGpo.detail, /^PowerShell's execution policy is Restricted, set by Group Policy\./);
});

test('pcRows: the scope that decides is the first one PowerShell reads that sets a policy', () => {
  const p = probeOf({
    executionPolicy: 'AllSigned',
    policies: { MachinePolicy: 'Undefined', UserPolicy: 'Undefined', Process: 'Undefined', CurrentUser: 'AllSigned', LocalMachine: 'RemoteSigned' },
  });
  assert.match(row(pcRows({ probe: p }, 'win32'), 'execution-policy').detail, /^PowerShell's execution policy is AllSigned \(CurrentUser scope\)\./);
});

test('pcRows: RemoteSigned and Unrestricted let the script run', () => {
  for (const policy of ['RemoteSigned', 'Unrestricted']) {
    const r = row(pcRows({ probe: withPolicy(policy, 'LocalMachine') }, 'win32'), 'execution-policy');
    assert.equal(r.status, 'met', policy);
    assert.equal(r.detail, `PowerShell's execution policy is ${policy}`);
  }
});

test("pcRows: when an application control policy limits PowerShell, the rest can't be checked", () => {
  const rows = pcRows({ probe: { languageMode: 'ConstrainedLanguage' } }, 'win32');
  assert.deepEqual(statuses(rows), {
    windows: 'met',
    pwsh: 'met',
    'execution-policy': 'missing',
    python: 'unknown',
    'task-scheduler': 'unknown',
    certificate: 'unknown',
  });
  assert.equal(row(rows, 'pwsh').detail, 'Installed.');
  assert.equal(
    row(rows, 'execution-policy').detail,
    "PowerShell runs in ConstrainedLanguage mode on this PC. An application control policy (such as App Control for Business or AppLocker) limits PowerShell here, so the scheduled task's script would fail.",
  );
  assert.match(row(rows, 'execution-policy').howTo, /^Ask IT whether the PAX refresh can run on this PC/);
  assert.equal(row(rows, 'python').detail, "Couldn't check: PowerShell limits what it can read on this PC.");
});

test('pcRows: a PC that isn\'t Windows', () => {
  const linux = pcRows({ probe: probeOf({ isWindows: false, os: 'Ubuntu 24.04.1 LTS', sid: null, user: null }) }, 'win32');
  assert.equal(row(linux, 'windows').status, 'missing');
  assert.equal(row(linux, 'windows').detail, 'This is Ubuntu 24.04.1 LTS, not Windows.', "the probe's answer counts, not the platform");
  const mac = pcRows({ error: "PowerShell 7 isn't installed (pwsh wasn't found)." }, 'darwin');
  assert.equal(row(mac, 'windows').status, 'missing');
  assert.equal(row(mac, 'windows').detail, 'This is darwin, not Windows.');
});

test("pcRows: Task Scheduler's commands or New-SelfSignedCertificate missing", () => {
  const rows = pcRows({ probe: probeOf({ scheduledTasks: false, certificates: false }) }, 'win32');
  assert.equal(row(rows, 'task-scheduler').status, 'missing');
  assert.equal(row(rows, 'task-scheduler').detail, "Register-ScheduledTask isn't available.");
  assert.equal(row(rows, 'certificate').status, 'missing');
  assert.equal(row(rows, 'certificate').detail, "New-SelfSignedCertificate isn't available.");
  assert.equal(row(rows, 'certificate').optional, true);
});

/**
 * A stand-in for PowerShell 7. Each probe answers with the next of `probes` (the last repeats): an
 * Error is thrown, a result with a `code` is returned as it is, and a probe comes back as PowerShell
 * would send it. The Python install answers `install`. Anything else fails the test.
 * @param {(Probe | Error | PwshResult)[]} probes
 * @param {{ exitCode: number }} [install]
 */
function fakePwsh(probes, install = { exitCode: 0 }) {
  /** @type {PwshRun[]} */
  const runs = [];
  let n = 0;
  /** @type {import('../src/pax/ps.js').RunPwsh} */
  const runPwsh = async (run) => {
    runs.push(run);
    if (run.command === PROBE) {
      const next = probes[Math.min(n++, probes.length - 1)];
      if (next instanceof Error) throw next;
      if ('code' in next) return next;
      return { code: 0, stdout: '', stderr: '', result: next };
    }
    if (run.script === INSTALL_PYTHON_SCRIPT) return { code: 0, stdout: '', stderr: '', result: install };
    throw new Error(`The test didn't expect this PowerShell run: ${JSON.stringify(run).slice(0, 200)}`);
  };
  return { runPwsh, runs };
}

/** @param {PwshRun} run */
const kind = (run) => (run.command === PROBE ? 'probe' : run.script === INSTALL_PYTHON_SCRIPT ? 'install Python' : 'something else');

/**
 * Nothing the installer ran changes the execution policy or works round it.
 * @param {PwshRun[]} runs
 */
function assertNoBypass(runs) {
  for (const run of runs) {
    const text = [run.command, run.script, run.file, ...(run.args ?? [])].filter(Boolean).join('\n');
    assert.doesNotMatch(text, /(^|\s)-ExecutionPolicy\b/im);
    assert.doesNotMatch(text, /Set-ExecutionPolicy/i);
    assert.doesNotMatch(text, /\bBypass\b/i);
    assert.ok(!Object.keys(run.env ?? {}).some((k) => k.toLowerCase() === 'psexecutionpolicypreference'));
    assert.notEqual(kind(run), 'something else');
  }
}

/**
 * What ensurePaxTools works with: a fake UI and PowerShell, a record, and LOCALAPPDATA in a temp folder.
 * @param {import('node:test').TestContext} t
 * @param {{ yes?: boolean, answers?: any[], probes?: (Probe | Error | PwshResult)[], install?: { exitCode: number }, pax?: Partial<import('../src/config.js').PaxConfig> }} [o]
 */
function paxCtx(t, o = {}) {
  const dir = tempDir(t);
  const { ui, text, asked } = fakeUi({ yes: o.yes, answers: o.answers });
  const config = emptyConfig();
  if (o.pax) config.pax = { ...emptyPax(), ...o.pax };
  const { runPwsh, runs } = fakePwsh(o.probes ?? [probeOf()], o.install);
  let saves = 0;
  const ctx = {
    ui,
    config,
    save: () => {
      saves++;
    },
    runPwsh,
    env: { LOCALAPPDATA: dir },
  };
  return { ctx, config, dir, text, asked, runs, saves: () => saves };
}

test('checkPc: asks PowerShell 7 with -Command, which the execution policy doesn\'t govern', async () => {
  const { runPwsh, runs } = fakePwsh([probeOf()]);
  assert.deepEqual(await checkPc({ runPwsh }), { probe: probeOf() });
  assert.deepEqual(runs, [{ command: PROBE, timeoutMs: 2 * 60_000 }]);
  assertNoBypass(runs);
});

test('checkPc: a check that fails is an answer, not an error', async () => {
  const missing = fakePwsh([new Error("PowerShell 7 isn't installed (pwsh wasn't found).")]);
  assert.deepEqual(await checkPc(missing), { error: "PowerShell 7 isn't installed (pwsh wasn't found)." });
  const denied = fakePwsh([{ code: 1, stdout: 'ignored', stderr: '\r\n  Access is denied.\r\nAt line:1' }]);
  assert.deepEqual(await checkPc(denied), { error: "PowerShell 7 couldn't check this PC: Access is denied." });
  const silent = fakePwsh([{ code: 3, stdout: '', stderr: '' }]);
  assert.deepEqual(await checkPc(silent), { error: "PowerShell 7 couldn't check this PC: exit code 3" });
  const odd = fakePwsh([{ code: 0, stdout: 'hello', stderr: '', result: { version: '7.4.6' } }]);
  assert.deepEqual(await checkPc(odd), { error: "PowerShell 7 couldn't check this PC: hello" });
});

test('ensurePaxTools: records what the task needs, then downloads PAX and checks its hash', async (t) => {
  const { ctx, config, dir, text, runs, saves } = paxCtx(t);
  const body = 'PAX for this test';
  const release = releaseFor(body);
  const { fetch, calls } = fakeFetch(body);
  const p = await ensurePaxTools(ctx, { fetch, release });
  assert.deepEqual(p, probeOf());
  const pax = config.pax;
  assert.ok(pax);
  assert.equal(pax.pythonDir, p.python?.dir);
  assert.equal(pax.pwsh, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.equal(pax.userSid, 'S-1-5-21-1000000001-1000000002-1000000003-1001');
  assert.equal(pax.userName, 'CONTOSO\\alex');
  assert.equal(pax.timeZone, 'GMT Standard Time');
  assert.equal(pax.version, release.version);
  assert.equal(pax.script, paxFile(dir, release));
  assert.equal(pax.sha256, release.sha256);
  assert.equal(readFileSync(paxFile(dir, release), 'utf8'), body);
  assert.equal(saves(), 1);
  assert.equal(calls.length, 1);
  assert.match(text(), /PowerShell 7\.4\.6\. PowerShell's execution policy is RemoteSigned/);
  assert.match(text(), /Python 3\.12\.4/);
  assert.match(text(), new RegExp(`Downloaded PAX ${esc(release.version)}; its SHA-256 matches the pinned release`));
  assert.deepEqual(runs.map(kind), ['probe']);
  assertNoBypass(runs);

  await ensurePaxTools(ctx, { fetch, release });
  assert.equal(calls.length, 1, 'the second run uses the file it checked');
  assert.match(text(), new RegExp(`PAX ${esc(release.version)} is here, and its SHA-256 matches the pinned release`));
  assert.equal(saves(), 2);
});

test('ensurePaxTools: installs Python with winget for the user only, once they say yes', async (t) => {
  const { ctx, config, runs, text, asked } = paxCtx(t, { probes: [probeOf({ python: null }), probeOf()], answers: [true] });
  const body = 'PAX for this test';
  const { fetch } = fakeFetch(body);
  await ensurePaxTools(ctx, { fetch, release: releaseFor(body) });
  assert.deepEqual(asked, ['Install Python 3.13 for your account only, with winget?']);
  assert.match(text(), /Python 3\.10 or later isn't installed\. PAX needs it to roll the audit log up\./);
  assert.deepEqual(runs.map(kind), ['probe', 'install Python', 'probe'], 'it looks for Python again after installing it');
  const install = runs[1];
  assert.deepEqual(install, { script: INSTALL_PYTHON_SCRIPT, timeoutMs: 15 * 60_000 });
  assert.match(install.script ?? '', /^& winget install --id Python\.Python\.3\.13 --exact --source winget --scope user --silent /m);
  assert.doesNotMatch(install.script ?? '', /--scope machine|-Verb RunAs|Start-Process/i, 'no admin rights asked for');
  assert.equal(config.pax?.pythonDir, probeOf().python?.dir);
  assertNoBypass(runs);
});

test('ensurePaxTools: when the user says no, nothing is installed and it says how to get Python', async (t) => {
  const { ctx, config, runs, text, asked } = paxCtx(t, { probes: [probeOf({ python: null })], answers: [false] });
  const { fetch, calls } = fakeFetch(new Error('not reached'));
  const err = await rejection(ensurePaxTools(ctx, { fetch, release: PINNED }));
  assert.equal(err.message, `Python 3.10 or later isn't installed. Install it for your account from ${PYTHON_URL}, then run the installer again.`);
  assert.deepEqual(asked, ['Install Python 3.13 for your account only, with winget?']);
  assert.deepEqual(runs.map(kind), ['probe'], 'no install script ran');
  assert.equal(calls.length, 0, "PAX isn't downloaded");
  assert.equal(config.pax?.script, undefined);
  assert.match(text(), /✗ Python 3\.10 or later isn't installed/);
  assertNoBypass(runs);
});

test("ensurePaxTools: says when winget fails, and stops when there's still no Python", async (t) => {
  const { ctx, runs, text } = paxCtx(t, { probes: [probeOf({ python: null })], answers: [true], install: { exitCode: 1603 } });
  const err = await rejection(ensurePaxTools(ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED }));
  assert.match(text(), /winget finished with exit code 1603\./);
  assert.equal(err.message, `Python 3.10 or later isn't installed. Install it for your account from ${PYTHON_URL}, then run the installer again.`);
  assert.deepEqual(runs.map(kind), ['probe', 'install Python', 'probe']);
  assertNoBypass(runs);
});

test("ensurePaxTools: with --yes it doesn't install Python, and says how to be offered it", async (t) => {
  const { ctx, runs, asked } = paxCtx(t, { yes: true, probes: [probeOf({ python: null })] });
  const err = await rejection(ensurePaxTools(ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED }));
  assert.equal(
    err.message,
    `Python 3.10 or later isn't installed. Install it for your account from ${PYTHON_URL}, then run the installer again. Or run the installer without --yes, and it offers to install Python with winget.`,
  );
  assert.deepEqual(asked, []);
  assert.deepEqual(runs.map(kind), ['probe']);
});

test("ensurePaxTools: without winget there's no offer, and an old Python is named", async (t) => {
  const { ctx, runs, asked, text } = paxCtx(t, { probes: [probeOf({ python: null, pythonOlder: '3.9.13', winget: false })] });
  const err = await rejection(ensurePaxTools(ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED }));
  assert.match(text(), /Python 3\.9\.13 is too old: PAX's rollup needs Python 3\.10 or later\./);
  assert.equal(err.message, `Python 3.10 or later isn't installed. Install it for your account from ${PYTHON_URL}, then run the installer again.`);
  assert.deepEqual(asked, []);
  assert.deepEqual(runs.map(kind), ['probe']);
});

test("ensurePaxTools: stops at AllSigned or Restricted, and doesn't change the policy or work round it", async (t) => {
  /** @type {[string, string, string][]} */
  const cases = [
    ['AllSigned', 'LocalMachine', "PowerShell's execution policy is AllSigned (LocalMachine scope)"],
    ['Restricted', 'CurrentUser', "PowerShell's execution policy is Restricted (CurrentUser scope)"],
    ['AllSigned', 'MachinePolicy', "PowerShell's execution policy is AllSigned, set by Group Policy"],
    ['Restricted', 'UserPolicy', "PowerShell's execution policy is Restricted, set by Group Policy"],
  ];
  for (const [policy, scope, title] of cases) {
    const { ctx, config, runs, text, saves } = paxCtx(t, { probes: [withPolicy(policy, scope)] });
    const { fetch, calls } = fakeFetch(new Error('not reached'));
    const err = await rejection(ensurePaxTools(ctx, { fetch, release: PINNED }));
    assert.ok(err.message.startsWith(`${title}. With ${policy}, `), err.message);
    if (scope.endsWith('Policy')) {
      assert.match(err.message, /Ask IT to allow local scripts \(RemoteSigned\)/);
      assert.doesNotMatch(err.message, /Set-ExecutionPolicy/);
    } else {
      assert.match(err.message, /run this yourself in PowerShell 7, then run the installer again: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned/);
    }
    assert.match(text(), new RegExp(`✗ ${esc(title)}`));
    assert.deepEqual(runs.map(kind), ['probe'], `${policy} at ${scope}: nothing else ran`);
    assertNoBypass(runs);
    assert.equal(calls.length, 0);
    assert.equal(config.pax?.script, undefined);
    assert.equal(saves(), 0);
  }
});

test('ensurePaxTools: stops when an application control policy limits PowerShell', async (t) => {
  const { ctx, runs } = paxCtx(t, { probes: [{ languageMode: 'ConstrainedLanguage' }] });
  const err = await rejection(ensurePaxTools(ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED }));
  assert.equal(
    err.message,
    "PowerShell runs in ConstrainedLanguage mode on this PC. An application control policy (such as App Control for Business or AppLocker) limits PowerShell here, so the scheduled task's script would fail. Ask IT whether the PAX refresh can run on this PC, or run the installer on a PC or server where PowerShell runs in full language mode.",
  );
  assert.deepEqual(runs.map(kind), ['probe']);
});

test("ensurePaxTools: stops on a PC that isn't Windows", async (t) => {
  const { ctx } = paxCtx(t, { probes: [probeOf({ isWindows: false, os: 'Ubuntu 24.04.1 LTS', sid: null, user: null })] });
  const err = await rejection(ensurePaxTools(ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED }));
  assert.equal(err.message, 'The PAX route runs on Windows. This is Ubuntu 24.04.1 LTS. Run the installer on a Windows PC or server.');
});

test('ensurePaxTools: stops when PowerShell is older than 7', async (t) => {
  const { ctx } = paxCtx(t, { probes: [probeOf({ version: '6.2.7' })] });
  const err = await rejection(ensurePaxTools(ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED }));
  assert.equal(err.message, `PowerShell 6.2.7 is too old. Install PowerShell 7 from ${PWSH_URL}, then run the installer again.`);
});

test("ensurePaxTools: stops without Task Scheduler's PowerShell commands", async (t) => {
  const { ctx } = paxCtx(t, { probes: [probeOf({ scheduledTasks: false })] });
  const err = await rejection(ensurePaxTools(ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED }));
  assert.equal(err.message, "Task Scheduler's PowerShell commands aren't available. They come with Windows. Ask IT whether they're blocked on this PC.");
});

test('ensurePaxTools: says how to install PowerShell 7 when it is missing, and passes other failures on', async (t) => {
  const missing = paxCtx(t, { probes: [new Error("PowerShell 7 isn't installed (pwsh wasn't found).")] });
  const err = await rejection(ensurePaxTools(missing.ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED }));
  assert.equal(err.message, `PowerShell 7 isn't installed. Install it from ${PWSH_URL}, then run the installer again.`);
  assert.match(missing.text(), /✗ PowerShell 7 isn't installed/);

  const denied = paxCtx(t, { probes: [{ code: 1, stdout: '', stderr: 'Access is denied.' }] });
  const err2 = await rejection(ensurePaxTools(denied.ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED }));
  assert.equal(err2.message, "PowerShell 7 couldn't check this PC: Access is denied.");

  const boom = new Error('pwsh took longer than 2 minutes');
  const slow = paxCtx(t, { probes: [boom] });
  assert.equal(await rejection(ensurePaxTools(slow.ctx, { fetch: fakeFetch('PAX').fetch, release: PINNED })), boom);
});

test('ensurePaxTools: warns when the task will run as another account', async (t) => {
  const body = 'PAX for this test';
  const moved = paxCtx(t, { pax: { userSid: 'S-1-5-21-1000000001-1000000002-1000000003-1002', userName: 'CONTOSO\\sam' } });
  await ensurePaxTools(moved.ctx, { fetch: fakeFetch(body).fetch, release: releaseFor(body) });
  assert.match(
    moved.text(),
    /The scheduled task ran as CONTOSO\\sam\. It now runs as CONTOSO\\alex, with a new certificate in that account's store\./,
  );
  assert.equal(moved.config.pax?.userSid, 'S-1-5-21-1000000001-1000000002-1000000003-1001');
  assert.equal(moved.config.pax?.userName, 'CONTOSO\\alex');

  const same = paxCtx(t, { pax: { userSid: 'S-1-5-21-1000000001-1000000002-1000000003-1001', userName: 'CONTOSO\\alex' } });
  await ensurePaxTools(same.ctx, { fetch: fakeFetch(body).fetch, release: releaseFor(body) });
  assert.doesNotMatch(same.text(), /The scheduled task ran as/);
});

test("ensurePaxTools: a PAX download that doesn't match isn't recorded", async (t) => {
  const { ctx, config, dir, saves } = paxCtx(t);
  const release = releaseFor('PAX as tested');
  const err = await rejection(ensurePaxTools(ctx, { fetch: fakeFetch('PAX, changed').fetch, release }));
  assert.match(err.message, /isn't the one this installer was tested with/);
  assert.equal(config.pax?.script, undefined);
  assert.equal(config.pax?.sha256, undefined);
  assert.equal(config.pax?.version, undefined);
  assert.equal(saves(), 0);
  assert.equal(existsSync(paxFile(dir, release)), false);
});
