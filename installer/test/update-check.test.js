import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkForUpdate, newerVersion, OPT_OUT, RELEASES_API, RELEASES_PAGE, REPO } from '../src/update-check.js';

/** @param {any} body @param {{ ok?: boolean }} [o] */
const fakeFetch = (body, o = {}) => {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  const fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    return { ok: o.ok ?? true, json: async () => body };
  });
  return { fetch, calls };
};

/** @param {string} tag @param {Record<string, any>} [more] */
const release = (tag, more = {}) => ({ tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, draft: false, prerelease: false, ...more });

test('update check: only a newer installer-v release counts', () => {
  assert.equal(newerVersion('0.5.0', 'installer-v0.5.1'), '0.5.1');
  assert.equal(newerVersion('0.5.0', 'installer-v0.6.0'), '0.6.0');
  assert.equal(newerVersion('0.5.0', 'installer-v1.0.0'), '1.0.0');
  assert.equal(newerVersion('0.5.0', 'installer-v0.5.0'), null);
  assert.equal(newerVersion('0.5.1', 'installer-v0.5.0'), null);
  assert.equal(newerVersion('0.10.0', 'installer-v0.9.9'), null);
  assert.equal(newerVersion('0.5.0', 'v0.6.0'), null);
  assert.equal(newerVersion('0.5.0', 'AIO-v2.0.0'), null);
  assert.equal(newerVersion('0.5.0', '2026-06-25'), null);
  assert.equal(newerVersion('0.5.0', 'installer-v0.6.0-rc.1'), null);
  assert.equal(newerVersion('0.5.0-dev', 'installer-v0.5.1'), '0.5.1');
  assert.equal(newerVersion('', 'installer-v0.5.1'), null);
});

test('update check: reads the release list, since the latest release is the dashboard\'s', async () => {
  const { fetch, calls } = fakeFetch([release('2026-06-25'), release('installer-v0.2.0'), release('AIO-v2.0.0')]);
  const u = await checkForUpdate({ version: '0.1.0', fetch, env: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RELEASES_API);
  assert.equal(RELEASES_API, 'https://api.github.com/repos/microsoft/AI-in-One-Dashboard/releases?per_page=50');
  assert.equal(calls[0].init.headers['User-Agent'], 'ai-in-one-installer/0.1.0');
  assert.deepEqual(u, { version: '0.2.0', url: 'https://github.com/microsoft/AI-in-One-Dashboard/releases/tag/installer-v0.2.0' });
});

test('update check: picks the newest installer release, whatever the list order', async () => {
  const { fetch } = fakeFetch([release('installer-v0.2.0'), release('installer-v0.10.0'), release('installer-v0.3.1'), release('2026-06-25')]);
  assert.deepEqual(await checkForUpdate({ version: '0.1.0', fetch, env: {} }), { version: '0.10.0', url: `https://github.com/${REPO}/releases/tag/installer-v0.10.0` });
});

test('update check: skips drafts and pre-releases', async () => {
  const { fetch } = fakeFetch([
    release('installer-v0.4.0', { draft: true }),
    release('installer-v0.3.0', { prerelease: true }),
    release('installer-v0.3.0-rc.1'),
    release('installer-v0.2.0'),
  ]);
  assert.deepEqual(await checkForUpdate({ version: '0.1.0', fetch, env: {} }), { version: '0.2.0', url: `https://github.com/${REPO}/releases/tag/installer-v0.2.0` });
});

test('update check: a link elsewhere falls back to the installer releases page', async () => {
  const { fetch } = fakeFetch([release('installer-v0.6.0', { html_url: 'https://example.com/x' })]);
  assert.deepEqual(await checkForUpdate({ version: '0.5.0', fetch, env: {} }), { version: '0.6.0', url: RELEASES_PAGE });
  assert.equal(RELEASES_PAGE, 'https://github.com/microsoft/AI-in-One-Dashboard/releases?q=installer-v&expanded=true');
});

test('update check: quiet when up to date, offline, failing or opted out', async () => {
  assert.equal(await checkForUpdate({ version: '0.6.0', fetch: fakeFetch([release('installer-v0.6.0'), release('installer-v0.5.0')]).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.1.0', fetch: fakeFetch([release('2026-06-25'), release('AIO-v2.0.0')]).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.1.0', fetch: fakeFetch([]).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch([release('installer-v0.6.0')], { ok: false }).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch(null).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch(release('installer-v0.6.0')).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch([null, 'x', release('installer-v0.6.0')]).fetch, env: {} }).then((u) => u?.version), '0.6.0');
  const offline = /** @type {any} */ (async () => { throw new TypeError('fetch failed'); });
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: offline, env: {} }), null);
  const optedOut = fakeFetch([release('installer-v0.6.0')]);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: optedOut.fetch, env: { [OPT_OUT]: '1' } }), null);
  assert.equal(OPT_OUT, 'AI_IN_ONE_NO_UPDATE_CHECK');
  assert.deepEqual(optedOut.calls, []);
});

test('update check: gives up when GitHub is slow', async () => {
  const slow = /** @type {any} */ ((/** @type {string} */ _url, /** @type {any} */ init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const started = Date.now();
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: slow, timeoutMs: 50, env: {} }), null);
  assert.ok(Date.now() - started < 2000);
});
