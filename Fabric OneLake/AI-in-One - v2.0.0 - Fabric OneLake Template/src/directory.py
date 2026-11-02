"""Directory snapshot collector; keeps manager links and structured names."""


def directory_record(user):
    upn = normalized(user.get("userPrincipalName"))
    if not upn or "@" not in upn:
        raise ValueError("Graph directory contains an empty or invalid UPN.")
    manager = user.get("manager")
    if manager is not None and not isinstance(manager, dict):
        raise ValueError("Unexpected manager payload.")
    if manager and not normalized(manager.get("userPrincipalName")):
        raise ValueError("Graph returned a manager without a UPN. Resolve permissions or supply an authoritative directory; the manager link will not be silently erased.")
    org = user.get("employeeOrgData") or {}
    if not isinstance(org, dict):
        raise ValueError("Unexpected employeeOrgData payload.")
    return {
        "PersonId": upn, "DisplayName": user.get("displayName"),
        "GivenName": user.get("givenName"), "Surname": user.get("surname"), "Email": user.get("mail"),
        "Organization": user.get("department"), "Company": user.get("companyName"),
        "Division": org.get("division"), "JobTitle": user.get("jobTitle"),
        "Country": user.get("country"), "City": user.get("city"), "Office": user.get("officeLocation"),
        "ManagerUPN": normalized((manager or {}).get("userPrincipalName")) or None,
        "ManagerName": (manager or {}).get("displayName"),
    }


def run_directory(spark, config):
    require_lakehouse()
    client = GraphClient(config["TENANT_ID"], config["CLIENT_ID"], config["KEY_VAULT_URL"], config["SECRET_NAME"])
    fields = "id,userPrincipalName,displayName,givenName,surname,mail,department,jobTitle,companyName,employeeOrgData,officeLocation,city,country"
    url = "https://graph.microsoft.com/v1.0/users?$select=" + fields + "&$expand=manager($select=userPrincipalName,displayName)&$top=999"
    rows = [directory_record(user) for user in client.pages(url)]
    if not rows:
        raise ValueError("Graph directory is empty; the prior snapshot will not be replaced.")
    schema = ", ".join(name + " string" for name in rows[0])
    frame = spark.createDataFrame(rows, schema)
    require_unique(frame, ["PersonId"], "Directory UPNs")
    from pyspark.sql import functions as F
    frame = frame.withColumn("TenantId", F.lit(normalized(config["TENANT_ID"])))
    write_snapshot(spark, frame, config["OUTPUT_TABLE"], config["RUN_ID"] or str(uuid.uuid4()))
