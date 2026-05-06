#############################################################
# Fabric path - Copilot Licensed Users fetcher (AppReg auth)
#
# Pulls the M365 active user detail report and adds a HasCopilot flag.
# Mirrors the interactive get-copilot-users.ps1 but with app registration
# auth and writes the CSV to a local path (Fabric Data Pipeline picks up).
#
# Required permission: Reports.Read.All (Application).
# Note: Microsoft 365 admin centre - Settings - Org settings - Reports
#   must have "Display concealed user, group, and site names" UNTICKED
#   to get real UPNs in the report. If left ticked, all UPNs are masked
#   (32-char hex strings) and the join to interactions data fails.
#
# Output schema (CSV columns): Report Refresh Date, User Principal Name, HasCopilot
#
# Contact: keithmcgrane@microsoft.com / alexgrover@microsoft.com
#############################################################

param (
    [string]$OutputFolder = ".",
    [ValidateSet('D7','D30','D90','D180')]
    [string]$Period = 'D7',

    # App registration auth (leave all blank to use managed identity)
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
        try {
            Write-Output "Installing module: $mod..."
            Install-Module -Name $mod -Force -AllowClobber -Scope CurrentUser
        } catch { Write-Error "Failed to install module '$mod': $_"; exit 1 }
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

# Streams the report CSV from /reports/getOffice365ActiveUserDetail to a temp file,
# processes line-by-line into the final HasCopilot CSV.
function DownloadAndProcessReport {
    param ([string]$OutFile, [string]$Period)

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
    $writer = New-Object System.IO.StreamWriter($OutFile, $false, [System.Text.Encoding]::UTF8)

    try {
        $headerLine = $reader.ReadLine()
        $cols       = $headerLine.Split(',')
        $idxRefresh  = $cols.IndexOf("Report Refresh Date")
        $idxUPN      = $cols.IndexOf("User Principal Name")
        $idxProducts = $cols.IndexOf("Assigned Products")
        if ($idxRefresh -lt 0 -or $idxUPN -lt 0 -or $idxProducts -lt 0) {
            throw "Required columns missing from report. Columns found: $($cols -join ', ')"
        }
        $writer.WriteLine("Report Refresh Date,User Principal Name,HasCopilot")

        $rowCount     = 0
        $copilotCount = 0
        $maskedCount  = 0
        while (($line = $reader.ReadLine()) -ne $null) {
            $row = $line.Split(',')
            $refresh  = $row[$idxRefresh]
            $upn      = $row[$idxUPN]
            $products = $row[$idxProducts]
            if ($upn -match '^[A-F0-9]{32}$') { $maskedCount++ }
            $hasCopilot = $products -match "MICROSOFT 365 COPILOT"
            if ($hasCopilot) { $copilotCount++ }
            $writer.WriteLine("$refresh,$upn,$hasCopilot")
            $rowCount++
        }
        $writer.Flush()

        Write-Output ""
        Write-Output ("Exported {0} users ({1} with Copilot license) to {2}" -f $rowCount, $copilotCount, $OutFile)
        if ($maskedCount -gt ($rowCount * 0.5)) {
            Write-Warning "WARNING: $maskedCount of $rowCount UPNs look masked (32-char hex)."
            Write-Warning "Fix: M365 admin centre - Settings - Org settings - Reports - untick"
            Write-Warning "     'Display concealed user, group, and site names in all reports'."
            Write-Warning "Wait ~10 mins to propagate, then re-run this script."
        }
    } finally {
        $reader.Close()
        $writer.Close()
        $writer.Dispose()
        Remove-Item $tempCsv -ErrorAction SilentlyContinue
    }
}

#############################################################
# Main
#############################################################

if (-not (Test-Path $OutputFolder)) {
    New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null
}
$resolvedOut = (Resolve-Path $OutputFolder).Path
$outFile     = Join-Path $resolvedOut ("M365CopilotUsers-{0}.csv" -f (Get-Date -Format 'yyyyMMddHHmmss'))

ConnectToGraph
DownloadAndProcessReport -OutFile $outFile -Period $Period

Write-Output ""
Write-Output "Done. Output: $outFile"
