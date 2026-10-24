// Runs the scheduled task's script for real in PowerShell 7, with a fake PAX and a fake clock.
// The run scenarios need Windows and pwsh. They never reach Graph or SharePoint, and they
// leave the execution policy alone: if it doesn't let local scripts run, they're skipped.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { emptyConfig, emptyPax } from '../src/config.js';
import * as N from '../src/pax/names.js';
import { loadRelease, sha256 } from '../src/pax/release.js';
import { scriptText } from '../src/pax/ps.js';
import { loadTemplate, taskXml, writeWrapper } from '../src/pax/wrapper.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const APP_ID = '00000000-0000-0000-0000-000000000002';
const SID = 'S-1-5-21-1000000000-1000000000-1000000000-1001';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' };
const SECRET = 'not-a-real-secret';
const RECHECK = 'Recheck this against PAX whenever the installer moves to a new PAX release.';

// The texts PAX 1.11.15 logs when its rollup fails but it still exits 0.
const ROLLUP_FAILURES = [
    'Rollup: post-processor returned non-zero',
    'Rollup: post-processor failed',
    'expected Fact CSV not produced',
    'expected Users dim CSV not produced',
    'expected Fact CSV not found',
    'Rollup stage [processor] failed',
];
const ROLLUP_BLOCK = ['$RollupFailures = @(', ...ROLLUP_FAILURES.map((s) => `    '${s}'`), ')'].join('\n');

const TPL = loadTemplate().replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

// The hook goes in just before the main block: the clock and the secret come from the test.
const SPLIT = '\nif ($CheckAccess) {';
const HOOK = String.raw`$global:AioClock = [DateTimeOffset]::Parse($env:AIO_TEST_NOW, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
function Get-Date { $global:AioClock }
function Get-ClientSecretText { 'not-a-real-secret' }
$RunStarted = Get-Date
$Today = $RunStarted.ToUniversalTime().Date`;
const PARTS = TPL.split(SPLIT);
const HOOKED = PARTS.length === 2 ? `${PARTS[0]}\n${HOOK}${SPLIT}${PARTS[1]}` : null;

// A stand-in for PAX. It records each call, then does what step n of the test's plan says.
// Step options: log, minutes, kill, rows, records, noMerge, noFact, quiet, noMetrics, exit.
const FAKE_PAX = String.raw`param(
    [string]$Auth,
    [string]$TenantId,
    [string]$ClientId,
    [string]$ClientSecret,
    [string]$ClientCertificateThumbprint,
    [string]$ClientCertificateStoreLocation,
    [string]$StartDate,
    [string]$EndDate,
    [string]$MetricsPath,
    [string]$OutputPathLog,
    [string]$OutputPath,
    [string]$AppendFile,
    [string]$OutputPathUserInfo,
    [string]$AppendUserInfo,
    [string]$OutputPathAgent365Info,
    [string]$AppendAgent365Info,
    [switch]$Rollup,
    [switch]$SkipVersionCheck,
    [switch]$EmitMetricsJson,
    [switch]$AutoCompleteness,
    [switch]$IncludeUserInfo,
    [switch]$IncludeAgent365Info
)
$ErrorActionPreference = 'Stop'
$callsFile = $env:AIO_FAKE_PAX_CALLS
$n = 1
if (Test-Path -LiteralPath $callsFile) { $n = @(Get-Content -LiteralPath $callsFile | Where-Object { $_.Trim() }).Count + 1 }
$call = [ordered]@{
    n                      = $n
    Auth                   = $Auth
    TenantId               = $TenantId
    ClientId               = $ClientId
    ClientSecret           = $ClientSecret
    ClientCertificateThumbprint = $ClientCertificateThumbprint
    StartDate              = $StartDate
    EndDate                = $EndDate
    MetricsPath            = $MetricsPath
    OutputPathLog          = $OutputPathLog
    OutputPath             = $OutputPath
    AppendFile             = $AppendFile
    OutputPathUserInfo     = $OutputPathUserInfo
    AppendUserInfo         = $AppendUserInfo
    OutputPathAgent365Info = $OutputPathAgent365Info
    AppendAgent365Info     = $AppendAgent365Info
    Rollup                 = [bool]$Rollup
    SkipVersionCheck       = [bool]$SkipVersionCheck
    EmitMetricsJson        = [bool]$EmitMetricsJson
    AutoCompleteness       = [bool]$AutoCompleteness
    IncludeUserInfo        = [bool]$IncludeUserInfo
    IncludeAgent365Info    = [bool]$IncludeAgent365Info
    nonInteractive         = $env:PAX_NONINTERACTIVE
    extra                  = @($args | ForEach-Object { [string]$_ })
}
Add-Content -LiteralPath $callsFile -Value ($call | ConvertTo-Json -Compress -Depth 4) -Encoding utf8
$plan = @(Get-Content -LiteralPath $env:AIO_FAKE_PAX_PLAN -Raw | ConvertFrom-Json)
if ($n -gt $plan.Count) { Write-Host "The test's plan has no step $n."; exit 99 }
$step = $plan[$n - 1]
function Opt([string]$Name, $Default) {
    $p = $step.PSObject.Properties[$Name]
    if ($p) { $p.Value } else { $Default }
}
function Get-FakeDir([string]$Path) {
    if ($Path) { $Path } else { (Get-Location).Path }
}
foreach ($line in @(Opt 'log' @())) { Write-Host $line }
$minutes = [int](Opt 'minutes' 0)
if ($minutes) { $global:AioClock = $global:AioClock.AddMinutes($minutes) }
if (Opt 'kill' $false) { [Environment]::Exit(137) }
$rows = [int](Opt 'rows' 0)
$records = [int](Opt 'records' $rows)
if ($rows -gt 0) {
    $new = @(1..$rows | ForEach-Object { '{0},{1},{2}' -f $StartDate, $n, $_ })
    if ($AppendFile) {
        $before = @(Get-Content -LiteralPath $AppendFile | Where-Object { $_.Trim() }).Count - 1
        Add-Content -LiteralPath $AppendFile -Value $new -Encoding utf8
        if (-not (Opt 'noMerge' $false)) {
            Write-Host ('Rollup: -AppendFile merge: Retained={0}  New={1}  Departed=0  Union={2}' -f $before, $rows, ($before + $rows))
        }
    } elseif (-not (Opt 'noFact' $false)) {
        $fact = Join-Path (Get-FakeDir $OutputPath) ('Purview_Audit_CopilotInteraction_{0}_Interactions.csv' -f $StartDate)
        Set-Content -LiteralPath $fact -Value (@('Day,Call,Row') + $new) -Encoding utf8
    }
    if ($AppendUserInfo) {
        Add-Content -LiteralPath $AppendUserInfo -Value ('user' + $n) -Encoding utf8
    } elseif ($IncludeUserInfo) {
        $users = Join-Path (Get-FakeDir $OutputPathUserInfo) ('EntraUsers_{0}_Users.csv' -f $StartDate)
        Set-Content -LiteralPath $users -Value @('Id', ('user' + $n)) -Encoding utf8
    }
    if ($AppendAgent365Info) {
        Add-Content -LiteralPath $AppendAgent365Info -Value ('agent' + $n) -Encoding utf8
    } elseif ($IncludeAgent365Info) {
        $agents = Join-Path (Get-FakeDir $OutputPathAgent365Info) ('Agent365_{0}.csv' -f $StartDate)
        Set-Content -LiteralPath $agents -Value @('Id', ('agent' + $n)) -Encoding utf8
    }
} else {
    $raw = Join-Path (Get-FakeDir $OutputPath) ('Purview_Audit_UsageActivity_{0}.csv' -f $StartDate)
    Set-Content -LiteralPath $raw -Value 'RecordId,CreationDate' -Encoding utf8
    if (-not (Opt 'quiet' $false)) {
        Write-Host 'No audit logs found in the specified date range for the selected activity types.'
        Write-Host 'Pipeline Summary:'
        Write-Host '  Retained:  0 records'
        Write-Host '  Exported:  0 rows'
    }
}
if ($MetricsPath -and -not (Opt 'noMetrics' $false)) {
    $metrics = [ordered]@{ version = '1.11.15'; metrics = [ordered]@{ TotalRecordsFetched = $records; TotalStructuredRows = $rows } }
    Set-Content -LiteralPath $MetricsPath -Value ($metrics | ConvertTo-Json -Depth 4) -Encoding utf8
}
exit ([int](Opt 'exit' 0))
`;

const ITEM = 'https://graph.microsoft.com/v1.0/drives/drive-1/root:/AI%20in%20One/AIO_Interactions.csv';
const HEADER = 'Day,Call,Row';
const OLD = [HEADER, '2026-05-01,0,1'];
const OLD_USERS = ['Id', 'user0'];
const SEED_KEYS = ['from', 'next', 'window', 'loading', 'done', 'found', 'rows'];
const INTERACTIONS = 'AIO_Interactions.csv';
const USERS = 'AIO_Users.csv';
const AGENTS = 'AIO_Agent365.csv';

function skipReason() {
    if (process.platform !== 'win32') return 'needs Windows';
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '(Get-ExecutionPolicy).ToString()'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
    });
    if (r.error || r.status !== 0) return 'needs PowerShell 7 (pwsh)';
    const policy = String(r.stdout).trim();
    if (/^(AllSigned|Restricted)$/i.test(policy)) return `the execution policy (${policy}) doesn't let local scripts run`;
    return false;
}
const SKIP = skipReason();

/**
 * Installs the task's script in a temporary folder, with the fake PAX and a local destination.
 * @param {import('node:test').TestContext} t
 * @param {{ days?: number, agent365?: boolean }} [o]
 */
function install(t, { days = 90, agent365 = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'aio-pax-run-'));
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    const env = { LOCALAPPDATA: join(dir, 'Local') };
    const script = join(dir, 'pax', 'PAX_Fake.ps1');
    mkdirSync(dirname(script), { recursive: true });
    const fake = Buffer.from(scriptText(FAKE_PAX));
    writeFileSync(script, fake);
    const pythonDir = join(dir, 'python');
    mkdirSync(pythonDir, { recursive: true });
    writeFileSync(join(pythonDir, 'python.exe'), '');
    const localFolder = join(dir, 'Published');
    const base = emptyConfig();
    /** @type {import('../src/config.js').InstallConfig} */
    const config = {
        ...base,
        target: 'pax',
        tenantId: TENANT,
        app: { ...base.app, appId: APP_ID },
        history: { ...base.history, days },
        pax: {
            ...emptyPax(),
            destination: 'local',
            localFolder,
            credentialType: 'secret',
            script,
            sha256: sha256(fake),
            version: loadRelease().version,
            pythonDir,
            agent365,
        },
    };
    assert.ok(HOOKED, 'the template has exactly one "if ($CheckAccess) {" line');
    const wrapper = writeWrapper(config, { env, version: '0.2.0', template: HOOKED ?? undefined });
    return { dir, env, wrapper, runDir: N.runDir(env), dataDir: N.dataDir(env), localFolder, runs: 0 };
}

/** @param {string} text */
const stripBom = (text) => text.replace(/^\uFEFF/, '');

/**
 * Runs the task's script once, as Task Scheduler would, with the fake clock set to `now`.
 * @param {ReturnType<typeof install>} inst
 * @param {{ now: string, plan: object[] }} o
 * @returns {Promise<any>}
 */
function run(inst, { now, plan }) {
    inst.runs += 1;
    const planFile = join(inst.dir, `plan-${inst.runs}.json`);
    const callsFile = join(inst.dir, `calls-${inst.runs}.jsonl`);
    writeFileSync(planFile, JSON.stringify(plan));
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, AIO_TEST_NOW: now, AIO_FAKE_PAX_PLAN: planFile, AIO_FAKE_PAX_CALLS: callsFile };
    delete env.PAX_NONINTERACTIVE;
    return new Promise((resolve, reject) => {
        const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', inst.wrapper], { env, windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        const timer = setTimeout(() => child.kill(), 120_000);
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const calls = (lines(callsFile) ?? []).map((l) => JSON.parse(stripBom(l)));
            const lastFile = N.lastRunPath(inst.env);
            const last = existsSync(lastFile) ? JSON.parse(stripBom(readFileSync(lastFile, 'utf8'))) : null;
            const seedFile = N.seedRequestPath(inst.env);
            /** @type {any} */
            let seed = null;
            if (existsSync(seedFile)) {
                const text = stripBom(readFileSync(seedFile, 'utf8'));
                try {
                    seed = JSON.parse(text);
                } catch {
                    seed = text;
                }
            }
            resolve({ code, out, calls, last, seed });
        });
    });
}

/** @param {string} path */
const lines = (path) =>
    existsSync(path) ? stripBom(readFileSync(path, 'utf8')).split(/\r?\n/).filter((l) => l.trim()) : null;
/** @param {ReturnType<typeof install>} inst @param {string} name */
const data = (inst, name) => lines(join(inst.dataDir, name));
/** @param {ReturnType<typeof install>} inst @param {string} name */
const published = (inst, name) => lines(join(inst.localFolder, name));
/** @param {string} path @param {string[]} rows */
function put(path, rows) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${rows.join('\r\n')}\r\n`);
}
/** Puts an earlier history in place, as a finished first load leaves it. @param {ReturnType<typeof install>} inst */
function preload(inst) {
    for (const folder of [inst.dataDir, inst.localFolder]) {
        put(join(folder, INTERACTIONS), OLD);
        put(join(folder, USERS), OLD_USERS);
    }
}
/** @param {any} r */
const runLog = (r) => (r.last?.log && existsSync(r.last.log) ? readFileSync(r.last.log, 'utf8') : '');
/** @param {any} obj @param {string[]} keys */
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k]]));
/** @param {any} r */
const windows = (r) => r.calls.map((/** @type {any} */ c) => [c.StartDate, c.EndDate]);

/** @param {any} r */
function explain(r) {
    const tail = (/** @type {string} */ text) => text.split(/\r?\n/).slice(-40).join('\n');
    return [
        `exit code: ${r.code}`,
        `last-run.json: ${JSON.stringify(r.last)}`,
        `seed.request: ${JSON.stringify(r.seed)}`,
        `PAX windows: ${JSON.stringify(windows(r))}`,
        `run log (tail):\n${tail(runLog(r))}`,
        `output (tail):\n${tail(r.out)}`,
    ].join('\n');
}

/** @param {any} r @param {{ code?: number, status?: string, message?: string | RegExp }} o */
function expectRun(r, { code, status, message }) {
    const why = explain(r);
    if (code !== undefined) assert.equal(r.code, code, why);
    if (status !== undefined) assert.equal(r.last?.status, status, why);
    if (message instanceof RegExp) assert.match(String(r.last?.message ?? ''), message, why);
    else if (message !== undefined) assert.equal(r.last?.message, message, why);
}

// The function-level cases: the template's own functions, with Graph, sleeps and uploads mocked.
const SETUP = String.raw`Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$CRLF = [string][char]13 + [char]10
$Root = $env:AIO_TEST_DIR
$LogDir = Join-Path $Root 'logs'
$PaxLogDir = Join-Path $LogDir 'pax'
$WorkDir = Join-Path $Root 'work'
$DataDir = Join-Path $Root 'data'
$SeedDir = Join-Path $Root 'seed'
foreach ($d in @($LogDir, $PaxLogDir, $WorkDir, $DataDir, $SeedDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
$RunLog = Join-Path $LogDir 'run.log'
$Target = Join-Path $DataDir 'AIO_Interactions.csv'
$script:Token = 'token'
$Settings = [ordered]@{ DriveId = 'drive-1'; Folder = 'AI in One'; Destination = 'sharepoint'; LocalFolder = (Join-Path $Root 'Published'); Agent365 = $false; SeedDays = 180 }
$Result = [ordered]@{ warnings = @(); files = @() }
$global:Remote = 'Day,Call,Row' + $CRLF + '2026-05-01,0,1' + $CRLF
$global:RemoteSize = [Text.Encoding]::UTF8.GetByteCount($global:Remote)
$Merged = 'Rollup: -AppendFile merge: Retained=1  New=1  Departed=0  Union=2'
`;

const MOCKS = String.raw`function New-HttpError([int]$Status) {
    $response = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$Status)
    [Microsoft.PowerShell.Commands.HttpResponseException]::new(('Response status code does not indicate success: {0}.' -f $Status), $response)
}
function Start-Sleep([int]$Seconds) { $global:Slept += $Seconds }
function Invoke-RestMethod([string]$Uri, $Headers, [string]$Method = 'GET', $Body, [string]$ContentType, [string]$InFile) {
    $global:Calls += ('REST {0} {1}' -f $Method.ToUpperInvariant(), $Uri)
    $next = @{}
    if ($global:Queue.Count) { $next = $global:Queue.Dequeue() }
    if ($next.ContainsKey('status')) { throw (New-HttpError $next.status) }
    $size = $global:RemoteSize
    if ($next.ContainsKey('size')) { $size = $next.size }
    [pscustomobject]@{ size = $size }
}
function Invoke-WebRequest([string]$Uri, $Headers, [string]$OutFile) {
    $global:Calls += ('WEB ' + $Uri)
    $bytes = [Text.Encoding]::UTF8.GetBytes($global:Remote)
    if ($null -ne $global:WebBytes) { $bytes = $bytes[0..($global:WebBytes - 1)] }
    [IO.File]::WriteAllBytes($OutFile, [byte[]]$bytes)
    if ($global:WebDrop) { throw [System.Net.Http.HttpRequestException]::new('The response ended prematurely.') }
}
function Send-RemoteFile([string]$Path, [string]$Name) { $global:Sent += $Name }
`;

const CASES = String.raw`function Start-Case {
    $Result.warnings = @()
    $Result.files = @()
    $global:Calls = @()
    $global:Slept = @()
    $global:Sent = @()
    $global:Queue = [System.Collections.Generic.Queue[hashtable]]::new()
    $global:WebBytes = $null
    $global:WebDrop = $false
    $Settings.Destination = 'sharepoint'
    foreach ($d in @($WorkDir, $DataDir, $Settings.LocalFolder)) {
        if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
    }
    foreach ($d in @($WorkDir, $DataDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}
function Set-Lines([string]$Path, [string[]]$Lines) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($Path, (@($Lines | ForEach-Object { $_ + $CRLF }) -join ''))
}
function Read-Text([string]$Path) {
    if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path) } else { $null }
}
function New-Run([bool]$Empty, [bool]$Appended, [string[]]$Lines) {
    [pscustomobject]@{ Empty = $Empty; Appended = $Appended; Output = (@($Lines) -join [Environment]::NewLine) }
}
function Invoke-Case([string]$Name, [scriptblock]$Body) {
    Start-Case
    $case = [ordered]@{ name = $Name; ok = $true; value = $null; error = $null; status = 0 }
    try {
        $case.value = & $Body
    } catch {
        $case.ok = $false
        $case.error = $_.Exception.Message
        $p = $_.Exception.PSObject.Properties['Response']
        if ($p -and $p.Value) { $case.status = [int]$p.Value.StatusCode }
    }
    $case.warnings = @($Result.warnings)
    $case.files = @($Result.files)
    $case.sent = @($global:Sent)
    $case.calls = @($global:Calls)
    $case.slept = @($global:Slept)
    $case.target = Test-Path -LiteralPath $Target
    $case.partial = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.download' | ForEach-Object { $_.Name })
    $case.targetText = Read-Text $Target
    $case.local = Read-Text (Join-Path $Settings.LocalFolder 'AIO_Interactions.csv')
    'AIO-CASE ' + ($case | ConvertTo-Json -Compress -Depth 4 -EscapeHandling EscapeNonAscii)
}
$I = 'AIO_Interactions.csv'
Invoke-Case 'receive-full' { Receive-RemoteFile $I $Target }
Invoke-Case 'receive-dropped' { $global:WebBytes = 10; $global:WebDrop = $true; Receive-RemoteFile $I $Target }
Invoke-Case 'receive-short' { $global:WebBytes = 10; Receive-RemoteFile $I $Target }
Invoke-Case 'receive-empty' { $global:Queue.Enqueue(@{ size = 0 }); Receive-RemoteFile $I $Target }
Invoke-Case 'receive-missing' { $global:Queue.Enqueue(@{ status = 404 }); Receive-RemoteFile $I $Target }
Invoke-Case 'receive-forbidden' { $global:Queue.Enqueue(@{ status = 403 }); Receive-RemoteFile $I $Target }
Invoke-Case 'receive-retried' { $global:Queue.Enqueue(@{ status = 503 }); Receive-RemoteFile $I $Target }
function Get-DataFiles { @(Get-ChildItem -LiteralPath $DataDir -File | ForEach-Object { $_.Name } | Sort-Object) -join ',' }
Invoke-Case 'fetch-sharepoint' { Get-PublishedFiles; Get-DataFiles }
Invoke-Case 'fetch-sharepoint-none' { $global:Queue.Enqueue(@{ status = 404 }); $global:Queue.Enqueue(@{ status = 404 }); Get-PublishedFiles; Get-DataFiles }
Invoke-Case 'fetch-keeps-local' { Set-Lines $Target @('Day,Call,Row', '2026-06-01,9,9'); Get-PublishedFiles; Get-DataFiles }
Invoke-Case 'fetch-local' {
    $Settings.Destination = 'local'
    Set-Lines (Join-Path $Settings.LocalFolder $I) @('Day,Call,Row', '2026-04-01,0,1')
    [IO.File]::WriteAllText((Join-Path $Settings.LocalFolder 'AIO_Users.csv'), '')
    Get-PublishedFiles
    Get-DataFiles
}
$Users = Join-Path $DataDir 'AIO_Users.csv'
Invoke-Case 'publish-header-only' { Set-Lines $Target @('Day,Call,Row'); Set-Lines $Users @('Id', 'user1'); Publish-Files $DataDir }
Invoke-Case 'publish-blank-then-rows' { Set-Lines $Target @('', 'Day,Call,Row', '', '2026-05-01,0,1'); Set-Lines $Users @('Id', 'user1'); Publish-Files $DataDir }
Invoke-Case 'publish-blank-only' { Set-Lines $Target @('', ''); Set-Lines $Users @('Id', 'user1'); Publish-Files $DataDir }
Invoke-Case 'publish-zero-bytes' { [IO.File]::WriteAllText($Target, ''); Set-Lines $Users @('Id', 'user1'); Publish-Files $DataDir }
Invoke-Case 'publish-rows' { Set-Lines $Target @('Day,Call,Row', '2026-05-01,0,1'); Set-Lines $Users @('Id', 'user1'); Publish-Files $DataDir }
Invoke-Case 'publish-missing-users' { Set-Lines $Target @('Day,Call,Row', '2026-05-01,0,1'); Publish-Files $DataDir }
Invoke-Case 'publish-no-data' { Publish-Files $DataDir }
Invoke-Case 'publish-local-header-only' {
    $Settings.Destination = 'local'
    Set-Lines (Join-Path $Settings.LocalFolder 'AIO_Interactions.csv') @('Day,Call,Row', '2026-05-01,0,1')
    Set-Lines $Target @('Day,Call,Row')
    Set-Lines $Users @('Id', 'user1')
    Publish-Files $DataDir
}
foreach ($text in $RollupFailures) {
    Invoke-Case ('rollup:' + $text) { Assert-PaxRun (New-Run $false $true @(($text + ' (test)'), $Merged)) }
    Invoke-Case ('rollup-empty:' + $text) { Assert-PaxRun (New-Run $true $false @($text)) }
}
Invoke-Case 'pass-empty' { Assert-PaxRun (New-Run $true $false @('No audit logs found in the specified date range for the selected activity types.')) }
Invoke-Case 'pass-merged' { Assert-PaxRun (New-Run $false $true @($Merged)) }
Invoke-Case 'pass-new-file' {
    Set-Lines (Join-Path $WorkDir 'Purview_Audit_CopilotInteraction_2026-05-01_Interactions.csv') @('Day,Call,Row', '2026-05-01,1,1')
    Assert-PaxRun (New-Run $false $false @())
}
Invoke-Case 'fail-skipped' { Assert-PaxRun (New-Run $false $true @('Rollup: -AppendFile: x; append SKIPPED to prevent data loss.')) }
Invoke-Case 'fail-no-merge-line' { Assert-PaxRun (New-Run $false $true @('Done.')) }
Invoke-Case 'fail-only-the-copy' { Set-Lines (Join-Path $WorkDir 'AIO_Interactions.csv') @('Day,Call,Row', '2026-05-01,0,1'); Assert-PaxRun (New-Run $false $false @()) }
Invoke-Case 'fail-only-raw' { Set-Lines (Join-Path $WorkDir 'Purview_Audit_UsageActivity_2026-05-01.csv') @('RecordId'); Assert-PaxRun (New-Run $false $false @()) }
Invoke-Case 'fail-nothing' { Assert-PaxRun (New-Run $false $false @()) }
`;

/** @param {RegExp} re @param {string} what */
function extract(re, what) {
    const m = TPL.match(re);
    assert.ok(m, `the template has ${what}`);
    return m[0];
}
/** @param {string} name */
const block = (name) => extract(new RegExp(String.raw`\n\$${name} = @\(\n[\s\S]*?\n\)\n`), `a $${name} block`);
/** @param {string} name */
const fn = (name) => extract(new RegExp(String.raw`\nfunction ${name}\b[^\n]*\{\n[\s\S]*?\n\}\n`), `a ${name} function`);
const FUNCTIONS = ['Write-RunLog', 'Get-HttpStatus', 'Invoke-Graph', 'Get-AuthHeader', 'Get-DriveItemUri', 'Receive-RemoteFile', 'Publish-Files', 'Assert-PaxRun', 'Get-PublishedFiles'];
const casesScript = () => [SETUP, block('RollupFailures'), block('Streams'), ...FUNCTIONS.map(fn), MOCKS, CASES].join('\n');

describe("the task script's pinned PAX behaviour", () => {
    test('the test hook fits the template', () => {
        assert.ok(HOOKED, 'the template has exactly one "if ($CheckAccess) {" line');
    });
    test('the installer still pins PAX 1.11.15', () => {
        assert.equal(loadRelease().version, '1.11.15', RECHECK);
    });
    test('the rollup failure texts are the ones PAX 1.11.15 logs', () => {
        assert.ok(TPL.includes(`\n${ROLLUP_BLOCK}\n`), `The template's $RollupFailures list changed. ${RECHECK}`);
    });
    test('the other PAX texts the script reads are still in it', () => {
        for (const s of ['No audit logs found in the specified date range', 'Rollup: -AppendFile merge:', 'append SKIPPED', 'TotalRecordsFetched', 'TotalStructuredRows']) {
            assert.ok(TPL.includes(s), `The template no longer reads "${s}". ${RECHECK}`);
        }
    });
    test("a first-load run stops well inside the task's time limit", () => {
        assert.ok(TPL.includes('$SeedBudget = [timespan]::FromMinutes(210)'));
        const xml = taskXml({ sid: SID, pwsh: PWSH, runAt: '02:00', env: WIN_ENV });
        const m = xml.match(/<ExecutionTimeLimit>PT(\d+)H/);
        assert.ok(m, xml);
        assert.ok(Number(m[1]) * 60 - 210 >= 30, `${m[1]} hours leaves too little room after the 210-minute budget`);
    });
    test('a first-load window is at least as long as a daily one', () => {
        assert.ok(N.SEED_WINDOW_DAYS >= N.WINDOW_DAYS);
    });
});

describe("the task script's functions, under pwsh", { skip: SKIP }, () => {
    /** @type {Map<string, any>} */
    const cases = new Map();
    let raw = '';
    let root = '';
    before(() => {
        root = mkdtempSync(join(tmpdir(), 'aio-pax-cases-'));
        const file = join(root, 'cases.ps1');
        writeFileSync(file, scriptText(casesScript()));
        const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', file], {
            env: { ...process.env, AIO_TEST_DIR: root },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 120_000,
        });
        raw = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
        for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
            if (!line.startsWith('AIO-CASE ')) continue;
            const c = JSON.parse(line.slice('AIO-CASE '.length));
            cases.set(c.name, c);
        }
    });
    after(() => {
        if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });
    /** @param {string} name */
    const get = (name) => {
        assert.ok(cases.has(name), `no "${name}" case. The script printed:\n${raw.slice(-6000)}`);
        return cases.get(name);
    };
    /** @param {any} c */
    const show = (c) => JSON.stringify(c);
    const GET = `REST GET ${ITEM}`;
    const WEB = `WEB ${ITEM}:/content`;

    test('a full download is checked against its size, then moved into place', () => {
        const c = get('receive-full');
        assert.equal(c.ok, true, show(c));
        assert.equal(c.value, true, show(c));
        assert.deepEqual(c.calls, [GET, WEB]);
        assert.equal(c.target, true);
        assert.deepEqual(c.partial, []);
        assert.equal(c.targetText, `${OLD.join('\r\n')}\r\n`);
    });
    test('a dropped download fails, without a retry, and leaves no file behind', () => {
        const c = get('receive-dropped');
        assert.equal(c.ok, false, show(c));
        assert.equal(c.status, 0);
        assert.deepEqual(c.calls, [GET, WEB]);
        assert.deepEqual(c.slept, []);
        assert.equal(c.target, false, show(c));
        assert.deepEqual(c.partial, []);
    });
    test('a download that stops short fails and leaves no file behind', () => {
        const c = get('receive-short');
        assert.equal(c.ok, false, show(c));
        assert.match(c.error, /stopped short: 10 of \d+ bytes arrived/);
        assert.equal(c.target, false);
        assert.deepEqual(c.partial, []);
    });
    test("an empty file in SharePoint isn't downloaded", () => {
        const c = get('receive-empty');
        assert.equal(c.ok, true, show(c));
        assert.equal(c.value, false);
        assert.deepEqual(c.warnings, ["AIO_Interactions.csv in the SharePoint folder is empty, so it wasn't downloaded."]);
        assert.deepEqual(c.calls, [GET]);
        assert.equal(c.target, false);
    });
    test("a file that isn't in SharePoint yet is no error", () => {
        const c = get('receive-missing');
        assert.equal(c.ok, true, show(c));
        assert.equal(c.value, false);
        assert.equal(c.target, false);
    });
    test('a first load on a new PC fetches the published files from SharePoint first', () => {
        const USERS_ITEM = ITEM.replace(INTERACTIONS, USERS);
        const c = get('fetch-sharepoint');
        assert.equal(c.ok, true, show(c));
        assert.equal(c.value, `${INTERACTIONS},${USERS}`, show(c));
        assert.deepEqual(c.calls, [GET, WEB, `REST GET ${USERS_ITEM}`, `WEB ${USERS_ITEM}:/content`]);
        assert.equal(c.targetText, `${OLD.join('\r\n')}\r\n`);
        assert.deepEqual(c.partial, []);
        assert.deepEqual(c.sent, [], 'nothing is published while it fetches');

        const none = get('fetch-sharepoint-none');
        assert.equal(none.ok, true, show(none));
        assert.equal(none.value, '', 'a true first install has nothing to fetch');

        const kept = get('fetch-keeps-local');
        assert.equal(kept.ok, true, show(kept));
        assert.ok(!kept.calls.some((/** @type {string} */ x) => x.endsWith(ITEM)), show(kept));
        assert.equal(kept.targetText, 'Day,Call,Row\r\n2026-06-01,9,9\r\n', 'a local file is never replaced');
    });
    test('a first load on a new PC copies the files from the local folder first, but not an empty one', () => {
        const c = get('fetch-local');
        assert.equal(c.ok, true, show(c));
        assert.equal(c.value, INTERACTIONS, show(c));
        assert.deepEqual(c.calls, []);
        assert.equal(c.targetText, 'Day,Call,Row\r\n2026-04-01,0,1\r\n');
        assert.equal(c.local, c.targetText, 'the published copy stays as it is');
        assert.deepEqual(c.partial, []);
    });
    test('a 403 fails at once, and a 503 is retried', () => {
        const forbidden = get('receive-forbidden');
        assert.equal(forbidden.ok, false, show(forbidden));
        assert.equal(forbidden.status, 403);
        assert.deepEqual(forbidden.slept, []);
        const retried = get('receive-retried');
        assert.equal(retried.ok, true, show(retried));
        assert.deepEqual(retried.slept, [15]);
        assert.deepEqual(retried.calls, [GET, GET, WEB]);
        assert.equal(retried.target, true);
    });
    test('an Interactions file with no rows is never published over the real one', () => {
        for (const name of ['publish-header-only', 'publish-blank-only', 'publish-zero-bytes']) {
            const c = get(name);
            assert.equal(c.ok, true, show(c));
            assert.deepEqual(c.sent, [USERS], name);
        }
        assert.ok(get('publish-header-only').warnings.includes("AIO_Interactions.csv has no rows, so it wasn't published."), show(get('publish-header-only')));
        assert.deepEqual(get('publish-blank-then-rows').sent, [INTERACTIONS, USERS]);
        assert.deepEqual(get('publish-rows').sent, [INTERACTIONS, USERS]);
    });
    test('a missing Users file is a warning, and no data at all publishes nothing', () => {
        const missing = get('publish-missing-users');
        assert.deepEqual(missing.sent, [INTERACTIONS]);
        assert.ok(missing.warnings.includes("PAX didn't write AIO_Users.csv this time."), show(missing));
        const none = get('publish-no-data');
        assert.equal(none.ok, true, show(none));
        assert.deepEqual(none.sent, []);
        assert.deepEqual(none.warnings, []);
    });
    test('a local folder keeps its history when the new file has no rows', () => {
        const c = get('publish-local-header-only');
        assert.equal(c.ok, true, show(c));
        assert.equal(c.local, `${OLD.join('\r\n')}\r\n`);
    });
    test("each rollup failure text fails the run, even when PAX exits 0", () => {
        const names = [...cases.keys()].filter((k) => k.startsWith('rollup:')).map((k) => k.slice('rollup:'.length));
        assert.deepEqual(names, ROLLUP_FAILURES);
        for (const text of ROLLUP_FAILURES) {
            for (const kind of ['rollup:', 'rollup-empty:']) {
                const c = get(kind + text);
                assert.equal(c.ok, false, `${kind}${text} passed`);
                assert.ok(String(c.error).startsWith(`PAX's rollup failed ("${text}"), so nothing was published.`), c.error);
            }
        }
    });
    test('an empty window, a merged append and a new Interactions file all pass', () => {
        for (const name of ['pass-empty', 'pass-merged', 'pass-new-file']) assert.equal(get(name).ok, true, show(get(name)));
    });
    test('a skipped append, a missing merge line or a missing Interactions file fails', () => {
        assert.match(get('fail-skipped').error, /--backfill-days 180/);
        assert.match(get('fail-no-merge-line').error, /PAX didn't say it added the new days to AIO_Interactions\.csv/);
        for (const name of ['fail-only-the-copy', 'fail-only-raw', 'fail-nothing']) {
            assert.equal(get(name).ok, false, name);
            assert.match(get(name).error, /PAX didn't write an Interactions file/, name);
        }
    });
});

describe("the task script's runs, under pwsh with a fake PAX", { skip: SKIP, concurrency: 4 }, () => {
    const NOW = '2026-06-01T03:00:00Z';
    const ONE = { rows: 1 };
    /** @param {any} r */
    const starts = (r) => r.calls.map((/** @type {any} */ c) => c.StartDate);
    /** @param {ReturnType<typeof install>} inst @param {any} r */
    function expectCalls(inst, r) {
        for (const c of r.calls) {
            const why = `call ${c.n}: ${JSON.stringify(c)}`;
            assert.ok(c.Auth, why);
            assert.equal(c.TenantId, TENANT, why);
            assert.equal(c.ClientId, APP_ID, why);
            assert.equal(c.ClientSecret, SECRET, why);
            assert.equal(c.Rollup, true, why);
            assert.equal(c.SkipVersionCheck, true, why);
            assert.equal(c.EmitMetricsJson, true, why);
            assert.equal(c.nonInteractive, '1', why);
            assert.equal(c.OutputPathLog, join(inst.runDir, 'logs', 'pax'), why);
            assert.ok(String(c.MetricsPath).startsWith(join(inst.runDir, 'logs', 'pax-metrics-')), why);
        }
    }
    const history = (/** @type {string[]} */ ...rows) => [HEADER, ...rows];

    test('a first load in windows, then a daily run, then a day with no new interactions', async (t) => {
        const inst = install(t);
        const r = await run(inst, { now: NOW, plan: [ONE, ONE, ONE] });
        expectRun(r, { code: 0, status: 'ok', message: 'Loaded the history from 2026-03-03 to 2026-05-31. Published 2 files.' });
        assert.deepEqual(windows(r), [['2026-03-03', '2026-04-02'], ['2026-04-02', '2026-05-02'], ['2026-05-02', '2026-06-01']]);
        expectCalls(inst, r);
        assert.equal(r.calls[0].OutputPath, join(inst.runDir, 'work'));
        assert.equal(r.calls[0].IncludeUserInfo, true);
        assert.ok(!r.calls[0].AppendFile);
        for (const c of r.calls.slice(1)) assert.match(c.AppendFile, /AIO_Interactions\.csv$/);
        assert.equal(r.last.mode, 'seed');
        const loaded = history('2026-03-03,1,1', '2026-04-02,2,1', '2026-05-02,3,1');
        assert.deepEqual(data(inst, INTERACTIONS), loaded);
        assert.deepEqual(published(inst, INTERACTIONS), loaded);
        assert.deepEqual(published(inst, USERS), ['Id', 'user1', 'user2', 'user3']);
        assert.equal(r.seed, null);

        const daily = await run(inst, { now: '2026-06-02T03:00:00Z', plan: [ONE] });
        expectRun(daily, { code: 0, status: 'ok', message: 'Published 2 files.' });
        assert.equal(daily.last.mode, 'daily');
        assert.deepEqual(windows(daily), [['2026-05-26', '2026-06-02']]);
        assert.match(daily.calls[0].AppendFile, /AIO_Interactions\.csv$/);
        expectCalls(inst, daily);
        assert.deepEqual(published(inst, INTERACTIONS), [...loaded, '2026-05-26,1,1']);

        const quiet = await run(inst, { now: '2026-06-03T03:00:00Z', plan: [{ rows: 0 }] });
        expectRun(quiet, { code: 0, status: 'ok', message: 'No new Copilot interactions from 2026-05-27 to 2026-06-02. Published 2 files.' });
        assert.deepEqual(data(inst, INTERACTIONS), [...loaded, '2026-05-26,1,1']);
    });

    test('a tenant with no Copilot interactions yet finishes the first load, then starts the file when some appear', async (t) => {
        const inst = install(t);
        const r = await run(inst, { now: NOW, plan: [{ rows: 0 }, { rows: 0 }, { rows: 0 }] });
        expectRun(r, { code: 0, status: 'warning', message: "No Copilot interactions were found from 2026-03-03 to 2026-05-31, so there's nothing to publish yet." });
        assert.equal(r.last.noData, true);
        assert.ok(existsSync(join(inst.runDir, 'no-interactions.json')));
        assert.equal(published(inst, INTERACTIONS), null);
        assert.equal(r.seed, null);

        const none = await run(inst, { now: '2026-06-02T03:00:00Z', plan: [{ rows: 0, noMetrics: true }] });
        expectRun(none, { code: 0, status: 'ok', message: 'No new Copilot interactions from 2026-05-26 to 2026-06-01.' });
        assert.equal(none.last.mode, 'daily');
        assert.ok(none.calls[0].OutputPath && !none.calls[0].AppendFile, JSON.stringify(none.calls[0]));

        const first = await run(inst, { now: '2026-06-03T03:00:00Z', plan: [ONE] });
        expectRun(first, { code: 0, status: 'ok', message: 'Published 2 files.' });
        assert.equal(first.last.noData, false);
        assert.ok(!existsSync(join(inst.runDir, 'no-interactions.json')));
        assert.deepEqual(data(inst, INTERACTIONS), history('2026-05-27,1,1'));
    });

    test('a first load that was stopped carries on from its last finished window, in smaller windows', async (t) => {
        const inst = install(t);
        const r = await run(inst, { now: NOW, plan: [ONE, { rows: 1, kill: true }] });
        assert.equal(r.code, 137, explain(r));
        assert.equal(r.calls.length, 2);
        assert.equal(r.last.status, 'running', explain(r));
        assert.deepEqual(pick(r.seed, SEED_KEYS), { from: '2026-03-03', next: '2026-04-02', window: 30, loading: true, done: false, found: false, rows: 1 });

        const again = await run(inst, { now: '2026-06-01T09:00:00Z', plan: [ONE, ONE, ONE, ONE] });
        expectRun(again, { code: 0, status: 'warning', message: /^Loaded the history from 2026-03-03 to 2026-05-31\. Published 2 files\./ });
        assert.ok(again.last.warnings.includes('The last run stopped before it finished. The history carries on loading from 2026-04-02, 15 days at a time.'), explain(again));
        assert.deepEqual(starts(again), ['2026-04-02', '2026-04-17', '2026-05-02', '2026-05-17']);
        for (const c of again.calls) assert.match(c.AppendFile, /AIO_Interactions\.csv$/);
        assert.deepEqual(data(inst, INTERACTIONS), history('2026-03-03,1,1', '2026-04-02,1,1', '2026-04-17,2,1', '2026-05-02,3,1', '2026-05-17,4,1'));
        assert.equal(again.seed, null);
    });

    test('a first load that would run past its time budget publishes what it has and carries on next time', async (t) => {
        const inst = install(t);
        const slow = { rows: 1, minutes: 100 };
        const r = await run(inst, { now: NOW, plan: [slow, slow] });
        expectRun(r, { code: 0, status: 'ok', message: 'Loaded the history from 2026-03-03 to 2026-05-01. The rest loads at the next run. Published 2 files.' });
        assert.equal(r.calls.length, 2);
        assert.deepEqual(pick(r.seed, ['next', 'loading', 'rows']), { next: '2026-05-02', loading: false, rows: 2 });
        assert.equal(r.last.seed?.loaded, '2026-05-01', explain(r));
        assert.equal(r.last.noData, false);
        assert.deepEqual(published(inst, INTERACTIONS), history('2026-03-03,1,1', '2026-04-02,2,1'));
        assert.doesNotMatch(runLog(r), /Copied \S+ from |Downloaded /, 'a true first install has nothing to fetch, so it publishes as it loads');

        const rest = await run(inst, { now: '2026-06-01T08:00:00Z', plan: [ONE] });
        assert.match(runLog(rest), /Carrying on loading the history from 2026-05-02\./, explain(rest));
        expectRun(rest, { code: 0, status: 'ok', message: 'Loaded the history from 2026-03-03 to 2026-05-31. Published 2 files.' });
        assert.equal(rest.seed, null);
        assert.deepEqual(data(inst, INTERACTIONS), history('2026-03-03,1,1', '2026-04-02,2,1', '2026-05-02,1,1'));
    });

    test('a first load on a new PC keeps the published files until the whole history has loaded', async (t) => {
        const inst = install(t);
        put(join(inst.localFolder, INTERACTIONS), OLD);
        put(join(inst.localFolder, USERS), OLD_USERS);
        writeFileSync(N.seedRequestPath(inst.env), '2026-06-01T02:00:00.000Z\n');
        const slow = { rows: 1, minutes: 100 };
        const r = await run(inst, { now: NOW, plan: [slow, slow] });
        expectRun(r, {
            code: 0,
            status: 'ok',
            message: 'Loaded the history from 2026-03-03 to 2026-05-01. The rest loads at the next run; until then the published files stay as they were.',
        });
        assert.match(runLog(r), /Copied AIO_Interactions\.csv from .*Published\. It stays there as it is until the history has loaded\./, explain(r));
        assert.deepEqual(data(inst, INTERACTIONS), OLD);
        assert.deepEqual(published(inst, INTERACTIONS), OLD, 'two windows never replace the full history');
        assert.deepEqual(published(inst, USERS), OLD_USERS);
        assert.equal(r.last.noData, false);

        const rest = await run(inst, { now: '2026-06-01T08:00:00Z', plan: [ONE] });
        expectRun(rest, { code: 0, status: 'ok', message: 'Loaded the history from 2026-03-03 to 2026-05-31. Published 2 files.' });
        assert.doesNotMatch(runLog(rest), /Copied \S+ from /);
        const loaded = history('2026-03-03,1,1', '2026-04-02,2,1', '2026-05-02,1,1');
        assert.deepEqual(published(inst, INTERACTIONS), loaded);
        assert.deepEqual(data(inst, 'AIO_Interactions.previous.csv'), OLD);
        assert.equal(rest.seed, null);
    });

    test('a history stuck on one day counts the stops, says so from the second, and resets when a day loads', async (t) => {
        const inst = install(t);
        const stuck = { from: '2026-05-30', next: '2026-05-30', window: 1, loading: true, done: false, found: false, rows: null, stops: 1 };
        writeFileSync(N.seedRequestPath(inst.env), JSON.stringify(stuck));
        const r = await run(inst, { now: NOW, plan: [{ rows: 1, kill: true }] });
        assert.equal(r.code, 137, explain(r));
        const paxLogs = join(inst.runDir, 'logs', 'pax');
        const warning = `The history is stuck at 2026-05-30: 2 runs in a row stopped while they loaded that one day. This run tries it again. PAX's logs are in ${paxLogs}.`;
        assert.ok(r.last.warnings.includes(warning), explain(r));
        assert.deepEqual(pick(r.last.seed, ['next', 'window', 'stops']), { next: '2026-05-30', window: 1, stops: 2 });
        assert.deepEqual(pick(r.seed, ['next', 'window', 'loading', 'stops']), { next: '2026-05-30', window: 1, loading: true, stops: 2 });

        const day = await run(inst, { now: '2026-06-01T09:00:00Z', plan: [ONE, { rows: 1, kill: true }] });
        assert.equal(day.code, 137, explain(day));
        assert.ok(day.last.warnings.includes(warning.replace('2 runs', '3 runs')), explain(day));
        assert.deepEqual(pick(day.last.seed, ['next', 'stops']), { next: '2026-05-31', stops: 0 }, 'a day that loads resets the count');
        assert.deepEqual(pick(day.seed, ['next', 'loading', 'stops']), { next: '2026-05-31', loading: true, stops: 0 });

        const again = await run(inst, { now: '2026-06-01T15:00:00Z', plan: [ONE] });
        expectRun(again, { code: 0, status: 'warning' });
        assert.ok(again.last.warnings.includes('The last run stopped before it finished. The history carries on loading from 2026-05-31, one day at a time.'), explain(again));
        assert.equal(again.seed, null);
    });

    test("a first load's result says there's no data yet from the start, and stops saying so after a window with rows", async (t) => {
        const empty = install(t);
        const r = await run(empty, { now: NOW, plan: [{ rows: 0, kill: true }] });
        assert.equal(r.code, 137, explain(r));
        assert.equal(r.last.status, 'running', explain(r));
        assert.equal(r.last.noData, true, 'a run that was stopped on an empty tenant still says there is no data yet');

        const some = install(t);
        const s = await run(some, { now: NOW, plan: [ONE, { rows: 1, kill: true }] });
        assert.equal(s.code, 137, explain(s));
        assert.equal(s.last.noData, false, explain(s));
    });

    test("exit 10 retries the window once with -AutoCompleteness, ignoring the first attempt's log", async (t) => {
        const inst = install(t, { days: 30 });
        const plan = [{ exit: 10, rows: 1, log: ['Rollup: post-processor failed: x'] }, ONE];
        const r = await run(inst, { now: NOW, plan });
        expectRun(r, { code: 0, status: 'warning' });
        assert.deepEqual(r.calls.map((/** @type {any} */ c) => c.AutoCompleteness), [false, true]);
        assert.equal(r.last.attempts, 2, explain(r));
        assert.deepEqual(data(inst, INTERACTIONS), history('2026-05-02,2,1'));
    });

    test('a daily run whose rollup failed publishes nothing, though PAX exits 0', async (t) => {
        const inst = install(t);
        preload(inst);
        const plan = [{ rows: 1, log: ['Rollup: post-processor returned non-zero exit code 1'] }];
        const r = await run(inst, { now: '2026-06-02T03:00:00Z', plan });
        expectRun(r, { code: 1, status: 'failed', message: /^PAX's rollup failed \("Rollup: post-processor returned non-zero"\), so nothing was published\./ });
        assert.equal(r.last.mode, 'daily');
        assert.deepEqual(data(inst, INTERACTIONS), OLD);
        assert.deepEqual(published(inst, INTERACTIONS), OLD);
        assert.deepEqual(published(inst, USERS), OLD_USERS);
    });

    test("a daily run without PAX's merge line publishes nothing", async (t) => {
        const inst = install(t);
        preload(inst);
        const r = await run(inst, { now: '2026-06-02T03:00:00Z', plan: [{ rows: 1, noMerge: true }] });
        expectRun(r, { code: 1, status: 'failed', message: /^PAX didn't say it added the new days to AIO_Interactions\.csv, so nothing was published\./ });
        assert.deepEqual(data(inst, INTERACTIONS), OLD);
        assert.deepEqual(published(inst, INTERACTIONS), OLD);
    });

    test('a reload that writes no Interactions file keeps the old history and its request', async (t) => {
        const inst = install(t, { days: 30 });
        preload(inst);
        writeFileSync(N.seedRequestPath(inst.env), '2026-06-02T02:00:00.000Z\n');
        const r = await run(inst, { now: '2026-06-02T03:00:00Z', plan: [{ rows: 1, noFact: true }] });
        expectRun(r, { code: 1, status: 'failed', message: /PAX didn't write an Interactions file/ });
        assert.equal(r.last.mode, 'seed');
        assert.deepEqual(pick(r.seed, SEED_KEYS), { from: '2026-05-03', next: '2026-05-03', window: 30, loading: false, done: false, found: false, rows: null });
        assert.equal(r.last.seed?.loaded ?? null, null);
        assert.deepEqual(data(inst, INTERACTIONS), OLD);
        assert.deepEqual(published(inst, INTERACTIONS), OLD);

        const again = await run(inst, { now: '2026-06-02T09:00:00Z', plan: [ONE] });
        assert.match(runLog(again), /Carrying on loading the history from 2026-05-03\./, explain(again));
        expectRun(again, { code: 0, status: 'ok', message: 'Loaded the history from 2026-05-03 to 2026-06-01. Published 2 files.' });
        assert.deepEqual(data(inst, INTERACTIONS), history('2026-05-03,1,1'));
        assert.deepEqual(data(inst, 'AIO_Interactions.previous.csv'), OLD);
        assert.equal(again.seed, null);
    });

    test('a failed window keeps the windows before it, and the next run carries on from there', async (t) => {
        const inst = install(t);
        const r = await run(inst, { now: NOW, plan: [ONE, { rows: 1, exit: 40 }] });
        expectRun(r, { code: 40, status: 'failed' });
        assert.equal(r.last.exitCode, 40);
        assert.deepEqual(pick(r.seed, ['next', 'loading']), { next: '2026-04-02', loading: false });

        const again = await run(inst, { now: '2026-06-01T09:00:00Z', plan: [ONE, ONE] });
        assert.match(runLog(again), /Carrying on loading the history from 2026-04-02\./, explain(again));
        assert.deepEqual(starts(again), ['2026-04-02', '2026-05-02']);
        for (const c of again.calls) assert.match(c.AppendFile, /AIO_Interactions\.csv$/);
        expectRun(again, { code: 0, status: 'ok', message: 'Loaded the history from 2026-03-03 to 2026-05-31. Published 2 files.' });
        assert.deepEqual(data(inst, INTERACTIONS), history('2026-03-03,1,1', '2026-04-02,1,1', '2026-05-02,2,1'));
    });

    test('an empty early window is skipped, and the Agent 365 file starts with the first rows', async (t) => {
        const inst = install(t, { agent365: true });
        const r = await run(inst, { now: NOW, plan: [{ rows: 0, quiet: true }, ONE, ONE] });
        expectRun(r, { code: 0, status: 'ok', message: 'Loaded the history from 2026-03-03 to 2026-05-31. Published 3 files.' });
        for (const c of r.calls.slice(0, 2)) {
            assert.ok(c.OutputPath && !c.AppendFile, JSON.stringify(c));
            assert.equal(c.IncludeAgent365Info, true);
        }
        assert.match(r.calls[2].AppendFile, /AIO_Interactions\.csv$/);
        assert.match(r.calls[2].AppendAgent365Info, /AIO_Agent365\.csv$/);
        assert.deepEqual(data(inst, INTERACTIONS), history('2026-04-02,2,1', '2026-05-02,3,1'));
        assert.deepEqual(data(inst, AGENTS), ['Id', 'agent2', 'agent3']);
    });
});
