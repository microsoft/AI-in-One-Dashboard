# ⚙️ Standalone processor — processing raw data without PAX

Part of [AI in One](../README.md). Most people should [run PAX](get-your-data.md) instead. Use this page if you export raw Purview and Entra data some other way.

---

The [`scripts/`](../scripts/) folder at the root of this repo contains a Python script that produces the same two rollup files this dashboard requires — without needing PAX. Use this path if you export raw Purview audit data and Entra/MAC user data through your own tooling, portal exports, or an alternative script rather than through PAX.

> **Note:** This processor handles the Purview interactions file and the Entra/MAC users file only. It does not produce the Agent 365 file. For Agent 365 data, see [**🤖 Agent 365**](get-your-data.md#agent-365) on the Get your data page.

## Requirements

- **Python 3.9 or later**
- The `orjson` package is optional but recommended for faster JSON parsing:
  ```
  pip install orjson
  ```
  The script falls back to the Python standard library `json` module if `orjson` is not installed.

## What you need before running

Two input files are required. Both must be CSV format.

---

### Input 1 — Raw Purview audit CSV (`--purview`)

This is the raw audit log export from Microsoft Purview. Export it from the **Microsoft Purview compliance portal → Audit → search/export**.

The script filters the file automatically — only `CopilotInteraction` operation records are processed; all other record types are skipped.

| Column | Required? | Notes |
|---|---|---|
| `AuditData` | ✅ Required | The JSON blob column that Purview includes in every audit export. All Copilot interaction detail is parsed from inside this column. If this column is absent, the script will produce no output. |
| `Operation` or `Operations` | Used for filtering | Used to identify `CopilotInteraction` records when the value is not already inside the `AuditData` JSON. Purview exports typically include one of these. |

All other columns in the Purview export are ignored — the script reads only `AuditData` and `Operation`/`Operations`.

---

### Input 2 — Combined Entra + MAC users CSV (`--entra`)

This file is **not** a direct export from a single portal. It is a combined file you assemble by joining two separate exports:

1. **Microsoft Entra ID user export** — provides the user list with UPN, display name, department, job title, etc.
2. **Microsoft 365 Admin Center (MAC) licensing export** — provides the per-user Copilot license assignment column

You must add the license column from the MAC export into the Entra user export (for example, using Excel or Power Query) before passing the file to the script. If no recognized license column is present, the script will still process the file but every user will be tagged as `Unlicensed`.

| Column | Required? | Accepted column names | Notes |
|---|---|---|---|
| User Principal Name | ✅ Required | `userPrincipalName`, `upn`, `personId` (case-insensitive) | Used to join Purview audit records to user data. Rows with a blank UPN are still written to the Users output but will not join to any audit activity. |
| Copilot license flag | ✅ Strongly recommended | `Has license`, `Has License`, `hasLicense`, `HasLicense`, `Has Copilot License`, `Has Copilot license`, `HasCopilotLicense`, `Has Copilot License Assigned`, `Has Copilot license assigned`, `isUser` | Any truthy value (`Yes`, `True`, `Y`, `1`) is treated as licensed; everything else is unlicensed. If the column is missing entirely, all users default to unlicensed. |
| Department | ✅ Required | Any casing of `department`, `organization`, or `organisation` — spaces, hyphens, and underscores in the column name are ignored when matching | Renamed to `Organization` in the output. Used for org-level segmentation in the dashboard. |
| Job title | ✅ Required | Any casing of `jobtitle` or `job title` — spaces, hyphens, and underscores in the column name are ignored when matching | Renamed to `JobTitle` in the output. |
| All other columns | Optional | Any | All other columns in your input file are passed through to the Users output as-is. |

## Arguments

| Argument | Required? | Description |
|---|---|---|
| `--purview <path>` | ✅ Required | Path to the raw Purview audit log CSV |
| `--entra <path>` | ✅ Required | Path to the Entra users CSV |
| `--out-dir <path>` or `-o <path>` | Optional | Directory where output files are written. Defaults to the same directory as the Purview input file |
| `--quiet` or `-q` | Optional | Suppresses progress output. Useful in scheduled or automated contexts |

## What the processor produces

Two files are written to the output directory, named automatically based on your input filenames and a run timestamp:

| Output file | What it is | Dashboard parameter |
|---|---|---|
| `<purview-filename>_Interactions_<timestamp>.csv` | Rolled-up Copilot interactions fact table | **Copilot Interactions File** |
| `<entra-filename>_Users_<timestamp>.csv` | Users and licensing dimension table | **Org Data File** |

Point the corresponding dashboard parameters at these two output files exactly as you would with PAX-produced files.

## Usage examples

Run the `.py` file found in the `scripts/` folder. In the examples below, replace `scripts/<processor>.py` with the actual filename.

**Basic — output files are written to the same folder as the Purview input**

```
python scripts/<processor>.py --purview "C:\Data\Purview_Audit_20260510.csv" --entra "C:\Data\EntraUsers_20260510.csv"
```

**With an explicit output directory**

```
python scripts/<processor>.py --purview "C:\Data\Purview_Audit_20260510.csv" --entra "C:\Data\EntraUsers_20260510.csv" --out-dir "C:\Data\Rollup Output"
```

**Quiet mode — suppress progress output (useful in scheduled tasks)**

```
python scripts/<processor>.py --purview "C:\Data\Purview_Audit_20260510.csv" --entra "C:\Data\EntraUsers_20260510.csv" --out-dir "C:\Data\Rollup Output" --quiet
```

## Multi-month history with the standalone processor

If you use PAX's `-AppendFile` switch to accumulate a growing raw Purview CSV over time, run the standalone processor against that accumulated file to produce a fresh rollup whenever you need to refresh the dashboard. See [**📚 Multi-month history**](get-your-data.md#appendfile) on the Get your data page for the full pattern, including the recommended commands.
