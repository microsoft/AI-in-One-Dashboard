"""Resumable Graph audit collection into an isolated v2 raw Delta table."""


def audit_windows(start, end, hours):
    if hours <= 0 or hours > 24:
        raise ValueError("CHUNK_HOURS must be between 1 and 24.")
    if start >= end:
        raise ValueError("Audit start must precede end.")
    while start < end:
        stop = min(start + timedelta(hours=hours), end)
        yield start, stop
        start = stop


def validate_query_result(result):
    if result.get("isRecordCountLimitExceeded") is True:
        raise RuntimeError("Audit query exceeded its result limit. Reduce CHUNK_HOURS and use a new RUN_ID; incomplete results will not be published.")
    if result.get("status") in ("failed", "cancelled", "unknownFutureValue"):
        raise RuntimeError(f"Audit query ended in {result['status']}; publication is blocked.")


def canonical_record(record, tenant):
    if normalized(record.get("organizationId")) not in ("", normalized(tenant)):
        raise ValueError("Audit record tenant does not match TENANT_ID.")
    data = record.get("auditData")
    if isinstance(data, str):
        data = json.loads(data)
    if not isinstance(data, dict) or not data:
        raise ValueError("Audit record has no usable auditData.")
    identifier = record.get("id") or data.get("Id")
    if not identifier:
        raise ValueError("Audit record has no stable record ID.")
    created = data.get("CreationTime") or record.get("createdDateTime")
    if not created:
        raise ValueError("Audit record has no creation timestamp.")
    utc(created)
    if not data.get("CreationTime"):
        data["CreationTime"] = created
    if not data.get("UserId") and record.get("userPrincipalName"):
        data["UserId"] = record["userPrincipalName"]
    return {"RecordId": str(identifier), "TenantId": normalized(tenant),
            "CreationDate": iso(utc(created)),
            "AuditData": json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)}


def run_audit(spark, config):
    from delta.tables import DeltaTable
    from pyspark.sql import functions as F
    from pyspark.sql.types import StructType, StructField, StringType
    from concurrent.futures import ThreadPoolExecutor, as_completed
    context = require_lakehouse()
    table = checked_table(config["OUTPUT_TABLE"])
    tenant = normalized(config["TENANT_ID"])
    run_id = config["RUN_ID"] or str(uuid.uuid4())
    uuid.UUID(run_id)
    if config["MODE"] not in ("backfill", "incremental"):
        raise ValueError("MODE must be backfill or incremental.")
    if not 1 <= config["MAX_CONCURRENT_QUERIES"] <= 4:
        raise ValueError("Use between one and four concurrent audit queries.")
    if config["BACKFILL_DAYS"] < 1 or config["OVERLAP_DAYS"] < 1:
        raise ValueError("BACKFILL_DAYS and OVERLAP_DAYS must be positive.")
    if config["MAX_WAIT_MIN_PER_QUERY"] <= 0 or config["POLL_INTERVAL_SEC"] <= 0:
        raise ValueError("Query wait and poll intervals must be positive.")
    client = GraphClient(tenant, config["CLIENT_ID"], config["KEY_VAULT_URL"], config["SECRET_NAME"])
    spark.conf.set("spark.sql.session.timeZone", "UTC")
    directory = Path("/lakehouse/default/Files/aio_v2_staging") / tenant / table.replace(".", "_") / run_id
    directory.mkdir(parents=True, exist_ok=True)
    plan_path = directory / "run.json"
    contract = {"tenant": tenant, "table": table, "lakehouse": context["defaultLakehouseId"],
                "mode": config["MODE"], "chunk_hours": config["CHUNK_HOURS"],
                "requested_start": config["START_UTC"], "requested_end": config["END_UTC"],
                "backfill_days": config["BACKFILL_DAYS"], "overlap_days": config["OVERLAP_DAYS"]}
    if plan_path.exists():
        plan = read_json(plan_path)
        if plan["contract"] != contract:
            raise ValueError("RUN_ID was already used with a different source or configuration.")
        start, end = utc(plan["start"]), utc(plan["end"])
    else:
        end = utc(config["END_UTC"]) if config["END_UTC"] else datetime.now(timezone.utc)
        if config["START_UTC"]:
            start = utc(config["START_UTC"])
        elif config["MODE"] == "incremental" and table_exists(spark, table):
            existing = spark.table(table)
            require_columns(existing, ["TenantId", "CreationDate"], table)
            if existing.filter(F.col("TenantId") != tenant).take(1):
                raise ValueError("The target table contains another tenant. Use a separate table.")
            latest = existing.agg(F.max("CreationDate")).first()[0]
            start = utc(latest) - timedelta(days=config["OVERLAP_DAYS"]) if latest else end - timedelta(days=config["BACKFILL_DAYS"])
        else:
            start = end - timedelta(days=config["BACKFILL_DAYS"])
        plan = {"contract": contract, "start": iso(start), "end": iso(end), "run_id": run_id}
        atomic_json(plan_path, plan)
    LOG.info("Audit run %s: %s through %s. Reuse this RUN_ID to resume.", run_id, iso(start), iso(end))
    windows = list(audit_windows(start, end, config["CHUNK_HOURS"]))

    def collect(index, bounds):
        begin, finish = bounds
        checkpoint = directory / f"window_{index:05d}.json"
        state = read_json(checkpoint) if checkpoint.exists() else {}
        if state.get("complete"):
            for item in state["files"]:
                path = directory / item["name"]
                if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                    raise ValueError("A completed audit staging page is missing or changed.")
            return state
        if state.get("creating") and not state.get("query_id"):
            raise RuntimeError("A previous query POST had an uncertain outcome. Find its displayName in Graph and populate query_id in this window checkpoint; do not resubmit blindly.")
        if not state.get("query_id"):
            state = {"creating": True, "displayName": f"AIO v2 {run_id} window {index}",
                     "start": iso(begin), "end": iso(finish)}
            atomic_json(checkpoint, state)
            response = client.request("POST", "https://graph.microsoft.com/v1.0/security/auditLog/queries",
                                      json={"displayName": state["displayName"], "filterStartDateTime": iso(begin),
                                            "filterEndDateTime": iso(finish), "recordTypeFilters": ["copilotInteraction"]})
            state["query_id"] = response.json()["id"]
            state["creating"] = False
            atomic_json(checkpoint, state)
        query_url = "https://graph.microsoft.com/v1.0/security/auditLog/queries/" + state["query_id"]
        deadline = time.monotonic() + config["MAX_WAIT_MIN_PER_QUERY"] * 60
        while True:
            result = client.request("GET", query_url).json()
            validate_query_result(result)
            if result.get("status") == "succeeded":
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Audit query is still pending. Its ID is checkpointed; rerun with the same RUN_ID.")
            time.sleep(config["POLL_INTERVAL_SEC"])
        files, total = [], 0
        url, page = query_url + "/records", 0
        while url:
            result = client.request("GET", url).json()
            records = result.get("value")
            if not isinstance(records, list):
                raise ValueError("Audit result page has no value list.")
            name = f"window_{index:05d}_page_{page:06d}.jsonl"
            path = directory / name
            with path.open("w", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(canonical_record(record, tenant), ensure_ascii=False) + "\n")
            files.append({"name": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
            total += len(records)
            url, page = result.get("@odata.nextLink"), page + 1
        validate_query_result(client.request("GET", query_url).json())
        state.update(complete=True, files=files, rows=total)
        atomic_json(checkpoint, state)
        return state

    completed, failures = [], []
    with ThreadPoolExecutor(max_workers=config["MAX_CONCURRENT_QUERIES"]) as pool:
        futures = [pool.submit(collect, i, window) for i, window in enumerate(windows)]
        for future in as_completed(futures):
            try:
                completed.append(future.result())
            except (RuntimeError, ValueError, TimeoutError, OSError, KeyError) as error:
                LOG.error("Audit window failed: %s", str(error))
                failures.append(error)
    if failures:
        raise RuntimeError(f"{len(failures)} audit windows failed. No Delta publication occurred; resume RUN_ID {run_id}.") from failures[0]
    relative = str(directory.relative_to("/lakehouse/default")).replace(os.sep, "/")
    paths = [relative + "/" + item["name"] for state in completed for item in state["files"] if state["rows"]]
    schema = StructType([StructField(n, StringType(), False) for n in ("RecordId", "TenantId", "CreationDate", "AuditData")])
    raw = spark.read.schema(schema).json(paths) if paths else spark.createDataFrame([], schema)
    if raw.count() != sum(state["rows"] for state in completed):
        raise ValueError("Staged audit row count does not reconcile.")
    raw = raw.withColumn("CreationDate", F.to_timestamp("CreationDate"))
    if raw.filter(F.col("CreationDate").isNull()).take(1):
        raise ValueError("Invalid audit timestamps; no Delta publication occurred.")
    conflicts = raw.groupBy("TenantId", "RecordId").agg(F.countDistinct("AuditData").alias("versions")).filter("versions > 1")
    if conflicts.take(1):
        raise ValueError("Conflicting payloads for the same audit record ID; review before publishing.")
    raw = raw.dropDuplicates(["TenantId", "RecordId"])
    if table_exists(spark, table):
        current = spark.table(table)
        if current.filter(F.col("TenantId") != tenant).take(1):
            raise ValueError("Target audit table belongs to a different tenant.")
        (DeltaTable.forName(spark, table).alias("target").merge(
            raw.alias("source"), "target.TenantId=source.TenantId AND target.RecordId=source.RecordId")
         .whenMatchedUpdateAll().whenNotMatchedInsertAll().execute())
    else:
        raw.write.format("delta").mode("errorifexists").saveAsTable(table)
    status_schema = "RunId string, TenantId string, CompletedAt timestamp, StartUtc string, EndUtc string, RecordCount long"
    status = spark.createDataFrame([(run_id, tenant, datetime.now(timezone.utc), iso(start), iso(end), raw.count())], status_schema)
    status.write.format("delta").mode("overwrite").saveAsTable(checked_table(config["STATUS_TABLE"]))
    LOG.info("Audit collection complete: %s unique records in this run; history merged by record ID.", raw.count())
