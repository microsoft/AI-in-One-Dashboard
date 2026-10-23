# AI in One: App Edition

A Copilot Managed App version of the AI in One Power BI dashboard. It shows the same metrics as the Power BI report, with the same DAX definitions, in a simpler layout: six tabs with short sub-views instead of fifteen report pages.

Everything runs in the browser. The app reads your PAX CSV exports locally and calculates every metric on the page. No data is sent anywhere.

## Tabs

| Tab | Views | Power BI pages it replaces |
|---|---|---|
| Overview | Trends, Leaderboard | Copilot Overall: Combined Trends, Combined Leaderboard |
| M365 Copilot | Trends, Leaderboard, Habits | M365 Copilot: Usage Trends, Leaderboard, Habit Formation |
| Copilot Chat | Trends, Leaderboard, Habits | Chat (Web): Usage Trends, Leaderboard, Habit Formation |
| Agents | Trends, Leaderboard, Habits, Health check, Use cases | Agents: Usage Trends, Leaderboard, Habit Formation, Health Check, Use Cases |
| Licence priority | — | License Prioritisation |
| Guide | — | Metric Glossary & Guide, plus the differences from Power BI |

The toolbar filters (date range, organisation, usage rank, licence and the agent filters) apply to the tab you are on, and only the relevant ones are shown. Each metric has an info button that shows its glossary definition.

## Data

Click **Change data** in the header and drop in your PAX CSVs. The app works out each file's type from its column headers:

| File | Detected by | Required |
|---|---|---|
| Purview audit interactions | `ThreadId` and `UserKey` | Yes |
| Entra users with licensing | `UserKey` plus `Organization` or `Has license` | Recommended (organisation filter and licence pages) |
| Agent 365 inventory | `Agent name` | Optional (agent health and use cases) |

A synthetic sample in `public/sample/` loads on first open and is clearly labelled as sample data. To rebuild it from the synthetic files at the repo root, run `node scripts/prepare-sample.mjs`.

The Guide tab lists where the app deliberately differs from the Power BI report. For example, month-over-month compares the last complete month with the month before it. Agents with fewer than three users are hidden from the sessions-by-agent visuals, as a privacy floor.

## Develop

```powershell
npm install
npm run dev       # local dev server
npm run lint
npm run build     # type-check and build to dist/
```

The code is organised like this:
- `src/data/`: CSV loading and header detection.
- `src/metrics/`: the DAX port.
- `src/ui/`: the design kit.
- `src/pages/`: the tabs.

The design system is in [DESIGN.md](DESIGN.md) and the product brief is in [PRODUCT.md](PRODUCT.md).

## Deploy

The same build runs in two hosts. Pick one.

### As a Fabric App in a Fabric workspace

You need a workspace on Fabric capacity (F2 or larger, or a trial; *My workspace* won't work) and the **Fabric Apps (preview)** tenant setting turned on. The project config is [`rayfin/rayfin.yml`](rayfin/rayfin.yml). The app keeps no server-side data, so only auth and static hosting are on.

```powershell
npx rayfin up --dry-run
npx rayfin up --tenant <tenant-id> --workspace-id <workspace-id> -y
```

It prints the item's portal link. People need access to the item (share it, or give them a workspace role) to open it. To update, run `npx rayfin up` again. The deploy state it writes (`rayfin/.deployments.json`, `rayfin/.env`) is gitignored.

### As a Copilot Managed App

You need the `ms` CLI, signed in to the target tenant. `ms app init` writes `ms.config.json` with your tenant's app and environment IDs. It's gitignored, so each deployer runs it once.

```powershell
ms app init -n "AI in One" --repo none -b ./dist -S "npm run build"   # add -e <environment-id> if environment lookup times out
ms app deploy
```
