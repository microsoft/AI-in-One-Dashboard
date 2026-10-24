// @ts-check
/**
 * The scheduled task's script and the task itself. The script is written from a template with
 * the install's settings as one quoted PowerShell hashtable; nothing else in it changes. The task
 * is defined as XML, so every setting it has is visible here and tested.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUN_AT, SEED_WINDOW_DAYS, SP_FOLDER, TASK_NAME, WINDOW_DAYS, runDir, secretPath, wrapperPath } from './names.js';
import { psHashtable, scriptText } from './ps.js';

export const TEMPLATE_FILE = fileURLToPath(new URL('../../assets/pax/Run-AIO-PAX.ps1.template', import.meta.url));
const MARKER = '# {{SETTINGS}}';
/** The installer's version, which the script writes to its log. */
export const INSTALLER_VERSION = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);

/** @param {string} [file] */
export const loadTemplate = (file = TEMPLATE_FILE) => readFileSync(file, 'utf8');

/**
 * The script, with the settings in place of the marker line. The settings are written as
 * literals by psHashtable, so a value can't become code.
 * @param {string} template
 * @param {Record<string, unknown>} settings
 */
export function renderWrapper(template, settings) {
  const lines = template.replace(/^\uFEFF/, '').split(/\r?\n/);
  const at = lines.flatMap((line, i) => (line.trim() === MARKER ? [i] : []));
  if (at.length !== 1) throw new Error(`The script template must have one "${MARKER}" line; it has ${at.length}.`);
  const body = lines.map((line, i) => (i === at[0] ? `$Settings = ${psHashtable(settings)}` : line));
  return scriptText(body.join('\n'));
}

/** @param {string | undefined} value @param {string} what */
function need(value, what) {
  if (!value) throw new Error(`The install record has no ${what} yet, so the task's script can't be written.`);
  return value;
}

/**
 * The settings the script reads, from the install record.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ env?: NodeJS.ProcessEnv, version?: string }} [o]  version: the installer's.
 */
export function wrapperSettings(config, { env = process.env, version = INSTALLER_VERSION } = {}) {
  const pax = config.pax;
  if (!pax) throw new Error('The install record has no PAX setup.');
  const sp = pax.destination === 'sharepoint';
  const site = sp ? pax.site : undefined;
  if (sp && !site) throw new Error('The install record has no SharePoint site yet.');
  const cert = pax.credentialType === 'certificate';
  return {
    TenantId: need(config.tenantId, 'tenant'),
    ClientId: need(config.app.appId, 'app registration'),
    CredentialType: pax.credentialType,
    CertificateThumbprint: cert ? need(pax.certificateThumbprint, 'certificate') : '',
    SecretFile: secretPath(env),
    SecretExpires: cert ? '' : pax.secretExpires ?? '',
    PaxScript: need(pax.script, 'PAX download'),
    PaxSha256: need(pax.sha256, 'PAX hash').toUpperCase(),
    PaxVersion: need(pax.version, 'PAX version'),
    PythonDir: pax.pythonDir ?? '',
    InstallerVersion: version,
    StateDir: runDir(env),
    Destination: sp ? 'sharepoint' : 'local',
    SiteHost: site ? need(site.host, 'site host') : '',
    SitePath: site?.path ?? '',
    Library: site ? need(site.library, 'library') : '',
    DriveId: site?.driveId ?? '',
    Folder: site ? site.folder || SP_FOLDER : '',
    LocalFolder: sp ? '' : need(pax.localFolder, 'local folder'),
    SeedDays: config.history.days,
    WindowDays: pax.windowDays ?? WINDOW_DAYS,
    SeedWindowDays: SEED_WINDOW_DAYS,
    Agent365: !!pax.agent365,
  };
}

/**
 * Writes the script where the task runs it.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ env?: NodeJS.ProcessEnv, version?: string, template?: string }} [o]
 * @returns {string} its path
 */
export function writeWrapper(config, o = {}) {
  const file = wrapperPath(o.env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderWrapper(o.template ?? loadTemplate(), wrapperSettings(config, o)), 'utf8');
  return file;
}

/** @param {string} value */
const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** @param {number} n */
const two = (n) => String(n).padStart(2, '0');

/** A local time as Task Scheduler writes it, without a zone, so it follows the PC's clock. @param {Date} d */
const localStamp = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

/**
 * The next time the clock reads `runAt`, today or tomorrow.
 * @param {string} runAt  HH:mm
 * @param {Date} now
 */
export function nextRun(runAt, now) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(runAt);
  if (!m) throw new Error(`"${runAt}" isn't a time. Use HH:mm, such as ${DEFAULT_RUN_AT}.`);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * @typedef {object} TaskSpec
 * @property {string} sid  The user the task runs as.
 * @property {string} pwsh  PowerShell 7's full path.
 * @property {string} [wrapper]  The script. wrapperPath() when absent.
 * @property {string} [workingDir]  runDir() when absent.
 * @property {string} runAt  HH:mm, local time.
 * @property {Date} [now]
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * The task's arguments to pwsh: the script, with -File and no -ExecutionPolicy.
 * @param {string} wrapper
 */
export const taskArguments = (wrapper) => `-NoProfile -NonInteractive -WindowStyle Hidden -File "${wrapper}"`;

/**
 * The task's definition. It runs as the user, only while they're signed in (Windows asks for
 * their password if they later choose to have it run when they're signed out), without raised
 * rights, and catches up after a missed start. It runs the script with -File and no
 * -ExecutionPolicy, so the PC's policy applies.
 * @param {TaskSpec} spec
 */
export function taskXml(spec) {
  const now = spec.now ?? new Date();
  const wrapper = spec.wrapper ?? wrapperPath(spec.env);
  const workingDir = spec.workingDir ?? runDir(spec.env);
  if (!/^S-1-\d+(-\d+)+$/.test(spec.sid)) throw new Error(`"${spec.sid}" isn't a Windows account SID.`);
  for (const [what, path] of /** @type {const} */ ([['pwsh', spec.pwsh], ['script', wrapper], ['folder', workingDir]])) {
    if (!path || /["\0\r\n]/.test(path)) throw new Error(`The task's ${what} path "${path}" can't be used.`);
  }
  const args = taskArguments(wrapper);
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Date>${localStamp(now)}</Date>`,
    '    <Author>AI in One installer</Author>',
    '    <Description>Loads the AI in One data with PAX each day, then puts the files where the report reads them. The AI in One installer manages this task.</Description>',
    `    <URI>${xml(`\\${TASK_NAME}`)}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <CalendarTrigger>',
    `      <StartBoundary>${localStamp(nextRun(spec.runAt, now))}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '      <ScheduleByDay>',
    '        <DaysInterval>1</DaysInterval>',
    '      </ScheduleByDay>',
    '    </CalendarTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xml(spec.sid)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xml(spec.pwsh)}</Command>`,
    `      <Arguments>${xml(args)}</Arguments>`,
    `      <WorkingDirectory>${xml(workingDir)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * The task's definition as UTF-16 with a byte order mark, which is what its declaration says.
 * @param {TaskSpec} spec
 */
export function taskXmlBytes(spec) {
  return Buffer.from(`\uFEFF${taskXml(spec)}`, 'utf16le');
}

/**
 * Writes the task's definition beside its script.
 * @param {TaskSpec} spec
 * @returns {string} its path
 */
export function writeTaskXml(spec) {
  const file = join(spec.workingDir ?? runDir(spec.env), 'task.xml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, taskXmlBytes(spec));
  return file;
}
