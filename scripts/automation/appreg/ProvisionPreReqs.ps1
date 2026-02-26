#############################################################
# Script to create an app registration and configure all permissions
# needed for the AI-in-One Dashboard automation scripts.
#
# Run this once as a setup step, interactively as a Global Admin.
#
# What this script does:
#   Step 1 - Creates the app registration (or finds existing by clientId or display name)
#   Step 2 - Adds required Graph application permissions:
#              - AuditLog.Read.All
#              - AuditLogsQuery.Read.All
#              - Sites.Selected
#   Step 3 - Admin-consents all permissions
#   Step 4 - Creates SharePoint site (or uses existing), doc library and queue list
#   Step 5 - Grants the app write access to the specific SharePoint site
#
# Contact alexgrover@microsoft.com for questions
#
# Permissions required to RUN this script (delegated):
#   - Application.ReadWrite.All  (to create/update the app registration)
#   - AppRoleAssignment.ReadWrite.All (to grant admin consent)
#   - Sites.FullControl.All (to grant site-level permissions)
#############################################################

#############################################################
# Parameters
#############################################################

param (
    [Parameter(Mandatory)]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [string]$TenantName,            # e.g. "contoso" (without .onmicrosoft.com / .sharepoint.com)

    [string]$SharePointSiteId = "", # If provided, skips site creation and uses this existing site

    [string]$SiteAlias = "ai-in-one-dashboard",         # URL alias for new site, e.g. /sites/ai-in-one-dashboard
    [string]$SiteDisplayName = "AI-in-One Dashboard",   # Display name for new site
    [string]$DocLibName = "CopilotReports",             # Document library name for CSV reports
    [string]$QueueListName = "AuditQueryQueue",         # List name for the audit query queue

    [string]$ClientId = "",         # If provided, skips app creation and uses this existing app registration
    [string]$AppDisplayName = "AI-in-One Dashboard Automation",
    [string]$SitePermissionRole = "write"   # 'read' or 'write'
)

#############################################################
# Dependencies
#############################################################

foreach ($moduleName in @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Applications')) {
    if (-not (Get-Module -ListAvailable -Name $moduleName)) {
        try {
            Write-Output "Installing module: $moduleName..."
            Install-Module -Name $moduleName -Force -AllowClobber -Scope CurrentUser
        }
        catch {
            Write-Error "Failed to install module '$moduleName': $_"
            exit 1
        }
    }
    Write-Output "Importing module: $moduleName..."
    Import-Module -Name $moduleName -Force
}

#############################################################
# Connect (delegated, interactive)
#############################################################

Write-Output "Connecting to Microsoft Graph (interactive)..."
Write-Output "Note: you will see TWO dialogs. This is expected — first a sign-in prompt, then an"
Write-Output "      admin consent prompt to approve the high-privilege permissions being requested."
Connect-MgGraph -TenantId $TenantId `
    -Scopes "Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All", "Sites.FullControl.All" `
    -NoWelcome
Write-Output "Connected."

#############################################################
# Known IDs
#############################################################

# Microsoft Graph service principal app ID (constant across all tenants)
$graphAppId = "00000003-0000-0000-c000-000000000000"

# Graph app role IDs (application permissions)
$appRoles = @{
    "AuditLog.Read.All"          = "b0afded3-3588-46d8-8b3d-9842eff778da"
    "AuditLogsQuery.Read.All"    = "5e1e9171-754d-478c-812c-f1755a9a4c2d"
    "Sites.Selected"             = "883ea226-0bf2-4a8f-9f9d-92c9162a727d"
}

#############################################################
# Step 1 - Create or find the app registration
#############################################################

Write-Output ""
Write-Output "=== Step 1: App Registration ==="

if (-not [string]::IsNullOrWhiteSpace($ClientId)) {
    # Use existing app registration — skip creation
    Write-Output "ClientId provided — looking up existing app registration: $ClientId..."
    $app = Get-MgApplication -Filter "appId eq '$ClientId'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $app) {
        Write-Error "No app registration found with ClientId '$ClientId'."
        exit 1
    }
    Write-Output "Found app registration: $($app.DisplayName) ($($app.AppId))"
} else {
    $app = Get-MgApplication -Filter "displayName eq '$AppDisplayName'" -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($app) {
        Write-Output "Found existing app registration: $($app.DisplayName) ($($app.AppId))"
    } else {
        Write-Output "Creating app registration: $AppDisplayName..."

        # Build the required resource access entries for Microsoft Graph
        $requiredAccess = @{
            resourceAppId  = $graphAppId
            resourceAccess = $appRoles.Values | ForEach-Object {
                @{ id = $_; type = "Role" }
            }
        }

        $app = New-MgApplication -DisplayName $AppDisplayName `
            -SignInAudience "AzureADMyOrg" `
            -RequiredResourceAccess @($requiredAccess)

        Write-Output "Created app registration: $($app.DisplayName) ($($app.AppId))"
    }
}

#############################################################
# Step 2 - Ensure required Graph permissions are declared on the app
#############################################################

Write-Output ""
Write-Output "=== Step 2: Ensuring Graph permissions are declared ==="

# Get current required resource access
$currentApp     = Get-MgApplication -ApplicationId $app.Id
$graphResource  = $currentApp.RequiredResourceAccess | Where-Object { $_.ResourceAppId -eq $graphAppId }
$currentRoleIds = @()
if ($graphResource) {
    $currentRoleIds = $graphResource.ResourceAccess | Where-Object { $_.Type -eq "Role" } | Select-Object -ExpandProperty Id
}

$missingRoles = $appRoles.GetEnumerator() | Where-Object { $_.Value -notin $currentRoleIds }

if (-not $missingRoles) {
    Write-Output "All required permissions already declared — skipping."
} else {
    Write-Output "Adding missing permissions: $($missingRoles.Key -join ', ')"

    # Build full list (existing + missing)
    $allRoleIds = ($currentRoleIds + ($missingRoles | Select-Object -ExpandProperty Value)) | Sort-Object -Unique

    $updatedResourceAccess = @{
        resourceAppId  = $graphAppId
        resourceAccess = $allRoleIds | ForEach-Object { @{ id = $_; type = "Role" } }
    }

    # Preserve any non-Graph resource access entries
    $otherResources = $currentApp.RequiredResourceAccess | Where-Object { $_.ResourceAppId -ne $graphAppId }
    $allResources   = @($updatedResourceAccess) + @($otherResources)

    Update-MgApplication -ApplicationId $app.Id -RequiredResourceAccess $allResources
    Write-Output "Permissions declared on app registration."
}

#############################################################
# Step 3 - Admin consent all permissions (app role assignments)
#############################################################

Write-Output ""
Write-Output "=== Step 3: Granting admin consent ==="

# Ensure a service principal exists for the app
$appSp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue
if (-not $appSp) {
    Write-Output "Creating service principal for the app..."
    $appSp = New-MgServicePrincipal -AppId $app.AppId
    Write-Output "Service principal created: $($appSp.Id)"
} else {
    Write-Output "Found existing service principal: $($appSp.Id)"
}

# Get the Graph service principal
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'"

# Get already-consented roles
$existingAssignments = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $appSp.Id |
    Where-Object { $_.ResourceId -eq $graphSp.Id }
$existingRoleIds = $existingAssignments | Select-Object -ExpandProperty AppRoleId

foreach ($role in $appRoles.GetEnumerator()) {
    if ($role.Value -in $existingRoleIds) {
        Write-Output "$($role.Key) — already consented, skipping."
    } else {
        Write-Output "Consenting $($role.Key)..."
        $body = @{
            principalId = $appSp.Id
            resourceId  = $graphSp.Id
            appRoleId   = $role.Value
        }
        New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $appSp.Id -BodyParameter $body | Out-Null
        Write-Output "$($role.Key) — granted."
    }
}

#############################################################
# Step 4 - Create or find SharePoint site, doc library and queue list
#############################################################

Write-Output ""
Write-Output "=== Step 4: SharePoint Site, Document Library and Queue List ==="

# --- 4a: Site ---
if (-not [string]::IsNullOrWhiteSpace($SharePointSiteId)) {
    Write-Output "SharePointSiteId provided — looking up existing site..."
    try {
        $site = Invoke-MgGraphRequest -Method GET `
            -Uri "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId"
        Write-Output "Found site: $($site.displayName) ($($site.id))"
        $SharePointSiteId = $site.id
    }
    catch {
        Write-Error "Failed to find site with ID '$SharePointSiteId': $_"
        exit 1
    }
} else {
    Write-Output "No SharePointSiteId provided — checking for existing site at /sites/$SiteAlias..."

    $existingSite = $null
    try {
        $existingSite = Invoke-MgGraphRequest -Method GET `
            -Uri "https://graph.microsoft.com/v1.0/sites/$TenantName.sharepoint.com:/sites/$SiteAlias" `
            -ErrorAction SilentlyContinue
    }
    catch {
        # Site doesn't exist yet — will create below
    }

    if ($existingSite) {
        Write-Output "Found existing site: $($existingSite.displayName) ($($existingSite.id))"
        $SharePointSiteId = $existingSite.id
    } else {
        Write-Output "Creating SharePoint Communication Site: $SiteDisplayName..."

        $siteCreationBody = @{
            request = @{
                Title               = $SiteDisplayName
                Url                 = "https://$TenantName.sharepoint.com/sites/$SiteAlias"
                Lcid                = 1033
                ShareByEmailEnabled = $false
                Classification      = ""
                Description         = "Site for AI-in-One Dashboard automation reports and queues"
                WebTemplate         = "STS#3"
                SiteDesignId        = "00000000-0000-0000-0000-000000000000"
                HubSiteId           = "00000000-0000-0000-0000-000000000000"
                Owner               = ""
            }
        } | ConvertTo-Json -Depth 5

        try {
            $createResult = Invoke-MgGraphRequest -Method POST `
                -Uri "https://$TenantName-admin.sharepoint.com/_api/SPSiteManager/create" `
                -Body $siteCreationBody `
                -ContentType "application/json;odata=verbose"

            if ($createResult.SiteStatus -eq 2) {
                Write-Output "Site created successfully."
            } elseif ($createResult.SiteStatus -eq 1) {
                Write-Output "Site provisioning in progress — waiting up to 2 minutes..."
                $retries = 0
                do {
                    Start-Sleep -Seconds 15
                    $retries++
                    $statusCheck = Invoke-MgGraphRequest -Method POST `
                        -Uri "https://$TenantName-admin.sharepoint.com/_api/SPSiteManager/status" `
                        -Body (@{ "url" = "https://$TenantName.sharepoint.com/sites/$SiteAlias" } | ConvertTo-Json) `
                        -ContentType "application/json;odata=verbose"
                } while ($statusCheck.SiteStatus -ne 2 -and $retries -lt 8)

                if ($statusCheck.SiteStatus -ne 2) {
                    Write-Error "Site provisioning timed out. Provision manually and re-run with -SharePointSiteId."
                    exit 1
                }
            }
        }
        catch {
            Write-Error "Failed to create SharePoint site: $_"
            exit 1
        }

        $newSite = Invoke-MgGraphRequest -Method GET `
            -Uri "https://graph.microsoft.com/v1.0/sites/$TenantName.sharepoint.com:/sites/$SiteAlias"
        $SharePointSiteId = $newSite.id
        Write-Output "Site ID: $SharePointSiteId"
    }
}

# --- 4b: Document Library for CSV reports ---
Write-Output ""
Write-Output "Checking for document library '$DocLibName'..."

$existingLibrary = $null
try {
    $allLists = Invoke-MgGraphRequest -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/lists?`$filter=displayName eq '$DocLibName'"
    $existingLibrary = $allLists.value | Select-Object -First 1
}
catch { }

if ($existingLibrary) {
    Write-Output "Document library '$DocLibName' already exists (ID: $($existingLibrary.id)) — skipping."
    $docLibId = $existingLibrary.id
} else {
    Write-Output "Creating document library '$DocLibName'..."
    $docLibBody = @{
        displayName = $DocLibName
        description = "Stores Copilot interaction CSV reports generated by the automation runbooks"
        list        = @{ template = "documentLibrary" }
    } | ConvertTo-Json -Depth 5

    $docLib   = Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/lists" `
        -Body $docLibBody `
        -ContentType "application/json"
    $docLibId = $docLib.id
    Write-Output "Document library created. ID: $docLibId"
}

# Look up the Drive ID for the document library
Write-Output "Looking up Drive ID for document library '$DocLibName'..."
try {
    $drive   = Invoke-MgGraphRequest -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/lists/$docLibId/drive"
    $driveId = $drive.id
    Write-Output "Drive ID: $driveId"
}
catch {
    Write-Warning "Could not retrieve Drive ID: $_"
    $driveId = "<not found — check manually>"
}

# --- 4c: Queue list for audit query IDs ---
Write-Output ""
Write-Output "Checking for queue list '$QueueListName'..."

$existingQueueList = $null
try {
    $allLists2 = Invoke-MgGraphRequest -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/lists?`$filter=displayName eq '$QueueListName'"
    $existingQueueList = $allLists2.value | Select-Object -First 1
}
catch { }

if ($existingQueueList) {
    Write-Output "Queue list '$QueueListName' already exists (ID: $($existingQueueList.id)) — skipping."
    $queueListId = $existingQueueList.id
} else {
    Write-Output "Creating queue list '$QueueListName'..."

    $queueListBody = @{
        displayName = $QueueListName
        description = "Queue of AuditLogQuery IDs pending processing by the GetCopilotInteractions runbook"
        list        = @{ template = "genericList" }
    } | ConvertTo-Json -Depth 5

    $queueList   = Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/lists" `
        -Body $queueListBody `
        -ContentType "application/json"
    $queueListId = $queueList.id
    Write-Output "Queue list created. ID: $queueListId"

    # Add QueryId column (single line of text)
    Write-Output "Adding 'QueryId' column to queue list..."
    $columnBody = @{
        name        = "QueryId"
        displayName = "QueryId"
        text        = @{}
    } | ConvertTo-Json -Depth 5

    Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/lists/$queueListId/columns" `
        -Body $columnBody `
        -ContentType "application/json" | Out-Null

    Write-Output "'QueryId' column added."
}

#############################################################
# Step 5 - Grant site-level permission on SharePoint
#############################################################

Write-Output ""
Write-Output "=== Step 5: Granting site-level SharePoint permission ==="
Write-Output "Site ID   : $SharePointSiteId"
Write-Output "Role      : $SitePermissionRole"
Write-Output "App       : $($app.DisplayName)"

$existingSitePerms = Invoke-MgGraphRequest -Method GET `
    -Uri "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/permissions"

$alreadyGranted = $existingSitePerms.value | Where-Object {
    $_.grantedToIdentities.application.id -eq $app.AppId -or
    $_.grantedToIdentity.application.id   -eq $app.AppId
}

if ($alreadyGranted) {
    Write-Output "App already has site-level permission — skipping."
} else {
    $permBody = @{
        roles               = @($SitePermissionRole)
        grantedToIdentities = @(
            @{
                application = @{
                    id          = $app.AppId
                    displayName = $app.DisplayName
                }
            }
        )
    } | ConvertTo-Json -Depth 5

    $result = Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/permissions" `
        -Body $permBody `
        -ContentType "application/json"

    Write-Output "Site permission granted. Permission ID: $($result.id)"
}

#############################################################
# Summary
#############################################################

Write-Output ""
Write-Output "=== Setup complete ==="
Write-Output "App Display Name : $($app.DisplayName)"
Write-Output "Client ID        : $($app.AppId)"
Write-Output "Permissions      : AuditLog.Read.All, AuditLogsQuery.Read.All, Sites.Selected (admin consented)"
Write-Output "SPO Site ID      : $SharePointSiteId"
Write-Output "Doc Library      : $DocLibName (ID: $docLibId)"
Write-Output "Drive ID         : $driveId"
Write-Output "Queue List       : $QueueListName (ID: $queueListId)"
Write-Output "SPO Site Access  : '$SitePermissionRole' on $SharePointSiteId"
Write-Output ""
Write-Output "Use the values above in your runbook parameters."