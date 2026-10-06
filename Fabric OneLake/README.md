# 🟪 AI-in-One Dashboard: Fabric OneLake edition (v1.0.0)

> [!NOTE]
> **Not part of v2.0.0.** The v1.0.0 Fabric OneLake edition (formerly Classic Fabric) isn't receiving the v2.0.0 updates. It stays available here as is, and a PAX Fabric-native solution is on the way. For the v2.0.0 dashboard, use the SharePoint or Local CSV edition in the [main README](../README.md#-choose-your-edition).

This edition reads Copilot activity, licensed users and org data from Delta tables in a Microsoft Fabric Lakehouse. Fabric notebooks fill those tables directly from Microsoft Graph, and an optional Fabric pipeline runs them on a schedule.

## What's here

| Item | What it is |
|---|---|
| [Setup guide](AI-in-One%20-%20v1.0.0%20-%20Fabric%20OneLake%20Template/README.md) | Step-by-step Lakehouse, notebook, pipeline and template setup, plus troubleshooting and the table schemas |
| [`AI-in-One - v1.0.0 - Fabric OneLake Template.pbit`](AI-in-One%20-%20v1.0.0%20-%20Fabric%20OneLake%20Template/AI-in-One%20-%20v1.0.0%20-%20Fabric%20OneLake%20Template.pbit) | The Power BI template. The same file is also in the repository's [templates folder](../templates/AI-in-One%20-%20v1.0.0%20-%20Fabric%20OneLake%20Template.pbit). |
| [`notebooks/`](AI-in-One%20-%20v1.0.0%20-%20Fabric%20OneLake%20Template/notebooks/) | The three ingester notebooks that write the Delta tables |
| [`pipelines/`](AI-in-One%20-%20v1.0.0%20-%20Fabric%20OneLake%20Template/pipelines/README.md) | A Fabric Data Pipeline that runs the notebooks on a schedule |

**[Start the setup guide →](AI-in-One%20-%20v1.0.0%20-%20Fabric%20OneLake%20Template/README.md)**
