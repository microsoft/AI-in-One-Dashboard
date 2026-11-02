# Azure Automation — turnkey scheduled deployment

Deploys a complete scheduled-pull stack into your Azure subscription so the SharePoint **File** path data refresh runs unattended on a schedule. End state:

- **Azure Automation Account** with a system-assigned Managed Identity
- **4 PowerShell 7.4 runbooks** uploaded + published
- **Microsoft Graph application permissions** granted to the Managed Identity (`AuditLogsQuery.Read.All`, `Reports.Read.All`, `User.Read.All`, `Sites.Selected`)
- **Schedules** wired up so the runbooks fire weekly without manual intervention
- **Optional storage queue** (auditsearchidqueue) for handing the QueryId from `CreateAuditLogQuery` to `GetCopilotInteractions`

If you don't need turnkey deployment and just want to plug the AppReg scripts into your own scheduler (Task Scheduler, GitHub Actions, etc.), use [`../scripts/appreg/`](../scripts/appreg/) directly instead.

## What gets deployed

| File | Purpose |
|---|---|
| `main.bicep` | Bicep template — provisions Automation Account + Storage + Managed Identity + runbook metadata |
| `main.json`, `main.compiled.json` | ARM JSON outputs of the Bicep (regenerated on every `deploy.ps1` run) |
| `deploy.ps1` | One-shot deployment helper — connects to Azure, compiles Bicep, deploys, grants Graph permissions, uploads runbook content |
| `apply-permissions.ps1` | Standalone permissions-grant script — run separately if you need to grant Graph scopes to an *existing* Automation Account's MI |
| `runbooks/` | The 4 PowerShell scripts that get uploaded as Automation runbooks |

## Runbooks

| Runbook | Schedule cadence | Required Graph scope | Purpose |
|---|---|---|---|
| `CreateAuditLogQuery` | Weekly, e.g. Sunday 02:00 | `AuditLogsQuery.Read.All` | Creates the Purview audit log query, queues the QueryId in storage |
| `GetCopilotInteractions` | Weekly, ~30 min after CreateAuditLogQuery | `AuditLogsQuery.Read.All` + `Sites.Selected` | Fetches query results, applies 15-column flattening, uploads CSV to SharePoint |
| `GetCopilotUsers` | Weekly or daily | `Reports.Read.All` + `Sites.Selected` | Pulls M365 active user report, adds `HasCopilot` flag column, uploads CSV |
| `GetEntraOrgData` | Weekly or monthly | `User.Read.All` + `Sites.Selected` | Pulls org structure (manager, dept, location), uploads CSV |

## Values you must set before deploying

Five values customise the deployment per tenant. Three are **edited in `deploy.ps1`** (one-time, before running). Two are **passed as parameters** at runtime (or as defaults if you prefer to bake them in).

| # | Value | Where | Why |
|---|---|---|---|
| 1 | **NamePrefix** | `-NamePrefix` parameter to `deploy.ps1` | **Required, no default.** Derives all resource names. The Storage Account name is globally-unique across all of Azure, so this must be unique to your org. Pattern: short lowercase hyphenated, e.g. `contoso-copilot-dash`, `acme-cad-prod` |
| 2 | **SiteId** | Edit `$siteId` at top of `deploy.ps1` | The Graph **composite** Site ID of the SharePoint site that will receive the CSV uploads. Format: `hostname,siteCollectionGuid,siteGuid`. Get via Graph Explorer: `GET https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}?$select=id` |
| 3 | **ResourceGroup** | Edit `$resourceGroup` at top of `deploy.ps1` | Existing or new Azure Resource Group in your subscription. If it doesn't exist yet, create it first via `New-AzResourceGroup` |
| 4 | **DriveId** | Pass `-DriveId` at runbook invocation, OR set the default in `runbooks/GetCopilotInteractions.ps1` | The Graph Drive ID of the document library that receives uploaded CSVs. Get via: `GET https://graph.microsoft.com/v1.0/sites/{siteId}/drives` and copy the `id` of the target drive |
| 5 | **Region** | Inherited from `ResourceGroup`'s location | Pick the region closest to your SharePoint tenant when creating the RG. Examples: `uksouth`, `eastus`, `westeurope` |

## One-time deployment

```powershell
# 0. Sign into Azure (if not already)
Connect-AzAccount -SubscriptionId <your-sub-guid>

# 1. Create or confirm the target Resource Group
New-AzResourceGroup -Name "contoso-cad-rg" -Location "uksouth"

# 2. Edit deploy.ps1: set $siteId and $resourceGroup at the top

# 3. Run the deployment, passing your unique NamePrefix
cd ".\2. SharePoint\File\azure"
.\deploy.ps1 -NamePrefix "contoso-copilot-dash"
```

What `deploy.ps1` does, in order:

1. Validates `-NamePrefix` is provided and matches the naming pattern
2. Fails fast if `$siteId` or `$resourceGroup` is still a placeholder
3. `bicep build` to compile `main.bicep` → `main.compiled.json`
4. `New-AzResourceGroupDeployment` to deploy the stack (Storage Account, Queue, Automation Account with managed identity, runtime env with PS modules, runbook resources, role assignment)
5. Uploads runbook content from `./runbooks/*.ps1` to the Automation Account
6. `Connect-MgGraph` (browser prompt — sign in with tenant-admin or equivalent)
7. Grants the managed identity: `Sites.Selected`, `Reports.Read.All`, `AuditLogsQuery.Read.All`, `User.Read.All`
8. Grants the managed identity `write` access on the target SharePoint site via `New-MgSitePermission`

After deployment you'll have a fully provisioned pipeline. **One additional manual step**: set the `-DriveId` parameter on `GetCopilotInteractions` either at runbook invocation time, or as a default in the runbook file. Then trigger `CreateAuditLogQuery` once to validate, wait ~5–10 minutes for Purview to run the audit search, trigger `GetCopilotInteractions` to fetch + upload the CSV.

The Automation Account costs nothing for the first 500 runtime-minutes/month (well within typical usage); the Storage Account is pennies per month.

## Standalone permissions update

If you've already deployed the Automation Account but need to grant additional Graph scopes (e.g. you added `GetEntraOrgData` after initial deployment), use the standalone script:

```powershell
.\apply-permissions.ps1 `
    -PrincipalId "<Managed Identity object ID>" `
    -SiteId      "<Graph site ID>"
```

Requires tenant admin (Global Admin or equivalent) to grant the application-level Graph scopes.

## Triggering runbooks manually for testing

After deployment, in the Azure Portal → your Automation Account → Runbooks → click a runbook → **Start**. Supply the required parameters in the form (DriveId for the SP uploads, optional FolderPath, etc.). Output appears in the job log within ~30 seconds.

## Scheduling

Schedules can be set via the Azure Portal (Automation Account → Schedules → New) and linked to runbooks (Runbook → Schedules → Add). The Bicep template doesn't pre-create schedules today — that's a customisation choice (date/time depends on your tenant's preferred cadence). A future iteration of `main.bicep` may add an optional `schedules` parameter.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Connect-MgGraph -Identity` fails inside the runbook | Managed Identity not yet propagated | Wait ~5 mins after deployment, retry; or check the Automation Account's Identity blade shows `Status: On` |
| Runbook fails with `AccessDenied` on Graph | Permissions not granted yet | Run `apply-permissions.ps1` (or check that `deploy.ps1` completed step 6) |
| Runbook fails with `403 Forbidden` on SharePoint PUT | `Sites.Selected` not granted on the target site | Run `apply-permissions.ps1` with the correct `-SiteId` |
| `Failed to upload CSV` with `Content-Range must include a total length` | (Old issue, fixed in current runbooks.) Large file used streaming upload with `*` placeholder | Current runbooks use chunked upload with explicit total length |
| Deploy fails with `StorageAccountAlreadyTaken` | The Storage Account name derived from your NamePrefix is globally taken (storage account names are globally unique across all of Azure) | Re-run with a different `-NamePrefix` that includes your org name, e.g. `contoso-cad-2026` instead of a generic name. Check name availability first with `Get-AzStorageAccountNameAvailability -Name "<prefix-with-hyphens-removed>stg"` |
| Deploy fails with `LocationRequired` during runbook upload | (Old issue, fixed.) Runbook PUT body missing top-level `location` field | Current `deploy.ps1` fetches the RG location and includes it in the runbook metadata PUT |
| Deploy fails with `MissingApiVersionParameter` during runbook upload | (Old issue, fixed.) URL had `?api-version=` with empty value due to PowerShell `?` string-expansion ambiguity | Current `deploy.ps1` builds URLs via string concatenation, not interpolation |
| Deploy fails with `MethodNotAllowed` (HTTP 405) on runbook content PUT | (Old issue, fixed.) Old code used `/content` endpoint (GET-only); should be `/draft/content` for PUT | Current `deploy.ps1` targets `/draft/content` |
| `Get-MgServicePrincipal : Method not found` during AssignRoles | Microsoft.Graph PowerShell 2.36.1 has a known assembly-mismatch bug with `Microsoft.Kiota.Authentication.Azure` | Close the PowerShell window completely, open a fresh one (PowerShell 7+ recommended), reinstall `Microsoft.Graph.Authentication, Microsoft.Graph.Applications, Microsoft.Graph.Sites`, reconnect with `Connect-AzAccount`, then re-run `apply-permissions.ps1` standalone (skips the already-completed Bicep + runbook upload steps) |
