# SharePoint — Single File deployment

The recommended default for customers who want scheduled refresh in Power BI Service without setting up a Gateway. Script overwrites one CSV per refresh window; PBI reads a single static URL.

## What's in this folder

| Item | Purpose |
|---|---|
| `AI-in-One Dashboard.pbit` | Power BI template (pre-parsed format). Open in Power BI Desktop, fill in parameters, publish to Service. |
| `scripts/interactive/` | One-shot PowerShell scripts an admin runs manually |
| `scripts/appreg/` | Unattended app-registration scripts for scheduled jobs |
| `scripts/azure/` | Bicep + Azure Automation runbook templates |

## How it works

```
PowerShell scheduler (Task Scheduler / Azure Automation / GitHub Actions)
        ↓
Runs the appreg scripts (CreateAuditLogQuery + GetCopilotInteractions-SP-AppReg + GetCopilotUsers-SP-AppReg + Get-EntraOrgData-SP-AppReg)
        ↓
Each script POSTs the resulting CSV to the SharePoint document library
        ↓ (one CSV per data source, overwritten each run)
PBI Service scheduled refresh reads the SharePoint URLs and rebuilds the dataset
```

## Quick start

### Phase 1 — one-shot setup (do this once per tenant)

1. **Register an app** in Entra (or have your tenant admin do it). Add Microsoft Graph **Application** permissions:
   - `AuditLogsQuery.Read.All`
   - `User.Read.All`
   - `Reports.Read.All`
   - `Organization.Read.All`
   - `Sites.Selected`
   - Grant admin consent for all of them.
   - Generate a client secret. Note tenant ID + client ID + secret.

2. **Pick (or create) a SharePoint site** for the CSVs. Note the site host (e.g. `contoso.sharepoint.com`) and optional path (e.g. `/sites/CopilotAnalytics`).

3. **Run the site-access provisioning helper** to grant your app `write` access to that specific site (Sites.Selected workflow). This needs SharePoint Admin / Cloud App Admin / Global Admin role:

   ```powershell
   cd "scripts/appreg"
   .\ProvisionSiteAccess-SP-AppReg.ps1 `
       -TenantId "<your-tenant-id>" `
       -SiteHost "<tenant>.sharepoint.com" `
       -AppClientId "<app-client-id>" `
       -AppDisplayName "<app-display-name>"
   ```

   It prints the **SiteId** and **DriveId** you'll use in the runbook scripts.

### Phase 2 — schedule the runbooks

Create a scheduled job that runs (in this order, with a ~30-minute gap between create and get):

1. **`CreateAuditLogQuery-AppReg.ps1`** — creates a Purview audit query for a given date range
2. *(wait ~30 mins)*
3. **`GetCopilotInteractions-SP-AppReg.ps1`** — fetches results, applies 15-column flattening, uploads CSV to SharePoint
4. **`GetCopilotUsers-SP-AppReg.ps1`** — pulls licensed users + Copilot license flag, uploads CSV
5. **`Get-EntraOrgData-SP-AppReg.ps1`** — pulls org data (manager, dept, location), uploads CSV

For Azure Automation specifically, see [`scripts/azure/`](scripts/azure/) for Bicep templates + runbook examples.

### Phase 3 — open the PBIT and publish

1. Open `AI-in-One Dashboard.pbit` in Power BI Desktop
2. Fill in the parameters — the SharePoint URLs of the 4 CSVs the scripts produce:

| Parameter | URL pattern |
|---|---|
| Copilot Interactions File | `https://<tenant>.sharepoint.com/<site-path>/<library>/<folder>/CopilotInteractionsReport-...csv` |
| Copilot Licensed Users | `.../<library>/<folder>/M365CopilotUsers-...csv` |
| Org Data File | `.../<library>/<folder>/EntraOrgData-...csv` |
| Agent 365 | Optional — leave blank or point at a static dummy file |

3. Click Load → publish to Power BI Service
4. In Service: dataset Settings → **Data source credentials** → sign in to SharePoint with an account that has site read access. Set **Privacy: None** for all sources.
5. **Scheduled refresh** → enable, set to run after the script schedule (e.g. scripts run nightly at 2am, dataset refresh at 4am).

## Required permissions summary

| Permission | Type | Used by | Granted by |
|---|---|---|---|
| `AuditLogsQuery.Read.All` | Application | CreateAuditLogQuery, GetCopilotInteractions | Tenant admin (one-shot) |
| `Reports.Read.All` | Application | GetCopilotUsers | Tenant admin (one-shot) |
| `User.Read.All` | Application | Get-EntraOrgData | Tenant admin (one-shot) |
| `Organization.Read.All` | Application | (some auth flows include this implicitly) | Tenant admin (one-shot) |
| `Sites.Selected` | Application | All upload steps | Granted *per site* by ProvisionSiteAccess-SP-AppReg.ps1 |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `403 Forbidden` on upload | App doesn't have site permission | Re-run `ProvisionSiteAccess-SP-AppReg.ps1` |
| `404 Not Found` on PUT | Folder path doesn't exist | Verify folder exists in SP, or use `-FolderPath ""` for drive root |
| `ClientSecretCredential authentication failed` | Secret expired or mistyped | Generate a fresh secret in Azure portal, re-run |
| `0 records returned` from interactions | App reg missing `AuditLogsQuery.Read.All` consent | Re-grant in Entra → API permissions |
| Masked UPNs in licensed users (32-char hex) | M365 admin reports concealment is on | Org settings → Reports → untick "Display concealed user, group, and site names" |

## When to escape this path

| Symptom | Move to |
|---|---|
| You need >30 days of historical data | [`../Folder/`](../Folder/) (advanced) or [`../../3. Fabric/`](../../3.%20Fabric/) |
| Refresh hits 1 GB / 2-hour caps | [`../../3. Fabric/`](../../3.%20Fabric/) (Lakehouse handles parsing upstream) |
| You don't need scheduled refresh, just a one-off CSV | [`../../1. Manual/`](../../1.%20Manual/) |
