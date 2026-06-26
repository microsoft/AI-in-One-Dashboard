<div align="center">

<br>

# 🧠 AI-in-One Dashboard

### One Power BI dashboard for all Microsoft Copilot and Agent adoption signals.

<br>

[![Built by Microsoft](https://img.shields.io/badge/Built%20by-Microsoft-0078d4?style=for-the-badge&logo=microsoft&logoColor=white)](https://microsoft.github.io/Analytics-Hub/team/)
[![Analytics Hub](https://img.shields.io/badge/Analytics%20Hub-11%20Repositories-8661c5?style=for-the-badge&logo=github&logoColor=white)](https://microsoft.github.io/Analytics-Hub/)

**All Reports:** [https://microsoft.github.io/Analytics-Hub/](https://microsoft.github.io/Analytics-Hub/)

<br>

**Found this useful? ⭐ Star this repo to help others discover it!**

<br>

**[Dashboard Preview ↓](#-dashboard-preview)** &nbsp;·&nbsp; **[What is PAX? ↓](#-what-is-pax)** &nbsp;·&nbsp; **[Get Your Data ↓](#-get-your-data--run-pax-to-produce-the-files)** &nbsp;·&nbsp; **[Instructions ↓](#-open-and-configure-the-power-bi-template)** &nbsp;·&nbsp; **[Related Resources ↓](#-related-resources)** &nbsp;·&nbsp; **[Email your Admin ↓](#-email-your-admin)**

<br>

</div>

# 🤖 AI-in-One Dashboard — Rollup Edition

<p style="font-size:small; font-weight:normal;">
This folder contains the <strong>AI-in-One Dashboard (Rollup edition)</strong> Power BI template, available in <strong>two editions</strong>: a flexible <strong>3-in-1 auto-detect</strong> edition (reads local, SharePoint, or OneLake files) and a <strong>SharePoint-only (PBI-SharePoint)</strong> edition built for automatic scheduled refresh in the Power BI Service. Both deliver the same comprehensive insights into Microsoft Copilot and Agent adoption, empowering AI and business leaders to make informed decisions about AI implementation, licensing, and enablement strategies — and both load dramatically faster than previous versions thanks to a new pre-processed file format. <strong>See <a href="#-which-edition-should-i-download">Which edition should I download</a> to pick the right one.</strong>
</p>

---

> ## 🟦 IMPORTANT — Required input file format
>
> **This template requires pre-processed rollup files — it cannot read raw Purview CSVs, raw Entra exports, or files from any other unprocessed source.** Pointing the template at raw files will result in load failures or blank visuals.
>
> **The recommended way to produce these files is the PAX script.** See [**📦 What is PAX?**](#-what-is-pax) below for what PAX is and where to get it.
>
> Customers who export raw Purview and Entra data through a method other than PAX can use the standalone processor script in the [`scripts/`](scripts/) folder to produce the same rollup files. See the **⚙️ Standalone processor** section below.

---

## 📸 Dashboard Preview

See the dashboard in action:

![AI-in-One Dashboard animated preview](https://github.com/microsoft/AI-in-One-Dashboard/raw/main/Images/AIO%20v10%20Gif.gif)

---

## 🧭 Which edition should I download

This Rollup release ships in **two editions** that share the *exact same pages, visuals, and numbers*. They differ only in **where they read your input files from** and **whether the Power BI Service can refresh them on a schedule.** Pick one:

| | **Rollup Edition** (3-in-1, auto-detect) | **Rollup Edition — PBI-SharePoint** |
|---|---|---|
| **⬇️ Download** | **[AIO Dashboard - Rollup Edition](https://github.com/microsoft/AI-in-One-Dashboard/raw/main/AIO%20Dashboard%20-%20Rollup%20Edition%20-%202026-06-25.pbit)** | **[AIO Dashboard - Rollup Edition - PBI-SharePoint](https://github.com/microsoft/AI-in-One-Dashboard/raw/main/AIO%20Dashboard%20-%20Rollup%20Edition%20-%20PBI-SharePoint%20-%202026-06-25.pbit)** |
| **Input file locations** | **Local path, SharePoint URL, _or_ OneLake URL** — auto-detected for each parameter | **SharePoint URLs only** (each input is validated as a SharePoint URL) |
| **Best for** | Power BI Desktop analysis, quick local trials, OneLake/Fabric, or any mix of the above | Publishing to the Power BI Service when you want **automatic scheduled refresh** |
| **Scheduled refresh in the Service** | ❌ Not supported _(see below)_ | ✅ Supported — no Gateway needed |
| **Manual / on-demand refresh** | ✅ In Desktop (and on-demand in the Service) | ✅ |

### Why are there two editions

The Power BI Service decides whether it can schedule a dataset by **statically inspecting** how it connects to its sources — *before* it ever runs the query. A source whose location is computed at runtime — which is exactly how the 3-in-1 edition stays flexible enough to accept a local path **or** a SharePoint URL **or** a OneLake URL — is classified as a **dynamic data source**, and the Service **disables scheduled refresh for the entire dataset** when one is present. No M arrangement avoids this while keeping that flexibility; it's a platform rule, not a template bug.

The **PBI-SharePoint** edition gives up that flexibility on purpose: every input is read through a single, **static SharePoint connector** that the Service is happy to schedule. That one change is the only difference under the hood — the report itself is identical.

**Rule of thumb**
- Exploring in Power BI Desktop, or your files are local / on OneLake → **3-in-1 edition.**
- You want the report to refresh itself on a schedule in the Service and your files are on SharePoint → **PBI-SharePoint edition.**
- Your files are on OneLake/Fabric **and** you need scheduled refresh → use the dedicated Fabric edition in [`Classic Editions/3. Fabric/`](Classic%20Editions/3.%20Fabric/), a Fabric-native thin client.

---

<details>
<summary>⚠️ <strong>Important usage & compliance disclaimer</strong></summary>

Please note:

While this tool helps customers better understand their AI usage data, Microsoft has **no visibility** into the data that customers input into this template/tool, nor does Microsoft have any control over how customers will use this template/tool in their environment.

Customers are solely responsible for ensuring that their use of the template tool complies with all applicable laws and regulations, including those related to data privacy and security.

**Microsoft disclaims any and all liability** arising from or related to customers' use of the template tool.

**Experimental Template Notice:**
This is an experimental template with audit logs as the primary source. The audit logs from Microsoft Purview are intended to support security and compliance use cases. While they provide visibility into Copilot and Agent interactions, they are not intended to serve as the sole source of truth for licensing or full-fidelity reporting on Copilot or Agent activity. For the most accurate and reliable usage insights, users are encouraged to refer to data from the Microsoft 365 Admin Center and Viva Insights. Currently available in English only.

</details>

---

## 📦 What is PAX?

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

**PAX** stands for **Portable Audit eXporter**. It's a free, open-source PowerShell script from the Microsoft Copilot Growth ROI Advisory team that:

- Pulls Microsoft 365 Copilot audit data out of Microsoft Purview
- Pulls user, organization, and licensing data out of Microsoft Entra and the Microsoft 365 Admin Center (MAC)
- Pull additional agent details from Agent 365
- Writes the results as CSV files — locally, to SharePoint, or to OneLake/Fabric
- When run with one of the **rollup switches** (see below), it also pre-processes the Purview and Entra/MAC CSVs into the exact format this dashboard template expects. The optional Agent 365 data does not need any pre-processing for use in this dashboard.

**PAX repo (bookmark this):** **https://github.com/microsoft/PAX**

Throughout this README, "run PAX" means running the script from that repo. PAX is the recommended (and currently only supported) way to produce input files for this dashboard.

</details>

---

## ⚡ How this version is different — and why it loads so much faster

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

If you've used a previous version of the AI-in-One Dashboard, here's what changed and why it matters.

### The old way (and why it hurt)

In previous versions, Power BI did all of the heavy lifting itself. It opened large raw Purview audit files (often hundreds of megabytes — sometimes gigabytes), picked apart the messy nested data inside each row, looked up who each user was, figured out their licenses, and computed dozens of derived fields on the fly. For a small tenant, this was fine. For real-world tenants, this meant:

- Power BI Desktop loads of an hour or more
- Frequent "out of memory" errors
- Refresh failures and timeouts in the Power BI Service
- Dashboards that were effectively unusable for large organizations

### The new way

All of that prep work now happens **once, ahead of time**, in a small Python helper that runs as an embedded part of the PAX script. By the time Power BI ever opens the file, the hard work is already done. Power BI just reads a clean, ready-to-use file and shows you the dashboard.

### What "rollup" actually means here

The Python helper does the following, in order:

1. Reads the raw Purview audit file and the Entra/MAC user + licensing file
2. Expands the raw audit data into its full detail (one row per interaction × prompt × resource)
3. Merges in user, organization, and license information
4. Pre-calculates a long list of fields that the dashboard used to compute on the fly (things like agent identifiers, behavior categories, value outcomes, activity dates, etc.)
5. **Groups the result back together** at exactly the level the dashboard needs

A note on file size: the final rollup file usually has **more rows than the raw input** (because the raw was packed/compressed and we expanded it before regrouping). That sounds counterintuitive — but every row in the rollup file is already shaped *exactly* the way the dashboard wants it, so Power BI doesn't have to do any of the expensive work itself. And the processed files are only a fraction of their original size!

### Why two input files

- **Purview audit data** tells you *what people did with Copilot*
- **Entra + MAC user/license data** tells you *who they are and what licenses they have*

The Python helper joins these once, upstream, so Power BI doesn't have to do that join across millions of rows every time the dashboard refreshes.

### The result

- Typically **~80%+ reduction in Power BI load times**
- Reliable scheduled refresh in the Power BI Service
- No more wrestling with timeouts on large tenants
- Same pages, same visuals, same numbers — just calculated upstream so PBI doesn't have to

</details>

---

## 📊 What This Dashboard Provides

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

- **Comprehensive visibility into M365 Copilot, unlicensed Copilot Chat, and Agent usage** across your organization
- **User engagement tracking over time** to identify adoption patterns and trends across all Copilot surfaces
- **Data-driven insights** to optimize AI investments, license allocation, and employee enablement
- **Customizable views** to segment data by department, role, or other organizational dimensions

</details>

---

## 🚀 How This Helps Leaders

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

- **Make informed AI and Microsoft Copilot investment decisions** using comprehensive usage data and analytics consolidated in one place
- **Identify Copilot and Agent adoption champions** and areas needing additional enablement
- **Optimize enablement and change management efforts** based on actual usage patterns across M365 Copilot, unlicensed Copilot Chat, and Agents
- **Accelerate AI readiness, adoption, and impact** across the organization — from licensed Copilot experiences to emerging Agent capabilities

</details>

---

## 📥 Get your data — run PAX to produce the files

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

> **Reminder:** This template only consumes the rollup files produced by PAX. If you (or your admin) try to point it at a raw Purview audit CSV or a manually-exported Entra users CSV, it won't work.

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

### 🤖 Agent 365 — the one source you can also export manually

Agent 365 data is a **point-in-time catalog snapshot** of the agents registered in your tenant (name, host product, developer, status, version, etc.). Unlike Purview audit data and Entra/MAC user data, this file is **not** transformed by the embedded Python rollup processor — PAX produces it as a straight passthrough using the same column shape the dashboard expects.

Because there's no processor step involved, this is the **one and only** input file the dashboard accepts directly from the Microsoft 365 Admin Center's manual UI export. Purview audit data and Entra/MAC user data **must** go through a processor step — either PAX or the standalone processor script in the [`scripts/`](scripts/) folder. See the **⚙️ Standalone processor** section below for the non-PAX path.

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

> 💡 **Tip — for scheduled refresh (PBI-SharePoint edition):** the PBI-SharePoint edition requires **all three** input files to be SharePoint URLs. Upload your manually-exported Agent 365 CSV to the **same SharePoint folder** as your Interactions and Org Data files so all three parameters point at SharePoint. See the [mixed-source caveat](#-can-i-mix-file-locations-eg-sharepoint--local) further down.

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

</details>

---

## ⚙️ Standalone processor — processing raw data without PAX

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

The [`scripts/`](scripts/) folder in this folder contains a Python script that produces the same two rollup files this dashboard requires — without needing PAX. Use this path if you export raw Purview audit data and Entra/MAC user data through your own tooling, portal exports, or an alternative script rather than through PAX.

> **Note:** This processor handles the Purview interactions file and the Entra/MAC users file only. It does not produce the Agent 365 file. For Agent 365 data, see the **🤖 Agent 365** section above.

### Requirements

- **Python 3.9 or later**
- The `orjson` package is optional but recommended for faster JSON parsing:
  ```
  pip install orjson
  ```
  The script falls back to the Python standard library `json` module if `orjson` is not installed.

### What you need before running

Two input files are required. Both must be CSV format.

---

#### Input 1 — Raw Purview audit CSV (`--purview`)

This is the raw audit log export from Microsoft Purview. Export it from the **Microsoft Purview compliance portal → Audit → search/export**.

The script filters the file automatically — only `CopilotInteraction` operation records are processed; all other record types are skipped.

| Column | Required? | Notes |
|---|---|---|
| `AuditData` | ✅ Required | The JSON blob column that Purview includes in every audit export. All Copilot interaction detail is parsed from inside this column. If this column is absent, the script will produce no output. |
| `Operation` or `Operations` | Used for filtering | Used to identify `CopilotInteraction` records when the value is not already inside the `AuditData` JSON. Purview exports typically include one of these. |

All other columns in the Purview export are ignored — the script reads only `AuditData` and `Operation`/`Operations`.

---

#### Input 2 — Combined Entra + MAC users CSV (`--entra`)

This file is **not** a direct export from a single portal. It is a combined file you assemble by joining two separate exports:

1. **Microsoft Entra ID user export** — provides the user list with UPN, display name, department, job title, etc.
2. **Microsoft 365 Admin Center (MAC) licensing export** — provides the per-user Copilot license assignment column

You must add the license column from the MAC export into the Entra user export (for example, using Excel or Power Query) before passing the file to the script. If no recognized license column is present, the script will still process the file but every user will be tagged as `Unlicensed`.

| Column | Required? | Accepted column names | Notes |
|---|---|---|---|
| User Principal Name | ✅ Required | `userPrincipalName`, `upn`, `personId` (case-insensitive) | Used to join Purview audit records to user data. Rows with a blank UPN are still written to the Users output but will not join to any audit activity. |
| Copilot license flag | ✅ Strongly recommended | `Has license`, `Has License`, `hasLicense`, `HasLicense`, `Has Copilot License`, `Has Copilot license`, `HasCopilotLicense`, `Has Copilot License Assigned`, `Has Copilot license assigned`, `isUser` | Any truthy value (`Yes`, `True`, `Y`, `1`) is treated as licensed; everything else is unlicensed. If the column is missing entirely, all users default to unlicensed. |
| Department | ✅ Required | Any casing of `department`, `organization`, or `organisation` — spaces, hyphens, and underscores in the column name are ignored when matching | Renamed to `Organization` in the output. Used for org-level segmentation in the dashboard. |
| Job title | ✅ Required | Any casing of `jobtitle` or `job title` — spaces, hyphens, and underscores in the column name are ignored when matching | Renamed to `JobTitle` in the output. |
| All other columns | Optional | Any | All other columns in your input file are passed through to the Users output as-is. |

### Arguments

| Argument | Required? | Description |
|---|---|---|
| `--purview <path>` | ✅ Required | Path to the raw Purview audit log CSV |
| `--entra <path>` | ✅ Required | Path to the Entra users CSV |
| `--out-dir <path>` or `-o <path>` | Optional | Directory where output files are written. Defaults to the same directory as the Purview input file |
| `--quiet` or `-q` | Optional | Suppresses progress output. Useful in scheduled or automated contexts |

### What the processor produces

Two files are written to the output directory, named automatically based on your input filenames and a run timestamp:

| Output file | What it is | Dashboard parameter |
|---|---|---|
| `<purview-filename>_Interactions_<timestamp>.csv` | Rolled-up Copilot interactions fact table | **Copilot Interactions File** |
| `<entra-filename>_Users_<timestamp>.csv` | Users and licensing dimension table | **Org Data File** |

Point the corresponding dashboard parameters at these two output files exactly as you would with PAX-produced files.

### Usage examples

Run the `.py` file found in the `scripts/` folder. In the examples below, replace `scripts/<processor>.py` with the actual filename.

**Basic — output files are written to the same folder as the Purview input**

```
python scripts/<processor>.py --purview "C:\Data\Purview_Audit_20260510.csv" --entra "C:\Data\EntraUsers_20260510.csv"
```

**With an explicit output directory**

```
python scripts/<processor>.py --purview "C:\Data\Purview_Audit_20260510.csv" --entra "C:\Data\EntraUsers_20260510.csv" --out-dir "C:\Data\Rollup Output"
```

**Quiet mode — suppress progress output (useful in scheduled tasks)**

```
python scripts/<processor>.py --purview "C:\Data\Purview_Audit_20260510.csv" --entra "C:\Data\EntraUsers_20260510.csv" --out-dir "C:\Data\Rollup Output" --quiet
```

### Multi-month history with the standalone processor

If you use PAX's `-AppendFile` switch to accumulate a growing raw Purview CSV over time, run the standalone processor against that accumulated file to produce a fresh rollup whenever you need to refresh the dashboard. See the **📚 Multi-month history** section below for the full pattern, including the recommended commands.

</details>

---

## 📚 Multi-month history & the `-AppendFile` switch — what works today

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

Many customers want **months of trailing data** in this dashboard, not just a single PAX run. Here's the current state of how to get there.

### What `-AppendFile` does in PAX

PAX has an `-AppendFile` switch that appends new rows to an existing CSV instead of writing a fresh timestamped file. It's designed for exactly this scenario — running PAX on a schedule, accumulating audit history into one growing file over time. Key facts:

- **The target file must already exist.** Run PAX **once without** `-AppendFile` to create the initial seed file, then use `-AppendFile <name>` on every subsequent run.
- **CSV headers must match exactly** between the existing file and the new run. PAX validates this and exits with a clear error on mismatch.
- **Only Purview audit data is appendable.** `-AppendFile` is **incompatible with `-IncludeUserInfo` / `-OnlyUserInfo`** because Entra/MAC user+licensing data is a **point-in-time snapshot** — appending old user state on top of new state would corrupt the picture. Same logic applies to Agent 365.
- Each run still produces fresh timestamped log / telemetry / metrics files alongside the appended output.

### The catch: `-AppendFile` cannot currently be combined with `-Rollup` / `-RollupPlusRaw`

This is the honest answer: as of today, PAX **blocks `-AppendFile` when `-Rollup` or `-RollupPlusRaw` is used**, and exits with an error. The rollup processor assigns INT surrogate keys (`Message_Id`, `ThreadId`, `UserKey`) per run, so appending rolled-up rows would produce mismatched keys and a broken file.

> **Rollup-aware appending with the standalone processor:** Use the standalone processor in the [`scripts/`](scripts/) folder for this pattern:
> 1. Use PAX with `-AppendFile` (no `-Rollup`) to accumulate a growing **raw** Purview audit CSV over time
> 2. Run that accumulated raw file through the standalone processor to produce a freshly-keyed rollup file the dashboard can consume
>
> This gives you the best of both worlds — incremental daily/weekly raw appends from PAX, plus a clean dashboard-ready rollup whenever you need to refresh the report. See the **⚙️ Standalone processor** section below for usage details.

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
- Run the standalone processor in the [`scripts/`](scripts/) folder against the accumulated raw file to produce dashboard-ready rollup output. See the **⚙️ Standalone processor** section below for usage details.
- For current dashboards, also do a Pattern A run in parallel so you have a usable rollup file while you build up your raw history.
- Don't forget: Entra/MAC user data and Agent 365 data still need to be fresh point-in-time exports — they cannot be appended.

</details>

---

## 🔐 Open and Configure the Power BI Template

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

### What you'll do

1. Download and open **one of the two editions** in **Power BI Desktop** (see [Which edition should I download](#-which-edition-should-i-download)):
   - **`AIO Dashboard - Rollup Edition - 2026-06-25.pbit`** — accepts local, SharePoint, _or_ OneLake files; best for Desktop and manual refresh
   - **`AIO Dashboard - Rollup Edition - PBI-SharePoint - 2026-06-25.pbit`** — accepts SharePoint URLs only; use this one if you want scheduled refresh in the Service
2. Fill in the three parameters when prompted
3. Click **Load**

### The three parameters

| Parameter | What to paste in | Required? |
|---|---|---|
| **Copilot Interactions File** | The full path or URL to your `Purview_Audit_..._Interactions.csv` | ✅ Required |
| **Org Data File** | The full path or URL to your `EntraUsers_MAClicensing_..._Users.csv` | ✅ Required |
| **Agent 365 (highly recommended)** | The full path or URL to your `Agent365_....csv`, **or leave blank** to skip | Optional |

### Auto-detection — paste any of three formats *(3-in-1 edition)*

> **PBI-SharePoint edition:** each parameter must be a **SharePoint URL** — the template checks that the value starts with `https://` and points at a SharePoint site. Paste a local path or OneLake URL into that edition and you'll get a friendly message telling you to use the 3-in-1 edition instead. The auto-detection described below applies to the **3-in-1 (auto-detect)** edition.

Each parameter accepts whichever of these matches where your file lives. The template figures out the rest automatically:

- **Local file path** — e.g. `C:\Data\PAX\Purview_Audit_20260510_120000_Interactions.csv`
- **SharePoint URL** — e.g. `https://contoso.sharepoint.com/sites/CopilotAnalytics/Shared Documents/PAX Output/Purview_Audit_20260510_120000_Interactions.csv`
- **OneLake URL** — e.g. `https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>.Lakehouse/Files/PAX/Purview_Audit_20260510_120000_Interactions.csv`

The template is tolerant of common copy-paste mistakes:
- Surrounding quotes (single or double, including "smart quotes" from email clients) are stripped automatically
- URL-encoded spaces (`%20`) and trailing query strings (`?...`) are handled
- SharePoint URLs are matched case-insensitively and tolerate trailing slashes

> ⚠️ **SharePoint URL gotcha** — the URL you paste into these parameters must be the **document path** from the SharePoint details pane, **NOT** the URL in your browser's address bar and **NOT** a "Copy link" share link. See [How to get the correct SharePoint URL](#-how-to-get-the-correct-sharepoint-url-this-trips-everyone-up) above for step-by-step instructions.

### ❓ Can I mix file locations (e.g. SharePoint + local)?

Technically yes — each of the three parameters resolves its backend independently, so the template will accept (say) a SharePoint URL for Interactions, a SharePoint URL for Org Data, and a local path for Agent 365. In practice, **mixing source types is awkward and we recommend against it**:

- Power BI Desktop will throw `Formula.Firewall` errors when combining different source types unless you set Privacy → "Combine data without privacy"
- Power BI Service requires you to configure credentials separately for **each** source type, and Privacy levels must be set consistently
- Any local-path source requires an **On-premises Data Gateway** in the Power BI Service — but SharePoint and OneLake do not

**Strong recommendation: keep all three files in the same storage location.** The most common mismatch is a manually-exported Agent 365 file sitting on someone's laptop while the Purview/Entra rollup files live on SharePoint or OneLake. Easy fix: upload the Agent 365 CSV to the same SharePoint/OneLake folder.

### Troubleshooting

- **"File not found" / `DataSource.Error`** — double-check the path or URL is exactly what PAX wrote. Local paths must be absolute (e.g. `C:\Data\file.csv`, not `.\file.csv`). For SharePoint, copy the full document URL.
- **`Formula.Firewall: Query references other queries…`** — privacy-level mismatch when combining sources. In Power BI Desktop: **File → Options → Current File → Privacy → Combine data without privacy**. In Power BI Service: dataset Settings → Data source credentials → set **Privacy: Organizational** (or **None**) for SharePoint and OneLake sources.
- **Blank visuals after load** — the most common cause is that the input file is **not** a PAX rollup file. Confirm the filename matches the `..._Interactions.csv` / `..._Users.csv` pattern and was produced by PAX with `-Rollup` or `-RollupPlusRaw`.

</details>

---

## 🔄 Set up scheduled refresh in Power BI Service

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

> ### ⚠️ Scheduled refresh requires the **PBI-SharePoint** edition
> Automatic scheduled refresh in the Power BI Service is supported **only by the PBI-SharePoint edition**, with all three input files stored on SharePoint. The 3-in-1 (auto-detect) edition **cannot be scheduled** in the Service — its runtime-resolved connector is treated as a *dynamic data source*, which disables scheduled refresh for the entire dataset (a Power BI platform rule — see [Why are there two editions](#why-are-there-two-editions)). You can still refresh the 3-in-1 manually in Power BI Desktop. For OneLake/Fabric scheduled refresh, use the Fabric edition in [`Classic Editions/3. Fabric/`](Classic%20Editions/3.%20Fabric/).

Once the dashboard works in Power BI Desktop, publish the report to a Power BI Service workspace and configure scheduled refresh so it stays current automatically.

### For SharePoint-stored files — the PBI-SharePoint edition (recommended for most customers — no Gateway needed)

1. **Publish** the **PBI-SharePoint edition** report to a workspace from Power BI Desktop (`File → Publish → Publish to Power BI`)
2. In Power BI Service, go to the **dataset → Settings → Data source credentials**
3. Click **Edit credentials** for the SharePoint source and sign in with **OAuth2** using an account that can read the SharePoint folder
4. Set the **Privacy level** to **Organizational** (so PBI is allowed to combine your sources)
   > **Cross-tenant SharePoint:** if the SharePoint site holding your files is in a **different tenant** than your Power BI Service, sign in here with a guest/B2B account that has access to those files. The scheduled-refresh toggle stays **grayed out until valid credentials are saved** for every source — saving them here is what enables it. Conditional Access / MFA policies on the file-hosting tenant can block the unattended token renewal that scheduled refresh relies on; if the toggle won't enable after you sign in, that's the likely cause (copy the files into your own tenant, or use an account not subject to those policies).
5. Expand **Scheduled refresh** and turn it on. Pick a cadence (Daily / Weekly) that lines up with how often PAX runs
6. **Tip:** have your admin configure PAX to overwrite the *same filename* each run (rather than a new timestamped file every time). This way the dataset just refreshes against a stable URL — no template edits needed
7. **Limits to know:**
   - Power BI Pro: up to 8 scheduled refreshes per day
   - Premium / PPU: up to 48 scheduled refreshes per day
   - Make sure PAX finishes writing the file *before* your scheduled refresh window starts

### For OneLake / Fabric-stored files (recommended for large tenants)

> **For OneLake scheduled refresh, use the Fabric edition.** The 3-in-1 (auto-detect) edition reads OneLake files in Power BI Desktop, but it **can't be scheduled** in the Service (dynamic data source — see [Why are there two editions](#why-are-there-two-editions)), and the PBI-SharePoint edition only accepts SharePoint URLs. For Service-side **scheduled refresh against OneLake**, use the Fabric thin-client edition in [`Classic Editions/3. Fabric/`](Classic%20Editions/3.%20Fabric/). The steps below describe that Fabric pattern.

1. Publish the `.pbix` to a **Fabric-enabled workspace** (PPU or Fabric capacity required)
2. OneLake credentials are handled automatically via SSO if the workspace is in the same tenant — usually no manual credential setup needed
3. Configure scheduled refresh the same way as above
4. **Recommended pattern:** schedule PAX to run via an Azure Container Apps Job → PAX writes the rollup files directly to OneLake → the Power BI dataset's scheduled refresh fires shortly after.

> 🏭 **Fabric customers \u2014 use the `fabric_resources/` folder in the PAX repo.** It has the Dockerfile, detailed deployment instructions, prereq checklists, and configuration templates for setting up the Azure Container Apps Job end-to-end. Do not try to piece this together from scratch \u2014 the resources folder is the canonical guide.
>
> 👉 **https://github.com/microsoft/PAX** → `fabric_resources/`

### For local files

Power BI Service can't reach files on your laptop without an **On-premises Data Gateway**. If you're going to schedule refresh, use SharePoint or OneLake instead — both work without a Gateway and are simpler to maintain.

</details>

---

## 📊 Review and Customize

<details>
<summary><strong>Show this section</strong> <em>(click to expand)</em></summary>

<br>

Once the dashboard loads:

1. **Walk through the report pages** — verify data loaded correctly and that filters/slicers behave as expected
2. **Customize for your organization** — adjust colors/branding, organizational hierarchies, default date ranges, and bookmarks
3. **Publish and share** — publish to Power BI Service, optionally configure Row-Level Security, then share via workspace access or apps
4. **Set up subscriptions** — email subscriptions for executives who want regular updates without opening the dashboard

### Best practices

- 🔄 **Refresh schedule** — match it to how often PAX runs (typically weekly or daily)
- 🔒 **Row-Level Security** — restrict sensitive data by department or role if needed
- 📊 **Usage tracking** — monitor dashboard usage in Power BI Service to understand which views resonate

</details>

---

## 🔗 Related Resources

- **PAX (Purview Audit eXporter)** — the script that produces this template's input files: https://github.com/microsoft/PAX

---

## 🔄 Version History

This release ships **two editions**, both built for the same PAX rollup file format:

| Edition | File | Input locations | Scheduled refresh in the Service |
|---|---|---|---|
| Rollup Edition (3-in-1, auto-detect) | `AIO Dashboard - Rollup Edition - 2026-06-25.pbit` | Local / SharePoint / OneLake | Desktop / manual only |
| Rollup Edition — PBI-SharePoint | `AIO Dashboard - Rollup Edition - PBI-SharePoint - 2026-06-25.pbit` | SharePoint only | ✅ Supported |

As long as you're running a current version of PAX (v1.11.1+) with `-Rollup` (or `-RollupPlusRaw`), the output is compatible with both editions.

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE.md](../LICENSE.md) file for details.

---

## 🔒 Security

Please see [SECURITY.md](../SECURITY.md) for information on reporting security vulnerabilities.

---

## 📧 Email Your Admin

> 📧 **Before you begin, your IT admin needs to export data from Purview, Entra, and M365 Admin Center.**
> This pre-written email covers all required data sources, field names, admin roles, permissions, and export steps — everything your admin needs in one click.
>
> **[📨 Email Prerequisites to Your IT Admin](mailto:?subject=Action%20Required%3A%20Data%20Export%20Fields%20Needed%20for%20AI-in-One%20Dashboard%20%28Power%20BI%29&body=To%3A%20IT%20Admin%20%2F%20Global%20Admin%0ARe%3A%20AI-in-One%20Dashboard%20%E2%80%93%20Power%20BI%20Report%20Setup%0A%0A%0AWHAT%20THIS%20REPORT%20DOES%0A%0AThe%20AI-in-One%20Dashboard%20is%20a%20Power%20BI%20report%20that%20provides%20a%20comprehensive%20view%20of%20Microsoft%20365%20Copilot%2C%20unlicensed%20Copilot%20Chat%2C%20agent%20usage%2C%20and%20third-party%20AI%20adoption%20across%20your%20organization.%20It%20consolidates%20four%20data%20sources%20into%20a%20single%20dashboard%20for%20adoption%20tracking%2C%20license%20optimization%2C%20and%20enablement%20planning.%0A%0A%0ADATA%20SOURCES%20REQUIRED%0A%0A1.%20Microsoft%20Purview%20%E2%80%93%20Copilot%20Audit%20Logs%0A%20%20%20Export%3A%20Purview%20portal%20%28security.microsoft.com%29%20-%3E%20Audit%20-%3E%20Export%2C%20or%20PAX%20PowerShell%20script%0A%20%20%20Format%3A%20CSV%0A%0A2.%20Microsoft%20Entra%20ID%20%E2%80%93%20User%2FOrg%20Data%20%28includes%20license%20data%29%0A%20%20%20Export%3A%20entra.microsoft.com%20-%3E%20Identity%20-%3E%20Users%20-%3E%20Download%20users%2C%20or%20PAX%20script%20with%20-IncludeUserInfo%0A%20%20%20Format%3A%20CSV%0A%0A3.%20Microsoft%20365%20Admin%20Center%20%E2%80%93%20Agent%20365%20Inventory%0A%20%20%20Export%3A%20admin.microsoft.com%20-%3E%20Agents%20-%3E%20All%20Agents%20-%3E%20Export%20to%20Excel%0A%20%20%20Format%3A%20XLSX%0A%0A4.%20%28if%20not%20using%20PAX%29%20Microsoft%20365%20Admin%20Center%20%E2%80%93%20Licensed%20Users%0A%20%20%20Export%3A%20admin.microsoft.com%20-%3E%20Reports%20-%3E%20Usage%20-%3E%20M365%20Copilot%20-%3E%20Readiness%20tab%20-%3E%20Export%0A%20%20%20Format%3A%20CSV%0A%0ANote%20on%20license%20data%3A%20The%20report%20requires%20a%20hasLicense%20flag%20to%20split%20licensed%20vs.%20unlicensed%20Copilot%20usage.%20The%20PAX%20script%20automatically%20adds%20this%20column%20to%20the%20Entra%20user%20export%20%E2%80%94%20no%20separate%20file%20needed.%20If%20you%20are%20exporting%20manually%20from%20Entra%2C%20you%20will%20also%20need%20the%20M365%20Admin%20Center%20licensed%20users%20file%20%28source%20%234%29%20and%20provide%20it%20as%20a%20separate%20input%20to%20the%20template.%0A%0A%0AREQUIRED%20FIELDS%20%E2%80%94%20DO%20NOT%20REMOVE%0A%0AIMPORTANT%3A%20If%20you%20are%20running%20a%20PAX%20Purview%20agent%20extract%20or%20manually%20exporting%20from%20Purview%2C%20do%20not%20prune%20or%20remove%20columns%20from%20the%20output%20files.%20The%20report%20will%20silently%20break%20or%20produce%20blank%20visuals%20if%20any%20of%20the%20following%20fields%20are%20missing.%0A%0APurview%20Audit%20Log%20%28CopilotInteraction%20%2F%20ConnectedAIAppInteraction%20%2F%20AIAppInteraction%29%3A%0ACreationDate%2C%20UserId%2C%20Operations%2C%20AppHost%2C%20ThreadId%2C%20AgentId%2C%20AgentName%2C%20AISystemPlugin_Id%2C%20AISystemPlugin_Name%2C%20Context_Type%2C%20Message_isPrompt%2C%20ModelTransparencyDetails_ModelName%2C%20Workload%2C%20OrganizationId%2C%20AppIdentity_DisplayName.%0A%0AMicrosoft%20Entra%20ID%20%E2%80%93%20User%20Export%3A%0AUserPrincipalName%2C%20Department%2C%20JobTitle%2C%20displayName%2C%20hasLicense%20%28added%20automatically%20by%20PAX%3B%20or%20use%20the%20M365%20Admin%20Center%20licensed%20users%20file%20if%20exporting%20manually%29%2C%20Manager%2C%20Office%2C%20City%2C%20Country.%0A%0AM365%20Admin%20Center%20%E2%80%93%20Licensed%20Users%20%28manual%20export%20path%20only%29%3A%0AUserPrincipalName%2C%20Has%20Copilot%20License%20Assigned.%0A%0AAgent%20365%20Inventory%3A%0AName%2C%20Host%20Products%2C%20Created%20Date%2C%20Developer%20User%20ID%2C%20Description%2C%20Status%2C%20Version.%0A%0A%0AINSIGHTS%20YOU%20WILL%20GAIN%0A%0A-%20Active%20Copilot%20users%20and%20interaction%20volume%20by%20week%2Fmonth%0A-%20Surface%20breakdown%3A%20which%20apps%20%28Teams%2C%20Word%2C%20Outlook%2C%20BizChat%2C%20etc.%29%20users%20are%20engaging%20with%0A-%20Agent%20adoption%3A%20which%20agents%20are%20used%2C%20by%20how%20many%20users%2C%20on%20which%20surfaces%0A-%20AI%20model%20distribution%20across%20interactions%0A-%20Licensed%20vs.%20unlicensed%20usage%20patterns%0A-%20Session%20depth%20and%20prompt%20volume%20per%20user%20cohort%0A-%20Third-party%20and%20custom%20AI%20app%20usage%20alongside%20M365%20Copilot%0A%0A%0AROLES%20%26%20PERMISSIONS%20REQUIRED%0A%0AExport%20Purview%20audit%20logs%3A%20Audit%20Reader%20or%20Compliance%20Administrator%0AExport%20Entra%20user%20data%20%28includes%20hasLicense%20via%20PAX%29%3A%20User%20Administrator%20or%20Global%20Reader%0AExport%20Agent%20365%20inventory%3A%20AI%20Admin%20or%20Global%20Reader%0AExport%20M365%20Admin%20Center%20licensed%20users%20%28manual%20path%20only%29%3A%20Global%20Administrator%20or%20Reports%20Reader%0ARun%20PAX%20PowerShell%20script%20%28automated%20export%29%3A%20Audit%20Reader%20%2B%20Microsoft%20Graph%20API%20permissions%20%28AuditLog.Read.All%2C%20User.Read.All%2C%20Organization.Read.All%29%0A%0A%0ASOFTWARE%20REQUIREMENTS%0A%0A-%20Power%20BI%20Desktop%20%28free%20download%20from%20Microsoft%29%20%E2%80%94%20required%20to%20open%20the%20.pbit%20template%0A-%20PowerShell%205.1%2B%20%E2%80%94%20required%20only%20if%20using%20the%20PAX%20automated%20export%20script%0A-%20Microsoft%20Graph%20PowerShell%20module%20%E2%80%94%20required%20only%20for%20PAX%20script%20%28Install-Module%20Microsoft.Graph.Beta.Security%29%0A-%20Access%20to%3A%20security.microsoft.com%2C%20admin.microsoft.com%2C%20entra.microsoft.com%0A%0A%0ANote%20on%20Usernames%20in%20Reports%3A%0AIf%20user%20names%20appear%20concealed%20in%20M365%20Admin%20Center%20exports%2C%20go%20to%20Settings%20-%3E%20Org%20Settings%20-%3E%20Services%20-%3E%20Reports%20and%20uncheck%20%22Display%20concealed%20user%2C%20group%2C%20and%20site%20names%20in%20all%20reports%22%20before%20exporting.)**

---

Found this useful? ⭐ Star this repo to help others discover it!

That's it! 🚀
