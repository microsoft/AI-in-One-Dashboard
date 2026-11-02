// @ts-check
/**
 * What the PAX route needs from this PC: Windows, PowerShell 7, an execution policy that lets the
 * task's script run, Python 3.10 or later for PAX's rollup, and Task Scheduler. The installer
 * checks them, offers to install Python for the user's account when they say yes, then downloads
 * PAX and checks its hash. It never changes the execution policy or works round it.
 */
import { emptyPax } from '../config.js';
import { createRunPwsh } from './ps.js';
import { ensurePax } from './release.js';
import { checkPolicy, installPython, probe } from './scripts.js';

export const PYTHON_URL = 'https://www.python.org/downloads/windows/';
export const PWSH_URL = 'https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows';

/** @typedef {import('./scripts.js').Probe} Probe */
/** @typedef {import('../prereqs.js').Prereq} Prereq */
/** @typedef {{ probe?: Probe, error?: string }} PcCheck */

/**
 * How the installer runs PowerShell 7: the test's fake, or pwsh itself.
 * @param {{ runPwsh?: import('./ps.js').RunPwsh }} ctx
 */
export const runPwshOf = (ctx) => (ctx.runPwsh ??= createRunPwsh());

/**
 * Asks PowerShell 7 about this PC. Never throws: a PC without PowerShell 7 is an answer too.
 * @param {{ runPwsh?: import('./ps.js').RunPwsh }} ctx
 * @returns {Promise<PcCheck>}
 */
export async function checkPc(ctx) {
  try {
    return { probe: await probe(runPwshOf(ctx)) };
  } catch (err) {
    return { error: /** @type {Error} */ (err).message };
  }
}

/** @param {Probe} p */
const fullLanguage = (p) => p.languageMode === 'FullLanguage';
/** @param {string} [version] */
const major = (version) => Number(String(version ?? '').split('.')[0]);

/**
 * This PC's rows in the prerequisites list.
 * @param {PcCheck} pc
 * @param {NodeJS.Platform} [platform]
 * @returns {Prereq[]}
 */
export function pcRows(pc, platform = process.platform) {
  const p = pc.probe;
  const isWindows = p?.isWindows ?? platform === 'win32';
  const unchecked = { status: /** @type {const} */ ('unknown'), detail: `Couldn't check: ${pc.error ?? 'PowerShell limits what it can read on this PC.'}` };
  const known = !!p && fullLanguage(p);
  const policy = p ? checkPolicy(p) : undefined;
  /** @type {Prereq[]} */
  const rows = [
    {
      id: 'windows',
      label: 'A Windows PC or server',
      neededFor: 'The scheduled task that runs PAX each day. Use a PC or server that\'s on most days.',
      howTo: 'Run the installer on Windows, signed in as the account the task should run as.',
      ...(isWindows ? { status: 'met', detail: p?.os ?? 'Windows' } : { status: 'missing', detail: `This is ${p?.os ?? platform}, not Windows.` }),
    },
    {
      id: 'pwsh',
      label: 'PowerShell 7',
      neededFor: 'Running PAX and the scheduled task\'s script.',
      howTo: `Install PowerShell 7: ${PWSH_URL}`,
      ...(p
        ? !p.version || major(p.version) >= 7
          ? { status: 'met', detail: p.version ? `PowerShell ${p.version}` : 'Installed.' }
          : { status: 'missing', detail: `PowerShell ${p.version} is too old.` }
        : /isn't installed/.test(pc.error ?? '')
          ? { status: 'missing', detail: 'PowerShell 7 isn\'t installed.' }
          : unchecked),
    },
    {
      id: 'execution-policy',
      label: 'PowerShell can run local scripts',
      neededFor: 'The scheduled task runs its script under this PC\'s execution policy as it is. The installer never changes the policy or works round it.',
      howTo: policy?.howTo?.join(' ') ?? 'Allow local scripts (RemoteSigned) for your account, or ask IT.',
      ...(policy ? (policy.ok ? { status: 'met', detail: policy.title } : { status: 'missing', detail: `${policy.title}. ${policy.detail ?? ''}`.trim() }) : unchecked),
    },
    {
      id: 'python',
      label: 'Python 3.10 or later',
      neededFor: 'PAX\'s rollup of the audit log.',
      howTo: `${p?.winget ? 'The installer offers to install Python 3.13 for your account with winget. Or install it' : 'Install it'} from ${PYTHON_URL}`,
      ...(p?.python
        ? { status: 'met', detail: `Python ${p.python.version} (${p.python.exe})` }
        : known
          ? { status: 'missing', detail: p?.pythonOlder ? `Only Python ${p.pythonOlder} was found, which is too old.` : 'Not found.' }
          : unchecked),
    },
    {
      id: 'task-scheduler',
      label: 'Task Scheduler',
      neededFor: 'Running PAX each day.',
      howTo: 'Task Scheduler and its PowerShell commands come with Windows. If they\'re missing or blocked, ask IT.',
      ...(p?.scheduledTasks ? { status: 'met', detail: 'Available.' } : known ? { status: 'missing', detail: 'Register-ScheduledTask isn\'t available.' } : unchecked),
    },
    {
      id: 'certificate',
      label: 'A certificate for the scheduled task',
      neededFor: 'The task signs in as the app registration with a certificate the installer makes in your account\'s certificate store.',
      howTo: 'Nothing to do: without it, the task signs in with a client secret, protected for your account on this PC.',
      optional: true,
      ...(p?.certificates ? { status: 'met', detail: 'New-SelfSignedCertificate is available.' } : known ? { status: 'missing', detail: 'New-SelfSignedCertificate isn\'t available.' } : unchecked),
    },
  ];
  return rows;
}

/**
 * Stops the install with what's missing on this PC.
 * @param {import('../ui.js').Ui} ui
 * @param {string} title
 * @param {string[]} lines
 * @returns {never}
 */
function stop(ui, title, lines) {
  ui.fail(title);
  for (const l of lines) ui.info(l);
  throw new Error(`${title}. ${lines.join(' ')}`.trim());
}

/**
 * @typedef {object} PcCtx
 * @property {import('../ui.js').Ui} ui
 * @property {import('../config.js').InstallConfig} config
 * @property {() => void} save
 * @property {import('./ps.js').RunPwsh} [runPwsh]
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * Checks this PC can run the PAX refresh, offers to install Python, then gets PAX and checks its
 * hash. Records what the scheduled task needs. Throws when the PC can't run it.
 * @param {PcCtx} ctx
 * @param {{ fetch?: typeof fetch, release?: import('./release.js').PaxRelease }} [o]
 * @returns {Promise<Probe>}
 */
export async function ensurePaxTools(ctx, o = {}) {
  const { ui, config } = ctx;
  const pax = (config.pax ??= emptyPax());
  const runPwsh = runPwshOf(ctx);
  /** @type {Probe} */
  let p;
  try {
    p = await probe(runPwsh);
  } catch (err) {
    const msg = /** @type {Error} */ (err).message;
    if (/isn't installed/.test(msg)) stop(ui, 'PowerShell 7 isn\'t installed', [`Install it from ${PWSH_URL}, then run the installer again.`]);
    throw err;
  }
  const policy = checkPolicy(p);
  if (fullLanguage(p) && !p.isWindows) stop(ui, 'The PAX route runs on Windows', [`This is ${p.os ?? 'not Windows'}. Run the installer on a Windows PC or server.`]);
  if (!policy.ok) stop(ui, policy.title, [...(policy.detail ? [policy.detail] : []), ...(policy.howTo ?? [])]);
  if (major(p.version) < 7) stop(ui, `PowerShell ${p.version} is too old`, [`Install PowerShell 7 from ${PWSH_URL}, then run the installer again.`]);
  ui.ok(`PowerShell ${p.version}. ${policy.title}`);
  if (!p.scheduledTasks) stop(ui, 'Task Scheduler\'s PowerShell commands aren\'t available', ['They come with Windows. Ask IT whether they\'re blocked on this PC.']);

  if (!p.python) {
    ui.warn(p.pythonOlder ? `Python ${p.pythonOlder} is too old: PAX's rollup needs Python 3.10 or later.` : 'Python 3.10 or later isn\'t installed. PAX needs it to roll the audit log up.');
    if (p.winget && !ui.yes && (await ui.confirm('Install Python 3.13 for your account only, with winget?', true))) {
      const r = await installPython(runPwsh);
      if (r.exitCode !== 0) ui.warn(`winget finished with exit code ${r.exitCode}.`);
      p = await probe(runPwsh);
    }
    if (!p.python) {
      const offer = p.winget && ui.yes ? ' Or run the installer without --yes, and it offers to install Python with winget.' : '';
      stop(ui, 'Python 3.10 or later isn\'t installed', [`Install it for your account from ${PYTHON_URL}, then run the installer again.${offer}`]);
    }
  }
  ui.ok(`Python ${p.python.version}`);
  if (pax.userSid && p.sid && pax.userSid !== p.sid) {
    ui.warn(`The scheduled task ran as ${pax.userName ?? pax.userSid}. It now runs as ${p.user ?? p.sid}, with a new certificate in that account's store.`);
  }
  pax.pythonDir = p.python.dir;
  if (p.pwsh) pax.pwsh = p.pwsh;
  if (p.sid) pax.userSid = p.sid;
  if (p.user) pax.userName = p.user;
  if (p.timeZone) pax.timeZone = p.timeZone;

  const got = await ensurePax({ fetch: o.fetch, release: o.release, env: ctx.env });
  pax.version = got.version;
  pax.script = got.path;
  pax.sha256 = got.sha256;
  ctx.save();
  ui.ok(got.downloaded ? `Downloaded PAX ${got.version}; its SHA-256 matches the pinned release` : `PAX ${got.version} is here, and its SHA-256 matches the pinned release`);
  return p;
}
