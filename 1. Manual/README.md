# Manual deployment

The simplest path — no scripts, no automation. An admin manually exports a Copilot interactions CSV (from the Purview UI or a one-shot script run), opens the PBIT in Power BI Desktop, points it at the file, refreshes.

Best for ad-hoc analysis, one-off exports, or single-user dashboards.

## What's in this folder

| File | Purpose |
|---|---|
| `AI-in-One Dashboard.pbit` | Power BI template that reads a single local CSV file. No SharePoint or Fabric integration. |

## When to use this path

| Pick this if… | Don't pick this if… |
|---|---|
| You're testing the dashboard or running an ad-hoc audit | You need scheduled refresh in PBI Service — use SharePoint paths |
| You have < ~100K events to analyse | You're at enterprise volume (millions of events) — use Fabric |
| Single user, single laptop | Multiple people need to refresh — use SharePoint or Fabric |

## Quick start

### 1. Get the audit log CSV

Two options:

**(A) Run the scripts** — kept in [`../SharePoint/Single File/scripts/interactive/`](../SharePoint/Single%20File/scripts/interactive/) since they're the same scripts. Run `create-query.ps1` then `get-copilot-interactions.ps1` — produces a CSV in your current directory.

**(B) Manual export from Purview UI**:
- Go to https://purview.microsoft.com → Solutions → **Audit**
- New search → activity types: `Interacted with Copilot` (and optionally `Interacted with a Connected AI App` + `Interacted with an AI App` for full ecosystem coverage) → date range → submit
- Wait for completion → **Export results** → CSV
- This produces a CSV in the **raw Graph format** with the `auditData` JSON column

### 2. Open the PBIT

- Open `AI-in-One Dashboard.pbit` in Power BI Desktop
- When prompted, fill in the parameters:

| Parameter | Value |
|---|---|
| Copilot Interactions File | Local file path to the CSV from step 1 (e.g. `C:\Temp\CopilotInteractions.csv`) |
| Copilot Licensed Users | Local file path to a licensed-users CSV (or your M365 Admin Center export) |
| Org Data File | Local file path to an org data CSV (Entra user export) |
| Agent 365 | Optional — leave blank or use a dummy file |

- Click **Load**

### 3. Refresh as needed

Replace the CSV file at the same path and click **Refresh** in Power BI Desktop.

> **Note:** Manual path doesn't support scheduled refresh in Power BI Service unless you set up an On-premises Data Gateway. If you need scheduled refresh, use **SharePoint / Single File** instead.

## Limitations

- Single-user only (the file lives on your machine)
- No automation (you regenerate the CSV manually each time)
- 180-day Graph API cap on history (same as all paths)

## Compared to other paths

| | **Manual** | SharePoint / Single File | SharePoint / Folder | Fabric |
|---|---|---|---|---|
| Source | Local file | SharePoint URL | SharePoint folder iteration | Fabric Lakehouse table |
| Service refresh | Needs Gateway | ✅ Native | ✅ Native | ✅ Native, near-instant |
| Setup effort | Lowest | Low | Medium | Medium-high |
| Volume ceiling | ~100K events | ~500K (Pro), 30 days | ~500K (Pro), 180 days | Millions, multi-year |
| Best for | Ad-hoc | Default for most customers | Advanced (long history) | Enterprise / Frontier Firm |
