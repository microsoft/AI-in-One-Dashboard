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
    [string]$StorageQueueName = "auditlogquerries",
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
# Fetches pages from API and streams directly to SharePoint upload session
# Handles 320 KiB alignment automatically
function GetCopilotInteractionsAndUpload {
    param (
        [Parameter(Mandatory)]
        [string]$auditLogQueryId,

        [Parameter(Mandatory)]
        [string]$DriveId,

        [Parameter(Mandatory)]
        [string]$FileName,

        [int]$TargetChunkSizeMB = 4, # Target size, will be adjusted to nearest 320KiB
        [int]$MaxRetries = 8
    )

    # --- Upload Setup ---
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    # 320 KiB constant required by Graph API
    $UploadMultipleSize = 327680 
    
    # Calculate a safe chunk size that is a multiple of 320 KiB
    $chunkThreshold = [Math]::Ceiling(($TargetChunkSizeMB * 1MB) / $UploadMultipleSize) * $UploadMultipleSize

    $position = 0
    $bufferStream = New-Object System.IO.MemoryStream

    try {
        # Create upload session via the Graph module (uses managed identity context)
        $bodyJson = '{ "item": { "@microsoft.graph.conflictBehavior": "replace" } }'
        $session = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/$($FileName):/createUploadSession" -Body $bodyJson -ContentType "application/json"

        if (-not $session.uploadUrl) {
            throw "Failed to create upload session: no uploadUrl returned"
        }
        $uploadUrl = $session.uploadUrl
    }
    catch {
        Write-Error "Failed to create upload session: $_"
        throw
    }

    # --- Helper: Retry Logic ---
    function Invoke-GraphPutWithRetry {
        param (
            [byte[]] $Body,
            [string] $Range,
            [bool] $IsFinal = $false,
            [long] $TotalLength = 0
        )

        for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
            try {
                # Use the Range string as provided (should be "bytes start-end/*" or "bytes start-end/total")
                $contentRange = $Range

                # Build headers for Invoke-MgGraphRequest (the module will handle auth)
                $headers = @{ "Content-Range" = $contentRange; }

                return Invoke-MgGraphRequest -Method PUT -Uri $uploadUrl -Headers $headers -Body $Body -SkipHeaderValidation 
            }
            catch {
                $ex = $_
                # Try to extract response status and headers when available
                $resp = $null
                if ($ex.Exception -and $ex.Exception.Response) { $resp = $ex.Exception.Response }
                if ($resp -and ($resp.StatusCode -eq 429 -or $resp.StatusCode -ge 500)) {
                    $retryAfter = 5
                    try { if ($resp.Headers['Retry-After']) { $retryAfter = [int]$resp.Headers['Retry-After'] } } catch {}
                    Start-Sleep -Seconds $retryAfter
                    continue
                }
                throw
            }
        }
    }

    # --- Helper: Smart Flush ---
    # Sends only multiples of 320 KiB, keeps the rest in buffer
    function Flush-Buffer {
        param ([bool]$IsFinal = $false)

        $len = $bufferStream.Length
        if ($len -eq 0) { return }

        # Calculate bytes to send
        if ($IsFinal) {
            $bytesToSend = $len
        }
        else {
            # Round down to nearest 320 KiB
            $numMultiples = [Math]::Floor($len / $UploadMultipleSize)
            $bytesToSend = $numMultiples * $UploadMultipleSize
        }

        # Only upload if we have enough data (or it's the end)
        if ($bytesToSend -gt 0) {
            $bufferStream.Position = 0
            $chunk = New-Object byte[] $bytesToSend
            $readCount = $bufferStream.Read($chunk, 0, $bytesToSend)

            $end = $position + $bytesToSend - 1
            # For intermediate chunks, use '*' as the total. For final, we'll pass the actual total later.
            $range = "bytes $position-$end/*"

            if ($IsFinal) {
                $totalLength = $position + $bytesToSend
                $finalRange = "bytes $position-$end/$totalLength"
                Invoke-GraphPutWithRetry -Body $chunk -Range $finalRange -IsFinal $true -TotalLength $totalLength
            }
            else {
                Invoke-GraphPutWithRetry -Body $chunk -Range $range
            }
            
            $position += $bytesToSend
            Write-Output "Uploaded chunk: $([Math]::Round($bytesToSend / 1MB, 2)) MB. Total uploaded: $([Math]::Round($position / 1MB, 2)) MB"

            # Handle remainder
            $remaining = $len - $bytesToSend
            if ($remaining -gt 0) {
                $remainder = New-Object byte[] $remaining
                $bufferStream.Read($remainder, 0, $remaining) | Out-Null
                
                # Reset buffer with just the remainder
                $bufferStream.SetLength(0)
                $bufferStream.Write($remainder, 0, $remaining)
            }
            else {
                $bufferStream.SetLength(0)
            }
        }
    }

    # --- Data Fetching Loop ---
    try {
        $uri = "https://graph.microsoft.com/beta/security/auditLog/queries/$auditLogQueryId/records"
        $rowCount = 0
        $headerWritten = $false
        
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
            $records = $response.value
            
            foreach ($item in $records) {
                # 1. Handle Header
                if (-not $headerWritten) {
                    $headers = $item.Keys
                    $headerLine = ($headers | ForEach-Object { '"{0}"' -f $_.Replace('"', '""') }) -join ','
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$headerLine`n")
                    $bufferStream.Write($bytes, 0, $bytes.Length)
                    $headerWritten = $true
                }
                
                # 2. Handle Row
                $values = @()
                foreach ($propName in $headers) {
                    $value = $item[$propName]
                    if ($value -eq $null) { $values += '""' }
                    elseif ($value -is [string]) { $values += '"{0}"' -f $value.Replace('"', '""') }
                    elseif ($value -is [bool]) { $values += $value.ToString() }
                    elseif ($value -is [DateTime]) { $values += '"{0:O}"' -f $value }
                    else {
                        $jsonValue = $value | ConvertTo-Json -Compress -Depth 10
                        $values += '"{0}"' -f $jsonValue.Replace('"', '""')
                    }
                }
                $csvLine = $values -join ','
                $bytes = [System.Text.Encoding]::UTF8.GetBytes("$csvLine`n")
                $bufferStream.Write($bytes, 0, $bytes.Length)

                # 3. Check if we should flush (if buffer > threshold)
                if ($bufferStream.Length -ge $chunkThreshold) { 
                    Flush-Buffer -IsFinal $false 
                }

                $rowCount++
            }

            Write-Output "Processed $rowCount records..."
            $uri = $response.'@odata.nextLink'

        } while ($uri)
        
        # 4. Final Flush (sends whatever is left)
        Flush-Buffer -IsFinal $true
        
        Write-Output "Successfully uploaded $rowCount records to $FileName"
    }
    catch {
        Write-Error "Failed during processing: $_"
        exit 1
    }
    finally {
        $bufferStream.Dispose()
    }
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
