# Interactive scripts (browser sign-in)

These scripts run **once at a time, with the admin signing in via a browser pop-up**. They're the friendly counterpart to the `appreg/` scripts — same data pulls, but no service principal / no stored secrets / no scheduling. Useful for:

- Ad-hoc data extraction without setting up an app registration
- First-run validation that the Graph endpoints + permissions are correct in the tenant
- Testing changes before promoting to the scheduled `appreg/` flow

## Scripts in this folder

| Script | Purpose | Required scope (delegated) |
|---|---|---|
| `create-query.ps1` | Creates a Microsoft Purview audit log query for the date range. Prints the Query ID to the console. | `AuditLogsQuery.Read.All` |
| `get-copilot-interactions.ps1` | Fetches the query results and writes a CSV to your local disk. | `AuditLogsQuery.Read.All` |
| `get-copilot-users.ps1` | Pulls the M365 active user report + Copilot license flag, writes a CSV locally. | `Reports.Read.All` |
| `Get-EntraOrgData.ps1` | Pulls org structure (manager, dept, location) for all users, writes a CSV locally. | `User.Read.All` |
| `Get-Agents365Registry.ps1` | **Experimental.** Tries the Microsoft Graph Agent 365 catalog endpoint. Currently returns 403 unless the tenant has paid Agent 365 licensing — see header comment. Manual export from `admin.cloud.microsoft/agents` is the supported fallback today. | `CopilotPackages.Read.All` |

## Authentication

Each script calls `Connect-MgGraph -Scopes <required-scope>` which pops up a browser sign-in. The signed-in user must have a role granting them the listed scope **delegated** (the user's own permissions, not an app reg). Typical roles:

| Scope | User needs role |
|---|---|
| `AuditLogsQuery.Read.All` | Compliance Administrator (or Compliance Data Administrator) |
| `Reports.Read.All` | Reports Reader / Global Reader |
| `User.Read.All` | Global Reader / User Administrator |

## Typical run

```powershell
# 1. Create the audit query
.\create-query.ps1 -startDate (Get-Date).AddDays(-7) -endDate (Get-Date)
# Copy the QueryId from the output, then wait ~30 mins for Purview to process

# 2. Fetch the results to a local CSV
.\get-copilot-interactions.ps1 -AuditLogQueryId <id-from-step-1> -OutFile .\Interactions.csv

# 3. (Independently) pull users + org data
.\get-copilot-users.ps1 -OutFile .\Users.csv
.\Get-EntraOrgData.ps1 -OutFile .\OrgData.csv
```

The output CSVs match the schema the parent PBIT consumes (15-column pre-parsed format for interactions, etc.) — you can either:
- Upload them to SharePoint manually and point the PBIT at the URLs
- Use them directly with the local-CSV variant of the dashboard ([`../../1. Manual/`](../../../1.%20Manual/) — if it exists in this repo)

For unattended / scheduled runs, switch to [`../appreg/`](../appreg/).
