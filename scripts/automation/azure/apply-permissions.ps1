#############################################################
# Script to assign Graph API permissions to a Service Principal / Managed Identity
# Contact alexgrover@microsoft.com for questions
#
# Usage:
#   .\apply-permissions.ps1 -PrincipalId "<objectId>" -SiteId "<siteId>"
#############################################################

param(
    [Parameter(Mandatory = $true)]
    [string]$PrincipalId,

    [Parameter(Mandatory = $true)]
    [string]$SiteId
)

#############################################################
# Dependencies
#############################################################

$appgraphModule = Get-Module -ListAvailable | Where-Object { $_.Name -eq 'Microsoft.Graph.Applications' }

if ($appgraphModule -eq $null) {
    try {
        Write-Host "Installing module..."
        Install-Module -Name Microsoft.Graph.Applications -Force -AllowClobber -Scope CurrentUser
    }
    catch {
        Write-Host "Failed to install module: $_"
        exit
    }
}

$siteGraphModule = Get-Module -ListAvailable | Where-Object { $_.Name -eq 'Microsoft.Graph.Sites' }

if ($siteGraphModule -eq $null) {
    try {
        Write-Host "Installing module..."
        Install-Module -Name Microsoft.Graph.Sites -Force -AllowClobber -Scope CurrentUser
    }
    catch {
        Write-Host "Failed to install module: $_"
        exit
    }
}

#############################################################
# Functions
#############################################################

function ConnectToGraph {
    try {
        Connect-MgGraph -NoWelcome -Scopes `
            "Sites.FullControl.All", `
            "Application.Read.All", `
            "AppRoleAssignment.ReadWrite.All"
        Write-Output "Connected to Microsoft Graph."
    }
    catch {
        Write-Error "Failed to connect to Microsoft Graph: $_"
        exit 1
    }
}

function AssignRoles($principalId) {

    $graphAppId = "00000003-0000-0000-c000-000000000000"
    $graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'"

    # Site.Selected role
    TryAssignRoles $principalId $graphSp "Sites.Selected"
    # Assign Reports.Read.All
    TryAssignRoles $principalId $graphSp "Reports.Read.All"
    # Assign AuditLogsQuery.Read.All
    TryAssignRoles $principalId $graphSp "AuditLogsQuery.Read.All"

    # Get clientId from principalId 👈 Used for SharePoint site grant
    $sp = Get-MgServicePrincipal -ServicePrincipalId $principalId
    $clientId = $sp.AppId

    GrantSharePointPermissions $SiteId $clientId $sp.DisplayName
}

function TryAssignRoles($principalId, $servicePrincipal, $appRoleValue) {

    $sitesSelectedRole = $servicePrincipal.AppRoles | Where-Object {
        $_.Value -eq $appRoleValue -and $_.AllowedMemberTypes -contains "Application"
    }
    if ($sitesSelectedRole -and -not (Test-RoleAssigned $sitesSelectedRole.Id $servicePrincipal.Id $existingAssignments)) {
        $newRole = New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $principalId `
            -PrincipalId $principalId `
            -ResourceId $servicePrincipal.Id `
            -AppRoleId $sitesSelectedRole.Id
    }
}

function Test-RoleAssigned($roleId, $resourceId, $assignments) {
    return $assignments | Where-Object {
        $_.AppRoleId -eq $roleId -and $_.ResourceId -eq $resourceId
    }
}

function GrantSharePointPermissions($siteId, $clientId, $displayName) {

    $permissionBody = @{
        roles               = @("write")
        grantedToIdentities = @(
            @{
                application = @{
                    id          = $clientId       # Must be CLIENT ID here, not objectId
                    displayName = $displayName
                }
            }
        )
    }

    $newSPOPerms = New-MgSitePermission -SiteId $siteId -BodyParameter $permissionBody
}

#############################################################
# Main Script Execution
#############################################################

Write-Host "Connecting to Microsoft Graph..."
ConnectToGraph

Write-Host "Assigning roles to principal: $PrincipalId"
AssignRoles $PrincipalId

Write-Host "Permissions assigned successfully."
