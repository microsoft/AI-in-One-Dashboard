#############################################################
# Script to get CopilotInteractions from AuditLogs via Microsoft Graph and export to CSV
# and store in SPO. Script is designed to run in Azure Automation.
# Supports managed identity (default), app registration + secret, or app registration + certificate.
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
    [string]$SharePointSiteId = "",   # Graph site ID, e.g. contoso.sharepoint.com,{siteGuid},{webGuid}
    [string]$SharePointListId = "",   # GUID of the source SharePoint list
    [string]$DriveId = "",  # Update with actual Drive ID

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

$outputCSV = "CopilotInteractionsReport-$(Get-Date -Format 'yyyyMMddHHmmss')-"

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
                Invoke-GraphPutWithRetry -Body $chunk -Range $finalRange -IsFinal $true -TotalLength $totalLength | Out-Null
            }
            else {
                Invoke-GraphPutWithRetry -Body $chunk -Range $range | Out-Null
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

# Script-level variable to hold the list item ID for deletion after processing
$script:ListItemId = $null

# Get the first available query ID from the SharePoint list
function GetAuditQueryIdFromList {
    try {
        $uri = "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/lists/$SharePointListId/items?`$expand=fields&`$top=1"
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri

        if ($response.value.Count -eq 0) {
            Write-Output "No items found in the SharePoint list."
            exit 1
        }

        $item = $response.value[0]
        $script:ListItemId = $item.id
        $auditLogQueryId   = $item.fields.QueryId

        if ([string]::IsNullOrWhiteSpace($auditLogQueryId)) {
            Write-Error "List item '$($item.id)' has an empty QueryId field."
            exit 1
        }

        Write-Host "Retrieved list item ID: $($script:ListItemId), QueryId: $auditLogQueryId"
        return $auditLogQueryId
    }
    catch {
        Write-Error "Failed to get AuditLogQueryId from list: $_"
        exit 1
    }
}

# Delete the processed list item from the SharePoint list
function DeleteAuditQueryIdFromList {
    try {
        if ([string]::IsNullOrWhiteSpace($script:ListItemId)) {
            Write-Error "No list item ID stored - cannot delete."
            exit 1
        }

        $uri = "https://graph.microsoft.com/v1.0/sites/$SharePointSiteId/lists/$SharePointListId/items/$($script:ListItemId)"
        Invoke-MgGraphRequest -Method DELETE -Uri $uri

        Write-Output "Deleted list item: $($script:ListItemId)"
    }
    catch {
        Write-Error "Failed to delete list item: $_"
        exit 1
    }
}

#############################################################
# Main Script Execution
#############################################################

# Connect to Microsoft Graph
ConnectToGraph

# Get query ID from the SharePoint list
$AuditLogQueryId = GetAuditQueryIdFromList
Write-Output "Retrieved AuditLogQueryId from list: $SharePointListId"

# Check if ready to process / download (Exits if not ready)
$query = CheckIfQuerySucceeded -auditLogQueryId $AuditLogQueryId

# Define fileName for upload
$TargetFileName = $outputCSV + "$($AuditLogQueryId).csv"

# Get Copilot Interactions and Upload directly
GetCopilotInteractionsAndUpload -auditLogQueryId $AuditLogQueryId -DriveId $DriveId -FileName $TargetFileName

# Remove item from list after processing
DeleteAuditQueryIdFromList

Write-Output "Copilot Interactions report generated at: $TargetFileName"
