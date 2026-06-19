# Provisioning scripts (one-time setup)

Run **once per tenant + SharePoint site** to set up the app registration that the `appreg/` scripts will use afterwards.

These are interactive (browser sign-in) and need to be run as a tenant admin. After they've run, you typically don't touch them again — the day-to-day data pulls are done by the `appreg/` scripts using the service principal these scripts created.

## Scripts in this folder

| Script | Purpose | Admin role needed |
|---|---|---|
| `ProvisionPreReqs.ps1` | **Full setup.** Creates a fresh app registration in Entra, grants the required Microsoft Graph application permissions (admin-consented), creates a SharePoint document library + queue list, and grants `Sites.Selected` on that site. Use this if you don't already have an app reg. | Global Admin / Privileged Role Admin (to consent app permissions) |
| `ProvisionSiteAccess-SP-AppReg.ps1` | **Lighter weight.** You already have an app registration and just need to give it write access to a specific SharePoint site (`Sites.Selected` workflow). Prints the SiteId and DriveId you'll feed into the `appreg/` scripts. | SharePoint Admin / Cloud App Admin / Global Admin |

## Typical first-time provisioning

```powershell
# Option A: full setup, no existing app reg
.\ProvisionPreReqs.ps1 `
    -TenantId "<your-tenant-guid>" `
    -SiteHost "<tenant>.sharepoint.com" `
    -AppDisplayName "<your-app-display-name>"

# Option B: existing app reg, just grant site access
.\ProvisionSiteAccess-SP-AppReg.ps1 `
    -TenantId "<your-tenant-guid>" `
    -SiteHost "<tenant>.sharepoint.com" `
    -AppClientId "<your-app-client-id>" `
    -AppDisplayName "<your-app-display-name>"
```

Both scripts print the **SiteId** and **DriveId** at the end — save those, you'll feed them into the `appreg/` scripts as `-DriveId` and (optionally) `-FolderPath`.

## After provisioning

Once provisioning is done:

1. Run scripts in [`../interactive/`](../interactive/) once to validate the pipeline end-to-end
2. Configure the [`../appreg/`](../appreg/) scripts on whatever scheduler your org uses

For Azure Automation specifically, see [`../../azure/`](../../azure/) for Bicep templates that wire all of this up using a managed-identity-enabled Automation Account.
