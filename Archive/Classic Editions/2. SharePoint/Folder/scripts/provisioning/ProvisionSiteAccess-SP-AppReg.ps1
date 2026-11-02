#############################################################
# SharePoint path - Site access provisioning helper
#
# One-shot interactive script. Grants a target app registration "write"
# access to a specific SharePoint site (Sites.Selected workflow), then
# prints the Site ID and Drive ID needed by the unattended SP-AppReg
# scripts.
#
# Run this ONCE per tenant + site combination, by an account with one of:
#   - SharePoint Administrator
#   - Cloud Application Administrator
#   - Privileged Role Administrator
#   - Global Administrator
#
# (Compliance Administrator alone is NOT enough - the script needs to
#  consent to Sites.FullControl.All to grant the app's site permission.)
#
# Usage:
#   .\ProvisionSiteAccess-SP-AppReg.ps1 `
#       -TenantId "<your-tenant-guid>" `
#       -SiteHost "<tenant>.sharepoint.com" `
#       -AppClientId "<your-app-client-id>" `
#       -AppDisplayName "<your-app-display-name>"
#
# For non-root sites, also pass -SitePath e.g. "/sites/CopilotAnalytics".
#
# Outputs:
#   - Site ID  (Graph composite, e.g. host,siteGuid,webGuid)
#   - Drive ID (Graph drive ID for the default Documents library)
#   - Permission status (granted / already-granted)
#
# Contact: keithmcgrane@microsoft.com
#############################################################

param (
    [Parameter(Mandatory)]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [string]$SiteHost,                 # e.g. contoso.sharepoint.com

    [string]$SitePath = "",            # e.g. /sites/CopilotAnalytics. Leave empty for root site.

    [Parameter(Mandatory)]
    [string]$AppClientId,              # The app registration that needs write access

    [Parameter(Mandatory)]
    [string]$AppDisplayName
)

#############################################################
# Dependencies
#############################################################

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
    Write-Output "Installing Microsoft.Graph.Authentication module..."
    Install-Module -Name Microsoft.Graph.Authentication -Force -AllowClobber -Scope CurrentUser
}
Import-Module Microsoft.Graph.Authentication -Force

#############################################################
# Connect (delegated, interactive) - needs Sites.FullControl.All
#############################################################

Write-Output "Connecting to Microsoft Graph (interactive) - needs Sites.FullControl.All..."
Write-Output "If you can't consent to this scope, you don't have the right role - see script comments."
try {
    Connect-MgGraph -TenantId $TenantId -Scopes "Sites.FullControl.All" -NoWelcome -ErrorAction Stop
}
catch {
    Write-Error "Failed to connect to Microsoft Graph: $_"
    exit 1
}

# Verify the consented scope is actually present
$ctx = Get-MgContext
if (-not $ctx -or $ctx.Scopes -notcontains "Sites.FullControl.All") {
    Write-Error "Sites.FullControl.All was not consented. Cannot proceed - re-run as an account with the right role."
    exit 1
}
Write-Output "Connected as: $($ctx.Account)"
Write-Output "Scopes: $($ctx.Scopes -join ', ')"

#############################################################
# Step 1 - Look up the site
#############################################################

Write-Output ""
Write-Output "=== Step 1: Look up site ==="

$siteRef = if ([string]::IsNullOrWhiteSpace($SitePath)) {
    "${SiteHost}:"
} else {
    # Trim leading slash from SitePath if present, then build the Graph site ref
    $cleanPath = "/$($SitePath.TrimStart('/'))"
    "${SiteHost}:${cleanPath}:"
}

Write-Output "Looking up: https://graph.microsoft.com/v1.0/sites/$siteRef"

try {
    $site = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/sites/$siteRef" -ErrorAction Stop
}
catch {
    Write-Error "Failed to look up site: $_"
    exit 1
}

Write-Output "Site found:"
Write-Output "  Display name : $($site.displayName)"
Write-Output "  Web URL      : $($site.webUrl)"
Write-Output "  Site ID      : $($site.id)"

#############################################################
# Step 2 - Look up the Documents drive
#############################################################

Write-Output ""
Write-Output "=== Step 2: Look up document library (drive) ==="

try {
    $drives = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/sites/$($site.id)/drives" -ErrorAction Stop
}
catch {
    Write-Error "Failed to enumerate drives: $_"
    exit 1
}

if (-not $drives.value -or $drives.value.Count -eq 0) {
    Write-Error "No document libraries found on this site."
    exit 1
}

# Prefer the default Documents library; fall back to first drive
$defaultDrive = $drives.value | Where-Object { $_.name -eq "Documents" -or $_.name -eq "Shared Documents" } | Select-Object -First 1
if (-not $defaultDrive) {
    $defaultDrive = $drives.value | Select-Object -First 1
}

Write-Output "Drive found:"
Write-Output "  Name     : $($defaultDrive.name)"
Write-Output "  Drive ID : $($defaultDrive.id)"

#############################################################
# Step 3 - Grant the app write access to this site
#############################################################

Write-Output ""
Write-Output "=== Step 3: Grant app write access to site ==="

# Check if the app already has permission on this site
try {
    $existingPerms = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/sites/$($site.id)/permissions" -ErrorAction Stop
}
catch {
    Write-Error "Failed to enumerate site permissions: $_"
    exit 1
}

$alreadyGranted = $existingPerms.value | Where-Object {
    ($_.grantedToIdentities.application.id -contains $AppClientId) -or
    ($_.grantedToIdentity.application.id -eq $AppClientId)
}

if ($alreadyGranted) {
    Write-Output "App $AppClientId already has site-level permission - skipping grant."
} else {
    Write-Output "Granting 'write' role to app $AppDisplayName ($AppClientId)..."

    $body = @{
        roles               = @("write")
        grantedToIdentities = @(
            @{
                application = @{
                    id          = $AppClientId
                    displayName = $AppDisplayName
                }
            }
        )
    } | ConvertTo-Json -Depth 5

    try {
        $result = Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/sites/$($site.id)/permissions" `
            -Body $body `
            -ContentType "application/json" `
            -ErrorAction Stop
        Write-Output "Permission granted. Permission ID: $($result.id)"
    }
    catch {
        Write-Error "Failed to grant site permission: $_"
        exit 1
    }
}

#############################################################
# Summary - copy these values into the SP-AppReg scripts
#############################################################

Write-Output ""
Write-Output "============================================================"
Write-Output " Setup complete - copy these values into the SP-AppReg scripts"
Write-Output "============================================================"
Write-Output ""
Write-Output "  -SharePointSiteId  $($site.id)"
Write-Output "  -DriveId           $($defaultDrive.id)"
Write-Output ""
Write-Output "Site URL: $($site.webUrl)"
Write-Output "Drive name: $($defaultDrive.name)"
Write-Output ""
Write-Output "App $AppDisplayName ($AppClientId) now has 'write' access on this specific site."
Write-Output "It cannot access any other site in this tenant."
Write-Output ""
