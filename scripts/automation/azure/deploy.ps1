#############################################################
# Script to deploy and configure Automation Account and assign permissions
# Contact alexgrover@microsoft.com for questions

#############################################################
# Variables
#############################################################

$siteId = "0cfcc973-02f9-4a5b-b458-5bc1ca896d00" # 👈 Update with actual Site ID
$displayName = "AI in One Dashboard Automation Account"
$resourceGroup = "auditautomation" # 👈 Update with actual Resource Group name
$deploymentName = 'all-in-one-dashboard-ag'
$runbooksPath = ".\runbooks"
$queueName = "auditsearchidqueue"

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

    $runbookFiles = Get-ChildItem -Path $runbooksPath -Filter '*.ps1' -File

    foreach ($runbookFile in $runbookFiles) {
        $file = $runbookFile.FullName
        $name = $runbookFile.BaseName
        Write-Host "Uploading $name from $file"

        try {


            #Import-AzAutomationRunbook -ResourceGroupName $resourceGroup -AutomationAccountName $automationAccount -Path $file -Name $name -Type PowerShell -Force -ErrorAction Stop
            
            Upload-RunbookViaRest -ResourceGroup $resourceGroup -AutomationAccount $automationAccount -RunbookName $name -FilePath $file -RunbookType 'PowerShell' -RuntimeEnvironmentName 'ps74' -ApiVersion '2024-10-23'
            
            Publish-AzAutomationRunbook -ResourceGroupName $resourceGroup -AutomationAccountName $automationAccount -Name $name -ErrorAction Stop
            Write-Host "Uploaded and published runbook: $name"
        }
        catch {
            Write-Error ("Failed to upload runbook {0}: {1}" -f $name, $_)
            exit 1
        }
    }

    Write-Host "Runbooks uploaded successfully."
}

function ExecuteBicep {

    $scriptRoot = Split-Path -Parent $PSCommandPath
    $templateFile = Join-Path $scriptRoot 'main.bicep'
    $compiledTemplateFile = Join-Path $scriptRoot 'main.compiled.json'

    if (-not (Test-Path $templateFile)) {
        Write-Error "Could not find template file: $templateFile"
        exit 1
    }

    try {

        # Always compile first so we hard-fail on any bicep errors (and avoid Az's dynamic-parameter parsing issues)
        $null = Get-Command bicep -ErrorAction Stop
        Write-Host "Compiling Bicep template: $templateFile"
        $bicepOutput = & bicep build $templateFile --outfile $compiledTemplateFile 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Bicep build failed:\n$bicepOutput"
        }
        if (-not (Test-Path $compiledTemplateFile)) {
            throw "Bicep build did not produce expected file: $compiledTemplateFile"
        }

        Write-Host "Deploying $compiledTemplateFile to resource group $resourceGroup using Az PowerShell..."

        # Edit this hashtable to match the parameter names expected by your main.bicep
        $templateParameters = @{
            namePrefix = $deploymentName
            queueName  = $queueName
        }
        # Use a hashtable directly (straightforward for scripting)
        Write-Host "Using TemplateParameterObject with values: $($templateParameters | Out-String)"
        $deployment = New-AzResourceGroupDeployment -ResourceGroupName $resourceGroup -TemplateFile $compiledTemplateFile -TemplateParameterObject $templateParameters -Name $deploymentName -Verbose -ErrorAction Stop
    }
    catch {
        Write-Error ("Deployment failed: {0}`n{1}" -f $_, ($_.Exception | Format-List * -Force | Out-String))
        exit 1
    }
    return $deployment
}

function Get-DeploymentOutputValue {
    param(
        [Parameter(Mandatory = $true)]$Deployment,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if (-not $Deployment) {
        throw "Deployment result was null."
    }

    $outputs = $Deployment.Outputs
    if (-not $outputs) {
        throw "Deployment did not return any outputs. ProvisioningState=$($Deployment.ProvisioningState)"
    }

    # Outputs can be a hashtable or a PSCustomObject depending on Az version
    $outputItem = $null
    if ($outputs -is [System.Collections.IDictionary]) {
        $outputItem = $outputs[$Name]
    } else {
        $outputItem = $outputs.$Name
    }

    if (-not $outputItem) {
        $available = @()
        if ($outputs -is [System.Collections.IDictionary]) {
            $available = $outputs.Keys
        } else {
            $available = ($outputs | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name)
        }
        throw "Output '$Name' was not found. Available outputs: $($available -join ', ')"
    }

    if ($null -ne $outputItem.Value) { return $outputItem.Value }
    if ($null -ne $outputItem.value) { return $outputItem.value }
    return $outputItem
}

function Upload-RunbookViaRest {
    param(
        [Parameter(Mandatory = $true)][string] $ResourceGroup,
        [Parameter(Mandatory = $true)][string] $AutomationAccount,
        [Parameter(Mandatory = $true)][string] $RunbookName,
        [Parameter(Mandatory = $true)][string] $FilePath,
        [string] $RunbookType = 'PowerShell',
        [string] $RuntimeEnvironmentName = 'ps74',
        [string] $ApiVersion = '2024-10-23'
    )

    $subsId = (Get-AzContext).Subscription.Id
    if (-not $subsId) { throw "No active Az context. Run Connect-AzAccount." }

    $runbookResourcePath = "/subscriptions/$subsId/resourceGroups/$ResourceGroup/providers/Microsoft.Automation/automationAccounts/$AutomationAccount/runbooks/$RunbookName?api-version=$ApiVersion"
    $contentPath = "/subscriptions/$subsId/resourceGroups/$ResourceGroup/providers/Microsoft.Automation/automationAccounts/$AutomationAccount/runbooks/$RunbookName/content?api-version=$ApiVersion"
    $runtimeEnvResourceId = "/subscriptions/$subsId/resourceGroups/$ResourceGroup/providers/Microsoft.Automation/automationAccounts/$AutomationAccount/runtimeEnvironments/$RuntimeEnvironmentName"

    Write-Host "Uploading runbook content (no publish): $RunbookName"

    # 1) Check existing runbook
    try {
        $existingResp = Invoke-AzRest -Path $runbookResourcePath -Method Get -ErrorAction Stop
        $existing = ($existingResp.Content | ConvertFrom-Json)
        $existingType = $existing.properties.runbookType
    }
    catch {
        if ($_.Exception.Response -and ($_.Exception.Response.StatusCode -eq 404)) {
            $existing = $null
            $existingType = $null
        }
        else { throw $_ }
    }

    # 2) If exists and kind differs, delete it (to allow recreation with correct kind)
    if ($existing -and $existingType -and ($existingType -ne $RunbookType)) {
        Write-Host "Existing runbook '$RunbookName' is type '$existingType' (desired: $RunbookType). Deleting to recreate..."
        Invoke-AzRest -Path $runbookResourcePath -Method Delete -ErrorAction Stop
        # small pause for deletion to propagate
        Start-Sleep -Seconds 2
        $existing = $null
    }

    # 3) Create or update runbook metadata (PUT). Using runtimeEnvironment resourceId is most compatible.
    $runbookBody = @{
        properties = @{
            runbookType = $RunbookType
            runtimeEnvironment = $runtimeEnvResourceId
            draft = @{
                inEdit = $true
                description = "Uploaded by script (content only)."
            }
        }
    } | ConvertTo-Json -Depth 12

    Write-Host "Creating/updating runbook metadata..."
    Invoke-AzRest -Path $runbookResourcePath -Method Put -Payload $runbookBody -ContentType 'application/json' -ErrorAction Stop

    # 4) Upload runbook content (raw script text) to /content (no publish)
    if (-not (Test-Path $FilePath)) { throw "Runbook file not found: $FilePath" }
    $scriptText = Get-Content -Path $FilePath -Raw -ErrorAction Stop

    Write-Host "Uploading script content to runbook content endpoint..."
    Invoke-AzRest -Path $contentPath -Method Put -Payload $scriptText -ContentType 'text/plain' -ErrorAction Stop

    Write-Host "Upload complete (runbook not published): $RunbookName"
    return $true
}

#############################################################
# Main Script Execution
#############################################################

if (-not (Get-AzContext)) {
    Connect-AzAccount | Out-Null
}

Write-Host "Starting deployment: $deploymentName in Resource Group: $resourceGroup"

$deployment = ExecuteBicep

if ($deployment.ProvisioningState -ne 'Succeeded') {
    Write-Error "Deployment provisioning state: $($deployment.ProvisioningState)"
    if ($deployment.Error) {
        Write-Error ($deployment.Error | ConvertTo-Json -Depth 20)
    }
    exit 1
}

# Get the Automation Account name from deployment outputs
$automationAccount = Get-DeploymentOutputValue -Deployment $deployment -Name 'automationAccountName'

Write-Host "Automation Account deployed: $automationAccount"

# Upload runbooks to the Automation Account
#UploadRunbooks $automationAccount

#Get the Automation Account's principal ID
$principalId = Get-DeploymentOutputValue -Deployment $deployment -Name 'automationIdentityPrincipalId'

# Connect to Microsoft Graph
ConnectToGraph

# Assign required roles to the Automation Account
AssignRoles $principalId

Write-Host "Deployment and configuration completed successfully."


