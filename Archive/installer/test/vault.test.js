// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateVault, keyVaultApi, networkBlocked } from '../src/clients/azure.js';
import { createClient, HttpError } from '../src/http.js';
import { endpointName, endpointRequest, ensureVaultEndpoint, fromWorkspace } from '../src/steps/fabric.js';
import { ensureSecret, newSecret } from '../src/steps/identity.js';
import { runsFabric } from '../src/steps/plan.js';
import { createUi } from '../src/ui.js';
import { fakeCtx, fakeUi } from './fakes.js';

const VAULT_ID = '/subscriptions/sub-1/resourceGroups/rg-ai-in-one/providers/Microsoft.KeyVault/vaults/kv-test';
const NETWORK_403 = {
  error: {
    code: 'Forbidden',
    message: 'Public network access is disabled and request is not from a trusted service nor via an approved private link.',
    innererror: { code: 'ForbiddenByConnection' },
  },
};
const RBAC_403 = { error: { code: 'Forbidden', message: 'Caller is not authorized to perform action on resource.', innererror: { code: 'ForbiddenByRbac' } } };

/** @param {number} status @param {any} [body] */
const httpError = (status, body) => new HttpError(`returned ${status}`, { status, method: 'GET', url: 'https://kv-test.vault.azure.net/secrets/s', body });

/**
 * The Key Vault client over a scripted fetch.
 * @param {{ status: number, body?: any }[]} answers
 */
function scriptedVault(answers) {
  /** @type {string[]} */
  const calls = [];
  const http = createClient({
    baseUrl: 'https://vault.azure.net',
    getToken: async () => 'tok',
    sleep: async () => {},
    fetchImpl: /** @type {typeof fetch} */ (
      /** @type {unknown} */ (
        async (/** @type {string} */ url, /** @type {any} */ init) => {
          calls.push(`${init.method} ${new URL(url).pathname}`);
          const a = answers.shift();
          if (!a) throw new Error(`Unexpected request: ${init.method} ${url}`);
          return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status });
        }
      )
    ),
  });
  return { kv: keyVaultApi(http), calls };
}

test('private vaults, network blocks and Fabric capacities are recognised', () => {
  assert.equal(isPrivateVault({ properties: { publicNetworkAccess: 'Disabled' } }), true);
  assert.equal(isPrivateVault({ properties: { publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Deny' } } }), true);
  assert.equal(isPrivateVault({ properties: { publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Allow' } } }), false);
  assert.equal(isPrivateVault({ properties: {} }), false);

  assert.equal(networkBlocked(NETWORK_403), true);
  assert.equal(networkBlocked('Client address is not authorized and caller is not a trusted service.'), true);
  assert.equal(networkBlocked(RBAC_403), false);

  assert.deepEqual(
    ['F64', 'FTL64', 'P1', 'PP3', 'A1', 'EM2'].filter((sku) => runsFabric({ sku })),
    ['F64', 'FTL64', 'P1'],
  );

  assert.equal(endpointName('kv-test'), 'ai-in-one-kv-test');
  assert.ok(endpointRequest('ws-1').includes('ws-1'));
  assert.ok(endpointRequest('00000000-0000-0000-0000-000000000000').length <= 140);
});

test('Key Vault waits out a new role assignment but fails fast on a network block', async () => {
  const role = scriptedVault([{ status: 403, body: RBAC_403 }, { status: 403, body: RBAC_403 }, { status: 200, body: { id: 'x' } }]);
  await role.kv.setSecret('https://kv-test.vault.azure.net/', 's', 'v');
  assert.equal(role.calls.length, 3);

  const blocked = scriptedVault([{ status: 403, body: NETWORK_403 }]);
  await assert.rejects(blocked.kv.setSecret('https://kv-test.vault.azure.net/', 's', 'v'), (err) => err instanceof HttpError && err.status === 403);
  assert.equal(blocked.calls.length, 1);

  const fresh = scriptedVault([{ status: 403, body: RBAC_403 }, { status: 404, body: { error: { code: 'SecretNotFound' } } }]);
  await fresh.kv.waitForAccess('https://kv-test.vault.azure.net/', 's');
  assert.deepEqual(fresh.calls, ['GET /secrets/s', 'GET /secrets/s']);
});

/** @param {{ blocked?: boolean, canWriteArm?: boolean, armFails?: boolean | number, existing?: Record<string, string | undefined>, passwords?: { keyId: string, displayName: string }[] }} [o] */
function fakeSecretApis(o = {}) {
  /** @type {string[]} */
  const calls = [];
  const existing = o.existing ?? {};
  /** @param {string} name */
  const info = (name) => (name in existing ? { contentType: existing[name] } : null);
  let keys = 0;
  const graph = {
    addPassword: async (/** @type {string} */ _id, /** @type {Date} */ _end, /** @type {string} */ name) => {
      calls.push('addPassword');
      const keyId = `key-${++keys}`;
      (o.passwords ??= []).push({ keyId, displayName: name });
      return { secretText: 's3cret-value', endDateTime: '2027-06-01T12:00:00Z', keyId };
    },
    removePassword: async (/** @type {string} */ _id, /** @type {string} */ keyId) => {
      calls.push(`removePassword ${keyId}`);
    },
    listPasswords: async () => {
      calls.push('listPasswords');
      return o.passwords ?? [];
    },
  };
  const keyVault = {
    waitForAccess: async () => {
      calls.push('kv.waitForAccess');
      if (o.blocked) throw httpError(403, NETWORK_403);
    },
    setSecret: async (/** @type {string} */ _uri, /** @type {string} */ name) => {
      calls.push(`kv.setSecret ${name}`);
      if (o.blocked) throw httpError(403, NETWORK_403);
    },
    secretInfo: async (/** @type {string} */ _uri, /** @type {string} */ name) => {
      calls.push(`kv.secretInfo ${name}`);
      if (o.blocked) throw httpError(403, NETWORK_403);
      return info(name);
    },
  };
  const arm = {
    permissions: async () => {
      calls.push('arm.permissions');
      return [{ actions: o.canWriteArm === false ? ['*/read'] : ['Microsoft.KeyVault/*'] }];
    },
    setSecret: async (/** @type {string} */ _id, /** @type {string} */ name) => {
      calls.push(`arm.setSecret ${name}`);
      if (typeof o.armFails === 'number') throw httpError(o.armFails);
      if (o.armFails) throw new Error('boom');
    },
    secretInfo: async (/** @type {string} */ _id, /** @type {string} */ name) => {
      calls.push(`arm.secretInfo ${name}`);
      return info(name);
    },
  };
  return { graph, keyVault, arm, calls };
}

/** @param {ReturnType<typeof fakeSecretApis>} apis @param {{ private?: boolean, ui?: any, existing?: boolean }} [o] */
function secretCtx(apis, o = {}) {
  const made = fakeCtx({ graph: apis.graph, keyVault: apis.keyVault, arm: apis.arm, ui: o.ui });
  made.config.app.objectId = 'obj-1';
  Object.assign(made.config.keyVault, { id: VAULT_ID, name: 'kv-test', private: o.private, existing: o.existing });
  return made;
}

test('new secret: checks the vault first, then writes straight to it', async () => {
  const apis = fakeSecretApis();
  const { ctx, config } = secretCtx(apis);
  await newSecret(ctx);
  assert.deepEqual(apis.calls, ['kv.waitForAccess', 'addPassword', 'kv.setSecret ai-in-one-client-secret']);
  assert.equal(config.app.secretExpires, '2027-06-01T12:00:00Z');
  assert.ok(config.keyVault.secretSetAt);
  assert.notEqual(config.keyVault.private, true);
});

test('new secret: a vault that blocks public access is written through Resource Manager', async () => {
  const apis = fakeSecretApis({ blocked: true });
  const ui = fakeUi();
  const { ctx, config } = secretCtx(apis, { ui: ui.ui });
  await newSecret(ctx);
  assert.deepEqual(apis.calls, ['kv.waitForAccess', 'arm.permissions', 'addPassword', 'arm.setSecret ai-in-one-client-secret']);
  assert.equal(config.keyVault.private, true);
  assert.match(ui.text(), /blocks public network access/);
  assert.doesNotMatch(ui.text() + JSON.stringify(config), /s3cret-value/);
});

test('new secret: without write access none is made; a failed write keeps it tracked unless the vault turned it down', async () => {
  const denied = fakeSecretApis({ canWriteArm: false });
  await assert.rejects(newSecret(secretCtx(denied, { private: true }).ctx), /needs Contributor or Key Vault Contributor/);
  assert.deepEqual(denied.calls, ['arm.permissions']);

  // It may have reached the vault before the error: kept on the app and in the record.
  const failing = fakeSecretApis({ armFails: true });
  const f = secretCtx(failing, { private: true });
  await assert.rejects(newSecret(f.ctx), /Run the installer again: it makes a new one, and keeps track of this one/);
  assert.deepEqual(failing.calls, ['arm.permissions', 'addPassword', 'arm.setSecret ai-in-one-client-secret']);
  assert.deepEqual(f.config.keyVault.pendingSecretKeyIds, ['key-1']);
  assert.equal(f.config.keyVault.secretAttempts, undefined);
  assert.equal(f.config.keyVault.secretSetAt, undefined);

  // The vault said no, so nothing holds it: removed.
  const refusedApis = fakeSecretApis({ armFails: 400 });
  const r = secretCtx(refusedApis, { private: true });
  await assert.rejects(newSecret(r.ctx), /removed from the app again/);
  assert.deepEqual(refusedApis.calls, ['arm.permissions', 'addPassword', 'arm.setSecret ai-in-one-client-secret', 'removePassword key-1']);
  assert.equal(r.config.keyVault.pendingSecretKeyIds, undefined);
  assert.equal(r.config.keyVault.retiredSecretKeyIds, undefined);
});

test('new secret: one a stopped run may have put in the vault is replaced, then kept as previous, never removed unseen', async () => {
  // The run stopped after the vault write may have happened: the key is pending and the record says the vault has a secret.
  const apis = fakeSecretApis();
  const ui = fakeUi();
  const t = secretCtx(apis, { ui: ui.ui });
  Object.assign(t.config.keyVault, { secretSetAt: '2026-05-01T00:00:00Z', secretKeyId: 'key-old', pendingSecretKeyIds: ['key-maybe'] });
  t.config.app.existing = false;
  await ensureSecret(t.ctx);
  assert.deepEqual(apis.calls, ['kv.waitForAccess', 'addPassword', 'kv.setSecret ai-in-one-client-secret']);
  assert.equal(t.config.keyVault.secretKeyId, 'key-1');
  assert.equal(t.config.keyVault.pendingSecretKeyIds, undefined);
  assert.deepEqual(t.config.keyVault.previousSecretKeyIds, ['key-old', 'key-maybe'], 'left on the app, as a run already going may use either');
  assert.match(ui.text(), /may have saved it to Key Vault\. Making a new one/);
  assert.match(ui.text(), /couldn't confirm was saved to Key Vault \(key key-maybe\)/);
});

test('new secret: a stopped run that Entra gave a secret before its key was saved: found by its ref and tracked', async () => {
  // Stopped between addPassword and saving the key: only the attempt is in the record.
  const apis = fakeSecretApis({ passwords: [{ keyId: 'key-lost', displayName: 'AI in One installer (ref aaaaaaaaaaaa)' }, { keyId: 'key-theirs', displayName: 'AI in One installer' }] });
  const ui = fakeUi();
  const t = secretCtx(apis, { ui: ui.ui });
  t.config.app.existing = false;
  t.config.keyVault.secretSetAt = '2026-05-01T00:00:00Z';
  t.config.keyVault.secretAttempts = [{ ref: 'aaaaaaaaaaaa', at: '2026-06-01T11:59:00Z' }];
  await ensureSecret(t.ctx);
  assert.equal(t.config.keyVault.secretAttempts, undefined);
  assert.deepEqual(t.config.keyVault.previousSecretKeyIds, ['key-lost'], 'tracked, and only the one with its ref');
  assert.ok(!apis.calls.some((c) => c.startsWith('removePassword')), 'nothing removed');
  assert.match(ui.text(), /added a client secret to the app \(key key-lost\) without recording it/);

  // Two with the same ref: neither is adopted or removed, and the attempt stays.
  const twice = fakeSecretApis({
    passwords: [
      { keyId: 'k1', displayName: 'AI in One installer (ref bbbbbbbbbbbb)' },
      { keyId: 'k2', displayName: 'AI in One installer (ref bbbbbbbbbbbb)' },
    ],
  });
  const tw = fakeUi();
  const d = secretCtx(twice, { ui: tw.ui });
  d.config.app.existing = false;
  d.config.keyVault.secretAttempts = [{ ref: 'bbbbbbbbbbbb', at: '2026-06-01T11:59:00Z' }];
  await ensureSecret(d.ctx);
  assert.deepEqual(d.config.keyVault.secretAttempts?.map((a) => a.ref), ['bbbbbbbbbbbb']);
  assert.ok(!twice.calls.some((c) => c.startsWith('removePassword')));
  assert.ok(![d.config.keyVault.secretKeyId, ...(d.config.keyVault.previousSecretKeyIds ?? [])].some((k) => k === 'k1' || k === 'k2'));
  assert.match(tw.text(), /More than one client secret on the app is called/);
});

test('secret name: an existing vault keeps another install\'s secret and the new one takes a free name', async () => {
  const apis = fakeSecretApis({
    existing: { 'ai-in-one-client-secret': 'Client secret for other-app', 'ai-in-one-client-secret-2': undefined },
  });
  const ui = fakeUi();
  const { ctx, config } = secretCtx(apis, { existing: true, ui: ui.ui });
  await newSecret(ctx);
  assert.deepEqual(apis.calls, [
    'kv.waitForAccess',
    'kv.secretInfo ai-in-one-client-secret',
    'kv.secretInfo ai-in-one-client-secret-2',
    'kv.secretInfo ai-in-one-client-secret-3',
    'addPassword',
    'kv.setSecret ai-in-one-client-secret-3',
  ]);
  assert.equal(config.keyVault.secretName, 'ai-in-one-client-secret-3');
  assert.match(ui.text(), /isn't this app's/);
});

test('secret name: this app\'s own secret, a new vault, or one already written are reused without a check', async () => {
  const own = fakeSecretApis({ existing: { 'ai-in-one-client-secret': 'Client secret for app-1' } });
  await newSecret(secretCtx(own, { existing: true }).ctx);
  assert.deepEqual(own.calls, ['kv.waitForAccess', 'kv.secretInfo ai-in-one-client-secret', 'addPassword', 'kv.setSecret ai-in-one-client-secret']);

  const foreign = { existing: { 'ai-in-one-client-secret': 'Client secret for other-app' } };
  const fresh = fakeSecretApis(foreign);
  await newSecret(secretCtx(fresh).ctx);
  assert.deepEqual(fresh.calls, ['kv.waitForAccess', 'addPassword', 'kv.setSecret ai-in-one-client-secret']);

  const rotated = fakeSecretApis(foreign);
  const made = secretCtx(rotated, { existing: true });
  made.config.keyVault.secretSetAt = '2026-10-01T00:00:00Z';
  await newSecret(made.ctx);
  assert.deepEqual(rotated.calls, ['kv.waitForAccess', 'addPassword', 'kv.setSecret ai-in-one-client-secret']);
});

test('secret name: a pasted secret for an existing app is checked too, through Resource Manager on a private vault', async () => {
  const apis = fakeSecretApis({ existing: { 'ai-in-one-client-secret': undefined } });
  const { ctx, config } = secretCtx(apis, { existing: true, private: true });
  ctx.pendingSecret = 'pasted';
  await ensureSecret(ctx);
  assert.deepEqual(apis.calls, [
    'arm.permissions',
    'arm.secretInfo ai-in-one-client-secret',
    'arm.secretInfo ai-in-one-client-secret-2',
    'arm.setSecret ai-in-one-client-secret-2',
  ]);
  assert.equal(config.keyVault.secretName, 'ai-in-one-client-secret-2');
  assert.equal(ctx.pendingSecret, undefined);
  assert.ok(config.keyVault.secretSetAt);
});

/** @param {{ approvable?: boolean, earlierInstall?: boolean }} [o] */
function fakeEndpointApis(o = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  let endpoint = null;
  /** @type {any[]} */
  const connections = [
    {
      id: `${VAULT_ID}/privateEndpointConnections/other`,
      properties: {
        privateEndpoint: { id: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/privateEndpoints/someone-else' },
        privateLinkServiceConnectionState: { status: 'Pending', description: 'Another team' },
      },
    },
    // Another workspace that reads the vault: Fabric gives its endpoint the same name, with its own workspace ID in front.
    ...(o.earlierInstall
      ? [
          {
            id: `${VAULT_ID}/privateEndpointConnections/ws-0.ai-in-one-kv-test-conn`,
            name: 'ws-0.ai-in-one-kv-test-conn',
            properties: {
              privateEndpoint: { id: '/subscriptions/fabric/resourceGroups/managed/providers/Microsoft.Network/privateEndpoints/ws-0.ai-in-one-kv-test' },
              privateLinkServiceConnectionState: { status: 'Approved', description: 'Approved by the AI in One installer.' },
            },
          },
        ]
      : []),
  ];
  const state = (/** @type {string} */ name) => connections.find((c) => c.id.endsWith(name)).properties.privateLinkServiceConnectionState;
  const fabric = {
    listPrivateEndpoints: async () => (endpoint ? [structuredClone(endpoint)] : []),
    createPrivateEndpoint: async (/** @type {string} */ ws, /** @type {any} */ body) => {
      calls.push(`createPrivateEndpoint ${body.name} ${body.targetSubresourceType}`);
      endpoint = { id: 'mpe-1', name: body.name, targetPrivateLinkResourceId: body.targetPrivateLinkResourceId, provisioningState: 'Provisioning' };
      connections.push({
        id: `${VAULT_ID}/privateEndpointConnections/pec-1`,
        properties: {
          privateEndpoint: { id: `/subscriptions/fabric/resourceGroups/managed/providers/Microsoft.Network/privateEndpoints/${ws}.${body.name}` },
          privateLinkServiceConnectionState: { status: 'Pending', description: body.requestMessage },
        },
      });
      return structuredClone(endpoint);
    },
    getPrivateEndpoint: async () => {
      calls.push('getPrivateEndpoint');
      endpoint.provisioningState = 'Succeeded';
      endpoint.connectionState = { status: state('pec-1').status };
      return structuredClone(endpoint);
    },
  };
  const arm = {
    ensureProvider: async (/** @type {string} */ sub, /** @type {string} */ ns) => {
      calls.push(`ensureProvider ${sub} ${ns}`);
      return false;
    },
    listPrivateEndpointConnections: async () => structuredClone(connections),
    approvePrivateEndpointConnection: async (/** @type {string} */ id, /** @type {string} */ description) => {
      calls.push(`approve ${id.split('/').pop()}`);
      if (o.approvable === false) throw new HttpError('returned 403', { status: 403, method: 'PUT', url: id });
      // Like the vault, approval replaces the request message.
      connections.find((c) => c.id === id).properties.privateLinkServiceConnectionState = { status: 'Approved', description };
    },
  };
  return { fabric, arm, calls, state };
}

/** @param {ReturnType<typeof fakeEndpointApis>} apis @param {any} [ui] */
function endpointCtx(apis, ui) {
  const made = fakeCtx({ fabric: apis.fabric, arm: apis.arm, ui });
  Object.assign(made.config.keyVault, { id: VAULT_ID, name: 'kv-test', private: true });
  return made;
}

test('private vault: the workspace gets a managed private endpoint, approved on the vault', async () => {
  const apis = fakeEndpointApis();
  const { ctx, config } = endpointCtx(apis);
  assert.equal(await ensureVaultEndpoint(ctx), true);
  assert.deepEqual(apis.calls, [
    'ensureProvider sub-1 Microsoft.Network',
    'createPrivateEndpoint ai-in-one-kv-test vault',
    'getPrivateEndpoint',
    'approve pec-1',
    'getPrivateEndpoint',
  ]);
  assert.equal(config.fabric.vaultEndpointId, 'mpe-1');
  assert.equal(apis.state('other').status, 'Pending', 'someone else\'s request is left alone');

  apis.calls.length = 0;
  assert.equal(await ensureVaultEndpoint(ctx), true);
  assert.deepEqual(apis.calls, [], 'a re-run finds it approved');

  const open = fakeCtx();
  assert.equal(await ensureVaultEndpoint(open.ctx), true, 'a public vault needs no endpoint');
});

test('private vault: another workspace\'s approved endpoint with the same name is not taken for this one', async () => {
  const apis = fakeEndpointApis({ earlierInstall: true });
  const { ctx } = endpointCtx(apis);
  assert.equal(await ensureVaultEndpoint(ctx), true);
  assert.deepEqual(apis.calls.filter((c) => c.startsWith('approve')), ['approve pec-1']);
  assert.deepEqual(apis.state('pec-1'), { status: 'Approved', description: 'Approved by the AI in One installer for Fabric workspace ws-1.' });
  assert.deepEqual(apis.state('ws-0.ai-in-one-kv-test-conn'), { status: 'Approved', description: 'Approved by the AI in One installer.' }, 'the other workspace\'s is left alone');
});

test('a vault connection belongs to the workspace whose ID it carries, before and after approval', () => {
  const ws = '2b9f7c1e-0d4a-4e8b-9c3f-5a6d7e8f9a0b';
  const peId = (/** @type {string} */ w) => `/subscriptions/fabric/resourceGroups/managed/providers/Microsoft.Network/privateEndpoints/${w}.${endpointName('kv-test')}`;
  const conn = (/** @type {string} */ w, /** @type {string} */ status, /** @type {string} */ description) => ({
    name: `${w}.${endpointName('kv-test')}-conn`,
    properties: { privateEndpoint: { id: peId(w) }, privateLinkServiceConnectionState: { status, description } },
  });
  assert.equal(fromWorkspace(conn(ws, 'Pending', endpointRequest(ws)), ws), true);
  assert.equal(fromWorkspace(conn(ws, 'Approved', 'Approved in the portal.'), ws), true, 'approval replaces the request message');
  assert.equal(fromWorkspace(conn(ws, 'Pending', endpointRequest(ws)), ws.toUpperCase()), true);
  assert.equal(fromWorkspace(conn('7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'Approved', 'Approved by the AI in One installer.'), ws), false);
  assert.equal(fromWorkspace({ properties: { privateLinkServiceConnectionState: { status: 'Pending', description: 'Another team' } } }, ws), false);
});

test('private vault: someone who may not approve gets a link, and the first load can wait', async () => {
  const apis = fakeEndpointApis({ approvable: false });
  const ui = fakeUi({ yes: true });
  const { ctx } = endpointCtx(apis, ui.ui);
  assert.equal(await ensureVaultEndpoint(ctx), false);
  assert.match(ui.text(), /waiting for approval on kv-test/);
  assert.match(ui.text(), /portal\.azure\.com\/#@tenant-1\/resource\/subscriptions\/sub-1\/.+\/vaults\/kv-test\/networking/);
});

test('a question with only one answer answers itself', async () => {
  /** @type {string[]} */
  const out = [];
  const ui = createUi({ write: (s) => out.push(s) });
  assert.equal(await ui.select('Azure subscription', [{ name: 'Demo (sub-1)', value: 'sub-1' }]), 'sub-1');
  assert.match(out.join(''), /Azure subscription .*Demo \(sub-1\)/);

  const unattended = createUi({ yes: true, write: () => {} });
  const two = [
    { name: 'a', value: 1 },
    { name: 'b', value: 2 },
  ];
  assert.equal(await unattended.select('Pick', two, 2), 2);
  await assert.rejects(unattended.select('Pick', two), /has no saved answer/);
});
