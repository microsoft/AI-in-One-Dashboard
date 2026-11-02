# Changelog

Notable, reviewed changes to the AI in One installer.

How to install, check, update and remove it is in the [installer README](README.md). What it
deploys is the [Fabric edition](../Classic%20Editions/3.%20Fabric/README.md) of the dashboard or,
with PAX, the report from the PBI-SharePoint Power BI template and the AI in One app.

---

## 0.2.0

Adds a second way to get the data, with PAX instead of Fabric, and the AI in One app.

**Added:**

- **PAX, on a Windows PC.** Choose **PAX, on this Windows PC**, or add `--target pax`. It needs no
  Fabric capacity. A scheduled task, `AI in One - PAX refresh`, runs PAX each day as you, and its
  script uploads the files (`AIO_Interactions.csv`, `AIO_Users.csv` and, if you choose it,
  `AIO_Agent365.csv`) to the `AI in One` folder on a SharePoint site you choose. The first run
  loads 180 days of history by default, 30 days at a time, oldest first. If it stops part way, at
  the task's 4-hour limit or when you sign out, the next run carries on from the last window that
  finished. Each daily run loads the last 7 days and merges them in, without counting a message
  twice. A window or a day with no Copilot interactions isn't a failure, and `check` says there's
  no data yet until the task finds some. On a new PC, the files already in the folder stay as they
  are until the history has loaded. Or keep the files in a folder on the PC, for Power BI Desktop
  and the app only.
- **Write access to one site.** With a SharePoint folder, the app registration, `AI in One (PAX)`, gets `Sites.Selected`,
  with write access to the site you chose and no other. The task signs in with a certificate in
  your account's certificate store or, where the PC can't make one, a client secret that Windows
  protects for your account. It runs without changing or working round the PowerShell execution
  policy, and only while you're signed in unless you set it to run while you're signed out. When a
  changed setup no longer needs the site or the Agent 365 file, the installer takes away that
  access and those permissions from an app registration it created.
- **PAX pinned.** The installer downloads the PAX version it pins, and the task checks its SHA-256
  before each run. A new installer release brings a new PAX.
- **The report, from SharePoint.** The `AI in One` semantic model and report, from the
  PBI-SharePoint Power BI template, with its parameters set to the files' addresses. You sign the
  model in to SharePoint once; Power BI then refreshes it each day after the task. If Power BI
  turns that schedule off, `check`, `refresh` and `update` turn it back on. A model or report
  already in the workspace is never taken over.
- **The AI in One app.** With PAX, setup deploys the AI in One app, a Copilot managed app, by
  default, and shares it with the viewer group. If the tenant isn't ready for it, setup finishes
  at the report and says what's missing. `deploy-app` deploys it again, and turns the app step back
  on if you turned it off. The exe and the zip carry the app's build and the managed apps CLI.
- **Commands for the task.** `run` starts it now, `check` checks the files and the model, `status`
  shows the last run and whether the task runs while you're signed out, and `rotate-secret` renews
  its sign-in. `prereqs` checks the SharePoint site, the app and whether the PC can run PAX.
  `uninstall` removes the task, its sign-in, the site access, the report and the app. It checks
  the site access and the app registration are still the ones it recorded before it deletes them,
  and asks separately about a model or report it took on from Power BI Desktop: that question
  defaults to No, and `--yes` keeps them.
- **Options.** `--target fabric|pax`, and `--environment-id` for the app's Power Platform
  environment.

**Changed:**

- **Fabric: a reload keeps older audit history.** A backfill, whether the first load,
  `run --backfill-days <n>` or **Load more audit history**, replaces the audit rows only from its
  first day on and keeps older rows, as the daily runs do. A reload of fewer days than are loaded
  now starts without asking, with `--yes` too, and the install record keeps the most days loaded.
  On a Lakehouse you set up by hand, the first load keeps rows older than the days it loads: see
  **Already set up by hand** in the README. The audit notebook gets `MODE = 'rebuild'`, which
  overwrites the whole table as a backfill used to; the installer never uses it.
- Removing the installer (`install.ps1 -Uninstall`) keeps the `pax` and `pax-run` folders in
  `%LOCALAPPDATA%\AIInOne`, which the scheduled task runs from, and `managed-app`, which holds the
  AI in One app's deployment settings. With PAX, run **Uninstall** first.

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
