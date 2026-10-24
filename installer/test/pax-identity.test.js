// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { adminConsentUrl, apiPermissionsUrl } from '../src/clients/graph.js';
import { emptyConfig, emptyPax } from '../src/config.js';
import {
  AGENT365_PERMISSIONS,
  daysLeft,
  ensureCredential,
  ensurePaxApp,
  OWN_APP,
  PAX_APP_NOTES,
  PAX_PERMISSIONS,
  paxGraphRoles,
  paxPermissions,
  removePaxCredentials,
  RENEW_DAYS,
  retireCredentials,
} from '../src/pax/identity.js';
import { CERT_MONTHS, CERT_SUBJECT, FILES, PAX_APP_NAME, secretPath, SP_FOLDER, wrapperPath } from '../src/pax/names.js';
import { psQuote } from '../src/pax/ps.js';
import { loadRelease } from '../src/pax/release.js';
import {
  CHECK_EVERY_MS,
  CHECK_WAIT_MS,
  describeCheck,
  ensureSiteAccess,
  fileUrl,
  folderLabel,
  grantCommands,
  GRAPH_CLI_APP_ID,
  mayBeLate,
  parseSiteUrl,
  revokeCommands,
  revokeSiteGrant,
  sameLibrary,
  SITE_ADMIN_SCOPE,
  siteAddress,
  siteAdminApi,
  sizeOf,
} from '../src/pax/site.js';
import { addDays, addMonths, ensureConsent } from '../src/steps/identity.js';
import { fakeCtx, fakeUi, httpError } from './fakes.js';

/** @typedef {import('../src/pax/ps.js').PwshRun} PwshRun */
/** @typedef {import('../src/pax/ps.js').PwshResult} PwshResult */
/** @typedef {import('../src/pax/scripts.js').AccessCheck} AccessCheck */
/** @typedef {import('../src/config.js').PaxConfig} PaxConfig */
/** @typedef {import('../src/config.js').PaxSite} PaxSite */
/** @typedef {import('../src/install.js').Ctx} Ctx */

const NOW = new Date('2026-06-01T12:00:00Z');
const TENANT = '00000000-0000-0000-0000-000000000001';
const APP_ID = '00000000-0000-0000-0000-0000000000a1';
const OTHER_APP_ID = '00000000-0000-0000-0000-0000000000f1';
/** Microsoft Graph's own app ID, as the app's requiredResourceAccess names it. */
const GRAPH_RESOURCE = '00000003-0000-0000-c000-000000000000';
const HOST = 'contoso.sharepoint.com';
const SITE_URL = `https://${HOST}/sites/AIinOne`;
const SITE_ID = `${HOST},00000000-0000-0000-0000-000000000011,00000000-0000-0000-0000-000000000012`;
/** @type {PaxSite} */
const SITE_RECORD = { url: SITE_URL, host: HOST, path: '/sites/AIinOne', library: 'Shared Documents', folder: SP_FOLDER };
const RELEASE = loadRelease();
const GOOD_UNTIL = '2027-01-01T00:00:00.000Z';
/** Graph's app roles in the fake tenant: PAX's, Agent 365's, and the broad ones PAX must never get. */
const GRAPH_ROLES = [
  ...PAX_PERMISSIONS,
  ...AGENT365_PERMISSIONS,
  'Sites.ReadWrite.All',
  'Sites.FullControl.All',
  'Sites.Read.All',
  'Files.ReadWrite.All',
].map((value, i) => ({ id: `00000000-0000-0000-0001-${String(i + 1).padStart(12, '0')}`, value }));
const NO_CERT = { certificateThumbprint: undefined, certificateKeyId: undefined, certificateExpires: undefined };
/** @type {AccessCheck} */
const PASSING = {
  ok: true,
  siteId: SITE_ID,
  siteName: 'AI in One',
  siteWebUrl: SITE_URL,
  driveId: 'drive-1',
  driveName: 'Documents',
  driveWebUrl: `${SITE_URL}/Shared%20Documents`,
  folder: SP_FOLDER,
  files: [],
};
/** @type {AccessCheck} */
const LATE = { ok: false, step: 'Signing in as the app', error: 'AADSTS700016: Application not found in the directory.' };

/** @param {string} value */
function roleId(value) {
  const role = GRAPH_ROLES.find((r) => r.value === value);
  if (!role) throw new Error(`The fake tenant has no role ${value}`);
  return role.id;
}

/** A certificate thumbprint. @param {number} n */
const thumb = (n) => n.toString(16).toUpperCase().padStart(40, '0');

/** What the user saw, without colours. @param {{ text: () => string }} u */
const plain = (u) => u.text().replace(/\x1b\[[0-9;]*m/g, '');

/** @param {string} text @param {string} part */
const has = (text, part) => assert.ok(text.includes(part), `expected ${JSON.stringify(part)} in:\n${text}`);

/**
 * A temp folder that stands in for %LOCALAPPDATA%, removed after the test.
 * @param {import('node:test').TestContext} t
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-pax-id-'));
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
 * Microsoft Graph in memory: app registrations, service principals, their keys and the admin
 * consent. `failures[method]` makes that method throw, once per error, before it does anything.
 * @param {{ roles?: { id: string, value: string }[] }} [o]
 */
function paxGraph(o = {}) {
  /** @type {{ method: string, args: any[] }[]} */
  const calls = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** @type {Map<string, any>} */
  const apps = new Map();
  /** @type {Map<string, any>} */
  const sps = new Map();
  /** @type {{ principalId: string, resourceId: string, appRoleId: string }[]} */
  const assignments = [];
  /** @type {any[]} */
  const made = [];
  const graphSp = { id: 'graph-sp', appId: GRAPH_RESOURCE, appRoles: o.roles ?? GRAPH_ROLES };
  const count = { app: 0, sp: 0, key: 0, pw: 0 };
  /** @param {string} method @param {any[]} args */
  const call = (method, args) => {
    calls.push({ method, args });
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  /** @param {string} objectId */
  const byObject = (objectId) => {
    for (const app of apps.values()) if (app.id === objectId) return app;
    throw httpError(404, `No application ${objectId}`);
  };
  const api = {
    async graphServicePrincipal() {
      call('graphServicePrincipal', []);
      return graphSp;
    },
    async findApplication(appId) {
      call('findApplication', [appId]);
      return apps.get(appId) ?? null;
    },
    async createApplication(displayName, roles, notes) {
      call('createApplication', [displayName, roles, notes]);
      count.app++;
      const app = {
        id: `obj-new-${count.app}`,
        appId: `00000000-0000-0000-0000-00000000b00${count.app}`,
        displayName,
        notes,
        requiredResourceAccess: [{ resourceAppId: GRAPH_RESOURCE, resourceAccess: roles.map((r) => ({ id: r.id, type: 'Role' })) }],
        keyCredentials: [],
        passwordCredentials: [],
      };
      apps.set(app.appId, app);
      return app;
    },
    async ensureRequiredAccess(application, roles) {
      call('ensureRequiredAccess', [application, roles]);
      let entry = application.requiredResourceAccess.find((r) => r.resourceAppId === GRAPH_RESOURCE);
      if (!entry) {
        entry = { resourceAppId: GRAPH_RESOURCE, resourceAccess: [] };
        application.requiredResourceAccess.push(entry);
      }
      const missing = roles.filter((r) => !entry.resourceAccess.some((a) => a.id === r.id));
      if (!missing.length) return false;
      entry.resourceAccess.push(...missing.map((r) => ({ id: r.id, type: 'Role' })));
      return true;
    },
    async findServicePrincipal(appId) {
      call('findServicePrincipal', [appId]);
      return sps.get(appId) ?? null;
    },
    async createServicePrincipal(appId) {
      call('createServicePrincipal', [appId]);
      const sp = { id: `sp-new-${++count.sp}`, appId };
      sps.set(appId, sp);
      return sp;
    },
    async keyCredentials(objectId) {
      call('keyCredentials', [objectId]);
      return byObject(objectId).keyCredentials.map((k) => ({ ...k }));
    },
    async addCertificate(objectId, cert) {
      call('addCertificate', [objectId, cert]);
      const keyId = `cert-key-${++count.key}`;
      byObject(objectId).keyCredentials.push({ keyId, displayName: cert.displayName, endDateTime: cert.endDateTime });
      return keyId;
    },
    async removeCertificates(objectId, keyIds) {
      call('removeCertificates', [objectId, keyIds]);
      const app = byObject(objectId);
      const before = app.keyCredentials.length;
      app.keyCredentials = app.keyCredentials.filter((k) => !keyIds.includes(k.keyId));
      return before - app.keyCredentials.length;
    },
    async addPassword(objectId, end, displayName) {
      call('addPassword', [objectId, end, displayName]);
      const n = ++count.pw;
      const p = { keyId: `pw-${n}`, secretText: `secret-value-${n}`, endDateTime: end.toISOString(), displayName };
      made.push(p);
      byObject(objectId).passwordCredentials.push({ keyId: p.keyId, endDateTime: p.endDateTime, displayName });
      return p;
    },
    async listPasswords(objectId) {
      call('listPasswords', [objectId]);
      return byObject(objectId).passwordCredentials.map((p) => ({ ...p }));
    },
    async removePassword(objectId, keyId) {
      call('removePassword', [objectId, keyId]);
      const app = byObject(objectId);
      app.passwordCredentials = app.passwordCredentials.filter((p) => p.keyId !== keyId);
    },
    async appRoleAssignments(principalId) {
      call('appRoleAssignments', [principalId]);
      return assignments.filter((a) => a.principalId === principalId).map((a) => ({ ...a }));
    },
    async grantAppRole(resourceId, principalId, appRoleId) {
      call('grantAppRole', [resourceId, principalId, appRoleId]);
      assignments.push({ principalId, resourceId, appRoleId });
    },
  };
  return {
    api: /** @type {any} */ (api),
    calls,
    failures,
    apps,
    sps,
    assignments,
    made,
    graphSp,
    names: () => calls.map((c) => c.method),
    /** @param {string} method */
    args: (method) => calls.filter((c) => c.method === method).map((c) => c.args),
    /** The PAX app registration, as the install record names it. @param {Record<string, any>} [over] */
    addApp: (over = {}) => {
      const app = { id: 'obj-pax', appId: APP_ID, displayName: PAX_APP_NAME, requiredResourceAccess: [], keyCredentials: [], passwordCredentials: [], ...over };
      apps.set(app.appId, app);
      return app;
    },
    /** @param {string} appId @param {string} id */
    addSp: (appId, id) => {
      const sp = { id, appId };
      sps.set(appId, sp);
      return sp;
    },
  };
}

/** Which of the scripts the code under test ran. @param {PwshRun} run @param {NodeJS.ProcessEnv} env */
function kind(run, env) {
  if (run.file === wrapperPath(env) && run.args?.[0] === '-CheckAccess') return 'check';
  const s = run.script ?? '';
  if (s.includes('New-SelfSignedCertificate')) return 'make';
  if (s.includes('-DeleteKey')) return 'remove';
  if (s.includes('exists = $true')) return 'inspect';
  if (s.includes('AIO_SECRET')) return 'protect';
  return 'other';
}

/**
 * PowerShell in memory: nothing runs. It tells the scripts apart by what they do, keeps a
 * certificate store, and answers the task script's access check from `checks` (a result, or a
 * function of the script's text), then with `state.fallback`.
 * @param {NodeJS.ProcessEnv} env
 */
function fakePwsh(env) {
  /** @type {PwshRun[]} */
  const runs = [];
  /** @type {string[]} */
  const unexpected = [];
  /** @type {Map<string, { notAfter: string, hasPrivateKey: boolean }>} */
  const store = new Map();
  /** @type {{ hasPrivateKey: boolean, fail?: string }} */
  const make = { hasPrivateKey: true };
  /** @type {{ inspect?: string, remove?: string, protect?: string }} */
  const failures = {};
  /** @type {(AccessCheck | ((wrapper: string) => AccessCheck))[]} */
  const checks = [];
  const state = { fallback: PASSING, now: () => NOW };
  let next = 0x100;
  /** @param {string} stderr @returns {PwshResult} */
  const fail = (stderr) => ({ code: 1, stdout: '', stderr });
  /** @param {any} result @returns {PwshResult} */
  const answer = (result) => ({ code: 0, stdout: '', stderr: '', result });
  /** @type {import('../src/pax/ps.js').RunPwsh} */
  const runPwsh = async (run) => {
    runs.push(run);
    const script = run.script ?? '';
    const tp = /Cert:\\CurrentUser\\My\\([0-9A-F]{40})/.exec(script)?.[1];
    switch (kind(run, env)) {
      case 'check': {
        const c = checks.length ? checks.shift() : state.fallback;
        return answer(typeof c === 'function' ? c(readFileSync(wrapperPath(env), 'utf8')) : c);
      }
      case 'make': {
        if (make.fail) return fail(make.fail);
        const thumbprint = thumb(next++);
        const from = new Date(state.now().getTime() - 10 * 60_000);
        const notAfter = addDays(addMonths(from, CERT_MONTHS), -1).toISOString();
        store.set(thumbprint, { notAfter, hasPrivateKey: make.hasPrivateKey });
        return answer({ thumbprint, notBefore: from.toISOString(), notAfter, hasPrivateKey: make.hasPrivateKey, der: Buffer.from(`cert ${thumbprint}`).toString('base64') });
      }
      case 'inspect': {
        if (failures.inspect) return fail(failures.inspect);
        const cert = tp ? store.get(tp) : undefined;
        return answer(cert ? { exists: true, thumbprint: tp, ...cert } : { exists: false });
      }
      case 'remove': {
        if (failures.remove) return fail(failures.remove);
        return answer({ removed: !!tp && store.delete(tp) });
      }
      case 'protect': {
        if (failures.protect) return fail(failures.protect);
        if (!run.env?.AIO_SECRET || !script.includes(`$file = ${psQuote(secretPath(env))}`)) {
          unexpected.push(script);
          return fail('Not the protect script this test expects');
        }
        mkdirSync(dirname(secretPath(env)), { recursive: true });
        writeFileSync(secretPath(env), 'protected');
        return answer({ ok: true });
      }
      default:
        unexpected.push(script || run.command || String(run.file));
        return fail('Not expected in this test');
    }
  };
  return {
    runPwsh,
    runs,
    unexpected,
    store,
    make,
    failures,
    checks,
    state,
    kinds: () => runs.map((r) => kind(r, env)),
    scripts: () => runs.map((r) => r.script ?? ''),
  };
}

/** SharePoint in memory, as siteAdminApi gives it, with one site and its two libraries. */
function fakeSites() {
  /** @type {{ method: string, args: any[] }[]} */
  const calls = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** @type {Record<string, any>} */
  const sitesByPath = { [`${HOST}/sites/AIinOne`]: { id: SITE_ID, displayName: 'AI in One', name: 'AIinOne', webUrl: SITE_URL } };
  /** @type {Record<string, any[]>} */
  const drives = {
    [SITE_ID]: [
      { id: 'drive-1', name: 'Documents', webUrl: `${SITE_URL}/Shared%20Documents`, driveType: 'documentLibrary' },
      { id: 'drive-2', name: 'Reports', webUrl: `${SITE_URL}/Reports`, driveType: 'documentLibrary' },
    ],
  };
  /** @type {Record<string, { id: string, roles: string[], appId: string }[]>} */
  const perms = { [SITE_ID]: [] };
  let n = 0;
  /** @param {string} method @param {any[]} args */
  const call = (method, args) => {
    calls.push({ method, args });
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  /** @param {string} siteId */
  const listOf = (siteId) => (perms[siteId] ??= []);
  const api = {
    async siteByPath(host, path) {
      call('siteByPath', [host, path]);
      const site = sitesByPath[`${host}${path}`];
      if (!site) throw httpError(404, 'Requested site could not be found');
      return { ...site };
    },
    async drives(siteId) {
      call('drives', [siteId]);
      return (drives[siteId] ?? []).map((d) => ({ ...d }));
    },
    async permissions(siteId) {
      call('permissions', [siteId]);
      return listOf(siteId).map((p) => ({ id: p.id, grantedToIdentitiesV2: [{ application: { id: p.appId, displayName: 'An app' } }] }));
    },
    async permission(siteId, id) {
      call('permission', [siteId, id]);
      const p = listOf(siteId).find((x) => x.id === id);
      if (!p) throw httpError(404, 'Item not found');
      return { id: p.id, roles: [...p.roles], grantedToIdentitiesV2: [{ application: { id: p.appId, displayName: 'An app' } }] };
    },
    async grant(siteId, app, roles) {
      call('grant', [siteId, app, roles]);
      const p = { id: `perm-${++n}`, roles: [...roles], appId: app.appId };
      listOf(siteId).push(p);
      return { id: p.id, roles: [...p.roles] };
    },
    async updateGrant(siteId, id, roles) {
      call('updateGrant', [siteId, id, roles]);
      const p = listOf(siteId).find((x) => x.id === id);
      if (!p) throw httpError(404, 'Item not found');
      p.roles = [...roles];
      return { id, roles };
    },
    async revoke(siteId, id) {
      call('revoke', [siteId, id]);
      const list = listOf(siteId);
      const i = list.findIndex((x) => x.id === id);
      if (i === -1) throw httpError(404, 'Item not found');
      list.splice(i, 1);
    },
  };
  return {
    api: /** @type {import('../src/clients/graph.js').SitesApi} */ (/** @type {unknown} */ (api)),
    calls,
    failures,
    sitesByPath,
    drives,
    perms,
    names: () => calls.map((c) => c.method),
    /** A permission on the site for an app. @param {string} appId @param {string[]} roles @param {string} [id] */
    addPerm: (appId, roles, id = `perm-${++n}`) => {
      const p = { id, roles, appId };
      listOf(SITE_ID).push(p);
      return p;
    },
  };
}

/**
 * An install record on the PAX route, with a certificate and a site, as a finished install has.
 * @param {string} tmp
 * @param {Record<string, any>} [over]  Replaces fields of the pax record; undefined ones go.
 */
function paxConfig(tmp, over = {}) {
  const config = emptyConfig();
  config.target = 'pax';
  config.tenantId = TENANT;
  config.app = { appId: APP_ID, objectId: 'obj-pax', servicePrincipalId: 'sp-pax', displayName: PAX_APP_NAME };
  /** @type {Record<string, any>} */
  const pax = {
    ...emptyPax(),
    version: RELEASE.version,
    script: join(tmp, 'AIInOne', 'pax', RELEASE.version, RELEASE.file),
    sha256: 'a'.repeat(64),
    certificateThumbprint: thumb(1),
    certificateKeyId: 'cert-key-0',
    certificateExpires: GOOD_UNTIL,
    site: { ...SITE_RECORD },
    ...over,
  };
  for (const key of Object.keys(pax)) if (pax[key] === undefined) delete pax[key];
  config.pax = /** @type {PaxConfig} */ (pax);
  return config;
}

/**
 * A ctx on the PAX route with fakes for Graph, SharePoint and PowerShell, a clock that moves on
 * when it sleeps, and %LOCALAPPDATA% in a temp folder.
 * @param {import('node:test').TestContext} t
 * @param {{ ui?: ReturnType<typeof fakeUi>, pax?: Record<string, any>, app?: any, graph?: ReturnType<typeof paxGraph>, sites?: ReturnType<typeof fakeSites> | null, method?: string }} [o]
 *   sites: null for none, so code that needs them would sign in: only with the azure-cli method, which can't.
 */
function paxCtx(t, o = {}) {
  const tmp = tempDir(t);
  const env = /** @type {NodeJS.ProcessEnv} */ ({ LOCALAPPDATA: tmp });
  const ui = o.ui ?? fakeUi();
  const graph = o.graph ?? paxGraph();
  const config = paxConfig(tmp, o.pax);
  const f = fakeCtx({ ui: ui.ui, graph: graph.api, config, now: NOW });
  if (o.app) config.app = o.app;
  const ctx = /** @type {any} */ (f.ctx);
  let clock = NOW.getTime();
  /** @type {number[]} */
  const sleeps = [];
  ctx.now = () => new Date(clock);
  ctx.sleep = async (/** @type {number} */ ms) => {
    sleeps.push(ms);
    clock += ms;
  };
  const pwsh = fakePwsh(env);
  pwsh.state.now = () => ctx.now();
  ctx.env = env;
  ctx.runPwsh = pwsh.runPwsh;
  ctx.method = o.method ?? 'browser';
  const sites = o.sites === null ? undefined : (o.sites ?? fakeSites());
  if (sites) ctx.sites = sites.api;
  else if (ctx.method !== 'azure-cli') throw new Error('Without fake sites, use the azure-cli method, so nothing signs in for real.');
  return {
    ctx: /** @type {Ctx} */ (ctx),
    config,
    tmp,
    env,
    ui,
    graph,
    pwsh,
    sites: /** @type {ReturnType<typeof fakeSites>} */ (sites),
    sleeps,
    saves: f.saves,
  };
}

/** Only the scripts the test expects ran, and none of them touched the execution policy. @param {ReturnType<typeof fakePwsh>} pwsh */
function assertClean(pwsh) {
  assert.deepEqual(pwsh.unexpected, [], 'only the scripts the test expects ran');
  for (const run of pwsh.runs) {
    const text = [run.script, run.command, run.file, ...(run.args ?? [])].filter(Boolean).join('\n');
    assert.doesNotMatch(text, /-ExecutionPolicy|PSExecutionPolicyPreference|\bBypass\b/i);
    assert.ok(!Object.keys(run.env ?? {}).some((k) => /executionpolicy/i.test(k)), 'no policy in its environment');
  }
}

/** @param {string} path */
const writeSecretFile = (path) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'protected');
};

/** The pax record as it is now, loosely typed for reading. @param {{ config: import('../src/config.js').InstallConfig }} p */
const paxOf = (p) => /** @type {PaxConfig & Record<string, any>} */ (p.config.pax);

/** Every PAX permission, consented on Graph for the PAX app's service principal. @param {ReturnType<typeof paxGraph>} graph */
const consentAll = (graph) => {
  for (const v of PAX_PERMISSIONS) graph.assignments.push({ principalId: 'sp-pax', resourceId: 'graph-sp', appRoleId: roleId(v) });
};

test('PAX permissions: exactly the Graph application permissions PAX -Rollup needs app-only, and Sites.Selected', () => {
  assert.deepEqual([...PAX_PERMISSIONS].sort(), ['AuditLogsQuery.Read.All', 'Organization.Read.All', 'Sites.Selected', 'User.Read.All']);
  assert.deepEqual([...AGENT365_PERMISSIONS].sort(), ['Application.Read.All', 'CopilotPackages.Read.All']);
});

test('paxPermissions: adds the Agent 365 permissions only when Agent 365 is chosen', () => {
  assert.deepEqual(paxPermissions(undefined), [...PAX_PERMISSIONS]);
  assert.deepEqual(paxPermissions(/** @type {any} */ ({ ...emptyPax(), agent365: false })), [...PAX_PERMISSIONS]);
  assert.deepEqual(paxPermissions(/** @type {any} */ ({ ...emptyPax(), agent365: true })), [...PAX_PERMISSIONS, ...AGENT365_PERMISSIONS]);
});

test('paxPermissions: files kept in a folder on the PC go to no site, so there is no Sites.Selected', () => {
  const local = PAX_PERMISSIONS.filter((p) => p !== 'Sites.Selected');
  assert.deepEqual(paxPermissions(/** @type {any} */ ({ ...emptyPax(), destination: 'local' })), local);
  assert.deepEqual(paxPermissions(/** @type {any} */ ({ ...emptyPax(), destination: 'local', agent365: true })), [...local, ...AGENT365_PERMISSIONS]);
  assert.deepEqual(paxPermissions(/** @type {any} */ ({ ...emptyPax(), destination: 'sharepoint' })), [...PAX_PERMISSIONS]);
});

test('PAX permissions: Sites.Selected is the only SharePoint or files permission, and nothing asks for a tenant-wide one', () => {
  const all = paxPermissions(/** @type {any} */ ({ ...emptyPax(), agent365: true }));
  assert.deepEqual(all.filter((p) => /^(Sites|Files)\./.test(p)), ['Sites.Selected']);
  assert.equal(new Set(all).size, all.length, 'no permission twice');
  for (const file of ['identity.js', 'site.js']) {
    const text = readFileSync(new URL(`../src/pax/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /(Sites|Files)\.ReadWrite\.All/, file);
  }
});

test('paxGraphRoles: the PAX roles from Graph, looked up once', async (t) => {
  const p = paxCtx(t);
  const first = await paxGraphRoles(p.ctx);
  assert.deepEqual(
    first.roles.map((r) => ({ value: r.value, id: r.id })),
    PAX_PERMISSIONS.map((value) => ({ value, id: roleId(value) })),
  );
  assert.equal(first.sp, p.graph.graphSp);
  assert.equal(await paxGraphRoles(p.ctx), first);
  assert.deepEqual(p.graph.names(), ['graphServicePrincipal']);
  assert.equal(plain(p.ui), '');
});

test('paxGraphRoles: choosing Agent 365 looks the roles up again, with its two permissions', async (t) => {
  const p = paxCtx(t);
  await paxGraphRoles(p.ctx);
  paxOf(p).agent365 = true;
  const { roles } = await paxGraphRoles(p.ctx);
  assert.deepEqual(roles.map((r) => r.value), [...PAX_PERMISSIONS, ...AGENT365_PERMISSIONS]);
  assert.deepEqual(p.graph.names(), ['graphServicePrincipal', 'graphServicePrincipal']);
});

test('paxGraphRoles: a tenant without an Agent 365 permission warns and goes on without it', async (t) => {
  const roles = GRAPH_ROLES.filter((r) => r.value !== 'CopilotPackages.Read.All');
  const p = paxCtx(t, { graph: paxGraph({ roles }), pax: { agent365: true } });
  const got = await paxGraphRoles(p.ctx);
  assert.deepEqual(got.roles.map((r) => r.value), [...PAX_PERMISSIONS, 'Application.Read.All']);
  has(plain(p.ui), '! Microsoft Graph in this tenant has no application permission named CopilotPackages.Read.All yet, so the Agent 365 file may stay empty.\n');

  const off = paxCtx(t, { graph: paxGraph({ roles }) });
  await paxGraphRoles(off.ctx);
  assert.equal(plain(off.ui), '', 'no warning when Agent 365 is off');
});

test('ensurePaxApp: stops before it makes anything when Graph has no Sites.Selected', async (t) => {
  const graph = paxGraph({ roles: GRAPH_ROLES.filter((r) => r.value !== 'Sites.Selected') });
  const p = paxCtx(t, { graph, app: {} });
  const err = await rejection(ensurePaxApp(p.ctx));
  assert.equal(err.message, 'Microsoft Graph in this tenant has no application permission named Sites.Selected.');
  assert.deepEqual(graph.names(), ['graphServicePrincipal']);
  assert.deepEqual(p.config.app, {});
});

test('ensurePaxApp: creates "AI in One (PAX)" with the PAX permissions, and its service principal', async (t) => {
  const p = paxCtx(t, { app: {} });
  await ensurePaxApp(p.ctx);
  assert.deepEqual(p.graph.names(), ['graphServicePrincipal', 'createApplication', 'findServicePrincipal', 'createServicePrincipal']);
  const [[name, roles, notes]] = p.graph.args('createApplication');
  assert.equal(name, 'AI in One (PAX)');
  assert.equal(name, PAX_APP_NAME);
  assert.deepEqual(roles.map((/** @type {any} */ r) => r.value), [...PAX_PERMISSIONS]);
  assert.equal(notes, PAX_APP_NOTES);
  assert.match(notes, /one SharePoint site/);
  assert.deepEqual(p.config.app, {
    appId: '00000000-0000-0000-0000-00000000b001',
    objectId: 'obj-new-1',
    displayName: PAX_APP_NAME,
    existing: false,
    servicePrincipalId: 'sp-new-1',
  });
  const out = plain(p.ui);
  has(out, '✓ Created app registration "AI in One (PAX)" (00000000-0000-0000-0000-00000000b001)\n');
  has(out, '✓ Created its service principal\n');
  assert.deepEqual(p.pwsh.runs, [], 'no PowerShell to make the app');
});

test('ensurePaxApp: with Agent 365 the new app also gets its two permissions, and no broad one', async (t) => {
  const p = paxCtx(t, { app: {}, pax: { agent365: true } });
  await ensurePaxApp(p.ctx);
  const [[, roles]] = p.graph.args('createApplication');
  const values = roles.map((/** @type {any} */ r) => r.value);
  assert.deepEqual(values, [...PAX_PERMISSIONS, ...AGENT365_PERMISSIONS]);
  assert.ok(!values.some((/** @type {string} */ v) => /\.(ReadWrite|FullControl)\.All$|^Sites\.Read\.All$/.test(v)), values.join(', '));
});

test('ensurePaxApp: reuses the app in the install record and adds the permissions it lacks', async (t) => {
  const p = paxCtx(t);
  const app = p.graph.addApp();
  await ensurePaxApp(p.ctx);
  assert.deepEqual(p.graph.names(), ['graphServicePrincipal', 'findApplication', 'ensureRequiredAccess']);
  assert.deepEqual(app.requiredResourceAccess, [
    { resourceAppId: GRAPH_RESOURCE, resourceAccess: PAX_PERMISSIONS.map((v) => ({ id: roleId(v), type: 'Role' })) },
  ]);
  const out = plain(p.ui);
  has(out, '✓ Added the permissions PAX needs to its API permissions\n');
  has(out, `✓ Using app registration "AI in One (PAX)" (${APP_ID})\n`);
  assert.equal(p.config.app.objectId, 'obj-pax');
  assert.equal(p.config.app.servicePrincipalId, 'sp-pax');
});

test('ensurePaxApp: an app with every permission already is used as it is', async (t) => {
  const p = paxCtx(t);
  p.graph.addApp({
    requiredResourceAccess: [{ resourceAppId: GRAPH_RESOURCE, resourceAccess: PAX_PERMISSIONS.map((v) => ({ id: roleId(v), type: 'Role' })) }],
  });
  await ensurePaxApp(p.ctx);
  const out = plain(p.ui);
  assert.ok(!out.includes('Added the permissions'), out);
  has(out, `✓ Using app registration "AI in One (PAX)" (${APP_ID})\n`);
});

test('ensurePaxApp: adopts an app registration the user owns already, with its own name and service principal', async (t) => {
  const p = paxCtx(t, { app: { appId: APP_ID, existing: true } });
  p.graph.addApp({ id: 'obj-own', displayName: 'Contoso PAX reader' });
  p.graph.addSp(APP_ID, 'sp-own');
  await ensurePaxApp(p.ctx);
  assert.deepEqual(p.graph.names(), ['graphServicePrincipal', 'findApplication', 'ensureRequiredAccess', 'findServicePrincipal']);
  assert.deepEqual(p.config.app, { appId: APP_ID, existing: true, objectId: 'obj-own', displayName: 'Contoso PAX reader', servicePrincipalId: 'sp-own' });
  const out = plain(p.ui);
  has(out, `✓ Using app registration "Contoso PAX reader" (${APP_ID})\n`);
  assert.ok(!out.includes('Created'), out);
});

test('ensurePaxApp: a recorded app that is gone is an error, worded for who made it', async (t) => {
  const own = paxCtx(t, { app: { appId: APP_ID, existing: true } });
  assert.equal((await rejection(ensurePaxApp(own.ctx))).message, `No app registration with ID ${APP_ID} in this tenant, or you aren't one of its owners.`);
  const made = paxCtx(t);
  assert.equal(
    (await rejection(ensurePaxApp(made.ctx))).message,
    `The app registration ${APP_ID} in the install record no longer exists. Delete the "app" section of the install record to create a new one.`,
  );
  assert.deepEqual(made.graph.names(), ['graphServicePrincipal', 'findApplication']);
});

test("ensurePaxApp: when the user can't edit the API permissions it names the ones an admin must add, and goes on", async (t) => {
  const p = paxCtx(t);
  p.graph.addApp();
  p.graph.failures.ensureRequiredAccess = [httpError(403, 'Insufficient privileges to complete the operation.')];
  await ensurePaxApp(p.ctx);
  const out = plain(p.ui);
  has(out, `! You can't edit AI in One (PAX)'s API permissions. An admin must add these Graph application permissions: ${PAX_PERMISSIONS.join(', ')}.\n`);
  has(out, `✓ Using app registration "AI in One (PAX)" (${APP_ID})\n`);

  const q = paxCtx(t);
  q.graph.addApp();
  q.graph.failures.ensureRequiredAccess = [httpError(500, 'Server error')];
  assert.equal((await rejection(ensurePaxApp(q.ctx))).message, 'Server error');
});

test("ensurePaxApp: a user who can't create app registrations is told what to ask an admin for", async (t) => {
  const p = paxCtx(t, { app: {} });
  p.graph.failures.createApplication = [httpError(403, 'Insufficient privileges to complete the operation.')];
  const err = await rejection(ensurePaxApp(p.ctx));
  assert.equal(
    err.message,
    `You can't create app registrations in this tenant. Ask an admin to create "AI in One (PAX)" with the Graph application permissions ${PAX_PERMISSIONS.join(', ')}, ` +
      `and to make you one of its owners. Then run the installer again and choose "${OWN_APP}".`,
  );
  assert.equal(OWN_APP, 'Use an app registration I own already');
  assert.deepEqual(p.config.app, {});

  const q = paxCtx(t, { app: {} });
  q.graph.failures.createApplication = [httpError(500, 'Server error')];
  assert.equal((await rejection(ensurePaxApp(q.ctx))).message, 'Server error');
});

test('ensureConsent: an admin grants the missing PAX permissions, on Graph only', async (t) => {
  const p = paxCtx(t);
  p.graph.assignments.push(
    { principalId: 'sp-pax', resourceId: 'graph-sp', appRoleId: roleId('User.Read.All') },
    { principalId: 'sp-pax', resourceId: 'other-sp', appRoleId: roleId('AuditLogsQuery.Read.All') },
  );
  assert.equal(await ensureConsent(p.ctx, { canConsent: true }), true);
  const todo = PAX_PERMISSIONS.filter((v) => v !== 'User.Read.All');
  assert.deepEqual(p.graph.args('grantAppRole'), todo.map((v) => ['graph-sp', 'sp-pax', roleId(v)]));
  has(plain(p.ui), `✓ Granted admin consent: ${todo.join(', ')}\n`);
});

test('ensureConsent: with --yes and no admin it hands over the consent links and carries on', async (t) => {
  const u = fakeUi({ yes: true });
  const p = paxCtx(t, { ui: u });
  assert.equal(await ensureConsent(p.ctx, { canConsent: false }), false);
  const out = plain(u);
  has(out, `! A Global Administrator or Privileged Role Administrator needs to approve: ${PAX_PERMISSIONS.join(', ')}\n`);
  has(out, 'Send them this page and ask them to select "Grant admin consent":');
  has(out, apiPermissionsUrl(APP_ID));
  has(out, `Or the direct consent link: ${adminConsentUrl('tenant-1', APP_ID)}`);
  has(out, '! Carrying on without consent. Data loads will fail until it is granted.\n');
  assert.deepEqual(u.asked, []);
  assert.deepEqual(p.graph.args('grantAppRole'), []);
});

test('ensureConsent: says so when every permission is consented already', async (t) => {
  const p = paxCtx(t);
  consentAll(p.graph);
  assert.equal(await ensureConsent(p.ctx, { canConsent: false }), true);
  has(plain(p.ui), `✓ Admin consent is in place (${PAX_PERMISSIONS.join(', ')})\n`);
  assert.deepEqual(p.graph.args('grantAppRole'), []);
});

test('ensureConsent: "Check again" sees the consent once an admin has given it', async (t) => {
  const u = fakeUi();
  const p = paxCtx(t, { ui: u });
  const select = /** @type {any} */ (u.ui.select.bind(u.ui));
  u.ui.select = /** @type {any} */ (
    async (/** @type {any[]} */ ...a) => {
      consentAll(p.graph);
      return select(...a);
    }
  );
  assert.equal(await ensureConsent(p.ctx, { canConsent: false }), true);
  assert.deepEqual(u.asked, ['Once they have approved it:']);
  assert.ok(plain(u).endsWith('✓ Admin consent is in place\n'), plain(u));
});

test('ensureConsent: "Carry on without it" stops waiting and returns false', async (t) => {
  const u = fakeUi({ answers: ['check', 'skip'] });
  const p = paxCtx(t, { ui: u });
  assert.equal(await ensureConsent(p.ctx, { canConsent: false }), false);
  assert.deepEqual(u.asked, ['Once they have approved it:', 'Once they have approved it:']);
  has(plain(u), `! Still waiting for: ${PAX_PERMISSIONS.join(', ')}\n`);
});

test('daysLeft: days from now, in fractions, and NaN when it is not a date', () => {
  assert.equal(daysLeft('2026-07-01T12:00:00Z', NOW), 30);
  assert.equal(daysLeft('2026-05-31T00:00:00Z', NOW), -1.5);
  assert.equal(daysLeft('2026-06-02T00:00:00Z', NOW), 0.5);
  assert.ok(Number.isNaN(daysLeft(undefined, NOW)));
  assert.ok(Number.isNaN(daysLeft('soon', NOW)));
  assert.equal(RENEW_DAYS, 30);
});

test('ensureCredential: makes a certificate in the user store and adds only its public key to the app', async (t) => {
  const p = paxCtx(t, { pax: NO_CERT });
  const app = p.graph.addApp();
  assert.equal(await ensureCredential(p.ctx), true);
  assert.deepEqual(p.pwsh.kinds(), ['make']);
  const [script] = p.pwsh.scripts();
  has(script, `-Subject ${psQuote(CERT_SUBJECT)}`);
  has(script, "-CertStoreLocation 'Cert:\\CurrentUser\\My'");
  has(script, '-KeyExportPolicy NonExportable');
  has(script, `.AddMonths(${CERT_MONTHS})`);
  assert.doesNotMatch(script, /Export-PfxCertificate/);
  const tp = thumb(0x100);
  assert.deepEqual(p.graph.args('addCertificate'), [
    [
      'obj-pax',
      {
        der: Buffer.from(`cert ${tp}`).toString('base64'),
        displayName: PAX_APP_NAME,
        startDateTime: '2026-06-01T11:50:00.000Z',
        endDateTime: '2027-05-31T11:50:00.000Z',
      },
    ],
  ]);
  assert.deepEqual(app.keyCredentials.map((/** @type {any} */ k) => k.keyId), ['cert-key-1']);
  const pax = paxOf(p);
  assert.equal(pax.credentialType, 'certificate');
  assert.equal(pax.certificateThumbprint, tp);
  assert.equal(pax.certificateKeyId, 'cert-key-1');
  assert.equal(pax.certificateExpires, '2027-05-31T11:50:00.000Z');
  assert.deepEqual(pax.retiredKeyIds, []);
  assert.equal(pax.retiredThumbprints, undefined);
  assert.equal(pax.secretKeyId, undefined);
  assert.ok(p.pwsh.store.has(tp));
  has(plain(p.ui), '✓ Made a certificate for the task in your certificate store, and added its public key to the app (until 2027-05-31)\n');
  assert.deepEqual(p.graph.names(), ['keyCredentials', 'addCertificate']);
  assert.ok(!existsSync(secretPath(p.env)), 'no client secret');
  assertClean(p.pwsh);
});

test('ensureCredential: a certificate with less than RENEW_DAYS left is replaced, and the old one retired', async (t) => {
  const p = paxCtx(t);
  p.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }] });
  p.pwsh.store.set(thumb(1), { notAfter: '2026-06-30T12:00:00.000Z', hasPrivateKey: true });
  assert.equal(await ensureCredential(p.ctx), true);
  assert.deepEqual(p.pwsh.kinds(), ['inspect', 'make']);
  has(p.pwsh.scripts()[0], `Cert:\\CurrentUser\\My\\${thumb(1)}`);
  const pax = paxOf(p);
  assert.equal(pax.certificateKeyId, 'cert-key-1');
  assert.deepEqual(pax.retiredKeyIds, ['cert-key-0']);
  assert.deepEqual(pax.retiredThumbprints, [thumb(1)]);
  assert.ok(p.pwsh.store.has(thumb(1)), 'the old certificate stays until the task signs in with the new one');
  assertClean(p.pwsh);
});

test('ensureCredential: keeps a certificate that is on the app and in the store, with its key and RENEW_DAYS left', async (t) => {
  const p = paxCtx(t);
  p.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }] });
  p.pwsh.store.set(thumb(1), { notAfter: '2026-07-01T12:00:00.000Z', hasPrivateKey: true });
  const before = structuredClone(p.config.pax);
  assert.equal(await ensureCredential(p.ctx), false);
  assert.deepEqual(p.pwsh.kinds(), ['inspect']);
  assert.deepEqual(p.graph.names(), ['keyCredentials']);
  assert.deepEqual(p.config.pax, before);
  has(plain(p.ui), '✓ The task signs in with its certificate (until 2027-01-01)\n');
});

/** @type {[string, (p: ReturnType<typeof paxCtx>) => void, string[]][]} */
const CERT_NOT_GOOD = [
  [
    'is no longer on the app',
    (p) => {
      p.graph.addApp();
      p.pwsh.store.set(thumb(1), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
    },
    ['make'],
  ],
  [
    'is gone from the certificate store',
    (p) => {
      p.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }] });
    },
    ['inspect', 'make'],
  ],
  [
    'has lost its private key',
    (p) => {
      p.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }] });
      p.pwsh.store.set(thumb(1), { notAfter: GOOD_UNTIL, hasPrivateKey: false });
    },
    ['inspect', 'make'],
  ],
  [
    "can't be looked at",
    (p) => {
      p.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }] });
      p.pwsh.store.set(thumb(1), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
      p.pwsh.failures.inspect = 'Access is denied.';
    },
    ['inspect', 'make'],
  ],
];
for (const [why, arrange, kinds] of CERT_NOT_GOOD) {
  test(`ensureCredential: a certificate that ${why} is replaced`, async (t) => {
    const p = paxCtx(t);
    arrange(p);
    assert.equal(await ensureCredential(p.ctx), true);
    assert.deepEqual(p.pwsh.kinds(), kinds);
    const pax = paxOf(p);
    assert.equal(pax.credentialType, 'certificate');
    assert.equal(pax.certificateKeyId, 'cert-key-1');
    assert.deepEqual(pax.retiredKeyIds, ['cert-key-0']);
    assert.deepEqual(pax.retiredThumbprints, [thumb(1)]);
  });
}

test('ensureCredential: force replaces a good certificate without looking at it', async (t) => {
  const p = paxCtx(t);
  p.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }] });
  p.pwsh.store.set(thumb(1), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
  assert.equal(await ensureCredential(p.ctx, { force: true }), true);
  assert.deepEqual(p.pwsh.kinds(), ['make']);
  assert.deepEqual(p.graph.names(), ['addCertificate']);
  assert.deepEqual(paxOf(p).retiredKeyIds, ['cert-key-0']);
  assert.deepEqual(paxOf(p).retiredThumbprints, [thumb(1)]);
});

test('ensureCredential: a certificate made without its private key is removed, and a client secret takes its place', async (t) => {
  const p = paxCtx(t, { pax: NO_CERT });
  p.graph.addApp();
  p.pwsh.make.hasPrivateKey = false;
  assert.equal(await ensureCredential(p.ctx), true);
  assert.deepEqual(p.pwsh.kinds(), ['make', 'remove', 'protect']);
  has(p.pwsh.scripts()[1], `Cert:\\CurrentUser\\My\\${thumb(0x100)}`);
  assert.equal(p.pwsh.store.size, 0);
  assert.deepEqual(p.graph.args('addCertificate'), []);
  const out = plain(p.ui);
  has(out, "! Couldn't give the task a certificate (Windows made the certificate without its private key.). It gets a client secret instead.\n");
  has(out, '✓ Made a client secret for the task, protected with Windows for you on this PC (until 2027-06-01)\n');
  assert.equal(paxOf(p).credentialType, 'secret');
  assert.equal(paxOf(p).certificateThumbprint, undefined);
  assertClean(p.pwsh);
});

test('ensureCredential: when the certificate script fails, the task gets a client secret', async (t) => {
  const p = paxCtx(t, { pax: NO_CERT });
  p.graph.addApp();
  p.pwsh.make.fail = 'The system cannot find the file specified.';
  assert.equal(await ensureCredential(p.ctx), true);
  assert.deepEqual(p.pwsh.kinds(), ['make', 'protect']);
  has(plain(p.ui), '(Making the certificate failed: The system cannot find the file specified.)');
  assert.equal(paxOf(p).credentialType, 'secret');
});

test('ensureCredential: when Graph refuses the certificate it comes out of the store, and a secret takes its place', async (t) => {
  const p = paxCtx(t, { pax: NO_CERT });
  p.graph.addApp();
  p.graph.failures.addCertificate = [httpError(400, 'Key credential end date is invalid.')];
  assert.equal(await ensureCredential(p.ctx), true);
  assert.deepEqual(p.pwsh.kinds(), ['make', 'remove', 'protect']);
  assert.equal(p.pwsh.store.size, 0);
  has(plain(p.ui), "! Couldn't give the task a certificate (Key credential end date is invalid.). It gets a client secret instead.\n");
  assert.equal(paxOf(p).credentialType, 'secret');
  assert.equal(paxOf(p).secretKeyId, 'pw-1');
});

test("ensureCredential: a user who isn't an owner of the app is told to ask for that, and nothing is left behind", async (t) => {
  const p = paxCtx(t, { pax: NO_CERT });
  p.graph.addApp();
  p.graph.failures.addCertificate = [httpError(403, 'Insufficient privileges to complete the operation.')];
  const before = structuredClone(p.config.pax);
  const err = await rejection(ensureCredential(p.ctx));
  assert.equal(
    err.message,
    `You can't add a certificate or secret to AI in One (PAX) (${APP_ID}). Ask an admin to make you one of its owners, then run the installer again.`,
  );
  assert.deepEqual(p.pwsh.kinds(), ['make', 'remove']);
  assert.equal(p.pwsh.store.size, 0);
  assert.deepEqual(p.config.pax, before);
  assert.deepEqual(p.graph.args('addPassword'), []);
});

test("ensureCredential: on a PC that can't make certificates the task gets a client secret, kept only protected on this PC", async (t) => {
  const p = paxCtx(t);
  p.graph.addApp();
  assert.equal(await ensureCredential(p.ctx, { certificates: false }), true);
  assert.deepEqual(p.pwsh.kinds(), ['protect']);
  assert.deepEqual(p.graph.names(), ['keyCredentials', 'addPassword']);
  const [[objectId, end, name]] = p.graph.args('addPassword');
  assert.equal(objectId, 'obj-pax');
  assert.equal(end.toISOString(), '2027-06-01T12:00:00.000Z');
  assert.equal(name, 'AI in One (PAX) task');
  const secret = p.graph.made[0].secretText;
  const [run] = p.pwsh.runs;
  assert.deepEqual(run.env, { AIO_SECRET: secret });
  assert.ok(!(run.script ?? '').includes(secret), 'the secret goes in through the environment, not the script');
  assert.equal(readFileSync(secretPath(p.env), 'utf8'), 'protected');
  const pax = paxOf(p);
  assert.equal(pax.credentialType, 'secret');
  assert.equal(pax.secretKeyId, 'pw-1');
  assert.equal(pax.secretExpires, '2027-06-01T12:00:00.000Z');
  assert.equal(pax.certificateThumbprint, undefined);
  assert.deepEqual(pax.retiredKeyIds, ['cert-key-0']);
  assert.deepEqual(pax.retiredThumbprints, [thumb(1)]);
  assert.ok(!JSON.stringify(p.config).includes(secret), 'not in the install record');
  const out = plain(p.ui);
  assert.ok(!out.includes(secret), 'not shown');
  has(out, '✓ Made a client secret for the task, protected with Windows for you on this PC (until 2027-06-01)\n');
  assert.ok(!out.includes("Couldn't give the task a certificate"), out);
  assertClean(p.pwsh);
});

test("ensureCredential: a client secret that can't be protected on this PC is taken off the app again", async (t) => {
  const p = paxCtx(t);
  p.graph.addApp();
  p.pwsh.failures.protect = 'Access is denied.';
  const before = structuredClone(p.config.pax);
  const err = await rejection(ensureCredential(p.ctx, { certificates: false }));
  assert.equal(err.message, "Couldn't keep the client secret protected on this PC: Protecting the client secret failed: Access is denied.");
  assert.deepEqual(p.graph.args('removePassword'), [['obj-pax', 'pw-1']]);
  assert.deepEqual(p.config.pax, before);
  assert.ok(!existsSync(secretPath(p.env)));
});

test('ensureCredential: Graph refusing the client secret is an owner problem when it is a 403, and passed on otherwise', async (t) => {
  const p = paxCtx(t);
  p.graph.addApp();
  delete (/** @type {any} */ (p.config.app).displayName);
  p.graph.failures.addPassword = [httpError(403, 'Insufficient privileges to complete the operation.')];
  assert.equal(
    (await rejection(ensureCredential(p.ctx, { certificates: false }))).message,
    `You can't add a certificate or secret to the app registration (${APP_ID}). Ask an admin to make you one of its owners, then run the installer again.`,
  );
  p.graph.failures.addPassword = [httpError(500, 'Server error')];
  assert.equal((await rejection(ensureCredential(p.ctx, { certificates: false }))).message, 'Server error');
  assert.deepEqual(p.pwsh.runs, []);
});

test('ensureCredential: keeps a client secret that is on the app and protected on this PC, with RENEW_DAYS left', async (t) => {
  const p = paxCtx(t, { pax: { ...NO_CERT, credentialType: 'secret', secretKeyId: 'pw-old', secretExpires: '2026-07-01T12:00:00.000Z' } });
  p.graph.addApp({ passwordCredentials: [{ keyId: 'pw-old' }] });
  writeSecretFile(secretPath(p.env));
  assert.equal(await ensureCredential(p.ctx), false);
  assert.deepEqual(p.pwsh.runs, []);
  assert.deepEqual(p.graph.names(), ['listPasswords']);
  has(plain(p.ui), '✓ The task signs in with its client secret, protected for you on this PC (until 2026-07-01)\n');
});

/** @type {[string, Record<string, any>, { keyId: string }[], boolean][]} */
const SECRET_NOT_GOOD = [
  ['is no longer on the app', {}, [], true],
  ['is gone from this PC', {}, [{ keyId: 'pw-old' }], false],
  ['has less than RENEW_DAYS left', { secretExpires: '2026-06-30T12:00:00.000Z' }, [{ keyId: 'pw-old' }], true],
];
for (const [why, over, passwords, file] of SECRET_NOT_GOOD) {
  test(`ensureCredential: a client secret that ${why} gives way to a certificate`, async (t) => {
    const p = paxCtx(t, { pax: { ...NO_CERT, credentialType: 'secret', secretKeyId: 'pw-old', secretExpires: GOOD_UNTIL, ...over } });
    p.graph.addApp({ passwordCredentials: passwords });
    if (file) writeSecretFile(secretPath(p.env));
    assert.equal(await ensureCredential(p.ctx), true);
    assert.deepEqual(p.pwsh.kinds(), ['make']);
    const pax = paxOf(p);
    assert.equal(pax.credentialType, 'certificate');
    assert.equal(pax.certificateKeyId, 'cert-key-1');
    assert.deepEqual(pax.retiredKeyIds, ['pw-old']);
    assert.equal(pax.retiredThumbprints, undefined);
    assert.equal(pax.secretKeyId, undefined);
    assert.equal(pax.secretExpires, undefined);
  });
}

test('ensureCredential: needs an app registration and a PAX setup in the install record', async (t) => {
  const p = paxCtx(t);
  delete (/** @type {any} */ (p.config.app).objectId);
  assert.equal((await rejection(ensureCredential(p.ctx))).message, 'The install record has no app registration yet.');
  const q = paxCtx(t);
  delete (/** @type {any} */ (q.config).pax);
  assert.equal((await rejection(ensureCredential(q.ctx))).message, 'The install record has no PAX setup.');
  assert.deepEqual([...p.graph.calls, ...q.graph.calls], []);
  assert.deepEqual([...p.pwsh.runs, ...q.pwsh.runs], []);
});

test('retireCredentials: takes the replaced keys off the app and the replaced certificate out of the store', async (t) => {
  const p = paxCtx(t, { pax: { retiredKeyIds: ['cert-key-old', 'pw-old'], retiredThumbprints: [thumb(2)] } });
  const app = p.graph.addApp({
    keyCredentials: [{ keyId: 'cert-key-0' }, { keyId: 'cert-key-old' }],
    passwordCredentials: [{ keyId: 'pw-old' }, { keyId: 'pw-other' }],
  });
  p.pwsh.store.set(thumb(1), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
  p.pwsh.store.set(thumb(2), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
  writeSecretFile(secretPath(p.env));
  await retireCredentials(p.ctx);
  assert.deepEqual(p.graph.args('removeCertificates'), [['obj-pax', ['cert-key-old', 'pw-old']]]);
  assert.deepEqual(p.graph.args('removePassword'), [['obj-pax', 'pw-old']]);
  assert.deepEqual(app.keyCredentials, [{ keyId: 'cert-key-0' }]);
  assert.deepEqual(app.passwordCredentials, [{ keyId: 'pw-other' }]);
  assert.deepEqual(p.pwsh.kinds(), ['remove']);
  has(p.pwsh.scripts()[0], `Cert:\\CurrentUser\\My\\${thumb(2)}`);
  assert.deepEqual([...p.pwsh.store.keys()], [thumb(1)], 'the current certificate stays');
  const pax = paxOf(p);
  assert.equal(pax.retiredKeyIds, undefined);
  assert.equal(pax.retiredThumbprints, undefined);
  assert.equal(pax.certificateKeyId, 'cert-key-0');
  assert.ok(!existsSync(secretPath(p.env)), "a certificate task's old secret file goes");
  has(plain(p.ui), '✓ Took the replaced keys off the app\n');
  assertClean(p.pwsh);
});

test('retireCredentials: one key is worded as one, and keys gone already are dropped quietly', async (t) => {
  const p = paxCtx(t, { pax: { retiredKeyIds: ['cert-key-old'] } });
  p.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }, { keyId: 'cert-key-old' }] });
  await retireCredentials(p.ctx);
  has(plain(p.ui), '✓ Took the replaced key off the app\n');

  const q = paxCtx(t, { pax: { retiredKeyIds: ['cert-key-gone'] } });
  q.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }] });
  await retireCredentials(q.ctx);
  assert.equal(plain(q.ui), '');
  assert.equal(paxOf(q).retiredKeyIds, undefined);
});

test("retireCredentials: keeps the key IDs for the next repair when Graph can't take them off", async (t) => {
  const p = paxCtx(t, { pax: { retiredKeyIds: ['cert-key-old'], retiredThumbprints: [thumb(2)] } });
  p.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-old' }] });
  p.graph.failures.removeCertificates = [httpError(503, 'Service unavailable')];
  p.pwsh.store.set(thumb(2), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
  await retireCredentials(p.ctx);
  assert.deepEqual(paxOf(p).retiredKeyIds, ['cert-key-old']);
  has(plain(p.ui), "! Couldn't take the replaced keys off the app yet (Service unavailable). The next repair tries again.\n");
  assert.deepEqual(p.pwsh.kinds(), ['remove']);
  assert.equal(paxOf(p).retiredThumbprints, undefined);
});

test("retireCredentials: a secret task keeps its secret file, and a certificate that won't go is let go", async (t) => {
  const p = paxCtx(t, { pax: { ...NO_CERT, credentialType: 'secret', secretKeyId: 'pw-1', secretExpires: GOOD_UNTIL, retiredThumbprints: [thumb(2)] } });
  writeSecretFile(secretPath(p.env));
  p.pwsh.failures.remove = 'Access is denied.';
  await retireCredentials(p.ctx);
  assert.ok(existsSync(secretPath(p.env)));
  assert.deepEqual(p.pwsh.kinds(), ['remove']);
  assert.equal(paxOf(p).retiredThumbprints, undefined);
  assert.deepEqual(p.graph.calls, []);
  assert.equal(plain(p.ui), '');
});

test('removePaxCredentials: keeping the app takes the key off it, and the certificates and secret off this PC', async (t) => {
  const p = paxCtx(t, { pax: { retiredThumbprints: [thumb(2)] } });
  const app = p.graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }] });
  p.pwsh.store.set(thumb(1), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
  p.pwsh.store.set(thumb(2), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
  writeSecretFile(secretPath(p.env));
  await removePaxCredentials(p.ctx, { keepApp: true });
  assert.deepEqual(p.graph.args('removeCertificates'), [['obj-pax', ['cert-key-0']]]);
  assert.deepEqual(app.keyCredentials, []);
  assert.deepEqual(p.pwsh.kinds(), ['remove', 'remove']);
  assert.equal(p.pwsh.store.size, 0);
  assert.ok(!existsSync(secretPath(p.env)));
  const pax = paxOf(p);
  for (const key of ['certificateThumbprint', 'certificateKeyId', 'certificateExpires', 'retiredKeyIds', 'retiredThumbprints']) {
    assert.equal(pax[key], undefined, key);
  }
  const out = plain(p.ui);
  has(out, '✓ Took the replaced key off the app\n');
  has(out, "✓ Removed the task's certificate and secret from this PC\n");
  assert.match(out, /The app registration AI in One \(PAX\) stays\. To set this up again: .*install --target pax/);
  assertClean(p.pwsh);
});

test('removePaxCredentials: when the app goes too, only this PC is cleaned up', async (t) => {
  const p = paxCtx(t, { pax: { retiredThumbprints: [thumb(2)] } });
  p.pwsh.store.set(thumb(1), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
  p.pwsh.store.set(thumb(2), { notAfter: GOOD_UNTIL, hasPrivateKey: true });
  writeSecretFile(secretPath(p.env));
  await removePaxCredentials(p.ctx, { keepApp: false });
  assert.deepEqual(p.graph.calls, []);
  assert.deepEqual(p.pwsh.kinds(), ['remove', 'remove']);
  assert.equal(p.pwsh.store.size, 0);
  assert.ok(!existsSync(secretPath(p.env)));
  const pax = paxOf(p);
  assert.equal(pax.certificateThumbprint, undefined);
  assert.equal(pax.retiredThumbprints, undefined);
  assert.equal(pax.certificateKeyId, 'cert-key-0');
  const out = plain(p.ui);
  has(out, "✓ Removed the task's certificate and secret from this PC\n");
  assert.ok(!out.includes('stays'), out);
});

test("removePaxCredentials: a certificate that won't come out of the store doesn't stop the uninstall", async (t) => {
  const p = paxCtx(t);
  p.pwsh.failures.remove = 'Access is denied.';
  await removePaxCredentials(p.ctx, { keepApp: false });
  assert.deepEqual(p.pwsh.kinds(), ['remove']);
  has(plain(p.ui), "✓ Removed the task's certificate and secret from this PC\n");
});

test('removePaxCredentials: an app with no object ID in the record is left alone', async (t) => {
  const p = paxCtx(t, { app: { appId: APP_ID } });
  await removePaxCredentials(p.ctx, { keepApp: true });
  assert.deepEqual(p.graph.calls, []);
  assert.deepEqual(p.pwsh.kinds(), ['remove']);
  assert.ok(!plain(p.ui).includes('stays'), plain(p.ui));
});

const SITE = { host: HOST, path: '/sites/AIinOne', url: SITE_URL };
const ROOT = { host: HOST, path: '', url: `https://${HOST}` };
/** Without the keys whose value is undefined. @param {unknown} o */
const defined = (o) => JSON.parse(JSON.stringify(o));

/** @type {[string, Record<string, string>][]} */
const SITE_URLS = [
  ['https://contoso.sharepoint.com', ROOT],
  ['https://contoso.sharepoint.com/', ROOT],
  ['  https://Contoso.SharePoint.com/sites/AIinOne/  ', SITE],
  ['https://contoso.sharepoint.com/sites/AIinOne///', SITE],
  ['https://contoso.sharepoint.com/teams/Finance', { host: HOST, path: '/teams/Finance', url: `https://${HOST}/teams/Finance` }],
  ['https://contoso.sharepoint.com/sites/AIinOne?web=1#top', SITE],
  ['https://contoso.sharepoint.com/sites/AIinOne/SitePages/Home.aspx', SITE],
  ['https://contoso.sharepoint.com/sites/AIinOne/_layouts/15/viewlsts.aspx', SITE],
  ['https://contoso.sharepoint.com/sites/AIinOne/Lists/Tasks/AllItems.aspx', SITE],
  ['https://contoso.sharepoint.com/sites/AIinOne/Shared%20Documents/Forms/AllItems.aspx', { ...SITE, library: 'Shared Documents' }],
  [
    'https://contoso.sharepoint.com/sites/AIinOne/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FAIinOne%2FShared%20Documents%2FAI%20in%20One&viewid=00000000-0000-0000-0000-000000000003',
    { ...SITE, library: 'Shared Documents', folder: 'AI in One' },
  ],
  ['https://contoso.sharepoint.com/sites/AIinOne/Shared%20Documents/AI%20in%20One/2026', { ...SITE, library: 'Shared Documents', folder: 'AI in One/2026' }],
  ['https://contoso.sharepoint.com/Shared%20Documents/Forms/AllItems.aspx', { ...ROOT, library: 'Shared Documents' }],
  ['https://contoso.sharepoint.com/sites/AIinOne/Reports/', { ...SITE, library: 'Reports' }],
  ['https://contoso.sharepoint.com/:f:/r/sites/AIinOne/Shared%20Documents/AI%20in%20One?csf=1&web=1&e=Abc123', { ...SITE, library: 'Shared Documents', folder: 'AI in One' }],
  ['https://contoso.sharepoint.com/:f:/r/Shared%20Documents/AI%20in%20One?csf=1&web=1&e=Abc123', { ...ROOT, library: 'Shared Documents', folder: 'AI in One' }],
];
for (const [text, want] of SITE_URLS) {
  test(`parseSiteUrl: ${text.trim()}`, () => {
    assert.deepEqual(defined(parseSiteUrl(text)), want);
  });
}

const EXAMPLE = 'https://contoso.sharepoint.com/sites/AIinOne';
/** @type {[string, string][]} */
const NOT_SITES = [
  ['contoso.sharepoint.com/sites/AIinOne', `isn't a web address. Use the site's address, such as ${EXAMPLE}.`],
  ['', `isn't a web address. Use the site's address, such as ${EXAMPLE}.`],
  ['http://contoso.sharepoint.com/sites/AIinOne', `isn't a SharePoint Online site. Use an address such as ${EXAMPLE}.`],
  ['https://contoso.example.com/sites/AIinOne', `isn't a SharePoint Online site. Use an address such as ${EXAMPLE}.`],
  ['https://sharepoint.com.example.com/sites/AIinOne', `isn't a SharePoint Online site. Use an address such as ${EXAMPLE}.`],
  ['https://contoso-my.sharepoint.com/personal/admin_contoso_com', `is a OneDrive. Use a SharePoint site that the report's viewers can read, such as ${EXAMPLE}.`],
  ...['https://contoso.sharepoint.com/:f:/s/AIinOne/EabcToken123?e=Xyz', 'https://contoso.sharepoint.com/:f:/t/Finance/EabcToken123', 'https://contoso.sharepoint.com/:f:/g/EabcToken123'].map(
    (link) => /** @type {[string, string]} */ ([link, `is a sharing link, which doesn't say which folder it's for. Use the folder's address from the browser's address bar, or the site's address, such as ${EXAMPLE}.`]),
  ),
];
for (const [text, why] of NOT_SITES) {
  test(`parseSiteUrl: refuses "${text}"`, () => {
    assert.throws(() => parseSiteUrl(text), { message: `"${text}" ${why}` });
  });
}

test('parseSiteUrl: a "Copy link" sharing link is never taken for the root site', () => {
  const parsed = parseSiteUrl(`https://${HOST}/:f:/r/sites/AIinOne/Shared%20Documents/AI%20in%20One?csf=1&web=1&e=Abc123`);
  assert.equal(parsed.url, SITE_URL, 'the write grant goes to the site the link is in');
  assert.throws(() => parseSiteUrl(`https://${HOST}/:f:/s/AIinOne/EabcToken123`), /is a sharing link/, 'one that names no folder is refused');
});

test('siteAddress: the site from its host and path, else its recorded address', () => {
  assert.equal(siteAddress({ host: HOST, path: '/sites/AIinOne' }), SITE_URL);
  assert.equal(siteAddress({ host: HOST }), `https://${HOST}`);
  assert.equal(siteAddress({ url: `https://${HOST}/teams/Finance` }), `https://${HOST}/teams/Finance`);
  assert.equal(siteAddress({}), '');
});

test('folderLabel: the library and folder, in the site by name once it is known', () => {
  assert.equal(folderLabel({ ...SITE_RECORD }), `Shared Documents/AI in One in ${SITE_URL}`);
  assert.equal(folderLabel({ ...SITE_RECORD, name: 'AI in One', folder: 'Reports/2026' }), 'Shared Documents/Reports/2026 in AI in One');
  assert.equal(folderLabel({ ...SITE_RECORD, folder: '' }), `Shared Documents/${SP_FOLDER} in ${SITE_URL}`);
});

/** @type {[{ name?: string, webUrl?: string }, string, boolean][]} */
const LIBRARIES = [
  [{ name: 'Documents', webUrl: `${SITE_URL}/Shared%20Documents` }, 'Documents', true],
  [{ name: 'Documents', webUrl: `${SITE_URL}/Shared%20Documents` }, ' documents ', true],
  [{ name: 'Documents', webUrl: `${SITE_URL}/Shared%20Documents` }, 'Shared Documents', true],
  [{ name: 'Documents', webUrl: `${SITE_URL}/Shared%20Documents/` }, 'shared documents', true],
  [{ name: 'Documents', webUrl: `${SITE_URL}/Shared%20Documents` }, 'Reports', false],
  [{ name: 'Documents', webUrl: `${SITE_URL}/Shared%20Documents` }, 'Shared%20Documents', false],
  [{}, 'Documents', false],
];
for (const [drive, library, same] of LIBRARIES) {
  test(`sameLibrary: "${library}" ${same ? 'is' : "isn't"} ${JSON.stringify(drive)}`, () => {
    assert.equal(sameLibrary(drive, library), same);
  });
}

test('fileUrl: a stable address for each of the three files, in the chosen folder', () => {
  const site = { ...SITE_RECORD, driveWebUrl: `${SITE_URL}/Shared%20Documents/` };
  const names = Object.values(FILES);
  assert.equal(names.length, 3);
  for (const name of names) {
    assert.equal(fileUrl(site, name), `${SITE_URL}/Shared%20Documents/AI%20in%20One/${name}`);
    assert.equal(fileUrl(site, name), fileUrl({ ...site }, name), 'the same each time');
  }
});

test('fileUrl: encodes each part of the folder, and falls back to the default folder', () => {
  const site = { ...SITE_RECORD, driveWebUrl: `${SITE_URL}/Shared%20Documents` };
  assert.equal(fileUrl({ ...site, folder: 'Q&A #1/2026' }, 'AIO_Users.csv'), `${SITE_URL}/Shared%20Documents/Q%26A%20%231/2026/AIO_Users.csv`);
  assert.equal(fileUrl({ ...site, folder: '' }, 'AIO_Users.csv'), `${SITE_URL}/Shared%20Documents/AI%20in%20One/AIO_Users.csv`);
  assert.equal(fileUrl(site, 'a b#.csv'), `${SITE_URL}/Shared%20Documents/AI%20in%20One/a%20b%23.csv`);
});

test("fileUrl: needs the library's address from a passing check", () => {
  assert.throws(() => fileUrl({ ...SITE_RECORD }, FILES.users), {
    message: "The install record doesn't have the library's address yet. Run install again once the app can write to the folder.",
  });
});

test('grantCommands: an admin gives the app write on that one site, with Microsoft Graph PowerShell', () => {
  assert.deepEqual(grantCommands({ ...SITE_RECORD }, APP_ID), [
    'Connect-MgGraph -Scopes Sites.FullControl.All',
    `$site = Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/sites/${HOST}:/sites/AIinOne'`,
    `Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/sites/$($site.id)/permissions" -ContentType 'application/json' -Body (@{ roles = @('write'); grantedToIdentities = @(@{ application = @{ id = '${APP_ID}'; displayName = 'AI in One (PAX)' } }) } | ConvertTo-Json -Depth 5)`,
  ]);
});

test("grantCommands: the root site has no path, and a path's spaces are encoded", () => {
  assert.equal(grantCommands({ ...SITE_RECORD, path: '' }, APP_ID)[1], `$site = Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/sites/${HOST}'`);
  assert.equal(
    grantCommands({ ...SITE_RECORD, path: '/sites/AI in One' }, APP_ID)[1],
    `$site = Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/sites/${HOST}:/sites/AI%20in%20One'`,
  );
});

test("revokeCommands: an admin deletes the app's permission on the site", () => {
  assert.deepEqual(revokeCommands({ ...SITE_RECORD, id: SITE_ID, grantId: 'perm-1' }), [
    'Connect-MgGraph -Scopes Sites.FullControl.All',
    `Invoke-MgGraphRequest -Method DELETE -Uri 'https://graph.microsoft.com/v1.0/sites/${SITE_ID}/permissions/perm-1'`,
  ]);
});

/** Lists the parse errors and the commands in the PowerShell on stdin, without running it. */
const PARSE = [
  '$t = [Console]::In.ReadToEnd()',
  '$e = $null',
  '$a = [System.Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$e)',
  "foreach ($x in $e) { 'E:' + $x.Extent.StartLineNumber + ': ' + ($x.Message -replace '\\s+', ' ') }",
  "foreach ($c in $a.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)) { 'C:' + $c.GetCommandName() }",
].join('; ');

test('grantCommands and revokeCommands: parse as PowerShell, with quotes in the values kept inside their strings', (t) => {
  const hostile = "x'; Write-Output pwned; '";
  const site = { ...SITE_RECORD, path: "/sites/O'Brien", id: `${HOST},x'y,z`, grantId: hostile };
  const input = `${[...grantCommands(site, hostile), ...revokeCommands(site)].join('\n')}\n`;
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', PARSE], { input, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (/** @type {any} */ (r.error)?.code === 'ENOENT') {
    t.skip('needs PowerShell');
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  assert.deepEqual(lines.filter((l) => l.startsWith('E:')), []);
  assert.deepEqual(
    lines
      .filter((l) => l.startsWith('C:'))
      .map((l) => l.slice(2))
      .sort(),
    ['Connect-MgGraph', 'Connect-MgGraph', 'ConvertTo-Json', 'Invoke-MgGraphRequest', 'Invoke-MgGraphRequest', 'Invoke-MgGraphRequest'],
  );
});

/** @type {[string, any, boolean][]} */
const LATE_OR_NOT = [
  ['the app not signing in yet', LATE, true],
  ['a 401', { ok: false, step: 'Writing a test file', status: 401, error: 'Unauthorized' }, true],
  ['a 403', { ok: false, step: 'Writing a test file', status: 403, error: 'Access denied' }, true],
  ['the site not found yet', { ok: false, step: 'Finding the site', status: 404, error: 'Not found' }, true],
  ['a library that is not there', { ok: false, step: 'Finding the library', status: 404, error: 'Not found' }, false],
  ['a failure with no HTTP status', { ok: false, step: 'Making the folder', error: 'Bad name' }, false],
  ['the check not running', { ok: false, step: 'Running the check', error: 'pwsh was not found' }, false],
  ['a passing check', PASSING, false],
];
for (const [what, check, late] of LATE_OR_NOT) {
  test(`mayBeLate: ${what} ${late ? 'may' : "can't"} be the access still on its way`, () => {
    assert.equal(mayBeLate(check), late);
  });
}

test('describeCheck: the step, the HTTP status and the error', () => {
  assert.equal(describeCheck(LATE), "Signing in as the app didn't work: AADSTS700016: Application not found in the directory.");
  assert.equal(describeCheck({ ok: false, step: 'Making the folder', status: 403, error: 'Access denied' }), "Making the folder didn't work (HTTP 403): Access denied");
  assert.equal(describeCheck({ ok: false }), "The check didn't work: no detail");
});

test('sizeOf: KB below a MB, rounded and at least 1, then MB to one place', () => {
  assert.equal(sizeOf(undefined), '');
  assert.equal(sizeOf(0), '1 KB');
  assert.equal(sizeOf(1536), '2 KB');
  assert.equal(sizeOf(1024 * 1024 - 1), '1024 KB');
  assert.equal(sizeOf(1024 * 1024), '1.0 MB');
  assert.equal(sizeOf(2.4 * 1024 * 1024), '2.4 MB');
});

test('site access constants: the Graph CLI app, the admin scope, and how long the check waits', () => {
  assert.equal(GRAPH_CLI_APP_ID, '14d82eec-204b-4c2f-b7e8-296a70dab67e');
  assert.equal(SITE_ADMIN_SCOPE, 'https://graph.microsoft.com/Sites.FullControl.All');
  assert.equal(CHECK_WAIT_MS, 3 * 60_000);
  assert.equal(CHECK_EVERY_MS, 20_000);
});

test("siteAdminApi: uses the ctx's SharePoint client when it has one", (t) => {
  const p = paxCtx(t);
  assert.equal(siteAdminApi(p.ctx), p.sites.api);
});

test('siteAdminApi: otherwise makes the SharePoint client once, without signing in until it is used', (t) => {
  const p = paxCtx(t, { sites: null, method: 'azure-cli' });
  const api = siteAdminApi(p.ctx);
  assert.deepEqual(Object.keys(api).sort(), ['drives', 'grant', 'permission', 'permissions', 'revoke', 'siteByPath', 'updateGrant']);
  assert.equal(siteAdminApi(p.ctx), api);
  assert.equal(p.ctx.sites, api);
  assert.equal(plain(p.ui), '');
});

/** The arguments of each call to one SharePoint method. @param {ReturnType<typeof fakeSites>} sites @param {string} method */
const callArgs = (sites, method) => sites.calls.filter((c) => c.method === method).map((c) => c.args);

/** How many times a part is in the text. @param {string} text @param {string} part */
const times = (text, part) => text.split(part).length - 1;

/** A line of the settings in the task's script. @param {string} key @param {string} value */
const setting = (key, value) => {
  const v = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${key} = '${v}'\\r?$`, 'm');
};

/** The task's script, as it was last written. @param {{ env: NodeJS.ProcessEnv }} p */
const wrapperText = (p) => readFileSync(wrapperPath(p.env), 'utf8');

/** Records each select's message, choices and default, and answers as the fake UI would. @param {ReturnType<typeof fakeUi>} u */
function recordSelects(u) {
  /** @type {{ message: string, choices: any[], def: any }[]} */
  const seen = [];
  const ui = /** @type {any} */ (u.ui);
  const select = ui.select;
  ui.select = async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) => {
    seen.push({ message, choices, def });
    return select(message, choices, def);
  };
  return seen;
}

/**
 * The hand-off: what to ask a SharePoint admin, and the commands that give the app write on this one site.
 * @param {string} out
 * @param {PaxSite} site
 * @param {string} [label]
 */
function assertHandOff(out, site, label = siteAddress(site)) {
  has(out, `    Ask a SharePoint admin to give "${PAX_APP_NAME}" write access to ${label}, and to no other site. In PowerShell, with the Microsoft Graph PowerShell module:\n`);
  const lines = grantCommands(site, APP_ID);
  assert.equal(lines.length, 3);
  for (const line of lines) has(out, `      ${line}\n`);
}

const WHO = `"${PAX_APP_NAME}" needs write access to ${SITE_URL}. Who gives it?`;
const SORTED = 'Once that is sorted:';
const NOT_CONSENTED = "The app can't sign in until an admin consents to its Graph permissions, so its access to the folder isn't checked yet.";
const WAITING = 'Waiting for the new access to reach SharePoint and Microsoft Entra.';

test('ensureSiteAccess: gives the app write on that one site, waits while the access reaches SharePoint, then records what the check found', async (t) => {
  const graph = paxGraph();
  graph.addApp({ keyCredentials: [{ keyId: 'cert-key-0' }, { keyId: 'cert-key-old' }] });
  const p = paxCtx(t, { graph, pax: { retiredKeyIds: ['cert-key-old'] } });
  const other = p.sites.addPerm(OTHER_APP_ID, ['read']);
  /** @type {AccessCheck} */
  const found = {
    ...PASSING,
    files: [
      { name: FILES.interactions, exists: true, size: 2.4 * 1024 * 1024, lastModified: '2026-05-31T02:10:44Z' },
      { name: FILES.users, exists: false },
    ],
  };
  p.pwsh.checks.push(LATE, LATE, found);

  const r = await ensureSiteAccess(p.ctx, { consented: true });

  assert.deepEqual(r, { ok: true, check: found });
  assert.deepEqual(p.sites.names(), ['siteByPath', 'drives', 'permissions', 'grant']);
  assert.deepEqual(callArgs(p.sites, 'siteByPath'), [[HOST, '/sites/AIinOne']]);
  assert.deepEqual(callArgs(p.sites, 'grant'), [[SITE_ID, { appId: APP_ID, displayName: PAX_APP_NAME }, ['write']]]);
  assert.deepEqual(p.sites.perms[SITE_ID], [other, { id: 'perm-2', roles: ['write'], appId: APP_ID }], "another app's access is left as it was");
  assert.deepEqual(p.pwsh.kinds(), ['check', 'check', 'check']);
  assert.deepEqual(p.sleeps, [CHECK_EVERY_MS, CHECK_EVERY_MS]);
  assert.deepEqual(paxOf(p).site, {
    ...SITE_RECORD,
    id: SITE_ID,
    name: 'AI in One',
    webUrl: SITE_URL,
    driveId: 'drive-1',
    driveWebUrl: `${SITE_URL}/Shared%20Documents`,
    grantId: 'perm-2',
    grantedByInstaller: true,
    checkedAt: '2026-06-01T12:00:40.000Z',
  });
  const w = wrapperText(p);
  assert.match(w, setting('DriveId', 'drive-1'), 'the script is written again with the library ID');
  assert.match(w, setting('SiteHost', HOST));
  assert.match(w, setting('SitePath', '/sites/AIinOne'));
  assert.match(w, setting('Library', 'Shared Documents'));
  assert.match(w, setting('Folder', SP_FOLDER));
  const out = plain(p.ui);
  assert.equal(times(out, WAITING), 1, 'says once that it waits');
  has(out, '  ✓ Gave the app write access to AI in One, and to no other site\n');
  has(out, '  ✓ The app can write to Shared Documents/AI in One in AI in One\n');
  has(out, `    ${FILES.interactions} is there already (2.4 MB, changed 2026-05-31 02:10)\n`);
  assert.ok(!out.includes(`${FILES.users} is there`), 'only the files that are there');
  has(out, '  ✓ Took the replaced key off the app\n');
  assert.deepEqual(
    graph.apps.get(APP_ID).keyCredentials.map((/** @type {any} */ k) => k.keyId),
    ['cert-key-0'],
    'the replaced key goes once the script signs in with the new one',
  );
  assert.equal(paxOf(p).retiredKeyIds, undefined);
  assert.deepEqual(p.ui.asked, [WHO]);
  assert.ok(p.saves() > 0);
  assertClean(p.pwsh);
});

test('ensureSiteAccess: with --yes it checks until CHECK_WAIT_MS is up while the access may be on its way, then carries on without it', async (t) => {
  const p = paxCtx(t, { ui: fakeUi({ yes: true }) });
  p.pwsh.state.fallback = LATE;
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.deepEqual(r, { ok: false, check: LATE });
  assert.deepEqual(p.pwsh.kinds(), Array(CHECK_WAIT_MS / CHECK_EVERY_MS + 1).fill('check'));
  assert.deepEqual(p.sleeps, Array(CHECK_WAIT_MS / CHECK_EVERY_MS).fill(CHECK_EVERY_MS));
  const out = plain(p.ui);
  assert.equal(times(out, WAITING), 1);
  has(out, "  ! Signing in as the app didn't work: AADSTS700016: Application not found in the directory.\n");
  has(out, "  ! Carrying on without it. The task can't upload the files until the check passes: run install again then.\n");
  assert.equal(paxOf(p).site?.checkedAt, undefined);
  assert.equal(paxOf(p).site?.grantId, 'perm-1', 'the grant stays, for the next run');
  assert.deepEqual(p.ui.asked, [WHO], 'only the question --yes takes the default for');
  assertClean(p.pwsh);
});

test('ensureSiteAccess: when the check passed before and still does, nothing on the site changes', async (t) => {
  /** @type {PaxSite} */
  const site = {
    ...SITE_RECORD,
    id: SITE_ID,
    name: 'AI in One',
    webUrl: SITE_URL,
    driveId: 'drive-1',
    driveWebUrl: `${SITE_URL}/Shared%20Documents`,
    grantId: 'perm-1',
    grantedByInstaller: true,
    checkedAt: '2026-05-01T02:00:00.000Z',
  };
  const p = paxCtx(t, { pax: { site: { ...site } } });
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.equal(r.ok, true);
  assert.deepEqual(p.sites.names(), []);
  assert.deepEqual(p.ui.asked, []);
  assert.deepEqual(p.pwsh.kinds(), ['check']);
  assert.deepEqual(paxOf(p).site, { ...site, checkedAt: NOW.toISOString() });
  has(plain(p.ui), '  ✓ The app can write to Shared Documents/AI in One in AI in One\n');
  assertClean(p.pwsh);
});

test('ensureSiteAccess: when a check that passed before fails, it says why and looks at the grant again', async (t) => {
  const site = { ...SITE_RECORD, id: SITE_ID, name: 'AI in One', webUrl: SITE_URL, grantId: 'perm-1', checkedAt: '2026-05-01T02:00:00.000Z' };
  const p = paxCtx(t, { pax: { site } });
  p.sites.addPerm(APP_ID, ['write']);
  p.pwsh.checks.push({ ok: false, step: 'Writing a test file', status: 403, error: 'Access denied' });
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.equal(r.ok, true);
  const out = plain(p.ui);
  has(out, "  ! Writing a test file didn't work (HTTP 403): Access denied\n");
  has(out, '  ✓ The app can already write to AI in One\n');
  assert.deepEqual(p.sites.names(), ['siteByPath', 'drives', 'permissions', 'permission']);
  assert.deepEqual(p.pwsh.kinds(), ['check', 'check']);
  assert.deepEqual(p.sleeps, []);
  assert.equal(paxOf(p).site?.grantId, 'perm-1');
  assert.equal(paxOf(p).site?.grantedByInstaller, undefined);
  assert.equal(paxOf(p).site?.checkedAt, NOW.toISOString());
});

test('ensureSiteAccess: run again once an admin has consented, it finds the grant it made and makes no other', async (t) => {
  const p = paxCtx(t);
  assert.deepEqual(await ensureSiteAccess(p.ctx, { consented: false }), { ok: false });
  assert.deepEqual(p.pwsh.kinds(), [], "the app can't sign in yet, so nothing checks");
  has(plain(p.ui), `  ! ${NOT_CONSENTED}\n`);
  assert.equal(paxOf(p).site?.grantId, 'perm-1');

  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.equal(r.ok, true);
  assert.deepEqual(p.sites.names(), ['siteByPath', 'drives', 'permissions', 'grant', 'siteByPath', 'drives', 'permissions', 'permission']);
  assert.equal(callArgs(p.sites, 'grant').length, 1);
  assert.equal(paxOf(p).site?.grantId, 'perm-1');
  assert.equal(paxOf(p).site?.grantedByInstaller, true, 'still the grant the installer made, so uninstall takes it away');
  has(plain(p.ui), '  ✓ The app can already write to AI in One\n');
  assert.deepEqual(p.ui.asked, [WHO, WHO]);
});

test("ensureSiteAccess: an admin's grant to the app, by its app ID in any case, is used as it is", async (t) => {
  const p = paxCtx(t);
  p.sites.addPerm(APP_ID.toUpperCase(), ['owner']);
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.equal(r.ok, true);
  assert.deepEqual(p.sites.names(), ['siteByPath', 'drives', 'permissions', 'permission']);
  assert.equal(paxOf(p).site?.grantId, 'perm-1');
  assert.equal(paxOf(p).site?.grantedByInstaller, undefined, "uninstall leaves an admin's grant alone");
  has(plain(p.ui), '  ✓ The app can already write to AI in One\n');
});

/** @type {[string[], string][]} */
const WEAK_GRANTS = [
  [['read'], 'read'],
  [[], 'none'],
];
for (const [roles, was] of WEAK_GRANTS) {
  test(`ensureSiteAccess: the app's grant of ${was} on the site is changed to write`, async (t) => {
    const p = paxCtx(t);
    p.sites.addPerm(APP_ID, roles);
    const r = await ensureSiteAccess(p.ctx, { consented: true });
    assert.equal(r.ok, true);
    assert.deepEqual(callArgs(p.sites, 'updateGrant'), [[SITE_ID, 'perm-1', ['write']]]);
    assert.deepEqual(callArgs(p.sites, 'grant'), []);
    assert.deepEqual(p.sites.perms[SITE_ID].map((x) => x.roles), [['write']]);
    has(plain(p.ui), `  ✓ Changed the app's access to AI in One from ${was} to write\n`);
    assert.equal(paxOf(p).site?.grantId, 'perm-1');
    assert.equal(paxOf(p).site?.grantedByInstaller, undefined);
  });
}

test('ensureSiteAccess: "An admin" shows the commands that give the app write on this one site, and checks once', async (t) => {
  const p = paxCtx(t, { ui: fakeUi({ answers: ['admin', 'skip'] }) });
  p.pwsh.state.fallback = LATE;
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.deepEqual(r, { ok: false, check: LATE });
  assert.deepEqual(p.sites.names(), []);
  assert.deepEqual(p.ui.asked, [WHO, SORTED]);
  assert.deepEqual(p.pwsh.kinds(), ['check'], 'no grant was made, so it checks once, without waiting');
  assert.deepEqual(p.sleeps, []);
  const out = plain(p.ui);
  assertHandOff(out, SITE_RECORD);
  assert.ok(!out.includes(WAITING));
  assert.equal(paxOf(p).site?.grantId, undefined);
});

test("ensureSiteAccess: signed in with the Azure CLI it can't give the access, so it shows the commands", async (t) => {
  const p = paxCtx(t, { sites: null, method: 'azure-cli', ui: fakeUi({ answers: ['skip'] }) });
  p.pwsh.state.fallback = LATE;
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.deepEqual(r, { ok: false, check: LATE });
  assert.deepEqual(p.ui.asked, [SORTED]);
  assert.equal(p.ctx.sites, undefined, 'no SharePoint sign-in');
  const out = plain(p.ui);
  has(out, "  ! You signed in with the Azure CLI, which can't ask for the SharePoint permission that giving the app access takes.\n");
  assertHandOff(out, SITE_RECORD);
});

/** @type {[string, string, Error, string][]} */
const GRANT_FAILURES = [
  ["the user can't open the site", 'siteByPath', httpError(403, 'Forbidden'), `You can't open ${SITE_URL} (HTTP 403).`],
  [
    'the sign-in fails',
    'siteByPath',
    new Error('AADSTS65001: The user or administrator has not consented to use the application.\nTrace ID: 00000000-0000-0000-0000-000000000009'),
    "That sign-in didn't work: AADSTS65001: The user or administrator has not consented to use the application.",
  ],
  ["the user can't manage the site's permissions", 'permissions', httpError(403, 'Access denied'), "You can't manage who has access to AI in One."],
  ['SharePoint refuses the grant', 'grant', httpError(400, 'Invalid request\nmore detail'), 'SharePoint refused (HTTP 400): Invalid request'],
];
for (const [what, method, err, why] of GRANT_FAILURES) {
  test(`ensureSiteAccess: when ${what}, it says why and shows the commands for an admin`, async (t) => {
    const p = paxCtx(t, { ui: fakeUi({ answers: ['me', 'skip'] }) });
    p.sites.failures[method] = [err];
    p.pwsh.state.fallback = LATE;
    const r = await ensureSiteAccess(p.ctx, { consented: true });
    assert.deepEqual(r, { ok: false, check: LATE });
    const out = plain(p.ui);
    has(out, `  ! ${why}\n`);
    assertHandOff(out, SITE_RECORD);
    assert.deepEqual(p.pwsh.kinds(), ['check'], 'checks once, without waiting');
    assert.equal(paxOf(p).site?.grantId, undefined);
    assert.equal(paxOf(p).site?.grantedByInstaller, undefined);
  });
}

test("ensureSiteAccess: a site that isn't there stops the install, with the address to check", async (t) => {
  const p = paxCtx(t, { pax: { site: { ...SITE_RECORD, url: `https://${HOST}/sites/Gone`, path: '/sites/Gone' } } });
  const err = await rejection(ensureSiteAccess(p.ctx, { consented: true }));
  assert.equal(err.message, `There's no SharePoint site at https://${HOST}/sites/Gone, or you can't see it. Check the address, then run install again and change it.`);
  assert.deepEqual(p.sites.names(), ['siteByPath']);
  assert.deepEqual(p.pwsh.kinds(), []);
});

test('ensureSiteAccess: an error that is not from SharePoint is passed on', async (t) => {
  const p = paxCtx(t);
  p.sites.failures.grant = [new TypeError('Cannot read properties of undefined')];
  const err = await rejection(ensureSiteAccess(p.ctx, { consented: true }));
  assert.ok(err instanceof TypeError);
  assert.equal(err.message, 'Cannot read properties of undefined');
  assert.deepEqual(p.pwsh.kinds(), []);
});

test('ensureSiteAccess: a site with no library by that name asks which of its libraries to use', async (t) => {
  const u = fakeUi({ answers: ['me', 'drive-2'] });
  const selects = recordSelects(u);
  const p = paxCtx(t, { ui: u, pax: { site: { ...SITE_RECORD, library: 'Finance Files' } } });
  const r = await ensureSiteAccess(p.ctx, { consented: false });
  assert.deepEqual(r, { ok: false });
  assert.deepEqual(selects[1], {
    message: 'AI in One has no library called "Finance Files". Which library should the files go in?',
    choices: [
      { name: 'Documents', value: 'drive-1' },
      { name: 'Reports', value: 'drive-2' },
    ],
    def: 'drive-1',
  });
  const site = paxOf(p).site;
  assert.equal(site?.library, 'Reports');
  assert.equal(site?.driveId, 'drive-2');
  assert.equal(site?.driveWebUrl, `${SITE_URL}/Reports`);
  assert.equal(site?.grantId, 'perm-1');
  has(plain(p.ui), `  ! ${NOT_CONSENTED}\n`);
  assert.deepEqual(p.pwsh.runs, []);
});

test('ensureSiteAccess: with --yes, a site with no library by that name stops the install and names its libraries', async (t) => {
  const p = paxCtx(t, { ui: fakeUi({ yes: true }), pax: { site: { ...SITE_RECORD, library: 'Finance Files' } } });
  const err = await rejection(ensureSiteAccess(p.ctx, { consented: true }));
  assert.equal(err.message, 'AI in One has no library called "Finance Files". Its libraries: Documents, Reports. Run install again without --yes to choose one.');
  assert.deepEqual(p.sites.names(), ['siteByPath', 'drives']);
  assert.deepEqual(p.pwsh.kinds(), []);
});

test('ensureSiteAccess: only document libraries count, and a drive without a type is taken for one', async (t) => {
  const p = paxCtx(t);
  p.sites.drives[SITE_ID] = [{ id: 'drive-3', name: 'Documents', webUrl: `${SITE_URL}/Shared%20Documents`, driveType: 'personal' }];
  const err = await rejection(ensureSiteAccess(p.ctx, { consented: true }));
  assert.equal(err.message, 'AI in One has no document library to put the files in.');
  assert.deepEqual(p.sites.names(), ['siteByPath', 'drives']);

  const q = paxCtx(t);
  q.sites.drives[SITE_ID] = [{ id: 'drive-9', name: 'Documents', webUrl: `${SITE_URL}/Shared%20Documents` }];
  await ensureSiteAccess(q.ctx, { consented: false });
  assert.equal(paxOf(q).site?.driveId, 'drive-9');
});

test('ensureSiteAccess: when the library is not found, "Change the library" writes the script again with the new one', async (t) => {
  const u = fakeUi({ answers: ['me', 'library', 'Reports  '] });
  const selects = recordSelects(u);
  const p = paxCtx(t, { ui: u });
  /** @type {AccessCheck} */
  const noLibrary = { ok: false, step: 'Finding the library', error: 'The site has no library called Shared Documents.' };
  p.pwsh.checks.push(noLibrary, (w) =>
    setting('Library', 'Reports').test(w) && setting('DriveId', '').test(w)
      ? { ...PASSING, driveId: 'drive-2', driveName: 'Reports', driveWebUrl: `${SITE_URL}/Reports` }
      : { ...noLibrary, error: 'The script still has the old library.' },
  );
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.equal(r.ok, true);
  const sorted = selects.find((s) => s.message === SORTED);
  assert.deepEqual(
    sorted?.choices.map((c) => c.value),
    ['check', 'library', 'skip'],
  );
  assert.equal(sorted?.def, 'check');
  assert.deepEqual(p.ui.asked, [WHO, SORTED, 'The document library for the files']);
  const site = paxOf(p).site;
  assert.equal(site?.library, 'Reports');
  assert.equal(site?.driveId, 'drive-2');
  assert.equal(site?.driveWebUrl, `${SITE_URL}/Reports`);
  const w = wrapperText(p);
  assert.match(w, setting('Library', 'Reports'));
  assert.match(w, setting('DriveId', 'drive-2'));
  const out = plain(p.ui);
  has(out, "  ! Finding the library didn't work: The site has no library called Shared Documents.\n");
  has(out, '  ✓ The app can write to Reports/AI in One in AI in One\n');
  assert.deepEqual(p.pwsh.kinds(), ['check', 'check']);
  assert.deepEqual(p.sleeps, []);
});

test('ensureSiteAccess: "Check again" runs the check again, and "Carry on without it" stops', async (t) => {
  const u = fakeUi({ answers: ['me', 'check', 'skip'] });
  const selects = recordSelects(u);
  const p = paxCtx(t, { ui: u });
  /** @type {AccessCheck} */
  const bad = { ok: false, step: 'Making the folder', status: 400, error: 'Bad request' };
  p.pwsh.state.fallback = bad;
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.deepEqual(r, { ok: false, check: bad });
  assert.deepEqual(p.pwsh.kinds(), ['check', 'check']);
  assert.deepEqual(p.sleeps, [], "a 400 isn't access on its way, so it doesn't wait");
  assert.deepEqual(
    selects.filter((s) => s.message === SORTED).map((s) => s.choices.map((c) => c.value)),
    [
      ['check', 'skip'],
      ['check', 'skip'],
    ],
  );
  assert.equal(times(plain(p.ui), "  ! Making the folder didn't work (HTTP 400): Bad request\n"), 2);
  assert.equal(paxOf(p).site?.checkedAt, undefined);
});

test('ensureSiteAccess: files kept on this PC need only the script, and no site', async (t) => {
  const p = paxCtx(t, { pax: { destination: 'local', site: undefined, retiredThumbprints: [thumb(2)] } });
  const folder = join(p.tmp, 'Out');
  paxOf(p).localFolder = folder;
  const r = await ensureSiteAccess(p.ctx, { consented: false });
  assert.deepEqual(r, { ok: true });
  const w = wrapperText(p);
  assert.match(w, setting('Destination', 'local'));
  assert.match(w, setting('LocalFolder', folder));
  has(plain(p.ui), `  ✓ The task copies the files to ${folder}\n`);
  assert.deepEqual(p.pwsh.kinds(), ['remove'], 'the replaced certificate comes out of the store');
  assert.equal(paxOf(p).retiredThumbprints, undefined);
  assert.deepEqual(p.sites.names(), []);
  assert.deepEqual(p.ui.asked, []);
  assertClean(p.pwsh);
});

test('ensureSiteAccess: a site recorded only by its address gets its host and path from it', async (t) => {
  const p = paxCtx(t, {
    ui: fakeUi({ answers: ['admin', 'skip'] }),
    pax: { site: { url: `https://${HOST}/teams/Finance/`, library: 'Shared Documents', folder: SP_FOLDER } },
  });
  p.pwsh.state.fallback = LATE;
  await ensureSiteAccess(p.ctx, { consented: true });
  const site = /** @type {PaxSite} */ (paxOf(p).site);
  assert.equal(site.host, HOST);
  assert.equal(site.path, '/teams/Finance');
  const w = wrapperText(p);
  assert.match(w, setting('SiteHost', HOST));
  assert.match(w, setting('SitePath', '/teams/Finance'));
  assert.deepEqual(p.ui.asked, [`"${PAX_APP_NAME}" needs write access to https://${HOST}/teams/Finance. Who gives it?`, SORTED]);
  assertHandOff(plain(p.ui), site);
});

test('ensureSiteAccess: a site made again at the same address gets its new ID and a grant of its own', async (t) => {
  const oldId = `${HOST},00000000-0000-0000-0000-000000000021,00000000-0000-0000-0000-000000000022`;
  const p = paxCtx(t, {
    pax: {
      site: {
        ...SITE_RECORD,
        id: oldId,
        name: 'AI in One',
        webUrl: SITE_URL,
        driveId: 'drive-old',
        driveWebUrl: `${SITE_URL}/Shared%20Documents`,
        grantId: 'perm-old',
        grantedByInstaller: true,
        checkedAt: '2026-05-01T02:00:00.000Z',
      },
    },
  });
  p.pwsh.checks.push({ ok: false, step: 'Finding the site', status: 404, error: 'Requested site could not be found' });
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.equal(r.ok, true);
  has(plain(p.ui), "  ! Finding the site didn't work (HTTP 404): Requested site could not be found\n");
  assert.ok(
    p.sites.calls.every((c) => !c.args.includes(oldId)),
    'nothing is asked of the old site',
  );
  assert.deepEqual(callArgs(p.sites, 'grant'), [[SITE_ID, { appId: APP_ID, displayName: PAX_APP_NAME }, ['write']]]);
  const site = paxOf(p).site;
  assert.equal(site?.id, SITE_ID);
  assert.equal(site?.driveId, 'drive-1');
  assert.equal(site?.grantId, 'perm-1');
  assert.equal(site?.grantedByInstaller, true);
  assert.equal(site?.checkedAt, NOW.toISOString());
  assert.deepEqual(p.pwsh.kinds(), ['check', 'check']);
});

test('ensureSiteAccess: needs a PAX setup, and a site when the files go to SharePoint', async (t) => {
  const p = paxCtx(t, { pax: { site: undefined } });
  assert.equal((await rejection(ensureSiteAccess(p.ctx, { consented: true }))).message, 'The install record has no SharePoint site yet.');
  assert.equal(existsSync(wrapperPath(p.env)), false, 'no script without a site');
  delete p.config.pax;
  assert.equal((await rejection(ensureSiteAccess(p.ctx, { consented: true }))).message, 'The install record has no PAX setup.');
  assert.deepEqual(p.pwsh.runs, []);
  assert.deepEqual(p.sites.names(), []);
});

test('ensureSiteAccess: the library chosen when the site has none by that name is the one the check uses', async (t) => {
  const p = paxCtx(t, { ui: fakeUi({ answers: ['me', 'drive-2', 'skip'] }), pax: { site: { ...SITE_RECORD, library: 'Finance Files' } } });
  /** @type {AccessCheck} */
  const notFound = { ok: false, step: 'Finding the library', error: 'The site has no library called Finance Files. Its libraries: Documents, Reports.' };
  /** @type {string[]} */
  const seen = [];
  p.pwsh.state.fallback = notFound;
  p.pwsh.checks.push((w) => {
    seen.push(w);
    return setting('Library', 'Reports').test(w) ? { ...PASSING, driveId: 'drive-2', driveName: 'Reports', driveWebUrl: `${SITE_URL}/Reports` } : notFound;
  });
  const r = await ensureSiteAccess(p.ctx, { consented: true });
  assert.equal(paxOf(p).site?.library, 'Reports', 'the record has the library chosen');
  assert.match(seen[0] ?? '', setting('Library', 'Reports'), 'the check ran the script with the library chosen, not "Finance Files"');
  assert.equal(r.ok, true);
});

/** @type {PaxSite} */
const GRANTED = { ...SITE_RECORD, id: SITE_ID, name: 'AI in One', webUrl: SITE_URL, grantId: 'perm-1', grantedByInstaller: true };
const TAKE_AWAY = `Take away the app's access to ${SITE_URL}? You sign in again, with Sites.FullControl.All.`;

/** The commands an admin runs to take the grant away, as uninstall shows them. @param {string} out */
function assertRevokeCommands(out) {
  const lines = revokeCommands(GRANTED);
  assert.equal(lines.length, 2);
  for (const line of lines) has(out, `      ${line}\n`);
}

test('revokeSiteGrant: does nothing when the record has no grant on a site', async (t) => {
  /** @type {Record<string, any>[]} */
  const records = [
    { site: { ...SITE_RECORD } },
    { site: { ...SITE_RECORD, id: SITE_ID } },
    { site: { ...SITE_RECORD, grantId: 'perm-1', grantedByInstaller: true } },
    { site: undefined, destination: 'local' },
  ];
  for (const pax of records) {
    const p = paxCtx(t, { pax });
    await revokeSiteGrant(p.ctx);
    assert.equal(plain(p.ui), '');
    assert.deepEqual(p.ui.asked, []);
    assert.deepEqual(p.sites.names(), []);
    assert.equal(p.saves(), 0);
  }
  const p = paxCtx(t);
  delete p.config.pax;
  await revokeSiteGrant(p.ctx);
  assert.equal(plain(p.ui), '');
});

test("revokeSiteGrant: an admin's grant stays, with the command to take it away", async (t) => {
  const p = paxCtx(t, { pax: { site: { ...SITE_RECORD, id: SITE_ID, name: 'AI in One', webUrl: SITE_URL, grantId: 'perm-1' } } });
  await revokeSiteGrant(p.ctx);
  const out = plain(p.ui);
  has(out, `    The installer didn't give the app its access to ${SITE_URL}, so it stays. An admin can take it away with:\n`);
  assertRevokeCommands(out);
  assert.deepEqual(p.ui.asked, []);
  assert.deepEqual(p.sites.names(), []);
  assert.equal(paxOf(p).site?.grantId, 'perm-1');
  assert.equal(p.saves(), 0);
});

test('revokeSiteGrant: takes away the grant the installer made, once the user says so, and only that one', async (t) => {
  const p = paxCtx(t, { pax: { site: { ...GRANTED } } });
  p.sites.addPerm(APP_ID, ['write'], 'perm-1');
  const other = p.sites.addPerm(OTHER_APP_ID, ['read'], 'perm-9');
  await revokeSiteGrant(p.ctx);
  assert.deepEqual(p.ui.asked, [TAKE_AWAY]);
  assert.deepEqual(callArgs(p.sites, 'revoke'), [[SITE_ID, 'perm-1']]);
  assert.deepEqual(p.sites.perms[SITE_ID], [other], "another app's access stays");
  has(plain(p.ui), `  ✓ Took away the app's access to ${SITE_URL}\n`);
  const site = paxOf(p).site;
  assert.equal(site?.grantId, undefined);
  assert.equal(site?.grantedByInstaller, undefined);
  assert.equal(site?.id, SITE_ID);
  assert.equal(p.saves(), 1);
});

test('revokeSiteGrant: a grant that is gone already is taken off the record', async (t) => {
  const p = paxCtx(t, { pax: { site: { ...GRANTED } } });
  await revokeSiteGrant(p.ctx);
  has(plain(p.ui), `  ✓ The app's access to ${SITE_URL} was gone already\n`);
  assert.equal(paxOf(p).site?.grantId, undefined);
  assert.equal(paxOf(p).site?.grantedByInstaller, undefined);
  assert.equal(p.saves(), 1);
});

test("revokeSiteGrant: a recorded permission that isn't the app's stays, and comes off the record", async (t) => {
  const p = paxCtx(t, { pax: { site: { ...GRANTED } } });
  const other = p.sites.addPerm(OTHER_APP_ID, ['write'], 'perm-1');
  await revokeSiteGrant(p.ctx);
  assert.deepEqual(p.ui.asked, [TAKE_AWAY]);
  assert.deepEqual(callArgs(p.sites, 'permission'), [[SITE_ID, 'perm-1']], 'it reads the permission before anything else');
  assert.deepEqual(callArgs(p.sites, 'revoke'), []);
  assert.deepEqual(p.sites.perms[SITE_ID], [other], "the other app's access stays");
  const out = plain(p.ui);
  has(out, `  ! The permission the install record names on ${SITE_URL} (perm-1) isn't the app's, so the installer left it alone and took it off the record. An admin can check the site's permissions.\n`);
  assert.doesNotMatch(out, /Invoke-MgGraphRequest -Method DELETE/, 'no command to delete a permission that is not the app\'s');
  assert.equal(paxOf(p).site?.grantId, undefined);
  assert.equal(paxOf(p).site?.grantedByInstaller, undefined);
  assert.equal(p.saves(), 1);

  const noAppId = paxCtx(t, { pax: { site: { ...GRANTED } } });
  noAppId.sites.addPerm(APP_ID, ['write'], 'perm-1');
  delete noAppId.config.app.appId;
  await revokeSiteGrant(noAppId.ctx);
  assert.deepEqual(callArgs(noAppId.sites, 'revoke'), [], 'without an app ID on record, nothing can be matched, so nothing is taken away');
  has(plain(noAppId.ui), `isn't the app's, so the installer left it alone`);
});

/** @type {[string, Error, string][]} */
const REVOKE_FAILURES = [
  ['SharePoint refuses', httpError(403, 'Access denied\nmore detail'), 'Access denied'],
  [
    'the sign-in fails',
    new Error('AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication.\nTrace ID: x'),
    'AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication.',
  ],
];
for (const [what, err, why] of REVOKE_FAILURES) {
  test(`revokeSiteGrant: when ${what}, the grant stays on record, with the command for an admin`, async (t) => {
    const p = paxCtx(t, { pax: { site: { ...GRANTED } } });
    p.sites.addPerm(APP_ID, ['write'], 'perm-1');
    p.sites.failures.revoke = [err];
    await revokeSiteGrant(p.ctx);
    const out = plain(p.ui);
    has(out, `  ! Couldn't take away the app's access to ${SITE_URL} (${why}). An admin can, with:\n`);
    assertRevokeCommands(out);
    assert.equal(paxOf(p).site?.grantId, 'perm-1');
    assert.equal(paxOf(p).site?.grantedByInstaller, true);
    assert.equal(p.saves(), 0);
  });
}

test('revokeSiteGrant: a user who says no keeps the grant, and gets the command for an admin', async (t) => {
  const p = paxCtx(t, { ui: fakeUi({ answers: [false] }), pax: { site: { ...GRANTED } } });
  await revokeSiteGrant(p.ctx);
  const out = plain(p.ui);
  has(out, `    The app's access to ${SITE_URL} stays. An admin can take it away with:\n`);
  assertRevokeCommands(out);
  assert.deepEqual(p.ui.asked, [TAKE_AWAY]);
  assert.deepEqual(p.sites.names(), []);
  assert.equal(paxOf(p).site?.grantId, 'perm-1');
});

test("revokeSiteGrant: signed in with the Azure CLI it can't sign in for SharePoint, so it shows the command", async (t) => {
  const p = paxCtx(t, { sites: null, method: 'azure-cli', pax: { site: { ...GRANTED } } });
  await revokeSiteGrant(p.ctx);
  const out = plain(p.ui);
  has(out, `    The app's access to ${SITE_URL} stays. An admin can take it away with:\n`);
  assertRevokeCommands(out);
  assert.deepEqual(p.ui.asked, []);
  assert.equal(p.ctx.sites, undefined);
  assert.equal(paxOf(p).site?.grantId, 'perm-1');
});
