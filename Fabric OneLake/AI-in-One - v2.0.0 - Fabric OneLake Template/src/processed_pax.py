"""Validate and publish already-processed PAX AIO files without re-keying history."""

import re as _pax_re
from datetime import date as _pax_date, datetime as _pax_datetime


def processed_pax_inputs(config):
    users = str(config.get("PAX_USERS_CSV") or "").strip()
    facts = str(config.get("PAX_INTERACTIONS_CSV") or "").strip()
    if bool(users) != bool(facts):
        raise ValueError("Supply both PAX_USERS_CSV and PAX_INTERACTIONS_CSV, or leave both blank.")
    if not users:
        return None
    if users == facts:
        raise ValueError("Processed Users and Interactions must be different files.")
    for path in (users, facts):
        if not (path.startswith("Files/") or
                (path.startswith("abfss://") and "/Files/" in path)):
            raise ValueError("Processed CSV inputs must use Files/ in the attached Lakehouse or an ABFSS Files path.")
        if not path.lower().endswith(".csv") or any(c in path for c in "*?[]"):
            raise ValueError("Each processed input must name one CSV file, not a directory or wildcard.")
    return users, facts


def pax_column_name(name):
    aliases = {
        "userkey": "UserKey", "manageruserkey": "Manager_UserKey",
        "personid": "PersonId", "personidnormalized": "PersonId_Normalized",
        "useridnormalized": "User_Id_Normalized", "effectivedate": "EffectiveDate",
        "haslicense": "Has_license", "licensestatus": "License_Status",
        "interactiondate": "InteractionDate", "creationdate": "CreationDate",
        "messageid": "Message_Id", "threadid": "ThreadId",
        "agentid": "AgentId", "apphost": "AppHost", "environment": "Environment",
        "weekstart": "WeekStart", "monthstart": "MonthStart", "activitydate": "ActivityDate",
        "messageisprompt": "Message_isPrompt", "issensitive": "Is_Sensitive",
        "totalemployees": "TotalEmployees", "tenantid": "TenantId",
    }
    key = _pax_re.sub(r"[\s_-]", "", name).lower()
    return aliases.get(key, _pax_re.sub(r"[ ,;{}()\n\r\t=]", "_", name))


def pax_columns(names):
    result = [pax_column_name(name) for name in names]
    if len(result) != len(set(result)):
        raise ValueError("Processed input has duplicate or colliding column names.")
    return result


def processed_pax_fact_columns(names):
    columns = pax_columns(names)
    required = {"UserKey", "InteractionDate", "Message_Id", "ThreadId", "CreationDate",
                "Has_license", "License_Status", "AgentId", "AppHost", "Environment",
                "WeekStart", "MonthStart", "ActivityDate", "Is_Sensitive"}
    if not required.issubset(columns):
        raise ValueError("Processed Interactions is missing required AIO identity, date, licensing or classification fields.")
    return columns


def pax_schema_fields(columns, users=False, typed_dates=False, snapshot=False):
    names = list(columns)
    if snapshot and "_SnapshotId" not in names:
        names.append("_SnapshotId")
    fields = []
    for name in names:
        if name == "UserKey" or (users and name == "Manager_UserKey") or (
                not users and name in ("Message_Id", "ThreadId")):
            kind = "long"
        elif not users and name == "Is_Sensitive":
            kind = "boolean"
        elif not users and typed_dates and name in ("InteractionDate", "WeekStart", "MonthStart", "ActivityDate"):
            kind = "date"
        elif not users and typed_dates and name == "CreationDate":
            kind = "timestamp"
        else:
            kind = "string"
        fields.append((name, kind, not (snapshot and name == "_SnapshotId")))
    return fields


def pax_publication_fields():
    return [(name, kind, True) for name, kind in (
        ("SnapshotId", "string"), ("State", "string"), ("TenantId", "string"),
        ("Users", "long"), ("Facts", "long"), ("Prompts", "long"),
        ("Sessions", "long"), ("CompletedAt", "timestamp"))]


def pax_spark_schema(fields):
    from pyspark.sql.types import (
        StructType, StructField, StringType, LongType, BooleanType, DateType, TimestampType)
    types = {"string": StringType, "long": LongType, "boolean": BooleanType,
             "date": DateType, "timestamp": TimestampType}
    return StructType([StructField(name, types[kind](), nullable) for name, kind, nullable in fields])


def cast_pax_fact_columns(frame):
    from pyspark.sql import functions as F
    for name, kind, _ in pax_schema_fields(frame.columns, typed_dates=True):
        if kind == "date":
            frame = frame.withColumn(name, F.to_date(name))
        elif kind == "timestamp":
            frame = frame.withColumn(name, F.to_timestamp(name))
    return frame


def pax_row(row, columns=None):
    if columns is not None:
        return {target: row[source] for source, target in columns.items()}
    names = list(row)
    return dict(zip(pax_columns(names), (row[name] for name in names)))


def pax_key(value, label, nullable=False):
    if value is None or str(value).strip() == "":
        if nullable:
            return None
        raise ValueError(f"{label} is required.")
    text = str(value).strip()
    if not _pax_re.fullmatch(r"[0-9]+", text) or not 0 < int(text) < 2 ** 63:
        raise ValueError(f"{label} must be a positive signed 64-bit integer.")
    return int(text)


def pax_day(value, label, unknown=False):
    text = "" if value is None else str(value).strip()
    if unknown and text.lower() == "unknown":
        return "Unknown"
    if not _pax_re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise ValueError(f"{label} must be yyyy-MM-dd" + (" or Unknown." if unknown else "."))
    try:
        _pax_date.fromisoformat(text)
    except ValueError as error:
        raise ValueError(f"{label} is not a valid date.") from error
    return text


def pax_license_flag(value):
    text = str("" if value is None else value).strip()
    values = {"true": "TRUE", "false": "FALSE", "unknown": "Unknown", "": ""}
    if text.lower() not in values:
        raise ValueError("Processed Has license must be TRUE, FALSE or Unknown.")
    return values[text.lower()]


def pax_license(row):
    if not {"Has_license", "License_Status"}.issubset(row):
        raise ValueError("Processed input needs Has license and License Status.")
    has_license = pax_license_flag(row["Has_license"])
    status = {"TRUE": "M365 Copilot Licensed", "FALSE": "Unlicensed",
              "Unknown": "Unknown", "": "Unknown"}[has_license]
    if str(row.get("License_Status") or "").strip().casefold() != status.casefold():
        raise ValueError("Processed Has license and License Status disagree.")
    return has_license, status


def pax_tenant(row, tenant):
    supplied = str(row.get("TenantId") or "").strip().lower()
    if supplied and tenant and supplied != tenant:
        raise ValueError("Processed input contains a different tenant.")


def build_pax_user_index(rows, tenant=""):
    output, by_key, states, fingerprints = [], {}, {}, set()
    for incoming in rows:
        row = pax_row(incoming)
        pax_tenant(row, tenant)
        identity = str(row.get("PersonId_Normalized") or row.get("PersonId") or "").strip().lower()
        if not identity or "@" not in identity:
            raise ValueError("Processed Users needs a normalized person identity.")
        key = pax_key(row.get("UserKey"), "UserKey")
        has_license, status = pax_license(row)
        fingerprint = (identity, has_license or "Unknown", status)
        if fingerprint in fingerprints:
            raise ValueError("Processed Users contains a duplicate person/license-state row.")
        if key in by_key:
            raise ValueError("Processed UserKey maps to multiple state rows.")
        fingerprints.add(fingerprint)
        effective = (pax_day(row["EffectiveDate"], "EffectiveDate", unknown=True)
                     if "EffectiveDate" in row else "Unknown")
        manager = pax_key(row.get("Manager_UserKey"), "Manager_UserKey", nullable=True)
        row.update(UserKey=key, PersonId_Normalized=identity, Has_license=has_license,
                   License_Status=status, EffectiveDate=effective, Manager_UserKey=manager)
        output.append(row)
        state = {"UserKey": key, "identity": identity, "EffectiveDate": effective,
                 "Has_license": has_license, "License_Status": status,
                 "Manager_UserKey": manager}
        by_key[key] = state
        states.setdefault(identity, []).append(state)
    if not output:
        raise ValueError("Processed Users is empty.")
    # Stable date sorting retains PAX export order for observations on the same day.
    for group in states.values():
        group.sort(key=lambda state: (state["EffectiveDate"] != "Unknown",
                                      "" if state["EffectiveDate"] == "Unknown" else state["EffectiveDate"]))
    for row in output:
        if row.get("TotalEmployees") not in (None, ""):
            if pax_key(row["TotalEmployees"], "TotalEmployees") != len(states):
                raise ValueError("TotalEmployees must count distinct people, not license-state rows.")
    return {"rows": output, "by_key": by_key, "states": states,
            "people": len(states), "state_rows": len(output), "tenant": tenant}


def resolve_pax_state(index, identity, event_day):
    chosen = unknown = earliest = None
    for state in index["states"].get(identity, []):
        effective = state["EffectiveDate"]
        if effective == "Unknown":
            unknown = state
            continue
        if earliest is None:
            earliest = state
        if effective > event_day:
            break
        chosen = state
    # PAX attributes pre-observation events to the earliest dated state, not a parallel Unknown row.
    return chosen or earliest or unknown


def validate_pax_fact(incoming, index, columns=None):
    row = pax_row(incoming, columns)
    pax_tenant(row, index.get("tenant", ""))
    key = pax_key(row.get("UserKey"), "Fact UserKey")
    state = index["by_key"].get(key)
    if state is None:
        raise ValueError("Processed activity UserKey has no matching Users state.")
    event_day = pax_day(row.get("InteractionDate"), "InteractionDate")
    expected = resolve_pax_state(index, state["identity"], event_day)
    if expected is None or expected["UserKey"] != key:
        raise ValueError("Processed activity UserKey does not match the PAX state at the event date.")
    identity = str(row.get("User_Id_Normalized") or "").strip().lower()
    if identity and identity != state["identity"]:
        raise ValueError("Processed activity identity disagrees with its UserKey.")
    if not {"Has_license", "License_Status"}.issubset(row):
        raise ValueError("Processed activity needs Has license and License Status.")
    has_license = pax_license_flag(row["Has_license"])
    status = str(row["License_Status"] or "").strip()
    if status.casefold() != state["License_Status"].casefold():
        raise ValueError("Processed activity License Status disagrees with its attributed state.")
    status = state["License_Status"]
    for name in ("Message_Id", "ThreadId"):
        row[name] = pax_key(row.get(name), name)
    creation = str(row.get("CreationDate") or "").strip()
    try:
        timestamp = _pax_datetime.fromisoformat(creation.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("Processed CreationDate must be a valid UTC timestamp.") from error
    if timestamp.tzinfo is None or timestamp.utcoffset().total_seconds() != 0:
        raise ValueError("Processed CreationDate must carry UTC timezone information.")
    if timestamp.date().isoformat() != event_day:
        raise ValueError("Processed InteractionDate disagrees with UTC CreationDate.")
    for name in ("WeekStart", "MonthStart", "ActivityDate"):
        if name in row:
            row[name] = pax_day(row[name], name)
    if "Message_isPrompt" in row and str(row["Message_isPrompt"]).strip().lower() != "true":
        raise ValueError("Processed Interactions must contain prompt rows only.")
    if "Is_Sensitive" in row:
        sensitive = "" if row["Is_Sensitive"] is None else str(row["Is_Sensitive"]).strip().lower()
        if sensitive not in ("true", "false", ""):
            raise ValueError("Processed Is_Sensitive must be TRUE, FALSE or blank for unknown.")
        row["Is_Sensitive"] = None if sensitive == "" else sensitive == "true"
    row.update(UserKey=key, InteractionDate=event_day, Has_license=has_license,
               License_Status=status)
    return row


def publish_processed_pax(spark, users, facts, marker, names, user_count, fact_count):
    marker("Publishing").write.format("delta").mode("overwrite").saveAsTable(names["PUBLICATION_TABLE"])
    users.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(names["USERS_TABLE"])
    facts.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(names["INTERACTIONS_TABLE"])
    if (spark.table(names["USERS_TABLE"]).count() != user_count or
            spark.table(names["INTERACTIONS_TABLE"]).count() != fact_count):
        raise RuntimeError("Processed table counts did not reconcile; publication remains Publishing.")
    marker("Ready").write.format("delta").mode("overwrite").saveAsTable(names["PUBLICATION_TABLE"])


def run_processed_pax_preparation(spark, config):
    from pyspark.sql import functions as F
    paths = processed_pax_inputs(config)
    if paths is None:
        raise ValueError("Processed PAX inputs were not supplied.")
    require_lakehouse()
    tenant = normalized(config["TENANT_ID"])
    uuid.UUID(tenant)
    names = {name: checked_table(config[name]) for name in
             ("USERS_TABLE", "INTERACTIONS_TABLE", "PUBLICATION_TABLE")}
    if len(set(names.values())) != 3:
        raise ValueError("Processed output and publication tables must be distinct.")
    spark.conf.set("spark.sql.session.timeZone", "UTC")
    spark.conf.set("spark.sql.timestampType", "TIMESTAMP_LTZ")
    reader = spark.read.options(header=True, inferSchema=False, multiLine=True,
                                quote='"', escape='"', mode="FAILFAST")
    raw_users, raw_facts = reader.csv(paths[0]), reader.csv(paths[1])
    pax_columns(raw_users.columns)
    fact_columns = processed_pax_fact_columns(raw_facts.columns)
    index = build_pax_user_index((row.asDict() for row in raw_users.toLocalIterator()), tenant)
    users_schema = pax_spark_schema(pax_schema_fields(index["rows"][0], users=True))
    users = spark.createDataFrame(index["rows"], users_schema)
    shared = spark.sparkContext.broadcast({name: index[name] for name in ("by_key", "states", "tenant")})
    fact_mapping = dict(zip(raw_facts.columns, fact_columns))

    def validate_partition(records):
        for record in records:
            yield validate_pax_fact(record.asDict(), shared.value, fact_mapping)

    facts_schema = pax_spark_schema(pax_schema_fields(fact_columns))
    cached_facts = spark.createDataFrame(raw_facts.rdd.mapPartitions(validate_partition), facts_schema).persist()
    try:
        fact_count = cached_facts.count()
        if not fact_count:
            raise ValueError("Processed Interactions is empty.")
        facts = cast_pax_fact_columns(cached_facts)
        owners = spark.createDataFrame([(key, state["identity"]) for key, state in index["by_key"].items()],
                                       pax_spark_schema(pax_schema_fields(("UserKey", "_PaxPerson"))))
        scoped = facts.join(owners, "UserKey", "inner")
        if scoped.count() != fact_count:
            raise ValueError("Processed activity and Users states did not join one-to-one.")
        stats = scoped.agg(F.countDistinct("Message_Id").alias("prompts"),
                           F.countDistinct(F.struct("_PaxPerson", "ThreadId")).alias("sessions")).first()
        batch = str(uuid.uuid4())
        users = users.withColumn("_SnapshotId", F.lit(batch))
        facts = facts.withColumn("_SnapshotId", F.lit(batch))
        schema = pax_spark_schema(pax_publication_fields())

        def marker(state):
            return spark.createDataFrame([(batch, state, tenant, index["state_rows"], fact_count,
                                           stats["prompts"], stats["sessions"], datetime.now(timezone.utc))], schema)

        publish_processed_pax(spark, users, facts, marker, names, index["state_rows"], fact_count)
        LOG.info("Published processed PAX snapshot: %s people, %s states, %s facts.",
                 index["people"], index["state_rows"], fact_count)
        return {"people": index["people"], "states": index["state_rows"], "facts": fact_count,
                "prompts": stats["prompts"], "sessions": stats["sessions"]}
    finally:
        cached_facts.unpersist()
        shared.unpersist()
