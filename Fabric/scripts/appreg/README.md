# Fabric path — Unattended scripts (App Registration auth)

These scripts produce the **raw audit log format** (with `auditData` JSON column) and write to **local disk** — designed to be picked up by Fabric Data Pipelines, OneDrive sync, or `azcopy` into a Lakehouse.

For Fabric customers, the pipeline is:

```
PowerShell scheduler (or Fabric Data Pipeline trigger)
        ↓
Runbooks produce raw CSVs to local path
        ↓
Fabric Data Pipeline / OneLake sync moves the files into Lakehouse Files/
        ↓
Lakehouse notebook (../../notebooks/) parses + writes Delta tables
        ↓
PBI Direct Lake reads Delta tables → near-instant refresh
```

If you want **direct upload to SharePoint** instead, use the [`../../../SharePoint/Single File/scripts/appreg/`](../../../SharePoint/Single%20File/scripts/appreg/) variants — they upload to a SharePoint document library directly and produce the **NatWest pre-parsed format** (different schema).

## Scripts in this folder

| Script | Purpose | Required scope |
|---|---|---|
| `CreateAuditLogQuery-AppReg.ps1` | Creates a Microsoft Purview audit log query for the date range | `AuditLogsQuery.Read.All` |
| `GetCopilotInteractions-Fabric-AppReg.ps1` | Fetches query results, writes raw-format CSV to local path. Fabric notebook does the parsing downstream. | `AuditLogsQuery.Read.All` |
| `GetCopilotUsers-Fabric-AppReg.ps1` | Pulls M365 active user report + Copilot license flag, writes locally | `Reports.Read.All` |
| `Get-EntraOrgData-Fabric-AppReg.ps1` | Pulls org structure, writes locally | `User.Read.All` |

All scripts support 3 auth modes: managed identity (default), client secret, or certificate.

## Required permissions on the app registration

| Permission | Type |
|---|---|
| `AuditLogsQuery.Read.All` | Application |
| `Reports.Read.All` | Application |
| `User.Read.All` | Application |
| `Organization.Read.All` | Application |

**No `Sites.Selected`** required (this path doesn't touch SharePoint).

## Why raw format vs NatWest format?

| | Fabric (this path) | SharePoint |
|---|---|---|
| Output format | Raw Graph schema with `auditData` JSON | NatWest 15-column pre-parsed |
| Where parsing happens | Upstream in Fabric notebook (Spark) | Inside the PowerShell script |
| Scales to | Millions of events, multi-year | ~500K events, 30 days rolling |

Both end up at the same dashboard — different routes there.
