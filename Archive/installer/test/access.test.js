// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessCommand, accessReview, accessSummaryLines, ensureViewerGroup, grantModelAccess, myGroupsUrl, NEW_GROUP_ATTEMPTS, NEW_GROUP_RETRY_MS, planAccess, VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { fabricViewerModels } from '../src/install.js';
import { HttpError } from '../src/http.js';
import { fakeCtx, fakeUi } from './fakes.js';

/** A directory with a few groups and users, recording what was changed. */
function directory() {
  /** @type {Map<string, { id: string, displayName: string, members: string[], owners: string[] }>} */
  const groups = new Map();
  const users = new Map([['ana@contoso.com', { id: 'u-ana', displayName: 'Ana' }], ['ben@contoso.com', { id: 'u-ben', displayName: 'Ben' }]]);
  /** @type {string[]} */
  const calls = [];
  /** @type {Error | undefined} */
  let createError;
  const graph = {
    verifiedDomains: async () => ['contoso.com', 'contoso.onmicrosoft.com'],
    getGroup: async (/** @type {string} */ id) => groups.get(id) ?? null,
    findGroupByName: async (/** @type {string} */ name) => [...groups.values()].find((g) => g.displayName === name) ?? null,
    /** @param {{ displayName: string, ownerId: string }} o */
    createSecurityGroup: async (o) => {
      calls.push(`create ${o.displayName} owner=${o.ownerId}`);
      if (createError) throw createError;
      const g = { id: `g-${groups.size + 1}`, displayName: o.displayName, members: [], owners: [o.ownerId] };
      groups.set(g.id, g);
      return g;
    },
    groupMembers: async (/** @type {string} */ id) => (groups.get(id)?.members ?? []).map((m) => ({ id: m })),
    groupOwners: async (/** @type {string} */ id) => (groups.get(id)?.owners ?? []).map((m) => ({ id: m, userPrincipalName: m })),
    addGroupMember: async (/** @type {string} */ id, /** @type {string} */ member) => {
      const g = /** @type {any} */ (groups.get(id));
      if (g.members.includes(member)) return false;
      g.members.push(member);
      calls.push(`member ${member}`);
      return true;
    },
    addGroupOwner: async (/** @type {string} */ id, /** @type {string} */ owner) => {
      /** @type {any} */ (groups.get(id)).owners.push(owner);
      calls.push(`owner ${owner}`);
      return true;
    },
    resolvePrincipal: async (/** @type {string} */ name) => {
      const u = users.get(name.toLowerCase());
      if (u) return { ...u, kind: 'user' };
      const g = groups.get(name) ?? [...groups.values()].find((x) => x.displayName === name);
      return g ? { id: g.id, displayName: g.displayName, kind: 'group' } : null;
    },
  };
  return { graph, groups, calls, failCreate: (/** @type {Error} */ e) => (createError = e) };
}

function datasets() {
  /** @type {Record<string, any[]>} */
  const users = {};
  /** @type {string[]} */
  const calls = [];
  /** @type {Set<string>} */
  const denied = new Set();
  /** How many more times each model rejects a group Power BI hasn't seen yet. @type {Record<string, number>} */
  const unseen = {};
  const powerBi = {
    datasetUsers: async (/** @type {string} */ _ws, /** @type {string} */ ds) => users[ds] ?? [],
    addDatasetUser: async (/** @type {string} */ ws, /** @type {string} */ ds, /** @type {any} */ body) => {
      if (denied.has(ds)) throw new HttpError('Forbidden', { status: 403, method: 'POST', url: 'https://x' });
      if (unseen[ds] > 0) {
        unseen[ds]--;
        throw new HttpError('InvalidRequest: Parameter identifier is missing or invalid', { status: 400, method: 'POST', url: 'https://x' });
      }
      calls.push(`${ws}/${ds} ${body.identifier} ${body.principalType} ${body.datasetUserAccessRight}`);
      (users[ds] ??= []).push(body);
    },
  };
  return { powerBi, users, calls, denied, unseen };
}

const MODELS = [{ workspaceId: 'ws-1', datasetId: 'ds-vl', name: 'AI in One' }, { workspaceId: 'ws-1', datasetId: 'ds-cc', name: 'Credits' }];

test('access: the plan asks for a new group by default; the group gets Build and the report, never a workspace role', async () => {
  const dir = directory();
  const { ui, asked } = fakeUi();
  const { ctx } = fakeCtx({ graph: dir.graph, ui });
  await planAccess(ctx);
  assert.deepEqual(ctx.config.access, { groupName: VIEWER_GROUP_NAME });
  assert.deepEqual(asked, ['Who can view AI in One?']);
  const review = accessReview(ctx.config, 'Workspace X');
  assert.equal(review.creates[0].name, VIEWER_GROUP_NAME);
  assert.equal(review.creates[0].isNew, true);
  assert.deepEqual(review.grants.map((g) => g.what), ['Build (ReadExplore)', 'Read the report']);
  assert.deepEqual(dir.calls, [], 'planning changes nothing');
});

test('access: without Advanced settings, a new viewer group, no questions; a re-run keeps the group it had', async () => {
  const { ui, asked } = fakeUi();
  const { ctx } = fakeCtx({ graph: directory().graph, ui });
  ctx.advanced = false;
  await planAccess(ctx);
  assert.deepEqual(ctx.config.access, { groupName: VIEWER_GROUP_NAME });
  assert.deepEqual(asked, []);

  const saved = { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false, reportShared: true };
  const again = fakeCtx({ graph: directory().graph, ui });
  again.ctx.advanced = false;
  again.config.access = { ...saved };
  await planAccess(again.ctx);
  assert.deepEqual(again.config.access, saved);

  const made = fakeCtx({ graph: directory().graph, ui });
  made.ctx.advanced = false;
  made.config.access = { createdGroup: true, groupName: 'Copilot Viewers' };
  await planAccess(made.ctx);
  assert.equal(made.config.access?.groupName, 'Copilot Viewers', 'a group the installer made keeps its name');
  assert.deepEqual(asked, []);
});

test('access: an existing group is found by name, asking again until it exists', async () => {
  const dir = directory();
  dir.groups.set('g-9', { id: 'g-9', displayName: 'Copilot Leads', members: [], owners: [] });
  const { ui, text } = fakeUi({ answers: ['existing', 'Nope', 'Copilot Leads'] });
  const { ctx } = fakeCtx({ graph: dir.graph, ui });
  await planAccess(ctx);
  assert.match(text(), /No group called "Nope"/);
  assert.equal(ctx.config.access?.groupId, 'g-9');
  assert.equal(ctx.config.access?.createdGroup, false);
  assert.match(text(), /Viewers: Copilot Leads/);
  assert.equal(accessReview(ctx.config, 'X').creates[0].isNew, false);
});

test('access: picking another group means the report must be shared with it again', async () => {
  const dir = directory();
  dir.groups.set('g-9', { id: 'g-9', displayName: 'Copilot Leads', members: [], owners: [] });
  const moved = fakeCtx({ graph: dir.graph, ui: fakeUi({ answers: ['existing', 'Copilot Leads'] }).ui });
  moved.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, createdGroup: true, reportShared: true };
  await planAccess(moved.ctx);
  assert.equal(moved.config.access?.groupId, 'g-9');
  assert.equal(moved.config.access?.reportShared, undefined);

  const same = fakeCtx({ graph: dir.graph, ui: fakeUi({ answers: ['existing', 'Copilot Leads'] }).ui });
  same.config.access = { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false, reportShared: true };
  await planAccess(same.ctx);
  assert.equal(same.config.access?.reportShared, true, 'the same group keeps it');

  const fresh = fakeCtx({ graph: dir.graph, ui: fakeUi({ answers: ['new'] }).ui });
  fresh.config.access = { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false, reportShared: true };
  await planAccess(fresh.ctx);
  assert.deepEqual(fresh.config.access, { groupName: VIEWER_GROUP_NAME, createdGroup: false });
});

test('access: the viewer group is created once, with the installer as owner, then reused', async () => {
  const dir = directory();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph });
  ctx.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com' };
  const first = await ensureViewerGroup(ctx);
  assert.equal(first?.id, 'g-1');
  assert.deepEqual(dir.calls, [`create ${VIEWER_GROUP_NAME} owner=user-1`]);
  assert.equal(ctx.config.access.createdGroup, true);
  await ensureViewerGroup(ctx);
  assert.equal(dir.calls.length, 1);
});

test('access: a created group that was deleted is created again; a chosen one is not', async () => {
  const dir = directory();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph });
  ctx.config.access = { groupId: 'gone', groupName: VIEWER_GROUP_NAME, createdGroup: true, grantedModels: ['ds-vl'] };
  assert.equal((await ensureViewerGroup(ctx))?.id, 'g-1');
  assert.deepEqual(ctx.config.access.grantedModels, []);

  const { ui, text } = fakeUi();
  const { ctx: other } = fakeCtx({ graph: dir.graph, ui });
  other.config.access = { groupId: 'gone', groupName: 'Copilot Leads', createdGroup: false };
  assert.equal(await ensureViewerGroup(other), null);
  assert.equal(other.config.access.groupId, undefined);
  assert.match(text(), /Copilot Leads is gone/);
});

test('access: without permission to create groups, setup carries on and says what to do', async () => {
  const dir = directory();
  dir.failCreate(new HttpError('Forbidden', { status: 403, method: 'POST', url: 'https://x' }));
  const { ui, text } = fakeUi();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph, ui });
  ctx.config.access = { groupName: VIEWER_GROUP_NAME };
  assert.equal(await ensureViewerGroup(ctx), null);
  assert.match(text(), /can't create groups/);
  assert.match(text(), /run "access"/);
});

test('access: the group gets Build on each model once, and a failed grant only warns', async () => {
  const pbi = datasets();
  pbi.users['ds-cc'] = [{ identifier: 'G-1', principalType: 'Group', datasetUserAccessRight: 'ReadExplore' }];
  const { ui, text } = fakeUi();
  const { ctx: ctx } = fakeCtx({ powerBi: pbi.powerBi, ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await grantModelAccess(ctx, MODELS);
  assert.deepEqual(pbi.calls, ['ws-1/ds-vl g-1 Group ReadExplore']);
  assert.deepEqual(ctx.config.access.grantedModels, ['ds-vl', 'ds-cc']);

  pbi.denied.add('ds-x');
  await grantModelAccess(ctx, [{ workspaceId: 'ws-1', datasetId: 'ds-x', name: 'Other' }]);
  assert.match(text(), /Couldn't give AI in One Viewers Build on Other/);
  assert.ok(!ctx.config.access.grantedModels?.includes('ds-x'));
});

test('access: a group Power BI does not know yet is retried, then reported if it never appears', async () => {
  const pbi = datasets();
  pbi.unseen['ds-vl'] = 2;
  const { ui, text } = fakeUi();
  const { ctx: ctx, sleeps } = fakeCtx({ powerBi: pbi.powerBi, ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await grantModelAccess(ctx, MODELS);
  assert.deepEqual(pbi.calls, ['ws-1/ds-vl g-1 Group ReadExplore', 'ws-1/ds-cc g-1 Group ReadExplore']);
  assert.deepEqual(sleeps, [NEW_GROUP_RETRY_MS, NEW_GROUP_RETRY_MS]);
  assert.match(text(), /Waiting for Power BI to see the group/);
  assert.doesNotMatch(text(), /Couldn't give/);

  pbi.unseen['ds-y'] = NEW_GROUP_ATTEMPTS;
  await grantModelAccess(ctx, [{ workspaceId: 'ws-1', datasetId: 'ds-y', name: 'Other' }]);
  assert.match(text(), /Couldn't give AI in One Viewers Build on Other/);
  assert.equal(sleeps.length, 2 + NEW_GROUP_ATTEMPTS - 1);
});

test('access: the command adds viewers and owners, and skips names it cannot find', async () => {
  const dir = directory();
  dir.groups.set('g-1', { id: 'g-1', displayName: VIEWER_GROUP_NAME, members: ['u-ana'], owners: ['user-1'] });
  const { ui, text } = fakeUi({ answers: ['members', 'ana@contoso.com, ben@contoso.com; nobody@contoso.com', 'owner', 'ben@contoso.com', 'done'] });
  const { ctx: ctx } = fakeCtx({ graph: dir.graph, powerBi: datasets().powerBi, ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await accessCommand(ctx, MODELS);
  assert.deepEqual(dir.calls, ['member u-ben', 'owner u-ben']);
  assert.match(text(), /Ana was already there/);
  assert.match(text(), /No user or group called "nobody@contoso.com"/);
  assert.match(text(), new RegExp(myGroupsUrl('g-1').replace(/[/.]/g, '\\$&')));
});

test('access: the summary names the group and how to add people, and says nothing without a group', () => {
  const { ctx } = fakeCtx();
  assert.deepEqual(accessSummaryLines(ctx.config), []);
  ctx.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com' };
  assert.deepEqual(accessSummaryLines(ctx.config), [], 'not until the group exists');

  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com', createdGroup: true, grantedModels: ['ds-vl'] };
  const [line, ...rest] = accessSummaryLines(ctx.config);
  assert.deepEqual(rest, []);
  assert.match(line, /^Viewers: members of "AI in One Viewers"\. To share, add people to it: run ".*access" or open /);
  assert.ok(line.endsWith(`open ${myGroupsUrl('g-1')}.`));
});

test('access: viewers get Build on the one AI in One model, once it is deployed', () => {
  const { ctx } = fakeCtx();
  const config = ctx.config;
  assert.deepEqual(fabricViewerModels(config), [], 'nothing before the model is deployed');
  config.semanticModel.enabled = true;
  assert.deepEqual(fabricViewerModels(config), [], 'nor before it has an ID');
  config.semanticModel.id = 'ds-vl';
  assert.deepEqual(fabricViewerModels(config), [{ workspaceId: 'ws-1', datasetId: 'ds-vl', name: 'AI in One' }]);
  config.semanticModel.enabled = false;
  assert.deepEqual(fabricViewerModels(config), []);
});
