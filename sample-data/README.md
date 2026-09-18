# 🧪 Synthetic sample data — Rollup Edition

This folder contains **fully synthetic, fictional demo data** in the exact format the
**AI-in-One Dashboard — Rollup Edition** consumes, so you can open the template and
explore every page **without a tenant, without Purview access, and without PAX**.

> ⚠️ **No real data.** Every user, agent, document, interaction and timestamp here is
> invented for the fictional *Contoso Ltd* tenant. Nothing in this folder originates
> from, or represents, any real Microsoft 365 tenant, customer, or person.
> Use it for demos, training, UI walkthroughs, and template testing only — never as a
> benchmark or as a basis for real adoption or licensing decisions.

---

## 📦 What's in here

| File | PBIT parameter it feeds | Contents |
|---|---|---|
| `Purview_Audit_Synthetic_<timestamp>_Interactions.csv` | **Copilot Interactions File** | ~18k rolled-up Copilot / Agent interaction rows over a 90-day window |
| `EntraUsers_MAClicensing_Synthetic_<timestamp>_Users.csv` | **Org Data File** | 150 users with organization, job title, location and licence flags |
| `Agent365_Synthetic_<timestamp>.csv` | **Agent 365 (highly recommended)** | 18-agent registry snapshot that joins to the interactions on `Title ID` |

All three are produced by [`../scripts/Generate_Synthetic_Rollup_Data.ps1`](../scripts/Generate_Synthetic_Rollup_Data.ps1).

---

## ▶️ How to use it

1. Download the [Rollup Edition template](../README.md#-which-edition-should-i-download) and open the `.pbit` in Power BI Desktop.
2. When prompted for parameters, paste the **full local path** to each file above.
   *(Use the 3-in-1 auto-detect edition — the PBI-SharePoint edition only accepts SharePoint URLs.)*
3. Click **Load**. Every page populates.

To load these files in the **PBI-SharePoint** edition instead, upload all three to the same
SharePoint document library and pass the Details-pane **Path** URLs.

---

## 🔁 Regenerating / resizing the data

The generator is a single self-contained PowerShell script — no modules, no Python required.

```powershell
# Defaults: 150 users, 90 days, ending today, writes to .\sample-data
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Generate_Synthetic_Rollup_Data.ps1

# Bigger tenant, longer history, different random draw
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Generate_Synthetic_Rollup_Data.ps1 `
    -UserCount 2000 -Days 180 -Seed 42 -OutDir "C:\Data\Synthetic"
```

| Parameter | Default | Notes |
|---|---|---|
| `-OutDir` | `.\sample-data` | Output folder (created if missing) |
| `-UserCount` | `150` | Size of the synthetic Entra population |
| `-Days` | `90` | Length of the activity window |
| `-EndDate` | today | Last day of the window |
| `-Seed` | `20260918` | Change for a different — but still reproducible — dataset |
| `-LicensedShare` | `0.55` | Baseline share of users with an M365 Copilot licence (varied per department) |
| `-Domain` | `contoso.com` | UPN / email domain |
| `-Quiet` | off | Suppress the summary output |

The same seed always produces the same files.

---

## 🧬 How faithful is it?

The generator emits the rollup format **directly**, and every classification /
derived column is a verbatim port of the logic in
[`../scripts/Rollup_Processor_v3.0.0.py`](../scripts/Rollup_Processor_v3.0.0.py):

- `FACT_HEADER` column set and ordering (36 columns, grain keys → `Message_Id` → non-grain attributes)
- `License Status`, `Environment`, `Autonomy_Pattern`, `AI_Model`, `Is_Sensitive`
- `Behavior_Category` (resource-first, then Enterprise Search plugin, then context/app-host fallback)
- `Behavior_Enriched`, `Behavior_Source`, `Value_Outcome`
- `CreationDate` / `WeekStart` (Monday-based) / `MonthStart` / `ActivityDate` / `UserMonthKey`
- INT surrogate keys for `UserKey`, `ThreadId` and `Message_Id`, with `UserKey` shared between the fact and Users files

The Users file reproduces the processor's renames and injected columns
(`PersonId`, `Organization`, `JobTitle`, `Has license` canonicalised to `TRUE`/`FALSE`,
plus `UserKey`, `PersonId_Normalized`, `License Status`, `TotalEmployees`).
The Agent 365 file matches the column set the template expects and is written
**without quoting or embedded commas**, because the template reads it with
`QuoteStyle.None`.

### Shape of the synthetic tenant

- **Engagement archetypes** — power / regular / occasional / trialist / dormant users, so active-user and frequency visuals show a realistic long tail
- **Adoption ramp** — usage grows across the window, with weekday peaks and weekend troughs
- **Uneven licence rollout** — Sales, Executive and Engineering skew licensed; Operations and Legal skew unlicensed
- **Surface mix** — Outlook, Word, Excel, PowerPoint, Teams, BizChat, SharePoint, Stream, Designer, OneNote, Loop, Planner, Forms, Power BI, Copilot Studio, Cowork
- **Agents** — 15 declarative agents plus 3 autonomous agents, whose names intentionally exercise every agent-classification rule (coaching, research, sales, HR, compliance, service desk, content, data, knowledge base, ideation)
- **Multi-prompt threads**, a minority of sensitivity-labelled interactions, and a handful of registered-but-unused agents so the agent review visuals have something to flag
