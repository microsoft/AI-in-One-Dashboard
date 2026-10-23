// @ts-check
/** In-memory stand-ins for the Fabric, Graph, Azure and Power BI APIs, the UI and the install record. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG_FILE, emptyConfig } from '../src/config.js';
import { fabricApi } from '../src/clients/fabric.js';
import { createClient, HttpError } from '../src/http.js';
import { loadSources } from '../src/sources.js';
import { DEFAULT_LAKEHOUSE_NAME } from '../src/steps/fabric.js';
import { createUi } from '../src/ui.js';

/** @typedef {import('../src/clients/fabric.js').ItemRef} ItemRef */

/** Where fake installs keep their record, so files written beside it stay out of the repo. */
const TEST_RECORD_DIR = mkdtempSync(join(tmpdir(), 'aio-installer-test-'));

let sources;
/** Loads the real notebooks and pipeline once. */
export function realSources() {
  sources ??= loadSources();
  return sources;
}

/**
 * A UI that records output. `answers` scripts confirm and select replies in order;
 * when it runs out, the default is taken. `yesTo` names confirms that say yes instead.
 * @param {{ yes?: boolean, answers?: any[], yesTo?: string[] }} [opts]
 */
export function fakeUi(opts = {}) {
  /** @type {string[]} */
  const out = [];
  const answers = [...(opts.answers ?? [])];
  const base = createUi({ yes: opts.yes, write: (s) => out.push(s) });
  /** @type {string[]} */
  const asked = [];
  const ui = {
    ...base,
    /** @param {string} message @param {boolean} def */
    async confirm(message, def) {
      asked.push(message);
      if (opts.yesTo?.includes(message)) return true;
      return answers.length ? answers.shift() : def;
    },
    /** @param {string} message @param {any[]} choices @param {any} def */
    async select(message, choices, def) {
      asked.push(message);
      return answers.length ? answers.shift() : def;
    },
    /** @param {string} message */
    async secret(message) {
      asked.push(message);
      if (!answers.length) throw new Error(`No answer scripted for "${message}"`);
      return answers.shift();
    },
    /** @param {string} message @param {{ default?: string, validate?: (v: string) => true | string }} [o] */
    async input(message, o = {}) {
      asked.push(message);
      const value = answers.length ? answers.shift() : o.default;
      const verdict = o.validate?.(value) ?? true;
      if (verdict !== true) throw new Error(`${message}: ${verdict}`);
      return value;
    },
    /** @param {string} message @param {{ value: any, checked?: boolean }[]} choices */
    async checkbox(message, choices) {
      asked.push(message);
      return answers.length ? answers.shift() : choices.filter((ch) => ch.checked).map((ch) => ch.value);
    },
  };
  return { ui: /** @type {import('../src/ui.js').Ui} */ (/** @type {unknown} */ (ui)), out, asked, text: () => out.join('') };
}

/** A Fabric workspace held in memory. */
export function fakeFabric() {
  let n = 0;
  /** @type {{ id: string, type: string, displayName: string, content?: any, description?: string }[]} */
  const items = [];
  /** @type {any[]} */
  const schedules = [];
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const jobs = [];
  /** Job instances listJobs returns. @type {any[]} */
  const jobList = [];
  /** Activity runs queryActivityRuns returns, by job id. @type {Record<string, any[]>} */
  const activityRuns = {};
  /** @type {any[]} */
  const roles = [];
  /** @type {{ id: string, displayName: string, body?: any }[]} */
  const connections = [];
  /**
   * The workspace's managed private endpoints. One that's deleted is still listed `deleting` more
   * times, as Fabric takes a while to remove it.
   * @type {{ id: string, name: string, targetPrivateLinkResourceId?: string, deleting?: number }[]}
   */
  const privateEndpoints = [];
  /** How many more times listPrivateEndpoints shows an endpoint once it's deleted. */
  const endpointLag = { lists: 0 };
  /** @type {Record<string, string>} */
  const workspaceCapacities = {};
  /** Errors to throw, in order, the next times a method is called. @type {Record<string, Error[]>} */
  const failures = {};
  /** SQL endpoint states getLakehouse returns, in order; then a ready endpoint. @type {any[]} */
  const sqlStates = [];
  /** What getLakehouse says of the Lakehouse's schemas: on, with dbo, unless a test deletes it. @type {{ defaultSchema?: string }} */
  const lakehouse = { defaultSchema: 'dbo' };
  /** The workspace's Spark settings. @type {{ highConcurrency: Record<string, boolean> }} */
  const spark = { highConcurrency: { notebookInteractiveRunEnabled: true, notebookPipelineRunEnabled: false } };
  /** The workspace's Git connection. @type {{ gitConnectionState: string }} */
  const git = { gitConnectionState: 'NotConnected' };
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  /** Fabric operations creates answered 202 with, and what operationStatus says of them. @type {Record<string, string>} */
  const operations = {};
  const add = (/** @type {string} */ type, /** @type {string} */ displayName, /** @type {any} */ content, /** @type {ItemRef} */ ref = '') => {
    const item = { id: `${type.toLowerCase()}-${++n}`, type, displayName, content, description: typeof ref === 'string' ? ref : ref.text };
    if (typeof ref === 'object' && ref.onAccepted) {
      const url = `https://api.fabric.microsoft.com/v1/operations/op-${n}`;
      operations[url] = 'Succeeded';
      ref.onAccepted(url);
    }
    items.push(item);
    return item;
  };
  const find = (/** @type {string} */ id) => {
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`no item ${id}`);
    return item;
  };
  const api = {
    /** @param {string} url */
    operationStatus: async (url) => {
      calls.push(`operationStatus ${url.split('/').pop()}`);
      fail('operationStatus');
      return operations[url];
    },
    /** @param {string} _ws @param {string} type */
    listItems: async (_ws, type) => items.filter((i) => i.type === type).map(({ id, type: t, displayName, description }) => ({ id, type: t, displayName, description })),
    /** @param {string} _ws @param {string} id */
    deleteItem: async (_ws, id) => {
      const at = items.findIndex((i) => i.id === id);
      calls.push(`deleteItem ${at >= 0 ? items[at].displayName : id}`);
      fail('deleteItem');
      if (at < 0) throw notFound();
      items.splice(at, 1);
      return null;
    },
    /** @param {string} _ws @param {string} name @param {string} content @param {ItemRef} [ref] */
    createNotebook: async (_ws, name, content, ref) => {
      calls.push(`createNotebook ${name}`);
      return { id: add('Notebook', name, content, ref).id };
    },
    /** @param {string} _ws @param {string} id @param {string} content */
    updateNotebook: async (_ws, id, content) => {
      calls.push(`updateNotebook ${find(id).displayName}`);
      find(id).content = content;
      return null;
    },
    /** @param {string} _ws @param {string} name @param {any} def @param {ItemRef} [ref] */
    createPipeline: async (_ws, name, def, ref) => {
      calls.push(`createPipeline ${name}`);
      // Fabric may answer 202 with no body; the step then finds the item by name.
      add('DataPipeline', name, def, ref);
      return null;
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updatePipeline: async (_ws, id, def) => {
      calls.push(`updatePipeline ${find(id).displayName}`);
      find(id).content = def;
      return null;
    },
    /** @param {string} _ws @param {string} id */
    getPipelineDefinition: async (_ws, id) => {
      fail('getPipelineDefinition');
      const item = items.find((i) => i.id === id);
      if (!item?.content) throw notFound();
      return structuredClone(item.content);
    },
    getSparkSettings: async () => {
      fail('getSparkSettings');
      return structuredClone(spark);
    },
    /** @param {string} _ws @param {any} body */
    updateSparkSettings: async (_ws, body) => {
      calls.push(`updateSparkSettings ${JSON.stringify(body)}`);
      fail('updateSparkSettings');
      spark.highConcurrency = { ...spark.highConcurrency, ...body.highConcurrency };
      return null;
    },
    listSchedules: async () => schedules.map((s) => structuredClone(s)),
    /** @param {string} _ws @param {string} _id @param {any} body */
    createSchedule: async (_ws, _id, body) => {
      calls.push('createSchedule');
      const s = { id: `schedule-${++n}`, owner: { id: 'u' }, ...structuredClone(body) };
      schedules.push(s);
      return s;
    },
    /** @param {string} _ws @param {string} _id @param {string} sid @param {any} body */
    updateSchedule: async (_ws, _id, sid, body) => {
      calls.push('updateSchedule');
      Object.assign(/** @type {any} */ (schedules.find((s) => s.id === sid)), structuredClone(body));
      return null;
    },
    /** @param {string} ws @param {string} id @param {string} jobType @param {any} data */
    runJob: async (ws, id, jobType, data) => {
      calls.push(`runJob ${jobType}${data ? ` ${JSON.stringify(data)}` : ''}`);
      fail('runJob');
      return `https://api.fabric.microsoft.com/v1/workspaces/${ws}/items/${id}/jobs/instances/job-${++n}`;
    },
    getJob: async () => jobs.shift(),
    listJobs: async () => structuredClone(jobList),
    /** @param {string} _ws @param {string} jobId */
    queryActivityRuns: async (_ws, jobId) => structuredClone(activityRuns[jobId] ?? []),
    /** @param {string} _ws @param {string} id */
    getLakehouse: async (_ws, id) => {
      fail('getLakehouse');
      return {
        id,
        displayName: items.find((i) => i.id === id)?.displayName ?? DEFAULT_LAKEHOUSE_NAME,
        properties: {
          ...(lakehouse.defaultSchema ? { defaultSchema: lakehouse.defaultSchema } : {}),
          sqlEndpointProperties: sqlStates.length ? sqlStates.shift() : { connectionString: 'abc.datawarehouse.fabric.microsoft.com', provisioningStatus: 'Success' },
        },
      };
    },
    /** @param {string} _ws @param {string} name @param {ItemRef} [ref] */
    createLakehouse: async (_ws, name, ref) => {
      calls.push(`createLakehouse ${name}`);
      fail('createLakehouse');
      return { id: add('Lakehouse', name, null, ref).id };
    },
    /** @param {string} _ws @param {string} name @param {any} def @param {ItemRef} [ref] */
    createSemanticModel: async (_ws, name, def, ref) => {
      calls.push(`createSemanticModel ${name}`);
      fail('createSemanticModel');
      return { id: add('SemanticModel', name, def, ref).id };
    },
    /** @param {string} _ws @param {string} id @param {any} def @param {{ allowPurgeData?: boolean }} [opts] */
    updateSemanticModel: async (_ws, id, def, opts) => {
      calls.push(`updateSemanticModel ${find(id).displayName}${opts?.allowPurgeData ? ' allowPurgeData' : ''}`);
      fail('updateSemanticModel');
      find(id).content = def;
      return null;
    },
    /** @param {string} _ws @param {string} name @param {any} def @param {ItemRef} [ref] */
    createReport: async (_ws, name, def, ref) => {
      calls.push(`createReport ${name}`);
      fail('createReport');
      return { id: add('Report', name, def, ref).id };
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updateReport: async (_ws, id, def) => {
      calls.push(`updateReport ${find(id).displayName}`);
      find(id).content = def;
      return null;
    },
    listRoleAssignments: async () => {
      fail('listRoleAssignments');
      return structuredClone(roles);
    },
    /** @param {string} _ws @param {string} id @param {string} type @param {string} role */
    addRoleAssignment: async (_ws, id, type, role) => {
      calls.push(`addRoleAssignment ${id} ${role}`);
      roles.push({ id, principal: { id, type }, role });
      return null;
    },
    /** @param {string} _ws @param {string} id @param {string} role */
    updateRoleAssignment: async (_ws, id, role) => {
      calls.push(`updateRoleAssignment ${id} ${role}`);
      Object.assign(/** @type {any} */ (roles.find((r) => r.id === id)), { role });
      return null;
    },
    /** @param {string} _ws @param {string} id */
    deleteRoleAssignment: async (_ws, id) => {
      calls.push(`deleteRoleAssignment ${id}`);
      fail('deleteRoleAssignment');
      const at = roles.findIndex((r) => r.id === id);
      if (at < 0) throw notFound();
      roles.splice(at, 1);
      return null;
    },
    listConnections: async () => connections.map(({ id, displayName }) => ({ id, displayName })),
    /** @param {string} id */
    getConnection: async (id) => {
      const conn = connections.find((x) => x.id === id);
      if (!conn) throw notFound();
      return { id, displayName: conn.displayName };
    },
    /** @param {any} body */
    createConnection: async (body) => {
      calls.push(`createConnection ${body.displayName}`);
      fail('createConnection');
      const conn = { id: `connection-${++n}`, displayName: body.displayName, body };
      connections.push(conn);
      return { id: conn.id, displayName: conn.displayName };
    },
    /** @param {string} id @param {any} body */
    updateConnection: async (id, body) => {
      calls.push(`updateConnection ${id}`);
      fail('updateConnection');
      Object.assign(/** @type {any} */ (connections.find((x) => x.id === id)), { body });
      return null;
    },
    /** @param {string} id */
    deleteConnection: async (id) => {
      calls.push(`deleteConnection ${id}`);
      fail('deleteConnection');
      const at = connections.findIndex((x) => x.id === id);
      if (at >= 0) connections.splice(at, 1);
    },
    listCapacities: async () => [{ id: 'cap-f', displayName: 'Trial', sku: 'FTL64', region: 'West US 3', state: 'Active' }, { id: 'cap-ppu', displayName: 'PPU', sku: 'PP3', region: 'West US 3', state: 'Active' }],
    /** @param {string} id */
    getWorkspace: async (id) => ({ id, capacityId: workspaceCapacities[id] }),
    /** @param {string} id @param {string} capacityId */
    assignToCapacity: async (id, capacityId) => {
      calls.push(`assignToCapacity ${id} ${capacityId}`);
      workspaceCapacities[id] = capacityId;
    },
    /** @param {string} id */
    deleteWorkspace: async (id) => {
      calls.push(`deleteWorkspace ${id}`);
      fail('deleteWorkspace');
      if (privateEndpoints.length) throw httpError(400, 'The workspace has managed private endpoints.');
      return null;
    },
    /** @param {string} _ws */
    listPrivateEndpoints: async (_ws) => {
      calls.push('listPrivateEndpoints');
      fail('listPrivateEndpoints');
      for (const e of [...privateEndpoints]) {
        if (e.deleting === undefined) continue;
        if (e.deleting <= 0) privateEndpoints.splice(privateEndpoints.indexOf(e), 1);
        else e.deleting--;
      }
      return privateEndpoints.map(({ deleting: _, ...e }) => ({ ...e }));
    },
    /** @param {string} _ws @param {string} id */
    deletePrivateEndpoint: async (_ws, id) => {
      calls.push(`deletePrivateEndpoint ${id}`);
      fail('deletePrivateEndpoint');
      const e = privateEndpoints.find((x) => x.id === id);
      if (!e) throw notFound();
      e.deleting ??= endpointLag.lists;
      return null;
    },
    /** @param {string} _ws @param {string} id @param {any} binding */
    bindConnection: async (_ws, id, binding) => {
      calls.push(`bindConnection ${find(id).displayName} ${binding.id} ${binding.path}`);
      fail('bindConnection');
      return null;
    },
    /** @param {string} _ws */
    getGitConnection: async (_ws) => {
      fail('getGitConnection');
      return { ...git };
    },
  };
  return { api, items, schedules, calls, jobs, jobList, activityRuns, roles, connections, privateEndpoints, endpointLag, workspaceCapacities, failures, sqlStates, lakehouse, spark, git, add, operations };
}

/**
 * Fabric's createConnection over the real HTTP client, where Fabric makes the connection but answers 429. The
 * client sends it again, and Fabric then says the name is taken.
 * @param {ReturnType<typeof fakeFabric>} fabric  Where the connection is made.
 * @param {any} [listed]  More of what Fabric lists for it.
 */
export function throttledThenTaken(fabric, listed = {}) {
  /** @type {string[]} */
  const sent = [];
  const http = createClient({
    baseUrl: 'https://fabric.invalid/v1',
    getToken: async () => 'offline',
    sleep: async () => {},
    fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
      const body = JSON.parse(init.body);
      sent.push(`${init.method} ${body.displayName}`);
      if (sent.length === 1) {
        fabric.connections.push({ id: 'conn-throttled', displayName: body.displayName, body: { ...body, ...listed } });
        return new Response(JSON.stringify({ errorCode: 'TooManyRequests', message: 'Too many requests' }), { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response(JSON.stringify({ errorCode: 'DuplicateConnectionName', message: `Connection with name ${body.displayName} already exists.` }), { status: 409 });
    }),
  });
  return { createConnection: fabricApi(http).createConnection, sent };
}

/** @param {number} [status] @param {string} [message] */
export const httpError = (status = 404, message = 'Not found') => new HttpError(message, { status, method: 'GET', url: 'https://x' });
const notFound = () => httpError(404);

/** Microsoft Graph calls for app secrets. */
export function fakeGraph() {
  let n = 0;
  /** @type {{ keyId: string, displayName: string }[]} */
  const passwords = [];
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  const api = {
    /** @param {string} _objectId @param {Date} end @param {string} [displayName] */
    addPassword: async (_objectId, end, displayName = 'AI in One installer') => {
      calls.push(`addPassword ${displayName}`);
      const err = failures.addPassword?.shift();
      if (err) throw err;
      const keyId = `key-${++n}`;
      passwords.push({ keyId, displayName });
      return { keyId, secretText: `secret-${n}`, endDateTime: end.toISOString() };
    },
    /** @param {string} _objectId */
    listPasswords: async (_objectId) => {
      calls.push('listPasswords');
      const err = failures.listPasswords?.shift();
      if (err) throw err;
      return passwords.map((p) => ({ ...p }));
    },
    /** @param {string} _objectId @param {string} keyId */
    removePassword: async (_objectId, keyId) => {
      calls.push(`removePassword ${keyId}`);
      const err = failures.removePassword?.shift();
      if (err) throw err;
      const at = passwords.findIndex((p) => p.keyId === keyId);
      if (at >= 0) passwords.splice(at, 1);
      return null;
    },
  };
  return { api, passwords, calls, failures };
}

/**
 * Azure Resource Manager, for the Key Vault the client secret goes in. One enabled subscription; the
 * signed-in user may do anything unless a test narrows `perms`.
 */
export function fakeArm() {
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, any>} */
  const groups = {};
  /** @type {any[]} */
  const vaults = [];
  /** Secrets by vault ID, then name: what Resource Manager says of each (never its value). @type {Record<string, Record<string, { contentType?: string }>>} */
  const secrets = {};
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** The signed-in user's ARM permissions by scope. Anything not listed allows everything. @type {Record<string, { actions?: string[], notActions?: string[] }[]>} */
  const perms = {};
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const api = {
    listSubscriptions: async () => {
      fail('listSubscriptions');
      return [{ subscriptionId: 'sub-1', displayName: 'Sub', state: 'Enabled' }];
    },
    /** @param {string} _sub @param {string} name */
    getResourceGroup: async (_sub, name) => groups[name] ?? null,
    /** @param {string} _sub @param {string} name @param {string} location @param {any} [tags] */
    ensureResourceGroup: async (_sub, name, location, tags = {}) => {
      calls.push(`ensureResourceGroup ${name}`);
      fail('ensureResourceGroup');
      groups[name] = { name, location, tags };
      return groups[name];
    },
    /** @param {string} _sub @param {string} ns */
    ensureProvider: async (_sub, ns) => {
      calls.push(`ensureProvider ${ns}`);
      fail('ensureProvider');
      return false;
    },
    /** @param {string} scope */
    permissions: async (scope) => {
      calls.push(`permissions ${scope}`);
      fail('permissions');
      return perms[scope] ?? [{ actions: ['*'], notActions: [] }];
    },
    myRoleAssignments: async () => [],
    myEligibleRoles: async () => [],
    /** @param {string} _sub */
    listVaults: async (_sub) => structuredClone(vaults),
    /** @param {string} _sub @param {string} name */
    checkVaultName: async (_sub, name) => ({ nameAvailable: !vaults.some((v) => v.name === name) }),
    /** @param {{ subscriptionId: string, resourceGroup: string, name: string, location: string, tenantId: string, rbac: boolean }} v */
    createVault: async (v) => {
      calls.push(`createVault ${v.name}`);
      fail('createVault');
      const vault = {
        id: `/subscriptions/${v.subscriptionId}/resourceGroups/${v.resourceGroup}/providers/Microsoft.KeyVault/vaults/${v.name}`,
        name: v.name,
        location: v.location,
        properties: { vaultUri: `https://${v.name}.vault.azure.net/`, enableRbacAuthorization: v.rbac, provisioningState: 'Succeeded' },
      };
      vaults.push(vault);
      return structuredClone(vault);
    },
    /** @param {string} id */
    getVault: async (id) => {
      const vault = vaults.find((v) => v.id === id);
      if (!vault) throw httpError(404);
      return structuredClone(vault);
    },
    /** @param {string} vaultId @param {string} name @param {string} _value @param {{ contentType?: string }} [o] */
    setSecret: async (vaultId, name, _value, o = {}) => {
      calls.push(`setSecret ${name}`);
      fail('setSecret');
      (secrets[vaultId] ??= {})[name] = { contentType: o.contentType };
      return null;
    },
    /** @param {string} vaultId @param {string} name */
    secretExists: async (vaultId, name) => !!secrets[vaultId]?.[name],
    /** @param {string} vaultId @param {string} name */
    secretInfo: async (vaultId, name) => secrets[vaultId]?.[name] ?? null,
    listPrivateEndpointConnections: async () => [],
    /** @param {string} id */
    approvePrivateEndpointConnection: async (id) => {
      calls.push(`approvePrivateEndpointConnection ${id}`);
      return null;
    },
    /** @param {string} _vaultId @param {string} _tenantId @param {string} objectId */
    addAccessPolicy: async (_vaultId, _tenantId, objectId) => {
      calls.push(`addAccessPolicy ${objectId}`);
      fail('addAccessPolicy');
      return null;
    },
    /** @param {string} scope @param {string} role @param {string} principal @param {string} type */
    assignRole: async (scope, role, principal, type) => {
      calls.push(`assignRole ${scope} ${role} ${principal} ${type}`);
      fail('assignRole');
      return true;
    },
  };
  return { api, calls, groups, vaults, secrets, failures, perms };
}

/** Microsoft Graph for the app registration: the app, its service principal, admin consent and client secrets. */
export function fakeAzureGraph() {
  let n = 0;
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const applications = [];
  /** @type {any[]} */
  const servicePrincipals = [];
  /** The Graph application permissions granted, as appRoleAssignments rows. @type {{ principalId: string, resourceId: string, appRoleId: string }[]} */
  const roleAssignments = [];
  /** @type {{ keyId: string, displayName: string }[]} */
  const passwords = [];
  const graphSp = { id: 'graph-sp', appId: '00000003-0000-0000-c000-000000000000', appRoles: [
    { id: 'r-audit', value: 'AuditLogsQuery.Read.All' },
    { id: 'r-reports', value: 'Reports.Read.All' },
    { id: 'r-users', value: 'User.Read.All' },
    { id: 'r-settings', value: 'ReportSettings.Read.All' },
  ] };
  /** The signed-in user's directory roles. None unless a test adds some. @type {{ roleTemplateId: string, displayName: string }[]} */
  const directoryRoles = [];
  /** What GET /admin/reportSettings answers: user names shown unless a test says otherwise. */
  const reportSettings = { displayConcealedNames: false };
  /** Errors each method throws next, by method. @type {Record<string, Error[]>} */
  const failures = {};
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const api = {
    myDirectoryRoles: async () => structuredClone(directoryRoles),
    reportSettings: async () => {
      fail('reportSettings');
      return { ...reportSettings };
    },
    graphServicePrincipal: async () => graphSp,
    /** @param {string} appId */
    findApplication: async (appId) => applications.find((a) => a.appId === appId) ?? null,
    /** @param {string} appId */
    findServicePrincipal: async (appId) => servicePrincipals.find((s) => s.appId === appId) ?? null,
    /** @param {string} name @param {{ id: string }[]} [appRoles] */
    createApplication: async (name, appRoles = []) => {
      calls.push(`createApplication ${name}`);
      fail('createApplication');
      const app = {
        id: `app-obj-${++n}`,
        appId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        displayName: name,
        requiredResourceAccess: appRoles.length ? [{ resourceAppId: graphSp.appId, resourceAccess: appRoles.map((r) => ({ id: r.id, type: 'Role' })) }] : [],
      };
      applications.push(app);
      return app;
    },
    /** @param {any} application @param {{ id: string }[]} appRoles */
    ensureRequiredAccess: async (application, appRoles) => {
      const access = (application.requiredResourceAccess ??= []);
      let graph = access.find((/** @type {any} */ r) => r.resourceAppId === graphSp.appId);
      if (!graph) access.push((graph = { resourceAppId: graphSp.appId, resourceAccess: [] }));
      const add = appRoles.filter((r) => !graph.resourceAccess.some((/** @type {any} */ a) => a.id === r.id));
      if (!add.length) return false;
      calls.push(`ensureRequiredAccess ${add.map((r) => r.id).join(',')}`);
      graph.resourceAccess.push(...add.map((r) => ({ id: r.id, type: 'Role' })));
      return true;
    },
    /** @param {string} appId */
    createServicePrincipal: async (appId) => {
      calls.push(`createServicePrincipal ${appId}`);
      const sp = { id: `sp-${appId}`, appId };
      servicePrincipals.push(sp);
      return sp;
    },
    /** @param {string} spId */
    appRoleAssignments: async (spId) => roleAssignments.filter((a) => a.principalId === spId),
    /** @param {string} resourceId @param {string} principalId @param {string} appRoleId */
    grantAppRole: async (resourceId, principalId, appRoleId) => {
      calls.push(`grantAppRole ${appRoleId}`);
      fail('grantAppRole');
      roleAssignments.push({ principalId, resourceId, appRoleId });
    },
    /** @param {string} _id @param {Date} end @param {string} [displayName] */
    addPassword: async (_id, end, displayName = 'AI in One installer') => {
      calls.push(`addPassword ${displayName}`);
      fail('addPassword');
      const keyId = `key-${++n}`;
      passwords.push({ keyId, displayName });
      return { keyId, secretText: `secret-${n}`, endDateTime: end.toISOString() };
    },
    /** @param {string} _id */
    listPasswords: async (_id) => passwords.map((p) => ({ ...p })),
    /** @param {string} _id @param {string} keyId */
    removePassword: async (_id, keyId) => {
      calls.push(`removePassword ${keyId}`);
      const at = passwords.findIndex((p) => p.keyId === keyId);
      if (at >= 0) passwords.splice(at, 1);
    },
    /** @param {string} id */
    deleteApplication: async (id) => {
      calls.push(`deleteApplication ${id}`);
      fail('deleteApplication');
      const at = applications.findIndex((a) => a.id === id);
      if (at >= 0) applications.splice(at, 1);
    },
  };
  return { api, calls, applications, servicePrincipals, roleAssignments, passwords, directoryRoles, reportSettings, failures };
}

/** Power BI: the semantic model's data sources, users and refreshes. `states` scripts what each poll of a refresh returns. */
export function fakePowerBi() {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const states = [];
  /** @type {any[]} */
  const history = [];
  /** @type {any[]} What each executeQueries call returns, in order. */
  const answers = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** Who has access to the semantic model, as datasetUsers lists them. @type {any[]} */
  const users = [];
  /** @type {any[]} */
  let datasources = [{ datasourceType: 'Sql', connectionDetails: { server: 'abc.datawarehouse.fabric.microsoft.com', database: DEFAULT_LAKEHOUSE_NAME } }];
  let n = 0;
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const api = {
    datasources: async () => datasources,
    datasetUsers: async () => {
      fail('datasetUsers');
      return structuredClone(users);
    },
    /** @param {string} _ws @param {string} id @param {any} body */
    addDatasetUser: async (_ws, id, body) => {
      calls.push(`addDatasetUser ${id} ${body.identifier} ${body.datasetUserAccessRight}`);
      fail('addDatasetUser');
      users.push(structuredClone(body));
      return null;
    },
    /** @param {string} _ws @param {string} id @param {any} body */
    refresh: async (_ws, id, body) => {
      calls.push(`refresh ${id} ${body.type}`);
      fail('refresh');
      return `request-${++n}`;
    },
    /** @param {string} _ws @param {string} _id @param {string} requestId */
    getRefresh: async (_ws, _id, requestId) => {
      calls.push(`getRefresh ${requestId}`);
      return states.length ? states.shift() : { status: 'Completed', extendedStatus: 'Completed' };
    },
    refreshes: async () => structuredClone(history),
    /** @param {string} _ws @param {string} id @param {string} _query */
    executeQueries: async (_ws, id, _query) => {
      calls.push(`executeQueries ${id}`);
      fail('executeQueries');
      return answers.length ? answers.shift() : { results: [{ tables: [{ rows: [{ '[CalendarDays]': 90 }] }] }] };
    },
  };
  return {
    api,
    calls,
    states,
    history,
    failures,
    answers,
    users,
    /** @param {any[]} d */
    setDatasources: (d) => {
      datasources = d;
    },
  };
}

/**
 * @param {{ ui?: import('../src/ui.js').Ui, fabric?: any, graph?: any, oneLake?: any, arm?: any, keyVault?: any, powerBi?: any, sources?: import('../src/sources.js').Sources, config?: import('../src/config.js').InstallConfig, now?: Date }} [o]
 */
export function fakeCtx(o = {}) {
  const config = o.config ?? emptyConfig();
  config.fabric.workspaceId ??= 'ws-1';
  config.fabric.lakehouseId ??= 'lh-1';
  config.fabric.lakehouseName ??= DEFAULT_LAKEHOUSE_NAME;
  config.app.appId ??= 'app-1';
  config.app.objectId ??= 'obj-1';
  config.app.servicePrincipalId ??= 'sp-1';
  config.keyVault.uri ??= 'https://kv-test.vault.azure.net/';
  let saves = 0;
  /** @type {number[]} */
  const sleeps = [];
  const ctx = /** @type {import('../src/install.js').Ctx} */ (
    /** @type {unknown} */ ({
      ui: o.ui ?? fakeUi().ui,
      config,
      file: join(TEST_RECORD_DIR, DEFAULT_CONFIG_FILE),
      save: () => {
        saves++;
      },
      api: {
        fabric: o.fabric,
        graph: o.graph,
        oneLake: o.oneLake,
        arm: o.arm,
        keyVault: o.keyVault,
        powerBi: o.powerBi,
      },
      user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
      sources: o.sources ?? realSources(),
      sleep: async (/** @type {number} */ ms) => {
        sleeps.push(ms);
      },
      now: () => o.now ?? new Date('2026-06-01T12:00:00Z'),
    })
  );
  return { ctx, config, sleeps, saves: () => saves };
}
