# AI in One app

An app version of the AI in One Power BI dashboard. It shows the same metrics as the Power BI report, with the same DAX definitions, in a simpler layout: six tabs with short sub-views instead of fifteen report pages.

Everything runs in the browser. The app reads your PAX CSV exports locally and calculates every metric on the page. No data is sent anywhere.

## Get the app

There are three ways to use it. None of them needs a Power BI licence.

| Option | What you do | Best for |
|---|---|---|
| **Copilot Managed App** (recommended, preview) | Follow [Start here](../README.md#-start-here-the-app-preview) in the main README: an admin turns on two settings, then you deploy it with the `ms` CLI and share it. | Sharing it across your organisation, hosted in your Microsoft 365 tenant. |
| **Open it on your PC** | Download [`download/AI-in-One-App.html`](download/AI-in-One-App.html) (choose **Download raw file**) and open it in Edge or Chrome. | Trying it, or one person looking at the numbers. Works offline. |
| **Put it in a Fabric workspace** (the Fabric App) | Run one line in PowerShell (below). | Sharing it with your team inside Fabric. |

The app opens with a labelled synthetic sample. Choose **Change data** and drop in your PAX CSVs.

### Put it in a Fabric workspace

You need a workspace on Fabric capacity (F2 or larger, or a trial; *My workspace* won't work), the **Fabric Apps (preview)** tenant setting turned on, and Contributor or higher on the workspace. Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/microsoft/AI-in-One-Dashboard/main/app/Deploy-FabricApp.ps1 | iex
```

Paste the workspace URL from your browser when asked, and sign in when your browser opens. There's nothing to install first: [`Deploy-FabricApp.ps1`](Deploy-FabricApp.ps1) downloads a portable Node.js (only if you don't have Node.js 22.13 or later), the Fabric App deploy tool and the app into `%LOCALAPPDATA%\AI-in-One-App`, then deploys the same page as the download. It prints the app's Fabric portal link. Share the item, or give people a workspace role, so they can open it. Run the same line again to update the app.

To pass the workspace without being asked, or deploy a local copy of the page, save the script and run `.\Deploy-FabricApp.ps1 -WorkspaceUrl <url> [-TenantId <id>] [-AppHtml <path>]`.

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

If the users file is missing, licence totals show a dash and a hint to load it. If the Agent 365 file is missing, Health check says so. An interactions file with no rows is rejected, and the current data stays.

A synthetic sample in `public/sample/` loads on first open and is clearly labelled as sample data. To rebuild it from the synthetic files at the repo root, run `node scripts/prepare-sample.mjs`.

The Guide tab lists where the app deliberately differs from the Power BI report. For example, month-over-month compares the last complete month with the month before it. Agents with fewer than three users are hidden from the sessions-by-agent visuals, as a privacy floor.

## Develop

```powershell
npm install
npm run dev         # local dev server
npm run lint
npm test            # data-loading tests
npm run build       # type-check and build to dist/ (Fabric App and Managed App hosting)
npm run build:file  # build the single-file download to download/AI-in-One-App.html
```

`download/AI-in-One-App.html` is committed so people can download it, so run `npm run build:file` and commit the result whenever you change the app. The single-file build inlines the code and styles, and embeds the sample CSVs gzipped.

The code is organised like this:
- `src/data/`: CSV loading and header detection.
- `src/metrics/`: the DAX port.
- `src/ui/`: the design kit.
- `src/pages/`: the tabs.

The design system is in [DESIGN.md](DESIGN.md) and the product brief is in [PRODUCT.md](PRODUCT.md).

## Deploy

Most people should use [Get the app](#get-the-app). This section is for deploying from a clone of the repo. The same `npm run build` output runs in two hosts.

### As a Copilot Managed App

The full steps, including the admin settings, licensing and sharing, are in [Start here](../README.md#-start-here-the-app-preview) in the main README. In short, from this folder:

```powershell
npm ci              # installs the app's packages and the pinned ms CLI
npx ms auth login
npx ms app init -n "AI in One" --repo none -b ./dist -S "npm run build"   # once; add -e <environment-id> to pick an environment, or if environment lookup times out
npx ms app deploy
```

`ms app init` writes `ms.config.json` with your tenant's app and environment IDs. It's gitignored, so each deployer runs it once, and keeps it to deploy updates. Run `npx ms` in this folder: anywhere else, it looks for an unrelated npm package called `ms`.

### As a Fabric App in a Fabric workspace

The prerequisites are the same as [above](#put-it-in-a-fabric-workspace). The project config is [`rayfin/rayfin.yml`](rayfin/rayfin.yml). The app keeps no server-side data, so only auth and static hosting are on.

```powershell
npx rayfin up --dry-run
npx rayfin up --tenant <tenant-id> --workspace-id <workspace-id> -y
```

It prints the item's portal link. People need access to the item (share it, or give them a workspace role) to open it. To update, run `npx rayfin up` again. The deploy state it writes (`rayfin/.deployments.json`, `rayfin/.env`) is gitignored.
