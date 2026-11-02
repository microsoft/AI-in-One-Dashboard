# SharePoint deployment paths

Three flavours under here. Pick one:

| Path | Use when… | What happens |
|---|---|---|
| **[`File/`](File/)** *(default)* | You want simple scheduled refresh in Power BI Service. | Script overwrites one CSV per refresh window. PBI reads that single SharePoint URL. Pre-parsed 15-column format. |
| **[`Folder/`](Folder/)** | You want full audit history accumulating in SharePoint. | Each script run leaves a fresh timestamped CSV; PBIT unions all files in the folder. Same pre-parsed format as `File/`. |
| **[`Legacy/`](Legacy/)** | You're on the older flow that uploads raw `auditData` JSON to SharePoint. | Kept for tenants on the older approach. New deployments shouldn't need this — use `File/` or `Folder/`. |

## Quick decision

```
Need history older than 30 days?
├── No  → File/  (recommended default)
└── Yes → Do you have Fabric capacity?
         ├── Yes → use ../3. Fabric/ (more robust at volume)
         └── No  → Folder/  (180-day Graph cap; CSVs accumulate in SharePoint)
```

## What all three share

- Native PBI Service refresh — no Gateway needed (SharePoint OAuth handles auth).
- App registration + service principal pattern for unattended runs.
- Same Microsoft Graph audit-log source.
- Same dashboard content / DAX.

If you're hitting 1 GB / 2-hour PBI Service refresh caps, switch to [`../3. Fabric/`](../3.%20Fabric/) — Lakehouse handles parsing upstream and gives you Direct Lake performance.
