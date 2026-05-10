# Unattended scripts (App Registration auth)

These scripts run unattended via service principal — designed for scheduled jobs (Task Scheduler, Azure Automation, GitHub Actions, etc.). They auth via app registration (managed identity / client secret / certificate) and upload CSVs to SharePoint.

For full deployment instructions including app registration setup, see the parent [`README.md`](../../README.md). For the one-time tenant + site provisioning helpers, see [`../provisioning/`](../provisioning/).

## Scripts in this folder

| Script | Purpose | Required scope |
|---|---|---|
| `CreateAuditLogQuery-AppReg.ps1` | Creates a Microsoft Purview audit log query for the date range. Returns a Query ID. Schedule weekly (e.g. midnight Sunday). | `AuditLogsQuery.Read.All` |
| `GetCopilotInteractions-SP-AppReg.ps1` | Fetches the query results, applies the **15-column flattening** (CreationDate, AgentId, AgentName, …, Resource_Count), uploads as CSV. Schedule ~30 mins after CreateAuditLogQuery finishes. | `AuditLogsQuery.Read.All` + `Sites.Selected` |
| `GetCopilotUsers-SP-AppReg.ps1` | Pulls the M365 active user report and adds a `HasCopilot` flag column, uploads as CSV. Schedule daily or weekly. | `Reports.Read.All` + `Sites.Selected` |
| `Get-EntraOrgData-SP-AppReg.ps1` | Pulls org structure (manager, dept, location) for all users, uploads as CSV. Schedule weekly or monthly (org structure changes slowly). | `User.Read.All` + `Sites.Selected` |

## Required permissions on the app registration

All as **Application** permissions (not delegated), admin-consented:

| Permission | Purpose |
|---|---|
| `AuditLogsQuery.Read.All` | Create and read Purview audit log queries |
| `Reports.Read.All` | Read M365 active user usage reports (for licensed users data) |
| `User.Read.All` | Read user profiles + manager (for org data) |
| `Organization.Read.All` | Read tenant info (some auth flows require this implicitly) |
| `Sites.Selected` | Write CSV files to the specific SharePoint site (granted per-site by `../provisioning/ProvisionSiteAccess-SP-AppReg.ps1`) |

## Authentication modes

All scripts in this folder support 3 auth modes:

| Mode | When | How to invoke |
|---|---|---|
| **Managed Identity** (default) | Running in Azure Automation with a system-assigned identity | Omit all auth params; the script auto-uses the managed identity |
| **Client secret** | Running outside Azure (Task Scheduler, GitHub Actions, etc.) | Pass `-TenantId`, `-ClientId`, `-ClientSecret` |
| **Certificate** | Same scenarios as client secret, but more secure | Pass `-TenantId`, `-ClientId`, `-CertificateThumbprint` |

## Typical scheduled invocation

```powershell
# Weekly job — chain in this order with ~30 min wait between create and get
.\CreateAuditLogQuery-AppReg.ps1 -startDate (Get-Date).AddDays(-7) -endDate (Get-Date) `
    -TenantId $env:TENANT_ID -ClientId $env:CLIENT_ID -ClientSecret $env:CLIENT_SECRET

Start-Sleep -Seconds 1800   # wait for Purview to process

.\GetCopilotInteractions-SP-AppReg.ps1 -AuditLogQueryId <id-from-step-1> `
    -DriveId $env:SP_DRIVE_ID -FolderPath "AI Dashboard/Audit Logs" `
    -TenantId $env:TENANT_ID -ClientId $env:CLIENT_ID -ClientSecret $env:CLIENT_SECRET

.\GetCopilotUsers-SP-AppReg.ps1 -DriveId $env:SP_DRIVE_ID -FolderPath "AI Dashboard/Audit Logs" `
    -TenantId $env:TENANT_ID -ClientId $env:CLIENT_ID -ClientSecret $env:CLIENT_SECRET

.\Get-EntraOrgData-SP-AppReg.ps1 -DriveId $env:SP_DRIVE_ID -FolderPath "AI Dashboard/Audit Logs" `
    -TenantId $env:TENANT_ID -ClientId $env:CLIENT_ID -ClientSecret $env:CLIENT_SECRET
```

For Azure Automation specifically, see the [`../../azure/`](../../azure/) folder for Bicep templates and runbook examples.

## Common errors and fixes

See the parent [`SharePoint/<File or Folder>/README.md`](../../README.md#troubleshooting) for the full troubleshooting table — same issues apply to all of these scripts.
