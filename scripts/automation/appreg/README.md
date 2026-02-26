# AI-in-One Dashboard — App Registration Automation Scripts

These three scripts automate the collection of Microsoft Copilot interaction data from the Microsoft Purview Audit Log and store it in SharePoint Online, ready for use in the AI-in-One Dashboard Power BI report.

---

## How the scripts work together

```
┌─────────────────────────────┐
│   ProvisionPreReqs.ps1      │  Run once, interactively, as a Global Admin.
│   (Setup — run once)        │  Creates or configures all required Azure and
└────────────┬────────────────┘  SharePoint infrastructure.
             │
             ▼ (produces: Client ID, Site ID, List ID, Drive ID)
             │
┌────────────┴────────────────┐
│  CreateAuditLogQuery-       │  Run on a schedule (e.g. weekly).
│  AppReg.ps1  (Runbook 1)    │  Creates a Purview Audit Log Query for Copilot
└────────────┬────────────────┘  Interactions and queues the Query ID in SharePoint.
             │
             ▼ (produces: Query ID in SharePoint list)
             │
┌────────────┴────────────────┐
│  GetCopilotInteractions-    │  Run after Runbook 1 completes (e.g. ~30 min later).
│  AppReg.ps1  (Runbook 2)    │  Reads the Query ID from the queue, exports all
└─────────────────────────────┘  records to CSV, and uploads to SharePoint.
```

The typical workflow is:
1. Run `ProvisionPreReqs.ps1` **once** to set up the app registration and SharePoint infrastructure.
2. Schedule `CreateAuditLogQuery-AppReg.ps1` to run on a recurring basis (e.g. weekly).
3. Schedule `GetCopilotInteractions-AppReg.ps1` to run ~30 minutes after Runbook 1 to allow the Purview query time to complete.

---

## Prerequisites (all scripts)

| Requirement | Detail |
|---|---|
| PowerShell version | PowerShell 5.1 or PowerShell 7+ |
| Required modules | `Microsoft.Graph.Authentication`, `Microsoft.Graph.Applications`, `Microsoft.Graph.Beta.Security` — installed automatically if missing |
| Who runs `ProvisionPreReqs.ps1` | A **Global Admin** (or an account with `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, and `Sites.FullControl.All` delegated permissions) |
| Microsoft Purview | Your tenant must have the [Microsoft Purview Audit Log](https://learn.microsoft.com/en-us/purview/audit-log-enable-disable) enabled |

---

## Creating a self-signed certificate (optional)

If you choose the **App registration + certificate** auth mode, you need a certificate uploaded to the app registration and available in the local certificate store of the machine (or Azure Automation account) running the scripts.

The snippet below creates a self-signed certificate, exports the public key as a `.cer` file for upload to the app registration, and leaves the private key in your current user certificate store for use by the scripts.

```powershell
$certName = "ai-in-one-dashboard"   # Replace with your preferred certificate name

$cert = New-SelfSignedCertificate `
    -Subject           "CN=$certName" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyExportPolicy   Exportable `
    -KeySpec           Signature `
    -KeyLength         2048 `
    -KeyAlgorithm      RSA `
    -HashAlgorithm     SHA256

Export-Certificate -Cert $cert -FilePath "$certName.cer"

Write-Output "Thumbprint: $($cert.Thumbprint)"
Write-Output "Certificate exported to: $certName.cer"
```

Then:
1. In the [Azure portal](https://portal.azure.com), open the app registration → **Certificates & secrets** → **Certificates** → **Upload certificate** → select the exported `.cer` file.
2. Use the printed thumbprint as the `-CertificateThumbprint` parameter when invoking the runbook scripts.

> **Note:** Self-signed certificates are suitable for development and testing. For production, use a certificate issued by your organisation's CA or Azure Key Vault.

---

## Script 1 — ProvisionPreReqs.ps1

Run this **once** as a setup step, interactively. It sets up all the Azure and SharePoint infrastructure that the two runbooks depend on.

### What it does (in order)

| Step | Description |
|---|---|
| **Step 1** | Creates a new app registration (or finds an existing one by `-ClientId` or display name) |
| **Step 2** | Declares required Microsoft Graph application permissions on the app: `AuditLog.Read.All`, `AuditLogsQuery.Read.All`, `Sites.Selected` |
| **Step 3** | Admin-consents all permissions (creates app role assignments via the Graph service principal) |
| **Step 4** | Creates a SharePoint Communication Site (or uses existing), a Document Library for CSV reports, and a Queue List for query IDs |
| **Step 5** | Grants the app `write` access to the specific SharePoint site via `Sites.Selected` |

### Operating modes

The script is **idempotent** — you can re-run it safely. Each resource is only created if it does not already exist.

#### Mode A — Full new setup (recommended for first-time setup)

Omit both `-ClientId` and `-SharePointSiteId`. The script creates everything from scratch.

```powershell
.\ProvisionPreReqs.ps1 `
    -TenantId    "<your-tenant-id>" `
    -TenantName  "<your-tenant-name>"     # e.g. "contoso" (without .onmicrosoft.com)
```

#### Mode B — Existing app registration, new SharePoint site

Pass `-ClientId` to reuse an existing app registration. The script skips app creation and grants permissions to the existing app, then creates the SharePoint site and lists.

```powershell
.\ProvisionPreReqs.ps1 `
    -TenantId    "<your-tenant-id>" `
    -TenantName  "<your-tenant-name>" `
    -ClientId    "<existing-app-client-id>"
```

#### Mode C — New app registration, existing SharePoint site

Pass `-SharePointSiteId` to use an existing SharePoint site. The script creates a new app registration, grants it permissions, and creates the document library and queue list on the existing site if they are missing.

```powershell
.\ProvisionPreReqs.ps1 `
    -TenantId          "<your-tenant-id>" `
    -TenantName        "<your-tenant-name>" `
    -SharePointSiteId  "<site-id>"     # e.g. contoso.sharepoint.com,{siteGuid},{webGuid}
```

#### Mode D — Existing app registration and existing site (re-run / permissions check)

Pass both `-ClientId` and `-SharePointSiteId`. The script ensures all required permissions are declared and consented, and that the document library and queue list exist. Nothing is recreated if already present.

```powershell
.\ProvisionPreReqs.ps1 `
    -TenantId          "<your-tenant-id>" `
    -TenantName        "<your-tenant-name>" `
    -ClientId          "<existing-app-client-id>" `
    -SharePointSiteId  "<site-id>"
```

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `TenantId` | string | **Yes** | — | Your Microsoft Entra tenant ID (GUID) |
| `TenantName` | string | **Yes** | — | Your tenant short name (e.g. `contoso`, without `.onmicrosoft.com`) |
| `ClientId` | string | No | _(blank)_ | If provided, uses this existing app registration instead of creating a new one |
| `SharePointSiteId` | string | No | _(blank)_ | If provided, uses this existing SharePoint site instead of creating a new one |
| `SiteAlias` | string | No | `ai-in-one-dashboard` | URL alias for the new site (e.g. `/sites/ai-in-one-dashboard`) |
| `SiteDisplayName` | string | No | `AI-in-One Dashboard` | Display name for the new SharePoint site |
| `DocLibName` | string | No | `CopilotReports` | Name of the document library for CSV reports |
| `QueueListName` | string | No | `AuditQueryQueue` | Name of the SharePoint list used as a query queue |
| `AppDisplayName` | string | No | `AI-in-One Dashboard Automation` | Display name for the new app registration |
| `SitePermissionRole` | string | No | `write` | Permission role granted to the app on the SharePoint site (`read` or `write`) |

### Output

At the end of a successful run, the script prints the values you need for the runbook parameters:

```
=== Setup complete ===
App Display Name : AI-in-One Dashboard Automation
Client ID        : <app-client-id>
Permissions      : AuditLog.Read.All, AuditLogsQuery.Read.All, Sites.Selected (admin consented)
SPO Site ID      : <site-id>
Doc Library      : CopilotReports (ID: <doc-library-id>)
Drive ID         : <drive-id>
Queue List       : AuditQueryQueue (ID: <queue-list-id>)
SPO Site Access  : 'write' on <site-id>
```

Copy these values directly into your runbook parameters.

---

## Script 2 — CreateAuditLogQuery-AppReg.ps1

**Runbook 1.** Run on a schedule (e.g. weekly). Creates a Microsoft Purview Audit Log Query scoped to `CopilotInteraction` records for the specified date range, then writes the query ID into the SharePoint queue list for Runbook 2 to pick up.

### What it does

1. Authenticates to Microsoft Graph using the configured auth mode.
2. Calls `POST /beta/security/auditLog/queries` to create a new Purview Audit Log Query filtered to `CopilotInteraction` record types for the specified date range.
3. Writes the returned query ID to the `QueryId` column of the SharePoint queue list.

> The query runs asynchronously in Purview. This is why Runbook 2 is scheduled to run ~30 minutes later — the query needs time to complete before its results can be downloaded.

### Required permissions

| Permission | Type | Purpose |
|---|---|---|
| `AuditLogsQuery.Read.All` | Application | Create and read Purview Audit Log Queries |
| `Sites.Selected` | Application | Write the query ID to the SharePoint queue list |

### Authentication modes

#### Managed Identity (recommended for Azure Automation)

Omit all four auth parameters. The script uses the managed identity of the Azure Automation account.

```powershell
.\CreateAuditLogQuery-AppReg.ps1 `
    -startDate          (Get-Date).AddDays(-7) `
    -endDate            (Get-Date) `
    -SharePointSiteId   "<site-id>" `
    -SharePointListId   "<queue-list-id>"
```

> Ensure the managed identity has been granted the required permissions (or simply run `ProvisionPreReqs.ps1` with the managed identity's object ID as the `-ClientId`).

#### App registration + client secret

```powershell
.\CreateAuditLogQuery-AppReg.ps1 `
    -startDate          (Get-Date).AddDays(-7) `
    -endDate            (Get-Date) `
    -SharePointSiteId   "<site-id>" `
    -SharePointListId   "<queue-list-id>" `
    -TenantId           "<tenant-id>" `
    -ClientId           "<app-client-id>" `
    -ClientSecret       "<client-secret>"
```

#### App registration + certificate

```powershell
.\CreateAuditLogQuery-AppReg.ps1 `
    -startDate                (Get-Date).AddDays(-7) `
    -endDate                  (Get-Date) `
    -SharePointSiteId         "<site-id>" `
    -SharePointListId         "<queue-list-id>" `
    -TenantId                 "<tenant-id>" `
    -ClientId                 "<app-client-id>" `
    -CertificateThumbprint    "<thumbprint>"
```

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `startDate` | DateTime | No | 7 days ago | Start of the date range to query |
| `endDate` | DateTime | No | Now | End of the date range to query |
| `SharePointSiteId` | string | **Yes** | — | Graph site ID of the SharePoint site (from `ProvisionPreReqs.ps1` output) |
| `SharePointListId` | string | **Yes** | — | GUID of the queue list (from `ProvisionPreReqs.ps1` output) |
| `TenantId` | string | No* | — | Entra tenant ID — required when using app registration auth |
| `ClientId` | string | No* | — | App registration client ID — required when using app registration auth |
| `ClientSecret` | string | No* | — | Client secret — use with app registration auth (mutually exclusive with `CertificateThumbprint`) |
| `CertificateThumbprint` | string | No* | — | Certificate thumbprint — use with app registration auth (mutually exclusive with `ClientSecret`) |

\* Required together when using app registration authentication.

---

## Script 3 — GetCopilotInteractions-AppReg.ps1

**Runbook 2.** Run after Runbook 1 has had time to complete (typically ~30 minutes later). Reads the queued query ID from SharePoint, downloads all matching audit records, and streams them directly to a CSV file in the SharePoint document library.

### What it does

1. Authenticates to Microsoft Graph using the configured auth mode.
2. Reads the first item from the SharePoint queue list and extracts the `QueryId`.
3. Checks the Purview query status — if it has not yet `succeeded`, the script exits and can be retried later.
4. Creates a large-file upload session against the SharePoint document library.
5. Pages through `GET /beta/security/auditLog/queries/{id}/records` and **streams** each page directly into the upload session, flushing data to SharePoint in 320 KiB-aligned chunks. This avoids holding the full result set in memory, making it safe for very large tenants.
6. Deletes the processed queue item from the SharePoint list.

### What it does NOT do

- It does not wait for the Purview query to complete. If the query is still running when this script executes, the script exits with a non-zero code and can be retried or rescheduled.

### Required permissions

| Permission | Type | Purpose |
|---|---|---|
| `AuditLog.Read.All` | Application | Read records from the Purview Audit Log Query |
| `Sites.Selected` | Application | Read from the queue list and write the CSV to the document library |

### Authentication modes

The same three modes as Runbook 1 apply (Managed Identity, App secret, Certificate). Substitute `GetCopilotInteractions-AppReg.ps1` in the examples below.

#### Managed Identity (recommended)

```powershell
.\GetCopilotInteractions-AppReg.ps1 `
    -SharePointSiteId   "<site-id>" `
    -SharePointListId   "<queue-list-id>" `
    -DriveId            "<drive-id>"
```

#### App registration + client secret

```powershell
.\GetCopilotInteractions-AppReg.ps1 `
    -SharePointSiteId   "<site-id>" `
    -SharePointListId   "<queue-list-id>" `
    -DriveId            "<drive-id>" `
    -TenantId           "<tenant-id>" `
    -ClientId           "<app-client-id>" `
    -ClientSecret       "<client-secret>"
```

#### App registration + certificate

```powershell
.\GetCopilotInteractions-AppReg.ps1 `
    -SharePointSiteId         "<site-id>" `
    -SharePointListId         "<queue-list-id>" `
    -DriveId                  "<drive-id>" `
    -TenantId                 "<tenant-id>" `
    -ClientId                 "<app-client-id>" `
    -CertificateThumbprint    "<thumbprint>"
```

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `SharePointSiteId` | string | **Yes** | — | Graph site ID of the SharePoint site (from `ProvisionPreReqs.ps1` output) |
| `SharePointListId` | string | **Yes** | — | GUID of the queue list (from `ProvisionPreReqs.ps1` output) |
| `DriveId` | string | **Yes** | — | Graph Drive ID of the document library (see note below) |
| `TenantId` | string | No* | — | Entra tenant ID — required when using app registration auth |
| `ClientId` | string | No* | — | App registration client ID — required when using app registration auth |
| `ClientSecret` | string | No* | — | Client secret (mutually exclusive with `CertificateThumbprint`) |
| `CertificateThumbprint` | string | No* | — | Certificate thumbprint (mutually exclusive with `ClientSecret`) |

\* Required together when using app registration authentication.

> **Finding the DriveId:** `ProvisionPreReqs.ps1` outputs the Drive ID automatically at the end of its run. If you need to look it up manually, call:
> ```
> GET https://graph.microsoft.com/v1.0/sites/{site-id}/lists/{doc-library-id}/drive
> ```
> and copy the `id` value.

### Output

The script uploads a CSV file named in the format:

```
CopilotInteractionsReport-{yyyyMMddHHmmss}-{queryId}.csv
```

to the root of the document library.

---

## Permissions summary

| Permission | `ProvisionPreReqs.ps1` | Runbook 1 | Runbook 2 |
|---|:---:|:---:|:---:|
| `Application.ReadWrite.All` (delegated) | Required to run | — | — |
| `AppRoleAssignment.ReadWrite.All` (delegated) | Required to run | — | — |
| `Sites.FullControl.All` (delegated) | Required to run | — | — |
| `AuditLog.Read.All` (application) | Granted to app | — | ✓ |
| `AuditLogsQuery.Read.All` (application) | Granted to app | ✓ | — |
| `Sites.Selected` (application) | Granted to app | ✓ | ✓ |

---

## Questions?

Contact [alexgrover@microsoft.com](mailto:alexgrover@microsoft.com).
