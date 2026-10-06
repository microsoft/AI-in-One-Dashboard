# Copilot Audit Log Direct Ingester — resilience notes

This note explains the timeout issue some tenants hit with the audit-log ingester,
what changed to fix it, and how the `MODE` setting relates to Power BI incremental
refresh. It applies to `Copilot_Audit_Log_Direct_Ingester.ipynb` in this folder.

## The problem (why it timed out)

The notebook asks Microsoft Purview for audit-log data through an **asynchronous**
query: you submit a query, then poll until it reports `succeeded`, then download the
records. On large or busy tenants, a single **7-day** query can take longer to reach
`succeeded` than the notebook was willing to wait, so the run timed out before any
data landed.

- The original notebook polled for a fixed **30 minutes** (30s × 60 polls).
- Raising the poll count to ~45 minutes still wasn't enough on some tenants.
- This is a **duration / resilience** limitation — **not** a network, firewall, or
  Power BI problem. The other Fabric notebooks (licensed users, org data) are
  synchronous and unaffected.

## What changed (the fixes, in plain language)

- **Split the big query into small time windows.** Instead of one 7-day query, the
  lookback is broken into short windows (`CHUNK_HOURS`, default 8h). Each small query
  finishes quickly, so no single request stalls the whole run. *This is the core fix.*
- **Made it resumable.** Each window's results are staged to `Files/_audit_staging`
  with a manifest. If the Fabric session drops or you rerun the notebook, it **skips
  the windows that already succeeded** and only finishes what's left — no starting
  from zero.
- **Runs windows in parallel (but bounded).** A small pool (`MAX_CONCURRENT_QUERIES`,
  default 6) processes several windows at once for speed, while staying under the
  audit API's concurrency/throttling limits.
- **Automatic retries on transient errors.** Throttling (HTTP 429) and gateway/server
  errors (500/502/503/504) are retried with exponential backoff and honour the
  service's `Retry-After` hint, instead of failing the run.
- **Token auto-refresh.** The app-only access token is refreshed automatically, so
  multi-hour backfills don't die when the ~1-hour token expires.
- **Lower memory pressure.** Records stream to files as JSONL and are read back with
  distributed Spark, avoiding driver out-of-memory on large tenants.
- **Generous per-window ceiling.** Each window can wait up to `MAX_WAIT_MIN_PER_QUERY`
  (default 240 min) with progress logging — and because it's resumable, hitting a
  ceiling never wastes the work already done.

**The output table name and schema are unchanged** (`dbo.Copilot_Interactions_Parsed`).
The AI-in-One Dashboard and AI Business Value PBITs consume it **with no changes**.

## `MODE`, and how it relates to Power BI incremental refresh

The notebook has two run modes:

| `MODE` | What it does | `WRITE_MODE` | When to use |
|--------|--------------|--------------|-------------|
| `backfill` | Pulls `BACKFILL_DAYS` of history in one go | `overwrite` | First load / a clean re-seed |
| `incremental` | Pulls only rows newer than the latest `CreationDate` already in the table (high-water mark) | `append` | Scheduled daily/weekly runs |

**Recommended sequence:** run once with `MODE='backfill'` to seed history, then switch
to `MODE='incremental'` on the schedule.

### Do you need Power BI Incremental Refresh in the template? No.

These are **two different things** and are independent:

- **Notebook `MODE='incremental'`** controls *ingestion into the Lakehouse Delta table*.
- **Power BI Incremental Refresh** is a *semantic-model* feature (RangeStart/RangeEnd +
  a refresh policy) that partitions the dataset for faster refreshes.

The PBIT simply reads `Copilot_Interactions_Parsed` over the SQL endpoint — it doesn't
care how the table was populated. **Power BI Incremental Refresh is not required** for
this notebook to work. Without it, the dashboard just does a normal **full import** of
the table on each refresh, which is fine at typical volumes.

One thing to note: because `MODE='incremental'` **appends**, the Delta table grows over
time. A full import stays fast for a long while and only becomes worth optimizing once
the table reaches millions of rows over many months — at which point adding Power BI
Incremental Refresh to the template is a sensible *later* enhancement, not a blocker.

If you'd prefer the ingester to behave exactly like the previous weekly snapshot
(overwrite each run, no accumulation), just leave `MODE='backfill'`.

## If a window still runs long

On a very large tenant you can tune the config cell:

- **Lower `CHUNK_HOURS`** (e.g. 8 → 4 → 2) so each query covers less data and finishes faster.
- **Adjust `MAX_CONCURRENT_QUERIES`** (default 6) — lower it if you see sustained 429s.
- **Raise `MAX_WAIT_MIN_PER_QUERY`** if individual windows are genuinely large but still progressing.

Because the run is resumable, you can safely stop and rerun after changing these.
