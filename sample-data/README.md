<div align="center">

# 🧪 Sample data

### Try the AI-in-One dashboard v2.0.0 in minutes, before you export your own data

**[⬅️ Back to README](../README.md)** &nbsp;·&nbsp; **[⬇️ Download the dashboard](../README.md#-choose-your-edition)** &nbsp;·&nbsp; **[🖼️ Screenshot tour](../Report%20Screenshots.md)**

</div>

This folder holds made-up data for a fictional organization of **10,050 people** across two companies, **Contoso** and **Fabrikam**. It's the same data shown in the [screenshot tour](../Report%20Screenshots.md) and the What's New video. Load it into the dashboard to click through all 17 pages. You don't need a Microsoft 365 tenant, admin permissions or PAX.

> [!WARNING]
> **Everything here is made up.** Every person, manager, agent, conversation and date is invented. Use it to learn, demo and test the dashboard, never as a benchmark or as a basis for real adoption or licensing decisions.

## 📦 What's in the folder

| Template parameter | File | What's inside |
|---|---|---|
| **Copilot Interactions File** | 📦 [Interactions (zip)](AIO_Realistic_Interactions.zip) <sub>(25 MB; 469 MB unzipped)</sub> | 1,202,114 rows of Copilot and agent activity from June 22 to September 18, 2026 |
| **Org Data File** | 📄 [Users](AIO_Realistic_Users.csv) <sub>(2.4 MB)</sub> | 10,050 people in 2 companies, 5 divisions, 11 departments and 9 countries, with a full reporting hierarchy: 6,499 with a Microsoft 365 Copilot license and 3,551 without |
| **Agent 365** | 📄 [Agents](AIO_Realistic_Agents.csv) <sub>(664 KB)</sub> | A catalog of 1,206 agents |

The full file names are `AIO_Realistic_Interactions.zip` (it contains `AIO_Realistic_Interactions.csv`), `AIO_Realistic_Users.csv` and `AIO_Realistic_Agents.csv`.

## ▶️ Try it in four steps

**1. Download the files and unzip the activity file.** Select each file in the table above, then select **⬇️ Download raw file** on the right of the file's toolbar. Extract `AIO_Realistic_Interactions.csv` from the zip; the dashboard reads the `.csv`, not the zip. To get everything at once, go to the [repository home page](https://github.com/microsoft/AI-in-One-Dashboard) and select **Code → Download ZIP**.

**2. Put the three `.csv` files where your edition can read them.**

- 💻 **Local CSV edition:** put them in any folder on your PC. In File Explorer, select each file, choose **Copy as path**, paste it and remove the quotation marks, for example `C:\AIO sample\AIO_Realistic_Users.csv`.
- 🟦 **SharePoint edition:** upload them to a SharePoint document library. For each file, select it, choose **⋮ → Details**, then copy **Path**.

**3. Open the template** for your edition in Power BI Desktop and paste the three paths. Keep **Minimum Group Size** at **3** for team-level views, or set it to **1** to explore the individual views too. Every name is made up.

**4. Select Load.** With about 1.2 million rows, the first load takes a few minutes. The report opens on **🧭 Copilot Usage Explorer**, and every page fills with data.

## 👀 What you'll see

- **A realistic adoption story.** 9,246 of the 10,050 people show activity, with use growing across the 90 days, busy weekdays, quiet weekends and a mix of power, regular, occasional and inactive users.
- **A complete organization chart.** Everyone except the top leader has a manager, so **Org filters → Reporting team** works just as it would with your own data: search for a manager and see their whole organization. **Company** and **Division** are filled in too.
- **A mixed license rollout.** About two-thirds of people have a Microsoft 365 Copilot license, so **License Prioritization** and the **Chat (Web)** pages have plenty to compare.
- **Every Copilot experience.** Activity covers licensed Microsoft 365 Copilot, Copilot Chat, agents, autonomous agents and Cowork.
- **Agents to review.** 1,005 of the 1,206 catalog agents are used and 201 are registered but never used, so **Agents: Health Check** has agents to flag.

## 🚀 Ready for your own data?

Follow the **[four setup steps in the README](../README.md#-quick-start)**: prepare, export with PAX, open the template and publish.

<div align="center">

Built and maintained by the **Microsoft Copilot Analytics team** &nbsp;·&nbsp; More free reports at **[aka.ms/Analytics-Hub](https://aka.ms/Analytics-Hub)**

</div>
