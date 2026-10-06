# Generated from the repository's AIO processor. Do not hand-edit this cell.
# LRU decorators omitted for Spark worker serialization; classifier logic is unchanged.
# Source SHA-256: f6672db6e70bce19babf8297ea55455a4058081fddac6d649ee6861f57a8060d

from __future__ import annotations

import argparse

import contextlib

import csv

import heapq

import itertools

import pickle

import functools

import hashlib

import hmac

import json

import os

import re

import sqlite3

import sys

import tempfile

import time

from datetime import datetime, timedelta, timezone

from pathlib import Path

from typing import Any

_GRAIN_KEYS_COMMON: tuple[str, ...] = (
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

GRAIN_KEYS_AIO: tuple[str, ...] = _GRAIN_KEYS_COMMON

_RAW_ID_ATTRS: tuple[str, ...] = (
    "Message_Id_Raw",
    "ThreadId_Raw",
)

_NONGRAIN_ATTRS_AIO_BASE: tuple[str, ...] = (
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

_NONGRAIN_ATTRS_AIO: tuple[str, ...] = _NONGRAIN_ATTRS_AIO_BASE + (
    # Stable, deid-consistent user identity for AIO. Mirrors the
    # AIBV [Audit_UserId_Normalized] value (deid_upn -> normalize_user_id), so it
    # is deterministically de-identified under -Deidentify and never exposes a raw
    # UPN. Gives the cross-run append merge key a stable user component in place of
    # the per-run UserKey INT surrogate. Placed BEFORE the raw keys so
    # Message_Id_Raw / ThreadId_Raw stay the trailing reconciliation columns.
    "User_Id_Normalized",
) + _RAW_ID_ATTRS

FACT_HEADER_AIO: list[str] = list(GRAIN_KEYS_AIO) + ["Message_Id"] + list(_NONGRAIN_ATTRS_AIO)

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

_DEIDENTIFY: bool = False

_DEID_SALT = b"PAX-Deidentify-Salt-v1-DO-NOT-CHANGE-7f3c1e9b2d846050a1c4e8b3"

_DEID_DOMAIN = "deidentified.domain"

_deid_cache: dict[str, str] = {}

def _deid_hex(value: str, length: int) -> str:
    return hmac.new(
        _DEID_SALT, value.strip().lower().encode("utf-8"), hashlib.sha256
    ).hexdigest()[:length]

def deid_upn(value: str) -> str:
    """UPN / email -> <12hex>@deidentified.domain. No-op when off or value empty."""
    if not _DEIDENTIFY or not value:
        return value
    k = "upn\x00" + value
    v = _deid_cache.get(k)
    if v is None:
        v = _deid_hex(value, 12) + "@" + _DEID_DOMAIN
        _deid_cache[k] = v
    return v

def deid_guid(value: str) -> str:
    """GUID -> deterministic GUID shape xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx."""
    if not _DEIDENTIFY or not value:
        return value
    k = "guid\x00" + value
    v = _deid_cache.get(k)
    if v is None:
        h = _deid_hex(value, 32)
        v = f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
        _deid_cache[k] = v
    return v

def deid_resource(value: str) -> str:
    """Resource URL -> site_<12hex> (whole-string hash; preserves distinct-count)."""
    if not _DEIDENTIFY or not value:
        return value
    k = "res\x00" + value
    v = _deid_cache.get(k)
    if v is None:
        v = "site_" + _deid_hex(value, 12)
        _deid_cache[k] = v
    return v

_UPN_LOCAL_RE = re.compile(r"^[^\s\\@]+$")

_BARE_GUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

def _is_human_upn(uid: str) -> bool:
    """True iff uid is a syntactically valid human UPN (local@domain.tld), excluding
    well-known service/bot patterns (SupervisoryReview{...}@..., bare GUIDs)."""
    if not uid:
        return False
    s = uid.strip()
    if _BARE_GUID_RE.match(s):
        return False
    if s.lower().startswith("supervisoryreview{"):
        return False
    if "@" not in s or s.count("@") != 1:
        return False
    local, domain = s.split("@", 1)
    if not _UPN_LOCAL_RE.match(local):
        return False
    if "." not in domain or not domain or domain.startswith(".") or domain.endswith("."):
        return False
    return True

def parse_creation_time(value: Any) -> datetime | None:
    raw = to_text(value).strip()
    if not raw:
        return None
    return _parse_creation_time_cached(raw)

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

def is_security_copilot(audit_data, record=None):
    """Match explicit product identities, never people, agent names or prompt text."""
    def matches(value):
        if not isinstance(value, str):
            return False
        value = value.strip().casefold()
        return value in {
            "securitycopilot", "security copilot", "microsoft security copilot",
            "copilot for security", "microsoft copilot for security",
            "copilot.security.securitycopilot",
        } or value.startswith("securitycopilot-")

    event = audit_data.get("CopilotEventData") if isinstance(audit_data, dict) else None
    for source in (audit_data, event, record):
        if not isinstance(source, dict):
            continue
        if any(matches(source.get(key)) for key in ("AppHost", "Workload", "ProductName")):
            return True
        identity = source.get("AppIdentity")
        if matches(identity) or (isinstance(identity, dict) and matches(identity.get("DisplayName"))):
            return True
    return False

def derive_agent_name(agent_name: Any, app_identity_display: str, app_identity_app_id: str) -> str:
    # Match the BEFORE PBIP behavior: AgentName comes straight from the audit JSON.
    # Do NOT synthesize from AppIdentity when it's blank — that fabricates distinct
    # agent identities (e.g. "Copilot-Studio-Default-<tenantGuid>-<agentGuid>") that
    # don't exist in the raw data and inflate Active Agents / per-agent rollups.
    return to_text(agent_name).strip()

def derive_agent_title_id(agent_id: Any) -> str:
    if not isinstance(agent_id, str):
        return ""
    agent_id_text = agent_id.strip()
    if not agent_id_text:
        return ""
    segments = agent_id_text.split(".")
    title_positions = [position for position, segment in enumerate(segments)
                       if segment[:2].lower() in {"p_", "t_"}]
    if len(title_positions) > 1:
        return ""
    title_id = segments[-1]
    if title_positions and title_positions[0] != len(segments) - 1:
        position = title_positions[0]
        guid_pattern = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        if (position != len(segments) - 2
                or not re.fullmatch(guid_pattern, segments[position][2:], re.IGNORECASE)
                or not re.fullmatch(guid_pattern, segments[-1], re.IGNORECASE)):
            return ""
        title_id = segments[position]
    return title_id[2:] if title_id[:2].lower() == "t_" else title_id

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

_LICENSE_TRUTHY = {"YES", "TRUE", "Y", "1"}

_ACTIVE_RES_ACTION_TOKENS = ("send", "draft", "create", "post", "invoke", "write", "patch", "execute")

def normalize_has_license(raw: str) -> str:
    """Normalize known truthy/falsy values; missing evidence stays 'Unknown'.

    Existing PBIP measures filter with literal `[Has license] = "FALSE"`, so
    we canonicalize here to guarantee those filters match regardless of how
    the upstream Entra/PAX export rendered the value.
    """
    val = (raw or "").strip().upper()
    if val in _LICENSE_TRUTHY:
        return "TRUE"
    if val in {"NO", "FALSE", "N", "0"}:
        return "FALSE"
    return "Unknown"

def compute_license_status(has_license_raw: str) -> str:
    val = normalize_has_license(has_license_raw)
    return {"TRUE": "M365 Copilot Licensed", "FALSE": "Unlicensed"}.get(val, "Unknown")

def compute_environment(profile: str, has_license_raw: str, agent_name: str, agent_id: str, app_host: str) -> str:
    license_val = (has_license_raw or "").strip().upper()
    if profile == "aio":
        # AIO vocabulary (5-value, keyed off app_host + agent presence).
        host = (app_host or "").lower()
        has_agent = bool((agent_name or "").strip()) or bool((agent_id or "").strip())
        if host in {"autonomous", "logic app"}:
            return "Autonomous Agent"
        if "cowork" in host:
            return "Cowork"
        if has_agent:
            return "Agents"
        if license_val in _LICENSE_TRUTHY:
            return "Licensed M365 Copilot"
        return "Unlicensed Chat"
    # AIBV vocabulary (verbatim port of current AIBV calc col `Environment`):
    #   IF(CONTAINSSTRING(LOWER(TRIM(AgentName)),"cowork"),"Cowork",
    #   IF(isLicensed,"Licensed","Unlicensed"))
    if "cowork" in (agent_name or "").strip().lower():
        return "Cowork"
    if license_val in _LICENSE_TRUTHY:
        return "Licensed"
    return "Unlicensed"

def compute_is_sensitive(sens_label: str, resource_sens_label: str) -> str:
    return "TRUE" if (sens_label or "").strip() or (resource_sens_label or "").strip() else "FALSE"

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
    profile: str, res_type: str, res_action: str, site_url: str, is_active: bool
) -> str:
    if res_action in {"sendemailv2", "draftemail", "senddraftemail", "updatedraftemail"}:
        return "Email Drafting"
    if res_type == "emailmessage":
        return "Email Drafting" if res_action in {"draft", "write", "create"} else "Email Summarising"
    if res_action == "mcp_meetingmanagement":
        return "Meeting Scheduling"
    if res_type in {"event", "teamsmeeting"}:
        return "Meeting Prep"
    if res_action in {"postmessagetoconversation", "createchat"}:
        return "Teams Messaging"
    if res_type in {"teamsmessage", "teamschat", "teamschannel"}:
        return "Teams Assistance"
    if profile == "aio":
        # Any flow/connector/http resource -> "Workflow Execution".
        if res_type in {"flow", "connector", "http"}:
            return "Workflow Execution"
    else:
        # AIBV: explicit Flow always; connector/http only with an active verb.
        if res_type == "flow":
            return "Running a Workflow"
        if res_type in {"connector", "http"} and is_active:
            return "Running a Workflow"
    if res_action in {"executedatasetquery", "getitems", "getalltables", "gettableviews"}:
        return "Data Querying"
    if res_type in {"xlsx", "csv", "xlsm", "xlsb", "xls"}:
        return "Excel Assistance"
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
    if res_type in {"loop", "looppage"}:
        return "Loop Assistance"
    if res_type == "http://schema.skype.com/hyperlink":
        for token in ("github.com", "stackoverflow.com", "npmjs.com", "pypi.org", "docker.com", "kubernetes.io", "leetcode.com"):
            if token in site_url:
                return "Code Analysis"
        for token in ("learning.cloud.microsoft", "coursera.org", "udemy.com"):
            if token in site_url:
                return "Agent: Coaching"
        if "sharepoint.com" in site_url:
            return "Enterprise Searching"
        return "Referenced Content Assistance"
    if res_type in {"external", "http"}:
        return "Referenced Content Assistance"
    if res_type == "citation":
        return "Referenced Content Assistance"
    if res_type in {"docx", "doc", "rtf"}:
        if res_action in {"draft", "write", "create"}:
            return "Document Drafting"
        if res_action == "read":
            return "File Retrieval"
        return "Document Assistance"
    if res_type in {"pptx", "ppt", "potx"}:
        if res_action == "create":
            return "Presentation Creation"
        if res_action == "read":
            return "File Retrieval"
        return "Presentation Summarising"
    if "service-now.com" in site_url or "servicenow.com" in site_url:
        return "Agent: IT & Service Desk"
    if "dynamics.com" in site_url:
        return "Agent: Sales & Customer"
    return ""

def _context_behavior(profile: str, app_host: str, ctx_type: str, is_active: bool, has_agent: bool) -> str:
    if ctx_type == "teamsmeeting":
        return "Meeting Prep"
    if ctx_type == "streamvideo":
        return "Video Summarising"
    if ctx_type == "docx":
        return "Document Assistance"
    if ctx_type in {"xlsx", "xlsm", "xlsb", "xls", "csv"}:
        return "Excel Assistance"
    if ctx_type in {"pptx", "pptm"}:
        return "Presentation Summarising"
    if ctx_type in {"teamschat", "teamschannel"}:
        return "Teams Assistance"
    if ctx_type == "aspx":
        return "Enterprise Searching"
    if app_host in {"outlook", "outlooksidepane"}:
        return "Email Summarising"
    if app_host == "excel":
        return "Excel Assistance"
    if app_host == "word":
        return "Document Assistance"
    if app_host == "powerpoint":
        return "Presentation Summarising"
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
        return "Loop Assistance"
    if app_host == "copilot studio":
        return "Domain-Specific Agent"
    if profile == "aio":
        # Autonomous OR logic app -> "Workflow Execution".
        if app_host in {"autonomous", "logic app"}:
            return "Workflow Execution"
    else:
        # AIBV: autonomous always; logic app only when an agent context is present.
        if app_host == "autonomous":
            return "Running a Workflow"
        if app_host == "logic app" and has_agent:
            return "Running a Workflow"
    if app_host in {"datawarehousing core", "power bi"}:
        return "Data Querying"
    return "General Chat"

def compute_behavior_category(
    profile: str,
    app_host: str,
    ctx_type: str,
    res_type: str,
    res_action: str,
    site_url: str,
    plugin_id: str,
    has_agent: bool,
    has_resource: bool = False,
) -> str:
    app_host_l = (app_host or "").lower()
    ctx_l = (ctx_type or "").lower()
    res_t_l = (res_type or "").lower()
    res_a_l = (res_action or "").strip().lower()
    site_l = (site_url or "").lower()
    plugin_l = (plugin_id or "").lower()
    # Exact audit actions only: substrings such as "preview" or "notcreated"
    # are not evidence that content was authored.
    is_active = res_a_l in _ACTIVE_RES_ACTION_TOKENS

    explicit_actions = {
        "sendemailv2": "Email Drafting", "draftemail": "Email Drafting",
        "senddraftemail": "Email Drafting", "updatedraftemail": "Email Drafting",
        "mcp_meetingmanagement": "Meeting Scheduling",
        "postmessagetoconversation": "Teams Messaging", "createchat": "Teams Messaging",
        "executedatasetquery": "Data Querying", "getitems": "Data Querying",
        "getalltables": "Data Querying", "gettableviews": "Data Querying",
    }
    if res_a_l in explicit_actions:
        return explicit_actions[res_a_l]
    from_resource = _resource_behavior(profile, res_t_l, res_a_l, site_l, is_active)
    if from_resource and from_resource != "Referenced Content Assistance":
        return from_resource
    context = _context_behavior(profile, app_host_l, ctx_l, is_active, has_agent)
    # Only weak references yield to context; recognized resource domains do not.
    if res_t_l in {"http://schema.skype.com/hyperlink", "citation", "external", "http", ""}:
        if context != "General Chat":
            return context

    if from_resource:
        return from_resource
    if plugin_l == "enterprisesearch":
        return "Enterprise Searching"
    if has_resource or res_t_l or res_a_l or site_l:
        return "Unmapped Resource Assistance"
    return context

def _resource_slice_identity(
    behavior_category: str, behavior_enriched: str, resource_type: str,
    resource_action: str, context_type: str, app_host: str,
) -> tuple[str, str]:
    """Residual partition from public values only; never infer a protected URL."""
    category = (behavior_category or "").strip().lower()
    if category != (behavior_enriched or "").strip().lower():
        return "", ""
    kind = (resource_type or "").strip().lower()
    action = (resource_action or "").strip().lower()
    context = (context_type or "").strip().lower()
    host = (app_host or "").strip().lower()
    typed = (
        (category == "excel assistance" and kind in {"xlsx", "csv", "xlsm", "xlsb", "xls"})
        or (category == "document assistance" and kind in {"docx", "doc", "rtf"})
        or (category == "presentation summarising" and kind in {"pptx", "ppt", "potx"})
        or (category == "email summarising" and kind == "emailmessage")
        or (category == "meeting prep" and kind in {"event", "teamsmeeting"})
        or (category == "teams assistance" and kind in {"teamsmessage", "teamschat", "teamschannel"})
        or (category == "loop assistance" and kind in {"loop", "looppage"})
    )
    if typed:
        active = action in {"send", "draft", "create", "post", "invoke", "write", "patch", "execute"}
        return "typed-resource", "active" if active else "reference"
    office_context = (
        (category == "excel assistance" and (host == "excel" or context in {"xlsx", "xlsm", "xlsb", "xls", "csv"}))
        or (category == "document assistance" and (host == "word" or context == "docx"))
        or (category == "presentation summarising" and (host == "powerpoint" or context in {"pptx", "pptm"}))
        or (category == "email summarising" and host in {"outlook", "outlooksidepane"})
        or (category == "meeting prep" and context == "teamsmeeting")
        or (category == "teams assistance" and context in {"teamschat", "teamschannel"})
        or (category == "loop assistance" and host in {"loop", "whiteboard", "vivaengage"})
    )
    if office_context and kind in {"", "http://schema.skype.com/hyperlink", "citation", "external", "http"}:
        return "context-reference", ""
    return "", ""

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

def compute_behavior_enriched(profile: str, behavior_category: str, agent_name: str, environment: str) -> str:
    # AIO enriches agent/autonomous rows; AIBV enriches agents/cowork rows.
    # (In practice AIBV `Environment` never returns "Agents", so only Cowork enriches.)
    enrich_envs = {"Agents", "Autonomous Agent"} if profile == "aio" else {"Agents", "Cowork"}
    if environment not in enrich_envs:
        return behavior_category
    if behavior_category not in _GENERIC_QA_BEHAVIORS:
        return behavior_category
    name_l = (agent_name or "").lower()
    for tokens, label in _AGENT_NAME_RULES:
        if any(t in name_l for t in tokens):
            return label
    return "Agent: General Purpose"

def compute_autonomy_pattern(profile: str, environment: str, is_agent_activity_str: str) -> str:
    if profile == "aio":
        if environment == "Licensed M365 Copilot":
            return "1 - Copilot"
        if environment == "Agents":
            return "2 - Agent-Assisted"
        if environment == "Autonomous Agent":
            return "3 - Autonomous"
        return ""
    if environment == "Cowork":
        return "3 - Cowork"
    if is_agent_activity_str == "TRUE":
        return "2 - Agent-Assisted"
    if environment == "Licensed":
        return "1 - Copilot"
    return ""

def compute_behavior_source(
    profile: str,
    behavior_category: str,
    environment: str,
    agent_name: str,
    plugin_name: str,
    app_host: str,
) -> str:
    agent = (agent_name or "").strip()
    plugin = (plugin_name or "").strip()
    app = (app_host or "").strip()
    if profile == "aio" and environment == "Autonomous Agent":
        source = "Autonomous Agent" + (f": {agent}" if agent else "")
    elif profile != "aio" and environment == "Cowork":
        source = "Cowork" + (f": {agent}" if agent else "")
    elif environment == "Agents" and agent:
        source = f"Agent: {agent}"
    elif plugin:
        source = f"{app} ({plugin})"
    elif app:
        source = app
    else:
        source = "Copilot Chat"
    return f"{behavior_category} → {source}"

_VO_TIME_EMAIL = frozenset({"Email Summarising", "Email Triage", "Email Thread Summary"})

_VO_TIME_MEET = frozenset({"Meeting Prep", "Video Summarising"})

_VO_TIME_DOC = frozenset({"Document Summarising", "Presentation Summarising", "Note Taking", "Document Assistance"})

_VO_SEARCH = frozenset({
    "Web Searching", "Enterprise Searching", "File Retrieval", "PDF Analysis",
    "SharePoint Access", "People Lookup", "Agent: Knowledge Base",
})

_VO_COMM = frozenset({"Teams Messaging", "Meeting Scheduling", "Teams Assistance"})

_VO_SHEET = frozenset({"Spreadsheet Review", "Spreadsheet Analysis", "Excel Assistance"})

_VO_CONTENT = frozenset({
    "Email Drafting", "Document Drafting", "Presentation Creation",
    "Image Generation", "Image / Media Analysis", "Image/Media Analysis",
    "Agent: Content Generation", "Agent: Ideation & Creative",
})

_VO_TEAMCOLLAB = frozenset({"Real-time Collaboration", "Form / Survey Work", "Loop Assistance"})

_VO_DATA = frozenset({"Data Querying", "Agent: Data & Reporting", "Agent: Research & Analysis"})

_VO_CODE = frozenset({"Code Writing", "Code Analysis", "Code Analysis (URL)"})

_VO_COACH = frozenset({"Agent: Coaching", "Agent: Coaching (URL)"})

_VO_DOMAIN = frozenset({"Domain-Specific Agent", "Cross-Org Agent"})

_NEUTRAL_BEHAVIORS = frozenset({
    "Document Assistance", "Teams Assistance", "Loop Assistance",
    "Excel Assistance", "Referenced Content Assistance",
    "Unmapped Resource Assistance", "Mixed Resource Assistance",
})

def compute_value_outcome(
    profile: str, behavior_enriched: str, environment: str, is_sensitive_str: str
) -> str:
    b = behavior_enriched or ""
    # Profile-specific workflow signal (AIO: Workflow Execution / Autonomous Agent;
    # AIBV: Running a Workflow / Cowork).
    workflow_behavior = "Workflow Execution" if profile == "aio" else "Running a Workflow"
    workflow_env = "Autonomous Agent" if profile == "aio" else "Cowork"
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
    if b == workflow_behavior or environment == workflow_env:
        return "Workflow Automation"
    if b == "Task Management":
        return "Task Coordination"
    if (
        is_sensitive_str == "TRUE"
        and environment != "Agents"
        and environment != workflow_env
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

def compute_behavior_enriched_full(behavior_enriched: str) -> str:
    # No Agents 365 ingestion (by design) => NeedsEnhancement is always FALSE
    # => Behavior_Enriched_Full is exactly Behavior_Enriched.
    return behavior_enriched

_UM_PRODUCING = frozenset({
    "Email Drafting", "Document Drafting", "Presentation Creation", "Image Generation",
    "Code Writing", "Code Analysis", "Code Analysis (URL)", "Data Querying",
    "Spreadsheet Analysis", "Excel Assistance", "Agent: Content Generation",
    "Agent: Ideation & Creative", "Agent: Research & Analysis", "Agent: Data & Reporting",
    "Agent: Sales & Customer", "Agent: HR & People", "Agent: IT & Service Desk",
    "Agent: Compliance & Policy", "Agent: Coaching", "Agent: Coaching (URL)",
    "Domain-Specific Agent", "Cross-Org Agent", "Form / Survey Work",
    "Real-time Collaboration", "Note Taking", "Teams Messaging", "Meeting Scheduling",
    "Task Management",
})

_UM_CONSUMING = frozenset({
    "Document Summarising", "Email Summarising", "Email Thread Summary", "Email Triage",
    "Presentation Summarising", "Video Summarising", "Meeting Prep",
    "Image / Media Analysis", "Image/Media Analysis", "Sensitive Content Interaction",
})

_UM_FINDING = frozenset({
    "Web Searching", "Enterprise Searching", "PDF Analysis", "SharePoint Access",
    "File Retrieval", "People Lookup", "Agent: Knowledge Base", "Spreadsheet Review",
})

def compute_usage_mode(behavior_enriched_full: str, environment: str, app_host: str) -> str:
    # Verbatim port of AIBV `Usage_Mode` with the Agents-365 term dropped
    # (agentTypeA365 = IFERROR(RELATED(...),BLANK()) -> BLANK when A365 absent,
    # so its IN {...} test is always FALSE).
    behavior = behavior_enriched_full
    host = (app_host or "").lower()
    if behavior in _NEUTRAL_BEHAVIORS:
        return "1 - Asking"
    is_delegating = (
        environment == "Cowork"
        or host == "autonomous"
        or behavior == "Running a Workflow"
    )
    if is_delegating:
        return "5 - Delegating"
    if behavior in _UM_PRODUCING:
        return "4 - Producing"
    if behavior in _UM_CONSUMING:
        return "3 - Consuming"
    if behavior in _UM_FINDING:
        return "2 - Finding"
    return "1 - Asking"

_EXPERTISE_RULES: tuple[tuple[frozenset[str], str], ...] = (
    (frozenset({"Data Querying", "Agent: Data & Reporting", "Spreadsheet Analysis"}), "Data Analyst"),
    (frozenset({"Code Writing", "Code Analysis", "Code Analysis (URL)"}), "Software Engineer"),
    (frozenset({"Agent: Research & Analysis"}), "Business Analyst"),
    (frozenset({"Agent: Compliance & Policy", "Sensitive Content Interaction"}), "Compliance Specialist"),
    (frozenset({"Agent: Sales & Customer"}), "Sales Consultant"),
    (frozenset({"Agent: IT & Service Desk"}), "IT Specialist"),
    (frozenset({"Agent: HR & People"}), "HR Specialist"),
    (frozenset({"Agent: Coaching", "Agent: Coaching (URL)"}), "Coach"),
    (frozenset({"Running a Workflow", "Task Management"}), "Automation Engineer"),
    (frozenset({"Domain-Specific Agent", "Cross-Org Agent"}), "Domain Expert"),
    (frozenset({"Email Drafting"}), "Communications Specialist"),
    (frozenset({"Email Triage", "Meeting Scheduling", "Email Summarising", "Email Thread Summary"}), "Executive Assistant"),
    (frozenset({"Document Drafting", "Agent: Content Generation", "Note Taking", "Document Summarising", "Document Assistance"}), "Content Writer"),
    (frozenset({"Presentation Creation", "Presentation Summarising"}), "Presentation Designer"),
    (frozenset({"Image Generation", "Image/Media Analysis", "Image / Media Analysis", "Agent: Ideation & Creative"}), "Visual Designer"),
    (frozenset({"Meeting Prep", "Video Summarising"}), "Meeting Coordinator"),
    (frozenset({"Web Searching", "PDF Analysis", "Agent: Knowledge Base"}), "Researcher"),
    (frozenset({"Enterprise Searching", "SharePoint Access", "File Retrieval", "People Lookup"}), "Knowledge Navigator"),
    (frozenset({"Spreadsheet Review", "Excel Assistance"}), "Spreadsheet Specialist"),
    (frozenset({"Real-time Collaboration", "Form / Survey Work", "Form/Survey Work", "Teams Messaging", "Teams Assistance", "Loop Assistance"}), "Collaboration Lead"),
)

def compute_expertise_role(behavior_enriched_full: str) -> str:
    for members, label in _EXPERTISE_RULES:
        if behavior_enriched_full in members:
            return label
    return ""  # AIBV returns BLANK()

_EFF_RULES: tuple[tuple[frozenset[str], str], ...] = (
    (frozenset({"Email Summarising", "Email Triage", "Email Thread Summary", "Email Drafting"}), "Email"),
    (frozenset({"Document Summarising", "Note Taking", "Document Drafting", "Agent: Content Generation", "Document Assistance"}), "Document Assistance"),
    (frozenset({"Presentation Summarising", "Presentation Creation"}), "Presentations"),
    (frozenset({"Meeting Prep", "Video Summarising", "Meeting Scheduling"}), "Meetings"),
    (frozenset({"Web Searching", "Enterprise Searching", "PDF Analysis", "SharePoint Access", "File Retrieval", "People Lookup", "Agent: Knowledge Base", "Agent: Research & Analysis"}), "Search & Research"),
    (frozenset({"Spreadsheet Review", "Excel Assistance", "Spreadsheet Analysis", "Data Querying", "Agent: Data & Reporting"}), "Data & Spreadsheets"),
    (frozenset({"Image Generation", "Image / Media Analysis", "Image/Media Analysis", "Agent: Ideation & Creative", "Code Writing", "Code Analysis", "Code Analysis (URL)"}), "Creative & Technical"),
    (frozenset({"Teams Messaging", "Real-time Collaboration", "Form / Survey Work", "Task Management", "Running a Workflow", "Teams Assistance", "Loop Assistance"}), "Collaboration & Workflows"),
    (frozenset({"Agent: Sales & Customer", "Agent: IT & Service Desk", "Agent: HR & People", "Agent: Compliance & Policy", "Agent: Coaching", "Agent: Coaching (URL)", "Domain-Specific Agent", "Cross-Org Agent"}), "Specialist Agents"),
)

def compute_efficiency_breakdown(behavior_enriched_full: str, behavior_category: str) -> str:
    for members, label in _EFF_RULES:
        if behavior_enriched_full in members:
            return label
    if behavior_category == "Teams Q&A":
        return "Teams Chat"
    if behavior_category == "M365 Chat Q&A":
        return "BizChat Q&A"
    if behavior_category == "Browser Q&A":
        return "BizChat Q&A"
    return "General Q&A"

_HUMAN_BASELINE_MIN: dict[str, int] = {
    "Agent: Coaching": 45,
    "Agent: Coaching (URL)": 25,
    "Agent: Compliance & Policy": 25,
    "Agent: Content Generation": 25,
    "Agent: Data & Reporting": 35,
    "Agent: General Purpose": 15,
    "Agent: HR & People": 35,
    "Agent: IT & Service Desk": 20,
    "Agent: Ideation & Creative": 40,
    "Agent: Knowledge Base": 12,
    "Agent: Research & Analysis": 45,
    "Agent: Sales & Customer": 35,
    "Browser Q&A": 10,
    "Code Analysis": 30,
    "Code Analysis (URL)": 15,
    "Code Writing": 45,
    "Cross-Org Agent": 30,
    "Data Querying": 30,
    "Document Drafting": 60,
    "Document Summarising": 20,
    "Domain-Specific Agent": 25,
    "Email Drafting": 8,
    "Email Summarising": 4,
    "Email Thread Summary": 5,
    "Email Triage": 10,
    "Enterprise Searching": 18,
    "Excel Assistance": 30,
    "File Retrieval": 15,
    "Form / Survey Work": 25,
    "Form/Survey Work": 25,
    "General Chat": 10,
    "General Q&A": 10,
    "Image / Media Analysis": 8,
    "Image Generation": 60,
    "Image/Media Analysis": 8,
    "M365 Chat Q&A": 10,
    "Meeting Prep": 15,
    "Meeting Scheduling": 12,
    "Note Taking": 20,
    "PDF Analysis": 35,
    "People Lookup": 10,
    "Presentation Creation": 90,
    "Presentation Summarising": 12,
    "Real-time Collaboration": 30,
    "Running a Workflow": 15,
    "Sensitive Content Interaction": 20,
    "SharePoint Access": 12,
    "Spreadsheet Analysis": 40,
    "Spreadsheet Review": 25,
    "Task Management": 20,
    "Teams Messaging": 8,
    "Teams Q&A": 10,
    "Video Summarising": 30,
    "Web Searching": 22,
}

_BVM_BEHAVIORS: frozenset = frozenset({
    "Agent: Coaching",
    "Agent: Compliance & Policy",
    "Agent: Content Generation",
    "Agent: Data & Reporting",
    "Agent: General Purpose",
    "Agent: HR & People",
    "Agent: IT & Service Desk",
    "Agent: Ideation & Creative",
    "Agent: Knowledge Base",
    "Agent: Research & Analysis",
    "Agent: Sales & Customer",
    "Code Analysis",
    "Code Writing",
    "Data Querying",
    "Document Drafting",
    "Document Summarising",
    "Domain-Specific Agent",
    "Email Drafting",
    "Email Summarising",
    "Enterprise Searching",
    "Excel Assistance",
    "File Retrieval",
    "Form / Survey Work",
    "General Chat",
    "Image / Media Analysis",
    "Image Generation",
    "Meeting Prep",
    "Meeting Scheduling",
    "Note Taking",
    "PDF Analysis",
    "People Lookup",
    "Presentation Creation",
    "Presentation Summarising",
    "Real-time Collaboration",
    "Running a Workflow",
    "SharePoint Access",
    "Spreadsheet Review",
    "Task Management",
    "Teams Messaging",
    "Video Summarising",
    "Web Searching",
})

def compute_human_baseline_min(behavior_enriched_full: str) -> str:
    # Direct domain estimates for additional unpinned assistance categories.
    if behavior_enriched_full == "Document Assistance":
        return "20"
    if behavior_enriched_full == "Teams Assistance":
        return "8"
    if behavior_enriched_full == "Loop Assistance":
        return "30"
    # Emit the baseline only when reachable via the BVM bridge (AIBV topology).
    if behavior_enriched_full in _BVM_BEHAVIORS:
        return str(_HUMAN_BASELINE_MIN[behavior_enriched_full])
    return ""

_UNLICENSED_PLAUSIBLE = frozenset({
    "General Chat", "Web Searching", "PDF Analysis", "Document Summarising",
    "Image / Media Analysis", "Image Generation", "Code Analysis", "Translation",
})

_BP_WORKAROUND_EMAIL = frozenset({"Email Summarising", "Email Drafting"})

_BP_WORKAROUND_SHEET = frozenset({"Excel Assistance", "Spreadsheet Review", "Data Querying"})

_BP_WORKAROUND_MEET = frozenset({"Meeting Prep", "Meeting Scheduling"})

_BP_WORKAROUND_ENT = frozenset({"Enterprise Searching", "People Lookup"})

_BP_WORKAROUND_WORKFLOW = frozenset({"Running a Workflow", "Task Management"})

def compute_behavior_plausible(license_status: str, behavior_category: str) -> str:
    lic = license_status
    beh = behavior_category
    if lic == "M365 Copilot Licensed" or beh in _UNLICENSED_PLAUSIBLE or beh in _NEUTRAL_BEHAVIORS:
        return beh
    if beh in _BP_WORKAROUND_EMAIL:
        return "Free Chat Workaround (pasting Email)"
    if beh in _BP_WORKAROUND_SHEET:
        return "Free Chat Workaround (pasting Spreadsheet/Data)"
    if beh in _BP_WORKAROUND_MEET:
        return "Free Chat Workaround (pasting Meeting info)"
    if beh == "Teams Messaging":
        return "Free Chat Workaround (pasting Teams content)"
    if beh in _BP_WORKAROUND_ENT:
        return "Free Chat Workaround (pasting Enterprise data)"
    if beh in _BP_WORKAROUND_WORKFLOW:
        return "Free Chat Workaround (pasting Workflow)"
    if beh == "Real-time Collaboration":
        return "Free Chat Workaround (pasting Loop content)"
    if beh == "Code Writing":
        return "Free Chat Workaround (pasting Code)"
    if beh == "Video Summarising":
        return "Free Chat Workaround (uploading Video)"
    return "Free Chat Workaround (Other)"

def compute_workflow_action(behavior_enriched_full: str, res_action: str, app_host: str) -> str:
    if behavior_enriched_full != "Running a Workflow":
        return ""
    ra = (res_action or "").lower()
    host = (app_host or "").lower()
    if "send" in ra or "post" in ra or "notify" in ra:
        return "Sending / Notifying"
    if "create" in ra or "draft" in ra or "write" in ra or "add" in ra:
        return "Creating Content"
    if "invoke" in ra or "execute" in ra or "trigger" in ra or "run" in ra:
        return "Invoking / Triggering"
    if "update" in ra or "patch" in ra or "modify" in ra or "set" in ra:
        return "Updating Records"
    if "read" in ra or "get" in ra or "list" in ra or "fetch" in ra:
        return "Reading Data"
    if "delete" in ra or "remove" in ra:
        return "Deleting / Removing"
    if host == "autonomous":
        return "Autonomous Run (no action logged)"
    if host == "logic app":
        return "Logic App Run (no action logged)"
    return "Workflow (other)"

def compute_delegation_event_key(
    audit_user_id: str,
    interaction_date_str: str,
    agent_name: str,
    workflow_action: str,
    app_host: str,
) -> str:
    # Verbatim port of AIBV `Delegation_Event_Key`:
    #   Audit_UserId & "|" & FORMAT(InteractionDate,"yyyy-mm-dd") & "|" &
    #   COALESCE(AgentName, Workflow_Action, AppHost, "unknown-workflow")
    # NOTE: DAX FORMAT "mm" resolves to MONTH here (not minute) because it does
    # not follow h/hh — so interaction_date_str ("%Y-%m-%d") matches exactly.
    # COALESCE: we treat empty/whitespace as blank (skip it). The blank-vs-empty
    # nuance + rollup-vs-fanout grain interaction affect the
    # parity (measure: [Delegation Events] = DISTINCTCOUNT, filtered Usage_Mode
    # = "5 - Delegating").
    tail = "unknown-workflow"
    for candidate in (agent_name, workflow_action, app_host):
        if candidate and candidate.strip():
            tail = candidate
            break
    return f"{audit_user_id}|{interaction_date_str}|{tail}"

def compute_user_month_key(audit_user_id: str, month_start_str: str) -> str:
    if not audit_user_id or not month_start_str:
        return ""
    # MonthStart is YYYY-MM-DD; format key as YYYY-MM (mirrors DAX FORMAT(...,"yyyy-MM"))
    return f"{audit_user_id}|{month_start_str[:7]}"

def compute_agent_publish_status(agent_id: str, agent_name: str) -> str:
    has_agent_id = bool((agent_id or "").strip())
    if not has_agent_id:
        return "Not an Agent Row"
    if "draft as 1p" in (agent_name or "").lower():
        return "Unpublished"
    return "Published"

def compute_is_agent_activity(agent_name: str, agent_id: str, app_host: str, res_type: str) -> str:
    has_agent = bool((agent_name or "").strip())
    has_agent_id = bool((agent_id or "").strip())
    host = (app_host or "").lower()
    rt = (res_type or "").lower()
    is_autonomous = host in {"autonomous", "logic app"} or rt in {"flow", "connector"}
    return "TRUE" if (has_agent or has_agent_id or is_autonomous) else "FALSE"

def compute_web_grounded_signal(res_type: str, site_url: str) -> str:
    rt = (res_type or "").lower()
    su = (site_url or "").lower()
    is_internal = "sharepoint.com" in su or ".onmicrosoft.com" in su
    if (
        rt == "websearchquery"
        or rt in {"external", "http"}
        or (rt == "http://schema.skype.com/hyperlink" and not is_internal)
    ):
        return "Web Grounded"
    return "Not Web Grounded"

_NEXT_USER_KEY = 1

def mint_user_key(user_key_map: dict[str, int], normalized_identity: str) -> int:
    """Return the key reserved for an identity, allocating the next free key once."""
    global _NEXT_USER_KEY
    reserved = user_key_map.get(normalized_identity)
    if reserved is not None:
        return reserved
    assigned = _NEXT_USER_KEY
    _NEXT_USER_KEY = assigned + 1
    user_key_map[normalized_identity] = assigned
    return assigned

_UNKNOWN_EFFECTIVE_DATE = "Unknown"

def temporal_state_key(normalized_identity: str, has_license: str, license_status: str) -> str:
    """Stable identity+state key. The fingerprint covers exactly the two temporal
    attributes copied into Fact attribution."""
    fingerprint = hashlib.sha256(
        (has_license + "\x1f" + license_status).encode("utf-8")
    ).hexdigest()
    return normalized_identity + "\x1f" + fingerprint

def resolve_user_history_state(
    states: dict[str, list[dict[str, str]]], normalized_identity: str, event_date: str
) -> dict[str, str] | None:
    selected = None
    unknown_state = None
    earliest_dated = None
    for state in states.get(normalized_identity, []):
        if state["EffectiveDate"] == _UNKNOWN_EFFECTIVE_DATE:
            unknown_state = state
            continue
        if earliest_dated is None:
            earliest_dated = state
        if state["EffectiveDate"] > event_date:
            break
        selected = state
    # An event earlier than the first observation attributes to the earliest dated state
    # for a user we do know, rather than to a parallel unknown row.
    return selected or earliest_dated or unknown_state

def explode_record(
    audit_data: dict[str, Any],
    user_lookup: dict[str, dict[str, str]],
    user_key_map: dict[str, int],
    thread_key_map: dict[str, int],
    profile: str,
    user_history: bool = False,
) -> list[dict[str, Any]]:
    if is_security_copilot(audit_data):
        return []
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
    if not _is_human_upn(audit_user_id_raw):
        return []
    # Deidentify (no-op unless --deidentify) AFTER the human-UPN filter so the filter
    # sees the original; every downstream UserKey/Audit_UserId/join derives from the
    # hashed value, keeping it consistent with the (also-hashed) Users dim.
    audit_user_id_raw = deid_upn(audit_user_id_raw)
    audit_user_id_norm = normalize_user_id(audit_user_id_raw)
    # UserKey INT surrogate. If this audit user wasn't in Entra, mint a new
    # INT and stash so subsequent rows for the same user reuse it. The
    # caller tracks unmatched-vs-Entra via the lookup membership check.
    # ThreadId INT surrogate. deid_guid is a no-op unless --deidentify; under
    # --deidentify it returns a deterministic, format-preserving token (same raw
    # ThreadId -> same token across runs) so the INT-surrogate keying, the
    # ThreadId_Raw output column, and cross-run append dedup stay consistent.
    thread_id_raw = deid_guid(to_text(ced.get("ThreadId")))
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
    if user_history:
        history_for_user = user_lookup.get(audit_user_id_norm) or []
        user_rec = resolve_user_history_state(user_lookup, audit_user_id_norm, creation_date_str)
        if user_rec is None and history_for_user:
            user_rec = history_for_user[0]
        if user_rec is None:
            user_rec = {
                "EffectiveDate": _UNKNOWN_EFFECTIVE_DATE,
                "Has license": "Unknown",
                "License Status": "Unknown",
            }
        if audit_user_id_norm:
            user_key = user_rec.get("UserKey") or mint_user_key(
                user_key_map, temporal_state_key(audit_user_id_norm, "Unknown", "Unknown")
            )
        else:
            user_key = ""
    else:
        if audit_user_id_norm:
            user_key = mint_user_key(user_key_map, audit_user_id_norm)
        else:
            user_key = ""
        user_rec = user_lookup.get(audit_user_id_norm) or {
            "Has license": "Unknown", "License Status": "Unknown"
        }
    has_license_raw = user_rec.get("Has license", "")
    license_status = user_rec.get("License Status") or compute_license_status(has_license_raw)
    environment = compute_environment(profile, has_license_raw, agent_name, agent_id, app_host_str)
    if license_status == "Unknown" and environment in {
        "Licensed M365 Copilot", "Unlicensed Chat", "Licensed", "Unlicensed"
    }:
        environment = "Unknown"
    ai_model = compute_ai_model(model_name_str)
    user_month_key = compute_user_month_key(audit_user_id_raw, month_start_str)

    is_aibv = profile != "aio"

    # Per-record constants hoisted out of the (prompt x resource) inner loop.
    # All grain values are pre-stringified via to_text() exactly once so the
    # rollup loop can use the tuple directly as the dict key.
    user_key_text = to_text(user_key)
    thread_key_text = to_text(thread_key)
    agent_title_id = derive_agent_title_id(audit_data.get("AgentId"))
    aisystem_plugin_name_str = to_text(first_plugin.get("Name")) if first_plugin else ""
    in_entra = (audit_user_id_norm in user_lookup) if audit_user_id_norm else True
    # AIBV-only per-record constants.
    agent_publish_status = compute_agent_publish_status(agent_id, agent_name) if is_aibv else ""
    # has_agent gate for the Behavior_Category "logic app" branch (AIBV).
    has_agent_ctx = bool(agent_name.strip()) or bool(agent_id.strip())

    # Stable portion of the nongrain dict (everything that does NOT depend on
    # the per-resource fields). Built once per record; copied per emitted row
    # and updated with the resource-varying keys. Common keys first; AIBV-only
    # keys appended only for the aibv profile so the AIO output stays the exact
    # Column set.
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
        # Stable, deid-consistent user identity (AIO parity with the
        # AIBV [Audit_UserId_Normalized] value). Emitted only for the AIO profile
        # (AIBV's header carries Audit_UserId_Normalized instead), so for AIBV this
        # key is a harmless extra that its fact-header selection ignores.
        "User_Id_Normalized": audit_user_id_norm,
        # Cross-run append reconciliation key (trailing). Constant per record;
        # Message_Id_Raw (per message) is injected in the emit loop below.
        "ThreadId_Raw": thread_id_raw,
    }
    if is_aibv:
        base_nongrain.update({
            # M1: UPN passthrough (raw mirrors AIBV [Audit_UserId]; normalized for joins).
            "Audit_UserId": audit_user_id_raw,
            "Audit_UserId_Normalized": audit_user_id_norm,
            # Agent Filter injected per-resource; Agent Publish Status constant per record.
            "Agent Filter": "",
            "Agent Publish Status": agent_publish_status,
            # Downstream chain + ROI baseline + remaining calc cols (per-resource).
            "Behavior_Enriched_Full": "",
            "Usage_Mode": "",
            "Expertise_Role": "",
            "Efficiency_Breakdown": "",
            "Human_Baseline_Min": "",
            "Behavior_Plausible": "",
            "Delegation_Event_Key": "",
        })

    # Output schema: list of tuples
    #   (grain_tuple, message_id_str, nongrain_dict, in_entra, audit_user_id_norm)
    # consumed directly by run_processor's rollup loop. The grain arity differs
    # by profile (AIO 16 keys; AIBV 19 — the 3 promoted sliceable flags).
    rows: list[tuple[tuple[str, ...], str, dict[str, Any], bool, str]] = []
    for message in prompts:
        # deid_guid is a no-op unless --deidentify (then deterministic + format-
        # preserving), so message_id doubles as the raw Message_Id_Raw dedup key
        # AND the stable mid_to_int surrogate key that aligns with --seed-mid-map
        # across runs.
        message_id = deid_guid(to_text(message.get("Id")))
        # A message can occur in several observed families; totals count distinct IDs.
        for resource in resources:
            res_type_str = to_text(resource.get("Type"))
            res_action_str = to_text(resource.get("Action"))
            res_site_str = to_text(resource.get("SiteUrl"))
            res_sens_label_str = to_text(resource.get("SensitivityLabelId"))
            behavior_category = compute_behavior_category(
                profile, app_host_str, ctx_type_str, res_type_str, res_action_str,
                res_site_str, plugin_id_str, has_agent_ctx, real_resource_count > 0,
            )
            behavior_enriched = compute_behavior_enriched(
                profile, behavior_category, agent_name, environment
            )
            resource_slice = _resource_slice_identity(
                behavior_category, behavior_enriched, res_type_str, res_action_str, ctx_type_str, app_host_str
            )
            is_sensitive_str = compute_is_sensitive(sens_label_str, res_sens_label_str)
            behavior_source = compute_behavior_source(
                profile, behavior_category, environment, agent_name,
                aisystem_plugin_name_str, app_host_str,
            )
            value_outcome = compute_value_outcome(
                profile, behavior_enriched, environment, is_sensitive_str,
            )

            nongrain = dict(base_nongrain)
            nongrain["_ResourceSlice"] = resource_slice
            nongrain["Message_Id_Raw"] = message_id
            nongrain["AccessedResource_Type"] = res_type_str
            nongrain["AccessedResource_Action"] = res_action_str
            nongrain["AccessedResource_SiteUrl"] = deid_resource(res_site_str)
            nongrain["AccessedResource_SensitivityLabelId"] = res_sens_label_str
            nongrain["Behavior_Source"] = behavior_source
            nongrain["Value_Outcome"] = value_outcome

            common_grain = (
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
            )

            if is_aibv:
                # AIBV-faithful per-resource flags (3 are grain keys).
                is_agent_activity_str = compute_is_agent_activity(
                    agent_name, agent_id, app_host_str, res_type_str
                )
                web_grounded_str = compute_web_grounded_signal(res_type_str, res_site_str)
                # Autonomy_Pattern depends on per-resource Is_Agent_Activity (AIBV).
                autonomy_pattern = compute_autonomy_pattern(
                    profile, environment, is_agent_activity_str
                )
                # Downstream chain (faithful without Agents 365 per F2).
                behavior_enriched_full = compute_behavior_enriched_full(behavior_enriched)
                usage_mode = compute_usage_mode(behavior_enriched_full, environment, app_host_str)
                expertise_role = compute_expertise_role(behavior_enriched_full)
                efficiency_breakdown = compute_efficiency_breakdown(
                    behavior_enriched_full, behavior_category
                )
                human_baseline_min = compute_human_baseline_min(behavior_enriched_full)
                behavior_plausible = compute_behavior_plausible(license_status, behavior_category)
                workflow_action = compute_workflow_action(
                    behavior_enriched_full, res_action_str, app_host_str
                )
                delegation_event_key = compute_delegation_event_key(
                    audit_user_id_raw, interaction_date_str, agent_name,
                    workflow_action, app_host_str,
                )
                grain_tuple = common_grain + (
                    autonomy_pattern,
                    app_identity_app_id,
                    aisystem_plugin_name_str,
                    thread_key_text,
                    is_agent_activity_str,
                    web_grounded_str,
                    workflow_action,
                )
                nongrain["Agent Filter"] = "Agents" if is_agent_activity_str == "TRUE" else ""
                nongrain["Behavior_Enriched_Full"] = behavior_enriched_full
                nongrain["Usage_Mode"] = usage_mode
                nongrain["Expertise_Role"] = expertise_role
                nongrain["Efficiency_Breakdown"] = efficiency_breakdown
                nongrain["Human_Baseline_Min"] = human_baseline_min
                nongrain["Behavior_Plausible"] = behavior_plausible
                nongrain["Delegation_Event_Key"] = delegation_event_key
            else:
                # AIO: autonomy keyed purely off Environment; 16-key grain.
                autonomy_pattern = compute_autonomy_pattern(profile, environment, "")
                grain_tuple = common_grain + (
                    autonomy_pattern,
                    app_identity_app_id,
                    aisystem_plugin_name_str,
                    thread_key_text,
                )

            rows.append((grain_tuple, message_id, nongrain, in_entra, audit_user_id_norm))

    return rows
