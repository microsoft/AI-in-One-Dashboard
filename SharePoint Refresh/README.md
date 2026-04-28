# SharePoint Refresh deployment

Use this template when your audit-log CSVs land in a **SharePoint folder** (typically as scheduled drops from `scripts/get-copilot-interactions.ps1` or your own export pipeline) and you want Power BI Service to refresh them automatically — no Fabric capacity required.

## What's in this folder

| File | Purpose |
|---|---|
| `AI-in-One Dashboard - Sharepoint Refresh.pbit` | Power BI template that iterates a SharePoint folder, unions every CSV, and refreshes on schedule |

## When to use this path

| Pick this path if… | Pick another path instead if… |
|---|---|
| You have a SharePoint folder of audit CSVs (one or many) and want them auto-unioned | You only have a single static CSV — use `AI-in-One Dashboard - csv only.pbit` instead |
| You want Service-side scheduled refresh without managing Fabric / Premium | Audit volume is so large that in-dataset JSON parsing hits the 1 GB or 2-hour cap — see [`Fabric/`](../Fabric/) for the upstream-parsing path |
| Power BI Pro workspace | You need sub-second refresh / Direct Lake — use [`Fabric/`](../Fabric/) instead |

## How it works

The template's M-query loops through every CSV in the configured SharePoint folder, unions them all, then runs the same JSON parsing / fan-out as the standalone CSV variant. If you keep dropping new CSVs into the folder, the dataset just picks them up on the next refresh — no template change needed.

```
Export pipeline (scripts/automation/* or custom)
        ↓
SharePoint folder of audit CSVs
        ↓
PBIT (Sharepoint.Files() iteration → Csv.Document → JSON parse → expand)
        ↓
Power BI dataset → Service refresh on schedule
```

## Quick start

### 1. Prepare the SharePoint folder

- Pick (or create) a SharePoint document library / folder where the audit CSVs will land
- Ensure the account that will refresh the dataset in Power BI Service has **read access** to that folder
- Note the full URL of the folder, e.g.
  `https://contoso.sharepoint.com/sites/CopilotAnalytics/Shared%20Documents/AuditLogs`

### 2. Open the PBIT

- Open `AI-in-One Dashboard - Sharepoint Refresh.pbit` in Power BI Desktop
- Supply the parameters when prompted:

| Parameter | Value |
|---|---|
| **Copilot Interactions File** | The SharePoint folder URL from step 1 |
| **Copilot Licensed Users** | Path or SharePoint URL to your licensed-users CSV |
| **Org Data File** | Path or SharePoint URL to your org-data CSV |
| Optional ones | Leave blank |

- Click **Load**. First refresh parses every CSV in the folder; subsequent refreshes pick up new files automatically

### 3. Publish + schedule in Service

- Publish to a Power BI workspace
- In the Service: dataset Settings → **Data source credentials** → sign in to SharePoint with an account that has folder access
- **Scheduled refresh** → enable, set the cadence to match your export pipeline (typically daily after the export drops)

## Folder schema requirement

Each CSV in the folder must have these columns at minimum:

```
RecordId, CreationDate, RecordType, Operation, AuditData, AssociatedAdminUnits, AssociatedAdminUnitsNames
```

This is what `scripts/get-copilot-interactions.ps1` produces. If your export uses different column names, the M-query has a defensive renamer that handles common variants (`createdDateTime` → `CreationDate`, `auditData` → `AuditData`, etc.).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Refresh fails with `Access to the resource is forbidden` | Dataset's stored credentials lack SharePoint access | Service → dataset Settings → Data source credentials → re-sign in with an account that has folder read access |
| Refresh succeeds but interactions table is empty | The model's CreationDate filter dropped every row (locale-sensitive type conversion under en-GB) | This template's 28 04 build already includes the en-US culture fix; if you've customised the M-query, verify `Table.TransformColumnTypes` for `CreationDate` includes `, "en-US"` as the culture argument |
| Refresh times out (2-hour limit on shared) or hits 1 GB memory cap | Volume too large for in-dataset JSON parsing | Switch to the [`Fabric/`](../Fabric/) deployment path — moves parsing upstream, eliminates the limits |
| `Formula.Firewall: Query references other queries…` | Privacy levels mismatched between SharePoint sources | Service → dataset Settings → Data source credentials → set **Privacy: None** for SharePoint, OR enable Fast Combine in Desktop (File → Options → Current File → Privacy) |

## Compared to the other paths

| | csv only | **Sharepoint Refresh** | Fabric |
|---|---|---|---|
| Source | Single local file or URL | SharePoint folder (auto-unions all CSVs) | Fabric Lakehouse Delta table |
| Parsing happens in | Power BI dataset | Power BI dataset | Fabric (upstream) |
| Service refresh | Manual / scheduled | **Scheduled, hands-off** | Scheduled, near-instant |
| Volume ceiling | ~100K events comfortably | ~500K events comfortably (Pro) | Millions |
| Setup effort | Lowest | Low — just a SharePoint folder | One-time Lakehouse + notebook |
| Best for | Ad-hoc, one-shot | Recurring with Pro license | Large tenants, Fabric capacity |
