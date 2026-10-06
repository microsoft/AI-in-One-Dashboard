"""Build self-contained Fabric notebooks from reviewed sources and pinned AIO classifiers."""

import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts" / "Purview_CopilotInteraction_Processor_v4.2.3.py"


def classifier_source():
    source = SOURCE.read_text(encoding="utf-8-sig")
    tree = ast.parse(source)
    definitions = {}
    imports = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imports.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            definitions[node.name] = node
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    definitions[target.id] = node
    pending = ["explode_record", "FACT_HEADER_AIO", "GRAIN_KEYS_AIO", "parse_creation_time"]
    needed = set()
    while pending:
        name = pending.pop()
        if name in needed or name not in definitions:
            continue
        needed.add(name)
        pending.extend(n.id for n in ast.walk(definitions[name]) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load))
    nodes = {id(definitions[name]): definitions[name] for name in needed}
    chosen = sorted(list(nodes.values()) + imports, key=lambda node: node.lineno)
    pieces = []
    for node in chosen:
        decorators = getattr(node, "decorator_list", [])
        if any(not ast.unparse(decorator).startswith("functools.lru_cache(") for decorator in decorators):
            raise ValueError("Review new classifier decorators before embedding them in Spark.")
        # Notebook-local LRU wrappers are pickled by name and cannot load in Spark workers.
        first = node.lineno
        pieces.append("\n".join(source.splitlines()[first - 1:node.end_lineno]))
    result = ("# Generated from the repository's AIO processor. Do not hand-edit this cell.\n"
              "# LRU decorators omitted for Spark worker serialization; classifier logic is unchanged.\n"
              f"# Source SHA-256: {hashlib.sha256(source.encode('utf-8')).hexdigest()}\n\n" +
              "\n\n".join(pieces) + "\n")
    compile(result, "<embedded-classifiers>", "exec")
    namespace = {}
    exec(result, namespace)
    assert callable(namespace["explode_record"])
    return result


def cell(kind, content, tags=None):
    if not content.endswith("\n"):
        content += "\n"
    value = {"cell_type": kind, "metadata": {}, "source": content.splitlines(keepends=True)}
    if tags:
        value["metadata"]["tags"] = tags
    if kind == "code":
        value.update(execution_count=None, outputs=[])
    return value


AUTH = {
    "TENANT_ID": "<source-tenant-guid>", "CLIENT_ID": "<app-registration-client-id>",
    "KEY_VAULT_URL": "https://<your-vault>.vault.azure.net/", "SECRET_NAME": "<client-secret-name>",
    "RUN_ID": "",
}
SPECS = [
    ("Copilot_Audit_Log_Direct_Ingester", "Collect audit history safely", "audit", {
        **AUTH, "MODE": "incremental", "BACKFILL_DAYS": 7, "OVERLAP_DAYS": 7,
        "START_UTC": "", "END_UTC": "", "CHUNK_HOURS": 24, "MAX_CONCURRENT_QUERIES": 2,
        "MAX_WAIT_MIN_PER_QUERY": 240, "POLL_INTERVAL_SEC": 30,
        "OUTPUT_TABLE": "aio_v2_audit_raw", "STATUS_TABLE": "aio_v2_audit_status",
    }),
    ("Copilot_Org_Data_Direct_Ingester", "Collect directory and manager metadata", "directory", {
        **AUTH, "OUTPUT_TABLE": "aio_v2_org_raw",
    }),
    ("Copilot_Licensed_Users_Direct_Ingester", "Collect a current licensing snapshot", "licensing", {
        **AUTH, "OUTPUT_TABLE": "aio_v2_licenses_raw", "REPORT_PERIOD": "D30",
        "COPILOT_PRODUCT_NAMES": "MICROSOFT 365 COPILOT",
    }),
    ("Copilot_Report_Data_Preparation", "Prepare and validate the v2.0.0 report tables", "prepare", {
        "TENANT_ID": "<source-tenant-guid>", "RUN_ID": "",
        "AUDIT_TABLE": "aio_v2_audit_raw", "AUDIT_STATUS_TABLE": "aio_v2_audit_status",
        "ORG_TABLE": "aio_v2_org_raw", "LICENSE_TABLE": "aio_v2_licenses_raw",
        "USERS_TABLE": "aio_v2_users", "INTERACTIONS_TABLE": "aio_v2_interactions",
        "PUBLICATION_TABLE": "aio_v2_publication", "USE_EXISTING_ORG": False,
        "MAX_INPUT_AGE_HOURS": 48, "MAX_LICENSE_REPORT_AGE_DAYS": 7,
        "REQUIRE_ALL_ACTIVITY_USERS_IN_DIRECTORY": False,
    }),
]


def build_pipeline():
    run = "@if(empty(pipeline().parameters.RunId), pipeline().RunId, pipeline().parameters.RunId)"

    def parameter(expression, kind="string"):
        return {"value": {"value": expression, "type": "Expression"}, "type": kind}

    shared = {key: parameter("@pipeline().parameters." + key) for key in
              ("TENANT_ID", "CLIENT_ID", "KEY_VAULT_URL", "SECRET_NAME")}
    shared["RUN_ID"] = parameter(run)

    def activity(name, placeholder, parameters, timeout="0.02:00:00"):
        return {
            "name": name, "type": "TridentNotebook", "dependsOn": [],
            "policy": {"timeout": timeout, "retry": 0, "retryIntervalInSeconds": 60,
                       "secureInput": True, "secureOutput": True},
            "typeProperties": {"notebookId": placeholder, "workspaceId": "REPLACE_WITH_WORKSPACE_ID",
                               "parameters": parameters},
        }

    audit = activity("Run_Audit_Log_Ingester", "REPLACE_WITH_AUDIT_LOG_NOTEBOOK_ID", dict(shared), "7.00:00:00")
    licenses = activity("Run_Licensed_Users_Ingester", "REPLACE_WITH_LICENSED_USERS_NOTEBOOK_ID", dict(shared))
    org = {"name": "Conditionally_Run_Org_Data", "type": "IfCondition", "dependsOn": [], "typeProperties": {
        "expression": {"value": "@pipeline().parameters.EnableOrgDataPull", "type": "Expression"},
        "ifTrueActivities": [activity("Run_Org_Data_Ingester", "REPLACE_WITH_ORG_DATA_NOTEBOOK_ID", dict(shared))],
        "ifFalseActivities": [],
    }}
    prepare = activity("Prepare_Report_Data", "REPLACE_WITH_PREPARATION_NOTEBOOK_ID", {
        "TENANT_ID": parameter("@pipeline().parameters.TENANT_ID"), "RUN_ID": parameter(run),
        "USE_EXISTING_ORG": parameter("@not(pipeline().parameters.EnableOrgDataPull)", "bool"),
    })
    prepare["dependsOn"] = [{"activity": name, "dependencyConditions": ["Succeeded"]} for name in
                            ("Run_Audit_Log_Ingester", "Run_Licensed_Users_Ingester", "Conditionally_Run_Org_Data")]
    pipeline = {
        "properties": {
            "description": "AIO v2: parallel collection, then validated preparation. Refresh the Import semantic model only after this pipeline succeeds and SQL endpoint synchronization completes. Do not overlap runs.",
            "activities": [audit, licenses, org, prepare], "annotations": [],
            "parameters": {
                **{key: {"type": "String", "defaultValue": value} for key, value in AUTH.items() if key != "RUN_ID"},
                "RunId": {"type": "String", "defaultValue": ""},
                "EnableOrgDataPull": {"type": "Boolean", "defaultValue": True},
            },
        },
    }
    path = PACKAGE / "pipelines" / "CopilotAdoptionPipeline.DataPipeline" / "pipeline-content.json"
    path.write_text(json.dumps(pipeline, indent=2), encoding="utf-8")
    print("Built success-gated four-notebook pipeline.")


def build():
    classifiers = classifier_source()
    (PACKAGE / "src" / "classification_generated.py").write_text(classifiers, encoding="utf-8")
    common = (PACKAGE / "src" / "common.py").read_text(encoding="utf-8")
    for name, title, module, params in SPECS:
        config = "# Fabric parameter cell; pipeline parameters override these values.\n" + "\n".join(
            f"{key} = {value!r}" for key, value in params.items())
        code = (PACKAGE / "src" / f"{module}.py").read_text(encoding="utf-8")
        invocation = "run_preparation" if module == "prepare" else "run_" + module
        cells = [
            cell("markdown", f"# AI-in-One Fabric OneLake v2.0.0\n\n## {title}\n\n"
                 "Attach the same **default Lakehouse** to all four notebooks. "
                 "Bare table names resolve in the default Lakehouse (dbo on schema-enabled Lakehouses). "
                 "This package writes only `aio_v2_` (or explicit `aio_test_`) tables. "
                 "Power BI remains Import through the SQL analytics endpoint. Tables outside the `aio_v2_` prefix are never overwritten.\n\n"
                 "Configure the parameter cell before running. Keep notebook outputs free of credentials and personal data."),
            cell("code", config, ["parameters"]),
            cell("code", common),
        ]
        if module == "prepare":
            cells.append(cell("code", classifiers))
        cells.append(cell("code", code))
        cells.append(cell("code", f"{invocation}(spark, {{{', '.join(repr(key) + ': ' + key for key in params)}}})"))
        notebook = {
            "nbformat": 4, "nbformat_minor": 5, "cells": cells,
            "metadata": {
                "kernelspec": {"display_name": "Synapse PySpark", "language": "python", "name": "synapse_pyspark"},
                "language_info": {"name": "python"},
                "microsoft": {"host": {"trident": True}},
            },
        }
        for index, value in enumerate(cells):
            value["id"] = hashlib.sha256((name + str(index)).encode()).hexdigest()[:12]
        target = PACKAGE / "notebooks" / (name + ".ipynb")
        target.write_text(json.dumps(notebook, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Built {target.name}: {len(cells)} self-contained cells.")
    (PACKAGE / "src" / "processor-provenance.json").write_text(json.dumps({
        "source": "scripts/Purview_CopilotInteraction_Processor_v4.2.3.py",
        "sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "profile": "aio",
        "note": "Only the transitive pure classifier dependencies and schema constants are embedded. "
                "LRU decorators are omitted for Spark worker serialization. Stable keys and Spark publication "
                "are provided by this package; the source processor is unchanged.",
    }, indent=2), encoding="utf-8")
    build_pipeline()


if __name__ == "__main__":
    build()
