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

## Common pitfalls — read before you deploy

Five fragility points to know about up front. Each typically costs around 30 minutes of debugging if you hit it blind, so it's worth reading them before you publish.

### 1. Privacy Firewall blocks dynamic SharePoint URLs

**Error you'll see**:
```
Query 'Chat + Agent Interactions (Audit Logs)' (step 'Final Cleanup')
references other queries or steps, so it may not directly access a data
source. Please rebuild this data combination.
```
or in Service refresh:
```
Formula.Firewall: Query references other queries or steps...
```

**Why**: Power BI can't statically prove that a SharePoint URL coming from a parameter is safe to combine with the other CSV sources, so it quarantines the query chain.

**Fix**:
- **Desktop**: File → Options → Current File → Privacy → tick **"Always ignore Privacy Level settings and potentially improve performance"**
- **Service**: dataset Settings → Data source credentials → set **Privacy: None** for every SharePoint URL listed (typically 3 — interactions folder, licensed users CSV, org data CSV; **all** need the same setting)

### 2. Don't manually clean files out of the folder

**Error you'll see**: "No file found under this repo" / empty interactions table / blank visuals after a manual cleanup

**Why**: The M-query's dedup step behaves unpredictably when the folder has 0 or 1 files versus many. Schema inference can collapse on a single row, and the "Final Cleanup" step assumes a multi-file `Table.Combine`.

**Fix**: Let CSVs accumulate naturally — old files don't hurt anything. If you really must reset the folder, drop at least 2-3 fresh CSVs before the next refresh.

### 3. Microsoft Graph caps audit history at 180 days

**Error you'll see**: "Why can't I see 2025 data?" / "Data before February is missing"

**Why**: `POST /security/auditLog/queries` rejects any date range that looks back further than 180 days from the moment of the request. There's no backfill API — events older than 180 days are unreachable via Graph.

**Fix**:
- Set customer expectations up front: dashboard history starts from the date you began running the export script
- Run the script weekly (minimum) so the SharePoint folder accumulates beyond 180 days over time
- **Never delete old CSVs** — they're your only history record beyond the rolling 180-day Graph window
- For 2-year+ history needs, switch to the [`Fabric/`](../Fabric/) deployment path with managed Lakehouse retention

### 4. Don't overlap your script's date windows

**Error you'll see**: Inflated session counts, users showing 5-7× their real activity, suspiciously high `Resource_Count` totals

**Why**: A daily script run with `-startDate (today - 7) -endDate today` captures every event 7 times. The model has a `Message_Id`-based dedup but it's not bulletproof if `Message_Id` is null in some records.

**Fix**: pick **one** non-overlapping window:
- **Daily run**: `-startDate (today - 1) -endDate today`
- **Weekly run**: `-startDate (today - 7) -endDate today` (only if scheduled exactly every 7 days)

### 5. Service refresh credentials live per URL, not per publisher

**Error you'll see**: Desktop refresh works fine, but Service refresh fails with `Access denied` or `Unauthorized`

**Why**: Power BI Service stores credentials per data source URL, not against the identity of whoever published. The publisher's local OAuth token doesn't carry over to the Service.

**Fix**: After publishing → dataset Settings → Data source credentials → sign in to **every** SharePoint URL listed (typically 3 — interactions folder, licensed users CSV, org data CSV). Use a service account or admin with read access to all of them. Refresh fails if even one URL is missing credentials.

---

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

> Most of these have detailed avoidance guidance in [Common pitfalls](#common-pitfalls--read-before-you-deploy) above. The table below is the quick lookup.

| Symptom | Likely cause | Fix |
|---|---|---|
| Refresh fails with `Access to the resource is forbidden` | Dataset's stored credentials lack SharePoint access | Service → dataset Settings → Data source credentials → re-sign in (and check **all** SharePoint URLs, not just the interactions one) |
| Refresh succeeds but interactions table is empty | Locale-sensitive type conversion under en-GB silently dropped every row | This template's 28 04+ build already includes the en-US culture fix; if you've customised the M, verify `Table.TransformColumnTypes` for `CreationDate` includes `, "en-US"` as the culture argument |
| `Query '...' (step 'Final Cleanup') references other queries... rebuild this data combination` | Privacy Firewall blocks parameter-driven SharePoint URLs | See Pitfall #1 above. Desktop: tick "Always ignore Privacy Level settings". Service: set Privacy=None for every SP URL |
| `Formula.Firewall: Query references other queries…` | Same root cause as the row above (different message format) | Same fix as above |
| `No file found` / interactions table empty after a manual folder cleanup | M dedup assumes multi-file folder | See Pitfall #2 above. Drop 2-3 fresh CSVs and re-refresh |
| Inflated counts, users with 5-7× expected activity | Date windows in your script runs are overlapping | See Pitfall #4 above. Use non-overlapping windows |
| Desktop refresh works, Service refresh fails with `Access denied` | Per-URL credentials missing in Service | See Pitfall #5 above. Sign in to every SharePoint URL in dataset Settings |
| "Can't see data before February" / "Where's my 2025 history?" | Microsoft Graph 180-day audit log API limit | See Pitfall #3 above. Don't delete old CSVs; for >180 days history use Fabric path |
| Refresh times out (2-hour limit on shared) or hits 1 GB memory cap | Volume too large for in-dataset JSON parsing | Switch to the [`Fabric/`](../Fabric/) deployment path — moves parsing upstream, eliminates the limits |

## When this approach isn't right

If you're hitting the same pitfalls repeatedly, or the data volume keeps tripping the 2 h / 1 GB caps, two simpler alternatives:

| Alternative | Pattern | Best for |
|---|---|---|
| **Single overwrite file** (`AI-in-One Dashboard - csv only.pbit` at repo root) | Script always writes to `current.csv`, overwriting. PBIP reads one static URL — no folder iteration, no Privacy Firewall trips | Customers with simple needs, low volume, who don't need >180 days of history |
| **Fabric Lakehouse** ([`Fabric/`](../Fabric/)) | Script lands data in a Lakehouse Delta table; PBIP queries the table directly. No SharePoint, no folder iteration | Enterprise customers with Fabric capacity, large tenants, multi-year history needs |

## Compared to the other paths

| | csv only | **Sharepoint Refresh** | Fabric |
|---|---|---|---|
| Source | Single local file or URL | SharePoint folder (auto-unions all CSVs) | Fabric Lakehouse Delta table |
| Parsing happens in | Power BI dataset | Power BI dataset | Fabric (upstream) |
| Service refresh | Manual / scheduled | **Scheduled, hands-off** | Scheduled, near-instant |
| Volume ceiling | ~100K events comfortably | ~500K events comfortably (Pro) | Millions |
| Setup effort | Lowest | Low — just a SharePoint folder | One-time Lakehouse + notebook |
| Best for | Ad-hoc, one-shot | Recurring with Pro license | Large tenants, Fabric capacity |
