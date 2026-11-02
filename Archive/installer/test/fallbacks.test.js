// @ts-check
/**
 * Installs where the user lacks rights: a vault admin adds the secret, the secret goes in the
 * notebooks, a vault in a resource group the user only has Contributor on, and an app
 * registration an admin makes for them.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GRAPH_APP_ID } from '../src/catalog.js';
import { parseCli } from '../src/cli.js';
import { secretMode } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { rotateSecret } from '../src/install.js';
import { CREATE_SETTLE_MS, createdId, ensureNotebooks, ensurePipeline, modelKey, SECRET_SETTLE_MS, secretLabel, settleSecretAttempts, stoppedRunItem } from '../src/steps/fabric.js';
import {
  ADMIN_PACK_FILE,
  canWriteSecrets,
  checkExistingApp,
  ensureKeyVault,
  ensureSecret,
  handoffCommands,
  isResumeLater,
  newSecret,
  reportAppCheck,
  ResumeLater,
  secretHandoff,
  writeAdminPack,
} from '../src/steps/identity.js';
import { deployModel } from '../src/steps/model.js';
import { removeRetired } from '../src/steps/secrets.js';
import { askAppId, confirmPlan, defaultsToNoVault, planAdminPack, planKeyVault, planReview, reserveNames } from '../src/steps/plan.js';
import { fakeCtx, fakeFabric, fakeGraph, fakeUi, httpError } from './fakes.js';

/** Graph calls without the per-run ref in a new secret's name. @param {string[]} calls */
const unref = (calls) => calls.map((c) => c.replace(/ \(ref [0-9a-f]{12}\)$/, ''));

const VAULT_ID = '/subscriptions/sub-1/resourceGroups/rg-ai-in-one/providers/Microsoft.KeyVault/vaults/kv-test';
const OTHER_ID = '/subscriptions/sub-1/resourceGroups/rg-ai-in-one/providers/Microsoft.KeyVault/vaults/kv-mine';
const SUB = '/subscriptions/sub-1';
const APP_GUID = '11111111-2222-3333-4444-555555555555';
const READ_ONLY = [{ actions: ['*/read'] }];
const SECRETS_OFFICER = [{ actions: [], dataActions: ['Microsoft.KeyVault/vaults/secrets/*'] }];
const RG_CONTRIBUTOR = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Authorization/*/Delete'] }];
const PRE = /** @type {any} */ ({ subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], canConsent: false, capacities: [] });

/** @param {{ rbac?: boolean, policies?: any[], id?: string, name?: string }} [o] */
const vault = (o = {}) => ({
  id: o.id ?? VAULT_ID,
  name: o.name ?? 'kv-test',
  location: 'uksouth',
  properties: { vaultUri: 'https://kv-test.vault.azure.net/', enableRbacAuthorization: o.rbac ?? true, accessPolicies: o.policies ?? [] },
});

/**
 * Resource Manager calls for vault work.
 * @param {{ vaults?: any[], perms?: Record<string, any[]>, groups?: string[], assignFails?: boolean, policyFails?: boolean, providerFails?: boolean, groupFails?: boolean, createError?: Error }} [o]
 */
function vaultArm(o = {}) {
  /** @type {string[]} */
  const calls = [];
  const groups = new Set(o.groups ?? []);
  const api = {
    listVaults: async () => o.vaults ?? [],
    getVault: async (/** @type {string} */ id) => (o.vaults ?? []).find((v) => v.id === id),
    permissions: async (/** @type {string} */ scope) => o.perms?.[scope] ?? [],
    getResourceGroup: async (/** @type {string} */ _s, /** @type {string} */ name) => (groups.has(name) ? { name } : null),
    checkVaultName: async () => ({ nameAvailable: true }),
    ensureProvider: async () => {
      calls.push('ensureProvider');
      if (o.providerFails) throw httpError(403, 'Forbidden');
      return false;
    },
    ensureResourceGroup: async (/** @type {string} */ _s, /** @type {string} */ name) => {
      calls.push(`ensureResourceGroup ${name}`);
      if (o.groupFails) throw httpError(403, 'Forbidden');
      return { name };
    },
    createVault: async (/** @type {any} */ v) => {
      calls.push(`createVault ${v.resourceGroup}/${v.name}`);
      if (o.createError) throw o.createError;
      return vault({ rbac: v.rbac, name: v.name, id: `${SUB}/resourceGroups/${v.resourceGroup}/providers/Microsoft.KeyVault/vaults/${v.name}` });
    },
    assignRole: async (/** @type {string} */ _scope, /** @type {string} */ role) => {
      calls.push(`assignRole ${role}`);
      if (o.assignFails) throw httpError(403, 'Forbidden');
      return true;
    },
    addAccessPolicy: async (/** @type {string} */ _id, /** @type {string} */ _t, /** @type {string} */ _o, /** @type {string[]} */ secrets = ['get', 'list', 'set']) => {
      calls.push(`addAccessPolicy ${secrets.join(',')}`);
      if (o.policyFails) throw httpError(403, 'Forbidden');
    },
  };
  return { api, calls };
}

/**
 * Graph calls for checking an app the user brought.
 * @param {{ application?: any, sp?: any, assigned?: string[][] }} [o]  `assigned` is what each check sees, in turn.
 */
function appGraph(o = {}) {
  const assigned = [...(o.assigned ?? [[]])];
  const graphSp = {
    id: 'graph-sp',
    appRoles: [
      { id: 'r-audit', value: 'AuditLogsQuery.Read.All' },
      { id: 'r-reports', value: 'Reports.Read.All' },
      { id: 'r-users', value: 'User.Read.All' },
    ],
  };
  const api = {
    graphServicePrincipal: async () => graphSp,
    findApplication: async () => o.application ?? null,
    findServicePrincipal: async () => o.sp ?? null,
    appRoleAssignments: async () => (assigned.length > 1 ? assigned.shift() ?? [] : assigned[0]).map((appRoleId) => ({ resourceId: 'graph-sp', appRoleId })),
  };
  return { api };
}

const THEIR_APP = {
  id: 'their-obj',
  displayName: 'Their app',
  requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: ['r-audit', 'r-reports', 'r-users'].map((id) => ({ id, type: 'Role' })) }],
};

/** An install using an existing vault the user can't write to, with a vault admin adding the secret. */
function adminCtx(o = {}) {
  const made = fakeCtx(o);
  Object.assign(made.config.keyVault, { existing: true, id: VAULT_ID, name: 'kv-test', mode: 'keyvault-admin', rbac: true });
  delete made.config.keyVault.uri;
  return made;
}

test('secret modes: a record without a mode keeps the secret in Key Vault; ResumeLater is told apart from failures', () => {
  const { config } = fakeCtx();
  assert.equal(secretMode(config), 'keyvault');
  config.keyVault.mode = 'notebook';
  assert.equal(secretMode(config), 'notebook');
  assert.equal(isResumeLater(new ResumeLater('later')), true);
  assert.equal(isResumeLater(new Error('boom')), false);
  assert.equal(isResumeLater(undefined), false);
});

test('secret modes: a new install keeps the secret in the notebooks by default; --key-vault or a chosen vault changes that', () => {
  const fresh = () => {
    const c = fakeCtx();
    delete c.config.keyVault.uri;
    return c;
  };
  const t = fresh();
  assert.equal(defaultsToNoVault(t.ctx), true);
  t.ctx.useKeyVault = true;
  assert.equal(defaultsToNoVault(t.ctx), false);
  for (const kv of [{ mode: /** @type {const} */ ('notebook') }, { uri: 'https://kv-test.vault.azure.net/' }, { name: 'kv-test' }, { subscriptionId: 'sub-1' }]) {
    const c = fresh();
    Object.assign(c.config.keyVault, kv);
    assert.equal(defaultsToNoVault(c.ctx), false, JSON.stringify(kv));
  }
});

test('vault admin: the commands create the secret in the vault and never hold its value', () => {
  const { config } = adminCtx();
  const [only, ...rest] = handoffCommands(config, { userId: 'user-1' });
  assert.deepEqual(rest, []);
  assert.match(only, /^az keyvault secret set --vault-name kv-test --name ai-in-one-client-secret /);
  assert.match(only, /--value "\$\(az ad app credential reset --id app-1 --append /);
  assert.doesNotMatch(only, /secret-\d|s3cret/);

  config.keyVault.handoff = { grantRead: true };
  const rbac = handoffCommands(config, { userId: 'user-1' });
  assert.equal(rbac.length, 2);
  assert.equal(rbac[0], `az role assignment create --role "Key Vault Secrets User" --assignee-object-id user-1 --assignee-principal-type User --scope ${VAULT_ID}`);
  config.keyVault.rbac = false;
  assert.equal(handoffCommands(config, { userId: 'user-1' })[0], 'az keyvault set-policy --name kv-test --object-id user-1 --secret-permissions get list');
  assert.equal(handoffCommands(config).length, 1, 'no reader line without a user');
});

test('vault admin: can the user write secrets, or give themselves the right to', async () => {
  const check = async (/** @type {any} */ v, /** @type {any[] | null} */ perms) => {
    const { ctx } = fakeCtx({ arm: { permissions: async () => (perms === null ? Promise.reject(new Error('no')) : perms) } });
    return canWriteSecrets(ctx, v);
  };
  assert.equal(await check(vault(), SECRETS_OFFICER), true);
  assert.equal(await check(vault(), READ_ONLY), false);
  assert.equal(await check(vault(), [{ actions: ['Microsoft.Authorization/roleAssignments/write'] }]), true);
  assert.equal(await check(vault({ rbac: false, policies: [{ objectId: 'user-1', permissions: { secrets: ['Get', 'Set'] } }] }), READ_ONLY), true);
  assert.equal(await check(vault({ rbac: false, policies: [{ objectId: 'user-1', permissions: { secrets: ['get'] } }] }), READ_ONLY), false);
  assert.equal(await check(vault({ rbac: false }), [{ actions: ['Microsoft.KeyVault/vaults/accessPolicies/write'] }]), true);
  assert.equal(await check(vault(), null), true, 'unknown rights fall through to the usual path');
});

test('vault admin: the user gets read access when they can, or the admin is asked for it', async () => {
  const rbac = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: READ_ONLY } });
  const ui = fakeUi();
  const t = adminCtx({ arm: rbac.api, ui: ui.ui });
  await ensureKeyVault(t.ctx);
  assert.deepEqual(rbac.calls, ['assignRole 4633458b-17de-408a-b874-0445c86b69e6']);
  assert.equal(t.config.keyVault.uri, 'https://kv-test.vault.azure.net/');
  assert.equal(t.config.keyVault.handoff?.grantRead, undefined);
  assert.match(ui.text(), /Gave you Key Vault Secrets User/);

  const reader = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: [{ actions: [], dataActions: ['Microsoft.KeyVault/vaults/secrets/getSecret/action'] }] } });
  const has = adminCtx({ arm: reader.api });
  await ensureKeyVault(has.ctx);
  assert.deepEqual(reader.calls, [], 'already a reader');

  const denied = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: READ_ONLY }, assignFails: true });
  const deniedUi = fakeUi();
  const d = adminCtx({ arm: denied.api, ui: deniedUi.ui });
  await ensureKeyVault(d.ctx);
  assert.equal(d.config.keyVault.handoff?.grantRead, true);
  assert.match(deniedUi.text(), /can't give yourself read access to kv-test/);

  const policy = vaultArm({ vaults: [vault({ rbac: false })] });
  const p = adminCtx({ arm: policy.api });
  await ensureKeyVault(p.ctx);
  assert.deepEqual(policy.calls, ['addAccessPolicy get,list'], 'read only: no set');

  const policyDenied = vaultArm({ vaults: [vault({ rbac: false })], policyFails: true });
  const pd = adminCtx({ arm: policyDenied.api });
  await ensureKeyVault(pd.ctx);
  assert.equal(pd.config.keyVault.handoff?.grantRead, true);
});

test('vault admin: the default path still stops when the user can\'t write secrets', async () => {
  const arm = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: READ_ONLY }, assignFails: true });
  const t = adminCtx({ arm: arm.api });
  delete t.config.keyVault.mode;
  await assert.rejects(ensureKeyVault(t.ctx), /You can't write secrets to kv-test/);

  const policy = vaultArm({ vaults: [vault({ rbac: false })] });
  const p = adminCtx({ arm: policy.api });
  delete p.config.keyVault.mode;
  await ensureKeyVault(p.ctx);
  assert.deepEqual(policy.calls, ['addAccessPolicy get,list,set']);
});

test('vault admin: the handoff shows the steps, can make the admin an owner, and stops to resume later', async () => {
  /** @type {string[]} */
  const owners = [];
  const graph = {
    getUser: async (/** @type {string} */ upn) => (upn === 'kv.admin@example.com' ? { id: 'admin-1', displayName: 'Vault Admin', userPrincipalName: upn } : null),
    addOwner: async (/** @type {string} */ app, /** @type {string} */ user) => {
      owners.push(`${app} ${user}`);
    },
  };
  const ui = fakeUi({ answers: ['kv.admin@example.com', 'stop'] });
  const t = adminCtx({ graph, ui: ui.ui });
  t.config.keyVault.uri = 'https://kv-test.vault.azure.net/';
  await assert.rejects(secretHandoff(t.ctx), (err) => isResumeLater(err));
  assert.deepEqual(owners, ['obj-1 admin-1']);
  assert.equal(t.config.keyVault.handoff?.adminEmail, 'kv.admin@example.com');
  assert.equal(t.config.keyVault.handoff?.shownAt, '2026-06-01T12:00:00.000Z');
  assert.equal(t.config.keyVault.secretSetAt, undefined);
  const text = ui.text();
  assert.match(text, /Vault: {3}kv-test/);
  assert.match(text, /Secret: {2}ai-in-one-client-secret/);
  assert.match(text, /az keyvault secret set --vault-name kv-test/);
  assert.match(text, /Certificates & secrets > New client secret/);

  // Run again: the secret is there now.
  const again = fakeUi({ answers: ['', 'go'] });
  t.ctx.ui = again.ui;
  assert.equal(await secretHandoff(t.ctx), true);
  assert.equal(t.config.keyVault.secretSetAt, '2026-06-01T12:00:00.000Z');
  assert.equal(t.config.keyVault.handoff?.confirmedAt, '2026-06-01T12:00:00.000Z');
  assert.match(again.text(), /The vault admin has added the secret ai-in-one-client-secret/);

  const quiet = fakeUi({ yes: true });
  const unattended = adminCtx({ ui: quiet.ui });
  assert.equal(await secretHandoff(unattended.ctx), false);
  assert.deepEqual(quiet.asked, []);
  assert.match(quiet.text(), /Carrying on\. Data loads fail until the secret is in kv-test/);
  assert.equal(unattended.config.keyVault.secretSetAt, undefined);
});

test('vault admin: a name that holds another app\'s secret in a shared vault isn\'t handed over', async () => {
  const keyVault = {
    secretInfo: async (/** @type {string} */ _uri, /** @type {string} */ name) =>
      name === 'ai-in-one-client-secret' ? { contentType: 'Client secret for another-app' } : null,
  };
  const ui = fakeUi({ answers: ['', 'go'] });
  const t = adminCtx({ keyVault, ui: ui.ui });
  assert.equal(await secretHandoff(t.ctx), true);
  assert.equal(t.config.keyVault.secretName, 'ai-in-one-client-secret-2');
  assert.match(ui.text(), /--name ai-in-one-client-secret-2 /);

  // Without read access yet, the admin is told to check the name.
  const blind = fakeUi({ answers: ['', 'go'] });
  const b = adminCtx({ keyVault: { secretInfo: async () => Promise.reject(httpError(403, 'Forbidden')) }, ui: blind.ui });
  assert.equal(await secretHandoff(b.ctx), true);
  assert.equal(b.config.keyVault.secretName, 'ai-in-one-client-secret');
  assert.match(blind.text(), /Couldn't check whether kv-test already has a secret called ai-in-one-client-secret/);
});

test('vault admin: an unknown email or an existing owner doesn\'t stop the handoff', async () => {
  const graph = {
    getUser: async (/** @type {string} */ upn) => (upn === 'owner@example.com' ? { id: 'admin-1', userPrincipalName: upn } : null),
    addOwner: async () => {
      throw new HttpError('One or more added object references already exist', { status: 400, method: 'POST', url: 'https://x' });
    },
  };
  const ui = fakeUi({ answers: ['nobody@example.com', 'go'] });
  const t = adminCtx({ graph, ui: ui.ui });
  assert.equal(await secretHandoff(t.ctx), true);
  assert.match(ui.text(), /No user nobody@example\.com in this tenant/);

  const owner = adminCtx({ graph, ui: fakeUi({ answers: ['owner@example.com', 'go'] }).ui });
  assert.equal(await secretHandoff(owner.ctx), true);
  assert.equal(owner.config.keyVault.handoff?.adminEmail, 'owner@example.com');

  const theirs = fakeUi({ answers: ['go'] });
  const brought = adminCtx({ ui: theirs.ui });
  brought.config.app.existing = true;
  assert.equal(await secretHandoff(brought.ctx), true);
  assert.deepEqual(theirs.asked, ['Has the admin added the secret?'], 'no owner question for an app the user brought');
});

test('vault admin: ensureSecret and new secrets hand over instead of writing', async () => {
  /** @type {string[]} */
  const calls = [];
  const graph = { addPassword: async () => calls.push('addPassword') };
  const keyVault = { setSecret: async () => calls.push('setSecret'), secretExists: async () => calls.push('secretExists') };

  const done = fakeUi();
  const t = adminCtx({ graph, keyVault, ui: done.ui });
  t.config.keyVault.secretSetAt = '2026-05-01T00:00:00Z';
  t.config.keyVault.handoff = { grantRead: true };
  t.ctx.pendingSecret = 'never-used';
  await ensureSecret(t.ctx);
  assert.equal(t.ctx.pendingSecret, undefined);
  assert.deepEqual(done.asked, []);
  assert.match(done.text(), /You still need read access to kv-test/);
  assert.match(done.text(), /az role assignment create --role "Key Vault Secrets User"/);

  const rotate = fakeUi({ answers: ['', 'go'] });
  const r = adminCtx({ graph, keyVault, ui: rotate.ui });
  r.config.app.secretExpires = '2026-07-01T00:00:00Z';
  await newSecret(r.ctx);
  assert.match(rotate.text(), /A vault admin needs to replace the client secret in kv-test/);
  assert.match(rotate.text(), /delete the old one/);
  assert.equal(r.config.app.secretExpires, undefined);
  assert.deepEqual(calls, [], 'the installer never makes or writes the secret');
});

test('vault admin: rotate-secret shows the steps and can stop to resume later', async () => {
  const ui = fakeUi({ answers: [true, '', 'stop'] });
  const t = adminCtx({ ui: ui.ui });
  t.config.keyVault.uri = 'https://kv-test.vault.azure.net/';
  await assert.rejects(rotateSecret(t.ctx), (err) => isResumeLater(err));
  assert.match(ui.asked[0], /Show the steps for a vault admin to replace the secret in kv-test/);
});

test('notebook mode: the secret is written into the notebooks and nowhere else', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const ui = fakeUi();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: ui.ui });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };

  await ensureNotebooks(t.ctx);
  const holding = fabric.items.filter((i) => String(i.content).includes('secret-1'));
  assert.ok(holding.length >= 1, 'the notebooks that sign in hold the secret');
  for (const item of holding) assert.match(String(item.content), /no Key Vault, so the secret is here\. Anyone with a role in this workspace can read it/);
  assert.equal(t.config.app.secretKeyId, 'key-1');
  assert.equal(t.config.app.secretExpires, '2026-08-30T12:00:00.000Z', '90 days by default');
  assert.ok(t.config.keyVault.secretSetAt);
  assert.equal(t.ctx.pendingSecret, undefined);
  assert.doesNotMatch(ui.text(), /secret-1/);
  assert.doesNotMatch(JSON.stringify(t.config), /secret-1/);

  fabric.calls.length = 0;
  graph.calls.length = 0;
  await ensureNotebooks(t.ctx);
  assert.deepEqual(graph.calls, [], 'a re-run makes no new secret');
  assert.deepEqual(fabric.calls, []);

  // Rotating: a new secret goes into every notebook, then the old one is removed from the app.
  const rotate = fakeUi({ answers: [true] });
  t.ctx.ui = rotate.ui;
  await rotateSecret(t.ctx);
  assert.deepEqual(unref(graph.calls), ['addPassword AI in One installer', 'removePassword key-1']);
  assert.equal(t.config.app.secretKeyId, 'key-2');
  assert.ok(fabric.items.every((i) => !String(i.content).includes('secret-1')));
  assert.equal(fabric.items.filter((i) => String(i.content).includes('secret-2')).length, holding.length);
  assert.match(rotate.text(), /Anyone with a role in the workspace can read the secret in the notebooks\. Key Vault avoids that/);
  assert.doesNotMatch(rotate.text(), /secret-2/);
});

test('notebook mode: each install or repair replaces the secret, then removes the old one', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  t.config.app.secretDays = 30;
  await ensureNotebooks(t.ctx, { rotate: true });
  assert.equal(t.config.app.secretExpires, '2026-07-01T12:00:00.000Z', 'the lifetime is configurable');
  const holding = fabric.items.filter((i) => String(i.content).includes('secret-1')).length;

  graph.calls.length = 0;
  fabric.calls.length = 0;
  await ensureNotebooks(t.ctx, { rotate: true });
  assert.deepEqual(unref(graph.calls), ['addPassword AI in One installer', 'removePassword key-1']);
  assert.equal(fabric.calls.length, holding, 'only the notebooks that hold the secret are rewritten');
  assert.equal(t.config.app.secretKeyId, 'key-2');
  assert.ok(fabric.items.every((i) => !String(i.content).includes('secret-1')));
  assert.doesNotMatch(JSON.stringify(t.config), /secret-\d/);

  // Key Vault mode and an app the user brought are left alone.
  const vaulted = fakeCtx({ fabric: fakeFabric().api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(vaulted.ctx, { rotate: true });
  assert.equal(vaulted.config.app.secretKeyId, undefined);

  const brought = fakeGraph();
  const b = fakeCtx({ fabric: fakeFabric().api, graph: brought.api, ui: fakeUi().ui });
  b.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  b.config.app.existing = true;
  b.ctx.pendingSecret = 'pasted-value';
  await ensureNotebooks(b.ctx);
  b.ctx.pendingSecret = undefined;
  await ensureNotebooks(b.ctx, { rotate: true });
  assert.deepEqual(brought.calls, [], 'a secret the user pasted is never replaced');
});

test('notebook mode: the secret is never written into a workspace connected to Git', async () => {
  const fabric = fakeFabric();
  fabric.git.gitConnectionState = 'ConnectedAndInitialized';
  const graph = fakeGraph();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  await assert.rejects(ensureNotebooks(t.ctx), /connected to Git/);
  assert.deepEqual(graph.calls, [], 'no secret is made');
  assert.ok(fabric.items.every((i) => !/secret-\d/.test(String(i.content))));

  // A lookup that fails doesn't block the install.
  const flaky = fakeFabric();
  flaky.failures.getGitConnection = [new Error('Forbidden')];
  const ui = fakeUi();
  const f = fakeCtx({ fabric: flaky.api, graph: fakeGraph().api, ui: ui.ui });
  f.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  await ensureNotebooks(f.ctx);
  assert.equal(f.config.app.secretKeyId, 'key-1');
  assert.match(ui.text(), /Git/);
});

test('notebook mode: a rotation that stops part-way removes the old secret on the next run', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  await ensureNotebooks(t.ctx);
  assert.equal(t.config.fabric.secretInNotebooks, true);

  const update = fabric.api.updateNotebook;
  let secretWrites = 0;
  fabric.api.updateNotebook = async (/** @type {string} */ ws, /** @type {string} */ id, /** @type {string} */ content) => {
    if (String(content).includes('secret-2') && ++secretWrites === 2) throw new Error('Fabric is busy');
    return update(ws, id, content);
  };
  graph.calls.length = 0;
  await assert.rejects(ensureNotebooks(t.ctx, { force: true }), /Fabric is busy/);
  assert.deepEqual(unref(graph.calls), ['addPassword AI in One installer'], 'the old secret stays while notebooks still use it');
  assert.equal(t.config.app.secretKeyId, 'key-2');
  assert.deepEqual(t.config.app.retiredSecretKeyIds, ['key-1']);

  fabric.api.updateNotebook = update;
  graph.calls.length = 0;
  await ensureNotebooks(t.ctx, { force: true });
  assert.deepEqual(unref(graph.calls), ['addPassword AI in One installer', 'removePassword key-1', 'removePassword key-2']);
  assert.equal(t.config.app.secretKeyId, 'key-3');
  assert.equal(t.config.app.retiredSecretKeyIds, undefined);
  assert.doesNotMatch(JSON.stringify(t.config), /secret-\d/);
});

test('a run stopped while Fabric creates a notebook: the next run uses that notebook and removes the secret it made', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const first = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  first.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  // The record on disk is what the last save wrote; a stopped process saves nothing more.
  let saved = structuredClone(first.config);
  let stopped = false;
  first.ctx.save = () => {
    if (!stopped) saved = structuredClone(first.config);
  };
  const create = fabric.api.createNotebook;
  let creates = 0;
  fabric.api.createNotebook = async (/** @type {string} */ ws, /** @type {string} */ name, /** @type {string} */ content, /** @type {import('../src/clients/fabric.js').ItemRef | undefined} */ ref) => {
    const created = await create(ws, name, content, ref);
    if (++creates === 2) {
      stopped = true;
      throw new Error('stopped');
    }
    return created;
  };
  await assert.rejects(ensureNotebooks(first.ctx), /stopped/);
  assert.equal(Object.keys(saved.fabric.pendingItems ?? {}).length, 1, 'the notebook being created is in the record');
  assert.deepEqual(saved.app.pendingSecretKeyIds, ['key-1'], 'so is the secret it was given');
  const count = fabric.items.length;

  fabric.api.createNotebook = create;
  graph.calls.length = 0;
  const ui = fakeUi();
  const next = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: ui.ui, config: saved });
  await ensureNotebooks(next.ctx);
  const names = fabric.items.map((i) => String(i.displayName));
  assert.ok(names.every((n) => !/_2$/.test(n)), `no second copy: ${names.join(', ')}`);
  assert.equal(new Set(names).size, names.length);
  assert.ok(fabric.items.length > count, 'the rest are created');
  assert.ok(fabric.items.every((i) => !String(i.content).includes('secret-1')), 'the stopped run\'s notebook is rewritten');
  assert.deepEqual(unref(graph.calls), ['addPassword AI in One installer', 'removePassword key-1']);
  assert.equal(next.config.app.secretKeyId, 'key-2');
  assert.equal(next.config.app.pendingSecretKeyIds, undefined);
  assert.equal(next.config.fabric.pendingItems, undefined);
  assert.match(ui.text(), /which the run that stopped part-way created/);
  assert.doesNotMatch(ui.text(), /isn't from this install/);
});

test('a run stopped before Fabric created the item: the next run creates it under the saved name; others still get a new name', async () => {
  const fabric = fakeFabric();
  const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(t.ctx);
  fabric.calls.length = 0;
  // Fabric says that create failed, so nothing is coming.
  const failedOp = 'https://api.fabric.microsoft.com/v1/operations/op-f';
  t.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'aa11', at: t.ctx.now().toISOString(), operation: failedOp } };
  fabric.operations[failedOp] = 'Failed';
  await ensurePipeline(t.ctx);
  assert.deepEqual(fabric.calls, ['operationStatus op-f', 'createPipeline CopilotAdoptionPipeline']);
  assert.equal(t.config.fabric.pendingItems, undefined);
  assert.match(String(fabric.items.find((i) => i.type === 'DataPipeline')?.description), /^\(ref [0-9a-f]{12}\)$/, 'each create gets a fresh ref');

  // Not pending: a same-name item is someone else's and is left alone.
  const other = fakeFabric();
  other.add('DataPipeline', 'CopilotAdoptionPipeline', 'theirs');
  const o = fakeCtx({ fabric: other.api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(o.ctx);
  await ensurePipeline(o.ctx);
  assert.equal(o.config.fabric.pipelineName, 'CopilotAdoptionPipeline_2');

  // Pending and there with the stopped run's ref: that pipeline is used and brought up to date.
  const resumed = fakeFabric();
  const r = fakeCtx({ fabric: resumed.api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(r.ctx);
  const ours = resumed.add('DataPipeline', 'CopilotAdoptionPipeline', 'half-made', 'AI in One daily load. (ref aa11)');
  r.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'aa11' } };
  resumed.calls.length = 0;
  await ensurePipeline(r.ctx);
  assert.deepEqual(resumed.calls, ['updatePipeline CopilotAdoptionPipeline']);
  assert.equal(r.config.fabric.pipelineId, ours.id);
  assert.notEqual(ours.content, 'half-made');

  // The saved name but not the ref: someone made it after the run stopped, so it's left alone.
  const taken = fakeFabric();
  const k = fakeCtx({ fabric: taken.api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(k.ctx);
  const theirs = taken.add('DataPipeline', 'CopilotAdoptionPipeline', 'theirs', 'AI in One daily load. (ref bb22)');
  k.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'aa11', at: k.ctx.now().toISOString(), operation: failedOp } };
  taken.operations[failedOp] = 'Failed';
  taken.calls.length = 0;
  await ensurePipeline(k.ctx);
  assert.deepEqual(taken.calls.filter((c) => /Pipeline /.test(c)), ['createPipeline CopilotAdoptionPipeline_2']);
  assert.equal(theirs.content, 'theirs');
  assert.notEqual(k.config.fabric.pipelineId, theirs.id);
});

test('a run stopped while Fabric creates a model: planning keeps its name and the next run updates it, by the model, not its name', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: ui.ui });
  t.config.semanticModel.enabled = true;
  const ours = fabric.add('SemanticModel', 'AI in One', 'half-made', 'AI in One. (ref cc33)');
  t.config.fabric.pendingItems = { 'SemanticModel:main': { name: 'AI in One', ref: 'cc33' } };

  await reserveNames(t.ctx);
  assert.equal(t.config.semanticModel.name, 'AI in One', 'not renamed to "… 2"');
  assert.doesNotMatch(ui.text(), /not from this install/);
  fabric.calls.length = 0;
  await deployModel(t.ctx, t.config.semanticModel, { signature: 's', definition: () => ({ parts: [] }) });
  assert.deepEqual(fabric.calls, ['updateSemanticModel AI in One']);
  assert.equal(t.config.semanticModel.id, ours.id);
  assert.equal(t.config.fabric.pendingItems, undefined);

  // Someone else's model with that name and no ref: a new name, and theirs is left alone.
  const other = fakeFabric();
  const o = fakeCtx({ fabric: other.api, graph: fakeGraph().api, ui: fakeUi().ui });
  o.config.semanticModel.enabled = true;
  const theirs = other.add('SemanticModel', 'AI in One', 'theirs');
  const failedOp = 'https://api.fabric.microsoft.com/v1/operations/op-f';
  o.config.fabric.pendingItems = { 'SemanticModel:main': { name: 'AI in One', ref: 'cc33', at: o.ctx.now().toISOString(), operation: failedOp } };
  other.operations[failedOp] = 'Failed';
  await reserveNames(o.ctx);
  assert.equal(o.config.semanticModel.name, 'AI in One 2');
  await deployModel(o.ctx, o.config.semanticModel, { signature: 's', definition: () => ({ parts: [] }) });
  assert.deepEqual(other.calls.filter((c) => /SemanticModel /.test(c)), ['createSemanticModel AI in One 2']);
  assert.equal(theirs.content, 'theirs');
  assert.equal(modelKey(o.config, o.config.semanticModel), 'main', 'AI in One has one model');
});

test('a run stopped moments ago: waits for the item Fabric is still creating, rather than making a second', async () => {
  const fabric = fakeFabric();
  const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(t.ctx);
  const at = new Date(t.ctx.now().getTime() - 60_000).toISOString();
  t.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'ee55', at } };
  const list = fabric.api.listItems;
  let lists = 0;
  /** @type {any} */
  let ours;
  fabric.api.listItems = async (/** @type {string} */ ws, /** @type {string} */ type) => {
    if (type === 'DataPipeline' && ++lists === 3) ours = fabric.add('DataPipeline', 'CopilotAdoptionPipeline', 'half-made', 'AI in One daily load. (ref ee55)');
    return list(ws, type);
  };
  fabric.calls.length = 0;
  await ensurePipeline(t.ctx);
  assert.deepEqual(fabric.calls, ['updatePipeline CopilotAdoptionPipeline']);
  assert.equal(t.config.fabric.pipelineId, ours.id);
  assert.equal(fabric.items.filter((i) => i.type === 'DataPipeline').length, 1);

  // The wait is over and it hasn't appeared: with --yes, nothing is made and the record is kept.
  const late = fakeFabric();
  const lateUi = fakeUi({ yes: true });
  const l = fakeCtx({ fabric: late.api, graph: fakeGraph().api, ui: lateUi.ui });
  await ensureNotebooks(l.ctx);
  const old = new Date(l.ctx.now().getTime() - CREATE_SETTLE_MS).toISOString();
  l.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'ee55', at: old } };
  late.calls.length = 0;
  const sleeps = l.sleeps.length;
  await assert.rejects(ensurePipeline(l.ctx), /wasn't created again, so there won't be two\. Run the installer again later: it uses that item if Fabric made it\. If it never appears, run the installer again without --yes and answer yes to create it\./);
  assert.deepEqual(late.calls.filter((c) => /Pipeline /.test(c)), []);
  assert.equal(l.config.fabric.pendingItems?.DataPipeline?.ref, 'ee55', 'still pending, for the next run');
  assert.equal(l.sleeps.length, sleeps, 'no wait');
  assert.match(lateUi.text(), /isn't in the workspace yet/);

  // Asked, and told yes: a new one is made.
  const sure = fakeFabric();
  const s = fakeCtx({ fabric: sure.api, graph: fakeGraph().api, ui: fakeUi({ answers: [true] }).ui });
  await ensureNotebooks(s.ctx);
  s.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'ee55', at: old } };
  sure.calls.length = 0;
  await ensurePipeline(s.ctx);
  assert.deepEqual(sure.calls.filter((c) => /Pipeline /.test(c)), ['createPipeline CopilotAdoptionPipeline']);
  assert.equal(s.config.fabric.pendingItems, undefined);

  // Days on, still not there: time alone doesn't show it isn't coming, so --yes still stops.
  const gone = fakeFabric();
  const goneUi = fakeUi({ yes: true });
  const g = fakeCtx({ fabric: gone.api, graph: fakeGraph().api, ui: goneUi.ui });
  await ensureNotebooks(g.ctx);
  const days = new Date(g.ctx.now().getTime() - 3 * 24 * 60 * 60_000).toISOString();
  g.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'ee55', at: days } };
  gone.calls.length = 0;
  await assert.rejects(ensurePipeline(g.ctx), /wasn't created again, so there won't be two/);
  assert.deepEqual(gone.calls.filter((c) => /Pipeline /.test(c)), []);
  assert.equal(g.config.fabric.pendingItems?.DataPipeline?.ref, 'ee55');
  assert.equal(g.config.fabric.pendingItems?.DataPipeline?.at, days, 'the record is kept as it was');
  assert.match(goneUi.text(), /isn't known whether Fabric will still make it/);
});

test("a stopped run's create with no time in the record: asked about at once, the record left as it is, and nothing made without asking", async () => {
  for (const at of [undefined, 'not a time']) {
    const fabric = fakeFabric();
    const ui = fakeUi({ yes: true });
    const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: ui.ui });
    await ensureNotebooks(t.ctx);
    t.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'ab12', ...(at ? { at } : {}) } };
    const before = JSON.stringify(t.config.fabric.pendingItems);
    fabric.calls.length = 0;
    const sleeps = t.sleeps.length;
    await assert.rejects(ensurePipeline(t.ctx), /wasn't created again, so there won't be two\. .*without --yes and answer yes to create it/);
    assert.deepEqual(fabric.calls.filter((c) => /Pipeline /.test(c)), []);
    assert.equal(JSON.stringify(t.config.fabric.pendingItems), before, 'the record is unchanged');
    assert.equal(t.sleeps.length, sleeps, 'asks at once rather than waiting');

    // A run days later: still not made without asking, and the record still unchanged.
    const later = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: fakeUi({ yes: true }).ui, config: t.config, now: new Date(t.ctx.now().getTime() + 2 * 24 * 60 * 60_000) });
    fabric.calls.length = 0;
    await assert.rejects(ensurePipeline(later.ctx), /wasn't created again, so there won't be two/);
    assert.deepEqual(fabric.calls.filter((c) => /Pipeline /.test(c)), []);
    assert.equal(JSON.stringify(later.config.fabric.pendingItems), before, 'still pending, unchanged');

    // Told yes: made.
    const sure = fakeFabric();
    const s = fakeCtx({ fabric: sure.api, graph: fakeGraph().api, ui: fakeUi({ answers: [true] }).ui });
    await ensureNotebooks(s.ctx);
    s.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'ab12', ...(at ? { at } : {}) } };
    sure.calls.length = 0;
    await ensurePipeline(s.ctx);
    assert.deepEqual(sure.calls.filter((c) => /Pipeline /.test(c)), ['createPipeline CopilotAdoptionPipeline']);
  }
});

test("a stopped run's create that Fabric gave an operation for: asked about, not guessed", async () => {
  const OP = 'https://api.fabric.microsoft.com/v1/operations/op-x';
  const setup = async (/** @type {string | undefined} */ state, /** @type {any} */ uiOpts = { yes: true }) => {
    const fabric = fakeFabric();
    const ui = fakeUi(uiOpts);
    const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: ui.ui });
    await ensureNotebooks(t.ctx);
    // Asked a second ago, so the name-only wait would be long.
    const at = new Date(t.ctx.now().getTime() - 1000).toISOString();
    t.config.fabric.pendingItems = { DataPipeline: { name: 'CopilotAdoptionPipeline', ref: 'ee55', at, operation: OP } };
    if (state) fabric.operations[OP] = state;
    fabric.calls.length = 0;
    return { fabric, ui, t };
  };
  const pipelineCalls = (/** @type {string[]} */ calls) => calls.filter((c) => /Pipeline |operationStatus/.test(c));

  // Failed: there's nothing coming, so a new one is made at once.
  const failed = await setup('Failed');
  await ensurePipeline(failed.t.ctx);
  assert.deepEqual(pipelineCalls(failed.fabric.calls), ['operationStatus op-x', 'createPipeline CopilotAdoptionPipeline']);
  assert.equal(failed.t.sleeps.length, 0);

  // Still running throughout: an error to run again later, and the record (with the operation) kept.
  const running = await setup('Running');
  await assert.rejects(ensurePipeline(running.t.ctx), /Fabric is still creating CopilotAdoptionPipeline\. Run the installer again in a few minutes/);
  assert.deepEqual(running.fabric.calls.filter((c) => /Pipeline /.test(c)), []);
  assert.equal(running.t.config.fabric.pendingItems?.DataPipeline?.operation, OP);
  assert.equal(running.t.sleeps.length, CREATE_SETTLE_MS / 15_000);

  // Running, then done: the item it made is used.
  const done = await setup('Running');
  const status = done.fabric.api.operationStatus;
  let asks = 0;
  done.fabric.api.operationStatus = async (/** @type {string} */ url) => {
    if (++asks === 3) {
      done.fabric.operations[OP] = 'Succeeded';
      done.fabric.add('DataPipeline', 'CopilotAdoptionPipeline', 'half-made', 'AI in One daily load. (ref ee55)');
    }
    return status(url);
  };
  await ensurePipeline(done.t.ctx);
  assert.deepEqual(done.fabric.calls.filter((c) => /Pipeline /.test(c)), ['updatePipeline CopilotAdoptionPipeline']);
  assert.equal(done.fabric.items.filter((i) => i.type === 'DataPipeline').length, 1);
  assert.equal(done.t.config.fabric.pendingItems, undefined);

  // Succeeded but not there: looked for a little longer, as the list can lag.
  const lag = await setup('Succeeded');
  const lagList = lag.fabric.api.listItems;
  let lagLists = 0;
  lag.fabric.api.listItems = async (/** @type {string} */ ws, /** @type {string} */ type) => {
    if (type === 'DataPipeline' && ++lagLists === 3) lag.fabric.add('DataPipeline', 'CopilotAdoptionPipeline', 'half-made', 'AI in One daily load. (ref ee55)');
    return lagList(ws, type);
  };
  await ensurePipeline(lag.t.ctx);
  assert.deepEqual(lag.fabric.calls.filter((c) => /Pipeline /.test(c)), ['updatePipeline CopilotAdoptionPipeline']);
  assert.equal(lag.fabric.items.filter((i) => i.type === 'DataPipeline').length, 1);

  // Succeeded but never there (deleted since, or still lagging): not made again without asking.
  const deleted = await setup('Succeeded');
  await assert.rejects(ensurePipeline(deleted.t.ctx), /wasn't created again, so there won't be two/);
  assert.deepEqual(pipelineCalls(deleted.fabric.calls), ['operationStatus op-x']);
  assert.equal(deleted.t.sleeps.length, 8, 'looked for it for two minutes');
  assert.match(deleted.ui.text(), /Fabric says it created CopilotAdoptionPipeline for the run that stopped, but it isn't in the workspace/);
  assert.equal(deleted.t.config.fabric.pendingItems?.DataPipeline?.ref, 'ee55');
  const agreed = await setup('Succeeded', { answers: [true] });
  await ensurePipeline(agreed.t.ctx);
  assert.deepEqual(pipelineCalls(agreed.fabric.calls), ['operationStatus op-x', 'createPipeline CopilotAdoptionPipeline']);
  // However long ago Fabric said it made it: still not made again without asking.
  const old = await setup('Succeeded');
  /** @type {any} */ (old.t.config.fabric.pendingItems).DataPipeline.at = new Date(old.t.ctx.now().getTime() - 2 * 60 * 60_000).toISOString();
  await assert.rejects(ensurePipeline(old.t.ctx), /wasn't created again, so there won't be two\. Check the workspace/);
  assert.deepEqual(pipelineCalls(old.fabric.calls), ['operationStatus op-x']);
  assert.equal(old.t.config.fabric.pendingItems?.DataPipeline?.ref, 'ee55');
  assert.doesNotMatch(old.ui.text(), /created now/);

  // Fabric can't say (the call fails, it no longer knows the operation, or answers 'Undefined'): as for no operation, it waits and then doesn't guess.
  for (const unknown of [undefined, 'throws', 'Undefined']) {
    const u = await setup(unknown === 'throws' ? 'Running' : unknown);
    if (unknown === 'throws') u.fabric.failures.operationStatus = [httpError(500, 'boom')];
    await assert.rejects(ensurePipeline(u.t.ctx), /wasn't created again/);
    assert.deepEqual(u.fabric.calls.filter((c) => /Pipeline /.test(c)), []);
    assert.equal(u.t.config.fabric.pendingItems?.DataPipeline?.ref, 'ee55');
    assert.ok(u.t.sleeps.length > 0, 'waited for it first');
  }
});

test("a create that times out keeps Fabric's operation for the next run; one Fabric turns down is forgotten", async () => {
  // Fabric answered 202, then the wait for it ran out: pending, with the operation to ask about.
  const fabric = fakeFabric();
  const t = fakeCtx({ fabric: fabric.api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(t.ctx);
  const create = fabric.api.createPipeline;
  fabric.api.createPipeline = async (/** @type {string} */ ws, /** @type {string} */ name, /** @type {any} */ def, /** @type {any} */ ref) => {
    ref.onAccepted('https://api.fabric.microsoft.com/v1/operations/slow');
    throw new Error('Timed out waiting for a Fabric operation.');
  };
  let saves = t.saves();
  await assert.rejects(ensurePipeline(t.ctx), /Timed out/);
  const pending = t.config.fabric.pendingItems?.DataPipeline;
  assert.equal(pending?.operation, 'https://api.fabric.microsoft.com/v1/operations/slow');
  assert.equal(t.saves() - saves, 2, 'saved before asking, and again with the operation');

  // The next run asks Fabric about it rather than making another.
  fabric.api.createPipeline = create;
  fabric.operations['https://api.fabric.microsoft.com/v1/operations/slow'] = 'Running';
  fabric.calls.length = 0;
  await assert.rejects(ensurePipeline(t.ctx), /still creating/);
  assert.deepEqual(fabric.calls.filter((c) => /Pipeline /.test(c)), []);

  // A network error before any answer: kept too, as Fabric may have made it.
  const lost = fakeFabric();
  const n = fakeCtx({ fabric: lost.api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(n.ctx);
  lost.api.createPipeline = async () => {
    throw new Error('POST failed: socket hang up');
  };
  await assert.rejects(ensurePipeline(n.ctx), /socket hang up/);
  assert.ok(n.config.fabric.pendingItems?.DataPipeline?.ref);

  // Turned down outright (a 4xx before any operation): nothing was made, so nothing is pending.
  const refused = fakeFabric();
  const r = fakeCtx({ fabric: refused.api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(r.ctx);
  refused.api.createPipeline = async () => {
    throw httpError(400, 'Bad definition');
  };
  saves = r.saves();
  await assert.rejects(ensurePipeline(r.ctx), /Bad definition/);
  assert.equal(r.config.fabric.pendingItems, undefined);
  assert.equal(r.saves() - saves, 2, 'saved before asking, and again once forgotten');

  // A 500 may have come after Fabric started on it: kept.
  const busy = fakeFabric();
  const b = fakeCtx({ fabric: busy.api, graph: fakeGraph().api, ui: fakeUi().ui });
  await ensureNotebooks(b.ctx);
  busy.api.createPipeline = async () => {
    throw httpError(500, 'Internal');
  };
  await assert.rejects(ensurePipeline(b.ctx), /Internal/);
  assert.ok(b.config.fabric.pendingItems?.DataPipeline?.ref);
});

test('an item is found by its ref, not by a name someone else also used', async () => {
  const fabric = fakeFabric();
  const theirs = fabric.add('Notebook', 'X', null, 'Theirs');
  const ours = fabric.add('Notebook', 'X', null, 'Deployed by the installer. (ref ff66)');
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  assert.equal(await createdId(ctx, undefined, 'Notebook', 'X', 'ff66'), ours.id, 'a create that returns no ID');
  assert.equal(await createdId(ctx, undefined, 'Notebook', 'X'), theirs.id, 'no ref: by name, as before');
  await assert.rejects(createdId(ctx, undefined, 'Notebook', 'X', '0000'), /isn't in the workspace/);
  config.fabric.pendingItems = { 'Notebook:processor': { name: 'x', ref: 'ff66' } };
  assert.equal(stoppedRunItem(config.fabric, 'Notebook:processor', fabric.items)?.id, ours.id);
});

test('notebook mode: a secret Entra made just before the run stopped is found by its ref and removed', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const first = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  first.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  /** @type {any} */
  let saved;
  first.ctx.save = () => {
    saved = structuredClone(first.config);
  };
  const add = graph.api.addPassword;
  graph.api.addPassword = async (/** @type {string} */ id, /** @type {Date} */ end, /** @type {string | undefined} */ name) => {
    await add(id, end, name);
    throw new Error('stopped');
  };
  await assert.rejects(ensureNotebooks(first.ctx), /stopped/);
  const [attempt] = saved.app.secretAttempts;
  assert.deepEqual(graph.passwords, [{ keyId: 'key-1', displayName: secretLabel(attempt.ref) }]);
  assert.equal(saved.app.pendingSecretKeyIds, undefined, 'the key ID was never saved');

  // Someone else's secrets, named like the installer's, are left alone.
  graph.passwords.push({ keyId: 'theirs-1', displayName: 'AI in One installer' }, { keyId: 'theirs-2', displayName: secretLabel('123456abcdef') });
  graph.api.addPassword = add;
  const ui = fakeUi();
  const next = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: ui.ui, config: saved });
  await ensureNotebooks(next.ctx);
  assert.ok(graph.calls.includes('removePassword key-1'));
  assert.deepEqual(graph.passwords.map((p) => p.keyId).sort(), ['key-2', 'theirs-1', 'theirs-2']);
  assert.equal(next.config.app.secretAttempts, undefined);
  assert.equal(next.config.app.retiredSecretKeyIds, undefined);
  assert.equal(next.config.app.secretKeyId, 'key-2');
  assert.match(ui.text(), /Removed a client secret a stopped run added but never used/);
});

test('notebook mode: a secret attempt that matches more than one secret, or none yet, is kept', async () => {
  const graph = fakeGraph();
  const ui = fakeUi();
  const t = fakeCtx({ fabric: fakeFabric().api, graph: graph.api, ui: ui.ui });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  const now = t.ctx.now().getTime();
  t.config.app.secretAttempts = [
    { ref: 'aaaaaaaaaaaa', at: new Date(now - 60_000).toISOString() },
    { ref: 'bbbbbbbbbbbb', at: new Date(now - 60_000).toISOString() },
    { ref: 'cccccccccccc', at: new Date(now - SECRET_SETTLE_MS).toISOString() },
    { ref: 'dddddddddddd', at: new Date(now - 60_000).toISOString() },
  ];
  graph.passwords.push(
    { keyId: 'a-1', displayName: secretLabel('aaaaaaaaaaaa') },
    { keyId: 'a-2', displayName: secretLabel('aaaaaaaaaaaa') },
    { keyId: 'd-1', displayName: secretLabel('dddddddddddd') },
  );
  t.config.app.pendingSecretKeyIds = ['d-1'];
  graph.failures.listPasswords = [new Error('Forbidden')];
  await settleSecretAttempts(t.ctx);
  assert.match(ui.text(), /Couldn't check the app for a client secret a stopped run may have added \(Forbidden\)/);
  assert.equal(t.config.app.secretAttempts?.length, 4, 'kept when the app could not be read');

  await settleSecretAttempts(t.ctx);
  assert.deepEqual(
    t.config.app.secretAttempts?.map((a) => a.ref),
    ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'],
    'two matches: left alone; none yet: checked again; old with none: kept, with a warning; already tracked: dropped',
  );
  assert.match(ui.text(), /asked Entra for a client secret called "AI in One installer \(ref cccccccccccc\)" .*the app has none by that name\. The install record keeps watching for it/);
  assert.doesNotMatch(ui.text(), /ref bbbbbbbbbbbb\)" .*has none by that name/, 'no warning while Entra may still be catching up');
  assert.deepEqual(t.config.app.pendingSecretKeyIds, ['d-1']);

  // The old one appears later: still caught, and removed as untracked.
  graph.passwords.push({ keyId: 'c-1', displayName: secretLabel('cccccccccccc') });
  await settleSecretAttempts(t.ctx);
  assert.deepEqual(t.config.app.secretAttempts?.map((a) => a.ref), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.ok(graph.calls.includes('removePassword c-1'));
  assert.match(ui.text(), /More than one client secret on the app is called "AI in One installer \(ref aaaaaaaaaaaa\)" \(keys a-1, a-2\), so none is removed/);
  assert.ok(!graph.calls.some((c) => /removePassword (a-|d-1)/.test(c)), 'neither the ambiguous ones nor a tracked one is removed by the check');
});

test('a retired secret Entra errors on removing is cleared only once the app no longer lists it', async () => {
  const graph = fakeGraph();
  const ui = fakeUi();
  const t = fakeCtx({ graph: graph.api, ui: ui.ui });
  graph.passwords.push({ keyId: 'gone', displayName: 'x' }, { keyId: 'stuck', displayName: 'x' }, { keyId: 'fine', displayName: 'x' });
  /** @type {any} */
  const slot = { retiredSecretKeyIds: ['gone', 'stuck', 'fine'] };
  // 'gone' was removed by a run that then stopped: Entra now answers 404.
  graph.passwords.splice(0, 1);
  graph.failures.removePassword = [httpError(404, 'Not found'), httpError(500, 'busy')];
  await removeRetired(t.ctx, slot, 'obj');
  assert.deepEqual(slot.retiredSecretKeyIds, ['stuck'], "gone from the app: cleared; still listed: kept; removed: cleared");
  assert.equal(graph.calls.filter((c) => c === 'listPasswords').length, 1, 'the app is listed once');
  assert.match(ui.text(), /Couldn't remove a previous client secret \(key stuck\)/);
  assert.doesNotMatch(ui.text(), /key gone/);

  // The list can't be read either: kept.
  graph.failures.removePassword = [httpError(500, 'busy')];
  graph.failures.listPasswords = [new Error('Forbidden')];
  await removeRetired(t.ctx, slot, 'obj');
  assert.deepEqual(slot.retiredSecretKeyIds, ['stuck']);
  await removeRetired(t.ctx, slot, 'obj');
  assert.equal(slot.retiredSecretKeyIds, undefined);
});

test('notebook mode: a secret Entra turned down leaves nothing to look for', async () => {
  const graph = fakeGraph();
  const t = fakeCtx({ fabric: fakeFabric().api, graph: graph.api, ui: fakeUi().ui });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  graph.failures.addPassword = [httpError(403, 'Forbidden')];
  await assert.rejects(ensureNotebooks(t.ctx), /Forbidden/);
  assert.equal(t.config.app.secretAttempts, undefined);
  graph.failures.addPassword = [new Error('socket hang up')];
  await assert.rejects(ensureNotebooks(t.ctx), /socket hang up/);
  assert.equal(/** @type {any} */ (t.config.app).secretAttempts?.length, 1, 'no answer: it may exist, so it is looked for next run');
});

test('notebook mode: old secrets stay in the record until Entra confirms they are removed', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const first = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  first.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  await ensureNotebooks(first.ctx);
  assert.equal(first.config.app.secretKeyId, 'key-1');

  // Stopped as the previous secret is being removed: the record still lists it.
  let saved = structuredClone(first.config);
  let stopped = false;
  first.ctx.save = () => {
    if (!stopped) saved = structuredClone(first.config);
  };
  const remove = graph.api.removePassword;
  graph.api.removePassword = async () => {
    stopped = true;
    throw new Error('stopped');
  };
  await ensureNotebooks(first.ctx, { force: true });
  assert.equal(saved.app.secretKeyId, 'key-2');
  assert.deepEqual(saved.app.retiredSecretKeyIds, ['key-1']);
  assert.equal(saved.app.pendingSecretKeyIds, undefined);
  assert.deepEqual(graph.passwords.map((p) => p.keyId), ['key-1', 'key-2']);

  graph.api.removePassword = remove;
  const next = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui, config: saved });
  await ensureNotebooks(next.ctx, { force: true });
  assert.deepEqual(graph.passwords.map((p) => p.keyId), ['key-3']);
  assert.equal(next.config.app.retiredSecretKeyIds, undefined);

  // One that can't be removed stays listed; the one that was removed doesn't.
  graph.api.removePassword = async (/** @type {string} */ id, /** @type {string} */ keyId) => {
    if (keyId === 'key-3') throw new Error('Forbidden');
    return remove(id, keyId);
  };
  next.config.app.retiredSecretKeyIds = ['key-0'];
  await ensureNotebooks(next.ctx, { force: true });
  assert.deepEqual(next.config.app.retiredSecretKeyIds, ['key-3']);
  assert.equal(next.config.app.secretKeyId, 'key-4');

  // Entra answers 404 for one a stopped run already removed: cleared, as the app no longer lists it.
  graph.api.removePassword = remove;
  graph.passwords.splice(graph.passwords.findIndex((p) => p.keyId === 'key-3'), 1);
  graph.failures.removePassword = [httpError(404, 'Not found')];
  await ensureNotebooks(next.ctx, { force: true });
  assert.equal(next.config.app.retiredSecretKeyIds, undefined);
  assert.deepEqual(graph.passwords.map((p) => p.keyId), ['key-5']);
});

test('notebook mode: an unused secret that can\'t be removed is kept to remove later', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  fabric.api.createNotebook = async () => {
    throw new Error('Fabric is busy');
  };
  graph.api.removePassword = async () => {
    throw new Error('Forbidden');
  };
  await assert.rejects(ensureNotebooks(t.ctx), /Fabric is busy/);
  assert.equal(t.config.app.secretKeyId, undefined);
  assert.equal(t.config.app.pendingSecretKeyIds, undefined);
  assert.deepEqual(t.config.app.retiredSecretKeyIds, ['key-1']);
});

test('notebook mode: moving to Key Vault rewrites the notebooks and removes the secret they held', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  await ensureNotebooks(t.ctx);
  const holding = fabric.items.filter((i) => String(i.content).includes('secret-1')).map((i) => i.displayName);

  // As after "Use Key Vault instead" and the vault steps.
  Object.assign(t.config.keyVault, { uri: 'https://kv-test.vault.azure.net/', name: 'kv-test' });
  delete t.config.keyVault.mode;
  fabric.calls.length = 0;
  graph.calls.length = 0;
  await ensureNotebooks(t.ctx);
  assert.deepEqual(fabric.calls.sort(), holding.map((n) => `updateNotebook ${n}`).sort(), 'only the notebooks that read the secret are rewritten');
  assert.ok(fabric.items.every((i) => !String(i.content).includes('secret-1')));
  assert.ok(fabric.items.filter((i) => holding.includes(i.displayName)).every((i) => String(i.content).includes('https://kv-test.vault.azure.net/')));
  assert.deepEqual(graph.calls, ['removePassword key-1']);
  assert.equal(t.config.app.secretKeyId, undefined);
  assert.equal(t.config.fabric.secretInNotebooks, undefined);

  fabric.calls.length = 0;
  await ensureNotebooks(t.ctx);
  assert.deepEqual(fabric.calls, [], 'the default Key Vault path leaves the notebooks alone');
});

test('notebook mode: an app the user brought gets its pasted secret; no vault needed', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const ui = fakeUi({ answers: ['pasted-value'] });
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: ui.ui });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret', mode: 'notebook' };
  t.config.app.existing = true;

  await ensureKeyVault(t.ctx);
  await ensureSecret(t.ctx);
  await ensureNotebooks(t.ctx);
  assert.ok(fabric.items.some((i) => String(i.content).includes('pasted-value')));
  assert.deepEqual(graph.calls, []);
  assert.equal(t.config.keyVault.uri, undefined);
  assert.ok(t.config.keyVault.secretSetAt);
  assert.doesNotMatch(ui.text(), /pasted-value/);
  assert.doesNotMatch(JSON.stringify(t.config), /pasted-value/);
});

test('notebook mode: --no-key-vault (or --secret-in-notebook) and --key-vault go with install only', () => {
  assert.equal(parseCli(['install', '--secret-in-notebook']).secretInNotebook, true);
  assert.equal(parseCli(['install', '--no-key-vault']).secretInNotebook, true);
  assert.equal(parseCli(['install']).secretInNotebook, false);
  assert.throws(() => parseCli(['update', '--secret-in-notebook']), /--secret-in-notebook goes with install/);
  assert.throws(() => parseCli(['update', '--no-key-vault']), /--no-key-vault goes with install/);
  assert.equal(parseCli(['install', '--key-vault']).useKeyVault, true);
  assert.equal(parseCli(['install']).useKeyVault, false);
  assert.throws(() => parseCli(['install', '--key-vault', '--no-key-vault']), /--key-vault can't go with --no-key-vault/);
  assert.throws(() => parseCli(['update', '--key-vault']), /--key-vault goes with install/);
});

test('--secret-days: a whole number of days up to 730, for install or rotate-secret', () => {
  assert.equal(parseCli(['install']).secretDays, undefined);
  assert.equal(parseCli(['install', '--no-key-vault', '--secret-days', '30']).secretDays, 30);
  assert.equal(parseCli(['rotate-secret', '--secret-days', '730']).secretDays, 730);
  for (const bad of ['0', '731', '1.5', 'soon']) assert.throws(() => parseCli(['install', '--secret-days', bad]), /--secret-days/);
  assert.throws(() => parseCli(['update', '--secret-days', '30']), /--secret-days/);
});

test('planning: a vault the user can\'t write to recommends no Key Vault, then the vault admin', async () => {
  const arm = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: READ_ONLY } });
  const ui = fakeUi({ answers: ['sub-1', VAULT_ID, 'keyvault-admin'] });
  const t = fakeCtx({ arm: arm.api, ui: ui.ui });
  await planKeyVault(t.ctx, PRE, 'uksouth');
  assert.equal(t.config.keyVault.mode, 'keyvault-admin');
  assert.equal(t.config.keyVault.existing, true);
  assert.equal(t.config.keyVault.name, 'kv-test');
  assert.equal(t.config.keyVault.resourceGroup, 'rg-ai-in-one');
  assert.match(ui.text(), /You can't write secrets to kv-test: that needs Key Vault Secrets Officer/);
  assert.ok(ui.asked.includes('How should the client secret get there?'));

  // The default is no Key Vault, after the warning and a yes.
  const d = fakeUi({ answers: ['sub-1', VAULT_ID] });
  const n = fakeCtx({ arm: arm.api, ui: d.ui });
  await planKeyVault(n.ctx, PRE, 'uksouth');
  assert.equal(n.config.keyVault.mode, 'notebook');
  assert.match(d.text(), /Anyone with a role in the workspace/);

  // With --yes and no flag, the vault admin.
  const q = fakeCtx({ arm: arm.api, ui: fakeUi({ yes: true, answers: ['sub-1', VAULT_ID] }).ui });
  await planKeyVault(q.ctx, PRE, 'uksouth');
  assert.equal(q.config.keyVault.mode, 'keyvault-admin');

  // A vault they can write to keeps the usual path.
  const mine = vaultArm({ vaults: [vault(), vault({ id: OTHER_ID, name: 'kv-mine' })], perms: { [OTHER_ID]: SECRETS_OFFICER } });
  const u = fakeUi({ answers: ['sub-1', OTHER_ID] });
  const m = fakeCtx({ arm: mine.api, ui: u.ui });
  m.config.keyVault.mode = 'keyvault-admin';
  m.config.keyVault.handoff = { shownAt: 'x' };
  await planKeyVault(m.ctx, PRE, 'uksouth');
  assert.equal(secretMode(m.config), 'keyvault');
  assert.equal(m.config.keyVault.handoff, undefined);
  assert.ok(!u.asked.includes('How should the client secret get there?'));
});

test('planning: the no Key Vault option states the trade-off and needs a yes', async () => {
  const arm = vaultArm({ vaults: [vault({ id: OTHER_ID, name: 'kv-mine' })], perms: { [OTHER_ID]: SECRETS_OFFICER } });
  const ui = fakeUi({ answers: ['sub-1', 'notebook', false] });
  const t = fakeCtx({ arm: arm.api, ui: ui.ui });
  Object.assign(t.config.keyVault, { existing: true, id: OTHER_ID });
  await planKeyVault(t.ctx, PRE, 'uksouth');
  assert.equal(secretMode(t.config), 'keyvault', 'declined, then the vault it had');
  assert.equal(t.config.keyVault.name, 'kv-mine');
  const text = ui.text();
  assert.match(text, /written into the notebooks as plain text/);
  assert.match(text, /Anyone with a role in the workspace, Viewer included/);
  assert.match(text, /run snapshots, exports and deployment pipelines/);
  assert.match(text, /won't write it\s+into a workspace that is connected to Git/);
  assert.match(text, /It lasts 90 days/);
  assert.match(text, /Key Vault avoids this/);

  const yes = fakeUi({ answers: ['sub-1', 'notebook'] });
  const y = fakeCtx({ arm: arm.api, ui: yes.ui });
  y.config.keyVault.handoff = { shownAt: 'x' };
  await planKeyVault(y.ctx, PRE, 'uksouth');
  assert.equal(y.config.keyVault.mode, 'notebook', 'yes by default once chosen');
  assert.equal(y.config.keyVault.handoff, undefined);
  assert.ok(!yes.asked.includes('Secret name'), 'no vault, so no secret name');
});

test('planning: no rights to create a vault recommends no Key Vault; --yes needs the flag', async () => {
  const arm = vaultArm({ groups: ['rg-ai-in-one'], perms: { [SUB]: READ_ONLY } });
  const ui = fakeUi({ answers: ['sub-1', ''] });
  const t = fakeCtx({ arm: arm.api, ui: ui.ui });
  await planKeyVault(t.ctx, PRE, 'uksouth');
  assert.equal(t.config.keyVault.mode, 'notebook');
  assert.match(ui.text(), /You can't create a Key Vault in rg-ai-in-one: that needs Contributor there/);
  assert.ok(ui.asked.includes('Where should the client secret go?'));

  const quiet = fakeCtx({ arm: arm.api, ui: fakeUi({ yes: true, answers: ['sub-1', ''] }).ui });
  await assert.rejects(planKeyVault(quiet.ctx, PRE, 'uksouth'), /Add --no-key-vault/);
});

test('planning: with no subscription, only no Key Vault is left; --yes needs the flag', async () => {
  const none = /** @type {any} */ ({ ...PRE, subscriptions: [] });
  const quiet = fakeUi({ yes: true });
  const t = fakeCtx({ ui: quiet.ui });
  await assert.rejects(planKeyVault(t.ctx, none, 'uksouth'), /Key Vault needs an Azure subscription/);
  assert.match(quiet.text(), /add --no-key-vault/);

  const flagged = fakeCtx({ ui: fakeUi({ yes: true }).ui });
  flagged.ctx.secretInNotebook = true;
  await planKeyVault(flagged.ctx, none, 'uksouth');
  assert.equal(flagged.config.keyVault.mode, 'notebook');

  const asked = fakeUi({ answers: [true] });
  const i = fakeCtx({ ui: asked.ui });
  await planKeyVault(i.ctx, none, 'uksouth');
  assert.equal(i.config.keyVault.mode, 'notebook');
});

test('planning: Contributor on a resource group is enough for a new vault', async () => {
  const arm = vaultArm({ groups: ['rg-mine'], perms: { [SUB]: READ_ONLY, [`${SUB}/resourceGroups/rg-mine`]: RG_CONTRIBUTOR } });
  const ui = fakeUi({ answers: ['sub-1', '', 'rg-missing', 'rg-mine'] });
  const t = fakeCtx({ arm: arm.api, ui: ui.ui });
  await planKeyVault(t.ctx, PRE, 'uksouth');
  assert.equal(t.config.keyVault.resourceGroup, 'rg-mine');
  assert.equal(t.config.keyVault.existing, false);
  assert.equal(t.config.keyVault.rbac, false, 'no role assignments, so access policies');
  assert.match(ui.text(), /no resource group called rg-missing that you can see, and you can't create one/);
});

test('planning: without Advanced settings, a new vault takes its group, region, name and secret name silently', async () => {
  const arm = vaultArm({ perms: { [SUB]: [{ actions: ['*'] }] } });
  const ui = fakeUi({ answers: ['sub-1', ''] });
  const t = fakeCtx({ arm: arm.api, ui: ui.ui });
  t.ctx.advanced = false;
  await planKeyVault(t.ctx, PRE, 'uksouth');
  assert.deepEqual(ui.asked, ['Azure subscription', 'Vault']);
  assert.equal(t.config.keyVault.resourceGroup, 'rg-ai-in-one');
  assert.equal(t.config.keyVault.location, 'uksouth');
  assert.match(String(t.config.keyVault.name), /^ai-in-one-[0-9a-f]{6}$/);
  assert.equal(t.config.keyVault.secretName, 'ai-in-one-client-secret');

  // Only Contributor on another group: the default can't be made, so it asks.
  const rg = vaultArm({ groups: ['rg-mine'], perms: { [SUB]: READ_ONLY, [`${SUB}/resourceGroups/rg-mine`]: RG_CONTRIBUTOR } });
  const u = fakeUi({ answers: ['sub-1', '', 'rg-mine'] });
  const m = fakeCtx({ arm: rg.api, ui: u.ui });
  m.ctx.advanced = false;
  await planKeyVault(m.ctx, PRE, 'uksouth');
  assert.equal(m.config.keyVault.resourceGroup, 'rg-mine');
  assert.deepEqual(u.asked, ['Azure subscription', 'Vault', 'Resource group (created if missing)']);
});

test('new vault: Contributor on just the resource group creates it there', async () => {
  const kv = (/** @type {any} */ arm) => {
    const t = fakeCtx({ arm, ui: fakeUi().ui });
    t.config.keyVault = { secretName: 'ai-in-one-client-secret', subscriptionId: 'sub-1', resourceGroup: 'rg-mine', name: 'kv-new', location: 'uksouth', rbac: false, existing: false };
    return t;
  };
  const ok = vaultArm({ groups: ['rg-mine'], providerFails: true });
  const ui = fakeUi();
  const t = kv(ok.api);
  t.ctx.ui = ui.ui;
  await ensureKeyVault(t.ctx);
  assert.deepEqual(ok.calls, ['ensureProvider', 'createVault rg-mine/kv-new'], 'no resource group write for one that exists');
  assert.match(ui.text(), /can't check resource providers in this subscription/);
  assert.equal(t.config.keyVault.uri, 'https://kv-test.vault.azure.net/');

  const noGroup = vaultArm({ groupFails: true });
  await assert.rejects(ensureKeyVault(kv(noGroup.api).ctx), /give the name of an existing resource group you can write to/);

  const unregistered = vaultArm({
    groups: ['rg-mine'],
    createError: new HttpError('conflict', { status: 409, method: 'PUT', url: 'https://x', body: { error: { code: 'MissingSubscriptionRegistration' } } }),
  });
  await assert.rejects(ensureKeyVault(kv(unregistered.api).ctx), /isn't registered for Microsoft\.KeyVault/);
});

test('app check: an app the user brought is checked for its service principal, permissions and consent', async () => {
  const missing = appGraph({ application: { ...THEIR_APP, requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: [{ id: 'r-audit', type: 'Role' }] }] } });
  const t = fakeCtx({ graph: missing.api });
  const check = await checkExistingApp(t.ctx);
  assert.deepEqual(check, {
    found: true,
    displayName: 'Their app',
    servicePrincipal: false,
    undeclared: ['Reports.Read.All', 'User.Read.All'],
    unconsented: ['AuditLogsQuery.Read.All', 'Reports.Read.All', 'User.Read.All'],
  });
  const ui = fakeUi();
  t.ctx.ui = ui.ui;
  assert.equal(reportAppCheck(t.ctx, check), false);
  assert.match(ui.text(), /Its service principal \(enterprise application\)\. If you own the app, choose "Carry on anyway" and the installer creates it\./);
  assert.match(ui.text(), /These Graph application permissions on its API permissions page: Reports\.Read\.All, User\.Read\.All/);
  assert.match(ui.text(), /Admin consent for: AuditLogsQuery\.Read\.All/);
  assert.match(ui.text(), /CallAnAPI\/appId\/app-1/);

  const consentOnly = fakeUi();
  t.ctx.ui = consentOnly.ui;
  assert.equal(reportAppCheck(t.ctx, { ...check, servicePrincipal: true, undeclared: [] }), false);
  assert.match(consentOnly.text(), /login\.microsoftonline\.com\/tenant-1\/adminconsent\?client_id=app-1/);
  assert.equal(reportAppCheck(t.ctx, { ...check, servicePrincipal: true, undeclared: [] }, { canConsent: true }), true, 'an admin grants consent during the install');

  const none = fakeCtx({ graph: appGraph().api, ui: fakeUi().ui });
  const absent = await checkExistingApp(none.ctx);
  assert.equal(absent.found, false);
  assert.equal(reportAppCheck(none.ctx, absent), false);
});

test('app check: the user can check again once an admin has fixed it, or carry on', async () => {
  const graph = appGraph({ application: THEIR_APP, sp: { id: 'their-sp' }, assigned: [['r-audit'], ['r-audit', 'r-reports', 'r-users']] });
  const ui = fakeUi({ answers: [APP_GUID, 'again'] });
  const t = fakeCtx({ graph: graph.api, ui: ui.ui });
  await askAppId(t.ctx, { canConsent: false });
  assert.equal(t.config.app.appId, APP_GUID);
  assert.equal(t.config.app.displayName, 'Their app');
  assert.match(ui.text(), /Their app isn't ready yet/);
  assert.match(ui.text(), /Their app has everything AI in One needs/);

  const stuck = appGraph({ application: THEIR_APP, sp: { id: 'their-sp' } });
  const go = fakeUi({ answers: [APP_GUID, 'go'] });
  const g = fakeCtx({ graph: stuck.api, ui: go.ui });
  await askAppId(g.ctx, { canConsent: false });
  assert.match(go.text(), /Carrying on with the app as it is/);

  const quiet = fakeUi({ yes: true, answers: [APP_GUID] });
  const q = fakeCtx({ graph: stuck.api, ui: quiet.ui });
  await askAppId(q.ctx, { canConsent: false });
  assert.match(quiet.text(), /Carrying on\. Data the missing permissions cover/);

  const gone = fakeCtx({ graph: appGraph().api, ui: fakeUi({ yes: true, answers: [APP_GUID] }).ui });
  await assert.rejects(askAppId(gone.ctx, { canConsent: false }), /No app registration with ID 11111111/);

  await assert.rejects(askAppId(fakeCtx({ graph: stuck.api, ui: fakeUi({ answers: ['not-a-guid'] }).ui }).ctx, { canConsent: false }), /Paste the GUID/);
});

test('admin pack: a script and portal steps for every permission, with the secret going where the install keeps it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vl-pack-'));
  try {
    const t = fakeCtx();
    t.ctx.configFile = join(dir, 'aio-install.json');
    const file = writeAdminPack(t.ctx);
    assert.equal(file, join(dir, ADMIN_PACK_FILE));
    const body = readFileSync(file, 'utf8');
    assert.match(body, /az ad app create --display-name "AI in One \(Fabric\)"/);
    assert.match(body, /for P in AuditLogsQuery\.Read\.All Reports\.Read\.All User\.Read\.All; do/);
    assert.match(body, /az ad app permission admin-consent --id "\$APP_ID"/);
    assert.match(body, /Grant admin consent/);
    assert.match(body, /az ad app credential reset --id "\$APP_ID"/);
    assert.match(body, /through a secure channel/);
    assert.doesNotMatch(body, /az keyvault/);

    Object.assign(t.config.keyVault, { mode: 'keyvault-admin', name: 'kv-test' });
    const vaulted = readFileSync(writeAdminPack(t.ctx), 'utf8');
    assert.match(vaulted, /az keyvault secret set --vault-name kv-test --name ai-in-one-client-secret/);
    assert.match(vaulted, /if \[ -n "\$CT" \] && \[ "\$CT" != "Client secret for \$APP_ID" \]; then/, 'another app\'s secret with that name is left alone');
    assert.match(vaulted, /They don't need the secret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admin pack: the install stops until the admin sends the client ID, then checks it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vl-pack-'));
  try {
    const quiet = fakeUi({ yes: true });
    const q = fakeCtx({ ui: quiet.ui });
    q.ctx.configFile = join(dir, 'aio-install.json');
    delete q.config.app.appId;
    await assert.rejects(planAdminPack(q.ctx, { canConsent: false }), (err) => isResumeLater(err));
    assert.equal(q.config.app.adminPack, join(dir, ADMIN_PACK_FILE));
    assert.ok(existsSync(join(dir, ADMIN_PACK_FILE)));
    assert.match(quiet.text(), /An admin needs to register the app/);

    const stop = fakeCtx({ ui: fakeUi({ answers: ['stop'] }).ui });
    stop.ctx.configFile = q.ctx.configFile;
    await assert.rejects(planAdminPack(stop.ctx, { canConsent: false }), (err) => isResumeLater(err));

    const graph = appGraph({ application: THEIR_APP, sp: { id: 'their-sp' }, assigned: [['r-audit', 'r-reports', 'r-users']] });
    const vaulted = fakeCtx({ graph: graph.api, ui: fakeUi({ answers: ['go', APP_GUID] }).ui });
    vaulted.ctx.configFile = q.ctx.configFile;
    Object.assign(vaulted.config.keyVault, { mode: 'keyvault-admin', name: 'kv-test' });
    assert.equal(await planAdminPack(vaulted.ctx, { canConsent: false }), false, 'the admin\'s script put the secret in the vault');
    assert.equal(vaulted.config.app.appId, APP_GUID);
    assert.equal(vaulted.config.keyVault.secretSetAt, '2026-06-01T12:00:00.000Z');

    const pasted = fakeCtx({ graph: graph.api, ui: fakeUi({ answers: ['go', APP_GUID] }).ui });
    pasted.ctx.configFile = q.ctx.configFile;
    assert.equal(await planAdminPack(pasted.ctx, { canConsent: false }), true, 'the user pastes the secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review: each secret mode says where the secret is and what the user needs', async () => {
  const t = fakeCtx();
  Object.assign(t.config.keyVault, { existing: true, name: 'kv-test' });
  delete t.config.keyVault.uri;
  const usual = planReview(t.ctx);
  assert.match(String(usual.grants.find((g) => g.where === 'Key Vault kv-test')?.what), /Key Vault Secrets Officer/);
  assert.ok(usual.runsOn.some((r) => r.what === 'Key Vault'));

  t.config.keyVault.mode = 'keyvault-admin';
  const admin = planReview(t.ctx);
  assert.match(String(admin.grants.find((g) => g.where === 'Key Vault kv-test')?.what), /^Key Vault Secrets User/);
  assert.match(String(admin.creates.find((i) => i.kind === 'Key Vault')?.detail), /A vault admin adds it/);

  t.config.keyVault.mode = 'notebook';
  const inline = planReview(t.ctx);
  assert.equal(inline.creates.find((i) => i.kind === 'Key Vault'), undefined);
  assert.match(String(inline.creates.find((i) => i.kind === 'Client secret')?.detail), /Anyone with a role in the workspace, Viewer included, can read it/);
  assert.equal(inline.creates.find((i) => i.kind === 'Client secret')?.isNew, true, 'each install writes a new secret, so the plan says New');
  assert.match(String(inline.creates.find((i) => i.kind === 'App registration')?.detail), /lasts 90 days and is replaced on each install, repair or update/);
  assert.equal(inline.grants.find((g) => String(g.where).startsWith('Key Vault')), undefined);
  assert.equal(inline.runsOn.find((r) => r.what === 'Key Vault'), undefined);

  const ui = fakeUi({ answers: [true] });
  t.ctx.ui = ui.ui;
  await confirmPlan(t.ctx);
  assert.match(ui.text(), /Secret: {6}in the notebooks \(no Key Vault: anyone with a role in the workspace can read it; lasts 90 days\)/);
});
