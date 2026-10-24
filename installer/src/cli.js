// @ts-check
/** Command-line entry point. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AZ_LOGIN } from './auth.js';
import { archiveConfig, DEFAULT_CONFIG_FILE, loadConfig, TARGETS, targetOf } from './config.js';
import { HttpError } from './http.js';
import { APP_NEEDS_PAX, connect, createCtx, preview, runCommand } from './install.js';
import { adoptUploadedRecord, cloudShellKeepsFiles, cloudShellRecordMessage, commandLine, inCloudShell } from './launch.js';
import { chooseTarget, PAX_NEEDS_WINDOWS } from './pax/plan.js';
import { runWizard } from './server.js';
import { loadSources } from './sources.js';
import { recordWorkspaceGone, staleRecordMessage } from './steps/fabric.js';
import { isResumeLater, MAX_SECRET_DAYS, NOTEBOOK_SECRET_DAYS } from './steps/identity.js';
import { c, createUi } from './ui.js';

const COMMANDS = ['install', 'update', 'run', 'rerun-failed', 'check', 'refresh', 'status', 'rotate-secret', 'access', 'deploy-app', 'uninstall', 'prereqs', 'preview'];

/**
 * Why a command or option doesn't go with a route, if it doesn't.
 * @param {import('./config.js').Target} target
 * @param {{ command: string, environmentId?: string, fabricOnly?: string }} args  fabricOnly: the Fabric-only option given.
 * @returns {string | undefined}
 */
export function routeMismatch(target, args) {
  if (target === 'pax') {
    if (args.fabricOnly) return `${args.fabricOnly} is for the Fabric route. This install uses PAX.`;
    if (args.command === 'rerun-failed') return `rerun-failed is for the Fabric route. To run PAX again now, run: ${commandLine('run')}`;
    return undefined;
  }
  if (args.command === 'deploy-app') return APP_NEEDS_PAX;
  if (args.environmentId) return `--environment-id is for the AI in One app. ${APP_NEEDS_PAX}`;
  return undefined;
}

/**
 * The install record is for the other route.
 * @param {string} file
 * @param {import('./config.js').Target} target  The record's route.
 */
export const otherRoute = (file, target) =>
  `${file} is the install record for AI in One ${target === 'pax' ? 'with PAX' : 'on Fabric'}. Leave out --target to use it, or add --config with a new file name to set up the other route as well.`;

/** The `--help` text, naming the command the way it was started. */
export const help = () => `Sets up AI in One, the reports on how your organisation uses Copilot. It gets the data one
of two ways:
  fabric  Notebooks and a pipeline in a Fabric workspace load the Copilot usage data each day,
          for the semantic model and the report
  pax     A scheduled task on this Windows PC runs PAX each day and puts its files in a
          SharePoint folder, for the report and the AI in One app

Usage: ${commandLine('[command] [options]')}
       ${commandLine('--ui [options]')}

Commands:
  install          Set up AI in One, or repair it from the install record (default)
  update           Push what this copy of the installer has: on Fabric, the notebooks, pipeline,
                   semantic model and report; with PAX, PAX itself, the task's script, the report
                   and the app
  run              Fabric: run the pipeline now, then the data check. PAX: run the task now
  rerun-failed     Fabric: run again only the loads that failed in the latest pipeline run
  check            Fabric: run the data check again, without the pipeline. PAX: check the files
                   arrived and the model refreshed
  refresh          Refresh the semantic model now
  status           Show recent runs and refreshes, the last data check and when secrets expire
  rotate-secret    Fabric: create new client secrets for the notebooks (or Key Vault) and the
                   model's connection. PAX: a new certificate (or client secret) for the task
  access           Who can view: the viewer group, its members and owners, and its Build on the
                   model
  deploy-app       PAX: deploy the AI in One app again from this copy of the installer
  uninstall        Delete what the installer created: on Fabric, the workspace (or, in a workspace
                   you had, just its AI in One items) and the model's connection; with PAX, the
                   task, its certificate, the site access, the report, the app and the files on
                   this PC. Asks before deleting the app registration the installer created
  prereqs          Check the roles, licences, capacities and tenant settings you have and lack.
                   Read-only; works before anything is installed
  preview          Write what would be deployed to a folder, without signing in

Options:
  --ui                 Run the installer in your browser instead of the terminal, and choose
                       the command there. Only this computer can reach the page.
  --no-open            With --ui: print the link instead of opening the browser
  --config <file>      Install record (default ./${DEFAULT_CONFIG_FILE})
  --source <dir>       The repo folder to deploy from (default: this checkout)
  --tenant <id>        Tenant ID or domain to sign in to
  --target <target>    Where AI in One gets its data: fabric (the default) or pax. A new install
                       asks when you leave it out, except with --yes
  --environment-id <id>
                       With install, update, deploy-app or access, on PAX: the Power Platform
                       environment for a new AI in One app (default: your developer environment)
  --device-code        Sign in with a code on another device instead of a browser. The default
                       in Azure Cloud Shell
  --use-az             Use the account you are signed in to with the Azure CLI. In Azure Cloud
                       Shell, run ${AZ_LOGIN} first
  --backfill-days <n>  With run: reload n days of audit history, 1 to 180. On Fabric this replaces
                       the audit rows from the first of those days on and keeps older rows; with
                       PAX it rebuilds the files with just those days
  --out <dir>          With preview: where to write (default ./aio-preview)
  --dry-run            Same as the preview command
  --no-key-vault       Fabric, with install: no Key Vault, the default for a new install. The client
                       secret goes in the notebooks, where anyone with a role in the workspace can
                       read it
  --secret-in-notebook Same as --no-key-vault
  --key-vault          Fabric, with install: keep the client secret in Azure Key Vault instead, so
                       workspace roles don't expose it. Needed with --yes to choose Key Vault for a
                       new install
  --secret-days <n>    Fabric, with install or rotate-secret, and no Key Vault: how many days the
                       secret in the notebooks lasts, 1 to ${MAX_SECRET_DAYS} (default ${NOTEBOOK_SECRET_DAYS}). Each install, repair or
                       update replaces it
  --yes                Take saved answers and defaults without asking. It never lets Fabric clear a
                       model's data: add --allow-model-reset for that
  --allow-model-reset  With install, update or access: when Fabric can't update the model and keep
                       its data, clear the data and reload it without asking. The report shows no
                       data until the reload finishes
  --no-wait            Don't wait for the first load or a refresh to finish
  --verbose            Print each API call
  -h, --help           Show this help
  -v, --version        Show the version
`;

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseCli(argv, env = process.env) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      source: { type: 'string' },
      tenant: { type: 'string' },
      target: { type: 'string' },
      'environment-id': { type: 'string' },
      'device-code': { type: 'boolean' },
      'use-az': { type: 'boolean' },
      'backfill-days': { type: 'string' },
      out: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'no-wait': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      ui: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      verbose: { type: 'boolean' },
      'secret-in-notebook': { type: 'boolean' },
      'no-key-vault': { type: 'boolean' },
      'key-vault': { type: 'boolean' },
      'secret-days': { type: 'string' },
      'allow-model-reset': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const command = values['dry-run'] ? 'preview' : positionals[0] ?? 'install';
  if (positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command "${command}". Try --help.`);
  if (values.target !== undefined && !TARGETS.includes(/** @type {any} */ (values.target))) throw new Error(`--target must be ${TARGETS.join(' or ')}.`);
  const noVaultFlag = values['no-key-vault'] ? '--no-key-vault' : values['secret-in-notebook'] ? '--secret-in-notebook' : undefined;
  if (noVaultFlag && command !== 'install') throw new Error(`${noVaultFlag} goes with install.`);
  if (values['key-vault'] && command !== 'install') throw new Error('--key-vault goes with install.');
  if (values['key-vault'] && noVaultFlag) throw new Error(`--key-vault can't go with ${noVaultFlag}.`);
  /** @type {number | undefined} */
  let secretDays;
  if (values['secret-days'] !== undefined) {
    if (command !== 'install' && command !== 'rotate-secret') throw new Error('--secret-days goes with install or rotate-secret.');
    secretDays = Number(values['secret-days']);
    if (!Number.isInteger(secretDays) || secretDays < 1 || secretDays > MAX_SECRET_DAYS) throw new Error(`--secret-days must be a whole number from 1 to ${MAX_SECRET_DAYS}.`);
  }
  const fabricOnly = values['key-vault'] ? '--key-vault' : noVaultFlag ?? (secretDays !== undefined ? '--secret-days' : undefined);
  const environmentId = values['environment-id']?.trim();
  if (values['environment-id'] !== undefined) {
    if (!['install', 'update', 'deploy-app', 'access'].includes(command)) throw new Error('--environment-id goes with install, update, deploy-app or access.');
    if (!environmentId || !/^[A-Za-z0-9-]{1,100}$/.test(environmentId)) throw new Error('--environment-id must be an environment ID, such as the GUID in the Power Platform admin center.');
  }
  const mismatch = values.target && routeMismatch(/** @type {import('./config.js').Target} */ (values.target), { command, environmentId, fabricOnly });
  if (mismatch) throw new Error(mismatch);
  if (values['device-code'] && values['use-az']) throw new Error('Choose one of --device-code and --use-az.');
  const cloudShell = inCloudShell(env);
  if (values.ui && cloudShell) throw new Error('Azure Cloud Shell can\'t open the installer\'s page in your browser. Leave out --ui to answer in the terminal.');
  if (values.ui && (positionals.length || values['dry-run'])) throw new Error('--ui opens a home page where you choose what to do. Leave out the command.');
  if (values.ui && values.yes) throw new Error('Choose one of --ui and --yes.');
  if (values['allow-model-reset'] && !['install', 'update', 'access'].includes(command)) throw new Error('--allow-model-reset goes with install, update or access.');
  if (values.ui && values['allow-model-reset']) throw new Error('With --ui, the page asks before a model\'s data is cleared. Leave out --allow-model-reset.');
  /** @type {number | undefined} */
  let backfillDays;
  if (values['backfill-days'] !== undefined) {
    backfillDays = Number(values['backfill-days']);
    if (!Number.isInteger(backfillDays) || backfillDays < 1 || backfillDays > 180) throw new Error('--backfill-days must be a whole number from 1 to 180.');
  }
  return {
    command,
    configFile: resolve(values.config ?? DEFAULT_CONFIG_FILE),
    sourceDir: values.source,
    tenantId: values.tenant,
    target: /** @type {import('./config.js').Target | undefined} */ (values.target),
    environmentId,
    // Cloud Shell has no browser to sign in with.
    method: /** @type {'browser' | 'device-code' | 'azure-cli'} */ (values['use-az'] ? 'azure-cli' : values['device-code'] || cloudShell ? 'device-code' : 'browser'),
    cloudShell,
    backfillDays,
    outDir: values.out ?? 'aio-preview',
    yes: !!values.yes,
    wait: !values['no-wait'],
    ui: !!values.ui,
    open: !values['no-open'],
    verbose: !!values.verbose,
    secretInNotebook: !!noVaultFlag,
    useKeyVault: !!values['key-vault'],
    secretDays,
    fabricOnly,
    allowModelReset: !!values['allow-model-reset'],
    help: !!values.help,
    version: !!values.version,
  };
}

export function version() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return String(pkg.version);
}

/**
 * When the install record's workspace is gone, offers to set the record aside and start fresh.
 * Only install can start fresh; other commands stop and say so.
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, file: string, fabric: { getWorkspace: (id: string) => Promise<any> }, tenantId?: string, command: string }} o
 * @returns {Promise<boolean>} whether the record was set aside
 */
export async function startFresh(o) {
  const gone = await recordWorkspaceGone({ config: o.config, fabric: o.fabric, tenantId: o.tenantId });
  if (!gone) return false;
  const why = staleRecordMessage(gone);
  if (o.command !== 'install') throw new Error(`${why} To start fresh, run install.`);
  if (o.ui.yes) throw new Error(`${why} To start fresh, run install without --yes.`);
  o.ui.warn(why);
  if (!(await o.ui.confirm('Start fresh? The old install record is kept beside the new one, renamed with the date and time.', true))) return false;
  o.ui.ok(`The old install record is now ${archiveConfig(o.file)}`);
  return true;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv) {
  let verbose = false;
  try {
    const args = parseCli(argv);
    verbose = args.verbose;
    if (args.help) {
      process.stdout.write(help());
      return 0;
    }
    if (args.version) {
      process.stdout.write(`${version()}\n`);
      return 0;
    }
    const debug = verbose ? (/** @type {string} */ m) => process.stderr.write(`${c.dim(m)}\n`) : undefined;
    if (args.ui) {
      await runWizard({ configFile: args.configFile, sourceDir: args.sourceDir, tenantId: args.tenantId, method: args.method, open: args.open, version: version(), debug });
      return 0;
    }
    const ui = createUi({ yes: args.yes });
    const uploaded = args.cloudShell && args.command !== 'prereqs' ? adoptUploadedRecord(args.configFile) : undefined;
    const loaded = loadConfig(args.configFile);
    let config = loaded.config;
    const existed = loaded.existed;
    if (existed && args.target && targetOf(config) !== args.target) throw new Error(otherRoute(args.configFile, targetOf(config)));
    if (args.target) config.target = args.target;
    const sources = loadSources(args.sourceDir);

    ui.line(c.bold(`AI in One installer ${version()}`));
    if (args.command === 'preview') {
      preview({ ui, config, sources, outDir: args.outDir });
      return 0;
    }
    if (args.command !== 'install' && args.command !== 'prereqs' && !existed) throw new Error(`No install record at ${args.configFile}. Run the installer first, or pass --config.`);
    if (!existed && !args.target && args.command === 'install') config.target = await chooseTarget(ui);
    const pax = targetOf(config) === 'pax';
    const mismatch = routeMismatch(targetOf(config), args);
    if (mismatch) throw new Error(mismatch);
    if (pax && args.command === 'install' && process.platform !== 'win32') throw new Error(PAX_NEEDS_WINDOWS);
    if (uploaded) ui.note(`Moved the install record you uploaded from ${uploaded}.`);
    if (existed) ui.note(`Install record: ${args.configFile}`);
    if (args.cloudShell && args.command !== 'prereqs') {
      ui.note('Azure Cloud Shell signs you out after 20 minutes without input. If that stops the installer, run the same command again: it carries on from the install record. --no-wait saves waiting for the first load.');
    }

    ui.note(args.method === 'azure-cli' ? 'Using your Azure CLI sign-in…' : 'Signing in…');
    const { api, user, getToken } = await connect({
      tenantId: args.tenantId ?? config.tenantId,
      method: args.method,
      ui,
      debug,
      checkTokens: args.cloudShell && args.method === 'azure-cli',
    });
    // A Fabric record whose workspace is gone can start fresh. With PAX, the workspace only holds the report.
    if (existed && !pax && args.command !== 'prereqs' && (await startFresh({ ui, config, file: args.configFile, fabric: api.fabric, tenantId: user.tenantId, command: args.command }))) {
      config = loadConfig(args.configFile).config;
      if (args.target) config.target = args.target;
    }
    const ctx = createCtx({ ui, config, file: args.configFile, api, user, sources, getToken, method: args.method });
    if (args.environmentId) ctx.environmentId = args.environmentId;
    if (args.secretInNotebook) ctx.secretInNotebook = true;
    if (args.useKeyVault) ctx.useKeyVault = true;
    if (args.allowModelReset) ctx.allowModelReset = true;
    if (args.secretDays) config.app.secretDays = args.secretDays;
    try {
      const ok = await runCommand(ctx, args.command, { wait: args.wait, backfillDays: args.backfillDays });
      return ok ? 0 : 1;
    } finally {
      // Also after a failure part way: the record is what lets the next run carry on.
      if (args.cloudShell && !cloudShellKeepsFiles() && existsSync(args.configFile)) ui.warn(cloudShellRecordMessage(args.configFile));
    }
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.name === 'ExitPromptError') {
      process.stderr.write('\nCancelled.\n');
      return 130;
    }
    if (isResumeLater(e)) {
      process.stderr.write(`\n${c.yellow('!')} ${e.message}\n`);
      return 0;
    }
    if (/device_code_expired|expired_token|code_expired/i.test(String(e?.message ?? e?.errorCode ?? ''))) {
      process.stderr.write(`\n${c.red('✗')} The sign-in code expired before it was used. Run the installer again and enter the new code within 15 minutes.\n`);
      return 1;
    }
    process.stderr.write(`\n${c.red('✗')} ${e?.message ?? String(err)}\n`);
    if (verbose && err instanceof HttpError && err.body) process.stderr.write(`${c.dim(JSON.stringify(err.body, null, 2))}\n`);
    else if (verbose && e?.stack) process.stderr.write(`${c.dim(e.stack)}\n`);
    return 1;
  }
}
