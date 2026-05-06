#############################################################
# Fabric path - Entra Org Data fetcher (AppReg auth)
#
# Pulls organisational data (manager, department, location, etc.) for all
# users from Microsoft Entra ID and writes the CSV to a local path.
# Companion to the SP-path Get-EntraOrgData-SP-AppReg.ps1, which uploads
# directly to a SharePoint document library instead.
#
# Required permission: User.Read.All (Application).
#
# Output schema (CSV columns):
#   userPrincipalName, displayName, department, jobTitle, companyName,
#   officeLocation, city, country, accountEnabled, managerUPN
#
# Contact: keithmcgrane@microsoft.com
#############################################################

param (
    [string]$OutputFolder = ".",

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

function ExportEntraOrgData {
    param ([string]$OutFile)

    $writer = [System.IO.StreamWriter]::new($OutFile, $false, [System.Text.Encoding]::UTF8)
    try {
        $cols = 'userPrincipalName','displayName','department','jobTitle','companyName','officeLocation','city','country','accountEnabled','managerUPN'
        $writer.WriteLine(($cols | ForEach-Object { '"{0}"' -f $_ }) -join ',')

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
                $writer.WriteLine($values -join ',')
                $rowCount++
            }
            $writer.Flush()
            Write-Output ("Processed {0} users..." -f $rowCount)
            $uri = $response.'@odata.nextLink'
        } while ($uri)

        Write-Output ("Exported {0} users to {1}" -f $rowCount, $OutFile)
    } catch {
        Write-Error "Failed to fetch / export Entra org data: $_"; exit 1
    } finally {
        $writer.Dispose()
    }
}

#############################################################
# Main
#############################################################

if (-not (Test-Path $OutputFolder)) {
    New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null
}
$resolvedOut = (Resolve-Path $OutputFolder).Path
$outFile     = Join-Path $resolvedOut ("EntraOrgData-{0}.csv" -f (Get-Date -Format 'yyyyMMddHHmmss'))

ConnectToGraph
ExportEntraOrgData -OutFile $outFile

Write-Output ""
Write-Output "Done. Output: $outFile"
