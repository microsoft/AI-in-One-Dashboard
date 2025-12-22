#############################################################
# Script to deploy and configure Automation Account and assign permissions
# Contact alexgrover@microsoft.com for questions

#############################################################
# Variables
#############################################################

$siteId = "2bef5df0-2973-4edf-85d7-882f1532e0c8" # 👈 Update with actual Site ID
$displayName = "AI in One Dashboard Automation Account"
$resourceGroup = "AI-in-One-Dashboard-RG" # 👈 Update with actual Resource Group name
$deploymentName = 'all-in-one-dashboard-' + (Get-Random -Minimum 1000 -Maximum 9999)
$runbooksPath = ".\runbooks"

#############################################################
# Dependencies
#############################################################

# Check if Az.Resources module is already installed
$module = Get-Module -ListAvailable | Where-Object { $_.Name -eq 'Az.Resources' }

if ($module -eq $null) {
    try {
        Write-Host "Installing module..."
        Install-Module -Name Az.Resources -Force -AllowClobber -Scope CurrentUser
    } 
    catch {
        Write-Host "Failed to install module: $_"
        exit
    }
}

#############################################################
# Functions
#############################################################

# Connect to Microsoft Graph
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

    GrantSharePointPermissions $siteId $clientId $sp.DisplayName
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

# Helper function to check if role is already assigned
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

function UploadRunbooks ($automationAccount) {
    Write-Host "Uploading runbooks from $runbooksPath to Automation account $automationAccount in RG $resourceGroup"

    if (-not (Test-Path $runbooksPath)) {
        Write-Error "Runbooks path not found: $runbooksPath"
        exit 1
    }

    Get-ChildItem -Path $runbooksPath -Filter *.ps1 | ForEach-Object {
        $file = $_.FullName
        $name = $_.BaseName
        Write-Host "Uploading $name from $file"
        Set-AzAutomationRunbook -ResourceGroupName $resourceGroup -AutomationAccountName $automationAccount -Name $name -Path $file -Type PowerShell -Force
        Publish-AzAutomationRunbook -ResourceGroupName $resourceGroup -AutomationAccountName $automationAccount -Name $name -Force
    }

    Write-Host "Runbooks uploaded successfully."
}

#############################################################
# Main Script Execution
#############################################################

$scriptRoot = Split-Path -Parent $PSCommandPath
$templateFile = Join-Path $scriptRoot 'main.bicep'

if (-not (Test-Path $templateFile)) {
    Write-Error "Could not find template file: $templateFile"
    return
}

if (-not (Get-AzContext)) {
    Connect-AzAccount | Out-Null
}

try {
    Write-Host "Deploying $templateFile to resource group $resourceGroup using Az PowerShell..."

    $deployment = New-AzResourceGroupDeployment -ResourceGroupName $resourceGroup -TemplateFile $templateFile -Name $deploymentName -Verbose
}
catch {
    Write-Error "Deployment failed: $_"
    exit 1
}

# Get the Automation Account name from deployment outputs
$automationAccount = $deployment.Outputs.AutomationAccountName.Value

# Upload runbooks to the Automation Account
UploadRunbooks $automationAccount

# Get the Automation Account's principal ID
$principalId = $deployment.Outputs.AutomationPrincipalId.Value

# Connect to Microsoft Graph
ConnectToGraph

# Assign required roles to the Automation Account
AssignRoles $principalId

Write-Host "Deployment and configuration completed successfully."


