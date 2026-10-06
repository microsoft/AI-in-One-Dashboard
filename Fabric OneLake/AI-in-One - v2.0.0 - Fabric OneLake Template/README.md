# AI-in-One v2.0.0 - Fabric OneLake setup

## Architecture

```text
Graph audit queries --------> aio_v2_audit_raw + aio_v2_audit_status
Graph directory ------------> aio_v2_org_raw
Graph licensing report -----> aio_v2_licenses_raw
                                      |
                           Report Data Preparation
                                      |
               aio_v2_users + aio_v2_interactions
                      + aio_v2_publication (Ready)
                                      |
                      SQL analytics endpoint
                                      |
                        Power BI Import model
```

Delta tables are stored in **OneLake**. The report imports them through `Sql.Database`; it is **not Direct Lake**. The report retains the SharePoint edition's calculations, report pages, filters, bookmarks and two security roles. Only its required activity/directory source layer changes. The optional agent inventory remains a SharePoint-hosted Agent 365 CSV.

## 1. Prerequisites and permissions

- A Fabric workspace on active capacity, a Lakehouse and permission to create/run notebooks and write its tables.
- A Lakehouse SQL analytics endpoint that the Power BI refresh identity can read. Use a dedicated Lakehouse or appropriate SQL permissions; report RLS does not secure direct access to OneLake, notebooks or SQL.
- A source-tenant Entra application with administrator-consented Microsoft Graph **application** permissions:
  - `AuditLogsQuery.Read.All` for audit queries;
  - `User.Read.All` for directory properties and manager expansion;
  - `Reports.Read.All` for the Microsoft 365 active-user report.
- A client secret stored in Azure Key Vault. The notebook execution identity needs permission to retrieve that specific secret. Set the vault URL and secret name in notebook/pipeline parameters; **do not paste secrets into notebook cells or source control**.
- The source tenant must make the required audit data available under its licensing and retention policies. Query availability and retention are tenant-dependent; a longer requested backfill does not create older audit records.
- Licensing report identities must be identifiable UPNs. Concealed identities cannot join to the directory. Follow your organization's approved report-privacy process rather than bypassing privacy controls.

These collectors target the commercial `graph.microsoft.com` and `login.microsoftonline.com` endpoints. Sovereign-cloud deployments require a separately validated endpoint/authentication adaptation.

References: [create audit query](https://learn.microsoft.com/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0), [audit query resource and result-limit flag](https://learn.microsoft.com/graph/api/resources/security-auditlogquery?view=graph-rest-1.0), [list users](https://learn.microsoft.com/graph/api/user-list?view=graph-rest-1.0), [active-user report](https://learn.microsoft.com/graph/api/reportroot-getoffice365activeuserdetail?view=graph-rest-1.0), [Key Vault credentials](https://learn.microsoft.com/fabric/data-engineering/notebookutils/notebookutils-credentials).

## 2. Import and configure the notebooks

Import all four `.ipynb` files from [notebooks](notebooks/) into Fabric:

1. `Copilot_Audit_Log_Direct_Ingester`
2. `Copilot_Org_Data_Direct_Ingester`
3. `Copilot_Licensed_Users_Direct_Ingester`
4. `Copilot_Report_Data_Preparation`

Attach **the same default Lakehouse** to all four. Both existing non-schema Lakehouses and schema-enabled Lakehouses using default `dbo` are supported. Bare Spark table names resolve in the default Lakehouse; the SQL endpoint exposes these tables under `dbo`. Do not select a different default schema.

Each notebook is self-contained; uploading the `src` folder is unnecessary. The first code cell is the Fabric parameter cell. Configure `TENANT_ID`, `CLIENT_ID`, `KEY_VAULT_URL` and `SECRET_NAME` in the three collectors, and `TENANT_ID` in preparation.

Defaults:

| Setting | Default | Meaning |
|---|---|---|
| Audit mode | `incremental` | Merge by source tenant and audit record ID |
| Initial backfill | 7 days | Used when no prior raw history exists |
| Incremental overlap | 7 days | Revisit recent history for late-arriving records without appending duplicates |
| Audit window | 24 hours | Lower this when Graph reports a result limit |
| Concurrent audit queries | 2 | Bounded collection concurrency |
| Licensing report period | `D30` | Current report snapshot, not a history of license assignments |
| Copilot product labels | `MICROSOFT 365 COPILOT` | Exact, case-insensitive labels in Assigned Products; `+`/`;` separate products |
| Maximum input age | 48 hours | Preparation rejects stale collection snapshots |
| Maximum license report age | 7 days | Based on Report Refresh Date, not download time |

For a larger initial backfill, use explicit UTC `START_UTC`/`END_UTC` ranges or adjust `BACKFILL_DAYS`. Process manageable ranges within the tenant's available retention. `backfill` **merges** history; it does not erase existing v2 history. The normal incremental watermark is the latest stored audit timestamp minus the overlap.

The audit notebook logs its `RUN_ID`. Reuse that UUID to resume the same run's checkpointed range and query IDs. A blank `RUN_ID` starts a new run. See [audit resilience notes](notebooks/AUDIT_LOG_INGESTER_NOTES.md).

Keep all runs for this package **non-overlapping**. Do not concurrently run collectors/preparation against the same output tables.

## 3. Collect, prepare and verify the source

Run the three collectors, then run preparation. Alternatively, configure the [pipeline](pipelines/README.md).

Preparation validates tenant consistency, input age, identity uniqueness, key collisions, licensing schema, prompt/session identifiers and output counts. Missing license evidence stays `Unknown`; it is not silently converted to unlicensed.

Publication uses a generation ID and a state marker. The marker becomes `Ready` only after both output tables have been written and their counts reconcile. A failure during publication leaves `Publishing`; the template refuses that incomplete snapshot.

Wait for the SQL analytics endpoint to show all three final tables with the same completed snapshot. SQL metadata/data synchronization is asynchronous. A `Ready` Delta marker alone is not proof that all SQL tables have caught up.

### Supplying directory data without Graph

If you already maintain an authoritative Entra/HR directory, you may skip the org collector. Supply `aio_v2_org_raw` using the [schema contract](SCHEMA.md), including tenant, collection-run ID and UTC collection timestamp.

- Use one current row per normalized UPN, including managers needed to resolve the hierarchy.
- Preserve actual department and manager identities; do not invent links for access.
- In the pipeline, set `EnableOrgDataPull=false`. Preparation will still require a valid, sufficiently recent org snapshot.
- For manual preparation, `RUN_ID=""` accepts fresh snapshots from separately run collectors. When a nonblank run ID is provided, audit/licensing must match it; org must also match unless `USE_EXISTING_ORG=true`.

## 4. Open the v2 template

Open [AI-in-One-v2.0.0-Fabric-OneLake-Template.pbit](../../templates/AI-in-One-v2.0.0-Fabric-OneLake-Template.pbit) in current Power BI Desktop.

Set:

| Template parameter | Value |
|---|---|
| **Fabric SQL Endpoint** | SQL analytics endpoint hostname from the Lakehouse connection details, without `https://` |
| **Fabric Lakehouse** | The Lakehouse name shown in Fabric; its SQL endpoint uses this as the database name |
| **Agent 365 (highly recommended)** | Optional full SharePoint HTTPS file path for the agent inventory CSV; leave blank if unavailable |
| **Minimum Group Size** | Default **3**; set according to organizational privacy policy |

Sign in to the SQL source with the appropriate organizational account. If using the agent inventory, configure its SharePoint organizational credentials separately. Keep normal Power Query privacy protections enabled. A OneLake file URL is **not** a SQL endpoint.

After loading, compare directory headcount, distinct prompts, sessions, active users and agent activity with the prepared data. Verify representative department, license and reporting-team selections.

### Org filters and grouping

Use **Org filters**, next to **Clear filters**, to open Company, Division, Department, Reporting team, User and License selectors. The panel is available on analytical pages, not the glossary. Clear filters resets selections and table drill state.

Minimum Group Size is configured during initial template load. To change it later, use **Home > Transform data > Edit parameters**, change **Minimum Group Size**, and apply the changes. Individual details require **1**. Group thresholds use eligible directory headcount, not just people with activity.

## 5. Publish, assign access and refresh

Publishing and role membership are administrator actions; the notebooks and pipeline do not publish reports or assign members.

After publishing, configure the semantic model's SQL cloud connection/credentials and the optional SharePoint connection. An ordinary reachable Fabric SQL endpoint does not require an on-premises gateway; private networking and tenant policies can require additional connection configuration.

Assign authorized viewers to the appropriate role in Power BI Service:

- **Reporting hierarchy**: dynamic, fail-closed access based on the signed-in viewer's normalized UPN matching a directory identity. Viewers receive their own row and valid descendants. Report reporting-team selections represent subordinate teams and exclude the selected manager's own activity.
- **All data viewers**: unrestricted model data for explicitly authorized administrators/analysts who need full reporting access, including viewers who are not in the source directory. The role ships with **no members**.

Roles are additive. A member of All data viewers is not restricted by also belonging to Reporting hierarchy. Minimum Group Size is display suppression, **not an RLS security boundary**. Workspace administrators, members and contributors are not restricted like report viewers; test using an actual Viewer/app-consumer identity.

Refresh credentials do not map the signed-in viewer to source-tenant users. A corporate viewer whose UPN does not exist in the source directory correctly receives no data under Reporting hierarchy. Do not create fake manager links to make that identity work.

**Refresh order:** collection success -> preparation success -> SQL endpoint synchronization -> Power BI Import refresh. Never overlap notebook publication and semantic-model refresh. Keep the previous imported model available if a new refresh fails. The included pipeline stops after preparation; it does not silently trigger a model refresh.

Validate the published report with an individual contributor, a manager, a cross-department descendant, an unmatched identity and an authorized All data viewers member before broader sharing.

## Troubleshooting

| Symptom | Check |
|---|---|
| RLS Access Denied | The viewer needs report access and appropriate semantic-model role membership |
| Report opens but is empty | Check signed-in UPN against the loaded directory, role selection, date filters and Minimum Group Size |
| Preparation rejects old inputs | Rerun the affected collector; do not conceal the problem by changing timestamps |
| Licensing identities do not match | Confirm identifiable UPNs, source tenant and report privacy settings |
| Missing/blank Assigned Products | Missing column fails collection; blank value remains Unknown |
| Audit query succeeded but is truncated | Reduce the query window; see resilience notes |
| Snapshot state is Publishing | Fix the failed preparation and rerun it before refresh |
| SQL snapshot/count mismatch | Wait for SQL endpoint synchronization; ensure no overlapping notebook/refresh runs |
| Manager absent, cycle or broken hierarchy | Correct the authoritative directory; the model restricts invalid chains rather than granting a broader tree |

## Source maintenance

The [src](src/) folder contains the reviewed notebook implementations and the notebook/pipeline builder. The preparation classifier is generated from the repository's existing AIO v4.2.3 processor; [processor-provenance.json](src/processor-provenance.json) records its hash. Spark-specific differences are documented in [SCHEMA.md](SCHEMA.md).

From the repository root, rebuild the self-contained notebooks and pipeline with:

```powershell
python "Fabric OneLake\AI-in-One - v2.0.0 - Fabric OneLake Template\src\build_notebooks.py"
```
