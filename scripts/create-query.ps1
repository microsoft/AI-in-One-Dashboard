#############################################################
# Script to create a CopilotInteraction query in purview
# Contact alexgrover@microsoft.com for questions

#############################################################
# Parameters
#############################################################

param (
    [DateTime]$startDate = (Get-Date).AddDays(-7),
    [DateTime]$endDate = (Get-Date)
)

#############################################################
# Dependencies
#############################################################

# Check if Microsoft Graph module is already installed
$module = Get-Module -ListAvailable | Where-Object { $_.Name -eq 'Microsoft.Graph.Beta.Security' }

if ($module -eq $null) {
    try {
        Write-Host "Installing module..."
        Install-Module -Name Microsoft.Graph.Beta.Security -Force -AllowClobber -Scope CurrentUser
    } 
    catch {
        Write-Host "Failed to install module: $_"
        exit
    }
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
        Connect-MgGraph -Scopes "AuditLogsQuery.Read.All" -NoWelcome
        Write-Host "Connected to Microsoft Graph."
    }
    catch {
        Write-Host "Failed to connect to Microsoft Graph: $_"
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
        $params = @{
            "@odata.type" = "#microsoft.graph.security.auditLogQuery"
            displayName = $displayName
            filterStartDateTime = $filterStartDateTime
            filterEndDateTime = $filterEndDateTime
            recordTypeFilters = @("CopilotInteraction")
        }
        
        # Add user filter only if provided
        if ($userPrincipalNameFilters.Count -gt 0) {
            $params["userPrincipalNameFilters"] = $userPrincipalNameFilters
        }
        
        $query = New-MgBetaSecurityAuditLogQuery -BodyParameter $params
        Write-Host "Created Audit Log Query: $($query.Id)"
        return $query
    }
    catch {
        Write-Host "Failed to create Audit Log Query: $_"
        exit 1
    }
}

#############################################################
# Main Script Execution
#############################################################

# Connect to Microsoft Graph
ConnectToGraph

$query = CreateAuditLogQuery `
    -displayName $queryName `
    -filterStartDateTime $startDate `
    -filterEndDateTime $endDate