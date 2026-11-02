"""Derive the PAX Tables source edition without changing the report or analytics."""
import argparse
import copy
import json
import re
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = "AI-in-One-v2.0.0-Fabric-OneLake-PAX-Template.pbit"
PARAMETERS = {
    "Fabric SQL Endpoint": ("null", "Text", "Required SQL analytics endpoint hostname, without https:// or whitespace. Used directly by Sql.Database."),
    "Fabric Lakehouse": ("null", "Text", "Required SQL database/Lakehouse name. Used directly by Sql.Database without target rewriting."),
    "PAX SQL Schema": ('"dbo"', "Text", "SQL schema containing the canonical PAX tables; use the actual SQL schema, not a OneLake URL."),
    "Load Agent365 catalog": ("false", "Logical", "True requires the PAX Agent365 table and read access. False deliberately uses activity-only agents; no SharePoint catalog is required."),
}
RENAMES = {"Copilot Interactions File": "Fabric SQL Endpoint", "Org Data File": "Fabric Lakehouse",
           "Agent 365 (highly recommended)": "Load Agent365 catalog",
           "fnValidateSharePointFileUrl": "fnAIOPaxDeltaColumns"}
EXTRA_CATALOG = ["Name", "Publisher Type", "Type", "Description", "Last Modified",
                 "Created by", "Creator Id", "Bot ID", "External ID", "Developer Name",
                 "Creator provenance", "Creator Provenance", "Creator Source", "Creator source"]


def text(value):
    return "\n".join(value) if isinstance(value, list) else value


def lineage(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/microsoft/AI-in-One-Dashboard/pax-source/" + name))


def project_artifact_id(kind):
    if kind not in ("Report", "SemanticModel"):
        raise ValueError("PAX project artifact kind must be Report or SemanticModel.")
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/microsoft/AI-in-One-Dashboard/pax-artifact/" + kind))


def sanitize(name):
    return re.sub(r"[ ,;{}()\n\t=]", "_", name)


def build(source, destination, source_m):
    with zipfile.ZipFile(source) as archive:
        original = json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))
        document = copy.deepcopy(original)
        model = document["model"]
        pending = json.loads(archive.read("UnappliedChanges").decode("utf-16-le").lstrip("\ufeff"))
        expressions = {e["name"]: e for e in model["expressions"]}
        # These are explicit producer column contracts, not underscore-to-space rewriting.
        users = ["PersonId", "DisplayName", "Email", "Organization", "JobTitle", "Country", "City", "Office", "Manager",
                 "Has license", "UserKey", "PersonId_Normalized", "License Status", "TotalEmployees",
                 "Manager_UserKey", "companyName", "employeeOrgData_division", "EffectiveDate"]
        interactions = ["UserKey", "InteractionDate", "AgentId", "AgentName", "AppHost", "Environment",
                        "License Status", "Context_Type", "Behavior_Category", "Behavior_Enriched", "AI_Model",
                        "Is_Sensitive", "Autonomy_Pattern", "AppIdentity_AppId", "AISystemPlugin_Name",
                        "ThreadId", "Message_Id", "CreationDate", "WeekStart", "MonthStart", "UserMonthKey",
                        "Has license", "Resource_Count", "SensitivityLabelId", "AccessedResource_Type",
                        "AccessedResource_Action", "AccessedResource_SiteUrl", "AccessedResource_SensitivityLabelId",
                        "AppIdentity_DisplayName", "AISystemPlugin_Id", "ModelTransparencyDetails_ModelName",
                        "Agent_TitleID", "Message_isPrompt", "Behavior_Source", "Value_Outcome", "ActivityDate"]
        catalog_source = text(expressions["AIO Agent Inventory Source"]["expression"])
        block = catalog_source.split("EmptyTable = #table(", 1)[1].split("{}", 1)[0]
        catalog = re.findall(r'"([^"]+)"', block) + EXTRA_CATALOG
        contracts = {"Users": users, "Interactions": interactions, "Catalog": list(dict.fromkeys(catalog))}
        mappings = {name: [[sanitize(c), c] for c in columns if sanitize(c) != c] for name, columns in contracts.items()}
        mapping_records = []
        for kind, pairs in mappings.items():
            values = ", ".join('{"' + a + '", "' + b + '"}' for a, b in pairs)
            mapping_records.append(kind + " = {" + values + "}")
        normalize = """(Rows as table, Kind as text) as table =>
let
    Contracts = [""" + ",\n        ".join(mapping_records) + """],
    Mapping = Record.Field(Contracts, Kind),
    Present = List.Select(Mapping, each Table.HasColumns(Rows, {_{0}})),
    Conflicts = List.Select(Present, each Table.HasColumns(Rows, {_{1}})),
    Checked = if not List.IsEmpty(Conflicts) then error "PAX Delta columns contain ambiguous canonical/sanitized duplicates."
        else Table.RenameColumns(Rows, Present, MissingField.Error)
in Checked"""
        required = """(Rows as table, Columns as list, Name as text) as table =>
    if not Table.HasColumns(Rows, Columns) then
        error Error.Record("PaxSchemaInvalid", Name & " is missing required processed PAX columns.",
            [Missing=List.Difference(Columns, Table.ColumnNames(Rows))])
    else Rows"""
        integer = """(Value as any, Name as text) as number =>
    if Value = null or Text.Trim(Text.From(Value)) = "" then
        error Error.Record("PaxKeyInvalid", Name & " must be a nonblank integer key.", null)
    else
        let Number = Number.FromText(Text.From(Value), "en-US")
        in if Number <> Number.RoundDown(Number) then
            error Error.Record("PaxKeyInvalid", Name & " must not be rounded.", null)
        else Int64.From(Number)"""
        users_source = """let
    Raw = #"AIO PAX SQL Source"{[Schema=#"PAX SQL Schema", Item="AIO_Users"]}[Data],
    Columns = fnAIOPaxDeltaColumns(Raw, "Users"),
    Required = fnAIOPaxRequiredColumns(Columns, {"UserKey", "PersonId", "Has license", "License Status"}, "AIO_Users"),
    Typed = Table.TransformColumns(Required, {{"UserKey", each fnAIOPaxIntegerKey(_, "Users UserKey"), Int64.Type}}),
    Keys = List.Buffer(Typed[UserKey]),
    Checked = if List.Count(Keys) <> List.Count(List.Distinct(Keys)) then
        error "PAX Users must contain unique state UserKeys."
        else Typed
in Checked"""
        activity_source = """let
    Raw = #"AIO PAX SQL Source"{[Schema=#"PAX SQL Schema", Item="AIO_CopilotInteractions"]}[Data],
    Columns = fnAIOPaxDeltaColumns(Raw, "Interactions"),
    Required = fnAIOPaxRequiredColumns(Columns, {"UserKey", "Message_Id", "ThreadId", "InteractionDate", "CreationDate", "WeekStart", "MonthStart", "ActivityDate", "Is_Sensitive", "AgentId"}, "AIO_CopilotInteractions"),
    UserKeys = List.Buffer(#"AIO Users Source"[UserKey]),
    UserIndex = Record.FromList(List.Repeat({true}, List.Count(UserKeys)), List.Transform(UserKeys, each Text.From(_, "en-US"))),
    Typed = Table.TransformColumns(Required, {
        {"UserKey", each fnAIOPaxIntegerKey(_, "Activity UserKey"), Int64.Type},
        {"Message_Id", each fnAIOPaxIntegerKey(_, "Message_Id"), Int64.Type},
        {"ThreadId", each fnAIOPaxIntegerKey(_, "ThreadId"), Int64.Type}}),
    Checked = Table.SelectRows(Typed, each
        if not Record.HasFields(UserIndex, Text.From([UserKey], "en-US")) then
            error Error.Record("PaxOrphanState", "Activity UserKey is absent from the matching Users table.", [UserKey=[UserKey]])
        else if Value.Is([Message_Id], Int64.Type) and Value.Is([ThreadId], Int64.Type) then true
        else error "PAX activity must contain exact integer message and thread keys.")
in Checked"""
        replacements = {"fnValidateSharePointFileUrl": normalize,
                        "AIO Users Source": users_source}
        facts = text(expressions["AIO Interactions Source"]["expression"])
        start = facts.index('            #"Typed Dates"') if '            #"Typed Dates"' in facts else facts.index('#"Typed Dates"')
        facts = 'let\n    #"Promoted Headers" = #"AIO PAX Activity",\n    ' + facts[start:]
        facts = facts.replace('each _ = "TRUE"', 'each if Value.Is(_, type logical) then _ else if _ = null or List.Contains({"", "UNKNOWN"}, Text.Upper(Text.Trim(Text.From(_)))) then null else if Text.Upper(Text.Trim(Text.From(_))) = "TRUE" then true else if Text.Upper(Text.Trim(Text.From(_))) = "FALSE" then false else error "Invalid PAX Is_Sensitive logical value."')
        replacements["AIO Interactions Source"] = facts
        agent = catalog_source
        old_line = next(line for line in agent.splitlines() if "RawContent = if fnValidateSharePointFileUrl" in line)
        agent = agent.replace(old_line, '''    CatalogRows = if not Value.Is(#"Load Agent365 catalog", type logical) then
        error "Load Agent365 catalog must be true or false."
        else if #"Load Agent365 catalog" then
            fnAIOPaxDeltaColumns(#"AIO PAX SQL Source"{[Schema=#"PAX SQL Schema", Item="Agent365"]}[Data], "Catalog")
        else null,''')
        agent = agent.replace("if RawContent <> null then", "if CatalogRows <> null then")
        csv_start = agent.index("Source = Csv.Document(")
        header_end = agent.index("\n", agent.index('Table.PromoteHeaders(Source, [PromoteAllScalars=true]),', csv_start))
        agent = agent[:csv_start] + 'Source = CatalogRows,\n                #"Promoted Headers" = Source,' + agent[header_end:]
        replacements["AIO Agent Inventory Source"] = agent
        new_expressions = []
        for item in model["expressions"]:
            old_name = item["name"]
            if old_name in replacements:
                item["expression"] = replacements[old_name]
            item["name"] = RENAMES.get(old_name, old_name)
            if item["name"] in PARAMETERS:
                value, kind, description = PARAMETERS[item["name"]]
                item.update(expression=f'{value} meta [IsParameterQuery=true, Type="{kind}", IsParameterQueryRequired=true]',
                            description=description)
            new_expressions.append(item)
        present = {e["name"] for e in new_expressions}
        for name, (value, kind, description) in PARAMETERS.items():
            if name not in present:
                new_expressions.append({"name": name, "kind": "m", "lineageTag": lineage(name),
                    "expression": f'{value} meta [IsParameterQuery=true, Type="{kind}", IsParameterQueryRequired=true]',
                    "description": description})
        for name, expression, description in (
            ("AIO PAX SQL Source", source_m.read_text(encoding="utf-8").strip(),
             "Static managed-parameter SQL connection. Table adapters are evaluated independently; this is not an atomic cross-table publication marker."),
            ("fnAIOPaxRequiredColumns", required, "Rejects missing processed PAX schema columns."),
            ("fnAIOPaxIntegerKey", integer, "Preserves exact integer identifiers and rejects missing or fractional keys."),
            ("AIO PAX Activity", activity_source,
             "Streaming activity key validation using a Users-key-only index; no full activity buffer or row-count gate."),
        ):
            new_expressions.append({"name": name, "kind": "m", "lineageTag": lineage(name),
                                    "expression": expression, "description": description})
        model["expressions"] = new_expressions
        for annotation in model.get("annotations", []):
            if annotation["name"] == "PBI_QueryOrder":
                order = [RENAMES.get(n, n) for n in json.loads(annotation["value"])]
                annotation["value"] = json.dumps(order + [e["name"] for e in new_expressions if e["name"] not in order])
        by_name = {e["name"]: e for e in new_expressions}
        for query in pending["queries"]:
            old = query["name"]
            query["name"] = RENAMES.get(old, old)
            if old in RENAMES or old in replacements:
                definition = by_name[query["name"]]
                query["text"] = text(definition["expression"]).splitlines()
                query["description"] = definition.get("description", "")
                if "lastLoadedAsTableFormulaText" in query:
                    query["lastLoadedAsTableFormulaText"] = query["text"]
        names = {q["name"] for q in pending["queries"]}
        for expression in new_expressions:
            if expression["name"] not in names:
                pending["queries"].append({"name": expression["name"], "lineageTag": expression["lineageTag"],
                    "description": expression.get("description", ""), "text": text(expression["expression"]).splitlines(),
                    "loadAsTableDisabled": True, "resultType": "Unknown", "isHidden": False})
        assert model["tables"] == original["model"]["tables"]
        assert model["relationships"] == original["model"]["relationships"]
        assert model["roles"] == original["model"]["roles"]
        all_m = "\n".join(text(e["expression"]) for e in new_expressions)
        assert "Web.Contents(" not in all_m and "File.Contents(" not in all_m and "aio_v2_publication" not in all_m
        assert 'Sql.Database(#"Fabric SQL Endpoint", #"Fabric Lakehouse"' in all_m
        destination.parent.mkdir(parents=True, exist_ok=True)
        replacements_bytes = {
            "DataModelSchema": json.dumps(document, indent=2, ensure_ascii=False).encode("utf-16-le"),
            "UnappliedChanges": json.dumps(pending, indent=2, ensure_ascii=False).encode("utf-16-le"),
        }
        with zipfile.ZipFile(destination, "w") as output:
            for entry in archive.infolist():
                output.writestr(copy.copy(entry), replacements_bytes.get(entry.filename, archive.read(entry.filename)))
        with zipfile.ZipFile(destination) as output:
            assert output.testzip() is None
            assert {n for n in archive.namelist() if archive.read(n) != output.read(n)} == set(replacements_bytes)
    return document


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT / "templates" / "AI-in-One-v2.0.0-SharePoint-Template.pbit")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-m", type=Path, default=Path(__file__).with_name("pax_fabric_tables.m"))
    args = parser.parse_args()
    build(args.source, args.output, args.source_m)
