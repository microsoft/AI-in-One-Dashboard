# AI-in-One dashboard: Fabric OneLake edition (v2.0.0)

The Fabric edition is derived from the current SharePoint v2.0.0 template, with the same **17 visible report pages**, **540 calculation expressions**, relationships and security roles. **Copilot Usage Explorer** is the first page. The current preview includes the enhanced License Prioritization controls, monthly comparison on Combined Trends and person license timelines, alongside friendly app names, separate platform/catalog-status labels and system-agent controls. Minimum Group Size remains **3** by default; catalog Creator and Developer Name are visible within the viewer's access while individual usage remains protected.

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

### Observed license history

The included Graph collectors supply **current snapshots**, not a license-assignment history. Leave `PAX_USERS_CSV` and `PAX_INTERACTIONS_CSV` both blank to keep that path unchanged. With no observed transitions, the existing report keeps snapshot behavior; no historical assignment dates are inferred.

For observation history, supply both optional preparation parameters with matching already-processed PAX AIO Users and Interactions CSV paths, for example `Files/PAX/AIO_..._Users.csv` and `Files/PAX/AIO_..._Interactions.csv`. The pipeline forwards these optional paths but still runs its collectors; run preparation directly for a processed-only route without Graph credentials. Use single processed files, not raw Graph/Purview records or wildcard folders.

Preparation preserves PAX state UserKey, EffectiveDate, old manager-state keys and per-event state attribution. It accepts distinct states for the same normalized person and rejects duplicate person/state rows, key collisions and event/state mismatches. It does not invent history or assignment dates from current snapshots. No extra PAX PersonKey field or new producer flag is required. Missing EffectiveDate in legacy processed data remains Unknown.

First seen means first observed, not assignment time. Paid/free populations can overlap; distinct totals count people once. Keep matching approved inputs and tenant configuration, then verify the prepared-table publication gate and SQL synchronization before refresh. The report remains SQL analytics endpoint **Import**, not Direct Lake, with the same four report parameters and default Minimum Group Size **3**. Individual names/timelines need approved **1**.

The report resolves manager state keys to people before building the hierarchy. A blank `Manager_UserKey` means **top of chain**, not a missing manager. An explicitly requested manager absent from Users makes that person an unresolved root without hiding valid descendants; preparation does not invent manager links.
