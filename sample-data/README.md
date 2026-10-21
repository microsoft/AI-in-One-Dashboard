<div align="center">

# 🧪 Sample data

### Try the AI-in-One dashboard v2.0.0 in minutes, before you export your own data

**[⬅️ Back to README](../README.md)** &nbsp;·&nbsp; **[⬇️ Download the dashboard](../README.md#-choose-your-edition)** &nbsp;·&nbsp; **[🖼️ Screenshot tour](../Report%20Screenshots.md)**

</div>

This folder holds made-up data for a fictional organization of **10,050 people** across two companies, **Contoso** and **Fabrikam**. The current [screenshot tour](../Report%20Screenshots.md) uses these files; the What's New video may show an earlier report layout. Load the files into the dashboard to click through all 17 pages. You don't need a Microsoft 365 tenant, admin permissions or PAX.

> [!WARNING]
> **Everything here is made up.** Every person, manager, agent, conversation and date is invented. Use it to learn, demo and test the dashboard, never as a benchmark or as a basis for real adoption or licensing decisions.

## 📦 What's in the folder

| Template parameter | File | What's inside |
|---|---|---|
| **Copilot Interactions File** | 📦 [Interactions (zip)](AIO_Realistic_Interactions.zip) <sub>(26 MB; 469 MB unzipped)</sub> | 1,202,114 rows of Copilot and agent activity from June 22 to September 18, 2026 |
| **Org Data File** | 📄 [Users](AIO_Realistic_Users.csv) <sub>(2.4 MB)</sub> | 10,050 people in 2 companies, 5 divisions, 11 departments and 9 countries, with a full reporting hierarchy: 6,499 with a Microsoft 365 Copilot license and 3,551 without |
| **Agent 365** | 📄 [Agents](AIO_Realistic_Agents.csv) <sub>(669 KB)</sub> | A catalog of 1,206 agents |

The full file names are `AIO_Realistic_Interactions.zip` (it contains `AIO_Realistic_Interactions.csv`), `AIO_Realistic_Users.csv` and `AIO_Realistic_Agents.csv`.

## ▶️ Try it in four steps

**1. Download the files and unzip the activity file.** Select each file in the table above, then select **⬇️ Download raw file** on the right of the file's toolbar. Extract `AIO_Realistic_Interactions.csv` from the zip; the dashboard reads the `.csv`, not the zip. To get everything at once, go to the [repository home page](https://github.com/microsoft/AI-in-One-Dashboard/tree/preview) and select **Code → Download ZIP**.

**2. Put the three `.csv` files where your edition can read them.**

- 💻 **Local CSV edition:** put them in any folder on your PC. In File Explorer, select each file, choose **Copy as path**, paste it and remove the quotation marks, for example `C:\AI-in-One sample\AIO_Realistic_Users.csv`.
- 🟦 **SharePoint edition:** upload them to a SharePoint document library. For each file, select it, choose **⋮ → Details**, then copy **Path**.

> [!NOTE]
> **Exploring the Fabric OneLake edition?** Use these files with the **Local CSV** edition. It has the same 17 pages, metrics and privacy controls and needs nothing but Power BI Desktop. The Fabric OneLake template reads only Lakehouse tables built by its preparation notebook, which adds snapshot and publication checks that plain CSV files don't have, so loading these files straight into Lakehouse tables won't work.

**3. Open the template** for your edition in Power BI Desktop and paste the three paths. Keep **Minimum Group Size** at **3** for team-level views, or set it to **1** to explore the individual views too. Every name is made up.

**4. Select Load.** With about 1.2 million rows, the first load takes a few minutes. The report opens on **🧭 Copilot Usage Explorer**, and every page fills with data.

## 👀 What you'll see

- **A realistic adoption story.** 9,246 of the 10,050 people show activity, with use growing across the 89 recorded days, busy weekdays, quiet weekends and a mix of power, regular, occasional and inactive users.
- **A complete organization chart.** Everyone except the top leader has a manager, so **Org filters → Reporting team** works just as it would with your own data: search for a manager and see their whole organization. **Company** and **Division** are filled in too.
- **A mixed license rollout.** About two-thirds of people have a Microsoft 365 Copilot license, so **License Prioritization** and the **Copilot Chat (Unlicensed)** pages have plenty to compare. Licensed directory headcount remains distinct from recorded activity.
- **Every Copilot experience.** Activity covers licensed Microsoft 365 Copilot, Copilot Chat, agents, autonomous agents and Cowork.
- **Agents to review.** 1,005 of the 1,206 catalog agents are used and 201 are registered but never used, so **Agents: Health Check** has agents to flag.
- **Explicit catalog metadata.** All 1,206 sample agents have a legacy creator value; Creator is visible at Minimum Group Size 3 and 1. This sample does not provide Developer Name, so that column displays **Not stated** rather than inventing a developer. All activity agents match the catalog, so **Activity-only agents** is 0.
- **Meaningful return-rate blanks.** Three active sample agents have no repeat users and show **0%**. The 201 unused catalog agents retain blank Return Rate. The 469 agents whose only listed Copilot surface is M365 Copilot Chat include 67 unused agents; Features identifies that supported surface.
- **Current agent-platform names.** The retired Copilot Studio Lite source label has been replaced with **Microsoft 365 Copilot Agent Builder**. The dashboard displays **Agent Builder**. This field-only correction does not change identities, creators, activity, sessions, prompts or the Users file.
- **Friendly app names.** App labels use recognizable products, such as **M365 Copilot Chat** for bizchat. The raw AppHost remains available for support.
- **Clearer trends and units.** Explorer's month-start dots sit on its bold 7-day session and prompt trends; **Activity by experience** switches between the two metrics. Weekly usage-rank charts pair prompts and sessions, and License Prioritization's median and vertical scale follow its selected weekly metric.
- **Agent engagement and navigation.** Use Cases compares eligible agents using equal-weight percentile ranks of return rate, sessions per user and prompts per session, with at least **MAX(Minimum Group Size, 5)** users. The Leaderboard adds scoped **Most used agent** and **Agents used** columns. Selected-agent drillthrough now explains its scope and offers **Open Agent Details** for the full agent list.
- **Interpretable blanks.** Dormant means previously used, never-used agents remain **No usage**, and **Not enough activity to infer** avoids inventing a use case. Creator filtering includes matching no-usage catalog entries without disclosing protected usage.

The [screenshot tour](../Report%20Screenshots.md) uses these synthetic files at **Minimum Group Size 1** to illustrate optional detail. Templates still default to **3**; real-data individual views require approval. Prompts and sessions share consistent table color formatting, and prompt-count footers explain coverage differences.

**Reporting hierarchy:** a blank PAX **Manager_UserKey** means top of chain. A manager outside the users file also makes that person a root, rather than hiding their descendants' reporting levels. Any unresolved-manager status applies only to the affected person; the unmodified sample hierarchy is unchanged.

## Large-organization licensing assumptions

The sample represents an organization with more than 2,000 paid seats. From **April 15, 2026**, its unlicensed people do not generate non-agent activity inside Word, Excel, PowerPoint or OneNote. They can use supported Copilot Chat surfaces and agents. Licensed users' in-app activity is preserved.

The current June 22-September 18 window contains **zero** unsupported unlicensed non-agent rows. The sample preserves all **10,050 people**, **1,202,114 prompts** and **399,856 user/thread sessions**, including unlicensed agent activity. It is a deterministic illustration of the large-organization scenario, not a statement about a particular tenant's rollout date.

| AppHost | Unlicensed activity rows |
|---|---:|
| `bizchat` | 247,632 |
| `teams` | 55,878 |
| `autonomous` | 5,561 |
| `logic app` | 2,747 |
| `copilot studio` | 2,211 |

Agent and other-AI activity is retained and classified separately from chat. With the SharePoint template's existing chat-host list, **zero unlicensed rows remain Unclassified activity** in this sample.

### Reproduce the surface-policy update

The [synthetic generator](../scripts/Generate_Synthetic_Rollup_Data.ps1) retains its deterministic seed and applies the date/license/agent rule to newly generated sessions. Its existing-sample mode preserves the accepted realistic names, hierarchy, IDs, dates and totals:

```powershell
.\scripts\Generate_Synthetic_Rollup_Data.ps1 `
  -ExistingSampleDirectory .\sample-data `
  -OutDir .\_temp\sample-candidate
```

Use a new output directory. This mode never overwrites the input exports. It writes the three CSVs with LF line endings and a zip with fixed archive metadata. Repeating it on the corrected sample produces identical CSV and zip bytes. The Users and Agents files are unchanged by this surface-only update.

## 🚀 Ready for your own data?

Follow the **[four setup steps in the README](../README.md#-quick-start)**: prepare, export with PAX, open the template and publish.

<div align="center">

Built and maintained by the **Microsoft Copilot Analytics team** &nbsp;·&nbsp; More free reports at **[aka.ms/Analytics-Hub](https://aka.ms/Analytics-Hub)**

</div>
