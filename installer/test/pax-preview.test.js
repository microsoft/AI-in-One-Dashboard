// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { emptyConfig, emptyPax } from '../src/config.js';
import { defaultLocalFolder, paxDir, runDir, secretPath, wrapperPath } from '../src/pax/names.js';
import { paxPreview } from '../src/pax/preview.js';
import { loadRelease } from '../src/pax/release.js';
import { buildPaxModel, INTERACTIONS_PARAMETER, ORG_DATA_PARAMETER } from '../src/pax/report.js';
import { INSTALLER_VERSION, loadTemplate, taskXml } from '../src/pax/wrapper.js';
import { DEFAULT_SOURCE_DIR, findPaxModelTemplate } from '../src/sources.js';
import { AGENT365_PARAMETER, loadTemplateModel, mParameter } from '../src/transform/model.js';
import { loadTemplateReport, pbir } from '../src/transform/report.js';
import { fakeUi, realSources } from './fakes.js';

/** @typedef {import('../src/config.js').InstallConfig} InstallConfig */
/** @typedef {import('../src/config.js').PaxConfig} PaxConfig */

/** @param {number} n */
const fake = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const SAMPLE_SITE = 'https://your-tenant.sharepoint.com/sites/AIinOne';
const SAMPLE_FOLDER_URL = `${SAMPLE_SITE}/Shared%20Documents/AI%20in%20One`;
const SAMPLE_SID = 'S-1-5-21-1000000000-1000000000-1000000000-1001';
const SAMPLE_PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const SAMPLE_LOCALAPPDATA = 'C:\\Users\\you\\AppData\\Local';
const TASK_FILES = ['Run-AIO-PAX.ps1', 'task.xml', 'graph-permissions.txt'];
/** The preview's clock: noon, so the 02:00 run is tomorrow's. */
const noon = () => new Date(2026, 5, 1, 12, 0, 0);
const release = loadRelease();

/** The SharePoint edition's template, found the way the installer finds it. */
function templateFile() {
  const name = findPaxModelTemplate(DEFAULT_SOURCE_DIR);
  if (!name) assert.fail('The repo root has no .pbit with "PBI-SharePoint" in its name.');
  return join(DEFAULT_SOURCE_DIR, name);
}

/** @type {import('../src/transform/model.js').ModelBim | undefined} */
let templateModel;
/** The template's model, read once since the .pbit is large. */
const template = () => (templateModel ??= loadTemplateModel(templateFile()));

/** @type {import('../src/transform/report.js').ReportParts | undefined} */
let templateReport;
const reportParts = () => (templateReport ??= loadTemplateReport(templateFile()));

/** @param {string | string[]} e */
const mText = (e) => (Array.isArray(e) ? e.join('\n') : String(e));

/** A Power Query expression's M text. @param {import('../src/transform/model.js').ModelBim['model']} model @param {string} name */
function expressionOf(model, name) {
  const e = model.expressions?.find((x) => x.name === name);
  if (!e) assert.fail(`The model has no expression "${name}".`);
  return mText(e.expression);
}

/** What a preview with the model writes, in order. */
const withModel = () => [...TASK_FILES, 'model.bim', 'report/definition.pbir', ...reportParts().map((p) => `report/${p.path}`)];

/** The repo's sources as if it had no SharePoint template. */
const noTemplate = () => ({ ...realSources(), paxModelFile: undefined });

/**
 * An install record on the PAX route. Without `pax` it has no PAX setup yet, as before the first install.
 * @param {Partial<PaxConfig>} [pax]
 * @returns {InstallConfig}
 */
function paxConfig(pax) {
  const config = emptyConfig();
  config.target = 'pax';
  if (pax) config.pax = { ...emptyPax(), ...pax };
  return config;
}

/** The output without colours. @param {string} s */
const plain = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');

/** @param {string} value */
const xmlText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The files under a folder, as paths from it with "/" between parts, sorted. @param {string} dir */
const filesIn = (dir) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((p) => statSync(join(dir, p)).isFile())
    .map((p) => p.split(sep).join('/'))
    .sort();

/** task.xml's text. It's UTF-16 with a byte order mark; a test below checks the bytes. @param {Buffer} data */
const taskText = (data) => data.toString('utf16le').replace(/^\uFEFF/, '');

/** A PowerShell literal from the script's settings, as a JavaScript value. @param {string} raw */
function literal(raw) {
  if (raw === '$true' || raw === '$false') return raw === '$true';
  if (/^-?\d+$/.test(raw)) return Number(raw);
  const m = /^'((?:[^']|'')*)'$/.exec(raw);
  if (!m) assert.fail(`${raw} isn't a literal the script's settings use.`);
  return m[1].replace(/''/g, "'");
}

/** The settings the script starts from, read from its `$Settings = [ordered]@{ ... }` block. @param {string} script */
function settingsOf(script) {
  const lines = script.split(/\r?\n/);
  const start = lines.indexOf('$Settings = [ordered]@{');
  if (start === -1) assert.fail('The script has no settings block.');
  const end = lines.indexOf('}', start);
  if (end === -1) assert.fail("The script's settings block has no end.");
  /** @type {Record<string, string | number | boolean>} */
  const values = {};
  for (const line of lines.slice(start + 1, end)) {
    const m = /^ {4}([A-Za-z][A-Za-z0-9]*) = (.+)$/.exec(line);
    if (!m) assert.fail(`"${line}" isn't a setting.`);
    values[m[1]] = literal(m[2]);
  }
  return values;
}

/** @type {WeakMap<object, any>} */
const offline = new WeakMap();
/** Makes any network call fail for the rest of the test, once per test. @param {import('node:test').TestContext} t */
function noNetwork(t) {
  if (!offline.has(t)) {
    offline.set(
      t,
      t.mock.method(globalThis, 'fetch', async () => {
        throw new Error('A preview must not use the network.');
      }),
    );
  }
  return offline.get(t);
}

/** A new folder, removed when the test ends. @param {import('node:test').TestContext} t */
function tempDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'aio-pax-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * Runs the preview into a new folder, with %LOCALAPPDATA% in that folder too and no network.
 * @param {import('node:test').TestContext} t
 * @param {{ config?: InstallConfig, sources?: import('../src/sources.js').Sources, env?: NodeJS.ProcessEnv, now?: Date }} [o]
 */
function run(t, o = {}) {
  const root = tempDir(t);
  const fetch = noNetwork(t);
  const ui = fakeUi();
  const outDir = join(root, 'out');
  const env = o.env ?? { LOCALAPPDATA: join(root, 'appdata') };
  const written = paxPreview({ ui: ui.ui, config: o.config ?? paxConfig(), sources: o.sources ?? realSources(), outDir, env, now: o.now ?? noon() });
  /** @param {string} name */
  const bytes = (name) => readFileSync(join(outDir, ...name.split('/')));
  return {
    root,
    outDir,
    written,
    ui,
    fetch,
    /** The paths the script and task use, as the preview works them out. */
    env: { ...env, LOCALAPPDATA: env.LOCALAPPDATA || SAMPLE_LOCALAPPDATA },
    bytes,
    /** @param {string} name */
    text: (name) => bytes(name).toString('utf8'),
    settings: () => settingsOf(bytes('Run-AIO-PAX.ps1').toString('utf8')),
    task: () => taskText(bytes('task.xml')),
    shown: () => plain(ui.text()),
  };
}

test('paxPreview: finds the SharePoint edition template, with its report and the three file parameters', () => {
  assert.equal(realSources().paxModelFile, templateFile());
  assert.ok(reportParts().some((p) => p.path === 'definition/report.json'));
  for (const name of [INTERACTIONS_PARAMETER, ORG_DATA_PARAMETER, AGENT365_PARAMETER]) {
    assert.match(expressionOf(template().model, name), / meta \[IsParameterQuery=true\b/, `The template has no "${name}" parameter.`);
  }
});

test('paxPreview: with no install record, writes the documented files and nothing else, without signing in', (t) => {
  const config = paxConfig();
  const before = structuredClone(config);
  const r = run(t, { config });
  assert.deepEqual(r.written, withModel());
  assert.deepEqual(filesIn(r.outDir), [...r.written].sort());
  for (const name of r.written) assert.ok(statSync(join(r.outDir, ...name.split('/'))).size > 0, `${name} is empty.`);
  assert.deepEqual(readdirSync(r.root), ['out'], 'Nothing is written to %LOCALAPPDATA%.');
  assert.equal(r.fetch.mock.callCount(), 0);
  assert.deepEqual(r.ui.asked, []);
  assert.deepEqual(config, before, 'The install record is left as it was.');
  const shown = r.shown();
  assert.match(shown, /Preview written/);
  assert.ok(shown.includes(r.outDir));
  assert.ok(
    shown.includes(
      'Run-AIO-PAX.ps1 (the script the task "AI in One - PAX refresh" runs), task.xml, graph-permissions.txt, model.bim and the report (report folder), with placeholders where nothing is known yet.',
    ),
  );
});

test("paxPreview: model.bim is the template's model reading the sample folder's files, and the report reads a placeholder model", (t) => {
  const r = run(t);
  const text = r.text('model.bim');
  assert.ok(text.endsWith('}\n'));
  const bim = JSON.parse(text);
  assert.equal(mParameter(bim.model, INTERACTIONS_PARAMETER), `${SAMPLE_FOLDER_URL}/AIO_Interactions.csv`);
  assert.equal(mParameter(bim.model, ORG_DATA_PARAMETER), `${SAMPLE_FOLDER_URL}/AIO_Users.csv`);
  assert.equal(expressionOf(bim.model, AGENT365_PARAMETER), expressionOf(template().model, AGENT365_PARAMETER), 'Agent 365 is off, so its parameter is left as the template has it.');
  const urls = { interactions: `${SAMPLE_FOLDER_URL}/AIO_Interactions.csv`, users: `${SAMPLE_FOLDER_URL}/AIO_Users.csv`, agent365: '' };
  assert.deepEqual(bim, JSON.parse(JSON.stringify(buildPaxModel(template(), urls))));

  const definition = JSON.parse(r.text('report/definition.pbir'));
  assert.deepEqual(definition, pbir(fake(4)));
  assert.equal(definition.datasetReference.byConnection.connectionString, `semanticmodelid=${fake(4)}`);
  for (const p of reportParts()) assert.ok(r.bytes(`report/${p.path}`).equals(p.data), `report/${p.path} isn't the template's.`);
});

test("paxPreview: model.bim reads the record's folder, with its names encoded, and Agent 365's file when it's on", (t) => {
  const config = paxConfig({
    agent365: true,
    site: { url: 'https://contoso.sharepoint.com/sites/AIinOne/', library: 'Reports Library', folder: 'Copilot/AI in One #1' },
  });
  config.semanticModel.id = fake(7);
  const r = run(t, { config });
  assert.deepEqual(r.written, withModel());
  const base = 'https://contoso.sharepoint.com/sites/AIinOne/Reports%20Library/Copilot/AI%20in%20One%20%231';
  const bim = JSON.parse(r.text('model.bim'));
  assert.equal(mParameter(bim.model, INTERACTIONS_PARAMETER), `${base}/AIO_Interactions.csv`);
  assert.equal(mParameter(bim.model, ORG_DATA_PARAMETER), `${base}/AIO_Users.csv`);
  assert.equal(mParameter(bim.model, AGENT365_PARAMETER), `${base}/AIO_Agent365.csv`);
  assert.deepEqual(JSON.parse(r.text('report/definition.pbir')), pbir(fake(7)));
});

test('preview: on the PAX target writes the PAX files rather than the Fabric ones', async (t) => {
  const { preview } = await import('../src/install.js');
  const root = tempDir(t);
  const fetch = noNetwork(t);
  const ui = fakeUi();
  const outDir = join(root, 'out');
  // preview hands its options on as they are, so the files' paths use this %LOCALAPPDATA%.
  const o = { ui: ui.ui, config: paxConfig(), sources: realSources(), outDir, now: noon(), env: { LOCALAPPDATA: join(root, 'appdata') } };
  preview(o);
  assert.deepEqual(filesIn(outDir), withModel().sort());
  assert.deepEqual(readdirSync(root), ['out']);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(ui.asked, []);
});

test('paxPreview: task.xml runs the script with -File as the signed-in user, without Bypass', (t) => {
  const r = run(t, { sources: noTemplate() });
  const xml = r.task();
  assert.doesNotMatch(xml, /Bypass/i);
  assert.doesNotMatch(xml, /ExecutionPolicy/i);
  assert.equal(xml, taskXml({ sid: SAMPLE_SID, pwsh: SAMPLE_PWSH, runAt: '02:00', env: r.env, now: noon() }));
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n'));
  for (const element of [
    '<Date>2026-06-01T12:00:00</Date>',
    '<URI>\\AI in One - PAX refresh</URI>',
    '<StartBoundary>2026-06-02T02:00:00</StartBoundary>',
    `<UserId>${SAMPLE_SID}</UserId>`,
    '<LogonType>InteractiveToken</LogonType>',
    '<RunLevel>LeastPrivilege</RunLevel>',
    `<Command>${SAMPLE_PWSH}</Command>`,
    `<Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -File &quot;${xmlText(wrapperPath(r.env))}&quot;</Arguments>`,
    `<WorkingDirectory>${xmlText(runDir(r.env))}</WorkingDirectory>`,
  ]) {
    assert.ok(xml.includes(element), `task.xml has no ${element}`);
  }
});

test('paxPreview: writes task.xml as UTF-16 with a byte order mark, as its declaration says', (t) => {
  const r = run(t, { sources: noTemplate() });
  const expected = taskXml({ sid: SAMPLE_SID, pwsh: SAMPLE_PWSH, runAt: '02:00', env: r.env, now: noon() });
  assert.ok(expected.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
  const data = r.bytes('task.xml');
  assert.deepEqual([...data.subarray(0, 2)], [0xff, 0xfe], 'task.xml should start with the UTF-16 little-endian byte order mark, as writeTaskXml writes it.');
  assert.equal(data.toString('utf16le'), `\uFEFF${expected}`);
});

test("paxPreview: task.xml starts at the record's time and runs as its account and PowerShell, escaped", (t) => {
  const config = paxConfig({ runAt: '23:30', userSid: 'S-1-5-21-1-2-3-1104', pwsh: 'D:\\Tools & <Shells>\\pwsh.exe' });
  const r = run(t, { config, sources: noTemplate() });
  const xml = r.task();
  assert.ok(xml.includes('<StartBoundary>2026-06-01T23:30:00</StartBoundary>'), 'Later today, since the preview runs at noon.');
  assert.ok(xml.includes('<UserId>S-1-5-21-1-2-3-1104</UserId>'));
  assert.ok(xml.includes('<Command>D:\\Tools &amp; &lt;Shells&gt;\\pwsh.exe</Command>'));
  assert.ok(!xml.includes(SAMPLE_SID));
  assert.ok(!xml.includes(SAMPLE_PWSH));
});

test('paxPreview: with no install record, the script has placeholder IDs and the pinned PAX release', (t) => {
  const r = run(t, { sources: noTemplate() });
  assert.deepEqual(r.settings(), {
    TenantId: fake(0),
    ClientId: fake(1),
    CredentialType: 'certificate',
    CertificateThumbprint: '0'.repeat(40),
    SecretFile: secretPath(r.env),
    SecretExpires: '',
    PaxScript: join(paxDir(release.version, r.env), release.file),
    PaxSha256: release.sha256.toUpperCase(),
    PaxVersion: release.version,
    PythonDir: '',
    InstallerVersion: INSTALLER_VERSION,
    StateDir: runDir(r.env),
    Destination: 'sharepoint',
    SiteHost: 'your-tenant.sharepoint.com',
    SitePath: '/sites/AIinOne',
    Library: 'Documents',
    DriveId: '',
    Folder: 'AI in One',
    LocalFolder: '',
    SeedDays: 180,
    WindowDays: 7,
    Agent365: false,
  });
});

test('paxPreview: the script is the template with its settings line filled in, as UTF-8 with a BOM and CRLF', (t) => {
  const r = run(t, { sources: noTemplate() });
  const data = r.bytes('Run-AIO-PAX.ps1');
  assert.deepEqual([...data.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = data.toString('utf8').slice(1);
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'Every line ends in CRLF.');
  const lines = text.split('\r\n');
  const start = lines.indexOf('$Settings = [ordered]@{');
  const end = lines.indexOf('}', start);
  assert.ok(start > 0 && end > start);
  const source = loadTemplate().replace(/^\uFEFF/, '').split(/\r?\n/);
  assert.deepEqual(lines.slice(0, start), source.slice(0, start));
  assert.deepEqual(lines.slice(end + 1), source.slice(start + 1));
  assert.equal(end - start - 1, Object.keys(r.settings()).length);
});

test("paxPreview: the script's settings come from the install record where it has them", (t) => {
  const config = paxConfig({
    agent365: true,
    windowDays: 3,
    credentialType: 'secret',
    secretExpires: '2027-01-01T00:00:00.000Z',
    version: '9.9.9',
    script: 'D:\\PAX\\pax.ps1',
    sha256: 'ab'.repeat(32),
    pythonDir: 'C:\\Python312',
    site: {
      url: 'https://contoso.sharepoint.com/sites/AIinOne',
      host: 'contoso.sharepoint.com',
      path: '/sites/AIinOne',
      library: 'Reports Library',
      driveId: 'b!000',
      folder: "Copilot's AI in One",
    },
  });
  config.tenantId = fake(2);
  config.app.appId = fake(3);
  config.history.days = 30;
  const r = run(t, { config, sources: noTemplate() });
  assert.deepEqual(r.settings(), {
    TenantId: fake(2),
    ClientId: fake(3),
    CredentialType: 'secret',
    CertificateThumbprint: '',
    SecretFile: secretPath(r.env),
    SecretExpires: '2027-01-01T00:00:00.000Z',
    PaxScript: 'D:\\PAX\\pax.ps1',
    PaxSha256: 'AB'.repeat(32),
    PaxVersion: '9.9.9',
    PythonDir: 'C:\\Python312',
    InstallerVersion: INSTALLER_VERSION,
    StateDir: runDir(r.env),
    Destination: 'sharepoint',
    SiteHost: 'contoso.sharepoint.com',
    SitePath: '/sites/AIinOne',
    Library: 'Reports Library',
    DriveId: 'b!000',
    Folder: "Copilot's AI in One",
    LocalFolder: '',
    SeedDays: 30,
    WindowDays: 3,
    Agent365: true,
  });
  assert.ok(r.text('Run-AIO-PAX.ps1').includes("    Folder = 'Copilot''s AI in One'\r\n"), 'A quote in a value is doubled, so the value stays a literal.');
});

test('paxPreview: without %LOCALAPPDATA%, the paths are under a sample profile folder', (t) => {
  const sample = { LOCALAPPDATA: SAMPLE_LOCALAPPDATA };
  for (const env of [{}, { LOCALAPPDATA: '' }]) {
    const r = run(t, { sources: noTemplate(), env });
    const s = r.settings();
    assert.equal(s.StateDir, runDir(sample));
    assert.equal(s.SecretFile, secretPath(sample));
    assert.equal(s.PaxScript, join(paxDir(release.version, sample), release.file));
    const xml = r.task();
    assert.ok(xml.includes(`-File &quot;${xmlText(wrapperPath(sample))}&quot;`));
    assert.ok(xml.includes(`<WorkingDirectory>${xmlText(runDir(sample))}</WorkingDirectory>`));
  }
});

test("paxPreview: graph-permissions.txt lists the app's permissions and the one site Sites.Selected needs", (t) => {
  const off = run(t, { sources: noTemplate() });
  assert.equal(
    off.text('graph-permissions.txt'),
    [
      'Microsoft Graph application permissions for the app registration:',
      '  AuditLogsQuery.Read.All',
      '  User.Read.All',
      '  Organization.Read.All',
      '  Sites.Selected',
      `Sites.Selected gives it nothing until it has write permission on ${SAMPLE_SITE} alone.`,
      '',
    ].join('\n'),
  );
  const site = { url: 'https://contoso.sharepoint.com/sites/AIinOne', library: 'Documents', folder: 'AI in One' };
  const on = run(t, { config: paxConfig({ agent365: true, site }), sources: noTemplate() });
  assert.equal(
    on.text('graph-permissions.txt'),
    [
      'Microsoft Graph application permissions for the app registration:',
      '  AuditLogsQuery.Read.All',
      '  User.Read.All',
      '  Organization.Read.All',
      '  Sites.Selected',
      '  CopilotPackages.Read.All',
      '  Application.Read.All',
      'Sites.Selected gives it nothing until it has write permission on https://contoso.sharepoint.com/sites/AIinOne alone.',
      '',
    ].join('\n'),
  );
});

test("paxPreview: a local folder gets only the task's files, with no model, report or SharePoint site", (t) => {
  const r = run(t, { config: paxConfig({ destination: 'local', localFolder: 'D:\\Reports\\AI in One' }) });
  assert.deepEqual(r.written, TASK_FILES);
  assert.deepEqual(filesIn(r.outDir), [...TASK_FILES].sort());
  assert.deepEqual(readdirSync(r.root), ['out']);
  const { Destination, LocalFolder, SiteHost, SitePath, Library, DriveId, Folder } = r.settings();
  assert.deepEqual(
    { Destination, LocalFolder, SiteHost, SitePath, Library, DriveId, Folder },
    { Destination: 'local', LocalFolder: 'D:\\Reports\\AI in One', SiteHost: '', SitePath: '', Library: '', DriveId: '', Folder: '' },
  );
  assert.equal(
    r.text('graph-permissions.txt'),
    ['Microsoft Graph application permissions for the app registration:', '  AuditLogsQuery.Read.All', '  User.Read.All', '  Organization.Read.All', ''].join('\n'),
    'No Sites.Selected, since the files go to no site.',
  );
  const shown = r.shown();
  assert.ok(shown.includes('Run-AIO-PAX.ps1 (the script the task "AI in One - PAX refresh" runs), task.xml, graph-permissions.txt, with placeholders where nothing is known yet.'));
  assert.doesNotMatch(shown, /model\.bim/);
});

test("paxPreview: a local folder that isn't chosen yet shows the default one", (t) => {
  const r = run(t, { config: paxConfig({ destination: 'local' }), sources: noTemplate() });
  assert.equal(r.settings().LocalFolder, defaultLocalFolder());
});

test("paxPreview: with the model turned off, or no SharePoint template, writes only the task's files", (t) => {
  const off = paxConfig();
  off.semanticModel.enabled = false;
  for (const o of [{ config: off }, { sources: noTemplate() }]) {
    const r = run(t, o);
    assert.deepEqual(r.written, TASK_FILES);
    assert.deepEqual(filesIn(r.outDir), [...TASK_FILES].sort());
    assert.doesNotMatch(r.shown(), /model\.bim/);
  }
});

test('paxPreview: a OneDrive address instead of a site stops it before it writes anything', (t) => {
  const root = tempDir(t);
  const config = paxConfig({ site: { url: 'https://contoso-my.sharepoint.com/personal/someone_contoso_com', library: 'Documents', folder: 'AI in One' } });
  const o = { ui: fakeUi().ui, config, sources: noTemplate(), outDir: join(root, 'out'), env: { LOCALAPPDATA: join(root, 'appdata') }, now: noon() };
  assert.throws(() => paxPreview(o), /is a OneDrive/);
  assert.equal(existsSync(join(root, 'out')), false);
});
