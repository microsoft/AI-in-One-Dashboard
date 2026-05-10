# Fabric pipelines

Scheduled orchestration for the Direct Ingester notebooks. Two ways to use:

## Option A — Manual deployment (works today)

1. **Import the 3 notebooks** into your Fabric workspace first (one-time):
   - `3. Fabric/notebooks/Copilot_Audit_Log_Direct_Ingester.ipynb`
   - `3. Fabric/notebooks/Copilot_Licensed_Users_Direct_Ingester.ipynb`
   - `3. Fabric/notebooks/Copilot_Org_Data_Direct_Ingester.ipynb`

2. **Find each notebook's ID** — open the notebook in Fabric, look at the URL:
   ```
   https://app.fabric.microsoft.com/groups/<WORKSPACE_ID>/synapsenotebooks/<NOTEBOOK_ID>?experience=...
                                          ^^^^^^^^^^^^^^                  ^^^^^^^^^^^^
   ```
   Both GUIDs are visible in the URL. Save them — you'll need 4 GUIDs total (1 workspace + 3 notebooks).

3. **Create a new pipeline** in Fabric:
   - Workspace → **+ New** → **Data pipeline** → name it `CopilotAdoptionPipeline`
   - Use the JSON view (toolbar → **View** → **JSON** or "Code") and paste the contents of [`CopilotAdoptionPipeline.DataPipeline/pipeline-content.json`](CopilotAdoptionPipeline.DataPipeline/pipeline-content.json)
   - Replace the 4 placeholder values:
     - `REPLACE_WITH_AUDIT_LOG_NOTEBOOK_ID` → your audit-log notebook GUID
     - `REPLACE_WITH_LICENSED_USERS_NOTEBOOK_ID` → your users notebook GUID
     - `REPLACE_WITH_ORG_DATA_NOTEBOOK_ID` → your org-data notebook GUID
     - `REPLACE_WITH_WORKSPACE_ID` → your workspace GUID (same for all 3 activities)
   - Save

4. **Run manually first** to validate: pipeline editor → **Run** at top. Should kick off the 3 notebooks in parallel. Audit log activity typically runs 5–15 min (Purview polling); users + org each <30 sec.

5. **Schedule it**: pipeline editor → **Schedule** at top → e.g. weekly Sunday 02:00. Activities run on the same cadence.

## Option B — Tier 1 Fabric Git Integration (in development)

The Tier 1 work-in-progress will make this pipeline plus the 3 notebooks deployable via Fabric Git Sync — customer connects their workspace to this repo's branch, clicks Sync, all items appear. No manual GUID-swapping. See `Automation Scripts/Tier 1 — Fabric Git Integration Plan.md` for the build plan.

Until Tier 1 ships, Option A above is the working approach.

## Activity design notes

| Activity | Runtime | Why it's parallel-safe |
|---|---|---|
| `Run_Audit_Log_Ingester` | 5–15 min (Purview-bound) | Reads Graph audit log API; writes to `dbo.copilot_interactions_parsed`. No dependency on other tables. |
| `Run_Licensed_Users_Ingester` | <30 sec | Reads Graph reports endpoint; writes to `dbo.copilot_licensed_users`. No dependency on audit log. |
| `Conditionally_Run_Org_Data` → `Run_Org_Data_Ingester` | <30 sec when enabled | Reads Graph users endpoint; writes to `dbo.copilot_org_data`. **Optional** — gated by the `EnableOrgDataPull` parameter. |

Since the 3 tables are independent (joined later at the model layer in the PBIT), the activities can run in parallel for fastest total runtime ≈ max(audit, users, org) ≈ 15 min vs sequential ≈ 16 min. Tiny gain, but cleaner conceptually.

## Pipeline parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `EnableOrgDataPull` | Boolean | `true` | When `false`, the Org Data Ingester is skipped. Use this for customers who upload Entra/HRIS data manually (e.g. from their internal HRIS system) instead of pulling from Microsoft Graph — common because Graph's `/users` data is often incomplete vs the customer's source-of-truth HRIS. |

When you trigger the pipeline manually, Fabric prompts for parameter values. When you schedule it (via the Schedule button), the schedule definition stores fixed parameter values — you can have, e.g., a weekly Sunday schedule with `EnableOrgDataPull = true`, OR set it to `false` if you want the schedule to skip Org Data even when fired.

## Failure handling

- Each activity has `retry: 1` (audit log) or `retry: 2` (users/org) at 60s intervals — handles transient Graph throttling
- If audit log fails after retry, users + org still complete (parallel branches don't block each other)
- If any single activity ultimately fails, the pipeline run is marked failed but partial Delta writes are preserved
- Use Fabric Monitor Hub → Pipeline runs → click into the failed activity → view notebook job log for diagnostics

## Schedule recommendation

Microsoft Graph's audit log API caps each query at 7 days back. Recommended schedule cadence:

| Cadence | When | Trade-off |
|---|---|---|
| **Weekly** (recommended) | Sundays 02:00 UTC | Matches Graph's 7-day window cleanly; no overlap, no gaps |
| Daily | 02:00 UTC | More frequent updates; needs careful date-window management to avoid duplicate rows (the audit log Message_Id dedup mostly handles this) |
| Monthly | Last day of month | Misses any 8th+ day of data — only use if you accept this |

The 3 activities can share the same schedule, or you can give users + org a different (slower) cadence since they snapshot quickly-changing data less often.
