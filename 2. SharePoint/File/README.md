# SharePoint — File deployment

The recommended default. Script overwrites one CSV per refresh; PBI reads a single static SharePoint URL. No gateway needed.

## What's in this folder

| Item | Purpose |
|---|---|
| `AI-in-One Dashboard.pbit` | The dashboard. Open in PBI Desktop, fill in parameters, publish to Service. |
| `scripts/` | All PowerShell scripts in one flat folder. **Filename `*-AppReg.ps1` = unattended** (managed identity / client secret / cert). Others (lower-case names) = **interactive** (admin runs manually). See [`scripts/README.md`](scripts/README.md). |
| `azure/` | Bicep + Azure Automation runbook templates. Use when you want to host the AppReg scripts in Azure Automation. |

## How it works

```
PowerShell scheduler (Task Scheduler / Azure Automation / GitHub Actions)
        ↓
Runs the AppReg scripts (CreateAuditLogQuery + GetCopilotInteractions-SP-AppReg
                         + GetCopilotUsers-SP-AppReg + Get-EntraOrgData-SP-AppReg)
        ↓
Each script POSTs the resulting CSV to a SharePoint document library
        ↓ (one CSV per data source, overwritten each run)
PBI Service scheduled refresh reads the SharePoint URLs and rebuilds the dataset
```

## Quick start

### Phase 1 — one-shot setup (per tenant)

1. **Register an app** in Entra (or have your tenant admin do it). Add Microsoft Graph **Application** permissions:
   - `AuditLogsQuery.Read.All`, `Reports.Read.All`, `User.Read.All`, `Organization.Read.All`, `Sites.Selected`
   - Grant admin consent. Generate a client secret. Note tenant ID + client ID + secret.

2. **Pick a SharePoint site** for the CSVs. Note the host (e.g. `contoso.sharepoint.com`) and optional path (e.g. `/sites/CopilotAnalytics`).

3. **Run the site-access provisioning helper** to grant your app `write` access to that specific site (Sites.Selected). Needs SharePoint Admin / Cloud App Admin / Global Admin role:

   ```powershell
   cd scripts
   .\ProvisionSiteAccess-SP-AppReg.ps1 `
       -TenantId "<your-tenant-id>" `
       -SiteHost "<tenant>.sharepoint.com" `
       -AppClientId "<app-client-id>" `
       -AppDisplayName "<app-display-name>"
   ```

   It prints the **SiteId** and **DriveId** you'll use in the runbook scripts.

### Phase 2 — schedule the runbooks

Run in this order (with a ~30-minute gap between create and get):

1. `CreateAuditLogQuery-AppReg.ps1` — kicks off the Purview audit query for the date range
2. *(wait ~30 mins)*
3. `GetCopilotInteractions-SP-AppReg.ps1` — fetches results, applies 15-column flatten, uploads CSV to SharePoint
4. `GetCopilotUsers-SP-AppReg.ps1` — pulls licensed users + Copilot license flag
5. `Get-EntraOrgData-SP-AppReg.ps1` — pulls org structure (manager, dept, location)

For Azure Automation specifically, see [`azure/README.md`](azure/README.md).

### Phase 3 — open the PBIP and publish

1. Open `AI-in-One Dashboard.pbit` in Power BI Desktop.
2. Transform data → Edit parameters → fill in the SharePoint URLs:

| Parameter | URL pattern |
|---|---|
| Copilot Interactions File | `https://<tenant>.sharepoint.com/<site>/<library>/<folder>/CopilotInteractionsReport-...csv` |
| Copilot Licensed Users | `.../<library>/<folder>/M365CopilotUsers-...csv` |
| Org Data File | `.../<library>/<folder>/EntraOrgData-...csv` |
| Agent 365 | Optional — leave blank or point at a static dummy file |

3. Click Load → publish to Power BI Service.
4. In Service: dataset Settings → **Data source credentials** → sign in to SharePoint with an account that has site read access. Set **Privacy: None** for all sources.
5. **Scheduled refresh** → enable, run after the script schedule (e.g. scripts at 2am, dataset at 4am).

## Required permissions

| Permission | Type | Used by |
|---|---|---|
| `AuditLogsQuery.Read.All` | Application | CreateAuditLogQuery, GetCopilotInteractions |
| `Reports.Read.All` | Application | GetCopilotUsers |
| `User.Read.All` | Application | Get-EntraOrgData |
| `Organization.Read.All` | Application | (some auth flows include this implicitly) |
| `Sites.Selected` | Application | All upload steps (granted *per site* by ProvisionSiteAccess) |

## Common errors

| Symptom | Likely cause | Fix |
|---|---|---|
| `403 Forbidden` on upload | App doesn't have site permission | Re-run `ProvisionSiteAccess-SP-AppReg.ps1` |
| `404 Not Found` on PUT | Folder path doesn't exist | Verify folder exists in SP, or use `-FolderPath ""` for drive root |
| `ClientSecretCredential authentication failed` | Secret expired or mistyped | Generate a fresh secret in Azure portal, re-run |
| `0 records returned` | App reg missing `AuditLogsQuery.Read.All` consent | Re-grant in Entra → API permissions |
| Masked UPNs (32-char hex) in licensed users | M365 admin reports concealment is on | Org settings → Reports → untick "Display concealed user, group, and site names" |

## When to escape this path

| Symptom | Move to |
|---|---|
| Need >30 days of accumulated history | [`../Folder/`](../Folder/) or [`../../3. Fabric/`](../../3.%20Fabric/) |
| Refresh hits 1 GB / 2-hour caps | [`../../3. Fabric/`](../../3.%20Fabric/) |
| Don't need scheduled refresh, just a one-off CSV | [`../../1. Manual/`](../../1.%20Manual/) |
