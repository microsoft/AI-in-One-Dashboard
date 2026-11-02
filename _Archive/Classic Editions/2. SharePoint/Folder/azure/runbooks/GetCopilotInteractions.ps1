#############################################################
# Script to get CopilotInteractions from AuditLogs via Microsoft Graph and export to CSV
# and store in SPO. Script is designed to run in Azure Automation with Managed Identity.
# It will build the CSV and write to SPO in a streaming manner to avoid large memory usage. 
#
# Contact alexgrover@microsoft.com for questions
#
#
# Thanks here for how to chunk the file upload: https://pnp.github.io/script-samples/graph-upload-file-to-sharepoint/README.html?tabs=azure-cli

#############################################################
# Parameters
#############################################################

param (
    [string]$StorageAccountName = "allin1dashag",
    [string]$StorageQueueName = "auditsearchidqueue",
    [string]$DriveId = "b!8F3vK3Mp306F14gvFTLgyPa4BMFPYFxNjKT8_wIfG018E1NnUCshSqn-JysXy4tf"  # Update with actual Drive ID
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

$outputCSV = "CopilotInteractionsReport-$(Get-Date -Format 'yyyyMMddHHmmss')-$($AuditLogQueryId).csv"

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

# Combined function: Get Copilot Interactions and Upload to SharePoint
#
# Builds the full CSV in memory by paging through Graph audit records, then
# uploads to SharePoint:
#   * <= 4 MB → simple PUT to /drives/{id}/root:/{path}:/content
#   * >  4 MB → createUploadSession + chunked PUTs with explicit Content-Range
#               total length (SharePoint rejects "*" as the total).
#
# The previous streaming approach used "bytes X-Y/*" for intermediate chunks
# and Invoke-MgGraphRequest for the chunk PUTs; both are incompatible with
# SharePoint's upload-session endpoint, which:
#   1. requires the actual total length in every Content-Range header
#   2. needs a plain HTTP client (the upload URL is a pre-signed SP URL,
#      not a Graph URL — Invoke-MgGraphRequest mangles non-Graph requests)
function GetCopilotInteractionsAndUpload {
    param (
        [Parameter(Mandatory)]
        [string]$auditLogQueryId,

        [Parameter(Mandatory)]
        [string]$DriveId,

        [Parameter(Mandatory)]
        [string]$FileName,

        [int]$MaxRetries = 8
    )

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    # --- Helper: Graph GET with retry on 429/5xx ---
    function Invoke-GraphGetWithRetry {
        param ([Parameter(Mandatory)] [string]$Uri)
        for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
            try { return Invoke-MgGraphRequest -Method GET -Uri $Uri }
            catch {
                $resp = $null
                if ($_.Exception -and $_.Exception.Response) { $resp = $_.Exception.Response }
                if ($resp -and ($resp.StatusCode -eq 429 -or $resp.StatusCode -ge 500) -and $attempt -lt $MaxRetries) {
                    $sleep = [Math]::Min(5 * [Math]::Pow(2, $attempt - 1), 60)
                    try { if ($resp.Headers['Retry-After']) { $sleep = [int]$resp.Headers['Retry-After'] } } catch {}
                    Write-Output "GET failed (attempt $attempt/$MaxRetries, HTTP $($resp.StatusCode)), retrying in ${sleep}s..."
                    Start-Sleep -Seconds $sleep
                    continue
                }
                throw
            }
        }
        throw "GET request to $Uri failed after $MaxRetries attempts."
    }

    # --- Build full CSV in memory by paging through audit records ---
    $sb = New-Object System.Text.StringBuilder
    $rowCount = 0
    $headerWritten = $false
    $headers = $null
    $uri = "https://graph.microsoft.com/beta/security/auditLog/queries/$auditLogQueryId/records"

    do {
        $response = Invoke-GraphGetWithRetry -Uri $uri

        foreach ($item in $response.value) {
            if (-not $headerWritten) {
                $headers = $item.Keys
                $headerLine = ($headers | ForEach-Object { '"{0}"' -f $_.Replace('"','""') }) -join ','
                [void]$sb.AppendLine($headerLine)
                $headerWritten = $true
            }

            $values = @()
            foreach ($propName in $headers) {
                $value = $item[$propName]
                if ($null -eq $value)          { $values += '""' }
                elseif ($value -is [string])   { $values += '"{0}"' -f $value.Replace('"','""') }
                elseif ($value -is [bool])     { $values += $value.ToString() }
                elseif ($value -is [DateTime]) { $values += '"{0:O}"' -f $value }
                else {
                    $jsonValue = $value | ConvertTo-Json -Compress -Depth 10
                    $values += '"{0}"' -f $jsonValue.Replace('"','""')
                }
            }
            [void]$sb.AppendLine($values -join ',')
            $rowCount++
        }

        Write-Output "Processed $rowCount records..."
        $uri = $response.'@odata.nextLink'
        if ($uri) { Start-Sleep -Milliseconds 200 }
    } while ($uri)

    # --- Encode CSV and upload ---
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
    $totalBytes = $bytes.Length
    Write-Output "Built CSV with $rowCount rows ($totalBytes bytes). Uploading to: $FileName"

    # Graph caps simple PUT (root:/path:/content) at 4 MB. Larger files need an
    # upload session with chunked PUTs and Content-Range headers. To exercise
    # the chunked branch on a small test CSV, temporarily lower this to e.g. 100.
    $simpleUploadCap = 4 * 1024 * 1024

    if ($totalBytes -le $simpleUploadCap) {
        $uploadUri = "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/$($FileName):/content"
        Invoke-MgGraphRequest -Method PUT -Uri $uploadUri -Body $bytes -ContentType 'text/csv' | Out-Null
        Write-Output "Upload complete (simple PUT, $totalBytes bytes). $rowCount records."
        return
    }

    # Large file: createUploadSession then chunked PUT with explicit total.
    $sessionBody = '{ "item": { "@microsoft.graph.conflictBehavior": "replace" } }'
    $session = Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/$($FileName):/createUploadSession" `
        -Body $sessionBody -ContentType 'application/json'
    if (-not $session.uploadUrl) { throw "createUploadSession returned no uploadUrl" }
    $uploadUrl = $session.uploadUrl

    # Upload session chunk size must be a multiple of 320 KiB. 5 MiB = 16 * 320 KiB.
    $chunkSize = 5 * 1024 * 1024
    $offset = 0
    while ($offset -lt $totalBytes) {
        $end = [Math]::Min($offset + $chunkSize, $totalBytes) - 1
        $len = $end - $offset + 1
        $chunk = New-Object byte[] $len
        [Array]::Copy($bytes, $offset, $chunk, 0, $len)
        $contentRange = "bytes $offset-$end/$totalBytes"

        for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
            try {
                # Use Invoke-WebRequest, NOT Invoke-MgGraphRequest — uploadUrl is a
                # pre-signed SharePoint URL, not a Graph URL. The Graph SDK strips
                # custom headers (including Content-Range) when called with non-Graph
                # URLs, which is what caused SP to reject the request.
                Invoke-WebRequest -Uri $uploadUrl -Method Put `
                    -Body $chunk -ContentType 'application/octet-stream' `
                    -Headers @{ 'Content-Range' = $contentRange } `
                    -UseBasicParsing -ErrorAction Stop | Out-Null
                break
            }
            catch {
                $resp = $null
                if ($_.Exception -and $_.Exception.Response) { $resp = $_.Exception.Response }
                if ($resp -and ($resp.StatusCode -eq 429 -or $resp.StatusCode -ge 500) -and $attempt -lt $MaxRetries) {
                    $sleep = [Math]::Min(5 * [Math]::Pow(2, $attempt - 1), 60)
                    Write-Output "Chunk PUT failed at $contentRange (attempt $attempt/$MaxRetries, HTTP $($resp.StatusCode)), retrying in ${sleep}s..."
                    Start-Sleep -Seconds $sleep
                    continue
                }
                Write-Error "Chunk upload failed at $contentRange : $_"
                throw
            }
        }

        $offset = $end + 1
        Write-Output ("Uploaded {0:N0}/{1:N0} bytes" -f $offset, $totalBytes)
    }
    Write-Output "Upload complete (upload session, $totalBytes bytes). $rowCount records."
}


# Get status of query
function CheckIfQuerySucceeded {
    param (
        [string]$auditLogQueryId
    )
    try {
        $query = Get-MgBetaSecurityAuditLogQuery -AuditLogQueryId $auditLogQueryId -ErrorAction Stop
        if ($query.status -eq "succeeded") {
            Write-Output "Audit Log Query succeeded."
            return $query
        }
        else {
            Write-Output "Audit Log Query status: $($query.status)"
            Write-Output "Check again later."
            exit 1
        }
    }
    catch {
        Write-Error "Failed to get Audit Log Query: $auditLogQueryId"
        Write-Error "$_"
        exit 1
    }
}


# Export interactions to CSV
# Legacy function, not used in streaming upload
function ExportInteractionsToCSV {
    param (
        [array]$interactions,
        [string]$outputCSV
    )
    try {
        # build output filepath using pwd (can't use Resolve-Path for new file)
        $outputCSV = Join-Path -Path (Get-Location) -ChildPath $outputCSV

        $streamWriter = [System.IO.StreamWriter]::new($outputCSV, $false, [System.Text.Encoding]::UTF8)
        
        $rowCount = 0
        $headerWritten = $false
        
        foreach ($item in $interactions) {
            # Write header on first item
            # Write header on first item
            if (-not $headerWritten) {
                $headers = $item.Keys
                $headerLine = ($headers | ForEach-Object { '"{0}"' -f $_.Replace('"', '""') }) -join ','
                $streamWriter.WriteLine($headerLine)
                $headerWritten = $true
            }
            
            # Convert each property value to properly escaped CSV format
            $values = @()
            foreach ($prop in $item.PSObject.Properties) {
                $value = $prop.Value
                
                if ($value -eq $null) {
                    $values += '""'
                }
                elseif ($value -is [string]) {
                    $values += '"{0}"' -f $value.Replace('"', '""')
                }
                elseif ($value -is [bool]) {
                    $values += $value.ToString()
                }
                elseif ($value -is [DateTime]) {
                    $values += '"{0:O}"' -f $value
                }
                else {
                    # For complex objects, convert to JSON string
                    $jsonValue = $value | ConvertTo-Json -Compress -Depth 10
                    $values += '"{0}"' -f $jsonValue.Replace('"', '""')
                }
            }
            
            $csvLine = $values -join ','
            $streamWriter.WriteLine($csvLine)
            $rowCount++
            
            # Flush periodically
            if ($rowCount % 10000 -eq 0) {
                $streamWriter.Flush()
                Write-Output "Processed $rowCount records..."
            }
        }
        
        $streamWriter.Flush()
        $streamWriter.Close()
        $streamWriter.Dispose()
        
        Write-Output "Exported $rowCount Copilot Interactions to CSV: $outputCSV"
 
    }
    catch {
        Write-Error "Failed to export interactions to CSV: $_"
        exit 1
    }
}

function GetAuditQueryIdFromQueue {

    try {

        # Create a context using the connected account (managed identity)
        $ctx = New-AzStorageContext -StorageAccountName $storageAccountName -UseConnectedAccount

        # Retrieve a specific queue
        $queue = Get-AzStorageQueue -Name $queueName -Context $ctx

        # Peek the message from the queue, then show the contents of the message. 
        $queueMessage = $queue.QueueClient.PeekMessage()

        if ($queueMessage -eq $null) {
            Write-Output "No messages in the queue."
            exit 1
        }

        $auditLogQueryId = $queueMessage.Value.MessageText

        return $auditLogQueryId
    }
    catch {
        Write-Error "Failed to get AuditLogQueryId from queue: $_"
        exit 1
    }
}

function DeleteAuditQueryIdFromQueue {

    try {

        # Create a context using the connected account (managed identity)
        $ctx = New-AzStorageContext -StorageAccountName $storageAccountName -UseConnectedAccount

        # Retrieve a specific queue
        $queue = Get-AzStorageQueue -Name $queueName -Context $ctx

        # Set visibility timeout
        $visibilityTimeout = [System.TimeSpan]::FromSeconds(10)

        # Receive one message from the queue, then delete the message. 
        $queueMessage = $queue.QueueClient.ReceiveMessage($visibilityTimeout)
        $queue.QueueClient.DeleteMessage($queueMessage.Value.MessageId, $queueMessage.Value.PopReceipt)

        Write-Output "Deleted message from queue."

    }
    catch {
        Write-Error "Failed to delete message from queue: $_"
        exit 1
    }
}
#############################################################
# Main Script Execution
#############################################################

# Connect to Microsoft Graph
ConnectToGraph

# Connect to Azure for storage operations
ConnectToAzure

# Get query from the queue
$AuditLogQueryId = GetAuditQueryIdFromQueue
Write-Output "Retrieved AuditLogQueryId from queue: $AuditLogQueryId"

# Check if ready to process / download (Exits if not ready)
$query = CheckIfQuerySucceeded -auditLogQueryId $AuditLogQueryId

# Define fileName for upload
$TargetFileName = $outputCSV

# Get Copilot Interactions and Upload directly
GetCopilotInteractionsAndUpload -auditLogQueryId $AuditLogQueryId -DriveId $DriveId -FileName $TargetFileName

# Remove message from queue after processing
DeleteAuditQueryIdFromQueue

Write-Output "Copilot Interactions report generated at: $TargetFileName"
