// @ts-check
/**
 * The wizard's local web server: the page, a stream of events and the answers back. It listens
 * on 127.0.0.1 only, and every request needs the one-time token from the link it prints.
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { installerWindow, updateHint } from './launch.js';
import { createSession } from './web-session.js';
import { c } from './ui.js';
import { checkForUpdate } from './update-check.js';
import { createWebUi } from './web-ui.js';

const WEB_DIR = new URL('./web/', import.meta.url);
/** @type {Record<string, [file: string, type: string]>} */
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const MAX_BODY = 64 * 1024;
const HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function page(res, status, message) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>AI in One installer</title><p style="font:16px system-ui;margin:48px">${message}</p>`);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Not JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** @param {string | undefined} header @param {string} name */
function cookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/**
 * @param {{
 *   ui: import('./web-ui.js').WebUi,
 *   session: import('./web-session.js').Session,
 *   token?: string,
 *   port?: number,
 *   heartbeatMs?: number,
 * }} o
 */
export async function startServer(o) {
  const { ui, session } = o;
  const token = o.token ?? randomBytes(24).toString('base64url');
  const expected = Buffer.from(token);
  const host = '127.0.0.1';
  let port = 0;
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  /** @type {(v?: unknown) => void} */
  let finish = () => {};
  /** @type {Promise<void>} */
  const done = new Promise((resolve) => {
    finish = () => resolve();
  });

  /** @param {string} given */
  const tokenOk = (given) => {
    const b = Buffer.from(given);
    return b.length === expected.length && timingSafeEqual(b, expected);
  };
  const origins = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const cookieName = () => `aio_${port}`;

  /** @param {import('./web-ui.js').UiEvent} e */
  const frame = (e) => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
  const unsubscribe = ui.subscribe((e) => {
    for (const res of clients) res.write(frame(e));
  });
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, o.heartbeatMs ?? 20000);
  heartbeat.unref();

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    // A page on another site can't reach this server through a DNS name that points here.
    if (!origins().includes(req.headers.host ?? '')) return page(res, 421, 'This address isn\'t served here.');
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (!tokenOk(url.searchParams.get('t') ?? '')) return page(res, 403, `That link has expired. ${reopenHint()}`);
      res.writeHead(303, { ...HEADERS, Location: '/', 'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/` });
      return res.end();
    }
    if (!tokenOk(cookie(req.headers.cookie, cookieName()))) {
      if (url.pathname === '/') return page(res, 401, `This page needs the installer's link. ${reopenHint()}`);
      return json(res, 401, { error: reopenHint() });
    }

    if (method === 'GET') {
      if (url.pathname === '/events') {
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        for (const e of ui.history(Number(req.headers['last-event-id']) || 0)) res.write(frame(e));
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/api/state') return json(res, 200, session.state());
      const file = FILES[url.pathname];
      if (!file) return json(res, 404, { error: 'Not found' });
      const body = await readFile(new URL(file[0], WEB_DIR));
      res.writeHead(200, { ...HEADERS, 'Content-Type': file[1] });
      return res.end(body);
    }

    if (method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const origin = req.headers.origin ?? '';
    if (!origins().some((o) => origin === `http://${o}`)) return json(res, 403, { error: 'Cross-site request refused.' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'Send JSON.' });
    const body = await readJson(req);

    switch (url.pathname) {
      case '/api/start': {
        const r = session.start(body);
        return r.ok ? json(res, 202, { ok: true }) : json(res, r.status, { error: r.error });
      }
      case '/api/answer': {
        const r = ui.answer(Number(body.id), body.value);
        return json(res, r.ok ? 200 : 422, r);
      }
      case '/api/cancel':
        return json(res, 200, { ok: ui.cancel() });
      case '/api/section-cancel':
        return ui.cancelSection() ? json(res, 200, { ok: true }) : json(res, 409, { error: 'No settings category is open.' });
      case '/api/back': {
        const ok = ui.back();
        return ok ? json(res, 200, { ok: true }) : json(res, 409, { error: 'There\'s no earlier question to go back to.' });
      }
      case '/api/fresh': {
        const r = session.startFresh();
        return r.ok ? json(res, 200, r) : json(res, r.status, { error: r.error });
      }
      case '/api/keep':
        return json(res, 200, session.keepRecord());
      case '/api/quit':
        if (session.running) return json(res, 409, { error: `"${session.running}" is still running.` });
        json(res, 200, { ok: true });
        setImmediate(close);
        return;
      default:
        return json(res, 404, { error: 'Not found' });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, /** @type {any} */ (err)?.status ?? 500, { error: /** @type {any} */ (err)?.status ? err.message : 'Something went wrong.' });
      else res.end();
    });
  });

  function close() {
    clearInterval(heartbeat);
    unsubscribe();
    for (const res of clients) res.end();
    clients.clear();
    server.close(() => finish());
    server.closeAllConnections?.();
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, host, () => resolve(undefined));
  });
  port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const url = `http://${host}:${port}/`;
  return { url, launchUrl: `${url}?t=${token}`, port, token, done, close };
}

/** What a page opened without the installer's link says to do. */
export const reopenHint = () => `Go back to ${installerWindow()} and press Enter there to open the installer again. Or open the link it printed.`;

/**
 * Reopens the page each time Enter is pressed in the terminal.
 * @param {NodeJS.ReadableStream} input
 * @param {() => void} open
 * @returns {() => void} stops listening
 */
export function reopenOnEnter(input, open) {
  /** @param {Buffer | string} chunk */
  const onData = (chunk) => {
    for (const ch of String(chunk)) if (ch === '\n' || ch === '\r') return open();
  };
  input.on('data', onData);
  return () => {
    input.off('data', onData);
    input.pause?.();
  };
}

/**
 * Opens the default browser. The URL is printed too, in case this can't.
 * @param {string} url
 * @param {NodeJS.Platform} [platform]
 */
export function openBrowser(url, platform = process.platform) {
  /** @type {[string, string[]]} */
  const [cmd, args] =
    platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The printed link still works.
  }
}

/**
 * Echoes the wizard to the terminal, so it keeps a plain record too. After Back, the answers
 * given again aren't echoed: only the question the user is taken back to.
 * @param {(s: string) => void} write
 */
export function mirror(write) {
  const line = (/** @type {string} */ s = '') => write(`${s}\n`);
  const SYMBOL = { ok: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗') };
  let replaying = false;
  /** @param {import('./web-ui.js').UiEvent} e */
  return (e) => {
    if (e.type === 'rewind') {
      line(`  ${c.dim('← Back')}`);
      replaying = true;
      return;
    }
    if (e.replayed) return;
    if (replaying && (e.type === 'prompt' || e.type === 'command')) replaying = false;
    if (replaying) return;
    switch (e.type) {
      case 'command':
        if (e.state === 'running') line(`\n${c.bold(`▶ ${e.command}`)}`);
        else line(`${e.state === 'done' ? c.green('■') : c.red('■')} ${e.command}: ${e.state}${e.error ? `. ${e.error}` : ''}`);
        break;
      case 'signin':
        if (e.user) line(`  ${c.dim(`Signed in as ${e.user.upn}`)}`);
        break;
      case 'device-code':
        line(`    ${e.text}`);
        break;
      case 'heading':
        line(`\n${c.bold(c.cyan(e.title))}`);
        break;
      case 'step':
        line(`\n${c.bold(`[${e.n}/${e.total}] ${e.title}`)}`);
        break;
      case 'line':
        if (e.kind in SYMBOL) line(`  ${SYMBOL[/** @type {'ok' | 'warn' | 'fail'} */ (e.kind)]} ${e.text}`);
        else line(e.kind === 'line' ? e.text : `    ${e.kind === 'note' ? c.dim(e.text) : e.text}`);
        break;
      case 'prompt':
        line(`${c.cyan('?')} ${e.message} ${c.dim('(answer in the browser)')}`);
        break;
      case 'answered':
        line(`  ${c.dim('→')} ${e.display ?? ''}`);
        break;
      case 'auto':
        line(`${c.green('✔')} ${e.message} ${c.cyan(e.display)}`);
        break;
      case 'loads':
        for (const card of /** @type {import('./loads.js').LoadCard[]} */ (e.cards)) {
          const kind = card.state === 'ok' ? 'ok' : card.state === 'failed' ? 'fail' : 'warn';
          const state = card.state === 'running' ? 'still running' : card.state;
          line(`  ${SYMBOL[kind]} ${card.name}${card.state === 'ok' ? '' : `: ${state}`}`);
          if (card.reason) line(`    ${card.reason}`);
          for (const fix of card.fix) line(`    ${c.dim(fix)}`);
        }
        break;
      case 'next-steps':
        line(`  ${c.bold(c.yellow(e.title))}`);
        for (const s of /** @type {import('./steps/next-steps.js').NextStep[]} */ (e.steps)) line(`  ${SYMBOL.warn} ${s.title}${c.dim(`  ${s.who}`)}`);
        break;
    }
  };
}

/**
 * `aio-install --ui`: serves the wizard until the page closes it or Ctrl+C.
 * @param {{ configFile: string, sourceDir?: string, tenantId?: string, method?: import('./web-session.js').Method, open: boolean, version: string, debug?: (m: string) => void, write?: (s: string) => void, checkUpdate?: () => Promise<import('./update-check.js').Update | null>, stdin?: NodeJS.ReadableStream & { isTTY?: boolean } }} o
 */
export async function runWizard(o) {
  const write = o.write ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const ui = createWebUi();
  const session = createSession({ ui, configFile: o.configFile, sourceDir: o.sourceDir, version: o.version, tenantId: o.tenantId, method: o.method, debug: o.debug });
  const server = await startServer({ ui, session });
  ui.subscribe(mirror(write));
  write(`${c.bold(`AI in One installer ${o.version}`)}\n`);
  write(`${o.open ? 'The installer is opening in your browser. If it doesn\'t, go to:' : 'Open the installer in your browser:'}\n\n  ${server.launchUrl}\n\n`);
  write(`${c.dim('Only this computer can reach it. Keep this window open; press Ctrl+C to stop.')}\n`);
  const input = o.stdin ?? process.stdin;
  const stopReopen = input.isTTY ? reopenOnEnter(input, () => openBrowser(server.launchUrl)) : () => {};
  if (input.isTTY) write(`${c.dim('Press Enter here to reopen the page.')}\n`);
  if (o.open) openBrowser(server.launchUrl);
  (o.checkUpdate ?? (() => checkForUpdate({ version: o.version })))()
    .then((u) => {
      if (!u) return;
      session.setUpdate(u);
      write(`\n${c.yellow('!')} Installer ${u.version} is available. ${updateHint(u)}\n`);
    })
    .catch(() => {});
  await server.done;
  stopReopen();
  write('Closed the installer.\n');
}
