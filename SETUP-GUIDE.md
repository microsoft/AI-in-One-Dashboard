# 🚀 Quick Start Guide - AI-in-One Dashboard

This guide will help you set up and configure the AI-in-One Dashboard Power BI template.

## Prerequisites

- **Power BI Desktop** (latest version recommended)
- Access to required data sources
- Appropriate permissions to export organizational data

---

## Step-by-Step Setup

### 1️⃣ Download the Template

Download `AI-in-One Dashboard - Template.pbit` from this repository.

### 2️⃣ Gather Your Data

Before opening the template, collect the following data files:

#### Required Data Files:
- [ ] **File 1**: [Description] - Export from [System/Portal]
- [ ] **File 2**: [Description] - Export from [System/Portal]  
- [ ] **File 3**: [Description] - Export from [System/Portal]

💡 _See the main [README.md](README.md) for detailed export instructions_

### 3️⃣ Open the Template

1. Double-click the `.pbit` file to open it in Power BI Desktop
2. You'll be prompted to enter parameters

### 4️⃣ Enter Configuration Parameters

When the parameter dialog appears, provide:

| Parameter | Description | Example |
|-----------|-------------|---------|
| **Data File 1 Path** | Full path to your first data file | `C:\Data\file1.csv` |
| **Data File 2 Path** | Full path to your second data file | `C:\Data\file2.csv` |
| **Data File 3 Path** | Full path to your third data file | `C:\Data\file3.csv` |
| **Hash String** (optional) | String for de-identifying data | `MyOrg2024` |

### 5️⃣ Load and Refresh Data

1. Click **Load** after entering parameters
2. Wait for the data to refresh (this may take several minutes)
3. If you encounter errors, check:
   - File paths are correct and accessible
   - CSV files are properly formatted
   - You have read permissions for the files

### 6️⃣ Review and Customize

1. Navigate through the dashboard pages
2. Adjust filters and slicers as needed
3. Customize visuals if required
4. Save your configured dashboard as a `.pbix` file

### 7️⃣ Publish (Optional)

To share with others:
1. Sign in to Power BI Service
2. Click **File > Publish > Publish to Power BI**
3. Select your workspace
4. Configure refresh schedules if needed

---

## 📋 Troubleshooting

### Common Issues

**Issue**: "File not found" error
- **Solution**: Ensure file paths are absolute and files are accessible

**Issue**: Data refresh takes too long
- **Solution**: Check file sizes and consider filtering data before export

**Issue**: Visuals show no data
- **Solution**: Verify data files contain records and date ranges are appropriate

---

## 🔄 Updating Data

To refresh with new data:
1. Export fresh data files using the same process
2. In Power BI Desktop: **Home > Refresh**
3. Data will reload from the file paths you specified

---

## 📞 Need Help?

- Check the main [README.md](README.md) for detailed documentation
- Review the `/Images` folder for visual guides
- Open an issue in this repository
- Contact [your support channel]
