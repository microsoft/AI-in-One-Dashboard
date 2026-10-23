// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askAdvanced, asksAdvanced } from '../src/steps/advanced.js';
import { capacityLabel, defaultsToNoVault, plan } from '../src/steps/plan.js';
import { fakeArm, fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const PRE = /** @type {any} */ ({
  subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }],
  roles: [],
  canConsent: true,
  canCreateApps: true,
  capacities: [{ id: 'cap-1', displayName: 'F64', sku: 'F64', region: 'UK South', state: 'Active' }],
  tenantSettings: [],
});

/** The questions behind Advanced settings, which a default install doesn't ask, in the plan's order. */
const ADVANCED_QUESTIONS = [
  'Who can view AI in One?',
  'How much audit history should the first load pull?',
  'How many people are in the tenant?',
  'Lakehouse name',
  'How often should the pipeline run?',
  'Run the first load as soon as setup finishes?',
];

/** A new Key Vault's details, also behind Advanced settings, in the order they're asked. */
const VAULT_QUESTIONS = ['Resource group (created if missing)', 'Azure region', 'Vault name (globally unique)', 'Secret name'];

const LIFETIME = 'Days before the client secret expires';

/** A plan where the workspace exists and the Lakehouse is still to make. @param {import('../src/ui.js').Ui} ui */
function newLakehouse(ui) {
  const t = fakeCtx({ ui, fabric: fakeFabric().api });
  delete t.config.fabric.lakehouseId;
  delete t.config.fabric.lakehouseName;
  return t;
}

/** A new install whose secret has no home yet. @param {{ ui: import('../src/ui.js').Ui }} u */
function noVaultYet(u) {
  const t = fakeCtx({ ui: u.ui, fabric: fakeFabric().api, arm: fakeArm().api });
  t.config.keyVault = { secretName: 'ai-in-one-client-secret' };
  return t;
}

test('advanced: one question, No by default, and asked about outside the plan', async () => {
  const { ui, asked, text } = fakeUi();
  const { ctx } = fakeCtx({ ui });
  assert.equal(asksAdvanced(ctx), true, 'commands with no Advanced question still ask');
  await askAdvanced(ctx, 'the schedule');
  assert.deepEqual(asked, ['Change the advanced settings?']);
  assert.match(text(), /Choose Yes to change the schedule/);
  assert.equal(ctx.advanced, false);
  assert.equal(asksAdvanced(ctx), false);

  const yes = fakeCtx({ ui: fakeUi({ answers: [true] }).ui });
  await askAdvanced(yes.ctx, 'x');
  assert.equal(asksAdvanced(yes.ctx), true);

  const quiet = fakeCtx({ ui: fakeUi({ yes: true }).ui });
  await askAdvanced(quiet.ctx, 'x');
  assert.equal(quiet.ctx.advanced, false, '--yes takes the defaults');
});

test('advanced: a plan with No asks only the essentials and keeps the defaults', async () => {
  const { ui, asked, text } = fakeUi();
  const { ctx, config } = newLakehouse(ui);
  await plan(ctx, PRE);
  assert.ok(asked.includes('Change the advanced settings?'));
  assert.ok(asked.includes('Which capacity should run it?'));
  for (const q of [...ADVANCED_QUESTIONS, ...VAULT_QUESTIONS, LIFETIME]) assert.ok(!asked.some((a) => a.startsWith(q)), `didn't ask "${q}"`);
  assert.match(text(), /Choose Yes to change who can view, audit history, tenant size, the Lakehouse name, the new Key Vault's details, the schedule and the first load\./);
  assert.equal(config.history.days, 180, 'all the audit history there is');
  assert.equal(config.scale, 'large', 'from the F64');
  assert.equal(config.fabric.lakehouseName, 'CopilotAnalytics');
  assert.equal(config.schedule.frequency, 'daily');
  assert.equal(config.schedule.time, '02:00');
  assert.equal(ctx.runFirstLoad, true);
  assert.equal(config.access?.groupName, 'AI in One Viewers');
});

test('advanced: a plan with Yes asks the settings behind it, the first load last', async () => {
  const { ui, asked } = fakeUi({ yesTo: ['Change the advanced settings?'] });
  const { ctx, config } = newLakehouse(ui);
  await plan(ctx, PRE);
  assert.deepEqual(
    asked.filter((a) => ADVANCED_QUESTIONS.includes(a)),
    ADVANCED_QUESTIONS,
  );
  assert.equal(asked.at(-1), 'Run the first load as soon as setup finishes?');
  assert.equal(config.history.days, 180, 'the defaults are offered');
  assert.equal(config.fabric.lakehouseName, 'CopilotAnalytics');
  assert.equal(config.access?.groupName, 'AI in One Viewers');
  assert.equal(ctx.runFirstLoad, true);
});

test('advanced: a section edited on its own asks its advanced questions, even after No', async () => {
  const placement = fakeUi();
  const p = newLakehouse(placement.ui);
  p.ctx.advanced = false;
  await plan(p.ctx, PRE, 'placement');
  assert.deepEqual(placement.asked, ['Which capacity should run it?', 'How many people are in the tenant?', 'Lakehouse name']);

  const schedule = fakeUi();
  const s = fakeCtx({ ui: schedule.ui, fabric: fakeFabric().api });
  s.ctx.advanced = false;
  await plan(s.ctx, PRE, 'schedule');
  assert.deepEqual(schedule.asked, [
    'How much audit history should the first load pull?',
    'How often should the pipeline run?',
    'Time (UTC, 24-hour)',
    'Run the first load as soon as setup finishes?',
  ]);
});

test('plan: a new install suggests AI in One names and says what capacity size suits', async () => {
  const t = fakeUi();
  const fabric = fakeFabric().api;
  const { ctx, config } = fakeCtx({ ui: t.ui, fabric: { ...fabric, listWorkspaces: async () => [{ id: 'ws-x', type: 'Workspace', displayName: 'Other' }] } });
  delete config.fabric.workspaceId;
  delete config.fabric.workspaceName;
  delete config.fabric.lakehouseId;
  delete config.fabric.lakehouseName;
  await plan(ctx, PRE);
  assert.equal(config.fabric.workspaceName, 'AI in One');
  assert.equal(config.fabric.lakehouseName, 'CopilotAnalytics');
  assert.match(t.text(), /F64 or larger is recommended for more than 10,000 people; small or trial capacities work but loads are slower\./);

  const taken = fakeCtx({ ui: fakeUi().ui, fabric: { ...fakeFabric().api, listWorkspaces: async () => [{ id: 'ws-x', type: 'Workspace', displayName: 'AI in One' }] } });
  delete taken.config.fabric.workspaceId;
  delete taken.config.fabric.workspaceName;
  await plan(taken.ctx, PRE);
  assert.equal(taken.config.fabric.workspaceName, 'AI in One 2', 'never the name of a workspace that exists');
});

test('plan: an existing record keeps its names', async () => {
  const { ui } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fakeFabric().api });
  delete config.fabric.lakehouseId;
  config.fabric.lakehouseName = 'Copilot_Data';
  await plan(ctx, PRE);
  assert.equal(config.fabric.lakehouseName, 'Copilot_Data');
});

test('plan: a new install keeps the secret in the notebooks by default; Key Vault is a choice', async () => {
  const u = fakeUi();
  const t = noVaultYet(u);
  assert.equal(defaultsToNoVault(t.ctx), true);
  await plan(t.ctx, PRE);
  assert.equal(t.config.keyVault.mode, 'notebook');
  assert.ok(u.asked.includes('Where should the app\'s client secret go?'));
  assert.ok(u.asked.includes('Keep the client secret in the notebooks, with no Key Vault?'));
  assert.ok(!u.asked.includes('Azure subscription'));
  assert.match(u.text(), /Anyone with a role in the workspace, Viewer included/);

  const quiet = noVaultYet(fakeUi({ yes: true }));
  await plan(quiet.ctx, PRE);
  assert.equal(quiet.config.keyVault.mode, 'notebook', '--yes takes the default');

  const v = fakeUi();
  const select = v.ui.select;
  v.ui.select = /** @type {any} */ (async (/** @type {string} */ m, /** @type {any[]} */ ch, /** @type {any} */ d) => (m === 'Where should the app\'s client secret go?' ? (v.asked.push(m), 'keyvault') : select(m, ch, d)));
  const kv = noVaultYet(v);
  await plan(kv.ctx, PRE);
  assert.ok(v.asked.includes('Azure subscription'), 'Key Vault goes to the vault questions');
  assert.notEqual(kv.config.keyVault.mode, 'notebook');

  // --key-vault, or a vault already chosen, skip the default.
  const flagged = noVaultYet(fakeUi());
  flagged.ctx.useKeyVault = true;
  assert.equal(defaultsToNoVault(flagged.ctx), false);
  const chosen = noVaultYet(fakeUi());
  chosen.config.keyVault.name = 'kv-test';
  assert.equal(defaultsToNoVault(chosen.ctx), false);
});

test('advanced: a secret in the notebooks asks its lifetime only with Yes, and only for an app the installer makes', async () => {
  const no = fakeUi();
  const quiet = noVaultYet(no);
  await plan(quiet.ctx, PRE);
  assert.equal(quiet.config.keyVault.mode, 'notebook');
  assert.ok(!no.asked.some((a) => a.startsWith(LIFETIME)));
  assert.equal(quiet.config.app.secretDays, undefined);

  const yes = fakeUi({ yesTo: ['Change the advanced settings?'] });
  const asked = noVaultYet(yes);
  await plan(asked.ctx, PRE);
  assert.ok(yes.asked.includes(`${LIFETIME} (1 to 730). Each install, repair or update replaces it.`));
  assert.equal(asked.config.app.secretDays, undefined, 'the default, 90 days, isn\'t saved');

  const own = fakeUi({ yesTo: ['Change the advanced settings?'] });
  const brought = noVaultYet(own);
  brought.config.app.existing = true;
  await plan(brought.ctx, PRE);
  assert.equal(brought.config.keyVault.mode, 'notebook');
  assert.ok(!own.asked.some((a) => a.startsWith(LIFETIME)), 'an app the user brought has its own secret');
});

test('advanced: a new Key Vault takes its defaults with No, and asks its details with Yes', async () => {
  for (const yes of [false, true]) {
    const u = fakeUi(yes ? { yesTo: ['Change the advanced settings?'] } : {});
    const { ctx, config } = noVaultYet(u);
    ctx.useKeyVault = true;
    await plan(ctx, PRE);
    assert.deepEqual(u.asked.filter((a) => VAULT_QUESTIONS.includes(a)), yes ? VAULT_QUESTIONS : [], yes ? 'Yes asks them' : 'No keeps the defaults');
    const kv = config.keyVault;
    assert.equal(kv.mode, undefined, 'the secret goes in the vault');
    assert.equal(kv.existing, false);
    assert.equal(kv.resourceGroup, 'rg-ai-in-one');
    assert.equal(kv.location, 'uksouth', 'the capacity\'s region');
    assert.match(String(kv.name), /^ai-in-one-[0-9a-f]{6}$/);
    assert.equal(kv.secretName, 'ai-in-one-client-secret');
  }
});

test('capacityLabel: the SKU and region when Fabric gives them', () => {
  assert.equal(capacityLabel({ id: 'c', displayName: 'Prod', sku: 'F64', region: 'UK South' }), 'Prod (F64, UK South)');
  assert.equal(capacityLabel({ id: 'c', displayName: 'Trial', sku: 'FT1' }), 'Trial (FT1)');
  assert.equal(capacityLabel({ id: 'c', displayName: 'Bare' }), 'Bare');
});
