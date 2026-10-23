// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sourcePaths } from '../packaging/payload.js';
import { SCRIPT_NAME, ZIP_NAME, installScript, scriptCommand, scriptSha256, zipUrl } from '../packaging/script.js';
import { INSTALL_DOCS } from '../packaging/signing.js';
import { NOTEBOOKS, NOTEBOOKS_DIR } from '../src/catalog.js';
import { CLOUD_SHELL_ENV, CLOUD_SHELL_SHIM, EXE_ENV, INSTALLED_NODE_ENV, LAUNCHER_ENV, SCRIPT_COMMAND, SCRIPT_SHIM, SCRIPT_URL } from '../src/launch.js';
import { REPO } from '../src/update-check.js';

/** @param {string} rel */
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const TEMPLATE = read('../packaging/launcher/install.ps1');
const LAUNCHER = read('../packaging/launcher/Launcher.cs');
const VERSION = JSON.parse(read('../package.json')).version;
const HASH = '748ed2f139d14f8babdabea867a809c4fe6da12ef9da3d07ecd93dba616224db';
const V = {
  version: '1.2.3', sha256: HASH.toUpperCase(), id: '1.2.3-748ed2f139', repo: 'octo/hub', sizeMb: 151.6,
  commit: 'D793F32'.padEnd(40, 'A'), nodeVersion: '24.11.1', sourcePaths: sourcePaths(),
};
/** The command that runs V's install.ps1. */
const AGAIN = 'irm https://github.com/octo/hub/releases/download/installer-v1.2.3/install.ps1 | iex';
const CLOUD = TEMPLATE.slice(TEMPLATE.indexOf('if ($CloudShell) {'), TEMPLATE.indexOf("if ($env:OS -ne 'Windows_NT')"));
const WINDOWS = TEMPLATE.slice(TEMPLATE.indexOf("if ($env:OS -ne 'Windows_NT')"));

/**
 * The paths a filled-in install.ps1 checks out in Cloud Shell.
 * @param {string} script
 */
function checkedOut(script) {
  const m = /^\s*\$SourcePaths = @\((.*)\)$/m.exec(script);
  assert.ok(m, 'finds $SourcePaths');
  return [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((p) => p[1].replaceAll("''", "'"));
}

test('script: fills in every placeholder', () => {
  const s = installScript(TEMPLATE, V);
  assert.doesNotMatch(s, /\{\{/);
  assert.equal(scriptSha256(s), HASH);
  assert.match(s, /^\s*\$Version = '1\.2\.3'$/m);
  assert.match(s, /^\s*\$Id = '1\.2\.3-748ed2f139'$/m);
  assert.ok(s.includes(`$ZipUrl = 'https://github.com/octo/hub/releases/download/installer-v1.2.3/${ZIP_NAME}'`));
  assert.ok(s.includes(`$ZipName = '${ZIP_NAME}'`));
  assert.match(s, /^\s*\$SizeMb = '152'$/m);
  assert.match(s, /^\s*\$Commit = 'd793f32a{33}'$/m);
  assert.match(s, /^\s*\$NodeVersion = '24\.11\.1'$/m);
  assert.ok(s.includes("$RepoUrl = 'https://github.com/octo/hub.git'"));
  assert.deepEqual(checkedOut(s), V.sourcePaths);
});

test("script: every link names this release, since the repo's Latest release is the dashboard's", () => {
  const s = installScript(TEMPLATE, V);
  assert.ok(s.includes(`\r\n  ${AGAIN}\r\n`), 'the example at the top');
  assert.ok(s.includes(`$Again = '${AGAIN}'`), 'the command that runs this version again');
  assert.ok(s.includes("$Releases = 'https://github.com/octo/hub/releases?q=installer-v'"), 'where the current installer is');
  for (const text of [TEMPLATE, LAUNCHER]) {
    assert.doesNotMatch(text, /releases\/latest/);
    // Doc links go to the installer's user guide.
    const links = text.match(/\/blob\//g)?.length ?? 0;
    assert.ok(links > 0);
    assert.equal(text.split(`/${INSTALL_DOCS}`).length - 1, links);
  }
});

test('script: is plain ASCII with Windows line endings, for Windows PowerShell 5.1', () => {
  const s = installScript(TEMPLATE, V);
  assert.ok([...s].every((ch) => ch.charCodeAt(0) < 0x7f));
  assert.doesNotMatch(s, /[^\r]\n/);
  assert.throws(() => installScript(`${TEMPLATE}\n# caf\u00e9`, V), /plain ASCII/);
});

test('script: Node.js code passed with -e has no double quotes, which Windows PowerShell 5.1 drops', () => {
  const evals = [...TEMPLATE.matchAll(/ -e '((?:[^']|'')*)'/g)].map((m) => m[1]);
  assert.ok(evals.length > 0);
  for (const code of evals) assert.doesNotMatch(code, /"/, code);
});

test('script: refuses values that would break out of a PowerShell string', () => {
  assert.throws(() => installScript(TEMPLATE, { ...V, sha256: 'abc' }), /isn't a SHA-256/);
  assert.throws(() => installScript(TEMPLATE, { ...V, version: "1'; rm -r ~; '" }), /letters, digits/);
  assert.throws(() => installScript(TEMPLATE, { ...V, repo: 'octo/hub/../x' }), /owner\/name/);
  assert.throws(() => installScript(TEMPLATE, { ...V, commit: 'd793f32' }), /full commit ID/);
  assert.throws(() => installScript(TEMPLATE, { ...V, commit: "main'; rm -r ~; '".padEnd(40, 'a') }), /full commit ID/);
  assert.throws(() => installScript(TEMPLATE, { ...V, nodeVersion: '24' }), /Node\.js version/);
  assert.throws(() => installScript('{{NOPE}}', V), /unknown placeholder \{\{NOPE\}\}/);
});

test('script: refuses Cloud Shell paths that git would read as patterns, or that aren\'t plain repo paths', () => {
  assert.throws(() => installScript(TEMPLATE, { ...V, sourcePaths: [] }), /paths to check out/);
  for (const bad of ['', '/', 'installer/', '/installer/*', '/a?b', '/a[b]', '/a\\b', '/a"b', '/a`b', '/a ', '//a', '/a//b', '/a/../b', '/./a', '/a/..', '/caf\u00e9', '/a\nb', '/a\tb']) {
    assert.throws(() => installScript(TEMPLATE, { ...V, sourcePaths: ['/installer/', bad] }), /isn't a plain repo path starting with \//, JSON.stringify(bad));
  }
  const s = installScript(TEMPLATE, { ...V, sourcePaths: ['/installer/', "/it's/a b.ipynb", '/.github/x'] });
  assert.ok(s.includes("$SourcePaths = @('/installer/', '/it''s/a b.ipynb', '/.github/x')"), 'single quotes are doubled');
});

test('script: Cloud Shell checks out the installer and every file it deploys, and nothing archived', () => {
  const paths = checkedOut(installScript(TEMPLATE, V));
  assert.equal(paths[0], '/installer/');
  for (const nb of NOTEBOOKS) {
    const file = `/${posix.join(nb.dir ?? NOTEBOOKS_DIR, nb.file)}`;
    assert.ok(paths.includes(file), file);
  }
  assert.equal(paths.filter((p) => p.endsWith('/pipeline-content.json')).length, 1, 'the pipeline');
  assert.equal(paths.filter((p) => p.endsWith('.pbit')).length, 1, 'the Power BI template');
  assert.equal(new Set(paths).size, paths.length);
  for (const p of paths) assert.doesNotMatch(p, /(^|\/)archive\/|Archived Templates/i, p);
});

test('script: in Azure Cloud Shell, fetches just those paths at the pinned commit and runs the installer in the terminal', () => {
  assert.ok(CLOUD.length > 1000, 'the Cloud Shell branch comes before the Windows-only check');
  assert.ok(CLOUD.includes('$SourcePaths = @({{SOURCE_PATHS}})'));
  // A sparse, blobless fetch of one commit: the repo also holds videos, decks and archived templates.
  const git = CLOUD.split(/\r?\n/).map((l) => l.trim()).filter((l) => /\bgit (init|-C) /.test(l) && !l.includes('rev-parse'));
  assert.deepEqual(git, [
    "Invoke-Checked 'git init' { git init --quiet $partial }",
    "Invoke-Checked 'git remote add' { git -C $partial remote add origin $RepoUrl }",
    "Invoke-Checked 'git sparse-checkout' { git -C $partial sparse-checkout set --no-cone @SourcePaths }",
    "Invoke-Checked 'git fetch' { git -C $partial fetch --quiet --depth 1 --filter=blob:none origin $Commit }",
    "Invoke-Checked 'git checkout' { git -C $partial -c advice.detachedHead=false checkout --quiet FETCH_HEAD }",
  ], 'checks each step, and filters through a named remote');
  assert.match(CLOUD, /rev-parse HEAD[\s\S]*\$head -ne \$Commit/, 'checks it got the commit it asked for');
  assert.match(CLOUD, /npm ci --omit=dev/);
  assert.match(CLOUD, /SHASUMS256\.txt[\s\S]*Get-FileHash[\s\S]*\$got -ne \$want/, 'checks the Node.js it downloads');
  assert.doesNotMatch(CLOUD, /--ui/, 'Cloud Shell has no browser for the wizard');
  assert.match(CLOUD, /\$env:AI_IN_ONE_LAUNCHER = 'cloudshell'/);
  assert.match(CLOUD, /export AI_IN_ONE_LAUNCHER=cloudshell/);
  assert.ok(CLOUD.includes("$AioHome = Join-Path $HOME '.ai-in-one'"));
  assert.ok(CLOUD.includes("$Shim = Join-Path $AioHome 'aio-install'"));
  assert.ok(CLOUD.includes("$Work = Join-Path $HOME 'ai-in-one'"));
  assert.ok(CLOUD.includes('$AIO_ROOT/installer/bin/aio-install.js'));
  assert.ok(CLOUD.includes("(Join-Path $Root 'installer/bin/aio-install.js')"));
});

test('script: -UseInstalledNode runs the installer with an installed Node.js and keeps the same folders and command', () => {
  assert.match(TEMPLATE, /\$UseInstalledNode = \$env:AI_IN_ONE_USE_INSTALLED_NODE -eq '1'/);
  assert.match(TEMPLATE, /\$a -eq '-UseInstalledNode'\) \{ \$UseInstalledNode = \$true \}/);
  // The same Node.js check serves Cloud Shell and Windows.
  assert.equal(TEMPLATE.match(/Get-Command node /g)?.length, 1);
  assert.match(CLOUD, /\$sys = Get-SystemNode/);
  assert.match(WINDOWS, /\(\$sys\.Major -eq 22 -and \$sys\.Minor -ge 13\) -or \$sys\.Major -eq 24/, 'the LTS lines the installer supports');
  assert.match(WINDOWS, /-p 'process\.arch'[\s\S]*\$arch -ne 'x64'/, 'the native packages in the zip are x64');
  // Same unpacked folder, install record and command, so either route finds the other's install.
  assert.equal(WINDOWS.match(/\$Root = Join-Path \$AioHome \$Id/g)?.length, 1);
  assert.equal(WINDOWS.match(/\$Work = Join-Path \$Docs 'AI in One'/g)?.length, 1);
  assert.match(WINDOWS, /\$node = \$Installed\r?\n\s*if \(-not \$node\) \{ \$node = Join-Path \$Root 'node\\node\.exe' \}/);
  assert.match(WINDOWS, /& \$node \$script @Forward/);
  assert.match(WINDOWS, /set `"AIO_NODE=\$Installed`"/);
  assert.match(WINDOWS, /'set "AI_IN_ONE_USE_INSTALLED_NODE=1"'/);
  assert.match(WINDOWS, /"%AIO_NODE%" "%AIO_ROOT%\\f\\installer\\bin\\aio-install\.js" %\*/);
  assert.doesNotMatch(WINDOWS, /"%AIO_ROOT%\\node\\node\.exe" "%AIO_ROOT%/, 'the command runs whichever Node.js install.ps1 used');
  assert.match(WINDOWS, /\$Again = "`\$env:AI_IN_ONE_USE_INSTALLED_NODE = '1'; \$Again"/);
});

test('script: names the release files, folders and settings for AI in One', () => {
  assert.equal(SCRIPT_NAME, 'install.ps1');
  assert.equal(ZIP_NAME, 'AIInOneInstaller.zip');
  assert.equal(scriptCommand('octo/hub', '1.2.3'), AGAIN);
  assert.equal(zipUrl('octo/hub', '1.2.3'), 'https://github.com/octo/hub/releases/download/installer-v1.2.3/AIInOneInstaller.zip');
  assert.ok(WINDOWS.includes("$AioHome = Join-Path $env:LOCALAPPDATA 'AIInOne'"));
  assert.ok(WINDOWS.includes("$Shim = Join-Path $AioHome 'aio-install.cmd'"));
  assert.ok(WINDOWS.includes("$script = Join-Path $Root 'f\\installer\\bin\\aio-install.js'"));
  assert.ok(WINDOWS.includes('$copy = Join-Path $env:TEMP "ai-in-one-node-$PID.exe"'), 'the copy of node.exe that removes the folder it ran from');
  assert.ok(WINDOWS.includes('Your install record in Documents\\AI in One is still there.'));
  // The exe unpacks to the same folder and keeps the install record in the same place.
  assert.ok(LAUNCHER.includes('private const string HomeFolder = "AIInOne";'));
  assert.ok(LAUNCHER.includes('private const string WorkFolder = "AI in One";'));
  for (const [option, name] of [['ZipPath', 'AI_IN_ONE_ZIP'], ['Proxy', 'AI_IN_ONE_PROXY'], ['UseInstalledNode', 'AI_IN_ONE_USE_INSTALLED_NODE']]) {
    assert.ok(TEMPLATE.includes(`$a -eq '-${option}'`), option);
    assert.ok(TEMPLATE.includes(`$env:${name}`), name);
  }
});

// Fails until src/launch.js and src/update-check.js have the AI in One names and the pinned
// install.ps1 URL (port spec, section 6).
test('script: commands, URLs and settings agree between the launchers and the installer', () => {
  assert.equal(REPO, 'microsoft/AI-in-One-Dashboard');
  assert.equal(SCRIPT_URL, `https://github.com/${REPO}/releases/download/installer-v${VERSION}/install.ps1`);
  assert.equal(SCRIPT_COMMAND, scriptCommand(REPO, VERSION));
  assert.equal(SCRIPT_SHIM, '& $env:LOCALAPPDATA\\AIInOne\\aio-install.cmd');
  assert.equal(CLOUD_SHELL_SHIM, '~/.ai-in-one/aio-install');
  for (const name of [LAUNCHER_ENV, CLOUD_SHELL_ENV, INSTALLED_NODE_ENV]) assert.ok(TEMPLATE.includes(`$env:${name}`), name);
  assert.ok(LAUNCHER.includes(`psi.EnvironmentVariables["${EXE_ENV}"] = "1";`), EXE_ENV);
  assert.ok(LAUNCHER.includes(`private const string Docs = "https://github.com/${REPO}/${INSTALL_DOCS}";`), 'the exe links to the user guide');
});

test('script: the whole launcher runs in a script block, so iex leaves nothing behind in the session', () => {
  const body = TEMPLATE.replace(/^<#[\s\S]*?#>\s*/, '');
  assert.match(body, /^& \{/);
  assert.match(body, /\} @args\r?\nif \(\$MyInvocation\.MyCommand\.Path -and \$LASTEXITCODE\) \{ exit \$LASTEXITCODE \}\r?\n$/);
  assert.doesNotMatch(TEMPLATE, /\bparam\s*\(/i, 'a param block would bind installer commands such as "status" as launcher options');
  assert.match(TEMPLATE, /AI_IN_ONE_LAUNCHER=pwsh/);
  assert.match(TEMPLATE, /AI_IN_ONE_LAUNCHER = 'pwsh'/);
});

test('script: the command it leaves behind escapes the | in the install command for cmd.exe', () => {
  assert.match(WINDOWS, /\$AgainCmd = \$Again -replace '\\\|', '\^\|'/);
  assert.doesNotMatch(WINDOWS, /echo [^\r\n]*\$Again\b(?!Cmd)/);
});

test('script: the command it leaves behind quotes every path, which may hold spaces, & or brackets', () => {
  const start = TEMPLATE.indexOf('  $shimNode =');
  const end = TEMPLATE.indexOf('  if (-not $Forward.Count)', start);
  assert.ok(start >= 0 && end > start, 'finds the block that writes the command');
  const block = TEMPLATE.slice(start, end);
  assert.match(block, /Set-Content -LiteralPath \$Shim -Encoding Ascii -Value @\(/);
  // The lines of aio-install.cmd, from the block's PowerShell strings.
  const lines = [...block.matchAll(/'((?:[^']|'')*)'|"((?:[^"`]|`.)*)"/g)]
    .map((m) => (m[1] !== undefined ? m[1].replaceAll("''", "'") : m[2].replace(/`(.)/g, '$1')));
  for (const want of ['set "AIO_ROOT=%~dp0$Id"', 'if not exist "%AIO_ROOT%\\.unpacked" (', 'if not exist "%AIO_NODE%" (', 'set "AI_IN_ONE_LAUNCHER=pwsh"', 'cd /d "$Work"']) {
    assert.ok(lines.includes(want), want);
  }
  for (const [i, line] of lines.entries()) if (/^\s*echo /.test(line)) assert.equal(lines[i + 1], '  exit /b 1', line);
  assert.equal(
    lines.at(-1),
    'if "%~1"=="" ("%AIO_NODE%" "%AIO_ROOT%\\f\\installer\\bin\\aio-install.js" --ui) else ("%AIO_NODE%" "%AIO_ROOT%\\f\\installer\\bin\\aio-install.js" %*)',
    "opens the wizard when given nothing, passes anything else on as typed, and ends with Node.js, so its exit code is the command's",
  );
  for (const line of lines) {
    for (const m of line.matchAll(/%~dp0|%AIO_ROOT%|%AIO_NODE%|\$Installed|\$NodeDir|\$Work/g)) {
      assert.equal(line.slice(0, m.index).split('"').length % 2, 0, `${m[0]} isn't in quotes: ${line}`);
    }
  }
});

test("script: a pinned release whose zip has gone says so and points to the current installer", () => {
  const s = installScript(TEMPLATE, V);
  const start = s.indexOf('      $request = @{ Uri = $ZipUrl');
  const end = s.lastIndexOf('}', s.indexOf('    # Get-FileHash'));
  assert.ok(start >= 0 && end > start, 'finds the download block');
  const block = s.slice(start, end);
  assert.doesNotMatch(block, /\biex\b|Invoke-Expression|\[scriptblock\]::Create/i, "it doesn't run another release by itself");
  // Windows PowerShell 5.1 and PowerShell 7 both put the response on the exception.
  assert.ok(block.includes('try { $status = [int]$_.Exception.Response.StatusCode } catch { }'));
  const gone = block.indexOf('if ($status -eq 404) { throw "Release installer-v$Version is no longer available, so this copy of install.ps1 can\'t download its zip. Get the current installer from $Releases." }');
  const other = block.indexOf('throw "Couldn\'t download $ZipUrl ($($_.Exception.Message)).');
  assert.ok(gone > 0 && other > gone, 'a 404 gets its own message, ahead of the general one');
  assert.doesNotMatch(block.slice(gone, other), /\$Again|proxy/i, "the same command would fail again, and a proxy isn't to blame");
  assert.ok(block.slice(other).includes('If a proxy blocks it, download $ZipName from the release in a browser and run this again with -ZipPath, or set `$env:AI_IN_ONE_ZIP to its path.'));
});

test('script: a node.exe blocked by device policy says what to do instead of the raw error', () => {
  const s = installScript(TEMPLATE, V);
  const start = s.indexOf('  # AppLocker or App Control may block node.exe');
  const end = s.indexOf('  # Remove what other versions unpacked', start);
  assert.ok(start >= 0 && end > start, 'finds the probe');
  const probe = s.slice(start, end);
  assert.ok(probe.includes('try { & $node --version | Out-Null } catch { $ranNode = $_ }'));
  // AppLocker and software restriction policies say so in the message; App Control only in the Win32 error code.
  assert.ok(probe.includes("-match 'group policy|Application Control|Device Guard|blocked by your administrator|software restriction'"));
  assert.ok(probe.includes('while ($e) { if ($e.NativeErrorCode -eq 1260 -or $e.NativeErrorCode -eq 4551) { $byPolicy = $true }; $e = $e.InnerException }'));
  assert.ok(LAUNCHER.includes('return code == 1260 || code == 4551;'), 'the exe spots the same errors');
  assert.ok(probe.includes('if (-not $byPolicy) { throw $ranNode }'), 'other errors stay as they are');
  assert.ok(probe.includes(`$docs = 'https://github.com/octo/hub/${INSTALL_DOCS}'`));
  const installed = /if \(\$Installed\) \{ throw "(Your organisation's policy blocks [^\r\n]*)" \}/.exec(probe)?.[1] ?? '';
  assert.match(installed, /so the installer can't run here\. Don't work around it: run it in Azure Cloud Shell \(\$docs#locked-down-tenant--azure-cloud-shell\), or ask your IT team\.$/);
  assert.doesNotMatch(installed, /Company Portal|\$Again/, 'IT gave this Node.js already');
  const bundled = /\r\n {4}throw "(Your organisation's policy blocks the Node\.js that comes with the installer [^\r\n]*)"\r\n/.exec(probe)?.[1] ?? '';
  assert.match(bundled, /Don't work around it\./);
  assert.match(bundled, /If your IT team offers Node\.js, for example in Company Portal, install the x64 LTS version, then run: `\$env:AI_IN_ONE_USE_INSTALLED_NODE = '1'; \$Again \(\$docs#it-approved-nodejs\)\./);
  assert.match(bundled, /Otherwise run the installer in Azure Cloud Shell \(\$docs#locked-down-tenant--azure-cloud-shell\), or ask your IT team\.$/);
});

test('script: moving the unpacked installer into place retries while antivirus holds the files', () => {
  const win = TEMPLATE.slice(TEMPLATE.indexOf("Write-Host 'Unpacking it."));
  const move = win.slice(0, win.indexOf('# The zip\'s node.exe stays unpacked'));
  assert.match(move, /for \(\$try = 1; ; \$try\+\+\) \{\r?\n\s*try \{ Rename-Item -LiteralPath \$partial -NewName \$Id; break \} catch \{/);
  assert.match(move, /if \(\$try -ge 10 -or \(Test-Path -LiteralPath \(Join-Path \$Root \$Marker\)\)\) \{ throw \}\r?\n\s*Start-Sleep -Seconds 2/);
  assert.match(move, /Remove-Tree \$partial \$Installed\r?\n\s*throw "Couldn't finish unpacking the installer: .*Run the command again/, 'removes the half-unpacked folder and says what to do');
  assert.equal(move.match(/Rename-Item -LiteralPath \$partial/g)?.length, 1);
});

test('script: cleanup falls back to Remove-Item when policy blocks node.exe', () => {
  const tree = TEMPLATE.slice(TEMPLATE.indexOf('function Remove-Tree'), TEMPLATE.indexOf('function Find-Node'));
  const tryAt = tree.indexOf('try {');
  const nodeAt = tree.indexOf('& $Node -e ');
  const catchAt = tree.indexOf('} catch { }');
  assert.ok(tryAt >= 0 && tryAt < nodeAt && nodeAt < catchAt, tree);
  assert.match(tree, /Remove-Item -LiteralPath \$Dir -Recurse -Force/);
});

test("script: doesn't tell people to get around their organisation's policy", () => {
  assert.doesNotMatch(TEMPLATE, /ExecutionPolicy|Bypass|Run anyway|Keep anyway|AllSigned/i);
  assert.match(TEMPLATE, /ask your IT team/);
});

/** Windows PowerShell 5.1 on Windows, and PowerShell 7 wherever it's installed. */
function powerShells() {
  /** @type {string[]} */
  const shells = [];
  const windows = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (process.platform === 'win32' && existsSync(windows)) shells.push(windows);
  if (spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '1'], { windowsHide: true, timeout: 60_000 }).status === 0) shells.push('pwsh');
  return shells;
}

/**
 * Parses the script on stdin without running any of it, then prints the parse errors and the
 * paths $SourcePaths holds. It has no double quotes, so it reaches PowerShell as written.
 */
const PARSE = [
  '$t = [Console]::In.ReadToEnd()',
  '$e = $null',
  '$a = [System.Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$e)',
  "foreach ($x in $e) { 'E:' + $x.Extent.StartLineNumber + ': ' + ($x.Message -replace '\\s+', ' ') }",
  "$s = $a.Find({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] -and [string]$args[0].Left -eq '$SourcePaths' }, $true)",
  "if ($s) { foreach ($p in @($s.Right.Expression.SafeGetValue())) { 'P:' + $p } }",
].join('; ');

test('script: the filled-in launcher parses in Windows PowerShell 5.1 and PowerShell 7, with the paths it was given', (t) => {
  const shells = powerShells();
  if (!shells.length) {
    t.skip('needs PowerShell');
    return;
  }
  const odd = ['/installer/', "/it's here/a b.ipynb", "/x'); Write-Host ('y", '/Classic Editions/3. Fabric/x.json'];
  for (const shell of shells) {
    for (const paths of [V.sourcePaths, odd]) {
      const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', PARSE], {
        input: installScript(TEMPLATE, { ...V, sourcePaths: paths }), encoding: 'utf8', windowsHide: true, timeout: 60_000,
      });
      assert.equal(r.status, 0, `${shell}: ${r.error?.message ?? r.stderr}`);
      const out = r.stdout.split(/\r?\n/);
      assert.deepEqual(out.filter((l) => l.startsWith('E:')), [], `${shell} finds errors`);
      assert.deepEqual(out.filter((l) => l.startsWith('P:')).map((l) => l.slice(2)), paths, `${shell} reads other paths`);
    }
  }
});
