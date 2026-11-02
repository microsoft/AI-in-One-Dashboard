"""Shared, embedded notebook support. No credentials or data are logged."""

import csv
import hashlib
import io
import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlparse

import requests

LOG = logging.getLogger("aio.fabric.v2")
if not LOG.handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


def normalized(value):
    return "" if value is None else str(value).strip().lower()


def stable_key(kind, value):
    if value is None or str(value) == "":
        return None
    payload = json.dumps([kind, str(value)], ensure_ascii=False, separators=(",", ":"))
    return (int.from_bytes(hashlib.sha256(payload.encode("utf-8")).digest()[:8], "big")
            & ((1 << 63) - 1)) or 1


def utc(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def iso(value):
    return utc(value).isoformat().replace("+00:00", "Z")


def checked_table(value):
    if not re.fullmatch(r"(?:dbo\.)?[a-z][a-z0-9_]*", value):
        raise ValueError("Use a table name with lowercase letters, digits and underscores, optionally prefixed by dbo.")
    if not value.split(".")[-1].startswith(("aio_v2_", "aio_test_")):
        raise ValueError("Only aio_v2_ or aio_test_ tables may be written by this package.")
    return value


def require_lakehouse():
    import notebookutils
    context = notebookutils.runtime.context
    if not context.get("defaultLakehouseId"):
        raise RuntimeError("Attach a default Lakehouse before running.")
    return context


def table_exists(spark, name):
    checked_table(name)
    return spark.catalog.tableExists(name)


def require_columns(frame, names, label):
    missing = sorted(set(names) - set(frame.columns))
    if missing:
        raise ValueError(f"{label}: missing required columns {missing}.")


def require_nonempty(frame, label):
    if not frame.take(1):
        raise ValueError(f"{label} is empty. Existing published tables were not replaced.")


def require_unique(frame, columns, label):
    if frame.groupBy(*columns).count().filter("count > 1").take(1):
        raise ValueError(f"{label} contains duplicate keys; resolve the source before publication.")


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def read_json(path):
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)


def retry_delay(response, attempt):
    raw = response.headers.get("Retry-After", "")
    if raw.isdigit():
        return max(1, int(raw))
    if raw:
        return max(1, (parsedate_to_datetime(raw) - datetime.now(timezone.utc)).total_seconds())
    return min(120, 2 ** attempt)


class GraphClient:
    def __init__(self, tenant_id, client_id, key_vault_url, secret_name):
        uuid.UUID(tenant_id)
        uuid.UUID(client_id)
        if not key_vault_url.startswith("https://") or not secret_name:
            raise ValueError("Configure a Key Vault HTTPS URL and secret name.")
        import notebookutils
        self.secret = notebookutils.credentials.getSecret(key_vault_url, secret_name)
        self.tenant_id, self.client_id = tenant_id, client_id
        self._token, self._expires = None, 0
        self._lock = threading.Lock()
        self._local = threading.local()

    def session(self):
        if not hasattr(self._local, "session"):
            self._local.session = requests.Session()
        return self._local.session

    def token(self):
        with self._lock:
            if time.monotonic() < self._expires:
                return self._token
            response = self.session().post(
                f"https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token",
                data={"client_id": self.client_id, "client_secret": self.secret,
                      "scope": "https://graph.microsoft.com/.default", "grant_type": "client_credentials"},
                timeout=60)
            if response.status_code != 200:
                raise RuntimeError(f"Graph authentication failed: HTTP {response.status_code}. Check app permissions and Key Vault configuration.")
            result = response.json()
            self._token = result["access_token"]
            self._expires = time.monotonic() + max(1, int(result["expires_in"]) - 300)
            return self._token

    def request(self, method, url, **kwargs):
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.netloc != "graph.microsoft.com":
            raise ValueError("Refusing to send a Graph token to a non-Graph URL.")
        for attempt in range(1, 9):
            try:
                response = self.session().request(
                    method, url, headers={"Authorization": "Bearer " + self.token()},
                    timeout=120, allow_redirects=False, **kwargs)
            except (requests.Timeout, requests.ConnectionError):
                if method != "GET" or attempt == 8:
                    raise RuntimeError("Graph network failure; a submitted POST may have succeeded. Resolve its checkpoint before retrying.") from None
                LOG.warning("Graph GET network failure; retry %s/8", attempt)
                time.sleep(min(120, 2 ** attempt))
                continue
            retryable = response.status_code == 429 or (method == "GET" and response.status_code in (500, 502, 503, 504))
            if retryable and attempt < 8:
                LOG.warning("Graph HTTP %s; retry %s/8", response.status_code, attempt)
                time.sleep(retry_delay(response, attempt))
                continue
            if response.status_code not in (200, 201, 202, 302):
                raise RuntimeError(f"Graph {method} failed: HTTP {response.status_code}. Request ID: {response.headers.get('request-id', 'not supplied')}")
            return response
        raise RuntimeError("Graph retry budget exhausted.")

    def pages(self, url):
        while url:
            result = self.request("GET", url).json()
            if not isinstance(result.get("value"), list):
                raise ValueError("Graph collection response is missing its value list.")
            yield from result["value"]
            url = result.get("@odata.nextLink")


def write_snapshot(spark, frame, table, run_id):
    from pyspark.sql import functions as F
    checked_table(table)
    require_nonempty(frame, table)
    (frame.withColumn("_RunId", F.lit(run_id))
     .withColumn("_CollectedAt", F.current_timestamp())
     .write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(table))
    LOG.info("Wrote %s (%s rows).", table, spark.table(table).count())
