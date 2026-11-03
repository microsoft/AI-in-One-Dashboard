"""Extract presentation metadata only; never publish the model or its connections."""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[3]
source = root / "templates" / "AI-in-One-v2.0.0-Local-CSV-Template.pbit"
target = Path(__file__).resolve().parents[1] / "src" / "report" / "layout.json"


def literal(value, default=None):
    if not isinstance(value, dict):
        return default
    if "Literal" in value:
        raw = value["Literal"]["Value"]
        if raw in ("true", "false"):
            return raw == "true"
        if raw.startswith("'"):
            return raw[1:-1].replace("''", "'")
        try:
            return float(raw.rstrip("DL"))
        except ValueError:
            return default
    for key in ("expr", "solid", "color"):
        if key in value:
            return literal(value[key], default)
    return default


def prop(objects, group, name, default=None):
    for item in objects.get(group, []):
        if name in item.get("properties", {}):
            return literal(item["properties"][name], default)
    return default


def binding(value):
    for kind in ("Measure", "Column"):
        if kind in value:
            return {"kind": kind.lower(), "name": value[kind]["Property"],
                    "entity": value[kind].get("Expression", {}).get("SourceRef", {}).get("Entity", "")}
    if "PropertyVariationSource" in value:
        return {"kind": "column", "name": value["PropertyVariationSource"]["Property"]}
    for child in value.values():
        if isinstance(child, dict):
            found = binding(child)
            if found:
                return found
    return None


with zipfile.ZipFile(source) as archive:
    model_bytes = archive.read("DataModelSchema")
    model = json.loads(model_bytes.decode("utf-16-le") if model_bytes[1] == 0 else model_bytes.decode("utf-8-sig"))
    formats = {
        measure["name"]: measure.get("formatString", "")
        for table in model["model"]["tables"]
        for measure in table.get("measures", [])
    }
    page_root = "Report/definition/pages/"
    order = json.loads(archive.read(page_root + "pages.json"))["pageOrder"]
    pages = []
    for page_id in order:
        page = json.loads(archive.read(page_root + page_id + "/page.json"))
        if page.get("visibility") == "HiddenInViewMode" or page.get("type") == "Tooltip":
            continue
        prefix = page_root + page_id + "/visuals/"
        originals = {
            entry.split("/")[-2]: json.loads(archive.read(entry))
            for entry in archive.namelist()
            if entry.startswith(prefix) and entry.endswith("/visual.json")
        }

        def hidden(visual):
            if visual.get("isHidden"):
                return True
            parent = visual.get("parentGroupName")
            return parent in originals and hidden(originals[parent])

        visuals = []
        for item in originals.values():
            if hidden(item) or "visual" not in item:
                continue
            visual = item["visual"]
            kind = visual["visualType"]
            # Only original presentation properties and field names leave the package.
            if kind == "image":
                continue
            objects = visual.get("objects", {})
            container = visual.get("visualContainerObjects", {})
            roles = {}
            for role, state in visual.get("query", {}).get("queryState", {}).items():
                fields = []
                for projection in state.get("projections", []):
                    if projection.get("active") is False:
                        continue
                    field = binding(projection.get("field", {}))
                    if field:
                        fields.append({
                            **field,
                            "label": projection.get("displayName") or projection.get("nativeQueryRef") or field["name"],
                            "format": formats.get(field["name"], ""),
                        })
                if fields:
                    roles[role] = fields
            paragraphs = []
            text_styles = []
            for general in objects.get("general", []):
                for paragraph in general.get("properties", {}).get("paragraphs", []):
                    paragraphs.append("".join(str(run.get("value", "")) for run in paragraph.get("textRuns", [])))
                    text_styles.extend(run.get("textStyle", {}) for run in paragraph.get("textRuns", []))
            text = "\n".join(paragraphs) or prop(objects, "text", "text", "")
            text_expr = next(
                (binding(x.get("properties", {}).get("text", {}))
                 for x in objects.get("text", [])
                 if binding(x.get("properties", {}).get("text", {}))),
                None,
            )
            title = prop(container, "title", "text", "")
            title = re.sub(r"Right-click agent name.*", "Click an agent name for details", title)
            text_style = text_styles[0] if text_styles else {}
            fields = [f for group in roles.values() for f in group]
            visuals.append({
                "id": item["name"],
                "type": kind,
                "position": {k: item["position"].get(k, 0) for k in ("x", "y", "width", "height", "z")},
                "title": title,
                "text": text,
                "textMeasure": text_expr["name"] if text_expr else "",
                "roles": roles,
                "fontSize": float(re.sub(r"[^\d.]", "", text_style.get("fontSize", "10pt")))
                if kind == "textbox" else prop(objects, "value", "fontSize", 18),
                "bold": text_style.get("fontWeight") == "bold",
                "color": text_style.get("color", prop(objects, "value", "fontColor", "#52617A")),
                "background": prop(container, "background", "color", "#FFFFFF")
                if prop(container, "background", "transparency", 100) < 100 else "transparent",
                "border": prop(container, "border", "show", False),
                "palette": [
                    literal(p.get("properties", {}).get("fill") or p.get("properties", {}).get("defaultColor"), "#543477")
                    for p in objects.get("dataPoint", [])
                ] or ["#543477", "#008575", "#0078D4"],
                "fields": fields,
            })
        pages.append({
            "id": page_id,
            "name": page["displayName"],
            "width": page["width"],
            "height": page["height"],
            "visuals": visuals,
        })
    output = {
        "source": source.name,
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "pages": pages,
    }
    encoded = json.dumps(output, ensure_ascii=True, separators=(",", ":")) + "\n"
    if re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", encoded):
        sys.exit("Unexpected address in report presentation metadata; inspect before publication.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(encoded, encoding="utf-8")
    print(f"Extracted {len(pages)} report pages; model, connections and data excluded.")
