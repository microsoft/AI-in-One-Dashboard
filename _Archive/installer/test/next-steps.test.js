// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { myGroupsUrl, reportLink, shareReport, shareReportPending, shareReportSteps, VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { REPORT_NAME } from '../src/config.js';
import { M365_ADMIN_URL, nextSteps, stepsLeftTitle } from '../src/steps/next-steps.js';
import { summary } from '../src/install.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const USER = { tenantId: 'tenant-1', upn: 'admin@contoso.com' };

/** A Fabric install with a viewer group and a published report. */
function installed(answers = /** @type {any[]} */ ([])) {
  const fake = fakeUi({ answers });
  const t = fakeCtx({ ui: fake.ui, fabric: fakeFabric().api });
  t.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com', createdGroup: true };
  Object.assign(t.config.semanticModel, { enabled: true, id: 'sm-1', bound: true, report: { id: 'rep-1', name: REPORT_NAME } });
  t.config.fabric.workspaceName = 'AI in One';
  return { ...t, ...fake };
}

const ids = (/** @type {{ id: string }[]} */ steps) => steps.map((s) => s.id);

test('share: asked once after the report is published; "I\'ve shared it" is saved and not asked again', async () => {
  const t = installed([true]);
  assert.equal(shareReportPending(t.config), true);
  await shareReport(t.ctx);
  assert.deepEqual(t.asked, ['Have you shared the report?']);
  assert.equal(t.config.access?.reportShared, true);
  assert.equal(t.saves(), 1);
  assert.match(t.text(), /groups\/ws-1\/reports\/rep-1\?ctid=tenant-1/, 'it links straight to the report');
  assert.match(t.text(), /next to the AI in One report/);
  assert.match(t.text(), /Choose Manage permissions\./);
  assert.match(t.text(), /enter "AI in One Viewers" and choose Grant/);
  assert.equal(shareReportPending(t.config), false);

  await shareReport(t.ctx);
  assert.equal(t.asked.length, 1, 'not asked again once it is shared');
});

test('share: Later leaves it to the summary, and Repair asks again', async () => {
  const t = installed([false]);
  await shareReport(t.ctx);
  assert.equal(t.config.access?.reportShared, undefined);
  assert.equal(t.saves(), 0);
  assert.match(t.text(), /can't open the report/);
  assert.equal(shareReportPending(t.config), true);
  assert.deepEqual(ids(nextSteps(t.config, USER)), ['share-report']);
});

test('share: nothing to share without a viewer group or a published report', async () => {
  const t = installed();
  t.config.access = undefined;
  assert.equal(shareReportPending(t.config), false);
  await shareReport(t.ctx);
  assert.deepEqual(t.asked, []);
  assert.match(t.text(), /no viewer group yet/);

  const u = installed();
  /** @type {any} */ (u.config.semanticModel.report).id = undefined;
  assert.equal(shareReportPending(u.config), false);
  await shareReport(u.ctx);
  assert.deepEqual(u.asked, []);
  assert.match(u.text(), /The report isn't published yet/);
  assert.deepEqual(nextSteps(u.config, USER), []);
});

test('share: the report link signs in to the tenant, and there is none until the report is published', () => {
  const t = installed();
  assert.equal(reportLink(t.config), 'https://app.powerbi.com/groups/ws-1/reports/rep-1');
  assert.equal(reportLink(t.config, 'tenant-1'), 'https://app.powerbi.com/groups/ws-1/reports/rep-1?ctid=tenant-1');
  assert.deepEqual(shareReportSteps(t.config, 'tenant-1'), [
    'Open AI in One in Power BI and choose … (More options) next to the AI in One report (https://app.powerbi.com/groups/ws-1/reports/rep-1?ctid=tenant-1).',
    'Choose Manage permissions.',
    'Choose Add user, enter "AI in One Viewers" and choose Grant.',
  ]);
  /** @type {any} */ (t.config.semanticModel.report).id = undefined;
  assert.equal(reportLink(t.config, 'tenant-1'), undefined);
  assert.doesNotMatch(shareReportSteps(t.config)[0], /https:/);
});

test('install: the share step comes after the report and the viewer group, before the first load waits', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  const at = (/** @type {string} */ s) => {
    const i = src.indexOf(s);
    assert.ok(i >= 0, `${s} is in install.js`);
    return i;
  };
  assert.ok(at("step('Power BI report')") < at("step('Share the report')"));
  assert.ok(at("step('Viewer access')") < at("step('Share the report')"));
  assert.ok(at("step('Share the report')") < at("step('First load')"));
  assert.match(src, /withShare = .*reportShared !== true/, 'not asked again once shared');
});

test('next steps: none left for an install with nothing to do', () => {
  const t = installed();
  /** @type {any} */ (t.config.access).reportShared = true;
  assert.deepEqual(nextSteps(t.config, USER), []);
  assert.deepEqual(nextSteps(t.config, USER, { concealedNames: false }), []);
  assert.equal(stepsLeftTitle([]), '0 optional steps');
});

test('next steps: in order, share the report, then the concealed-names hand-off; each says who and why', () => {
  const t = installed();
  const steps = nextSteps(t.config, USER, { concealedNames: true });
  assert.deepEqual(ids(steps), ['share-report', 'concealed-names']);
  for (const s of steps) assert.ok(s.title && s.why && s.who, `${s.id} has a title, why and who`);
  assert.equal(stepsLeftTitle(steps), '2 steps left');

  const [share, names] = steps;
  assert.equal(share.title, 'Share the report with AI in One Viewers');
  assert.equal(share.who, 'You');
  assert.equal(share.link, 'https://app.powerbi.com/groups/ws-1/reports/rep-1?ctid=tenant-1');
  assert.equal(share.linkText, 'Open the report');
  assert.equal(share.steps?.length, 3);
  assert.ok(share.why.includes(myGroupsUrl('g-1')), 'after sharing, people are given access through the group');
  assert.equal(share.message, undefined, 'the user does it, so nothing to send');

  assert.equal(names.title, 'Ask for user names in Microsoft 365 reports');
  assert.equal(names.who, 'A Global Administrator');
  assert.equal(names.link, M365_ADMIN_URL);
  assert.equal(names.steps?.length, 2);
  assert.match(String(names.message), /^Hi,/);
  assert.match(String(names.message), /\n1\. In the Microsoft 365 admin center, go to Settings > Org settings/);
  assert.match(String(names.message), /\n2\. Untick "Conceal user, group, and site names in all reports"/);
  assert.match(String(names.message), /Thanks\nadmin@contoso\.com$/, 'signed by the person running the installer');
  assert.match(String(nextSteps(t.config, {}, { concealedNames: true })[1].message), /Thanks$/, 'unsigned without a sign-in');
});

test('next steps: the concealed-names card shows only when the tenant check found the names concealed', () => {
  const t = installed();
  /** @type {any} */ (t.config.access).reportShared = true;
  assert.deepEqual(ids(nextSteps(t.config, USER, { concealedNames: true })), ['concealed-names']);
  assert.deepEqual(nextSteps(t.config, USER, { concealedNames: false }), []);
  assert.deepEqual(nextSteps(t.config, USER), [], 'not when the setting could not be read');
});

test('next steps: the title counts what is left, and what is optional', () => {
  const step = (/** @type {string} */ id, optional = false) => ({ id, title: id, why: '', who: '', optional });
  assert.equal(stepsLeftTitle([step('a')]), '1 step left');
  assert.equal(stepsLeftTitle([step('a', true)]), '1 optional step');
  assert.equal(stepsLeftTitle([step('a', true), step('b', true)]), '2 optional steps');
  assert.equal(stepsLeftTitle([step('a'), step('b', true)]), '1 step left, and 1 optional');
  assert.equal(stepsLeftTitle([step('a'), step('b'), step('c', true), step('d', true)]), '2 steps left, and 2 optional');
});

test('summary: what is left comes first, as cards, before the next steps', async () => {
  const t = installed();
  await summary(t.ctx, { concealedNames: true });
  const text = t.text();
  const left = text.indexOf('2 steps left');
  assert.ok(left >= 0, text);
  assert.ok(left < text.indexOf('Share the report with AI in One Viewers'));
  assert.ok(text.indexOf('Share the report with AI in One Viewers') < text.indexOf('Ask for user names in Microsoft 365 reports'));
  const next = text.indexOf('Next steps');
  assert.ok(next >= 0, text);
  assert.ok(left < next, 'the cards lead');
  assert.match(text, /Copy and send:/);
});

test('summary: after a failed step it says the setup is partly done, not set up', async () => {
  const t = installed();
  await summary(t.ctx);
  assert.match(t.text(), /AI in One is set up/);
  const p = installed();
  await summary(p.ctx, { ok: false });
  assert.match(p.text(), /AI in One is partly set up/);
  assert.doesNotMatch(p.text(), /AI in One is set up/);
  assert.match(p.text(), /run the installer again/);
});

test('install: a failed step or an unproven first load makes the install not ok, and the summary hears of concealed names', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  assert.match(src, /ok = reloads\.ok && ok && stepsOk;\r?\n\s*await summary\(ctx, \{ ok, pending: reloads\.pending, concealedNames: pre\?\.concealedNames \}\)/);
  assert.match(src, /if \(opts\.wait && config\.firstRun\?\.status !== 'Completed'\) ok = false;/);
});
