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

Preparation has two explicit input paths. With `PAX_USERS_CSV` and
`PAX_INTERACTIONS_CSV` both blank, the existing collectors and current-snapshot
preparation are unchanged. With both supplied, preparation reads already-processed
PAX **AIO Users and Interactions CSVs**, not raw Entra/Purview records.

In processed-PAX mode, Users contains one row per exported person/license state,
so several rows may share a normalized person. `UserKey` is the exported stable
state key, not a new person hash. `Manager_UserKey` is retained, including a
manager's older state key; missing-manager references are preserved for model
diagnostics rather than silently erased. No extra PAX PersonKey column or new
producer flag is required.

`EffectiveDate` retains the exported `yyyy-MM-dd` observation date or explicit
`Unknown`. Legacy processed files without this column receive `Unknown`, never
an invented dated observation. An explicitly present blank or malformed date
is rejected. The standard Graph snapshots do not acquire history through this
option: history must already be present in the processed PAX inputs.

Duplicate normalized-person/license-state fingerprints and reused UserKeys are
rejected; distinct states for one person are accepted. License flags/status
must agree. PAX's blank `Has license` paired with `License Status=Unknown` is
preserved as unknown evidence, never converted to FALSE. `TotalEmployees`, when supplied, must equal distinct people, not
state rows. The publication marker's `Users` is the number of output **rows**
(including states); report headcount remains distinct people.

The v2 Power Query normalizer creates surname-first labels, License Status, management paths and hierarchy status. The model derives stable PersonKey from Users, keeps one latest descriptive row per person and resolves each Manager_UserKey to the manager's person, including references to an older state. No producer-side PersonKey column is required.

The model retains department-local display hierarchies, Reporting Viewer Identity and dynamic RLS. A blank Manager_UserKey means **top of chain**. An explicitly requested manager absent from Users makes that person a root and flags that person's unresolved manager; valid descendants remain visible within their authorized access. Cycles remain invalid and do not grant broader access. Preparation preserves the source evidence rather than inventing manager links.

### `aio_v2_interactions`

Uses the AIO profile's columns from `Purview_CopilotInteraction_Processor_v4.2.3.py`:

- Integer `UserKey`, `Message_Id`, `ThreadId`.
- Date `InteractionDate`, `WeekStart`, `MonthStart`, `ActivityDate`; UTC timestamp `CreationDate`.
- Logical `Is_Sensitive`.
- Source attributes for agent, application, environment, behavior, model, resource, license, user-month and raw reconciliation identifiers.
- `_SnapshotId` for publication validation.

The snapshot path expands/classifies raw audit input as before. The processed
path validates and copies the supplied AIO facts without re-expanding,
reclassifying, re-keying or collapsing their rows. Minimum required columns are
`UserKey`, `InteractionDate`, `Message_Id`, `ThreadId`, `CreationDate`,
`Has license`, `License Status`, `AgentId`, `AppHost`, `Environment`,
`WeekStart`, `MonthStart`, `ActivityDate` and `Is_Sensitive`. AgentId can be
blank for non-agent activity. Other AIO classification/resource fields are
retained. Message/thread/state keys must be positive signed 64-bit integers.
CreationDate must be a valid UTC timestamp; supplied activity/week/month dates
must be valid. A supplied `Message_isPrompt` must be TRUE.

The adapter uses one shared, ordered schema declaration: state/message/thread
keys are signed 64-bit integers, Manager_UserKey is nullable, Is_Sensitive is
Boolean, activity/week/month fields become Date and CreationDate becomes a
UTC timestamp. EffectiveDate remains text so Unknown is preserved. Other CSV
attributes remain nullable strings. Field order follows the canonicalized
CSV columns; the generated `_SnapshotId` is a nonnullable string.
Blank sensitivity remains an unknown nullable Boolean, not an explicit FALSE.
Fact License Status is validated case-insensitively and emitted using the
matched event state's canonical spelling; it is not taken from the ancillary
snapshot license flag.

Every fact state key must exist in the matching Users file and match the
recorded state for its event date. PAX semantics choose the latest dated state
on/before the event, otherwise the earliest dated state even when a parallel
Unknown row exists, otherwise the undated state. Equal-date validation follows
PAX CSV export order; physical SQL table row order is not a contract. This is attribution to **observed** states, not proof of the exact
assignment time. UTC CreationDate and InteractionDate must describe the same
date. Optional raw normalized identity and the fact's License Status must agree
with the chosen state. The ancillary fact Has license flag and Environment are
retained source provenance: they can describe the collection snapshot rather
than the event's selected state. They are not silently rewritten or used to
override the attributed key/status. These checks reject mismatched file pairs
instead of repairing their keys or reclassifying the facts.

Distinct session publication totals use stable normalized person/thread
identity, not state-key/thread pairs. Crossing a license state does not multiply
a person's session. User, message, thread and manager identifiers in the
published facts/Users retain the supplied PAX values.

Use standard Delta `timestamp` (Spark `TimestampType`) for UTC timestamp fields, including `CreationDate` and publication `CompletedAt`, not `timestamp_ntz`. The SQL analytics endpoint can omit unsupported timestamp columns even when they exist in Delta. Verify the SQL-exposed schema as well as row counts before refreshing.

Spaces are replaced with underscores in Delta column names: `Has_license` and `License_Status`. The template restores the existing model names `Has license` and `License Status`. Other classifications, catalog resolution and current-directory licensing logic remain in the v2 model.

The fact-to-agent relationship uses the **resolved `Agent_TitleID`**, not the raw `Source Agent Title ID`. This keeps catalog-matched and uncatalogued agents on the same key contract, so activity remains visible when the optional inventory is absent. Existing cross-filter and security-filter directions are retained.

**Grain:** user/date/agent/app/environment/license/context/behavior/model/sensitivity/autonomy/plugin/thread, message ID and resource slice. Repeated resource slices and repeated source records do not inflate the prepared facts. Multiple distinct resource slices can represent one prompt; use distinct message IDs for prompts, not raw row counts. Sessions use the user/thread combination.

Security Copilot, non-human identities and records without prompt messages are excluded consistently with the existing AIO processor. A qualifying prompt without a stable message/thread ID or valid timestamp blocks preparation instead of being silently collapsed or assigned an invented session.

### `aio_v2_publication`

Exactly one row: `SnapshotId`, `State`, `TenantId`, `Users`, `Facts`, `Prompts`, `Sessions`, `CompletedAt`.

`State=Publishing` blocks refresh. `State=Ready` identifies the completed generation. Both prepared tables carry that SnapshotId. The template verifies state, generation IDs and row counts through the SQL endpoint before returning source data.

This marker is a **failure gate**, not a transaction across Delta tables. Do not overlap preparation with Power BI refresh or another package run. SQL endpoint synchronization can lag independently for each table.

Processed input validation completes before output replacement. Both output
tables receive the same generation ID; Ready is written only after both writes
and row-count reconciliation. A write/count failure leaves Publishing rather
than exposing a partially replaced generation as Ready.

## PAX output compatibility

This edition retains its notebook-prepared contract. PAX's raw `AIO_Users`, `AIO_CopilotInteractions` and `Agent365` Delta tables are **not** direct substitutes for the three `aio_v2_` tables. Renaming tables alone is insufficient: required column types, a consistent user/key set and the publication gate must also be satisfied. The optional Agent 365 connector still reads a SharePoint-hosted CSV, not the `Agent365` Delta table.

For the processed alternative, set both parameters to **single CSV files**:

```text
PAX_USERS_CSV = Files/PAX/AIO_..._Users.csv
PAX_INTERACTIONS_CSV = Files/PAX/AIO_..._Interactions.csv
```

Use `Files/` in the attached default Lakehouse or full ABFSS paths under a
Lakehouse's `Files/`. Folders, wildcards, HTTP URLs, raw Graph responses and raw
Purview AuditData are not this interface. CSV headers with spaces or their
underscore equivalents are accepted; colliding aliases are rejected.
The source files are not modified. Supplying only one path fails before
preparation. Both blank retains the existing current-snapshot path.

The pipeline has optional blank-default parameters and explicit preparation
bindings for both CSV paths. Supplying them does not skip its collectors; run
preparation directly for a processed-only route without Graph credentials. Raw
snapshot age/run-ID checks remain in the current-snapshot path, not the
processed-PAX path. Historical EffectiveDate values
in processed files are not treated as stale collection timestamps.

Configure TENANT_ID for the source. If a processed file includes TenantId, a
different value is rejected. Files without tenant metadata do not independently
attest their origin: the administrator must provide the matching approved
source pair. Do not combine exports from different tenants or key generations.

PAX v2.0 preserves CSV headers when writing files under OneLake `Files`, but replaces Delta-prohibited characters, including spaces, with underscores when writing tables:

| CSV header | PAX Delta column | This edition's input |
|---|---|---|
| `Created by` | `Created_by` | Agent CSV: preferred creator; legacy `Agent creator` fallback when blank |
| `Creator Id` | `Creator_Id` | Agent CSV: preferred creator ID; legacy `Agent creator ID` fallback when blank |
| `Developer Name` | `Developer_Name` | Agent CSV: separate developer attribute |
| `Bot Id` | `Bot_Id` | Agent CSV: current header; legacy `Bot ID` fallback |
| `Entra Agent ID` | `Entra_Agent_ID` | Agent CSV: retained source attribute |
| `hasLicense` | `hasLicense` | Raw Entra output: recognized by the shared Users normalizer |
| `Has license` | `Has_license` | Prepared AIO Users/activity tables: restored to `Has license` by the Fabric source queries |
| `License Status` | `License_Status` | Prepared activity table: restored to `License Status` by the Fabric source query |

PAX's `-CopilotAccessGroups` adjusts the final raw Users `hasLicense` value: a user must have an enabled Copilot license and belong to an allowed group to retain TRUE. The AIO processor canonicalizes that value to `Has license`; a PAX-to-prepared-table adaptation must preserve it rather than recompute it from `assignedLicenses`. The existing Fabric collectors do not implement that PAX switch and continue to use their documented licensing-report source.

Creator and Developer Name are separate attributes. The Agent CSV accepts `Creator provenance`, `Creator Provenance`, `Creator Source` and `Creator source`, taking the first nonblank value in that order.

For ordinary agents, missing creator names and IDs display **Not recorded**. Missing Developer Name and the trimmed, case-insensitive defaults `Your developer name`, `Agent Developer` and `Published by your Org` display **Not stated**.

System-generated agents instead display **System-generated** or **System-generated (Power Apps)** for both creator and developer; creator ID displays **Not recorded**. System evidence is an all-zero creator GUID, or a blank creator ID with explicit `system`, `system-generated`, `system generated` or `system-generated (power apps)` provenance. A catalogued **Copilot in Power Apps** agent of type **Shared** also qualifies when its creator name/ID, publisher and description are blank and Developer Name is blank or **Not stated**. These catalog attributes are not governed by Minimum Group Size, but existing access restrictions still apply.

Platform labels and catalog status describe different things. An activity-only agent can be identified as SharePoint or Copilot Studio from its activity identifier without being in the Agent 365 catalog; an inferred platform is not a catalog match.

## Stable keys and compatibility

User identities use trimmed lowercase UPNs. Message/thread identifiers retain source identity semantics. Each key is a deterministic positive signed 64-bit SHA-256-derived value with a separate user/message/thread domain. The same identity receives the same key across repeated preparation runs, directory joins and manager lookups. Preparation checks collisions against raw identities and fails rather than joining unrelated records.

That key-generation rule describes the current-snapshot path only.
Processed-PAX mode preserves PAX's state/message/thread/manager keys and
validates their consistency instead of applying the snapshot hash function.
It does not collect missing historical states or manufacture assignment dates.

Current-snapshot keys need not equal sequential PAX CSV keys. Do not mix the
snapshot path's fact/directory tables with another run or key generation.
The processed path deliberately uses one complete, matching PAX Users and
Interactions pair; it does not combine that pair with snapshot-generated keys.

The generated classifier retains the canonical AIO classification logic. Notebook-local LRU cache decorators are omitted because their wrappers cannot be deserialized by Spark workers. When duplicate logical rows carry differing non-grain attributes, preparation chooses the latest creation timestamp with deterministic attribute tie-breaking; the file processor chooses the last encountered input record. This does not change the deduplication grain or distinct prompt/session identities.

In current-snapshot mode, activity from people absent from the directory can
remain in all-data totals; those identities do not gain hierarchy access.
Set `REQUIRE_ALL_ACTIVITY_USERS_IN_DIRECTORY=true` to reject such a snapshot.
The processed-PAX path instead requires a matching exported Users state for
every event key and fails before publication when one is missing; it does not
invent a missing person's state or silently drop their events. A complete
authoritative source pair is needed for accurate headcount and hierarchy.
