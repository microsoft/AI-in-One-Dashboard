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

| `MODE` | What it does | How it writes | When to use |
|--------|--------------|---------------|-------------|
| `backfill` | Pulls `BACKFILL_DAYS` of history in one go | Replaces the rows from the first of those days on and keeps older rows. With no table yet, creates it | First load, or loading more history |
| `incremental` | Pulls from the start of the day of the latest `CreationDate` already in the table (high-water mark) | Replaces the rows from that day on | Scheduled daily/weekly runs |

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

One thing to note: because `MODE='incremental'` **keeps older rows and adds new days**, the
Delta table grows over time. A full import stays fast for a long while and only becomes worth optimizing once
the table reaches millions of rows over many months — at which point adding Power BI
Incremental Refresh to the template is a sensible *later* enhancement, not a blocker.

Scheduling `MODE='backfill'` doesn't turn the table into a snapshot of the last `BACKFILL_DAYS`:
each run fetches all of those days again and keeps older rows, so you get the same table as
`incremental` gives you, from much longer runs. Keep the schedule on `MODE='incremental'`.

## Duplicate rows from earlier versions

Earlier versions of this notebook read every file in the staging folder on each run, not just
the current run's windows, and `incremental` appended them all. Each incremental run therefore
added the table's history again, and totals that count rows grew with every run.

This version reads only the current run's windows. In `incremental` mode it replaces the rows
from the start of the high-water mark's day on, the range it has just fetched again, so a rerun
never adds a row twice. A backfill does the same from its first day on.

If your table already has duplicates, run the notebook once with `MODE='backfill'` and a
`BACKFILL_DAYS` that reaches back past the oldest day with duplicates, then go back to
`MODE='incremental'`. A backfill replaces the rows from its first day on and keeps older rows, so
duplicates older than that stay. The audit log keeps 180 days by default and older rows can't be
fetched again, so a backfill can't clear duplicates among them. Windows the staging manifest
already lists as succeeded are read from staging rather than fetched again.

The staging folder (`Files/_audit_staging`) still keeps every run's files. Later runs don't read
them, so after a successful run you can delete the folder to save space; the next run then
fetches all of its windows again.

## If a window still runs long

On a very large tenant you can tune the config cell:

- **Lower `CHUNK_HOURS`** (e.g. 8 → 4 → 2) so each query covers less data and finishes faster.
- **Adjust `MAX_CONCURRENT_QUERIES`** (default 6) — lower it if you see sustained 429s.
- **Raise `MAX_WAIT_MIN_PER_QUERY`** if individual windows are genuinely large but still progressing.

Because the run is resumable, you can safely stop and rerun after changing these.
