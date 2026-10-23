// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../src/config.js';
import { memoApi, rewindable } from '../src/install.js';
import { mirror, reopenOnEnter, startServer } from '../src/server.js';
import { createWebUi, plainText, SECRET_MASK, toSegments } from '../src/web-ui.js';
import { describeRecord, prereqsSnapshot, WEB_COMMANDS } from '../src/web-session.js';
import { fakeCtx } from './fakes.js';

const SRC = new URL('../src/', import.meta.url);

/**
 * @param {number} port
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string, until?: string }} o
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function call(port, o) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        // An event stream never ends on its own, so stop once the expected frame is in.
        if (o.until && body.includes(o.until)) {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        }
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** @param {Record<string, any>} [session] Kept by reference, so a test can change it later. */
async function serve(session = {}) {
  const ui = createWebUi({ now: () => 1000 });
  session.running ??= null;
  session.state ??= () => ({ installed: false });
  session.start ??= () => ({ ok: true });
  const server = await startServer({ ui, session: /** @type {any} */ (session), token: 'tok' });
  const cookie = `aio_${server.port}=tok`;
  const post = (/** @type {string} */ path, /** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = {}) =>
    call(server.port, {
      method: 'POST',
      path,
      body: JSON.stringify(body),
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${server.port}`, 'Content-Type': 'application/json', ...headers },
    });
  return { ui, server, cookie, post };
}

const tick = () => new Promise((r) => setImmediate(r));

/** The newest event. @param {{ history: () => import('../src/web-ui.js').UiEvent[] }} ui */
const latest = (ui) => /** @type {import('../src/web-ui.js').UiEvent} */ (ui.history().at(-1));

/**
 * Asks the questions again each time Back stops them, as rewindable() does in the installer.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function untilDone(fn) {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (/** @type {Error} */ (err).name !== 'GoBack') throw err;
    }
  }
}

test('web ui: colours become styled runs and plain text drops them', () => {
  const s = '\x1b[1mBold\x1b[22m and \x1b[32mgreen\x1b[39m\x1b[2K\r';
  assert.deepEqual(toSegments(s), [{ text: 'Bold', bold: true }, { text: ' and ' }, { text: 'green', colour: 'green' }]);
  assert.equal(plainText(s), 'Bold and green');
});

test('web ui: output and a device code become events, replayable from any point', () => {
  const ui = createWebUi({ now: () => 5 });
  ui.heading('Fabric');
  ui.ok('\x1b[32mWorkspace\x1b[39m is ready');
  ui.line('To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-1234 to authenticate.');
  ui.line('   ');
  const all = ui.history();
  assert.deepEqual(all.map((e) => e.type), ['heading', 'line', 'device-code']);
  assert.equal(all[1].text, 'Workspace is ready');
  assert.equal(all[1].kind, 'ok');
  assert.deepEqual([all[2].url, all[2].code], ['https://microsoft.com/devicelogin', 'ABCD-1234']);
  assert.deepEqual(ui.history(2).map((e) => e.seq), [3]);
});

test('web ui: a wrong answer leaves the question open; a right one resolves it', async () => {
  const ui = createWebUi();
  const asked = ui.select('Which capacity?', [
    { name: 'F2', value: 'a', disabled: 'Paused' },
    { name: 'F4', value: 'b' },
    { name: 'F8', value: 'c' },
  ], 'c');
  const prompt = ui.history().find((e) => e.type === 'prompt');
  assert.equal(prompt?.default, 2);
  assert.deepEqual(prompt?.choices[0], { name: 'F2', disabled: 'Paused' });
  assert.deepEqual(ui.answer(prompt?.id, 0), { ok: false, error: 'Choose one of the options.' });
  assert.equal(ui.history().at(-1)?.type, 'invalid');
  assert.deepEqual(ui.answer(prompt?.id, 1), { ok: true });
  assert.equal(await asked, 'b');
  assert.equal(ui.history().at(-1)?.display, 'F4');
  assert.equal(ui.answer(prompt?.id, 1).ok, false, 'an answered question is closed');
});

test('web ui: a question with one open choice answers itself', async () => {
  const ui = createWebUi();
  assert.equal(await ui.select('Which tenant?', [{ name: 'Contoso', value: 't1' }, { name: 'Fabrikam', value: 't2', disabled: true }]), 't1');
  assert.deepEqual(ui.history().map((e) => [e.type, e.display]), [['auto', 'Contoso']]);
});

test('web ui: input defaults and validates; checkbox refuses disabled options', async () => {
  const ui = createWebUi();
  const name = ui.input('Workspace name', { default: 'AI in One', validate: (v) => (v.length < 40 ? true : 'Too long') });
  const id = ui.history().at(-1)?.id;
  assert.equal(ui.answer(id, 'x'.repeat(50)).error, 'Too long');
  ui.answer(id, '');
  assert.equal(await name, 'AI in One');

  const picked = ui.checkbox('What else?', [{ name: 'Credit', value: 'cc' }, { name: 'Licences', value: 'lic', disabled: 'Not licensed' }, { name: 'M365', value: 'm365' }]);
  const box = ui.history().at(-1)?.id;
  assert.equal(ui.answer(box, [1]).ok, false);
  ui.answer(box, [2, 0, 2]);
  assert.deepEqual(await picked, ['cc', 'm365']);
  assert.equal(ui.history().at(-1)?.display, 'Credit, M365');
});

test('web ui: a secret never reaches the history or the page', async () => {
  const ui = createWebUi();
  const seen = /** @type {string[]} */ ([]);
  ui.subscribe((e) => seen.push(JSON.stringify(e)));
  const secret = ui.secret('Client secret');
  const id = ui.history().at(-1)?.id;
  assert.equal(ui.answer(id, '   ').error, 'Required');
  ui.answer(id, 's3cr3t-value');
  assert.equal(await secret, 's3cr3t-value');
  assert.equal(ui.history().at(-1)?.display, SECRET_MASK);
  assert.ok(!JSON.stringify(ui.history()).includes('s3cr3t-value'));
  assert.ok(!seen.join('').includes('s3cr3t-value'));
});

test('web ui: cancel stops at the open question, as Ctrl+C does', async () => {
  const ui = createWebUi();
  assert.equal(ui.cancel(), false);
  const asked = ui.confirm('Go ahead?', true);
  assert.equal(ui.cancel(), true);
  await assert.rejects(asked, { name: 'ExitPromptError' });
  assert.equal(ui.history().at(-1)?.cancelled, true);
});

test('web ui: Back asks again from the start, gives the earlier answers again and opens the last one as it was', async () => {
  const ui = createWebUi();
  ui.heading('Before');
  ui.begin();
  /** @type {{ id: string }[]} */
  let offered = [];
  const done = untilDone(async () => {
    // New objects each time, as a fresh API call gives.
    offered = [{ id: 'a' }, { id: 'b' }];
    const ws = await ui.select('Workspace', offered.map((v) => ({ name: v.id.toUpperCase(), value: v })));
    const name = await ui.input('Lakehouse name', { default: 'Lakehouse1' });
    const extras = await ui.checkbox('Extras', [{ name: 'Credit', value: 'cc' }, { name: 'M365', value: 'm365' }]);
    const go = await ui.confirm('Go ahead?', true);
    return { ws, name, extras, go };
  });

  assert.equal('back' in latest(ui), false, 'nothing to go back to from the first question');
  assert.equal(ui.back(), false);
  ui.answer(latest(ui).id, 1);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).back], ['Lakehouse name', true]);
  ui.answer(latest(ui).id, 'Lake1');
  await tick();
  ui.answer(latest(ui).id, [1]);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).back], ['Go ahead?', true]);

  assert.equal(ui.back(), true);
  await tick();
  assert.deepEqual(ui.history().map((e) => [e.type, e.message ?? e.title ?? '', !!e.replayed]), [
    ['heading', 'Before', false],
    ['rewind', '', false],
    ['prompt', 'Workspace', true],
    ['answered', '', true],
    ['prompt', 'Lakehouse name', true],
    ['answered', '', true],
    ['prompt', 'Extras', false],
  ]);
  assert.equal(ui.history()[1].to, ui.history()[0].seq, 'the page drops what came after begin()');
  assert.deepEqual(latest(ui).choices.map((/** @type {any} */ ch) => ch.checked), [false, true], 'opens with the boxes that were ticked');
  assert.equal(latest(ui).back, true);

  assert.equal(ui.back(), true);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).default], ['Lakehouse name', 'Lake1']);
  ui.answer(latest(ui).id, 'Lake2');
  await tick();
  assert.equal(latest(ui).choices.some((/** @type {any} */ ch) => 'checked' in ch), false, 'after a new answer the rest are asked fresh');
  ui.answer(latest(ui).id, [0]);
  await tick();
  ui.answer(latest(ui).id, true);
  const result = await done;
  assert.deepEqual(result, { ws: { id: 'b' }, name: 'Lake2', extras: ['cc'], go: true });
  assert.equal(result.ws, offered[1], 'a choice given again is the one offered this time');
  assert.equal(ui.back(), false, 'no question is open');

  ui.end();
  const next = ui.input('Next');
  ui.answer(latest(ui).id, 'y');
  await next;
  const later = ui.input('Later');
  assert.equal(ui.back(), false, 'no going back past end()');
  ui.cancel();
  await assert.rejects(later, { name: 'ExitPromptError' });
});

test('web ui: Back gives a secret again from memory and never shows it; back at it, an empty answer keeps it', async () => {
  const ui = createWebUi();
  const seen = /** @type {string[]} */ ([]);
  ui.subscribe((e) => seen.push(JSON.stringify(e)));
  ui.begin();
  const done = untilDone(async () => ({
    clientId: await ui.input('Client ID'),
    secret: await ui.secret('Client secret'),
    name: await ui.input('Name'),
    go: await ui.confirm('Go ahead?', true),
  }));
  ui.answer(latest(ui).id, 'c1');
  await tick();
  ui.answer(latest(ui).id, 'first-s3cr3t');
  await tick();
  ui.answer(latest(ui).id, 'n1');
  await tick();

  assert.equal(ui.back(), true);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).default], ['Name', 'n1'], 'Back from Go ahead goes past the secret');
  assert.equal(ui.history().find((e) => e.kind === 'secret')?.replayed, true);

  assert.equal(ui.back(), true);
  await tick();
  const asked = latest(ui);
  assert.deepEqual([asked.kind, asked.keep, asked.back], ['secret', true, true]);
  assert.equal(ui.answer(asked.id, '  ').error, 'Required', 'only an empty answer keeps it');
  ui.answer(asked.id, '');
  await tick();
  assert.deepEqual([latest(ui).message, 'default' in latest(ui)], ['Name', false], 'after a new answer the rest are asked fresh');
  ui.answer(latest(ui).id, 'n2');
  await tick();
  ui.answer(latest(ui).id, true);
  assert.deepEqual(await done, { clientId: 'c1', secret: 'first-s3cr3t', name: 'n2', go: true });
  assert.doesNotMatch(JSON.stringify(ui.history()), /s3cr3t/);
  assert.doesNotMatch(seen.join(''), /s3cr3t/);
  ui.end();
});

test('web ui: back at a secret, a new one replaces it, and that is the one an empty answer keeps after', async () => {
  const ui = createWebUi();
  ui.begin();
  const done = untilDone(async () => ({ secret: await ui.secret('Client secret'), name: await ui.input('Name') }));
  ui.answer(latest(ui).id, 'first-s3cr3t');
  await tick();

  assert.equal(ui.back(), true);
  await tick();
  assert.equal(latest(ui).keep, true);
  ui.answer(latest(ui).id, 'second-s3cr3t');
  await tick();
  assert.equal(latest(ui).message, 'Name');

  assert.equal(ui.back(), true);
  await tick();
  assert.equal(latest(ui).keep, true);
  ui.answer(latest(ui).id, '');
  await tick();
  ui.answer(latest(ui).id, 'n1');
  assert.deepEqual(await done, { secret: 'second-s3cr3t', name: 'n1' });
  assert.doesNotMatch(JSON.stringify(ui.history()), /s3cr3t/);
  ui.end();
});

test('server: only the printed link opens it, and every call needs its cookie', async () => {
  const { server, cookie } = await serve();
  try {
    assert.equal((await call(server.port, { path: '/?t=wrong' })).status, 403);
    const opened = await call(server.port, { path: '/?t=tok' });
    assert.equal(opened.status, 303);
    assert.match(String(opened.headers['set-cookie']), new RegExp(`^aio_${server.port}=tok; HttpOnly; SameSite=Strict`));
    assert.equal((await call(server.port, { path: '/' })).status, 401);
    assert.equal((await call(server.port, { path: '/api/state', headers: { Cookie: `aio_${server.port}=nope` } })).status, 401);
    const state = await call(server.port, { path: '/api/state', headers: { Cookie: cookie } });
    assert.equal(state.status, 200);
    assert.deepEqual(JSON.parse(state.body), { installed: false });
    const html = await call(server.port, { path: '/', headers: { Cookie: cookie } });
    assert.match(html.body, /<title>AI in One installer<\/title>/);
    assert.match(String(html.headers['content-security-policy']), /default-src 'none'/);
  } finally {
    server.close();
    await server.done;
  }
});

test('server: refuses another host name, another site and anything but JSON', async () => {
  const { server, post } = await serve();
  try {
    assert.equal((await call(server.port, { path: '/?t=tok', headers: { Host: `evil.example:${server.port}` } })).status, 421);
    assert.equal((await post('/api/cancel', {}, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/cancel', {}, { Origin: '' })).status, 403);
    assert.equal((await post('/api/cancel', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await call(server.port, { method: 'PUT', path: '/api/cancel', headers: { Cookie: `aio_${server.port}=tok` } })).status, 405);
  } finally {
    server.close();
    await server.done;
  }
});

test('server: answers reach the open question; a reconnecting page gets only what it missed', async () => {
  const { ui, server, cookie, post } = await serve();
  try {
    ui.heading('Fabric');
    const name = ui.input('Workspace name', { validate: (v) => (v ? true : 'Type a name') });
    const id = ui.history().at(-1)?.id;
    const bad = await post('/api/answer', { id, value: '' });
    assert.equal(bad.status, 422);
    assert.equal(JSON.parse(bad.body).error, 'Type a name');
    assert.equal((await post('/api/answer', { id, value: 'AI in One' })).status, 200);
    assert.equal(await name, 'AI in One');

    const stream = await call(server.port, { path: '/events', headers: { Cookie: cookie, 'Last-Event-ID': '2' }, until: '"type":"answered"' });
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers['content-type']), /^text\/event-stream/);
    const ids = [...stream.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, [3, 4], 'replays from after Last-Event-ID');
  } finally {
    server.close();
    await server.done;
  }
});

test('server: start passes through; quit waits for a running command', async () => {
  /** @type {unknown[]} */
  const started = [];
  /** @type {Record<string, any>} */
  const session = {
    running: 'install',
    start: (/** @type {unknown} */ body) => {
      started.push(body);
      return { ok: false, status: 409, error: 'Busy' };
    },
  };
  const { server, post } = await serve(session);
  try {
    const start = await post('/api/start', { command: 'status' });
    assert.equal(start.status, 409);
    assert.deepEqual(started, [{ command: 'status' }]);
    assert.equal((await post('/api/quit', {})).status, 409);
    session.running = null;
    assert.equal((await post('/api/quit', {})).status, 200);
    await server.done;
  } finally {
    server.close();
  }
});

test('server: start fresh and keep the record pass through, behind the same checks', async () => {
  let fresh = /** @type {any} */ ({ ok: true, archived: 'C:\\Docs\\aio-install.20260507-090302.json' });
  let kept = 0;
  const { server, post } = await serve({ startFresh: () => fresh, keepRecord: () => (kept++, { ok: true }) });
  try {
    const ok = await post('/api/fresh', {});
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), fresh);
    fresh = { ok: false, status: 409, error: 'Wait for the current command to finish.' };
    const busy = await post('/api/fresh', {});
    assert.equal(busy.status, 409);
    assert.equal(JSON.parse(busy.body).error, 'Wait for the current command to finish.');
    assert.equal((await post('/api/keep', {})).status, 200);
    assert.equal(kept, 1);

    assert.equal((await call(server.port, { method: 'POST', path: '/api/fresh', body: '{}', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${server.port}` } })).status, 401);
    assert.equal((await post('/api/fresh', {}, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/keep', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(kept, 1);
  } finally {
    server.close();
    await server.done;
  }
});

test('server: a page without the link says to press Enter in the installer window, and Enter opens it again', async () => {
  const { server } = await serve();
  try {
    const bare = await call(server.port, { path: '/' });
    assert.equal(bare.status, 401);
    assert.match(bare.body, /needs the installer's link\. Go back to .* and press Enter there to open the installer again\./);
    assert.match((await call(server.port, { path: '/?t=wrong' })).body, /expired\. Go back to .* press Enter/);
    assert.match(JSON.parse((await call(server.port, { path: '/api/state' })).body).error, /press Enter/);
  } finally {
    server.close();
    await server.done;
  }

  const input = new PassThrough();
  let opened = 0;
  const stop = reopenOnEnter(input, () => opened++);
  input.write('x');
  await tick();
  assert.equal(opened, 0);
  input.write('\r\n');
  await tick();
  assert.equal(opened, 1, 'one Enter, one page');
  stop();
  input.write('\n');
  await tick();
  assert.equal(opened, 1);
});

test('server: Back to settings cancels only an open category and keeps the installer session available', async () => {
  const { ui, server, post } = await serve();
  try {
    assert.equal((await post('/api/section-cancel', {})).status, 409);
    ui.beginSection();
    const asked = ui.form('Fabric placement', [{ id: 'capacity', label: 'Capacity', default: 'F64' }]);
    const cancelled = assert.rejects(asked, { name: 'SettingsCancelled' });
    assert.equal((await post('/api/section-cancel', {})).status, 200);
    await cancelled;
    ui.endSection();
    assert.equal((await post('/api/section-cancel', {})).status, 409);
    const next = ui.confirm('Continue?', true);
    assert.equal((await post('/api/answer', { id: latest(ui).id, value: true })).status, 200);
    assert.equal(await next, true);
  } finally {
    server.close();
    await server.done;
  }
});

test('server: Back works once there is an earlier question', async () => {
  const { ui, server, post } = await serve();
  try {
    ui.begin();
    const first = ui.input('Workspace name');
    const refused = await post('/api/back', {});
    assert.equal(refused.status, 409);
    assert.equal(JSON.parse(refused.body).error, 'There\'s no earlier question to go back to.');
    ui.answer(latest(ui).id, 'AI in One');
    assert.equal(await first, 'AI in One');
    const second = ui.input('Lakehouse name');
    const stopped = assert.rejects(second, { name: 'GoBack' });
    assert.equal((await post('/api/back', {})).status, 200);
    await stopped;
    assert.equal(latest(ui).type, 'rewind');
  } finally {
    ui.end();
    server.close();
    await server.done;
  }
});

test('terminal: after Back it shows the question the user went back to, not the answers given again', async () => {
  const ui = createWebUi();
  /** @type {string[]} */
  const out = [];
  ui.subscribe(mirror((s) => out.push(plainText(s))));
  ui.begin();
  const done = untilDone(async () => {
    ui.heading('Fabric');
    const ws = await ui.input('Workspace name');
    const lh = await ui.input('Lakehouse name');
    return { ws, lh, go: await ui.confirm('Go ahead?', true) };
  });
  ui.answer(latest(ui).id, 'AI in One');
  await tick();
  ui.answer(latest(ui).id, 'Lake');
  await tick();
  assert.equal(ui.back(), true);
  await tick();
  ui.answer(latest(ui).id, 'Lake2');
  await tick();
  ui.answer(latest(ui).id, true);
  assert.deepEqual(await done, { ws: 'AI in One', lh: 'Lake2', go: true });
  ui.end();
  assert.deepEqual(out.join('').split('\n').filter((l) => l.trim()), [
    'Fabric',
    '? Workspace name (answer in the browser)',
    '  → AI in One',
    '? Lakehouse name (answer in the browser)',
    '  → Lake',
    '? Go ahead? (answer in the browser)',
    '  ← Back',
    '? Lakehouse name (answer in the browser)',
    '  → Lake2',
    '? Go ahead? (answer in the browser)',
    '  → Yes',
  ]);
});

test('web ui: load cards become one event, and the terminal shows each load with its fix', () => {
  const ui = createWebUi();
  /** @type {string[]} */
  const out = [];
  ui.subscribe(mirror((s) => out.push(plainText(s))));
  /** @type {import('../src/loads.js').LoadCard[]} */
  const cards = [
    { activity: 'Run_Licensed_Users_Ingester', name: 'Licensed users', state: 'ok', fix: [] },
    { activity: 'Run_Audit_Log_Ingester', name: 'Copilot audit log', state: 'failed', reason: 'The capacity was busy.', fix: ['Try again later.'] },
    { activity: 'Run_Org_Data_Ingester', name: 'Org data', state: 'skipped', fix: [] },
    { activity: 'Refresh_Semantic_Model', name: 'AI in One model refresh', state: 'running', fix: [] },
  ];
  ui.loads(cards);
  const e = latest(ui);
  assert.equal(e.type, 'loads');
  assert.deepEqual(e.cards.map((/** @type {any} */ c) => c.state), ['ok', 'failed', 'skipped', 'running']);
  const lines = out.join('').split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines.slice(-6), [
    `${String.fromCharCode(10003)} Licensed users`,
    `${String.fromCharCode(10007)} Copilot audit log: failed`,
    'The capacity was busy.',
    'Try again later.',
    '! Org data: skipped',
    '! AI in One model refresh: still running',
  ]);
});

test('rewindable: Back puts the config back and reuses the API calls; the terminal just runs', async () => {
  const ui = createWebUi();
  let lists = 0;
  const fabric = {
    listWorkspaces: async () => {
      lists++;
      return [{ id: 'w1', displayName: 'One', type: 'Workspace' }, { id: 'w2', displayName: 'Two', type: 'Workspace' }];
    },
  };
  const { ctx, config } = fakeCtx({ ui: /** @type {any} */ (ui), fabric, sources: /** @type {any} */ ({}) });
  const real = ctx.api;
  const before = config.fabric.lakehouseName;
  const done = rewindable(ctx, async () => {
    const workspaces = await ctx.api.fabric.listWorkspaces();
    config.fabric.workspaceId = await ui.select('Workspace', workspaces.map((w) => ({ name: w.displayName, value: w.id })));
    config.fabric.lakehouseName = await ui.input('Lakehouse name', { default: config.fabric.lakehouseName });
    ctx.pendingSecret = 'pasted';
    return ui.confirm('Go ahead?', true);
  });
  await tick();
  assert.notEqual(ctx.api, real);
  ui.answer(latest(ui).id, 1);
  await tick();
  ui.answer(latest(ui).id, 'Lake1');
  await tick();
  assert.deepEqual([config.fabric.lakehouseName, ctx.pendingSecret], ['Lake1', 'pasted']);

  assert.equal(ui.back(), true);
  await tick();
  assert.deepEqual([latest(ui).message, latest(ui).default], ['Lakehouse name', 'Lake1']);
  assert.equal(config.fabric.lakehouseName, before, 'the config is as it was before the questions');
  assert.equal(ctx.pendingSecret, undefined);
  assert.equal(config.fabric.workspaceId, 'w2', 'the answer given again is in the config');
  assert.equal(lists, 1, 'the workspaces are listed once');

  ui.answer(latest(ui).id, 'Lake2');
  await tick();
  ui.answer(latest(ui).id, true);
  assert.equal(await done, true);
  assert.equal(ctx.api, real);
  assert.equal(ctx.config, config, 'put back in place, so save() still writes it');
  assert.deepEqual([config.fabric.lakehouseName, ctx.pendingSecret], ['Lake2', 'pasted']);

  const plain = fakeCtx({ sources: /** @type {any} */ ({}) });
  const plainApi = plain.ctx.api;
  assert.equal(await rewindable(plain.ctx, async () => plain.ctx.api === plainApi), true, 'the terminal can\'t go back, so nothing changes');

  const ui2 = createWebUi();
  const other = fakeCtx({ ui: /** @type {any} */ (ui2), sources: /** @type {any} */ ({}) });
  const otherApi = other.ctx.api;
  const failing = rewindable(other.ctx, async () => {
    await ui2.input('Workspace name');
    throw new Error('boom');
  });
  await tick();
  ui2.answer(latest(ui2).id, 'x');
  await assert.rejects(failing, /boom/);
  assert.equal(other.ctx.api, otherApi);
  const next = ui2.input('Next');
  ui2.answer(latest(ui2).id, 'y');
  await next;
  const after = ui2.input('After');
  assert.equal(ui2.back(), false, 'recording stopped with the error');
  ui2.cancel();
  await assert.rejects(after, { name: 'ExitPromptError' });
});

test('memoApi: the same call is made once, each caller gets its own copy, and a failure is not kept', async () => {
  /** @type {string[]} */
  const calls = [];
  let fail = true;
  const real = /** @type {any} */ ({
    fabric: {
      listItems: async (/** @type {string} */ ws, /** @type {string} */ type) => {
        calls.push(`listItems ${ws} ${type}`);
        return [{ id: `${ws}-1`, type }];
      },
      flaky: async () => {
        calls.push('flaky');
        if (fail) {
          fail = false;
          throw new Error('throttled');
        }
        return 'ok';
      },
      count: () => calls.length,
      each: async (/** @type {() => void} */ fn) => {
        calls.push('each');
        fn();
      },
    },
    token: (/** @type {string} */ scope) => ({ scope }),
  });
  const api = /** @type {any} */ (memoApi(real));

  const first = await api.fabric.listItems('ws', 'Lakehouse');
  first[0].id = 'changed';
  assert.deepEqual(await api.fabric.listItems('ws', 'Lakehouse'), [{ id: 'ws-1', type: 'Lakehouse' }]);
  await api.fabric.listItems('ws', 'Notebook');
  assert.deepEqual(calls, ['listItems ws Lakehouse', 'listItems ws Notebook']);

  await assert.rejects(api.fabric.flaky(), /throttled/);
  assert.equal(await api.fabric.flaky(), 'ok');
  assert.equal(api.fabric.count(), 4, 'an answer that isn\'t a promise comes straight back');
  await api.fabric.each(() => {});
  await api.fabric.each(() => {});
  assert.equal(calls.filter((x) => x === 'each').length, 2, 'a call given a function is never kept');
  assert.equal(api.token, real.token);
});

test('page: every script under web/ parses', async () => {
  const web = new URL('web/', SRC);
  const scripts = (await readdir(web)).filter((f) => f.endsWith('.js'));
  assert.ok(scripts.includes('app.js'));
  for (const f of scripts) {
    const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(f, web))], { encoding: 'utf8' });
    assert.equal(r.status, 0, `web/${f} has a syntax error:\n${r.stderr}`);
  }
});

test('page: the stages and the finish it waits for are headings the installer prints', async () => {
  const app = await readFile(new URL('web/app.js', SRC), 'utf8');
  const list = (/** @type {string} */ name) => {
    const m = new RegExp(`const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]`).exec(app);
    assert.ok(m, `${name} is in app.js`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith('.js') && !/^web[\\/]/.test(f));
  const printed = new Set();
  for (const f of files) for (const m of (await readFile(new URL(f.replaceAll('\\', '/'), SRC), 'utf8')).matchAll(/\bheading\('([^']+)'\)/g)) printed.add(m[1]);

  // Sign in comes from the sign-in event, Setting up from the numbered steps, and Done from the finish.
  const stages = list('INSTALL_STAGES');
  const fromHeadings = stages.filter((s) => !['Sign in', 'Setting up', 'Done'].includes(s));
  assert.ok(fromHeadings.length >= 6);
  assert.deepEqual(fromHeadings.filter((s) => !printed.has(s)), []);

  // Every way an install finishes is one the page waits for.
  const done = list('DONE_HEADINGS');
  assert.ok(done.length >= 3);
  assert.deepEqual(done.filter((s) => !printed.has(s)), []);
  assert.deepEqual([...printed].filter((s) => /^AI in One is /.test(s) && !done.includes(s)), []);

  // Done is last, so nothing ahead of it is skipped. There's one target, so every install has the same stages.
  assert.equal(stages.at(-1), 'Done');
  assert.doesNotMatch(app, /TARGET_STAGES/);
});

test('page: every command has a row, or for prerequisites its own panel, and the record says which rows can run', async () => {
  const app = await readFile(new URL('web/app.js', SRC), 'utf8');
  const table = /^const COMMANDS = \{\r?\n([\s\S]*?)\r?\n\};/m.exec(app)?.[1] ?? '';
  const titled = [...table.matchAll(/^ {2}'?([a-z-]+)'?: \{/gm)].map((m) => m[1]);
  assert.deepEqual([...titled].sort(), [...WEB_COMMANDS].sort(), 'each command the session takes has a title and text, and no other');
  const rows = [...(/const ROW_ORDER = \[([^\]]*)\]/.exec(app)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...rows].sort(), WEB_COMMANDS.filter((c) => c !== 'prereqs').sort());
  assert.match(app, /start\('prereqs'\)/, 'the Prerequisites panel starts the check');

  const config = emptyConfig();
  config.fabric.workspaceId = 'ws-1';
  config.fabric.lakehouseId = 'lh-1';
  const rec = describeRecord(config);
  assert.deepEqual(Object.keys(rec.can).sort(), rows.filter((c) => c !== 'install').sort(), 'Repair or change is always there');
  assert.equal(rec.can.check, false);
  config.fabric.notebooks.dataCheck = 'nb-check';
  assert.equal(describeRecord(config).can.check, true, 'Check the data needs the data check notebook');

  assert.equal(rec.report, undefined);
  config.semanticModel.report = { id: 'rep-1', name: 'AI in One' };
  assert.deepEqual(describeRecord(config).report, { name: 'AI in One', url: 'https://app.powerbi.com/groups/ws-1/reports/rep-1' });
  assert.match(app, /rec\.report\b/, 'the installed view links the report');

  config.history.days = 90;
  assert.equal(describeRecord(config).historyDays, 90, 'the installed view shows how much audit history is loaded');
  assert.match(app, /backfillDays/, 'the Run row can load more history');
});

test('page: names no other product', async () => {
  // Bracketed, so this file doesn't match it either.
  const other = /Analytic[s] ?Hub|analytic[s][-_]hub|Valu[e]Lens|vlen[s]|Cowor[k]|Viv[a]|Workda[y]|Defende[r]|Datavers[e]|Resourc[e] Graph|Rayfi[n]|Agen[t] Evaluator|consumptio[n]|deplo[y]-app/i;
  for (const f of ['app.js', 'app.css', 'index.html', 'icon.svg']) {
    const lines = (await readFile(new URL(`web/${f}`, SRC), 'utf8')).split('\n');
    assert.deepEqual(lines.flatMap((line, i) => (other.test(line) ? [`web/${f}:${i + 1}: ${line.trim()}`] : [])), []);
  }
});

test('prereqsSnapshot: says whether the signer can assign directory roles, from an active Global or Privileged Role Administrator', () => {
  const row = (/** @type {string} */ status) => /** @type {any} */ ({ id: 'consent-role', label: 'x', neededFor: 'x', status });
  const yes = prereqsSnapshot('admin@contoso.com', [row('met')]);
  assert.equal(yes.canAssignDirectoryRoles, true);
  assert.equal(yes.upn, 'admin@contoso.com');
  assert.equal(prereqsSnapshot('admin@contoso.com', [row('eligible')]).canAssignDirectoryRoles, false, 'eligible is not active');
  assert.equal(prereqsSnapshot('admin@contoso.com', [row('missing')]).canAssignDirectoryRoles, false);
  assert.equal(prereqsSnapshot('admin@contoso.com', []).canAssignDirectoryRoles, false);
});