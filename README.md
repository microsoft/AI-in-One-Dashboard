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

**[Start here ↓](#-start-here-the-app-preview)** &nbsp;·&nbsp; **[Your data ↓](#-where-your-data-comes-from-pax)** &nbsp;·&nbsp; **[Power BI report ↓](#-the-power-bi-report)** &nbsp;·&nbsp; **[Alternatives ↓](#-alternatives)** &nbsp;·&nbsp; **[Watch First ↓](#-watch-first)** &nbsp;·&nbsp; **[Email your Admin ↓](#-email-your-admin)**

<br>

</div>

<details>
<summary><strong>📊 What it shows, and how it helps leaders</strong> <em>(click to expand)</em></summary>

### 📊 What This Dashboard Provides

- **Comprehensive visibility into M365 Copilot, unlicensed Copilot Chat, and Agent usage** across your organization
- **User engagement tracking over time** to identify adoption patterns and trends across all Copilot surfaces
- **Data-driven insights** to optimize AI investments, license allocation, and employee enablement
- **Customizable views** to segment data by department, role, or other organizational dimensions

### 🚀 How This Helps Leaders

- **Make informed AI and Microsoft Copilot investment decisions** using comprehensive usage data and analytics consolidated in one place
- **Identify Copilot and Agent adoption champions** and areas needing additional enablement
- **Optimize enablement and change management efforts** based on actual usage patterns across M365 Copilot, unlicensed Copilot Chat, and Agents
- **Accelerate AI readiness, adoption, and impact** across the organization — from licensed Copilot experiences to emerging Agent capabilities

</details>

<details>
<summary>⚠️ <strong>Important usage & compliance disclaimer</strong></summary>

Please note:

While this tool helps customers better understand their AI usage data, Microsoft has **no visibility** into the data that customers input into this template/tool, nor does Microsoft have any control over how customers will use this template/tool in their environment.

Customers are solely responsible for ensuring that their use of the template tool complies with all applicable laws and regulations, including those related to data privacy and security.

**Microsoft disclaims any and all liability** arising from or related to customers' use of the template tool.

**Experimental Template Notice:**
This is an experimental template with audit logs as the primary source. The audit logs from Microsoft Purview are intended to support security and compliance use cases. While they provide visibility into Copilot and Agent interactions, they are not intended to serve as the sole source of truth for licensing or full-fidelity reporting on Copilot or Agent activity. For the most accurate and reliable usage insights, users are encouraged to refer to data from the Microsoft 365 Admin Center and Viva Insights. Currently available in English only.

</details>

---

<!-- These anchors keep links to the old README's sections working. -->
<a id="-app-edition-preview"></a>

## 🚀 Start here: the app (preview)

**The app** shows the same metrics as the Power BI report, in six tabs: Overview, M365 Copilot, Copilot Chat, Agents, Licence priority and Guide. You deploy it once to your Microsoft 365 tenant as a **Copilot Managed App**, then share it. Viewers open it in their browser and choose their [PAX files](#-where-your-data-comes-from-pax). Every number is calculated in the browser, and the files are never uploaded. No one needs a Power BI licence.

![The AI in One app's Overview tab, showing the built-in sample data](Images/AI%20in%20One%20App%20-%20Overview.png)

> [!NOTE]
> Copilot Managed Apps run on Copilot Managed Runtime, which is in **preview**, so these steps and the licensing may change. Microsoft Learn has the latest: the [admin overview](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/) and the [licensing FAQ](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/licensing-faq).

**Try it first:** download [`app/download/AI-in-One-App.html`](app/download/AI-in-One-App.html) (select **Download raw file**) and open it in Edge or Chrome. It opens on sample data, and there's nothing to install.

### What you need

| Who | What they need |
|---|---|
| **An admin** | Global Administrator or Power Platform Administrator, to turn on two settings (step 1). |
| **You, to deploy it** | [Node.js](https://nodejs.org/) 24.11 or later, and [Git](https://git-scm.com/downloads) 2.27 or later. You don't need a licence to create, build or deploy the app, only to open it. |
| **Viewers** | A Power Apps Premium licence, or Copilot Credits (step 2). They don't need Power BI or a Microsoft 365 Copilot licence. |

### Deploy it

1. **An admin turns on two settings.** Both are off by default. In the [Power Platform admin center](https://admin.powerplatform.microsoft.com), go to **Copilot** > **Settings** > **Managed apps**. Turn on each of these for the environment group or environment the app will go in:

   - [**Allow app creation with the Copilot Managed Runtime command line interface (CLI)**](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/governance#control-whether-apps-can-be-created-using-the-cli)
   - [**External artifacts in managed apps**](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/governance#configure-external-artifact-deployment), because you build the app on your PC and upload it

   Unless your organisation has its own environment routing, each person who deploys an app gets their own personal developer environment, in the default environment group.

2. **An admin makes sure viewers can run it.** Each viewer needs a Power Apps Premium licence, or your organisation pays with Copilot Credits: set up a spending policy that covers them in the [Microsoft 365 admin center](https://admin.microsoft.com), under **Copilot** > **Cost management**. The Power Apps rights included with Microsoft 365 don't count. During the preview, people without either get a warning, then are blocked after 20 app operations or five minutes, whichever comes first.

3. **Get the code and the `ms` CLI.** In PowerShell, or any terminal:

   ```powershell
   git clone https://github.com/microsoft/AI-in-One-Dashboard.git
   cd AI-in-One-Dashboard/app
   npm ci
   npx ms --version
   ```

   `npm ci` installs the app's packages, including the `ms` CLI (`@microsoft/managed-apps-cli`) at the version pinned in [`app/package.json`](app/package.json). Run `npx ms` from the `app` folder: anywhere else, it looks for an unrelated npm package called `ms`.

4. **Sign in** with your work account:

   ```powershell
   npx ms auth login
   ```

   If there's no browser on this machine, add `--device-code`.

5. **Create the app** in your tenant. You only do this once:

   ```powershell
   npx ms app init -n "AI in One" --repo none -b ./dist -S "npm run build"
   ```

   `--repo none` means you build the app on your PC and upload it. `-b` is the build folder and `-S` is the build command. The CLI saves the app's IDs in `ms.config.json`, which git ignores. Keep it: you need it to update the app. To use a particular environment, or if finding your environment times out, add `-e <environment-id>` ([where to find it](https://learn.microsoft.com/en-us/power-platform/admin/determine-org-id-name#find-your-environment-and-organization-ids)).

6. **Deploy it.** This builds the app, uploads it and waits until it's live:

   ```powershell
   npx ms app deploy
   ```

7. **Share it** with the people or groups who'll use it. List their email addresses or Entra object IDs, separated by commas:

   ```powershell
   npx ms app share "alex@contoso.com,copilot-analytics@contoso.com"
   ```

   Or run `npx ms app share link create` to get a link that gives access to anyone in your organisation who opens it. Your admin's sharing rules apply.

8. **Viewers open it** from the link that `npx ms app play --no-browser` prints, or at [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft). It opens on sample data. To see their own, they select **Change data** > **Choose CSV files** and pick their [PAX files](#-where-your-data-comes-from-pax).

**To update the app later,** run these in the `app` folder:

```powershell
git pull
npm ci
npx ms app deploy
```

> [!TIP]
> **Deploy this code; don't regenerate it.** Cowork, Copilot Studio and Copilot Code build a *new* app from a prompt, so giving them this code would give you an untested copy. Copilot Code can run the steps above for you, but it should deploy this repo's code, not rewrite it.

More about the app, including its tabs, the files it reads and how to build it: [`app/README.md`](app/README.md).

---

<!-- These anchors keep links to the old README's sections working. -->
<a id="-important--required-input-file-format"></a><a id="-what-is-pax"></a><a id="-get-your-data--run-pax-to-produce-the-files"></a><a id="-multi-month-history--the--appendfile-switch--what-works-today"></a><a id="️-standalone-processor--processing-raw-data-without-pax"></a>

## 📥 Where your data comes from: PAX

The app and the Power BI report read the same **rollup files**, made by [PAX](https://github.com/microsoft/PAX), a free PowerShell script from Microsoft. PAX exports Copilot and agent activity from the Microsoft Purview audit log, and your users, organisation and licences from Microsoft Entra and the Microsoft 365 admin center. Then it turns them into the rollup files. Neither the app nor the report can read raw Purview or Entra exports.

| File | The app | The Power BI report |
|---|---|---|
| Copilot interactions | Required | Required |
| Users, with organisation and licences | Recommended | Required |
| Agent 365 inventory | Optional | Optional, but highly recommended |

1. Check that [unified audit logging is on](docs/get-your-data.md#audit-logging) in Purview. Turning it on doesn't backfill, so do it early.
2. Get PAX from [its repo](https://github.com/microsoft/PAX), and run it with `-Rollup`. For example, to write all three files to a local folder:

   ```powershell
   .\PAX_Purview_Audit_Log_Processor.ps1 -Rollup -IncludeAgent365Info -OutputPath "C:\Data\PAX"
   ```

Running PAX needs admin permissions: [Email Your Admin](#-email-your-admin) has a ready-made request. [Get your data: PAX](docs/get-your-data.md) has the details, including writing to SharePoint or OneLake, the Agent 365 file and multi-month history. Already exported raw Purview and Entra data another way? The [standalone processor](docs/standalone-processor.md) makes the same rollup files. To explore without a tenant, use the fictional files in [`sample-data/`](sample-data/).

---

<!-- These anchors keep links to the old README's sections working. -->
<a id="-ai-in-one-dashboard--rollup-edition"></a><a id="-which-edition-should-i-download"></a><a id="why-are-there-two-editions"></a><a id="-how-this-version-is-different--and-why-it-loads-so-much-faster"></a><a id="-open-and-configure-the-power-bi-template"></a><a id="-set-up-scheduled-refresh-in-power-bi-service"></a><a id="-review-and-customize"></a><a id="-version-history"></a>

## 📊 The Power BI report

Prefer Power BI? The report shows the same metrics as the app. It comes in two editions with the same pages, visuals and numbers, which differ only in where they read your PAX files from, and whether the Power BI Service can refresh them on a schedule.

| | **Rollup Edition** (3-in-1, auto-detect) | **Rollup Edition — PBI-SharePoint** |
|---|---|---|
| **⬇️ Download** | **[AIO Dashboard - Rollup Edition](https://github.com/microsoft/AI-in-One-Dashboard/raw/main/AIO%20Dashboard%20-%20Rollup%20Edition%20-%202026-06-25.pbit)** | **[AIO Dashboard - Rollup Edition - PBI-SharePoint](https://github.com/microsoft/AI-in-One-Dashboard/raw/main/AIO%20Dashboard%20-%20Rollup%20Edition%20-%20PBI-SharePoint%20-%202026-06-25.pbit)** |
| **Reads your files from** | A local path, SharePoint or OneLake, auto-detected | SharePoint only |
| **Scheduled refresh in the Service** | ❌ Not supported: refresh in Desktop, or on demand | ✅ Supported, with no gateway |

**Rule of thumb** ([why two editions?](docs/power-bi-report.md#why-are-there-two-editions))
- Exploring in Power BI Desktop, or your files are local or on OneLake → the **3-in-1 edition**.
- You want the report to refresh itself on a schedule, and your files are on SharePoint → the **PBI-SharePoint edition**.
- Your files are on OneLake or Fabric, and you need scheduled refresh → the [Fabric edition](Classic%20Editions/3.%20Fabric/README.md).

To use it, open the `.pbit` in Power BI Desktop, paste where each PAX file is into the three parameters, and select **Load**. The [Power BI report guide](docs/power-bi-report.md) covers the parameters, scheduled refresh, customising the report and the version history.

📄 [Interpretation Guide (PDF)](AIO%20Dashboard%20-%20Interpretation%20Guide.pdf) &nbsp;·&nbsp; 🖼️ [Storyboard (PowerPoint)](AIO%20Dashboard%20-%20Storyboard.pptx)

<a id="-dashboard-preview"></a>

![AI-in-One Dashboard animated preview](https://github.com/microsoft/AI-in-One-Dashboard/raw/main/Images/AIO%20v10%20Gif.gif)

---

## 🧭 Alternatives

Everything here still works, if the app doesn't suit you.

| You want | Use |
|---|---|
| The app on your PC, with nothing to host | Download [`app/download/AI-in-One-App.html`](app/download/AI-in-One-App.html) and open it in Edge or Chrome. It works offline. |
| The app in a Fabric workspace (the **Fabric App**) | Run `irm https://raw.githubusercontent.com/microsoft/AI-in-One-Dashboard/main/app/Deploy-FabricApp.ps1 \| iex` in PowerShell. Check [what you need first](app/README.md#put-it-in-a-fabric-workspace). |
| The report on Fabric, loaded from Microsoft Graph on a schedule, without PAX | The [Fabric edition](Classic%20Editions/3.%20Fabric/README.md). The [AI in One installer](installer/README.md) can set it up for you. |
| PAX to run on a schedule on a Windows PC, writing to SharePoint | The [AI in One installer](installer/README.md#with-pax-instead-of-fabric)'s PAX path. It sets up the scheduled task, publishes the report and can deploy the app. |
| PAX to run on a schedule in Azure, writing to OneLake | The [Azure Container Apps job](docs/get-your-data.md#aca-job). |
| An earlier edition | [`Classic Editions/`](Classic%20Editions/): the Manual, SharePoint and Fabric editions, and archived templates. |

---

<a id="-watch-first"></a>

## 🎬 Watch First

Both play here in the page — no download.

**YouTube overview** *(2m 32s)*  
https://youtu.be/W9JWgF6wcqg

**Overview — what the dashboard measures, page by page** *(2m 40s)*

https://github.com/user-attachments/assets/37f84c0c-125d-4814-890d-14001d5a3127

**Setup guide — getting your own data in, every source, start to finish** *(10m 12s)*

https://github.com/user-attachments/assets/036ab946-7fa2-411b-b70a-e512e2028778

**YouTube setup guide** *(10m 12s)*  
https://youtu.be/z4FWazaBDS8

📄 **[Video Guide & Chapter Reference](docs/Video-Guide.md)** — timestamped chapters for both videos, so you can jump straight to any topic. *(Also available as a [downloadable Word document](docs/AI-in-One-Dashboard-Video-Guide.docx?raw=1).)*

---

## 🔗 Related Resources

- **PAX (Purview Audit eXporter)** — the script that produces this template's input files: https://github.com/microsoft/PAX

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE.md](LICENSE.md) file for details.

---

## 🔒 Security

Please see [SECURITY.md](SECURITY.md) for information on reporting security vulnerabilities.

---

## 📧 Email Your Admin

> 📧 **Before you begin, your IT admin needs to export data from Purview, Entra, and M365 Admin Center.**
> This pre-written email covers all required data sources, field names, admin roles, permissions, and export steps — everything your admin needs in one click.
>
> **[📨 Email Prerequisites to Your IT Admin](mailto:?subject=Action%20Required%3A%20Data%20Export%20Fields%20Needed%20for%20AI-in-One%20Dashboard%20%28Power%20BI%29&body=To%3A%20IT%20Admin%20%2F%20Global%20Admin%0ARe%3A%20AI-in-One%20Dashboard%20%E2%80%93%20Power%20BI%20Report%20Setup%0A%0A%0AWHAT%20THIS%20REPORT%20DOES%0A%0AThe%20AI-in-One%20Dashboard%20is%20a%20Power%20BI%20report%20that%20provides%20a%20comprehensive%20view%20of%20Microsoft%20365%20Copilot%2C%20unlicensed%20Copilot%20Chat%2C%20agent%20usage%2C%20and%20third-party%20AI%20adoption%20across%20your%20organization.%20It%20consolidates%20four%20data%20sources%20into%20a%20single%20dashboard%20for%20adoption%20tracking%2C%20license%20optimization%2C%20and%20enablement%20planning.%0A%0A%0ADATA%20SOURCES%20REQUIRED%0A%0A1.%20Microsoft%20Purview%20%E2%80%93%20Copilot%20Audit%20Logs%0A%20%20%20Export%3A%20Purview%20portal%20%28security.microsoft.com%29%20-%3E%20Audit%20-%3E%20Export%2C%20or%20PAX%20PowerShell%20script%0A%20%20%20Format%3A%20CSV%0A%0A2.%20Microsoft%20Entra%20ID%20%E2%80%93%20User%2FOrg%20Data%20%28includes%20license%20data%29%0A%20%20%20Export%3A%20entra.microsoft.com%20-%3E%20Identity%20-%3E%20Users%20-%3E%20Download%20users%2C%20or%20PAX%20script%20with%20-IncludeUserInfo%0A%20%20%20Format%3A%20CSV%0A%0A3.%20Microsoft%20365%20Admin%20Center%20%E2%80%93%20Agent%20365%20Inventory%0A%20%20%20Export%3A%20admin.microsoft.com%20-%3E%20Agents%20-%3E%20All%20Agents%20-%3E%20Export%20to%20Excel%0A%20%20%20Format%3A%20XLSX%0A%0A4.%20%28if%20not%20using%20PAX%29%20Microsoft%20365%20Admin%20Center%20%E2%80%93%20Licensed%20Users%0A%20%20%20Export%3A%20admin.microsoft.com%20-%3E%20Reports%20-%3E%20Usage%20-%3E%20M365%20Copilot%20-%3E%20Readiness%20tab%20-%3E%20Export%0A%20%20%20Format%3A%20CSV%0A%0ANote%20on%20license%20data%3A%20The%20report%20requires%20a%20hasLicense%20flag%20to%20split%20licensed%20vs.%20unlicensed%20Copilot%20usage.%20The%20PAX%20script%20automatically%20adds%20this%20column%20to%20the%20Entra%20user%20export%20%E2%80%94%20no%20separate%20file%20needed.%20If%20you%20are%20exporting%20manually%20from%20Entra%2C%20you%20will%20also%20need%20the%20M365%20Admin%20Center%20licensed%20users%20file%20%28source%20%234%29%20and%20provide%20it%20as%20a%20separate%20input%20to%20the%20template.%0A%0A%0AREQUIRED%20FIELDS%20%E2%80%94%20DO%20NOT%20REMOVE%0A%0AIMPORTANT%3A%20If%20you%20are%20running%20a%20PAX%20Purview%20agent%20extract%20or%20manually%20exporting%20from%20Purview%2C%20do%20not%20prune%20or%20remove%20columns%20from%20the%20output%20files.%20The%20report%20will%20silently%20break%20or%20produce%20blank%20visuals%20if%20any%20of%20the%20following%20fields%20are%20missing.%0A%0APurview%20Audit%20Log%20%28CopilotInteraction%20%2F%20ConnectedAIAppInteraction%20%2F%20AIAppInteraction%29%3A%0ACreationDate%2C%20UserId%2C%20Operations%2C%20AppHost%2C%20ThreadId%2C%20AgentId%2C%20AgentName%2C%20AISystemPlugin_Id%2C%20AISystemPlugin_Name%2C%20Context_Type%2C%20Message_isPrompt%2C%20ModelTransparencyDetails_ModelName%2C%20Workload%2C%20OrganizationId%2C%20AppIdentity_DisplayName.%0A%0AMicrosoft%20Entra%20ID%20%E2%80%93%20User%20Export%3A%0AUserPrincipalName%2C%20Department%2C%20JobTitle%2C%20displayName%2C%20hasLicense%20%28added%20automatically%20by%20PAX%3B%20or%20use%20the%20M365%20Admin%20Center%20licensed%20users%20file%20if%20exporting%20manually%29%2C%20Manager%2C%20Office%2C%20City%2C%20Country.%0A%0AM365%20Admin%20Center%20%E2%80%93%20Licensed%20Users%20%28manual%20export%20path%20only%29%3A%0AUserPrincipalName%2C%20Has%20Copilot%20License%20Assigned.%0A%0AAgent%20365%20Inventory%3A%0AName%2C%20Host%20Products%2C%20Created%20Date%2C%20Developer%20User%20ID%2C%20Description%2C%20Status%2C%20Version.%0A%0A%0AINSIGHTS%20YOU%20WILL%20GAIN%0A%0A-%20Active%20Copilot%20users%20and%20interaction%20volume%20by%20week%2Fmonth%0A-%20Surface%20breakdown%3A%20which%20apps%20%28Teams%2C%20Word%2C%20Outlook%2C%20BizChat%2C%20etc.%29%20users%20are%20engaging%20with%0A-%20Agent%20adoption%3A%20which%20agents%20are%20used%2C%20by%20how%20many%20users%2C%20on%20which%20surfaces%0A-%20AI%20model%20distribution%20across%20interactions%0A-%20Licensed%20vs.%20unlicensed%20usage%20patterns%0A-%20Session%20depth%20and%20prompt%20volume%20per%20user%20cohort%0A-%20Third-party%20and%20custom%20AI%20app%20usage%20alongside%20M365%20Copilot%0A%0A%0AROLES%20%26%20PERMISSIONS%20REQUIRED%0A%0AExport%20Purview%20audit%20logs%3A%20Audit%20Reader%20or%20Compliance%20Administrator%0AExport%20Entra%20user%20data%20%28includes%20hasLicense%20via%20PAX%29%3A%20User%20Administrator%20or%20Global%20Reader%0AExport%20Agent%20365%20inventory%3A%20AI%20Admin%20or%20Global%20Reader%0AExport%20M365%20Admin%20Center%20licensed%20users%20%28manual%20path%20only%29%3A%20Global%20Administrator%20or%20Reports%20Reader%0ARun%20PAX%20PowerShell%20script%20%28automated%20export%29%3A%20Audit%20Reader%20%2B%20Microsoft%20Graph%20API%20permissions%20%28AuditLog.Read.All%2C%20User.Read.All%2C%20Organization.Read.All%29%0A%0A%0ASOFTWARE%20REQUIREMENTS%0A%0A-%20Power%20BI%20Desktop%20%28free%20download%20from%20Microsoft%29%20%E2%80%94%20required%20to%20open%20the%20.pbit%20template%0A-%20PowerShell%205.1%2B%20%E2%80%94%20required%20only%20if%20using%20the%20PAX%20automated%20export%20script%0A-%20Microsoft%20Graph%20PowerShell%20module%20%E2%80%94%20required%20only%20for%20PAX%20script%20%28Install-Module%20Microsoft.Graph.Beta.Security%29%0A-%20Access%20to%3A%20security.microsoft.com%2C%20admin.microsoft.com%2C%20entra.microsoft.com%0A%0A%0ANote%20on%20Usernames%20in%20Reports%3A%0AIf%20user%20names%20appear%20concealed%20in%20M365%20Admin%20Center%20exports%2C%20go%20to%20Settings%20-%3E%20Org%20Settings%20-%3E%20Services%20-%3E%20Reports%20and%20uncheck%20%22Display%20concealed%20user%2C%20group%2C%20and%20site%20names%20in%20all%20reports%22%20before%20exporting.)**

---

Found this useful? ⭐ Star this repo to help others discover it!

That's it! 🚀
