# SharePoint deployment

Two SharePoint patterns are available — pick the one that fits your scenario:

| Sub-path | When to use |
|---|---|
| **[Single File/](Single%20File/)** *(recommended default)* | Standard scheduled refresh. Script overwrites one CSV per refresh window. No folder iteration, no privacy firewall errors, simplest M-query. Covers 80% of real customer deployments. |
| **[Folder/](Folder/)** *(advanced)* | You need >30 days of accumulated history and don't have Fabric capacity. Folder iteration auto-unions all daily CSVs. Has well-documented pitfalls — read the README before deploying. |

## Which one should I use?

```
Are you a customer with > 100K events/week?
├── No  → Single File (rolling 30 days is plenty)
└── Yes → Do you have Fabric capacity?
         ├── Yes → use Fabric path instead (../3. Fabric/), not SharePoint at all
         └── No  → Folder (180-day cap, but accept the additional fragility)
```

## What both paths share

- Native PBI Service refresh — no Gateway required
- App registration + service principal pattern for unattended automation
- Same script source (audit log via Microsoft Graph)
- Same dashboard content / DAX

## What's different

| | Single File | Folder |
|---|---|---|
| **CSV pattern** | One file overwritten on each script run | Multiple dated files accumulate over time |
| **PBI source** | Single SharePoint URL | SharePoint folder iteration via `SharePoint.Files()` |
| **Privacy firewall risk** | None — single static URL | High — common cause of refresh failures |
| **Dedup logic** | Not needed | Required (M-query has it) |
| **History ceiling** | Last 30 days (script's pull window) | Up to 180 days (Graph API cap) |
| **Setup complexity** | ⭐ | ⭐⭐⭐ |

## When to escape SharePoint entirely

If you're hitting the 1 GB / 2-hour PBI refresh caps on shared capacity, or your customer needs multi-year history, switch to [`../3. Fabric/`](../3.%20Fabric/). Fabric Lakehouse handles upstream parsing and gives you Direct Lake performance.
