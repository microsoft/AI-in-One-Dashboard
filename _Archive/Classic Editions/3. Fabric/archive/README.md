# Archived Fabric assets

These are the previous-generation ingestion assets, kept for reference and for customers still mid-migration. **The active Fabric path no longer uses them.** See [`../README.md`](../README.md) for the current Direct Ingester + DataPipeline flow.

## What changed

The legacy flow was a **two-stage pipeline**:

```
PowerShell (export raw audit log + users + org → CSVs)
                ↓
Lakehouse Files/{audit_raw,licensed_raw,org_raw}/
                ↓
PySpark notebook (parse / load) → Delta tables
```

The current flow is a **one-stage Direct Ingester**: a single PySpark notebook authenticates to Microsoft Graph and writes Delta tables directly. No CSV landing step, no PowerShell, no app reg secrets stored on the operator's laptop. Scheduled via the [`../pipelines/CopilotAdoptionPipeline.DataPipeline/`](../pipelines/CopilotAdoptionPipeline.DataPipeline/) Fabric Data Pipeline.

| Concern | Legacy 2-stage flow | Direct Ingester (current) |
|---|---|---|
| Where secrets live | PowerShell env vars on the operator machine | Notebook → Key Vault |
| Run cadence | Two manual steps each cycle (PS + notebook) | One scheduled DataPipeline run |
| External dependency | A working PowerShell + Graph PowerShell SDK | None — `requests` against Graph REST |
| Output schemas | Same Delta tables (`dbo.copilot_*`) | Same Delta tables — PBIT unchanged |

## Migration

If you're a customer running the legacy flow today:

1. Stop the PowerShell scripts. They aren't needed anymore.
2. Run the three Direct Ingester notebooks under [`../notebooks/`](../notebooks/) — they produce the same Delta tables, so your PBIT and any downstream consumers keep working.
3. The Lakehouse `Files/audit_raw/`, `Files/licensed_raw/`, `Files/org_raw/` folders can stay (notebooks ignore them) or be cleaned up.
4. Once you've verified a successful Direct Ingester run, the app registration created for the legacy flow can be reused — it has the same Graph permissions.
5. Optionally: import the new [`../pipelines/CopilotAdoptionPipeline.DataPipeline/`](../pipelines/CopilotAdoptionPipeline.DataPipeline/) into your workspace to schedule the Direct Ingesters automatically.

## What's in here

### `notebooks/`

The legacy 2-stage notebooks. They consume CSVs from Lakehouse `Files/` folders and produce Delta tables.

| File | Inputs | Output |
|---|---|---|
| `Copilot_Audit_Log_Parser.ipynb` | `Files/audit_raw/*.csv` | `dbo.copilot_interactions_parsed` |
| `Copilot_Licensed_Users_Loader.ipynb` | `Files/licensed_raw/*.csv` | `dbo.copilot_licensed_users` |
| `Copilot_Org_Data_Loader.ipynb` | `Files/org_raw/*.csv` | `dbo.copilot_org_data` |

### `scripts/`

The PowerShell helpers that produced the raw CSVs the legacy notebooks consumed.

- **`appreg/`** — App-registration-based scripts (recommended for unattended/scheduled runs in the legacy flow). Targeted Graph application permissions; no interactive sign-in.
- **`interactive/`** — Interactive variants for ad-hoc operator use, signing in with the operator's account.

The `appreg/README.md` has the historical setup instructions; useful if you're studying how the original flow authenticated. None of these are required for the current Direct Ingester path.

## When this folder can be deleted

Safe to delete once **all** customers on the legacy flow have migrated to Direct Ingesters and you no longer need the historical reference. Until then, keeping this folder costs ~few hundred kilobytes and avoids a broken-link experience for anyone following an old runbook.
