# AI in One installer

The installer sets up the [Fabric edition](../Classic%20Editions/3.%20Fabric/README.md) of AI in
One for you. It creates the app registration, the workspace, the Lakehouse, the notebooks and
pipeline that load Copilot usage data, and the semantic model and report. Then it runs the first
load and checks the data. It runs on your PC, signed in as you, and asks its questions in your
browser or in the terminal.

Check the [Prerequisites](#prerequisites) first. Then start the installer one of these ways. They
all run the same installer and ask the same questions.

| Your PC | Start with |
|---|---|
| Windows 10 or 11 | [The PowerShell one-liner](#from-powershell) |
| Windows, and you'd rather download a program | [The exe](#run-it) |
| Windows, with a Node.js your IT team has approved | [IT-approved Node.js](#it-approved-nodejs) |
| Locked down, or not Windows | [Azure Cloud Shell](#locked-down-tenant--azure-cloud-shell) |
| Nothing can run locally, and no Cloud Shell | Your IT team runs it for you, for example from an approved admin workstation |
| A clone of this repo, with Node.js | [Without the exe](#without-the-exe) |

If your organisation's policy blocks a route, don't work around it. Use another route, or ask
your IT team.

When it finishes: [Check it worked](#check-it-worked).

## Run it

1. Start the installer. Paste this into PowerShell (see [From PowerShell](#from-powershell)):

   ```powershell
   irm https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.1.0/install.ps1 | iex
   ```

   Or [download the exe](https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.1.0/AIInOneInstaller.exe)
   and open it. To check the exe, see [Check the download](#check-the-download). If your
   organisation blocks either, use another route in the table above.
2. The first time, it takes about a minute to unpack. Then it opens in your browser. Keep its
   window open while you use the page, and keep the PC plugged in until it finishes. If you close
   the page, go back to that window and press **Enter** to open it again.
3. Choose **Set up AI in One** and sign in.
4. On **Setup settings**, open each category, answer its questions and save it:
   1. **Data collection.** What it loads: Copilot usage and licences, and org data. There's
      nothing to choose here.
   2. **Fabric placement.** The capacity, how many people are in the tenant, the workspace and the
      Lakehouse. A new workspace is named `AI in One` and its Lakehouse `CopilotAnalytics`. F64 or
      larger is recommended for more than 10,000 people; small or trial capacities work, but
      loads are slower.
   3. **Viewer access.** A new group, `AI in One Viewers`, with you as owner, or a security group
      you already have. Its members can view the report.
   4. **Identity and secrets.** The app registration the notebooks sign in as, and where its
      client secret goes. See [Where the secret goes](#where-the-secret-goes) and
      [If you can't register apps](#if-you-cant-register-apps).
   5. **Schedule and loading.** How often the pipeline runs (daily at 02:00 UTC by default), how
      much audit history the first load pulls (180 days by default) and whether the first load
      runs as soon as setup finishes.

   **Review and deploy** asks you to review any category you haven't yet. **Save and close** keeps
   your answers as a draft and changes nothing.
5. Check the plan and choose **Go ahead**. Nothing is created until you do. The plan lists what it
   creates (new, or already there), the access it grants, where it runs and bills, and a
   **Costs** list with links to the pricing pages. **Not now** stops and keeps your answers.
   **Save this plan** downloads it as a Markdown file, for example to send for approval. The
   installer stops Windows going to sleep while it runs.
6. Wait for it to finish. Straight after the report is published, it asks you to share it with
   the viewer group (see [After it finishes](#after-it-finishes)). Then the first load runs.
   Loading 180 days of history can take from under an hour to several hours in a large tenant.
7. When it finishes, open the link to the report.

**In the terminal.** Run the installer without `--ui` and it asks the same things in order: what
it collects, then **Change the advanced settings?** (**No** takes the defaults), then the
capacity, workspace, app registration and where the secret goes. Then it shows the plan and asks
**Go ahead?**. See [Advanced settings](#advanced-settings).

**Want to change an answer?** Choose **Back** on any question. It opens the previous question
with your answer filled in. If you go back to the client secret, leave the box empty to keep the
one you pasted, or paste a new one.

It keeps your answers in `Documents\AI in One`, in an install record named `aio-install.json`.
Keep that folder. To run the pipeline, check status, update, or repair the set-up later, start the
installer again the same way. If OneDrive syncs your Documents folder, the record follows you to
your other PCs.

**The workspace has gone?** After you sign in, the installer checks that the record's workspace
still exists. If Fabric says it doesn't, or the record is for another tenant, the home page says
so. Choose **Start fresh** to set up again. The old record is kept beside the new one, renamed
with the date and time, such as `aio-install.20261023-090302.json`. Or choose **Keep this record**
to carry on with it. In the terminal, `install` asks whether to start fresh. If Fabric can't be
reached, or you can't read the workspace, nothing changes.

**Using a workspace that already has things in it?** The installer never changes anything it
didn't create. If one of its names is taken, its own item gets the next free name, such as
`CopilotAdoptionPipeline_2` or `AI in One 2`. The plan shows the names before you approve it. You
can also pick a Lakehouse the workspace already has, if it has schemas turned on: the notebooks
write their tables to the `dbo` schema.

### Where the secret goes

The notebooks sign in to Microsoft Graph as the app registration, with a client secret. A new
install keeps the secret **in the notebooks**, with nothing in Azure. That's simple, but:

- anyone with a role in the workspace, Viewer included, or anyone a notebook is shared with, can
  read it and use it to read your tenant's data through Microsoft Graph;
- it's copied into notebook run snapshots, exports and deployment pipelines. The installer won't
  write it into a workspace that is connected to Git;
- it lasts 90 days (1 to 730 in the advanced settings, or `--secret-days`). Each install, repair or
  update replaces it and removes the old one.

**Azure Key Vault** avoids this: the notebooks read the secret from the vault at run time, so a
workspace role doesn't expose it. Choose it in **Identity and secrets**, or add `--key-vault`. A
new vault is named `ai-in-one-` and six random characters, in the resource group `rg-ai-in-one`,
and the secret is `ai-in-one-client-secret`, valid for 12 months. You get Key Vault Secrets
Officer on the vault, and Key Vault Secrets User so scheduled runs can read the secret as you.
Creating a vault needs Contributor on the subscription or resource group. You can pick a vault you
already have instead. If you can't write to it, choose **A vault admin will add the secret for
me**: you get the exact steps to send them, and you only need to read the secret. A vault with
public access turned off is reached through a managed private endpoint, which makes each run's
Spark session slower to start.

### If you can't register apps

The app registration is `AI in One (Fabric)`. It needs these Microsoft Graph application
permissions, with admin consent: `AuditLogsQuery.Read.All`, `Reports.Read.All` and
`User.Read.All`.

- **You can't create apps?** Choose **An admin will register the app for me**. You get an admin
  pack, `ai-in-one-admin-pack.md`: a Cloud Shell script and portal steps for an admin, who sends
  you back the client ID. Or choose **Use an app registration I already have**: the installer
  checks it has the permissions before anything is created.
- **You can't grant consent?** The installer gives you a link to send to a Global Administrator
  or Privileged Role Administrator, who selects **Grant admin consent**. Choose **Check again**
  once they have, or carry on and skip the first load for now. Loads fail until consent is
  granted.

### Advanced settings

**Change the advanced settings?** **No** takes the defaults that suit most organisations. **Yes**
asks about who can view, audit history (30, 90 or 180 days), tenant size, the Lakehouse name, the
new Key Vault's details, the schedule and the first load. In the browser, every category asks its
questions in full.

## What it sets up

| What | Name |
|---|---|
| App registration | `AI in One (Fabric)`, unless you bring your own |
| Fabric workspace | `AI in One`, or one you pick |
| Lakehouse, with schemas | `CopilotAnalytics`, or one you pick |
| Notebooks | `Copilot_Audit_Log_Direct_Ingester`, `Copilot_Licensed_Users_Direct_Ingester`, `Copilot_Org_Data_Direct_Ingester`, `AIO_Data_Check` and `AIO_Refresh_Model` |
| Pipeline, with its schedule | `CopilotAdoptionPipeline` |
| Lakehouse tables | `dbo.Copilot_Interactions_Parsed`, `dbo.copilot_licensed_users` and `dbo.copilot_org_data` |
| Semantic model and report | `AI in One`, from the Fabric edition's Power BI template |
| SQL connection for the model's refresh | `AI in One SQL` and the first 8 characters of the workspace ID |
| Viewer group | `AI in One Viewers`, or a group you name |
| Key Vault (only if you choose it) | `ai-in-one-` and six random characters, in `rg-ai-in-one` |

The three ingester notebooks, the pipeline and the Power BI template come from the Fabric edition
in this repo, so the result matches its
[Quick start](../Classic%20Editions/3.%20Fabric/README.md#quick-start). The installer adds
`AIO_Data_Check` and `AIO_Refresh_Model`. Org data is always loaded: it needs no permission beyond
`User.Read.All`.

## Check it worked

1. **Read the Done page.** It lists what's left, as cards: who does each step and why, with a
   link. See [After it finishes](#after-it-finishes).
2. **Check what loaded.** After the first run, each load has a card: **Copilot audit log**,
   **Licensed users**, **Org data** and **AI in One model refresh**. Each says loaded, failed,
   skipped or still running. A failed card says why and what to do. See
   [Load status and reruns](#load-status-and-reruns).
3. **Check status.** Start the installer again and choose **Check status** (`status`): recent runs,
   model refreshes, secret expiry and the last data check. It changes nothing.
4. **Check the data.** **Check the data** (`check`) reads the Lakehouse tables for row counts,
   date ranges and licence matches, without running the pipeline. The result is also saved in the
   Lakehouse at `Files/aio_installer/data_check.json`.
5. **Open the report.** Open the link the installer gives you.

Something failed? Choose **Rerun failed loads** (`rerun-failed`), or see
[Troubleshooting](#troubleshooting).

### After it finishes

- **Share the report with the viewer group, once.** Power BI has no API for this, so the
  installer asks you to, with the steps: open the workspace, choose **…** next to the `AI in One`
  report, then **Manage permissions**, **Add user**, enter the group and choose **Grant**. Choose
  **I've shared it** and it isn't asked again. Choose **Later** and it's a card on the Done page,
  and Repair asks again. Until it's shared, people in the group can't open the report.
- **To give someone access**, add them to the group in
  [My Groups](https://myaccount.microsoft.com/groups), or choose **Manage access** (`access`). The
  group has **Build** on the model, which the report needs. Keep viewers off workspace roles: a
  workspace role can read the notebooks, and the secret if it's kept there.
- **Concealed user names.** If Microsoft 365 reports conceal user names, the licensed users load
  with hashed names that match nobody's Copilot activity. A card asks a Global Administrator to
  turn it off in the [Microsoft 365 admin center](https://admin.microsoft.com/): **Settings** >
  **Org settings** > **Services** > **Reports**, then untick **Conceal user, group, and site names
  in all reports**. The next run picks it up.
- **Admin consent.** If you couldn't grant it, send the link the installer gave you to an admin.
  Then start the installer again and choose **Run now**.
- **Your own reports.** Connect Power BI Desktop to the `AI in One` model, or use **Save a copy**
  on the report.
- **Someone else takes over the pipeline?** The notebooks run as whoever last changed the
  pipeline, or the schedule's owner. With Key Vault, give them Key Vault Secrets User on the vault
  and Contributor on the workspace first. With the secret in the notebooks, they only need
  Contributor.

## Load status and reruns

Each run loads the Copilot audit log, the licensed users and the org data, then refreshes the
model and checks the data. When a load fails, its card says why:

- **The capacity was too busy.** Nothing is lost. Rerun it when the capacity is quieter, or use a
  larger capacity.
- **The SQL endpoint hadn't caught up.** Wait a couple of minutes and rerun.
- **Sign-in failed.** Check admin consent, and whether the client secret has expired.
- **It timed out.** Rerun it. In a large tenant, choose **More than 10,000** for the tenant size
  with **Repair or change**.
- **Anything else.** Open the pipeline's latest run in Fabric for the details.

**Rerun failed** (`rerun-failed`) runs again only the loads that failed in the latest run. **Run
now** (`run`) runs the whole pipeline, then the data check. The installer won't start a run while
one is going. A run that started more than 24 hours ago counts as stuck, not running.

## A large tenant

For more than 10,000 people, choose **More than 10,000** for the tenant size. It's the default on
F64 or larger, or with more than 10,000 Copilot seats assigned. It gives the loads and the model
refresh longer time limits (the refresh gets 5 hours rather than 3). F64 or larger is recommended.
With 30,000 seats or more on a smaller capacity, setup still works, but loads take longer and may
hit their time limits.

The first load is the longest. Loading 180 days of history can take from under an hour to several
hours in a large tenant. Later runs load again only from the start of the latest day loaded.

### Load more audit history

To change how much history is loaded after the first load, choose **Repair or change**: it asks
**Load more audit history?**, with the number of days loaded now. Or run
`aio-install run --backfill-days <n>`, from 1 to 180. That rebuilds the audit table with just
those days, so fewer days than are loaded now removes the older rows: it asks first, and with
`--yes` it doesn't start. In the browser, **Run now** can reload older history too.

## Already set up by hand

If you imported the Fabric edition's notebooks yourself, update the audit log notebook first.
Scheduled incremental runs of earlier versions duplicated rows:

1. Import `Copilot_Audit_Log_Direct_Ingester.ipynb` again, keeping your `TENANT_ID`,
   `CLIENT_ID`, `CLIENT_SECRET` and other settings.
2. Run it once with `MODE = 'backfill'` and a `BACKFILL_DAYS` that covers the history you want.
   The backfill overwrites the table, so rows older than that are removed.
3. Set `MODE` back to `'incremental'`.

The [notebook notes](../Classic%20Editions/3.%20Fabric/notebooks/AUDIT_LOG_INGESTER_NOTES.md)
explain this. Or switch to the installer: pick your existing Lakehouse (it must have schemas), and
the first load rebuilds the audit table. Turn off your own pipeline's or notebooks' schedules
first. If one of the installer's names is taken, its own item gets the next free name.

## Update, repair or change

- **Repair or change** (`install` again) reuses the install record and what's already there, and
  skips finished steps. Existing resources are reused where safe: changing settings never deletes
  them.
- **Update** (`update`) pushes the notebooks, pipeline, semantic model and report from this
  version of the installer to Fabric, then refreshes the model.
- If Fabric can't update the model and keep its data, the installer asks before it clears the
  data and reloads it. The report shows no data until the reload finishes. With `--yes`, add
  `--allow-model-reset` to allow it.
- **A new installer version.** When one is out, the installer says so and how to get it. Set
  `AI_IN_ONE_NO_UPDATE_CHECK=1` to turn the check off.

## Secrets expire

**Check status** warns when a secret has less than 30 days left. Choose **Create new secrets**
(`rotate-secret`). It replaces the app's client secret and the model connection's secret, which
lasts 12 months.

- **Secret in the notebooks, installer's app.** A new secret is written into the notebooks, then
  the old one is removed from the app, so copies of it in run snapshots, exports or Git stop
  working.
- **Secret in the notebooks, your own app.** You paste the new secret and the notebooks are
  rewritten with it. Then delete the old one from the app's **Certificates & secrets** page.
- **Key Vault.** The new secret goes into the vault. The old one keeps working until it expires:
  delete it from the app's **Certificates & secrets** page once a run has succeeded.
- **A vault admin adds the secret.** The installer shows the steps to send them.

## Uninstall

Choose **Uninstall** (`uninstall`). It:

1. deletes the workspace, if the installer created it. In a workspace you had, it deletes only its
   own items (deleting the pipeline also removes its schedule) and removes the app's role on the
   workspace;
2. deletes the model's SQL connection;
3. asks before it deletes an app registration it created.

It leaves alone, and lists: an app registration it didn't create, the Key Vault and its secret,
the viewer group and a Lakehouse you already had. The install record still names the deleted
items, so move it aside before you install again.

## Remove the installer

Uninstalling AI in One doesn't remove the installer from your PC. To remove it, delete
`%LOCALAPPDATA%\AIInOne`, or see **Remove it** under [From PowerShell](#from-powershell). Your
install record in `Documents\AI in One` stays.

## Check the download

Each [installer release](https://github.com/microsoft/AI-in-One-Dashboard/releases?q=installer-v&expanded=true)
lists the exe's SHA-256, which is also in `AIInOneInstaller.exe.sha256`. To check your copy, run
this in PowerShell, in the folder you downloaded it to:

```powershell
(Get-FileHash .\AIInOneInstaller.exe -Algorithm SHA256).Hash
```

It should match, ignoring capitals. If it doesn't, delete the file and download it again.
`install.ps1` checks the zip's SHA-256 for you the same way.

A matching hash confirms the file is the one in the release. It doesn't confirm who published it:
the exe and `install.ps1` aren't code-signed yet. On a PC your organisation doesn't manage, Edge
may say the exe isn't commonly downloaded, and Windows SmartScreen may say it protected your PC.
On a managed PC, if policy blocks the exe, use the [PowerShell one-liner](#from-powershell) or
another route in the table at the top, or ask your IT team.

## From PowerShell

Paste this into PowerShell (Windows PowerShell 5.1 or PowerShell 7). It runs the same installer as
the exe, with the same browser steps:

```powershell
irm https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.1.0/install.ps1 | iex
```

It downloads `AIInOneInstaller.zip` from that release (Node.js and the installer), checks its
SHA-256 against the one written into `install.ps1`, unpacks it under `%LOCALAPPDATA%\AIInOne` and
opens the installer in your browser. It needs no admin rights, installs nothing system-wide and
changes no settings. Run a newer release's command to pick up a new version; it removes the old
one.

- **Later commands.** It leaves a command behind for the version it unpacked, for example
  `& $env:LOCALAPPDATA\AIInOne\aio-install.cmd status`. With no arguments it opens the browser
  steps.
- **A fixed version.** The command above is pinned to one release. If that release's zip has since
  been removed, the command says so, points you to the
  [installer releases](https://github.com/microsoft/AI-in-One-Dashboard/releases?q=installer-v&expanded=true)
  and stops. It doesn't switch versions on its own.
- **Download and run.** To keep the files, download `install.ps1` and `AIInOneInstaller.zip` from
  the [release](https://github.com/microsoft/AI-in-One-Dashboard/releases/tag/installer-v0.1.0)
  and, where your execution policy allows scripts, run
  `.\install.ps1 -ZipPath .\AIInOneInstaller.zip`. The zip must be from the same release. Anything
  after the options goes to the installer, for example `... -ZipPath .\AIInOneInstaller.zip status`.
- **If policy blocks it.** If execution policy, endpoint protection or another control blocks
  `irm | iex` or the script, don't work around it. Use another route in the table at the top, or
  ask your IT team.
- **Behind a proxy.** It uses the system proxy. To name one, signed in as you, run
  `$env:AI_IN_ONE_PROXY = 'http://proxy:8080'` first, or use `-Proxy`. If the proxy blocks
  GitHub's download host, download the zip in a browser and set `$env:AI_IN_ONE_ZIP` to its path,
  or use `-ZipPath`.
- **Constrained Language Mode** works: the launcher only uses commands allowed there. It skips
  keeping the PC awake, so keep it plugged in and awake yourself.
- **Remove it** with `.\install.ps1 -Uninstall` (from the download-and-run steps above), or by
  deleting `%LOCALAPPDATA%\AIInOne`. That doesn't touch what's in your tenant, or your install
  record in `Documents\AI in One`. To remove what's in your tenant, use **Uninstall** in the
  installer first.

AppLocker or App Control rules that block programs under your profile stop the unpacked
`node.exe`, as they stop the exe. The launcher and the exe spot this and say what to do instead of
showing the raw error. If your IT team has approved a Node.js install, for example from Company
Portal, use [IT-approved Node.js](#it-approved-nodejs). Otherwise use
[Azure Cloud Shell](#locked-down-tenant--azure-cloud-shell), or ask your IT team.

## IT-approved Node.js

If your organisation has installed an approved Node.js (22.13 or later on 22.x, or 24.x; x64), the
PowerShell launcher can run the installer with it instead of the `node.exe` in the zip:

```powershell
$env:AI_IN_ONE_USE_INSTALLED_NODE = '1'; irm https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.1.0/install.ps1 | iex
```

Or, from the [download-and-run](#from-powershell) files,
`.\install.ps1 -ZipPath .\AIInOneInstaller.zip -UseInstalledNode`.

- **Which Node.js.** The `node` on your PATH. It stops if that's missing, too old or not x64.
- **What's still downloaded.** The same zip, checked the same way and unpacked to
  `%LOCALAPPDATA%\AIInOne`: the installer's JavaScript and the templates. The zip's `node.exe` is
  unpacked but not run. Nothing else runs from your profile: the installer has no native add-ons.
- **Same install.** It uses the same folders and the same install record as the other Windows
  routes, so you can switch routes without a second install. The command it leaves behind,
  `aio-install.cmd`, keeps using the approved Node.js, and the update command the installer shows
  keeps the setting.

## Locked-down tenant / Azure Cloud Shell

If your PC can't run the exe or the PowerShell command (AppLocker, App Control, or no local
PowerShell at all), run the installer in [Azure Cloud Shell](https://shell.azure.com) instead.
Nothing runs on your PC: the installer runs in Cloud Shell and asks its questions in the terminal.
Choose **PowerShell** in Cloud Shell and paste the same command:

```powershell
irm https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.1.0/install.ps1 | iex
```

In Cloud Shell, `install.ps1` doesn't download the Windows zip. It fetches the installer's source
from GitHub at the commit written into `install.ps1`, checks it got that commit, and installs the
installer's packages with `npm ci` from the lockfile. If Cloud Shell's Node.js is older than 22.13,
it downloads the Node.js version the release was built with from nodejs.org and checks its SHA-256
against the list nodejs.org publishes. It all goes in `~/.ai-in-one`. The first run takes a minute
or two.

- **Options.** To pass options or a command, run
  `& ([scriptblock]::Create((irm https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.1.0/install.ps1))) --use-az status`.
  In Bash, run
  `pwsh -c "irm https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.1.0/install.ps1 | iex"`.
- **Later commands.** It leaves `~/.ai-in-one/aio-install` behind, which works from Bash or
  PowerShell, for example `~/.ai-in-one/aio-install status`. To update, run a newer release's
  `irm` command.
- **Terminal only.** Cloud Shell can't open the installer's page in your browser, so `--ui` isn't
  available. The terminal asks the same questions.
- **Signing in.** By default the installer signs you in with a code: it shows a code and a link,
  and you sign in on any device. The tokens stay in memory, so each run asks again. To use
  `--use-az` instead, first run `az login --use-device-code`. The Azure CLI stays signed in
  between Cloud Shell sessions.
- **If Conditional Access blocks sign-in with a code**, Cloud Shell can't run the installer: both
  ways of signing in use a code there. Ask whoever manages Conditional Access, or run the
  installer on a PC that's allowed.
- **Keep the install record.** It's in `~/ai-in-one/aio-install.json`. Your home folder is kept
  between sessions only if Cloud Shell has a storage account (it then has `~/clouddrive`);
  `install.ps1` warns if it doesn't. Without the record, running the installer again sets up a
  second copy, so in that case download it before you close Cloud Shell: choose **Manage files** >
  **Download** and enter `ai-in-one/aio-install.json`. In a new session, upload it with **Manage
  files** > **Upload** and run the installer again: it moves the uploaded record from your home
  folder to where it looks. To carry on from a PC later, put the record in `Documents\AI in One`.
- **Idle timeout.** Cloud Shell ends a session after 20 minutes without input. If that stops the
  installer, run the same command again: it reuses what's in the install record, skips finished
  steps and doesn't create a second app. `--no-wait` saves waiting for the first load.
- **Remove it** with
  `& ([scriptblock]::Create((irm https://github.com/microsoft/AI-in-One-Dashboard/releases/download/installer-v0.1.0/install.ps1))) -Uninstall`,
  or by deleting `~/.ai-in-one`. Your install record stays.

`install.ps1` spots Cloud Shell from the environment variables it sets. To force it either way,
set `$env:AI_IN_ONE_CLOUD_SHELL` to `1` or `0` first. Cloud Shell is the PowerShell launcher's only
Linux target; on other Linux or macOS machines, use [Without the exe](#without-the-exe).

## Without the exe

Run the installer from a clone of this repo with Node.js 22.13 or later:

```text
cd installer
npm ci
npx aio-install --ui
```

Leave out `--ui` to answer the questions in the terminal. The exe takes the same commands, for
example `AIInOneInstaller.exe status`. From a clone, the install record is `aio-install.json` in the
folder you run it from (Git ignores it in `installer`), unless `--config` names another file.
`install --yes` keeps the secret in the notebooks for a new install: read
[Where the secret goes](#where-the-secret-goes) first, and add `--key-vault` to use Key Vault
instead. See [Commands and options](#commands-and-options).

## Prerequisites

Choose **Check prerequisites** (`prereqs`) to see what you have and what you lack. It's
read-only and works before anything is installed. It checks:

- **Global Administrator or Privileged Role Administrator** (optional), to grant admin consent
  yourself. Otherwise an admin grants it later.
- **Fabric administrator**, only if the tenant settings below are off.
- **Register apps in Entra**: Application Administrator or Cloud Application Administrator, or
  users being allowed to register apps. Otherwise bring an app, or use the admin pack.
- **Power BI Pro or Premium Per User licence.**
- **Microsoft 365 Copilot licences in the tenant** (optional). Without them assigned, only Copilot
  Chat usage shows.
- **Active Fabric capacity**: F2 or larger, or a trial. F64 or larger for more than 10,000
  people.
- **Fabric tenant settings:** **Service principals can call Fabric public APIs** and **Allow
  visuals created using the Power BI SDK**.
- **Microsoft 365 reports show user names** (optional). See [After it finishes](#after-it-finishes).
- Only with Key Vault: **Owner, or Contributor and User Access Administrator**, on the
  subscription you'll use, and **Key Vault access for the app secret**.

It doesn't check that unified audit logging is on, and the audit log load needs it. See
**Before you run anything — unified audit logging must be ON** in the [main README](../README.md).

## Troubleshooting

- **A load failed.** See [Load status and reruns](#load-status-and-reruns).
- **The report shows no data.** Check the load cards, then **Check the data**. If the model was
  just reset, wait for the reload to finish.
- **Licences don't match anyone's activity.** Microsoft 365 reports may conceal user names: see
  [After it finishes](#after-it-finishes).
- **A load card says sign-in failed.** Check admin consent, and whether the client secret has
  expired: **Check status** says.
- **The page has lost its link to the installer.** Go back to the installer's window and press
  **Enter** to open it again.

### Known issues

- The **Agent 365** page is empty: the installer leaves the template's `Agent 365 (highly
  recommended)` parameter blank.
- Audit records that arrive late, in a time window a run has already loaded, aren't fetched again.
- Incremental runs don't write audit rows that have no `CreationDate`.
- The exe and `install.ps1` aren't code-signed yet. See [Check the download](#check-the-download).

## Commands and options

```text
aio-install [command] [options]
aio-install --ui [options]
```

| Command | In the browser | What it does |
|---|---|---|
| `install` | **Set up AI in One**, or **Repair or change** | Sets up AI in One, or repairs it from the install record. The default |
| `update` | **Update** | Pushes the notebooks, pipeline, semantic model and report from this version to Fabric, then refreshes the model |
| `run` | **Run now** | Runs the pipeline now, then the data check |
| `rerun-failed` | **Rerun failed** | Runs again only the loads that failed in the latest run |
| `check` | **Check the data** | Runs the data check again, without the pipeline |
| `refresh` | **Refresh** | Refreshes the semantic model now |
| `status` | **Check status** | Recent runs and refreshes, the last data check and when secrets expire |
| `rotate-secret` | **Create new secrets** | New client secrets for the notebooks (or Key Vault) and the model's connection |
| `access` | **Manage access** | The viewer group, its members and owners, and its Build on the model |
| `uninstall` | **Uninstall** | Deletes what the installer created. See [Uninstall](#uninstall) |
| `prereqs` | **Check prerequisites** | Checks the roles, licences, capacities and tenant settings you have and lack |
| `preview` | | Writes what would be deployed to a folder, without signing in |

| Option | What it does |
|---|---|
| `--ui` | Runs the installer in your browser. Only this computer can reach the page |
| `--no-open` | With `--ui`: prints the link instead of opening the browser |
| `--config <file>` | The install record (default `./aio-install.json`) |
| `--source <dir>` | The repo folder to deploy from (default: this checkout) |
| `--tenant <id>` | Tenant ID or domain to sign in to |
| `--target fabric` | Where AI in One runs. Fabric is the only target for now |
| `--device-code` | Signs in with a code on another device. The default in Azure Cloud Shell |
| `--use-az` | Uses the account you're signed in to with the Azure CLI |
| `--backfill-days <n>` | With `run`: reloads n days of audit history, 1 to 180 |
| `--out <dir>` | With `preview`: where to write (default `./aio-preview`) |
| `--dry-run` | Same as `preview` |
| `--no-key-vault`, `--secret-in-notebook` | With `install`: no Key Vault, the default for a new install |
| `--key-vault` | With `install`: keeps the client secret in Azure Key Vault. Needed with `--yes` to choose Key Vault for a new install |
| `--secret-days <n>` | With `install` or `rotate-secret`, and no Key Vault: how many days the secret lasts, 1 to 730 (default 90) |
| `--yes` | Takes saved answers and defaults without asking. It never lets Fabric clear a model's data |
| `--allow-model-reset` | With `install`, `update` or `access`: clears the model's data and reloads it if Fabric can't keep it |
| `--no-wait` | Doesn't wait for the first load or a refresh to finish |
| `--verbose` | Prints each API call |
| `-h`, `--help` | Shows the help |
| `-v`, `--version` | Shows the version |

## For maintainers

**Where it comes from.** The installer is ported from the Analytics Hub installer
(microsoft/AnalyticsHub-Dashboard, `installer/`) at
[`1af87db`](https://github.com/microsoft/AnalyticsHub-Dashboard/commit/1af87db759e3c4a759311b0beca6bbe8f13b992d),
cut down to the Fabric path. These later Analytics Hub changes are worth bringing across once they
land:

- [microsoft/AnalyticsHub-Dashboard#169](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/169):
  only its audit-ingestion check.
- [microsoft/AnalyticsHub-Dashboard#170](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/170):
  prerequisite checks inside install and update.
- [microsoft/AnalyticsHub-Dashboard#181](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/181):
  tenant size asked in the main flow.
- [microsoft/AnalyticsHub-Dashboard#183](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/183):
  prerequisite checks say what to ask for, and who.
- [microsoft/AnalyticsHub-Dashboard#186](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/186):
  an honest first-load estimate, and status shows history progress.
- [microsoft/AnalyticsHub-Dashboard#114](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/114):
  the managed app deployment, for the App Edition.

**Build and test.** In `installer/`: `npm ci`, then `npm test`, `npm run typecheck` and
`npm run build:exe`. `build:exe` writes `AIInOneInstaller.exe`, `AIInOneInstaller.zip` and
`install.ps1` with the zip's SHA-256 and the commit written in.

**Releases.** Installer releases are tagged `installer-vX.Y.Z`, apart from the dashboard's own
releases. Pushing the tag runs `.github/workflows/installer-exe.yml`, which builds the files and
drafts a release with `--latest=false`, so the repo's Latest release stays the dashboard's. Publish
the draft by hand. An `installer-vX.Y.Z-rc.N` tag makes a pre-release. Because the repo's Latest
release isn't the installer's, the installer's update check reads the releases list, skips drafts
and pre-releases, and takes the highest `installer-v` version.

- Bump `version` in `package.json` and the `installer-v` links in this README together: a test
  checks they match.
- The pinned links work once `installer-v0.1.0` is published.
- The exe isn't code-signed yet. The ESRP pipeline is
  `installer/packaging/sign-installer.azure-pipelines.yml`, with the variable group
  `ai-in-one-esrp`. With the repository variable `REQUIRE_SIGNED_INSTALLER` set to `true`, the
  workflow turns an unsigned release back into a draft.
- `AI_IN_ONE_NO_UPDATE_CHECK=1` turns the update check off, for example in tests.
