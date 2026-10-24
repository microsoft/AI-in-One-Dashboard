# 📊 The Power BI report: Rollup Edition

Part of [AI in One](../README.md). The README has the [short version](../README.md#-the-power-bi-report). This page has the detail. Both editions read the files described in [Get your data](get-your-data.md).

<p style="font-size:small; font-weight:normal;">
This repo contains the <strong>AI-in-One Dashboard (Rollup edition)</strong> Power BI template, available in <strong>two editions</strong>: a flexible <strong>3-in-1 auto-detect</strong> edition (reads local, SharePoint, or OneLake files) and a <strong>SharePoint-only (PBI-SharePoint)</strong> edition built for automatic scheduled refresh in the Power BI Service. Both deliver the same comprehensive insights into Microsoft Copilot and Agent adoption, empowering AI and business leaders to make informed decisions about AI implementation, licensing, and enablement strategies — and both load dramatically faster than previous versions thanks to a new pre-processed file format. <strong>See <a href="#-which-edition-should-i-download">Which edition should I download</a> to pick the right one.</strong>
</p>

**On this page:** [Which edition](#which-edition) · [Why two editions](#why-are-there-two-editions) · [What changed](#-how-this-version-is-different--and-why-it-loads-so-much-faster) · [Open and configure](#-open-and-configure-the-power-bi-template) · [Scheduled refresh](#-set-up-scheduled-refresh-in-power-bi-service) · [Review and customize](#-review-and-customize) · [Version history](#-version-history)

---

<a id="which-edition"></a>

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
- Your files are on OneLake/Fabric **and** you need scheduled refresh → use the dedicated Fabric edition in [`Classic Editions/3. Fabric/`](../Classic%20Editions/3.%20Fabric/), a Fabric-native thin client.

**Want the Fabric edition set up for you?** The [AI in One installer](../installer/README.md) creates the app registration, the workspace, Lakehouse, notebooks, pipeline, model and report, then runs the first load.

---

## ⚡ How this version is different — and why it loads so much faster

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

---

## 🔐 Open and Configure the Power BI Template

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

> ⚠️ **SharePoint URL gotcha** — the URL you paste into these parameters must be the **document path** from the SharePoint details pane, **NOT** the URL in your browser's address bar and **NOT** a "Copy link" share link. See [How to get the correct SharePoint URL](get-your-data.md#sharepoint-url) on the Get your data page for step-by-step instructions.

<a id="mix-locations"></a>

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

---

## 🔄 Set up scheduled refresh in Power BI Service

> ### ⚠️ Scheduled refresh requires the **PBI-SharePoint** edition
> Automatic scheduled refresh in the Power BI Service is supported **only by the PBI-SharePoint edition**, with all three input files stored on SharePoint. The 3-in-1 (auto-detect) edition **cannot be scheduled** in the Service — its runtime-resolved connector is treated as a *dynamic data source*, which disables scheduled refresh for the entire dataset (a Power BI platform rule — see [Why are there two editions](#why-are-there-two-editions)). You can still refresh the 3-in-1 manually in Power BI Desktop. For OneLake/Fabric scheduled refresh, use the Fabric edition in [`Classic Editions/3. Fabric/`](../Classic%20Editions/3.%20Fabric/).

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

> **For OneLake scheduled refresh, use the Fabric edition.** The 3-in-1 (auto-detect) edition reads OneLake files in Power BI Desktop, but it **can't be scheduled** in the Service (dynamic data source — see [Why are there two editions](#why-are-there-two-editions)), and the PBI-SharePoint edition only accepts SharePoint URLs. For Service-side **scheduled refresh against OneLake**, use the Fabric thin-client edition in [`Classic Editions/3. Fabric/`](../Classic%20Editions/3.%20Fabric/). The steps below describe that Fabric pattern.

1. Publish the `.pbix` to a **Fabric-enabled workspace** (PPU or Fabric capacity required)
2. OneLake credentials are handled automatically via SSO if the workspace is in the same tenant — usually no manual credential setup needed
3. Configure scheduled refresh the same way as above
4. **Recommended pattern:** schedule PAX to run via an Azure Container Apps Job → PAX writes the rollup files directly to OneLake → the Power BI dataset's scheduled refresh fires shortly after.

> 🏭 **Fabric customers — use the `fabric_resources/` folder in the PAX repo.** It has the Dockerfile, detailed deployment instructions, prereq checklists, and configuration templates for setting up the Azure Container Apps Job end-to-end. Do not try to piece this together from scratch — the resources folder is the canonical guide.
>
> 👉 **https://github.com/microsoft/PAX** → `fabric_resources/`

### For local files

Power BI Service can't reach files on your laptop without an **On-premises Data Gateway**. If you're going to schedule refresh, use SharePoint or OneLake instead — both work without a Gateway and are simpler to maintain.

---

## 📊 Review and Customize

Once the dashboard loads:

1. **Walk through the report pages** — verify data loaded correctly and that filters/slicers behave as expected
2. **Customize for your organization** — adjust colors/branding, organizational hierarchies, default date ranges, and bookmarks
3. **Publish and share** — publish to Power BI Service, optionally configure Row-Level Security, then share via workspace access or apps
4. **Set up subscriptions** — email subscriptions for executives who want regular updates without opening the dashboard

### Best practices

- 🔄 **Refresh schedule** — match it to how often PAX runs (typically weekly or daily)
- 🔒 **Row-Level Security** — restrict sensitive data by department or role if needed
- 📊 **Usage tracking** — monitor dashboard usage in Power BI Service to understand which views resonate

---

## 🔄 Version History

This release ships **two editions**, both built for the same PAX rollup file format:

| Edition | File | Input locations | Scheduled refresh in the Service |
|---|---|---|---|
| Rollup Edition (3-in-1, auto-detect) | `AIO Dashboard - Rollup Edition - 2026-06-25.pbit` | Local / SharePoint / OneLake | Desktop / manual only |
| Rollup Edition — PBI-SharePoint | `AIO Dashboard - Rollup Edition - PBI-SharePoint - 2026-06-25.pbit` | SharePoint only | ✅ Supported |

As long as you're running a current version of PAX (v1.11.1+) with `-Rollup` (or `-RollupPlusRaw`), the output is compatible with both editions.
