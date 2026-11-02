// @ts-check
/** The browser wizard's route for a new install: Fabric, or PAX on this Windows PC. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig, emptyPax, saveConfig } from '../src/config.js';
import { PAX_NEEDS_WINDOWS } from '../src/pax/plan.js';
import { createWebUi } from '../src/web-ui.js';
import { createSession } from '../src/web-session.js';

/** @param {(dir: string) => Promise<void> | void} fn */
async function inDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-route-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_SIGN_IN = 'No sign-in in tests.';

/** A browser session with no install record, whose sign-in always fails, so nothing reaches a tenant. @param {string} dir */
function session(dir) {
  const configFile = join(dir, 'aio-install.json');
  const ui = createWebUi({ now: () => 1000 });
  const connect = async () => {
    throw new Error(NO_SIGN_IN);
  };
  const s = createSession({ ui, configFile, version: '0.0.0', connect: /** @type {any} */ (connect) });
  const of = (/** @type {string} */ type) => ui.history().filter((e) => e.type === type);
  const ended = () => of('command').filter((e) => e.state !== 'running');
  return { s, configFile, of, ended };
}

test('web session: a route goes only with setup or the prerequisites check, and is Fabric or PAX', () =>
  inDir((dir) => {
    const { s } = session(dir);
    for (const req of [{ command: 'install', target: 'azure' }, { command: 'run', target: 'pax' }, { command: 'status', target: 'fabric' }]) {
      assert.deepEqual(s.start(/** @type {any} */ (req)), { ok: false, status: 400, error: 'Unknown route: choose Fabric or PAX.' }, JSON.stringify(req));
    }
    assert.equal(s.running, null, 'nothing started');
  }));

test('web session: a new install goes the route the page chose, and tells the page which', () =>
  inDir(async (dir) => {
    const { s, configFile, of, ended } = session(dir);
    const st = s.state();
    assert.equal(st.draftTarget, undefined);
    assert.equal(st.paxHere, process.platform === 'win32', 'the page offers PAX only on Windows');

    assert.equal(s.start({ command: 'prereqs', target: 'pax' }).ok, true);
    await s.settled();
    assert.deepEqual(of('route').map((e) => e.target), ['pax']);
    assert.equal(ended().at(-1)?.error, NO_SIGN_IN);

    s.start({ command: 'install', target: 'pax' });
    await s.settled();
    assert.deepEqual(of('route').map((e) => e.target), ['pax', 'pax']);
    // The scheduled task runs on the PC that sets it up, so anywhere else setup stops before sign-in.
    assert.equal(ended().at(-1)?.error, process.platform === 'win32' ? NO_SIGN_IN : PAX_NEEDS_WINDOWS);

    s.start({ command: 'install', target: 'fabric' });
    await s.settled();
    assert.equal(of('route').at(-1)?.target, 'fabric');
    assert.ok(!existsSync(configFile), 'nothing is saved before sign-in');
  }));

test('web session: a setup draft keeps its route, and an install record has its own', () =>
  inDir(async (dir) => {
    const { s, configFile, of } = session(dir);
    const draft = emptyConfig();
    draft.target = 'pax';
    draft.pax = emptyPax();
    saveConfig(`${configFile}.draft.json`, draft);
    assert.equal(s.state().draftTarget, 'pax', 'the page shows the draft\'s route and no picker');

    s.start({ command: 'prereqs', target: 'fabric' });
    await s.settled();
    assert.equal(of('route').at(-1)?.target, 'pax', 'setup picks the draft up after sign-in, so its route wins');

    const record = emptyConfig();
    record.tenantId = 'tenant-1';
    saveConfig(configFile, record);
    const st = s.state();
    assert.equal(st.draftTarget, undefined, 'with a record, the record says');
    assert.equal(st.record?.target, 'fabric', 'a record from before PAX is Fabric');
  }));
