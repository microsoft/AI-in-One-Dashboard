# Changelog

Notable, reviewed changes to the AI in One installer.

How to install, check, update and remove it is in the [installer README](README.md). What it
deploys is the [Fabric edition](../Classic%20Editions/3.%20Fabric/README.md) of the dashboard.

---

## 0.1.0

First release. It sets up the Fabric edition of AI in One in your tenant.

**Added:**

- **Setup, in the browser or the terminal.** It checks the prerequisites, signs you in, asks where
  to put things and shows you the plan before it changes anything. Then it creates the app
  registration (or uses yours) with admin consent, the `AI in One` workspace and the
  `CopilotAnalytics` Lakehouse. It adds the three ingester notebooks, the `CopilotAdoptionPipeline`
  pipeline with its schedule, the semantic model and report, and the `AI in One Viewers` group.
- **A first load and a check.** Unless you turn it off, the pipeline runs once as soon as setup
  finishes, loading 180 days of audit history by default. Each run loads the data, then refreshes
  the model. Setup then checks the loaded tables.
- **Org data, always.** Org data loads on every run. It needs no permission beyond
  `User.Read.All`.
- **Where the secret goes.** In the notebooks by default, or in a Key Vault. It never writes the
  secret into a workspace connected to Git.
- **Look after it.** Repair or change the setup, rerun failed loads, check status and the data,
  create new secrets before they expire, manage who can see the report, and uninstall.
- **Windows exe.** `AIInOneInstaller.exe` brings its own Node.js, and each release lists its
  SHA-256. Also: `install.ps1` for PowerShell, a setup for an IT-approved Node.js, and Azure Cloud
  Shell for locked-down tenants. The exe isn't code-signed yet.
- **Update check.** It tells you when a newer installer release is out. Set
  `AI_IN_ONE_NO_UPDATE_CHECK=1` to turn it off.
