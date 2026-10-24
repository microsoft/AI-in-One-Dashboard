# 📥 Get your data: PAX

Part of [AI in One](../README.md). The [app](../README.md#-start-here-the-app-preview) and the [Power BI report](power-bi-report.md) both read the files described here. For the short version, see [Where your data comes from](../README.md#-where-your-data-comes-from-pax) in the README.

**On this page:** [Required input format](#-important--required-input-file-format) · [What is PAX?](#-what-is-pax) · [Run PAX](#-get-your-data--run-pax-to-produce-the-files) · [Audit logging](#audit-logging) · [Agent 365](#agent-365) · [SharePoint URLs](#sharepoint-url) · [Fabric: Azure Container Apps job](#aca-job) · [Multi-month history](#appendfile)

---

> ## 🟦 IMPORTANT — Required input file format
>
> **This template requires pre-processed rollup files — it cannot read raw Purview CSVs, raw Entra exports, or files from any other unprocessed source.** Pointing the template at raw files will result in load failures or blank visuals.
>
> **The recommended way to produce these files is the PAX script.** See [**📦 What is PAX?**](#-what-is-pax) below for what PAX is and where to get it.
>
> Customers who export raw Purview and Entra data through a method other than PAX can use the standalone processor script in the [`scripts/`](../scripts/) folder to produce the same rollup files. See the [**⚙️ Standalone processor**](standalone-processor.md) page.

---

## 📦 What is PAX?

**PAX** stands for **Portable Audit eXporter**. It's a free, open-source PowerShell script from the Microsoft Copilot Growth ROI Advisory team that:

- Pulls Microsoft 365 Copilot audit data out of Microsoft Purview
- Pulls user, organization, and licensing data out of Microsoft Entra and the Microsoft 365 Admin Center (MAC)
- Pull additional agent details from Agent 365
- Writes the results as CSV files — locally, to SharePoint, or to OneLake/Fabric
- When run with one of the **rollup switches** (see below), it also pre-processes the Purview and Entra/MAC CSVs into the exact format this dashboard template expects. The optional Agent 365 data does not need any pre-processing for use in this dashboard.

**PAX repo (bookmark this):** **https://github.com/microsoft/PAX**

Throughout this guide, "run PAX" means running the script from that repo. PAX is the recommended (and currently only supported) way to produce input files for this dashboard.

---

## 📥 Get your data — run PAX to produce the files

> **Reminder:** This template only consumes the rollup files produced by PAX. If you (or your admin) try to point it at a raw Purview audit CSV or a manually-exported Entra users CSV, it won't work.

> 🧪 **No tenant access yet? Use the synthetic sample data.** The [`sample-data/`](../sample-data/) folder contains fully fictional demo files in the exact rollup format, so you can open the template and explore every page without Purview, PAX, or a tenant. See [`sample-data/README.md`](../sample-data/README.md).

<a id="audit-logging"></a>

### ⚠️ Before you run anything — unified audit logging must be ON

Every number in this dashboard comes from the Microsoft Purview unified audit log. If audit logging is switched off for the tenant, PAX has nothing to read and **every** audit query fails with:

```
"Status":"AuditingDisabledTenant"
```

It is on by default for most tenants, but frequently off in demo, dev, and newly provisioned tenants — so check before you start.

**Turn it on — Purview portal**
1. Go to [https://purview.microsoft.com/audit/auditsearch](https://purview.microsoft.com/audit/auditsearch)
2. If you see **Start recording user and admin activity**, click it.

**Turn it on — PowerShell**
```powershell
Connect-ExchangeOnline -Organization contoso.onmicrosoft.com
Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true
(Get-AdminAuditLogConfig).UnifiedAuditLogIngestionEnabled   # expect: True
```

> ⏳ **Enabling it does not backfill.** Collection starts from the moment it is switched on, and records can take up to 24 hours to show up. If you have just enabled auditing, your first export will be near-empty and the dashboard will look sparse until usage accumulates. That is expected — it is not a broken deployment, and no date range will recover data from before auditing was enabled.

### The two rollup switches

PAX exposes two switches that produce the file format this template needs:

| Switch | What it does | When to use it |
|---|---|---|
| **`-Rollup`** | Runs the rollup post-processor and produces only the rolled-up output files. The raw intermediate CSVs are deleted. | Recommended default. Smallest footprint. Use this if the dashboard is the only thing you'll use the data for. |
| **`-RollupPlusRaw`** | Same as `-Rollup` but **keeps** the raw Purview and Entra CSVs alongside the rollup output. | Use this if you also want the raw data for other purposes (custom reporting, archival, troubleshooting). |

The two switches are mutually exclusive — pick one.

### What you get back

After PAX finishes, you'll have these files (filenames are timestamped automatically):

| File | What it is | Required by template? |
|---|---|---|
| `Purview_Audit_..._Interactions.csv` | The main "what happened" file — rolled-up Copilot interactions | ✅ Required |
| `EntraUsers_MAClicensing_..._Users.csv` | The "who they are" file — user, organization, and license info | ✅ Required |
| `Agent365_....csv` | Agent catalog snapshot (only produced if you also pass `-IncludeAgent365Info`) | Optional but **highly recommended** |

<a id="agent-365"></a>

### 🤖 Agent 365 — the one source you can also export manually

Agent 365 data is a **point-in-time catalog snapshot** of the agents registered in your tenant (name, host product, developer, status, version, etc.). Unlike Purview audit data and Entra/MAC user data, this file is **not** transformed by the embedded Python rollup processor — PAX produces it as a straight passthrough using the same column shape the dashboard expects.

Because there's no processor step involved, this is the **one and only** input file the dashboard accepts directly from the Microsoft 365 Admin Center's manual UI export. Purview audit data and Entra/MAC user data **must** go through a processor step — either PAX or the standalone processor script in the [`scripts/`](../scripts/) folder. See the [**⚙️ Standalone processor**](standalone-processor.md) page for the non-PAX path.

You have two options for getting the Agent 365 file:

**Option 1 — let PAX produce it**

Add the `-IncludeAgent365Info` switch to your PAX command. PAX will produce `Agent365_<timestamp>.csv` alongside the rollup files. This is the simplest path and keeps all three input files together. (`-IncludeAgent365Info` is fully compatible with `-Rollup` and `-RollupPlusRaw`.)

Note: producing the Agent 365 file requires additional permissions — typically **AI Admin** or **Global Reader** — on top of the Purview/Entra permissions PAX already needs. If your admin doesn't have these, Option 2 below works just as well.

**Option 2 — manual export from the Microsoft 365 Admin Center**

Use this path if you don't want to run PAX with elevated Agent 365 permissions, or if a different person owns Agent 365 governance in your org. Steps:

1. Go to **[admin.microsoft.com](https://admin.microsoft.com)** → in the left nav, **Agents** → **All Agents**
2. Click **Export** in the toolbar (the button is sometimes labeled "Export to Excel", but the file it produces is **CSV** — see [Microsoft Learn: Manage agent registry](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry))
3. Save the `.csv` to a known location
4. Point the `Agent 365` parameter in the PBIT at that CSV

> 💡 **Tip — for scheduled refresh (PBI-SharePoint edition):** the PBI-SharePoint edition requires **all three** input files to be SharePoint URLs. Upload your manually-exported Agent 365 CSV to the **same SharePoint folder** as your Interactions and Org Data files so all three parameters point at SharePoint. See the [mixed-source caveat](power-bi-report.md#mix-locations) on the Power BI report page.

### Three example commands

These are the most common patterns. Your admin can copy-paste them, adjusting paths/URLs for your environment. (See the PAX repo for the full set of switches and options.)

**1. Local CSVs — single-user / quick try**

```powershell
.\PAX_Purview_Audit_Log_Processor.ps1 -Rollup -IncludeAgent365Info -OutputPath "C:\Data\PAX"
```

**2. SharePoint — recommended for scheduled refresh (no Gateway required)**

```powershell
.\PAX_Purview_Audit_Log_Processor.ps1 -Rollup -IncludeAgent365Info `
  -OutputPath "https://contoso.sharepoint.com/sites/CopilotAnalytics/Shared Documents/PAX Output"
```

<a id="sharepoint-url"></a>

> ### 📋 How to get the *correct* SharePoint URL (this trips everyone up)
>
> **Do NOT copy the URL from your browser's address bar.** That URL includes view parameters (`?...`), session tokens, and a path layout that won't work for either PAX output or the PBIT parameters.
>
> **Do this instead — for a folder URL** (used as PAX `-OutputPath`):
> 1. In SharePoint, navigate to the document library and into the target folder
> 2. Click the **three-dot menu (`⋮`)** next to the folder name, or right-click the folder → **Details**
> 3. In the details pane on the right, scroll to **Path**
> 4. Click the **📋 copy icon** next to the path
> 5. Paste somewhere — you'll get a clean URL like `https://contoso.sharepoint.com/sites/CopilotAnalytics/Shared Documents/PAX Output` (no `?...`, no view state)
>
> **For a file URL** (used in the PBIT parameters):
> 1. Navigate into the folder so you see the file in the list
> 2. Click the **three-dot menu (`⋮`)** next to the file name → **Details**
> 3. Copy the **Path** the same way
> 4. Paste — you should get something ending in `.../filename.csv`
>
> If your URL looks like `https://contoso.sharepoint.com/:x:/r/sites/.../filename.csv?d=w...&csf=1&web=1&e=...` — that's the **browser address bar URL** (or a "Copy link" share link). It will not work. Go back and use the Details pane Path instead.

**3. OneLake / Fabric — large tenants, multi-year retention**

```powershell
.\PAX_Purview_Audit_Log_Processor.ps1 -Rollup -IncludeAgent365Info `
  -OutputPath "https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>.Lakehouse/Files/PAX"
```

<a id="aca-job"></a>

### Fabric setup (Azure Container Apps Job) — read this if you're a Fabric customer

If you have Fabric capacity, the recommended pattern is to run PAX inside an **Azure Container Apps Job** on a schedule, writing the rollup files directly to a Lakehouse in OneLake. The Power BI dataset then refreshes against OneLake via SSO with no Gateway, no laptop dependency, and no manual file-copy step.

Everything you need to set this up is in the **`fabric_resources/`** folder of the PAX repo:

👉 **https://github.com/microsoft/PAX** → `fabric_resources/`

That folder contains:
- A **Dockerfile** for building the PAX container image
- **Detailed step-by-step instructions** for deploying the Azure Container Apps Job
- Prereq checklists (capacity, identity, RBAC, secret management)
- Configuration templates

**If you're a Fabric customer, do not skip this folder** — it has the canonical Fabric deployment guidance.

---

<a id="appendfile"></a>

## 📚 Multi-month history & the `-AppendFile` switch — what works today

Many customers want **months of trailing data** in this dashboard, not just a single PAX run. Here's the current state of how to get there.

### What `-AppendFile` does in PAX

PAX has an `-AppendFile` switch that appends new rows to an existing CSV instead of writing a fresh timestamped file. It's designed for exactly this scenario — running PAX on a schedule, accumulating audit history into one growing file over time. Key facts:

- **The target file must already exist.** Run PAX **once without** `-AppendFile` to create the initial seed file, then use `-AppendFile <name>` on every subsequent run.
- **CSV headers must match exactly** between the existing file and the new run. PAX validates this and exits with a clear error on mismatch.
- **Only Purview audit data is appendable.** `-AppendFile` is **incompatible with `-IncludeUserInfo` / `-OnlyUserInfo`** because Entra/MAC user+licensing data is a **point-in-time snapshot** — appending old user state on top of new state would corrupt the picture. Same logic applies to Agent 365.
- Each run still produces fresh timestamped log / telemetry / metrics files alongside the appended output.

### The catch: `-AppendFile` cannot currently be combined with `-Rollup` / `-RollupPlusRaw`

This is the honest answer: as of today, PAX **blocks `-AppendFile` when `-Rollup` or `-RollupPlusRaw` is used**, and exits with an error. The rollup processor assigns INT surrogate keys (`Message_Id`, `ThreadId`, `UserKey`) per run, so appending rolled-up rows would produce mismatched keys and a broken file.

> **Rollup-aware appending with the standalone processor:** Use the standalone processor in the [`scripts/`](../scripts/) folder for this pattern:
> 1. Use PAX with `-AppendFile` (no `-Rollup`) to accumulate a growing **raw** Purview audit CSV over time
> 2. Run that accumulated raw file through the standalone processor to produce a freshly-keyed rollup file the dashboard can consume
>
> This gives you the best of both worlds — incremental daily/weekly raw appends from PAX, plus a clean dashboard-ready rollup whenever you need to refresh the report. See the [**⚙️ Standalone processor**](standalone-processor.md) page for usage details.

### What to do right now if you want months of data

Until rollup-append lands, use one of these patterns:

**Pattern A — full re-run of a rolling window (simplest, recommended for most)**

Schedule PAX with `-Rollup` over a rolling window (e.g. last 60 or 90 days, depending on your Purview retention). Each run replaces the previous rollup output. Power BI just refreshes against the latest file. Trade-off: every run does a full export, which on large tenants takes longer than an incremental append would.

```powershell
# Example: weekly run, last 90 days
.\PAX_Purview_Audit_Log_Processor.ps1 -Rollup -IncludeAgent365Info `
  -StartDate (Get-Date).AddDays(-90).ToString('yyyy-MM-dd') `
  -EndDate   (Get-Date).ToString('yyyy-MM-dd') `
  -OutputPath "https://contoso.sharepoint.com/sites/CopilotAnalytics/Shared Documents/PAX Output"
```

**Pattern B — accumulate raw with `-AppendFile` now, convert to rollup when the standalone processor ships**

If you want to start building up multi-month raw history immediately so you're ready the day the standalone processor releases, run PAX **without** `-Rollup` and use `-AppendFile` to grow a single raw Purview CSV over time.

```powershell
# Step 1 (run ONCE) — create the initial seed file
.\PAX_Purview_Audit_Log_Processor.ps1 -StartDate 2026-02-01 -EndDate 2026-02-28 `
  -ActivityTypes CopilotInteraction -CombineOutput -OutputPath "C:\Data\PAX"

# Step 2 (run on a schedule) — append each new day/week into the same file
.\PAX_Purview_Audit_Log_Processor.ps1 -StartDate 2026-03-01 -EndDate 2026-03-07 `
  -ActivityTypes CopilotInteraction -CombineOutput `
  -AppendFile "Purview_Audit_UsageActivity_CombinedActivityTypes_<seed-timestamp>.csv" `
  -OutputPath "C:\Data\PAX"
```

Important points for Pattern B:
- The accumulated **raw** file produced this way **cannot** be opened by this dashboard directly — it must be processed first.
- Run the standalone processor in the [`scripts/`](../scripts/) folder against the accumulated raw file to produce dashboard-ready rollup output. See the [**⚙️ Standalone processor**](standalone-processor.md) page for usage details.
- For current dashboards, also do a Pattern A run in parallel so you have a usable rollup file while you build up your raw history.
- Don't forget: Entra/MAC user data and Agent 365 data still need to be fresh point-in-time exports — they cannot be appended.
