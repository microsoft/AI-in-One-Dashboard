# AI-in-One Dashboard: Fabric OneLake edition (v2.0.0)

The Fabric edition is derived from the current SharePoint v2.0.0 template, with the same report, all 444 measures, relationships and security roles. This includes the current agent metadata, description fallbacks, readable numeric cells and resolved-agent activity relationship. Minimum Group Size remains **3** by default; catalog Creator and Developer Name are visible within the viewer's access while individual usage remains protected.

**OneLake is the storage layer; Power BI uses Import mode through the Lakehouse SQL analytics endpoint. This is not Direct Lake.**

Three notebooks collect audit activity, directory information and current licensing from Microsoft Graph. A fourth notebook prepares the report's integer-keyed tables, checks data quality and marks the snapshot ready. The optional pipeline runs preparation only after collection succeeds.

The template reads the prepared `aio_v2_users`, `aio_v2_interactions` and `aio_v2_publication` tables, not raw PAX Delta tables. Agent 365 remains an optional SharePoint CSV. See the [source compatibility contract](AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/SCHEMA.md#pax-output-compatibility) before adapting PAX output to this data tier.

| Start here | Contents |
|---|---|
| [Setup guide](AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/README.md) | Permissions, Lakehouse, notebooks, template parameters, refresh and RLS |
| [v2.0.0 template](../templates/AI-in-One-v2.0.0-Fabric-OneLake-Template.pbit) | Current Power BI template |
| [Notebooks](AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/notebooks/) | Three collectors and final report preparation |
| [Schema and identity contract](AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/SCHEMA.md) | Table names, keys, licensing and hierarchy |
| [Pipeline instructions](AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/pipelines/README.md) | Success dependencies and refresh sequencing |

The v2 notebooks write separate `aio_v2_` tables. They don't overwrite or delete any other Fabric or PAX tables. Keep the old solution available until the new report has been configured and its counts and access have been checked.

This edition is an interim Fabric option ahead of the separate PAX Fabric solution. It does not change the architecture to Direct Lake or require migration of existing PAX workloads.
