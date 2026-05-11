#############################################################
# Fabric path - Copilot Interactions fetcher (AppReg auth)
#
# Fetches records from a completed Microsoft Purview audit log query and
# writes the RAW format CSV to a local path. Output is intended to be picked
# up by a Fabric Data Pipeline / Lakehouse notebook for downstream parsing.
#
# Companion script: CreateAuditLogQuery-AppReg.ps1 (already exists in
# /customer-facing/appreg/) - run that first to create a query, then run
# this script with the returned AuditLogQueryId.
#
# Output schema: raw Graph schema (RecordId, CreationDate, RecordType,
# Operation, UserId, AuditData [JSON blob], AssociatedAdminUnits,
# AssociatedAdminUnitsNames, etc. - whatever the API returns).
#
# Authentication: app registration (managed identity / client secret / cert).
# Permissions needed: AuditLogsQuery.Read.All (Application).
#
# Contact: keithmcgrane@microsoft.com / alexgrover@microsoft.com
#############################################################

param (
    [Parameter(Mandatory)]
    [string]$AuditLogQueryId,

    [string]$OutputFolder = ".",
    [int]$AuditLogFetchRetrySeconds = 30,
    [int]$MaxStatusChecks = 60,                # ~30 mins of polling at default retry interval

    # App registration auth (leave all blank to use managed identity in Azure Automation)
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

foreach ($mod in @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Beta.Security')) {
    if (-not (Get-Module -ListAvailable -Name $mod)) {
        try {
            Write-Output "Installing module: $mod..."
            Install-Module -Name $mod -Force -AllowClobber -Scope CurrentUser
        } catch {
            Write-Error "Failed to install module '$mod': $_"; exit 1
        }
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
            "AppCert" {
                Connect-MgGraph -ClientId $ClientId -TenantId $TenantId -CertificateThumbprint $CertificateThumbprint -NoWelcome
            }
        }
        Write-Output "Connected to Microsoft Graph."
    } catch {
        Write-Error "Failed to connect to Microsoft Graph: $_"; exit 1
    }
}

# Wait until the query has succeeded server-side (or give up)
function WaitForQuerySucceeded {
    param ([string]$QueryId)
    for ($i = 1; $i -le $MaxStatusChecks; $i++) {
        try {
            $q = Get-MgBetaSecurityAuditLogQuery -AuditLogQueryId $QueryId -ErrorAction Stop
        } catch {
            Write-Error "Failed to get query status: $_"; exit 1
        }
        if ($q.status -eq "succeeded") {
            Write-Output "Query $QueryId succeeded."
            return $q
        }
        Write-Output ("[{0}/{1}] Query status: {2}. Waiting {3}s..." -f $i, $MaxStatusChecks, $q.status, $AuditLogFetchRetrySeconds)
        Start-Sleep -Seconds $AuditLogFetchRetrySeconds
    }
    Write-Error "Query did not succeed within $MaxStatusChecks status checks. Aborting."
    exit 1
}

function FetchAndExportRaw {
    param ([string]$QueryId, [string]$OutFile)

    $writer        = $null
    $rowCount      = 0
    $headerWritten = $false
    $headers       = @()

    try {
        $writer = [System.IO.StreamWriter]::new($OutFile, $false, [System.Text.Encoding]::UTF8)

        $uri = "https://graph.microsoft.com/beta/security/auditLog/queries/$QueryId/records?top=999"
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
            foreach ($item in $response.value) {

                # Discover headers from the first record (whatever Graph returns)
                if (-not $headerWritten) {
                    $headers = @($item.Keys)
                    $headerLine = ($headers | ForEach-Object { '"{0}"' -f ($_ -replace '"','""') }) -join ','
                    $writer.WriteLine($headerLine)
                    $headerWritten = $true
                }

                # Build the row in same key order
                $values = foreach ($k in $headers) {
                    $v = $item[$k]
                    if ($null -eq $v)            { '""' }
                    elseif ($v -is [string])     { '"{0}"' -f ($v -replace '"','""') }
                    elseif ($v -is [bool])       { $v.ToString() }
                    elseif ($v -is [DateTime])   { '"{0:O}"' -f $v }
                    else {
                        $json = $v | ConvertTo-Json -Compress -Depth 10
                        '"{0}"' -f ($json -replace '"','""')
                    }
                }
                $writer.WriteLine($values -join ',')
                $rowCount++
            }
            $writer.Flush()
            Write-Output ("Processed {0} records..." -f $rowCount)
            $uri = $response.'@odata.nextLink'
            if ($uri) { Start-Sleep -Milliseconds 200 }   # gentle pacing
        } while ($uri)

        Write-Output ("Exported {0} records to {1}" -f $rowCount, $OutFile)
    } catch {
        Write-Error "Failed during fetch / export: $_"; exit 1
    } finally {
        if ($writer) { $writer.Dispose() }
    }
}

#############################################################
# Main
#############################################################

if (-not (Test-Path $OutputFolder)) {
    New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null
}
$resolvedOut = (Resolve-Path $OutputFolder).Path
$outFile     = Join-Path $resolvedOut ("CopilotInteractionsReport-{0}-{1}.csv" -f (Get-Date -Format 'yyyyMMddHHmmss'), $AuditLogQueryId)

ConnectToGraph
WaitForQuerySucceeded -QueryId $AuditLogQueryId | Out-Null
FetchAndExportRaw -QueryId $AuditLogQueryId -OutFile $outFile

Write-Output ""
Write-Output "Done. Output: $outFile"
