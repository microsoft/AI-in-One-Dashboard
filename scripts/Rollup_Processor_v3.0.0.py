#!/usr/bin/env python3
"""
Purview CopilotInteraction Processor v3.0.0
-------------------------------------------
Two-input / two-output preprocessor for the AI Business Value Dashboard
and AI-in-One Rollup PBIPs.

Inputs:
    --purview <raw Purview audit log CSV>     (required)
    --entra   <Entra users CSV w/ licensing>  (required)

Outputs (in --out-dir, default = directory of --purview):
    <purview_stem>_Interactions_<YYYYMMDD_HHMMSS>.csv   (fact table)
    <entra_stem>_Users_<YYYYMMDD_HHMMSS>.csv            (dim table)

Grain (Option D):
    One row per (16-column grain x Message_Id). DAX measures use
    DISTINCTCOUNT(Message_Id) which yields exact BEFORE-PBIP parity at
    every visual / slicer combination. Replaces the v3.0.0 PromptCount
    grain (which inflated counts by ~2.25x via per-resource explosion).

INT-surrogated columns (perf):
    Message_Id, ThreadId, and UserKey (replaces Audit_UserId) are emitted
    as 1-based INTs assigned in input encounter order. Cuts CSV size,
    parse time, AND VertiPaq dictionary build time on the three highest-
    cardinality GUID columns. UserKey is written to BOTH the fact CSV
    and the Users dim CSV (same shared map keyed on normalized UPN), so
    the fact↔Users relationship is INT-to-INT. DISTINCTCOUNT semantics
    are identical between INT and string surrogates of the same set.
    UserMonthKey stays string (cross-processor blast radius).

Calc cols ported from DAX -> precomputed here for ingestion-time speedup:
    Agent_TitleID, Behavior_Source, Value_Outcome, ActivityDate
    (= InteractionDate alias).

Stays in DAX (cross-table dependencies that cannot be precomputed without
shipping Agents 365 / UserMonthMetrics / AgentMetrics into the processor):
    Behavior_Enriched_Full (RELATED Agents 365),
    User_Stage_Maturity / User_Stage (RELATED UserMonthMetrics),
    Usage_Mode, Expertise_Role, Efficiency_Breakdown
    (all depend on Behavior_Enriched_Full),
    Agent Last Used Date (LOOKUPVALUE AgentMetrics).

Requirements:
    Python 3.9+
    pip install orjson   (OPTIONAL - faster JSON parsing; falls back to stdlib json)
"""

from __future__ import annotations

import argparse
import csv
import functools
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import orjson

    def json_loads(value: str | bytes) -> Any:
        if isinstance(value, str):
            value = value.encode("utf-8")
        return orjson.loads(value)

    _JSON_ENGINE = "orjson"
except ImportError:
    import json as _json

    def json_loads(value: str | bytes) -> Any:
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        return _json.loads(value)

    _JSON_ENGINE = "json (stdlib)"


SCRIPT_VERSION = "3.0.0"

# ---------------------------------------------------------------------------
# Output schemas
# ---------------------------------------------------------------------------

# Grain keys used for rollup groupby. Mirrors the slicer/filter dimensions
# that any AIO or AIBV BEFORE PBIP visual binds to. AccessedResource_*,
# CreationDate, Resource_Count, etc. are NOT in the grain because they are
# either per-resource (would fan rows back out and break parity) or
# derivable / per-prompt-only.
GRAIN_KEYS: tuple[str, ...] = (
    "UserKey",
    "InteractionDate",
    "AgentId",
    "AgentName",
    "AppHost",
    "Environment",
    "License Status",
    "Context_Type",
    "Behavior_Category",
    "Behavior_Enriched",
    "AI_Model",
    "Is_Sensitive",
    "Autonomy_Pattern",
    "AppIdentity_AppId",
    "AISystemPlugin_Name",
    "ThreadId",
)

# Per-(grain x Message_Id) attributes carried through to the output row.
# Some are constant per Message_Id (CreationDate, Has license, Agent_TitleID,
# WeekStart/MonthStart/UserMonthKey, AppIdentity_DisplayName, ModelName,
# AISystemPlugin_Id, Audit_UserId_Normalized); a few may vary across the
# resources collapsed into one row (SensitivityLabelId, AccessedResource_*)
# for which last-resource-wins is the deterministic choice — same semantic
# as the prior dict-overwrite behavior.
_NONGRAIN_ATTRS: tuple[str, ...] = (
    "CreationDate",
    "WeekStart",
    "MonthStart",
    "UserMonthKey",
    "Has license",
    "Resource_Count",
    "SensitivityLabelId",
    "AccessedResource_Type",
    "AccessedResource_Action",
    "AccessedResource_SiteUrl",
    "AccessedResource_SensitivityLabelId",
    "AppIdentity_DisplayName",
    "AISystemPlugin_Id",
    "ModelTransparencyDetails_ModelName",
    "Agent_TitleID",
    "Message_isPrompt",
    # Calc cols ported from DAX
    "Behavior_Source",
    "Value_Outcome",
    "ActivityDate",
)

# Final fact CSV schema. One row per (grain x Message_Id). Message_Id is
# emitted as a sequential INT surrogate (1-based, assigned in input order).
FACT_HEADER: list[str] = list(GRAIN_KEYS) + ["Message_Id"] + list(_NONGRAIN_ATTRS)

# Entra column-name aliases used by the existing PBIP M-code. We mirror the
# same renaming so the dim CSV is drop-in compatible with all downstream DAX.
UPN_VARIANTS_NORMALIZED = {"userprincipalname", "upn", "personid"}
DEPARTMENT_VARIANT_NORMALIZED = "department"
JOBTITLE_RAW_NAME = "jobTitle"  # exact-match rename to "JobTitle"
HAS_LICENSE_VARIANTS = (
    "Has license",
    "Has License",
    "hasLicense",
    "HasLicense",
    "Has Copilot License",
    "Has Copilot license",
    "HasCopilotLicense",
    "Has Copilot License Assigned",
    "Has Copilot license assigned",
    "isUser",
)

# ---------------------------------------------------------------------------
# Datetime helpers
# ---------------------------------------------------------------------------

_CREATION_TIME_FORMATS: tuple[str, ...] = (
    "%Y-%m-%dT%H:%M:%S.%fZ",
    "%Y-%m-%dT%H:%M:%SZ",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%m/%d/%Y %I:%M:%S %p",
    "%m/%d/%Y %H:%M:%S",
)


def safe_get(obj: Any, key: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def get_array(obj: Any, key: str) -> list[Any]:
    value = safe_get(obj, key)
    return value if isinstance(value, list) else []


def to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


def normalize_user_id(value: Any) -> str:
    return to_text(value).strip().lower()


def parse_creation_time(value: Any) -> datetime | None:
    raw = to_text(value).strip()
    if not raw:
        return None
    return _parse_creation_time_cached(raw)


@functools.lru_cache(maxsize=None)
def _parse_creation_time_cached(raw: str) -> datetime | None:
    # Fast path: ISO 8601 (covers ~100% of Purview audit timestamps).
    # datetime.fromisoformat is ~10x faster than strptime and avoids the
    # locale lookup that strptime performs on every call. Python 3.11+
    # accepts a trailing "Z"; for 3.10 and earlier we strip it.
    try:
        if raw.endswith("Z"):
            try:
                return datetime.fromisoformat(raw)
            except ValueError:
                return datetime.fromisoformat(raw[:-1])
        return datetime.fromisoformat(raw)
    except ValueError:
        pass
    # Slow path: legacy non-ISO formats kept for backwards compat with
    # older / hand-edited audit exports.
    for fmt in _CREATION_TIME_FORMATS:
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return None


def format_creation_date(value: Any) -> str:
    parsed = parse_creation_time(value)
    if parsed is None:
        raw = to_text(value).strip()
        if len(raw) >= 10 and raw[4:5] == "-":
            return raw[:10] + "T00:00:00.000Z"
        return raw
    return parsed.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT00:00:00.000Z")


def interaction_date(parsed: datetime | None) -> str:
    return parsed.strftime("%Y-%m-%d") if parsed else ""


def week_start(parsed: datetime | None) -> str:
    if parsed is None:
        return ""
    return (parsed - timedelta(days=parsed.weekday())).strftime("%Y-%m-%d")


def month_start(parsed: datetime | None) -> str:
    if parsed is None:
        return ""
    return parsed.replace(day=1).strftime("%Y-%m-%d")


# Cached bundle: given a raw timestamp string, return all 4 derived date
# strings in one shot. Avoids 4x strftime + tzinfo replace per record. The
# distinct raw-timestamp count in a typical dataset is small relative to
# input row count (many records share the same audit timestamp at the
# second granularity), so this collapses ~4N strftime calls to ~K where
# K is the distinct timestamp count.
@functools.lru_cache(maxsize=None)
def _date_strings_for_raw(raw: str) -> tuple[str, str, str, str]:
    """
    Returns (creation_date_iso_z, interaction_date, week_start, month_start)
    for the given raw timestamp string. Empty string is returned for any
    field that cannot be derived (matches non-cached helper semantics).
    """
    if not raw:
        return ("", "", "", "")
    parsed = _parse_creation_time_cached(raw)
    if parsed is None:
        if len(raw) >= 10 and raw[4:5] == "-":
            return (raw[:10] + "T00:00:00.000Z", "", "", "")
        return (raw, "", "", "")
    # Direct f-string formatting is ~10x faster than strftime (which does
    # locale lookup + format-string parsing on every call). Output bytes
    # are byte-identical to the prior strftime("%Y-%m-%d") output for any
    # year in [1000, 9999] (CreationTime range).
    y = parsed.year
    m = parsed.month
    d = parsed.day
    creation = f"{y:04d}-{m:02d}-{d:02d}T00:00:00.000Z"
    interaction = f"{y:04d}-{m:02d}-{d:02d}"
    # Week start (Monday-based, mirroring strftime((parsed-weekday).strftime))
    ws = parsed - timedelta(days=parsed.weekday())
    week = f"{ws.year:04d}-{ws.month:02d}-{ws.day:02d}"
    month = f"{y:04d}-{m:02d}-01"
    return (creation, interaction, week, month)


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.strip())
    return slug.strip("-")


# ---------------------------------------------------------------------------
# Audit JSON shaping
# ---------------------------------------------------------------------------


def app_identity_values(audit_data: dict[str, Any]) -> tuple[str, str]:
    app_identity = safe_get(audit_data, "AppIdentity")
    if isinstance(app_identity, str):
        return "", app_identity
    if isinstance(app_identity, dict):
        return (
            to_text(safe_get(app_identity, "AppId")),
            to_text(safe_get(app_identity, "DisplayName")),
        )
    return "", ""


def derive_agent_name(agent_name: Any, app_identity_display: str, app_identity_app_id: str) -> str:
    # Match the BEFORE PBIP behavior: AgentName comes straight from the audit JSON.
    # Do NOT synthesize from AppIdentity when it's blank — that fabricates distinct
    # agent identities (e.g. "Copilot-Studio-Default-<tenantGuid>-<agentGuid>") that
    # don't exist in the raw data and inflate Active Agents / per-agent rollups.
    return to_text(agent_name).strip()


def derive_agent_title_id(agent_id: Any) -> str:
    agent_id_text = to_text(agent_id).strip()
    if not agent_id_text:
        return ""
    return agent_id_text.rsplit(".", 1)[-1]


def first_dict_item(items: list[Any]) -> dict[str, Any]:
    for item in items:
        if isinstance(item, dict):
            return item
    return {}


def prompt_messages(ced: dict[str, Any]) -> list[dict[str, Any]]:
    prompts: list[dict[str, Any]] = []
    for message in get_array(ced, "Messages"):
        if isinstance(message, dict) and message.get("isPrompt") is True:
            prompts.append(message)
    return prompts


def resource_rows(ced: dict[str, Any]) -> list[dict[str, Any]]:
    resources = [item for item in get_array(ced, "AccessedResources") if isinstance(item, dict)]
    return resources if resources else [{}]


def is_copilot_interaction(audit_data: dict[str, Any], raw_row: dict[str, Any]) -> bool:
    operation = to_text(
        safe_get(audit_data, "Operation")
        or raw_row.get("Operation")
        or raw_row.get("Operations")
    ).strip()
    return operation == "CopilotInteraction"


# ---------------------------------------------------------------------------
# Classification logic (ports of the PBIP DAX calc columns)
# ---------------------------------------------------------------------------

_LICENSE_TRUTHY = {"YES", "TRUE", "Y", "1"}
_ACTIVE_RES_ACTION_TOKENS = ("send", "draft", "create", "post", "invoke", "write", "patch", "execute")


def normalize_has_license(raw: str) -> str:
    """Normalize any truthy/falsy variant to canonical 'TRUE' / 'FALSE'.

    Existing PBIP measures filter with literal `[Has license] = "FALSE"`, so
    we canonicalize here to guarantee those filters match regardless of how
    the upstream Entra/PAX export rendered the value.
    """
    val = (raw or "").strip().upper()
    if val in _LICENSE_TRUTHY:
        return "TRUE"
    if val in {"NO", "FALSE", "N", "0"}:
        return "FALSE"
    return "FALSE"


@functools.lru_cache(maxsize=None)
def compute_license_status(has_license_raw: str) -> str:
    val = (has_license_raw or "").strip().upper()
    return "M365 Copilot Licensed" if val in _LICENSE_TRUTHY else "Unlicensed"


@functools.lru_cache(maxsize=None)
def compute_environment(has_license_raw: str, agent_name: str, agent_id: str, app_host: str) -> str:
    host = (app_host or "").lower()
    has_agent = bool((agent_name or "").strip()) or bool((agent_id or "").strip())
    license_val = (has_license_raw or "").strip().upper()
    if host in {"autonomous", "logic app"}:
        return "Autonomous Agent"
    if "cowork" in host:
        return "Cowork"
    if has_agent:
        return "Agents"
    if license_val in _LICENSE_TRUTHY:
        return "Licensed M365 Copilot"
    return "Unlicensed Chat"


@functools.lru_cache(maxsize=None)
def compute_is_sensitive(sens_label: str, resource_sens_label: str) -> str:
    return "TRUE" if (sens_label or "").strip() or (resource_sens_label or "").strip() else "FALSE"


@functools.lru_cache(maxsize=None)
def compute_ai_model(model_name: str) -> str:
    m = (model_name or "").upper()
    if not m or m == "NULL":
        return "Embedded App (no model logged)"
    if "DEEP_LEO" in m:
        return "GPT-4 (Standard)"
    if "REASONING" in m:
        return "Reasoning Model (o1/o3)"
    if "OFFENSIVE" in m:
        return "Safety Filter (blocked)"
    if "GPT-41" in m or "GPT-4.1" in m:
        return "GPT-4.1 (Next Gen)"
    if "O3-MINI" in m or "O3MINI" in m:
        return "o3-mini (Reasoning)"
    if "O3" in m or "O1" in m:
        return "Reasoning Model (o-series)"
    if "GPT-5" in m or "GPT5" in m:
        return "GPT-5 (Next Gen)"
    if "CLAUDE" in m:
        return "Claude (Anthropic)"
    if "GEMINI" in m:
        return "Gemini (Google)"
    if "LLAMA" in m or "META" in m:
        return "LLaMA (Meta)"
    if "PHI" in m:
        return "Phi (Microsoft Small Model)"
    return model_name or ""


def _resource_behavior(
    res_type: str, res_action: str, site_url: str, is_active: bool
) -> str:
    if res_action in {"sendemailv2", "draftemail", "senddraftemail", "updatedraftemail"}:
        return "Email Drafting"
    if res_type == "emailmessage":
        return "Email Drafting" if is_active else "Email Summarising"
    if res_action == "mcp_meetingmanagement":
        return "Meeting Scheduling"
    if res_type in {"event", "teamsmeeting"}:
        return "Meeting Prep"
    if res_action in {"postmessagetoconversation", "createchat"}:
        return "Teams Messaging"
    if res_type in {"teamsmessage", "teamschat", "teamschannel"}:
        return "Teams Messaging"
    if res_type in {"flow", "connector", "http"}:
        return "Workflow Execution"
    if res_action in {"executedatasetquery", "getitems", "getalltables", "gettableviews"}:
        return "Data Querying"
    if res_type in {"xlsx", "csv", "xlsm", "xlsb", "xls"}:
        return "Excel Assistance" if is_active else "Spreadsheet Review"
    if res_type == "peopleinferenceanswer":
        return "People Lookup"
    if res_type in {"listitem", "aspx"}:
        return "Enterprise Searching"
    if res_type == "websearchquery":
        return "Web Searching"
    if res_type == "pdf":
        return "PDF Analysis"
    if res_type in {"py", "js", "java", "tsx", "jsx", "css", "php", "sh"} and is_active:
        return "Code Writing"
    if res_type in {"py", "sql", "js", "java", "json", "xml", "html", "yaml", "yml", "txt"}:
        return "Code Analysis"
    if res_type in {"png", "jpg", "jpeg", "svg", "gif"} and is_active:
        return "Image Generation"
    if res_type in {"png", "jpg", "jpeg", "gif"}:
        return "Image / Media Analysis"
    if res_type in {"streamvideo", "mp4", "mov", "webm", "mkv"}:
        return "Video Summarising"
    if res_type in {"planid", "taskids"}:
        return "Task Management"
    if res_type == "looppage":
        return "Real-time Collaboration"
    if res_type == "http://schema.skype.com/hyperlink":
        for token in ("github.com", "stackoverflow.com", "npmjs.com", "pypi.org", "docker.com", "kubernetes.io", "leetcode.com"):
            if token in site_url:
                return "Code Analysis"
        for token in ("learning.cloud.microsoft", "coursera.org", "udemy.com"):
            if token in site_url:
                return "Agent: Coaching"
        if "sharepoint.com" in site_url:
            return "Enterprise Searching"
        return "Web Searching"
    if res_type in {"external", "http"}:
        return "Web Searching"
    if res_type in {"docx", "doc", "rtf"}:
        if is_active:
            return "Document Drafting"
        if res_action == "read":
            return "File Retrieval"
        return "Document Summarising"
    if res_type in {"pptx", "ppt", "potx"}:
        if is_active:
            return "Presentation Creation"
        if res_action == "read":
            return "File Retrieval"
        return "Presentation Summarising"
    if "service-now.com" in site_url or "servicenow.com" in site_url:
        return "Agent: IT & Service Desk"
    if "dynamics.com" in site_url:
        return "Agent: Sales & Customer"
    return ""


def _context_behavior(app_host: str, ctx_type: str, is_active: bool) -> str:
    if ctx_type == "teamsmeeting":
        return "Meeting Prep"
    if ctx_type == "streamvideo":
        return "Video Summarising"
    if ctx_type == "docx":
        return "Document Drafting" if (app_host == "word" and is_active) else "Document Summarising"
    if ctx_type in {"xlsx", "xlsm", "xlsb", "xls", "csv"}:
        return "Spreadsheet Review"
    if ctx_type in {"pptx", "pptm"}:
        return "Presentation Creation" if (app_host == "powerpoint" and is_active) else "Presentation Summarising"
    if ctx_type in {"teamschat", "teamschannel"}:
        return "Teams Messaging"
    if ctx_type == "aspx":
        return "Enterprise Searching"
    if app_host in {"outlook", "outlooksidepane"}:
        return "Email Drafting" if is_active else "Email Summarising"
    if app_host == "excel":
        return "Excel Assistance"
    if app_host == "word":
        return "Document Drafting" if is_active else "Document Summarising"
    if app_host == "powerpoint":
        return "Presentation Creation" if is_active else "Presentation Summarising"
    if app_host == "stream":
        return "Video Summarising"
    if app_host == "sharepoint":
        return "SharePoint Access"
    if app_host == "designer":
        return "Image Generation"
    if app_host == "onenote":
        return "Note Taking"
    if app_host == "forms":
        return "Form / Survey Work"
    if app_host == "planner":
        return "Task Management"
    if app_host in {"loop", "whiteboard", "vivaengage"}:
        return "Real-time Collaboration"
    if app_host == "copilot studio":
        return "Domain-Specific Agent"
    if app_host in {"autonomous", "logic app"}:
        return "Workflow Execution"
    if app_host in {"datawarehousing core", "power bi"}:
        return "Data Querying"
    return "General Chat"


@functools.lru_cache(maxsize=None)
def compute_behavior_category(
    app_host: str,
    ctx_type: str,
    res_type: str,
    res_action: str,
    site_url: str,
    plugin_id: str,
) -> str:
    app_host_l = (app_host or "").lower()
    ctx_l = (ctx_type or "").lower()
    res_t_l = (res_type or "").lower()
    res_a_l = (res_action or "").lower()
    site_l = (site_url or "").lower()
    plugin_l = (plugin_id or "").lower()
    is_active = any(tok in res_a_l for tok in _ACTIVE_RES_ACTION_TOKENS)

    from_resource = _resource_behavior(res_t_l, res_a_l, site_l, is_active)
    if from_resource:
        return from_resource
    if plugin_l == "enterprisesearch":
        return "Enterprise Searching"
    return _context_behavior(app_host_l, ctx_l, is_active)


_GENERIC_QA_BEHAVIORS = {"General Q&A", "M365 Chat Q&A", "Teams Q&A", "Browser Q&A", "General Chat"}
_AGENT_NAME_RULES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("coach", "mentor", "learning", "career"), "Agent: Coaching"),
    (("research", "analyst", "analy"), "Agent: Research & Analysis"),
    (("sales", "commercial", "customer", "crm", "revenue"), "Agent: Sales & Customer"),
    (("hr", "recruit", "talent", "onboard", "people"), "Agent: HR & People"),
    (("policy", "compliance", "legal", "audit", "risk"), "Agent: Compliance & Policy"),
    (("service", "support", "help", "ticket", "incident"), "Agent: IT & Service Desk"),
    (("summar", "draft", "translat", "editor"), "Agent: Content Generation"),
    (("data", "report", "dashboard", "metric"), "Agent: Data & Reporting"),
    (("knowledge", "faq", "wiki", "buddy", "guide"), "Agent: Knowledge Base"),
    (("idea", "brainstorm", "creative", "design"), "Agent: Ideation & Creative"),
)


@functools.lru_cache(maxsize=None)
def compute_behavior_enriched(behavior_category: str, agent_name: str, environment: str) -> str:
    if environment not in {"Agents", "Autonomous Agent"}:
        return behavior_category
    if behavior_category not in _GENERIC_QA_BEHAVIORS:
        return behavior_category
    name_l = (agent_name or "").lower()
    for tokens, label in _AGENT_NAME_RULES:
        if any(t in name_l for t in tokens):
            return label
    return "Agent: General Purpose"


@functools.lru_cache(maxsize=None)
def compute_autonomy_pattern(environment: str) -> str:
    if environment == "Licensed M365 Copilot":
        return "1 - Copilot"
    if environment == "Agents":
        return "2 - Agent-Assisted"
    if environment == "Autonomous Agent":
        return "3 - Autonomous"
    return ""


# Verbatim port of AIBV BEFORE DAX calc col `Behavior_Source`.
@functools.lru_cache(maxsize=None)
def compute_behavior_source(
    behavior_category: str,
    environment: str,
    agent_name: str,
    plugin_name: str,
    app_host: str,
) -> str:
    agent = (agent_name or "").strip()
    plugin = (plugin_name or "").strip()
    app = (app_host or "").strip()
    if environment == "Autonomous Agent":
        source = "Autonomous Agent" + (f": {agent}" if agent else "")
    elif environment == "Agents" and agent:
        source = f"Agent: {agent}"
    elif plugin:
        source = f"{app} ({plugin})"
    elif app:
        source = app
    else:
        source = "Copilot Chat"
    return f"{behavior_category} → {source}"


# Verbatim port of AIBV BEFORE DAX calc col `Value_Outcome`.
_VO_TIME_EMAIL = frozenset({"Email Summarising", "Email Triage", "Email Thread Summary"})
_VO_TIME_MEET = frozenset({"Meeting Prep", "Video Summarising"})
_VO_TIME_DOC = frozenset({"Document Summarising", "Presentation Summarising", "Note Taking"})
_VO_SEARCH = frozenset({
    "Web Searching", "Enterprise Searching", "File Retrieval", "PDF Analysis",
    "SharePoint Access", "People Lookup", "Agent: Knowledge Base",
})
_VO_COMM = frozenset({"Teams Messaging", "Meeting Scheduling"})
_VO_SHEET = frozenset({"Spreadsheet Review", "Spreadsheet Analysis", "Excel Assistance"})
_VO_CONTENT = frozenset({
    "Email Drafting", "Document Drafting", "Presentation Creation",
    "Image Generation", "Image / Media Analysis", "Image/Media Analysis",
    "Agent: Content Generation", "Agent: Ideation & Creative",
})
_VO_TEAMCOLLAB = frozenset({"Real-time Collaboration", "Form / Survey Work"})
_VO_DATA = frozenset({"Data Querying", "Agent: Data & Reporting", "Agent: Research & Analysis"})
_VO_CODE = frozenset({"Code Writing", "Code Analysis", "Code Analysis (URL)"})
_VO_COACH = frozenset({"Agent: Coaching", "Agent: Coaching (URL)"})
_VO_DOMAIN = frozenset({"Domain-Specific Agent", "Cross-Org Agent"})


@functools.lru_cache(maxsize=None)
def compute_value_outcome(
    behavior_enriched: str, environment: str, is_sensitive_str: str
) -> str:
    b = behavior_enriched or ""
    if b in _VO_TIME_EMAIL:
        return "Time Saved (Email)"
    if b in _VO_TIME_MEET:
        return "Time Saved (Meetings)"
    if b in _VO_TIME_DOC:
        return "Time Saved (Documents)"
    if b in _VO_SEARCH:
        return "Search Time Saved"
    if b in _VO_COMM:
        return "Communication Time Saved"
    if b in _VO_SHEET:
        return "Spreadsheet Time Saved"
    if b in _VO_CONTENT:
        return "Content Output"
    if b in _VO_TEAMCOLLAB:
        return "Team Collaboration"
    if b == "Workflow Execution" or environment == "Autonomous Agent":
        return "Workflow Automation"
    if b == "Task Management":
        return "Task Coordination"
    if (
        is_sensitive_str == "TRUE"
        and environment != "Agents"
        and environment != "Autonomous Agent"
    ):
        return "Compliance & Risk"
    if b in _VO_DATA:
        return "Data-Driven Decisions"
    if b in _VO_CODE:
        return "Coding Capability"
    if b in _VO_COACH:
        return "Skills Development"
    if b == "Agent: Sales & Customer":
        return "Revenue Enablement"
    if b == "Agent: IT & Service Desk":
        return "Service Desk Deflection"
    if b == "Agent: Compliance & Policy":
        return "Compliance & Risk"
    if b == "Agent: HR & People":
        return "HR Expertise"
    if b in _VO_DOMAIN:
        return "Specialist Expertise"
    return "General AI Productivity"


def compute_user_month_key(audit_user_id: str, month_start_str: str) -> str:
    if not audit_user_id or not month_start_str:
        return ""
    # MonthStart is YYYY-MM-DD; format key as YYYY-MM (mirrors DAX FORMAT(...,"yyyy-MM"))
    return f"{audit_user_id}|{month_start_str[:7]}"


# ---------------------------------------------------------------------------
# Entra loader / Users dim CSV writer
# ---------------------------------------------------------------------------


def _normalize_col_name(name: str) -> str:
    return re.sub(r"[\s_\-.()\[\]]", "", (name or "").lower())


def detect_has_license_column(headers: list[str]) -> str | None:
    for variant in HAS_LICENSE_VARIANTS:
        if variant in headers:
            return variant
    return None


def detect_upn_column(headers: list[str]) -> str | None:
    for h in headers:
        if _normalize_col_name(h) in UPN_VARIANTS_NORMALIZED:
            return h
    return None


def detect_department_column(headers: list[str]) -> str | None:
    for h in headers:
        if _normalize_col_name(h) in {DEPARTMENT_VARIANT_NORMALIZED, "organization", "organisation"}:
            return h
    return None


def detect_jobtitle_column(headers: list[str]) -> str | None:
    for h in headers:
        if _normalize_col_name(h) == "jobtitle":
            return h
    return None


def load_entra_and_write_users(
    entra_csv: str,
    users_out_csv: str,
    user_key_map: dict[str, int],
    quiet: bool = False,
) -> dict[str, dict[str, str]]:
    """
    Read the Entra CSV, write the Users dim CSV (with PBIP-compatible renames +
    precomputed License Status + UserKey INT surrogate), and return a dict
    keyed on PersonId_Normalized -> {"Has license": ..., "License Status": ...}
    for fact-row lookup.

    Mutates `user_key_map` (normalized_upn -> int) in place — every Entra row
    with a non-empty PersonId_Normalized is assigned a UserKey (1-based, in
    Entra-file order). The same map is reused by the fact path so any audit
    user already in Entra resolves to the same INT.

    Mirrors the rename/normalization logic in the existing PBIP M-code:
      userPrincipalName/upn/personid -> PersonId
      department                     -> Organization
      jobTitle                       -> JobTitle
      Has license variants           -> "Has license"
      adds PersonId_Normalized (lower+trim of PersonId)
      adds License Status (precomputed)
      adds TotalEmployees (row count, repeated per row)
    """
    with open(entra_csv, "r", encoding="utf-8-sig", newline="") as fin:
        # Sniff via a generous quote-aware reader; encoding="utf-8-sig" eats BOM if present.
        reader = csv.DictReader(fin)
        original_headers = reader.fieldnames or []
        if not original_headers:
            raise ValueError(f"Entra CSV has no header row: {entra_csv}")

        upn_col = detect_upn_column(original_headers)
        dept_col = detect_department_column(original_headers)
        has_license_col = detect_has_license_column(original_headers)
        jobtitle_col = detect_jobtitle_column(original_headers)

        # Build rename map: source_header -> target_header
        rename_map: dict[str, str] = {}
        if upn_col and upn_col != "PersonId":
            rename_map[upn_col] = "PersonId"
        if dept_col and dept_col != "Organization":
            rename_map[dept_col] = "Organization"
        if jobtitle_col and jobtitle_col != "JobTitle":
            rename_map[jobtitle_col] = "JobTitle"
        if has_license_col and has_license_col != "Has license":
            rename_map[has_license_col] = "Has license"

        # Final header list for users CSV — preserve original order, apply renames,
        # then append injected columns. UserKey is the INT surrogate that joins
        # to the fact table.
        renamed_headers = [rename_map.get(h, h) for h in original_headers]
        injected = ["UserKey", "PersonId_Normalized", "License Status", "TotalEmployees"]
        if "Has license" not in renamed_headers:
            renamed_headers.append("Has license")
        for inj in injected:
            if inj not in renamed_headers:
                renamed_headers.append(inj)

        rows = list(reader)

    total_rows = len(rows)
    user_lookup: dict[str, dict[str, str]] = {}

    out_dir = Path(users_out_csv).parent
    out_dir.mkdir(parents=True, exist_ok=True)

    pax_licensed = 0
    pax_unlicensed = 0
    no_license_col = 0
    seen_normalized_keys: set[str] = set()

    with open(users_out_csv, "w", encoding="utf-8", newline="") as fout:
        writer = csv.DictWriter(fout, fieldnames=renamed_headers, lineterminator="\n")
        writer.writeheader()

        for src_row in rows:
            # Apply renames + ensure all renamed_headers keys exist in the out row.
            out_row: dict[str, str] = {h: "" for h in renamed_headers}
            for src_h, value in src_row.items():
                tgt_h = rename_map.get(src_h, src_h)
                if tgt_h in out_row:
                    out_row[tgt_h] = "" if value is None else str(value)

            # PersonId_Normalized
            person_id = out_row.get("PersonId", "")
            person_id_norm = person_id.strip().lower() if person_id else ""
            out_row["PersonId_Normalized"] = person_id_norm

            # UserKey (INT surrogate; assigned in Entra-file order)
            if person_id_norm:
                user_key = user_key_map.get(person_id_norm)
                if user_key is None:
                    user_key = len(user_key_map) + 1
                    user_key_map[person_id_norm] = user_key
                out_row["UserKey"] = str(user_key)
            else:
                out_row["UserKey"] = ""

            # License Status (mirrors PBIP DAX exactly).
            # We also normalize Has license to canonical TRUE/FALSE so existing
            # measures that filter `[Has license] = "FALSE"` match regardless
            # of source casing.
            has_license_raw = out_row.get("Has license", "")
            normalized_has_license = normalize_has_license(has_license_raw)
            if has_license_col is None:
                no_license_col += 1
            elif (has_license_raw or "").strip().upper() in _LICENSE_TRUTHY:
                pax_licensed += 1
            else:
                pax_unlicensed += 1
            out_row["Has license"] = normalized_has_license
            out_row["License Status"] = compute_license_status(normalized_has_license)

            # TotalEmployees (matches M-code: row count repeated per row)
            out_row["TotalEmployees"] = str(total_rows)

            writer.writerow(out_row)

            # Build fact-lookup dict (dedupe on normalized key, last-wins matches
            # M-code Table.Distinct behavior on the licensed-users path).
            if person_id_norm:
                user_lookup[person_id_norm] = {
                    "Has license": normalized_has_license,
                    "License Status": out_row["License Status"],
                }
                seen_normalized_keys.add(person_id_norm)

    if not quiet:
        print(f"  Entra rows:            {total_rows:,}")
        print(f"  Unique users (norm):   {len(seen_normalized_keys):,}")
        if has_license_col:
            print(f"  License col detected:  '{has_license_col}'")
            print(f"  Licensed (PAX):        {pax_licensed:,}")
            print(f"  Unlicensed (PAX):      {pax_unlicensed:,}")
        else:
            print(f"  License col detected:  NO RECOGNIZED LICENSE COLUMN FOUND IN ENTRA CSV")
            print(f"     Fallback: every user will be tagged 'Unlicensed' until a recognized column is present.")

    return user_lookup


# ---------------------------------------------------------------------------
# Fact row explosion + output
# ---------------------------------------------------------------------------


def explode_record(
    audit_data: dict[str, Any],
    user_lookup: dict[str, dict[str, str]],
    user_key_map: dict[str, int],
    thread_key_map: dict[str, int],
) -> list[dict[str, Any]]:
    creation_time_raw = audit_data.get("CreationTime")
    creation_time_raw_str = to_text(creation_time_raw).strip()
    # Cached bundle: 4 derived date strings in one shot, keyed on the raw
    # timestamp string (~K distinct values across N records).
    creation_date_str, interaction_date_str, week_start_str, month_start_str = (
        _date_strings_for_raw(creation_time_raw_str)
    )
    app_identity_app_id, app_identity_display = app_identity_values(audit_data)
    agent_id = to_text(audit_data.get("AgentId"))
    agent_name = derive_agent_name(audit_data.get("AgentName"), app_identity_display, app_identity_app_id)

    ced = audit_data.get("CopilotEventData")
    if not isinstance(ced, dict):
        return []

    prompts = prompt_messages(ced)
    if not prompts:
        return []

    resources = resource_rows(ced)
    real_resource_count = sum(1 for item in get_array(ced, "AccessedResources") if isinstance(item, dict))
    resource_count_value = real_resource_count if real_resource_count > 0 else 1
    first_context = first_dict_item(get_array(ced, "Contexts"))
    first_plugin = first_dict_item(get_array(ced, "AISystemPlugin"))
    first_model = first_dict_item(get_array(ced, "ModelTransparencyDetails"))

    audit_user_id_raw = to_text(audit_data.get("UserId"))
    audit_user_id_norm = normalize_user_id(audit_user_id_raw)
    # UserKey INT surrogate. If this audit user wasn't in Entra, mint a new
    # INT and stash so subsequent rows for the same user reuse it. The
    # caller tracks unmatched-vs-Entra via the lookup membership check.
    if audit_user_id_norm:
        user_key = user_key_map.get(audit_user_id_norm)
        if user_key is None:
            user_key = len(user_key_map) + 1
            user_key_map[audit_user_id_norm] = user_key
    else:
        user_key = ""
    # ThreadId INT surrogate.
    thread_id_raw = to_text(ced.get("ThreadId"))
    if thread_id_raw:
        thread_key = thread_key_map.get(thread_id_raw)
        if thread_key is None:
            thread_key = len(thread_key_map) + 1
            thread_key_map[thread_id_raw] = thread_key
    else:
        thread_key = ""
    app_host_str = to_text(ced.get("AppHost"))
    sens_label_str = to_text(ced.get("SensitivityLabelId"))
    ctx_type_str = to_text(first_context.get("Type")) if first_context else ""
    plugin_id_str = to_text(first_plugin.get("Id")) if first_plugin else ""
    model_name_str = to_text(first_model.get("ModelName")) if first_model else ""

    # User-level lookups (constant per record)
    user_rec = user_lookup.get(audit_user_id_norm) or {}
    has_license_raw = user_rec.get("Has license", "")
    license_status = user_rec.get("License Status") or compute_license_status(has_license_raw)
    environment = compute_environment(has_license_raw, agent_name, agent_id, app_host_str)
    autonomy_pattern = compute_autonomy_pattern(environment)
    ai_model = compute_ai_model(model_name_str)
    user_month_key = compute_user_month_key(audit_user_id_raw, month_start_str)

    # Per-record constants hoisted out of the (prompt x resource) inner loop.
    # All grain values are pre-stringified via to_text() exactly once so the
    # rollup loop can use the tuple directly as the dict key.
    user_key_text = to_text(user_key)
    thread_key_text = to_text(thread_key)
    agent_title_id = derive_agent_title_id(agent_id)
    aisystem_plugin_name_str = to_text(first_plugin.get("Name")) if first_plugin else ""
    in_entra = (audit_user_id_norm in user_lookup) if audit_user_id_norm else True

    # Stable portion of the nongrain dict (everything that does NOT depend on
    # the per-resource fields). Built once per record; copied per emitted
    # row and updated with the resource-varying keys. Values mirror the
    # prior base_row exactly (same types, same to_text() handling) so the
    # final flushed CSV bytes are identical.
    base_nongrain: dict[str, Any] = {
        "CreationDate": creation_date_str,
        "WeekStart": week_start_str,
        "MonthStart": month_start_str,
        "UserMonthKey": user_month_key,
        "Has license": has_license_raw,
        "Resource_Count": resource_count_value,
        "SensitivityLabelId": sens_label_str,
        # AccessedResource_* injected per-resource below.
        "AccessedResource_Type": "",
        "AccessedResource_Action": "",
        "AccessedResource_SiteUrl": "",
        "AccessedResource_SensitivityLabelId": "",
        "AppIdentity_DisplayName": app_identity_display,
        "AISystemPlugin_Id": plugin_id_str,
        "ModelTransparencyDetails_ModelName": model_name_str,
        "Agent_TitleID": agent_title_id,
        "Message_isPrompt": "TRUE",
        # Behavior_Source / Value_Outcome injected per-resource below.
        "Behavior_Source": "",
        "Value_Outcome": "",
        "ActivityDate": interaction_date_str,
    }

    # Output schema: list of tuples
    #   (grain_tuple, message_id_str, nongrain_dict, in_entra, audit_user_id_norm)
    # consumed directly by run_processor's rollup loop (no per-row dict
    # rebuild, no transient _audit_user_* keys).
    rows: list[tuple[tuple[str, ...], str, dict[str, Any], bool, str]] = []
    for message in prompts:
        message_id = to_text(message.get("Id"))
        for resource in resources:
            res_type_str = to_text(resource.get("Type"))
            res_action_str = to_text(resource.get("Action"))
            res_site_str = to_text(resource.get("SiteUrl"))
            res_sens_label_str = to_text(resource.get("SensitivityLabelId"))
            behavior_category = compute_behavior_category(
                app_host_str, ctx_type_str, res_type_str, res_action_str, res_site_str, plugin_id_str
            )
            behavior_enriched = compute_behavior_enriched(behavior_category, agent_name, environment)
            is_sensitive_str = compute_is_sensitive(sens_label_str, res_sens_label_str)
            behavior_source = compute_behavior_source(
                behavior_category, environment, agent_name,
                aisystem_plugin_name_str, app_host_str,
            )
            value_outcome = compute_value_outcome(
                behavior_enriched, environment, is_sensitive_str,
            )

            # Grain tuple in EXACT GRAIN_KEYS order (verified at module load
            # via _assert_grain_order below). All values are already
            # pre-stringified.
            grain_tuple = (
                user_key_text,
                interaction_date_str,
                agent_id,
                agent_name,
                app_host_str,
                environment,
                license_status,
                ctx_type_str,
                behavior_category,
                behavior_enriched,
                ai_model,
                is_sensitive_str,
                autonomy_pattern,
                app_identity_app_id,
                aisystem_plugin_name_str,
                thread_key_text,
            )

            nongrain = dict(base_nongrain)
            nongrain["AccessedResource_Type"] = res_type_str
            nongrain["AccessedResource_Action"] = res_action_str
            nongrain["AccessedResource_SiteUrl"] = res_site_str
            nongrain["AccessedResource_SensitivityLabelId"] = res_sens_label_str
            nongrain["Behavior_Source"] = behavior_source
            nongrain["Value_Outcome"] = value_outcome

            rows.append((grain_tuple, message_id, nongrain, in_entra, audit_user_id_norm))

    return rows


def run_processor(
    purview_csv: str,
    entra_csv: str,
    fact_out_csv: str,
    users_out_csv: str,
    quiet: bool = False,
) -> dict[str, Any]:
    start_time = time.perf_counter()
    stats: dict[str, Any] = {
        "input_records": 0,
        "skipped_non_copilot": 0,
        "output_rows": 0,
        "errors": 0,
        "unmatched_users": 0,
    }

    if not quiet:
        print(f"Purview CopilotInteraction Processor v{SCRIPT_VERSION}")
        print(f"  JSON engine:    {_JSON_ENGINE}")
        print(f"  Purview input:  {purview_csv}")
        print(f"  Entra input:    {entra_csv}")
        print(f"  Purview output: {fact_out_csv}")
        print(f"  Entra output:   {users_out_csv}")
        print()
        print("Loading Entra users + writing Users dim CSV...")

    # Shared INT-surrogate maps. UserKey is populated first by the Entra
    # loader (so Entra-known users get the lowest INTs / lowest dictionary
    # offsets in VertiPaq); the fact path then reuses + extends the map.
    user_key_map: dict[str, int] = {}
    thread_key_map: dict[str, int] = {}

    user_lookup = load_entra_and_write_users(
        entra_csv, users_out_csv, user_key_map, quiet=quiet
    )

    if not quiet:
        print()
        print("Flattening CopilotInteraction records...")

    # v3.0.0 (Option D): one row per (grain x distinct Message_Id). Replaces
    # the old PromptCount accumulator (which inflated counts ~2.25x by
    # incrementing per (prompt x AccessedResource) iteration). Downstream
    # measures use DISTINCTCOUNT(Message_Id) for exact BEFORE-PBIP parity.
    #
    # Message_Id is INT-surrogated (1-based, encounter order) for CSV size
    # and parse-time win on the highest-cardinality column.
    #
    # Key:    (grain_tuple, message_id_int)
    # Value:  dict of non-grain attrs (last-write-wins on a per-resource
    #         basis for AccessedResource_* / SensitivityLabelId — same
    #         semantic as the prior dict-overwrite behavior).
    rollup: dict[tuple[Any, ...], dict[str, Any]] = {}
    mid_to_int: dict[str, int] = {}
    unmatched: set[str] = set()

    with open(purview_csv, "r", encoding="utf-8-sig", newline="") as fin:
        reader = csv.DictReader(fin)

        for raw_row in reader:
            stats["input_records"] += 1

            audit_raw = raw_row.get("AuditData", "") or ""
            try:
                audit_data = json_loads(audit_raw) if audit_raw.strip() else {}
            except Exception:
                stats["errors"] += 1
                continue

            if not isinstance(audit_data, dict):
                stats["errors"] += 1
                continue

            if not is_copilot_interaction(audit_data, raw_row):
                stats["skipped_non_copilot"] += 1
                continue

            try:
                rows = explode_record(audit_data, user_lookup, user_key_map, thread_key_map)
            except Exception:
                stats["errors"] += 1
                continue

            for grain_key, message_id_str, nongrain, in_entra, audit_user_norm in rows:
                stats["output_rows"] += 1
                if not in_entra and audit_user_norm:
                    unmatched.add(audit_user_norm)
                mid_int = mid_to_int.get(message_id_str)
                if mid_int is None:
                    mid_int = len(mid_to_int) + 1
                    mid_to_int[message_id_str] = mid_int
                rollup[(grain_key, mid_int)] = nongrain

    if not quiet:
        print(f"  Input records:         {stats['input_records']:,}")
        print(f"  Skipped (non-Copilot): {stats['skipped_non_copilot']:,}")
        print(f"  Raw prompt rows:       {stats['output_rows']:,}")
        print(f"  Errors:                {stats['errors']:,}")
        print()
        print("Writing rolled-up fact CSV...")

    with open(fact_out_csv, "w", encoding="utf-8", newline="") as fout:
        writer = csv.writer(fout, lineterminator="\n")
        writer.writerow(FACT_HEADER)
        # Pre-compute the index of Message_Id within FACT_HEADER so we can
        # splice the INT surrogate into a list-of-attrs in one shot. The
        # list-based csv.writer.writerow path is materially faster than
        # DictWriter (skips dict-to-list translation + per-row genexpr).
        nongrain_attrs = _NONGRAIN_ATTRS  # local rebind
        grain_len = len(GRAIN_KEYS)
        for (grain_key, mid_int), attrs in rollup.items():
            # FACT_HEADER = GRAIN_KEYS + ("Message_Id",) + _NONGRAIN_ATTRS
            row_out = list(grain_key)
            row_out.append(mid_int)
            row_out.extend(attrs[k] for k in nongrain_attrs)
            writer.writerow(row_out)

    stats["output_rows_rollup"] = len(rollup)
    stats["distinct_message_ids"] = len(mid_to_int)
    stats["distinct_thread_ids"] = len(thread_key_map)
    stats["distinct_user_keys"] = len(user_key_map)
    stats["unmatched_users"] = len(unmatched)
    elapsed = time.perf_counter() - start_time
    if not quiet:
        reduction_pct = (1 - len(rollup) / stats["output_rows"]) * 100 if stats["output_rows"] else 0
        print(f"  Rollup rows:           {len(rollup):,}  ({reduction_pct:.1f}% reduction)")
        print(f"  Distinct Message_Ids:  {len(mid_to_int):,}")
        print(f"  Distinct ThreadIds:    {len(thread_key_map):,}")
        print(f"  Distinct UserKeys:     {len(user_key_map):,}")
        print(f"  Unmatched users:       {stats['unmatched_users']:,}")
        print(f"  Elapsed:               {elapsed:.2f}s")

    return stats


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            f"Purview CopilotInteraction Processor v{SCRIPT_VERSION} - "
            "Two-input/two-output preprocessor that produces a rolled-up "
            "Interactions fact CSV (~85% row reduction via PromptCount grain) "
            "and a Users dim CSV for the AI Business Value Dashboard PBIP."
        )
    )
    parser.add_argument(
        "--purview",
        required=True,
        help="Path to the raw Purview audit log CSV (must contain AuditData column).",
    )
    parser.add_argument(
        "--entra",
        required=True,
        help="Path to the Entra users CSV (must contain UPN + license columns).",
    )
    parser.add_argument(
        "--out-dir",
        "-o",
        default=None,
        help="Directory for output files. Default: same directory as the Purview file.",
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        default=False,
        help="Suppress progress output.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {SCRIPT_VERSION}",
    )

    args = parser.parse_args()

    purview_path = os.path.abspath(args.purview)
    entra_path = os.path.abspath(args.entra)
    for label, p in (("Purview", purview_path), ("Entra", entra_path)):
        if not os.path.isfile(p):
            print(f"ERROR: {label} input file not found: {p}", file=sys.stderr)
            sys.exit(1)

    out_dir = Path(os.path.abspath(args.out_dir)) if args.out_dir else Path(purview_path).parent
    out_dir.mkdir(parents=True, exist_ok=True)

    purview_stem = Path(purview_path).stem
    entra_stem = Path(entra_path).stem
    run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fact_out = str(out_dir / f"{purview_stem}_Interactions_{run_ts}.csv")
    users_out = str(out_dir / f"{entra_stem}_Users_{run_ts}.csv")

    stats = run_processor(
        purview_csv=purview_path,
        entra_csv=entra_path,
        fact_out_csv=fact_out,
        users_out_csv=users_out,
        quiet=args.quiet,
    )
    sys.exit(1 if stats["errors"] > 0 else 0)


if __name__ == "__main__":
    main()
