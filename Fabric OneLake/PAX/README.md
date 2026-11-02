# Fabric OneLake PAX edition

This is **the PAX-script-backed Fabric OneLake edition of AI-in-One**. It reads processed outputs produced by the PAX PowerShell script from Fabric OneLake Tables through the SQL analytics endpoint, in **Import** mode. The separate Fabric-native **PAX Fabric** product is not integrated here. Get the PowerShell script from [PAX v2.0 prerelease](https://aka.ms/PAX-Prerelease).

Use [AI-in-One-v2.0.0-Fabric-OneLake-PAX-Template.pbit](../../templates/AI-in-One-v2.0.0-Fabric-OneLake-PAX-Template.pbit). It shares the report, 541 calculations, privacy controls, hierarchy, observed license history and security roles with the other editions. Minimum Group Size defaults to **3**.

This is **not** the [notebook-backed Fabric OneLake edition](../AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/README.md). It requires neither that solution's collectors/preparation notebook nor `aio_v2_*` tables. It does not call Graph during report refresh or require a SharePoint catalog. Both editions remain available with their own source contracts.

## Required data and permissions

Use an existing PAX-populated Lakehouse. The selected SQL schema must expose:

- `AIO_Users`: processed AIO users, including state UserKeys and observed history when produced.
- `AIO_CopilotInteractions`: processed AIO activity, not raw Purview records.
- `Agent365`: processed catalog, only when catalog loading is enabled.

PAX's default naming is used unchanged; do not rename these tables or export them back to CSV. PAX can target a physical schema in schema-enabled Lakehouses; choose the schema actually exposed by the SQL endpoint. See the [schema contract](SCHEMA.md).

The report reader needs permission to connect to the SQL endpoint/database and `SELECT` the required tables, including `Agent365` when enabled. Use an existing organizational account with the appropriate access. This template does not provision resources, grant permissions or create application registrations.

## Parameters

| Parameter | Value |
|---|---|
| **Fabric SQL Endpoint** | Actual SQL analytics endpoint hostname; no URL prefix or surrounding whitespace |
| **Fabric Lakehouse** | Actual SQL database/Lakehouse name |
| **PAX SQL Schema** | SQL schema containing the canonical tables; default `dbo` |
| **Load Agent365 catalog** | Default `false`: intentionally use activity-only agents. `true` requires a readable, valid `Agent365` table |
| **Minimum Group Size** | Default `3`; approved individual detail requires `1` |

## One-time setup and unattended refresh

1. Select the existing PAX SQL endpoint, database, schema and catalog option above. Authenticate with an authorized organizational account.
2. Load the report in Desktop. The adapter checks required schemas, types, unique Users state keys and activity-to-Users relationships. Check representative data and access behavior.
3. If separately authorized to publish, configure the Service SQL cloud connection and scheduled refresh after your normal PAX completion/SQL synchronization window. Confirm source recognition and scheduled-refresh availability in that workspace.

Normal successful PAX runs require no recurring template-parameter changes or manual approval of subsequent dashboard refreshes. The report does not add a customer-maintained publication mechanism or another collector.

The connection uses `Sql.Database(#"Fabric SQL Endpoint", #"Fabric Lakehouse", ...)` directly. Schema navigation and validation do not construct or rewrite its server/database target. No path-based storage autodetection is used.

**Independent SQL reads are not an atomic cross-table snapshot.** PAX publication completion and SQL endpoint synchronization are separate boundaries. Schema and key validation reject invalid inputs but do not prove a common table generation or eliminate SQL synchronization lag. No atomic-publication or successful Service refresh claim follows from Desktop loading, cached rendering or static source discovery.

## Catalog and identity

Catalog loading disabled means deliberate activity-only behavior without reading Users or activity. When enabled, a missing table, access failure or malformed schema is an error, not an empty-catalog fallback.

Users and catalog are evaluated independently of activity. Activity validates imported keys against a Users-key-only index; it does not buffer or count the complete activity table as a prerequisite for loading other inputs.

The adapter reverses only explicit known PAX column-name encodings. It preserves intentional names such as `Agent_TitleID`, UserKey, message/thread keys and per-event state attribution. Existing catalog normalization and identifier resolution remain in place; creator, developer, platform and catalog-match status are not interchangeable.

Observed `EffectiveDate` is **First seen**, not license-assignment time. Users' manager state keys continue to resolve to manager people through the shared model. No SKU-based licensing reconstruction or new key family is introduced.

## Release scope and limitations

This release supports the documented processed-table contract and SQL Import configuration. Full-release branding does not establish a SQL-provider load-time or regression guarantee, customer-specific authentication or scheduled-execution qualification, or certification of a complete customer PAX-script-to-Fabric-to-AIO pipeline. Customer-specific Local CSV UserKey cases and SQL synchronization/common-generation limits are not erased by release packaging. Use the normal PAX completion and SQL synchronization cadence; no recurring row-count parameters or manual approval mechanism is introduced.
