#############################################################
# Script to extract organisational data (manager, department, etc) for all
# users from Microsoft Entra ID via Microsoft Graph and export to CSV.
#
# Output is a flat CSV with one row per user, suitable as the "Org Data"
# input to the AI-in-One / AI Business Value PBIP dashboards.
#
# Run this interactively as a tenant admin (or any user with User.Read.All
# delegated permission). For unattended runs, adapt the auth pattern from
# /appreg/CreateAuditLogQuery-AppReg.ps1.
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
#   accountEnabled     - TRUE/FALSE
#   managerUPN         - UPN of direct manager (blank if no manager)
#############################################################

param (
    [string]$OutputCsv = ".\EntraOrgData.csv"
)

#############################################################
# Dependencies
#############################################################

foreach ($mod in 'Microsoft.Graph.Authentication') {
    if (-not (Get-Module -ListAvailable -Name $mod)) {
        try {
            Write-Host "Installing module: $mod..."
            Install-Module -Name $mod -Force -AllowClobber -Scope CurrentUser
        }
        catch {
            Write-Host "Failed to install module '$mod': $_"
            exit 1
        }
    }
}

#############################################################
# Functions
#############################################################

function ConnectToGraph {
    try {
        Connect-MgGraph -Scopes "User.Read.All" -NoWelcome
        Write-Host "Connected to Microsoft Graph."
    }
    catch {
        Write-Host "Failed to connect to Microsoft Graph: $_"
        exit 1
    }
}

function ExportEntraOrgData {
    param (
        [string]$OutputCsvPath
    )
    try {
        $OutputCsvPath = Join-Path -Path (Get-Location) -ChildPath $OutputCsvPath

        $writer = [System.IO.StreamWriter]::new($OutputCsvPath, $false, [System.Text.Encoding]::UTF8)
        $cols = 'userPrincipalName','displayName','department','jobTitle','companyName','officeLocation','city','country','accountEnabled','managerUPN'
        $writer.WriteLine(($cols | ForEach-Object { '"{0}"' -f $_ }) -join ',')

        # Page through users with manager expanded
        $selectFields = 'userPrincipalName,displayName,department,jobTitle,companyName,officeLocation,city,country,accountEnabled'
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
            Write-Host "Processed $rowCount users..." -ForegroundColor Green
            $uri = $response.'@odata.nextLink'
        } while ($uri)

        $writer.Dispose()
        Write-Host "Exported $rowCount users to: $OutputCsvPath" -ForegroundColor Green
    }
    catch {
        Write-Host "Failed to export Entra org data: $_" -ForegroundColor Red
        exit 1
    }
}

#############################################################
# Main
#############################################################

ConnectToGraph
ExportEntraOrgData -OutputCsvPath $OutputCsv
