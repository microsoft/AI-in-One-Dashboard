# Deploy the app

Part of [AI in One](../README.md). This page has the full manual steps to deploy **the app** to your Microsoft 365 tenant.

The app shows the same metrics as the Power BI report, in six tabs: Overview, M365 Copilot, Copilot Chat, Agents, Licence priority and Guide. You deploy it once as a **Copilot Managed App**, then share it. Viewers open it in their browser and choose their [PAX files](get-your-data.md). Every number is calculated in the browser, and the files are never uploaded. No one needs a Power BI licence.

![The AI in One app's Overview tab, showing the built-in sample data](../Images/AI%20in%20One%20App%20-%20Overview.png)

> [!NOTE]
> Copilot Managed Apps run on Copilot Managed Runtime, which is in **preview**, so these steps and the licensing may change. Microsoft Learn has the latest: the [admin overview](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/) and the [licensing FAQ](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/licensing-faq).

**Try it first:** download [`app/download/AI-in-One-App.html`](../app/download/AI-in-One-App.html) (select **Download raw file**) and open it in Edge or Chrome. It opens on sample data, and there's nothing to install.

**Rather not use the command line?** The [AI in One installer](../installer/README.md#the-ai-in-one-app)'s PAX path deploys and shares the app for you.

## What you need

| Who | What they need |
|---|---|
| **An admin** | Global Administrator or Power Platform Administrator, to turn on two settings (step 1). |
| **You, to deploy it** | [Node.js](https://nodejs.org/) 24.11 or later, and [Git](https://git-scm.com/downloads) 2.27 or later. You don't need a licence to create, build or deploy the app, only to open it. |
| **Viewers** | A Power Apps Premium licence, or Copilot Credits (step 2). They don't need Power BI or a Microsoft 365 Copilot licence. |

## Deploy it

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

   `npm ci` installs the app's packages, including the `ms` CLI (`@microsoft/managed-apps-cli`) at the version pinned in [`app/package.json`](../app/package.json). Run `npx ms` from the `app` folder: anywhere else, it looks for an unrelated npm package called `ms`.

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

8. **Viewers open it** from the link that `npx ms app play --no-browser` prints, or at [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft). It opens on sample data. To see their own, they select **Change data** > **Choose CSV files** and pick their [PAX files](get-your-data.md).

## Update it later

Run these in the `app` folder:

```powershell
git pull
npm ci
npx ms app deploy
```

> [!TIP]
> **Deploy this code; don't regenerate it.** Cowork, Copilot Studio and Copilot Code build a *new* app from a prompt, so giving them this code would give you an untested copy. Copilot Code can run the steps above for you, but it should deploy this repo's code, not rewrite it.

More about the app, including its tabs, the files it reads, the Fabric App and how to build it: [`app/README.md`](../app/README.md).
