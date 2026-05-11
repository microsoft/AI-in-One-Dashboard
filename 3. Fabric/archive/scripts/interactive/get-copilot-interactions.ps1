#############################################################
# Script to get CopilotInteractions from AuditLogs via Microsoft Graph and export to CSV
# Contact alexgrover@microsoft.com for questions

#############################################################
# Parameters
#############################################################

param (
    # Mandatory AuditLogQueryId parameter
    [Parameter(Mandatory=$true)]
    [string]$AuditLogQueryId
)



#############################################################
# Dependencies
#############################################################

# Check if Microsoft Graph module is already installed
$module = Get-Module -ListAvailable | Where-Object { $_.Name -eq 'Microsoft.Graph.Beta.Security' }

if ($null -eq $module) {
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

$outputCSV = "CopilotInteractionsReport-$(Get-Date -Format 'yyyyMMddHHmmss')-$($AuditLogQueryId).csv"

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


function Invoke-WithRetry {
    param(
        [ScriptBlock]$ScriptBlock,
        [int]$MaxAttempts = 5,
        [int]$BaseDelaySeconds = 2,
        [int]$MaxDelaySeconds = 60
    )

    $attempt = 0

    while ($true) {
        $attempt++
        try {
            return & $ScriptBlock
        }
        catch 
        {
            $ex = $_.Exception

            # Try to extract status code + headers (works for Invoke-WebRequest/Invoke-RestMethod failures)
            $statusCode = $null
            $headers = $null

            if ($ex.PSObject.Properties.Name -contains "Response" -and $ex.Response) {
                try {
                    $statusCode = [int]$ex.Response.StatusCode.value__
                    $headers = $ex.Response.Headers
                } catch { }
            }

            # Decide if retryable
            $retryableStatus = @(429,502,503,504)
            $isRetryable = $false

            if ($statusCode -and $retryableStatus -contains $statusCode) {
                $isRetryable = $true
            }
            elseif ($ex.Message -match "The operation has timed out|timed out|connection.*(closed|aborted|reset)|name resolution|temporarily unavailable") {
                $isRetryable = $true
            }

            if (-not $isRetryable -or $attempt -ge $MaxAttempts) {
                throw "Operation failed after $attempt attempts. StatusCode=$statusCode. Error=$($_)"
            }

            # Prefer Retry-After header if present
            $delay = $null
            if ($headers -and $headers["Retry-After"]) {
                $delay = [int]$headers["Retry-After"][0]
            }

            if (-not $delay) {
                # Exponential backoff with jitter
                $delay = [Math]::Min($MaxDelaySeconds, $BaseDelaySeconds * [Math]::Pow(2, $attempt - 1))
                $jitter = Get-Random -Minimum (-0.2) -Maximum 0.2
                $delay = [Math]::Max(1, [Math]::Floor($delay + ($delay * $jitter)))
            }
            else {
                # small jitter even with Retry-After to avoid thundering herd
                $delay = $delay + (Get-Random -Minimum 0 -Maximum 2)
                $delay = [Math]::Min($MaxDelaySeconds, [Math]::Max(1, [Math]::Floor($delay)))
            }

            # Log correlation IDs if available
            $reqId = $headers["request-id"] | Select-Object -First 1
            $clientReqId = $headers["client-request-id"] | Select-Object -First 1

            Write-Host "Attempt $attempt failed (HTTP $statusCode). Retrying in $delay seconds... request-id=$reqId client-request-id=$clientReqId"
            Start-Sleep -Seconds $delay
        }
    }
}


# Get Copilot Interactions from AuditLogQuery
# Get Copilot Interactions from AuditLogQuery - write to CSV incrementally
function GetCopilotInteractionsAndExport {
    param (
        [string]$auditLogQueryId,
        [string]$outputCSV
    )
    try {
        # Build output filepath
        $outputCSV = Join-Path -Path (Get-Location) -ChildPath $outputCSV
        $streamWriter = [System.IO.StreamWriter]::new($outputCSV, $false, [System.Text.Encoding]::UTF8)
        
        # Get records using the API directly to handle pagination
        $uri = "https://graph.microsoft.com/beta/security/auditLog/queries/$auditLogQueryId/records"
        
        $rowCount = 0
        $headerWritten = $false
        
        do {
            $response = Invoke-WithRetry -ScriptBlock { Invoke-MgGraphRequest -Method GET -Uri $uri }
            $records = $response.value
            
            foreach ($item in $records) {
                # Write header on first item
                if (-not $headerWritten) {
                    $headers = $item.Keys
                    $headerLine = ($headers | ForEach-Object { '"{0}"' -f $_.Replace('"', '""') }) -join ','
                    $streamWriter.WriteLine($headerLine)
                    $headerWritten = $true
                }
                
                # Convert each property to CSV format and write
                # Convert each property to CSV format and write
                $values = @()
                foreach ($propName in $headers) {
                    $value = $item[$propName]
        
                    if ($null -eq $value) {
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
                        $jsonValue = $value | ConvertTo-Json -Compress -Depth 10
                        $values += '"{0}"' -f $jsonValue.Replace('"', '""')
                    }
                }
    
                $csvLine = $values -join ','
                $streamWriter.WriteLine($csvLine)
                $rowCount++
                
             
            }

            # Flush after each page
            $streamWriter.Flush()
            Write-Host "Processed $rowCount records..."
    
            
            # Check for @odata.nextLink for pagination
            $uri = $response.'@odata.nextLink'
        } while ($uri)
        
        $streamWriter.Flush()
        $streamWriter.Close()
        $streamWriter.Dispose()
        
        Write-Host "Exported $rowCount Copilot Interactions to CSV: $outputCSV"
    }
    catch {
        Write-Host "Failed to export interactions to CSV: $_"
        exit 1
    }
}

# Get status of query
function CheckIfQuerySucceeded {
    param (
        [string]$auditLogQueryId
    )
    try {
        $query = Get-MgBetaSecurityAuditLogQuery -AuditLogQueryId $auditLogQueryId
        if ($query.status -eq "succeeded") {
            Write-Host "Audit Log Query succeeded."
            return $query
        }
        else {
            Write-Host "Audit Log Query status: $($query.status)"
            Write-Host "Check again later."
            exit 1
        }
    }
    catch {
        Write-Host "Failed to get Audit Log Query: $auditLogQueryId"
        Write-Host "$_"
        exit 1
    }
}


# Export interactions to CSV
# Unused function, kept for reference
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
                
                if ($null -eq $value) {
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
                Write-Host "Processed $rowCount records..."
            }
        }
        
        $streamWriter.Flush()
        $streamWriter.Close()
        $streamWriter.Dispose()
        
        Write-Host "Exported $rowCount Copilot Interactions to CSV: $outputCSV"
 
    }
    catch {
        Write-Host "Failed to export interactions to CSV: $_"
        exit 1
    }
}

#############################################################
# Main Script Execution
#############################################################

# Connect to Microsoft Graph
ConnectToGraph

$query = CheckIfQuerySucceeded -auditLogQueryId $AuditLogQueryId

# Get Copilot Interactions
GetCopilotInteractionsAndExport -auditLogQueryId $AuditLogQueryId -outputCSV $outputCSV

Write-Host "Copilot Interactions report generated at: $outputCSV"
