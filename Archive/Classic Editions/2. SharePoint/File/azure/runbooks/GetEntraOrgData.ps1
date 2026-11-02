#############################################################
# Script to get Entra organisational data via Microsoft Graph and store it
# in SharePoint Online. Designed to run as an Azure Automation runbook under
# a system-assigned Managed Identity.
#
# Calls /v1.0/users?$select=... with $expand=manager(...) to pull org structure
# (department, jobTitle, location, manager UPN) for every Entra user, then
# uploads as CSV to a SharePoint document library via Graph.
#
# Output schema (CSV columns):
#   userPrincipalName, displayName, department, jobTitle, companyName,
#   officeLocation, city, country, accountEnabled, managerUPN
#
# Required Managed Identity permissions:
#   - User.Read.All  (Application)
#   - Sites.Selected (Application, scoped to the target SharePoint site)
#
# Contact: keithmcgrane@microsoft.com / alexgrover@microsoft.com
#############################################################

param (
    [Parameter(Mandatory)]
    [string]$DriveId,

    [string]$FolderPath = ""    # e.g. "AI Dashboard/Audit Logs". Empty = drive root.
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

function BuildOrgDataCsv {
    $selectFields  = 'userPrincipalName,displayName,department,jobTitle,companyName,officeLocation,city,country,accountEnabled'
    $expandManager = 'manager($select=userPrincipalName)'
    $uri = "https://graph.microsoft.com/v1.0/users?`$select=$selectFields&`$expand=$expandManager&`$top=999"

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine('"userPrincipalName","displayName","department","jobTitle","companyName","officeLocation","city","country","accountEnabled","managerUPN"')

    $rowCount = 0
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        foreach ($u in $response.value) {
            $managerUpn = ''
            if ($u.manager -and $u.manager.userPrincipalName) {
                $managerUpn = [string]$u.manager.userPrincipalName
            }
            $row = @(
                $u.userPrincipalName, $u.displayName, $u.department, $u.jobTitle,
                $u.companyName, $u.officeLocation, $u.city, $u.country,
                [string]$u.accountEnabled, $managerUpn
            ) | ForEach-Object {
                if ($null -eq $_) { '""' } else { '"{0}"' -f ($_.ToString() -replace '"','""') }
            }
            [void]$sb.AppendLine($row -join ',')
            $rowCount++
        }
        $uri = $response.'@odata.nextLink'
        if ($uri) { Write-Output "Fetched $rowCount users so far..." }
    } while ($uri)

    Write-Output ("Total users: {0}" -f $rowCount)
    return @{ Csv = $sb.ToString(); RowCount = $rowCount }
}

function UploadToSharePoint {
    param ([byte[]]$Bytes, [string]$DriveId, [string]$FolderPath, [string]$FileName)

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $cleanFolder = ($FolderPath -replace '^/+','' -replace '/+$','')
    $uploadPath  = if ([string]::IsNullOrWhiteSpace($cleanFolder)) { $FileName } else { "$cleanFolder/$FileName" }
    $encodedSegments = $uploadPath.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }
    $encodedPath = $encodedSegments -join '/'

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

    $chunkSize = 5 * 1024 * 1024
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

$result = BuildOrgDataCsv
Write-Output ""
Write-Output ("Built Entra org CSV with {0} users." -f $result.RowCount)

$FileName = "EntraOrgData-{0}.csv" -f (Get-Date -Format 'yyyyMMddHHmmss')
$bytes    = [System.Text.Encoding]::UTF8.GetBytes($result.Csv)
UploadToSharePoint -Bytes $bytes -DriveId $DriveId -FolderPath $FolderPath -FileName $FileName

Write-Output ""
Write-Output ("Done. Uploaded {0} users to SP folder: {1}" -f $result.RowCount, $(if ($FolderPath) { "$FolderPath/$FileName" } else { $FileName }))
