#############################################################
# SharePoint path - Copilot Interactions fetcher (AppReg auth)
#
# Fetches records from a completed Microsoft Purview audit log query,
# applies the pre-parsed flattening (15 columns), and uploads
# the resulting CSV to a SharePoint document library.
#
# Output schema (15 columns):
#   CreationDate, AgentId, AgentName, Agent_TitleID, AppIdentity,
#   Audit_UserId, AppHost, ThreadId, Context_Type, AISystemPlugin (JSON),
#   ModelTransparencyDetails_ModelProviderName, ModelTransparencyDetails_ModelName,
#   AccessedResources (JSON), Message_Id, Resource_Count
#
# This is the format the new SP-Path PBITs consume directly via
# Web.Contents + Csv.Document + Table.PromoteHeaders.
#
# Authentication: app registration (managed identity / client secret / cert).
# Permissions needed (Application):
#   - AuditLogsQuery.Read.All
#   - Sites.Selected (granted on the target site via ProvisionSiteAccess)
#
# Contact: keithmcgrane@microsoft.com / alexgrover@microsoft.com
#############################################################

param (
    [Parameter(Mandatory)]
    [string]$AuditLogQueryId,

    [Parameter(Mandatory)]
    [string]$DriveId,

    [string]$FolderPath = "",                      # e.g. "Documents/Scripts Testing". Empty = drive root.
    [string]$FileName   = "",                      # Override the default filename. Empty = auto-generated with timestamp.
    [int]$AuditLogFetchRetrySeconds = 30,
    [int]$MaxStatusChecks = 60,

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

foreach ($mod in @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Beta.Security')) {
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

function WaitForQuerySucceeded {
    param ([string]$QueryId)
    for ($i = 1; $i -le $MaxStatusChecks; $i++) {
        try { $q = Get-MgBetaSecurityAuditLogQuery -AuditLogQueryId $QueryId -ErrorAction Stop }
        catch { Write-Error "Failed to get query status: $_"; exit 1 }
        if ($q.status -eq "succeeded") { Write-Output "Query $QueryId succeeded."; return $q }
        Write-Output ("[{0}/{1}] Query status: {2}. Waiting {3}s..." -f $i, $MaxStatusChecks, $q.status, $AuditLogFetchRetrySeconds)
        Start-Sleep -Seconds $AuditLogFetchRetrySeconds
    }
    Write-Error "Query did not succeed within $MaxStatusChecks status checks. Aborting."; exit 1
}

# Build the pre-parsed-format CSV in memory by streaming records and applying the 15-column flatten.
function BuildPreParsedCsv {
    param ([string]$QueryId)

    $headers = @(
        'CreationDate','AgentId','AgentName','Agent_TitleID','AppIdentity','Audit_UserId',
        'AppHost','ThreadId','Context_Type','AISystemPlugin',
        'ModelTransparencyDetails_ModelProviderName','ModelTransparencyDetails_ModelName',
        'AccessedResources','Message_Id','Resource_Count'
    )

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine(($headers | ForEach-Object { '"{0}"' -f $_ }) -join ',')

    $uri = "https://graph.microsoft.com/beta/security/auditLog/queries/$QueryId/records?top=999"
    $rowCount = 0

    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        foreach ($record in $response.value) {
            $ad = $record.auditData
            $ce = $ad.CopilotEventData

            $CreationDate = '"{0:O}"' -f [DateTime]$record.createdDateTime
            $AgentId      = $ad.AgentId
            $AgentName    = $ad.AgentName
            $Agent_TitleID = if ($AgentId -match '\b[A-Z]_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b') { $matches[0] } else { '' }
            $AppIdentity  = if ($ad.appIdentity -is [string]) { $ad.appIdentity } else { ($ad.appIdentity | ConvertTo-Json -Compress -Depth 5) }
            $Audit_UserId = if ($ad.userId) { ($ad.userId -as [string]).Trim().ToLower() } else { '' }
            $AppHost      = if ($ce) { $ce.AppHost } else { '' }
            $ThreadId     = if ($ce) { $ce.Threadid } else { '' }

            $Context_Type = ''
            if ($ce -and $ce.Contexts -and $ce.Contexts.Count -gt 0) {
                $Context_Type = $ce.Contexts[0].Type
            }

            $AISystemPlugin = ''
            if ($ce -and $ce.AISystemPlugin) {
                $AISystemPlugin = '"{0}"' -f (($ce.AISystemPlugin | ConvertTo-Json -Compress -Depth 10) -replace '"','""')
            }

            $ModelTransparencyDetails_ModelProviderName = ''
            $ModelTransparencyDetails_ModelName         = ''
            if ($ce -and $ce.ModelTransparencyDetails -and $ce.ModelTransparencyDetails.Count -gt 0) {
                $ModelTransparencyDetails_ModelName         = $ce.ModelTransparencyDetails[0].ModelName
                $ModelTransparencyDetails_ModelProviderName = $ce.ModelTransparencyDetails[0].ModelProviderName
            }

            $AccessedResources = ''
            $Resource_Count = 0
            if ($ce -and $ce.AccessedResources) {
                $AccessedResources = '"{0}"' -f (($ce.AccessedResources | ConvertTo-Json -Compress -Depth 10) -replace '"','""')
                $Resource_Count = $ce.AccessedResources.Count
            }

            $Message_Id = ''
            if ($ce -and $ce.Messages) {
                $promptMsg = $ce.Messages | Where-Object { $_.isPrompt -or [string]::IsNullOrEmpty($_.isPrompt) } | Select-Object -First 1
                if ($promptMsg) { $Message_Id = $promptMsg.Id }
            }

            $row = @($CreationDate, $AgentId, $AgentName, $Agent_TitleID, $AppIdentity, $Audit_UserId,
                $AppHost, $ThreadId, $Context_Type, $AISystemPlugin,
                $ModelTransparencyDetails_ModelProviderName, $ModelTransparencyDetails_ModelName,
                $AccessedResources, $Message_Id, $Resource_Count) -join ','
            [void]$sb.AppendLine($row)
            $rowCount++
        }
        Write-Output ("Processed {0} records..." -f $rowCount)
        $uri = $response.'@odata.nextLink'
    } while ($uri)

    return @{ Csv = $sb.ToString(); RowCount = $rowCount }
}

function UploadToSharePoint {
    param ([byte[]]$Bytes, [string]$DriveId, [string]$FolderPath, [string]$FileName)

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    # Build the upload URI. Folder path is appended via Graph's "root:/path/file:/content" syntax.
    $cleanFolder = ($FolderPath -replace '^/+', '' -replace '/+$', '')   # trim leading/trailing slashes
    $uploadPath = if ([string]::IsNullOrWhiteSpace($cleanFolder)) { $FileName } else { "$cleanFolder/$FileName" }

    # URL-encode the path segments (preserves the slashes between folder and filename)
    $encodedSegments = $uploadPath.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }
    $encodedPath = $encodedSegments -join '/'

    $uploadUri = "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/${encodedPath}:/content"
    Write-Output "Uploading $($Bytes.Length) bytes to: $uploadPath"

    try {
        Invoke-MgGraphRequest -Method PUT -Uri $uploadUri -Body $Bytes -ContentType 'text/csv' | Out-Null
        Write-Output "Upload complete."
    } catch {
        Write-Error "Failed to upload CSV to SharePoint: $_"; exit 1
    }
}

#############################################################
# Main
#############################################################

ConnectToGraph
WaitForQuerySucceeded -QueryId $AuditLogQueryId | Out-Null

$result = BuildPreParsedCsv -QueryId $AuditLogQueryId
Write-Output ""
Write-Output ("Built CSV with {0} rows ({1} bytes)." -f $result.RowCount, $result.Csv.Length)

if ([string]::IsNullOrWhiteSpace($FileName)) {
    $FileName = "CopilotInteractionsReport-{0}-{1}.csv" -f (Get-Date -Format 'yyyyMMddHHmmss'), $AuditLogQueryId
}

$bytes = [System.Text.Encoding]::UTF8.GetBytes($result.Csv)
UploadToSharePoint -Bytes $bytes -DriveId $DriveId -FolderPath $FolderPath -FileName $FileName

Write-Output ""
Write-Output ("Done. Uploaded {0} records to SP folder: {1}" -f $result.RowCount, $(if ($FolderPath) { "$FolderPath/$FileName" } else { $FileName }))
