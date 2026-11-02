// @ts-check
/**
 * The PowerShell the installer runs on this PC for the PAX path: the checks, the scheduled task,
 * the app's certificate and the protected secret. Each script is text built from quoted values,
 * so the tests read exactly what would run, and each prints one AIO-RESULT line.
 */
import { CERT_MONTHS, CERT_SUBJECT, PAX_APP_NAME, TASK_NAME, wrapperPath } from './names.js';
import { firstError, psQuote, RESULT_PREFIX } from './ps.js';

/** @typedef {import('./ps.js').RunPwsh} RunPwsh */

/**
 * PowerShell writes to the installer in the console's code page, so the line escapes anything that
 * isn't ASCII, such as a user's name.
 * @param {string} expr  A PowerShell expression.
 */
const result = (expr) => `${psQuote(RESULT_PREFIX)} + (${expr} | ConvertTo-Json -Compress -Depth 5 -EscapeHandling EscapeNonAscii)`;

const PREAMBLE = ["$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'"];

/** Dates from Windows go back to the installer as UTC ISO text; "never" (before 2000) as null. */
const ISO_TIME = [
  'function ConvertTo-IsoTime($Value) {',
  '    if ($Value -is [datetime]) { if ($Value.Year -lt 2000) { return $null }; return $Value.ToUniversalTime().ToString(\'o\') }',
  '    if ($null -eq $Value) { return $null }',
  '    [string]$Value',
  '}',
];

/**
 * What the PAX path needs from this PC. It runs with -Command, which the execution policy doesn't
 * govern, so it can report the policy that would stop the task's script. It has no double quotes,
 * so nothing on the way can split it.
 */
export const PROBE = [
  ...PREAMBLE,
  '$mode = [string]$ExecutionContext.SessionState.LanguageMode',
  `if ($mode -ne 'FullLanguage') { ${result('@{ languageMode = $mode }')}; exit 0 }`,
  '$policies = [ordered]@{}',
  'foreach ($p in @(Get-ExecutionPolicy -List)) { $policies[[string]$p.Scope] = [string]$p.ExecutionPolicy }',
  '$sid = $null; $user = $null',
  'if ($IsWindows) { $id = [System.Security.Principal.WindowsIdentity]::GetCurrent(); $sid = $id.User.Value; $user = $id.Name }',
  "$pwsh = Join-Path $PSHOME 'pwsh.exe'",
  "if ($PSHOME -like '*\\WindowsApps\\*' -and $env:LOCALAPPDATA) { $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\pwsh.exe'; if (Test-Path -LiteralPath $alias) { $pwsh = $alias } }",
  // The task starts with the PATH a new sign-in gets, so Python is looked for there.
  "if ($IsWindows) { $env:PATH = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join [IO.Path]::PathSeparator }",
  'function Test-Python([string]$Exe, [string[]]$Pre) {',
  "    try { $out = @(& $Exe @Pre -c 'import sys; print(sys.version_info[0], sys.version_info[1], sys.version_info[2]); print(sys.executable)' 2>$null) } catch { return $null }",
  '    if ($LASTEXITCODE -ne 0 -or $out.Count -lt 2) { return $null }',
  "    $v = @(([string]$out[0]).Trim() -split ' ')",
  '    $exe = ([string]$out[1]).Trim()',
  '    if ($v.Count -lt 3 -or -not $exe -or -not (Test-Path -LiteralPath $exe)) { return $null }',
  "    [ordered]@{ version = ($v[0..2] -join '.'); major = [int]$v[0]; minor = [int]$v[1]; exe = $exe; dir = (Split-Path -Parent $exe) }",
  '}',
  '$candidates = [System.Collections.Generic.List[object]]::new()',
  "$cmd = Get-Command -Name python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
  'if ($cmd) { $candidates.Add(@{ Exe = $cmd.Source; Pre = @() }) }',
  "$cmd = Get-Command -Name py -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
  "if ($cmd) { foreach ($want in @('-3.13', '-3.12', '-3.11', '-3.10')) { $candidates.Add(@{ Exe = $cmd.Source; Pre = @($want) }) } }",
  "$cmd = Get-Command -Name python3 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
  'if ($cmd) { $candidates.Add(@{ Exe = $cmd.Source; Pre = @() }) }',
  "$roots = @(); if ($env:LOCALAPPDATA) { $roots += Join-Path $env:LOCALAPPDATA 'Programs\\Python' }; if ($env:ProgramFiles) { $roots += $env:ProgramFiles }",
  "foreach ($root in $roots) { if (Test-Path -LiteralPath $root) { foreach ($d in @(Get-ChildItem -LiteralPath $root -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) { $exe = Join-Path $d.FullName 'python.exe'; if (Test-Path -LiteralPath $exe) { $candidates.Add(@{ Exe = $exe; Pre = @() }) } } } }",
  '$python = $null; $older = $null',
  'foreach ($c in $candidates) {',
  '    $info = Test-Python $c.Exe $c.Pre',
  '    if (-not $info) { continue }',
  '    if ($info.major -gt 3 -or ($info.major -eq 3 -and $info.minor -ge 10)) { $python = $info; break }',
  '    if (-not $older) { $older = $info.version }',
  '}',
  `${result(`[ordered]@{
    version = $PSVersionTable.PSVersion.ToString()
    edition = [string]$PSVersionTable.PSEdition
    languageMode = $mode
    executionPolicy = [string](Get-ExecutionPolicy)
    policies = $policies
    isWindows = [bool]$IsWindows
    os = [Environment]::OSVersion.VersionString
    sid = $sid
    user = $user
    timeZone = (Get-TimeZone).Id
    pwsh = $pwsh
    python = $python
    pythonOlder = $older
    winget = [bool](Get-Command -Name winget -CommandType Application -ErrorAction SilentlyContinue)
    scheduledTasks = [bool](Get-Command -Name Register-ScheduledTask -ErrorAction SilentlyContinue)
    certificates = [bool](Get-Command -Name New-SelfSignedCertificate -ErrorAction SilentlyContinue)
}`)}`,
].join('\n');

/**
 * @typedef {object} PythonInfo
 * @property {string} version
 * @property {number} major
 * @property {number} minor
 * @property {string} exe
 * @property {string} dir
 *
 * @typedef {object} Probe
 * @property {string} [version]  PowerShell's.
 * @property {string} [edition]
 * @property {string} languageMode
 * @property {string} [executionPolicy]  The policy in force.
 * @property {Record<string, string>} [policies]  Each scope's policy, as Get-ExecutionPolicy -List gives them.
 * @property {boolean} [isWindows]
 * @property {string} [os]
 * @property {string | null} [sid]
 * @property {string | null} [user]
 * @property {string} [timeZone]  Windows's ID for the PC's time zone.
 * @property {string} [pwsh]  The pwsh.exe the task runs.
 * @property {PythonInfo | null} [python]  Python 3.10 or later, if there is one.
 * @property {string | null} [pythonOlder]  An older Python that was found instead.
 * @property {boolean} [winget]
 * @property {boolean} [scheduledTasks]
 * @property {boolean} [certificates]
 */

/**
 * Asks PowerShell 7 what the PAX path needs to know about this PC.
 * @param {RunPwsh} runPwsh
 * @returns {Promise<Probe>}
 */
export async function probe(runPwsh) {
  const r = await runPwsh({ command: PROBE, timeoutMs: 2 * 60_000 });
  if (!r.result || typeof r.result.languageMode !== 'string') throw new Error(`PowerShell 7 couldn't check this PC: ${firstError(r)}`);
  return r.result;
}

/** The scopes in the order PowerShell reads them. The first that sets a policy decides. */
const SCOPES = ['MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine'];

/**
 * Whether the task's script can run here. AllSigned and Restricted stop it. The installer never
 * changes the policy or works round it: the user does, or IT does when Group Policy sets it.
 * @param {Probe} p
 * @returns {{ ok: boolean, title: string, detail?: string, howTo?: string[] }}
 */
export function checkPolicy(p) {
  if (p.languageMode !== 'FullLanguage') {
    return {
      ok: false,
      title: `PowerShell runs in ${p.languageMode} mode on this PC`,
      detail: 'An application control policy (such as App Control for Business or AppLocker) limits PowerShell here, so the scheduled task\'s script would fail.',
      howTo: ['Ask IT whether the PAX refresh can run on this PC, or run the installer on a PC or server where PowerShell runs in full language mode.'],
    };
  }
  const policy = p.executionPolicy ?? 'Undefined';
  if (policy !== 'AllSigned' && policy !== 'Restricted') return { ok: true, title: `PowerShell's execution policy is ${policy}` };
  const scope = SCOPES.find((s) => p.policies?.[s] && p.policies[s] !== 'Undefined') ?? 'LocalMachine';
  const why = policy === 'AllSigned' ? 'only signed scripts can run' : "scripts can't run";
  if (scope === 'MachinePolicy' || scope === 'UserPolicy') {
    return {
      ok: false,
      title: `PowerShell's execution policy is ${policy}, set by Group Policy`,
      detail: `With ${policy}, ${why}, so the scheduled task couldn't run the refresh script. The installer doesn't change the policy or work round it.`,
      howTo: ['Ask IT to allow local scripts (RemoteSigned) for your account on this PC, or run the installer on a PC or server where they are allowed.'],
    };
  }
  return {
    ok: false,
    title: `PowerShell's execution policy is ${policy} (${scope} scope)`,
    detail: `With ${policy}, ${why}, so the scheduled task couldn't run the refresh script. The installer doesn't change the policy for you.`,
    howTo: [
      'To let local scripts run for your account only, run this yourself in PowerShell 7, then run the installer again:',
      'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned',
      'If your organisation doesn\'t allow that, ask IT.',
    ],
  };
}

/**
 * Runs a script and returns its result, or throws with what PowerShell said.
 * @param {RunPwsh} runPwsh
 * @param {string} script
 * @param {string} what  "Registering the task", for the message.
 * @param {{ env?: Record<string, string>, timeoutMs?: number }} [o]
 */
async function run(runPwsh, script, what, o = {}) {
  const r = await runPwsh({ script, ...o });
  if (r.result === undefined || r.result === null) throw new Error(`${what} failed: ${firstError(r)}`);
  return r.result;
}

const TASK = `-TaskName ${psQuote(TASK_NAME)} -TaskPath '\\'`;

/** @param {string} xmlFile */
export const registerTaskScript = (xmlFile) =>
  [
    ...PREAMBLE,
    `$xml = Get-Content -Raw -LiteralPath ${psQuote(xmlFile)}`,
    `$task = Register-ScheduledTask ${TASK} -Xml $xml -Force`,
    result('[ordered]@{ ok = $true; state = [string]$task.State }'),
  ].join('\n');

/**
 * Registers the task from its XML, replacing one of the same name.
 * @param {RunPwsh} runPwsh
 * @param {string} xmlFile
 */
export const registerTask = (runPwsh, xmlFile) => run(runPwsh, registerTaskScript(xmlFile), 'Registering the scheduled task');

export const START_TASK_SCRIPT = [...PREAMBLE, `Start-ScheduledTask ${TASK}`, result('[ordered]@{ ok = $true }')].join('\n');

/** @param {RunPwsh} runPwsh */
export const startTask = (runPwsh) => run(runPwsh, START_TASK_SCRIPT, 'Starting the scheduled task');

/** The task's result codes that aren't a run's own exit code. */
export const TASK_NOT_RUN = 267011;
export const TASK_RUNNING = 267009;

export const TASK_INFO_SCRIPT = [
  ...PREAMBLE,
  ...ISO_TIME,
  `$task = Get-ScheduledTask ${TASK} -ErrorAction SilentlyContinue`,
  `if (-not $task) { ${result('[ordered]@{ exists = $false }')}; exit 0 }`,
  '$info = Get-ScheduledTaskInfo -InputObject $task',
  '$action = @($task.Actions)[0]',
  '$trigger = @($task.Triggers)[0]',
  result(`[ordered]@{
    exists = $true
    state = [string]$task.State
    logonType = [string]$task.Principal.LogonType
    userId = [string]$task.Principal.UserId
    execute = [string]$action.Execute
    arguments = [string]$action.Arguments
    workingDir = [string]$action.WorkingDirectory
    startBoundary = [string]$trigger.StartBoundary
    lastRunTime = (ConvertTo-IsoTime $info.LastRunTime)
    lastTaskResult = [long]$info.LastTaskResult
    nextRunTime = (ConvertTo-IsoTime $info.NextRunTime)
}`),
].join('\n');

/**
 * @typedef {object} TaskInfo
 * @property {boolean} exists
 * @property {string} [state]  Ready, Running, Disabled, Queued.
 * @property {string} [logonType]  Interactive while it runs only when the user is signed in; Password or S4U once set to run when they're signed out.
 * @property {string} [userId]
 * @property {string} [execute]
 * @property {string} [arguments]
 * @property {string} [workingDir]
 * @property {string} [startBoundary]  Local time, yyyy-MM-ddTHH:mm:ss.
 * @property {string | null} [lastRunTime]
 * @property {number} [lastTaskResult]
 * @property {string | null} [nextRunTime]
 */

/**
 * @param {RunPwsh} runPwsh
 * @returns {Promise<TaskInfo>}
 */
export const taskInfo = (runPwsh) => run(runPwsh, TASK_INFO_SCRIPT, 'Reading the scheduled task');

export const UNREGISTER_TASK_SCRIPT = [
  ...PREAMBLE,
  `$task = Get-ScheduledTask ${TASK} -ErrorAction SilentlyContinue`,
  `if ($task) { Unregister-ScheduledTask ${TASK} -Confirm:$false }`,
  result('[ordered]@{ removed = [bool]$task }'),
].join('\n');

/**
 * @param {RunPwsh} runPwsh
 * @returns {Promise<{ removed: boolean }>}
 */
export const unregisterTask = (runPwsh) => run(runPwsh, UNREGISTER_TASK_SCRIPT, 'Removing the scheduled task');

/** @param {string} thumbprint */
function certPath(thumbprint) {
  if (!/^[0-9A-F]{40}$/.test(thumbprint)) throw new Error(`"${thumbprint}" isn't a certificate thumbprint.`);
  return psQuote(`Cert:\\CurrentUser\\My\\${thumbprint}`);
}

/**
 * A certificate for the app, made in the user's own store. Its private key can't be exported,
 * so it can't be copied off this PC; only its public key goes to Microsoft Entra. Entra takes a
 * certificate that ends at most a year after it starts, so it ends a day short of that.
 * @param {number} [months]
 */
export const makeCertificateScript = (months = CERT_MONTHS) => {
  if (!Number.isInteger(months) || months < 1 || months > 12) throw new Error('A certificate lasts 1 to 12 months.');
  return [
    ...PREAMBLE,
    ...ISO_TIME,
    '$from = (Get-Date).AddMinutes(-10)',
    `$made = New-SelfSignedCertificate -Subject ${psQuote(CERT_SUBJECT)} -FriendlyName ${psQuote(PAX_APP_NAME)} -CertStoreLocation 'Cert:\\CurrentUser\\My' -Provider 'Microsoft Software Key Storage Provider' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage DigitalSignature -NotBefore $from -NotAfter $from.AddMonths(${months}).AddDays(-1)`,
    // Read back from the store, which is what the task uses.
    "$cert = Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $made.Thumbprint)",
    result(`[ordered]@{
    thumbprint = $cert.Thumbprint
    notBefore = (ConvertTo-IsoTime $cert.NotBefore)
    notAfter = (ConvertTo-IsoTime $cert.NotAfter)
    hasPrivateKey = [bool]$cert.HasPrivateKey
    der = [Convert]::ToBase64String($cert.RawData)
}`),
  ].join('\n');
};

/**
 * @typedef {object} Certificate
 * @property {string} thumbprint
 * @property {string} notBefore
 * @property {string} notAfter
 * @property {boolean} hasPrivateKey
 * @property {string} der  The public certificate, base64.
 */

/**
 * @param {RunPwsh} runPwsh
 * @param {number} [months]
 * @returns {Promise<Certificate>}
 */
export const makeCertificate = (runPwsh, months) => run(runPwsh, makeCertificateScript(months), 'Making the certificate');

/** @param {string} thumbprint */
export const inspectCertificateScript = (thumbprint) =>
  [
    ...PREAMBLE,
    ...ISO_TIME,
    `$path = ${certPath(thumbprint)}`,
    `if (-not (Test-Path -LiteralPath $path)) { ${result('[ordered]@{ exists = $false }')}; exit 0 }`,
    '$cert = Get-Item -LiteralPath $path',
    result('[ordered]@{ exists = $true; thumbprint = $cert.Thumbprint; notAfter = (ConvertTo-IsoTime $cert.NotAfter); hasPrivateKey = [bool]$cert.HasPrivateKey }'),
  ].join('\n');

/**
 * @param {RunPwsh} runPwsh
 * @param {string} thumbprint
 * @returns {Promise<{ exists: boolean, thumbprint?: string, notAfter?: string, hasPrivateKey?: boolean }>}
 */
export const inspectCertificate = (runPwsh, thumbprint) => run(runPwsh, inspectCertificateScript(thumbprint), 'Reading the certificate');

/** @param {string} thumbprint */
export const removeCertificateScript = (thumbprint) =>
  [
    ...PREAMBLE,
    `$path = ${certPath(thumbprint)}`,
    `if (-not (Test-Path -LiteralPath $path)) { ${result('[ordered]@{ removed = $false }')}; exit 0 }`,
    'try { Remove-Item -LiteralPath $path -DeleteKey } catch { Remove-Item -LiteralPath $path }',
    result('[ordered]@{ removed = $true }'),
  ].join('\n');

/**
 * Deletes the certificate and its private key from the user's store.
 * @param {RunPwsh} runPwsh
 * @param {string} thumbprint
 * @returns {Promise<{ removed: boolean }>}
 */
export const removeCertificate = (runPwsh, thumbprint) => run(runPwsh, removeCertificateScript(thumbprint), 'Removing the certificate');

/**
 * The client secret, protected with Windows (DPAPI) for this user on this PC. The secret comes in
 * an environment variable, so it's never in the script or on a command line.
 * @param {string} file
 */
export const protectSecretScript = (file) =>
  [
    ...PREAMBLE,
    "if (-not $env:AIO_SECRET) { throw 'No secret was passed.' }",
    '$protected = ConvertTo-SecureString -String $env:AIO_SECRET -AsPlainText -Force | ConvertFrom-SecureString',
    `$file = ${psQuote(file)}`,
    '$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file)',
    'Set-Content -LiteralPath $file -Value $protected -Encoding utf8NoBOM -NoNewline',
    result('[ordered]@{ ok = $true }'),
  ].join('\n');

/**
 * @param {RunPwsh} runPwsh
 * @param {string} file
 * @param {string} secret
 */
export const protectSecret = (runPwsh, file, secret) =>
  run(runPwsh, protectSecretScript(file), 'Protecting the client secret', { env: { AIO_SECRET: secret } });

/** Python for the user only, from winget's own source. Only run when the user says yes. */
export const INSTALL_PYTHON_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  '& winget install --id Python.Python.3.13 --exact --source winget --scope user --silent --accept-source-agreements --accept-package-agreements',
  result('[ordered]@{ exitCode = [long]$LASTEXITCODE }'),
].join('\n');

/**
 * @param {RunPwsh} runPwsh
 * @returns {Promise<{ exitCode: number }>}
 */
export const installPython = (runPwsh) => run(runPwsh, INSTALL_PYTHON_SCRIPT, 'Installing Python', { timeoutMs: 15 * 60_000 });

/**
 * @typedef {object} AccessFile
 * @property {string} name
 * @property {boolean} exists
 * @property {number} [size]
 * @property {string} [lastModified]
 * @property {string} [webUrl]
 *
 * @typedef {object} AccessCheck
 * @property {boolean} ok
 * @property {string} [siteId]
 * @property {string} [siteName]
 * @property {string} [siteWebUrl]
 * @property {string} [driveId]
 * @property {string} [driveName]
 * @property {string} [driveWebUrl]
 * @property {string} [folder]
 * @property {AccessFile[]} [files]
 * @property {string} [step]  Where it failed.
 * @property {number} [status]  The HTTP status, when there was one.
 * @property {string} [error]
 */

/**
 * Has the task's script sign in as the app and check the SharePoint folder, as the task would.
 * @param {RunPwsh} runPwsh
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<AccessCheck>}
 */
export async function checkAccess(runPwsh, env) {
  const r = await runPwsh({ file: wrapperPath(env), args: ['-CheckAccess'], timeoutMs: 3 * 60_000 });
  if (!r.result) return { ok: false, step: 'Running the check', error: firstError(r) };
  return r.result;
}
