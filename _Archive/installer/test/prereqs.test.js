// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armApi, ROLES } from '../src/clients/azure.js';
import { FABRIC_ADMIN_ROLE, graphApi } from '../src/clients/graph.js';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { checkPrereqs, keyVaultWanted, MAX_SUBSCRIPTIONS } from '../src/prereqs.js';
import { BIG_CAPACITY_SEATS } from '../src/seats.js';
import { CONCEALED_NAMES_SETTING } from '../src/steps/plan.js';

const GA = '62e90394-69f5-4237-9190-012177145e10';
const APP_ADMIN = '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3';
const USER = /** @type {any} */ ({ id: 'user-1', upn: 'admin@contoso.com', tenantId: 't-1' });
const ALL = [{ actions: ['*'], notActions: [] }];
const READ = [{ actions: ['*/read'], notActions: [] }];
const CREATE = [{ actions: ['Microsoft.Resources/*'], notActions: [] }];
const VAULT_ID = '/subscriptions/sub-1/resourceGroups/rg-ai-in-one/providers/Microsoft.KeyVault/vaults/kv-ai-in-one';
const assignment = (/** @type {string} */ role, principalId = USER.id) => ({ properties: { roleDefinitionId: `/subscriptions/x/providers/Microsoft.Authorization/roleDefinitions/${role}`, principalId } });
const failure = (/** @type {number} */ status, code = 'Forbidden') => new HttpError(`GET /x returned ${status} ${code}`, { method: 'GET', url: 'https://example.test/x', status, code });
/** @param {number} consumedUnits */
const copilotSkus = (consumedUnits, sku = 'Microsoft_365_Copilot') => [{ skuPartNumber: sku, capabilityStatus: 'Enabled', consumedUnits, prepaidUnits: { enabled: 100 }, servicePlans: [{ servicePlanName: 'M365_COPILOT_APPS' }] }];

/**
 * Read-only APIs with everything a user could have, to take away test by test.
 * @param {any} [over]
 */
function fakeApis(over = {}) {
  /** @type {Record<string, any[]>} */
  const perms = { '/subscriptions/sub-1': ALL, ...(over.perms ?? {}) };
  return /** @type {any} */ ({
    graph: {
      myDirectoryRoles: async () => over.roles ?? [{ roleTemplateId: GA, displayName: 'Global Administrator' }, { roleTemplateId: FABRIC_ADMIN_ROLE, displayName: 'Fabric Administrator' }],
      myEligibleRoles: over.eligible ?? (async () => []),
      myGroupIds: async () => ['group-1'],
      myLicenseDetails: async () => over.licences ?? [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'Success' }] }],
      subscribedSkus: over.skusFn ?? (async () => over.skus ?? []),
      usersCanRegisterApps: async () => over.usersCanRegister ?? true,
      reportSettings: over.reportSettings ?? (async () => ({ displayConcealedNames: false })),
    },
    arm: {
      listSubscriptions: over.subsFn ?? (async () => over.subs ?? [{ subscriptionId: 'sub-1', displayName: 'Production', state: 'Enabled' }]),
      permissions: async (/** @type {string} */ scope) => perms[scope] ?? READ,
      myRoleAssignments: async (/** @type {string} */ scope) => over.assigned?.[scope] ?? [assignment(ROLES.owner)],
      myEligibleRoles: async (/** @type {string} */ scope) => over.armEligible?.[scope] ?? [],
      getVault: over.getVault ?? (async (/** @type {string} */ id) => ({ id, name: 'kv-ai-in-one' })),
    },
    fabric: {
      listCapacities: over.capacitiesFn ?? (async () => over.capacities ?? [{ id: 'cap-1', displayName: 'F64', sku: 'F64', state: 'Active' }]),
      tenantSettings: over.tenantSettings ?? (async () => { throw new HttpError('401 Unauthorized', { method: 'GET', url: 'https://api.fabric.microsoft.com/v1/admin/tenantsettings', status: 401 }); }),
    },
  });
}

/** The checks by id. @param {any} over @param {import('../src/config.js').InstallConfig} [config] @param {boolean} [useKeyVault]  As with --key-vault. */
const run = async (over, config = emptyConfig(), useKeyVault = false) => {
  const items = await checkPrereqs({ api: fakeApis(over), user: USER, config, useKeyVault });
  return Object.fromEntries(items.map((i) => [i.id, i]));
};
/** @param {any} over @param {import('../src/config.js').InstallConfig} [config] */
const withKeyVault = (over, config = emptyConfig()) => run(over, config, true);

test('checkPrereqs: a well-equipped admin meets everything; each item says what it is for and how to get it', async () => {
  const api = fakeApis();
  /** @type {string[]} */
  const azure = [];
  for (const [name, fn] of Object.entries(api.arm)) api.arm[name] = async (/** @type {any[]} */ ...args) => (azure.push(name), /** @type {any} */ (fn)(...args));
  const items = await checkPrereqs({ api, user: USER, config: emptyConfig() });
  assert.deepEqual(items.map((i) => i.id), ['consent-role', 'fabric-admin', 'register-apps', 'power-bi-pro', 'copilot-licences', 'fabric-capacity', 'tenant-settings', 'concealed-names']);
  assert.deepEqual(azure, [], 'without Key Vault, nothing in Azure is read');
  for (const i of items) {
    assert.ok(i.neededFor && i.howTo && i.label, i.id);
  }
  assert.deepEqual(items.filter((i) => i.optional).map((i) => i.id), ['consent-role', 'fabric-admin', 'copilot-licences', 'concealed-names']);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId['consent-role'].status, 'met');
  assert.match(byId['consent-role'].detail, /Active: Global Administrator/);
  assert.equal(byId['fabric-admin'].status, 'met');
  assert.equal(byId['register-apps'].status, 'met');
  assert.equal(byId['register-apps'].detail, 'Your Global Administrator role allows it.');
  assert.equal(byId['power-bi-pro'].status, 'met');
  assert.equal(byId['power-bi-pro'].detail, 'Power BI Pro');
  assert.equal(byId['fabric-capacity'].status, 'met');
  assert.equal(byId['fabric-capacity'].detail, '1 available: F64 (F64).');
  assert.match(byId['fabric-capacity'].neededFor, /The AI in One workspace, Lakehouse, notebooks and pipeline run on it/);
  assert.equal(byId['tenant-settings'].status, 'unknown', 'a 401 on tenant settings is "couldn\'t check", not missing');
  assert.match(byId['tenant-settings'].detail, /only a Fabric Administrator can read/);
  assert.equal(byId['concealed-names'].status, 'met');
  assert.equal(byId['azure-rbac'], undefined);
  assert.equal(byId['key-vault'], undefined);
});

test('checkPrereqs: only active roles count; one you can activate in PIM says so, with a link', async () => {
  const eligible = await run({ roles: [], eligible: async () => [{ roleDefinitionId: GA, principalId: USER.id }] });
  assert.equal(eligible['consent-role'].status, 'eligible');
  assert.match(eligible['consent-role'].detail, /Not active yet: Global Administrator\. You can activate this role in Entra \(Privileged Identity Management\): https:\/\/entra\.microsoft\.com\/.* Then check again\.$/);
  assert.doesNotMatch(eligible['consent-role'].detail, /PIM-eligible|Eligible/);

  const none = await run({ roles: [], eligible: async () => { throw failure(403); } });
  assert.equal(none['consent-role'].status, 'missing');
  assert.equal(none['consent-role'].detail, 'You don\'t have Global Administrator or Privileged Role Administrator active. Couldn\'t check for roles you could activate yourself.');
  assert.match(none['consent-role'].howTo, /link for a Global Administrator/);
  assert.equal(none['register-apps'].status, 'met', 'users can register apps');
  assert.equal(none['register-apps'].detail, 'Users in this tenant can register apps.');

  const locked = await run({ roles: [], usersCanRegister: false });
  assert.equal(locked['register-apps'].status, 'missing');
  assert.match(locked['register-apps'].howTo, /admin pack/);

  const appAdmin = await run({ roles: [{ roleTemplateId: APP_ADMIN, displayName: 'Application Administrator' }], usersCanRegister: false });
  assert.equal(appAdmin['register-apps'].status, 'met');
  assert.equal(appAdmin['register-apps'].detail, 'Your Application Administrator role allows it.');

  const config = emptyConfig();
  config.app.appId = 'app-9';
  const reuse = await run({ roles: [], usersCanRegister: false }, config);
  assert.equal(reuse['register-apps'].status, 'met', 'an app registration you already have needs no rights to register one');
  assert.equal(reuse['register-apps'].detail, 'Uses the app registration app-9.');
});

test('checkPrereqs: Power BI Pro only counts once provisioned', async () => {
  const none = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'PendingActivation' }, { servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'Success' }] }] });
  assert.equal(none['power-bi-pro'].status, 'missing');
  const ppu = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P3', provisioningStatus: 'Success' }] }] });
  assert.equal(ppu['power-bi-pro'].status, 'met');
  assert.match(ppu['power-bi-pro'].detail, /Premium Per User/);
});

test('keyVaultWanted: Azure is only checked for --key-vault, or an install that keeps its secret in a vault', () => {
  assert.equal(keyVaultWanted({ config: emptyConfig() }), false);
  assert.equal(keyVaultWanted({ config: emptyConfig(), useKeyVault: true }), true);
  for (const mode of /** @type {const} */ (['keyvault', 'keyvault-admin'])) {
    const config = emptyConfig();
    config.keyVault.mode = mode;
    assert.equal(keyVaultWanted({ config }), true, mode);
  }
  const notebook = emptyConfig();
  notebook.keyVault.mode = 'notebook';
  notebook.keyVault.id = VAULT_ID;
  notebook.keyVault.uri = 'https://kv-ai-in-one.vault.azure.net/';
  assert.equal(keyVaultWanted({ config: notebook }), false, 'a secret in the notebooks needs no vault, whatever vault is recorded');
  assert.equal(keyVaultWanted({ config: notebook, useKeyVault: true }), true);
  for (const key of /** @type {const} */ (['id', 'uri'])) {
    const config = emptyConfig();
    config.keyVault[key] = key === 'id' ? VAULT_ID : 'https://kv-ai-in-one.vault.azure.net/';
    assert.equal(keyVaultWanted({ config }), true, `a recorded vault ${key} with no mode is a vault install`);
  }
});

test('checkPrereqs: with Key Vault, Azure access per subscription: Contributor alone is missing, Contributor and UAA is met, eligible Owner says activate first', async () => {
  const subs = [
    { subscriptionId: 'sub-a', displayName: 'A', state: 'Enabled' },
    { subscriptionId: 'sub-b', displayName: 'B', state: 'Enabled' },
    { subscriptionId: 'sub-c', displayName: 'C', state: 'Enabled' },
    { subscriptionId: 'sub-off', displayName: 'Off', state: 'Disabled' },
  ];
  const r = await withKeyVault({
    subs,
    perms: { '/subscriptions/sub-a': CREATE, '/subscriptions/sub-b': ALL, '/subscriptions/sub-c': READ },
    assigned: {
      '/subscriptions/sub-a': [assignment(ROLES.contributor)],
      '/subscriptions/sub-b': [assignment(ROLES.contributor), assignment(ROLES.userAccessAdministrator, 'group-1')],
      '/subscriptions/sub-c': [],
    },
    armEligible: { '/subscriptions/sub-c': [assignment(ROLES.owner)] },
  });
  const ids = Object.keys(r);
  assert.deepEqual(ids.slice(ids.indexOf('fabric-capacity'), ids.indexOf('tenant-settings') + 1), ['fabric-capacity', 'azure-rbac', 'key-vault', 'tenant-settings']);
  const rbac = r['azure-rbac'];
  assert.equal(rbac.optional, true);
  assert.match(rbac.neededFor, /^Only with Key Vault \(--key-vault\)/);
  const rows = Object.fromEntries((rbac.rows ?? []).map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(rows).sort(), ['A', 'B', 'C'], 'disabled subscriptions are skipped');
  assert.equal(rows.A.status, 'missing');
  assert.equal(rows.A.detail, 'Can create resources but not assign roles (no User Access Administrator) (Contributor)');
  assert.equal(rows.B.status, 'met');
  assert.equal(rows.B.detail, 'Can create resources and assign roles (Contributor, User Access Administrator)', 'a role held through a group counts');
  assert.equal(rows.C.status, 'eligible');
  assert.equal(rows.C.detail, 'Not active yet: Owner. You can activate it in Privileged Identity Management.');
  assert.equal(rbac.status, 'met');
  assert.equal(rbac.detail, '1 of 3 subscriptions give you this.');
  assert.equal(r['key-vault'].status, 'met');
  assert.equal(r['key-vault'].detail, 'You can create a new vault in one of your subscriptions.');

  const assignOnly = await withKeyVault({ perms: { '/subscriptions/sub-1': [{ actions: ['Microsoft.Authorization/roleAssignments/write', '*/read'], notActions: [] }] }, assigned: { '/subscriptions/sub-1': [assignment(ROLES.userAccessAdministrator)] } });
  assert.equal(assignOnly['azure-rbac'].rows?.[0].detail, 'Can assign roles but not create resources (no Contributor) (User Access Administrator)');
  const readOnly = await withKeyVault({ perms: { '/subscriptions/sub-1': READ }, assigned: { '/subscriptions/sub-1': [] } });
  assert.equal(readOnly['azure-rbac'].status, 'missing');
  assert.equal(readOnly['azure-rbac'].rows?.[0].detail, 'Can\'t create resources or assign roles');
  assert.equal(readOnly['key-vault'].status, 'missing');
});

test('checkPrereqs: with Key Vault, the install\'s subscription is checked first, no more than ten are checked, and no Azure at all is optional', async () => {
  const config = emptyConfig();
  config.keyVault.subscriptionId = 'sub-b';
  const r = await withKeyVault({ subs: [{ subscriptionId: 'sub-a', displayName: 'A', state: 'Enabled' }, { subscriptionId: 'sub-b', displayName: 'B', state: 'Enabled' }] }, config);
  assert.equal(r['azure-rbac'].rows?.[0].name, 'B');

  const many = Array.from({ length: MAX_SUBSCRIPTIONS + 2 }, (_, i) => ({ subscriptionId: `sub-${i + 1}`, displayName: `S${i + 1}`, state: 'Enabled' }));
  const lots = await withKeyVault({ subs: many });
  assert.equal(MAX_SUBSCRIPTIONS, 10);
  assert.equal(lots['azure-rbac'].rows?.length, MAX_SUBSCRIPTIONS);
  assert.equal(lots['azure-rbac'].detail, '1 of 10 subscriptions give you this. Checked the first 10 of 12.');

  const none = await withKeyVault({ subs: [] });
  assert.equal(none['azure-rbac'].status, 'missing');
  assert.equal(none['azure-rbac'].optional, true);
  assert.equal(none['azure-rbac'].detail, 'No enabled Azure subscription you can see.');
  assert.match(none['azure-rbac'].howTo, /leave out --key-vault: the app secret goes in the notebooks/);
  assert.equal(none['key-vault'].status, 'missing');
  assert.equal(none['key-vault'].optional, true, 'no Key Vault is a choice');
  assert.match(none['key-vault'].detail, /^You can't create a vault in any subscription you can see\./);

  const unlisted = await withKeyVault({ subsFn: async () => { throw failure(403); } });
  assert.equal(unlisted['azure-rbac'].status, 'unknown');
  assert.match(unlisted['azure-rbac'].detail, /^Couldn't check: 403/);
  assert.equal(unlisted['key-vault'].status, 'unknown');
  assert.equal(unlisted['key-vault'].detail, 'Couldn\'t check your Azure access.');

  const eligible = await withKeyVault({ perms: { '/subscriptions/sub-1': READ }, assigned: { '/subscriptions/sub-1': [] }, armEligible: { '/subscriptions/sub-1': [assignment(ROLES.owner)] } });
  assert.equal(eligible['azure-rbac'].status, 'eligible');
  assert.equal(eligible['key-vault'].status, 'eligible', 'activating the Azure role is enough to create the vault');
});

test('checkPrereqs: with a vault already chosen, you need to be able to write its secrets', async () => {
  const config = emptyConfig();
  config.keyVault.id = VAULT_ID;
  config.keyVault.name = 'kv-ai-in-one';
  const rbacVault = async () => ({ id: VAULT_ID, name: 'kv-ai-in-one', properties: { enableRbacAuthorization: true } });

  const writer = await run({ getVault: rbacVault, perms: { [VAULT_ID]: [{ actions: ['*/read'], dataActions: ['Microsoft.KeyVault/vaults/secrets/*'] }] } }, config);
  assert.equal(writer['key-vault'].status, 'met', 'a recorded vault is checked without --key-vault');
  assert.equal(writer['key-vault'].detail, 'You can write secrets to kv-ai-in-one.');

  const reader = await run({ getVault: rbacVault, perms: { [VAULT_ID]: READ } }, config);
  assert.equal(reader['key-vault'].status, 'missing');
  assert.equal(reader['key-vault'].detail, 'You can\'t write secrets to kv-ai-in-one. A vault admin can add the secret for you, or give you Key Vault Secrets Officer.');

  const policy = async () => ({ id: VAULT_ID, name: 'kv-ai-in-one', properties: { accessPolicies: [{ objectId: USER.id, permissions: { secrets: ['Get', 'List', 'Set'] } }] } });
  const viaPolicy = await run({ getVault: policy, perms: { [VAULT_ID]: READ } }, config);
  assert.equal(viaPolicy['key-vault'].status, 'met', 'an access policy that lets you set secrets counts');

  const gone = await run({ getVault: async () => { throw failure(404, 'NotFound'); } }, config);
  assert.equal(gone['key-vault'].status, 'unknown');
  assert.match(gone['key-vault'].detail, /^Couldn't check: 404 GET \/x returned 404 NotFound$/);
});

test('checkPrereqs: a capacity counts when active and able to run Fabric; with many seats and nothing F64 or larger, it says so', async () => {
  const r = await run({ capacities: [{ id: 'p1', displayName: 'Premium', sku: 'P1', state: 'Active' }, { id: 'f2', displayName: 'Paused', sku: 'F2', state: 'Paused' }] });
  assert.equal(r['fabric-capacity'].status, 'met', 'a P SKU runs Fabric');
  assert.equal(r['fabric-capacity'].detail, '1 available: Premium (P1).');

  for (const sku of ['A1', 'EM1', 'PP3']) {
    const noCap = await run({ capacities: [{ id: 'x', displayName: 'Embedded', sku, state: 'Active' }] });
    assert.equal(noCap['fabric-capacity'].status, 'missing', sku);
    assert.equal(noCap['fabric-capacity'].detail, 'No active Fabric capacity (F2 or larger, or a trial) you can assign workspaces to.');
  }

  const four = await run({ capacities: [1, 2, 3, 4].map((n) => ({ id: `c${n}`, displayName: `Cap ${n}`, sku: 'F2', state: 'Active' })) });
  assert.equal(four['fabric-capacity'].detail, '4 available: Cap 1 (F2), Cap 2 (F2), Cap 3 (F2) and 1 more.', 'lists the first three');

  const small = [{ id: 'f8', displayName: 'Small', sku: 'F8', state: 'Active' }];
  assert.equal(BIG_CAPACITY_SEATS, 30_000);
  const big = await run({ capacities: small, skus: copilotSkus(BIG_CAPACITY_SEATS) });
  assert.equal(big['fabric-capacity'].status, 'met', 'a small capacity still works');
  assert.equal(big['fabric-capacity'].detail, '1 available: Small (F8). With 30,000 Copilot seats assigned, use F64 or larger: on a smaller capacity, loads take longer and may hit their time limits.');
  const fewer = await run({ capacities: small, skus: copilotSkus(BIG_CAPACITY_SEATS - 1) });
  assert.equal(fewer['fabric-capacity'].detail, '1 available: Small (F8).');
  const large = await run({ capacities: [...small, { id: 'f64', displayName: 'Large', sku: 'F64', state: 'Active' }], skus: copilotSkus(BIG_CAPACITY_SEATS) });
  assert.doesNotMatch(large['fabric-capacity'].detail, /use F64 or larger/);
  const unread = await run({ capacities: small, skusFn: async () => { throw failure(403); } });
  assert.equal(unread['fabric-capacity'].detail, '1 available: Small (F8).', 'seats that can\'t be read add nothing');

  const down = await run({ capacitiesFn: async () => { throw failure(503, 'ServiceUnavailable'); } });
  assert.equal(down['fabric-capacity'].status, 'unknown');
  assert.match(down['fabric-capacity'].detail, /^Couldn't check: 503/);
});

test('checkPrereqs: tenant settings: each one that is off is named; one delegated to capacity admins isn\'t counted as off', async () => {
  const setting = (/** @type {string} */ settingName, /** @type {boolean} */ enabled, delegateToCapacity = false) => ({ settingName, enabled, delegateToCapacity });
  const on = await run({ tenantSettings: async () => [setting('ServicePrincipalAccessPermissionAPIs', true), setting('CustomVisualsTenant', true)] });
  assert.equal(on['tenant-settings'].status, 'met');
  assert.equal(on['tenant-settings'].detail, 'The settings AI in One needs are on.');

  const off = await run({ tenantSettings: async () => [setting('ServicePrincipalAccessPermissionAPIs', false), setting('CustomVisualsTenant', false)] });
  assert.equal(off['tenant-settings'].status, 'missing');
  assert.equal(off['tenant-settings'].detail, 'Off: Service principals can call Fabric public APIs; Allow visuals created using the Power BI SDK.', 'the report\'s setting counts too');

  const delegated = await run({ tenantSettings: async () => [setting('ServicePrincipalAccessPermissionAPIs', false, true), setting('CustomVisualsTenant', false)] });
  assert.equal(delegated['tenant-settings'].detail, 'Off: Allow visuals created using the Power BI SDK.');

  const unlisted = await run({ tenantSettings: async () => [] });
  assert.equal(unlisted['tenant-settings'].status, 'met', 'a setting not in the list isn\'t known to be off');
});

test('checkPrereqs: concealed user names: shown is met, concealed is missing (hashed names), unreadable says where to check by hand', async () => {
  const shown = await run({});
  assert.equal(shown['concealed-names'].status, 'met');
  assert.equal(shown['concealed-names'].detail, 'Reports show user names.');

  const concealed = await run({ reportSettings: async () => ({ displayConcealedNames: true }) });
  assert.equal(concealed['concealed-names'].status, 'missing');
  assert.equal(concealed['concealed-names'].optional, true, 'the install goes ahead with hashed names');
  assert.match(concealed['concealed-names'].detail, /hashed user names until it's turned off/);
  assert.ok(concealed['concealed-names'].howTo.includes(CONCEALED_NAMES_SETTING));

  for (const reportSettings of [async () => { throw failure(403); }, async () => ({})]) {
    const unknown = await run({ reportSettings });
    assert.equal(unknown['concealed-names'].status, 'unknown');
    assert.equal(unknown['concealed-names'].detail, `Couldn't check: reading it needs a reports reader or admin role. To check by hand, open ${CONCEALED_NAMES_SETTING}.`);
  }
});

test('graph and ARM lookups keep only rows for the signed-in user\'s principals, whatever the filter returned', async () => {
  /** @type {any[]} */
  const queries = [];
  const http = /** @type {any} */ ({
    list: async (/** @type {string} */ path, /** @type {any} */ o) => {
      queries.push([path, o.query]);
      if (path.includes('roleEligibilityScheduleInstances') && path.startsWith('/roleManagement')) {
        return [{ roleDefinitionId: GA, principalId: USER.id }, { roleDefinitionId: GA, principalId: 'someone-else' }];
      }
      return [assignment(ROLES.owner), assignment(ROLES.owner, 'someone-else'), assignment(ROLES.contributor, 'group-1')];
    },
  });
  const graph = graphApi(http);
  assert.deepEqual((await graph.myEligibleRoles(USER.id)).map((r) => r.principalId), [USER.id]);
  assert.match(queries[0][1].$filter, /principalId eq 'user-1'/);

  const arm = armApi(http);
  const ids = [USER.id, 'group-1'];
  assert.deepEqual((await arm.myRoleAssignments('/subscriptions/s', ids)).map((r) => r.properties.principalId), [USER.id, 'group-1']);
  assert.equal(queries[1][1].$filter, "assignedTo('user-1')");
  assert.deepEqual((await arm.myEligibleRoles('/subscriptions/s', ids)).map((r) => r.properties.principalId), [USER.id, 'group-1']);
  assert.equal(queries[2][1].$filter, 'asTarget()');
});

test('checkPrereqs: Fabric administrator says plainly it is only needed when the tenant settings are off', async () => {
  const r = await run({ roles: [], eligible: async () => [{ roleDefinitionId: FABRIC_ADMIN_ROLE, principalId: USER.id }] });
  assert.match(r['fabric-admin'].label, /only needed if the tenant settings below are off/);
  assert.equal(r['fabric-admin'].status, 'eligible');
  assert.match(r['fabric-admin'].detail, /You can activate this role in Entra \(Privileged Identity Management\)/);
  for (const i of Object.values(r)) assert.doesNotMatch(`${i.label} ${i.detail} ${i.howTo}`, /PIM-eligible/, i.id);
});

test('checkPrereqs: Microsoft 365 Copilot licences in the tenant are met once any are assigned', async () => {
  const none = await run({ skus: [{ skuPartNumber: 'SPE_E5', consumedUnits: 50, servicePlans: [{ servicePlanName: 'EXCHANGE_S_ENTERPRISE' }] }] });
  assert.equal(none['copilot-licences'].status, 'missing');
  assert.equal(none['copilot-licences'].optional, true, 'Copilot Chat usage shows without them');
  assert.equal(none['copilot-licences'].detail, 'No Microsoft 365 Copilot licences found in this tenant.');
  const bought = await run({ skus: copilotSkus(0) });
  assert.equal(bought['copilot-licences'].status, 'missing');
  assert.equal(bought['copilot-licences'].detail, 'The tenant has Microsoft_365_Copilot, but none are assigned yet.');
  const used = await run({ skus: [...copilotSkus(30), ...copilotSkus(5, 'Microsoft_365_Copilot_EDU')] });
  assert.equal(used['copilot-licences'].status, 'met');
  assert.equal(used['copilot-licences'].detail, '35 assigned (Microsoft_365_Copilot, Microsoft_365_Copilot_EDU).');
  const many = await run({ skus: copilotSkus(12_345) });
  assert.match(many['copilot-licences'].detail, /^12,345 assigned/);
  const unreadable = await run({ skusFn: async () => { throw failure(403); } });
  assert.equal(unreadable['copilot-licences'].status, 'unknown');
});
