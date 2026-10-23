// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

/** A small DOM double exercises the real page renderers and their event payloads. */
class Element {
  /** @param {string} tag */
  constructor(tag) {
    this.tag = tag;
    /** @type {Element[]} */
    this.children = [];
    /** @type {Record<string, string>} */
    this.attributes = {};
    /** @type {Record<string, Function>} */
    this.events = {};
    this.value = '';
    this.selected = false;
    this.textContent = '';
    this.className = '';
    /** @type {Record<string, string>} */
    this.dataset = {};
    this.classList = { toggle() {} };
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'value') this.value = value;
    if (name === 'selected') this.selected = true;
  }
  /** @param {string} name @param {Function} handler */
  addEventListener(name, handler) { this.events[name] = handler; }
  /** @param {Element[]} kids */
  append(...kids) {
    this.children.push(...kids);
    if (this.tag === 'select') {
      this.value = this.children.find((child) => child.selected)?.value ?? this.children[0]?.value ?? '';
    }
  }
  /** @param {(Element | string)[]} kids */
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids.map((kid) => (typeof kid === 'string' ? Object.assign(new Element('#text'), { textContent: kid }) : kid)));
  }
  replaceWith() {}
  remove() {}
  /** @param {string} tag @returns {Element[]} */
  querySelectorAll(tag) { return this.children.flatMap(all).filter((el) => el.tag === tag); }
  /** @returns {string} */
  get text() { return this.textContent + this.children.map((child) => child.text).join(''); }
}

/** @param {{ live?: boolean }} [o]  live: answers go through the page's own answer(), to a fetch double that records each post. */
function page(o = {}) {
  /** @type {[string, unknown][]} */
  const posted = [];
  const context = createContext({
    Node: Element, matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 0, submitted: [], posted,
    fetch: async (/** @type {string} */ path, /** @type {{ body: string }} */ init) => {
      posted.push([path, JSON.parse(init.body)]);
      return { ok: true, status: 200, json: async () => ({}) };
    },
    document: {
      createElement: (/** @type {string} */ tag) => new Element(tag),
      createElementNS: (/** @type {string} */ ns, /** @type {string} */ tag) => new Element(tag),
      createTextNode: (/** @type {string} */ text) => Object.assign(new Element('#text'), { textContent: text }),
    },
  });
  const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8').replace(/\ninit\(\);\s*$/, '\n');
  runInContext(source, context);
  runInContext(`${o.live ? '' : 'answer = (item, value) => submitted.push(value); '}start = (command, extra = {}) => submitted.push({ command, ...extra });`, context);
  return context;
}

/** @param {Element} root @returns {Element[]} */
function all(root) { return [root, ...root.children.flatMap(all)]; }

test('settings page renders every category as a direct action and shows edits and earlier attempts', () => {
  const context = page();
  runInContext("app.attempts = [{ at: 0, state: 'failed', error: 'The capacity is paused' }];", context);
  const root = runInContext(`renderPrompt({
    id: 1, kind: 'settings', message: 'Review and fix setup', error: '',
    categories: [{ id: 'placement', title: 'Fabric placement', summary: 'AI in One; capacity: cap-2', complete: true },
      { id: 'schedule', title: 'Schedule and loading', summary: 'daily, 02:00 UTC; 180 days', complete: false }],
    notice: 'Review Fabric placement: the selected capacity is no longer active or accessible.',
    changes: ['Fabric placement: AI in One; capacity: cap-1 -> AI in One; capacity: cap-2']
  })`, context);
  assert.match(root.text, /Fabric placement.*Reviewed.*Edit settings.*Schedule and loading.*Needs review/);
  assert.match(root.text, /no longer active or accessible/);
  assert.match(root.text, /capacity: cap-1 -> AI in One; capacity: cap-2/);
  assert.match(root.text, /Previous attempts in this session.*The capacity is paused/);
  const button = (/** @type {string} */ label) => all(root).find((el) => el.tag === 'button' && el.text.startsWith(label));
  for (const label of ['Fabric placement', 'Review and deploy', 'Save and close']) button(label)?.events.click();
  assert.deepEqual([...context.submitted], ['placement', 'deploy', 'close']);
});

test('grouped form submits all related fields together and explains locked fields', () => {
  const context = page();
  const root = runInContext(`renderPrompt({
    id: 2, kind: 'form', message: 'Schedule', error: '',
    fields: [{ id: 'frequency', label: 'Frequency', default: 'weekly',
      choices: [{ name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }] },
      { id: 'weekday', label: 'Day (weekly schedules only)', default: 'Sunday',
        choices: [{ name: 'Saturday', value: 'Saturday' }, { name: 'Sunday', value: 'Sunday' }] },
      { id: 'time', label: 'Time (UTC, 24-hour)', default: '02:00', readOnly: 'Already deployed' }],
    settingsBack: true
  })`, context);
  assert.match(root.text, /Already deployed/);
  assert.match(root.text, /Back to settings/);
  assert.equal(all(root).filter((el) => el.tag === 'select').length, 2);
  root.events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(context.submitted[0])), { frequency: 'weekly', weekday: 'Sunday', time: '02:00' });
});

test('failure page offers direct category edit, all settings and saved-config retry without Home', () => {
  const context = page();
  const root = runInContext(`renderOutcome({
    command: 'install', state: 'failed', phase: 'build', startedAt: 0, endedAt: 1000,
    error: 'The capacity is paused\\nCapacityNotActive: the capacity is not active',
    recovery: { section: 'placement', label: 'Change region or capacity' }
  })`, context);
  for (const label of ['Change region or capacity', 'Edit all settings', 'Retry saved configuration']) {
    const button = all(root).find((el) => el.tag === 'button' && el.text === label);
    assert.ok(button, label);
    button.events.click();
  }
  assert.deepEqual(JSON.parse(JSON.stringify(context.submitted)), [
    { command: 'install', section: 'placement' },
    { command: 'install' },
    { command: 'install', retry: true },
  ]);
  assert.match(root.text, /Technical details.*CapacityNotActive/s);
});

test('run page: an install step with a ✗ line shows as failed, even when the install carries on past it', () => {
  const context = page();
  const install = runInContext(`
    app.replay = true;
    app.run = createRun({ type: 'command', command: 'install', state: 'running', at: 0, seq: 1 });
    [
      { type: 'step', n: 1, total: 3, title: 'Power BI report', at: 1 },
      { type: 'line', kind: 'fail', text: "The AI in One report wasn't published: the import failed", at: 2 },
      { type: 'step', n: 2, total: 3, title: 'Share the report', at: 3 },
      { type: 'line', kind: 'warn', text: "The report isn't published yet, so there's nothing to share. The summary at the end says what to do.", at: 4 },
      { type: 'step', n: 3, total: 3, title: 'Model refresh', at: 5 },
      { type: 'line', kind: 'fail', text: 'AI in One refreshed, but a test query failed, so report pages will fail', at: 6 },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'install', state: 'done', at: 7, seq: 2 });
    app.run.stages.find((s) => s.title === 'Setting up').kids.map((k) => [k.title, k.status, k.el.dataset.status]);
  `, context);
  assert.deepEqual(JSON.parse(JSON.stringify(install)), [
    ['Power BI report', 'failed', 'failed'],
    ['Share the report', 'done', 'done'],
    ['Model refresh', 'failed', 'failed'],
  ]);

  // Other commands' sections aren't steps: status shows an earlier run that failed with ✗, and checking it didn't fail.
  const status = runInContext(`
    app.run = createRun({ type: 'command', command: 'status', state: 'running', at: 0, seq: 3 });
    [
      { type: 'heading', title: 'Recent runs', at: 1 },
      { type: 'line', kind: 'fail', text: '2026-06-01 02:00 UTC  Failed, 3 h 45 min  Scheduled', at: 2 },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'status', state: 'done', at: 3, seq: 4 });
    app.run.stages[1].kids.map((k) => [k.title, k.status]);
  `, context);
  assert.deepEqual(JSON.parse(JSON.stringify(status)), [['Recent runs', 'done']]);
});

test('run page: a failed load leaves the install partly set up, with Rerun failed beside the next steps', () => {
  const context = page();
  const audit = { activity: 'Run_Audit_Log_Ingester', name: 'Copilot audit log', state: 'failed', fix: [] };
  const users = { activity: 'Run_Licensed_Users_Ingester', name: 'Licensed users', state: 'ok', fix: [] };
  /** An install whose First load ends with these cards, then sharing the report as a next step. @param {any[]} cards */
  const firstLoad = (cards) => JSON.parse(JSON.stringify(runInContext(`
    app.replay = true;
    app.state = { record: { can: { 'rerun-failed': true } } };
    app.run = createRun({ type: 'command', command: 'install', state: 'running', at: 0, seq: 1 });
    [
      { type: 'step', n: 1, total: 1, title: 'First load', at: 1 },
      { type: 'line', kind: 'ok', text: 'Pipeline finished in 2 h', at: 2 },
      { type: 'loads', cards: ${JSON.stringify(cards)}, at: 3 },
      { type: 'next-steps', title: '1 step left', at: 4, steps: [{ id: 'share-report', title: 'Share the report with AI in One Viewers',
        why: "Once only. Until it's shared, people in the group can't open the report.", who: 'You' }] },
    ].forEach(apply);
    onCommand({ type: 'command', command: 'install', state: 'done', at: 5, seq: 2 });
    ({
      step: app.run.stages.find((s) => s.title === 'Setting up').kids[0].status,
      loads: [...runItems(app.run.stages)].find((it) => it.t === 'loads').el.text,
      outcome: app.run.outcomeEl.text,
    });
  `, context)));

  // Every failed load counts, whatever the reason: nothing waits on a later step.
  const failed = firstLoad([{ ...audit, kind: 'capacity', reason: "Fabric's capacity was too busy to start it.", counted: true }, users]);
  assert.equal(failed.step, 'failed');
  assert.match(failed.loads, /Copilot audit log failed.*too busy to start it.*Licensed users loaded/);
  assert.match(failed.outcome, /Share the report with AI in One Viewers/);
  assert.match(failed.outcome, /Some loads failed/);
  assert.match(failed.outcome, /Rerun failed/);

  const loaded = firstLoad([{ ...audit, state: 'ok' }, users]);
  assert.equal(loaded.step, 'done');
  assert.match(loaded.outcome, /Share the report with AI in One Viewers/);
  assert.doesNotMatch(loaded.outcome, /Some loads failed|Rerun failed/);
});

test('run page: Run now asks before it drops loaded history, and the question is answered on the page', async () => {
  const context = page({ live: true });
  const item = runInContext(`
    app.replay = true;
    app.run = createRun({ type: 'command', command: 'run', state: 'running', at: 0, seq: 1 });
    onSignin({ type: 'signin', state: 'reused', user: { upn: 'admin@contoso.com' }, at: 1 });
    [
      { type: 'line', kind: 'warn', text: 'This rebuilds the audit table with 30 days of history, so the 180 days loaded now drop to 30.', at: 2 },
      { type: 'prompt', id: 7, kind: 'confirm', message: 'Reload only 30 days?', default: false, at: 3 },
    ].forEach(apply);
    app.run.prompts.get(7);
  `, context);
  assert.equal(item.stage.title, 'Pipeline run', 'it shows in the run, not under sign-in');
  assert.match(item.stage.body.text, /drop to 30\..*Reload only 30 days\?/);
  const no = all(item.el).find((el) => el.tag === 'button' && el.text === 'No');
  assert.equal(no?.className, 'btn primary', 'keeping the history is the default');
  await no?.events.click();
  assert.deepEqual(JSON.parse(JSON.stringify(context.posted)), [['/api/answer', { id: 7, value: false }]]);

  runInContext("apply({ type: 'answered', id: 7, display: 'No', at: 4 });", context);
  assert.equal(item.t, 'qa');
  assert.match(item.el.text, /Reload only 30 days\?No/);
});
