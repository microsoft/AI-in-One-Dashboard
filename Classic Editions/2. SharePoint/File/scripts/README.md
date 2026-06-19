# SharePoint scripts

Three subfolders, by who runs the script and how often.

| Subfolder | Auth | When to use |
|---|---|---|
| **[`provisioning/`](provisioning/)** | Browser sign-in (tenant admin) | **Run once per tenant + site.** Sets up the app registration's Graph permissions and grants `Sites.Selected` access to the SharePoint site you're uploading CSVs to. |
| **[`appreg/`](appreg/)** | App registration (service principal) | **Scheduled production runs.** Designed for Task Scheduler / Azure Automation / GitHub Actions. Pulls audit logs / user list / org data and uploads CSVs to SharePoint unattended. |
| **[`interactive/`](interactive/)** | Browser sign-in (admin) | **One-shot manual runs.** Same data pulls as `appreg/` but with the admin signing in via browser instead of a stored secret. Useful for ad-hoc analysis or before you've set up the full automation. |

## Recommended path for new tenants

1. **Provisioning** — admin runs `provisioning/ProvisionPreReqs.ps1` (or `ProvisionSiteAccess-SP-AppReg.ps1` if you already have an app reg) to set up Graph permissions + SharePoint site access.
2. **First-run validation** — admin runs the `interactive/` scripts manually to validate the full pipeline produces the CSVs you expect.
3. **Production schedule** — switch to the `appreg/` scripts on whatever scheduler your org uses (Task Scheduler, Azure Automation, etc.).

## Common errors and fixes

See the parent [`README.md`](../README.md#troubleshooting) for the troubleshooting table — same issues apply across all subfolders.

For Azure Automation specifically, see [`../azure/`](../azure/) for Bicep templates + runbook examples that wire the `appreg/` scripts up to a managed-identity-enabled Automation Account.
