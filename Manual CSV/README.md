# Manual CSV / SharePoint single-file deployment

Use these templates when you have a **single static audit-log CSV** — either on a local drive or as a single file in SharePoint — and you refresh the dataset ad-hoc (or once-off for analysis).

## What's in this folder

| File | When to use |
|---|---|
| `AI-in-One Dashboard - csv only.pbit` | Your CSV lives on a local drive (or anywhere accessible via `File.Contents`). Refreshes locally in Power BI Desktop. For Service refresh you'd need an on-premises data gateway. |
| `AI-in-One Dashboard - sharepoint only.pbit` | Your CSV lives at a single SharePoint URL. Refreshes in both Desktop and Service without a gateway (Service uses your stored SharePoint credentials). |

## When to use this path

| Pick this path if… | Pick another path instead if… |
|---|---|
| You have one CSV (or a manually re-uploaded CSV) and refresh sporadically | You have multiple CSVs landing in a folder → use [`SharePoint Refresh`](../SharePoint%20Refresh/) |
| You're doing ad-hoc analysis or a proof of concept | You need automated, scheduled refresh in Service → use [`SharePoint Refresh`](../SharePoint%20Refresh/) or [`Fabric`](../Fabric/) |
| Audit volume is comfortably under 1 GB once parsed | Audit volume is large and you hit the 1 GB / 2-hour Service limits → use [`Fabric`](../Fabric/) |

## Quick start

### `csv only` variant

1. Generate the audit-log CSV (use [`scripts/get-copilot-interactions.ps1`](../scripts/get-copilot-interactions.ps1) or your own export)
2. Open `AI-in-One Dashboard - csv only.pbit` in Power BI Desktop
3. Supply the parameters when prompted:

   | Parameter | Value |
   |---|---|
   | **Copilot Interactions File** | Local path to the audit CSV, e.g. `C:\Data\CopilotInteractions.csv` |
   | **Copilot Licensed Users** | Local path to the licensed-users CSV |
   | **Org Data File** | Local path to the org-data CSV |
   | Optional ones | Leave blank |

4. Click **Load**. To publish + refresh in Service you'll need an on-premises data gateway pointing at the same paths.

### `sharepoint only` variant

1. Upload your CSV to a SharePoint document library and copy its URL (right-click the file → **Copy link** → grab the document URL)
2. Open `AI-in-One Dashboard - sharepoint only.pbit` in Power BI Desktop
3. Supply the parameters:

   | Parameter | Value |
   |---|---|
   | **Copilot Interactions File** | Full SharePoint URL to the CSV |
   | **Copilot Licensed Users** | SharePoint URL or local path |
   | **Org Data File** | SharePoint URL or local path |

4. Click **Load**. Publish to a Power BI workspace; Service refresh works once you sign in to SharePoint under dataset Settings → Data source credentials.

## Why two separate templates (instead of one dynamic one)

Power BI Service treats `if condition then Web.Contents else File.Contents` as a **dynamic data source**, which the Service refresh engine can't validate at design time. That can break scheduled refresh or require "Skip test connection" workarounds. Splitting into two static-source templates avoids the problem entirely — each has one connector type, fully resolvable up-front.

## Compared to the other paths

| | **Manual CSV / SharePoint File** | SharePoint Refresh | Fabric |
|---|---|---|---|
| Source | Single file (local or single SP URL) | SharePoint folder, auto-unions all CSVs | Lakehouse Delta table |
| Service refresh | Manual (csv) / scheduled with creds (sharepoint) | Scheduled, hands-off | Scheduled, near-instant |
| Volume ceiling | ~100K events comfortably | ~500K events comfortably (Pro) | Millions |
| Setup effort | Lowest | Low | One-time Lakehouse + notebook |
| Best for | Ad-hoc / POC | Recurring with Pro license | Large tenants, Fabric capacity |
