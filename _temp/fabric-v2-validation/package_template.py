import argparse
import copy
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[2]
CANDIDATE = Path(__file__).resolve().parent / "candidate"
SOURCE = ROOT / "templates" / "AI-in-One-v2.0.0-SharePoint-Template.pbit"
FABRIC = ROOT / "templates" / "AI-in-One-v2.0.0-Fabric-OneLake-Template.pbit"
RENAMES = {"Copilot Interactions File": "Fabric SQL Endpoint", "Org Data File": "Fabric Lakehouse"}
CHANGED = set(RENAMES.values()) | {"AIO Users Source", "AIO Interactions Source", "AIO Fabric Snapshot"}
AGENT_RELATIONSHIP = "6450cf9f-bcd4-c54f-9874-d25c67e16d03"


def expression(value):
    return "\n".join(value) if isinstance(value, list) else value


def utf16(value, original):
    return (("\ufeff" if original.startswith(b"\xff\xfe") else "") + json.dumps(value, ensure_ascii=False, indent=2)).encode("utf-16le")


def build(source=SOURCE, candidate=CANDIDATE, authored_model=None):
    candidate.mkdir(parents=True, exist_ok=True)
    if authored_model is not None:
        authored = json.loads(authored_model.read_text(encoding="utf-8-sig"))
    else:
        with zipfile.ZipFile(FABRIC) as seed:
            authored = json.loads(seed.read("DataModelSchema").decode("utf-16le").lstrip("\ufeff"))
    desired = {e["name"]: e for e in authored["model"]["expressions"]}
    assert CHANGED <= desired.keys()
    with zipfile.ZipFile(source) as before:
        original = json.loads(before.read("DataModelSchema").decode("utf-16le").lstrip("\ufeff"))
        model = copy.deepcopy(original)
        for item in model["model"]["expressions"]:
            item["name"] = RENAMES.get(item["name"], item["name"])
            if item["name"] in CHANGED:
                update = desired[item["name"]]
                item["expression"] = expression(update["expression"])
                item["description"] = update.get("description", "")
        new = desired["AIO Fabric Snapshot"]
        model["model"]["expressions"].append({key: value for key, value in new.items()
                                               if key in ("name", "kind", "expression", "description", "lineageTag")})
        relation = next(r for r in model["model"]["relationships"] if r["name"] == AGENT_RELATIONSHIP)
        authored_relation = next(r for r in authored["model"]["relationships"] if r["name"] == AGENT_RELATIONSHIP)
        assert relation["fromColumn"] == "Agent_TitleID"
        assert authored_relation["fromColumn"] == "Agent_TitleID"
        for field in ("fromTable", "toTable", "toColumn", "crossFilteringBehavior", "securityFilteringBehavior"):
            assert relation[field] == authored_relation[field], field
        relation["fromColumn"] = authored_relation["fromColumn"]
        for annotation in model["model"].get("annotations", []):
            if annotation["name"] == "PBI_QueryOrder":
                order = [RENAMES.get(name, name) for name in json.loads(annotation["value"])]
                order.append("AIO Fabric Snapshot")
                annotation["value"] = json.dumps(order)
        pending = json.loads(before.read("UnappliedChanges").decode("utf-16le").lstrip("\ufeff"))
        for query in pending["queries"]:
            query["name"] = RENAMES.get(query["name"], query["name"])
            if query["name"] in CHANGED:
                update = desired[query["name"]]
                query["text"] = expression(update["expression"]).splitlines()
                query["description"] = update.get("description", "")
                if "lastLoadedAsTableFormulaText" in query:
                    query["lastLoadedAsTableFormulaText"] = query["text"]
        pending["queries"].append({
            "name": new["name"], "lineageTag": new["lineageTag"], "description": new["description"],
            "text": expression(new["expression"]).splitlines(), "loadAsTableDisabled": True,
            "resultType": "Record", "isHidden": False,
        })
        replacements = {"DataModelSchema": utf16(model, before.read("DataModelSchema")),
                        "UnappliedChanges": utf16(pending, before.read("UnappliedChanges"))}
        target = candidate / "AI-in-One-v2.0.0-Fabric-OneLake-Template.pbit"
        assert target.resolve() not in {source.resolve(), FABRIC.resolve()}, "Build a candidate before replacing a deliverable."
        with zipfile.ZipFile(target, "w") as after:
            for info in before.infolist():
                after.writestr(copy.copy(info), replacements.get(info.filename, before.read(info.filename)))
        with zipfile.ZipFile(target) as after:
            assert after.testzip() is None
            assert before.namelist() == after.namelist()
            assert {name for name in before.namelist() if before.read(name) != after.read(name)} == set(replacements)
            assert "DataModel" not in after.namelist() and "SecurityBindings" not in after.namelist()
        assert model["model"]["tables"] == original["model"]["tables"]
        assert model["model"]["relationships"] == original["model"]["relationships"]
        assert model["model"]["roles"] == original["model"]["roles"]
        assert len(model["model"]["tables"]) == len(original["model"]["tables"])
        measures = sum(len(t.get("measures", [])) for t in model["model"]["tables"])
        assert measures == sum(len(t.get("measures", [])) for t in original["model"]["tables"])
        assert {r["name"] for r in model["model"]["roles"]} == {"Reporting hierarchy", "All data viewers"}
        assert not any("members" in r and r["members"] for r in model["model"]["roles"])
        current = {e["name"]: e for e in model["model"]["expressions"]}
        assert current["Minimum Group Size"]["expression"].lstrip().startswith("3")
        for name in ("Fabric SQL Endpoint", "Fabric Lakehouse", "Agent 365 (highly recommended)"):
            assert expression(current[name]["expression"]).split(" meta", 1)[0].strip() in {'""', "null"}, name
        for query in pending["queries"]:
            if query["name"] in CHANGED:
                assert "\n".join(query["text"]).strip() == expression(current[query["name"]]["expression"]).strip()
        for name in RENAMES:
            assert name not in json.dumps(model) and name not in json.dumps(pending)
        report = candidate / "AIO.Report"
        for info in before.infolist():
            if info.filename.startswith("Report/"):
                relative = Path(*info.filename.split("/")[1:])
                destination = report / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(before.read(info.filename))
        (candidate / "model.json").write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
        (candidate / "template-static-validation.json").write_text(json.dumps({
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "candidate_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "tables": len(model["model"]["tables"]), "measures": measures,
            "relationships": len(model["model"]["relationships"]), "roles": len(model["model"]["roles"]),
            "report_entries_byte_identical": True, "minimum_group_size": 3,
            "pending_queries_synchronized": True, "embedded_data": False,
            "agent_relationship_uses_resolved_key": True, "security_filter_directions_preserved": True,
        }, indent=2), encoding="utf-8")
    print(f"PASS: {measures} measures; only Fabric sources and matching pending queries changed. "
          "Report, tables, relationships, and roles match SharePoint.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Derive the Fabric candidate from the current SharePoint PBIT.")
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--candidate-dir", type=Path, default=CANDIDATE)
    parser.add_argument("--authored-model", type=Path,
                        help="Optional authored BIM for the five Fabric source overrides; otherwise use the existing Fabric PBIT.")
    args = parser.parse_args()
    build(args.source, args.candidate_dir, args.authored_model)
