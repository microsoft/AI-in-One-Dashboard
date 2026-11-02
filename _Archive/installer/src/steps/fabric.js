// @ts-check
/**
 * Workspace, Lakehouse, notebooks, pipeline and schedule. Re-runs reuse what the
 * install record points at; `update` pushes fresh notebook and pipeline content.
 */
import { createHash, randomBytes } from 'node:crypto';
import { enabledModules, notebooksFor } from '../catalog.js';
import { parseResourceId } from '../clients/azure.js';
import { scheduleBody } from '../clients/fabric.js';
import { secretMode } from '../config.js';
import { HttpError } from '../http.js';
import { prepareNotebook, serialiseNotebook } from '../transform/notebook.js';
import { buildPipeline, PIPELINE_CHANGE, PIPELINE_VERSION } from '../transform/pipeline.js';
import { addDays, notebookSecretDays } from './identity.js';
import { dropAttempt, findAttempts, refused, removeRetired, SECRET_SETTLE_MS, withSecretRef } from './secrets.js';

/** @typedef {import('../install.js').Ctx} Ctx */

export const PIPELINE_NAME = 'CopilotAdoptionPipeline';
/** Fabric Lakehouse names can't have spaces. */
export const DEFAULT_LAKEHOUSE_NAME = 'CopilotAnalytics';

/** @param {unknown} err */
const isNotFound = (err) => err instanceof HttpError && (err.status === 404 || err.code === 'ItemNotFound' || err.code === 'WorkspaceNotFound');

/**
 * @param {any[]} items
 * @param {string} name
 */
export const byName = (items, name) => items.find((i) => String(i.displayName).toLowerCase() === name.toLowerCase());

/**
 * `name`, or the first free `name_2`, `name_3`… (a space instead of `_` when the name has spaces).
 * The installer never takes over an item it didn't create, so a clash gets a new name.
 * @param {string} name
 * @param {Iterable<string>} taken  Display names already in the workspace.
 */
export function freeName(name, taken) {
  const used = new Set([...taken].map((t) => String(t).toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const sep = /\s/.test(name) ? ' ' : '_';
  for (let n = 2; ; n++) {
    const candidate = `${name}${sep}${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** @param {any[]} items */
export const displayNames = (items) => items.map((i) => String(i.displayName));

/**
 * Says why an item has a different name from usual.
 * @param {Ctx} ctx
 * @param {string} wanted
 * @param {string} name
 */
export function noteRenamed(ctx, wanted, name) {
  if (name !== wanted) ctx.ui.note(`"${wanted}" is already in the workspace and isn't from this install, so it's left as it is. AI in One's is called "${name}".`);
}

/**
 * A create can answer 201 with the item, or 202 and a result. If neither carries an ID, look it up by name.
 * @param {Ctx} ctx
 * @param {any} created
 * @param {string} type
 * @param {string} name
 * @param {string} [ref]  When given, only the item with this ref in its description counts, not another with the same name.
 * @returns {Promise<string>}
 */
export async function createdId(ctx, created, type, name, ref) {
  if (created?.id) return created.id;
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  const items = await ctx.api.fabric.listItems(ws, type);
  const found = ref ? ownItem(items, name, ref) : byName(items, name);
  if (!found) throw new Error(`Fabric reported that ${name} was created, but it isn't in the workspace.`);
  return found.id;
}

/**
 * The item a run that stopped part-way created for `key`: it has the name that run saved and that
 * run's ref in its description. A name alone isn't enough, since someone else could have made an
 * item with that name after the run stopped.
 * @param {import('../config.js').InstallConfig['fabric']} f
 * @param {string} key
 * @param {any[]} items  The workspace's items of the type.
 */
export function stoppedRunItem(f, key, items) {
  const pending = f.pendingItems?.[key];
  if (!pending?.name || !pending.ref) return undefined;
  return ownItem(items, pending.name, pending.ref);
}

/**
 * The item called `name` with `ref` in its description, among any others with that name.
 * @param {any[]} items
 * @param {string} name
 * @param {string} ref
 */
const ownItem = (items, name, ref) =>
  items.find((i) => String(i.displayName).toLowerCase() === name.toLowerCase() && String(i.description ?? '').includes(itemRef(ref)));

/** How long Fabric may still be creating an item after the run that asked for it stopped. */
export const CREATE_SETTLE_MS = 10 * 60_000;
const CREATE_POLL_MS = 15_000;
/** How many more times a create Fabric says succeeded is looked for in the workspace. */
const SUCCEEDED_POLLS = 8;

/**
 * A run that stopped part-way may have left Fabric still creating its item. Doesn't make a second
 * one while the first may still appear:
 * - If Fabric gave that run an operation, asks it. Failed: a new one is made. Still running after
 *   a wait: stops with an error to run again later, keeping the record. Succeeded: uses the item,
 *   looking for it a little longer as the list can lag; if it's still not there, asks as below.
 * - Otherwise waits until CREATE_SETTLE_MS after that run asked, then asks before making another.
 *   A record with no time for the request asks at once.
 * Only Fabric saying the create failed, or the user agreeing, makes another; with --yes, or a no,
 * the run stops with the record kept, however long ago it was.
 * Returns the item, or undefined when a new one should be made.
 * @param {Ctx} ctx
 * @param {string} key
 * @param {string} type
 */
async function settleStoppedCreate(ctx, key, type) {
  const f = ctx.config.fabric;
  const pending = f.pendingItems?.[key];
  if (!pending?.ref) return undefined;
  const ws = /** @type {string} */ (f.workspaceId);
  const look = async () => stoppedRunItem(f, key, await ctx.api.fabric.listItems(ws, type));
  const status = async () => (pending.operation ? await ctx.api.fabric.operationStatus(pending.operation).catch(() => undefined) : undefined);

  let state = await status();
  if (state === 'NotStarted' || state === 'Running') {
    ctx.ui.info(`The run that stopped had asked Fabric to create ${pending.name}, and Fabric is still working on it. Waiting up to ${CREATE_SETTLE_MS / 60_000} min for it, so there aren't two.`);
    for (let i = 0; i < CREATE_SETTLE_MS / CREATE_POLL_MS && (state === 'NotStarted' || state === 'Running'); i++) {
      await ctx.sleep(CREATE_POLL_MS);
      state = await status();
    }
    if (state === 'NotStarted' || state === 'Running') throw new Error(stillCreating(pending.name));
  }
  // Only Failed says nothing is coming; 'Undefined' is treated as not known.
  if (state === 'Failed') return undefined;
  if (state === 'Succeeded') {
    // The workspace's list can lag the operation.
    for (let i = 0; ; i++) {
      const found = await look();
      if (found) return found;
      if (i === SUCCEEDED_POLLS) break;
      await ctx.sleep(CREATE_POLL_MS);
    }
    ctx.ui.warn(`Fabric says it created ${pending.name} for the run that stopped, but it isn't in the workspace. Someone may have deleted it, or the workspace's list hasn't caught up.`);
  }

  // Not known how that create went: wait out the time Fabric may take, then ask. A record with no
  // time for the request asks at once, and is left as it is.
  const untimed = !pending.at || Number.isNaN(Date.parse(pending.at));
  const left = state === 'Succeeded' || untimed ? 0 : CREATE_SETTLE_MS - (ctx.now().getTime() - Date.parse(/** @type {string} */ (pending.at)));
  if (left > 0) {
    ctx.ui.info(`The run that stopped had asked Fabric to create ${pending.name}. Waiting up to ${Math.ceil(left / 60_000)} min for it to appear, so there aren't two.`);
    for (let i = 0; i < Math.ceil(left / CREATE_POLL_MS); i++) {
      await ctx.sleep(CREATE_POLL_MS);
      const found = await look();
      if (found) return found;
    }
  }
  // However long ago it was: time alone doesn't show Fabric won't still make it. Only Fabric
  // saying it failed, or the user agreeing here, makes another.
  if (state !== 'Succeeded') ctx.ui.warn(`The run that stopped had asked Fabric to create ${pending.name}, and it isn't in the workspace yet. It isn't known whether Fabric will still make it.`);
  if (await ctx.ui.confirm(`Create ${pending.name} again now? If Fabric does still make the first one, there will be two, and the extra one is yours to delete.`, false)) return undefined;
  throw new Error(
    `${pending.name} wasn't created again, so there won't be two. ` +
      (state === 'Succeeded' ? 'Check the workspace: if it is there, run the installer again and it is used. ' : 'Run the installer again later: it uses that item if Fabric made it. ') +
      `If it never appears, run the installer again without --yes and answer yes to create it.`,
  );
}

/** @param {string} name */
const stillCreating = (name) => `Fabric is still creating ${name}. Run the installer again in a few minutes: it uses that item rather than making another.`;

/** The text a create adds to the item's description, so a later run can tell the item is its own. @param {string} ref */
export const itemRef = (ref) => `(ref ${ref})`;

/**
 * Which of the install's models `m` is, for keys that stay the same when the model's name changes.
 * AI in One has one model.
 * @param {import('../config.js').InstallConfig} _config
 * @param {import('../config.js').ModelConfig} _m
 */
export const modelKey = (_config, _m) => 'main';

/**
 * Creates a workspace item so that a run stopped part-way through doesn't leave a stray copy. The
 * name and a random ref are saved as pending before the create, and the ref goes in the item's
 * description. If the run stops before the ID is saved, the next run finds the item by both and
 * uses it instead of making a second one. Any other clash still gets a new name, since the
 * installer never takes over an item it didn't create.
 * The caller saves the record with the ID it gets back, which also clears the pending entry.
 * @param {Ctx} ctx
 * @param {string} key  Unique per item in the install and stable between runs, e.g. `Notebook:auditIngester`.
 * @param {string} type  The Fabric item type, for looking the item up by name.
 * @param {string} wanted
 * @param {any[]} items  The workspace's items of this type.
 * If Fabric doesn't answer in time, the pending entry stays, with Fabric's operation if it gave
 * one, and the next run waits for that create rather than making another.
 * @param {(name: string, ref: import('../clients/fabric.js').ItemRef) => Promise<any>} create  `ref` goes at the end of the item's description.
 * @returns {Promise<{ id: string, name: string, resumed: boolean }>}
 */
export async function createItem(ctx, key, type, wanted, items, create) {
  const f = ctx.config.fabric;
  const found = stoppedRunItem(f, key, items) ?? (await settleStoppedCreate(ctx, key, type));
  if (found) {
    clearPending(f, key);
    ctx.ui.note(`Using ${found.displayName}, which the run that stopped part-way created.`);
    return { id: found.id, name: String(found.displayName), resumed: true };
  }
  const fresh = f.pendingItems?.[key] ? await ctx.api.fabric.listItems(/** @type {string} */ (f.workspaceId), type) : items;
  const name = freeName(wanted, displayNames(fresh));
  noteRenamed(ctx, wanted, name);
  const ref = randomBytes(6).toString('hex');
  /** @type {NonNullable<typeof f.pendingItems>[string]} */
  const pending = { name, ref, at: ctx.now().toISOString() };
  (f.pendingItems ??= {})[key] = pending;
  ctx.save();
  let created;
  try {
    created = await create(name, {
      text: itemRef(ref),
      onAccepted: (url) => {
        pending.operation = url;
        ctx.save();
      },
    });
  } catch (err) {
    // Fabric turned the create down outright, so there's nothing to wait for next time.
    if (!pending.operation && refused(err)) {
      clearPending(f, key);
      ctx.save();
    }
    throw err;
  }
  const id = await createdId(ctx, created, type, name, ref);
  clearPending(f, key);
  return { id, name, resumed: false };
}

/**
 * @param {import('../config.js').InstallConfig['fabric']} f
 * @param {string} key
 */
export function clearPending(f, key) {
  if (!f.pendingItems) return;
  delete f.pendingItems[key];
  if (!Object.keys(f.pendingItems).length) delete f.pendingItems;
}

/**
 * Whether the workspace an install record points at is gone, so the record is stale. Only a
 * definite answer counts: Fabric says it isn't there, or the record is for another tenant. A 403,
 * a network error or anything else returns null, and the record is used as it is.
 * @param {{ config: import('../config.js').InstallConfig, fabric: { getWorkspace: (id: string) => Promise<any> }, tenantId?: string }} o
 * @returns {Promise<{ workspace: string, reason: 'not-found' | 'other-tenant' } | null>}
 */
export async function recordWorkspaceGone({ config, fabric, tenantId }) {
  const f = config.fabric;
  if (!f?.workspaceId) return null;
  const workspace = f.workspaceName ?? f.workspaceId;
  if (config.tenantId && tenantId && config.tenantId.toLowerCase() !== tenantId.toLowerCase()) return { workspace, reason: 'other-tenant' };
  try {
    await fabric.getWorkspace(f.workspaceId);
    return null;
  } catch (err) {
    return isNotFound(err) && /** @type {HttpError} */ (err).status !== 403 ? { workspace, reason: 'not-found' } : null;
  }
}

/**
 * Says why the install record is stale.
 * @param {{ workspace: string, reason: 'not-found' | 'other-tenant' }} gone
 */
export const staleRecordMessage = (gone) =>
  gone.reason === 'other-tenant'
    ? `The install record is for workspace "${gone.workspace}" in another tenant, not the one you signed in to.`
    : `This workspace no longer exists: "${gone.workspace}".`;

/** @param {Ctx} ctx */
export async function ensureWorkspace(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (f.workspaceId) {
    /** @type {any} */
    let ws;
    try {
      ws = await api.fabric.getWorkspace(f.workspaceId);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      throw new Error(`Workspace ${f.workspaceName ?? f.workspaceId} no longer exists, or you can't see it. Remove "workspaceId" from the install record to create a new one.`);
    }
    f.workspaceName = ws.displayName;
    if (!ws.capacityId) {
      await api.fabric.assignToCapacity(ws.id, /** @type {string} */ (f.capacityId));
      ui.ok(`Workspace "${ws.displayName}", now on your Fabric capacity`);
    } else {
      if (f.capacityId && ws.capacityId.toLowerCase() !== f.capacityId.toLowerCase()) {
        ui.note(`"${ws.displayName}" is already on another capacity, so it stays there.`);
      }
      f.capacityId = ws.capacityId;
      ui.ok(`Workspace "${ws.displayName}"`);
    }
  } else {
    if (!f.workspaceName || !f.capacityId) throw new Error('Workspace settings are incomplete. Run the installer without --yes to choose them.');
    const ws = await api.fabric.createWorkspace(f.workspaceName, f.capacityId);
    f.workspaceId = ws.id;
    f.createdWorkspace = true;
    ui.ok(`Created workspace "${ws.displayName}"`);
  }
  ctx.save();
}

/**
 * Whether a Lakehouse has schemas turned on. Fabric returns `properties.defaultSchema` only for a
 * schema-enabled Lakehouse (https://learn.microsoft.com/rest/api/fabric/lakehouse/items/get-lakehouse),
 * and schemas can only be turned on when one is created, with `creationPayload.enableSchemas`
 * (https://learn.microsoft.com/rest/api/fabric/lakehouse/items/create-lakehouse).
 * @param {any} lakehouse  The Lakehouse as Fabric's Get Lakehouse returns it.
 */
export const hasSchemas = (lakehouse) => !!lakehouse?.properties?.defaultSchema;

/** Why a Lakehouse without schemas can't be used. @param {string} name */
export const noSchemasMessage = (name) =>
  `The Lakehouse "${name}" doesn't have schemas turned on. AI in One's notebooks write their tables to its dbo schema, and without schemas every notebook fails with "System cancelled the Spark session". ` +
  'Choose another Lakehouse, or create a new one: schemas can only be turned on when a Lakehouse is created.';

/** @param {Ctx} ctx */
export async function ensureLakehouse(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  if (f.lakehouseId) {
    /** @type {any} */
    let lh;
    try {
      lh = await api.fabric.getLakehouse(ws, f.lakehouseId);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      if (f.existingLakehouse) {
        throw new Error(`The Lakehouse "${f.lakehouseName ?? f.lakehouseId}" you chose is gone, or you can't see it. Run the installer again without --yes and choose another one.`);
      }
      ui.warn('The Lakehouse in the install record is gone. Setting it up again.');
      delete f.lakehouseId;
    }
    if (lh) {
      if (!hasSchemas(lh)) throw new Error(noSchemasMessage(lh.displayName));
      f.lakehouseName = lh.displayName;
      ui.ok(`Lakehouse "${lh.displayName}"${f.existingLakehouse ? ' (yours)' : ''}`);
      ctx.save();
      return;
    }
  }
  const wanted = f.lakehouseName ?? DEFAULT_LAKEHOUSE_NAME;
  const made = await createItem(ctx, 'Lakehouse', 'Lakehouse', wanted, await api.fabric.listItems(ws, 'Lakehouse'), (name, ref) => api.fabric.createLakehouse(ws, name, ref));
  f.lakehouseId = made.id;
  f.lakehouseName = made.name;
  delete f.existingLakehouse;
  ui.ok(`${made.resumed ? 'Found' : 'Created'} Lakehouse "${made.name}"`);
  ctx.save();
}

export const ENDPOINT_POLL_MS = 15_000;
const ENDPOINT_MAX_POLLS = 80;

/** Fabric allows up to 64 characters. @param {string} vaultName */
export const endpointName = (vaultName) => `ai-in-one-${vaultName}`.slice(0, 64);

/**
 * Shown to whoever approves the request on the vault. It carries the workspace ID so
 * the installer can tell its own request from others.
 * @param {string} workspaceId
 */
export const endpointRequest = (workspaceId) => `AI in One: Fabric workspace ${workspaceId} reads the app secret.`;

/**
 * Whether a private endpoint connection on the vault comes from this workspace. Fabric names
 * the endpoint "<workspace ID>.<endpoint name>", and the description carries the workspace ID.
 * The endpoint name alone is the same for every workspace that reads the vault.
 * @param {any} conn
 * @param {string} workspaceId
 */
export const fromWorkspace = (conn, workspaceId) =>
  [conn.name, conn.properties?.privateEndpoint?.id, conn.properties?.privateLinkServiceConnectionState?.description].some((s) =>
    String(s ?? '').toLowerCase().includes(workspaceId.toLowerCase()),
  );

/** @param {string | undefined} a @param {string | undefined} b */
const sameResource = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Polls a managed private endpoint until `done`, for up to 20 minutes.
 * @param {Ctx} ctx
 * @param {any} endpoint
 * @param {(e: any) => boolean} done
 * @param {string} waiting  e.g. "Fabric is provisioning the private endpoint"
 */
async function pollEndpoint(ctx, endpoint, done, waiting) {
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  let e = endpoint;
  for (let i = 0; !done(e); i++) {
    if (i === ENDPOINT_MAX_POLLS) throw new Error(`${waiting} for more than 20 minutes. Run the installer again later to carry on.`);
    if (i === 0) ctx.ui.info(`${waiting}. This usually takes a few minutes.`);
    await ctx.sleep(ENDPOINT_POLL_MS);
    e = await ctx.api.fabric.getPrivateEndpoint(ws, e.id);
  }
  return e;
}

/**
 * Approves the workspace's request on the vault. Returns true once the vault shows it
 * approved, false if the request hasn't arrived or the user may not approve it.
 * @param {Ctx} ctx
 */
async function approveOnVault(ctx) {
  const { ui, api, config } = ctx;
  const kv = config.keyVault;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  for (let i = 0; i < 8; i++) {
    const mine = (await api.arm.listPrivateEndpointConnections(/** @type {string} */ (kv.id))).filter((conn) => fromWorkspace(conn, ws));
    if (mine.some((conn) => conn.properties?.privateLinkServiceConnectionState?.status === 'Approved')) return true;
    const pending = mine.filter((conn) => conn.properties?.privateLinkServiceConnectionState?.status === 'Pending');
    if (pending.length) {
      try {
        for (const conn of pending) await api.arm.approvePrivateEndpointConnection(conn.id, `Approved by the AI in One installer for Fabric workspace ${ws}.`);
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return false;
        throw err;
      }
      ui.ok(`Approved the workspace's private endpoint on ${kv.name}`);
      return true;
    }
    await ctx.sleep(ENDPOINT_POLL_MS);
  }
  return false;
}

/**
 * Fabric can only read a vault that blocks public access through a managed private
 * endpoint. Creates one from the workspace, approves it on the vault, and waits until
 * notebooks can use it. Returns false if it isn't approved yet.
 * @param {Ctx} ctx
 */
export async function ensureVaultEndpoint(ctx) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  const f = config.fabric;
  if (secretMode(config) === 'notebook' || !kv.private) return true;
  const ws = /** @type {string} */ (f.workspaceId);
  const vaultId = /** @type {string} */ (kv.id);

  let endpoint = (await api.fabric.listPrivateEndpoints(ws)).find((e) => sameResource(e.targetPrivateLinkResourceId, vaultId));
  if (!endpoint) {
    const { subscriptionId } = parseResourceId(vaultId);
    if (await api.arm.ensureProvider(subscriptionId, 'Microsoft.Network')) ui.ok('Registered the Microsoft.Network resource provider');
    try {
      endpoint = await api.fabric.createPrivateEndpoint(ws, {
        name: endpointName(/** @type {string} */ (kv.name)),
        targetPrivateLinkResourceId: vaultId,
        targetSubresourceType: 'vault',
        requestMessage: endpointRequest(ws),
      });
    } catch (err) {
      throw new Error(
        `Fabric couldn't create a managed private endpoint to ${kv.name} (${/** @type {Error} */ (err).message}). ` +
          'They need an F or trial capacity in a region where Fabric Data Engineering runs.',
      );
    }
    ui.ok(`Created a managed private endpoint from the workspace to ${kv.name}`);
  }
  f.vaultEndpointId = endpoint.id;
  ctx.save();

  endpoint = await pollEndpoint(ctx, endpoint, (e) => !['Provisioning', 'Updating'].includes(e.provisioningState), 'Fabric is provisioning the private endpoint');
  if (endpoint.provisioningState === 'Failed') {
    throw new Error(`The managed private endpoint to ${kv.name} failed to provision. Delete it under the workspace's Network security settings, then run the installer again.`);
  }

  for (;;) {
    const status = endpoint.connectionState?.status;
    if (status === 'Approved') {
      ui.ok(`The workspace reaches ${kv.name} through a managed private endpoint`);
      return true;
    }
    if (status === 'Rejected' || status === 'Disconnected') {
      throw new Error(`The private endpoint to ${kv.name} was ${status.toLowerCase()}. Delete it under the workspace's Network security settings, then run the installer again.`);
    }
    if (await approveOnVault(ctx)) {
      endpoint = await pollEndpoint(ctx, endpoint, (e) => e.connectionState?.status !== 'Pending', 'Waiting for Fabric to see the approval');
      continue;
    }
    ui.warn(`The workspace's private endpoint request is waiting for approval on ${kv.name}.`);
    ui.info('Someone who manages the vault can approve it under Networking, Private endpoint connections:');
    ui.info(`https://portal.azure.com/#@${ctx.user.tenantId}/resource${vaultId}/networking`);
    if (ui.yes) {
      ui.warn('Carrying on. Data loads will fail until it is approved.');
      return false;
    }
    const next = await ui.select(
      'Once it is approved:',
      [
        { name: 'Check again', value: 'check' },
        { name: 'Carry on without it (skip the first load for now)', value: 'skip' },
      ],
      'check',
    );
    if (next === 'skip') return false;
    endpoint = await api.fabric.getPrivateEndpoint(ws, endpoint.id);
  }
}

/** Stands in for the client secret when there is no value to write, e.g. in a preview. */
export const SECRET_PLACEHOLDER = '<client secret>';

/**
 * Notebooks that hold or read the app's client secret.
 * @param {import('../catalog.js').NotebookInfo} nb
 */
export const usesSecret = (nb) => nb.credentials;

/**
 * What the installer changes in one notebook.
 * @param {Ctx} ctx
 * @param {import('../catalog.js').NotebookInfo} nb
 * @returns {import('../transform/notebook.js').NotebookSettings}
 */
export function notebookSettings(ctx, nb) {
  const { config, user } = ctx;
  const f = config.fabric;
  const inline = secretMode(config) === 'notebook';
  const value = ctx.pendingSecret ?? SECRET_PLACEHOLDER;
  /** @type {Record<string, string> | undefined} */
  let values = nb.values;
  if (nb.key === 'refreshModel') values = { WORKSPACE_ID: /** @type {string} */ (f.workspaceId), SEMANTIC_MODEL_ID: /** @type {string} */ (config.semanticModel.id) };
  return {
    ...(nb.credentials
      ? {
          tenantId: user.tenantId,
          clientId: config.app.appId,
          secret: inline ? { value } : { vaultUri: /** @type {string} */ (config.keyVault.uri), secretName: config.keyVault.secretName },
        }
      : {}),
    parameters: nb.parameters,
    ...(values ? { values } : {}),
    ...(nb.expressions ? { expressions: nb.expressions } : {}),
    patches: nb.patches,
    lakehouse: {
      id: /** @type {string} */ (f.lakehouseId),
      name: /** @type {string} */ (f.lakehouseName),
      workspaceId: /** @type {string} */ (f.workspaceId),
    },
    dataCheckSummary: nb.key === 'dataCheck',
  };
}

/**
 * Notebook options that follow the install: the refresh notebook comes with the semantic model.
 * @param {import('../config.js').InstallConfig} config
 */
export const notebookOptions = (config) => ({ semanticModel: modelDeployed(config) });

/**
 * @param {Ctx} ctx
 * @param {{ force?: boolean, rotate?: boolean }} [opts]  `force` pushes fresh content to notebooks that already exist.
 *   `rotate`: with no Key Vault, give the notebooks a new client secret and remove the old one, so each install or repair replaces it.
 */
export async function ensureNotebooks(ctx, opts = {}) {
  const { ui, config, api, sources } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  const items = await api.fabric.listItems(ws, 'Notebook');
  const ids = new Set(items.map((i) => i.id));
  const wanted = notebooksFor(config.modules, notebookOptions(config));
  // The notebooks that read the secret are rewritten when it moves into or out of them.
  const inNotebooks = secretMode(config) === 'notebook';
  const switched = !!f.secretInNotebooks !== inNotebooks;
  // An app the user brought has a secret they paste, so the installer can't replace it.
  const rotate = !!opts.rotate && inNotebooks && !config.app.existing;

  /** @param {import('../catalog.js').NotebookInfo} nb */
  const stale = (nb) => {
    const id = f.notebooks[nb.key];
    return !id || !ids.has(id) || !!opts.force || (switched && usesSecret(nb)) || (rotate && usesSecret(nb));
  };
  // With the secret in the notebooks, writing one means a fresh secret, so all of them get it.
  const inline = inNotebooks && wanted.some((nb) => usesSecret(nb) && stale(nb));
  if (inline) await refuseGitSync(ctx);
  const fresh = inline ? await inlineSecret(ctx) : undefined;
  let written = 0;

  try {
    for (const nb of wanted) {
      const content = serialiseNotebook(prepareNotebook(sources.notebooks[nb.key], notebookSettings(ctx, nb)));
      // Notebooks are updated when this checkout's version differs, so running the installer again
      // from a newer release pushes their fixes. Not those holding an inline secret: their content
      // changes with each secret, and writing them needs a fresh one.
      const hash = inNotebooks && usesSecret(nb) ? undefined : createHash('sha256').update(content).digest('hex').slice(0, 16);
      f.notebookHashes ??= {};
      f.notebookNames ??= {};
      let id = f.notebooks[nb.key];
      // Older records saved only the ID: keep the name the notebook already has.
      const current = id ? items.find((i) => i.id === id)?.displayName : undefined;
      if (current && !f.notebookNames[nb.key]) f.notebookNames[nb.key] = current;
      const label = f.notebookNames[nb.key] ?? nb.displayName;
      if (id && !ids.has(id)) {
        ui.warn(`${label} was deleted. Deploying it again.`);
        id = undefined;
        // The pipeline calls notebooks by ID, so it has to be rewritten for the new one.
        delete f.pipelineModules;
      }
      if (!id) {
        const made = await createItem(ctx, `Notebook:${nb.key}`, 'Notebook', label, items, (name, ref) => api.fabric.createNotebook(ws, name, content, ref));
        id = made.id;
        f.notebookNames[nb.key] = made.name;
        // A notebook the stopped run created may hold its secret or older settings.
        if (made.resumed) await api.fabric.updateNotebook(ws, id, content);
        else items.push({ id, displayName: made.name });
        if (usesSecret(nb)) written++;
        ui.ok(`${made.resumed ? 'Updated' : 'Created'} ${made.name}`);
      } else if (
        opts.force ||
        (inline && usesSecret(nb)) ||
        (switched && usesSecret(nb)) ||
        (hash !== undefined && hash !== f.notebookHashes[nb.key])
      ) {
        await api.fabric.updateNotebook(ws, id, content);
        if (usesSecret(nb)) written++;
        ui.ok(`Updated ${label}`);
      } else {
        ui.ok(`${label} is in place`);
      }
      f.notebooks[nb.key] = id;
      if (hash !== undefined) f.notebookHashes[nb.key] = hash;
      ctx.save();
    }
  } catch (err) {
    if (fresh) await settleInlineSecret(ctx, fresh, written > 0 ? 'partial' : 'unused');
    throw err;
  }
  if (fresh) await settleInlineSecret(ctx, fresh, 'written');
  if (switched) {
    if (inNotebooks) f.secretInNotebooks = true;
    else {
      delete f.secretInNotebooks;
      await retireInlineSecrets(ctx);
    }
    ctx.save();
  }
}

/**
 * Once the notebooks read the secret from Key Vault, removes the secrets that were written
 * into them, since anyone who saw the notebooks could still use those.
 * @param {Ctx} ctx
 */
async function retireInlineSecrets(ctx) {
  const { ui, config } = ctx;
  const app = config.app;
  await settleSecretAttempts(ctx);
  const keyIds = [...(app.retiredSecretKeyIds ?? []), ...(app.pendingSecretKeyIds ?? []), ...(app.secretKeyId ? [app.secretKeyId] : [])];
  if (!keyIds.length) {
    if (app.existing) ui.warn(`The client secret that was in the notebooks still works. Delete it from ${app.displayName ?? 'the app'}'s Certificates & secrets page.`);
    return;
  }
  // Saved as to-remove first, so a run that stops part-way still knows to remove them.
  app.retiredSecretKeyIds = [...new Set(keyIds)];
  delete app.pendingSecretKeyIds;
  delete app.secretKeyId;
  ctx.save();
  await removeKeys(ctx, keyIds);
  if (!app.retiredSecretKeyIds?.length) ui.ok('Removed the client secret that was in the notebooks from the app');
}

/**
 * Removes app secrets by key ID. Each one stays in the install record's to-remove list until
 * Entra confirms it's gone, or the app no longer lists it, so a run that fails or stops part-way
 * tries the rest again.
 * @param {Ctx} ctx
 * @param {string[]} keyIds
 */
async function removeKeys(ctx, keyIds) {
  const app = ctx.config.app;
  app.retiredSecretKeyIds = [...new Set([...(app.retiredSecretKeyIds ?? []), ...keyIds])];
  ctx.save();
  await removeRetired(ctx, app, app.objectId);
}

/**
 * Stops before a client secret is written into notebooks that Git integration would commit to a
 * repository. When the workspace's Git connection can't be read, it warns and carries on.
 * @param {Ctx} ctx
 */
async function refuseGitSync(ctx) {
  const { ui, config, api } = ctx;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const git = await Promise.resolve()
    .then(() => api.fabric.getGitConnection(ws))
    .catch(() => undefined);
  if (!git) {
    ui.warn('Couldn\'t check whether the workspace is connected to Git. If it is, don\'t commit the notebooks: the client secret is in them.');
    return;
  }
  if (git.gitConnectionState && git.gitConnectionState !== 'NotConnected') {
    throw new Error(
      'This workspace is connected to Git, so the client secret in the notebooks would be committed to the repository. ' +
        'Disconnect it under Workspace settings > Git integration, or run the installer again and choose Key Vault.',
    );
  }
}

/**
 * The client secret to write into the notebooks. A new one on the app, unless the app is one
 * the user brought (they paste its secret) or they already pasted it this run. Held only in memory.
 * @param {Ctx} ctx
 * @returns {Promise<{ keyId?: string, endDateTime?: string, previousKeyId?: string }>}
 */
export async function inlineSecret(ctx) {
  const { ui, config, api } = ctx;
  const app = config.app;
  if (ctx.pendingSecret) return {};
  if (app.existing) {
    ctx.pendingSecret = await ui.secret(`Client secret value for ${app.displayName ?? app.appId}. It is written into the notebooks.`);
    return {};
  }
  if (!app.objectId) throw new Error('No app registration to add a secret to.');
  await settleSecretAttempts(ctx);
  // Saved before asking Entra, and in the secret's name, so a run that stops before the key ID is
  // saved leaves a way to find that exact secret.
  const ref = randomBytes(6).toString('hex');
  app.secretAttempts = [...(app.secretAttempts ?? []), { ref, at: ctx.now().toISOString() }];
  ctx.save();
  let credential;
  try {
    credential = await api.graph.addPassword(app.objectId, addDays(ctx.now(), notebookSecretDays(config)), secretLabel(ref));
  } catch (err) {
    // Entra turned the request down, so there's no secret to look for later.
    if (refused(err)) {
      dropAttempt(app, ref);
      ctx.save();
    }
    throw err;
  }
  ctx.pendingSecret = credential.secretText;
  // Saved before any notebook gets it, so a run that stops part-way still knows to remove it.
  app.pendingSecretKeyIds = [...new Set([...(app.pendingSecretKeyIds ?? []), credential.keyId])];
  dropAttempt(app, ref);
  ctx.save();
  ui.ok(`Created a client secret for the notebooks (expires ${credential.endDateTime.slice(0, 10)})`);
  return { keyId: credential.keyId, endDateTime: credential.endDateTime, previousKeyId: app.secretKeyId };
}

/**
 * After the notebooks are written: keep the new secret and remove the one they used before.
 * If the writes stopped part-way, both stay so every notebook still signs in.
 * @param {Ctx} ctx
 * @param {{ keyId?: string, endDateTime?: string, previousKeyId?: string }} fresh
 * @param {'written' | 'partial' | 'unused'} outcome
 */
async function settleInlineSecret(ctx, fresh, outcome) {
  const { ui, config, api } = ctx;
  const app = config.app;
  delete ctx.pendingSecret;
  const objectId = /** @type {string} */ (app.objectId);
  if (!fresh.keyId) {
    if (outcome !== 'unused') config.keyVault.secretSetAt = ctx.now().toISOString();
    ctx.save();
    return;
  }
  if (outcome === 'unused') {
    const removed = await api.graph.removePassword(objectId, fresh.keyId).then(
      () => true,
      () => false,
    );
    if (!removed) {
      // No notebook has it, so it's kept to remove with the other old secrets on a later run.
      ui.warn(`Delete the unused client secret (key ${fresh.keyId}) from the app's Certificates & secrets page, or run the update again.`);
      app.retiredSecretKeyIds = [...new Set([...(app.retiredSecretKeyIds ?? []), fresh.keyId])];
    }
    dropPending(app, [fresh.keyId]);
    ctx.save();
    return;
  }
  app.secretKeyId = fresh.keyId;
  app.secretExpires = fresh.endDateTime;
  config.keyVault.secretSetAt = ctx.now().toISOString();
  const previous = fresh.previousKeyId && fresh.previousKeyId !== fresh.keyId ? fresh.previousKeyId : undefined;
  if (outcome === 'partial') {
    // Kept in the record, so the run that finishes the notebooks removes it. Secrets from runs
    // that stopped earlier stay pending: some notebooks may still have them.
    dropPending(app, [fresh.keyId]);
    if (previous) app.retiredSecretKeyIds = [...new Set([...(app.retiredSecretKeyIds ?? []), previous])];
    ctx.save();
    if (previous) ui.warn(`Some notebooks still use the previous client secret (key ${previous}), so it stays on the app. Run the update again to finish.`);
    return;
  }
  // Every notebook now has the new secret, so the previous one and those from runs that stopped
  // part-way can go. They move to the to-remove list in the same save that clears them as
  // pending, and leave it only once Entra confirms each is removed.
  const stale = [...(app.retiredSecretKeyIds ?? []), ...(previous ? [previous] : []), ...(app.pendingSecretKeyIds ?? [])].filter((k) => k !== fresh.keyId);
  delete app.pendingSecretKeyIds;
  if (stale.length) app.retiredSecretKeyIds = [...new Set(stale)];
  ctx.save();
  if (!stale.length) return;
  await removeKeys(ctx, stale);
  if (!app.retiredSecretKeyIds?.length) ui.ok(`Removed the previous client secret${new Set(stale).size > 1 ? 's' : ''} from the app`);
}

/** What a notebook secret is called on the app, before the ref. */
const NOTEBOOK_SECRET_LABEL = 'AI in One installer';

/** The name a notebook secret gets on the app, with the ref of the run that asked for it. @param {string} ref */
export const secretLabel = (ref) => withSecretRef(NOTEBOOK_SECRET_LABEL, ref);

export { SECRET_SETTLE_MS };

/**
 * Finds notebook secrets a run asked Entra for but stopped before saving the key ID. A notebook
 * secret's key ID is saved before any notebook gets the value, so none has these: each is
 * recorded to remove and removed. Matched only by the exact name with that run's ref. More than
 * one match is left alone with a warning.
 * @param {Ctx} ctx
 */
export async function settleSecretAttempts(ctx) {
  const { ui, config } = ctx;
  const app = config.app;
  if (!app.secretAttempts?.length || !app.objectId) return;
  const remove = await findAttempts(ctx, app, app.objectId, NOTEBOOK_SECRET_LABEL);
  // Recorded to remove in the same save that drops the attempts.
  if (remove.length) app.retiredSecretKeyIds = [...new Set([...(app.retiredSecretKeyIds ?? []), ...remove])];
  ctx.save();
  if (!remove.length) return;
  await removeKeys(ctx, remove);
  if (!remove.some((k) => app.retiredSecretKeyIds?.includes(k))) ui.ok('Removed a client secret a stopped run added but never used');
}

/**
 * @param {import('../config.js').InstallConfig['app']} app
 * @param {string[]} keyIds
 */
function dropPending(app, keyIds) {
  if (!app.pendingSecretKeyIds) return;
  app.pendingSecretKeyIds = app.pendingSecretKeyIds.filter((k) => !keyIds.includes(k));
  if (!app.pendingSecretKeyIds.length) delete app.pendingSecretKeyIds;
}

/**
 * What the pipeline definition is built from. A change means the deployed pipeline is out of date.
 * @param {import('../config.js').InstallConfig} config
 */
export function pipelineSignature(config) {
  const parts = [enabledModules(config.modules).join(',')];
  if (modelDeployed(config)) parts.push(`model=${config.semanticModel.id}`);
  if (config.scale) parts.push(`scale=${config.scale}`);
  return parts.join(';');
}

/**
 * The semantic model is switched on, exists and reads the Lakehouse, so the pipeline can refresh it.
 * @param {import('../config.js').InstallConfig} config
 */
export const modelDeployed = (config) => !!(config.semanticModel?.enabled && config.semanticModel.id && config.semanticModel.bound);

/**
 * What the pipeline is built from, for this install.
 * @param {import('../config.js').InstallConfig} config
 * @returns {import('../transform/pipeline.js').PipelineSettings}
 */
export function pipelineSettings(config) {
  const f = config.fabric;
  return {
    workspaceId: /** @type {string} */ (f.workspaceId),
    scale: config.scale,
    notebookIds: f.notebooks,
    modules: config.modules,
    backfillDays: config.history.days,
    semanticModelId: modelDeployed(config) ? config.semanticModel.id : undefined,
  };
}

/** Where the setting that lets pipeline notebooks share a Spark session lives. */
export const HIGH_CONCURRENCY_PATH =
  'Workspace settings > Data Engineering/Science > Spark settings > High concurrency > "For pipeline running multiple notebooks"';

/**
 * Lets the pipeline's notebooks share one Spark session, so a run starts a session once instead
 * of once per notebook. That is what used to fill a small capacity (error 430).
 * @param {Ctx} ctx
 */
export async function ensureSparkSettings(ctx) {
  const { ui, config, api } = ctx;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  try {
    const settings = await api.fabric.getSparkSettings(ws);
    if (settings?.highConcurrency?.notebookPipelineRunEnabled === true) {
      ui.ok('Pipeline notebooks share one Spark session');
      return;
    }
    await api.fabric.updateSparkSettings(ws, { highConcurrency: { notebookPipelineRunEnabled: true } });
    ui.ok('Turned on high concurrency for pipelines, so the pipeline\'s notebooks share one Spark session');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    ui.warn(
      err.status === 403
        ? 'Couldn\'t turn on high concurrency for pipelines: that needs the workspace Admin role.'
        : `Couldn't turn on high concurrency for pipelines: ${err.message}`,
    );
    ui.note(`Each notebook will start its own Spark session, which can fill a small capacity. A workspace admin can turn it on: ${HIGH_CONCURRENCY_PATH}.`);
  }
}

/**
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
export async function ensurePipeline(ctx, opts = {}) {
  const { ui, config, api, sources } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  const definition = buildPipeline(sources.pipeline, pipelineSettings(config));
  const signature = pipelineSignature(config);
  const items = await api.fabric.listItems(ws, 'DataPipeline');

  const current = f.pipelineId ? items.find((i) => i.id === f.pipelineId) : undefined;
  if (current && !f.pipelineName) f.pipelineName = current.displayName;
  if (f.pipelineId && !current) {
    ui.warn(`${f.pipelineName ?? PIPELINE_NAME} was deleted. Creating it again.`);
    delete f.pipelineId;
    delete f.scheduleId;
  }

  if (!f.pipelineId) {
    const made = await createItem(ctx, 'DataPipeline', 'DataPipeline', f.pipelineName ?? PIPELINE_NAME, items, (name, ref) => api.fabric.createPipeline(ws, name, definition, ref));
    f.pipelineId = made.id;
    f.pipelineName = made.name;
    if (made.resumed) {
      await api.fabric.updatePipeline(ws, made.id, definition);
      ui.ok(`Updated pipeline ${made.name}`);
    } else ui.ok(`Created pipeline ${made.name}`);
  } else if (opts.force || f.pipelineModules !== signature || f.pipelineVersion !== PIPELINE_VERSION) {
    if (f.pipelineVersion !== PIPELINE_VERSION) ui.note(PIPELINE_CHANGE);
    ui.note('This replaces the pipeline definition, including any activities you added to it yourself.');
    if (await ui.confirm(`Update ${f.pipelineName ?? PIPELINE_NAME}?`, true)) {
      await api.fabric.updatePipeline(ws, f.pipelineId, definition);
      ui.ok(`Updated pipeline ${f.pipelineName ?? PIPELINE_NAME}`);
    } else {
      ui.warn('Left the pipeline as it was. It keeps running the old definition until it is updated.');
      return;
    }
  } else {
    ui.ok(`Pipeline ${f.pipelineName ?? PIPELINE_NAME} is in place`);
  }
  f.pipelineModules = signature;
  f.pipelineVersion = PIPELINE_VERSION;
  ctx.save();
}

/**
 * @param {any} existing  A schedule from the API.
 * @param {ReturnType<typeof scheduleBody>} wanted
 */
export function sameSchedule(existing, wanted) {
  const a = existing?.configuration ?? {};
  const b = wanted.configuration;
  const list = (/** @type {any} */ v) => JSON.stringify([...(v ?? [])].sort());
  return (
    existing?.enabled === true &&
    a.type === b.type &&
    a.localTimeZoneId === b.localTimeZoneId &&
    list(a.times) === list(b.times) &&
    (b.type !== 'Weekly' || list(a.weekdays) === list(b.weekdays))
  );
}

/** @param {import('../config.js').InstallConfig['schedule']} s */
export function describeSchedule(s) {
  return `${s.frequency === 'weekly' ? `every ${s.weekday}` : 'daily'} at ${s.time} ${s.timeZone}`;
}

/** @param {Ctx} ctx */
export async function ensureSchedule(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  const pipelineId = /** @type {string} */ (f.pipelineId);
  const wanted = scheduleBody(config.schedule, ctx.now());
  const schedules = await api.fabric.listSchedules(ws, pipelineId);
  const mine = schedules.find((s) => s.id === f.scheduleId);

  if (mine) {
    if (sameSchedule(mine, wanted)) {
      ui.ok(`Schedule: ${describeSchedule(config.schedule)}`);
      return;
    }
    await api.fabric.updateSchedule(ws, pipelineId, mine.id, wanted);
    ui.ok(`Updated the schedule: ${describeSchedule(config.schedule)}`);
    return;
  }
  if (schedules.length) {
    f.scheduleId = schedules[0].id;
    ctx.save();
    ui.note('The pipeline already has a schedule, so it was left as it is.');
    return;
  }
  const created = await api.fabric.createSchedule(ws, pipelineId, wanted);
  f.scheduleId = created?.id;
  ctx.save();
  ui.ok(`Scheduled ${describeSchedule(config.schedule)}`);
}
