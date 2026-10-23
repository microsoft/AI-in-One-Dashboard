// @ts-check
/**
 * Uninstall on Fabric. A workspace the installer created goes, with everything in it: its managed
 * private endpoints first, which Fabric won't delete a workspace without. In a workspace the user
 * already had, only what the installer created there goes, and the workspace stays. Then the
 * model's SQL connection, which lives outside the workspace, and, if the user agrees, the app
 * registration the installer created.
 */
import { secretMode } from '../config.js';
import { NOTEBOOKS } from '../catalog.js';
import { HttpError } from '../http.js';
import { PIPELINE_NAME } from './fabric.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {{ kind: string, name: string, id: string }} CreatedItem */

/** How often, and how many times, to check the private endpoints have gone: ten minutes in all. */
export const ENDPOINT_POLL_MS = 10_000;
const ENDPOINT_POLLS = 60;

/** @param {unknown} err */
const gone = (err) => err instanceof HttpError && err.status === 404;

/** @param {unknown} err */
const reason = (err) => /** @type {Error} */ (err).message;

/**
 * "a", "a and b", "a, b and c".
 * @param {string[]} items
 */
const listOf = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * Deletes the workspace's managed private endpoints and waits until Fabric has removed them.
 * @param {Ctx} ctx
 * @param {string} workspaceId
 * @returns {Promise<number>}  How many there were.
 */
export async function deletePrivateEndpoints(ctx, workspaceId) {
  const { ui, api } = ctx;
  const list = async () => {
    try {
      return await api.fabric.listPrivateEndpoints(workspaceId);
    } catch (err) {
      if (gone(err)) return [];
      throw err;
    }
  };
  const endpoints = await list();
  if (!endpoints.length) return 0;
  for (const mpe of endpoints) {
    try {
      await api.fabric.deletePrivateEndpoint(workspaceId, mpe.id);
    } catch (err) {
      if (!gone(err)) throw err;
    }
  }
  for (let i = 0; i < ENDPOINT_POLLS; i++) {
    if (!(await list()).length) {
      ui.ok(`Deleted ${endpoints.length === 1 ? 'the managed private endpoint' : `${endpoints.length} managed private endpoints`} (${endpoints.map((e) => e.name ?? e.id).join(', ')})`);
      return endpoints.length;
    }
    await ctx.sleep(ENDPOINT_POLL_MS);
  }
  throw new Error('Fabric is still deleting the workspace\'s managed private endpoints after ten minutes. Run uninstall again later.');
}

/**
 * What the installer created in the workspace, in the order to delete them: the report before the
 * model it reads, the pipeline before the notebooks it runs, and the Lakehouse last. A Lakehouse
 * the user already had isn't on the list.
 * @param {import('../config.js').InstallConfig} config
 * @returns {CreatedItem[]}
 */
export function createdItems(config) {
  const f = config.fabric;
  const sm = config.semanticModel;
  /** @type {CreatedItem[]} */
  const items = [];
  if (sm?.report?.id) items.push({ kind: 'report', name: sm.report.name, id: sm.report.id });
  if (sm?.id) items.push({ kind: 'semantic model', name: sm.name, id: sm.id });
  if (f.pipelineId) items.push({ kind: 'pipeline', name: f.pipelineName ?? PIPELINE_NAME, id: f.pipelineId });
  for (const nb of NOTEBOOKS) {
    const id = f.notebooks?.[nb.key];
    if (id) items.push({ kind: 'notebook', name: f.notebookNames?.[nb.key] ?? nb.displayName, id });
  }
  if (f.lakehouseId && !f.existingLakehouse) items.push({ kind: 'Lakehouse', name: f.lakehouseName ?? f.lakehouseId, id: f.lakehouseId });
  return items;
}

/**
 * Deletes each item in turn. One that fails only warns, so the rest still go.
 * @param {Ctx} ctx
 * @param {string} workspaceId
 * @param {CreatedItem[]} items
 */
async function deleteItems(ctx, workspaceId, items) {
  const { ui, api } = ctx;
  for (const item of items) {
    const label = `${item.kind} "${item.name}"`;
    try {
      await api.fabric.deleteItem(workspaceId, item.id);
      ui.ok(`Deleted the ${label}`);
    } catch (err) {
      if (gone(err)) ui.ok(`The ${label} was already gone`);
      else ui.warn(`Couldn't delete the ${label}: ${reason(err)}. Delete it in the workspace.`);
    }
  }
}

/**
 * Takes away the workspace role the installer gave the app, as the record has it (see
 * steps/model.js): removes it, or puts back the role the app had before. A role the installer
 * didn't give, one changed since, or one recorded for another workspace stays.
 * @param {Ctx} ctx
 * @param {string} workspaceId
 */
async function removeAppRole(ctx, workspaceId) {
  const { ui, config, api } = ctx;
  const spId = config.app.servicePrincipalId;
  if (!spId) return;
  const app = config.app.displayName ?? 'the app';
  /** @param {unknown} id */
  const isApp = (id) => String(id).toLowerCase() === spId.toLowerCase();
  const marker = config.fabric.appRole;
  const given = marker && isApp(marker.principalId) && marker.workspaceId?.toLowerCase() === workspaceId.toLowerCase() ? marker : undefined;
  try {
    const roles = await api.fabric.listRoleAssignments(workspaceId);
    const mine = roles.find((r) => isApp(r.principal?.id ?? r.id));
    if (!mine) return;
    if (!given || mine.role !== given.role) {
      ui.note(`Left ${app}'s ${mine.role ? `${mine.role} ` : ''}role on the workspace: the installer didn't give it that role.`);
      return;
    }
    if (given.previous) {
      await api.fabric.updateRoleAssignment(workspaceId, mine.id, given.previous);
      ui.ok(`Put ${app}'s role on the workspace back to ${given.previous}`);
    } else {
      await api.fabric.deleteRoleAssignment(workspaceId, mine.id);
      ui.ok(`Removed ${app}'s ${given.role} role on the workspace`);
    }
  } catch (err) {
    if (!gone(err) && given) ui.warn(`Couldn't take away the ${given.role} role the installer gave ${app} on the workspace: ${reason(err)}. Change it under Manage access.`);
  }
}

/**
 * Deletes the semantic model's SQL connection. Connections live outside the workspace, so deleting
 * the workspace or the model leaves it behind. A failure only warns: the rest is already gone.
 * @param {Ctx} ctx
 */
async function deleteModelConnection(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  if (!sm?.connectionId) return;
  const label = sm.connectionName ?? sm.connectionId;
  try {
    await api.fabric.deleteConnection(sm.connectionId);
    ui.ok(`Deleted the connection "${label}"`);
  } catch (err) {
    if (gone(err)) ui.ok(`The connection "${label}" was already gone`);
    else ui.warn(`Couldn't delete the connection "${label}": ${reason(err)}. Delete it under Manage connections and gateways.`);
  }
}

/**
 * Offers to delete the app registration, only when the installer created it. No by default, so
 * --yes keeps it.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether it's gone.
 */
async function deleteAppRegistration(ctx) {
  const { ui, config, api } = ctx;
  const app = config.app;
  if (!app.objectId || app.existing || app.adminPack) return false;
  const name = app.displayName ?? app.appId ?? app.objectId;
  const sure = await ui.confirm(
    `Delete the app registration "${name}" too? Only do this if nothing else uses it. Entra keeps it under Deleted applications for 30 days.`,
    false,
  );
  if (!sure) return false;
  try {
    await api.graph.deleteApplication(app.objectId);
    ui.ok(`Deleted the app registration "${name}"`);
  } catch (err) {
    if (!gone(err)) {
      ui.warn(`Couldn't delete the app registration "${name}": ${reason(err)}. Delete it in the Microsoft Entra admin center, under App registrations.`);
      return false;
    }
    ui.ok(`The app registration "${name}" was already gone`);
  }
  return true;
}

/**
 * Uninstalls AI in One. Deletes the workspace when the installer created it; otherwise deletes
 * only what the installer created in it. Asks first, yes by default.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether it went ahead.
 */
export async function fabricUninstall(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId) throw new Error('Nothing is installed yet.');
  const name = f.workspaceName ?? f.workspaceId;
  ui.heading('Uninstalling AI in One');
  if (f.createdWorkspace) {
    if (!(await ui.confirm(`Delete workspace "${name}" and everything in it, including the Lakehouse data?`, true))) {
      ui.note(`Left workspace "${name}" alone.`);
      return false;
    }
    await deletePrivateEndpoints(ctx, f.workspaceId);
    try {
      await api.fabric.deleteWorkspace(f.workspaceId);
      ui.ok(`Deleted workspace "${name}"`);
    } catch (err) {
      if (!gone(err)) throw err;
      ui.ok(`Workspace "${name}" was already gone`);
    }
  } else {
    const items = createdItems(config);
    if (items.length) {
      ui.info(`AI in One created these in workspace "${name}":`);
      for (const item of items) ui.info(`  The ${item.kind} "${item.name}"${item.kind === 'pipeline' ? ' (deleting it also removes its schedule)' : ''}`);
    } else ui.info(`The install record names nothing AI in One created in workspace "${name}".`);
    if (!(await ui.confirm(`Delete what AI in One created in workspace "${name}"? The workspace and everything else in it stay.`, true))) {
      ui.note(`Left workspace "${name}" alone.`);
      return false;
    }
    await deleteItems(ctx, f.workspaceId, items);
    await removeAppRole(ctx, f.workspaceId);
  }
  await deleteModelConnection(ctx);
  const appGone = await deleteAppRegistration(ctx);

  const kv = config.keyVault;
  const left = [
    !appGone && `the app registration${config.app.displayName ? ` "${config.app.displayName}"` : ''} and its client secrets`,
    secretMode(config) !== 'notebook' && (kv?.uri || kv?.name) && `the Key Vault${kv.name ? ` "${kv.name}"` : ''} and its secret`,
    config.access?.groupId && `the viewer group${config.access.groupName ? ` "${config.access.groupName}"` : ''}`,
    !f.createdWorkspace && f.existingLakehouse && `the Lakehouse "${f.lakehouseName ?? f.lakehouseId}" with its tables and files`,
  ].filter((s) => typeof s === 'string');
  if (left.length) ui.note(`Left alone: ${listOf(left)}. Remove them yourself if nothing else uses them.`);
  ui.note(
    f.createdWorkspace
      ? 'The install record still names the deleted workspace. Move it aside before installing again.'
      : 'The install record still names the deleted items. Move it aside before installing again.',
  );
  return true;
}
