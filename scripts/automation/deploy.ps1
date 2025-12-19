## Automation account
## Storage (queue)

# Helper function to check if role is already assigned
function Test-RoleAssigned($roleId, $resourceId, $assignments) {
    return $assignments | Where-Object {
        $_.AppRoleId -eq $roleId -and $_.ResourceId -eq $resourceId
    }
}


Connect-MgGraph -NoWelcome -Scopes `
    "Sites.FullControl.All", `
    "Application.Read.All", `
    "AppRoleAssignment.ReadWrite.All"


$principalId = "b5d9a8f5-b965-4f43-aea8-ff50d682efc7" # 👈 Must be the OBJECT ID of the service principal
$graphAppId = "00000003-0000-0000-c000-000000000000"
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'"


## Site.Selected role
$sitesSelectedRole = $graphSp.AppRoles | Where-Object {
    $_.Value -eq "Sites.Selected" -and $_.AllowedMemberTypes -contains "Application"
}
if ($sitesSelectedRole -and -not (Test-RoleAssigned $sitesSelectedRole.Id $graphSp.Id $existingAssignments)) {
    $newRole = New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $principalId `
        -PrincipalId $principalId `
        -ResourceId $graphSp.Id `
        -AppRoleId $sitesSelectedRole.Id
}

# Assign Reports.Read.All
$reportsReadAllRole = $graphSp.AppRoles | Where-Object {
    $_.Value -eq "Reports.Read.All" -and $_.AllowedMemberTypes -contains "Application"
}
if ($reportsReadAllRole -and -not (Test-RoleAssigned $reportsReadAllRole.Id $graphSp.Id $existingAssignments)) {
    $newRole = New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $principalId `
        -PrincipalId $principalId `
        -ResourceId $graphSp.Id `
        -AppRoleId $reportsReadAllRole.Id
}

# Assign AuditLogsQuery.Read.All
$auditLogsQueryReadAllRole = $graphSp.AppRoles | Where-Object {
    $_.Value -eq "AuditLogsQuery.Read.All" -and $_.AllowedMemberTypes -contains "Application"
}
if ($auditLogsQueryReadAllRole -and -not (Test-RoleAssigned $auditLogsQueryReadAllRole.Id $graphSp.Id $existingAssignments)) {
    $newRole = New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $principalId `
        -PrincipalId $principalId `
        -ResourceId $graphSp.Id `
        -AppRoleId $auditLogsQueryReadAllRole.Id
}

### 3. Grant SharePoint permission using Sites.Selected model ###
$siteId = "2bef5df0-2973-4edf-85d7-882f1532e0c8" # 👈 Update with actual Site ID
$clientId = "8025703a-0d1f-404e-8900-edfbcb00a9f0" # 👈 Must be the APPLICATION ID of the service principal
$displayName = "AI in One Dashboard Automation Account"

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

## need to give the automation account permission to read/write to storage account
## Storage Queue Data Contributor role