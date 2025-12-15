# 🤖 AI-in-One Dashboard

<p style="font-size:small; font-weight:normal;">
This repository contains the <strong>AI-in-One Dashboard</strong> Power BI template. This report provides comprehensive insights into Microsoft Copilot and Agent adoption, empowering AI and business leaders to make informed decisions regarding AI implementation, licensing, and enablement strategies.
</p>

---

<details>
<summary>⚠️ <strong>Important usage & compliance disclaimer</strong></summary>

Please note: 

While this tool helps customers better understand their AI usage data, Microsoft has **no visibility** into the data that customers input into this template/tool, nor does Microsoft have any control over how customers will use this template/tool in their environment.

Customers are solely responsible for ensuring that their use of the template tool complies with all applicable laws and regulations, including those related to data privacy and security.

**Microsoft disclaims any and all liability** arising from or related to customers' use of the template tool.

**Experimental Template Notice:**  
This is an experimental template. On occasion, you may notice small deviations from metrics in the official Copilot and Agent Dashboards. We will continue to iterate based on your feedback. Currently available in English only.

</details>

---

## 📊 What This Dashboard Provides

- **Comprehensive visibility into M365 Copilot, unlicensed Copilot Chat, and Agent usage** across your organization
- **User engagement tracking over time** to identify adoption patterns and trends across all Copilot surfaces
- **Data-driven insights** to optimize AI investments, license allocation, and employee enablement
- **Customizable views** to segment data by department, role, or other organizational dimensions

---

## 🚀 How This Helps Leaders

- **Make informed AI and Microsoft Copilot investment decisions** using comprehensive usage data and analytics consolidated in one place
- **Identify Copilot and Agent adoption champions** and areas needing additional enablement
- **Optimize enablement and change management efforts** based on actual usage patterns across M365 Copilot, unlicensed Copilot Chat, and Agents
- **Accelerate AI readiness, adoption, and impact** across the organization—from licensed Copilot experiences to emerging Agent capabilities

---

## ✅ What You'll Do

**Quick Overview**: Export 3 data sources → Connect them to Power BI → Analyze your AI adoption

### Choose Your Method

<details open>
<summary>🖱️ Option A: Manual Export via Web Portal (Recommended for first-time setup)</summary>

Follow the traditional workflow using browser-based portals to export your data:

1. **Export Copilot audit logs** from Microsoft Purview
2. **Download licensed user data** from Microsoft 365 Admin Center
3. **Export org data** from Microsoft Entra Admin Center
4. **Connect CSV files** to Power BI template

**Best for**: One-time setup, first-time users, or those who prefer GUI-based workflows

👉 **See detailed instructions below** in the [Detailed Steps](#-detailed-steps) section

</details>

<details>
<summary>⚡ Option B: Automated PowerShell Scripts (For regular refreshes)</summary>

Use the PowerShell automation scripts in the [`/scripts`](scripts/) folder for a faster, repeatable workflow:

**Advantages**:
- ✅ Automated data export via Microsoft Graph API
- ✅ Reduced manual steps and potential errors
- ✅ Easy to schedule for regular data refreshes
- ✅ Consistent results every time

**Prerequisites**:
- PowerShell 5.1 or later
- Microsoft Graph PowerShell modules
- Appropriate permissions (same as manual method)

**Quick Start**:
```powershell
# 1. Install required modules
Install-Module Microsoft.Graph.Beta.Security -Scope CurrentUser

# 2. Navigate to scripts folder and run
cd scripts
.\create-query.ps1              # Creates audit log query
.\get-copilot-interactions.ps1  # Exports query results
.\get-copilot-users.ps1         # Exports licensed users list
```

📖 **Full documentation**: See [`/scripts/readme.md`](scripts/readme.md) for detailed instructions and troubleshooting

</details>

---

### Detailed Steps

<details>
<summary>📤 Step 1: Export 3 Data Sources</summary>

- **Copilot interactions audit log** from Microsoft Purview  
- **Copilot licensed user list** from Microsoft 365 Admin Center  
- **Org data** from Microsoft Entra Admin Center  

</details>

<details>
<summary>🔐 Step 2: Connect Files to Power BI Template</summary>

- Paste full file paths for each CSV into the Power BI template

</details>

---

## 📁 Detailed Steps

<details>
<summary>🔍 Step 1: Download Copilot Interactions Audit Logs (Microsoft Purview)</summary>

### What This Data Provides
This log provides detailed records of Copilot interactions across all surfaces (Chat, M365 apps, Agents), enabling deep analysis of usage patterns and engagement.

### Requirements
- Access level required: **Audit Reader** or **Compliance Administrator**
- Portal: Microsoft Purview Compliance Portal
- Permissions needed: View and export audit logs

### Step-by-Step Instructions

1. **Navigate to the portal**
   - Go to: [security.microsoft.com](https://security.microsoft.com)
   - In the left pane, scroll down and click **Audit**
   - Ensure you have appropriate compliance roles (e.g., **Audit Reader**). If not, contact your IT admin

2. **Configure the audit search**
   - In **Activities > Friendly Names**, select:  
     `Copilot Activities – Interacted with Copilot`
   - Set a **Date Range** (recommended: 1–3 months to match your Viva query)
   - Give your search a descriptive name (e.g., "Copilot Audit Export - Oct 2025")

3. **Run and export the search**
   - Click **Search**
   - Wait until the status changes to **Completed**
   - Click into the completed search
   - Select **Export > Download all results**
   - Save the CSV file to a known location (e.g., `C:\Data\Copilot_Audit_Logs.csv`)

### Expected File Format
- **File format**: CSV
- **Typical size**: Varies widely (5 MB–500 MB depending on org size and activity)
- **Columns**: ~50+ columns including timestamps, user IDs, activity types, surfaces
- **Rows**: One row per Copilot interaction

📖 **Learn more**: [Export, configure, and view audit log records – Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/compliance/audit-log-search)

</details>

<details>
<summary>👤 Step 2: Download Copilot Licensed User List (Microsoft 365 Admin Center)</summary>

### What This Data Provides
This data provides a list of users with Copilot licenses, enabling you to track license utilization and identify licensed vs. unlicensed usage patterns.

### Requirements
- Access level required: **Global Administrator** or **Reports Reader**
- Portal: Microsoft 365 Admin Center
- Permissions needed: View usage reports

### Step-by-Step Instructions

1. **Navigate to the portal**
   - Go to: [admin.microsoft.com](https://admin.microsoft.com)
   - Log in as a **Microsoft 365 Global Administrator** or **Reports Reader**

2. **Unhide usernames** (if concealed)
   - Go to **Settings > Org Settings**
   - Under the **Services** tab, choose **Reports**
   - **Deselect**: "Display concealed user, group, site names in all reports"
   - Click **Save changes**

3. **Navigate to Copilot reports**
   - Go to: **Reports > Usage > Microsoft 365 Copilot**
   - Click on the **Readiness** tab

4. **Export license data**
   - Scroll to **Copilot Readiness Details** section
   - Ensure the column `Has Copilot license assigned` is visible
   - Click the ellipsis (`...`) menu
   - Choose **Export** to download the file as CSV
   - Save to a known location (e.g., `C:\Data\Copilot_Licensed_Users.csv`)

### Expected File Format
- **File format**: CSV
- **Typical size**: 1–10 MB for 1,000–10,000 users
- **Columns**: ~10–15 columns including UserPrincipalName, Department, LicenseStatus, LastActivityDate
- **Rows**: One row per user in your organization

📖 **Learn more**: [Microsoft 365 Copilot Readiness Report – Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-readiness)

</details>

<details>
<summary>📥 Step 3: Access Org Data File (Microsoft Entra or Viva Insights)</summary>

### What This Data Provides
This file provides organizational hierarchy and user attributes, enabling segmentation by department, role, location, or other organizational dimensions.

### Requirements
- Access level required: **User Administrator** or **Global Reader** (Entra) OR **Insights Administrator** (Viva)
- Portal: Microsoft Entra Admin Center or Viva Insights
- Permissions needed: View and export user data

### Option A: Export from Microsoft Entra (Recommended)

1. **Navigate to the portal**
   - Sign in to: [entra.microsoft.com](https://entra.microsoft.com)
   - In the left-hand navigation, go to: `Identity ➝ Users`

2. **Select and download users**
   - Click **All users**
   - Click the **"Download users"** button (in toolbar or under `...` menu)

3. **Configure the export**
   - In the download dialog, select attributes to include:
   - **Required fields**:
     - `UserPrincipalName`
     - `Department`
   - **Optional but recommended fields**:
     - `JobTitle`
     - `Office`
     - `City`
     - `Country`
     - `Manager`
     - Any custom attributes relevant for reporting

4. **Download the file**
   - Choose **CSV format**
   - Click **Download**
   - Save to a known location (e.g., `C:\Data\Org_Data_Entra.csv`)

### Option B: Use Custom Org Data (Alternative)

If you have a custom org data file with organizational hierarchy and user attributes, you can use that instead. Ensure it includes:
- **Required columns**: UserPrincipalName, Department
- **Optional but recommended**: JobTitle, Office, Manager, any custom attributes

### Expected File Format
- **File format**: CSV
- **Typical size**: 1–20 MB depending on org size and attributes
- **Columns**: Varies (5–30+ columns)
- **Required columns**: UserPrincipalName, Department
- **Rows**: One row per user

💡 **Note**: Avoid downloading non-essential attributes as it can degrade performance and increase file size unnecessarily.

📖 **Learn more**: [Download a list of users – Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity/users/users-bulk-download)

</details>

<details>
<summary>🔐 Step 4: Open and Configure the Power BI Template</summary>

### What You'll Do
Connect the Power BI template to your data sources using file paths for the CSV files.

### Step-by-Step Instructions

1. **Download the template**
   - Download **AI-in-One Dashboard - Purview - Template.pbit** from this repository

2. **Open the template in Power BI Desktop**
   - Double-click the `.pbit` file
   - A parameter dialog will appear

3. **Enter file paths**
   - **Copilot Audit Log Path**: Full path to your audit log CSV  
     Example: `C:\Data\Copilot_Audit_Logs.csv`
   - **Licensed Users Path**: Full path to your licensed users CSV  
     Example: `C:\Data\Copilot_Licensed_Users.csv`
   - **Org Data Path**: Full path to your org data CSV  
     Example: `C:\Data\Org_Data_Entra.csv`

4. **Load the data**
   - Click **Load**
   - Wait for all queries to refresh (may take 5–15 minutes on first load)
   - If errors occur, verify file paths are correct and files are accessible

5. **Save and publish**
   - Save as a `.pbix` file (e.g., `AI-in-One Dashboard - Purview.pbix`)
   - Publish to your Power BI workspace
   - Configure scheduled refresh for CSV files in Power BI Service (recommended weekly or monthly)

### Troubleshooting

- **Issue**: "File not found" error
  - **Solution**: Verify file paths use absolute paths (e.g., `C:\Data\file.csv`, not `.\file.csv`) and files exist at those locations

- **Issue**: Data refresh takes extremely long
  - **Solution**: Check CSV file sizes. Very large audit logs (>500 MB) may need to be filtered or split.

</details>

<details>
<summary>📊 Step 5: Review and Customize</summary>

### What You'll Do
Review the dashboard, customize visualizations, and share with stakeholders.

### Recommended Actions

1. **Review dashboard pages**
   - Navigate through all report pages
   - Verify data loaded correctly
   - Check that filters and slicers work as expected

2. **Customize for your organization**
   - Update visuals to match your branding (colors, logos)
   - Adjust hierarchies to match your org structure
   - Add or remove pages based on your needs
   - Create bookmarks for common views

3. **Set up filters and parameters**
   - Configure default date ranges
   - Set up department/role filters
   - Create user-specific views if needed

4. **Publish and share**
   - Publish to Power BI Service if not already done
   - Set up Row-Level Security (RLS) if needed
   - Share with stakeholders via workspace access or apps
   - Create subscriptions for key reports

5. **Document customizations**
   - Keep notes on any changes you make
   - Version your .pbix file if making significant updates
   - Archive old versions in the `/Archived Templates` folder

### Best Practices

- 🔄 **Refresh schedule**: Set up weekly or monthly refresh for CSV files in Power BI Service
- 🔒 **Security**: Use Row-Level Security to restrict sensitive data by department or role
- 📧 **Subscriptions**: Set up email subscriptions for executives who want regular updates
- 📊 **Usage tracking**: Monitor dashboard usage in Power BI Service to understand what resonates

</details>

---

## 📸 Dashboard Preview

### M365 Copilot Overview
Comprehensive view of M365 Copilot adoption, activity trends, and key metrics across your organization.

![Copilot Summary - Combined View](Images/Copilot%20Summary%20-%20Combined%20View.png)

### M365 Copilot Activity Trends
Track M365 Copilot usage patterns and engagement levels over time.

![M365 Copilot Activity Trends](Images/M365%20Copilot%20Activity%20Trends.png)

### Chat Web - Activity Trends
Monitor Copilot Chat web activity and usage patterns across different surfaces.

![Chat Web - Activity Trend](Images/Chat%20Web%20-%20Activity%20Trend.png)

### Chat Web - Habit Formation
Understand user habit formation and engagement patterns with Copilot Chat web.

![Chat Web - Habit Formation](Images/Chat%20Web%20-%20Habit%20Formation.png)

### Agents - Activity Trends
Track AI Agent activity and usage trends across your organization.

![Agents - Activity Trend](Images/Agents%20-%20Activity%20Trend.png)

### Agents - Habit Formation
Monitor how users are forming habits with AI Agents over time.

![Agents Habit Formation](Images/Agents%20Habit%20Formation.png)

### Agent Leaderboard
View the most active and popular AI Agents being used in your organization.

![Agent Leaderboard](Images/Agent%20Leaderboard.png)

---

## 🔄 Version History

Check the `/Archived Templates` folder for previous versions of the dashboard template.

Current version: **v1.0** (Initial release)

---

##  License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

---

## 🔒 Security

Please see [SECURITY.md](SECURITY.md) for information on reporting security vulnerabilities.
