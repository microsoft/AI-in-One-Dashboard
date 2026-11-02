/* AI in One installer wizard. Plain modules, no build step.
   Everything the installer says arrives as events from /events; answers go back to /api/answer.
   The page never keeps a secret: a typed secret is sent once and the field is cleared. */

const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  play: 'M7 4.5v15l12-7.5z',
  refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7',
  pulse: 'M3 12h4l3-7 4 14 3-7h4',
  database: 'M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0M4 6v12a8 3 0 0 0 16 0V6M4 12a8 3 0 0 0 16 0',
  key: 'M3 15a4 4 0 1 0 8 0a4 4 0 1 0-8 0M10 12l9-9M16 6l3 3M13.5 8.5l2 2',
  check: 'M5 12.5 9.5 17 19 7.5',
  x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  stop: 'M7 7h10v10H7z',
  current: 'M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  circle: 'M6 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0',
  minus: 'M7 12h10',
  warn: 'M12 4 2.8 19.5h18.4zM12 10v4.5M12 17.2v.3',
  clock: 'M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0M12 7.5V12l3 2',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  sun: 'M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  power: 'M12 3.5V11M6.7 6.6a7.5 7.5 0 1 0 10.6 0',
  menu: 'M4 7h16M4 12h16M4 17h16',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M4 20h16',
  down: 'M12 5v14M6 13l6 6 6-6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  link: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  shield: 'M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6zM8.5 12l2.5 2.5 4.5-4.5',
};

const COMMANDS = {
  install: {
    title: 'Set up AI in One', short: 'Set up', icon: 'sliders',
    row: 'Repair or change', button: 'Repair or change',
    desc: 'Review your saved settings and edit only the category you need. Nothing deploys until you approve the plan.',
  },
  run: {
    title: 'Run the pipeline', short: 'Run now', icon: 'play', section: 'Pipeline run',
    row: 'Run now', button: 'Run now',
    desc: 'Start the pipeline, wait for it, then run the data check.',
    off: 'There is no pipeline yet.',
  },
  'rerun-failed': {
    title: 'Rerun failed loads', short: 'Rerun failed', icon: 'refresh', section: 'Rerun',
    row: 'Rerun failed loads', button: 'Rerun failed',
    desc: 'Run again only the loads that failed in the latest pipeline run, and the steps that waited for them, one at a time.',
    off: 'There is no pipeline yet.',
  },
  refresh: {
    title: 'Refresh the model', short: 'Refresh', icon: 'refresh', section: 'Model refresh',
    row: 'Refresh the model', button: 'Refresh',
    desc: 'Refresh the semantic model from the Lakehouse now.',
    off: 'No semantic model is deployed.',
  },
  status: {
    title: 'Check status', short: 'Status', icon: 'pulse', section: 'Status',
    row: 'Check status', button: 'Check status',
    desc: 'Recent runs, model refreshes, when secrets expire and the last data check. Changes nothing.',
  },
  check: {
    title: 'Check the data', short: 'Check data', icon: 'database', section: 'Data check',
    row: 'Check the data', button: 'Check the data',
    desc: 'Read the Lakehouse tables again for row counts, date ranges, departments and licence matches, without running the pipeline. Then test the model with a small query. Takes a few minutes.',
    off: 'The data check notebook isn\'t deployed.',
  },
  update: {
    title: 'Update AI in One', short: 'Update', icon: 'download', section: 'Update', adopt: true,
    row: 'Update', button: 'Update',
    desc: 'Push the notebooks, pipeline, semantic model and report from this version of the installer to Fabric, then refresh the model. If Fabric can\'t update the model and keep its data, the page asks before the data is cleared and reloaded.',
    off: 'Nothing is installed yet.',
  },
  'rotate-secret': {
    title: 'Create new secrets', short: 'New secrets', icon: 'key', section: 'New secrets', adopt: true,
    row: 'Create new secrets', button: 'Create new secrets',
    desc: 'Replace the app\'s client secret in Key Vault (or show a vault admin the steps), or in the notebooks, and the model connection\'s.',
    off: 'There is no app registration or client secret yet.',
  },
  access: {
    title: 'Manage access', short: 'Access', icon: 'shield', section: 'Viewer access',
    row: 'Manage access', button: 'Manage access',
    desc: 'Choose the viewer group if there isn\'t one yet. Then add viewers or an owner, share the report with the group if that\'s still to do, or give the group Build on the model again. To share AI in One, add people to the group.',
    off: 'Viewers need the semantic model first.',
  },
  uninstall: {
    title: 'Uninstall AI in One', short: 'Uninstall', icon: 'x', section: 'Uninstall', adopt: true,
    row: 'Uninstall', button: 'Uninstall',
    desc: 'Delete the workspace if the installer created it, after its managed private endpoints. In a workspace you already had, delete only what the installer created there. Then delete the model\'s connection, and ask before deleting an app registration the installer created.',
    off: 'Nothing is installed yet.',
  },
  prereqs: {
    title: 'Check prerequisites', short: 'Prerequisites', icon: 'shield', section: 'Prerequisites',
    row: 'Check prerequisites', button: 'Check prerequisites',
    desc: 'See which roles, licences, capacities and tenant settings you have and which are missing, and Azure access if you choose Key Vault. Changes nothing.',
  },
};
const ROW_ORDER = ['run', 'rerun-failed', 'refresh', 'status', 'check', 'update', 'access', 'rotate-secret', 'uninstall', 'install'];

// With PAX, a scheduled task on this PC runs PAX and puts the files in a folder. Where a command reads
// differently, this replaces COMMANDS' text. hide: there's no row for it.
const PAX_COMMANDS = {
  run: {
    title: 'Run PAX now', section: 'PAX run',
    desc: 'Start the scheduled task now and wait for PAX to finish. Then refresh the model on the new files.',
    off: 'The scheduled task isn\'t set up yet.',
  },
  'rerun-failed': { hide: true },
  refresh: {
    desc: 'Refresh the semantic model from the files in SharePoint now.',
  },
  status: {
    desc: 'The scheduled task and its last run, when its sign-in expires, and where the files, the model and the app are. Changes nothing.',
  },
  check: {
    title: 'Check the files', short: 'Check files', section: 'File check',
    row: 'Check the files', button: 'Check the files',
    desc: 'Look for each file in the folder and when it last changed. For a SharePoint folder, first check that the app registration can still write there, then refresh the model and test it with a small query.',
    off: 'The scheduled task isn\'t set up yet.',
  },
  update: {
    desc: 'Update PAX, the scheduled task\'s script, the semantic model, the report and the app from this version of the installer. The next scheduled run uses them.',
    off: 'The scheduled task isn\'t set up yet.',
  },
  'rotate-secret': {
    title: 'Renew the task\'s sign-in', short: 'Renew sign-in', section: 'New sign-in',
    row: 'Renew the task\'s sign-in', button: 'Renew sign-in',
    desc: 'Give the scheduled task a new certificate, or a new client secret where this PC can\'t make certificates. The old one comes off the app registration once the task has signed in with the new one.',
    off: 'The scheduled task isn\'t set up yet.',
  },
  access: {
    desc: 'Choose the viewer group if there isn\'t one yet. Then add viewers or an owner, share the report and the app with the group if that\'s still to do, or give the group Build on the model again. To share AI in One, add people to the group.',
    off: 'Viewers need the semantic model or the app first.',
  },
  uninstall: {
    desc: 'Remove the scheduled task, its sign-in and its working files on this PC, the app, the app registration\'s access to the SharePoint site, and the report, or its workspace if the installer created it. Ask before deleting an app registration the installer created. The files PAX wrote stay.',
  },
  prereqs: {
    desc: 'See which roles, licences and tenant settings you have and which are missing, and whether this PC can run PAX. Changes nothing.',
  },
};
/** A command's text on a route. */
const cmdOf = (cmd, route) => ({ ...COMMANDS[cmd], ...(route === 'pax' ? PAX_COMMANDS[cmd] : null) });

// The install's stages in the order the installer prints them. Other headings (Who can view, the
// history question, Schedule, Advanced settings...) slot in as they come. Some are on one route
// only, and the rail leaves them out on the other.
const INSTALL_STAGES = [
  'Sign in', 'Checking your tenant', 'Checking this PC', 'What it collects', 'Fabric', 'Where the files go', 'App registration',
  'Key Vault for the app secret', 'Ready to set up', 'Setting up', 'Done',
];
const FABRIC_STAGES = new Set(['Fabric', 'Key Vault for the app secret']);
const PAX_STAGES = new Set(['Checking this PC', 'Where the files go']);
const onlyOn = (title) => (FABRIC_STAGES.has(title) ? 'fabric' : PAX_STAGES.has(title) ? 'pax' : undefined);
const onRoute = (run) => (s) => !s.only || s.only === run.route;
const DONE_HEADINGS = new Set(['AI in One is set up', 'AI in One is set up, still reloading', 'AI in One is partly set up', 'Connect Power BI']);

const METHODS = [
  { value: 'browser', name: 'Browser', tag: 'Recommended', desc: 'A Microsoft sign-in window opens on this computer.' },
  { value: 'device-code', name: 'Code', desc: 'Sign in on any device with a code, for when a window can\'t open here.' },
  { value: 'azure-cli', name: 'Azure CLI', desc: 'Uses the account you signed in with through az login.' },
];
const WAITING = {
  browser: 'Finish signing in in the window that opened. This page carries on by itself.',
  'device-code': 'Getting a sign-in code.',
  'azure-cli': 'Using your Azure CLI sign-in.',
};
const ROUTES = [
  { value: 'fabric', name: 'Fabric', desc: 'Notebooks in a Fabric workspace load the audit log each day. Needs a Fabric capacity (F2 or larger, or a trial).' },
  { value: 'pax', name: 'PAX, on this Windows PC', desc: 'A scheduled task on this PC runs PAX each day and puts the files in a SharePoint folder, for the report and the AI in One app. No capacity.' },
];
// The scheduled task's last run (pax/task.js LastRun's status).
const PAX_RUN = { running: 'Running', ok: 'Succeeded', warning: 'Succeeded with warnings', failed: 'Failed' };
const LEDE = {
  fabric: 'Answer a few questions and review the plan. Then the installer sets up AI in One in your tenant: an app registration, with its secret in the notebooks or in Azure Key Vault; a Fabric workspace with a Lakehouse; the notebooks and pipeline that load Copilot audit logs, licensed users and org data; and the AI in One semantic model and report.',
  pax: 'Answer a few questions and review the plan. Then the installer sets up AI in One: a scheduled task on this PC that runs PAX each day for Copilot audit logs and licensed users; an app registration for the task to sign in as, which can write to one SharePoint site only; the AI in One semantic model and report on the files; and the AI in One app.',
};
const NEEDS = {
  fabric: [
    'An active Fabric capacity (F2 or larger, or a trial) you can assign workspaces to, or a workspace where you\'re an Admin or Member.',
    'A Power BI Pro or Premium Per User licence, to publish the model and the report and to share the report.',
    'The Fabric tenant settings that the model\'s connection and the report\'s custom visuals need. If any are off, a Fabric administrator turns them on.',
    'Optional: an Azure subscription where you can create a Key Vault, or a vault you can read secrets from. By default, the app\'s client secret goes in the notebooks instead, where anyone with a role in the workspace can read it.',
    'Permission to register apps in Entra, or an app registration you already have. If you have neither, you get an admin pack to send an admin.',
    'A Global Administrator or Privileged Role Administrator to grant admin consent. If that isn\'t you, you get a link to send them.',
  ],
  pax: [
    'This Windows PC or server, on most days, with PowerShell 7 and Python 3.10 or later. The installer offers to install Python for your account. PowerShell must be allowed to run local scripts: the installer never changes the policy or works round it.',
    'A SharePoint site you own, for the files. Or a folder on this PC, for Power BI Desktop and the app only.',
    'A Power BI Pro or Premium Per User licence, to publish the model and the report and to share the report.',
    'For the AI in One app: Copilot managed apps turned on in your Power Platform environment, and Power Apps Premium or Copilot Credits for each person who opens it. If the tenant isn\'t ready, setup finishes at the report.',
    'Permission to register apps in Entra, or an app registration you own.',
    'A Global Administrator or Privileged Role Administrator to grant admin consent. If that isn\'t you, you get a link to send them.',
  ],
};
const launcher = () => app.state?.launcher ?? {};
/** The route: the install record's, a setup draft's, or the one chosen on the home page. */
const routeOf = () => app.state?.record?.target ?? app.state?.draftTarget ?? app.target ?? 'fabric';
const installerName = () => launcher().command ?? 'aio-install';
const installerWindow = () => launcher().window ?? 'your terminal';
const GLYPH = { ok: 'check', warn: 'warn', fail: 'x' };
const STATUS_ICON = { done: 'check', failed: 'x', stopped: 'stop', current: 'current', upcoming: 'circle', skipped: 'minus' };
const STATUS_TEXT = { done: 'done', failed: 'failed', stopped: 'stopped', current: 'in progress', upcoming: 'to do', skipped: 'skipped' };
const KV = /^([A-Z][A-Za-z]*(?: [A-Za-z()]+){0,3}):\s+(\S.*)$/;

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const narrow = matchMedia('(max-width: 760px)');
const byId = (id) => document.getElementById(id);

const app = {
  state: null,
  run: null,
  attempts: [],
  view: 'home',
  follow: true,
  replay: false,
  rewinding: false,
  lastSeq: 0,
  conn: 'ok',
  method: null,
  tenant: null,
  target: null,
  startError: '',
  starting: false,
  railOpen: false,
  openPrompt: null,
  scheduled: false,
  revealStage: null,
  revealEl: null,
  focusEl: null,
  progUntil: 0,
  lastTop: 0,
  es: null,
};
let stageIds = 0;

/* ---------- DOM helpers ---------- */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  put(el, kids);
  return el;
}

function put(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === '') continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

function icon(name, cls = 'ic') {
  const svg = document.createElementNS(SVGNS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', class: cls, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.circle);
  svg.append(path);
  return svg;
}

function fmt(ms) {
  if (ms < 1000) return 'under 1 s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

const since = (at) => h('span', { 'data-since': at }, fmt(Date.now() - at));

function announce(text) {
  const live = byId('live');
  live.textContent = '';
  requestAnimationFrame(() => {
    live.textContent = text;
  });
}

function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/(https:\/\/[^\s<>"')]+)|( {2,})/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const url = m[1].replace(/[.,;:]+$/, '');
      out.push(h('a', { href: url, target: '_blank', rel: 'noreferrer' }, url));
      if (url.length < m[1].length) out.push(m[1].slice(url.length));
    } else out.push(h('span', { class: 'gap' }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function segsEl(segs) {
  return segs.map((s) => {
    const cls = [s.colour && `c-${s.colour}`, s.bold && 's-b', s.dim && 's-d'].filter(Boolean).join(' ');
    const parts = linkify(s.text);
    return cls ? h('span', { class: cls }, parts) : parts;
  });
}

function dropChars(segs, n) {
  const out = [];
  for (const s of segs) {
    if (n >= s.text.length) {
      n -= s.text.length;
      continue;
    }
    out.push({ ...s, text: s.text.slice(n) });
    n = 0;
  }
  return out;
}

const segsText = (segs) => segs.map((s) => s.text).join('').replace(/ {2,}/g, ' · ');

// A line's indented follow-on lines: wrapped text joins it, and each numbered one starts a step of its own.
function moreParts(more) {
  const lead = [];
  const steps = [];
  for (const m of more ?? []) {
    if (/^\d+\.\s/.test(segsText(m))) steps.push([m]);
    else (steps.length ? steps[steps.length - 1] : lead).push(m);
  }
  return { lead, steps };
}

/* ---------- Requests ---------- */

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // No body.
    }
    if (res.status === 401) setConn('closed');
    return { ok: res.ok, status: res.status, body: data };
  } catch {
    return { ok: false, status: 0, body: { error: `Can't reach the installer. Is it still running in ${installerWindow()}?` } };
  }
}

async function refreshState() {
  try {
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    if (res.status === 401) {
      setConn('closed');
      return;
    }
    if (!res.ok) return;
    app.state = await res.json();
  } catch {
    return;
  }
  renderRail();
  if (app.view === 'home') byId('view').replaceChildren(renderHome());
}

async function start(command, extra = {}) {
  const st = app.state;
  if (!st || app.starting) return;
  const installed = !!st.record?.installed;
  const method = st.user?.method ?? app.method ?? st.defaults.method;
  const tenant = st.user || installed ? '' : (app.tenant ?? st.defaults.tenant ?? '').trim();
  app.starting = true;
  app.startError = '';
  byId('view').replaceChildren(renderHome());
  // Without a record, setup and the prerequisites check go the route the home page shows.
  const route = !st.record && (command === 'install' || command === 'prereqs') ? { target: routeOf() } : {};
  const r = await post('/api/start', { command, method, ...(tenant ? { tenant } : {}), ...route, ...extra });
  app.starting = false;
  if (!r.ok) {
    app.startError = r.body?.error ?? 'It didn\'t start. Try again.';
    if (app.view === 'home') byId('view').replaceChildren(renderHome());
  }
}

async function quit() {
  const r = await post('/api/quit');
  if (!r.ok) {
    announce(r.body?.error ?? 'The installer didn\'t close.');
    return;
  }
  app.es?.close();
  // The page below has no rail or main, so the scroll and key handlers must stand down.
  app.view = 'closed';
  app.railOpen = false;
  document.body.replaceChildren(
    h('main', { class: 'closed' },
      h('h1', null, 'The installer has stopped'),
      h('p', { class: 'lede' }, 'You can close this tab.'),
      h('p', { class: 'sub' }, launcher().reopen ?? 'To open it again, run aio-install --ui in your terminal.'),
    ),
  );
}

/* ---------- Connection ---------- */

function setConn(conn) {
  if (conn === app.conn) return;
  const was = app.conn;
  app.conn = conn;
  const link = byId('link');
  if (conn === 'ok') {
    link.hidden = true;
    link.replaceChildren();
    if (was === 'lost') refreshState();
    return;
  }
  link.hidden = false;
  link.replaceChildren(
    icon('warn'),
    h('span', null, conn === 'lost'
      ? 'Lost the link to the installer. Trying again.'
      : `This page has lost its link to the installer. If it's still running, go back to ${installerWindow()} and press Enter there to open it again.`),
  );
}

function connect() {
  const es = new EventSource('/events');
  app.es = es;
  es.addEventListener('open', () => setConn('ok'));
  es.addEventListener('error', () => setConn(es.readyState === EventSource.CLOSED ? 'closed' : 'lost'));
  es.addEventListener('message', (m) => {
    let e;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    onEvent(e);
  });
}

/* ---------- The run model ---------- */

function newStage(title, o = {}) {
  return {
    id: ++stageIds, title, heading: null, level: o.level ?? 0, parent: o.parent ?? null, status: 'upcoming',
    items: [], kids: [], startedAt: 0, endedAt: 0, n: o.n, total: o.total, el: null, body: null, kidsEl: null,
    step: !!o.step, failed: false, only: o.level ? undefined : onlyOn(title),
  };
}

function createRun(e) {
  const cmd = e.command;
  const route = routeOf();
  const c = cmdOf(cmd, route);
  const title = cmd === 'install' && app.state?.record?.installed ? c.row : c.title;
  const run = {
    command: cmd, route, title, startedAt: e.at, endedAt: 0, state: 'running', error: '', phase: 'signin',
    stages: cmd === 'install' ? INSTALL_STAGES.map((t) => newStage(t)) : [newStage('Sign in'), newStage(c.section)],
    cur: null, child: null, doneTitle: '', signedIn: false, user: null, prompts: new Map(), progress: new Map(), adopted: false,
    events: [e],
  };
  buildRunDom(run);
  enter(run, run.stages[0], e.at);
  return run;
}

const target = (run) => run.child ?? run.cur;

function finish(stage, at, status = 'done') {
  if (stage.status !== 'current') return;
  stage.status = status === 'done' && stage.failed ? 'failed' : status;
  stage.endedAt = at;
  paintStage(stage);
}

function enter(run, stage, at) {
  if (stage.level === 0) {
    if (run.child) finish(run.child, at);
    run.child = null;
    if (run.cur && run.cur !== stage) finish(run.cur, at);
    const from = run.cur ? run.stages.indexOf(run.cur) + 1 : 0;
    for (let i = from; i < run.stages.indexOf(stage); i++) if (run.stages[i].status === 'upcoming') run.stages[i].status = 'skipped';
    run.cur = stage;
    app.revealStage = stage;
    if (!app.replay && run === app.run) announce(stage.heading ?? stage.title);
  } else {
    if (run.child && run.child !== stage) finish(run.child, at);
    run.child = stage;
    app.revealEl = null;
  }
  stage.status = 'current';
  stage.startedAt = at;
  mountStage(run, stage);
  if (stage.level > 0) app.revealEl = stage.el;
  schedule();
}

/** Non-install commands: output after sign-in belongs to the command's own section. */
function ensureRoot(run, at) {
  if (run.command !== 'install' && run.cur === run.stages[0] && run.signedIn) enter(run, run.stages[1], at);
}

function add(run, item, stage = target(run)) {
  item.stage = stage;
  item.more = item.more ?? [];
  stage.items.push(item);
  // An install step with a ✗ line failed, even when the install carries on to the next step. So did one with a load
  // that failed in a way that leaves the install partly set up.
  if (stage.step && ((item.t === 'line' && item.kind === 'fail') || (item.t === 'loads' && item.cards.some((card) => card.counted)))) stage.failed = true;
  item.el = renderItem(item);
  if (item.el) {
    stage.body.append(item.el);
    app.revealEl = item.el;
  }
  schedule();
  return item;
}

function rerender(item) {
  const el = renderItem(item);
  if (item.el) {
    if (el) item.el.replaceWith(el);
    else item.el.remove();
  }
  item.el = el;
}

const result = (run) => (run.state === 'done' && run.command === 'install' && run.phase !== 'build' && run.phase !== 'done' ? 'held' : run.state);

function* runItems(stages) {
  for (const s of stages) {
    yield* s.items;
    yield* runItems(s.kids ?? []);
  }
}

/** Whether the latest loads had one that failed, which the outcome offers to rerun. */
function markFailed(run) {
  const loads = [...runItems(run.stages)].filter((it) => it.t === 'loads');
  run.failedLoads = (loads.at(-1)?.cards ?? []).some((card) => card.state === 'failed');
}

/* ---------- Events ---------- */

function onEvent(e) {
  if (typeof e?.seq !== 'number' || e.seq <= app.lastSeq) return;
  app.lastSeq = e.seq;
  // After Back, everything up to the question the user went back to is drawn at once.
  if (app.rewinding && ((e.type === 'prompt' && !e.replayed) || e.type === 'command')) app.rewinding = false;
  app.replay = Date.now() - e.at > 1500 || app.rewinding || !!e.replayed;
  if (e.type === 'command') return onCommand(e);
  if (e.type === 'rewind') return onRewind(e);
  if (e.type === 'prereqs-ready' || e.type === 'update-available' || e.type === 'record-checked') {
    if (!app.replay) refreshState();
    return;
  }
  app.run?.events.push(e);
  if (e.type === 'signin') return onSignin(e);
  apply(e);
}

/** Back: the installer dropped what came after `e.to`, so the run is drawn again from what came before. */
function onRewind(e) {
  const old = app.run;
  if (!old || old.state !== 'running') return;
  const kept = old.events.filter((x) => x.seq <= e.to);
  if (!kept.length) return;
  app.replay = true;
  const run = createRun(kept[0]);
  run.title = old.title;
  app.run = run;
  app.openPrompt = null;
  for (const x of kept.slice(1)) {
    run.events.push(x);
    if (x.type === 'signin') onSignin(x);
    else apply(x);
  }
  if (old.root.isConnected) old.root.replaceWith(run.root);
  app.rewinding = true;
  setFollow(true);
  schedule();
}

function apply(e) {
  const run = app.run;
  if (!run) return;
  switch (e.type) {
    case 'route':
      // The route the installer took, so the rail shows that route's stages.
      run.route = e.target;
      schedule();
      return;
    case 'heading':
      return onHeading(run, e);
    case 'step':
      return onStep(run, e);
    case 'line':
      return onLine(run, e);
    case 'device-code': {
      for (const it of target(run).items) if (it.t === 'wait' && !it.done) {
        it.done = true;
        rerender(it);
      }
      add(run, { t: 'device', url: e.url, code: e.code });
      return;
    }
    case 'review': {
      ensureRoot(run, e.at);
      for (const it of target(run).items) {
        if (it.t === 'kv' || (it.t === 'line' && it.kind === 'info')) {
          it.hidden = true;
          rerender(it);
        }
      }
      add(run, { t: 'review', plan: e.plan });
      return;
    }
    case 'loads':
      ensureRoot(run, e.at);
      add(run, { t: 'loads', cards: e.cards ?? [] });
      markFailed(run);
      return;
    case 'next-steps':
      ensureRoot(run, e.at);
      run.nextSteps = { title: e.title ?? '', steps: e.steps ?? [] };
      // Shown in the outcome at the end; kept as an item for the saved record.
      add(run, { t: 'next-steps', title: run.nextSteps.title, steps: run.nextSteps.steps });
      return;
    case 'prereqs':
      ensureRoot(run, e.at);
      add(run, { t: 'prereqs', items: e.items ?? [] });
      return;
    case 'auto':
      ensureRoot(run, e.at);
      add(run, { t: 'qa', message: e.message, display: e.display, auto: true });
      return;
    case 'prompt': {
      ensureRoot(run, e.at);
      const stage = target(run);
      const decide = e.kind === 'confirm' && stage.items.some((it) => it.t === 'review');
      const item = { t: 'prompt', id: e.id, kind: e.kind, message: e.message, choices: e.choices ?? [], default: e.default, error: '', decide, back: !!e.back, keep: !!e.keep,
        fields: e.fields ?? [], categories: e.categories ?? [], notice: e.notice, changes: e.changes ?? [], settingsBack: !!e.settingsBack };
      run.prompts.set(e.id, item);
      app.openPrompt = item;
      add(run, item);
      if (!app.replay) {
        announce(`Question: ${e.message}`);
        if (!decide) app.focusEl = focusTarget(item.el);
      }
      paintJump();
      return;
    }
    case 'invalid': {
      const item = run.prompts.get(e.id);
      if (item) showError(item, e.error);
      return;
    }
    case 'answered': {
      const item = run.prompts.get(e.id);
      if (!item) return;
      run.prompts.delete(e.id);
      if (item.kind === 'secret') for (const input of item.el?.querySelectorAll('input') ?? []) input.value = '';
      Object.assign(item, { t: 'qa', display: e.display ?? '', cancelled: !!e.cancelled, fresh: !app.replay && !reduced.matches });
      rerender(item);
      if (app.openPrompt === item) app.openPrompt = null;
      paintJump();
      schedule();
      return;
    }
    case 'progress': {
      ensureRoot(run, e.at);
      const item = run.progress.get(e.id);
      if (item) {
        item.status = e.status;
        if (item.statusEl) item.statusEl.textContent = e.status;
        if (item.statusEl && !app.replay) announce(`${item.label}: ${e.status}`);
      } else run.progress.set(e.id, add(run, { t: 'progress', id: e.id, label: e.label, status: e.status, startedAt: e.startedAt }));
      return;
    }
    case 'progress-done': {
      const item = run.progress.get(e.id);
      if (!item) return;
      item.ms = e.ms;
      rerender(item);
      return;
    }
  }
}

function onCommand(e) {
  if (e.state === 'running') {
    if (app.run?.command === 'install' && app.run.state !== 'running') {
      app.attempts.push({ at: app.run.startedAt, state: app.run.state, error: app.run.error });
    }
    app.run = createRun(e);
    app.openPrompt = null;
    app.follow = true;
    if (!app.replay || app.state?.running) show('run');
    else renderRail();
    return;
  }
  const run = app.run;
  if (!run || run.state !== 'running') return;
  run.state = e.state;
  run.error = e.error ?? '';
  run.recovery = e.recovery;
  run.paused = e.paused ?? '';
  run.endedAt = e.at;
  const status = e.state === 'done' ? 'done' : e.state === 'failed' ? 'failed' : 'stopped';
  if (run.child) finish(run.child, e.at, status);
  if (run.cur) finish(run.cur, e.at, status);
  for (const s of run.stages) if (s.status === 'upcoming') s.status = 'skipped';
  for (const it of run.progress.values()) if (it.ms == null) {
    it.ms = e.at - it.startedAt;
    rerender(it);
  }
  app.openPrompt = null;
  run.outcomeEl.replaceWith((run.outcomeEl = renderOutcome(run)));
  app.revealEl = run.outcomeEl;
  paintJump();
  schedule();
  if (!app.replay) {
    announce(`${headTitle(run)}: ${blurb(run)}`);
    // The record's workspace is gone: the home page says what to do.
    if (e.stale) show('home');
    refreshState();
  }
}

function onSignin(e) {
  const run = app.run;
  if (!run) return;
  if (e.state === 'started') {
    add(run, { t: 'wait', method: e.method });
    return;
  }
  for (const it of run.stages[0].items) {
    if ((it.t === 'wait' || it.t === 'device') && !it.done) {
      it.done = true;
      rerender(it);
    }
  }
  run.signedIn = true;
  run.user = e.user;
  const who = e.user?.displayName ? `${e.user.displayName} (${e.user.upn})` : e.user?.upn ?? 'you';
  const text = e.state === 'reused' ? `Using your sign-in as ${who}` : `Signed in as ${who}`;
  add(run, { t: 'line', kind: 'ok', segs: [{ text }], text }, run.stages[0]);
  if (!app.replay) refreshState();
}

function onHeading(run, e) {
  const title = e.title;
  if (run.command !== 'install') {
    const root = run.stages[1];
    const fresh = run.cur !== root || (!root.items.length && !root.kids.length);
    if (COMMANDS[run.command].adopt && !run.adopted && fresh) {
      run.adopted = true;
      root.heading = title;
      if (run.cur !== root) enter(run, root, e.at);
      else paintStage(root);
      return;
    }
    ensureRoot(run, e.at);
    if (run.cur !== root) enter(run, root, e.at);
    const kid = newStage(title, { level: 1, parent: root });
    root.kids.push(kid);
    enter(run, kid, e.at);
    return;
  }
  if (DONE_HEADINGS.has(title) && run.phase !== 'done') {
    run.phase = 'done';
    run.doneTitle = title;
    const done = run.stages[run.stages.length - 1];
    done.heading = title;
    enter(run, done, e.at);
    return;
  }
  if (run.phase === 'build' || run.phase === 'done') {
    add(run, { t: 'subhead', title });
    return;
  }
  run.phase = 'questions';
  const known = run.stages.find((s) => s.status === 'upcoming' && s.title === title);
  if (known) {
    enter(run, known, e.at);
    return;
  }
  const first = run.stages.findIndex((s) => s.status === 'upcoming');
  const stage = newStage(title);
  run.stages.splice(first < 0 ? run.stages.length : first, 0, stage);
  enter(run, stage, e.at);
}

function onStep(run, e) {
  if (run.command !== 'install') return onHeading(run, { ...e, title: e.title });
  const parent = run.stages.find((s) => s.title === 'Setting up');
  if (run.phase !== 'build') {
    run.phase = 'build';
    enter(run, parent, e.at);
  }
  parent.n = e.n;
  parent.total = e.total;
  const kid = newStage(e.title, { level: 1, parent, n: e.n, total: e.total, step: true });
  parent.kids.push(kid);
  enter(run, kid, e.at);
  paintStage(parent);
}

function onLine(run, e) {
  ensureRoot(run, e.at);
  const stage = target(run);
  const raw = e.text ?? '';
  const trimmed = raw.replace(/^\s+/, '');
  const indent = raw.length - trimmed.length;
  const segs = dropChars(e.segments ?? [{ text: raw }], indent);
  const kind = e.kind === 'line' ? 'info' : e.kind;
  if (kind === 'info') {
    const m = KV.exec(trimmed);
    if (m && m[1].length <= 26) {
      add(run, { t: 'kv', k: m[1], segs: dropChars(segs, trimmed.length - m[2].length), text: trimmed });
      return;
    }
    const prev = [...stage.items].reverse().find((it) => !it.hidden && it.t !== 'wait');
    if (indent >= 2 && prev && (prev.t === 'kv' || (prev.t === 'line' && prev.kind === 'info'))) {
      prev.more.push(segs);
      rerender(prev);
      return;
    }
  }
  add(run, { t: 'line', kind, segs, text: trimmed });
}

/* ---------- Rendering: run ---------- */

function buildRunDom(run) {
  run.tileEl = h('div', { class: 'tile' });
  run.titleEl = h('h1', null);
  run.subEl = h('p', { class: 'sub' });
  run.secsEl = h('div', { class: 'secs' });
  run.outcomeEl = h('div', { hidden: true });
  run.jumpLabel = h('span', null, 'Back to the current step');
  run.jumpEl = h('button', {
    type: 'button', class: 'btn jump', hidden: true,
    onclick: () => {
      setFollow(true);
      app.revealEl = run.state === 'running' || run.outcomeEl.hidden ? lastEl(run) : run.outcomeEl;
      schedule();
    },
  }, icon('down'), run.jumpLabel);
  run.root = h('div', { class: 'page run' },
    h('header', { class: 'head' }, run.tileEl, h('div', { class: 'head-text' }, run.titleEl, run.subEl)),
    run.secsEl, run.outcomeEl, run.jumpEl);
  paintHead(run);
}

function lastEl(run) {
  const stage = target(run);
  if (!stage) return run.secsEl;
  const items = stage.items.filter((it) => it.el);
  return items.length ? items[items.length - 1].el : stage.el;
}

const headTitle = (run) => (run.state === 'done' && run.doneTitle ? run.doneTitle : run.title);

function paintHead(run) {
  const r = result(run);
  run.titleEl.textContent = headTitle(run);
  run.tileEl.className = `tile${r === 'done' ? ' ok' : r === 'failed' ? ' fail' : ''}`;
  run.tileEl.replaceChildren(icon(r === 'running' ? COMMANDS[run.command].icon : r === 'done' ? 'check' : r === 'failed' ? 'x' : 'stop'));
  const took = run.endedAt ? fmt(run.endedAt - run.startedAt) : '';
  run.subEl.replaceChildren(...[
    r === 'running' ? ['Running for ', since(run.startedAt)] : null,
    r === 'done' ? `Finished in ${took}` : null,
    r === 'held' ? 'Stopped before changing anything' : null,
    r === 'failed' ? `Stopped with an error after ${took}` : null,
    r === 'cancelled' ? `Stopped after ${took}` : null,
    run.user?.upn ? ` · ${run.user.upn}` : null,
  ].flat().filter(Boolean).map((x) => (x instanceof Node ? x : document.createTextNode(x))));
}

function mountStage(run, s) {
  if (s.el) return;
  const kid = s.level > 0;
  s.glyphEl = h('span', { class: 'gl' });
  s.titleEl = h(kid ? 'h3' : 'h2', { id: `t${s.id}` });
  s.nEl = h('span', { class: 'sec-n' });
  s.tookEl = h('span', { class: 'took' });
  s.body = h('div', { class: 'log' });
  s.kidsEl = h('div', { class: 'kids' });
  s.el = h('section', { class: kid ? 'sec child' : 'sec', 'aria-labelledby': `t${s.id}` },
    h('header', { class: 'sec-head' }, s.glyphEl, s.titleEl, s.nEl, s.tookEl), s.body, s.kidsEl);
  (kid ? s.parent.kidsEl : run.secsEl).append(s.el);
  paintStage(s);
}

function paintStage(s) {
  if (!s.el) return;
  s.el.dataset.status = s.status;
  s.glyphEl.replaceChildren(icon(STATUS_ICON[s.status], `ic st-${s.status}`), h('span', { class: 'sr' }, STATUS_TEXT[s.status]));
  s.titleEl.textContent = s.heading ?? s.title;
  s.nEl.textContent = s.level > 0 && s.total ? `Step ${s.n} of ${s.total}` : s.kids.length && s.total ? `${s.kids.length} of ${s.total} steps` : '';
  const timed = s.level > 0 || s.kids.length > 0;
  s.tookEl.replaceChildren(!timed ? '' : s.status === 'current' ? since(s.startedAt) : s.endedAt ? fmt(s.endedAt - s.startedAt) : '');
}

function renderItem(it) {
  if (it.hidden) return null;
  switch (it.t) {
    case 'line': {
      const { lead, steps } = moreParts(it.more);
      const joined = (list) => list.map((m) => [' ', segsEl(m)]);
      return h('div', { class: `ln ${it.kind}` },
        h('span', { class: 'gl' }, GLYPH[it.kind] ? icon(GLYPH[it.kind]) : null),
        h('span', { class: 'tx' }, segsEl(it.segs), joined(lead),
          steps.map(([first, ...rest]) => h('span', { class: 'step' }, segsEl(first), joined(rest)))));
    }
    case 'kv':
      return h('div', { class: 'kv-row' },
        h('span', { class: 'k' }, it.k),
        h('span', { class: 'v' }, segsEl(it.segs), it.more.map((m) => h('span', { class: 'more' }, segsEl(m)))));
    case 'subhead':
      return h('h3', { class: 'subhead' }, it.title);
    case 'qa':
      return h('div', { class: `qa${it.fresh ? ' fresh' : ''}${it.cancelled ? ' cancelled' : ''}` },
        h('span', { class: 'q' }, it.message),
        h('span', { class: 'a' }, it.display, it.auto ? h('span', { class: 'qa-note' }, 'Only option') : null));
    case 'prompt':
      return it.decide ? renderDecide(it) : renderPrompt(it);
    case 'progress':
      return renderProgress(it);
    case 'device':
      return renderDevice(it);
    case 'wait':
      return it.done ? null : h('div', { class: 'signin' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', null, WAITING[it.method] ?? 'Signing in.'));
    case 'review':
      return renderReview(it.plan);
    case 'loads':
      return renderLoads(it.cards);
    case 'next-steps':
      return null;
    case 'prereqs':
      return renderPrereqs(it.items);
    default:
      return null;
  }
}

const PREREQ_GLYPH = { met: 'check', missing: 'x', eligible: 'clock', unknown: 'circle' };
const PREREQ_STATE = { met: 'You have it', missing: 'Missing', eligible: 'Can be activated', unknown: 'Couldn\'t check' };

/** What the signed-in user has and lacks, each with what it's for and how to get it. */
function renderPrereqs(items) {
  return h('ul', { class: 'prereqs', 'aria-label': 'Prerequisites' },
    items.map((it) => h('li', { class: `prereq ${it.status}` },
      h('span', { class: 'gl' }, icon(PREREQ_GLYPH[it.status] ?? 'circle')),
      h('div', null,
        h('span', { class: 'prereq-name' }, it.label),
        ' ',
        h('span', { class: 'prereq-state' }, PREREQ_STATE[it.status] ?? it.status, it.optional ? ', optional' : ''),
        h('p', null, linkify(it.detail ?? '')),
        (it.rows ?? []).length
          ? h('ul', { class: 'prereq-rows' }, it.rows.map((r) => h('li', { class: r.status },
            h('span', { class: 'gl' }, icon(PREREQ_GLYPH[r.status] ?? 'circle')),
            h('span', null, h('strong', null, r.name), r.detail ? `: ${r.detail}` : ''))))
          : null,
        h('p', { class: 'prereq-why' }, h('strong', null, 'Needed for: '), it.neededFor),
        it.status !== 'met' ? h('p', { class: 'prereq-how' }, h('strong', null, 'How to get it: '), linkify(it.howTo ?? '')) : null))));
}

const LOAD_GLYPH = { ok: 'check', failed: 'x', skipped: 'minus', running: 'clock' };
const LOAD_STATE = { ok: 'loaded', failed: 'failed', skipped: 'didn\'t run', running: 'still running' };

/** One card per source: whether it loaded, why not and what to do. */
function renderLoads(cards) {
  return h('ul', { class: 'loads', 'aria-label': 'Loads by source' },
    cards.map((card) => h('li', { class: `load ${card.state}` },
      h('span', { class: 'gl' }, icon(LOAD_GLYPH[card.state] ?? 'circle')),
      h('div', null,
        h('span', { class: 'load-name' }, card.name),
        ' ',
        h('span', { class: 'load-state' }, LOAD_STATE[card.state] ?? card.state, card.attempts ? `, ${card.attempts} attempts` : ''),
        card.reason ? h('p', null, card.reason) : null,
        (card.fix ?? []).length ? h('p', { class: 'load-fix' }, card.fix.join('\n')) : null))));
}

function copyButton(text, labelText) {
  const label = document.createTextNode(labelText);
  return h('button', {
    type: 'button', class: 'btn',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        label.textContent = 'Copied';
      } catch {
        label.textContent = 'Select the text to copy it';
      }
    },
  }, icon('copy'), label);
}

/** What's left once it finishes: a card per step, with who does it, the link, and for a hand-off the message to send. */
function renderNextSteps(next) {
  return h('section', { class: 'next', 'aria-labelledby': 'next-title' },
    h('h3', { id: 'next-title' }, next.title),
    h('ol', { class: 'next-list' }, next.steps.map((s) => h('li', { class: `next-card${s.optional ? ' optional' : ''}` },
      h('div', { class: 'next-head' },
        h('span', { class: 'next-name' }, s.title),
        h('span', { class: 'next-who' }, s.who, s.optional ? ', optional' : '')),
      h('p', null, s.why),
      (s.steps ?? []).length ? h('ol', { class: 'next-how' }, s.steps.map((x) => h('li', null, x))) : null,
      s.message ? h('details', { class: 'next-message' }, h('summary', null, 'The message to send'), h('pre', null, s.message)) : null,
      s.link || s.message
        ? h('div', { class: 'actions' },
          s.message ? copyButton(s.message, 'Copy message') : null,
          s.link ? h('a', { class: 'btn', href: s.link, target: '_blank', rel: 'noreferrer' }, icon('link'), s.linkText ?? 'Open') : null)
        : null))));
}

function renderProgress(it) {
  const done = it.ms != null;
  it.statusEl = h('span', { class: 'prog-status' }, it.status);
  return h('div', { class: 'prog' },
    done ? h('span', { class: 'gl' }, icon('clock')) : h('span', { class: 'spin', 'aria-hidden': 'true' }),
    h('span', { class: 'prog-label' }, it.label),
    it.statusEl,
    h('span', { class: 'took' }, done ? fmt(it.ms) : since(it.startedAt)));
}

function renderDevice(it) {
  if (it.done) return h('div', { class: 'ln note' }, h('span', { class: 'gl' }), h('span', { class: 'tx' }, 'Signed in with a code.'));
  const label = document.createTextNode('Copy code');
  const copy = h('button', {
    type: 'button', class: 'btn',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(it.code);
        label.textContent = 'Copied';
      } catch {
        label.textContent = 'Select the code to copy it';
      }
    },
  }, icon('copy'), label);
  return h('div', { class: 'device' },
    h('h3', { class: 'label' }, 'Sign in with this code'),
    h('p', null, 'Open ', h('a', { href: it.url, target: '_blank', rel: 'noreferrer' }, it.url.replace(/^https:\/\//, '')),
      ' on any device, enter the code and sign in to your tenant. This page carries on by itself.'),
    h('div', { class: 'actions' },
      h('span', { class: 'code' }, it.code),
      copy,
      h('a', { class: 'btn primary', href: it.url, target: '_blank', rel: 'noreferrer' }, icon('link'), 'Open the sign-in page')));
}

function stopButton() {
  return h('button', { type: 'button', class: 'btn quiet push', onclick: () => post('/api/cancel') }, 'Stop here');
}

function errorEl(item) {
  const el = h('p', { class: 'err', role: 'alert', id: `err${item.id}` }, item.error);
  el.hidden = !item.error;
  item.errEl = el;
  return el;
}

function showError(item, message) {
  item.error = message;
  if (!item.errEl) return;
  item.errEl.textContent = message;
  item.errEl.hidden = !message;
}

function setBusy(item, busy) {
  item.busy = busy;
  const root = item.el;
  if (!root) return;
  root.classList.toggle('busy', busy);
  root.setAttribute('aria-busy', String(busy));
  for (const b of root.querySelectorAll('button')) b.disabled = busy;
}

async function answer(item, value) {
  if (item.busy) return;
  showError(item, '');
  setBusy(item, true);
  const r = await post('/api/answer', { id: item.id, value });
  setBusy(item, false);
  if (!r.ok) showError(item, r.body?.error ?? 'That answer wasn\'t accepted.');
}

/** On success the installer asks again from the question before, and the page is drawn again. */
async function goBack(item) {
  if (item.busy) return;
  showError(item, '');
  setBusy(item, true);
  const r = await post('/api/back');
  if (r.ok) return;
  setBusy(item, false);
  showError(item, r.body?.error ?? 'Couldn\'t go back.');
}

function backButton(item) {
  if (item.settingsBack) return h('button', { type: 'button', class: 'btn quiet', onclick: async () => {
    if (item.busy) return;
    setBusy(item, true);
    const response = await post('/api/section-cancel');
    if (!response.ok) {
      setBusy(item, false);
      showError(item, response.body?.error ?? 'Could not return to settings.');
    }
  } }, icon('back'), 'Back to settings');
  return item.back ? h('button', { type: 'button', class: 'btn quiet', onclick: () => goBack(item) }, icon('back'), 'Back') : null;
}

/** Where a new question puts the cursor: the filter, the chosen option, the first option or box, else the default button, never Back. */
function focusTarget(el) {
  for (const sel of ['input.filter', 'input[type=radio]:checked', 'input:not(:disabled)', 'button.primary', 'button:not(.quiet)']) {
    const hit = el.querySelector(sel);
    if (hit) return hit;
  }
  return null;
}

function renderPrompt(item) {
  const titleId = `q${item.id}`;
  const errId = `err${item.id}`;
  let body = null;
  let submit = () => {};
  let buttons = [h('button', { type: 'submit', class: 'btn primary' }, 'Continue')];

  if (item.kind === 'settings') {
    body = h('div', { class: 'ask-body' },
      h('p', { class: 'hint' }, `Open any category to edit its settings. Your other answers stay unchanged.${app.run?.route === 'pax' ? '' : ' A capacity that\'s active now could be paused by the time you deploy.'}`),
      item.notice ? h('p', { class: 'err', role: 'alert' }, item.notice) : null,
      h('div', { class: 'settings-grid' }, item.categories.map((cat) =>
        h('button', { type: 'button', class: 'settings-card', onclick: () => answer(item, cat.id) },
          h('span', { class: 'opt-name' }, cat.title, h('span', { class: 'opt-tag' }, cat.complete ? 'Reviewed' : 'Needs review')),
          h('span', { class: 'opt-desc' }, cat.summary), h('span', { class: 'hint' }, 'Edit settings')))),
      item.changes.length ? h('details', { class: 'settings-changes', open: true }, h('summary', null, 'Changes in this session'),
        h('ul', null, item.changes.map((text) => h('li', null, text)))) : null,
      app.attempts.length ? h('details', { class: 'settings-changes' }, h('summary', null, 'Previous attempts in this session'),
        app.attempts.map((attempt) => h('div', { class: 'settings-field' },
          h('strong', null, `${new Date(attempt.at).toLocaleString()}: ${attempt.state}`),
          attempt.error ? h('pre', null, attempt.error) : null))) : null);
    buttons = [
      h('button', { type: 'button', class: 'btn primary', onclick: () => answer(item, 'deploy') }, 'Review and deploy'),
      h('button', { type: 'button', class: 'btn', onclick: () => answer(item, 'close') }, 'Save and close'),
    ];
  } else if (item.kind === 'form') {
    const controls = item.fields.map((field) => {
      const id = `f${item.id}-${field.id}`;
      const control = field.choices
        ? h('select', { id, class: 'field', disabled: !!field.readOnly, 'aria-describedby': errId }, field.choices.map((ch) =>
          h('option', { value: ch.value, selected: ch.value === field.default, disabled: !!ch.disabled }, ch.name, typeof ch.disabled === 'string' ? ` (${ch.disabled})` : '')))
        : h('input', { id, class: 'field', type: 'text', readonly: !!field.readOnly, value: field.default, autocomplete: 'off', 'aria-describedby': errId });
      return { field, control, el: h('div', { class: 'settings-field' }, h('label', { class: 'label', for: id }, field.label), control, field.readOnly ? h('p', { class: 'hint' }, field.readOnly) : null) };
    });
    body = h('div', { class: 'ask-body' }, controls.map((x) => x.el));
    buttons = [h('button', { type: 'submit', class: 'btn primary' }, 'Save changes')];
    submit = () => answer(item, Object.fromEntries(controls.map(({ field, control }) => [field.id, control.value])));
  } else if (item.kind === 'select' || item.kind === 'checkbox') {
    const radio = item.kind === 'select';
    const rows = item.choices.map((ch, i) => {
      const off = !!ch.disabled;
      const locked = !radio && off && !!ch.checked;
      const note = typeof ch.disabled === 'string' ? ch.disabled : null;
      return h('label', { class: locked ? 'opt locked' : off ? 'opt off' : 'opt' },
        h('input', {
          type: radio ? 'radio' : 'checkbox', name: titleId, value: i, disabled: off,
          checked: radio ? i === item.default : !!ch.checked, 'aria-describedby': errId,
        }),
        h('span', { class: 'opt-text' },
          h('span', { class: 'opt-name' }, ch.name, locked && note ? h('span', { class: 'opt-tag' }, note) : null),
          ch.description ? h('span', { class: 'opt-desc' }, ch.description) : null,
          !locked && note ? h('span', { class: 'opt-desc' }, note) : null));
    });
    const opts = h('div', { class: 'opts', role: radio ? 'radiogroup' : 'group', 'aria-labelledby': titleId }, rows);
    let filter = null;
    if (rows.length > 8) {
      filter = h('input', { class: 'field filter', type: 'search', 'aria-label': 'Filter the options', placeholder: 'Filter', autocomplete: 'off' });
      filter.addEventListener('input', () => {
        const q = filter.value.trim().toLowerCase();
        for (const row of rows) row.hidden = !!q && !row.textContent.toLowerCase().includes(q);
      });
    }
    body = h('div', { class: 'ask-body' }, filter, opts);
    submit = () => {
      const picked = [...opts.querySelectorAll('input:checked:not(:disabled)')].map((x) => Number(x.value));
      if (radio) {
        if (!picked.length) return showError(item, 'Choose one of the options.');
        answer(item, picked[0]);
      } else answer(item, picked);
    };
  } else if (item.kind === 'confirm') {
    const yes = h('button', { type: 'button', class: item.default === false ? 'btn' : 'btn primary', onclick: () => answer(item, true) }, 'Yes');
    const no = h('button', { type: 'button', class: item.default === false ? 'btn primary' : 'btn', onclick: () => answer(item, false) }, 'No');
    buttons = [yes, no];
  } else {
    const secret = item.kind === 'secret';
    const input = h('input', {
      class: 'field', type: secret ? 'password' : 'text', 'aria-labelledby': titleId, 'aria-describedby': secret ? `${errId} h${item.id}` : errId,
      value: secret ? null : item.default ?? '', autocomplete: secret ? 'new-password' : 'off', spellcheck: 'false',
    });
    body = h('div', { class: 'ask-body' }, input,
      secret ? h('p', { class: 'hint', id: `h${item.id}` }, item.keep
        ? 'Leave it empty to keep the secret you already pasted, or paste a new one. It isn\'t saved in the install record or shown on this page again.'
        : 'Hidden as you type. It isn\'t saved in the install record or shown on this page again.') : null);
    submit = () => answer(item, input.value);
  }

  const form = h('form', { class: 'ask', 'aria-labelledby': titleId, novalidate: true },
    h('h2', { id: titleId }, item.message), body, errorEl(item), h('div', { class: 'actions' }, backButton(item), buttons, stopButton()));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  return form;
}

function renderDecide(item) {
  return h('div', { class: 'decide', role: 'group', 'aria-label': item.message },
    h('p', null, h('strong', null, 'Nothing has been created yet. '), 'Go ahead to create what\'s listed above, or stop here and keep your answers for next time.'),
    h('div', { class: 'actions' },
      backButton(item),
      h('button', { type: 'button', class: 'btn primary', onclick: () => answer(item, true) }, 'Go ahead'),
      h('button', { type: 'button', class: 'btn', onclick: () => answer(item, false) }, 'Not now'),
      h('button', { type: 'button', class: 'btn quiet', onclick: () => savePlan(app.run) }, icon('download'), 'Save this plan')),
    errorEl(item));
}

function renderReview(plan) {
  const table = (head, rows) => h('table', { class: 'table' },
    h('thead', null, h('tr', null, head.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', null, rows));
  const detail = (d) => (d ? h('span', { class: 'detail' }, d) : null);
  const fresh = plan.creates.filter((c) => c.isNew).length;
  const kept = plan.creates.length - fresh;
  return h('div', { class: 'review' },
    h('section', { class: 'rv' },
      h('div', { class: 'rv-head' }, h('h2', null, 'What it creates'), h('span', { class: 'sec-n' }, `${fresh} new${kept ? `, ${kept} already there` : ''}`)),
      table(['Item', 'Name', ''], plan.creates.map((c) => h('tr', null,
        h('td', { class: 'kind' }, c.kind),
        h('td', null, h('span', { class: 'name' }, c.name), detail(c.detail)),
        h('td', { class: 'state' }, h('span', { class: c.isNew ? 'badge' : 'badge existing' }, c.isNew ? 'New' : 'Already there')))))),
    h('section', { class: 'rv' },
      h('div', { class: 'rv-head' }, h('h2', null, 'Access it grants')),
      table(['Who', 'Gets', 'On'], plan.grants.map((g) => h('tr', null,
        h('td', null, h('span', { class: 'name' }, g.who)),
        h('td', null, g.what, detail(g.detail)),
        h('td', null, g.where))))),
    h('section', { class: 'rv' },
      h('div', { class: 'rv-head' }, h('h2', null, 'Where it runs and bills')),
      table(['What', 'Where'], plan.runsOn.map((r) => h('tr', null,
        h('td', null, h('span', { class: 'name' }, r.what)),
        h('td', null, r.where, detail(r.detail)))))),
    plan.costs?.length ? h('section', { class: 'rv' },
      h('div', { class: 'rv-head' }, h('h2', null, 'Costs')),
      table(['What', 'Pricing'], plan.costs.map((x) => h('tr', null,
        h('td', null, h('span', { class: 'name' }, x.what), detail(x.detail)),
        h('td', null, linkify(x.url)))))) : null);
}

function renderOutcome(run) {
  const r = result(run);
  const install = run.command === 'install';
  const built = run.phase === 'build' || run.phase === 'done';
  const took = fmt(run.endedAt - run.startedAt);
  const copy = {
    done: ['ok', `Finished in ${took}`, [install ? 'Save a record of what was set up and the answers you gave. It holds no secrets.' : 'Save a record of this run if you want to keep it.']],
    held: ['', 'Nothing was created', ['Your answers are saved, so Set up starts from them next time.']],
    failed: ['fail', 'It stopped with an error', [
      run.error.split('\n')[0],
      install ? 'Your saved choices are available below. Review a category or retry after fixing the problem. Resources already created are checked and reused where safe.' : null,
    ]],
    cancelled: run.paused
      ? ['', 'Paused', [run.paused, 'Your answers are saved, so it carries on from here next time.']]
      : ['', 'Stopped', [install && !built ? 'Nothing was created.' : 'Nothing after this point ran.']],
  }[r] ?? ['', 'Finished', []];
  const rerun = run.failedLoads && app.state?.record?.can?.['rerun-failed'];
  return h('section', { class: `outcome ${copy[0]}`.trim(), 'aria-labelledby': 'outcome-title' },
    h('h2', { id: 'outcome-title' }, copy[1]),
    run.nextSteps?.steps.length ? renderNextSteps(run.nextSteps) : null,
    copy[2].filter(Boolean).map((p) => h('p', null, p)),
    r === 'failed' && run.error ? h('details', { class: 'settings-changes' }, h('summary', null, 'Technical details'), h('pre', null, run.error)) : null,
    rerun ? h('p', null, 'Some loads failed. Rerun failed runs just those again, and the steps that waited for them.') : null,
    h('div', { class: 'actions' },
      install && r === 'failed' && run.recovery?.section ? h('button', { type: 'button', class: 'btn primary', onclick: () => start('install', { section: run.recovery.section }) }, run.recovery.label) : null,
      install && r === 'failed' ? [
        h('button', { type: 'button', class: 'btn primary', onclick: () => start('install') }, icon('sliders'), 'Edit all settings'),
        h('button', { type: 'button', class: 'btn', onclick: () => start('install', { retry: true }) }, icon('refresh'), 'Retry saved configuration'),
      ] : null,
      rerun ? h('button', { type: 'button', class: 'btn primary', onclick: () => start('rerun-failed') }, icon('refresh'), 'Rerun failed') : null,
      h('button', { type: 'button', class: rerun ? 'btn' : 'btn primary', onclick: () => saveRecord(run) }, icon('download'), 'Save a record'),
      h('button', { type: 'button', class: 'btn', onclick: () => show('home') }, 'Back to home')));
}

/* ---------- Rendering: home ---------- */

function head(iconName, title, sub, tileClass = '') {
  return h('header', { class: 'head' },
    h('div', { class: `tile ${tileClass}`.trim() }, icon(iconName)),
    h('div', { class: 'head-text' }, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null));
}

function methodPicker() {
  const current = app.method ?? app.state.defaults.method;
  return h('fieldset', { class: 'methods' },
    h('legend', null, 'Sign in with'),
    METHODS.map((m) => {
      const input = h('input', { type: 'radio', name: 'method', value: m.value, checked: m.value === current });
      input.addEventListener('change', () => {
        app.method = m.value;
      });
      return h('label', { class: 'method' }, input,
        h('span', { class: 'method-text' },
          h('span', { class: 'method-name' }, m.name, m.tag ? h('span', { class: 'method-tag' }, m.tag) : null),
          h('span', { class: 'method-desc' }, m.desc)));
    }));
}

/** A new install's route. PAX needs this PC to be Windows, since its scheduled task runs here. */
function routePicker(busy) {
  const current = routeOf();
  return h('fieldset', { class: 'methods' },
    h('legend', null, 'Where should AI in One get its data?'),
    ROUTES.map((r) => {
      const off = r.value === 'pax' && !app.state.paxHere;
      const input = h('input', { type: 'radio', name: 'route', value: r.value, checked: r.value === current, disabled: off || busy });
      input.addEventListener('change', () => {
        app.target = r.value;
        byId('view').replaceChildren(renderHome());
        byId('view').querySelector(`input[name="route"][value="${r.value}"]`)?.focus();
      });
      return h('label', { class: 'method' }, input,
        h('span', { class: 'method-text' },
          h('span', { class: 'method-name' }, r.name, off ? h('span', { class: 'method-tag' }, 'Needs Windows') : null),
          h('span', { class: 'method-desc' }, r.desc)));
    }));
}

function signedInNote() {
  const u = app.state.user;
  return h('p', { class: 'ln ok' }, h('span', { class: 'gl' }, icon('check')),
    h('span', { class: 'tx' }, `Signed in as ${u.displayName ? `${u.displayName} (${u.upn})` : u.upn}. The installer uses this sign-in.`));
}

function runningBanner() {
  const run = app.run;
  return h('div', { class: 'back' },
    h('span', null, h('strong', null, run.title), ` is running${run.cur ? `: ${run.cur.heading ?? run.cur.title}` : ''}.`),
    h('button', { type: 'button', class: 'btn primary', onclick: () => show('run') }, 'Back to it'));
}

/** A newer installer is out: says so, with a link to download it. */
function updateBanner() {
  const u = app.state?.update;
  if (!u) return null;
  return h('div', { class: 'back', role: 'status' },
    h('span', null, h('strong', null, `Installer ${u.version} is available.`), ' ', launcher().update ?? 'Download it, open it and choose Repair or change.'),
    h('a', { class: 'btn primary', href: u.url, target: '_blank', rel: 'noreferrer' }, 'Get it'));
}

function startError() {
  const el = h('p', { class: 'err', role: 'alert' }, app.startError);
  el.hidden = !app.startError;
  return el;
}

/** The install record points at a workspace that's gone: start fresh, or keep the record. */
function staleBanner(busy) {
  const gone = app.state?.stale;
  if (!gone) return null;
  const err = h('p', { class: 'err', role: 'alert' });
  err.hidden = true;
  const act = async (path) => {
    const r = await post(path);
    if (!r.ok) {
      err.textContent = r.body?.error ?? 'That didn\'t work. Try again.';
      err.hidden = false;
      return;
    }
    if (r.body?.archived) announce(`The old install record is now ${r.body.archived}.`);
    refreshState();
  };
  const other = gone.reason === 'other-tenant';
  return h('section', { class: 'outcome fail', role: 'alert' },
    h('h2', null, other ? 'This workspace isn\'t in the tenant you signed in to' : 'This workspace no longer exists'),
    h('p', null, other
      ? `Your install record is for "${gone.workspace}", in another tenant.`
      : `Fabric can't find "${gone.workspace}", the workspace in your install record. It may have been deleted.`),
    h('p', null, 'Start fresh to set up AI in One again. The old record is kept beside the new one, renamed with the date and time.'),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn primary', disabled: busy, onclick: () => act('/api/fresh') }, 'Start fresh'),
      h('button', { type: 'button', class: 'btn', disabled: busy, onclick: () => act('/api/keep') }, 'Keep this record')),
    err);
}

function renderHome() {
  const st = app.state;
  if (!st) return h('div', { class: 'page' }, h('p', { class: 'sub' }, 'Loading.'));
  const rec = st.record;
  const running = app.run?.state === 'running';
  const busy = running || app.starting || !!st.running;
  const kids = [];

  if (st.recordError) {
    kids.push(h('section', { class: 'outcome fail' },
      h('h2', null, 'The install record can\'t be read'),
      h('p', null, st.recordError),
      h('p', { class: 'hint' }, st.configFile)));
  }

  if (!rec?.installed) {
    const route = routeOf();
    kids.unshift(head('sliders', 'Set up AI in One', `Installer ${st.version}`));
    kids.push(updateBanner());
    kids.push(staleBanner(busy));
    if (running) kids.push(runningBanner());
    kids.push(h('p', { class: 'lede' }, LEDE[route]));
    if (rec) kids.push(h('p', { class: 'hint' }, 'Your answers from last time are saved, so the questions start from them.'));
    else if (st.draftTarget) {
      kids.push(h('p', { class: 'hint' }, `Setup carries on from your answers last time, with ${ROUTES.find((r) => r.value === route)?.name ?? route}.`));
    }

    const tenantInput = h('input', {
      id: 'tenant', class: 'field', type: 'text', value: app.tenant ?? st.defaults.tenant ?? '', autocomplete: 'off',
      spellcheck: 'false', 'aria-describedby': 'tenant-hint',
    });
    tenantInput.addEventListener('input', () => {
      app.tenant = tenantInput.value;
    });
    const form = h('form', { class: 'panel-body', novalidate: true },
      rec || st.draftTarget ? null : routePicker(busy),
      st.user ? signedInNote() : [
        methodPicker(),
        h('div', { class: 'tenant' },
          h('label', { class: 'label', for: 'tenant' }, 'Tenant ', h('span', { class: 'hint-inline' }, 'optional')),
          tenantInput,
          h('p', { class: 'hint', id: 'tenant-hint' }, 'Your tenant ID or domain, such as contoso.onmicrosoft.com. Leave it blank to use your home tenant.')),
      ],
      h('div', { class: 'actions' },
        h('button', { type: 'submit', class: `btn primary${app.starting ? ' busy' : ''}`, disabled: busy }, 'Set up AI in One'),
        h('p', { class: 'hint' }, 'Nothing is created until you\'ve reviewed the plan and chosen Go ahead.')),
      startError());
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      start('install');
    });
    kids.push(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, rec || st.draftTarget ? 'Sign in to your tenant' : 'Choose a route and sign in')), form));
    kids.push(prereqsPanel(busy));
    return h('div', { class: 'page' }, kids);
  }

  kids.unshift(head('home', 'Manage AI in One', `Tenant ${rec.tenantId}`));
  kids.push(updateBanner());
  kids.push(staleBanner(busy));
  if (running) kids.push(runningBanner());

  const pax = rec.target === 'pax';
  const days = rec.secretExpires ? Math.floor((Date.parse(rec.secretExpires) - Date.now()) / 86_400_000) : null;
  const soon = days != null && days < 30;
  const firstRun = rec.firstRun ? rec.firstRun.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/ ([A-Z])/g, (_, c) => ` ${c.toLowerCase()}`) : 'Not run yet';
  const link = (text, url) => (url ? h('a', { href: url, target: '_blank', rel: 'noreferrer' }, text) : text);
  const expires = rec.secretExpires ? h('span', { class: soon ? 'soon' : null }, `${rec.secretExpires} (${days < 0 ? 'expired' : `in ${days} days`})`) : 'Unknown';
  const recordRow = ['Install record', [h('div', null, st.configFile),
    /[\\/]Documents[\\/]/i.test(st.configFile ?? '') ? h('p', { class: 'hint' }, 'If OneDrive syncs your Documents folder, this record follows you to your other PCs.') : null]];
  const rows = (pax ? [
    ['Tenant', rec.tenantId],
    ['Files', rec.files],
    ['Collects', rec.data.join(', ')],
    ['Scheduled task', rec.task ?? 'Not set up'],
    ['Workspace', rec.workspace ? link(rec.workspace, rec.workspaceUrl) : null],
    ['Semantic model', rec.model ?? 'Not deployed'],
    ['Report', rec.report ? link(rec.report.name, rec.report.url) : 'Not deployed'],
    ['The AI in One app', rec.app ? link(rec.app.name, rec.app.url) : rec.appSkipped ? `Not deployed: ${rec.appSkipped}` : 'Not deployed'],
    ['Viewer group', rec.viewers],
    [rec.credential === 'secret' ? 'Client secret expires' : 'Certificate expires', expires],
    ['Last run', rec.lastRun ? `${PAX_RUN[rec.lastRun.status] ?? rec.lastRun.status}${rec.lastRun.mode === 'seed' ? ', loading history' : ''}, ${new Date(rec.lastRun.at).toLocaleString()}` : 'Not run yet'],
    ['Audit history', rec.historyDays ? `${rec.historyDays} days` : null],
    recordRow,
  ] : [
    ['Tenant', rec.tenantId],
    ['Workspace', link(rec.workspace, rec.workspaceUrl)],
    ['Lakehouse', rec.lakehouse],
    ['Collects', rec.data.join(', ')],
    ['Semantic model', rec.model ?? 'Not deployed'],
    ['Report', rec.report ? link(rec.report.name, rec.report.url) : 'Not deployed'],
    ['Viewer group', rec.viewers],
    ['Schedule', rec.schedule ?? 'Not set'],
    ['Client secret expires', expires],
    ['First load', firstRun],
    ['Audit history', rec.historyDays ? `${rec.historyDays} days` : null],
    recordRow,
  ]).filter(([, v]) => v != null && v !== '');
  kids.push(h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Your installation'),
      rec.workspaceUrl ? h('a', { href: rec.workspaceUrl, target: '_blank', rel: 'noreferrer' }, 'Open the workspace') : null),
    h('div', { class: 'panel-body' }, h('dl', { class: 'record' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])))));

  const primary = soon && rec.can['rotate-secret'] ? 'rotate-secret' : rec.firstRun !== 'Completed' && rec.can.run ? 'run' : 'status';
  const actions = ROW_ORDER.filter((cmd) => !cmdOf(cmd, rec.target).hide).map((cmd) => {
    const c = cmdOf(cmd, rec.target);
    const can = cmd === 'install' || !!rec.can[cmd];
    const history = cmd === 'run' && can ? historyPicker(busy, rec) : null;
    return h('li', { class: 'row' }, icon(c.icon),
      h('div', { class: 'row-text' },
        h('span', { class: 'row-title' }, c.row),
        h('span', { class: 'row-desc' }, c.desc),
        !can && c.off ? h('span', { class: 'row-why' }, c.off) : null,
        history),
      h('button', {
        type: 'button', class: cmd === primary ? 'btn primary' : 'btn', disabled: !can || busy,
        onclick: () => start(cmd, cmd === 'run' && app.backfill ? { backfillDays: Number(app.backfill) } : {}),
      }, c.button));
  });
  kids.push(h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Actions')),
    h('div', { class: 'panel-body' }, st.user ? signedInNote() : methodPicker(), startError()),
    h('ul', { class: 'rows' }, actions)));
  kids.push(prereqsPanel(busy));
  return h('div', { class: 'page' }, kids);
}

const BACKFILL = [
  { value: '', name: 'Usual run' },
  { value: '30', name: 'Reload the last 30 days of audit history' },
  { value: '90', name: 'Reload the last 90 days of audit history' },
  { value: '180', name: 'Reload the last 180 days of audit history' },
];

/**
 * Run now can reload audit history, like run --backfill-days. On Fabric a reload keeps the older rows,
 * so it starts straight away. With PAX, fewer days than are loaded drops the rest, so pax/flow.js
 * runNow() asks first and the question shows on the run page.
 */
function historyPicker(busy, rec) {
  const hint = h('span', { class: 'row-desc', id: 'backfill-hint' });
  const loaded = rec.firstRun === 'Completed' ? rec.historyDays : 0;
  const paint = () => {
    const n = Number(app.backfill || 0);
    hint.textContent = n ? [
      rec.target === 'pax'
        ? 'PAX loads these days of audit history again, then the model refreshes on the new files.'
        : 'Loads these days of audit history again and keeps older days, then runs the data check.',
      n >= 90 ? 'In a large tenant, this can take several hours. The usual schedule carries on afterwards.' : '',
      rec.target === 'pax' && loaded && n < loaded ? `That's fewer than the ${loaded} days loaded now. The installer asks before it drops the older days.` : '',
    ].filter(Boolean).join(' ') : '';
    hint.hidden = !n;
  };
  const sel = h('select', { id: 'backfill', class: 'field', disabled: busy, 'aria-describedby': 'backfill-hint' },
    BACKFILL.map((o) => h('option', { value: o.value, selected: (app.backfill ?? '') === o.value }, o.name)));
  sel.addEventListener('change', () => {
    app.backfill = sel.value;
    paint();
  });
  paint();
  return h('div', { class: 'history-pick' }, h('label', { class: 'label', for: 'backfill' }, 'Audit history'), sel, hint);
}

/**
 * Roles, licences, capacities, tenant settings, for Key Vault Azure access, and with PAX this PC: what the signed-in user has and lacks.
 * Before sign-in it lists what the chosen route needs, with a button that signs in and checks.
 */
function prereqsPanel(busy) {
  const st = app.state;
  const p = st.prereqs;
  const when = p ? new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const button = h('button', { type: 'button', class: 'btn', disabled: busy, onclick: () => start('prereqs') },
    p ? 'Check again' : st.user ? 'Check prerequisites' : 'Sign in and check');
  let body;
  if (p) {
    const counts = ['met', 'eligible', 'missing', 'unknown'].map((s) => [s, p.items.filter((i) => i.status === s).length]).filter(([, n]) => n);
    const other = !st.record && p.target && p.target !== routeOf() ? ROUTES.find((r) => r.value === p.target) : null;
    body = [
      h('p', { class: 'hint' }, `Checked as ${p.upn} at ${when}. ${counts.map(([s, n]) => `${n} ${PREREQ_STATE[s].toLowerCase()}`).join(', ')}. Only active roles count. A role you can activate yourself in Entra (Privileged Identity Management) needs activating first.`),
      other ? h('p', { class: 'hint' }, `This check was for ${other.name}. Check again for the route you've chosen.`) : null,
      renderPrereqs(p.items),
    ];
  } else if (st.user) {
    body = [h('p', { class: 'hint' }, 'Checking your roles, licences and access in the background. This takes a few seconds.')];
  } else {
    body = [
      h('p', { class: 'hint' }, 'Sign in to check which of these you have. The check only reads; it changes nothing.'),
      h('ul', { class: 'needs' }, NEEDS[routeOf()].map((n) => h('li', null, n))),
    ];
  }
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Prerequisites'), button),
    h('div', { class: 'panel-body' }, body));
}

/* ---------- Rendering: rail ---------- */

function blurb(run) {
  if (run.state === 'running') {
    if (app.openPrompt) return 'Waiting for your answer';
    const s = target(run);
    return s ? `Running: ${s.heading ?? s.title}` : 'Running';
  }
  return { done: 'Finished', held: 'Nothing created', failed: 'Stopped with an error', cancelled: run.paused ? 'Paused' : 'Stopped' }[result(run)];
}

function stageButton(s) {
  const label = [
    icon(STATUS_ICON[s.status], `ic st-${s.status}`),
    h('span', { class: 'stage-title' }, s.title),
    s.kids.length && s.total ? h('span', { class: 'sec-n' }, `${s.kids.length}/${s.total}`) : null,
    h('span', { class: 'sr' }, `, ${STATUS_TEXT[s.status]}`),
  ];
  if (!s.el) return h('span', { class: 'stage', 'data-status': s.status }, label);
  return h('button', {
    type: 'button', class: 'stage', 'data-status': s.status, 'data-key': `s${s.id}`,
    'aria-current': s.status === 'current' ? 'step' : null, onclick: () => goStage(s),
  }, label);
}

function renderRail() {
  const rail = byId('rail');
  const focusKey = document.activeElement?.closest?.('#rail [data-key]')?.getAttribute('data-key');
  const run = app.run;
  const st = app.state;
  const running = run?.state === 'running' || !!st?.running;
  const dark = effectiveTheme() === 'dark';
  const where = app.view === 'run' && run ? (target(run)?.title ?? run.title) : 'Home';

  const top = h('div', { class: 'rail-top' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-name' }, 'AI in One'), h('span', { class: 'brand-sub' }, 'Installer')),
    h('button', {
      type: 'button', class: 'rail-toggle', 'data-key': 'toggle', 'aria-expanded': String(app.railOpen), 'aria-controls': 'rail-menu',
      onclick: () => {
        app.railOpen = !app.railOpen;
        renderRail();
      },
    }, icon('menu'), h('span', null, where)));

  const dests = h('ul', { class: 'dests', id: 'rail-menu' },
    h('li', null, h('button', {
      type: 'button', class: 'dest', 'data-key': 'home', 'aria-current': app.view === 'home' ? 'page' : null, onclick: () => show('home'),
    }, icon('home'), h('span', { class: 'dest-text' },
      h('span', { class: 'dest-label' }, 'Home'),
      h('span', { class: 'dest-blurb' }, st?.record?.installed ? 'Your installation' : 'Start here')))),
    run ? h('li', null,
      h('button', {
        type: 'button', class: 'dest', 'data-key': 'run', 'aria-current': app.view === 'run' ? 'page' : null, onclick: () => show('run'),
      }, icon(COMMANDS[run.command].icon), h('span', { class: 'dest-text' },
        h('span', { class: 'dest-label' }, run.title),
        h('span', { class: 'dest-blurb' }, blurb(run)))),
      h('ol', { class: 'stages', 'aria-label': 'Stages' }, run.stages.filter(onRoute(run)).map((s) => h('li', null,
        stageButton(s),
        s.kids.length ? h('ol', { class: 'steps' }, s.kids.map((k) => h('li', null, stageButton(k)))) : null)))) : null);

  const foot = h('div', { class: 'rail-foot' },
    st?.user ? h('p', { class: 'who' }, 'Signed in as', h('strong', null, st.user.displayName || st.user.upn), st.user.displayName ? st.user.upn : null) : null,
    h('button', { type: 'button', class: 'foot-btn', 'data-key': 'theme', onclick: () => setTheme(dark ? 'light' : 'dark') },
      icon(dark ? 'sun' : 'moon'), dark ? 'Light theme' : 'Dark theme'),
    h('button', {
      type: 'button', class: 'foot-btn', 'data-key': 'close', disabled: running, title: running ? 'Wait for the current command to finish' : null, onclick: quit,
    }, icon('power'), 'Close installer'));

  rail.classList.toggle('open', app.railOpen);
  rail.replaceChildren(top, dests, foot);
  if (focusKey) rail.querySelector(`[data-key="${focusKey}"]`)?.focus();
}

/* ---------- Views, scrolling and following ---------- */

const scroller = () => (narrow.matches ? document.scrollingElement : byId('main'));

// The visible band of the scroller. On narrow screens the page scrolls under the sticky top bar.
function viewport(sc) {
  if (sc !== document.scrollingElement) {
    const r = sc.getBoundingClientRect();
    return { top: r.top, height: sc.clientHeight };
  }
  const top = Math.max(0, byId('rail').getBoundingClientRect().bottom);
  return { top, height: window.innerHeight - top };
}

// Smooth scrolling is for short hops. A long glide only shows blank page going past.
function glide(sc, y, view) {
  const far = Math.abs(y - sc.scrollTop) > view.height * 1.5;
  sc.scrollTo({ top: y, behavior: far || app.replay || reduced.matches ? 'auto' : 'smooth' });
}

function show(view) {
  if (view === 'run' && !app.run) view = 'home';
  app.view = view;
  app.railOpen = false;
  const v = byId('view');
  if (view === 'home') {
    v.replaceChildren(renderHome());
    scroller().scrollTop = 0;
  } else {
    v.replaceChildren(app.run.root);
    if (app.follow) app.revealEl = lastEl(app.run);
  }
  paintJump();
  schedule();
  renderRail();
}

function goStage(s) {
  if (app.view !== 'run') show('run');
  app.railOpen = false;
  const run = app.run;
  setFollow(s === target(run));
  const sc = scroller();
  const view = viewport(sc);
  app.progUntil = Date.now() + 900;
  glide(sc, sc.scrollTop + s.el.getBoundingClientRect().top - view.top - 16, view);
  renderRail();
  s.titleEl.setAttribute('tabindex', '-1');
  s.titleEl.focus({ preventScroll: true });
}

function setFollow(v) {
  app.follow = v;
  paintJump();
}

function paintJump() {
  const run = app.run;
  if (!run) return;
  // Once the run ends, the same button takes someone who scrolled back up to the result.
  run.jumpEl.hidden = app.follow || !!app.openPrompt?.decide;
  run.jumpLabel.textContent = run.state === 'running' ? 'Back to the current step' : 'See the result';
}

function onScroll() {
  if (app.view !== 'run') return;
  const sc = scroller();
  const top = sc.scrollTop;
  const near = sc.scrollHeight - top - sc.clientHeight < 96;
  if (near) setFollow(true);
  else if (Date.now() > app.progUntil && Date.now() - app.userAt < 1000 && top < app.lastTop - 2) setFollow(false);
  app.lastTop = top;
}

function schedule() {
  if (app.scheduled) return;
  app.scheduled = true;
  requestAnimationFrame(() => {
    app.scheduled = false;
    renderRail();
    if (app.run) paintHead(app.run);
    flushReveal();
  });
}

function flushReveal() {
  const stage = app.revealStage;
  const el = app.revealEl;
  const focus = app.focusEl;
  app.revealStage = app.revealEl = app.focusEl = null;
  if (app.view !== 'run') return;
  if (app.follow && (stage?.el?.isConnected || el?.isConnected)) {
    const sc = scroller();
    const view = viewport(sc);
    let y = sc.scrollTop;
    if (stage?.el?.isConnected) y = sc.scrollTop + stage.el.getBoundingClientRect().top - view.top - 16;
    if (el?.isConnected) {
      const bottom = sc.scrollTop + el.getBoundingClientRect().bottom - view.top + 24;
      if (bottom > y + view.height) y = bottom - view.height;
    }
    if (Math.abs(y - sc.scrollTop) > 1) {
      app.progUntil = Date.now() + 900;
      glide(sc, y, view);
    }
  }
  const active = document.activeElement;
  if (focus?.isConnected && (!active || active === document.body || byId('view').contains(active))) focus.focus({ preventScroll: true });
}

/* ---------- Theme ---------- */

function effectiveTheme() {
  return document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('aio-theme', theme);
  } catch {
    // Storage is optional.
  }
  renderRail();
}

/* ---------- Records ---------- */

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function reviewMarkdown(plan) {
  const L = [];
  L.push('### What it creates', '', '| Item | Name | | Details |', '|---|---|---|---|');
  for (const c of plan.creates) L.push(`| ${cell(c.kind)} | ${cell(c.name)} | ${c.isNew ? 'New' : 'Already there'} | ${cell(c.detail)} |`);
  L.push('', '### Access it grants', '', '| Who | Gets | On | Details |', '|---|---|---|---|');
  for (const g of plan.grants) L.push(`| ${cell(g.who)} | ${cell(g.what)} | ${cell(g.where)} | ${cell(g.detail)} |`);
  L.push('', '### Where it runs and bills', '', '| What | Where | Details |', '|---|---|---|');
  for (const r of plan.runsOn) L.push(`| ${cell(r.what)} | ${cell(r.where)} | ${cell(r.detail)} |`);
  if (plan.costs?.length) {
    L.push('', '### Costs', '', '| What | Details | Pricing |', '|---|---|---|');
    for (const x of plan.costs) L.push(`| ${cell(x.what)} | ${cell(x.detail)} | ${cell(x.url)} |`);
  }
  return L;
}

function itemMarkdown(it, depth) {
  if (it.hidden) return [];
  const more = (it.more ?? []).map(segsText).join(' ');
  switch (it.t) {
    case 'line': {
      const sym = { ok: '✓ ', warn: '⚠ ', fail: '✗ ' }[it.kind] ?? '';
      const { lead, steps } = moreParts(it.more);
      const joined = (list) => list.map((m) => ` ${segsText(m)}`).join('');
      return [`- ${sym}${segsText(it.segs)}${joined(lead)}`, ...steps.map(([first, ...rest]) => `  ${segsText(first)}${joined(rest)}`)];
    }
    case 'kv':
      return [`- ${it.k}: ${segsText(it.segs)}${more ? ` (${more})` : ''}`];
    case 'subhead':
      return ['', `${'#'.repeat(Math.min(depth + 1, 6))} ${it.title}`, ''];
    case 'qa':
      return [`- ${it.message} **${it.display}**${it.auto ? ' (only option)' : ''}`];
    case 'prompt':
      return [`- ${it.message} _(not answered)_`];
    case 'progress':
      return [`- ${it.label}: ${it.status || 'started'}${it.ms != null ? ` (${fmt(it.ms)})` : ''}`];
    case 'review':
      return ['', ...reviewMarkdown(it.plan), ''];
    case 'loads':
      return it.cards.flatMap((card) => [
        `- ${{ ok: '✓', failed: '✗', skipped: '⚠', running: '…' }[card.state] ?? ''} ${card.name}: ${LOAD_STATE[card.state] ?? card.state}${card.attempts ? ` (${card.attempts} attempts)` : ''}`,
        ...(card.reason ? [`  - ${card.reason}`] : []),
        ...(card.fix ?? []).map((f) => `  - ${f.trim()}`),
      ]);
    case 'next-steps':
      return ['', `**${it.title}**`, '', ...it.steps.flatMap((s, i) => [
        `${i + 1}. **${s.title}** (${s.who}${s.optional ? ', optional' : ''}). ${s.why}`,
        ...(s.link ? [`   - ${s.linkText ?? 'Link'}: ${s.link}`] : []),
        ...(s.steps ?? []).map((x) => `   - ${x}`),
      ]), ''];
    case 'prereqs':
      return it.items.flatMap((p) => [
        `- ${{ met: '✓', missing: '✗', eligible: '◐', unknown: '?' }[p.status] ?? ''} ${p.label}: ${PREREQ_STATE[p.status] ?? p.status}${p.optional ? ' (optional)' : ''}`,
        `  - ${p.detail}`,
        ...(p.rows ?? []).map((r) => `  - ${r.name}: ${r.detail ?? PREREQ_STATE[r.status]}`),
        `  - Needed for: ${p.neededFor}`,
        ...(p.status !== 'met' ? [`  - How to get it: ${p.howTo}`] : []),
      ]);
    default:
      return [];
  }
}

function stageMarkdown(s, depth) {
  if (s.status === 'upcoming') return [];
  if (s.status === 'skipped') return ['', `${'#'.repeat(depth)} ${s.title}`, '', '_Skipped._'];
  const L = ['', `${'#'.repeat(depth)} ${s.heading ?? s.title}`, ''];
  for (const it of s.items) L.push(...itemMarkdown(it, depth));
  for (const k of s.kids) L.push(...stageMarkdown(k, depth + 1));
  return L;
}

function stamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(name, lines) {
  const url = URL.createObjectURL(new Blob([`${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`], { type: 'text/markdown;charset=utf-8' }));
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function runFacts(run) {
  const L = [
    `- Command: \`${installerName()} ${run.command}\``,
    `- Started: ${new Date(run.startedAt).toLocaleString()}`,
  ];
  if (run.endedAt) L.push(`- Result: ${blurb(run)}, after ${fmt(run.endedAt - run.startedAt)}`);
  if (run.user?.upn) L.push(`- Signed in as: ${run.user.upn} (tenant ${run.user.tenantId})`);
  if (app.state) L.push(`- Installer: ${app.state.version}`, `- Install record: ${app.state.configFile}`);
  return L;
}

function saveRecord(run) {
  const L = [`# ${headTitle(run)}`, '', ...runFacts(run)];
  if (run.error) L.push('', `**Error:** ${run.error}`);
  for (const s of run.stages.filter(onRoute(run))) L.push(...stageMarkdown(s, 2));
  L.push('', '---', '', '_Written by the AI in One installer. Secrets are masked and sign-in codes left out._');
  download(`aio-${run.command}-${stamp(run.startedAt)}.md`, L);
}

function savePlan(run) {
  if (!run) return;
  const review = run.stages.flatMap((s) => s.items).find((it) => it.t === 'review');
  const answers = run.stages.flatMap((s) => s.items).filter((it) => it.t === 'qa');
  const L = ['# AI in One set-up plan', '', ...runFacts(run), '', '## The plan', ''];
  if (review) L.push(...reviewMarkdown(review.plan));
  L.push('', '## Your answers', '');
  for (const a of answers) L.push(...itemMarkdown(a, 2));
  L.push('', '---', '', '_Nothing had been created when this plan was saved._');
  download(`aio-plan-${stamp(Date.now())}.md`, L);
}

/* ---------- Start ---------- */

function init() {
  try {
    const saved = localStorage.getItem('aio-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch {
    // Storage is optional.
  }
  byId('main').addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  // Crossing the breakpoint swaps the scroller between the page and main, which starts at the top.
  narrow.addEventListener('change', () => {
    if (app.view === 'run' && app.follow && app.run) {
      if (app.openPrompt?.decide) app.revealStage = target(app.run);
      else app.revealEl = app.openPrompt?.el ?? lastEl(app.run);
      schedule();
    }
  });
  // Only a person scrolling stops the follow. Scroll anchoring and layout shifts also fire scroll events.
  const touched = () => {
    app.userAt = Date.now();
  };
  addEventListener('wheel', touched, { passive: true, capture: true });
  addEventListener('touchmove', touched, { passive: true, capture: true });
  addEventListener('pointerdown', (ev) => {
    if (ev.target === scroller()) touched();
  }, { passive: true, capture: true });
  addEventListener('keydown', (ev) => {
    if (['PageUp', 'ArrowUp', 'Home'].includes(ev.key) && !ev.target.closest?.('input, textarea, select, [role="listbox"]')) touched();
  }, { capture: true });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && app.railOpen) {
      app.railOpen = false;
      renderRail();
      byId('rail').querySelector('[data-key="toggle"]')?.focus();
    }
  });
  setInterval(() => {
    const now = Date.now();
    for (const el of document.querySelectorAll('[data-since]')) el.textContent = fmt(now - Number(el.getAttribute('data-since')));
  }, 1000);
  renderRail();
  byId('view').replaceChildren(renderHome());
  refreshState().then(connect);
}

init();
