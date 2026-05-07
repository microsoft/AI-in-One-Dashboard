# SharePoint — Legacy raw-audit path

Older flow that uploads **raw audit log records** to SharePoint (with embedded `auditData` JSON). Power Query M does all the parsing in the dashboard.

> **New deployments should use [`../File/`](../File/) or [`../Folder/`](../Folder/).** They're faster, cleaner, and the parsing is done upstream in PowerShell instead of in Power Query (which scales better and is far less fragile around Privacy Firewall / type-inference issues).
>
> This path is kept for tenants already on the older flow, or edge cases where you want raw `auditData` available in SharePoint for other downstream consumers.

## What's in this folder

| Item | Purpose |
|---|---|
| `scripts/CreateAuditLogQuery-AppReg.ps1` | Same as the modern flow. |
| `scripts/GetCopilotInteractions-AppReg.ps1` | **Different** — uploads *raw* audit records (with embedded JSON) to SharePoint. PBIP must do the JSON parsing. |
| `scripts/Get-EntraOrgData-AppReg.ps1` | Same as the modern flow. |
| `scripts/ProvisionPreReqs.ps1` | Same as the modern flow. |

There is no PBIP shipped here. If you need the legacy raw-audit dashboard, use any older `.pbit` from before the pre-parsed migration (check `git log` of [`../File/`](../File/) for pre-2026-04 versions).

## When you might genuinely need this

- A non-Power-BI consumer also reads the SharePoint CSVs and expects the raw audit schema.
- You're maintaining a tenant on the legacy flow and don't have time to migrate the PBIP.

In all other cases — **use [`../File/`](../File/) or [`../Folder/`](../Folder/)** instead.
