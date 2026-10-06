# AI-in-One Dashboard: Fabric OneLake edition (v2.0.0)

The Fabric edition uses the v2.0.0 report, reporting hierarchy, organizational filters, Minimum Group Size and security roles. Its source is a Fabric Lakehouse rather than CSV exports.

**OneLake is the storage layer; Power BI uses Import mode through the Lakehouse SQL analytics endpoint. This is not Direct Lake.**

Three notebooks collect audit activity, directory information and current licensing from Microsoft Graph. A fourth notebook prepares the report's integer-keyed tables, checks data quality and marks the snapshot ready. The optional pipeline runs preparation only after collection succeeds.

| Start here | Contents |
|---|---|
| [Setup guide](AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/README.md) | Permissions, Lakehouse, notebooks, template parameters, refresh and RLS |
| [v2.0.0 template](../templates/AI-in-One-v2.0.0-Fabric-OneLake-Template.pbit) | Current Power BI template |
| [Notebooks](AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/notebooks/) | Three collectors and final report preparation |
| [Schema and identity contract](AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/SCHEMA.md) | Table names, keys, licensing and hierarchy |
| [Pipeline instructions](AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/pipelines/README.md) | Success dependencies and refresh sequencing |

The v2 notebooks write separate `aio_v2_` tables. They don't overwrite or delete any other Fabric or PAX tables. Keep the old solution available until the new report has been configured and its counts and access have been checked.

This edition is an interim Fabric option ahead of the separate PAX Fabric solution. It does not change the architecture to Direct Lake or require migration of existing PAX workloads.
