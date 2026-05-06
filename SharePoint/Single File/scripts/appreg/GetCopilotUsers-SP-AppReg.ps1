#############################################################
# SharePoint path - Copilot Licensed Users fetcher (AppReg auth)
#
# Pulls the M365 active user detail report and uploads a 3-column CSV
# (Report Refresh Date, User Principal Name, HasCopilot) to SharePoint.
#
# Required permissions (Application):
#   - Reports.Read.All       (for the M365 usage report)
#   - Sites.Selected         (granted on the target site via ProvisionSiteAccess)
#
# Note: M365 admin centre - Settings - Org settings - Reports must have
# "Display concealed user, group, and site names" UNTICKED to get real
# UPNs. Otherwise UPNs are masked (32-char hex) and the join to interactions
# data fails.
#
# Contact: keithmcgrane@microsoft.com
#############################################################

param (
    [Parameter(Mandatory)]
    [string]$DriveId,

    [string]$FolderPath = "",
    [string]$FileName   = "",
    [ValidateSet('D7','D30','D90','D180')]
    [string]$Period = 'D7',

    # App registration auth
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
    if ($useSecret -and $useCert) { Write-Error "Provide either -ClientSecret OR -CertificateThumbprint, not both."; exit 1 }
    if (-not $hasTenantId) { Write-Error "-TenantId is required when using app registration authentication."; exit 1 }
    if (-not $hasClientId) { Write-Error "-ClientId is required when using app registration authentication."; exit 1 }
    if (-not $useSecret -and -not $useCert) { Write-Error "Provide either -ClientSecret or -CertificateThumbprint when using app registration authentication."; exit 1 }
    $authMode = if ($useSecret) { "AppSecret" } else { "AppCert" }
} else {
    $authMode = "ManagedIdentity"
}
Write-Output "Auth mode: $authMode"

#############################################################
# Dependencies
#############################################################

foreach ($mod in @('Microsoft.Graph.Authentication')) {
    if (-not (Get-Module -ListAvailable -Name $mod)) {
        try { Install-Module -Name $mod -Force -AllowClobber -Scope CurrentUser } catch { Write-Error "Failed to install module '$mod': $_"; exit 1 }
    }
    Import-Module -Name $mod -Force
}

#############################################################
# Functions
#############################################################

function ConnectToGraph {
    try {
        switch ($authMode) {
            "ManagedIdentity" { Connect-MgGraph -Identity -NoWelcome }
            "AppSecret" {
                $secureSecret = ConvertTo-SecureString $ClientSecret -AsPlainText -Force
                $credential   = New-Object System.Management.Automation.PSCredential($ClientId, $secureSecret)
                Connect-MgGraph -ClientSecretCredential $credential -TenantId $TenantId -NoWelcome
            }
            "AppCert" { Connect-MgGraph -ClientId $ClientId -TenantId $TenantId -CertificateThumbprint $CertificateThumbprint -NoWelcome }
        }
        Write-Output "Connected to Microsoft Graph."
    } catch { Write-Error "Failed to connect to Microsoft Graph: $_"; exit 1 }
}

function DownloadAndProcess {
    param ([string]$Period)

    $tempCsv = Join-Path $env:TEMP ("tempM365Users-{0}.csv" -f (Get-Date -Format 'yyyyMMddHHmmss'))
    $reportUri = "https://graph.microsoft.com/v1.0/reports/getOffice365ActiveUserDetail(period='$Period')"
    Write-Output "Downloading M365 active users report..."
    try {
        Invoke-MgGraphRequest -Method GET -Uri $reportUri -OutputFilePath $tempCsv
    } catch {
        Write-Error "Failed to download report: $_"; exit 1
    }
    Write-Output ("Downloaded raw report ({0} KB)." -f [Math]::Round((Get-Item $tempCsv).Length / 1KB, 1))

    $reader = [System.IO.File]::OpenText($tempCsv)
    try {
        $headerLine = $reader.ReadLine()
        $cols       = $headerLine.Split(',')
        $idxRefresh  = $cols.IndexOf("Report Refresh Date")
        $idxUPN      = $cols.IndexOf("User Principal Name")
        $idxProducts = $cols.IndexOf("Assigned Products")
        if ($idxRefresh -lt 0 -or $idxUPN -lt 0 -or $idxProducts -lt 0) {
            throw "Required columns missing from report. Columns found: $($cols -join ', ')"
        }

        $sb = [System.Text.StringBuilder]::new()
        [void]$sb.AppendLine("Report Refresh Date,User Principal Name,HasCopilot")

        $rowCount     = 0
        $copilotCount = 0
        $maskedCount  = 0
        while (($line = $reader.ReadLine()) -ne $null) {
            $row      = $line.Split(',')
            $refresh  = $row[$idxRefresh]
            $upn      = $row[$idxUPN]
            $products = $row[$idxProducts]
            if ($upn -match '^[A-F0-9]{32}$') { $maskedCount++ }
            $hasCopilot = $products -match "MICROSOFT 365 COPILOT"
            if ($hasCopilot) { $copilotCount++ }
            [void]$sb.AppendLine("$refresh,$upn,$hasCopilot")
            $rowCount++
        }

        if ($maskedCount -gt ($rowCount * 0.5)) {
            Write-Warning "WARNING: $maskedCount of $rowCount UPNs look masked (32-char hex)."
            Write-Warning "Fix: M365 admin - Org settings - Reports - untick 'Display concealed user, group, and site names'."
        }

        return @{ Csv = $sb.ToString(); RowCount = $rowCount; CopilotCount = $copilotCount }
    }
    finally {
        $reader.Close()
        Remove-Item $tempCsv -ErrorAction SilentlyContinue
    }
}

function UploadToSharePoint {
    param ([byte[]]$Bytes, [string]$DriveId, [string]$FolderPath, [string]$FileName)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $cleanFolder = ($FolderPath -replace '^/+', '' -replace '/+$', '')
    $uploadPath = if ([string]::IsNullOrWhiteSpace($cleanFolder)) { $FileName } else { "$cleanFolder/$FileName" }
    $encodedSegments = $uploadPath.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }
    $encodedPath = $encodedSegments -join '/'
    $uploadUri = "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/${encodedPath}:/content"
    Write-Output "Uploading $($Bytes.Length) bytes to: $uploadPath"
    try {
        Invoke-MgGraphRequest -Method PUT -Uri $uploadUri -Body $Bytes -ContentType 'text/csv' | Out-Null
        Write-Output "Upload complete."
    } catch { Write-Error "Failed to upload CSV to SharePoint: $_"; exit 1 }
}

#############################################################
# Main
#############################################################

ConnectToGraph

$result = DownloadAndProcess -Period $Period
Write-Output ""
Write-Output ("Built CSV with {0} users ({1} with Copilot license)." -f $result.RowCount, $result.CopilotCount)

if ([string]::IsNullOrWhiteSpace($FileName)) {
    $FileName = "M365CopilotUsers-{0}.csv" -f (Get-Date -Format 'yyyyMMddHHmmss')
}

$bytes = [System.Text.Encoding]::UTF8.GetBytes($result.Csv)
UploadToSharePoint -Bytes $bytes -DriveId $DriveId -FolderPath $FolderPath -FileName $FileName

Write-Output ""
Write-Output ("Done. Uploaded {0} users to SP folder: {1}" -f $result.RowCount, $(if ($FolderPath) { "$FolderPath/$FileName" } else { $FileName }))
