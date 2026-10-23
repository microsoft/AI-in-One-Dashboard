// @ts-check
/**
 * Creating the viewer group as an Entra admin and as a user who isn't one. Entra makes a user who isn't an admin an
 * owner of a security group they create, and Graph refuses a request that names them as owner too, with 400 "Request
 * contains a property with duplicate values". It doesn't make an admin an owner, so their request still names them.
 * These run the real Graph client against a fake Graph that behaves that way.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphApi } from '../src/clients/graph.js';
import { createClient, HttpError } from '../src/http.js';
import { accessCommand, accessReview, ensureViewerGroup, VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { fakeCtx, fakePowerBi, fakeUi } from './fakes.js';

/** The signed-in user, as fakeCtx has them. */
const ME = { id: 'user-1', upn: 'admin@contoso.com' };
const OWNER = `https://graph.microsoft.com/v1.0/users/${ME.id}`;

/** The group the installer asks Graph for, without its owner. */
const GROUP = {
  displayName: VIEWER_GROUP_NAME,
  description: 'People who can view AI in One. Add members to share it.',
  mailEnabled: false,
  mailNickname: 'ai-in-one-viewers',
  securityEnabled: true,
};

/** Graph's answer when a user who isn't an admin names themselves as an owner of the group they create. */
const DUPLICATE = {
  error: {
    code: 'Request_BadRequest',
    message: 'Request contains a property with duplicate values.',
    innerError: { date: '2026-06-01T12:00:00', 'request-id': 'req-1', 'client-request-id': 'req-1' },
  },
};

const who = (/** @type {boolean} */ admin) => (admin ? 'an Entra admin' : "a user who isn't an Entra admin");

/**
 * Microsoft Graph's groups as the signed-in user sees them, behind a fake fetch, with the real Graph client on top.
 * Like Entra, it makes a user who isn't an admin an owner of a security group they create, and refuses a create that
 * names them as owner too. It makes an admin an owner only when the create names them.
 * @param {{ admin: boolean, failCreate?: { status: number, body: any } }} o  `failCreate`: every create gets this answer.
 */
function tenant(o) {
  /** @type {Map<string, { id: string, displayName: string, owners: string[], members: string[] }>} */
  const groups = new Map();
  /** The body of each create Graph was sent. @type {any[]} */
  const creates = [];
  const reply = (/** @type {number} */ status, /** @type {any} */ body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const user = (/** @type {string} */ id) => ({ '@odata.type': '#microsoft.graph.user', id, userPrincipalName: id === ME.id ? ME.upn : `${id}@contoso.com` });
  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ input, /** @type {any} */ init) => {
        const url = new URL(String(input));
        const path = url.pathname.replace(/^\/v1\.0/, '');
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path === '/groups') {
          const name = /^displayName eq '(.*)'$/.exec(url.searchParams.get('$filter') ?? '')?.[1]?.replace(/''/g, "'");
          return reply(200, { value: [...groups.values()].filter((g) => g.displayName === name).map((g) => ({ id: g.id, displayName: g.displayName, securityEnabled: true })) });
        }
        if (method === 'POST' && path === '/groups') {
          const body = JSON.parse(init.body);
          creates.push(body);
          if (o.failCreate) return reply(o.failCreate.status, o.failCreate.body);
          const named = (body['owners@odata.bind'] ?? []).map((/** @type {string} */ ref) => ref.split('/').pop());
          if (!o.admin && named.includes(ME.id)) return reply(400, DUPLICATE);
          const g = { id: `g-${groups.size + 1}`, displayName: body.displayName, owners: o.admin ? named : [...new Set([...named, ME.id])], members: [] };
          groups.set(g.id, g);
          return reply(201, { id: g.id, displayName: g.displayName, securityEnabled: true });
        }
        const [, id, part] = /^\/groups\/([^/]+)(?:\/(owners|members|transitiveMembers))?$/.exec(path) ?? [];
        if (method === 'GET' && id) {
          const g = groups.get(decodeURIComponent(id));
          if (!g) return reply(404, { error: { code: 'Request_ResourceNotFound', message: `Resource '${id}' does not exist.` } });
          if (!part) return reply(200, { id: g.id, displayName: g.displayName, securityEnabled: true });
          return reply(200, { value: (part === 'owners' ? g.owners : g.members).map(user) });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
    )
  );
  const graph = graphApi(createClient({ baseUrl: 'https://graph.microsoft.com/v1.0', getToken: async () => 'token', fetchImpl, sleep: async () => {} }));
  return { graph, groups, creates };
}

test('an Entra admin keeps "A new group": one create, naming them as owner, as before', async () => {
  const t = tenant({ admin: true });
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ graph: t.graph, ui });
  config.access = { groupName: VIEWER_GROUP_NAME, contact: ME.upn };

  assert.equal((await ensureViewerGroup(ctx))?.id, 'g-1');

  assert.deepEqual(t.creates, [{ ...GROUP, 'owners@odata.bind': [OWNER] }]);
  assert.deepEqual(t.groups.get('g-1')?.owners, [ME.id]);
  assert.equal(config.access.groupId, 'g-1');
  assert.equal(config.access.createdGroup, true);
  assert.match(text(), /Created the group "AI in One Viewers", with you as owner/);
});

test(`${who(false)} keeps "A new group": Graph's duplicate-values 400 is sent again without naming them, and they own the group`, async () => {
  const t = tenant({ admin: false });
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ graph: t.graph, ui });
  config.access = { groupName: VIEWER_GROUP_NAME, contact: ME.upn };

  assert.equal((await ensureViewerGroup(ctx))?.id, 'g-1');

  assert.deepEqual(t.creates, [{ ...GROUP, 'owners@odata.bind': [OWNER] }, GROUP], 'the same group, leaving out the owner Entra adds');
  assert.equal(t.groups.size, 1);
  assert.deepEqual(t.groups.get('g-1')?.owners, [ME.id]);
  assert.equal(config.access.groupId, 'g-1');
  assert.equal(config.access.createdGroup, true);
  assert.match(text(), /Created the group "AI in One Viewers", with you as owner/);
  assert.doesNotMatch(text(), /duplicate values|Couldn't create/);

  assert.equal((await ensureViewerGroup(ctx))?.id, 'g-1');
  assert.equal(t.creates.length, 2, 'reused, not created again');
});

test('another failure to create the group is not sent again, and warns with what to do instead of stopping', async () => {
  const invalid = { error: { code: 'Request_BadRequest', message: "Invalid value specified for property 'mailNickname' of resource 'Group'." } };
  const t = tenant({ admin: false, failCreate: { status: 400, body: invalid } });
  await assert.rejects(
    t.graph.createSecurityGroup({ displayName: VIEWER_GROUP_NAME, description: GROUP.description, ownerId: ME.id }),
    (/** @type {any} */ err) => err instanceof HttpError && err.status === 400 && /mailNickname/.test(err.message),
  );
  assert.equal(t.creates.length, 1, 'only the duplicate-values 400 is sent again');

  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ graph: t.graph, ui });
  config.access = { groupName: VIEWER_GROUP_NAME };
  assert.equal(await ensureViewerGroup(ctx), null);
  assert.equal(config.access.groupId, undefined);
  assert.match(text(), /Couldn't create the group "AI in One Viewers", so there's no viewer group yet: .*mailNickname/);
  assert.match(text(), /Run "access" and choose "A group I already have" to use a security group you own, or ask an Entra admin for one/);
});

test('a create that fails without an answer from Graph still stops', async () => {
  const graph = {
    findGroupByName: async () => null,
    createSecurityGroup: async () => {
      throw new Error('POST https://graph.microsoft.com/v1.0/groups failed: fetch failed');
    },
  };
  const { ctx, config } = fakeCtx({ graph });
  config.access = { groupName: VIEWER_GROUP_NAME };
  await assert.rejects(ensureViewerGroup(ctx), /fetch failed/);
});

for (const admin of [true, false]) {
  test(`access, as ${who(admin)}: keeping "A new group" creates it with them as owner, then shows it`, async () => {
    const t = tenant({ admin });
    const { ui, text, asked } = fakeUi();
    const { ctx, config } = fakeCtx({ graph: t.graph, ui });

    await accessCommand(ctx, []);

    assert.equal(asked[0], 'Who can view AI in One?', 'kept the default, "A new group"');
    assert.equal(t.creates.length, admin ? 1 : 2);
    assert.deepEqual(t.groups.get('g-1')?.owners, [ME.id]);
    assert.equal(config.access?.groupId, 'g-1');
    assert.equal(config.access?.createdGroup, true);
    assert.match(text(), /Created the group "AI in One Viewers", with you as owner/);
    assert.match(text(), /0 members; owners: admin@contoso\.com/);
    assert.ok(asked.includes('What next?'), 'carries on to the menu');
  });
}

/**
 * A fake UI that also records the values offered by each "What next?" menu.
 * @param {any[]} answers
 */
function menuUi(answers) {
  const f = fakeUi({ answers });
  /** @type {string[][]} */
  const menus = [];
  const ui = /** @type {any} */ (f.ui);
  const select = ui.select;
  ui.select = async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) => {
    if (message === 'What next?') menus.push(choices.map((c) => c.value));
    return select(message, choices, def);
  };
  return { ...f, menus };
}

/** The one AI in One model, as the install passes it to the access command. */
const MODELS = [{ workspaceId: 'ws-1', datasetId: 'sm-1', name: 'AI in One' }];

test('access command: "Give the group Build on the model again" grants Build on each model, and sharing the report is offered only while it is pending', async () => {
  const t = tenant({ admin: true });
  t.groups.set('g-1', { id: 'g-1', displayName: VIEWER_GROUP_NAME, owners: [ME.id], members: [] });
  const powerBi = fakePowerBi();
  const { ui, text, asked, menus } = menuUi(['grants', 'share', true, 'done']);
  const { ctx, config } = fakeCtx({ graph: t.graph, powerBi: powerBi.api, ui });
  config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, createdGroup: true };
  config.semanticModel.report = { id: 'rep-1', name: 'AI in One' };

  await accessCommand(ctx, MODELS);

  assert.ok(!asked.includes('Who can view AI in One?'), 'a saved group is used without asking');
  assert.deepEqual(powerBi.calls, ['addDatasetUser sm-1 g-1 ReadExplore'], 'Build, never a workspace role');
  assert.deepEqual(config.access.grantedModels, ['sm-1']);
  assert.match(text(), /AI in One Viewers can build on AI in One/);
  const all = ['members', 'owner', 'share', 'grants', 'done'];
  assert.deepEqual(menus, [all, all, all.filter((v) => v !== 'share')]);
  assert.ok(asked.includes('Have you shared the report?'));
  assert.equal(config.access.reportShared, true);
  assert.match(text(), /The report is shared with "AI in One Viewers"/);
});

test('access command: a grant Power BI already has is not sent again, and the menu never offers sharing a report that is not published', async () => {
  const t = tenant({ admin: true });
  t.groups.set('g-1', { id: 'g-1', displayName: VIEWER_GROUP_NAME, owners: [ME.id], members: [] });
  const powerBi = fakePowerBi();
  powerBi.users.push({ identifier: 'G-1', principalType: 'Group', datasetUserAccessRight: 'ReadExplore' });
  const { ui, text, menus } = menuUi(['grants', 'done']);
  const { ctx, config } = fakeCtx({ graph: t.graph, powerBi: powerBi.api, ui });
  config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, createdGroup: true };

  await accessCommand(ctx, MODELS);

  assert.deepEqual(powerBi.calls, []);
  assert.deepEqual(config.access.grantedModels, ['sm-1']);
  assert.match(text(), /AI in One Viewers can build on AI in One/);
  assert.deepEqual(menus, [['members', 'owner', 'grants', 'done'], ['members', 'owner', 'grants', 'done']]);
});

test('access command: viewers and owners are added by name, a name it cannot find is skipped with a warning, and an owner must be a user', async () => {
  const t = tenant({ admin: true });
  t.groups.set('g-1', { id: 'g-1', displayName: VIEWER_GROUP_NAME, owners: [ME.id], members: [] });
  const people = new Map([
    ['ana@contoso.com', { id: 'u-2', displayName: 'ana@contoso.com', kind: 'user' }],
    ['Copilot Leads', { id: 'g-9', displayName: 'Copilot Leads', kind: 'group' }],
  ]);
  /** @type {string[]} */
  const adds = [];
  const add = (/** @type {'members' | 'owners'} */ part) => async (/** @type {string} */ groupId, /** @type {string} */ id) => {
    adds.push(`${part} ${groupId} ${id}`);
    const list = /** @type {NonNullable<ReturnType<typeof t.groups.get>>} */ (t.groups.get(groupId))[part];
    if (list.includes(id)) return false;
    list.push(id);
    return true;
  };
  const graph = { ...t.graph, resolvePrincipal: async (/** @type {string} */ name) => people.get(name) ?? null, addGroupMember: add('members'), addGroupOwner: add('owners') };
  const { ui, text, asked } = menuUi(['members', 'ana@contoso.com, Nope; Copilot Leads', 'members', 'ana@contoso.com', 'owner', 'Copilot Leads', 'owner', 'ana@contoso.com', 'done']);
  const { ctx, config } = fakeCtx({ graph, ui });
  config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, createdGroup: true };

  await accessCommand(ctx, []);

  assert.deepEqual(adds, ['members g-1 u-2', 'members g-1 g-9', 'members g-1 u-2', 'owners g-1 u-2']);
  assert.match(text(), /ana@contoso\.com added/);
  assert.match(text(), /No user or group called "Nope"/);
  assert.match(text(), /Copilot Leads added/);
  assert.match(text(), /ana@contoso\.com was already there/);
  assert.match(text(), /No user called "Copilot Leads"/);
  assert.deepEqual(asked.filter((q) => q !== 'What next?'), ['Emails or group names, separated by commas', 'Emails or group names, separated by commas', 'Owner email', 'Owner email']);
  assert.match(text(), /0 members; owners: admin@contoso\.com/);
  assert.match(text(), /2 members; owners: admin@contoso\.com\n/);
  assert.match(text(), /2 members; owners: admin@contoso\.com, u-2@contoso\.com/, 'the group is read again after each change');
});

test('access command: when the viewer group cannot be created, it says why and stops before the menu', async () => {
  const denied = { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } };
  const t = tenant({ admin: false, failCreate: { status: 403, body: denied } });
  const { ui, text, asked } = fakeUi();
  const { ctx, config, saves } = fakeCtx({ graph: t.graph, ui });

  await accessCommand(ctx, MODELS);

  assert.deepEqual(asked, ['Who can view AI in One?']);
  assert.equal(config.access?.groupId, undefined);
  assert.deepEqual(config.access, { groupName: VIEWER_GROUP_NAME });
  assert.match(text(), /You can't create groups in this tenant, so there's no viewer group yet/);
  assert.match(text(), /Ask an Entra admin for a security group, then run "access" to use it/);
  assert.ok(saves() >= 1, 'the choice is saved');
});

test('the plan says you own the viewer group only when the installer creates it', () => {
  const { config } = fakeCtx();
  const detail = () => accessReview(config, 'Semantic models in workspace X').creates[0].detail;
  config.access = { groupName: VIEWER_GROUP_NAME };
  assert.match(detail(), /You are its owner/);
  config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, createdGroup: true };
  assert.match(detail(), /You are its owner/);
  config.access = { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false };
  assert.doesNotMatch(detail(), /You are its owner/);
  assert.match(detail(), /Its owners share it by adding people to it/);
});
