#############################################################
# Script to get Microsoft 365 Copilot Users from Microsoft Graph and export to CSV
# Contact alexgrover@microsoft.com for questions

#############################################################
# Parameters
#############################################################

param (
    [string]$tempCSVLocation = ".\tempM365Users.csv",
    [string]$outputCSV = ".\M365CopilotUsers.csv"
)



#############################################################
# Dependencies
#############################################################

# Check if Microsoft Graph module is already installed
$module = Get-Module -ListAvailable | Where-Object { $_.Name -eq 'Microsoft.Graph.Reports' }

if ($module -eq $null) {
    try {
        Write-Host "Installing module..."
        Install-Module -Name Microsoft.Graph -Force -AllowClobber -Scope CurrentUser
    } 
    catch {
        Write-Host "Failed to install module: $_"
        exit
    }
}

#############################################################
# Functions
#############################################################

# Connect to Microsoft Graph
function ConnectToGraph {
    try {
        Connect-MgGraph -Scopes "Reports.Read.All" -NoWelcome
        Write-Host "Connected to Microsoft Graph."
    }
    catch {
        Write-Host "Failed to connect to Microsoft Graph: $_"
        exit 1
    }
}


# Get all users from Microsoft Graph
function GetAllUsers {
    try {
        Get-MgReportOffice365ActiveUserDetail -Period D7 -OutFile $tempCSVLocation
    }
    catch {
        Write-Host "Failed to get users from Microsoft Graph: $_"
        exit 1
    }
}

# Process the user report and extract Report
# Reads the CSV line-by-line (memory efficient for teanats with 100K+ users)

# Extracts only: Report Refresh Date, User Principal Name, Adds a third column: HasCopilot = TRUE/FALSE
# TRUE if the users Assigned Products Array contains "MICROSOFT 365 COPILOT"
function ProcessUserReport {
    param (
        [string]$inputCSV,
        [string]$outputCSV
    )

    # Get full path for input file
    $inputCSV = (Resolve-Path $inputCSV).Path

    # build output filepath using pwd (can't use Resolve-Path for new file)
    $outputCSV = Join-Path -Path (Get-Location) -ChildPath $outputCSV

    try {
        $reader = [System.IO.File]::OpenText($inputCSV)
        $writer = New-Object System.IO.StreamWriter($outputCSV, $false, [System.Text.Encoding]::UTF8)

        # --- Read header and find column positions ---
        $headerLine = $reader.ReadLine()
        $headers = $headerLine.Split(',')

        $idxRefresh = $headers.IndexOf("Report Refresh Date")
        $idxUPN = $headers.IndexOf("User Principal Name")
        $idxProducts = $headers.IndexOf("Assigned Products")    

        if ($idxRefresh -lt 0 -or $idxUPN -lt 0 -or $idxProducts -lt 0) {
            throw "One or more required columns missing from CSV"
        }

        # --- Write output header ---
        $writer.WriteLine("Report Refresh Date,User Principal Name,HasCopilot")

        # --- Stream rows ---
        while (($line = $reader.ReadLine()) -ne $null) {

            $cols = $line.Split(',')

            $refresh = $cols[$idxRefresh]
            $upn = $cols[$idxUPN]
            $products = $cols[$idxProducts]

            # Check if the product array contains Copilot
            $hasCopilot = $products -match "MICROSOFT 365 COPILOT"

            $writer.WriteLine("$refresh,$upn,$hasCopilot")
        }

        $reader.Close()
        $writer.Close()
    }
    catch {
        Write-Host "Failed to process user report: $_"
        exit 1
    }
}


#############################################################
# Main Script
#############################################################

# Connect to Microsoft Graph
ConnectToGraph

# Get all users and save to temp CSV
GetAllUsers

# Process the user report and output final CSV
ProcessUserReport -inputCSV $tempCSVLocation -outputCSV $outputCSV

### Cleanup temp file
Remove-Item $tempCSVLocation -ErrorAction SilentlyContinue

Write-Host "M365 Copilot user report generated"