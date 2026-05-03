# Fabric / Lakehouse deployment

> **Not just Fabric.** This folder is named "Fabric" because that's the simplest deployment, but the same PBIT + parsing notebook also work on **Azure Databricks**, **Synapse Spark**, **Azure SQL / Fabric Warehouse**, or **ADLS Gen2** with no real changes — see [Alternative platforms](#alternative-platforms) below.

This is the **fastest, most reliable** way to run the AI-in-One Dashboard on real audit-log volumes. The heavy JSON parsing happens **upstream** (in Fabric / Databricks / wherever your Spark or SQL compute lives) instead of inside the Power BI dataset, so the dataset refresh becomes a near-instant data copy (or zero-copy with Direct Lake mode).

## What's in this folder

| File | Purpose |
|---|---|
| `AI-in-One Dashboard - Fabric.pbit` | The Power BI template (thin client — sources all three input tables from a Lakehouse SQL endpoint) |
| `notebooks/Copilot_Audit_Log_Parser.ipynb` | Parses raw audit logs → `dbo.copilot_interactions_parsed` |
| `notebooks/Copilot_Licensed_Users_Loader.ipynb` | Ingests MAC licensed-user CSVs → `dbo.copilot_licensed_users` |
| `notebooks/Copilot_Org_Data_Loader.ipynb` | Ingests Entra/HRIS org CSVs → `dbo.copilot_org_data` |

## When to use this path

| Pick this path if… | Pick the [scripts](../scripts/) path instead if… |
|---|---|
| You have Fabric capacity (F2+ or trial) | You're on Power BI Pro only with no Fabric / Premium |
| Audit volume > 100K events / week | Audit volume is small enough to refresh in Power BI dataset directly |
| You want scheduled, hands-off ingestion | You're happy running scripts ad-hoc |
| You hit the 1 GB dataset cap or 2-hour refresh timeout in Service | Refresh has always succeeded for you |

## Why pre-parsing matters

The default templates parse the `AuditData` JSON column inside the Power BI dataset's M-query. That works for small/medium tenants, but at large scale it triggers three separate Service-side limits:

1. **Memory cap** — Pro/shared workspaces cap the dataset at 1 GB; peak refresh memory can be 3× that during JSON expansion
2. **Refresh timeout** — 2 hours on shared, 5 hours on Premium
3. **Power Query firewall** — `Formula.Firewall` errors when combining queries from different sources

Moving the parse into Fabric eliminates all three. The dataset becomes a thin pass-through against an already-flat Delta table.

## Architecture

```
Raw audit-log CSVs       Licensed-users CSV         Org-data CSV
(get-copilot-            (MAC export)               (Entra / HRIS)
 interactions.ps1
 or your pipeline)
        ↓                       ↓                        ↓
Files/audit_raw/         Files/licensed_raw/        Files/org_raw/
        ↓                       ↓                        ↓
Copilot_Audit_Log_       Copilot_Licensed_          Copilot_Org_Data_
Parser.ipynb             Users_Loader.ipynb         Loader.ipynb
        ↓                       ↓                        ↓
dbo.copilot_             dbo.copilot_               dbo.copilot_
interactions_parsed      licensed_users             org_data
        └───────────────────────┴────────────────────────┘
                                ↓
                  PBIT (Sql.Database connector
                  + one direct Org→Licensed
                  relationship for filter context)
                                ↓
                        Power BI Report
```

The PBIT only requires two parameters: **Fabric SQL Endpoint** and **Lakehouse Database**. The previous file-path parameters (`Copilot Licensed Users`, `Org Data File`, `Copilot Interactions File`) are kept for backward compatibility but should be left blank when running this Fabric path — the notebooks own those data sources now. Only `Agent 365` still uses a file-path parameter (a CSV export from MAC), pending a Graph API loader.

## Quick start

### 1. Stand up the Lakehouse

- Open a Fabric workspace assigned to a Fabric capacity (F2+ or trial)
- **+ New → Lakehouse**, name it e.g. `CopilotAnalytics`
- Note the **SQL endpoint** under Lakehouse settings — looks like `<workspace-guid>.datawarehouse.fabric.microsoft.com`

### 2. Land raw CSVs in three Lakehouse `Files/` sub-folders

Create the folders if they don't exist (right-click `Files` → **New folder**), then drop the corresponding CSVs in:

| Folder | Source | Required columns |
|---|---|---|
| `Files/audit_raw/` | M365 audit-log export (e.g. [`scripts/get-copilot-interactions.ps1`](../scripts/get-copilot-interactions.ps1) or any other audit pipeline) | `RecordId, CreationDate, RecordType, Operation, AuditData, AssociatedAdminUnits, AssociatedAdminUnitsNames` |
| `Files/licensed_raw/` | MAC export of Copilot-licensed users | A UPN column (`User Principal Name`, `userPrincipalName`, `UserPrincipalName`, `User principal name`) and a licence column (`Has license`, `Has Licence`, `HasLicense`, `HasCopilot`, `Has Copilot License`, `Has Copilot license assigned`, `isUser`, etc.). The loader auto-detects which variant your export uses. |
| `Files/org_raw/` | Entra / HRIS / Viva Insights export with org structure | A PersonId column (`User Principal Name` / `UPN` / `PersonId`) plus a `Department` column. Optional: `JobTitle`, `DisplayName`, `Email`, `Country`, plus any management-path / hierarchy columns you want to slice by. |

For each, pick whichever ingestion path fits your environment:

| If your export goes to… | Use… |
|---|---|
| SharePoint folder | A **Fabric Pipeline** with a Copy activity (SharePoint Online → Lakehouse Files) |
| Azure Blob Storage / ADLS Gen2 | A **Lakehouse Shortcut** to the storage container (no copy needed) |
| Local files | Direct upload via the Fabric portal, or pipeline Copy activity |

### 3. Import and run all three notebooks

For each of the three notebooks under `notebooks/`:

- In your Fabric workspace → **+ New → Import notebook** → upload the `.ipynb`
- Attach the notebook to your `CopilotAnalytics` Lakehouse and **pin it as default** (📌 icon next to the name in the Lakehouses panel — this is what makes `saveAsTable` write to the right place)
- Click **Run all**

| Notebook | Run cadence | Output Delta table | Typical runtime |
|---|---|---|---|
| `Copilot_Audit_Log_Parser.ipynb` | Daily (matches audit-log export) | `dbo.copilot_interactions_parsed` | 30–60s for ~400K events |
| `Copilot_Licensed_Users_Loader.ipynb` | Weekly / monthly (matches MAC export cadence) | `dbo.copilot_licensed_users` | Seconds |
| `Copilot_Org_Data_Loader.ipynb` | Weekly (matches HRIS / Entra refresh) | `dbo.copilot_org_data` | Seconds |

Use the **Schedule** button at the top of each notebook to set a cadence — or wire all three into a single Fabric Pipeline.

### 4. Connect the PBIT

- Open `AI-in-One Dashboard - Fabric.pbit` in Power BI Desktop
- Supply the two **required** parameters when prompted; leave the rest blank:

| Parameter | Value |
|---|---|
| **Fabric SQL Endpoint** | `<workspace-guid>.datawarehouse.fabric.microsoft.com` |
| **Lakehouse Database** | `CopilotAnalytics` (or whatever you named your Lakehouse) |
| Copilot Interactions File | Leave blank — vestigial |
| Copilot Licensed Users | Leave blank — sourced from `dbo.copilot_licensed_users` |
| Org Data File | Leave blank — sourced from `dbo.copilot_org_data` |
| Agent 365 (highly recommended) | Path to your Agents 365 CSV (still file-based pending Graph API loader) |

- Click **Load**. Refresh should complete in seconds
- Publish to a Power BI workspace ideally **on the same Fabric capacity** so Direct Lake works without cross-capacity overhead

### 5. Schedule + secure the Service refresh

- In the Service: workspace → dataset Settings → **Data source credentials** → sign in to the SQL endpoint with an account that has read access to the Lakehouse
- **Scheduled refresh** → enable, match the cadence to your notebook schedule (the dataset only needs to refresh after the parser updates the Delta table)

## Alternative platforms

The two artifacts in this folder are deliberately portable:

- **The notebook** is plain PySpark — runs unchanged on any Spark engine (Fabric, Databricks, Synapse Spark)
- **The PBIT** uses the `Sql.Database()` connector, which works against any SQL endpoint that exposes the parsed Delta/SQL table — Fabric Lakehouse, Databricks SQL Warehouse, Synapse SQL pool, Azure SQL DB, Fabric Warehouse, on-prem SQL Server

So the same set of files supports the deployments below; only a couple of paths/parameter values change.

### 🧱 Azure Databricks

**Notebook changes (3 lines):**
- Raw input path: `'Files/audit_raw/*.csv'` → DBFS or Unity Catalog volume, e.g. `'/Volumes/main/copilot/audit_raw/*.csv'`
- Output: `saveAsTable('Copilot_Interactions_Parsed')` → three-part UC name, e.g. `'main.copilot.interactions_parsed'`
- Schedule via **Databricks Workflows** instead of Fabric Pipelines

**PBIT parameters:**

| Parameter | Value |
|---|---|
| **Fabric SQL Endpoint** | Your Databricks SQL Warehouse hostname (e.g. `<workspace-id>.cloud.databricks.com`) |
| **Lakehouse Database** | The Unity Catalog name (or `hive_metastore`) — the database the parsed table lives in |

For a more polished native-connector experience, swap the M-query's `Sql.Database(...)` line for `Databricks.Catalogs(...)`. The rest of the M-query is unchanged.

### 🪣 Azure Data Lake Gen2 (no Spark)

You have **three** routes depending on what you're willing to stand up:

1. **Easiest — Fabric Lakehouse Shortcut.** Create a Shortcut from your Fabric Lakehouse to the ADL container holding raw CSVs. The Shortcut makes the ADL data appear as a Lakehouse `Files/` reference. Run the notebook unchanged. Best of both worlds — your data stays in ADL, Fabric does the compute.

2. **No Fabric — use the [`Manual CSV`](../Manual%20CSV/) `sharepoint only` PBIT instead.** Point its `Copilot Interactions File` parameter at `https://<account>.dfs.core.windows.net/<container>/<path>/parsed.csv`. Skips the Spark step entirely; works for tenants that already pre-parse upstream and just need Power BI to consume the result.

3. **Pure ADL + Databricks.** Mount the ADL container in Databricks (or use Unity Catalog external locations), then run the notebook from there as in the Databricks section above.

### 🔷 Azure Synapse / Azure SQL DB / Fabric Warehouse

- Run the parsing notebook on a **Synapse Spark pool**, or replace it with an equivalent SQL stored procedure / dbt model that produces the same flat schema
- Land the output in any SQL table
- Use the PBIT's existing `Sql.Database(...)` connector — supply your hostname + database name in the two parameters

The PBIT only cares that a table called `dbo.Copilot_Interactions_Parsed` (or whatever you name it — adjust one line in the M-query) exists with the [expected schema](#schema-reference).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Refresh succeeds but interactions table is empty | Parsing notebook hasn't run yet, or failed silently | Check the notebook's last execution; run manually |
| `Login failed` / `cannot open database` | SQL endpoint hostname or database name wrong | Re-check Lakehouse settings page for the exact SQL endpoint string |
| `the key didn't match any rows in the table` | A loader notebook ran against the wrong (non-default) lakehouse, so the expected table name doesn't exist | In the notebook's Lakehouses panel, confirm `CopilotAnalytics` is **pinned** (📌) before re-running |
| All users show as "Unlicensed" / `Total Licensed Users` empty | Licensed-users notebook hasn't been run yet, or its CSV used a UPN column-name variant the loader doesn't recognise | Check the notebook output for the detected UPN/licence column names; widen the variant list in the loader if needed |
| `Inactive Licensed Users` is 0 even with no filter | Every licensed user has audit activity (likely with synthetic / test data); or `UPN_Normalized` ↔ `PersonId_Normalized` casing mismatch | Run `SELECT COUNT(*) FROM dbo.copilot_licensed_users WHERE UPN_Normalized NOT IN (SELECT LOWER(LTRIM(RTRIM(Audit_UserId))) FROM dbo.copilot_interactions_parsed)` — if result is 0, your population is genuinely fully active |
| `Formula.Firewall` error (only on non-Fabric variants) | Cross-source merge with privacy levels mismatched | Service → dataset Settings → Data source credentials → set **Privacy: None** for both sources |
| Only some columns populated | Microsoft added new fields to the audit schema | Update `audit_schema` in the notebook (cell 2) to include them, re-run |
| Refresh slow (more than a minute) | Dataset is in Import mode | Switch the workspace to a Fabric capacity and convert to **Direct Lake** for sub-second response |

## Schema reference

The `Copilot_Interactions_Parsed` Delta table has one row per **prompt × accessed-resource**, mirroring what the AI-in-One M-query produces post-expansion. Key columns:

| Column | Type | Notes |
|---|---|---|
| `CreationDate` | timestamp | Parsed from `AuditData.CreationTime` |
| `Audit_UserId` | string | The user's UPN |
| `AppHost` | string | `Teams`, `Word`, `Excel`, `Copilot Studio`, etc. |
| `Workload` | string | Typically `Copilot` |
| `AISystemPlugin_Id` | string | `BingWebSearch` indicates Bing grounding was used |
| `AccessedResource_Type` | string | `WebSearchQuery`, `File`, `Email`, `EnterpriseSearch`, etc. |
| `Message_Id` / `Message_isPrompt` | string | One row per prompt; `Message_isPrompt = "TRUE"` always |
| `Resource_Count` | int | Original fan-out count (number of resources the prompt accessed) |
| `InteractionDate` / `WeekStart` / `MonthStart` | date | Computed in PySpark |

For the full audit-log JSON schema, see [Microsoft Learn — CopilotInteraction schema](https://learn.microsoft.com/en-us/office/office-365-management-api/copilot-schema).

## Customising the parser

The notebook's `audit_schema` cell defines which JSON fields get extracted. Add fields by extending that struct — the rest of the notebook adapts automatically as long as the new field is referenced in the `flat.select(...)` block.

For incremental refresh (only parse new events since last run), change the `WRITE_MODE` config to `'append'` and add a watermark filter on `CreationTime` keyed off the max value already in the Delta table.
