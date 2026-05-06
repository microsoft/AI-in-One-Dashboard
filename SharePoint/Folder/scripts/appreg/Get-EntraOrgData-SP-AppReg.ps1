#############################################################
# SharePoint path - Entra Org Data fetcher (AppReg auth)
#
# Pulls organisational data (manager, department, location, etc.) for
# all users from Microsoft Entra ID and uploads the CSV to SharePoint.
#
# Required permissions (Application):
#   - User.Read.All
#   - Sites.Selected (granted on the target site via ProvisionSiteAccess)
#
# Output schema (10 columns):
#   userPrincipalName, displayName, department, jobTitle, companyName,
#   officeLocation, city, country, accountEnabled, managerUPN
#
# Contact: keithmcgrane@microsoft.com
#############################################################

param (
    [Parameter(Mandatory)]
    [string]$DriveId,

    [string]$FolderPath = "",
    [string]$FileName   = "",

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

function BuildOrgDataCsv {
    $cols = 'userPrincipalName','displayName','department','jobTitle','companyName','officeLocation','city','country','accountEnabled','managerUPN'

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine(($cols | ForEach-Object { '"{0}"' -f $_ }) -join ',')

    $selectFields  = 'userPrincipalName,displayName,department,jobTitle,companyName,officeLocation,city,country,accountEnabled'
    $expandManager = 'manager($select=userPrincipalName)'
    $uri = "https://graph.microsoft.com/v1.0/users?`$select=$selectFields&`$expand=$expandManager&`$top=999"
    $rowCount = 0

    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        foreach ($u in $response.value) {
            $managerUpn = ''
            if ($u.manager) { $managerUpn = $u.manager.userPrincipalName }
            $values = @(
                $u.userPrincipalName, $u.displayName, $u.department, $u.jobTitle,
                $u.companyName, $u.officeLocation, $u.city, $u.country,
                [string]$u.accountEnabled, $managerUpn
            ) | ForEach-Object {
                if ($null -eq $_) { '""' } else { '"{0}"' -f ($_ -replace '"','""') }
            }
            [void]$sb.AppendLine($values -join ',')
            $rowCount++
        }
        Write-Output ("Processed {0} users..." -f $rowCount)
        $uri = $response.'@odata.nextLink'
    } while ($uri)

    return @{ Csv = $sb.ToString(); RowCount = $rowCount }
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
$result = BuildOrgDataCsv
Write-Output ""
Write-Output ("Built CSV with {0} users." -f $result.RowCount)

if ([string]::IsNullOrWhiteSpace($FileName)) {
    $FileName = "EntraOrgData-{0}.csv" -f (Get-Date -Format 'yyyyMMddHHmmss')
}

$bytes = [System.Text.Encoding]::UTF8.GetBytes($result.Csv)
UploadToSharePoint -Bytes $bytes -DriveId $DriveId -FolderPath $FolderPath -FileName $FileName

Write-Output ""
Write-Output ("Done. Uploaded {0} users to SP folder: {1}" -f $result.RowCount, $(if ($FolderPath) { "$FolderPath/$FileName" } else { $FileName }))
