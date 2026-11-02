// @ts-check
/**
 * Puts the AI in One app live as a Copilot managed app, from the build the installer carries, and
 * shares it with the viewer group. It runs as the PAX install's last step and as `deploy-app`.
 *
 * A tenant that isn't ready for managed apps isn't a failure: the install finishes at the report, and
 * the summary says which settings a Power Platform admin turns on (next-steps.js reads
 * managedApp.missing). A step it can't take here, such as an older Node.js, is skipped the same way,
 * with what to do in managedApp.skipped.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { managedAppDir } from '../pax/names.js';
import { CLI_PACKAGE_DIR, createCli, installedVersion, MIN_NODE, nodeOk, pinnedVersion } from './cli.js';
import { ADMIN_STEPS, deployAgain, LINKS, notReady } from './errors.js';
import { authStatus, createApp, deleteApp, deployApp, login, playUrl, readAppConfig, shareApp, switchAccount, verifyShare } from './steps.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('./cli.js').RunCli} RunCli */
/** @typedef {import('./errors.js').Problem} Problem */
/** @typedef {import('../config.js').ManagedAppConfig} ManagedAppConfig */

export const APP_NAME = 'AI in One';

/** The tenant settings notReady finds turned off, in words. */
export const NOT_READY_NAMES = /** @type {const} */ ({
  createApps: 'app creation with the managed apps CLI',
  externalArtifacts: 'external artifacts in managed apps',
});

/**
 * What the app's step runs with. Tests pass fakes.
 * @typedef {object} AppDeps
 * @property {RunCli} [run]
 * @property {string} [nodeVersion]  The Node.js that runs the CLI: this one.
 * @property {string} [distDir]  The built app. The sources' appDist by default.
 * @property {string} [cliDir]  The package that pins the CLI.
 * @property {string} [appDir]  The app's folder on this PC: the build and ms.config.json.
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @typedef {object} AppResult
 * @property {boolean} ok  false when a step failed. A tenant that isn't ready, or a step skipped, isn't a failure.
 * @property {'deployed' | 'up-to-date' | 'not-ready' | 'skipped' | 'failed'} state
 * @property {string} [url]
 */

/**
 * Deploys the app when its build changed, or it isn't deployed yet, and shares it with the viewer group.
 * @param {Ctx} ctx
 * @param {AppDeps} [deps]
 * @param {{ force?: boolean, environmentId?: string }} [opts]  force: deploy even when the build hasn't
 *   changed. environmentId: the Power Platform environment for a new app; your developer environment when absent.
 * @returns {Promise<AppResult>}
 */
export async function deployTheApp(ctx, deps = {}, opts = {}) {
  const { ui, config } = ctx;
  const record = (config.managedApp ??= {});
  const appDir = deps.appDir ?? managedAppDir(deps.env);
  const cliDir = deps.cliDir ?? CLI_PACKAGE_DIR;
  const distDir = deps.distDir ?? ctx.sources?.appDist;

  const blocked = whyNot({ distDir, cliDir, nodeVersion: deps.nodeVersion ?? process.version });
  if (blocked && !hasBuild(distDir)) return skip(ctx, blocked);
  const dist = /** @type {string} */ (distDir);

  const hash = buildHash(dist);
  const existing = readAppConfig(appDir);
  if (existing && opts.environmentId && existing.environmentId.toLowerCase() !== opts.environmentId.toLowerCase()) {
    ui.warn(`The app is already in environment ${existing.environmentId}. --environment-id is for a new app only, so it stays there.`);
  }
  const group = config.access?.groupId;
  const changed = !!opts.force || !existing || existing.appId !== record.appId || record.buildHash !== hash;
  const unshared = !!group && !(record.sharedWith ?? []).includes(group);
  if (!changed && !unshared) {
    ui.ok(`The AI in One app is up to date${record.url ? `: ${record.url}` : ''}`);
    settled(record);
    ctx.save();
    return { ok: true, state: 'up-to-date', ...(record.url ? { url: record.url } : {}) };
  }
  // An app with nothing to do needs no CLI, so only now does an older Node.js or CLI stop it.
  if (blocked) return skip(ctx, blocked);

  const run = deps.run ?? createCli({ cliDir }).run;
  const signedIn = await signIn(ctx, run);
  if (!signedIn.ok) return 'skipped' in signedIn ? skip(ctx, signedIn.skipped) : failure(ctx, signedIn.problem, signedIn.result);

  if (existing && existing.appId !== record.appId) {
    // The folder's ms.config.json is the app the CLI deploys to.
    if (record.appId) ui.warn(`This PC's app settings are for app ${existing.appId}, not ${record.appId} as recorded, so ${existing.appId} is deployed.`);
    forgetDeploy(record);
    Object.assign(record, { appId: existing.appId, environmentId: existing.environmentId });
    ctx.save();
  }
  if (!existing) {
    if (record.appId) {
      ui.warn(`This PC doesn't have the settings for the app deployed before (${record.appId}), so a new app is made. Delete the old one at ${LINKS.portal}.`);
    }
    mkdirSync(appDir, { recursive: true });
    copyBuild(dist, join(appDir, 'dist'));
    const made = await again(ctx, run, () => createApp(run, { appDir, displayName: APP_NAME, environmentId: opts.environmentId ?? record.environmentId }));
    if (!made.ok) return failure(ctx, made.problem, made.result);
    forgetDeploy(record);
    Object.assign(record, { appId: made.appId, environmentId: made.environmentId });
    ctx.save();
    ui.ok(`Made the app ${APP_NAME} in environment ${made.environmentId}`);
  }

  const first = !record.deployedAt;
  if (changed || first) {
    copyBuild(dist, join(appDir, 'dist'));
    ui.info('Deploying the AI in One app. It takes a few minutes.');
    const deployed = await again(ctx, run, () => deployApp(run, { appDir }));
    if (!deployed.ok) return failure(ctx, deployed.problem, deployed.result);
    for (const w of deployed.warnings) ui.warn(w);
    let url = deployed.playUrl;
    if (!url) {
      const link = await playUrl(run, { appDir });
      if (link.ok) url = link.url;
    }
    Object.assign(record, { buildHash: hash, deployedAt: ctx.now().toISOString(), ...(url ? { url } : {}) });
    ctx.save();
    ui.ok(`The AI in One app is live${record.url ? `: ${record.url}` : ''}`);
  }

  const ok = group ? await shareWith(ctx, run, appDir, group) : true;
  if (ok) settled(record);
  ctx.save();

  if (first) {
    ui.note(`Each person who opens it needs Power Apps Premium or Copilot Credits: ${ADMIN_STEPS.licences.link}`);
    const folder = config.pax?.destination === 'local' ? config.pax.localFolder : undefined;
    ui.note(
      folder
        ? `In the app, choose Change data and pick the CSV files from ${folder}.`
        : 'In the app, viewers choose Change data and pick the CSV files from the AI in One folder in SharePoint, so they need read access to it.',
    );
  }
  return { ok, state: ok ? 'deployed' : 'failed', ...(record.url ? { url: record.url } : {}) };
}

/**
 * Deletes the app, then its folder on this PC and its part of the record. When the app can't be
 * deleted from here, the record keeps it and this says where to delete it.
 * @param {Ctx} ctx
 * @param {AppDeps} [deps]
 * @returns {Promise<{ ok: boolean, removed: boolean }>}
 */
export async function removeTheApp(ctx, deps = {}) {
  const { ui, config } = ctx;
  const record = config.managedApp;
  const appDir = deps.appDir ?? managedAppDir(deps.env);
  const cliDir = deps.cliDir ?? CLI_PACKAGE_DIR;
  const forget = () => {
    rmSync(appDir, { recursive: true, force: true });
    delete config.managedApp;
    ctx.save();
  };
  // An interrupted "ms app init" has made the app, but only the folder's ms.config.json names it.
  const made = record?.appId ? { appId: record.appId, environmentId: record.environmentId } : readAppConfig(appDir);
  if (!made?.appId) {
    forget();
    return { ok: true, removed: false };
  }
  const leave = (/** @type {string} */ why) => {
    ui.warn(`The AI in One app (${made.appId}) is still there: ${why} Delete it at ${LINKS.portal}.`);
    return { ok: false, removed: false };
  };
  const blocked = whyNot({ distDir: undefined, cliDir, nodeVersion: deps.nodeVersion ?? process.version, needBuild: false });
  if (blocked) return leave(blocked.why);

  const run = deps.run ?? createCli({ cliDir }).run;
  const signedIn = await signIn(ctx, run);
  if (!signedIn.ok) return leave('skipped' in signedIn ? signedIn.skipped.why : signedIn.problem.what);
  const gone = await deleteApp(run, { appId: made.appId, environmentId: made.environmentId, cwd: existsSync(appDir) ? appDir : undefined });
  if (!gone.ok) return leave(gone.problem.message ?? gone.problem.what);
  ui.ok(gone.existed ? `Deleted the AI in One app` : 'The AI in One app was already gone');
  forget();
  return { ok: true, removed: gone.existed };
}

/**
 * Why the app can't be deployed from here, and what to do; undefined when it can.
 * @param {{ distDir: string | undefined, cliDir: string, nodeVersion: string, needBuild?: boolean }} o
 * @returns {{ why: string, steps: string[] } | undefined}
 */
export function whyNot({ distDir, cliDir, nodeVersion, needBuild = true }) {
  const then = `Then run: ${deployAgain()}`;
  if (needBuild && !hasBuild(distDir)) {
    return {
      why: 'This copy of the installer has no build of the app.',
      steps: ['Use AIInOneInstaller.exe, which carries it. Or build it from a clone: in app, run npm ci, then npm run build.', then],
    };
  }
  if (!nodeOk(nodeVersion)) {
    return {
      why: `The managed apps CLI needs Node.js ${MIN_NODE} or later, and this is ${nodeVersion.replace(/^v/, '')}.`,
      steps: [`Use AIInOneInstaller.exe, which carries a new enough Node.js, or install it from ${LINKS.node}.`, then],
    };
  }
  const pinned = pinnedVersion(cliDir);
  const installed = installedVersion(cliDir);
  if (installed !== pinned) {
    return {
      why: installed ? `The managed apps CLI here is ${installed}, and the installer needs ${pinned}.` : 'The managed apps CLI isn\'t installed here.',
      steps: ['Use AIInOneInstaller.exe, which carries it. Or install it in a clone: npm ci --ignore-scripts --omit=dev --prefix installer/managed-cli', then],
    };
  }
  return undefined;
}

/**
 * Whether the folder holds a build of the app.
 * @param {string | undefined} distDir
 * @returns {distDir is string}
 */
function hasBuild(distDir) {
  return !!distDir && existsSync(join(distDir, 'index.html'));
}

/**
 * A hash of the built app: each file's path and contents, in path order.
 * @param {string} dir
 */
export function buildHash(dir) {
  const hash = createHash('sha256');
  for (const rel of filesIn(dir)) {
    hash.update(rel.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** @param {string} dir @returns {string[]} */
function filesIn(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .map((rel) => rel.replaceAll('\\', '/'))
    .sort();
}

/**
 * Replaces the app folder's build with this one.
 * @param {string} from
 * @param {string} to
 */
function copyBuild(from, to) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

/**
 * What the record says about the last deploy, for an app that's new to it.
 * @param {ManagedAppConfig} record
 */
function forgetDeploy(record) {
  delete record.url;
  delete record.buildHash;
  delete record.deployedAt;
  delete record.sharedWith;
}

/** @param {ManagedAppConfig} record */
function settled(record) {
  delete record.missing;
  delete record.skipped;
}

/**
 * @param {Ctx} ctx
 * @param {{ why: string, steps: string[] }} reason
 * @returns {AppResult}
 */
function skip(ctx, reason) {
  const record = (ctx.config.managedApp ??= {});
  delete record.missing;
  record.skipped = reason;
  ctx.save();
  ctx.ui.warn(`Skipped the AI in One app: ${reason.why}`);
  for (const s of reason.steps) ctx.ui.info(s);
  return { ok: true, state: 'skipped', ...(record.url ? { url: record.url } : {}) };
}

/**
 * A failed step. When it's because the tenant isn't ready for managed apps, the install still finishes:
 * the summary says what a Power Platform admin turns on.
 * @param {Ctx} ctx
 * @param {Problem} problem
 * @param {import('./cli.js').CliResult} [result]
 * @returns {AppResult}
 */
function failure(ctx, problem, result) {
  const { ui } = ctx;
  const record = (ctx.config.managedApp ??= {});
  const off = result ? notReady(result) : [];
  if (off.length) {
    delete record.skipped;
    record.missing = off;
    ctx.save();
    ui.warn(`The AI in One app can't be deployed until a Power Platform admin turns on ${off.map((k) => NOT_READY_NAMES[k]).join(' and ')}. The report works without it.`);
    ui.info(`The summary has a message to send them. Then run: ${deployAgain()}`);
    return { ok: true, state: 'not-ready', ...(record.url ? { url: record.url } : {}) };
  }
  delete record.missing;
  const again = deployAgain();
  const steps = [problem.who === 'you' ? problem.what : `Ask your ${problem.who}: ${problem.what}`];
  if (problem.link) steps.push(`More: ${problem.link}`);
  if (!problem.what.includes(again)) steps.push(`Then run: ${again}`);
  const said = (problem.message ?? '').split(/\r?\n/)[0].slice(0, 300);
  record.skipped = { why: `The last attempt to deploy it failed${said ? `: ${said}` : '.'}`, steps };
  ctx.save();
  ui.fail(`The AI in One app: ${problem.message ?? problem.what}`);
  if (problem.details) ui.note(problem.details);
  if (problem.message) ui.info(problem.what);
  if (problem.who !== 'you') ui.info(`Who fixes it: your ${problem.who}.`);
  if (problem.link) ui.note(problem.link);
  return { ok: false, state: 'failed', ...(record.url ? { url: record.url } : {}) };
}

/** @param {string | undefined} a @param {string | undefined} b */
const sameAccount = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Signs the CLI in as the person running the installer: the account it's on, one it already has, or a
 * browser sign-in. With --yes it never opens a browser.
 * @param {Ctx} ctx
 * @param {RunCli} run
 * @returns {Promise<{ ok: true, account?: string } | { ok: false, skipped: { why: string, steps: string[] } } | { ok: false, problem: Problem, result?: import('./cli.js').CliResult }>}
 */
async function signIn(ctx, run) {
  const { ui } = ctx;
  const want = ctx.user?.upn;
  const status = await authStatus(run);
  if (!status.ok) return status;
  if (status.signedIn && (!want || sameAccount(status.account, want))) return { ok: true, account: status.account };
  const known = want ? status.accounts.find((a) => sameAccount(a, want)) : undefined;
  if (known) {
    const switched = await switchAccount(run, known);
    const now = switched.ok ? await authStatus(run) : switched;
    if (now.ok && now.signedIn && sameAccount(now.account, want)) return { ok: true, account: now.account };
  }
  if (ui.yes) {
    return {
      ok: false,
      skipped: {
        why: `The managed apps CLI isn't signed in${want ? ` as ${want}` : ''}, and --yes doesn't open a browser.`,
        steps: [`Run ${deployAgain()} without --yes, and sign in when it asks.`],
      },
    };
  }
  ui.info(`Sign in to the managed apps CLI${want ? ` as ${want}` : ''}. A browser opens.`);
  const signed = await login(run, { account: want });
  if (!signed.ok) return signed;
  const after = await authStatus(run);
  if (!after.ok) return after;
  if (after.signedIn && (!want || sameAccount(after.account, want))) return { ok: true, account: after.account };
  if (after.signedIn && (await ui.confirm(`The CLI signed in as ${after.account}, not ${want}. Deploy the app as ${after.account}?`, false))) {
    return { ok: true, account: after.account };
  }
  return {
    ok: false,
    skipped: {
      why: after.signedIn ? `The managed apps CLI signed in as ${after.account}, not ${want}.` : 'The managed apps CLI didn\'t sign in.',
      steps: [`Run ${deployAgain()}, and sign in${want ? ` as ${want}` : ''} when it asks.`],
    },
  };
}

/**
 * Runs a step, and when the CLI's sign-in expired on the way, signs in again and runs it once more.
 * @template {{ ok: true } | { ok: false, problem: Problem, result?: import('./cli.js').CliResult }} R
 * @param {Ctx} ctx
 * @param {RunCli} run
 * @param {() => Promise<R>} step
 * @returns {Promise<R>}
 */
async function again(ctx, run, step) {
  const first = await step();
  if (first.ok || first.result?.exitCode !== 3 || ctx.ui.yes) return first;
  ctx.ui.info('The managed apps CLI\'s sign-in expired. Sign in again; a browser opens.');
  const signed = await login(run, { account: ctx.user?.upn });
  return signed.ok ? step() : first;
}

/**
 * Lets the viewer group open the app, and checks it took.
 * @param {Ctx} ctx
 * @param {RunCli} run
 * @param {string} appDir
 * @param {string} group
 * @returns {Promise<boolean>}
 */
async function shareWith(ctx, run, appDir, group) {
  const { ui, config } = ctx;
  const record = /** @type {ManagedAppConfig} */ (config.managedApp);
  const name = config.access?.groupName ?? 'the viewer group';
  const shared = await again(ctx, run, () => shareApp(run, { appDir, principals: [group] }));
  if (!shared.ok) {
    const { problem } = shared;
    const rerun = deployAgain();
    ui.warn(`Couldn't share the app with ${name}: ${problem.message ?? problem.what}`);
    ui.info(problem.what);
    delete record.missing;
    record.skipped = {
      why: `The app is live, but it isn't shared with ${name}, so nobody else can open it.`,
      steps: [problem.who === 'you' ? problem.what : `Ask your ${problem.who}: ${problem.what}`, ...(problem.what.includes(rerun) ? [] : [`Then run: ${rerun}`])],
    };
    return false;
  }
  for (const w of shared.warnings) ui.warn(w);
  const checked = await verifyShare(run, { appDir, ids: [group] });
  if (!checked.ok || checked.missing.length) {
    // The share went through, and the list can lag behind it. It isn't recorded, so the next update shares it again.
    ui.warn(`Shared the app with ${name}, but couldn't see it in the app's sharing yet. It can take a few minutes. Check it at ${LINKS.portal}.`);
    return true;
  }
  record.sharedWith = [group];
  ui.ok(`Shared the app with ${name}`);
  return true;
}
