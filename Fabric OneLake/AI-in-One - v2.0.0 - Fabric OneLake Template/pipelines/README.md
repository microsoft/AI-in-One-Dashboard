# v2 collection and preparation pipeline

[pipeline-content.json](CopilotAdoptionPipeline.DataPipeline/pipeline-content.json) is a Fabric Data Pipeline definition with placeholders for your workspace and notebook IDs.

Its structure follows the [Fabric DataPipeline definition reference](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/datapipeline-definition). There is no dependency on an unpublished JSON-schema URL.

```text
Run_Audit_Log_Ingester -------\
Run_Licensed_Users_Ingester ---+-- all Succeeded --> Prepare_Report_Data
Conditionally_Run_Org_Data ---/
```

The first three branches run independently. Directory collection is controlled by `EnableOrgDataPull`; skipping it does not waive directory validation in preparation.

## Configure

1. Import the four notebooks and attach the same default Lakehouse.
2. Create a pipeline using this definition or reproduce its four activities in Fabric.
3. Replace the workspace placeholder and all four notebook ID placeholders with the imported artifacts' IDs.
4. Set the pipeline's source tenant, client ID, Key Vault URL and secret name.
5. Leave `EnableOrgDataPull=true` unless you provide a current valid directory table yourself.
6. Leave `RunId=""` for a new execution. The pipeline passes its own run UUID to every notebook. To resume a previously checkpointed audit run deliberately, set RunId to its saved UUID; all branches use that same ID.
7. Keep the notebook default output names unless you also adapt preparation and the template consistently.

The preparation activity depends on **Succeeded**, not Completed, for every input branch. Its audit and licensing snapshots must carry the same run ID. Org must match as well unless its Graph pull is disabled; an existing org snapshot must still pass age, tenant and schema checks.

Activity-level retries are zero: retry/resume is controlled by the notebooks and their durable audit query IDs, not by blindly starting another query. The audit activity has a seven-day outer timeout to accommodate multiple windows, while each query has its own bounded wait. Historical runs should still be split into manageable ranges.

Pipeline secure input/output settings keep parameter and activity details out of ordinary logs. They do not replace workspace permissions or Key Vault access control. The pipeline stores only a secret **name**, not the secret value.

## Schedule and Power BI refresh

Do not overlap executions. Allow all collection and preparation work to finish. Verify the SQL endpoint exposes the completed generation, then refresh the Power BI Import semantic model.

**The supplied pipeline does not include a Power BI refresh or publish action.** Configure the separate semantic-model refresh only after successful preparation and SQL synchronization. Do not use a fixed short delay as proof of synchronization: the template checks actual generations and counts and fails if the endpoint is not ready.

If collection fails, preparation does not run. If preparation fails during output replacement, the publication marker remains `Publishing`, which blocks template refresh. Correct the failure and rerun preparation; do not manually mark an incomplete snapshot Ready.
