# SharePoint — Folder deployment

Same setup as [`../File/`](../File/) but the script writes a fresh **timestamped** CSV per run; the PBIT reads **all** matching files in the SharePoint folder and unions them. Use when you want full audit history accumulating in SharePoint.

## What's in this folder

| Item | Purpose |
|---|---|
| `AI-in-One Dashboard - SP Folder.pbit` | Power BI template. Reads every CSV in the configured SharePoint folder via `SharePoint.Files()` + `Table.Combine`. Same pre-parsed 15-column format as `../File/`. |
| `scripts/` | Same scripts as `../File/scripts/` — flat folder with both Interactive and AppReg variants. The `GetCopilotInteractions-SP-AppReg.ps1` writes timestamped filenames so multiple files accumulate. |

## How it works

Identical to `../File/` except for the CSV pattern + PBI source:

| | `../File/` | This path |
|---|---|---|
| CSV filename | Overwritten each run | Fresh timestamp per run |
| PBI source | One static SharePoint URL | A SharePoint folder URL (folder iteration) |
| History ceiling | Last 30 days (script's pull window) | Up to 180 days (Graph API cap), accumulating in SharePoint |

## Quick start

Follow the same Phase 1 / Phase 2 steps as [`../File/README.md`](../File/README.md). The only change is in Phase 3: instead of pointing at an individual CSV URL, point the **Copilot Interactions File** parameter at the **SharePoint folder URL** (e.g. `https://contoso.sharepoint.com/sites/CopilotAnalytics/Shared%20Documents/AuditLogs`).

## Pitfalls — read before deploying

### 1. Privacy Firewall blocks dynamic SharePoint folder URLs

**Error**: `Formula.Firewall: Query references other queries…` or `Query 'Chat + Agent Interactions...' references other queries or steps...`

**Fix**:
- **Desktop**: File → Options → Current File → Privacy → tick **"Always ignore Privacy Level settings"**
- **Service**: dataset Settings → Data source credentials → set **Privacy: None** for *every* SharePoint URL listed

### 2. Microsoft Graph caps audit history at 180 days

You can't backfill events older than 180 days from the moment of the request. Run the script weekly minimum so the SharePoint folder accumulates beyond 180 days over time. **Never delete old CSVs** — they're your only history beyond the rolling Graph window. For multi-year history, use [`../../3. Fabric/`](../../3.%20Fabric/).

### 3. Don't overlap script date windows

A daily run with `-startDate (today - 7) -endDate today` captures every event 7 times. Use one non-overlapping window:
- Daily: `-startDate (today - 1) -endDate today`
- Weekly: `-startDate (today - 7) -endDate today` (only if scheduled exactly every 7 days)

### 4. Service refresh credentials are per-URL

After publishing → dataset Settings → Data source credentials → sign in to **every** SharePoint URL listed (typically 3 — interactions folder, licensed users, org data). Refresh fails if even one is missing credentials.

## Common errors

| Symptom | Fix |
|---|---|
| `Access to the resource is forbidden` | Service → dataset Settings → Data source credentials → re-sign in (check **all** SharePoint URLs) |
| Refresh succeeds but interactions table is empty | Verify `Table.TransformColumnTypes` for `CreationDate` includes `, "en-US"` (current build does) |
| Inflated counts, users with 5-7× expected activity | See Pitfall #3 — your script date windows are overlapping |
| "Where's my 2025 history?" | See Pitfall #2 — Graph 180-day cap. Don't delete old CSVs. For >180 days, use Fabric. |
| Refresh times out (2 h) or hits 1 GB cap | Volume too large — switch to [`../../3. Fabric/`](../../3.%20Fabric/) |

## When this isn't right

| You want… | Switch to |
|---|---|
| Simpler setup, rolling 30 days is enough | [`../File/`](../File/) |
| Multi-year history, large tenants | [`../../3. Fabric/`](../../3.%20Fabric/) |
| One-off CSV with no scheduling | [`../../1. Manual/`](../../1.%20Manual/) |
