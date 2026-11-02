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

Many customers want **months of trailing data** in this dashboard, not just a single PAX run. PAX's `-AppendFile` switch grows one set of rollup files across scheduled runs.

### What `-AppendFile` does in PAX

`-AppendFile` merges a run's rows into an existing file instead of writing a new timestamped one. In PAX 1.11.15:

- **It works with `-Rollup` and `-RollupPlusRaw`.** Point it at the rolled-up `..._Interactions.csv`. PAX matches rows on the full grain plus each message's `Message_Id_Raw`, so days that overlap between runs aren't counted twice, and rows that are only in the existing file are kept.
- **The target file must already exist.** Run PAX once without `-AppendFile` to make the seed files, then append to them on every later run.
- **The Users and Agent 365 files have their own switches.** `-AppendUserInfo` merges the run's users into an existing Users file and keeps people who have since left, marked `In_Latest_Append = FALSE`. `-AppendAgent365Info` does the same for the Agent 365 file. Each one turns on its `-Include…` switch for you.
- **The Users and Agent 365 files take one destination each:** `-AppendUserInfo` or `-OutputPathUserInfo`, and `-AppendAgent365Info` or `-OutputPathAgent365Info`, never both. `-AppendFile` takes a full path, or a file name in the `-OutputPath` folder.
- **`-AppendFile` can't be used with `-OnlyUserInfo` or `-OnlyAgent365Info`**, which load no audit data.
- **A file from an older PAX needs a one-time re-baseline.** PAX won't merge into a file that lacks the columns it matches on (for example, AIO files made before PAX 1.11.12). It leaves that file untouched, writes the run's rows to a new timestamped file, and says so. Make new seed files with the current PAX and append to those.
- Each run still writes its own timestamped log and metrics files.

### A daily refresh with `-AppendFile`

```powershell
# Once: the seed run, with as much history as you want (up to your audit log retention)
.\PAX_Purview_Audit_Log_Processor.ps1 -Rollup `
  -StartDate (Get-Date).AddDays(-180).ToString('yyyy-MM-dd') `
  -EndDate   (Get-Date).ToString('yyyy-MM-dd') `
  -OutputPath "C:\Data\PAX" -IncludeUserInfo -OutputPathUserInfo "C:\Data\PAX"

# Then on a schedule: the last 7 days, merged into the seed run's files
.\PAX_Purview_Audit_Log_Processor.ps1 -Rollup `
  -StartDate (Get-Date).AddDays(-7).ToString('yyyy-MM-dd') `
  -EndDate   (Get-Date).ToString('yyyy-MM-dd') `
  -AppendFile "C:\Data\PAX\<seed>_Interactions.csv" `
  -AppendUserInfo "C:\Data\PAX\<seed>_Users.csv"
```

Replace `<seed>_Interactions.csv` and `<seed>_Users.csv` with the names of the files the seed run wrote. The 7-day window overlaps earlier runs on purpose: audit records can arrive late, and PAX merges the overlap rather than counting it twice.

For the Agent 365 file, add `-IncludeAgent365Info -OutputPathAgent365Info "C:\Data\PAX"` to the seed run and `-AppendAgent365Info` with the seed's Agent 365 file to the scheduled run.

**Keeping the raw audit data too.** Run PAX without `-Rollup` and use `-AppendFile` to grow one raw Purview audit CSV, then run the standalone processor in the [`scripts/`](../scripts/) folder on it whenever you need a dashboard-ready rollup. See the [**⚙️ Standalone processor**](standalone-processor.md) page.
