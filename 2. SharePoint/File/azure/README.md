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

## One-time deployment

```powershell
cd ".\2. SharePoint\File\azure"

# 1. Fill in your values at the top of deploy.ps1:
#    - $siteId        = "<Graph site ID for your SharePoint upload target>"
#    - $resourceGroup = "<your-RG-name>"

# 2. Run the deployment
.\deploy.ps1
```

What `deploy.ps1` does, in order:

1. `Connect-AzAccount` (browser prompt if not signed in)
2. `bicep build` to compile `main.bicep` → `main.compiled.json`
3. `New-AzResourceGroupDeployment` to deploy the stack
4. Captures the Automation Account's Managed Identity principal ID from outputs
5. `Connect-MgGraph` (browser prompt for tenant-admin sign-in)
6. Grants the MI: `Sites.Selected`, `Reports.Read.All`, `AuditLogsQuery.Read.All`, `User.Read.All`
7. Grants the MI `write` access on the target SharePoint site via `New-MgSitePermission`
8. Uploads runbook content from `./runbooks/*.ps1` to the Automation Account

After deployment you'll have a fully scheduled pipeline. The Automation Account costs nothing for the first 500 runtime-minutes/month (well within typical usage).

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
