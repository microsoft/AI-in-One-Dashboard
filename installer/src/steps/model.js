// @ts-check
/**
 * The AI in One semantic model: deployed from the Power BI template, connected to the
 * Lakehouse through a cloud connection that signs in as the app registration, and refreshed.
 */
import { createHash } from 'node:crypto';
import { enabledModules, MODEL_MODULES } from '../catalog.js';
import { servicePrincipalCredentials, semanticModelDefinition, sqlConnectionBody } from '../clients/fabric.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';
import { buildModel, datasourcePath, loadTemplateModel, MODEL_TEMPLATE, PBISM } from '../transform/model.js';
import { formatDuration } from '../ui.js';
import { createItem, modelKey } from './fabric.js';
import { addMonths, SECRET_LIFETIME_MONTHS } from './identity.js';
import { addTrackedSecret, adoptAttempts, promoteSecret, removeRetired, settleFailedSecret } from './secrets.js';

/** @typedef {import('../install.js').Ctx} Ctx */

/** Name of the app secret that only the model's connection holds. */
export const CONNECTION_SECRET_NAME = 'AI in One semantic model connection';

/** @param {string} workspaceId */
export const connectionName = (workspaceId) => `AI in One SQL ${workspaceId.slice(0, 8)}`;

/** @param {string} workspaceId @param {string} modelId */
export const modelSettingsUrl = (workspaceId, modelId) => `https://app.powerbi.com/groups/${workspaceId}/settings/datasets/${modelId}`;

/** @param {string} workspaceId @param {string} modelId */
export const modelUrl = (workspaceId, modelId) => `https://app.powerbi.com/groups/${workspaceId}/datasets/${modelId}/details`;

export const ENDPOINT_POLL_MS = 15_000;
export const CONNECTION_RETRY_MS = 30_000;
const CONNECTION_ATTEMPTS = 10;
export const REFRESH_POLL_MS = 20_000;

/** Refresh states after which Power BI does no more work. */
export const REFRESH_FINAL = new Set(['Completed', 'Failed', 'Cancelled', 'Disabled', 'TimedOut']);

/**
 * The model's Lakehouse SQL analytics endpoint. A new Lakehouse takes a minute or two to get one.
 * @param {Ctx} ctx
 * @returns {Promise<{ server: string, database: string }>}
 */
export async function waitForSqlEndpoint(ctx) {
  const f = ctx.config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  for (let i = 0; ; i++) {
    const lh = await ctx.api.fabric.getLakehouse(ws, /** @type {string} */ (f.lakehouseId));
    const sql = lh?.properties?.sqlEndpointProperties;
    if (sql?.connectionString && (!sql.provisioningStatus || sql.provisioningStatus === 'Success')) {
      return { server: sql.connectionString, database: lh.displayName };
    }
    if (sql?.provisioningStatus === 'Failed') throw new Error(`The Lakehouse's SQL analytics endpoint failed to provision. Open ${lh.displayName} in Fabric to retry it.`);
    if (i === 40) throw new Error('The Lakehouse\'s SQL analytics endpoint wasn\'t ready after 10 minutes. Run the installer again later.');
    if (i === 0) ctx.ui.info('Waiting for the Lakehouse\'s SQL analytics endpoint.');
    await ctx.sleep(ENDPOINT_POLL_MS);
  }
}

/**
 * What the model definition is built from.
 * @param {string} server
 * @param {string} database
 * @param {import('../catalog.js').ModuleChoice} modules
 */
export const modelSignature = (server, database, modules) =>
  `${server.toLowerCase()};${database};${enabledModules(modules).filter((m) => /** @type {readonly string[]} */ (MODEL_MODULES).includes(m)).join(',')}`;

/** @param {unknown} definition */
export const definitionHash = (definition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16);

/** What the plan says about a model that's already deployed. */
export const MODEL_UPDATE_NOTE = 'Updated in place if this version changed it, keeping its data. If Fabric can\'t keep the data, you\'re asked before it\'s cleared and reloaded; reports on it show no data until then.';

/**
 * The installer's models that are owed a reload: their definition was, or may have been, replaced
 * and no refresh has finished since. Kept in the install record, so a later run still reloads them.
 * @param {import('../config.js').InstallConfig} config
 * @returns {import('../config.js').ModelConfig[]}
 */
export function pendingReloads(config) {
  return [config.semanticModel].filter((m) => !!m && !!m.id && !!m.reload);
}

/**
 * Records, before a request that can change a model, that it's owed a reload and that the change
 * hasn't settled. `cleared` stays set until the reload finishes.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 * @param {boolean} cleared
 */
function oweReload(ctx, m, cleared) {
  m.reload = { since: ctx.now().toISOString(), unsettled: true, ...(cleared || m.reload?.cleared ? { cleared: true } : {}) };
  ctx.save();
}

/**
 * Records that the request changing a model finished. From now on, a whole-model refresh the
 * installer requests can be its reload; nothing that ran before, or that it didn't request, is.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 */
function changeSettled(ctx, m) {
  m.reload = { since: ctx.now().toISOString(), ...(m.reload?.cleared ? { cleared: true } : {}) };
  ctx.save();
}

/**
 * Whether a refresh is the reload a model is owed: the whole-model refresh the installer requested
 * after the change settled. A refresh someone else started, such as the pipeline's or one it
 * followed because it was already running, may cover only some tables, so it never is.
 * @param {import('../config.js').ModelConfig} m
 * @param {string | undefined} requestId
 */
const isOurReload = (m, requestId) => !!m.reload && !m.reload.unsettled && !!requestId && requestId === m.reload.ours;

/**
 * Forgets the installer's reload refresh once it ended badly, so the next run requests another.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 * @param {string} requestId
 */
function reloadFailed(ctx, m, requestId) {
  if (!isOurReload(m, requestId)) return;
  delete m.reload?.ours;
  ctx.save();
}

/**
 * Whether Fabric turned an update down because it can't make it without clearing the model's data.
 * A failed operation surfaces as a plain Error that carries the code in its message.
 * @param {unknown} err
 */
export function needsDataReset(err) {
  const code = err instanceof HttpError ? err.code : undefined;
  return code === 'RequiredOptionsMissing' || /\(RequiredOptionsMissing\)/.test(String(/** @type {any} */ (err)?.message ?? ''));
}

/**
 * Asks before Fabric may clear a model's data. --allow-model-reset says yes for unattended runs;
 * --yes alone doesn't.
 * @param {Ctx} ctx
 * @param {string} name
 */
async function allowDataReset(ctx, name) {
  const { ui } = ctx;
  ui.warn(`Fabric can't apply this version of ${name} and keep its data. To apply it, Fabric clears the data and the installer reloads it ` +
    `from the Lakehouse, which isn't changed. Until that reload finishes, reports on ${name} show no data, ` +
    'which can take an hour or more with a lot of history.');
  if (ctx.allowModelReset) {
    ui.note('Clearing it, as --allow-model-reset allows.');
    return true;
  }
  if (ui.yes) return false;
  return ui.confirm(`Clear ${name}'s data and reload it now?`, false);
}

/**
 * Replaces a model's definition, keeping its data unless Fabric can't and the user agrees to clear
 * it. The model is recorded as owed a reload, with the change unsettled, before each request that
 * could change it; it stays unsettled if the outcome is unknown, and only a refusal that changed
 * nothing takes that back.
 * @param {Ctx} ctx
 * @param {string} ws
 * @param {import('../config.js').ModelConfig} m
 * @param {any} definition
 */
async function replaceDefinition(ctx, ws, m, definition) {
  const { api, ui } = ctx;
  const id = /** @type {string} */ (m.id);
  const name = m.name;
  const owed = m.reload && structuredClone(m.reload);
  oweReload(ctx, m, false);
  try {
    await api.fabric.updateSemanticModel(ws, id, definition);
    changeSettled(ctx, m);
    return;
  } catch (err) {
    if (!needsDataReset(err)) throw err;
  }
  // Fabric turned it down and changed nothing.
  if (owed) m.reload = owed;
  else delete m.reload;
  ctx.save();
  if (!(await allowDataReset(ctx, name))) {
    throw new Error(`${name} wasn't changed, so this run stopped before finishing: its new version needs its data cleared and reloaded. ` +
      `When reports can show no data while it reloads, run it again and answer yes${ui.web ? '' : ', or add --allow-model-reset'}.`);
  }
  oweReload(ctx, m, true);
  try {
    await api.fabric.updateSemanticModel(ws, id, definition, { allowPurgeData: true });
  } catch (err) {
    ui.warn(`${name}'s data may have been cleared. Run the installer again once the problem below is fixed: it applies the update again and then reloads the data.`);
    throw err;
  }
  changeSettled(ctx, m);
}

/**
 * Creates a semantic model item, or updates it when its inputs or its definition changed, or
 * `force` is set. The definition's hash is part of the signature, so running the installer again
 * from a newer checkout redeploys a model whose template changed. An update clears the model's
 * connection binding. Fabric keeps its data where it can; when it can't, it
 * clears the data only once the user agrees. Either way the model is owed a reload (see pendingReloads).
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 * @param {{ signature: string, definition: () => any, force?: boolean }} o
 */
export async function deployModel(ctx, m, o) {
  const { ui, api } = ctx;
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  const items = await api.fabric.listItems(ws, 'SemanticModel');
  const definition = o.definition();
  const signature = `${o.signature};${definitionHash(definition)}`;

  if (m.id && !items.some((i) => i.id === m.id)) {
    ui.warn(`${m.name} was deleted. Deploying it again.`);
    delete m.id;
  }
  const unsettled = !!m.id && !!m.reload?.unsettled;
  const deployed = !m.id || !!o.force || m.signature !== signature || unsettled;
  if (!m.id) {
    const made = await createItem(ctx, `SemanticModel:${modelKey(ctx.config, m)}`, 'SemanticModel', m.name, items, (name, ref) => api.fabric.createSemanticModel(ws, name, definition, ref));
    m.id = made.id;
    m.name = made.name;
    if (made.resumed) await replaceDefinition(ctx, ws, m, definition);
    // Made again after it was deleted while owed a reload: the new one still needs loading.
    else if (m.reload) changeSettled(ctx, m);
    ui.ok(`${made.resumed ? 'Updated' : 'Created'} semantic model ${made.name}`);
    m.bound = false;
  } else if (deployed) {
    if (unsettled && !o.force && m.signature === signature) ui.note(`${m.name}'s last update may not have finished, so applying it again.`);
    await replaceDefinition(ctx, ws, m, definition);
    m.bound = false;
    ui.ok(`Updated semantic model ${m.name}`);
  } else {
    ui.ok(`Semantic model ${m.name} is in place`);
  }
  m.signature = signature;
  ctx.save();
}

/**
 * Creates the semantic model, or updates it when its inputs changed or `force` is set.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureSemanticModel(ctx, opts = {}) {
  const { config, sources } = ctx;
  const sm = config.semanticModel;
  if (!sources.modelFile) throw new Error(`This checkout has no "${MODEL_TEMPLATE.split('/').pop()}" to build the semantic model from.`);

  const { server, database } = await waitForSqlEndpoint(ctx);
  await deployModel(ctx, sm, {
    signature: modelSignature(server, database, config.modules),
    definition: () =>
      semanticModelDefinition(buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), { server, database }), PBISM),
    force: opts.force,
  });
  Object.assign(sm, { server, database });
  ctx.save();
}

/** @param {unknown} err */
const status = (err) => (err instanceof HttpError ? err.status : 0);

/**
 * A secret for the connection: a new one on the app, or one the user pastes when they can't add one.
 * A new one is tracked from before Entra is asked (see steps/secrets.js).
 * @param {Ctx} ctx
 * @returns {Promise<{ value: string, keyId?: string, expires?: string }>}
 */
async function connectionSecret(ctx) {
  const { ui, config } = ctx;
  const app = config.app;
  try {
    const cred = await addTrackedSecret(ctx, config.semanticModel, /** @type {string} */ (app.objectId), CONNECTION_SECRET_NAME, addMonths(ctx.now(), SECRET_LIFETIME_MONTHS));
    return { value: cred.secretText, keyId: cred.keyId, expires: cred.endDateTime };
  } catch (err) {
    if (status(err) !== 403) throw err;
  }
  ui.warn(`You can't add a client secret to ${app.displayName ?? app.appId}, and the model's connection needs one.`);
  return { value: await ui.secret(`A client secret for ${app.displayName ?? app.appId}. It is kept only in the Fabric connection.`) };
}

/**
 * After Fabric didn't take the new secret: removed if Fabric turned it down, otherwise kept as
 * pending, since the connection may hold it.
 * @param {Ctx} ctx
 * @param {{ keyId?: string }} secret
 * @param {unknown} err
 */
async function settleConnectionSecret(ctx, secret, err) {
  if (secret.keyId) await settleFailedSecret(ctx, ctx.config.semanticModel, ctx.config.app.objectId, secret.keyId, err);
}

/** @param {Ctx} ctx @param {string} clientSecret */
const credentialsFor = (ctx, clientSecret) => ({
  tenantId: ctx.user.tenantId,
  clientId: /** @type {string} */ (ctx.config.app.appId),
  clientSecret,
});

const ROLE_RANK = { Viewer: 1, Contributor: 2, Member: 3, Admin: 4 };

/**
 * Gives the app's service principal at least `role` on the workspace. Viewer lets the model's
 * connection read the Lakehouse. People and the viewer group never get a workspace role: a Viewer
 * can read the notebooks, which may hold the client secret.
 * @param {Ctx} ctx
 * @param {'Viewer' | 'Contributor'} [role]
 * @param {string} [why]
 */
export async function ensureWorkspaceRole(ctx, role = 'Viewer', why = 'so the model can read the Lakehouse') {
  const { ui, config, api } = ctx;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const spId = /** @type {string} */ (config.app.servicePrincipalId);
  const roles = await api.fabric.listRoleAssignments(ws);
  const mine = roles.find((r) => String(r.principal?.id ?? r.id).toLowerCase() === spId.toLowerCase());
  // Any assignment reads the workspace; an unrecognised role is never lowered.
  const has = mine ? (ROLE_RANK[/** @type {keyof typeof ROLE_RANK} */ (mine.role)] ?? (mine.role ? 5 : 1)) : 0;
  if (has >= ROLE_RANK[role]) return;
  if (mine) await api.fabric.updateRoleAssignment(ws, mine.id, role);
  else await api.fabric.addRoleAssignment(ws, spId, 'ServicePrincipal', role);
  ui.ok(`Gave ${config.app.displayName ?? 'the app'} ${role} on the workspace, ${why}`);
}

/** @param {Ctx} ctx */
const ensureViewer = (ctx) => ensureWorkspaceRole(ctx, 'Viewer');

/**
 * Creates the connection. Fabric tests it first, and a new secret or role takes a few minutes to work.
 * @param {Ctx} ctx
 * @param {any} body
 */
async function createConnection(ctx, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.api.fabric.createConnection(body);
    } catch (err) {
      const s = status(err);
      if (s === 409 || s === 404 || s < 400 || s >= 500 || attempt === CONNECTION_ATTEMPTS) throw err;
      if (attempt === 1) ctx.ui.info('Waiting for the new secret and workspace access to take effect.');
      await ctx.sleep(CONNECTION_RETRY_MS);
    }
  }
}

/**
 * After a connection create failed with 409: Fabric can make the connection and still answer 429 or time out,
 * and the retry then finds the name taken. Returns the connection `match` finds, to reuse, or undefined.
 * @param {Ctx} ctx
 * @param {unknown} err  What the create threw.
 * @param {(c: any) => boolean} match  Which listed connection is the one the create was making.
 * @returns {Promise<any>}
 */
export async function connectionCreatedAnyway(ctx, err, match) {
  if (status(err) !== 409) return undefined;
  const found = (await ctx.api.fabric.listConnections().catch(() => [])).find(match);
  if (found) ctx.ui.info(`Fabric already has a connection named "${found.displayName}", probably from an earlier request that it throttled or that timed out. Using that one.`);
  return found;
}

/**
 * Makes sure the model reads the Lakehouse through a connection that signs in as the app.
 * @param {Ctx} ctx
 */
export async function ensureModelConnection(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const objectId = config.app.objectId;
  await ensureViewer(ctx);
  await removeRetired(ctx, sm, objectId);
  await adoptAttempts(ctx, sm, objectId, CONNECTION_SECRET_NAME);

  /** @type {any} */
  let conn = sm.connectionId ? await api.fabric.getConnection(sm.connectionId).catch((err) => (status(err) === 404 ? null : Promise.reject(err))) : null;
  if (sm.connectionId && !conn) {
    ui.warn(`The connection ${sm.connectionName ?? sm.connectionId} was deleted. Creating it again.`);
    delete sm.connectionId;
    sm.bound = false;
  }
  if (conn && sm.pendingSecretKeyIds?.length) {
    // A stopped run may have given the connection a secret the record doesn't have as current.
    // A new one makes it certain which the connection holds; then the others are removed.
    ui.warn(`A run that stopped part-way added a client secret for the connection (key ${sm.pendingSecretKeyIds.join(', ')}) and may have given it to the connection. Giving the connection a new one, so it's certain which it holds.`);
    await rotateModelSecret(ctx);
  }
  if (!conn) {
    const name = connectionName(ws);
    const secret = await connectionSecret(ctx);
    const credentials = credentialsFor(ctx, secret.value);
    try {
      let existing = (await api.fabric.listConnections()).find((c) => c.displayName === name);
      if (!existing) {
        const body = sqlConnectionBody({ displayName: name, server: /** @type {string} */ (sm.server), database: /** @type {string} */ (sm.database), ...credentials });
        try {
          conn = await createConnection(ctx, body);
          ui.ok(`Created the connection "${name}", signed in as ${config.app.displayName ?? 'the app'}`);
        } catch (err) {
          existing = await connectionCreatedAnyway(ctx, err, (c) => c.displayName === name);
          if (!existing) throw err;
        }
      }
      if (existing) {
        await api.fabric.updateConnection(existing.id, { connectivityType: 'ShareableCloud', credentialDetails: servicePrincipalCredentials(credentials) });
        conn = existing;
        ui.ok(`Updated the connection "${name}" to sign in as ${config.app.displayName ?? 'the app'}`);
      }
    } catch (err) {
      await settleConnectionSecret(ctx, secret, err);
      throw new Error(`Fabric couldn't set up the model's connection: ${/** @type {Error} */ (err).message}`);
    }
    Object.assign(sm, { connectionId: conn.id, connectionName: name, secretExpires: secret.expires, bound: false });
    // Saved with the record above; the secrets it replaces are then removed from the app.
    await promoteSecret(ctx, sm, objectId, secret.keyId);
  }

  if (!sm.bound) await bindModel(ctx, sm);
}

/**
 * Points a model's SQL data source at the installer's connection.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 */
export async function bindModel(ctx, m) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const id = /** @type {string} */ (m.id);
  const sources = await api.powerBi.datasources(ws, id).catch(() => []);
  const sql = sources.find((d) => String(d.datasourceType).toLowerCase() === 'sql')?.connectionDetails;
  const path = sql?.server && sql?.database ? datasourcePath(sql.server, sql.database) : datasourcePath(/** @type {string} */ (sm.server), /** @type {string} */ (sm.database));
  for (;;) {
    try {
      await api.fabric.bindConnection(ws, id, { id: /** @type {string} */ (sm.connectionId), type: 'SQL', path });
      m.bound = true;
      ctx.save();
      ui.ok(`${m.name} reads the Lakehouse through "${sm.connectionName}"`);
      return true;
    } catch (err) {
      ui.warn(`Couldn't connect ${m.name} to "${sm.connectionName}" (${/** @type {Error} */ (err).message}).`);
      ui.info(`Choose it under "Gateway and cloud connections" in the model's settings: ${modelSettingsUrl(ws, id)}`);
      if (ui.yes) return false;
      const next = await ui.select(
        'Then:',
        [
          { name: 'Try again', value: 'retry' },
          { name: 'I\'ve connected it myself', value: 'done' },
          { name: 'Skip for now (the model won\'t refresh)', value: 'skip' },
        ],
        'retry',
      );
      if (next === 'skip') return false;
      if (next === 'done') {
        m.bound = true;
        ctx.save();
        return true;
      }
    }
  }
}

/**
 * Starts a refresh, or follows one that is already running.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 * @returns {Promise<{ requestId: string, startedAt?: string }>}  `startedAt`, for one it follows: when that one started.
 */
async function startRefresh(ctx, m) {
  const { api, config } = ctx;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const id = /** @type {string} */ (m.id);
  try {
    return { requestId: await api.powerBi.refresh(ws, id, { type: 'full', commitMode: 'transactional', applyRefreshPolicy: true, retryCount: 1 }) };
  } catch (err) {
    const busy = status(err) === 409 || /in progress/i.test(/** @type {Error} */ (err).message);
    if (!busy) throw err;
    const running = (await api.powerBi.refreshes(ws, id, 1))[0];
    if (!running?.requestId) throw err;
    ctx.ui.note('A refresh is already running, so following that one.');
    return { requestId: running.requestId, startedAt: running.startTime ?? '' };
  }
}

/**
 * Takes back a model's reload obligation after the installer's own reload refresh (see
 * isOurReload) finished cleanly.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 * @param {string} requestId
 */
export function reloaded(ctx, m, requestId) {
  if (!isOurReload(m, requestId)) return false;
  delete m.reload;
  ctx.save();
  return true;
}

/**
 * A refresh's Warning and Error messages, from its details.
 * @param {any} r
 */
const refreshProblems = (r) => (r?.messages ?? []).filter((/** @type {any} */ m) => m?.type === 'Warning' || m?.type === 'Error');
/** @param {any} r */
const refreshState = (r) => r?.extendedStatus ?? r?.status;

/**
 * Whether the model has reloaded since its definition changed: the whole-model refresh the
 * installer requested for it (see isOurReload), in this run or an earlier one, finished cleanly
 * by its own details, by the same rule a refresh it waits for is held to. A refresh it didn't
 * request, such as the pipeline's, never counts, however it ended: it may cover only some tables.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 */
export async function confirmReloaded(ctx, m) {
  if (!m.reload || !m.id) return !m.reload;
  const ours = m.reload.ours;
  if (!ours || !isOurReload(m, ours)) return false;
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  const detail = await ctx.api.powerBi.getRefresh(ws, m.id, ours).catch(() => null);
  if (refreshState(detail) === 'Completed' && !refreshProblems(detail).length) return reloaded(ctx, m, ours);
  if (REFRESH_FINAL.has(refreshState(detail))) reloadFailed(ctx, m, ours);
  return false;
}

/**
 * How far this command got with reloading the models' data: nothing reloads them (`none`); it
 * refreshed them already (`refreshed`); a load that refreshes them is still going (`running`); or
 * such a load finished (`done`).
 * @typedef {'none' | 'refreshed' | 'running' | 'done'} LoadState
 */

/**
 * Reloads the models still owed one (see pendingReloads), whichever command replaced them. Only
 * the installer's own whole-model refresh, requested after the change settled and finished
 * cleanly, takes an obligation back (see isOurReload), so after a load such as the pipeline's it
 * refreshes the model once more. A change that may not have finished has to be applied again
 * first. Not ok when one can't be refreshed, its refresh failed, or `wait` is set and it hasn't
 * finished yet; `pending` names the ones still reloading.
 * @param {Ctx} ctx
 * @param {{ wait: boolean, load: LoadState, reachable: (m: import('../config.js').ModelConfig) => boolean }} opts
 * @returns {Promise<{ ok: boolean, pending: string[] }>}
 */
export async function settleReloads(ctx, opts) {
  const { ui, config } = ctx;
  const owed = pendingReloads(config);
  /** @type {string[]} */
  const pending = [];
  let ok = true;
  for (const m of owed) {
    if (m.reload?.unsettled) {
      ui.fail(`${m.name}'s last update may not have finished, so it can't be reloaded yet. Run the installer again to apply it and then reload it.`);
      ok = false;
    } else if (!opts.reachable(m)) {
      ui.fail(`${m.name} needs reloading after its update, but isn't connected to its data, so it can't be refreshed yet.`);
      ok = false;
    } else if (opts.load === 'running' || (opts.load === 'refreshed' && !opts.wait)) {
      // A load, or its refresh this run, is still going and wasn't waited for.
      pending.push(m.name);
    } else if (await confirmReloaded(ctx, m)) {
      continue;
    } else if (opts.load === 'refreshed') {
      // Its refresh this run failed or didn't finish.
      ok = false;
    } else {
      ui.info(`${m.name} ${m.reload?.cleared ? 'has no data' : 'may show old data or miss new columns'} until it reloads after its update, so refreshing it now.`);
      const r = await refreshModel(ctx, { model: m, wait: opts.wait });
      if (!r.ok) ok = false;
      else if (m.reload) pending.push(m.name);
    }
  }
  if (pending.length && opts.wait) {
    ui.fail(`${joinList(pending)} ${pending.length === 1 ? 'is' : 'are'} still reloading, so this couldn't confirm ${pending.length === 1 ? 'it' : 'they'} finished.`);
    ok = false;
  }
  return { ok, pending };
}

/** @param {string[]} names */
const joinList = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Refreshes a model, the AI in One one unless `model` says otherwise. Waiting, a refresh it
 * requested that finishes cleanly takes back the model's reload obligation; not waiting, it stays
 * until a later run finds it finished cleanly. When it has to follow a refresh that was already
 * running, it refreshes once more for a model owed a reload.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean, timeoutMs?: number, model?: import('../config.js').ModelConfig, followed?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, status?: string }>}  `status` 'Unknown' when it didn't wait.
 */
export async function refreshModel(ctx, opts = {}) {
  const { ui, config, api } = ctx;
  const sm = opts.model ?? config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  if (!sm.id) throw new Error('There is no semantic model yet. Run the installer first.');
  if (!sm.bound) {
    ui.warn(`${sm.name} isn't connected to the Lakehouse yet, so it can't refresh. Run the installer again to connect it.`);
    return { ok: false };
  }
  const { requestId, startedAt } = await startRefresh(ctx, sm);
  ui.ok(`Started a refresh of ${sm.name}`);
  // One it started after the change settled can be the model's reload, whenever it's checked.
  if (startedAt === undefined && sm.reload && !sm.reload.unsettled) {
    sm.reload.ours = requestId;
    ctx.save();
  }
  if (opts.wait === false) return { ok: true, status: 'Unknown' };

  const progress = ui.progress('Refresh');
  const deadline = Date.now() + (opts.timeoutMs ?? 2 * 3_600_000);
  /** @type {any} */
  let r;
  let took = 0;
  try {
    for (;;) {
      r = await api.powerBi.getRefresh(ws, sm.id, requestId).catch((err) => (status(err) === 404 ? null : Promise.reject(err)));
      const state = refreshState(r) ?? 'NotStarted';
      progress.update(state);
      if (REFRESH_FINAL.has(state) || Date.now() > deadline) break;
      await ctx.sleep(REFRESH_POLL_MS);
    }
  } finally {
    took = progress.done();
  }
  const state = refreshState(r);
  // A calculated table whose DAX doesn't parse is only a Warning, and the refresh still ends
  // Completed. Nothing that depends on it is calculated and report pages fail, so it's a failure.
  const problems = refreshProblems(r);
  if (state === 'Completed' && !problems.length) {
    ui.ok(`${sm.name} refreshed in ${formatDuration(took)}`);
    if (reloaded(ctx, sm, requestId)) return { ok: true, status: state };
    // It followed a refresh that was already running, which may not have reloaded the whole model.
    if (startedAt !== undefined && sm.reload && !sm.reload.unsettled) {
      if (!opts.followed) {
        ui.info(`${sm.name} still needs a full reload after its update, so refreshing it again.`);
        return refreshModel(ctx, { ...opts, followed: true });
      }
      // Another refresh was running again, so its own full reload still hasn't run.
      ui.fail(`${sm.name} still needs a full reload after its update, but other refreshes kept running, so it couldn't start one. Run "${commandLine('refresh')}" again once they finish.`);
      return { ok: false, status: state };
    }
    return { ok: true, status: state };
  }
  if (REFRESH_FINAL.has(state)) {
    reloadFailed(ctx, sm, requestId);
    ui.fail(state === 'Completed' ? `${sm.name} refreshed, but Power BI reported problems, so parts of it weren't calculated` : `The refresh ended as ${state}`);
    for (const m of (problems.length ? problems : r?.messages ?? []).slice(0, 3)) ui.info(String(m.message ?? m).slice(0, 600));
    if (r?.serviceExceptionJson) ui.info(String(r.serviceExceptionJson).slice(0, 600));
    if (state === 'Completed') ui.info(`Run the installer again from the latest release to redeploy the model, or run "${commandLine('update')}".`);
    return { ok: false, status: state };
  }
  ui.warn(`The refresh is still running. Check later with "${commandLine('status')}".`);
  return { ok: false, status: state };
}

/**
 * Last few refreshes, newest first.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} [m]
 */
export async function modelRefreshes(ctx, m = ctx.config.semanticModel) {
  if (!m.id) return [];
  return ctx.api.powerBi.refreshes(/** @type {string} */ (ctx.config.fabric.workspaceId), m.id, 3);
}

/** The probe's DAX. It errors when the Calendar table was never calculated. */
export const MODEL_PROBE = 'EVALUATE ROW("CalendarDays", COUNTROWS(\'Calendar\'))';

/** @param {any} err */
function queryError(err) {
  const details = err?.body?.error?.['pbi.error']?.details;
  const detail = Array.isArray(details) ? details.find((d) => d?.code === 'DetailsMessage')?.detail?.value : undefined;
  return String(detail ?? err?.message ?? err).slice(0, 600);
}

/**
 * Asks the AI in One model a small DAX question. A refresh can report Completed while a
 * calculated table, column or relationship was never calculated; this catches that.
 * @param {Ctx} ctx
 * @returns {Promise<{ ok: boolean, skipped?: boolean, calendarDays?: number, error?: string }>}
 *   `skipped` when the model can't be queried (no model, or the API is turned off), which isn't a failure.
 */
export async function verifyModel(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  if (!sm.enabled || !sm.id || !sm.bound) return { ok: true, skipped: true };
  /** @type {any} */
  let res;
  try {
    res = await api.powerBi.executeQueries(ws, sm.id, MODEL_PROBE);
  } catch (err) {
    const s = status(err);
    if (s !== 400) {
      ui.warn(`Couldn't query ${sm.name} to check it (${queryError(err)}).`);
      if (s === 401 || s === 403) ui.note('The tenant setting "Semantic model Execute Queries REST API" may be off. Open a report page to check the model.');
      return { ok: true, skipped: true };
    }
    res = { results: [{ error: { message: queryError(err) } }] };
  }
  const result = res?.results?.[0];
  const error = result?.error ? String(result.error.message ?? JSON.stringify(result.error)).slice(0, 600) : undefined;
  const calendarDays = Number(result?.tables?.[0]?.rows?.[0]?.['[CalendarDays]'] ?? 0);
  if (!error && calendarDays > 0) {
    ui.ok(`${sm.name} answers queries (its Calendar has ${calendarDays.toLocaleString('en-GB')} days)`);
    return { ok: true, calendarDays };
  }
  ui.fail(`${sm.name} refreshed, but ${error ? 'a test query failed' : 'its Calendar table is empty'}, so report pages will fail`);
  if (error) ui.info(error);
  ui.info(`Run the installer again from the latest release to redeploy and refresh the model, or run "${commandLine('update')}".`);
  return { ok: false, calendarDays, error };
}

/**
 * Gives the connection a new secret and removes the old one from the app.
 * @param {Ctx} ctx
 */
export async function rotateModelSecret(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const objectId = config.app.objectId;
  if (!sm.connectionId) return;
  const secret = await connectionSecret(ctx);
  try {
    await api.fabric.updateConnection(sm.connectionId, {
      connectivityType: 'ShareableCloud',
      credentialDetails: servicePrincipalCredentials(credentialsFor(ctx, secret.value)),
    });
  } catch (err) {
    await settleConnectionSecret(ctx, secret, err);
    throw new Error(`Fabric couldn't update the model's connection: ${/** @type {Error} */ (err).message}`);
  }
  sm.secretExpires = secret.expires;
  if (!secret.expires) delete sm.secretExpires;
  const replaced = await promoteSecret(ctx, sm, objectId, secret.keyId);
  ui.ok(`Gave "${sm.connectionName}" a new secret${secret.expires ? ` (expires ${secret.expires.slice(0, 10)})` : ''}`);
  if (replaced.length && !replaced.some((k) => sm.retiredSecretKeyIds?.includes(k))) ui.ok('Removed the connection\'s old secret from the app');
}
