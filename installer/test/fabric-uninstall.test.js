// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTEBOOKS } from '../src/catalog.js';
import { ENDPOINT_POLL_MS, fabricUninstall } from '../src/steps/fabric-uninstall.js';
import { createUi } from '../src/ui.js';
import { fakeAzureGraph, fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const APP_QUESTION = 'Delete the app registration "AI in One" too? Only do this if nothing else uses it. Entra keeps it under Deleted applications for 30 days.';
const DELETES = /^(listPrivateEndpoints|deletePrivateEndpoint|deleteWorkspace|deleteItem|deleteRoleAssignment|deleteConnection)\b/;

/**
 * An install with every item the installer makes, in a workspace it created or one the user had.
 * @param {{ created: boolean, answers?: any[], ui?: any }} o
 */
function setup(o) {
  const fabric = fakeFabric();
  const graph = fakeAzureGraph();
  const u = fakeUi({ answers: o.answers });
  const { ctx, config, sleeps } = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: o.ui ?? u.ui });
  const f = config.fabric;
  Object.assign(f, {
    workspaceName: o.created ? 'AI in One' : 'Team analytics',
    createdWorkspace: o.created,
    lakehouseName: 'CopilotAnalytics',
    pipelineId: 'pl-1',
    pipelineName: 'AI in One pipeline',
    notebooks: Object.fromEntries(NOTEBOOKS.map((nb) => [nb.key, `nb-${nb.key}`])),
  });
  Object.assign(config.semanticModel, {
    id: 'sm-1',
    name: 'AI in One (Fabric)',
    connectionId: 'conn-1',
    connectionName: 'AI in One SQL ws-1',
    report: { id: 'rp-1', name: 'AI in One' },
  });
  config.app.displayName = 'AI in One';
  config.keyVault.name = 'kv-ai-in-one-test';
  Object.assign(config.access ??= {}, { groupId: 'g-1', groupName: 'AI in One Viewers' });
  fabric.items.push(
    { id: 'rp-1', type: 'Report', displayName: 'AI in One' },
    { id: 'sm-1', type: 'SemanticModel', displayName: 'AI in One (Fabric)' },
    { id: 'pl-1', type: 'DataPipeline', displayName: 'AI in One pipeline' },
    ...NOTEBOOKS.map((nb) => ({ id: `nb-${nb.key}`, type: 'Notebook', displayName: nb.displayName })),
    { id: 'lh-1', type: 'Lakehouse', displayName: 'CopilotAnalytics' },
    { id: 'other-1', type: 'Report', displayName: 'Sales' },
  );
  fabric.roles.push(
    { id: 'sp-1', principal: { id: 'sp-1', type: 'ServicePrincipal' }, role: 'Viewer' },
    { id: 'u-1', principal: { id: 'u-1', type: 'User' }, role: 'Admin' },
  );
  return { ctx, config, fabric, graph, ui: u, sleeps };
}

test('uninstall, created workspace: asks, deletes the private endpoints, then the workspace, then the model connection', async () => {
  const { ctx, fabric, graph, ui, sleeps } = setup({ created: true });
  fabric.privateEndpoints.push({ id: 'mpe-1', name: 'kv-ai-in-one-test' });
  fabric.endpointLag.lists = 1;
  assert.equal(await fabricUninstall(ctx), true);
  assert.deepEqual(ui.asked, ['Delete workspace "AI in One" and everything in it, including the Lakehouse data?', APP_QUESTION]);
  assert.deepEqual(fabric.calls.filter((c) => DELETES.test(c)), [
    'listPrivateEndpoints',
    'deletePrivateEndpoint mpe-1',
    'listPrivateEndpoints',
    'listPrivateEndpoints',
    'deleteWorkspace ws-1',
    'deleteConnection conn-1',
  ], 'the workspace goes once its endpoints have; no item is deleted one by one');
  assert.deepEqual(sleeps, [ENDPOINT_POLL_MS]);
  assert.deepEqual(graph.calls.filter((c) => c.startsWith('deleteApplication')), [], 'no by default');
  const text = ui.text();
  assert.match(text, /Deleted the managed private endpoint \(kv-ai-in-one-test\)/);
  assert.match(text, /Deleted workspace "AI in One"/);
  assert.match(text, /Deleted the connection "AI in One SQL ws-1"/);
  assert.match(text, /Left alone: the app registration "AI in One" and its client secrets, the Key Vault "kv-ai-in-one-test" and its secret and the viewer group "AI in One Viewers"\. Remove them yourself if nothing else uses them\./);
  assert.match(text, /The install record still names the deleted workspace\. Move it aside before installing again\./);
});

test('uninstall, created workspace: the app registration goes only when the installer made it and the user says yes', async () => {
  const yes = setup({ created: true, answers: [true, true] });
  assert.equal(await fabricUninstall(yes.ctx), true);
  assert.deepEqual(yes.graph.calls.filter((c) => c.startsWith('deleteApplication')), ['deleteApplication obj-1']);
  assert.match(yes.ui.text(), /Deleted the app registration "AI in One"/);
  assert.doesNotMatch(yes.ui.text(), /Left alone: the app registration/);

  for (const app of [{ existing: true }, { adminPack: true }, { objectId: undefined }]) {
    const s = setup({ created: true, answers: [true, true] });
    Object.assign(s.config.app, app);
    assert.equal(await fabricUninstall(s.ctx), true);
    assert.deepEqual(s.ui.asked, ['Delete workspace "AI in One" and everything in it, including the Lakehouse data?'], `not offered: ${JSON.stringify(app)}`);
    assert.deepEqual(s.graph.calls.filter((c) => c.startsWith('deleteApplication')), []);
  }

  /** @type {string[]} */
  const out = [];
  const auto = setup({ created: true, ui: createUi({ yes: true, write: (s) => out.push(s) }) });
  assert.equal(await fabricUninstall(auto.ctx), true);
  assert.ok(auto.fabric.calls.includes('deleteWorkspace ws-1'), '--yes takes the yes default for the workspace');
  assert.deepEqual(auto.graph.calls.filter((c) => c.startsWith('deleteApplication')), [], '--yes keeps the app registration');
});

test('uninstall, created workspace: no means nothing is deleted', async () => {
  const { ctx, fabric, graph, ui } = setup({ created: true, answers: [false] });
  assert.equal(await fabricUninstall(ctx), false);
  assert.deepEqual(fabric.calls.filter((c) => DELETES.test(c)), []);
  assert.deepEqual(graph.calls.filter((c) => c.startsWith('deleteApplication')), []);
  assert.match(ui.text(), /Left workspace "AI in One" alone\./);
});

test('uninstall, the user\'s workspace: only the installer\'s items go, in order, and only the app\'s Viewer role', async () => {
  const { ctx, fabric, ui } = setup({ created: false });
  assert.equal(await fabricUninstall(ctx), true);
  assert.equal(ui.asked[0], 'Delete what AI in One created in workspace "Team analytics"? The workspace and everything else in it stay.');
  assert.deepEqual(fabric.calls.filter((c) => DELETES.test(c)), [
    'deleteItem AI in One',
    'deleteItem AI in One (Fabric)',
    'deleteItem AI in One pipeline',
    ...NOTEBOOKS.map((nb) => `deleteItem ${nb.displayName}`),
    'deleteItem CopilotAnalytics',
    'deleteRoleAssignment sp-1',
    'deleteConnection conn-1',
  ], 'report, model, pipeline, notebooks, then the Lakehouse it created; never the workspace');
  assert.deepEqual(fabric.items.map((i) => i.displayName), ['Sales'], 'anything else in the workspace stays');
  assert.deepEqual(fabric.roles.map((r) => r.id), ['u-1']);
  const text = ui.text();
  assert.match(text, /AI in One created these in workspace "Team analytics":/);
  assert.match(text, / {2}The report "AI in One"/);
  assert.match(text, / {2}The pipeline "AI in One pipeline" \(deleting it also removes its schedule\)/);
  assert.match(text, / {2}The Lakehouse "CopilotAnalytics"/);
  assert.match(text, /Removed AI in One's Viewer role on the workspace/);
  assert.match(text, /Left alone: the app registration "AI in One" and its client secrets, the Key Vault "kv-ai-in-one-test" and its secret and the viewer group "AI in One Viewers"\./);
  assert.match(text, /The install record still names the deleted items\. Move it aside before installing again\./);
});

test('uninstall, the user\'s workspace: a Lakehouse they had and an app role the installer didn\'t give stay', async () => {
  const { ctx, config, fabric, ui } = setup({ created: false });
  config.fabric.existingLakehouse = true;
  config.keyVault.mode = 'notebook';
  config.app.existing = true;
  delete config.access?.groupId;
  /** @type {any} */ (fabric.roles[0]).role = 'Contributor';
  assert.equal(await fabricUninstall(ctx), true);
  assert.equal(ui.asked.length, 1, 'an app registration the user had is not offered for deletion');
  const deleted = fabric.calls.filter((c) => DELETES.test(c));
  assert.ok(!deleted.includes('deleteItem CopilotAnalytics'), 'their Lakehouse stays');
  assert.ok(!deleted.some((c) => c.startsWith('deleteRoleAssignment')));
  assert.ok(fabric.items.some((i) => i.displayName === 'CopilotAnalytics'));
  const text = ui.text();
  assert.doesNotMatch(text, / {2}The Lakehouse /);
  assert.match(text, /Left AI in One's Contributor role on the workspace: the installer only gives it Viewer\./);
  assert.match(text, /Left alone: the app registration "AI in One" and its client secrets and the Lakehouse "CopilotAnalytics" with its tables and files\./);
});
