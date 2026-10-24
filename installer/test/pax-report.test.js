// @ts-check
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { semanticModelDefinition } from '../src/clients/fabric.js';
import { emptyConfig, emptyPax, REPORT_NAME } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { commandLine } from '../src/launch.js';
import { FILES, lastRunPath, SP_FOLDER } from '../src/pax/names.js';
import {
  buildPaxModel,
  connectModel,
  deployPaxModel,
  desktopSteps,
  ensurePaxWorkspace,
  ensureRefreshSchedule,
  FIRST_REFRESH_MS,
  INTERACTIONS_PARAMETER,
  localGuidance,
  ORG_DATA_PARAMETER,
  parameterLines,
  paxModelUrls,
  paxSignature,
  paxViewerAccess,
  REFRESH_AFTER_HOURS,
  refreshPaxModel,
  refreshTimes,
  signInSteps,
  workspaceRefused,
} from '../src/pax/report.js';
import { DEFAULT_SOURCE_DIR, findPaxModelTemplate } from '../src/sources.js';
import { definitionHash, modelSettingsUrl, REFRESH_POLL_MS } from '../src/steps/model.js';
import { AGENT365_PARAMETER, loadTemplateModel, mParameter, PBISM } from '../src/transform/model.js';
import { loadTemplateReport, pbir, reportSignature } from '../src/transform/report.js';
import { fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

/** @typedef {import('../src/config.js').InstallConfig} InstallConfig */
/** @typedef {import('../src/transform/model.js').ModelBim} ModelBim */

const SITE_URL = 'https://contoso.sharepoint.com/sites/AIinOne';
const LIBRARY_URL = `${SITE_URL}/Shared%20Documents`;
const FOLDER_URL = `${LIBRARY_URL}/AI%20in%20One`;
const PARAMETERS = [INTERACTIONS_PARAMETER, ORG_DATA_PARAMETER, AGENT365_PARAMETER];
const OK = '\u2713';
const FAIL = '\u2717';

/** The SharePoint edition's template, found the way the installer finds it. */
function templateFile() {
  const name = findPaxModelTemplate(DEFAULT_SOURCE_DIR);
  if (!name) assert.fail('The repo root has no .pbit with "PBI-SharePoint" in its name.');
  return join(DEFAULT_SOURCE_DIR, name);
}

/** @type {ModelBim | undefined} */
let templateModel;
/** The template's model, read once since the .pbit is large. Tests never change it. */
const template = () => (templateModel ??= loadTemplateModel(templateFile()));

/** @type {import('../src/transform/report.js').ReportParts | undefined} */
let templateReport;
const reportParts = () => (templateReport ??= loadTemplateReport(templateFile()));

/** @param {string | string[]} e */
const mText = (e) => (Array.isArray(e) ? e.join('\n') : String(e));

/** @param {ModelBim['model']} model @param {string} name */
function expression(model, name) {
  const e = model.expressions?.find((x) => x.name === name);
  if (!e) assert.fail(`The model has no expression "${name}".`);
  return mText(e.expression);
}

/** The template parameter's meta record, which follows its value. @param {string} name */
function metaOf(name) {
  const text = expression(template().model, name);
  return text.slice(text.indexOf(' meta ['));
}

/** A part of a Fabric item definition, decoded. @param {{ parts: { path: string, payload: string }[] }} definition @param {string} path */
function part(definition, path) {
  const p = definition.parts.find((x) => x.path === path);
  if (!p) assert.fail(`The definition has no ${path}.`);
  return JSON.parse(Buffer.from(p.payload, 'base64').toString('utf8'));
}

/** The output without colours. @param {string} s */
const plain = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');

/**
 * An install record for the PAX route, with the files going to a SharePoint folder.
 * @param {Partial<import('../src/config.js').PaxConfig>} [pax]
 * @param {Partial<import('../src/config.js').PaxSite>} [site]
 * @returns {InstallConfig}
 */
function spConfig(pax = {}, site = {}) {
  const config = emptyConfig();
  config.target = 'pax';
  config.tenantId = '00000000-0000-0000-0000-000000000001';
  config.pax = {
    ...emptyPax(),
    site: { url: SITE_URL, host: 'contoso.sharepoint.com', path: '/sites/AIinOne', name: 'Copilot Reporting', library: 'Documents', driveWebUrl: LIBRARY_URL, folder: SP_FOLDER, ...site },
    ...pax,
  };
  return config;
}

/**
 * A context with fake Fabric and Power BI APIs, and a UI that records what it shows.
 * @param {{ config?: InstallConfig, answers?: any[], sources?: import('../src/sources.js').Sources, graph?: any }} [o]
 */
function setup(o = {}) {
  const ui = fakeUi({ answers: o.answers });
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, powerBi: powerBi.api, graph: o.graph, sources: o.sources, config: o.config ?? spConfig() });
  // Never this PC's own PAX files: a test that needs a last run writes one here.
  /** @type {any} */ (made.ctx).env = { LOCALAPPDATA: join(tmpdir(), `aio-pax-report-${process.pid}-${++setups}`) };
  return { ...made, ui, fabric, powerBi, text: () => plain(ui.text()) };
}
let setups = 0;

/** Marks the model as deployed, and puts it in the workspace. @param {ReturnType<typeof setup>} s @param {string} [id] */
function deployed(s, id = 'm1') {
  Object.assign(s.config.semanticModel, { enabled: true, id });
  s.fabric.add('SemanticModel', s.config.semanticModel.name, null).id = id;
}

/** An access check that found these files in the folder. @param {string[]} names @returns {import('../src/pax/scripts.js').AccessCheck} */
const found = (names) => ({ ok: true, files: names.map((name) => ({ name, exists: true })) });

test('template: the SharePoint edition .pbit is found by its name pattern, as the installer finds it', () => {
  const file = templateFile();
  assert.match(file, /PBI-SharePoint.*\.pbit$/i);
  assert.equal(realSources().paxModelFile, file);
});

test('template: has the three text parameters the report reads, each read by a table', () => {
  const model = template().model;
  for (const name of PARAMETERS) {
    assert.match(expression(model, name), / meta \[IsParameterQuery=true, Type="Text"/, name);
    const readers = model.tables.filter((t) => (t.partitions ?? []).some((p) => mText(p.source?.expression ?? '').includes(`#"${name}"`)));
    assert.ok(readers.length >= 1, `A table reads "${name}".`);
  }
  assert.match(expression(model, INTERACTIONS_PARAMETER), /IsParameterQueryRequired=true/);
  assert.match(expression(model, ORG_DATA_PARAMETER), /IsParameterQueryRequired=true/);
  assert.match(expression(model, AGENT365_PARAMETER), /IsParameterQueryRequired=false/);
  assert.ok(model.tables.some((t) => t.name === 'Calendar'), 'The model has a Calendar table.');
});

test('paxModelUrls: the files in the default folder, with Agent 365 off and on', () => {
  assert.deepEqual(paxModelUrls(spConfig()), {
    interactions: `${FOLDER_URL}/AIO_Interactions.csv`,
    users: `${FOLDER_URL}/AIO_Users.csv`,
    agent365: '',
  });
  assert.deepEqual(paxModelUrls(spConfig({ agent365: true })), {
    interactions: `${FOLDER_URL}/AIO_Interactions.csv`,
    users: `${FOLDER_URL}/AIO_Users.csv`,
    agent365: `${FOLDER_URL}/AIO_Agent365.csv`,
  });
});

test('paxModelUrls: encodes each level of a library and folder with spaces and special characters', () => {
  const library = `${SITE_URL}/Copilot%20Reports%20%26%20Exports`;
  const config = spConfig({ agent365: true }, { library: 'Copilot Reports & Exports', driveWebUrl: `${library}/`, folder: '/Exports #1//Q3 & Q4 100% \u00fcn\u00ef/' });
  const urls = paxModelUrls(config);
  const folder = `${library}/Exports%20%231/Q3%20%26%20Q4%20100%25%20%C3%BCn%C3%AF`;
  assert.deepEqual(urls, {
    interactions: `${folder}/AIO_Interactions.csv`,
    users: `${folder}/AIO_Users.csv`,
    agent365: `${folder}/AIO_Agent365.csv`,
  });
  for (const [key, url] of Object.entries(urls)) {
    const parsed = new URL(url);
    assert.equal(parsed.hash, '', key);
    assert.equal(parsed.search, '', key);
    assert.doesNotMatch(url, /[ #"]/, key);
    assert.doesNotMatch(url.slice('https://'.length), /\/\//, key);
    const name = FILES[/** @type {keyof typeof FILES} */ (key)];
    assert.equal(decodeURIComponent(parsed.pathname), `/sites/AIinOne/Copilot Reports & Exports/Exports #1/Q3 & Q4 100% \u00fcn\u00ef/${name}`);
  }
});

test('paxModelUrls: a blank folder is the default one, and a nested folder keeps its levels', () => {
  assert.equal(paxModelUrls(spConfig({}, { folder: '' })).users, `${FOLDER_URL}/AIO_Users.csv`);
  assert.equal(paxModelUrls(spConfig({}, { folder: 'Reports/AI in One' })).users, `${LIBRARY_URL}/Reports/AI%20in%20One/AIO_Users.csv`);
});

test('paxModelUrls: only for files in a SharePoint folder whose library address is known', () => {
  const notSharePoint = { message: 'The installer publishes the report only when the files go to a SharePoint folder.' };
  assert.throws(() => paxModelUrls(spConfig({ destination: 'local', localFolder: 'C:\\AIO' })), notSharePoint);
  assert.throws(() => paxModelUrls(spConfig({ site: undefined })), notSharePoint);
  assert.throws(() => paxModelUrls(emptyConfig()), notSharePoint);
  assert.throws(() => paxModelUrls(spConfig({}, { driveWebUrl: undefined })), /doesn't have the library's address yet/);
});

test('paxSignature: names the three files, so a change to any of them is a new signature', () => {
  assert.equal(paxSignature({ interactions: 'a', users: 'b', agent365: '' }), 'pax;a;b;');
  const urls = paxModelUrls(spConfig({ agent365: true }));
  assert.equal(paxSignature(urls), `pax;${FOLDER_URL}/AIO_Interactions.csv;${FOLDER_URL}/AIO_Users.csv;${FOLDER_URL}/AIO_Agent365.csv`);
  const variants = [paxModelUrls(spConfig()), urls, paxModelUrls(spConfig({}, { folder: 'Reports' }))].map((u) => paxSignature(u));
  assert.equal(new Set(variants).size, 3);
});

test('buildPaxModel: puts each address in its parameter and keeps the parameter\'s meta record', () => {
  const urls = paxModelUrls(spConfig({ agent365: true }));
  const built = buildPaxModel(template(), urls);
  const values = { [INTERACTIONS_PARAMETER]: urls.interactions, [ORG_DATA_PARAMETER]: urls.users, [AGENT365_PARAMETER]: urls.agent365 };
  for (const [name, url] of Object.entries(values)) {
    assert.equal(expression(built.model, name), `"${url}"${metaOf(name)}`);
    assert.equal(mParameter(built.model, name), url);
  }
});

test('buildPaxModel: changes nothing else, and leaves the template as it was', () => {
  const before = JSON.stringify(template());
  const built = buildPaxModel(template(), paxModelUrls(spConfig({ agent365: true })));
  assert.equal(JSON.stringify(template()), before);
  assert.deepEqual(Object.keys(built), ['compatibilityLevel', 'model']);
  assert.equal(built.compatibilityLevel, template().compatibilityLevel);
  const restored = structuredClone(built.model);
  for (const name of PARAMETERS) {
    const e = restored.expressions?.find((x) => x.name === name);
    const original = template().model.expressions?.find((x) => x.name === name);
    if (!e || !original) assert.fail(`No "${name}" expression.`);
    e.expression = original.expression;
  }
  assert.deepEqual(restored, template().model);
});

test('buildPaxModel: with Agent 365 off, leaves its parameter as the template has it', () => {
  const built = buildPaxModel(template(), paxModelUrls(spConfig()));
  assert.equal(expression(built.model, AGENT365_PARAMETER), expression(template().model, AGENT365_PARAMETER));
  assert.equal(mParameter(built.model, AGENT365_PARAMETER), mParameter(template().model, AGENT365_PARAMETER));
  assert.equal(mParameter(built.model, ORG_DATA_PARAMETER), `${FOLDER_URL}/AIO_Users.csv`);
});

test('buildPaxModel: the result is valid model JSON, which the Fabric definition carries as model.bim', () => {
  const built = buildPaxModel(template(), paxModelUrls(spConfig({ agent365: true })));
  assert.deepEqual(JSON.parse(JSON.stringify(built)), built);
  assert.ok(Array.isArray(built.model.tables) && built.model.tables.length > 0);
  const def = semanticModelDefinition(built, PBISM);
  assert.deepEqual(def.parts.map((p) => p.path), ['model.bim', 'definition.pbism']);
  assert.deepEqual(part(def, 'model.bim'), built);
  assert.deepEqual(part(def, 'definition.pbism'), PBISM);
});

test('buildPaxModel: quotes an address safely in M, doubling its double quotes', () => {
  const odd = `${SITE_URL}/Shared Documents/Say "hi" #1/AIO_Interactions.csv`;
  const built = buildPaxModel(template(), { interactions: odd, users: `${FOLDER_URL}/AIO_Users.csv`, agent365: '' });
  assert.equal(expression(built.model, INTERACTIONS_PARAMETER), `"${SITE_URL}/Shared Documents/Say ""hi"" #1/AIO_Interactions.csv"${metaOf(INTERACTIONS_PARAMETER)}`);
  assert.equal(mParameter(built.model, INTERACTIONS_PARAMETER), odd);
});

test('buildPaxModel: fails loudly when the template lacks a parameter, or it is not a parameter', () => {
  const urls = paxModelUrls(spConfig({ agent365: true }));
  /** A copy of the template with its expressions changed. @param {(e: { name: string, expression: string | string[] }[]) => void} change @returns {ModelBim} */
  const changed = (change) => {
    const expressions = structuredClone(template().model.expressions ?? []);
    change(expressions);
    return { compatibilityLevel: template().compatibilityLevel, model: { ...template().model, expressions } };
  };
  /** @param {string} name */
  const renamed = (name) => changed((all) => all.filter((e) => e.name === name).forEach((e) => (e.name = `${name} (old)`)));
  assert.throws(() => buildPaxModel(renamed(INTERACTIONS_PARAMETER), urls), { message: `The model has no "${INTERACTIONS_PARAMETER}" parameter.` });
  assert.throws(() => buildPaxModel(renamed(ORG_DATA_PARAMETER), urls), { message: `The model has no "${ORG_DATA_PARAMETER}" parameter.` });
  const notParameter = changed((all) => all.filter((e) => e.name === ORG_DATA_PARAMETER).forEach((e) => (e.expression = 'let Source = "x" in Source')));
  assert.throws(() => buildPaxModel(notParameter, urls), { message: `"${ORG_DATA_PARAMETER}" is not a parameter.` });
  const noAgents = renamed(AGENT365_PARAMETER);
  assert.throws(() => buildPaxModel(noAgents, urls), { message: `The model has no "${AGENT365_PARAMETER}" parameter.` });
  assert.equal(mParameter(buildPaxModel(noAgents, { ...urls, agent365: '' }).model, ORG_DATA_PARAMETER), urls.users);
});

test('workspaceRefused: a 4xx answer or a failed Fabric operation means the workspace turned the model down', () => {
  for (const status of [400, 403, 404, 409, 422]) assert.equal(workspaceRefused(httpError(status, 'No')), true, String(status));
  assert.equal(workspaceRefused(new Error("Fabric operation failed (Failed): The workspace can't hold this item.")), true);
  assert.equal(workspaceRefused(new Error('Fabric operation failed')), true);
});

test('workspaceRefused: sign-in, timeouts, throttling, server errors and other failures are not a refusal', () => {
  for (const status of [401, 408, 429, 500, 502, 503]) assert.equal(workspaceRefused(httpError(status, 'No')), false, String(status));
  for (const err of [new Error('fetch failed'), new Error('The Fabric operation failed'), 'Fabric operation failed', undefined, null]) {
    assert.equal(workspaceRefused(err), false, String(err));
  }
});

test('ensurePaxWorkspace: reuses the recorded workspace and records whether it has a capacity', async () => {
  const s = setup();
  s.config.fabric.capacityId = 'cap-old';
  await ensurePaxWorkspace(s.ctx);
  assert.equal(s.config.fabric.workspaceId, 'ws-1');
  assert.equal(s.config.fabric.capacityId, undefined);
  assert.deepEqual(s.fabric.calls, []);
  assert.equal(s.saves(), 1);
  assert.ok(s.text().includes(`${OK} Workspace "ws-1"`), s.text());

  const t = setup();
  t.config.fabric.workspaceName = 'AI in One';
  t.fabric.workspaceCapacities['ws-1'] = 'cap-f';
  await ensurePaxWorkspace(t.ctx);
  assert.equal(t.config.fabric.capacityId, 'cap-f');
  assert.ok(t.text().includes(`${OK} Workspace "AI in One"`), t.text());
});

test('ensurePaxWorkspace: takes the workspace\'s current name', async () => {
  const s = setup();
  s.config.fabric.workspaceName = 'Old name';
  /** @type {any} */ (s.fabric.api).getWorkspace = async (/** @type {string} */ id) => ({ id, displayName: 'Copilot Reporting', capacityId: 'cap-f' });
  await ensurePaxWorkspace(s.ctx);
  assert.equal(s.config.fabric.workspaceName, 'Copilot Reporting');
  assert.equal(s.config.fabric.capacityId, 'cap-f');
  assert.ok(s.text().includes(`${OK} Workspace "Copilot Reporting"`), s.text());
});

test('ensurePaxWorkspace: a recorded workspace that is gone stops with what to do; other errors pass through', async () => {
  /** @param {number} status @param {string} code */
  const coded = (status, code) => new HttpError('Gone', { status, method: 'GET', url: 'https://x', code });
  for (const err of [httpError(404), coded(403, 'WorkspaceNotFound'), coded(400, 'ItemNotFound')]) {
    const s = setup();
    s.config.fabric.workspaceName = 'AI in One';
    s.fabric.failures.getWorkspace = [err];
    await assert.rejects(ensurePaxWorkspace(s.ctx), {
      message: 'Workspace AI in One no longer exists, or you can\'t see it. Remove "workspaceId" from the install record to create a new one.',
    });
    assert.equal(s.saves(), 0);
  }
  const unnamed = setup();
  unnamed.fabric.failures.getWorkspace = [httpError(404)];
  await assert.rejects(ensurePaxWorkspace(unnamed.ctx), /^Error: Workspace ws-1 no longer exists/);
  for (const err of [httpError(500, 'Server error'), httpError(403, 'Forbidden'), new Error('fetch failed')]) {
    const s = setup();
    s.fabric.failures.getWorkspace = [err];
    await assert.rejects(ensurePaxWorkspace(s.ctx), (e) => e === err);
    assert.equal(s.config.fabric.workspaceId, 'ws-1');
  }
});

test('ensurePaxWorkspace: creates a workspace without a capacity when none is recorded', async () => {
  const s = setup();
  delete s.config.fabric.workspaceId;
  s.config.fabric.capacityId = 'cap-old';
  await ensurePaxWorkspace(s.ctx);
  assert.deepEqual(s.fabric.calls, ['createWorkspace AI in One']);
  assert.equal(s.config.fabric.workspaceId, 'ws-new');
  assert.equal(s.config.fabric.workspaceName, 'AI in One');
  assert.equal(s.config.fabric.createdWorkspace, true);
  assert.equal(s.config.fabric.capacityId, undefined);
  assert.equal(s.saves(), 1);
  assert.ok(s.text().includes(`${OK} Created workspace "AI in One"`), s.text());

  const named = setup();
  delete named.config.fabric.workspaceId;
  named.config.fabric.workspaceName = 'Copilot Reporting';
  await ensurePaxWorkspace(named.ctx);
  assert.deepEqual(named.fabric.calls, ['createWorkspace Copilot Reporting']);
  assert.equal(named.config.fabric.workspaceName, 'Copilot Reporting');
});

test('ensurePaxWorkspace: explains a name clash and a tenant where the user can\'t create workspaces', async () => {
  const cantCreate = "You can't create Power BI workspaces in this tenant. Ask a Power BI admin to let you, or for a workspace you can publish to, then run install again and choose it.";
  /** @type {[Error, string][]} */
  const cases = [
    [httpError(409, 'Conflict'), 'There\'s a workspace called "AI in One" already. Run install again and choose it, or another name.'],
    [httpError(401, 'Unauthorized'), cantCreate],
    [httpError(403, 'Forbidden'), cantCreate],
  ];
  for (const [err, message] of cases) {
    const s = setup();
    delete s.config.fabric.workspaceId;
    s.fabric.failures.createWorkspace = [err];
    await assert.rejects(ensurePaxWorkspace(s.ctx), { message });
    assert.equal(s.config.fabric.workspaceId, undefined);
    assert.equal(s.saves(), 0);
  }
  const s = setup();
  delete s.config.fabric.workspaceId;
  const err = httpError(500, 'Server error');
  s.fabric.failures.createWorkspace = [err];
  await assert.rejects(ensurePaxWorkspace(s.ctx), (e) => e === err);
});

test('deployPaxModel: creates the model with the files\' addresses, then publishes the report on it', async () => {
  const s = setup({ config: spConfig({ agent365: true }) });
  assert.deepEqual(await deployPaxModel(s.ctx), { deployed: true, reportOk: true });
  assert.deepEqual(s.fabric.calls, ['createSemanticModel AI in One', 'createReport AI in One']);
  const sm = s.config.semanticModel;
  const model = s.fabric.items.find((i) => i.type === 'SemanticModel');
  const report = s.fabric.items.find((i) => i.type === 'Report');
  if (!model || !report) assert.fail('The model and the report are in the workspace.');
  assert.equal(sm.id, model.id);
  const urls = paxModelUrls(s.config);
  const bim = buildPaxModel(template(), urls);
  assert.deepEqual(part(model.content, 'model.bim'), bim);
  assert.deepEqual(part(model.content, 'definition.pbism'), PBISM);
  assert.equal(sm.signature, `${paxSignature(urls)};${definitionHash(semanticModelDefinition(bim, PBISM))}`);
  assert.equal(sm.enabled, true);
  assert.equal(sm.bound, false, 'a new model is signed in to its files once they are there');
  assert.equal(sm.desktop, undefined);
  assert.deepEqual(sm.report, { name: REPORT_NAME, id: report.id, signature: reportSignature(reportParts()), modelId: model.id });
  assert.deepEqual(part(report.content, 'definition.pbir'), pbir(model.id));
  assert.equal(report.content.parts.length, reportParts().length + 1);
  assert.equal(s.config.fabric.pendingItems, undefined);
  assert.ok(s.text().includes(`${OK} Created semantic model AI in One`), s.text());
  assert.ok(s.text().includes(`${OK} Published the AI in One report, on AI in One`), s.text());
});

test('deployPaxModel: a re-run with nothing changed leaves the model, its sign-in and the report as they are', async () => {
  const s = setup();
  await deployPaxModel(s.ctx);
  s.config.semanticModel.bound = true;
  s.fabric.calls.length = 0;
  s.ui.out.length = 0;
  assert.deepEqual(await deployPaxModel(s.ctx), { deployed: true, reportOk: true });
  assert.deepEqual(s.fabric.calls, []);
  assert.equal(s.config.semanticModel.bound, true);
  assert.ok(s.text().includes(`${OK} Semantic model AI in One is in place`), s.text());
  assert.ok(s.text().includes(`${OK} The AI in One report is in place`), s.text());
});

test('deployPaxModel: a new folder updates the model, which then needs signing in to the new files', async () => {
  const s = setup();
  await deployPaxModel(s.ctx);
  const sm = s.config.semanticModel;
  sm.bound = true;
  /** @type {import('../src/config.js').PaxSite} */ (s.config.pax?.site).folder = 'Reports';
  s.fabric.calls.length = 0;
  assert.deepEqual(await deployPaxModel(s.ctx), { deployed: true, reportOk: true });
  assert.deepEqual(s.fabric.calls, ['updateSemanticModel AI in One']);
  assert.equal(sm.bound, false);
  assert.deepEqual(sm.reload, { since: '2026-06-01T12:00:00.000Z' });
  const model = s.fabric.items.find((i) => i.id === sm.id);
  if (!model) assert.fail('The model is in the workspace.');
  assert.equal(mParameter(part(model.content, 'model.bim').model, ORG_DATA_PARAMETER), `${LIBRARY_URL}/Reports/AIO_Users.csv`);
  assert.ok(String(sm.signature).startsWith(`pax;${LIBRARY_URL}/Reports/AIO_Interactions.csv;`), sm.signature);
});

test('deployPaxModel: a new template alone updates the model and keeps its sign-in, as it reads the same files', async () => {
  const s = setup();
  await deployPaxModel(s.ctx);
  const sm = s.config.semanticModel;
  const urls = paxModelUrls(s.config);
  Object.assign(sm, { bound: true, signature: `${paxSignature(urls)};0000` });
  s.fabric.calls.length = 0;
  await deployPaxModel(s.ctx);
  assert.deepEqual(s.fabric.calls, ['updateSemanticModel AI in One']);
  assert.equal(sm.bound, true);
  assert.notEqual(sm.signature, `${paxSignature(urls)};0000`);
});

test('deployPaxModel: a workspace that refuses the model falls back to publishing it from Power BI Desktop', async () => {
  for (const err of [httpError(403, 'The workspace has no capacity.'), new Error('Fabric operation failed (Failed): Not allowed.')]) {
    const s = setup();
    s.fabric.failures.createSemanticModel = [err];
    assert.deepEqual(await deployPaxModel(s.ctx), { deployed: false, reportOk: true });
    const sm = s.config.semanticModel;
    assert.equal(sm.desktop, true);
    assert.equal(sm.id, undefined);
    assert.equal(sm.enabled, true);
    assert.deepEqual(s.fabric.calls, ['createSemanticModel AI in One'], 'no report without a model');
    assert.equal(s.fabric.items.length, 0);
    assert.ok(s.text().includes(`! The workspace didn't take the model from the installer: ${err.message}`), s.text());
    assert.ok(s.text().includes('You publish it from Power BI Desktop instead. The steps come once the first load has written the files.'), s.text());
  }
});

test('deployPaxModel: sign-in, throttling and server errors stop the run rather than fall back to Desktop', async () => {
  for (const err of [httpError(401, 'Unauthorized'), httpError(408, 'Timeout'), httpError(429, 'Too many requests'), httpError(500, 'Server error'), new Error('fetch failed')]) {
    const s = setup();
    s.fabric.failures.createSemanticModel = [err];
    await assert.rejects(deployPaxModel(s.ctx), (e) => e === err);
    assert.equal(s.config.semanticModel.desktop, undefined, err.message);
  }
});

test('deployPaxModel: a refused update of a deployed model stops the run, still owing the update', async () => {
  const s = setup();
  const item = s.fabric.add('SemanticModel', 'AI in One', null);
  Object.assign(s.config.semanticModel, { id: item.id, signature: 'old', bound: true });
  const err = httpError(400, 'Bad definition');
  s.fabric.failures.updateSemanticModel = [err];
  await assert.rejects(deployPaxModel(s.ctx), (e) => e === err);
  const sm = s.config.semanticModel;
  assert.equal(sm.desktop, undefined);
  assert.equal(sm.signature, 'old');
  assert.deepEqual(sm.reload, { since: '2026-06-01T12:00:00.000Z', unsettled: true });
});

test('deployPaxModel: leaves a model published from Power BI Desktop as it is', async () => {
  const s = setup();
  Object.assign(s.config.semanticModel, { desktop: true, id: 'm1', signature: 'desktop' });
  s.fabric.add('SemanticModel', 'AI in One', null).id = 'm1';
  assert.deepEqual(await deployPaxModel(s.ctx), { deployed: true, reportOk: true });
  assert.deepEqual(s.fabric.calls, []);
  assert.equal(s.config.semanticModel.signature, 'desktop');
  assert.ok(s.text().includes(`${OK} Semantic model AI in One is in place. It was published from Power BI Desktop, so the installer leaves it as it is.`), s.text());
});

/** A context whose recorded model was deleted from the workspace. @param {object} [sm] */
function deletedModel(sm = {}) {
  const s = setup();
  Object.assign(s.config.fabric, { workspaceId: 'ws1', workspaceName: 'Copilot Reporting' });
  Object.assign(s.config.semanticModel, { enabled: true, id: 'gone', bound: true, refreshTimes: ['06:00', '12:00'], report: { id: 'r0', name: 'AI in One', modelId: 'gone' }, ...sm });
  return s;
}
const DELETED = '! AI in One isn\'t in "Copilot Reporting" any more.';

test('deployPaxModel: a Desktop model that was deleted is forgotten, and one published again under its name is taken on', async () => {
  const s = deletedModel({ desktop: true, signature: 'desktop' });
  const model = s.fabric.add('SemanticModel', 'AI in One', null);
  assert.deepEqual(await deployPaxModel(s.ctx), { deployed: true, reportOk: true });
  const sm = s.config.semanticModel;
  assert.equal(sm.id, model.id);
  assert.equal(sm.bound, false, 'the new model needs signing in');
  assert.equal(sm.refreshTimes, undefined);
  assert.equal(sm.report, undefined, 'the old report went with the old model');
  assert.ok(s.text().includes(DELETED), s.text());
  assert.ok(!s.text().includes('is in place'), s.text());
});

test('connectModel: a model that was deleted is forgotten, and the owner is told to run update instead of getting a 404', async () => {
  const s = deletedModel();
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), false);
  const sm = s.config.semanticModel;
  assert.deepEqual([sm.id, sm.bound, sm.refreshTimes, sm.report], [undefined, undefined, undefined, undefined]);
  assert.ok(s.text().includes(DELETED), s.text());
  assert.ok(s.text().includes(`! AI in One isn't deployed. Run "${commandLine('update')}".`), s.text());
  assert.deepEqual(s.powerBi.calls, []);
});

test('connectModel: a Desktop model that was deleted is forgotten, and the steps to publish it again are shown', async () => {
  const s = deletedModel({ desktop: true });
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), false);
  assert.deepEqual(s.ui.asked, ['Have you published it?']);
  assert.ok(s.text().includes(DELETED), s.text());
  assert.ok(s.text().includes("The workspace didn't take AI in One from the installer, so publish it from Power BI Desktop:"), s.text());
  assert.deepEqual(s.powerBi.calls, []);
});

test('deployPaxModel: takes on the model and report once they are published from Power BI Desktop', async () => {
  const s = setup();
  s.config.semanticModel.desktop = true;
  const model = s.fabric.add('SemanticModel', 'ai in one', null);
  const report = s.fabric.add('Report', 'AI IN ONE', null);
  assert.deepEqual(await deployPaxModel(s.ctx), { deployed: true, reportOk: true });
  const sm = s.config.semanticModel;
  assert.equal(sm.id, model.id);
  assert.equal(sm.bound, false, "Desktop's sign-in stays in Desktop");
  assert.deepEqual(sm.report, { id: report.id, name: 'AI IN ONE', modelId: model.id });
  assert.equal(sm.desktop, true);
  assert.deepEqual(s.fabric.calls, []);
  assert.ok(s.text().includes(`${OK} Found ai in one and the AI IN ONE report, published from Power BI Desktop`), s.text());
});

test('deployPaxModel: with nothing published from Desktop yet, tries the installer\'s deployment again', async () => {
  const s = setup();
  s.config.semanticModel.desktop = true;
  assert.deepEqual(await deployPaxModel(s.ctx), { deployed: true, reportOk: true });
  assert.deepEqual(s.fabric.calls, ['createSemanticModel AI in One', 'createReport AI in One']);
  assert.equal(s.config.semanticModel.desktop, undefined);
});

test('deployPaxModel: needs the SharePoint edition template, and a SharePoint folder', async () => {
  const sources = { ...realSources() };
  delete sources.paxModelFile;
  const s = setup({ sources });
  await assert.rejects(deployPaxModel(s.ctx), {
    message: 'This copy of the installer has no SharePoint edition Power BI template (a .pbit with "PBI-SharePoint" in its name) to build the model from.',
  });
  assert.deepEqual(s.fabric.calls, []);
  const local = setup({ config: spConfig({ destination: 'local', localFolder: 'C:\\AIO', site: undefined }) });
  await assert.rejects(deployPaxModel(local.ctx), { message: 'The installer publishes the report only when the files go to a SharePoint folder.' });
  assert.deepEqual(local.fabric.calls, []);
});

test('deployPaxModel: a report that fails to publish is reported, and the model stays deployed', async () => {
  const s = setup();
  s.fabric.failures.createReport = [httpError(500, 'Server error')];
  assert.deepEqual(await deployPaxModel(s.ctx), { deployed: true, reportOk: false });
  assert.ok(s.config.semanticModel.id);
  assert.ok(s.text().includes(`${FAIL} The AI in One report wasn't published: Server error`), s.text());
  assert.ok(s.text().includes(`Fix the problem, then run "${commandLine('update')}".`), s.text());
});

test('parameterLines: one line per template parameter, with Agent 365 left blank when it is off', () => {
  assert.deepEqual(parameterLines({ interactions: 'i', users: 'u', agent365: 'a' }), [
    'Copilot Interactions File: i',
    'Org Data File: u',
    'Agent 365 (highly recommended): a',
  ]);
  assert.equal(parameterLines({ interactions: 'i', users: 'u', agent365: '' })[2], 'Agent 365 (highly recommended): (leave it blank)');
});

test('desktopSteps: open the template, enter the files\' addresses and publish to the workspace', () => {
  const config = spConfig({ agent365: true });
  config.fabric.workspaceName = 'Copilot Reporting';
  const file = templateFile();
  assert.deepEqual(desktopSteps(config, file), [
    `Open "${file}" in Power BI Desktop.`,
    `When it asks for the parameters, enter these, then choose Load: Copilot Interactions File: ${FOLDER_URL}/AIO_Interactions.csv; Org Data File: ${FOLDER_URL}/AIO_Users.csv; Agent 365 (highly recommended): ${FOLDER_URL}/AIO_Agent365.csv.`,
    'When it asks how to connect to SharePoint, choose "Organizational account", sign in and choose Connect.',
    'Once it has loaded, save it as "AI in One", choose Publish and pick the workspace "Copilot Reporting".',
  ]);
  const generic = desktopSteps(spConfig());
  assert.equal(generic[0], 'Open the SharePoint edition\'s .pbit ("AIO Dashboard - Rollup Edition - PBI-SharePoint") in Power BI Desktop.');
  assert.ok(generic[1].endsWith('Agent 365 (highly recommended): (leave it blank).'), generic[1]);
  assert.equal(generic[3], 'Once it has loaded, save it as "AI in One", choose Publish and pick the workspace "AI in One".');
});

test('signInSteps: the model\'s settings page, an OAuth2 sign-in, and the folder whose files it reads', () => {
  const config = spConfig();
  config.fabric.workspaceId = 'ws-1';
  config.semanticModel.id = 'm1';
  const steps = signInSteps(config);
  assert.deepEqual(steps, [
    'Open https://app.powerbi.com/groups/ws-1/settings/datasets/m1',
    'Expand "Data source credentials".',
    'For each data source, choose "Edit credentials", set the authentication method to OAuth2 and the privacy level to Organizational, then choose "Sign in".',
    'Sign in as someone who can open the files in Documents/AI in One in Copilot Reporting: usually you.',
  ]);
  assert.equal(steps[0], `Open ${modelSettingsUrl('ws-1', 'm1')}`);
  const site = /** @type {import('../src/config.js').PaxSite} */ (config.pax?.site);
  delete site.name;
  assert.equal(signInSteps(config)[3], `Sign in as someone who can open the files in Documents/AI in One in ${SITE_URL}: usually you.`);
  delete config.pax;
  assert.equal(signInSteps(config)[3], 'Sign in as someone who can open the files in the SharePoint folder: usually you.');
});

test('refreshTimes: 4 and 10 hours after the task\'s run, on the hour or half hour, across midnight', () => {
  /** @type {[string, string[]][]} */
  const cases = [
    ['02:00', ['06:00', '12:00']],
    ['02:10', ['06:30', '12:30']],
    ['02:31', ['07:00', '13:00']],
    ['03:15', ['07:30', '13:30']],
    ['15:00', ['01:00', '19:00']],
    ['13:50', ['00:00', '18:00']],
    ['20:00', ['00:00', '06:00']],
    ['23:45', ['04:00', '10:00']],
    ['00:00', ['04:00', '10:00']],
    ['7', ['11:00', '17:00']],
    ['garbage', ['06:00', '12:00']],
  ];
  for (const [runAt, times] of cases) assert.deepEqual(refreshTimes(runAt), times, runAt);
});

test('refreshTimes: two times for any run time, each on the hour or half hour within 30 minutes of its delay', () => {
  for (let minute = 0; minute < 24 * 60; minute += 5) {
    const runAt = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const times = refreshTimes(runAt);
    assert.equal(times.length, 2, runAt);
    assert.deepEqual([...times].sort(), times, runAt);
    const offsets = times
      .map((t) => {
        const [h, m] = t.split(':').map(Number);
        assert.ok(m === 0 || m === 30, `${runAt}: ${t}`);
        return (h * 60 + m - minute + 24 * 60) % (24 * 60);
      })
      .sort((a, b) => a - b);
    REFRESH_AFTER_HOURS.forEach((after, i) => assert.ok(offsets[i] >= after * 60 && offsets[i] < after * 60 + 30, `${runAt}: ${times.join(',')}`));
  }
});

test('ensureRefreshSchedule: has Power BI refresh the model each day after the task\'s run, in the PC\'s time zone', async () => {
  const s = setup({ config: spConfig({ timeZone: 'GMT Standard Time' }) });
  deployed(s);
  assert.equal(await ensureRefreshSchedule(s.ctx), true);
  assert.deepEqual(s.powerBi.calls, ['setRefreshSchedule m1 06:00,12:00']);
  assert.deepEqual(s.powerBi.refreshSchedule, {
    enabled: true,
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    times: ['06:00', '12:00'],
    localTimeZoneId: 'GMT Standard Time',
    notifyOption: 'MailOnFailure',
  });
  assert.deepEqual(s.config.semanticModel.refreshTimes, ['06:00', '12:00']);
  assert.equal(s.saves(), 1);
  assert.ok(s.text().includes(`${OK} Power BI refreshes AI in One at 06:00 and 12:00 each day (GMT Standard Time), after the task's run at 02:00`), s.text());

  s.powerBi.calls.length = 0;
  assert.equal(await ensureRefreshSchedule(s.ctx), true);
  assert.deepEqual(s.powerBi.calls, [], 'the schedule is in place');

  /** @type {any} */ (s.config.pax).runAt = '23:45';
  assert.equal(await ensureRefreshSchedule(s.ctx), true);
  assert.deepEqual(s.powerBi.calls, ['setRefreshSchedule m1 04:00,10:00']);
  assert.deepEqual(s.config.semanticModel.refreshTimes, ['04:00', '10:00']);
});

test('ensureRefreshSchedule: when Power BI won\'t take the schedule, says how to set it by hand', async () => {
  const s = setup();
  deployed(s);
  s.powerBi.failures.setRefreshSchedule = [httpError(403, 'Forbidden')];
  assert.equal(await ensureRefreshSchedule(s.ctx), false);
  assert.equal(s.config.semanticModel.refreshTimes, undefined);
  assert.ok(s.text().includes("! Couldn't have Power BI refresh AI in One each day: Forbidden"), s.text());
  assert.ok(s.text().includes(`Open ${modelSettingsUrl('ws-1', 'm1')}, expand "Refresh", turn on "Configure a refresh schedule" and add 06:00 and 12:00 (UTC).`), s.text());
});

test('ensureRefreshSchedule: nothing to schedule until the model is deployed', async () => {
  const s = setup();
  assert.equal(await ensureRefreshSchedule(s.ctx), false);
  assert.deepEqual(s.powerBi.calls, []);
  assert.equal(s.text(), '');
});

test('refreshPaxModel: starts a plain refresh and follows it in the refresh history until it completes', async () => {
  const s = setup();
  deployed(s);
  s.config.semanticModel.reload = { since: '2026-06-01T11:00:00.000Z' };
  s.powerBi.plainStates.push({ status: 'Unknown' }, { status: 'Completed', startTime: '2026-06-01T12:00:00Z', endTime: '2026-06-01T12:02:05Z' });
  assert.deepEqual(await refreshPaxModel(s.ctx, { timeoutMs: FIRST_REFRESH_MS }), { ok: true, status: 'Completed' });
  assert.deepEqual(s.powerBi.calls, ['startRefresh m1']);
  assert.deepEqual(s.sleeps, [REFRESH_POLL_MS], 'the fake sleep, between looks');
  assert.equal(s.config.semanticModel.reload, undefined);
  assert.ok(s.text().includes('Refreshing AI in One. The first load of a large history can take a while.'), s.text());
  assert.ok(s.text().includes(`${OK} Refreshed AI in One (2m 05s)`), s.text());
});

test('refreshPaxModel: a refresh that fails for want of the sign-in says so and forgets the sign-in', async () => {
  const s = setup();
  deployed(s);
  s.config.semanticModel.bound = true;
  const error = 'DM_GWPipeline_Gateway_InvalidCredentials: The credentials for the SharePoint source are invalid.';
  s.powerBi.plainStates.push({ status: 'Failed', serviceExceptionJson: JSON.stringify({ errorCode: 'DM_GWPipeline_Gateway_InvalidCredentials', errorDescription: 'The credentials for the SharePoint source are invalid.' }) });
  assert.deepEqual(await refreshPaxModel(s.ctx, { timeoutMs: FIRST_REFRESH_MS }), { ok: false, status: 'Failed', credentials: true, error });
  assert.equal(s.config.semanticModel.bound, false);
  assert.ok(s.text().includes(`${FAIL} AI in One's refresh failed`), s.text());
  assert.ok(s.text().includes(`    ${error}`), s.text());
  assert.deepEqual(s.sleeps, []);
});

test('refreshPaxModel: other failures keep the sign-in and show Power BI\'s error, cut short', async () => {
  const s = setup();
  deployed(s);
  s.config.semanticModel.bound = true;
  s.powerBi.plainStates.push({ status: 'Failed', serviceExceptionJson: 'x'.repeat(700) });
  assert.deepEqual(await refreshPaxModel(s.ctx, { timeoutMs: FIRST_REFRESH_MS }), { ok: false, status: 'Failed', credentials: false, error: 'x'.repeat(600) });
  assert.equal(s.config.semanticModel.bound, true);

  const c = setup();
  deployed(c);
  c.powerBi.plainStates.push({ status: 'Cancelled' });
  assert.deepEqual(await refreshPaxModel(c.ctx, { timeoutMs: FIRST_REFRESH_MS }), { ok: false, status: 'Cancelled', credentials: false, error: '' });
  assert.ok(c.text().includes(`${FAIL} AI in One's refresh ended: Cancelled`), c.text());
});

test('refreshPaxModel: Power BI refusing to start it for want of the sign-in forgets the sign-in', async () => {
  const s = setup();
  deployed(s);
  s.config.semanticModel.bound = true;
  const message = 'Data source credentials are missing or invalid.';
  s.powerBi.failures.startRefresh = [httpError(400, message)];
  assert.deepEqual(await refreshPaxModel(s.ctx, { timeoutMs: FIRST_REFRESH_MS }), { ok: false, status: 'Failed', credentials: true, error: message });
  assert.equal(s.config.semanticModel.bound, false);
  assert.ok(s.text().includes(`${FAIL} Power BI won't refresh AI in One: it isn't signed in to the files`), s.text());
  assert.deepEqual(s.sleeps, []);
});

test('refreshPaxModel: other errors starting the refresh stop the run', async () => {
  for (const err of [httpError(400, 'Bad request'), httpError(500, 'Server error'), new Error('credentials fetch failed')]) {
    const s = setup();
    deployed(s);
    s.config.semanticModel.bound = true;
    s.powerBi.failures.startRefresh = [err];
    await assert.rejects(refreshPaxModel(s.ctx, { timeoutMs: FIRST_REFRESH_MS }), (e) => e === err);
    assert.equal(s.config.semanticModel.bound, true, err.message);
  }
});

test('refreshPaxModel: when a refresh is running already, follows that one to the end', async () => {
  for (const err of [httpError(409, 'Conflict'), httpError(400, 'Another refresh is in progress.')]) {
    const s = setup();
    deployed(s);
    s.powerBi.failures.startRefresh = [err];
    s.powerBi.history.push({ requestId: 'scheduled-1', refreshType: 'Scheduled', status: 'Unknown', startTime: '2026-06-01T10:00:00Z' });
    const refreshes = s.powerBi.api.refreshes;
    let looks = 0;
    /** @type {any} */ (s.powerBi.api).refreshes = async () => {
      if (++looks === 3) Object.assign(s.powerBi.history[0], { status: 'Completed', endTime: '2026-06-01T10:30:00Z' });
      return refreshes();
    };
    assert.deepEqual(await refreshPaxModel(s.ctx, { timeoutMs: FIRST_REFRESH_MS }), { ok: true, status: 'Completed' }, err.message);
    assert.deepEqual(s.powerBi.calls, ['startRefresh m1']);
    assert.deepEqual(s.sleeps, [REFRESH_POLL_MS]);
    assert.ok(s.text().includes('AI in One is refreshing already. Following that refresh.'), s.text());
    assert.ok(s.text().includes(`${OK} Refreshed AI in One (30m 00s)`), s.text());
  }
});

test('refreshPaxModel: without the running refresh\'s ID, follows the first one started since it asked', async () => {
  const s = setup();
  deployed(s);
  s.powerBi.failures.startRefresh = [httpError(409, 'Conflict')];
  const { history } = s.powerBi;
  const refreshes = s.powerBi.api.refreshes;
  let looks = 0;
  /** @type {any} */ (s.powerBi.api).refreshes = async () => {
    looks++;
    if (looks === 2) history.push({ requestId: 'yesterday', status: 'Completed', startTime: '2026-05-31T06:00:00Z', endTime: '2026-05-31T06:10:00Z' });
    if (looks === 3) history.unshift({ requestId: 'today', status: 'Completed', startTime: '2026-06-01T11:59:30Z', endTime: '2026-06-01T12:01:00Z' });
    return refreshes();
  };
  assert.deepEqual(await refreshPaxModel(s.ctx, { timeoutMs: FIRST_REFRESH_MS }), { ok: true, status: 'Completed' });
  assert.deepEqual(s.sleeps, [REFRESH_POLL_MS], "yesterday's refresh isn't taken for it");
  assert.ok(s.text().includes(`${OK} Refreshed AI in One (1m 30s)`), s.text());
});

test("refreshPaxModel: when a refresh is running already, an older one that finished isn't taken for it", async () => {
  const s = setup();
  deployed(s);
  s.powerBi.failures.startRefresh = [httpError(409, 'Conflict')];
  s.powerBi.history.push({ requestId: 'yesterday', status: 'Completed', startTime: '2026-05-31T06:00:00Z', endTime: '2026-05-31T06:10:00Z' });
  assert.deepEqual(await refreshPaxModel(s.ctx, { timeoutMs: REFRESH_POLL_MS }), { ok: false, status: 'NotStarted', running: true });
  assert.ok(!s.text().includes('Refreshed'), s.text());
  assert.ok(s.text().includes(`! AI in One is still refreshing. Check later with "${commandLine('status')}".`), s.text());
});

test('refreshPaxModel: stops waiting at the timeout and says the refresh is still going', async () => {
  const s = setup();
  deployed(s);
  s.powerBi.plainStates.push({ status: 'Unknown' }, { status: 'Unknown' }, { status: 'Unknown' });
  assert.deepEqual(await refreshPaxModel(s.ctx, { timeoutMs: 3 * REFRESH_POLL_MS }), { ok: false, status: 'Unknown', running: true });
  assert.deepEqual(s.sleeps, [REFRESH_POLL_MS, REFRESH_POLL_MS]);
  assert.ok(s.text().includes(`! AI in One is still refreshing. Check later with "${commandLine('status')}".`), s.text());

  const quiet = setup();
  deployed(quiet);
  quiet.powerBi.failures.startRefresh = [httpError(409, 'Conflict')];
  assert.deepEqual(await refreshPaxModel(quiet.ctx, { timeoutMs: REFRESH_POLL_MS }), { ok: false, status: 'NotStarted', running: true });
  assert.deepEqual(quiet.sleeps, []);
});

test('refreshPaxModel: doesn\'t refresh a model whose last update may not have finished', async () => {
  const s = setup();
  deployed(s);
  s.config.semanticModel.reload = { since: '2026-06-01T11:00:00.000Z', unsettled: true };
  assert.deepEqual(await refreshPaxModel(s.ctx, { timeoutMs: FIRST_REFRESH_MS }), { ok: false });
  assert.deepEqual(s.powerBi.calls, []);
  assert.ok(s.text().includes(`! AI in One's last update may not have finished, so it isn't refreshed now. Run "${commandLine('update')}" to apply it again.`), s.text());
});

const BOTH = [FILES.interactions, FILES.users];
const FOLDER_LABEL = 'Documents/AI in One in Copilot Reporting';

test('connectModel: only for files in a SharePoint folder', async () => {
  for (const config of [spConfig({ destination: 'local', localFolder: join('C:', 'AIO'), site: undefined }), spConfig({ site: undefined })]) {
    const s = setup({ config });
    deployed(s);
    assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), false);
    assert.equal(s.text(), '');
    assert.deepEqual(s.powerBi.calls, []);
  }
});

test('connectModel: a check that couldn\'t look at the folder says why', async () => {
  const s = setup();
  deployed(s);
  assert.equal(await connectModel(s.ctx, { check: { ok: false, step: 'Reading the folder', status: 403, error: 'Access denied' } }), false);
  assert.ok(s.text().includes(`! Couldn't look at the files in ${FOLDER_LABEL}. Reading the folder didn't work (HTTP 403): Access denied`), s.text());
  assert.deepEqual(s.powerBi.calls, []);
});

test('connectModel: waits for the task\'s first run to put the files in the folder', async () => {
  /** @type {[Partial<import('../src/config.js').PaxConfig>, import('../src/pax/scripts.js').AccessCheck, string][]} */
  const cases = [
    [{}, found([]), `${FILES.interactions} and ${FILES.users} aren't in`],
    [{}, found([FILES.interactions]), `${FILES.users} isn't in`],
    [{ agent365: true }, found(BOTH), `${FILES.agent365} isn't in`],
    [{}, { ok: true, files: [{ name: FILES.interactions, exists: true }, { name: FILES.users, exists: false }] }, `${FILES.users} isn't in`],
  ];
  for (const [pax, check, says] of cases) {
    const s = setup({ config: spConfig(pax) });
    deployed(s);
    assert.equal(await connectModel(s.ctx, { check }), false, says);
    assert.ok(s.text().includes(`! ${says} ${FOLDER_LABEL} yet, so AI in One has nothing to load.`), s.text());
    assert.ok(s.text().includes(`Once "${commandLine('status')}" shows the first run finished, run "${commandLine('check')}".`), s.text());
    assert.deepEqual(s.ui.asked, []);
    assert.deepEqual(s.powerBi.calls, []);
  }
});

test('connectModel: before the task has found any Copilot interactions, says there is no data yet rather than fail', async (t) => {
  const s = setup();
  deployed(s);
  const file = lastRunPath(/** @type {any} */ (s.ctx).env);
  mkdirSync(dirname(file), { recursive: true });
  t.after(() => rmSync(/** @type {any} */ (s.ctx).env.LOCALAPPDATA, { recursive: true, force: true }));
  writeFileSync(file, `\uFEFF${JSON.stringify({ mode: 'seed', status: 'warning', startedAt: '2026-06-01T02:00:00Z', noData: true })}`, 'utf8');
  assert.equal(await connectModel(s.ctx, { check: found([]) }), true);
  assert.ok(s.text().includes(`! There's no data yet: the task hasn't found any Copilot interactions in the audit log`), s.text());
  assert.ok(s.text().includes(`Then run "${commandLine('check')}" to connect AI in One to them.`), s.text());
  assert.deepEqual(s.powerBi.calls, [], 'no refresh of a model with nothing to load');
  assert.equal(await connectModel(s.ctx, { check: found([FILES.interactions]) }), false, 'once some files are there, the rest are waited for as before');
  assert.match(s.text(), /isn't in .* yet, so AI in One has nothing to load\./);
});

test('connectModel: a model that isn\'t deployed needs an update first', async () => {
  const s = setup();
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), false);
  assert.ok(s.text().includes(`! AI in One isn't deployed. Run "${commandLine('update')}".`), s.text());
  assert.deepEqual(s.ui.asked, []);
  assert.deepEqual(s.powerBi.calls, []);
});

test('connectModel: has the owner sign the model in, refreshes it, schedules the refresh and tests a query', async () => {
  const s = setup({ answers: [true] });
  deployed(s);
  assert.equal(await connectModel(s.ctx, { check: found(BOTH.map((n) => n.toUpperCase())) }), true);
  assert.deepEqual(s.ui.asked, ['Have you signed it in?']);
  assert.deepEqual(s.powerBi.calls, ['startRefresh m1', 'setRefreshSchedule m1 06:00,12:00', 'executeQueries m1']);
  const sm = s.config.semanticModel;
  assert.equal(sm.bound, true);
  assert.deepEqual(sm.refreshTimes, ['06:00', '12:00']);
  const text = s.text();
  assert.ok(text.includes("AI in One reads the files in SharePoint with the sign-in of someone who can open them. Power BI takes it only on the model's settings page, so sign it in once:"), text);
  signInSteps(s.config).forEach((step, i) => assert.ok(text.includes(`      ${i + 1}. ${step}`), step));
  assert.ok(text.includes(`${OK} AI in One answers queries (its Calendar has 90 days)`), text);
});

test('connectModel: a model signed in already is refreshed without asking', async () => {
  const s = setup();
  deployed(s);
  s.config.semanticModel.bound = true;
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), true);
  assert.deepEqual(s.ui.asked, []);
  assert.deepEqual(s.powerBi.calls, ['startRefresh m1', 'setRefreshSchedule m1 06:00,12:00', 'executeQueries m1']);
});

test('connectModel: when the owner skips the sign-in, says the model can\'t load until it is signed in', async () => {
  const s = setup({ answers: [false] });
  deployed(s);
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), false);
  assert.deepEqual(s.powerBi.calls, []);
  assert.equal(s.config.semanticModel.bound, undefined);
  assert.ok(s.text().includes(`AI in One can't load the files until it's signed in. Run "${commandLine('check')}" once it is.`), s.text());
});

test('connectModel: asks for the sign-in once more when the refresh fails for want of it', async () => {
  const credentials = { status: 'Failed', serviceExceptionJson: JSON.stringify({ errorCode: 'DM_GWPipeline_Gateway_InvalidCredentials', errorDescription: 'The credentials are invalid.' }) };
  const s = setup({ answers: [true, true] });
  deployed(s);
  s.powerBi.plainStates.push(credentials);
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), true);
  assert.deepEqual(s.ui.asked, ['Have you signed it in?', 'Have you signed it in?']);
  assert.deepEqual(s.powerBi.calls, ['startRefresh m1', 'startRefresh m1', 'setRefreshSchedule m1 06:00,12:00', 'executeQueries m1']);
  assert.ok(s.text().includes('Power BI needs the model signed in again.'), s.text());

  const twice = setup({ answers: [true, true, true] });
  deployed(twice);
  twice.powerBi.plainStates.push(credentials, { ...credentials });
  assert.equal(await connectModel(twice.ctx, { check: found(BOTH) }), false);
  assert.equal(twice.ui.asked.length, 2, 'asks twice at most');
  assert.deepEqual(twice.powerBi.calls, ['startRefresh m1', 'startRefresh m1'], "no schedule for a model that can't load");
  assert.equal(twice.config.semanticModel.bound, false);
});

test('connectModel: a first load that is still going gets its schedule, and is checked later', async () => {
  const s = setup();
  deployed(s);
  s.config.semanticModel.bound = true;
  s.powerBi.plainStates.push(...Array.from({ length: 100 }, () => ({ status: 'Unknown' })));
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), false);
  assert.equal(s.sleeps.length, Math.ceil(FIRST_REFRESH_MS / REFRESH_POLL_MS) - 1);
  assert.ok(s.sleeps.every((ms) => ms === REFRESH_POLL_MS));
  assert.deepEqual(s.powerBi.calls, ['startRefresh m1', 'setRefreshSchedule m1 06:00,12:00']);
});

test('connectModel: a model whose test query finds no data isn\'t connected', async () => {
  const s = setup();
  deployed(s);
  s.config.semanticModel.bound = true;
  s.powerBi.answers.push({ results: [{ tables: [{ rows: [{ '[CalendarDays]': 0 }] }] }] });
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), false);
  assert.ok(s.text().includes(`${FAIL} AI in One refreshed, but its Calendar table is empty, so report pages will fail`), s.text());
});

test('connectModel: a model for Power BI Desktop is published from it first, with the steps', async () => {
  const s = setup();
  s.config.fabric.workspaceName = 'Copilot Reporting';
  Object.assign(s.config.semanticModel, { enabled: true, desktop: true });
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), false);
  assert.deepEqual(s.ui.asked, ['Have you published it?']);
  const text = s.text();
  assert.ok(text.includes("The workspace didn't take AI in One from the installer, so publish it from Power BI Desktop:"), text);
  desktopSteps(s.config, realSources().paxModelFile).forEach((step, i) => assert.ok(text.includes(`      ${i + 1}. ${step}`), step));
  assert.ok(!text.includes("isn't deployed"), text);
  assert.deepEqual(s.powerBi.calls, []);
});

test('connectModel: once it is published from Desktop, takes it on and has it signed in', async () => {
  const s = setup({ answers: [true, true] });
  Object.assign(s.config.semanticModel, { enabled: true, desktop: true });
  const ui = /** @type {any} */ (s.ctx.ui);
  const select = ui.select;
  ui.select = async (/** @type {any[]} */ ...args) => {
    if (args[0] === 'Have you published it?') {
      s.fabric.add('SemanticModel', 'AI in One', null);
      s.fabric.add('Report', 'AI in One', null);
    }
    return select(...args);
  };
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), true);
  assert.deepEqual(s.ui.asked, ['Have you published it?', 'Have you signed it in?']);
  const id = s.config.semanticModel.id;
  if (!id) assert.fail('The model published from Desktop was taken on.');
  assert.deepEqual(s.powerBi.calls, [`startRefresh ${id}`, `setRefreshSchedule ${id} 06:00,12:00`, `executeQueries ${id}`]);
});

test('connectModel: says so when it isn\'t in the workspace after the owner says it is published', async () => {
  const s = setup({ answers: [true] });
  s.config.fabric.workspaceName = 'AI in One';
  Object.assign(s.config.semanticModel, { enabled: true, desktop: true });
  assert.equal(await connectModel(s.ctx, { check: found(BOTH) }), false);
  assert.ok(s.text().includes(`! There's no AI in One in "AI in One" yet. Run "${commandLine('check')}" once it's published.`), s.text());
  assert.ok(!s.text().includes("isn't deployed"), s.text());
  assert.deepEqual(s.powerBi.calls, []);
});

const GROUP_ID = '00000000-0000-0000-0000-000000000009';

/**
 * Graph with just the group calls the viewer group needs.
 * @param {{ groups?: { id: string, displayName: string }[], refuse?: number }} [o]  refuse: the status a create gets.
 */
function groupGraph(o = {}) {
  /** @type {string[]} */
  const calls = [];
  const groups = [...(o.groups ?? [])];
  const api = {
    /** @param {string} id */
    getGroup: async (id) => {
      calls.push(`getGroup ${id}`);
      return groups.find((g) => g.id === id) ?? null;
    },
    /** @param {string} name */
    findGroupByName: async (name) => {
      calls.push(`findGroupByName ${name}`);
      return groups.find((g) => g.displayName.toLowerCase() === name.toLowerCase()) ?? null;
    },
    /** @param {{ displayName: string, description: string, ownerId: string }} body */
    createSecurityGroup: async (body) => {
      calls.push(`createSecurityGroup ${body.displayName} ${body.ownerId}`);
      if (o.refuse) throw httpError(o.refuse, 'Insufficient privileges to complete the operation.');
      const group = { id: GROUP_ID, displayName: body.displayName };
      groups.push(group);
      return group;
    },
  };
  return { api, calls };
}

test('paxViewerAccess: does nothing when the install gives no viewer group', async () => {
  const graph = groupGraph();
  const s = setup({ graph: graph.api });
  deployed(s);
  await paxViewerAccess(s.ctx);
  assert.deepEqual(graph.calls, []);
  assert.deepEqual(s.powerBi.calls, []);
  assert.equal(s.text(), '');
});

test('paxViewerAccess: creates the viewer group, and grants it access once the model is published', async () => {
  const graph = groupGraph();
  const s = setup({ graph: graph.api });
  s.config.access = {};
  await paxViewerAccess(s.ctx);
  assert.deepEqual(graph.calls, ['findGroupByName AI in One Viewers', 'createSecurityGroup AI in One Viewers user-1']);
  assert.deepEqual(s.config.access, { groupId: GROUP_ID, groupName: 'AI in One Viewers', createdGroup: true });
  assert.ok(s.text().includes(`${OK} Created the group "AI in One Viewers", with you as owner`), s.text());
  assert.ok(s.text().includes(`AI in One isn't published yet. Once it is, run "${commandLine('access')}" to give "AI in One Viewers" access.`), s.text());
  assert.deepEqual(s.powerBi.calls, []);
});

test('paxViewerAccess: gives the group Build on the model and has the report shared with it', async () => {
  const graph = groupGraph({ groups: [{ id: GROUP_ID, displayName: 'AI in One Viewers' }] });
  const s = setup({ graph: graph.api, answers: [true] });
  deployed(s);
  s.config.semanticModel.report = { name: REPORT_NAME, id: 'r1' };
  s.config.access = { groupId: GROUP_ID };
  await paxViewerAccess(s.ctx);
  assert.deepEqual(graph.calls, [`getGroup ${GROUP_ID}`]);
  assert.deepEqual(s.powerBi.calls, [`addDatasetUser m1 ${GROUP_ID} ReadExplore`]);
  assert.deepEqual(s.config.access, { groupId: GROUP_ID, groupName: 'AI in One Viewers', grantedModels: ['m1'], reportShared: true });
  assert.deepEqual(s.ui.asked, ['Have you shared the report?']);
  const text = s.text();
  assert.ok(text.includes(`${OK} Viewer group: AI in One Viewers`), text);
  assert.ok(text.includes(`${OK} AI in One Viewers can build on AI in One`), text);
  assert.ok(text.includes('(https://app.powerbi.com/groups/ws-1/reports/r1?ctid=tenant-1)'), text);
  assert.ok(text.includes(`${OK} The report is shared with "AI in One Viewers"`), text);
  assert.ok(text.includes('The workspace has no capacity, so each viewer needs a Power BI Pro or Premium Per User licence.'), text);
});

test('paxViewerAccess: leaves a grant and a share that are done as they are', async () => {
  const graph = groupGraph({ groups: [{ id: GROUP_ID, displayName: 'Copilot Viewers' }] });
  const s = setup({ graph: graph.api });
  deployed(s);
  s.config.fabric.capacityId = '00000000-0000-0000-0000-000000000005';
  s.config.semanticModel.report = { name: REPORT_NAME, id: 'r1' };
  s.config.access = { groupId: GROUP_ID, reportShared: true };
  s.powerBi.users.push({ identifier: GROUP_ID.toUpperCase(), principalType: 'Group', datasetUserAccessRight: 'ReadReshareExplore' });
  await paxViewerAccess(s.ctx);
  assert.deepEqual(s.powerBi.calls, []);
  assert.deepEqual(s.ui.asked, []);
  assert.deepEqual(s.config.access?.grantedModels, ['m1']);
  assert.ok(s.text().includes(`${OK} Copilot Viewers can build on AI in One`), s.text());
  assert.ok(!s.text().includes('licence'), s.text());
});

test('paxViewerAccess: a tenant where the user can\'t create groups gets no grant', async () => {
  const graph = groupGraph({ refuse: 403 });
  const s = setup({ graph: graph.api });
  deployed(s);
  s.config.access = {};
  await paxViewerAccess(s.ctx);
  assert.deepEqual(s.powerBi.calls, []);
  assert.deepEqual(s.config.access, {});
  assert.ok(s.text().includes("! You can't create groups in this tenant, so there's no viewer group yet."), s.text());
});

test('localGuidance: only for files kept in a folder on this PC', () => {
  for (const config of [spConfig(), spConfig({ destination: 'local', site: undefined })]) {
    const s = setup({ config });
    localGuidance(s.ctx);
    assert.equal(s.text(), '');
  }
});

test('localGuidance: opens the Rollup Edition on the files in the folder, in Power BI Desktop', () => {
  const folder = join('C:', 'Users', 'someone', 'Documents', 'AI in One');
  const rollup = join('repo', 'AIO Rollup.pbit');
  const s = setup({ config: spConfig({ destination: 'local', localFolder: folder, site: undefined, agent365: true }), sources: { ...realSources(), rollupModelFile: rollup } });
  localGuidance(s.ctx);
  const text = s.text();
  assert.ok(text.includes('The files stay on this PC, so open the report on them in Power BI Desktop:'), text);
  [
    `Open "${rollup}" in Power BI Desktop.`,
    `When it asks for the parameters, enter these, then choose Load: ${INTERACTIONS_PARAMETER}: ${join(folder, FILES.interactions)}; ${ORG_DATA_PARAMETER}: ${join(folder, FILES.users)}; ${AGENT365_PARAMETER}: ${join(folder, FILES.agent365)}.`,
    "Save it. Choose Refresh in Desktop after each day's run to see the new data.",
  ].forEach((step, i) => assert.ok(text.includes(`      ${i + 1}. ${step}`), step));

  const sources = { ...realSources() };
  delete sources.rollupModelFile;
  const generic = setup({ config: spConfig({ destination: 'local', localFolder: folder, site: undefined }), sources });
  localGuidance(generic.ctx);
  assert.ok(generic.text().includes('      1. Open the Rollup Edition .pbit ("AIO Dashboard - Rollup Edition") from the AI in One repository in Power BI Desktop.'), generic.text());
  assert.ok(generic.text().includes(`${AGENT365_PARAMETER}: (leave it blank).`), generic.text());
});
