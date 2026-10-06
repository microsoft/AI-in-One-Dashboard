"""Build the v2 model contract from independent collection snapshots."""


def expand_audit_row(row):
    data = json.loads(row["AuditData"])
    identity = normalize_user_id(data.get("UserId"))
    ced = data.get("CopilotEventData")
    if is_security_copilot(data) or not _is_human_upn(identity):
        return []
    if not isinstance(ced, dict):
        raise ValueError("A human audit record is missing valid CopilotEventData.")
    prompts = prompt_messages(ced)
    if not prompts:
        return []
    if not parse_creation_time(data.get("CreationTime")):
        raise ValueError("A prompt record has an invalid CreationTime.")
    if not to_text(ced.get("ThreadId")).strip() or any(not to_text(p.get("Id")).strip() for p in prompts):
        raise ValueError("A prompt record is missing Message Id or ThreadId. Repair source IDs before publishing.")
    key = stable_key("user", identity)
    thread = to_text(ced["ThreadId"])
    license_value = row.get("Has_license") or "Unknown"
    lookup = {identity: {"Has license": license_value, "License Status": compute_license_status(license_value)}}
    candidates = explode_record(data, lookup, {identity: key}, {thread: stable_key("thread", thread)}, "aio")
    result = []
    for grain, message, attributes, _, _ in candidates:
        record = dict(zip(GRAIN_KEYS_AIO, grain))
        record.update(attributes)
        record["Message_Id"] = str(stable_key("message", message))
        # The reference processor deduplicates by grain, message and resource slice.
        record["_Slice"] = json.dumps(attributes["_ResourceSlice"], ensure_ascii=False, sort_keys=True)
        result.append({name.replace(" ", "_"): str(record.get(name, "") or "")
                       for name in FACT_HEADER_AIO + ["_Slice"]})
    return result


def run_preparation(spark, config):
    from pyspark.sql import functions as F, Window
    from pyspark.sql.types import StructType, StructField, StringType
    require_lakehouse()
    spark.conf.set("spark.sql.session.timeZone", "UTC")
    names = [config[k] for k in ("AUDIT_TABLE", "AUDIT_STATUS_TABLE", "ORG_TABLE", "LICENSE_TABLE",
                                 "USERS_TABLE", "INTERACTIONS_TABLE", "PUBLICATION_TABLE")]
    for name in names:
        checked_table(name)
    if len(names) != len(set(names)):
        raise ValueError("Source, output and publication table names must all be distinct.")
    tenant = normalized(config["TENANT_ID"])
    uuid.UUID(tenant)
    batch = str(uuid.uuid4())
    run_id = config["RUN_ID"]
    if run_id:
        uuid.UUID(run_id)
    if config["MAX_INPUT_AGE_HOURS"] <= 0:
        raise ValueError("MAX_INPUT_AGE_HOURS must be positive.")
    raw = spark.table(config["AUDIT_TABLE"])
    status = spark.table(config["AUDIT_STATUS_TABLE"])
    org = spark.table(config["ORG_TABLE"])
    licenses = spark.table(config["LICENSE_TABLE"])
    require_columns(raw, ["TenantId", "RecordId", "CreationDate", "AuditData"], "Audit source")
    require_columns(status, ["RunId", "TenantId", "CompletedAt"], "Audit completion")
    require_columns(org, ["PersonId", "DisplayName", "Organization", "ManagerUPN", "TenantId", "_RunId", "_CollectedAt"], "Org snapshot")
    require_columns(licenses, ["PersonId", "Has_license", "ReportRefreshDate", "TenantId", "_RunId", "_CollectedAt"], "License snapshot")
    for frame, label in ((status, "Audit completion"), (org, "Org snapshot"), (licenses, "License snapshot")):
        require_nonempty(frame, label)
        if frame.filter(F.col("TenantId").isNull() | (F.col("TenantId") != tenant)).take(1):
            raise ValueError(f"{label} has an unexpected tenant.")
        timestamp = "CompletedAt" if label == "Audit completion" else "_CollectedAt"
        earliest = frame.agg(F.min(timestamp)).first()[0]
        if earliest is None or (datetime.now(timezone.utc) - utc(earliest)).total_seconds() > config["MAX_INPUT_AGE_HOURS"] * 3600:
            raise ValueError(f"{label} is too old; collect it again before publication.")
        run_field = "RunId" if label == "Audit completion" else "_RunId"
        if frame.select(run_field).distinct().count() != 1:
            raise ValueError(f"{label} contains multiple collection run IDs.")
        if run_id and (label != "Org snapshot" or not config["USE_EXISTING_ORG"]):
            if frame.filter(F.col(run_field).isNull() | (F.col(run_field) != run_id)).take(1):
                raise ValueError(f"{label} was not produced by this pipeline run.")
    if status.count() != 1:
        raise ValueError("Audit completion table must have exactly one row.")
    if raw.filter(F.col("TenantId").isNull() | (F.col("TenantId") != tenant)).take(1):
        raise ValueError("Audit data contains another tenant.")
    for column in ("GivenName", "Surname", "Email", "Company", "Division", "JobTitle", "Country", "City", "Office", "ManagerName"):
        if column not in org.columns:
            org = org.withColumn(column, F.lit(None).cast("string"))
    org = org.withColumn("PersonId", F.lower(F.trim("PersonId"))).withColumn("ManagerUPN", F.lower(F.trim("ManagerUPN")))
    licenses = licenses.withColumn("PersonId", F.lower(F.trim("PersonId")))
    if org.filter(F.col("PersonId").isNull() | ~F.col("PersonId").contains("@")).take(1):
        raise ValueError("Org snapshot has invalid UPNs.")
    if licenses.filter(F.col("PersonId").isNull() | ~F.col("PersonId").contains("@")).take(1):
        raise ValueError("License snapshot has invalid or concealed UPNs.")
    require_unique(org, ["PersonId"], "Org snapshot")
    require_unique(licenses, ["PersonId"], "License snapshot")
    if licenses.filter(~F.col("Has_license").isin("TRUE", "FALSE", "Unknown") | F.col("Has_license").isNull()).take(1):
        raise ValueError("Licensing flags must be TRUE, FALSE or Unknown.")
    report_dates = licenses.select(F.to_date("ReportRefreshDate").alias("day")).distinct()
    if report_dates.filter(F.col("day").isNull()).take(1):
        raise ValueError("Licensing report has no valid Report Refresh Date.")
    earliest_date = report_dates.agg(F.min("day")).first()[0]
    if (datetime.now(timezone.utc).date() - earliest_date).days > config["MAX_LICENSE_REPORT_AGE_DAYS"]:
        raise ValueError("Licensing report is stale; do not publish misleading license classifications.")
    user_key_udf = F.udf(lambda value: stable_key("user", value), "long")
    directory = (org.drop("_RunId", "_CollectedAt")
                 .join(licenses.select("PersonId", "Has_license"), "PersonId", "left")
                 .withColumn("Has_license", F.coalesce("Has_license", F.lit("Unknown")))
                 .withColumn("UserKey", user_key_udf("PersonId"))
                 .withColumn("PersonId_Normalized", F.col("PersonId")))
    require_unique(directory, ["UserKey"], "User surrogate keys")
    manager_keys = directory.select(F.col("PersonId").alias("_ManagerUPN"), F.col("UserKey").alias("Manager_UserKey"))
    directory = (directory.join(manager_keys, directory.ManagerUPN == manager_keys._ManagerUPN, "left")
                 .drop("_ManagerUPN")
                 .withColumn("TotalEmployees", F.lit(str(directory.count())))
                 .withColumn("Manager", F.col("ManagerUPN")))
    cached_directory = directory.persist()
    directory = cached_directory
    # A raw UPN match only joins current licensing. It never grants RLS access.
    raw = raw.withColumn("_UPN", F.lower(F.trim(F.get_json_object("AuditData", "$.UserId"))))
    joined = raw.join(licenses.select(F.col("PersonId").alias("_UPN"), "Has_license"), "_UPN", "left")
    columns = [name.replace(" ", "_") for name in FACT_HEADER_AIO] + ["_Slice"]
    schema = StructType([StructField(name, StringType(), True) for name in columns])

    def expand_partition(records):
        for record in records:
            yield from expand_audit_row(record.asDict())

    cached_candidates = spark.createDataFrame(joined.select("AuditData", "Has_license").rdd.mapPartitions(expand_partition), schema).persist()
    candidates = cached_candidates
    try:
        candidates_count = candidates.count()
        LOG.info("Parsed %s resource-slice candidates from %s raw audit records.", candidates_count, raw.count())
        for integer in ("UserKey", "Message_Id", "ThreadId"):
            candidates = candidates.withColumn(integer, F.col(integer).cast("long"))
        for name in ("InteractionDate", "WeekStart", "MonthStart", "ActivityDate"):
            candidates = candidates.withColumn(name, F.to_date(name))
        candidates = candidates.withColumn("CreationDate", F.to_timestamp("CreationDate"))
        required = ["UserKey", "Message_Id", "ThreadId", "InteractionDate", "CreationDate"]
        invalid = None
        for name in required:
            condition = F.col(name).isNull()
            invalid = condition if invalid is None else invalid | condition
        if candidates.filter(invalid).take(1):
            raise ValueError("Invalid typed fact fields; publication blocked.")
        for key, raw_name in (("UserKey", "User_Id_Normalized"), ("Message_Id", "Message_Id_Raw"), ("ThreadId", "ThreadId_Raw")):
            values = candidates.select(key, raw_name)
            if key == "UserKey":
                values = values.unionByName(directory.select("UserKey", F.col("PersonId").alias(raw_name)))
            if values.groupBy(key).agg(F.countDistinct(raw_name).alias("identities")).filter("identities > 1").take(1):
                raise ValueError(f"Surrogate collision for {key}; no publication occurred.")
        grain = [name.replace(" ", "_") for name in GRAIN_KEYS_AIO] + ["Message_Id", "_Slice"]
        # Same grain and resource-slice identity as the processor; latest timestamp wins instead of input-file order.
        remaining = [name for name in columns if name not in grain]
        order = Window.partitionBy(*grain).orderBy(F.col("CreationDate").desc(), *remaining)
        facts = candidates.withColumn("_Pick", F.row_number().over(order)).filter("_Pick=1").drop("_Pick", "_Slice")
        unknown = facts.select("UserKey").distinct().join(directory.select("UserKey"), "UserKey", "left_anti").count()
        LOG.info("Facts without a directory row: %s distinct users. Missing license evidence remains Unknown; missing directory identities receive no hierarchy access.", unknown)
        if config["REQUIRE_ALL_ACTIVITY_USERS_IN_DIRECTORY"] and unknown:
            raise ValueError("Activity contains identities missing from the directory. Supply a complete directory or explicitly allow unmatched activity.")
        facts = facts.withColumn("Is_Sensitive", F.col("Is_Sensitive") == "TRUE")
        # Delta/SQL column names avoid spaces; Power Query restores the model's canonical names.
        directory = directory.withColumn("_SnapshotId", F.lit(batch))
        facts = facts.withColumn("_SnapshotId", F.lit(batch))
        user_count, fact_count = directory.count(), facts.count()
        stats = facts.agg(F.countDistinct("Message_Id").alias("prompts"),
                         F.countDistinct(F.struct("UserKey", "ThreadId")).alias("sessions")).first()
        publication_schema = "SnapshotId string, State string, TenantId string, Users long, Facts long, Prompts long, Sessions long, CompletedAt timestamp"
        def marker(state):
            return spark.createDataFrame([(batch, state, tenant, user_count, fact_count,
                                           stats["prompts"], stats["sessions"], datetime.now(timezone.utc))], publication_schema)
        marker("Publishing").write.format("delta").mode("overwrite").saveAsTable(config["PUBLICATION_TABLE"])
        directory.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(config["USERS_TABLE"])
        facts.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(config["INTERACTIONS_TABLE"])
        if spark.table(config["USERS_TABLE"]).count() != user_count or spark.table(config["INTERACTIONS_TABLE"]).count() != fact_count:
            raise RuntimeError("Published table row counts did not reconcile; marker remains Publishing and the template refuses refresh.")
        marker("Ready").write.format("delta").mode("overwrite").saveAsTable(config["PUBLICATION_TABLE"])
        LOG.info("Published snapshot %s: %s users, %s facts, %s prompts, %s sessions.",
                 batch, user_count, fact_count, stats["prompts"], stats["sessions"])
    finally:
        cached_directory.unpersist()
        cached_candidates.unpersist()
