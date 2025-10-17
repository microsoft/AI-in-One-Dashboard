# 📝 Template - Customize Your Data Sources

This file contains templates for documenting your specific data sources. Copy the relevant sections into your README.md and SETUP-GUIDE.md files.

---

## Template: Data Source Section

Use this template for each data source in your README.md:

```markdown
<details>
<summary>🔍 [Data Source Name] - Detailed Instructions</summary>

### What This Data Provides
[Describe what information this data source contains and why it's needed]

### Requirements
- Access level required: [e.g., Admin, Viewer, etc.]
- System/Portal: [e.g., Azure Portal, Microsoft 365 Admin Center, etc.]
- Permissions needed: [List specific permissions]

### Step-by-Step Export Instructions

1. **Navigate to the portal**
   - Go to: [URL or path]
   - Sign in with appropriate credentials

2. **Configure the export**
   - Click on [Menu/Button]
   - Select [Options]
   - Set date range: [Recommended range, e.g., "Last 90 days"]

3. **Select required fields**
   Required columns:
   - `[Column Name 1]`
   - `[Column Name 2]`
   - `[Column Name 3]`
   
   Optional columns:
   - `[Column Name 4]`
   - `[Column Name 5]`

4. **Export the data**
   - Click **Export** or **Download**
   - Choose **CSV** format
   - Save to a known location (e.g., `C:\Data\datasource1.csv`)

### Expected File Format
- **File format**: CSV
- **Typical size**: [e.g., 5-10 MB for 1000 users]
- **Columns**: [Number] columns
- **Rows**: Varies by organization size

### Troubleshooting
- **Issue**: [Common problem]
  - **Solution**: [How to fix it]
- **Issue**: [Another common problem]
  - **Solution**: [How to fix it]

📖 **Learn more**: [Link to official documentation]

</details>
```

---

## Example: Copilot Usage Data

Here's a filled-in example you can adapt:

```markdown
<details>
<summary>🔍 Copilot Usage Data from Microsoft 365 Admin Center</summary>

### What This Data Provides
This data source provides information about Copilot license assignments and user readiness across your organization.

### Requirements
- Access level required: Microsoft 365 Global Administrator or Reports Reader
- System/Portal: Microsoft 365 Admin Center
- Permissions needed: View-only access to Microsoft 365 reports

### Step-by-Step Export Instructions

1. **Navigate to the portal**
   - Go to: [admin.microsoft.com](https://admin.microsoft.com)
   - Sign in as a Microsoft 365 Global Administrator

2. **Configure the export**
   - Navigate to: **Reports > Usage > Microsoft 365 Copilot**
   - In the **Readiness** tab, scroll to **Copilot Readiness Details**
   - Select column: `Has Copilot license assigned`

3. **Export the data**
   - Click the ellipsis (`...`) menu
   - Choose **Export**
   - File will download as CSV format
   - Save to: `C:\Data\copilot-licenses.csv`

### Expected File Format
- **File format**: CSV
- **Typical size**: 1-5 MB for 1000 users
- **Columns**: ~15 columns including UserPrincipalName, Department, LicenseStatus
- **Rows**: One row per user in your organization

### Troubleshooting
- **Issue**: Usernames appear as "User1", "User2", etc.
  - **Solution**: Go to Settings > Org Settings > Services > Reports, and deselect "Display concealed user names"
- **Issue**: No data appears in the report
  - **Solution**: Ensure users have been active in the last 30 days and wait 24-48 hours for data refresh

📖 **Learn more**: [Microsoft 365 Copilot Usage Analytics](https://learn.microsoft.com/microsoft-365/admin/activity-reports/microsoft-365-copilot-usage)

</details>
```

---

## Template: Parameters Table

Use this for documenting Power BI template parameters:

```markdown
### Required Parameters

When you open the template, you'll be prompted to enter these parameters:

| Parameter Name | Description | Example Value | Required? |
|----------------|-------------|---------------|-----------|
| **FilePath_DataSource1** | Full path to [data source 1] CSV file | `C:\Data\source1.csv` | Yes |
| **FilePath_DataSource2** | Full path to [data source 2] CSV file | `C:\Data\source2.csv` | Yes |
| **FilePath_DataSource3** | Full path to [data source 3] CSV file | `C:\Data\source3.csv` | Yes |
| **HashString** | Text string for de-identifying sensitive data | `MyCompany2024` | Optional |
| **DateRangeStart** | Start date for analysis | `2024-01-01` | Optional |
| **DateRangeEnd** | End date for analysis | `2024-10-17` | Optional |

💡 **Tips:**
- Use absolute file paths (e.g., `C:\Data\file.csv` not `.\file.csv`)
- Avoid special characters in file paths
- Keep hash string consistent across refreshes to maintain user anonymization
```

---

## Template: Visual Guide Section

Add this to reference screenshots:

```markdown
## 📸 Dashboard Preview

### Overview Page
The main overview page provides a high-level summary of AI usage across your organization.

![Overview Dashboard](Images/01-overview.png)

### Usage Analytics
Deep dive into usage patterns, trends, and adoption metrics.

![Usage Analytics](Images/02-usage-analytics.png)

### User Engagement
Track user engagement levels and identify power users and champions.

![User Engagement](Images/03-user-engagement.png)

### Organizational Insights
Segment data by department, role, or custom hierarchies.

![Org Insights](Images/04-org-insights.png)
```

---

## Template: FAQ Section

```markdown
## ❓ Frequently Asked Questions

<details>
<summary><strong>How often should I refresh the data?</strong></summary>

We recommend refreshing monthly for trend analysis, or weekly for active monitoring during rollout phases.

</details>

<details>
<summary><strong>Can I customize the visuals?</strong></summary>

Yes! The template is fully customizable. You can:
- Modify existing visuals
- Add new pages
- Adjust color schemes
- Create custom measures and calculations

</details>

<details>
<summary><strong>What if my data sources are different?</strong></summary>

The template is designed to be flexible. You can:
- Modify the data connections in Power Query
- Add or remove data sources
- Adjust the data model as needed

Contact [support] for guidance on significant customizations.

</details>

<details>
<summary><strong>How do I handle errors during data refresh?</strong></summary>

Common solutions:
1. Verify file paths are correct and accessible
2. Check that CSV files are not open in other programs
3. Ensure date formats match expected format (YYYY-MM-DD)
4. Review the Power Query errors for specific issues

</details>
```

---

## Next Steps

1. **Identify your data sources** - Determine what data you need
2. **Document each source** - Use the templates above
3. **Test the process** - Walk through the export steps yourself
4. **Update README.md** - Replace placeholder sections with real content
5. **Update SETUP-GUIDE.md** - Add specific parameters and values
6. **Add screenshots** - Create visual guides for each step
7. **Commit and push** - Update your GitHub repository

---

**Pro Tips:**
- Keep instructions simple and linear
- Include screenshots for complex steps
- Test instructions with someone unfamiliar with the process
- Link to official Microsoft documentation where possible
- Update regularly as systems change
