# Azure Automation — turnkey scheduled deployment (Legacy raw-audit path)

Same Bicep stack as [`../../File/azure/`](../../File/azure/), wired to the **Legacy raw-audit** path's data refresh. Use this if you're maintaining a tenant on the older flow that uploads raw `auditData` JSON to SharePoint instead of the modern 15-column pre-parsed format.

> New deployments should use [`../../File/azure/`](../../File/azure/) or [`../../Folder/azure/`](../../Folder/azure/) — they're faster, cleaner, and the parsing happens upstream in PowerShell. This Legacy stack exists to keep existing customers running without forcing migration.

## Two differences vs File/azure/

1. **Runbooks use a SharePoint LIST queue pattern**, not an Azure Storage Queue. The QueryId is written to a SharePoint list by `CreateAuditLogQuery`, then read by `GetCopilotInteractions`. This means:
   - You need to have provisioned the SharePoint list (via `../scripts/appreg/ProvisionPreReqs.ps1`, **not** via this Bicep)
   - Each runbook needs `-SharePointSiteId` and `-SharePointListId` parameters set when scheduled
   - `GetCopilotInteractions` also accepts `-AuditLogQueryId` directly as a fallback (added in 2026-05)
2. **`GetCopilotInteractions` output is raw audit format** — CSV with embedded `auditData` JSON column. PBIT does the JSON parsing in M-query. The modern File/Folder runbooks produce the flat 15-column format instead.

## Deployment

```powershell
cd ".\2. SharePoint\Legacy\azure"

# 1. Fill in your values at the top of deploy.ps1
#    - $siteId        = "<SharePoint site for raw audit CSVs>"
#    - $resourceGroup = "<your-RG-name>"

# 2. Make sure the SharePoint list (audit queue) already exists in the target site
#    — if not, run ../scripts/appreg/ProvisionPreReqs.ps1 first

# 3. Deploy
.\deploy.ps1
```

Same `apply-permissions.ps1` script as File/azure/ — grants the Managed Identity the four required Graph scopes (`AuditLogsQuery.Read.All`, `Reports.Read.All`, `User.Read.All`, `Sites.Selected`).

## Runbook parameter notes

When scheduling the runbooks in the Azure Portal:

| Runbook | Required params |
|---|---|
| `CreateAuditLogQuery` | `-SharePointSiteId`, `-SharePointListId` (to write the QueryId into the queue list) |
| `GetCopilotInteractions` | Either: `-SharePointSiteId` + `-SharePointListId` (queue mode) **or** `-AuditLogQueryId` (direct mode), plus `-DriveId` |
| `GetCopilotUsers` | `-DriveId`, optionally `-FolderPath`, `-Period` |
| `GetEntraOrgData` | `-DriveId`, optionally `-FolderPath` |

For the full deployment walkthrough, runbook reference, and troubleshooting table, see [`../../File/azure/README.md`](../../File/azure/README.md).

## Storage queue note

The Bicep template provisions an Azure Storage Queue (`auditsearchidqueue`) which the File path uses. The Legacy path doesn't use it (uses SP list instead) — it'll sit unused after deployment. Negligible cost (~£0.00 storage); ignore unless you want a cleaner stack, in which case strip the queue resource from `main.bicep`.
