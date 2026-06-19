# Azure Automation — turnkey scheduled deployment (Folder path)

Same Bicep stack as [`../../File/azure/`](../../File/azure/), wired to the **SharePoint Folder** path's data refresh. Use this if you've picked the Folder PBIT variant — every scheduled run drops a fresh timestamped CSV in SharePoint and the PBIT unions them.

## What gets deployed

Identical to the File-path stack:

- **Azure Automation Account** with system-assigned Managed Identity
- **4 PowerShell 7.4 runbooks** (CreateAuditLogQuery, GetCopilotInteractions, GetCopilotUsers, GetEntraOrgData)
- **Microsoft Graph application permissions** granted to the Managed Identity
- **Optional storage queue** for QueryId hand-off between CreateAuditLogQuery and GetCopilotInteractions

## Difference vs File path

The **runbooks themselves are the same scripts** as the File path — the Folder vs File distinction lives entirely in the PBIT side (which reads either a single static URL or a folder iterator). The runbook output filenames (`CopilotInteractionsReport-{timestamp}-{queryId}.csv`) work for both modes.

So you could literally re-use the File-path Bicep deployment for a Folder customer, or deploy this independent instance — it just depends on whether you want isolated Automation Accounts per customer use-case.

## Deployment

```powershell
cd ".\2. SharePoint\Folder\azure"

# Fill in $siteId + $resourceGroup at the top of deploy.ps1
.\deploy.ps1
```

For the full deployment walkthrough, runbook reference, permissions, and troubleshooting table, see [`../../File/azure/README.md`](../../File/azure/README.md) — same content applies here verbatim.

## When you would prefer this over File/azure/

- You want a separate Automation Account per Power BI variant (e.g. for billing isolation across customers)
- You want to evolve the Folder-specific runbooks independently (e.g. different schedule cadences, file retention policies)
- You're standing up a fresh Folder-only deployment and want everything self-contained under `Folder/`

In most cases the File-path deployment is fine for both PBIT variants — they consume the same CSV format and naming.
