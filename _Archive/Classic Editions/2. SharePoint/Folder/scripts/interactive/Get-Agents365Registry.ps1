#############################################################
# *** EXPERIMENTAL ***
#
# Script to extract the Agent 365 Registry (Copilot agents catalog) from
# Microsoft Graph and export to CSV. Output is a flat CSV with one row per
# registered agent / package, suitable as the "Agent 365" input to the
# AI-in-One / AI Business Value PBIP dashboards.
#
# *** STATUS: NOT YET VALIDATED ***
# The Microsoft Graph endpoint for the Agent 365 admin registry is in flux
# and the defaults below have not been confirmed against a live tenant with
# Agent 365 licensing. Initial testing returned HTTP 403 ("Customer must be
# licensed for Agent 365") even in tenants that DO have Agent 365 - which
# strongly suggests the endpoint or scope below is wrong.
#
# To find the correct values for now:
#   1. Open the M365 admin centre at admin.cloud.microsoft/agents/all
#   2. Press F12 -> Network tab -> reload the page
#   3. Inspect the requests that return the agent list - that's the real
#      endpoint and scope you need
#   4. Override -Endpoint and -GraphScope on the command line
#
# Until the defaults are verified, treat output of this script as best-effort.
# Run interactively as a tenant admin (or any user with the required scope
# delegated). For unattended runs, adapt the auth pattern from
# /appreg/CreateAuditLogQuery-AppReg.ps1.
#
# CSV schema is dynamic - whatever fields the API returns become columns.
# This keeps the script forward-compatible if the API adds new fields.
#############################################################

param (
    [string]$OutputCsv  = ".\Agents365Registry.csv",
    [string]$Endpoint   = "https://graph.microsoft.com/beta/copilot/admin/catalog/packages",
    [string]$GraphScope = "CopilotPackages.Read.All"
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
        Connect-MgGraph -Scopes $GraphScope -NoWelcome
        Write-Host "Connected to Microsoft Graph."
    }
    catch {
        Write-Host "Failed to connect to Microsoft Graph: $_"
        exit 1
    }
}

function ExportAgents365Registry {
    param (
        [string]$OutputCsvPath
    )
    try {
        $OutputCsvPath = Join-Path -Path (Get-Location) -ChildPath $OutputCsvPath

        $writer        = [System.IO.StreamWriter]::new($OutputCsvPath, $false, [System.Text.Encoding]::UTF8)
        $rowCount      = 0
        $headerWritten = $false
        $headerKeys    = @()

        # Page through the catalog
        $uri = "$Endpoint`?`$top=999"
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri

            foreach ($item in $response.value) {
                # Header line - dynamic schema based on first item's keys
                if (-not $headerWritten) {
                    $headerKeys  = @($item.Keys)
                    $writer.WriteLine(($headerKeys | ForEach-Object { '"{0}"' -f ($_ -replace '"','""') }) -join ',')
                    $headerWritten = $true
                }

                # Row - one value per known key (in same order)
                $values = foreach ($k in $headerKeys) {
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
            Write-Host "Processed $rowCount agents..." -ForegroundColor Green
            $uri = $response.'@odata.nextLink'
        } while ($uri)

        $writer.Dispose()
        Write-Host "Exported $rowCount agents to: $OutputCsvPath" -ForegroundColor Green
    }
    catch {
        Write-Host "Failed to export Agents 365 registry: $_" -ForegroundColor Red
        exit 1
    }
}

#############################################################
# Main
#############################################################

ConnectToGraph
ExportAgents365Registry -OutputCsvPath $OutputCsv
