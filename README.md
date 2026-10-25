<div align="center">

<br>

# 🧠 AI-in-One Dashboard

### One dashboard for all Microsoft Copilot and agent adoption signals, as an app or a Power BI report.

<br>

All reports and guides can be found on the [Analytics Hub](https://microsoft.github.io/Analytics-Hub/).

**Cowork Billing:** [https://microsoft.github.io/Analytics-Hub/cowork-billing/](https://microsoft.github.io/Analytics-Hub/cowork-billing/)

**Also see [ValueLens](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot):** the next step on from AI in One, with full task-level activity, more focus on Cowork, model fit and efficiency, and comprehensive value estimation.

**Also see [Analytics Hub for Microsoft Copilot](https://github.com/microsoft/AnalyticsHub-Dashboard):** one installer sets up an app on Microsoft Fabric or Azure that shows Copilot and agent adoption, value, consumption and governance in one place.

<br>

**Found this useful? ⭐ Star this repo to help others discover it!**

<br>

**[Videos](#videos)** &nbsp;·&nbsp; **[Before you start](#before-you-start)** &nbsp;·&nbsp; **[Choose your path](#choose-your-path)** &nbsp;·&nbsp; **[After setup](#after-setup)**

<br>

</div>

<a id="-watch-first"></a>

## Videos

**Overview: what the dashboard measures, page by page** *(2m 40s)*

https://github.com/user-attachments/assets/37f84c0c-125d-4814-890d-14001d5a3127

**Setup guide: getting your own data in, start to finish** *(10m 12s)*

https://github.com/user-attachments/assets/036ab946-7fa2-411b-b70a-e512e2028778

Both play here in the page.
The [Video Guide](docs/Video-Guide.md) has timestamped chapters for both.
It's also a [Word document](docs/AI-in-One-Dashboard-Video-Guide.docx?raw=1).

<a id="-dashboard-preview"></a>

![AI-in-One Dashboard animated preview](https://github.com/microsoft/AI-in-One-Dashboard/raw/main/Images/AIO%20v10%20Gif.gif)

<a id="-what-this-dashboard-provides"></a><a id="-how-this-helps-leaders"></a>

## What you get

- Microsoft 365 Copilot, Copilot Chat and agent usage, in one place.
- Adoption trends, leaderboards and habits, by department.
- **The app** in your browser, or a Power BI report. Both show the same numbers.

<a id="what-you-need"></a>

## Before you start

| You need | Why |
|---|---|
| Unified audit logging turned on in Microsoft Purview | Every number comes from the audit log. Turning it on doesn't backfill, so [do it early](docs/get-your-data.md#audit-logging). |
| An admin who can export the audit log and user data | To run [PAX](https://github.com/microsoft/PAX), or to consent to the installer's app registration. |
| A Power Platform admin | To turn on two settings, so you can deploy **the app**. |
| Power Apps Premium or Copilot Credits, for each viewer of the app | To open the app. No Power BI licence is needed. |
| Power BI Desktop, and Power BI Pro or Premium Per User | Only for the Power BI report. Pro or PPU is to publish and share it. |
| A Windows 10 or 11 PC with PowerShell | To run the installer or PAX. |

<a id="-email-your-admin"></a>

**Need an admin?** [Email the prerequisites to your IT admin](mailto:?subject=Action%20Required%3A%20Data%20Export%20Fields%20Needed%20for%20AI-in-One%20Dashboard%20%28Power%20BI%29&body=To%3A%20IT%20Admin%20%2F%20Global%20Admin%0ARe%3A%20AI-in-One%20Dashboard%20%E2%80%93%20Power%20BI%20Report%20Setup%0A%0A%0AWHAT%20THIS%20REPORT%20DOES%0A%0AThe%20AI-in-One%20Dashboard%20is%20a%20Power%20BI%20report%20that%20provides%20a%20comprehensive%20view%20of%20Microsoft%20365%20Copilot%2C%20unlicensed%20Copilot%20Chat%2C%20agent%20usage%2C%20and%20third-party%20AI%20adoption%20across%20your%20organization.%20It%20consolidates%20four%20data%20sources%20into%20a%20single%20dashboard%20for%20adoption%20tracking%2C%20license%20optimization%2C%20and%20enablement%20planning.%0A%0A%0ADATA%20SOURCES%20REQUIRED%0A%0A1.%20Microsoft%20Purview%20%E2%80%93%20Copilot%20Audit%20Logs%0A%20%20%20Export%3A%20Purview%20portal%20%28security.microsoft.com%29%20-%3E%20Audit%20-%3E%20Export%2C%20or%20PAX%20PowerShell%20script%0A%20%20%20Format%3A%20CSV%0A%0A2.%20Microsoft%20Entra%20ID%20%E2%80%93%20User%2FOrg%20Data%20%28includes%20license%20data%29%0A%20%20%20Export%3A%20entra.microsoft.com%20-%3E%20Identity%20-%3E%20Users%20-%3E%20Download%20users%2C%20or%20PAX%20script%20with%20-IncludeUserInfo%0A%20%20%20Format%3A%20CSV%0A%0A3.%20Microsoft%20365%20Admin%20Center%20%E2%80%93%20Agent%20365%20Inventory%0A%20%20%20Export%3A%20admin.microsoft.com%20-%3E%20Agents%20-%3E%20All%20Agents%20-%3E%20Export%20to%20Excel%0A%20%20%20Format%3A%20XLSX%0A%0A4.%20%28if%20not%20using%20PAX%29%20Microsoft%20365%20Admin%20Center%20%E2%80%93%20Licensed%20Users%0A%20%20%20Export%3A%20admin.microsoft.com%20-%3E%20Reports%20-%3E%20Usage%20-%3E%20M365%20Copilot%20-%3E%20Readiness%20tab%20-%3E%20Export%0A%20%20%20Format%3A%20CSV%0A%0ANote%20on%20license%20data%3A%20The%20report%20requires%20a%20hasLicense%20flag%20to%20split%20licensed%20vs.%20unlicensed%20Copilot%20usage.%20The%20PAX%20script%20automatically%20adds%20this%20column%20to%20the%20Entra%20user%20export%20%E2%80%94%20no%20separate%20file%20needed.%20If%20you%20are%20exporting%20manually%20from%20Entra%2C%20you%20will%20also%20need%20the%20M365%20Admin%20Center%20licensed%20users%20file%20%28source%20%234%29%20and%20provide%20it%20as%20a%20separate%20input%20to%20the%20template.%0A%0A%0AREQUIRED%20FIELDS%20%E2%80%94%20DO%20NOT%20REMOVE%0A%0AIMPORTANT%3A%20If%20you%20are%20running%20a%20PAX%20Purview%20agent%20extract%20or%20manually%20exporting%20from%20Purview%2C%20do%20not%20prune%20or%20remove%20columns%20from%20the%20output%20files.%20The%20report%20will%20silently%20break%20or%20produce%20blank%20visuals%20if%20any%20of%20the%20following%20fields%20are%20missing.%0A%0APurview%20Audit%20Log%20%28CopilotInteraction%20%2F%20ConnectedAIAppInteraction%20%2F%20AIAppInteraction%29%3A%0ACreationDate%2C%20UserId%2C%20Operations%2C%20AppHost%2C%20ThreadId%2C%20AgentId%2C%20AgentName%2C%20AISystemPlugin_Id%2C%20AISystemPlugin_Name%2C%20Context_Type%2C%20Message_isPrompt%2C%20ModelTransparencyDetails_ModelName%2C%20Workload%2C%20OrganizationId%2C%20AppIdentity_DisplayName.%0A%0AMicrosoft%20Entra%20ID%20%E2%80%93%20User%20Export%3A%0AUserPrincipalName%2C%20Department%2C%20JobTitle%2C%20displayName%2C%20hasLicense%20%28added%20automatically%20by%20PAX%3B%20or%20use%20the%20M365%20Admin%20Center%20licensed%20users%20file%20if%20exporting%20manually%29%2C%20Manager%2C%20Office%2C%20City%2C%20Country.%0A%0AM365%20Admin%20Center%20%E2%80%93%20Licensed%20Users%20%28manual%20export%20path%20only%29%3A%0AUserPrincipalName%2C%20Has%20Copilot%20License%20Assigned.%0A%0AAgent%20365%20Inventory%3A%0AName%2C%20Host%20Products%2C%20Created%20Date%2C%20Developer%20User%20ID%2C%20Description%2C%20Status%2C%20Version.%0A%0A%0AINSIGHTS%20YOU%20WILL%20GAIN%0A%0A-%20Active%20Copilot%20users%20and%20interaction%20volume%20by%20week%2Fmonth%0A-%20Surface%20breakdown%3A%20which%20apps%20%28Teams%2C%20Word%2C%20Outlook%2C%20BizChat%2C%20etc.%29%20users%20are%20engaging%20with%0A-%20Agent%20adoption%3A%20which%20agents%20are%20used%2C%20by%20how%20many%20users%2C%20on%20which%20surfaces%0A-%20AI%20model%20distribution%20across%20interactions%0A-%20Licensed%20vs.%20unlicensed%20usage%20patterns%0A-%20Session%20depth%20and%20prompt%20volume%20per%20user%20cohort%0A-%20Third-party%20and%20custom%20AI%20app%20usage%20alongside%20M365%20Copilot%0A%0A%0AROLES%20%26%20PERMISSIONS%20REQUIRED%0A%0AExport%20Purview%20audit%20logs%3A%20Audit%20Reader%20or%20Compliance%20Administrator%0AExport%20Entra%20user%20data%20%28includes%20hasLicense%20via%20PAX%29%3A%20User%20Administrator%20or%20Global%20Reader%0AExport%20Agent%20365%20inventory%3A%20AI%20Admin%20or%20Global%20Reader%0AExport%20M365%20Admin%20Center%20licensed%20users%20%28manual%20path%20only%29%3A%20Global%20Administrator%20or%20Reports%20Reader%0ARun%20PAX%20PowerShell%20script%20%28automated%20export%29%3A%20Audit%20Reader%20%2B%20Microsoft%20Graph%20API%20permissions%20%28AuditLog.Read.All%2C%20User.Read.All%2C%20Organization.Read.All%29%0A%0A%0ASOFTWARE%20REQUIREMENTS%0A%0A-%20Power%20BI%20Desktop%20%28free%20download%20from%20Microsoft%29%20%E2%80%94%20required%20to%20open%20the%20.pbit%20template%0A-%20PowerShell%205.1%2B%20%E2%80%94%20required%20only%20if%20using%20the%20PAX%20automated%20export%20script%0A-%20Microsoft%20Graph%20PowerShell%20module%20%E2%80%94%20required%20only%20for%20PAX%20script%20%28Install-Module%20Microsoft.Graph.Beta.Security%29%0A-%20Access%20to%3A%20security.microsoft.com%2C%20admin.microsoft.com%2C%20entra.microsoft.com%0A%0A%0ANote%20on%20Usernames%20in%20Reports%3A%0AIf%20user%20names%20appear%20concealed%20in%20M365%20Admin%20Center%20exports%2C%20go%20to%20Settings%20-%3E%20Org%20Settings%20-%3E%20Services%20-%3E%20Reports%20and%20uncheck%20%22Display%20concealed%20user%2C%20group%2C%20and%20site%20names%20in%20all%20reports%22%20before%20exporting.).
It lists the data, roles and permissions they need.

**Just want a look?** Download [the app as one file](app/download/AI-in-One-App.html) (select **Download raw file**).
Open it in Edge or Chrome. It runs on sample data, with nothing to install.

## Choose your path

| Path | Best for |
|---|---|
| **[Installer](#installer)** (recommended, fastest) | Most people. It asks a few questions in your browser, sets everything up and refreshes it daily. |
| **[Manual](#manual)** (step by step) | You want to control each step, or your organisation can't run the installer. |

## Installer

1. Check you have the [prerequisites](installer/README.md#prerequisites).
2. On the Windows PC that will run it, open PowerShell and paste:

   ```powershell
   irm https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.2.0/install.ps1 | iex
   ```

   Or [download the exe](https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.2.0/AIInOneInstaller.exe).
   Locked-down PC? See [other ways to start it](installer/README.md#locked-down-tenant--azure-cloud-shell).
3. It opens in your browser. Choose where your data comes from:
   - **PAX, on this Windows PC**: sets up **the app** and the Power BI report. No Fabric needed.
   - **Fabric**: sets up the report on a Fabric capacity.
4. Choose **Set up AI in One** and sign in.
5. Answer each question under **Setup settings**. The defaults suit most organisations.
6. Check the plan and choose **Go ahead**. Nothing is created until you do.
7. When it finishes, share the report when asked, then open the link it gives you.

The full guide: [AI in One installer](installer/README.md).

<a id="-start-here-the-app-preview"></a><a id="-app-edition-preview"></a><a id="deploy-it"></a><a id="-where-your-data-comes-from-pax"></a><a id="-important--required-input-file-format"></a><a id="-what-is-pax"></a><a id="-get-your-data--run-pax-to-produce-the-files"></a><a id="-multi-month-history--the--appendfile-switch--what-works-today"></a><a id="️-standalone-processor--processing-raw-data-without-pax"></a>

## Manual

1. **Turn on audit logging.** [Check it's on](docs/get-your-data.md#audit-logging) in Microsoft Purview.
2. **Get your data with PAX.** Run [PAX](https://github.com/microsoft/PAX) with `-Rollup` to make the data files. See [Get your data](docs/get-your-data.md).

   ```powershell
   .\PAX_Purview_Audit_Log_Processor.ps1 -Rollup -IncludeAgent365Info -OutputPath "C:\Data\PAX"
   ```

3. **Deploy the app.** An admin turns on two settings, then you deploy it with the `ms` CLI and share it. See [Deploy the app](docs/deploy-the-app.md).
4. **Or use the Power BI report.** Download a template, open it in Power BI Desktop and paste in where your files are. See [The Power BI report](docs/power-bi-report.md).

## After setup

- **Check it worked.** The app shows your dates, without the sample data label. The report pages show data.
- **Installer users:** start the installer again and choose **Check status**. See [Check it worked](installer/README.md#check-it-worked).
- **Keep it fresh.** The installer refreshes every day. Manually, run PAX again, then choose **Change data** in the app or refresh the report. See [multi-month history](docs/get-your-data.md#appendfile) and [scheduled refresh](docs/power-bi-report.md#-set-up-scheduled-refresh-in-power-bi-service).
- **Update the app.** Run `git pull`, `npm ci` and `npx ms app deploy` in the `app` folder.
- **Get help.** See [Troubleshooting](#troubleshooting), or [open an issue](https://github.com/microsoft/AI-in-One-Dashboard/issues).

---

<a id="-the-power-bi-report"></a><a id="-ai-in-one-dashboard--rollup-edition"></a><a id="-which-edition-should-i-download"></a><a id="why-are-there-two-editions"></a><a id="-how-this-version-is-different--and-why-it-loads-so-much-faster"></a><a id="-open-and-configure-the-power-bi-template"></a><a id="-set-up-scheduled-refresh-in-power-bi-service"></a><a id="-review-and-customize"></a><a id="-version-history"></a><a id="-related-resources"></a><a id="-license"></a><a id="-security"></a>

<details>
<summary><strong>Reference</strong></summary>

### The data files

The app and the report read the same rollup files, made by [PAX](https://github.com/microsoft/PAX).
Neither can read raw Purview or Entra exports.

| File | The app | The Power BI report |
|---|---|---|
| Copilot interactions | Required | Required |
| Users, with organisation and licences | Recommended | Required |
| Agent 365 inventory | Optional | Optional, but highly recommended |

- [Get your data: PAX](docs/get-your-data.md): SharePoint, OneLake, Agent 365 and multi-month history.
- Already exported raw data another way? Use the [standalone processor](docs/standalone-processor.md).
- No tenant? Use the fictional files in [`sample-data/`](sample-data/).

### The Power BI report

Two editions, with the same pages and numbers. [Why two?](docs/power-bi-report.md#why-are-there-two-editions)

| | **Rollup Edition** (3-in-1, auto-detect) | **Rollup Edition — PBI-SharePoint** |
|---|---|---|
| **Download** | **[AIO Dashboard - Rollup Edition](https://github.com/microsoft/AI-in-One-Dashboard/raw/main/AIO%20Dashboard%20-%20Rollup%20Edition%20-%202026-06-25.pbit)** | **[AIO Dashboard - Rollup Edition - PBI-SharePoint](https://github.com/microsoft/AI-in-One-Dashboard/raw/main/AIO%20Dashboard%20-%20Rollup%20Edition%20-%20PBI-SharePoint%20-%202026-06-25.pbit)** |
| **Reads your files from** | A local path, SharePoint or OneLake | SharePoint only |
| **Scheduled refresh in the Service** | No: refresh in Desktop, or on demand | Yes, with no gateway |

- [Interpretation Guide (PDF)](AIO%20Dashboard%20-%20Interpretation%20Guide.pdf)
- [Storyboard (PowerPoint)](AIO%20Dashboard%20-%20Storyboard.pptx)

### What it shows, and how it helps leaders

- Visibility into M365 Copilot, unlicensed Copilot Chat and agent usage across your organisation.
- User engagement over time, to spot adoption patterns across every Copilot surface.
- Insights to optimise AI investment, licence allocation and employee enablement.
- Views by department, role or other organisational dimensions.
- Find adoption champions, and the areas that need more enablement.
- Target change management on actual usage, from licensed Copilot to agents.

### More

- [`app/README.md`](app/README.md): the app's tabs, the files it reads and how to build it.
- [PAX](https://github.com/microsoft/PAX): the script that makes the input files.
- [LICENSE.md](LICENSE.md): MIT License.
- [SECURITY.md](SECURITY.md): how to report a security vulnerability.

</details>

<a id="-alternatives"></a>

<details>
<summary><strong>Other options and archived editions</strong></summary>

Everything here still works.

| You want | Use |
|---|---|
| The app on your PC, with nothing to host | Download [`app/download/AI-in-One-App.html`](app/download/AI-in-One-App.html) and open it in Edge or Chrome. It works offline. |
| The app in a Fabric workspace (the **Fabric App**) | Run `irm https://raw.githubusercontent.com/microsoft/AI-in-One-Dashboard/main/app/Deploy-FabricApp.ps1 \| iex` in PowerShell. Check [what you need first](app/README.md#put-it-in-a-fabric-workspace). |
| The report on Fabric, loaded from Microsoft Graph on a schedule, without PAX | The [Fabric edition](Classic%20Editions/3.%20Fabric/README.md). The [installer](installer/README.md) can set it up for you. |
| PAX on a schedule on a Windows PC, writing to SharePoint | The [installer's PAX path](installer/README.md#with-pax-instead-of-fabric). |
| PAX on a schedule in Azure, writing to OneLake | The [Azure Container Apps job](docs/get-your-data.md#aca-job). |
| An earlier edition | [`Classic Editions/`](Classic%20Editions/): the Manual, SharePoint and Fabric editions, and archived templates. |

</details>

<a id="troubleshooting"></a>

<details>
<summary><strong>Troubleshooting</strong></summary>

- **Audit queries fail with `AuditingDisabledTenant`.** Turn on [audit logging](docs/get-your-data.md#audit-logging).
- **The installer stopped or a load failed.** See the [installer's troubleshooting](installer/README.md#troubleshooting).
- **The report is blank or won't load.** See the [report's troubleshooting](docs/power-bi-report.md#troubleshooting).
- **The app won't deploy.** Check the two admin settings in [Deploy the app](docs/deploy-the-app.md#deploy-it).
- **`npx ms` runs the wrong tool.** Run it from the `app` folder.

</details>

<details>
<summary><strong>Important usage and compliance disclaimer</strong></summary>

While this tool helps customers better understand their AI usage data, Microsoft has **no visibility** into the data that customers input into this template/tool, nor does Microsoft have any control over how customers will use this template/tool in their environment.

Customers are solely responsible for ensuring that their use of the template tool complies with all applicable laws and regulations, including those related to data privacy and security.

**Microsoft disclaims any and all liability** arising from or related to customers' use of the template tool.

**Experimental Template Notice:**
This is an experimental template with audit logs as the primary source. The audit logs from Microsoft Purview are intended to support security and compliance use cases. While they provide visibility into Copilot and Agent interactions, they are not intended to serve as the sole source of truth for licensing or full-fidelity reporting on Copilot or Agent activity. For the most accurate and reliable usage insights, users are encouraged to refer to data from the Microsoft 365 Admin Center and Viva Insights. Currently available in English only.

</details>

---

Found this useful? ⭐ Star this repo to help others discover it!
