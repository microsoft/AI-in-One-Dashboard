#############################################################
# Script to get the M365 Copilot licensed user list via Microsoft Graph
# and store it in SharePoint Online. Designed to run as an Azure Automation
# runbook under a system-assigned Managed Identity.
#
# Calls /v1.0/reports/getOffice365ActiveUserDetail(period='D7'), parses the
# returned CSV, adds a HasCopilot flag column (TRUE/FALSE) by inspecting the
# 'Assigned Products' column for 'MICROSOFT 365 COPILOT', then uploads the
# enriched CSV to a SharePoint document library via Graph.
#
# Output schema (CSV columns appended with HasCopilot):
#   Report Refresh Date, User Principal Name, Assigned Products, ...,
#   HasCopilot
#
# Required Managed Identity permissions:
#   - Reports.Read.All (Application)
#   - Sites.Selected   (Application, scoped to the target SharePoint site)
#
# Contact: keithmcgrane@microsoft.com / alexgrover@microsoft.com
#############################################################

param (
    [Parameter(Mandatory)]
    [string]$DriveId,

    [string]$FolderPath = "",                 # e.g. "AI Dashboard/Audit Logs". Empty = drive root.
    [string]$Period     = "D7"                 # D7 / D30 / D90 / D180 — Graph fixed values
)

#############################################################
# Dependencies
#############################################################

Write-Output "Importing Microsoft.Graph.Authentication module..."
Import-Module -Name Microsoft.Graph.Authentication -Force

#############################################################
# Functions
#############################################################

function ConnectToGraph {
    try {
        Connect-MgGraph -Identity -NoWelcome
        Write-Output "Connected to Microsoft Graph (Managed Identity)."
    }
    catch {
        Write-Error "Failed to connect to Microsoft Graph: $_"
        exit 1
    }
}

# Fetch the M365 active user report and add HasCopilot flag.
function BuildCopilotUsersCsv {
    param ([string]$ReportPeriod)

    $reportUri = "https://graph.microsoft.com/v1.0/reports/getOffice365ActiveUserDetail(period='$ReportPeriod')"
    Write-Output "Fetching M365 active user report ($ReportPeriod)..."

    # Returns CSV text body directly
    $raw = Invoke-MgGraphRequest -Method GET -Uri $reportUri -OutputType HttpResponseMessage
    $csvText = ($raw.Content.ReadAsStringAsync().Result).TrimStart([char]0xFEFF)   # strip BOM if present

    # Parse + enrich
    $rows = ($csvText | ConvertFrom-Csv)
    if (-not $rows -or $rows.Count -eq 0) {
        Write-Warning "Report returned 0 rows."
        return @{ Csv = $csvText; RowCount = 0; CopilotCount = 0 }
    }

    $copilotCount = 0
    $sb = [System.Text.StringBuilder]::new()
    $headers = ($rows[0].PSObject.Properties.Name) + 'HasCopilot'
    [void]$sb.AppendLine(($headers | ForEach-Object { '"{0}"' -f ($_ -replace '"','""') }) -join ',')

    foreach ($row in $rows) {
        $assigned = ($row.'Assigned Products' -as [string]).ToUpper()
        $hasCopilot = if ($assigned -like '*MICROSOFT 365 COPILOT*') { 'TRUE' } else { 'FALSE' }
        if ($hasCopilot -eq 'TRUE') { $copilotCount++ }

        $values = foreach ($h in $headers) {
            $v = if ($h -eq 'HasCopilot') { $hasCopilot } else { $row.$h }
            if ($null -eq $v) { '""' } else { '"{0}"' -f ($v.ToString() -replace '"','""') }
        }
        [void]$sb.AppendLine($values -join ',')
    }

    return @{
        Csv          = $sb.ToString()
        RowCount     = $rows.Count
        CopilotCount = $copilotCount
    }
}

function UploadToSharePoint {
    param ([byte[]]$Bytes, [string]$DriveId, [string]$FolderPath, [string]$FileName)

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $cleanFolder = ($FolderPath -replace '^/+','' -replace '/+$','')
    $uploadPath  = if ([string]::IsNullOrWhiteSpace($cleanFolder)) { $FileName } else { "$cleanFolder/$FileName" }
    $encodedSegments = $uploadPath.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }
    $encodedPath = $encodedSegments -join '/'

    # Graph caps simple PUT at 4 MB. Above that → createUploadSession + chunked PUT.
    $simpleUploadCap = 4 * 1024 * 1024

    Write-Output "Uploading $($Bytes.Length) bytes to: $uploadPath"

    if ($Bytes.Length -le $simpleUploadCap) {
        $uploadUri = "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/${encodedPath}:/content"
        try {
            Invoke-MgGraphRequest -Method PUT -Uri $uploadUri -Body $Bytes -ContentType 'text/csv' | Out-Null
            Write-Output "Upload complete (simple PUT)."
        } catch { Write-Error "Failed to upload CSV to SharePoint: $_"; exit 1 }
        return
    }

    $sessionUri  = "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/${encodedPath}:/createUploadSession"
    $sessionBody = @{ item = @{ '@microsoft.graph.conflictBehavior' = 'replace' } } | ConvertTo-Json
    try {
        $session = Invoke-MgGraphRequest -Method POST -Uri $sessionUri -Body $sessionBody -ContentType 'application/json'
    } catch { Write-Error "Failed to create upload session: $_"; exit 1 }
    $uploadUrl = $session.uploadUrl
    if (-not $uploadUrl) { Write-Error "createUploadSession returned no uploadUrl"; exit 1 }

    $chunkSize = 5 * 1024 * 1024   # multiple of 320 KB required by Graph
    $total  = $Bytes.Length
    $offset = 0
    while ($offset -lt $total) {
        $end = [Math]::Min($offset + $chunkSize, $total) - 1
        $len = $end - $offset + 1
        $chunk = New-Object byte[] $len
        [Array]::Copy($Bytes, $offset, $chunk, 0, $len)
        $contentRange = "bytes $offset-$end/$total"
        try {
            Invoke-WebRequest -Uri $uploadUrl -Method Put `
                -Body $chunk -ContentType 'application/octet-stream' `
                -Headers @{ 'Content-Range' = $contentRange } `
                -UseBasicParsing -ErrorAction Stop | Out-Null
        } catch { Write-Error "Chunk upload failed at $contentRange : $_"; exit 1 }
        $offset = $end + 1
        Write-Output ("Uploaded {0:N0}/{1:N0} bytes" -f $offset, $total)
    }
    Write-Output "Upload complete (upload session)."
}

#############################################################
# Main
#############################################################

ConnectToGraph

$result = BuildCopilotUsersCsv -ReportPeriod $Period
Write-Output ""
Write-Output ("Built CSV with {0} users ({1} with Copilot license)." -f $result.RowCount, $result.CopilotCount)

$FileName = "M365CopilotUsers-{0}.csv" -f (Get-Date -Format 'yyyyMMddHHmmss')
$bytes = [System.Text.Encoding]::UTF8.GetBytes($result.Csv)
UploadToSharePoint -Bytes $bytes -DriveId $DriveId -FolderPath $FolderPath -FileName $FileName

Write-Output ""
Write-Output ("Done. Uploaded {0} users to SP folder: {1}" -f $result.RowCount, $(if ($FolderPath) { "$FolderPath/$FileName" } else { $FileName }))
