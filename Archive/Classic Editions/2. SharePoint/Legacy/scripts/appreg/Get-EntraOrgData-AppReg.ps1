#############################################################
# Script to extract organisational data (manager, department, etc) for all
# users from Microsoft Entra ID via Microsoft Graph and upload the CSV to
# a SharePoint document library. Designed to run unattended in Azure
# Automation alongside the Copilot interactions runbooks.
#
# Supports managed identity (default), app registration + secret, or
# app registration + certificate.
#
# Permissions needed (Application):
# - For Microsoft Graph: User.Read.All, Sites.Selected
#
# Output schema (CSV columns):
#   userPrincipalName  - join key (auto-renames to PersonId in PBIP Power Query)
#   displayName
#   department
#   jobTitle
#   companyName
#   officeLocation
#   city
#   country
#   accountEnabled
#   managerUPN
#############################################################

#############################################################
# Parameters
#############################################################

param (
    [string]$DriveId = "",  # Graph Drive ID of the target SharePoint document library

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
    if ($useSecret -and $useCert) {
        Write-Error "Provide either -ClientSecret OR -CertificateThumbprint, not both."
        exit 1
    }
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
    if ($useSecret) { $authMode = "AppSecret" } else { $authMode = "AppCert" }
} else {
    $authMode = "ManagedIdentity"
}

if ([string]::IsNullOrWhiteSpace($DriveId)) {
    Write-Error "-DriveId is required (target SharePoint document library)."
    exit 1
}

Write-Output "Auth mode: $authMode"

#############################################################
# Dependencies
#############################################################

foreach ($moduleName in @('Microsoft.Graph.Authentication')) {
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
# Functions
#############################################################

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

# Build the full CSV in a memory stream, then upload to SharePoint in one go.
# Org-data exports are small enough (under a few MB even for large tenants)
# that chunked streaming is overkill; a single PUT to a small-file upload URL
# is simpler and reliable.
function ExportEntraOrgDataAndUpload {
    param (
        [Parameter(Mandatory)]
        [string]$DriveId,

        [Parameter(Mandatory)]
        [string]$FileName
    )

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $cols = 'userPrincipalName','displayName','department','jobTitle','companyName','officeLocation','city','country','accountEnabled','managerUPN'

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine(($cols | ForEach-Object { '"{0}"' -f $_ }) -join ',')

    $selectFields  = 'userPrincipalName,displayName,department,jobTitle,companyName,officeLocation,city,country,accountEnabled'
    $expandManager = 'manager($select=userPrincipalName)'
    $uri = "https://graph.microsoft.com/v1.0/users?`$select=$selectFields&`$expand=$expandManager&`$top=999"
    $rowCount = 0

    try {
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
            Write-Output "Processed $rowCount users..."
            $uri = $response.'@odata.nextLink'
        } while ($uri)
    }
    catch {
        Write-Error "Failed to fetch users from Graph: $_"
        exit 1
    }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
    Write-Output ("CSV built in memory: {0} rows / {1} KB. Uploading..." -f $rowCount, [Math]::Round($bytes.Length / 1KB, 1))

    # Use simple PUT (single chunk) since the file is small.
    try {
        $uploadUri = "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/$($FileName):/content"
        Invoke-MgGraphRequest -Method PUT -Uri $uploadUri -Body $bytes -ContentType 'text/csv' | Out-Null
        Write-Output "Successfully uploaded $rowCount users to $FileName"
    }
    catch {
        Write-Error "Failed to upload CSV to SharePoint: $_"
        exit 1
    }
}

#############################################################
# Main Script Execution
#############################################################

ConnectToGraph

$TargetFileName = "EntraOrgData-$(Get-Date -Format 'yyyyMMddHHmmss').csv"
ExportEntraOrgDataAndUpload -DriveId $DriveId -FileName $TargetFileName

Write-Output "Entra org data report generated at: $TargetFileName"
