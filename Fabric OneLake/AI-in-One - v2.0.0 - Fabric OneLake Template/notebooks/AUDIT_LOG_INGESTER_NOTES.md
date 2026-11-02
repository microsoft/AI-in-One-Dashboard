# Audit collection and recovery

The v2 collector stores complete audit payloads rather than prematurely expanding prompt/resource rows. Final classification and deduplication happen in Report Data Preparation.

## Reliability behavior

- Uses the Microsoft Graph v1.0 audit-query API and bounded concurrent time windows.
- Retries GET connection failures and retryable HTTP responses with backoff; honors Retry-After.
- Retries an explicit throttled POST, but does not automatically repeat an uncertain query-creation POST after a network failure.
- Refreshes app-only tokens without writing tokens or secrets to output.
- Saves the run range, query IDs, completed page files and SHA-256 checksums under `Files/aio_v2_staging/<tenant>/<table>/<run-id>`.
- Each worker owns its own window checkpoint. Completed files are verified on resume.
- Reads only the files in that run's completed manifests, never all historical staging files.
- Blocks publication if any window fails or Graph reports `isRecordCountLimitExceeded=true`, even if status is succeeded.
- Merges raw history by tenant and record ID. Overlapping windows and repeated runs cannot append duplicate copies of the same record.
- Rejects malformed payloads, missing record IDs, invalid timestamps, cross-tenant records and conflicting payloads for one record within a run.
- Writes the audit completion table only after all windows and the raw-table merge succeed.

## Resume an interrupted run

1. Copy the run UUID from the notebook's non-sensitive status message.
2. Set `RUN_ID` to that UUID. Keep the same source tenant, Lakehouse, output table, mode and window size.
3. Rerun. Existing query IDs are polled; completed verified windows are reused.

An uncertain query-creation POST leaves `creating=true` without a `query_id`. The notebook fails explicitly rather than creating another query blindly. An administrator should find the exact `displayName` in Graph and record its confirmed query ID in that window's checkpoint. If the request never created a query, confirm that before resetting only that window's creation checkpoint.

For a failed/cancelled/truncated query, investigate its cause. For a result limit, reduce `CHUNK_HOURS`, use the same explicit UTC range and start a new RUN_ID. A truncated result is never accepted as complete.

Incremental overlap covers only its configured recent interval. To recover later-arriving or corrected older records, run an explicit older range. Do not assume any fixed seven-day audit-retention limit.

## Operational boundaries

Allow sufficient pipeline time for the total number of windows; each query can wait up to the configured per-query deadline. For large historical loads, use smaller overall ranges. Do not overlap runs or semantic-model refresh with publication.

Staging contains source audit data and must have the same access protection and retention governance as the raw table. Retain failed-run checkpoints until recovery is complete. Remove only explicitly identified completed run folders after the published result has been validated; there is no automatic broad cleanup.

The collector uses the currently configured source app identity. Actual tenant permissions, availability, throttling, retention and report privacy must be checked in that deployment. Synthetic transformation tests cannot establish production Graph access.
