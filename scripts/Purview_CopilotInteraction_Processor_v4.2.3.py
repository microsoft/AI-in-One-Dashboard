#!/usr/bin/env python3
"""
Purview CopilotInteraction Processor v4.2.3
-------------------------------------------
Two-input / two-output preprocessor for the AI Business Value Dashboard
and AI-in-One Rollup PBIPs.

Output profiles (--profile):
    aibv  (default) : AI Business Value Dashboard. 50-column fact superset —
                      3-value Environment {Cowork, Licensed, Unlicensed},
                      all DAX calc-columns pre-computed (Behavior_*, Usage_Mode,
                      Expertise_Role, Efficiency_Breakdown, Human_Baseline_Min,
                      Behavior_Plausible, Workflow_Action, Delegation_Event_Key,
                      Is_Agent_Activity/Web_Grounded_Signal promoted into the
                      grain for sliceability) + Audit_UserId passthrough.
    aio             : AI-in-One Dashboard. 36-column fact + 2 trailing append-
                      reconciliation columns (Message_Id_Raw, ThreadId_Raw) —
                      5-value Environment {Autonomous Agent, Cowork,
                      Agents, Licensed M365 Copilot, Unlicensed Chat}. Reproduces
                      the AIO output byte-identically in the original 36
                      columns (validated); the two raw keys are appended last so
                      the AIO dashboard is unaffected. ~41% smaller than the aibv
                      fact.

Inputs:
    --purview <raw Purview audit log CSV>     (required)
    --entra   <Entra users CSV w/ licensing>  (required)

Outputs (in --out-dir, default = directory of --purview):
    <purview_stem>_Interactions_<YYYYMMDD_HHMMSS>.csv   (fact table)
    <entra_stem>_Users_<YYYYMMDD_HHMMSS>.csv            (dim table)

    These two files are all the AIBV template needs. Pass --with-aggregates
    (aibv only) to ALSO write 5 pre-aggregated tables for a future calc-table
    offload:
        <purview_stem>_ActiveDaysSummary_<ts>.csv
        <purview_stem>_UserMonthMetrics_<ts>.csv
        <purview_stem>_LicensedUserRankings_<ts>.csv
        <purview_stem>_UnlicensedUserRankings_<ts>.csv
        <purview_stem>_LicensedUserSummary_<ts>.csv

Grain:
    One row per (16-column grain x Message_Id; aibv adds 3 sliceable flag
    keys -> 19). DAX measures use DISTINCTCOUNT(Message_Id) which yields exact
    parity with the semantic-model definitions at every visual / slicer
    combination. Per-resource accumulation is intentionally avoided so counts
    are
    not inflated (~2.25x) by per (prompt x AccessedResource) iteration.

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


def json_loads_rescue(value: str | bytes) -> Any:
    """Second-chance parse: a record the optimized parser rejects is a genuine
    reject only when the standard library rejects it as well."""
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    return json.loads(value)


REJECT_MANIFEST_SCHEMA = "pax-reject-manifest/1"

# A run that finishes but cannot account for every input record is reported
# separately from a run that died: the candidate outputs are preserved, nothing
# is published, and the caller can tell the two apart.
EXIT_RESIDUAL_REJECTS = 40


def reject_row_digest(row: dict[str, Any]) -> str:
    """Identifies a rejected source row without disclosing any part of it."""
    digest = hashlib.sha256()
    for key in sorted(row.keys(), key=lambda item: "" if item is None else str(item)):
        digest.update(str(key).encode("utf-8", "replace"))
        digest.update(b"\x1e")
        value = row.get(key)
        digest.update(("" if value is None else str(value)).encode("utf-8", "replace"))
        digest.update(b"\x1f")
    return digest.hexdigest().upper()


def reject_manifest_path_for(output_path: str) -> str:
    target = Path(output_path)
    return str(target.with_name(target.stem + "_Rejects.jsonl"))


class RejectManifest:
    """Every rejected row, streamed to disk as it is encountered.

    There is no cap, no sample, no truncation and no first-N: a run with
    100,000 rejects writes 100,000 entries. Only the record ordinal, a
    sanitized reason and a digest are recorded - never a field value, an
    identifier or any part of the row text.
    """

    def __init__(self, path: str, processor: str, processor_version: str) -> None:
        self.path = path
        self.count = 0
        self._processor = processor
        self._processor_version = processor_version
        self._handle: Any = None
        # A manifest left by an earlier run at the same derived name would
        # otherwise be read as this run's verdict.
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass

    def record(self, ordinal: int, reason: str, digest: str) -> None:
        if self._handle is None:
            self._handle = open(self.path, "w", encoding="utf-8", newline="\n")
            self._write({
                "schema": REJECT_MANIFEST_SCHEMA,
                "processor": self._processor,
                "processorVersion": self._processor_version,
            })
        self.count += 1
        self._write({"ordinal": int(ordinal), "reason": reason, "sourceRowDigest": digest})

    def _write(self, payload: dict[str, Any]) -> None:
        self._handle.write(json.dumps(payload, separators=(",", ":"), sort_keys=True))
        self._handle.write("\n")

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None


SCRIPT_VERSION = "4.2.3"

# ---------------------------------------------------------------------------
# Output schemas — TWO PROFILES
#
#   --profile aio   : reproduces the AIO-faithful output EXACTLY except
#                     for two provenance columns (Message_Id_Raw, ThreadId_Raw)
#                     APPENDED LAST for cross-run append reconciliation.
#                     The original 36 columns are unchanged in name, order, and
#                     value (5-value Environment vocabulary), so the pre-existing
#                     AIO output is unchanged; only the two
#                     trailing raw keys are new. This is the contract the
#                     AI-in-One dashboard already consumes.
#   --profile aibv  : the AIBV-faithful superset (50-col fact, 3-value
#                     Environment, all offloaded calc cols + grain-promoted
#                     sliceable flags).
#
# Both share one classification CODEBASE; the per-profile vocabulary is
# selected by the `profile` argument threaded through the classifiers.
# ---------------------------------------------------------------------------

# Common grain prefix (identical in both profiles).
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

# AIO grain = the common 16.
GRAIN_KEYS_AIO: tuple[str, ...] = _GRAIN_KEYS_COMMON

# AIBV grain = common 16 + 3 promoted per-resource flags (sliceability fix).
GRAIN_KEYS_AIBV: tuple[str, ...] = _GRAIN_KEYS_COMMON + (
    # Promoted into the grain (sliceability fix): computed per-resource and
    # bound to AIBV slicers/filters, so they MUST be grain-faithful. Validated
    # at 0.000% row inflation on real data.
    "Is_Agent_Activity",
    "Web_Grounded_Signal",
    "Workflow_Action",
)

# Cross-run append reconciliation keys: the stable raw GUIDs behind the
# INT surrogates Message_Id (message) and ThreadId (thread). Appended as the FINAL
# two columns of EVERY profile so all pre-existing column positions are unchanged.
# The PAX append layer (ConvertTo-FactSeedMaps / Merge-FactCsv) dedups cross-run on
# Message_Id_Raw. Under --deidentify these carry the deterministic deid_guid token
# (same raw GUID -> same token across runs) so append dedup still reconciles.
_RAW_ID_ATTRS: tuple[str, ...] = (
    "Message_Id_Raw",
    "ThreadId_Raw",
)

# AIO non-grain carried attrs end at ActivityDate;
# the trailing _RAW_ID_ATTRS are appended below to form _NONGRAIN_ATTRS_AIO.
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
# AIO carried attrs = the base set + a stable user-identity column + the
# trailing raw reconciliation keys.
_NONGRAIN_ATTRS_AIO: tuple[str, ...] = _NONGRAIN_ATTRS_AIO_BASE + (
    # Stable, deid-consistent user identity for AIO. Mirrors the
    # AIBV [Audit_UserId_Normalized] value (deid_upn -> normalize_user_id), so it
    # is deterministically de-identified under -Deidentify and never exposes a raw
    # UPN. Gives the cross-run append merge key a stable user component in place of
    # the per-run UserKey INT surrogate. Placed BEFORE the raw keys so
    # Message_Id_Raw / ThreadId_Raw stay the trailing reconciliation columns.
    "User_Id_Normalized",
) + _RAW_ID_ATTRS

# AIBV non-grain carried attrs = AIO base set + AIBV-only offloaded columns, with
# the raw reconciliation keys appended LAST so they remain the trailing two columns
# for this profile too (all pre-existing AIBV column positions unchanged).
_NONGRAIN_ATTRS_AIBV: tuple[str, ...] = _NONGRAIN_ATTRS_AIO_BASE + (
    # M1: UPN passthrough for AIBV joins + DISTINCTCOUNT.
    "Audit_UserId",
    "Audit_UserId_Normalized",
    # AIBV-faithful row-level flags. (Is_Agent_Activity / Web_Grounded_Signal /
    # Workflow_Action were promoted into GRAIN_KEYS_AIBV.) `Agent Filter`
    # derives from Is_Agent_Activity, so it stays a grain-consistent carried attr.
    "Agent Filter",
    "Agent Publish Status",
    # Downstream classification chain (offloaded; faithful without Agents 365 per F2).
    "Behavior_Enriched_Full",
    "Usage_Mode",
    "Expertise_Role",
    "Efficiency_Breakdown",
    # ROI baseline pre-join (offloads the Human Equivalent Hours SUMX+RELATED).
    "Human_Baseline_Min",
    # Remaining row-level calc cols (offloaded).
    "Behavior_Plausible",
    "Delegation_Event_Key",
) + _RAW_ID_ATTRS

# Final fact CSV schemas. One row per (grain x Message_Id). Message_Id is
# emitted as a sequential INT surrogate (1-based, assigned in input order).
FACT_HEADER_AIO: list[str] = list(GRAIN_KEYS_AIO) + ["Message_Id"] + list(_NONGRAIN_ATTRS_AIO)
FACT_HEADER_AIBV: list[str] = list(GRAIN_KEYS_AIBV) + ["Message_Id"] + list(_NONGRAIN_ATTRS_AIBV)


def schema_for(profile: str) -> tuple[tuple[str, ...], tuple[str, ...], list[str]]:
    """Return (grain_keys, nongrain_attrs, fact_header) for the profile."""
    if profile == "aio":
        return GRAIN_KEYS_AIO, _NONGRAIN_ATTRS_AIO, FACT_HEADER_AIO
    return GRAIN_KEYS_AIBV, _NONGRAIN_ATTRS_AIBV, FACT_HEADER_AIBV

# Entra column-name aliases used by the existing PBIP M-code. We mirror the
# same renaming so the dim CSV is drop-in compatible with all downstream DAX.
UPN_VARIANTS_NORMALIZED = {"userprincipalname", "upn", "personid"}
DEPARTMENT_VARIANT_NORMALIZED = "department"
# Organization source precedence (most meaningful first). `department` carries the
# human-readable org name in a directory export; a column literally named
# Organization/Organisation is accepted only when no readable department exists,
# because in real exports it is frequently a numeric department identifier.
_DEPARTMENT_SOURCE_PREFERENCE: tuple[str, ...] = (
    DEPARTMENT_VARIANT_NORMALIZED,
    "organisation",
    "organization",
)
# Name used to retain a displaced Organization-named identifier column.
_DISPLACED_ORG_COLUMN = "Organization_Id"
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


# ---------------------------------------------------------------------------
# Deidentification (--deidentify): one-way, salted, format-preserving.
# OFF by default; enabled by main() setting the module flag from --deidentify.
# Every PII value becomes a deterministic token so relationships (manager links,
# UserKey/Users joins, distinct-resource counts) are preserved while identities
# are removed. Irreversible (no decode map). The SAME salt + algorithm + formats
# MUST exist verbatim in the PowerShell raw-path deidentifier and the M365
# processor (PAX deidentify spec) so tokens match across engines.
# ---------------------------------------------------------------------------
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


def deid_name(value: str) -> str:
    """Person/device display name -> <12hex>."""
    if not _DEIDENTIFY or not value:
        return value
    k = "name\x00" + value
    v = _deid_cache.get(k)
    if v is None:
        v = _deid_hex(value, 12)
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


def deid_sid(value: str) -> str:
    """SID -> deterministic S-1-5-21-<d1>-<d2>-<d3>-<d4> shape."""
    if not _DEIDENTIFY or not value:
        return value
    k = "sid\x00" + value
    v = _deid_cache.get(k)
    if v is None:
        h = _deid_hex(value, 32)
        v = "S-1-5-21-{0}-{1}-{2}-{3}".format(
            int(h[0:8], 16), int(h[8:16], 16), int(h[16:24], 16), int(h[24:32], 16)
        )
        _deid_cache[k] = v
    return v


def deid_token(value: str) -> str:
    """Opaque id (employeeId, immutableId) -> <12hex>."""
    if not _DEIDENTIFY or not value:
        return value
    k = "tok\x00" + value
    v = _deid_cache.get(k)
    if v is None:
        v = _deid_hex(value, 12)
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


def deid_file(value: str) -> str:
    """File / document name -> file_<12hex>."""
    if not _DEIDENTIFY or not value:
        return value
    k = "file\x00" + value
    v = _deid_cache.get(k)
    if v is None:
        v = "file_" + _deid_hex(value, 12)
        _deid_cache[k] = v
    return v


def deid_proxy(value: str) -> str:
    """proxyAddresses entry(ies) -> keep smtp:/SMTP: prefix + deidentified email.
    Handles ';'-delimited multi-value fields."""
    if not _DEIDENTIFY or not value:
        return value
    out = []
    for entry in value.split(";"):
        if not entry:
            out.append(entry)
        elif ":" in entry:
            prefix, addr = entry.split(":", 1)
            out.append(prefix + ":" + deid_upn(addr))
        else:
            out.append(deid_upn(entry))
    return ";".join(out)


# Non-human/system identities found in Purview audit logs (Teams Sync, SharePoint app,
# SupervisoryReview bots, ServicePrincipals, NT-style accounts, SIDs, bare GUIDs, etc.).
# These have no matching userPrincipalName in EntraUsers and would render as blank
# User/Department rows in downstream visuals. Filter out before any record is emitted.
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


@functools.lru_cache(maxsize=None)
def compute_license_status(has_license_raw: str) -> str:
    val = normalize_has_license(has_license_raw)
    return {"TRUE": "M365 Copilot Licensed", "FALSE": "Unlicensed"}.get(val, "Unknown")


@functools.lru_cache(maxsize=None)
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


@functools.lru_cache(maxsize=None)
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


@functools.lru_cache(maxsize=None)
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


# Autonomy_Pattern — profile-aware.
#   AIO: keyed off the 5-value Environment.
#   AIBV: SWITCH(Cowork->3, Is_Agent_Activity->2, Licensed->1, else BLANK).
@functools.lru_cache(maxsize=None)
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


# Behavior_Source — profile-aware (AIO: "Autonomous Agent" branch; AIBV: "Cowork").
@functools.lru_cache(maxsize=None)
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


# Verbatim port of current AIBV DAX calc col `Value_Outcome`.
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

# Additional labels do not rename the published email, meeting or presentation
# categories. Domain estimates below are direct memberships, not label aliases.
_NEUTRAL_BEHAVIORS = frozenset({
    "Document Assistance", "Teams Assistance", "Loop Assistance",
    "Excel Assistance", "Referenced Content Assistance",
    "Unmapped Resource Assistance", "Mixed Resource Assistance",
})


@functools.lru_cache(maxsize=None)
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


# ---------------------------------------------------------------------------
# Downstream classification chain (offloaded from AIBV DAX).
#
# Per F2 (see offload plan): in the current AIBV model `Environment` never
# returns "Agents", so `Behavior_Enriched_Full`'s NeedsEnhancement guard
# (Env = "Agents" && BaseEnriched = "Agent: General Purpose") is always FALSE
# and the RELATED('Agents 365'...) lookups never execute. Therefore
# Behavior_Enriched_Full == Behavior_Enriched and the whole chain
# (Usage_Mode / Expertise_Role / Efficiency_Breakdown) is fully computable
# here WITHOUT ingesting Agents 365. Published category literals remain stable;
# additional assistance categories do not require template predicate changes.
# ---------------------------------------------------------------------------


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


@functools.lru_cache(maxsize=None)
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


# Verbatim port of AIBV `Expertise_Role` (ordered IF cascade on Behavior_Enriched_Full).
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


@functools.lru_cache(maxsize=None)
def compute_expertise_role(behavior_enriched_full: str) -> str:
    for members, label in _EXPERTISE_RULES:
        if behavior_enriched_full in members:
            return label
    return ""  # AIBV returns BLANK()


# Verbatim port of AIBV `Efficiency_Breakdown` (behavior cascade, then Behavior_Category fallback).
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


@functools.lru_cache(maxsize=None)
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


# ---------------------------------------------------------------------------
# Embedded static value map (offloads the ROI baseline join).
#
# `Human Time Estimates` is a static lookup (Behavior -> Human Baseline (min)).
# The AIBV measure `Human Equivalent Hours` does:
#     SUMX(FILTER(fact, isPrompt="TRUE"), DIVIDE(RELATED(HTE[Human Baseline]),60,0))
# which traverses fact -> Behavior Value Map (BVM) -> Human Time Estimates (HTE)
# per row. We pre-join `Human_Baseline_Min` onto every fact row so the PBIT
# measure collapses to SUM(fact[Human_Baseline_Min])/60 (no SUMX, no RELATED).
#
# FIDELITY: HTE is reachable in the model ONLY through the BVM bridge, so a
# baseline is emitted ONLY when Behavior_Enriched_Full is present in BVM (then
# looked up in HTE; BVM is a strict subset of HTE, so the lookup always hits).
# Behaviors not in BVM contribute 0 hours in the current AIBV — we emit "" for
# them, which SUMs to 0 identically. Both maps are transcribed verbatim from
# the AIBV `.pbit` static #table literals (see temp/_offload_test/_parse_maps.py).
# ---------------------------------------------------------------------------

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

# Behaviors present in the Behavior Value Map bridge (gates HTE reachability).
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


@functools.lru_cache(maxsize=None)
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


# ---------------------------------------------------------------------------
# Remaining row-level calc cols (offloaded from AIBV DAX).
# ---------------------------------------------------------------------------

# Verbatim port of AIBV `Behavior_Plausible`.
_UNLICENSED_PLAUSIBLE = frozenset({
    "General Chat", "Web Searching", "PDF Analysis", "Document Summarising",
    "Image / Media Analysis", "Image Generation", "Code Analysis", "Translation",
})
_BP_WORKAROUND_EMAIL = frozenset({"Email Summarising", "Email Drafting"})
_BP_WORKAROUND_SHEET = frozenset({"Excel Assistance", "Spreadsheet Review", "Data Querying"})
_BP_WORKAROUND_MEET = frozenset({"Meeting Prep", "Meeting Scheduling"})
_BP_WORKAROUND_ENT = frozenset({"Enterprise Searching", "People Lookup"})
_BP_WORKAROUND_WORKFLOW = frozenset({"Running a Workflow", "Task Management"})


@functools.lru_cache(maxsize=None)
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


# Verbatim port of AIBV `Workflow_Action`.
@functools.lru_cache(maxsize=None)
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


# Verbatim port of AIBV calc col `Agent Publish Status`.
@functools.lru_cache(maxsize=None)
def compute_agent_publish_status(agent_id: str, agent_name: str) -> str:
    has_agent_id = bool((agent_id or "").strip())
    if not has_agent_id:
        return "Not an Agent Row"
    if "draft as 1p" in (agent_name or "").lower():
        return "Unpublished"
    return "Published"


# Verbatim port of AIBV calc col `Is_Agent_Activity` (emitted as TRUE/FALSE text,
# mirroring the Is_Sensitive / Message_isPrompt convention; the PBIT types it
# logical). res_type is the per-resource AccessedResource_Type.
@functools.lru_cache(maxsize=None)
def compute_is_agent_activity(agent_name: str, agent_id: str, app_host: str, res_type: str) -> str:
    has_agent = bool((agent_name or "").strip())
    has_agent_id = bool((agent_id or "").strip())
    host = (app_host or "").lower()
    rt = (res_type or "").lower()
    is_autonomous = host in {"autonomous", "logic app"} or rt in {"flow", "connector"}
    return "TRUE" if (has_agent or has_agent_id or is_autonomous) else "FALSE"


# Verbatim port of AIBV calc col `Web_Grounded_Signal`.
@functools.lru_cache(maxsize=None)
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
    # Selection is by meaning, not by source-column position: the readable department
    # name owns `Organization` whenever one is present, because the dashboards bind
    # their Organization slicers to that value.
    for wanted in _DEPARTMENT_SOURCE_PREFERENCE:
        for h in headers:
            if _normalize_col_name(h) == wanted:
                return h
    return None


def detect_displaced_org_columns(headers: list[str], chosen: str | None) -> list[str]:
    """Organization-named source columns displaced by the chosen department column.

    When a readable `department` column is promoted to `Organization`, any
    pre-existing column already named Organization/Organisation would collide.
    Those are preserved under a separate truthful name rather than dropped,
    because a numeric department identifier is legitimate data in its own right.
    """
    if not chosen:
        return []
    displaced: list[str] = []
    for h in headers:
        if h == chosen:
            continue
        if _normalize_col_name(h) in {"organization", "organisation"}:
            displaced.append(h)
    return displaced


def detect_jobtitle_column(headers: list[str]) -> str | None:
    for h in headers:
        if _normalize_col_name(h) == "jobtitle":
            return h
    return None


def load_licensing_map(licensing_csv: str) -> tuple[dict[str, str], int]:
    """Read a standalone licensing CSV (UPN + 'Has License' columns) and return
    (normalized_upn -> raw license value, data_row_count).

    Used by the 3-file input mode to merge license status into a users-only
    Entra file. UPN + license columns are detected with the same alias lists as
    the Entra loader. Duplicate UPNs are last-write-wins (mirrors the M-code
    Table.Distinct behavior on the licensed-users path).
    """
    with open(licensing_csv, "r", encoding="utf-8-sig", newline="") as fin:
        reader = csv.DictReader(fin)
        headers = reader.fieldnames or []
        if not headers:
            raise ValueError(f"Licensing CSV has no header row: {licensing_csv}")
        upn_col = detect_upn_column(headers)
        if upn_col is None:
            raise ValueError(
                f"Licensing CSV has no recognized UPN column "
                f"(expected one of {sorted(UPN_VARIANTS_NORMALIZED)}): {licensing_csv}"
            )
        lic_col = detect_has_license_column(headers)
        if lic_col is None:
            raise ValueError(
                f"Licensing CSV has no recognized license column "
                f"(expected one of {list(HAS_LICENSE_VARIANTS)}): {licensing_csv}"
            )
        license_map: dict[str, str] = {}
        row_count = 0
        for row in reader:
            row_count += 1
            upn_norm = (row.get(upn_col) or "").strip().lower()
            if not upn_norm:
                continue
            license_map[upn_norm] = row.get(lic_col) or ""
    return license_map, row_count


# ---------------------------------------------------------------------------
# Org / manager hierarchy (Users dim enrichment; AIO + AIBV; always on).
# Built from the Entra manager links (id <-> manager_id, UPN fallback) that PAX
# already pulls. Structure is keyed on the INT UserKey surrogate, so every
# *_UserKey / OrgLevel / HierarchyPath column is identical with or without
# --deidentify; the *_Name columns use the display name as written (hashed when
# --deidentify is on). Filler for level slots deeper than a user is controlled
# by --hierarchy-fill (none|self|manager|fixed); 'fixed' uses --hierarchy-fill-label.
# ---------------------------------------------------------------------------
_HIER_LEVELS = 15           # Level0..Level14 denormalized top-down columns
_HIER_WALK_CAP = 1000       # safety backstop for manager-chain walks (cycle guard also applies)
_HIER_FILL_MODE = "none"    # none | self | manager | fixed (set in main() from --hierarchy-fill)
_HIER_FILL_LABEL = ""       # literal label for 'fixed' (set in main() from --hierarchy-fill-label)


def _hier_columns() -> list[str]:
    cols = [
        "Manager_UserKey", "OrgLevel", "HierarchyPath", "TopOfChain_UserKey",
        "IsManager", "DirectReports", "TotalReports",
    ]
    for i in range(_HIER_LEVELS):
        cols.append(f"Level{i}_UserKey")
        cols.append(f"Level{i}_Name")
    return cols


_HIER_COLUMNS: list[str] = _hier_columns()


def _hier_filler(uk: int, mgr, name_by_uk: dict, mode: str, label: str) -> tuple[str, str]:
    """(UserKey, Name) to place in a level slot DEEPER than the user's own level."""
    if mode == "self":
        return str(uk), name_by_uk.get(uk, "")
    if mode == "manager":
        ref = mgr if mgr is not None else uk
        return str(ref), name_by_uk.get(ref, "")
    if mode == "fixed":
        return "", label
    return "", ""  # none


def _build_org_hierarchy(uk_by_id, uk_by_upn, mgr_ptr, name_by_uk) -> dict:
    """Return {UserKey -> {hier_col: value}}.

    uk_by_id  : normalized Entra id   -> UserKey
    uk_by_upn : normalized UPN        -> UserKey
    mgr_ptr   : UserKey -> (manager_id_norm, manager_upn_norm)
    name_by_uk: UserKey -> display name (as written; deid'd when applicable)
    """
    # Immediate manager UserKey for each user (id link first, UPN fallback).
    direct_mgr: dict = {}
    for uk, (mid, mupn) in mgr_ptr.items():
        m = uk_by_id.get(mid) if mid else None
        if m is None and mupn:
            m = uk_by_upn.get(mupn)
        if m == uk:
            m = None  # ignore self-management
        direct_mgr[uk] = m

    direct_reports: dict = {}
    for uk, m in direct_mgr.items():
        if m is not None:
            direct_reports[m] = direct_reports.get(m, 0) + 1

    all_uks = set(uk_by_upn.values()) | set(name_by_uk.keys()) | set(direct_mgr.keys())
    total_reports: dict = {}
    result: dict = {}
    mode = _HIER_FILL_MODE
    label = _HIER_FILL_LABEL

    for uk in all_uks:
        chain = []
        seen = set()
        cur = uk
        while cur is not None and cur not in seen and len(chain) < _HIER_WALK_CAP:
            seen.add(cur)
            chain.append(cur)
            cur = direct_mgr.get(cur)
        # every ancestor of uk gains one report (cycle-safe via `seen`)
        for anc in chain[1:]:
            total_reports[anc] = total_reports.get(anc, 0) + 1
        chain.reverse()  # top .. user
        depth = len(chain) - 1
        top = chain[0]
        mgr = direct_mgr.get(uk)
        rec = {
            "Manager_UserKey": str(mgr) if mgr is not None else "",
            "OrgLevel": str(depth),
            "HierarchyPath": "/".join(str(x) for x in chain),
            "TopOfChain_UserKey": str(top),
        }
        n = len(chain)
        for i in range(_HIER_LEVELS):
            if i < n:
                node = chain[i]
                rec[f"Level{i}_UserKey"] = str(node)
                rec[f"Level{i}_Name"] = name_by_uk.get(node, "")
            else:
                fk, fn = _hier_filler(uk, mgr, name_by_uk, mode, label)
                rec[f"Level{i}_UserKey"] = fk
                rec[f"Level{i}_Name"] = fn
        result[uk] = rec

    for uk in all_uks:
        dr = direct_reports.get(uk, 0)
        result[uk]["DirectReports"] = str(dr)
        result[uk]["IsManager"] = "TRUE" if dr > 0 else "FALSE"
        result[uk]["TotalReports"] = str(total_reports.get(uk, 0))

    return result


def _pax_required_temp_root() -> str:
    """Return the caller-supplied temporary root, refusing to run without a usable one."""
    raw = os.environ.get("PAX_TEMP_ROOT") or ""
    root = raw.strip()
    if not root:
        raise RuntimeError(
            "PAX_TEMP_ROOT is not set. No temporary working file was created and nothing was touched."
        )
    if not os.path.isabs(root):
        raise RuntimeError(
            "PAX_TEMP_ROOT is not a fully qualified path. No temporary working file was created and nothing was touched."
        )
    if not os.path.isdir(root):
        raise RuntimeError(
            "PAX_TEMP_ROOT does not exist as a directory. No temporary working file was created and nothing was touched."
        )
    return root


class _SqliteRowView:
    """Re-iterable, disk-backed drop-in replacement for ``list(csv.DictReader)``.

    Stages every source row into a temporary SQLite table (source sequence +
    JSON payload) in bounded batches during construction, then serves ordered
    re-iteration by reopening a cursor on each pass. The complete row set is
    never held in memory. It behaves like a list for the only two operations the
    callers use — ``len()`` and (repeatable) iteration — and each yielded item is
    the original ``csv.DictReader`` dict reconstructed identically, so downstream
    calculations, ordering, and output are unchanged.
    """

    def __init__(self, reader, batch_size: int = 2000):
        import json
        fd, self._path = tempfile.mkstemp(prefix="pax_rowview_", suffix=".sqlite", dir=_pax_required_temp_root())
        os.close(fd)
        self._conn = sqlite3.connect(self._path)
        self._conn.execute("PRAGMA journal_mode=OFF")
        self._conn.execute("PRAGMA synchronous=OFF")
        self._conn.execute("CREATE TABLE rows (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
        seq = 0
        batch: list = []
        try:
            self._conn.execute("BEGIN")
            for row in reader:
                batch.append((seq, json.dumps(row, ensure_ascii=False)))
                seq += 1
                if len(batch) >= batch_size:
                    self._conn.executemany("INSERT INTO rows (seq, payload) VALUES (?, ?)", batch)
                    batch.clear()
            if batch:
                self._conn.executemany("INSERT INTO rows (seq, payload) VALUES (?, ?)", batch)
            self._conn.execute("COMMIT")
        except Exception:
            try:
                self._conn.execute("ROLLBACK")
            except Exception:
                pass
            self.close()
            raise
        self._count = seq

    def __len__(self) -> int:
        return self._count

    def __iter__(self):
        import json
        cur = self._conn.cursor()
        try:
            cur.execute("SELECT payload FROM rows ORDER BY seq")
            for (payload,) in cur:
                yield json.loads(payload)
        finally:
            cur.close()

    def close(self) -> None:
        conn = getattr(self, "_conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._conn = None
        path = getattr(self, "_path", None)
        if path:
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass

    def __del__(self):
        self.close()


# Exact-case Users columns the AIO semantic model exposes as source columns. Power Query M is
# case-sensitive, so these names must match exactly. PowerShell CSV readers, by contrast, treat
# headers case-INSENSITIVELY and reject a file carrying both `displayName` and `DisplayName`, so
# these two are RENAMED to their canonical form rather than duplicated. `mail` and `Email` differ
# by more than case and may safely coexist, so `mail` is retained and `Email` added alongside it.
# ValueLens consumes the directory-native names and is deliberately unaffected.
_AIO_CANONICAL_RENAMES: tuple[tuple[str, str], ...] = (
    ("displayName", "DisplayName"),
    ("country", "Country"),
)
_AIO_EMAIL_SOURCE = "mail"
_AIO_EMAIL_CANONICAL = "Email"


# UserKey allocation. A new key is always taken from a counter positioned STRICTLY
# ABOVE every key already reserved by a prior append target, so a key that is no
# longer present in the current directory export can never be handed to a different
# identity. With no reserved keys the counter starts at 1 and allocates 1, 2, 3, ...
# in encounter order.
_NEXT_USER_KEY = 1


def reset_user_key_allocator(user_key_map: dict[str, int]) -> None:
    """Position the allocator above every already-reserved key."""
    global _NEXT_USER_KEY
    highest = 0
    for reserved in user_key_map.values():
        if reserved > highest:
            highest = reserved
    _NEXT_USER_KEY = highest + 1


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


def temporal_effective_sort_key(effective_date: str) -> tuple[int, str]:
    """Sort the explicit Unknown state before strictly formatted dated states."""
    return (0, "") if effective_date == _UNKNOWN_EFFECTIVE_DATE else (1, effective_date)


def temporal_state_key(normalized_identity: str, has_license: str, license_status: str) -> str:
    """Stable identity+state key. The fingerprint covers exactly the two temporal
    attributes copied into Fact attribution."""
    fingerprint = hashlib.sha256(
        (has_license + "\x1f" + license_status).encode("utf-8")
    ).hexdigest()
    return normalized_identity + "\x1f" + fingerprint


def load_user_history(path: str | None, user_key_map: dict[str, int]) -> dict[str, list[dict[str, str]]]:
    states: dict[str, list[dict[str, str]]] = {}
    if not path:
        return states
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames or []
        required = {"PersonId_Normalized", "Has license", "License Status", "EffectiveDate", "UserKey"}
        if not required.issubset(set(fields)):
            raise ValueError("UserHistory target does not carry the required history columns")
        for row in reader:
            identity = (row.get("PersonId_Normalized") or "").strip().lower()
            effective = (row.get("EffectiveDate") or "").strip()
            has_license = (row.get("Has license") or "").strip()
            license_status = (row.get("License Status") or "").strip()
            key_text = (row.get("UserKey") or "").strip()
            if not identity or not effective or not key_text:
                raise ValueError("UserHistory target contains an incomplete state row")
            if effective != _UNKNOWN_EFFECTIVE_DATE:
                datetime.strptime(effective, "%Y-%m-%d")
            key = int(key_text)
            if key < 1:
                raise ValueError("UserHistory target contains an invalid UserKey")
            state_key = temporal_state_key(identity, has_license, license_status)
            prior = user_key_map.get(state_key)
            if prior is not None and prior != key:
                raise ValueError("UserHistory target maps one state to multiple UserKeys")
            user_key_map[state_key] = key
            states.setdefault(identity, []).append({
                "EffectiveDate": effective,
                "Has license": has_license,
                "License Status": license_status,
                "UserKey": str(key),
            })
    for identity_states in states.values():
        identity_states.sort(key=lambda item: temporal_effective_sort_key(item["EffectiveDate"]))
    return states


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


def load_entra_and_write_users(
    entra_csv: str,
    users_out_csv: str,
    user_key_map: dict[str, int],
    licensing_csv: str | None = None,
    quiet: bool = False,
    profile: str = "aibv",
    user_history: bool = False,
    history_effective_date: str = "",
    history_states: dict[str, list[dict[str, str]]] | None = None,
) -> dict[str, Any]:
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

    3-file input mode: when `licensing_csv` is provided, `entra_csv` is treated
    as a users-only file and the per-user license value is merged in from the
    separate licensing CSV (keyed on normalized UPN). When `licensing_csv` is
    None the function behaves exactly as before (license read from the combined
    Entra row), so the legacy 2-file output is byte-identical.
    """
    license_map: dict[str, str] | None = None
    licensing_rows = 0
    if licensing_csv:
        license_map, licensing_rows = load_licensing_map(licensing_csv)

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
            # Retain any other Organization-named source column (typically a numeric
            # department identifier) under a separate name so promoting the readable
            # department neither collides with it nor discards it.
            for displaced in detect_displaced_org_columns(original_headers, dept_col):
                alt = _DISPLACED_ORG_COLUMN
                suffix = 2
                while alt in original_headers or alt in rename_map.values():
                    alt = f"{_DISPLACED_ORG_COLUMN}_{suffix}"
                    suffix += 1
                rename_map[displaced] = alt
        if jobtitle_col and jobtitle_col != "JobTitle":
            rename_map[jobtitle_col] = "JobTitle"
        if has_license_col and has_license_col != "Has license":
            rename_map[has_license_col] = "Has license"

        # AIO canonical identity headers. Renamed (not duplicated) so the emitted CSV never
        # carries two headers differing only by case, which PowerShell CSV readers reject.
        # When the export already supplies the exact canonical header, the case-only variant is
        # dropped from the OUTPUT but its source name is remembered: a blank canonical value
        # still falls back to the variant's value rather than emitting a blank field.
        aio_fallback_source_by_canonical: dict[str, str] = {}
        if profile == "aio":
            for _src, _canon in _AIO_CANONICAL_RENAMES:
                _srcs = [h for h in original_headers if h == _src]
                _canons = [h for h in original_headers if h == _canon]
                if _canons:
                    for h in _srcs:
                        rename_map[h] = None
                        aio_fallback_source_by_canonical[_canon] = h
                elif _srcs:
                    rename_map[_srcs[0]] = _canon

        # Final header list for users CSV — preserve original order, apply renames,
        # then append injected columns. UserKey is the INT surrogate that joins
        # to the fact table.
        renamed_headers = [rename_map.get(h, h) for h in original_headers]
        # A None target means the source column is intentionally dropped (AIO case-only variant
        # superseded by an already canonical header).
        renamed_headers = [h for h in renamed_headers if h is not None]
        injected = ["UserKey", "PersonId_Normalized", "License Status", "TotalEmployees"]
        if user_history:
            injected.append("EffectiveDate")
        if "Has license" not in renamed_headers:
            renamed_headers.append("Has license")
        for inj in injected:
            if inj not in renamed_headers:
                renamed_headers.append(inj)
        # AIO exact-case alias headers (aio profile only, additive). ValueLens output shape
        # is deliberately unchanged.
        if profile == "aio":
            if _AIO_EMAIL_CANONICAL not in renamed_headers:
                renamed_headers.append(_AIO_EMAIL_CANONICAL)
        # Org/manager hierarchy columns (always appended; AIO/AIBV Users dim).
        for hc in _HIER_COLUMNS:
            if hc not in renamed_headers:
                renamed_headers.append(hc)

        rows = _SqliteRowView(reader)

    total_rows = len(rows)
    user_lookup: dict[str, dict[str, str]] = {}

    # --- Org/manager hierarchy pre-pass: assign UserKeys in Entra-file order and
    # build the link maps from the SAME rename + deid the write loop applies, then
    # resolve the hierarchy. Always on for the AIO/AIBV Users dim. UserKeys assigned
    # here are reused by the write loop (identical to the prior lazy assignment). ---
    uk_by_id: dict[str, int] = {}
    uk_by_upn: dict[str, int] = {}
    mgr_ptr: dict[int, tuple[str, str]] = {}
    name_by_uk: dict[int, str] = {}
    original_name_by_uk: dict[int, str] = {}
    for src_row in rows:
        pid = src_row.get(upn_col, "") if (upn_col and upn_col != "PersonId") else src_row.get("PersonId", "")
        pid = "" if pid is None else str(pid)
        if _DEIDENTIFY:
            pid = deid_upn(pid)
        pid_norm = pid.strip().lower()
        if not pid_norm:
            continue
        if user_history:
            source_license = license_map.get(pid_norm, "") if license_map is not None else src_row.get(has_license_col, "") if has_license_col else ""
            normalized_source_license = normalize_has_license(source_license)
            source_status = compute_license_status(normalized_source_license)
            uk = mint_user_key(user_key_map, temporal_state_key(pid_norm, normalized_source_license, source_status))
        else:
            uk = mint_user_key(user_key_map, pid_norm)
        uk_by_upn[pid_norm] = uk
        rid = src_row.get("id", "")
        rid = "" if rid is None else str(rid)
        if _DEIDENTIFY:
            rid = deid_guid(rid)
        rid_norm = rid.strip().lower()
        if rid_norm:
            uk_by_id[rid_norm] = uk
        mid = src_row.get("manager_id", "")
        mid = "" if mid is None else str(mid)
        if _DEIDENTIFY:
            mid = deid_guid(mid)
        mupn = src_row.get("manager_userPrincipalName", "")
        mupn = "" if mupn is None else str(mupn)
        if _DEIDENTIFY:
            mupn = deid_upn(mupn)
        mgr_ptr[uk] = (mid.strip().lower(), mupn.strip().lower())
        dn = src_row.get("displayName", "")
        dn = "" if dn is None else str(dn)
        if _DEIDENTIFY and os.environ.get("PAX_USERS_PROTECTION_REFERENCE"):
            original_name_by_uk[uk] = dn
        if _DEIDENTIFY:
            dn = deid_name(dn)
        name_by_uk[uk] = dn
    hier_by_uk = _build_org_hierarchy(uk_by_id, uk_by_upn, mgr_ptr, name_by_uk)

    out_dir = Path(users_out_csv).parent
    out_dir.mkdir(parents=True, exist_ok=True)

    pax_licensed = 0
    pax_unlicensed = 0
    pax_unknown = 0
    no_license_col = 0
    matched_in_licensing = 0
    seen_normalized_keys: set[str] = set()

    # The launcher owns this private, temporary source-comparison reference.
    # It is never an output artifact or a hash-only protection certificate.
    from contextlib import ExitStack
    reference_path = os.environ.get("PAX_USERS_PROTECTION_REFERENCE", "") if _DEIDENTIFY else ""
    with open(users_out_csv, "w", encoding="utf-8", newline="") as fout, ExitStack() as reference_stack:
        writer = csv.DictWriter(fout, fieldnames=renamed_headers, lineterminator="\n")
        writer.writeheader()
        reference_writer = None
        if reference_path:
            reference_stream = reference_stack.enter_context(open(reference_path, "x", encoding="utf-8", newline=""))
            reference_writer = csv.DictWriter(reference_stream, fieldnames=renamed_headers, lineterminator="\n")
            reference_writer.writeheader()

        for src_row in rows:
            # Apply renames + ensure all renamed_headers keys exist in the out row.
            out_row: dict[str, str] = {h: "" for h in renamed_headers}
            for src_h, value in src_row.items():
                tgt_h = rename_map.get(src_h, src_h)
                if tgt_h in out_row:
                    out_row[tgt_h] = "" if value is None else str(value)

            # AIO canonical selection: prefer a nonblank exact canonical value, otherwise fall
            # back to the dropped case-only variant's source value. Done BEFORE the
            # de-identification block so the selected value is the one that gets transformed.
            # Lookups are explicit and case-sensitive - no case-insensitive dictionary access.
            if profile == "aio":
                for _canon, _srcname in aio_fallback_source_by_canonical.items():
                    if not out_row.get(_canon, ""):
                        _fb = src_row.get(_srcname, "")
                        out_row[_canon] = "" if _fb is None else str(_fb)

            original_identity = dict(out_row) if reference_writer is not None else None
            # Deidentification (no-op unless --deidentify): transform identity columns
            # IN PLACE before PersonId_Normalized / UserKey derive from PersonId, so the
            # fact<->Users join and manager links stay consistent across the hash.
            if _DEIDENTIFY:
                if "PersonId" in out_row:
                    out_row["PersonId"] = deid_upn(out_row["PersonId"])
                if "displayName" in out_row:
                    out_row["displayName"] = deid_name(out_row["displayName"])
                # AIO emits the canonical header instead of the case-only variant, so the same
                # transform must be applied to it (dict keys are case-sensitive in Python).
                if "DisplayName" in out_row:
                    out_row["DisplayName"] = deid_name(out_row["DisplayName"])
                if "Email" in out_row:
                    out_row["Email"] = deid_upn(out_row["Email"])
                if "mail" in out_row:
                    out_row["mail"] = deid_upn(out_row["mail"])
                if "givenName" in out_row:
                    out_row["givenName"] = deid_name(out_row["givenName"])
                if "surname" in out_row:
                    out_row["surname"] = deid_name(out_row["surname"])
                if "UserName" in out_row:
                    out_row["UserName"] = deid_upn(out_row["UserName"])
                if "employeeId" in out_row:
                    out_row["employeeId"] = deid_token(out_row["employeeId"])
                if "onPremisesImmutableId" in out_row:
                    out_row["onPremisesImmutableId"] = deid_token(out_row["onPremisesImmutableId"])
                if "proxyAddresses_Primary" in out_row:
                    out_row["proxyAddresses_Primary"] = deid_proxy(out_row["proxyAddresses_Primary"])
                if "proxyAddresses_All" in out_row:
                    out_row["proxyAddresses_All"] = deid_proxy(out_row["proxyAddresses_All"])
                if "id" in out_row:
                    out_row["id"] = deid_guid(out_row["id"])
                if "manager_id" in out_row:
                    out_row["manager_id"] = deid_guid(out_row["manager_id"])
                if "manager_userPrincipalName" in out_row:
                    out_row["manager_userPrincipalName"] = deid_upn(out_row["manager_userPrincipalName"])
                if "manager_displayName" in out_row:
                    out_row["manager_displayName"] = deid_name(out_row["manager_displayName"])
                if "manager_mail" in out_row:
                    out_row["manager_mail"] = deid_upn(out_row["manager_mail"])
                if "ManagerID" in out_row:
                    out_row["ManagerID"] = deid_guid(out_row["ManagerID"])

            # PersonId_Normalized
            person_id = out_row.get("PersonId", "")
            person_id_norm = person_id.strip().lower() if person_id else ""
            out_row["PersonId_Normalized"] = person_id_norm

            # Preserve missing license evidence as Unknown, not a negative observation.
            # Normalize known Has license values to canonical TRUE/FALSE so existing
            # measures that filter `[Has license] = "FALSE"` match regardless
            # of source casing.
            #
            # 3-file input mode: when a separate licensing file is supplied, the
            # per-user license value comes from that file (keyed on normalized
            # UPN). When it is NOT supplied, the value is read from the
            # (combined) Entra row exactly as before -> byte-identical 2-file
            # output.
            if license_map is not None:
                has_license_raw = license_map.get(person_id_norm, "")
            else:
                has_license_raw = out_row.get("Has license", "")
            normalized_has_license = normalize_has_license(has_license_raw)
            if license_map is not None:
                if person_id_norm and person_id_norm in license_map:
                    matched_in_licensing += 1
                if (has_license_raw or "").strip().upper() in _LICENSE_TRUTHY:
                    pax_licensed += 1
                elif normalized_has_license == "FALSE":
                    pax_unlicensed += 1
                else:
                    pax_unknown += 1
            elif has_license_col is None:
                no_license_col += 1
                pax_unknown += 1
            elif (has_license_raw or "").strip().upper() in _LICENSE_TRUTHY:
                pax_licensed += 1
            elif normalized_has_license == "FALSE":
                pax_unlicensed += 1
            else:
                pax_unknown += 1
            out_row["Has license"] = normalized_has_license
            out_row["License Status"] = compute_license_status(normalized_has_license)

            # UserKey (INT surrogate; assigned in Entra-file order). History mode
            # keys the surrogate on identity plus the exact temporal attributes.
            if person_id_norm:
                allocation_key = (
                    temporal_state_key(person_id_norm, out_row["Has license"], out_row["License Status"])
                    if user_history else person_id_norm
                )
                user_key = mint_user_key(user_key_map, allocation_key)
                out_row["UserKey"] = str(user_key)
            else:
                out_row["UserKey"] = ""
            if user_history:
                out_row["EffectiveDate"] = history_effective_date

            # TotalEmployees (matches M-code: row count repeated per row)
            out_row["TotalEmployees"] = str(total_rows)

            # Org/manager hierarchy columns (always emitted; blank if no UserKey).
            uk_str = out_row.get("UserKey", "")
            if uk_str:
                hrec = hier_by_uk.get(int(uk_str))
                if hrec:
                    for hc in _HIER_COLUMNS:
                        out_row[hc] = hrec.get(hc, "")

            # AIO exact-case aliases. Copied AFTER the de-identification transforms above so a
            # deidentified run carries the transformed value and never the original. An alias
            # already supplied by the directory export is preserved rather than overwritten
            # with a blank source value.
            if profile == "aio":
                if not out_row.get(_AIO_EMAIL_CANONICAL, ""):
                    out_row[_AIO_EMAIL_CANONICAL] = out_row.get(_AIO_EMAIL_SOURCE, "")

            prior_identity_states = (
                list((history_states or {}).get(person_id_norm, []))
                if user_history and person_id_norm
                else []
            )
            # A user present in the directory this run already has a dated state, so no
            # parallel unknown-state row is written for them. Doing so doubled the Users
            # table on the first append for every user in the tenant.
            if reference_writer is not None:
                reference_row = dict(out_row)
                for field in (
                    "PersonId", "displayName", "DisplayName", "Email", "mail", "givenName", "surname",
                    "UserName", "employeeId", "onPremisesImmutableId", "proxyAddresses_Primary",
                    "proxyAddresses_All", "id", "manager_id", "manager_userPrincipalName",
                    "manager_displayName", "manager_mail", "ManagerID",
                ):
                    if field in reference_row:
                        reference_row[field] = original_identity.get(field, "")
                if profile == "aio" and not reference_row.get("Email", ""):
                    reference_row["Email"] = original_identity.get("mail", "")
                reference_row["PersonId_Normalized"] = original_identity.get("PersonId", "").strip().lower()
                for level in range(_HIER_LEVELS):
                    level_key = out_row.get(f"Level{level}_UserKey", "")
                    if level_key:
                        reference_row[f"Level{level}_Name"] = original_name_by_uk.get(int(level_key), "")
                reference_writer.writerow(reference_row)
            writer.writerow(out_row)

            # Build fact-lookup dict (dedupe on normalized key, last-wins matches
            # M-code Table.Distinct behavior on the licensed-users path).
            if person_id_norm:
                if user_history:
                    identity_states = list(prior_identity_states)
                    state_by_date_and_values = {
                        (item["EffectiveDate"], item["Has license"], item["License Status"]): item
                        for item in identity_states
                    }
                    # An unknown state already recorded for this person is carried forward
                    # so activity written against it still resolves; a new one is never minted.
                    current_state = {
                        "EffectiveDate": history_effective_date,
                        "Has license": normalized_has_license,
                        "License Status": out_row["License Status"],
                        "UserKey": out_row["UserKey"],
                    }
                    state_by_date_and_values[(history_effective_date, normalized_has_license, out_row["License Status"])] = current_state
                    user_lookup[person_id_norm] = sorted(
                        state_by_date_and_values.values(),
                        key=lambda item: temporal_effective_sort_key(item["EffectiveDate"]),
                    )
                else:
                    user_lookup[person_id_norm] = {
                        "Has license": normalized_has_license,
                        "License Status": out_row["License Status"],
                    }
                seen_normalized_keys.add(person_id_norm)

    if not quiet:
        print(f"  Entra rows:            {total_rows:,}")
        print(f"  Unique users (norm):   {len(seen_normalized_keys):,}")
        if license_map is not None:
            print(f"  Licensing file:        {licensing_csv}")
            print(f"  Licensing rows:        {licensing_rows:,}")
            print(f"  Matched to users:      {matched_in_licensing:,}")
            print(f"  Licensed:              {pax_licensed:,}")
            print(f"  Unlicensed:            {pax_unlicensed:,}")
            print(f"  Unknown:               {pax_unknown:,}")
        elif has_license_col:
            print(f"  License col detected:  '{has_license_col}'")
            print(f"  Licensed (PAX):        {pax_licensed:,}")
            print(f"  Unlicensed (PAX):      {pax_unlicensed:,}")
            print(f"  Unknown (PAX):         {pax_unknown:,}")
        else:
            print(f"  License col detected:  NO RECOGNIZED LICENSE COLUMN FOUND IN ENTRA CSV")
            print(f"     Fallback: every user will be tagged 'Unknown' until license evidence is present.")

    rows.close()
    return user_lookup


# ---------------------------------------------------------------------------
# Fact row explosion + output
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Pre-aggregated tables (AIBV only) — offload the DAX calculated tables.
#
# Each of these replaces a DAX calc table that SUMMARIZEs the ENTIRE fact on
# every refresh. We compute them ONCE here from the same rollup that produces
# the fact CSV, so they equal exactly what the existing DAX would compute when
# evaluated over the rolled-up fact (internally consistent — a reviewer can
# keep the DAX calc tables over the rollup fact and get the same numbers).
#
# Grain-key index map (AIBV profile): see GRAIN_KEYS_AIBV.
#   [1]=InteractionDate  [3]=AgentName  [6]=License Status
# The remaining inputs come from the nongrain dict
#   (MonthStart, WeekStart, Audit_UserId, Behavior_Enriched_Full, Usage_Mode).
# ---------------------------------------------------------------------------

_VALUEFOCUS_MODES = frozenset({"4 - Producing", "5 - Delegating"})


def _percentile_inc(sorted_vals: list[float], p: float) -> float:
    """PERCENTILE.INC / PERCENTILEX.INC — linear interpolation, p in [0, 1]."""
    n = len(sorted_vals)
    if n == 0:
        return 0.0
    if n == 1:
        return sorted_vals[0]
    rank = p * (n - 1)
    lo = int(rank)  # floor (rank is non-negative)
    if lo + 1 >= n:
        return sorted_vals[lo]
    frac = rank - lo
    return sorted_vals[lo] + (sorted_vals[lo + 1] - sorted_vals[lo]) * frac


def _usage_rank(avg_ppw: float, p90: float, p75: float, p50: float, p25: float) -> str:
    if avg_ppw == 0:
        return "0. No Usage"
    if avg_ppw >= p90:
        return "5. Top 10% Users"
    if avg_ppw >= p75:
        return "4. 75-90% Users"
    if avg_ppw >= p50:
        return "3. 50-75% Users"
    if avg_ppw >= p25:
        return "2. 25-50% Users"
    return "1. Bottom 25% Users"


def _user_stage(active_days: int, behavior_count: int, value_focus_share: float, has_agent: bool) -> str:
    if active_days >= 15 or (active_days >= 10 and value_focus_share >= 0.30 and has_agent):
        return "4 - Power"
    if active_days >= 8 and behavior_count >= 5:
        return "3 - Habitual"
    if active_days >= 3 and behavior_count >= 3:
        return "2 - Developing"
    return "1 - Beginner"


def _activity_segment(avg_days: float) -> str:
    if avg_days == 0:
        return "0. No Activity"
    if avg_days <= 5:
        return "1. 1-5 Chat Days/Month - 'Infrequent'"
    if avg_days <= 10:
        return "2. 6-10 Chat Days/Month - 'Moderate'"
    if avg_days <= 19:
        return "3. 11-19 Chat Days/Month - 'Frequent'"
    return "4. 20+ Chat Days/Month - 'Daily'"


def _fmt_float(x: float) -> str:
    """Shortest round-trippable float, integers without trailing '.0'."""
    if x == int(x):
        return str(int(x))
    return repr(x)


# Bounded Copilot rollup storage. Input staging and surrogate allocation stay separate.
HEARTBEAT_ROW_STRIDE = 1000
HEARTBEAT_MIN_SECONDS = 60.0
ROLLUP_RUN_ROWS = 1_000_000
ROLLUP_RUN_BYTES = 256 * 1024 * 1024
ROLLUP_FRAME_ROWS = 10_000
ROLLUP_FRAME_BYTES = 256 * 1024
ROLLUP_SIZE_STRIDE = 1024
ROLLUP_MERGE_FANIN = 128
ROLLUP_CANONICAL_LIMIT = 4096
_ROLLUP_CANONICAL_FIELDS = frozenset({
    "CreationDate", "InteractionDate", "WeekStart", "MonthStart", "ActivityDate",
    "AppHost", "Environment", "License Status", "Context_Type", "Behavior_Category",
    "Behavior_Enriched", "AI_Model", "Is_Sensitive", "Autonomy_Pattern",
    "Is_Agent_Activity", "Web_Grounded_Signal", "Workflow_Action", "Has license",
    "AccessedResource_Type", "AccessedResource_Action", "Message_isPrompt",
    "Behavior_Source", "Value_Outcome", "Agent Filter", "Agent Publish Status",
    "Behavior_Enriched_Full", "Usage_Mode", "Expertise_Role", "Efficiency_Breakdown",
    "Human_Baseline_Min", "Behavior_Plausible",
})


class Heartbeat(object):
    """Numeric-only, monotonic, quiet-aware main-processor progress."""
    def __init__(self, quiet=False):
        self.quiet = quiet
        self.started = time.monotonic()
        self.last = self.started

    def emit(self, rows_read, rollup, message_ids, thread_ids, phase="flatten"):
        if self.quiet:
            return
        now = time.monotonic()
        if now - self.last < HEARTBEAT_MIN_SECONDS:
            return
        self.last = now
        print(
            "[PAX-HEARTBEAT] CopilotInteractionProcessor "
            f"phase={phase} rows_read={rows_read} "
            f"rollup_buffered={rollup.buffered} rollup_staged={rollup.staged} "
            f"rollup_winners={len(rollup)} winners_exact={int(rollup.ready)} "
            f"message_ids={message_ids} thread_ids={thread_ids} "
            f"elapsed={now - self.started:.3f}"
        )
        sys.stdout.flush()


def _rollup_temp_root():
    # Embedded host requires its owned root; standalone keeps its established policy.
    require_root = globals().get("_pax_required_temp_root")
    return require_root() if require_root is not None else None


def _rollup_record_bytes(value):
    size = sys.getsizeof(value)
    if isinstance(value, (tuple, list)):
        size += sum(_rollup_record_bytes(v) for v in value)
    return size


def _probe_available_physical_memory():
    """Read available (not total) physical memory; never guess on probe failure."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        class MemoryStatus(ctypes.Structure):
            _fields_ = [("length", wintypes.DWORD), ("load", wintypes.DWORD)] + [
                (name, ctypes.c_ulonglong) for name in (
                    "total", "available", "totalPageFile", "availablePageFile",
                    "totalVirtual", "availableVirtual", "availableExtendedVirtual")]
        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(MemoryStatus)]
        kernel.GlobalMemoryStatusEx.restype = wintypes.BOOL
        if not kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
            raise ctypes.WinError(ctypes.get_last_error())
        available = int(status.available)
    elif sys.platform.startswith("linux"):
        with open("/proc/meminfo", encoding="ascii") as stream:
            entries = dict(line.split(":", 1) for line in stream)
        fields = entries["MemAvailable"].split()
        if len(fields) != 2 or fields[1] != "kB":
            raise RuntimeError("Unrecognized available physical memory units")
        available = int(fields[0]) * 1024
    elif sys.platform == "darwin":
        import subprocess
        result = subprocess.run(["/usr/bin/vm_stat"], check=True, capture_output=True, text=True)
        lines = result.stdout.splitlines()
        page_size = re.search(r"page size of ([0-9]+) bytes", lines[0])
        if page_size is None:
            raise RuntimeError("Unrecognized available physical memory page size")
        pages = dict(line.split(":", 1) for line in lines[1:] if ":" in line)
        available = int(page_size[1]) * sum(int(pages[name].strip().rstrip("."))
                                          for name in ("Pages free", "Pages inactive", "Pages speculative"))
    else:
        raise RuntimeError("Available physical memory probe unsupported on this platform")
    if available <= 0:
        raise RuntimeError("Available physical memory probe returned no available memory")
    return available


def _startup_rollup_memory():
    # Shared by both engines if imported in one interpreter; before any input/seed load.
    available = getattr(sys, "_pax_rollup_startup_available_bytes", None)
    if available is None:
        available = _probe_available_physical_memory()
        sys._pax_rollup_startup_available_bytes = available
    return available


_ROLLUP_STARTUP_AVAILABLE_BYTES = _startup_rollup_memory()
# Fresh 25k/100k native peak/input-byte maxima across both engines, three runs each.
# These ratios ALREADY include the single twofold safety factor.
ROLLUP_PROFILE_PEAK_PER_BYTE = {"aio": 16.648754230307475, "aibv": 18.509418165488725}


def _effective_rollup_budget():
    setting = os.environ.get("PAX_ROLLUP_MEMORY_BUDGET_MB")
    if setting is None:
        return _ROLLUP_STARTUP_AVAILABLE_BYTES // 2
    if not setting.isascii() or not setting.isdecimal() or int(setting) < 1:
        raise ValueError("PAX_ROLLUP_MEMORY_BUDGET_MB must be a positive integer")
    return int(setting) * 1024 * 1024


def _select_rollup_path(input_path, profile, quiet):
    import math
    mode = os.environ.get("PAX_ROLLUP_MODE", "auto")
    if mode not in ("auto", "fast", "bounded"):
        raise ValueError("PAX_ROLLUP_MODE must be auto, fast, or bounded")
    budget = _effective_rollup_budget()
    input_bytes = os.path.getsize(input_path)
    predicted = math.ceil(input_bytes * ROLLUP_PROFILE_PEAK_PER_BYTE[profile])
    selected = ("fast" if predicted <= budget else "bounded") if mode == "auto" else mode
    reason = ("auto-within-budget" if selected == "fast" else "auto-over-budget") if mode == "auto" else "forced"
    print(f"[PAX-ROLLUP-PATH] path={selected} input_bytes={input_bytes} "
          f"predicted_bytes={predicted} budget_bytes={budget} reason={reason}",
          file=sys.stderr if quiet else sys.stdout, flush=True)
    return selected


def _rollup_budget():
    limit = _effective_rollup_budget()
    # Shared even when the two engines are imported into the same interpreter.
    budget = getattr(sys, "_pax_copilot_retained_budget", None)
    if budget is None:
        budget = {"limit": limit, "bytes": 0, "owners": {}, "configured_limit": limit}
        sys._pax_copilot_retained_budget = budget
    elif not budget["owners"]:
        budget["limit"] = budget["configured_limit"] = limit
    elif budget["configured_limit"] != limit:
        raise RuntimeError("Rollup budget changed while retained buffers are active")
    return budget


def _charge_rollup_buffer(owner, value, enforce=True):
    budget = owner.budget
    budget["bytes"] += value - owner.batch_bytes
    owner.batch_bytes = value
    if enforce:
        while budget["bytes"] > budget["limit"]:
            # Registration order is the deterministic tie breaker, including
            # decoded read blocks and pending serialization blocks.
            max(budget["owners"].values(), key=lambda s: s.batch_bytes)._flush()


class _ReadBlock:
    """Evictable decoded frame; reload from its existing run, never a copy spool."""
    def __init__(self, stream, mark, size, count, digest):
        self.stream, self.mark = stream, mark
        self.size, self.count, self.digest = size, count, digest
        self.rows = None
        self.batch_bytes = 0
        self.budget = _rollup_budget()
        self.budget["owners"][id(self)] = self

    def _flush(self):
        self.rows = None
        _charge_rollup_buffer(self, 0, enforce=False)

    def close(self):
        self._flush()
        self.budget["owners"].pop(id(self), None)

    def get(self, index):
        if self.rows is None:
            self.stream.restore(self.mark)
            # Serialized workspace is charged too. Enforcement occurs after
            # decoding so eviction cannot invalidate an in-progress pickle.
            _charge_rollup_buffer(self, self.size, enforce=False)
            payload = self.stream.read(self.size)
            if len(payload) != self.size or hashlib.sha256(payload).digest() != self.digest:
                raise OSError("Private rollup frame integrity failure")
            rows = pickle.loads(payload)
            del payload
            if not isinstance(rows, list) or len(rows) != self.count:
                raise OSError("Private rollup frame count mismatch")
            self.rows = rows
            row = rows[index]
            samples = (rows[0], rows[len(rows) // 2], rows[-1])
            estimate = max(_rollup_record_bytes(v) for v in samples)
            charge = len(rows) * estimate + sys.getsizeof(rows)
            del rows, samples
            _charge_rollup_buffer(self, charge)
            return row
        return self.rows[index]


class _RunWriter:
    """Framed logical run, split into bounded physical continuation segments."""
    def __init__(self, path):
        self.name = path
        self.segment = -1
        self.stream = None
        self.segment_bytes = self.segment_rows = 0
        self.records = []
        self.payload_bytes = 0
        self.estimate = 0
        self.batch_bytes = 0
        self.budget = _rollup_budget()
        self.budget["owners"][id(self)] = self

    def __enter__(self):
        return self

    def _next(self, rows=0):
        if self.stream is not None:
            self.stream.close()
        self.segment += 1
        self.stream = open(f"{self.name}.{self.segment}", "wb")
        self.segment_bytes = 0
        self.segment_rows = rows

    def _write(self, data, rows):
        view = memoryview(data)
        while view:
            if self.stream is None or self.segment_bytes == ROLLUP_RUN_BYTES:
                self._next(rows)
            n = min(len(view), ROLLUP_RUN_BYTES - self.segment_bytes)
            self.stream.write(view[:n])
            self.segment_bytes += n
            view = view[n:]

    def add(self, value):
        if not self.records or len(self.records) % ROLLUP_SIZE_STRIDE == 0:
            self.estimate = max(self.estimate, _rollup_record_bytes(value))
        target = min(ROLLUP_FRAME_BYTES, max(1, self.budget["limit"] // (ROLLUP_MERGE_FANIN * 4)))
        if self.records and (len(self.records) + 1) * self.estimate > target:
            self.flush()
        self.records.append(value)
        # The caller may itself be spilling. Account workspace immediately but
        # enforce only at a completed block boundary, avoiding recursive spill.
        _charge_rollup_buffer(self, len(self.records) * self.estimate + sys.getsizeof(self.records), enforce=False)
        if len(self.records) >= min(ROLLUP_FRAME_ROWS, ROLLUP_RUN_ROWS) or self.batch_bytes >= target:
            self.flush()

    def _flush(self):
        self.flush()

    def flush(self):
        if not self.records:
            return
        count = len(self.records)
        # Exactly ONE pickle invocation per bounded list block, not per row.
        payload = pickle.dumps(self.records, protocol=4)
        _charge_rollup_buffer(self, self.batch_bytes + len(payload), enforce=False)
        digest = hashlib.sha256(payload)
        if self.stream is None or self.segment_rows + count > ROLLUP_RUN_ROWS:
            self._next()
        self.segment_rows += count
        header = b"PXR1" + count.to_bytes(4, "big") + len(payload).to_bytes(8, "big") + digest.digest()
        self._write(header, count)
        self._write(payload, count)
        self.records.clear()
        self.payload_bytes = 0
        _charge_rollup_buffer(self, 0, enforce=False)

    def __exit__(self, kind, *exc):
        try:
            if kind is None:
                self.flush()
                self._write(b"PXR1" + bytes(12) + hashlib.sha256(b"").digest(), 0)
        finally:
            self.records.clear()
            _charge_rollup_buffer(self, 0, enforce=False)
            self.budget["owners"].pop(id(self), None)
            if self.stream is not None:
                self.stream.close()


class _RunReader:
    def __init__(self, path):
        self.path, self.segment = path, 0
        self.stream = open(f"{path}.0", "rb")

    def close(self):
        self.stream.close()

    def mark(self):
        return self.segment, self.stream.tell()

    def restore(self, mark):
        self.stream.close()
        self.segment, offset = mark
        self.stream = open(f"{self.path}.{self.segment}", "rb")
        self.stream.seek(offset)

    def read(self, size):
        value = self.stream.read(size)
        if len(value) == size:
            return value
        parts = [value]
        remaining = size - len(value)
        while remaining and os.path.exists(f"{self.path}.{self.segment + 1}"):
            self.stream.close()
            self.segment += 1
            self.stream = open(f"{self.path}.{self.segment}", "rb")
            value = self.stream.read(remaining)
            parts.append(value)
            remaining -= len(value)
        return b"".join(parts)


def _write_rollup_record(stream, value):
    stream.add(value)


def _read_rollup_records(path):
    # Only files created in this invocation's owned directory are ever unpickled.
    # Decoded blocks share the retained budget and can be evicted/reloaded while
    # their iterator is suspended. Ordinary frame targets divide the budget by
    # fan-in; indivisible oversized rows remain supported, not truncated.
    with contextlib.closing(_RunReader(path)) as stream:
        while True:
            header = stream.read(48)
            if len(header) != 48 or header[:4] != b"PXR1":
                raise OSError("Incomplete private rollup frame header")
            count = int.from_bytes(header[4:8], "big")
            size = int.from_bytes(header[8:16], "big")
            if count > ROLLUP_FRAME_ROWS or (count == 0 and size != 0):
                raise OSError("Invalid private rollup frame count")
            mark = stream.mark()
            if not count:
                if header[16:] != hashlib.sha256(b"").digest():
                    raise OSError("Private rollup frame integrity failure")
                if stream.read(1):
                    raise OSError("Trailing private rollup bytes")
                return
            with contextlib.closing(_ReadBlock(stream, mark, size, count, header[16:])) as block:
                for index in range(count):
                    yield block.get(index)


class _ExternalSorter:
    """Shared-budget retained rows, lazy segmented spill and repeatable replay."""
    def __init__(self, key, root=None, progress=None):
        self.key = key
        self.progress = progress
        self.parent = root
        self.owner = None
        self.root = None
        self.batch = []
        self.batch_bytes = 0
        self.run_count = 0
        self.count = 0
        self.path = None
        self.finished = False
        self.estimate = 0
        self.samples = 0
        self.budget = _rollup_budget()
        self.budget["owners"][id(self)] = self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        self.batch.clear()
        self._charge(0, enforce=False)
        self.budget["owners"].pop(id(self), None)
        if self.owner is not None:
            self.owner.cleanup()

    def _charge(self, value, enforce=True):
        _charge_rollup_buffer(self, value, enforce)

    def _path(self, level, number):
        if self.owner is None:
            self.owner = tempfile.TemporaryDirectory(prefix="pax_copilot_sort_", dir=self.parent)
            self.root = self.owner.name
        return os.path.join(self.root, f"{level}_{number}.bin")

    def _progress(self):
        if self.progress is not None:
            self.progress()

    def add(self, row):
        if self.finished:
            raise RuntimeError("Cannot append to a finished rollup sort")
        # Conservative high-water sample; reprice ALL retained rows on change.
        # Estimates intentionally overcount shared strings; they are not RSS.
        if self.count % ROLLUP_SIZE_STRIDE == 0:
            self.estimate = max(self.estimate, _rollup_record_bytes(row))
            self.samples += 1
        self.batch.append(row)
        self.count += 1
        self._charge(len(self.batch) * self.estimate + sys.getsizeof(self.batch))

    def _flush(self):
        if not self.batch:
            return
        if self.key is not None:
            self.batch.sort(key=self.key)
        path = self._path(0, self.run_count)
        with _RunWriter(path) as stream:
            for row in self.batch:
                _write_rollup_record(stream, row)
        self.run_count += 1
        self.batch.clear()
        self._charge(0, enforce=False)
        if self.finished:
            self.path = path
        self._progress()

    def finish(self):
        if self.finished:
            return
        if ROLLUP_MERGE_FANIN < 2:
            raise ValueError("Rollup merge fan-in must be at least two")
        if not self.run_count:
            if self.key is not None:
                self.batch.sort(key=self.key)
            self.finished = True
            return
        self._flush()
        level, count = 0, self.run_count
        while count > 1:
            output_count = 0
            for first in range(0, count, ROLLUP_MERGE_FANIN):
                # Never enumerate all run paths. This list is at most fan-in long.
                paths = [self._path(level, n) for n in
                         range(first, min(count, first + ROLLUP_MERGE_FANIN))]
                with contextlib.ExitStack() as stack:
                    readers = [stack.enter_context(contextlib.closing(_read_rollup_records(p)))
                               for p in paths]
                    with _RunWriter(self._path(level + 1, output_count)) as stream:
                        merged = heapq.merge(*readers, key=self.key) if self.key is not None else itertools.chain.from_iterable(readers)
                        for i, row in enumerate(merged, 1):
                            _write_rollup_record(stream, row)
                            if i % HEARTBEAT_ROW_STRIDE == 0:
                                self._progress()
                for path in paths:
                    segment = 0
                    while os.path.exists(f"{path}.{segment}"):
                        os.remove(f"{path}.{segment}")
                        segment += 1
                output_count += 1
                self._progress()
            level, count = level + 1, output_count
        self.path = self._path(level, 0) if count else None
        self.finished = True

    def rows(self):
        self.finish()
        emitted = 0
        while self.path is None and emitted < len(self.batch):
            row = self.batch[emitted]
            emitted += 1
            yield row
        # Eviction can happen while a consumer is suspended at yield. Do not
        # capture a list iterator or a copy that would retain the old buffer.
        if self.path is not None:
            with contextlib.closing(_read_rollup_records(self.path)) as rows:
                yield from itertools.islice(rows, emitted, None)


class _CompactAttrs:
    __slots__ = ("values", "index")

    def __init__(self, values, index):
        self.values, self.index = values, index

    def __getitem__(self, name):
        return self.values[self.index[name]]


class _RollupStore:
    """LAST attrs at FIRST insertion position, replayable without a winner dict."""
    def __init__(self, profile):
        self.root = _rollup_temp_root()
        self.grain_names, self.attr_names, _ = schema_for(profile)
        self.index = {name: i for i, name in enumerate(self.attr_names)}
        self.canonical = {}
        self.sequence = 0
        self.winner_count = 0
        self.ready = False
        self.progress = None
        self.sorter = None
        self.winners = None
        self.sorter = _ExternalSorter(lambda r: r[:4], self.root, self._progress)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        try:
            if self.sorter is not None:
                self.sorter.close()
        finally:
            self.canonical.clear()
            if self.winners is not None:
                self.winners.close()

    def __len__(self):
        return self.winner_count

    @property
    def buffered(self):
        return len(self.sorter.batch)

    @property
    def staged(self):
        return self.sequence - self.buffered

    def _progress(self):
        if self.progress is not None:
            self.progress()

    def _canonical(self, name, value):
        if name not in _ROLLUP_CANONICAL_FIELDS or not isinstance(value, str) or len(value) > 256:
            return value
        key = (name, value)
        found = self.canonical.get(key)
        if found is not None:
            return found
        if len(self.canonical) >= ROLLUP_CANONICAL_LIMIT:
            self.canonical.clear()
        if name in ("CreationDate", "InteractionDate", "WeekStart", "MonthStart", "ActivityDate") or value in (
                "", "TRUE", "FALSE", "True", "False", "M365 Copilot Licensed", "Unlicensed", "Unknown"):
            value = sys.intern(value)
        self.canonical[key] = value
        return value

    def add(self, grain, mid, attrs):
        grain = tuple(self._canonical(n, v) for n, v in zip(self.grain_names, grain))
        values = tuple(self._canonical(n, attrs[n]) for n in self.attr_names)
        row = (grain, mid, attrs["_ResourceSlice"], self.sequence, values)
        self.sequence += 1
        self.sorter.add(row)

    def prepare(self):
        if self.ready:
            return
        ordered = self.winners = _ExternalSorter(lambda r: r[0], self.root, self._progress)
        try:
            with contextlib.closing(self.sorter.rows()) as source:
                for _, group in itertools.groupby(source, key=lambda r: r[:3]):
                    winner = next(group)
                    first_sequence = winner[3]
                    for row in group:
                        winner = row
                    ordered.add((first_sequence, winner[:3], winner[4]))
                    self.winner_count += 1
            ordered.finish()
        except BaseException:
            ordered.close()
            raise
        self.sorter.close()
        self.canonical.clear()
        self.ready = True

    def items(self):
        self.prepare()
        for _, key, values in self.winners.rows():
            yield key, _CompactAttrs(values, self.index)

    def distinct_count(self, value_for, exclude_blank=False):
        with _ExternalSorter(lambda v: v, self.root, self._progress) as sorter:
            for key, attrs in self.items():
                value = value_for(key, attrs)
                if not exclude_blank or value != "":
                    sorter.add(value)
            sentinel = object()
            previous, count = sentinel, 0
            for value in sorter.rows():
                if previous is sentinel or value != previous:
                    count += 1
                    previous = value
            return count


class _FastRollupStore(dict):
    """Original dictionary winners: LAST value, FIRST insertion position."""
    ready = False
    staged = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.clear()

    @property
    def buffered(self):
        return len(self)

    def add(self, grain, mid, attrs):
        self[(grain, mid, attrs["_ResourceSlice"])] = attrs

    def prepare(self):
        self.ready = True

    def distinct_count(self, value_for, exclude_blank=False):
        values = {value_for(key, attrs) for key, attrs in self.items()}
        if exclude_blank:
            values.discard("")
        return len(values)


def _compute_fast_aggregates(
    rollup: dict[tuple[Any, ...], dict[str, Any]],
    agg_paths: dict[str, str],
    quiet: bool = False,
) -> dict[str, int]:
    """Original dictionary/set aggregate algorithm, without bounded-path machinery."""
    um: dict[tuple[str, str], dict[str, Any]] = {}
    ua: dict[str, dict[str, Any]] = {}
    for grain_key, nongrain in rollup.items():
        gk = grain_key[0]
        mid = grain_key[1]
        interaction_date = gk[1]
        agent_name = gk[3]
        license_status = gk[6]
        uid = nongrain["Audit_UserId"]
        month = nongrain["MonthStart"]
        week = nongrain["WeekStart"]
        bef = nongrain["Behavior_Enriched_Full"]
        usage_mode = nongrain["Usage_Mode"]
        mk = (uid, month)
        a = um.get(mk)
        if a is None:
            a = um[mk] = {
                "idates": set(), "mids": set(), "behaviors": set(),
                "has_agent": False, "rows": 0, "valuefocus": 0, "license": license_status,
            }
        a["idates"].add(interaction_date)
        a["mids"].add(mid)
        a["behaviors"].add(bef)
        if agent_name.strip():
            a["has_agent"] = True
        a["rows"] += 1
        if usage_mode in _VALUEFOCUS_MODES:
            a["valuefocus"] += 1
        if license_status < a["license"]:
            a["license"] = license_status
        u = ua.get(uid)
        if u is None:
            u = ua[uid] = {"rows": 0, "weeks": set(), "license": license_status}
        u["rows"] += 1
        u["weeks"].add(week)
        if license_status < u["license"]:
            u["license"] = license_status
    ads_rows: list[tuple[str, str, int, int, str]] = []
    for (uid, month), a in um.items():
        chat_active_days = len(a["idates"])
        if chat_active_days <= 0:
            continue
        ads_rows.append((uid, month, chat_active_days, len(a["mids"]), a["license"]))
    ads_rows.sort(key=lambda r: (r[0], r[1]))
    umm_rows: list[tuple] = []
    for (uid, month), a in um.items():
        active_days = len(a["idates"])
        behavior_count = len(a["behaviors"])
        value_focus_share = (a["valuefocus"] / a["rows"]) if a["rows"] else 0.0
        has_agent = a["has_agent"]
        user_month_key = f"{uid}|{month[:7]}" if (uid and month) else ""
        stage = _user_stage(active_days, behavior_count, value_focus_share, has_agent)
        umm_rows.append((
            uid, month, behavior_count, "True" if has_agent else "False",
            active_days, user_month_key, stage, value_focus_share,
        ))
    umm_rows.sort(key=lambda r: (r[0], r[1]))
    def _build_rankings(target_license: str) -> list[tuple]:
        summary = []
        for uid, u in ua.items():
            if u["license"] != target_license:
                continue
            total_prompts = u["rows"]
            total_weeks = len(u["weeks"])
            avg_ppw = (total_prompts / total_weeks) if total_weeks else 0.0
            summary.append((uid, total_prompts, total_weeks, avg_ppw))
        avgs = sorted(s[3] for s in summary)
        p90 = _percentile_inc(avgs, 0.90)
        p75 = _percentile_inc(avgs, 0.75)
        p50 = _percentile_inc(avgs, 0.50)
        p25 = _percentile_inc(avgs, 0.25)
        out = []
        for uid, tp, tw, avg in summary:
            out.append((uid, _usage_rank(avg, p90, p75, p50, p25), tp, tw, avg))
        out.sort(key=lambda r: r[0])
        return out
    licensed_rank_rows = _build_rankings("M365 Copilot Licensed")
    unlicensed_rank_rows = _build_rankings("Unlicensed")
    lsum: dict[str, dict[str, int]] = {}
    for uid, month, chat_active_days, prompt_count, lic in ads_rows:
        if lic != "M365 Copilot Licensed":
            continue
        s = lsum.get(uid)
        if s is None:
            s = lsum[uid] = {"days": 0, "months": 0, "prompts": 0}
        s["days"] += chat_active_days
        s["months"] += 1
        s["prompts"] += prompt_count
    summary_rows: list[tuple] = []
    for uid, s in lsum.items():
        total_days = s["days"]
        total_months = s["months"]
        total_prompts = s["prompts"]
        avg_days = (total_days / total_months) if total_months else 0.0
        summary_rows.append((
            uid, _activity_segment(avg_days), total_days, total_months,
            total_prompts, avg_days,
        ))
    summary_rows.sort(key=lambda r: r[0])
    def _write(path: str, header: list[str], rows: list[tuple], float_cols: set[int]) -> int:
        with open(path, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(header)
            for r in rows:
                w.writerow([_fmt_float(v) if i in float_cols else v for i, v in enumerate(r)])
        return len(rows)
    counts = {}
    counts["active_days"] = _write(
        agg_paths["active_days"],
        ["Audit_UserId", "MonthStart", "ChatActiveDays", "PromptCount", "LicenseStatus"],
        ads_rows, set(),
    )
    counts["user_month_metrics"] = _write(
        agg_paths["user_month_metrics"],
        ["Audit_UserId", "MonthStart", "BehaviorCount", "HasAgent", "ActiveDays",
         "UserMonthKey", "UserStage", "ValueFocusShare"],
        umm_rows, {7},
    )
    counts["licensed_rankings"] = _write(
        agg_paths["licensed_rankings"],
        ["Audit_UserId", "Usage Rank", "TotalPrompts", "TotalWeeks", "AvgPromptsPerWeek"],
        licensed_rank_rows, {4},
    )
    counts["unlicensed_rankings"] = _write(
        agg_paths["unlicensed_rankings"],
        ["Audit_UserId", "Usage Rank", "TotalPrompts", "TotalWeeks", "AvgPromptsPerWeek"],
        unlicensed_rank_rows, {4},
    )
    counts["licensed_summary"] = _write(
        agg_paths["licensed_summary"],
        ["Audit_UserId", "Activity Segment", "TotalActiveDays", "TotalMonths",
         "TotalPrompts", "AvgActiveDaysPerMonth"],
        summary_rows, {5},
    )
    if not quiet:
        print("  Pre-aggregated tables (ValueLens):")
        print(f"    ActiveDaysSummary:        {counts['active_days']:,} rows")
        print(f"    UserMonthMetrics:         {counts['user_month_metrics']:,} rows")
        print(f"    Licensed User Rankings:   {counts['licensed_rankings']:,} rows")
        print(f"    Unlicensed User Rankings: {counts['unlicensed_rankings']:,} rows")
        print(f"    Licensed User Summary:    {counts['licensed_summary']:,} rows")
    return counts


def compute_and_write_aggregates(
    rollup,
    agg_paths: dict[str, str],
    quiet: bool = False,
) -> dict[str, int]:
    """Stream all five AIBV outputs; group state and percentile samples are bounded."""
    if isinstance(rollup, _FastRollupStore):
        return _compute_fast_aggregates(rollup, agg_paths, quiet=quiet)
    progress = getattr(rollup, "_progress", None)
    parent = getattr(rollup, "root", None)
    if parent is None:
        parent = _rollup_temp_root()
    with contextlib.ExitStack() as replay:
        root = parent
        months = replay.enter_context(_ExternalSorter(None, root, progress))
        users = replay.enter_context(_ExternalSorter(None, root, progress))
        # Sort tags separately within each (uid, month): row facts, dates, mids, behaviors.
        # No whole-group set is needed, even for an unusually large user/month.
        with _ExternalSorter(lambda r: r, root, progress) as sorter:
            for (grain, mid, _slice), attrs in rollup.items():
                uid, month = attrs["Audit_UserId"], attrs["MonthStart"]
                sorter.add((uid, month, 0, (grain[6], bool(grain[3].strip()),
                                          attrs["Usage_Mode"] in _VALUEFOCUS_MODES)))
                sorter.add((uid, month, 1, grain[1]))
                sorter.add((uid, month, 2, mid))
                sorter.add((uid, month, 3, attrs["Behavior_Enriched_Full"]))
            with contextlib.closing(sorter.rows()) as sorted_rows:
                for (uid, month), group in itertools.groupby(sorted_rows, lambda r: r[:2]):
                    rows = valuefocus = 0
                    counts = [0, 0, 0]
                    license_status = None
                    has_agent = False
                    previous = None
                    for _, _, tag, value in group:
                        if tag == 0:
                            license, agent, focused = value
                            rows += 1
                            valuefocus += int(focused)
                            has_agent = has_agent or agent
                            if license_status is None or license < license_status:
                                license_status = license
                        else:
                            identity = (tag, value)
                            if identity != previous:
                                counts[tag - 1] += 1
                            previous = identity
                    months.add((uid, month, *counts, has_agent, rows, valuefocus, license_status))
        # Rankings count fact rows (not distinct messages) and distinct weeks per user.
        with _ExternalSorter(lambda r: r, root, progress) as sorter:
            for (grain, _mid, _slice), attrs in rollup.items():
                sorter.add((attrs["Audit_UserId"], attrs["WeekStart"], grain[6]))
            with contextlib.closing(sorter.rows()) as sorted_rows:
                for uid, group in itertools.groupby(sorted_rows, lambda r: r[0]):
                    total_prompts = total_weeks = 0
                    previous = None
                    license_status = None
                    for _, week, license in group:
                        total_prompts += 1
                        if week != previous:
                            total_weeks += 1
                            previous = week
                        if license_status is None or license < license_status:
                            license_status = license
                    average = (total_prompts / total_weeks) if total_weeks else 0.0
                    users.add((uid, license_status, total_prompts, total_weeks, average))

        def month_rows(kind):
            for uid, month, days, mids, behaviors, agent, rows, vf, license in months.rows():
                if kind == "active_days":
                    if days > 0:
                        yield uid, month, days, mids, license
                else:
                    share = (vf / rows) if rows else 0.0
                    key = f"{uid}|{month[:7]}" if (uid and month) else ""
                    yield (uid, month, behaviors, "True" if agent else "False", days,
                           key, _user_stage(days, behaviors, share, agent), share)

        def percentile_thresholds(target):
            with _ExternalSorter(lambda v: v, root, progress) as sorter:
                for _, license, _, _, avg in users.rows():
                    if license == target:
                        sorter.add(avg)
                n = sorter.count
                if not n:
                    return (0.0, 0.0, 0.0, 0.0)
                ranks = [p * (n - 1) for p in (0.90, 0.75, 0.50, 0.25)]
                indices = {i for rank in ranks for i in (int(rank), min(int(rank) + 1, n - 1))}
                samples = {}
                for i, value in enumerate(sorter.rows()):
                    if i in indices:
                        samples[i] = value
                values = []
                for rank in ranks:
                    lo = int(rank)
                    if lo + 1 >= n:
                        values.append(samples[lo])
                    else:
                        frac = rank - lo
                        values.append(samples[lo] + (samples[lo + 1] - samples[lo]) * frac)
                return tuple(values)

        def rankings(target):
            thresholds = percentile_thresholds(target)
            for uid, license, tp, tw, avg in users.rows():
                if license == target:
                    yield uid, _usage_rank(avg, *thresholds), tp, tw, avg

        def licensed_summary():
            for uid, group in itertools.groupby(months.rows(), lambda r: r[0]):
                total_days = total_months = total_prompts = 0
                for _, _, days, mids, _, _, _, _, license in group:
                    if license == "M365 Copilot Licensed" and days > 0:
                        total_days += days
                        total_months += 1
                        total_prompts += mids
                if total_months:
                    average = total_days / total_months
                    yield (uid, _activity_segment(average), total_days, total_months,
                           total_prompts, average)

        def write(path, header, rows, float_cols):
            count = 0
            with contextlib.closing(rows), open(path, "w", encoding="utf-8", newline="") as stream:
                writer = csv.writer(stream, lineterminator="\n")
                writer.writerow(header)
                for row in rows:
                    writer.writerow([_fmt_float(v) if i in float_cols else v
                                     for i, v in enumerate(row)])
                    count += 1
                    if progress is not None and count % HEARTBEAT_ROW_STRIDE == 0:
                        progress()
            return count

        counts = {}
        counts["active_days"] = write(
            agg_paths["active_days"],
            ["Audit_UserId", "MonthStart", "ChatActiveDays", "PromptCount", "LicenseStatus"],
            month_rows("active_days"), (),
        )
        counts["user_month_metrics"] = write(
            agg_paths["user_month_metrics"],
            ["Audit_UserId", "MonthStart", "BehaviorCount", "HasAgent", "ActiveDays",
             "UserMonthKey", "UserStage", "ValueFocusShare"],
            month_rows("user_month_metrics"), (7,),
        )
        counts["licensed_rankings"] = write(
            agg_paths["licensed_rankings"],
            ["Audit_UserId", "Usage Rank", "TotalPrompts", "TotalWeeks", "AvgPromptsPerWeek"],
            rankings("M365 Copilot Licensed"), (4,),
        )
        counts["unlicensed_rankings"] = write(
            agg_paths["unlicensed_rankings"],
            ["Audit_UserId", "Usage Rank", "TotalPrompts", "TotalWeeks", "AvgPromptsPerWeek"],
            rankings("Unlicensed"), (4,),
        )
        counts["licensed_summary"] = write(
            agg_paths["licensed_summary"],
            ["Audit_UserId", "Activity Segment", "TotalActiveDays", "TotalMonths",
             "TotalPrompts", "AvgActiveDaysPerMonth"],
            licensed_summary(), (5,),
        )
    if not quiet:
        print("  Pre-aggregated tables (ValueLens):")
        print(f"    ActiveDaysSummary:        {counts['active_days']:,} rows")
        print(f"    UserMonthMetrics:         {counts['user_month_metrics']:,} rows")
        print(f"    Licensed User Rankings:   {counts['licensed_rankings']:,} rows")
        print(f"    Unlicensed User Rankings: {counts['unlicensed_rankings']:,} rows")
        print(f"    Licensed User Summary:    {counts['licensed_summary']:,} rows")
    return counts


def run_processor(
    purview_csv: str,
    entra_csv: str,
    fact_out_csv: str,
    users_out_csv: str,
    profile: str = "aibv",
    agg_paths: dict[str, str] | None = None,
    quiet: bool = False,
    licensing_csv: str | None = None,
    seed_mid_map_path: str | None = None,
    seed_thread_map_path: str | None = None,
    seed_userkey_map_path: str | None = None,
    user_history: bool = False,
    history_effective_date: str = "",
    history_users_target: str | None = None,
) -> dict[str, Any]:
    start_time = time.perf_counter()
    selected_rollup_path = _select_rollup_path(purview_csv, profile, quiet)
    stats: dict[str, Any] = {
        "input_records": 0,
        "skipped_non_copilot": 0,
        "excluded_security_copilot": 0,
        "output_rows": 0,
        "errors": 0,
        "reject_manifest_path": None,
        "unmatched_users": 0,
    }
    reject_manifest = RejectManifest(
        reject_manifest_path_for(fact_out_csv),
        "CopilotInteraction",
        SCRIPT_VERSION,
    )

    profile_label = "ValueLens" if profile == "aibv" else "AI-in-One"

    if not quiet:
        print(f"Purview CopilotInteraction Processor v{SCRIPT_VERSION}")
        print(f"  Profile:        {profile_label}")
        print(f"  JSON engine:    {_JSON_ENGINE}")
        print(f"  Purview input:  {purview_csv}")
        print(f"  Entra input:    {entra_csv}")
        if licensing_csv:
            print(f"  Licensing:      {licensing_csv}")
        print(f"  Purview output: {fact_out_csv}")
        print(f"  Entra output:   {users_out_csv}")
        print()
        print("Loading Entra users + writing Users dim CSV...")

    # Shared INT-surrogate maps. UserKey is populated first by the Entra
    # loader (so Entra-known users get the lowest INTs / lowest dictionary
    # offsets in VertiPaq); the fact path then reuses + extends the map.
    # mid_to_int is declared here (alongside the other two) so all three can be
    # pre-seeded from the PAX append-target maps before the Entra load + fact loop.
    user_key_map: dict[str, int] = {}
    thread_key_map: dict[str, int] = {}
    mid_to_int: dict[str, int] = {}

    # PAX append support: pre-seed the
    # three INT-surrogate maps from JSON snapshots of the append-target's existing
    # surrogates so retained rows keep stable Message_Id / ThreadKey / UserKey
    # values across runs. No-op when the seed paths are None (the standalone
    # 2/3-file runs and any non-append PAX run).
    def _load_int_seed(path: str, target: dict[str, int]) -> None:
        with open(path, "r", encoding="utf-8") as f:
            data = json_loads(f.read())
        if not isinstance(data, dict):
            return
        while data:
            k, v = data.popitem()
            try:
                target[str(k)] = int(v)
            except (TypeError, ValueError):
                continue

    if seed_userkey_map_path:
        _load_int_seed(seed_userkey_map_path, user_key_map)
    if seed_thread_map_path:
        _load_int_seed(seed_thread_map_path, thread_key_map)
    if seed_mid_map_path:
        _load_int_seed(seed_mid_map_path, mid_to_int)
    history_states = load_user_history(history_users_target, user_key_map) if user_history else {}
    reset_user_key_allocator(user_key_map)

    user_lookup = load_entra_and_write_users(
        entra_csv, users_out_csv, user_key_map, licensing_csv=licensing_csv, quiet=quiet, profile=profile,
        user_history=user_history, history_effective_date=history_effective_date,
        history_states=history_states,
    )

    if not quiet:
        print()
        print("Flattening CopilotInteraction records...")

    # Select once before seed loading; neither path retries or switches midstream.
    unmatched: set[str] = set()
    beat = Heartbeat(quiet=quiet)
    with (_FastRollupStore() if selected_rollup_path == "fast" else _RollupStore(profile)) as rollup:
        rollup.progress = lambda: beat.emit(
            stats["input_records"], rollup, len(mid_to_int), len(thread_key_map), "sort"
        )
        with open(purview_csv, "r", encoding="utf-8-sig", newline="") as fin:
            reader = csv.DictReader(fin)

            for raw_row in reader:
                stats["input_records"] += 1
                if stats["input_records"] % HEARTBEAT_ROW_STRIDE == 0:
                    beat.emit(stats["input_records"], rollup, len(mid_to_int), len(thread_key_map))

                audit_raw = raw_row.get("AuditData", "") or ""
                try:
                    audit_data = json_loads(audit_raw) if audit_raw.strip() else {}
                except Exception:
                    try:
                        audit_data = json_loads_rescue(audit_raw)
                    except Exception:
                        stats["errors"] += 1
                        reject_manifest.record(
                            stats["input_records"], "JSON_PARSE_FAILED", reject_row_digest(raw_row)
                        )
                        continue

                if not isinstance(audit_data, dict):
                    stats["errors"] += 1
                    reject_manifest.record(
                        stats["input_records"], "AUDITDATA_NOT_OBJECT", reject_row_digest(raw_row)
                    )
                    continue

                if not is_copilot_interaction(audit_data, raw_row):
                    stats["skipped_non_copilot"] += 1
                    continue

                if is_security_copilot(audit_data, raw_row):
                    stats["excluded_security_copilot"] += 1
                    continue

                try:
                    rows = explode_record(
                        audit_data, user_lookup, user_key_map, thread_key_map, profile,
                        user_history=user_history,
                    )
                except Exception:
                    stats["errors"] += 1
                    reject_manifest.record(
                        stats["input_records"], "ROW_BUILD_FAILED", reject_row_digest(raw_row)
                    )
                    continue

                for grain_key, message_id_str, nongrain, in_entra, audit_user_norm in rows:
                    stats["output_rows"] += 1
                    if not in_entra and audit_user_norm:
                        unmatched.add(audit_user_norm)
                    mid_int = mid_to_int.get(message_id_str)
                    if mid_int is None:
                        mid_int = len(mid_to_int) + 1
                        mid_to_int[message_id_str] = mid_int
                    rollup.add(grain_key, mid_int, nongrain)

        reject_manifest.close()
        if reject_manifest.count > 0:
            stats["reject_manifest_path"] = reject_manifest.path

        if not quiet:
            print(f"  Input records:         {stats['input_records']:,}")
            print(f"  Skipped (non-Copilot): {stats['skipped_non_copilot']:,}")
            print(f"  Excluded Security Copilot: {stats['excluded_security_copilot']:,}")
            print(f"  Raw prompt rows:       {stats['output_rows']:,}")
            print(f"  Errors:                {stats['errors']:,}")
            if reject_manifest.count > 0:
                print(f"  Reject manifest:       {reject_manifest.path}")
            print()
            print("Writing rolled-up fact CSV...")

        rollup.prepare()

        # Profile-specific output schema (AIO = 39-col; AIBV = 52-col superset).
        grain_keys, nongrain_attrs_sel, fact_header = schema_for(profile)
        with open(fact_out_csv, "w", encoding="utf-8", newline="") as fout:
            writer = csv.writer(fout, lineterminator="\n")
            writer.writerow(fact_header)
            # Pre-compute the index of Message_Id within FACT_HEADER so we can
            # splice the INT surrogate into a list-of-attrs in one shot. The
            # list-based csv.writer.writerow path is materially faster than
            # DictWriter (skips dict-to-list translation + per-row genexpr).
            nongrain_attrs = nongrain_attrs_sel  # local rebind
            grain_len = len(grain_keys)
            for (grain_key, mid_int, _resource_slice), attrs in rollup.items():
                # fact_header = grain_keys + ("Message_Id",) + nongrain_attrs
                row_out = list(grain_key)
                row_out.append(mid_int)
                row_out.extend(attrs[k] for k in nongrain_attrs)
                writer.writerow(row_out)

        stats["output_rows_rollup"] = len(rollup)
        # Allocator-map totals. With --seed-mid-map / --seed-thread-map / --seed-userkey-map
        # these maps open pre-loaded with the append target's existing surrogates, so their
        # length is the cumulative reserved mapping count AFTER seeding, not what this run
        # alone contained. These three keys keep that established meaning; the current-run
        # and reserved counts are published below under their own explicit names.
        stats["distinct_message_ids"] = len(mid_to_int)
        stats["distinct_thread_ids"] = len(thread_key_map)
        stats["distinct_user_keys"] = len(user_key_map)
        # Replay winners through bounded distinct reducers; no whole-run sets.
        _thread_grain_idx = grain_keys.index("ThreadId")
        stats["current_run_distinct_message_ids"] = rollup.distinct_count(lambda k, a: k[1])
        stats["current_run_distinct_thread_ids"] = rollup.distinct_count(
            lambda k, a: k[0][_thread_grain_idx], exclude_blank=True
        )
        stats["reserved_message_id_mappings"] = len(mid_to_int)
        stats["reserved_thread_id_mappings"] = len(thread_key_map)
        stats["unmatched_users"] = len(unmatched)

        # Pre-aggregated tables (AIBV profile only). These offload the DAX
        # calculated tables (ActiveDaysSummary / UserMonthMetrics / rankings /
        # summary), each of which otherwise SUMMARIZEs the whole fact on refresh.
        if profile != "aio" and agg_paths:
            if not quiet:
                print()
                print("Writing pre-aggregated tables...")
            compute_and_write_aggregates(rollup, agg_paths, quiet=quiet)
        elapsed = time.perf_counter() - start_time
        if not quiet:
            reduction_pct = (1 - len(rollup) / stats["output_rows"]) * 100 if stats["output_rows"] else 0
            print(f"  Rollup rows:           {len(rollup):,}  ({reduction_pct:.1f}% reduction)")
            print(f"  Distinct Message_Ids this run:  {stats['current_run_distinct_message_ids']:,}")
            print(f"  Distinct ThreadIds this run:    {stats['current_run_distinct_thread_ids']:,}")
            print(f"  Reserved Message_Id mappings:   {stats['reserved_message_id_mappings']:,}")
            print(f"  Reserved ThreadId mappings:     {stats['reserved_thread_id_mappings']:,}")
            fact_user_count = rollup.distinct_count(lambda k, a: k[0][0])
            print(f"  Users in dimension:        {len(user_key_map):,}")
            print(f"  Users represented in fact: {fact_user_count:,}")
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
            "Two/three-input, two-output preprocessor that produces a rolled-up "
            "Interactions fact CSV (~85% row reduction via PromptCount grain) "
            "and a Users dim CSV for the ValueLens Dashboard PBIP."
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
        help=(
            "Path to the Entra users CSV (UPN + org columns). The license column "
            "is optional: supply it separately via --licensing (recommended for "
            "standalone use), or omit --licensing to use a single combined "
            "users+licensing file (license column auto-detected)."
        ),
    )
    parser.add_argument(
        "--licensing",
        default=None,
        help=(
            "Path to a separate licensing CSV (UPN + 'Has License' columns), e.g. "
            "the Microsoft Admin Center Copilot user export. When provided, "
            "--entra is treated as a users-only file and license status is merged "
            "in from this file (the 3-file workflow). Omit to use a single "
            "combined Entra file (license column auto-detected). Applies to both "
            "ValueLens and AI-in-One profiles."
        ),
    )
    parser.add_argument(
        "--combined-entra",
        action="store_true",
        default=False,
        help=(
            "Legacy 2-file mode: assert that --entra is a single combined "
            "users+licensing file (as produced by the PAX script). Mutually "
            "exclusive with --licensing. Optional - even without this flag a "
            "combined file still works (the license column is auto-detected)."
        ),
    )
    parser.add_argument(
        "--out-dir",
        "-o",
        default=None,
        help="Directory for output files. Default: same directory as the Purview file.",
    )
    parser.add_argument(
        "--profile",
        "-p",
        choices=("aibv", "aio"),
        default="aibv",
        help=(
            "Output profile. ValueLens Dashboard (default; internally selected by PAX) "
            "superset (50-col fact, 3-value Environment). 'aio' = AI-in-One "
            "Dashboard (36-col fact, 5-value Environment) — reproduces the "
            "AIO output exactly."
        ),
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        default=False,
        help="Suppress progress output.",
    )
    parser.add_argument(
        "--with-aggregates",
        action="store_true",
        default=False,
        help=(
            "Also write the ValueLens pre-aggregated tables (ActiveDaysSummary, "
            "UserMonthMetrics, Licensed/Unlicensed user rankings, Licensed user "
            "summary). OFF by default — the ValueLens template only needs the two core "
            "rollup files (Interactions + Users). No effect for --profile aio."
        ),
    )
    parser.add_argument(
        # Deprecated no-op: aggregates are now OFF by default, so this flag does
        # nothing. Kept so older command lines don't error.
        "--no-aggregates",
        action="store_true",
        default=False,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--deidentify",
        action="store_true",
        default=False,
        help=(
            "One-way hash all identifying values (UPNs, names, manager fields, "
            "Entra/mailbox GUIDs and SIDs, resource URLs) for anonymous reporting. "
            "Deterministic and format-preserving, so manager links and "
            "UserKey/Users joins are kept; irreversible (no decode map)."
        ),
    )
    parser.add_argument(
        # PAX append support.
        "--seed-mid-map",
        default=None,
        help=(
            "Optional JSON file mapping {Message_Id_Raw -> existing INT surrogate} "
            "extracted from the target Fact CSV. Pre-seeds mid_to_int so cross-run "
            "appends preserve Message_Id INTs and dedup source rows on Message_Id_Raw."
        ),
    )
    parser.add_argument(
        "--seed-thread-map",
        default=None,
        help=(
            "Optional JSON file mapping {ThreadId_Raw -> existing INT surrogate} "
            "extracted from the target Fact CSV. Pre-seeds thread_key_map so cross-run "
            "appends preserve ThreadId INTs."
        ),
    )
    parser.add_argument(
        "--seed-userkey-map",
        default=None,
        help=(
            "Optional JSON file mapping {PersonId_Normalized -> existing UserKey INT} "
            "extracted from the merged Users CSV. Pre-seeds user_key_map so Entra users "
            "carried forward from prior runs keep their UserKey across the append."
        ),
    )
    parser.add_argument(
        "--user-history",
        choices=("off", "on"),
        default="off",
        help="Enable prospective effective-dated user license/status attribution.",
    )
    parser.add_argument(
        "--history-effective-date",
        default="",
        help="UTC requested-period start date (yyyy-MM-dd) for the observed user state.",
    )
    parser.add_argument(
        "--history-users-target",
        default=None,
        help="Existing effective-dated Users target used to resolve prior states.",
    )
    parser.add_argument(
        "--hierarchy-fill",
        choices=("none", "self", "manager", "fixed"),
        default="none",
        help=(
            "Filler for org-hierarchy level slots deeper than a user's own level "
            "(Users dim, AIO/ValueLens). 'none' (default) leaves them blank; 'self' "
            "repeats the user; 'manager' repeats the user's manager; 'fixed' uses "
            "--hierarchy-fill-label. The hierarchy columns are always emitted."
        ),
    )
    parser.add_argument(
        "--hierarchy-fill-label",
        default="",
        help="Literal label used when '--hierarchy-fill fixed' is selected.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {SCRIPT_VERSION}",
    )

    args = parser.parse_args()

    global _DEIDENTIFY
    _DEIDENTIFY = bool(args.deidentify)

    global _HIER_FILL_MODE, _HIER_FILL_LABEL
    _HIER_FILL_MODE = args.hierarchy_fill
    _HIER_FILL_LABEL = args.hierarchy_fill_label or ""
    if _HIER_FILL_MODE == "fixed" and not _HIER_FILL_LABEL:
        print(
            'ERROR: --hierarchy-fill fixed requires --hierarchy-fill-label "<text>".',
            file=sys.stderr,
        )
        sys.exit(1)
    if _HIER_FILL_MODE != "fixed" and _HIER_FILL_LABEL:
        print(
            "ERROR: --hierarchy-fill-label is only valid with --hierarchy-fill fixed.",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.licensing and args.combined_entra:
        print(
            "ERROR: --licensing and --combined-entra are mutually exclusive. Use "
            "--licensing for the 3-file (separate licensing) workflow, or "
            "--combined-entra (or neither) for a single combined Entra file.",
            file=sys.stderr,
        )
        sys.exit(1)
    if args.user_history == "on":
        try:
            datetime.strptime(args.history_effective_date, "%Y-%m-%d")
        except ValueError:
            print("ERROR: --user-history on requires --history-effective-date yyyy-MM-dd.", file=sys.stderr)
            sys.exit(1)

    purview_path = os.path.abspath(args.purview)
    entra_path = os.path.abspath(args.entra)
    for label, p in (("Purview", purview_path), ("Entra", entra_path)):
        if not os.path.isfile(p):
            print(f"ERROR: {label} input file not found: {p}", file=sys.stderr)
            sys.exit(1)

    licensing_path = os.path.abspath(args.licensing) if args.licensing else None
    if licensing_path and not os.path.isfile(licensing_path):
        print(f"ERROR: Licensing input file not found: {licensing_path}", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(os.path.abspath(args.out_dir)) if args.out_dir else Path(purview_path).parent
    out_dir.mkdir(parents=True, exist_ok=True)

    purview_stem = Path(purview_path).stem
    entra_stem = Path(entra_path).stem
    run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    # PAX embed (the standalone timestamps these two):
    # the core rollup outputs use NON-timestamped names so PAX's post-run
    # Merge-FactCsv / Merge-UsersCsv resolve them by exact name. The run timestamp
    # is already baked into the input filenames (Purview_Audit_*_<ts>.csv,
    # EntraUsers_MAClicensing_<ts>.csv), so it is not duplicated on the output.
    fact_out = str(out_dir / f"{purview_stem}_Interactions.csv")
    users_out = str(out_dir / f"{entra_stem}_Users.csv")

    # Pre-aggregated table paths (AIBV only, opt-in via --with-aggregates).
    # Default: not written — the AIBV template consumes only the Interactions
    # + Users rollups. The aggregates remain available for the future
    # calc-table offload (point the 5 DAX calc tables at these CSVs).
    agg_paths: dict[str, str] | None = None
    if args.profile != "aio" and args.with_aggregates:
        agg_paths = {
            "active_days": str(out_dir / f"{purview_stem}_ActiveDaysSummary_{run_ts}.csv"),
            "user_month_metrics": str(out_dir / f"{purview_stem}_UserMonthMetrics_{run_ts}.csv"),
            "licensed_rankings": str(out_dir / f"{purview_stem}_LicensedUserRankings_{run_ts}.csv"),
            "unlicensed_rankings": str(out_dir / f"{purview_stem}_UnlicensedUserRankings_{run_ts}.csv"),
            "licensed_summary": str(out_dir / f"{purview_stem}_LicensedUserSummary_{run_ts}.csv"),
        }

    stats = run_processor(
        purview_csv=purview_path,
        entra_csv=entra_path,
        fact_out_csv=fact_out,
        users_out_csv=users_out,
        profile=args.profile,
        agg_paths=agg_paths,
        quiet=args.quiet,
        licensing_csv=licensing_path,
        seed_mid_map_path=args.seed_mid_map,
        seed_thread_map_path=args.seed_thread_map,
        seed_userkey_map_path=args.seed_userkey_map,
        user_history=(args.user_history == "on"),
        history_effective_date=args.history_effective_date,
        history_users_target=args.history_users_target,
    )
    # Absolute: any record this run could not account for withholds the run.
    if stats["errors"] > 0:
        print(
            f"ERROR: {stats['errors']:,} input record(s) were rejected and are listed in full at "
            f"{stats['reject_manifest_path']}. The candidate outputs are preserved but are NOT "
            f"published.",
            file=sys.stderr,
        )
    sys.exit(EXIT_RESIDUAL_REJECTS if stats["errors"] > 0 else 0)


if __name__ == "__main__":
    main()
