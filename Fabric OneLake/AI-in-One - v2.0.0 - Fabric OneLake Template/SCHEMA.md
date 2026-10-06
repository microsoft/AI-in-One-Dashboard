# Fabric v2.0.0 source and identity contract

All tables below are managed Delta tables in the attached Lakehouse's default location. The report reads final tables in SQL schema `dbo`. The v2 package refuses write targets outside `aio_v2_` or explicitly chosen `aio_test_` names.

## Collection tables

| Table | Key and required content |
|---|---|
| `aio_v2_audit_raw` | `(TenantId, RecordId)`; `CreationDate` UTC timestamp and `AuditData` JSON text |
| `aio_v2_audit_status` | One completed run: `RunId`, `TenantId`, `CompletedAt`, `StartUtc`, `EndUtc`, `RecordCount` |
| `aio_v2_org_raw` | One row per normalized `PersonId`; required `DisplayName`, `Organization`, `ManagerUPN`, `TenantId`, `_RunId`, `_CollectedAt` |
| `aio_v2_licenses_raw` | One row per normalized `PersonId`; `Has_license`, `ReportRefreshDate`, `TenantId`, `_RunId`, `_CollectedAt` |

Directory optional string columns are `GivenName`, `Surname`, `Email`, `Company`, `Division`, `JobTitle`, `Country`, `City`, `Office` and `ManagerName`. Null values are allowed for missing attributes and for a root's ManagerUPN. Required identity/metadata columns may not be omitted. `TenantId` is the source tenant GUID; `_RunId` identifies the collection; `_CollectedAt` is its actual UTC collection timestamp.

License flags are exactly `TRUE`, `FALSE` or `Unknown`. An unavailable product value or missing join stays Unknown. A nonblank product list without one of the configured exact Copilot labels means FALSE. Conflicting duplicate report rows fail collection. These are **current snapshot** assignments applied to reported activity, not point-in-time historical license evidence.

## Prepared tables

### `aio_v2_users`

Includes the directory attributes, `PersonId_Normalized`, integer `UserKey`, nullable integer `Manager_UserKey`, `ManagerUPN`, `Manager`, `Has_license`, `TotalEmployees` and `_SnapshotId`.

The unchanged v2 Power Query normalizer creates surname-first labels, License Status, management paths and hierarchy status. The model retains department-local display hierarchies, Reporting Viewer Identity and dynamic RLS. Missing parents and cycles remain invalid chains; preparation does not silently reconnect them.

### `aio_v2_interactions`

Uses the AIO profile's columns from `Purview_CopilotInteraction_Processor_v4.2.3.py`:

- Integer `UserKey`, `Message_Id`, `ThreadId`.
- Date `InteractionDate`, `WeekStart`, `MonthStart`, `ActivityDate`; UTC timestamp `CreationDate`.
- Logical `Is_Sensitive`.
- Source attributes for agent, application, environment, behavior, model, resource, license, user-month and raw reconciliation identifiers.
- `_SnapshotId` for publication validation.

Spaces are replaced with underscores in Delta column names: `Has_license` and `License_Status`. The template restores the existing model names `Has license` and `License Status`. Other classifications, catalog resolution and current-directory licensing logic remain in the v2 model.

The fact-to-agent relationship uses the **resolved `Agent_TitleID`**, not the raw `Source Agent Title ID`. This keeps catalog-matched and uncatalogued agents on the same key contract, so activity remains visible when the optional inventory is absent. Existing cross-filter and security-filter directions are retained.

**Grain:** user/date/agent/app/environment/license/context/behavior/model/sensitivity/autonomy/plugin/thread, message ID and resource slice. Repeated resource slices and repeated source records do not inflate the prepared facts. Multiple distinct resource slices can represent one prompt; use distinct message IDs for prompts, not raw row counts. Sessions use the user/thread combination.

Security Copilot, non-human identities and records without prompt messages are excluded consistently with the existing AIO processor. A qualifying prompt without a stable message/thread ID or valid timestamp blocks preparation instead of being silently collapsed or assigned an invented session.

### `aio_v2_publication`

Exactly one row: `SnapshotId`, `State`, `TenantId`, `Users`, `Facts`, `Prompts`, `Sessions`, `CompletedAt`.

`State=Publishing` blocks refresh. `State=Ready` identifies the completed generation. Both prepared tables carry that SnapshotId. The template verifies state, generation IDs and row counts through the SQL endpoint before returning source data.

This marker is a **failure gate**, not a transaction across Delta tables. Do not overlap preparation with Power BI refresh or another package run. SQL endpoint synchronization can lag independently for each table.

## Stable keys and compatibility

User identities use trimmed lowercase UPNs. Message/thread identifiers retain source identity semantics. Each key is a deterministic positive signed 64-bit SHA-256-derived value with a separate user/message/thread domain. The same identity receives the same key across repeated preparation runs, directory joins and manager lookups. Preparation checks collisions against raw identities and fails rather than joining unrelated records.

Keys need not equal the sequential keys in a prior CSV export. Do not combine fact and directory tables from different preparation runs or from other tools, such as PAX CSV exports.

The generated classifier retains the canonical AIO classification logic. Notebook-local LRU cache decorators are omitted because their wrappers cannot be deserialized by Spark workers. When duplicate logical rows carry differing non-grain attributes, preparation chooses the latest creation timestamp with deterministic attribute tie-breaking; the file processor chooses the last encountered input record. This does not change the deduplication grain or distinct prompt/session identities.

Activity from people absent from the directory can remain in the all-data totals; those identities do not gain hierarchy access. Set `REQUIRE_ALL_ACTIVITY_USERS_IN_DIRECTORY=true` to reject such a snapshot instead. Preparation logs the unmatched count. A complete authoritative directory is needed for accurate organizational headcount and reporting-team coverage.
