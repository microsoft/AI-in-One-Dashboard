#############################################################
# Script to create a CopilotInteraction query in purview via runbook
# Contact alexgrover@microsoft.com for questions

#############################################################
# Parameters
#############################################################

param (
    [DateTime]$startDate = (Get-Date).AddDays(-7),
    [DateTime]$endDate = (Get-Date),
    [string]$StorageAccountName = "allinonedashboardagstg",
    [string]$StorageQueueName = "auditsearchidqueue"
)

#############################################################
# Dependencies
#############################################################

# Import the required modules (assumes they're available in the automation account)
Write-Output "Importing Microsoft.Graph.Authentication module..."
Import-Module -Name Microsoft.Graph.Authentication -Force

Write-Output "Importing Microsoft.Graph.Beta.Security module..."
Import-Module -Name Microsoft.Graph.Beta.Security -Force

Write-Output "Importing Az.Accounts module..."
Import-Module -Name Az.Accounts -Force

Write-Output "Importing Az.Storage module..."
Import-Module -Name Az.Storage -Force

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
        Connect-MgGraph -Identity -NoWelcome
        Write-Output "Connected to Microsoft Graph."
    }
    catch {
        Write-Error "Failed to connect to Microsoft Graph: $_"
        exit 1
    }
}

# Connect to Azure using managed identity
function ConnectToAzure {
    try {
        Connect-AzAccount -Identity | Out-Null
        Write-Output "Connected to Azure using managed identity."
    }
    catch {
        Write-Error "Failed to connect to Azure: $_"
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

# Send query ID to Azure Storage Queue
function SendQueryIdToQueue {
    param (
        [string]$queryId,
        [string]$storageAccountName,
        [string]$queueName
    )
    try {
        Write-Output "Sending query ID to Azure Storage Queue: $queueName"
        
        
        
        # Create a context using the connected account (managed identity)
        $ctx = New-AzStorageContext -StorageAccountName $storageAccountName -UseConnectedAccount

        # Retrieve a specific queue
        $queue = Get-AzStorageQueue -Name $queueName -Context $ctx

        # Add a new message to the queue
        $queue.QueueClient.SendMessageAsync($queryId)

        
        Write-Output "Successfully sent query ID to queue: $queryId"
    }
    catch {
        Write-Error "Failed to send message to queue: $_"
        # Don't exit - continue even if queue send fails
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

# Connect to Azure for storage operations
ConnectToAzure

Write-Output "Calling CreateAuditLogQuery function..."
$query = CreateAuditLogQuery `
    -displayName $queryName `
    -filterStartDateTime $startDate `
    -filterEndDateTime $endDate

Write-Output "Query creation completed."
Write-Output "Query ID: $($query.Id)"
Write-Output "Query Display Name: $($query.displayName)"

# Send query ID to storage queue
SendQueryIdToQueue -queryId $query.Id -storageAccountName $StorageAccountName -queueName $StorageQueueName