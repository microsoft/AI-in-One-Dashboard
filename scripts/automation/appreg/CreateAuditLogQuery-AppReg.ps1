#############################################################
# Script to create a CopilotInteraction query in purview via runbook
# Supports managed identity (default), app registration + secret, or app registration + certificate.
# Contact alexgrover@microsoft.com for questions
#
# Permissions needed:
# - For Microsoft Graph: AuditLogsQuery.Read.All, Sites.Selected
# Note: The target SharePoint list must have a 'QueryId' column (single line of text).

#############################################################
# Parameters
#############################################################

param (
    [DateTime]$startDate = (Get-Date).AddDays(-7),
    [DateTime]$endDate = (Get-Date),
    [string]$SharePointSiteId = "",   # Graph site ID, e.g. contoso.sharepoint.com,{siteGuid},{webGuid}
    [string]$SharePointListId = "",   # GUID of the target SharePoint list

    # App registration auth (optional - leave all blank to use managed identity)
    [string]$TenantId = "",
    [string]$ClientId = "",
    [string]$ClientSecret = "",
    [string]$CertificateThumbprint = ""
)

#############################################################
# Auth Mode Validation
#############################################################

$useSecret      = -not [string]::IsNullOrWhiteSpace($ClientSecret)
$useCert        = -not [string]::IsNullOrWhiteSpace($CertificateThumbprint)
$hasTenantId    = -not [string]::IsNullOrWhiteSpace($TenantId)
$hasClientId    = -not [string]::IsNullOrWhiteSpace($ClientId)
$hasAppRegParam = $useSecret -or $useCert -or $hasTenantId -or $hasClientId

if ($hasAppRegParam) {
    # Validate mutual exclusion
    if ($useSecret -and $useCert) {
        Write-Error "Provide either -ClientSecret OR -CertificateThumbprint, not both."
        exit 1
    }
    # Validate all required app reg params are present
    if (-not $hasTenantId) {
        Write-Error "-TenantId is required when using app registration authentication."
        exit 1
    }
    if (-not $hasClientId) {
        Write-Error "-ClientId is required when using app registration authentication."
        exit 1
    }
    if (-not $useSecret -and -not $useCert) {
        Write-Error "Provide either -ClientSecret or -CertificateThumbprint when using app registration authentication."
        exit 1
    }

    if ($useSecret) {
        $authMode = "AppSecret"
    } else {
        $authMode = "AppCert"
    }
} else {
    $authMode = "ManagedIdentity"
}

Write-Output "Auth mode: $authMode"

#############################################################
# Dependencies
#############################################################

foreach ($moduleName in @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Beta.Security')) {
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
# Variables
#############################################################

$queryName = "Copilot Interactions Report - $($startDate.ToString('yyyyMMdd')) to $($endDate.ToString('yyyyMMdd'))"

#############################################################
# Functions
#############################################################

# Connect to Microsoft Graph
function ConnectToGraph {
    try {
        switch ($authMode) {
            "ManagedIdentity" {
                Connect-MgGraph -Identity -NoWelcome
            }
            "AppSecret" {
                $secureSecret = ConvertTo-SecureString $ClientSecret -AsPlainText -Force
                $credential   = New-Object System.Management.Automation.PSCredential($ClientId, $secureSecret)
                Connect-MgGraph -ClientSecretCredential $credential -TenantId $TenantId -NoWelcome
            }
            "AppCert" {
                Connect-MgGraph -ClientId $ClientId -TenantId $TenantId -CertificateThumbprint $CertificateThumbprint -NoWelcome
            }
        }
        Write-Output "Connected to Microsoft Graph."
    }
    catch {
        Write-Error "Failed to connect to Microsoft Graph: $_"
        exit 1
    }
}



# Create a new Audit Log Query for CopilotInteraction records
function CreateAuditLogQuery {
    param (
        [string]$displayName,
        [DateTime]$filterStartDateTime,
        [DateTime]$filterEndDateTime,
        [string[]]$userPrincipalNameFilters = @()
    )
    try {

        Write-Output "Creating Audit Log Query: $displayName"

        $params = @{
            "@odata.type"       = "#microsoft.graph.security.auditLogQuery"
            displayName         = $displayName
            filterStartDateTime = $filterStartDateTime
            filterEndDateTime   = $filterEndDateTime
            recordTypeFilters   = @("CopilotInteraction")
        }
        
        # Add user filter only if provided
        if ($userPrincipalNameFilters.Count -gt 0) {
            $params["userPrincipalNameFilters"] = $userPrincipalNameFilters
        }
        
        $query = New-MgBetaSecurityAuditLogQuery -BodyParameter $params
        Write-Output "Created Audit Log Query: $($query.Id)"
        return $query
    }
    catch {
        Write-Error "Failed to create Audit Log Query: $_"
        exit 1
    }
}

# Send query ID to SharePoint list via Microsoft Graph
function SendQueryIdToList {
    param (
        [string]$queryId,
        [string]$siteId,
        [string]$listId
    )
    try {
        Write-Output "Sending query ID to SharePoint list: $listId"

        $body = @{
            fields = @{
                QueryId = $queryId
            }
        } | ConvertTo-Json -Depth 3

        $response = Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$listId/items" `
            -Body $body `
            -ContentType "application/json"

        Write-Output "Successfully added query ID to list. Item ID: $($response.id)"
    }
    catch {
        Write-Error "Failed to send query ID to list: $_"
        # Don't exit - continue even if list write fails
    }
}

#############################################################
# Main Script Execution
#############################################################

Write-Output "Script started with parameters:"
Write-Output "Start Date: $startDate"
Write-Output "End Date: $endDate"

# Connect to Microsoft Graph
ConnectToGraph

Write-Output "Calling CreateAuditLogQuery function..."
$query = CreateAuditLogQuery `
    -displayName $queryName `
    -filterStartDateTime $startDate `
    -filterEndDateTime $endDate

Write-Output "Query creation completed."
Write-Output "Query ID: $($query.Id)"
Write-Output "Query Display Name: $($query.displayName)"

# Send query ID to SharePoint list
SendQueryIdToList -queryId $query.Id -siteId $SharePointSiteId -listId $SharePointListId
