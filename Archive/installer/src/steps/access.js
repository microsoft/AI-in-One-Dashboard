// @ts-check
/**
 * Who can view AI in One: one Entra security group. Its members get Build on the semantic model
 * the report reads, and the report is shared with the group once, in Power BI. Nobody gets a
 * workspace role for this: a workspace Viewer can read the notebooks, which can hold the client
 * secret. Sharing is then adding people to the group, from the installer or My Groups.
 */
import { REPORT_NAME } from '../config.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';
import { asksAdvanced } from './advanced.js';
import { reportUrl } from './report.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {{ workspaceId: string, datasetId: string, name: string }} ModelRef */

export const VIEWER_GROUP_NAME = 'AI in One Viewers';
const GROUP_DESCRIPTION = 'People who can view AI in One. Add members to share it.';

/** Where a group's owners add and remove members themselves. @param {string} groupId */
export const myGroupsUrl = (groupId) => `https://myaccount.microsoft.com/groups/${groupId}`;

/**
 * The plan's question: which group can view.
 * @param {Ctx} ctx
 */
export async function planAccess(ctx) {
  const { ui, config, api } = ctx;
  const access = { ...(config.access ?? {}) };
  if (!asksAdvanced(ctx)) {
    // The saved group, or a new "AI in One Viewers"; Manage access changes it later.
    if (!access.groupId) access.groupName = access.createdGroup ? access.groupName ?? VIEWER_GROUP_NAME : VIEWER_GROUP_NAME;
    config.access = access;
    return;
  }
  ui.heading('Who can view');
  const mode = await ui.select(
    'Who can view AI in One?',
    [
      { name: `A new group, "${VIEWER_GROUP_NAME}" (recommended)`, value: 'new', description: 'Created with you as owner. Share by adding people to it.' },
      { name: 'A group I already have', value: 'existing', description: 'A security group, by name or object ID. Its members can view.' },
    ],
    access.groupId && !access.createdGroup ? 'existing' : 'new',
  );
  if (mode === 'new') {
    if (!access.createdGroup) {
      delete access.groupId;
      delete access.reportShared;
    }
    access.groupName = access.createdGroup ? access.groupName ?? VIEWER_GROUP_NAME : VIEWER_GROUP_NAME;
  } else {
    for (;;) {
      const name = (await ui.input('Group name or object ID', { default: access.createdGroup ? undefined : access.groupName ?? access.groupId })).trim();
      const found = await api.graph.resolvePrincipal(name).catch(() => null);
      if (found?.kind === 'group') {
        if (found.id !== access.groupId) delete access.reportShared;
        Object.assign(access, { groupId: found.id, groupName: found.displayName, createdGroup: false });
        ui.ok(`Viewers: ${found.displayName}`);
        break;
      }
      ui.warn(`No group called "${name}". Check the name, or paste its object ID from Entra.`);
    }
  }
  config.access = access;
}

/**
 * Plan review rows: the group the access step creates, the Build grant it gives, and the report
 * share the user does once. The group gets no workspace role.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} where  The model, e.g. "Semantic model X in workspace Y".
 */
export function accessReview(config, where) {
  const a = config.access;
  if (!a) return { creates: [], grants: [] };
  const name = a.groupName ?? VIEWER_GROUP_NAME;
  // You may not own a group you picked. You own one the installer creates.
  const owners = a.groupId && !a.createdGroup ? 'Its owners share it by adding people to it.' : 'You are its owner; share by adding people to it.';
  const ws = config.fabric?.workspaceName;
  const report = `Report ${config.semanticModel?.report?.name ?? REPORT_NAME}${ws ? ` in workspace ${ws}` : ''}`;
  return {
    creates: [{ kind: 'Entra group', name, isNew: !a.groupId, detail: `Who can view AI in One. ${owners}` }],
    grants: [
      { who: `${name} (group)`, what: 'Build (ReadExplore)', where, detail: "So its members can read the report's data." },
      { who: `${name} (group)`, what: 'Read the report', where: report, detail: "You share it with the group once in Power BI, after it's published. The installer shows the steps." },
    ],
  };
}

/**
 * Finds the viewer group, or creates it with the installer as owner. Null when it can't be created.
 * @param {Ctx} ctx
 * @returns {Promise<{ id: string, displayName: string } | null>}
 */
export async function ensureViewerGroup(ctx) {
  const { ui, config, api, user } = ctx;
  const a = config.access;
  if (!a) return null;
  if (a.groupId) {
    const group = await api.graph.getGroup(a.groupId);
    if (group) {
      a.groupName = group.displayName;
      ui.ok(`Viewer group: ${group.displayName}`);
      return group;
    }
    ui.warn(`The viewer group ${a.groupName ?? a.groupId} is gone.${a.createdGroup ? ' Creating it again.' : ''}`);
    delete a.groupId;
    delete a.reportShared;
    a.grantedModels = [];
    if (!a.createdGroup) {
      ctx.save();
      ui.info(`Run "access" to choose another group.`);
      return null;
    }
  }
  const name = a.groupName ?? VIEWER_GROUP_NAME;
  const found = await api.graph.findGroupByName(name);
  if (found) {
    Object.assign(a, { groupId: found.id, groupName: found.displayName });
    ctx.save();
    ui.ok(`Viewer group: ${found.displayName}`);
    return found;
  }
  try {
    const group = await api.graph.createSecurityGroup({ displayName: name, description: GROUP_DESCRIPTION, ownerId: user.id });
    Object.assign(a, { groupId: group.id, groupName: group.displayName, createdGroup: true });
    ctx.save();
    ui.ok(`Created the group "${group.displayName}", with you as owner`);
    return group;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 403 || err.status === 401) {
      ui.warn(`You can't create groups in this tenant, so there's no viewer group yet.`);
      ui.info('Ask an Entra admin for a security group, then run "access" to use it.');
    } else {
      ui.warn(`Couldn't create the group "${name}", so there's no viewer group yet: ${err.message}`);
      ui.info('Run "access" and choose "A group I already have" to use a security group you own, or ask an Entra admin for one.');
    }
    return null;
  }
}

/** A new group takes a minute or two to reach Power BI, which until then rejects it as an invalid identifier. */
export const NEW_GROUP_ATTEMPTS = 8;
export const NEW_GROUP_RETRY_MS = 15_000;

/**
 * Adds the group to a model, waiting while Power BI doesn't know the group yet.
 * @param {Ctx} ctx
 * @param {ModelRef} m
 * @param {string} groupId
 */
async function addGroupToModel(ctx, m, groupId) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.api.powerBi.addDatasetUser(m.workspaceId, m.datasetId, { identifier: groupId, principalType: 'Group', datasetUserAccessRight: 'ReadExplore' });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400 || attempt === NEW_GROUP_ATTEMPTS) throw err;
      if (attempt === 1) ctx.ui.info('Waiting for Power BI to see the group. A new group takes a minute or two.');
      await ctx.sleep(NEW_GROUP_RETRY_MS);
    }
  }
}

/**
 * Gives the viewer group Build (ReadExplore) on each model, so its members can read the report's
 * data. A grant that fails is reported and doesn't stop the install.
 * @param {Ctx} ctx
 * @param {ModelRef[]} models
 */
export async function grantModelAccess(ctx, models) {
  const { ui, config, api } = ctx;
  const a = config.access;
  if (!a?.groupId) return;
  const granted = new Set(a.grantedModels ?? []);
  for (const m of models) {
    try {
      const users = await api.powerBi.datasetUsers(m.workspaceId, m.datasetId).catch(() => []);
      const has = users.some((u) => String(u.identifier).toLowerCase() === a.groupId?.toLowerCase() && /Explore/i.test(u.datasetUserAccessRight ?? ''));
      if (!has) await addGroupToModel(ctx, m, a.groupId);
      granted.add(m.datasetId);
      ui.ok(`${a.groupName} can build on ${m.name}`);
    } catch (err) {
      ui.warn(`Couldn't give ${a.groupName} Build on ${m.name}: ${/** @type {Error} */ (err).message}`);
      ui.info('Share the model with the group from its Manage permissions page, with "Allow recipients to build content" ticked.');
    }
  }
  a.grantedModels = [...granted];
  ctx.save();
}

/**
 * The published report in Power BI, signed in to the tenant when it's known. Undefined until it's published.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} [tenantId]
 * @returns {string | undefined}
 */
export function reportLink(config, tenantId) {
  const ws = config.fabric?.workspaceId;
  const id = config.semanticModel?.report?.id;
  if (!ws || !id) return undefined;
  return `${reportUrl(ws, id)}${tenantId ? `?ctid=${tenantId}` : ''}`;
}

/**
 * The clicks that share the report with the viewer group, one whole step each.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} [tenantId]
 */
export function shareReportSteps(config, tenantId) {
  const group = config.access?.groupName ?? VIEWER_GROUP_NAME;
  const url = reportLink(config, tenantId);
  const reportName = config.semanticModel?.report?.name ?? REPORT_NAME;
  return [
    `Open ${config.fabric?.workspaceName ?? 'the workspace'} in Power BI and choose … (More options) next to the ${reportName} report${url ? ` (${url})` : ''}.`,
    'Choose Manage permissions.',
    `Choose Add user, enter "${group}" and choose Grant.`,
  ];
}

/**
 * The report still needs sharing with the viewer group: there is a group and a published report,
 * and nobody has said it's done.
 * @param {import('../config.js').InstallConfig} config
 */
export const shareReportPending = (config) => !!config.access?.groupId && !!config.semanticModel.report?.id && config.access.reportShared !== true;

/**
 * Asks the user to share the report with the viewer group, once. Power BI has no public API for
 * it, so it's a few clicks in the portal. Asked straight after the report is published and before
 * the first load, which can take hours, so viewers can open the report while the history loads.
 * Not asked again once done.
 * @param {Ctx} ctx
 */
export async function shareReport(ctx) {
  const { ui, config, user } = ctx;
  const a = config.access;
  if (a?.reportShared === true) return;
  if (!shareReportPending(config)) {
    ui.warn(a?.groupId
      ? "The report isn't published yet, so there's nothing to share. The summary at the end says what to do."
      : "There's no viewer group yet, so there's nothing to share. The summary at the end says what to do.");
    return;
  }
  const group = a?.groupName ?? VIEWER_GROUP_NAME;
  ui.info(`Members of "${group}" can open the report once it's shared with the group. Power BI has no API for that, so it takes a few clicks:`);
  shareReportSteps(config, user.tenantId).forEach((s, i) => ui.info(`  ${i + 1}. ${s}`));
  ui.note('After that, give people access by adding them to the group.');
  const done = await ui.select(
    'Have you shared the report?',
    [
      { name: 'I\'ve shared it', value: true, description: `Members of "${group}" can open it.` },
      { name: 'Later', value: false, description: 'The summary at the end reminds you, and Repair asks again.' },
    ],
    false,
  );
  if (!done) {
    ui.note('Until it\'s shared, people in the group can\'t open the report.');
    return;
  }
  /** @type {import('../config.js').AccessConfig} */ (a).reportShared = true;
  ctx.save();
  ui.ok(`The report is shared with "${group}"`);
}

/**
 * Summary lines: who can view and how to share.
 * @param {import('../config.js').InstallConfig} config
 */
export function accessSummaryLines(config) {
  const a = config.access;
  if (!a?.groupId) return [];
  return [`Viewers: members of "${a.groupName}". To share, add people to it: run "${commandLine('access')}" or open ${myGroupsUrl(a.groupId)}.`];
}

/**
 * The `access` command: shows the viewer group and adds viewers or owners to it.
 * @param {Ctx} ctx
 * @param {ModelRef[]} models  The models the group should have Build on.
 */
export async function accessCommand(ctx, models) {
  const { ui, config, api } = ctx;
  if (!config.access?.groupId) await planAccess(ctx);
  ctx.save();
  ui.heading('Viewer access');
  const group = await ensureViewerGroup(ctx);
  if (!group) return;
  for (;;) {
    const [members, owners] = await Promise.all([api.graph.groupMembers(group.id).catch(() => []), api.graph.groupOwners(group.id).catch(() => [])]);
    ui.info(`${members.length} ${members.length === 1 ? 'member' : 'members'}; owners: ${owners.map((o) => o.userPrincipalName ?? o.displayName).join(', ') || 'none'}`);
    ui.note(`Owners can also manage it at ${myGroupsUrl(group.id)}`);
    const action = await ui.select(
      'What next?',
      [
        { name: 'Add viewers', value: 'members', description: 'People or groups, by email or group name.' },
        { name: 'Add an owner', value: 'owner', description: 'Owners can add and remove viewers themselves.' },
        ...(shareReportPending(config) ? [{ name: 'Share the report with the group', value: 'share', description: 'Once, in Power BI, so members can open it.' }] : []),
        { name: 'Give the group Build on the model again', value: 'grants', description: 'Repairs access to the data the report reads.' },
        { name: 'Done', value: 'done' },
      ],
      'done',
    );
    if (action === 'done') return;
    if (action === 'share') {
      await shareReport(ctx);
      continue;
    }
    if (action === 'grants') {
      await grantModelAccess(ctx, models);
      continue;
    }
    const names = (await ui.input(action === 'owner' ? 'Owner email' : 'Emails or group names, separated by commas')).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      const p = await api.graph.resolvePrincipal(name).catch(() => null);
      if (!p || (action === 'owner' && p.kind !== 'user')) {
        ui.warn(`No ${action === 'owner' ? 'user' : 'user or group'} called "${name}"`);
        continue;
      }
      const added = action === 'owner' ? await api.graph.addGroupOwner(group.id, p.id) : await api.graph.addGroupMember(group.id, p.id);
      ui.ok(`${p.displayName} ${added ? 'added' : 'was already there'}`);
    }
  }
}
