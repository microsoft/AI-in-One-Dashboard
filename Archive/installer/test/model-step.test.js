// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normaliseModules } from '../src/catalog.js';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import {
  CONNECTION_SECRET_NAME,
  connectionName,
  definitionHash,
  ensureModelConnection,
  ensureSemanticModel,
  ensureWorkspaceRole,
  MODEL_PROBE,
  modelSignature,
  refreshModel,
  rotateModelSecret,
  verifyModel,
} from '../src/steps/model.js';
import { blockedSettings } from '../src/steps/plan.js';
import { buildModel, DATABASE_PARAMETER, ENSURE_COLUMNS_MARKER, loadTemplateModel, mParameter, ORG_TABLE, SERVER_PARAMETER } from '../src/transform/model.js';
import { fakeCtx, fakeFabric, fakeGraph, fakePowerBi, fakeUi, httpError, realSources, throttledThenTaken } from './fakes.js';

const SERVER = 'abc.datawarehouse.fabric.microsoft.com';
const DATABASE = 'CopilotAnalytics';

/** @param {any} item */
const modelBim = (item) => JSON.parse(Buffer.from(item.content.parts.find((/** @type {any} */ p) => p.path === 'model.bim').payload, 'base64').toString('utf8'));

/** @param {{ answers?: any[], yes?: boolean, config?: any }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const powerBi = fakePowerBi();
  const ui = fakeUi({ answers: o.answers, yes: o.yes });
  const config = o.config ?? emptyConfig();
  config.semanticModel.enabled = true;
  config.app.displayName = 'AI in One';
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, graph: graph.api, powerBi: powerBi.api, config });
  return { ...made, fabric, graph, powerBi, ui };
}

test('semantic model: created from the template, left alone on re-run, updated when its SQL endpoint changes', async () => {
  const t = setup();
  await ensureSemanticModel(t.ctx);
  const item = t.fabric.items.find((i) => i.type === 'SemanticModel');
  assert.ok(item);
  assert.equal(item.displayName, 'AI in One');
  assert.deepEqual(item.content.parts.map((/** @type {any} */ p) => p.path), ['model.bim', 'definition.pbism']);
  const bim = modelBim(item);
  assert.equal(mParameter(bim.model, SERVER_PARAMETER), SERVER);
  assert.equal(mParameter(bim.model, DATABASE_PARAMETER), DATABASE);
  const org = bim.model.tables.find((/** @type {any} */ tb) => tb.name === ORG_TABLE);
  const query = [org.partitions[0].source.expression].flat().join('\n');
  assert.equal(query.split(ENSURE_COLUMNS_MARKER).length - 1, 1, 'the org table copes with the case of the columns the notebook writes');
  assert.equal(t.config.semanticModel.id, item.id);
  assert.equal(t.config.semanticModel.bound, false);
  assert.equal(t.config.semanticModel.server, SERVER);
  assert.equal(t.config.semanticModel.database, DATABASE);
  assert.equal(t.config.semanticModel.signature?.split(';').slice(0, 3).join(';'), `${SERVER};${DATABASE};core,orgData`);

  t.config.semanticModel.bound = true;
  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls, ['createSemanticModel AI in One']);
  assert.equal(t.config.semanticModel.bound, true);

  await ensureSemanticModel(t.ctx, { force: true });
  assert.deepEqual(t.fabric.calls.slice(1), ['updateSemanticModel AI in One']);
  assert.equal(t.config.semanticModel.bound, false, 'an update needs the connection bound again');

  t.config.semanticModel.bound = true;
  t.fabric.sqlStates.push({ connectionString: 'xyz.datawarehouse.fabric.microsoft.com', provisioningStatus: 'Success' });
  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls.slice(2), ['updateSemanticModel AI in One']);
  assert.equal(t.config.semanticModel.bound, false);
  assert.equal(t.config.semanticModel.server, 'xyz.datawarehouse.fabric.microsoft.com');
  assert.equal(mParameter(modelBim(item).model, SERVER_PARAMETER), 'xyz.datawarehouse.fabric.microsoft.com');
});

test('semantic model: the signature always includes org data, which is always collected', () => {
  assert.equal(modelSignature('ABC.datawarehouse.fabric.microsoft.com', DATABASE, normaliseModules(undefined)), `${SERVER};${DATABASE};core,orgData`);
  assert.equal(modelSignature(SERVER, DATABASE, normaliseModules({ orgData: false })), `${SERVER};${DATABASE};core,orgData`);
  assert.equal(connectionName('0123456789abcdef'), 'AI in One SQL 01234567');
});

test('semantic model: waits for the SQL endpoint; a same-name model that is not ours is left alone', async () => {
  const t = setup();
  t.fabric.sqlStates.push({ provisioningStatus: 'InProgress' }, { connectionString: null });
  const existing = t.fabric.add('SemanticModel', 'AI in One', 'theirs');
  await ensureSemanticModel(t.ctx);
  assert.equal(t.sleeps.length, 2);
  assert.deepEqual(t.ui.asked, [], 'never asks to replace it');
  assert.notEqual(t.config.semanticModel.id, existing.id);
  assert.equal(t.config.semanticModel.name, 'AI in One 2');
  assert.deepEqual(t.fabric.calls, ['createSemanticModel AI in One 2']);
  assert.equal(existing.content, 'theirs');
  assert.match(t.ui.text(), /"AI in One" is already in the workspace and isn't from this install/);

  const failed = setup();
  failed.fabric.sqlStates.push({ provisioningStatus: 'Failed' });
  await assert.rejects(ensureSemanticModel(failed.ctx), /failed to provision/);
});

test('semantic model: a deleted model is deployed again', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'gone', bound: true, signature: 'x' });
  await ensureSemanticModel(t.ctx);
  assert.notEqual(t.config.semanticModel.id, 'gone');
  assert.deepEqual(t.fabric.calls, ['createSemanticModel AI in One']);
  assert.match(t.ui.text(), /AI in One was deleted\. Deploying it again\./);
});

test('semantic model: a re-run redeploys a model whose definition changed, such as one from an older installer', async () => {
  const t = setup();
  await ensureSemanticModel(t.ctx);
  const sm = t.config.semanticModel;
  assert.match(String(sm.signature), /;[0-9a-f]{16}$/, 'the signature carries the definition hash');
  sm.bound = true;

  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls, ['createSemanticModel AI in One'], 'the same definition is left in place');

  sm.signature = String(sm.signature).replace(/;[0-9a-f]{16}$/, '');
  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateSemanticModel AI in One'], 'a record without the hash is updated');
  assert.equal(sm.bound, false, 'so the connection is bound again and the repair refreshes it');

  sm.signature = `${String(sm.signature).slice(0, -16)}0000000000000000`;
  await ensureSemanticModel(t.ctx);
  assert.equal(t.fabric.calls.length, 3, 'a different template is updated');
  assert.equal(definitionHash({ a: 1 }), definitionHash({ a: 1 }));
  assert.notEqual(definitionHash({ a: 1 }), definitionHash({ a: 2 }));
});

test('semantic model: a checkout without the template stops before anything is deployed', async () => {
  const t = setup();
  t.ctx.sources = { ...t.ctx.sources, modelFile: undefined };
  await assert.rejects(ensureSemanticModel(t.ctx), /This checkout has no "AI-in-One Dashboard - Fabric\.pbit" to build the semantic model from\./);
  assert.deepEqual(t.fabric.calls, []);
});

test('the built model has no DAX variable named after a reserved word, which would leave its tables uncalculated', () => {
  const reserved = new Set(
    readFileSync(new URL('./fixtures/dax-reserved-names.txt', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l && !l.startsWith('#')),
  );
  assert.ok(reserved.has('LASTDATE'));
  const sources = realSources();
  const model = buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), { server: 's', database: 'd' });
  /** @type {string[]} */
  const bad = [];
  let vars = 0;
  for (const table of model.model.tables) {
    const texts = [
      ...(table.measures ?? []).map((/** @type {any} */ m) => m.expression),
      ...(table.columns ?? []).map((/** @type {any} */ c) => c.expression),
      ...(table.partitions ?? []).filter((/** @type {any} */ p) => p.source?.type === 'calculated').map((/** @type {any} */ p) => p.source.expression),
    ];
    for (const text of texts) {
      const dax = Array.isArray(text) ? text.join('\n') : String(text ?? '');
      for (const [, name] of dax.matchAll(/\bVAR\s+([A-Za-z_][A-Za-z0-9_.]*)/gi)) {
        vars++;
        if (reserved.has(name.toUpperCase())) bad.push(`${table.name}: VAR ${name}`);
      }
    }
  }
  assert.ok(vars > 0, 'the check found the model\'s DAX variables');
  assert.deepEqual(bad, []);
});

/** @param {ReturnType<typeof setup>} t */
async function withModel(t) {
  await ensureSemanticModel(t.ctx);
  t.fabric.calls.length = 0;
}

test('connection: the app gets Viewer and its own secret; the model is bound to the connection', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  const sm = t.config.semanticModel;
  const name = connectionName('ws-1');
  assert.equal(name, 'AI in One SQL ws-1');
  assert.deepEqual(t.fabric.calls, ['addRoleAssignment sp-1 Viewer', `createConnection ${name}`, `bindConnection AI in One ${sm.connectionId} ${SERVER};${DATABASE}`]);
  assert.deepEqual(unref(t.graph.calls), [`addPassword ${CONNECTION_SECRET_NAME}`]);
  assert.match(t.graph.passwords[0].displayName, new RegExp(`^${CONNECTION_SECRET_NAME} \\(ref [0-9a-f]{12}\\)$`), 'named with the ref saved before Entra was asked');
  const body = /** @type {any} */ (t.fabric.connections[0].body);
  assert.equal(body.connectivityType, 'ShareableCloud');
  assert.deepEqual(body.connectionDetails.parameters.map((/** @type {any} */ p) => p.value), [SERVER, DATABASE]);
  assert.deepEqual(body.credentialDetails.credentials, { credentialType: 'ServicePrincipal', tenantId: 'tenant-1', servicePrincipalClientId: 'app-1', servicePrincipalSecret: 'secret-1' });
  assert.equal(sm.bound, true);
  assert.equal(sm.secretKeyId, 'key-1');
  assert.equal(sm.connectionName, name);
  assert.deepEqual(t.fabric.roles.map((r) => `${r.principal.id} ${r.role}`), ['sp-1 Viewer'], 'only the app gets a workspace role');
  assert.deepEqual(t.config.fabric.appRole, { workspaceId: 'ws-1', principalId: 'sp-1', role: 'Viewer' }, 'recorded, so uninstall takes it away');
  assert.match(t.ui.text(), /Gave AI in One Viewer on the workspace, so the model can read the Lakehouse/);
  assert.match(t.ui.text(), /AI in One reads the Lakehouse through "AI in One SQL ws-1"/);

  t.fabric.calls.length = 0;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(t.fabric.calls, [], 'nothing to do on a re-run');
  assert.equal(t.graph.passwords.length, 1);
});

test('workspace role: the app gets at least the role asked for, and a higher or unknown role is never lowered', async () => {
  const t = setup();
  t.fabric.roles.push({ id: 'ra-1', principal: { id: 'SP-1', type: 'ServicePrincipal' }, role: 'Viewer' });
  await ensureWorkspaceRole(t.ctx);
  assert.deepEqual(t.fabric.calls, [], 'Viewer already, whatever the ID\'s case');
  assert.equal(t.config.fabric.appRole, undefined, 'nothing given, so nothing for uninstall to take away');
  await ensureWorkspaceRole(t.ctx, 'Contributor', 'so it can run the notebooks');
  assert.deepEqual(t.fabric.calls, ['updateRoleAssignment ra-1 Contributor']);
  assert.match(t.ui.text(), /Gave AI in One Contributor on the workspace, so it can run the notebooks/);
  assert.deepEqual(t.config.fabric.appRole, { workspaceId: 'ws-1', principalId: 'sp-1', role: 'Contributor', previous: 'Viewer' }, 'uninstall puts Viewer back');

  const fresh = setup();
  await ensureWorkspaceRole(fresh.ctx);
  await ensureWorkspaceRole(fresh.ctx, 'Contributor');
  assert.deepEqual(fresh.fabric.calls, ['addRoleAssignment sp-1 Viewer', 'updateRoleAssignment sp-1 Contributor']);
  assert.deepEqual(fresh.config.fabric.appRole, { workspaceId: 'ws-1', principalId: 'sp-1', role: 'Contributor' }, 'the app had no role before the installer');

  const moved = setup();
  moved.config.fabric.appRole = { workspaceId: 'ws-old', principalId: 'sp-1', role: 'Contributor' };
  moved.fabric.roles.push({ id: 'ra-1', principal: { id: 'sp-1', type: 'ServicePrincipal' }, role: 'Viewer' });
  await ensureWorkspaceRole(moved.ctx, 'Contributor');
  assert.deepEqual(moved.config.fabric.appRole, { workspaceId: 'ws-1', principalId: 'sp-1', role: 'Contributor', previous: 'Viewer' }, 'a record from another workspace says nothing about this one');

  for (const role of ['Admin', 'Member', 'SomethingNew']) {
    const s = setup();
    s.fabric.roles.push({ id: 'ra-1', principal: { id: 'sp-1', type: 'ServicePrincipal' }, role });
    await ensureWorkspaceRole(s.ctx, 'Contributor');
    assert.deepEqual(s.fabric.calls, [], role);
    assert.equal(s.config.fabric.appRole, undefined, role);
  }
});

test('connection: retried while a new secret takes effect; a failure takes the secret off the app', async () => {
  const t = setup();
  await withModel(t);
  t.fabric.failures.createConnection = [httpError(400, 'Credentials are invalid'), httpError(401, 'Login failed')];
  await ensureModelConnection(t.ctx);
  assert.equal(t.fabric.calls.filter((c) => c.startsWith('createConnection')).length, 3);
  assert.deepEqual(t.sleeps, [30_000, 30_000]);
  assert.equal(t.config.semanticModel.bound, true);

  const bad = setup();
  await withModel(bad);
  bad.fabric.failures.createConnection = [httpError(409, 'Duplicate')];
  await assert.rejects(ensureModelConnection(bad.ctx), /couldn't set up the model's connection: Duplicate/);
  assert.deepEqual(bad.graph.passwords, []);
  assert.equal(bad.config.semanticModel.connectionId, undefined);
});

test('connection: one a throttled create made anyway is reused when the retry finds the name taken', async () => {
  const t = setup();
  await withModel(t);
  const name = connectionName('ws-1');
  const throttled = throttledThenTaken(t.fabric);
  t.fabric.api.createConnection = throttled.createConnection;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(throttled.sent, [`POST ${name}`, `POST ${name}`], 'the client sends it again after the 429, and Fabric answers 409');
  assert.deepEqual(t.fabric.calls, ['addRoleAssignment sp-1 Viewer', 'updateConnection conn-throttled', `bindConnection AI in One conn-throttled ${SERVER};${DATABASE}`]);
  assert.equal(t.fabric.connections.length, 1);
  assert.equal(/** @type {any} */ (t.fabric.connections[0].body).credentialDetails.credentials.servicePrincipalSecret, 'secret-1', 'given the secret again');
  const sm = t.config.semanticModel;
  assert.equal(sm.connectionId, 'conn-throttled');
  assert.equal(sm.secretKeyId, 'key-1');
  assert.equal(sm.bound, true);
  assert.match(t.ui.text(), new RegExp(`Fabric already has a connection named "${name}", probably from an earlier request that it throttled or that timed out\\. Using that one\\.`));
});

test('connection: one with the same name is reused with a new secret; without rights to add one, the user pastes it', async () => {
  const t = setup({ answers: ['pasted-secret'] });
  await withModel(t);
  t.fabric.connections.push({ id: 'conn-old', displayName: connectionName('ws-1') });
  t.fabric.roles.push({ principal: { id: 'sp-1' } });
  t.graph.failures.addPassword = [httpError(403, 'Forbidden')];
  await ensureModelConnection(t.ctx);
  assert.deepEqual(t.fabric.calls.slice(0, 1), ['updateConnection conn-old']);
  assert.equal(/** @type {any} */ (t.fabric.connections[0].body).credentialDetails.credentials.servicePrincipalSecret, 'pasted-secret');
  assert.equal(t.config.semanticModel.connectionId, 'conn-old');
  assert.equal(t.config.semanticModel.secretKeyId, undefined);
  assert.deepEqual(t.ui.asked, ['A client secret for AI in One. It is kept only in the Fabric connection.']);
  assert.match(t.ui.text(), /You can't add a client secret to AI in One, and the model's connection needs one\./);
});

test('connection: a deleted connection is made again and the model bound to it', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  const sm = t.config.semanticModel;
  t.fabric.connections.length = 0;
  t.fabric.calls.length = 0;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(t.fabric.calls.filter((c) => !c.startsWith('getConnection')), [`createConnection ${connectionName('ws-1')}`, `bindConnection AI in One ${sm.connectionId} ${SERVER};${DATABASE}`]);
  assert.equal(sm.bound, true);
  assert.match(t.ui.text(), /The connection AI in One SQL ws-1 was deleted\. Creating it again\./);
});

test('connection: when binding fails the user can retry, say they did it, or skip', async () => {
  const skip = setup({ answers: ['retry', 'skip'] });
  await withModel(skip);
  skip.fabric.failures.bindConnection = [httpError(400, 'No match'), httpError(400, 'No match')];
  await ensureModelConnection(skip.ctx);
  assert.equal(skip.config.semanticModel.bound, false);
  assert.equal(skip.fabric.calls.filter((c) => c.startsWith('bindConnection')).length, 2);
  assert.match(skip.ui.text(), /Gateway and cloud connections/);
  assert.match(skip.ui.text(), /https:\/\/app\.powerbi\.com\/groups\/ws-1\/settings\/datasets\//);

  const done = setup({ answers: ['done'] });
  await withModel(done);
  done.fabric.failures.bindConnection = [httpError(400, 'No match')];
  await ensureModelConnection(done.ctx);
  assert.equal(done.config.semanticModel.bound, true);

  const unattended = setup({ yes: true });
  await withModel(unattended);
  unattended.fabric.failures.bindConnection = [httpError(400, 'No match')];
  await ensureModelConnection(unattended.ctx);
  assert.equal(unattended.config.semanticModel.bound, false);
  assert.deepEqual(unattended.ui.asked, [], '--yes skips without asking');
});

test('refresh: polls until it ends and reports a failure with its messages', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  /** @type {any[]} */
  const bodies = [];
  const refresh = t.powerBi.api.refresh;
  t.powerBi.api.refresh = async (ws, id, body) => {
    bodies.push(body);
    return refresh(ws, id, body);
  };
  t.powerBi.states.push({ status: 'Unknown', extendedStatus: 'InProgress' }, { status: 'Completed', extendedStatus: 'Completed' });
  const ok = await refreshModel(t.ctx);
  assert.deepEqual(ok, { ok: true, status: 'Completed' });
  assert.deepEqual(t.powerBi.calls, ['refresh model-1 full', 'getRefresh request-1', 'getRefresh request-1']);
  assert.deepEqual(bodies, [{ type: 'full', commitMode: 'transactional', applyRefreshPolicy: true, retryCount: 1 }]);
  assert.deepEqual(t.sleeps, [20_000]);

  t.powerBi.states.push({ status: 'Failed', messages: [{ message: 'Login failed for user' }] });
  const bad = await refreshModel(t.ctx);
  assert.deepEqual(bad, { ok: false, status: 'Failed' });
  assert.match(t.ui.text(), /The refresh ended as Failed/);
  assert.match(t.ui.text(), /Login failed for user/);

  const quick = await refreshModel(t.ctx, { wait: false });
  assert.deepEqual(quick, { ok: true, status: 'Unknown' });
});

test('refresh: Completed with a warning or error message is a failure, since parts of the model were not calculated', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  const warning = "Failed to save modifications to the server. Error returned: 'The syntax for 'LastDate' is incorrect.'";
  t.powerBi.states.push({ status: 'Completed', extendedStatus: 'Completed', messages: [{ type: 'Warning', message: warning }] });
  assert.deepEqual(await refreshModel(t.ctx), { ok: false, status: 'Completed' });
  const text = t.ui.text();
  assert.match(text, /AI in One refreshed, but Power BI reported problems/);
  assert.match(text, /The syntax for 'LastDate' is incorrect/);
  assert.match(text, /Run the installer again/);

  t.powerBi.states.push({ status: 'Completed', extendedStatus: 'Completed', messages: [{ type: 'Error', message: 'x' }] });
  assert.equal((await refreshModel(t.ctx)).ok, false);
  t.powerBi.states.push({ status: 'Completed', extendedStatus: 'Completed', messages: [{ type: 'Information', message: 'fine' }] });
  assert.deepEqual(await refreshModel(t.ctx), { ok: true, status: 'Completed' });
});

test('probe: a model whose Calendar has days passes; an empty or broken one fails; a blocked API is skipped', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  assert.deepEqual(await verifyModel(t.ctx), { ok: true, calendarDays: 90 });
  assert.deepEqual(t.powerBi.calls, ['executeQueries model-1']);
  assert.match(MODEL_PROBE, /COUNTROWS\('Calendar'\)/);
  assert.match(t.ui.text(), /AI in One answers queries \(its Calendar has 90 days\)/);

  t.powerBi.answers.push({ results: [{ tables: [{ rows: [{ '[CalendarDays]': 0 }] }] }] });
  assert.equal((await verifyModel(t.ctx)).ok, false);
  assert.match(t.ui.text(), /its Calendar table is empty/);

  const detail = "Query (1, 26) The expression referenced column 'Calendar'[Date] which does not hold any data because it needs to be recalculated.";
  t.powerBi.failures.executeQueries = [new HttpError('Bad request', { status: 400, method: 'POST', url: 'https://x', body: { error: { code: 'DatasetExecuteQueriesError', 'pbi.error': { details: [{ code: 'DetailsMessage', detail: { value: detail } }] } } } })];
  const broken = await verifyModel(t.ctx);
  assert.equal(broken.ok, false);
  assert.match(String(broken.error), /needs to be recalculated/);
  assert.match(t.ui.text(), /a test query failed, so report pages will fail/);

  t.powerBi.failures.executeQueries = [httpError(401, 'Unauthorized')];
  assert.deepEqual(await verifyModel(t.ctx), { ok: true, skipped: true });
  assert.match(t.ui.text(), /Execute Queries REST API/);

  t.powerBi.failures.executeQueries = [httpError(500, 'Boom')];
  assert.deepEqual(await verifyModel(t.ctx), { ok: true, skipped: true }, 'a service hiccup does not fail a finished install');
  assert.match(t.ui.text(), /Couldn't query AI in One to check it \(Boom\)/);

  t.config.semanticModel.bound = false;
  const before = t.powerBi.calls.length;
  assert.deepEqual(await verifyModel(t.ctx), { ok: true, skipped: true });
  assert.equal(t.powerBi.calls.length, before, 'an unconnected model is not queried');
});

test('refresh: one already running is followed; an unconnected model is not refreshed', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  t.powerBi.failures.refresh = [httpError(409, 'Another refresh is in progress')];
  t.powerBi.history.push({ requestId: 'running-1', status: 'Unknown' });
  await refreshModel(t.ctx);
  assert.deepEqual(t.powerBi.calls, ['refresh model-1 full', 'getRefresh running-1']);
  assert.match(t.ui.text(), /A refresh is already running, so following that one\./);

  t.config.semanticModel.bound = false;
  assert.deepEqual(await refreshModel(t.ctx), { ok: false });
  assert.match(t.ui.text(), /isn't connected to the Lakehouse/);

  delete t.config.semanticModel.id;
  await assert.rejects(refreshModel(t.ctx), /There is no semantic model yet/);
});

test('rotate: the connection gets a new secret and the old one leaves the app', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  await rotateModelSecret(t.ctx);
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId), ['key-2']);
  assert.equal(/** @type {any} */ (t.fabric.connections[0].body).credentialDetails.credentials.servicePrincipalSecret, 'secret-2');
  assert.equal(t.config.semanticModel.secretKeyId, 'key-2');
  assert.equal(t.config.semanticModel.secretExpires?.slice(0, 10), '2027-06-01');
  assert.match(t.ui.text(), /Gave "AI in One SQL ws-1" a new secret \(expires 2027-06-01\)/);
});

/** Graph calls without the per-run ref in a new secret's name. @param {string[]} calls */
const unref = (calls) => calls.map((c) => c.replace(/ \(ref [0-9a-f]{12}\)$/, ''));

test('connection secret: one Entra made before a stopped run saved its key is found by its ref, replaced, then removed', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  const sm = t.config.semanticModel;
  // The stopped run had saved its ref and Entra had made the secret; then it stopped.
  t.graph.passwords.push({ keyId: 'key-lost', displayName: `${CONNECTION_SECRET_NAME} (ref aaaaaaaaaaaa)` }, { keyId: 'key-other', displayName: CONNECTION_SECRET_NAME });
  sm.secretAttempts = [{ ref: 'aaaaaaaaaaaa', at: '2026-06-01T11:59:00Z' }];
  t.graph.calls.length = 0;
  t.fabric.calls.length = 0;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(unref(t.graph.calls), ['listPasswords', `addPassword ${CONNECTION_SECRET_NAME}`, 'removePassword key-1', 'removePassword key-lost']);
  assert.deepEqual(t.fabric.calls, [`updateConnection ${sm.connectionId}`], 'the connection gets the new one before any is removed');
  assert.equal(sm.secretKeyId, 'key-2');
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId).sort(), ['key-2', 'key-other'], "one without the ref isn't touched");
  for (const f of /** @type {const} */ (['secretAttempts', 'pendingSecretKeyIds', 'retiredSecretKeyIds'])) assert.equal(sm[f], undefined, f);
  assert.match(t.ui.text(), /without recording it/);
});

test('connection secret: a failed update keeps the new key tracked unless Fabric turned it down; the next run settles it', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  const sm = t.config.semanticModel;

  // Fabric may have stored it before the error: kept, and the one in use stays.
  t.fabric.failures.updateConnection = [httpError(500, 'Internal')];
  await assert.rejects(rotateModelSecret(t.ctx), /couldn't update the model's connection: Internal/);
  assert.equal(sm.secretKeyId, 'key-1');
  assert.deepEqual(sm.pendingSecretKeyIds, ['key-2']);
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId), ['key-1', 'key-2']);

  // The next run gives the connection a newer one, then removes both.
  t.graph.calls.length = 0;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(unref(t.graph.calls), [`addPassword ${CONNECTION_SECRET_NAME}`, 'removePassword key-1', 'removePassword key-2']);
  assert.equal(sm.secretKeyId, 'key-3');
  assert.equal(sm.pendingSecretKeyIds, undefined);
  assert.match(t.ui.text(), /may have given it to the connection/);

  // Turned down: nothing holds it, so it's removed and the one in use stays.
  t.fabric.failures.updateConnection = [httpError(400, 'Bad request')];
  t.graph.calls.length = 0;
  await assert.rejects(rotateModelSecret(t.ctx), /Bad request/);
  assert.deepEqual(unref(t.graph.calls), [`addPassword ${CONNECTION_SECRET_NAME}`, 'removePassword key-4']);
  assert.equal(sm.secretKeyId, 'key-3');
  assert.equal(sm.pendingSecretKeyIds, undefined);
  assert.equal(sm.retiredSecretKeyIds, undefined);

  // Entra won't remove an old one: it stays listed and is tried again next run.
  t.graph.failures.removePassword = [httpError(500, 'busy')];
  await rotateModelSecret(t.ctx);
  assert.deepEqual(sm.retiredSecretKeyIds, ['key-3']);
  t.graph.calls.length = 0;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(t.graph.calls, ['removePassword key-3']);
  assert.equal(sm.retiredSecretKeyIds, undefined);
});

test('connection secret: if Entra may have made the secret before an error, its ref is kept and the next run looks for it', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  const sm = /** @type {any} */ (t.config.semanticModel);
  t.graph.failures.addPassword = [httpError(400, 'Bad request')];
  await assert.rejects(rotateModelSecret(t.ctx), /Bad request/);
  assert.equal(sm.secretAttempts, undefined, 'turned down: nothing was made');
  t.graph.failures.addPassword = [new Error('socket hang up')];
  await assert.rejects(rotateModelSecret(t.ctx), /socket hang up/);
  assert.equal(sm.secretAttempts?.length, 1, 'may have been made: the ref stays');
  // Entra had made it after all.
  t.graph.passwords.push({ keyId: 'key-made', displayName: `${CONNECTION_SECRET_NAME} (ref ${sm.secretAttempts?.[0].ref})` });
  await rotateModelSecret(t.ctx);
  assert.ok(!t.graph.passwords.some((p) => p.keyId === 'key-made'), 'found, then removed once the new one is in use');
  assert.equal(sm.secretAttempts, undefined);
  assert.equal(sm.pendingSecretKeyIds, undefined);
});

test('connection secret: a stopped run that made the connection but not the record: found by name, given a new secret, and the old ones removed', async () => {
  const t = setup();
  await withModel(t);
  const sm = t.config.semanticModel;
  // Stopped after Fabric created the connection with key-1 but before its ID was saved.
  t.fabric.failures.createConnection = [httpError(500, 'Internal')];
  await assert.rejects(ensureModelConnection(t.ctx), /Internal/);
  assert.deepEqual(sm.pendingSecretKeyIds, ['key-1']);
  t.fabric.connections.push({ id: 'conn-made', displayName: connectionName('ws-1') });
  await ensureModelConnection(t.ctx);
  assert.equal(sm.connectionId, 'conn-made');
  assert.equal(sm.secretKeyId, 'key-2');
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId), ['key-2']);
  assert.equal(sm.pendingSecretKeyIds, undefined);
});

test('tenant settings: only a setting that is off and not delegated is flagged; the report\'s settings only with the report', () => {
  const settings = {
    ServicePrincipalAccessPermissionAPIs: { enabled: false },
    CustomVisualsTenant: { enabled: false },
    DatasetExecuteQueries: { enabled: false },
  };
  assert.deepEqual(blockedSettings(settings).map((s) => s.name), ['ServicePrincipalAccessPermissionAPIs']);
  assert.deepEqual(blockedSettings(settings, { reports: true }).map((s) => s.name), ['ServicePrincipalAccessPermissionAPIs', 'CustomVisualsTenant']);
  assert.deepEqual(blockedSettings({ ServicePrincipalAccessPermissionAPIs: { enabled: false, delegateToCapacity: true }, CustomVisualsTenant: { enabled: true } }, { reports: true }), []);
  assert.deepEqual(blockedSettings(undefined, { reports: true }), []);
});
