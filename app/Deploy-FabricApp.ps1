<#
.SYNOPSIS
  Deploys the AI in One app to a Microsoft Fabric workspace as a Fabric App.

.DESCRIPTION
  Nothing to install first. The script downloads what it needs into
  %LOCALAPPDATA%\AI-in-One-App: a portable copy of Node.js (only when Node.js 22.13 or later
  isn't already installed), the Fabric App deploy tool and the ready-built app page. Then it signs
  you in and deploys. Run it again to update the app in place.

  The app keeps no data in Fabric. People open it from the workspace and drop in their PAX CSVs,
  which are read in their browser.

  Run it from PowerShell, either from a copy of this file:
    .\Deploy-FabricApp.ps1
  or straight from GitHub:
    irm https://raw.githubusercontent.com/microsoft/AI-in-One-Dashboard/main/app/Deploy-FabricApp.ps1 | iex

.PARAMETER WorkspaceUrl
  The Fabric workspace to deploy to: paste its URL from the browser
  (https://app.fabric.microsoft.com/groups/<workspace-id>/...). Asked for when not given.

.PARAMETER TenantId
  Your Entra tenant ID. Only needed when your account can sign in to more than one tenant and the
  workspace URL has no ctid.

.PARAMETER AppHtml
  A local copy of AI-in-One-App.html to deploy instead of the latest one from GitHub.
#>
param(
  [string]$WorkspaceUrl,
  [string]$TenantId,
  [string]$AppHtml
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AppId = 'ai-in-one'
$AppName = 'AI in One'
$AppSource = 'https://raw.githubusercontent.com/microsoft/AI-in-One-Dashboard/main/app/download/AI-in-One-App.html'
$RayfinVersion = '1.35.1'
$MinNode = [version]'22.13'
$Root = Join-Path $env:LOCALAPPDATA 'AI-in-One-App'
$Project = Join-Path $Root 'fabric'

function Step([string]$Message) { Write-Host "`n> $Message" -ForegroundColor Cyan }
$GuidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

# 1. Where to deploy
if (-not $WorkspaceUrl) {
  Write-Host "Open your Fabric workspace in the browser and copy its URL."
  Write-Host "It must be on Fabric capacity (F2 or larger, or a trial); My workspace won't work."
  $WorkspaceUrl = Read-Host 'Workspace URL'
}
if ($WorkspaceUrl -match "groups/($GuidPattern)") { $WorkspaceId = $Matches[1] }
elseif ($WorkspaceUrl -match "^$GuidPattern$") { $WorkspaceId = $WorkspaceUrl }
else { throw "That isn't a workspace URL. It looks like https://app.fabric.microsoft.com/groups/<workspace-id>/..." }
if (-not $TenantId -and $WorkspaceUrl -match "ctid=($GuidPattern)") { $TenantId = $Matches[1] }

# 2. Node.js: use the installed one when it's new enough, otherwise a portable copy
Step 'Checking for Node.js'
$NodeDir = $null
$installed = Get-Command node -ErrorAction SilentlyContinue
if ($installed) {
  $v = [version]((& node --version).TrimStart('v'))
  if ($v -ge $MinNode) { $NodeDir = Split-Path $installed.Source; Write-Host "  Using Node.js $v" }
}
if (-not $NodeDir) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $existing = Get-ChildItem $Root -Directory -Filter "node-v*-win-$arch" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing) { $NodeDir = $existing.FullName; Write-Host "  Using the portable Node.js in $NodeDir" }
  else {
    $release = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') |
      Where-Object { $_.lts -and $_.files -contains "win-$arch-zip" -and [version]$_.version.TrimStart('v') -ge $MinNode } |
      Select-Object -First 1
    if (-not $release) { throw 'Could not find a Node.js download. Install Node.js 22.13 or later from https://nodejs.org and run this again.' }
    $name = "node-$($release.version)-win-$arch"
    Write-Host "  Downloading a portable Node.js $($release.version) (about 35 MB, nothing is installed)"
    New-Item -ItemType Directory -Force $Root | Out-Null
    $zip = Join-Path $Root "$name.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/$name.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $Root -Force
    Remove-Item $zip
    $NodeDir = Join-Path $Root $name
  }
}
$env:PATH = "$NodeDir;$env:PATH"

# 3. The Fabric App deploy tool
Step 'Getting the Fabric App deploy tool'
New-Item -ItemType Directory -Force (Join-Path $Project 'rayfin'), (Join-Path $Project 'site') | Out-Null
$cli = Join-Path $Project 'node_modules\@microsoft\rayfin-cli\scripts\main'
$pkg = Join-Path $Project 'node_modules\@microsoft\rayfin-cli\package.json'
if (-not (Test-Path $pkg) -or (Get-Content $pkg -Raw | ConvertFrom-Json).version -ne $RayfinVersion) {
  Set-Content (Join-Path $Project 'package.json') "{ `"name`": `"$AppId-fabric`", `"private`": true }"
  Push-Location $Project
  try {
    & (Join-Path $NodeDir 'npm.cmd') install --no-audit --no-fund --loglevel=error "@microsoft/rayfin-cli@$RayfinVersion"
    if ($LASTEXITCODE) { throw 'Installing the deploy tool failed. Check your internet connection and run this again.' }
  } finally { Pop-Location }
}
else { Write-Host "  Already have it" }

# 4. The app page and its Fabric App settings
Step 'Getting the app'
$page = Join-Path $Project 'site\index.html'
if ($AppHtml) { Copy-Item $AppHtml $page -Force }
else { Invoke-WebRequest $AppSource -OutFile $page }
Write-Host "  $([math]::Round((Get-Item $page).Length / 1KB)) KB"

# Rayfin adds the app's hosting URL to allowedRedirectUris on first deploy, so keep that list.
$yml = Join-Path $Project 'rayfin\rayfin.yml'
$redirects = @()
if (Test-Path $yml) { $redirects = Select-String -Path $yml -Pattern '^\s+- (https://\S+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } }
$redirectLines = if ($redirects) { "    allowedRedirectUris:`n" + (($redirects | ForEach-Object { "      - $_" }) -join "`n") + "`n" } else { '' }
$config = @"
id: $AppId
name: $AppName
version: 1.0.0
services:
  auth:
    enabled: true
    fabric:
      enabled: true
$redirectLines  data:
    enabled: false
  storage:
    enabled: false
  staticHosting:
    enabled: true
    folder: site
    indexDocument: index.html
    assetAccess: protected
  functions:
    enabled: false
"@
[IO.File]::WriteAllText($yml, $config.Replace("`r`n", "`n"))

# 5. Deploy
Step 'Deploying to your workspace. Sign in when your browser asks.'
$upArgs = @($cli, 'up', '--workspace-id', $WorkspaceId, '--yes')
if ($TenantId) { $upArgs += @('--tenant', $TenantId) }
Push-Location $Project
try {
  & (Join-Path $NodeDir 'node.exe') @upArgs
  if ($LASTEXITCODE) { throw 'The deploy failed. The messages above say why.' }
} finally { Pop-Location }

Write-Host "`n$AppName is in your workspace. Use the Open in Fabric portal link above." -ForegroundColor Green
Write-Host 'To let others open it, share the item with them or give them a workspace role.'
Write-Host 'Run this script again any time to update the app.'
