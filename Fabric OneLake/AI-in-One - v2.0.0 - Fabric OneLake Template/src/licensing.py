"""Current licensing snapshot from the existing Microsoft 365 active-user report."""


def license_record(row, product_names):
    upn = normalized(row.get("User Principal Name"))
    if not upn or "@" not in upn:
        raise ValueError("Licensing report UPNs are blank or concealed. Configure identifiable report data through an approved administrator.")
    if "Assigned Products" not in row:
        raise ValueError("Licensing report is missing Assigned Products; cannot classify licenses.")
    raw = (row["Assigned Products"] or "").strip()
    names = {name.strip().upper() for name in re.split(r"[+;]", raw) if name.strip()}
    status = "Unknown" if not raw else ("TRUE" if names & product_names else "FALSE")
    return {"PersonId": upn, "Has_license": status, "ReportRefreshDate": row.get("Report Refresh Date")}


def run_licensing(spark, config):
    require_lakehouse()
    if config["REPORT_PERIOD"] not in ("D7", "D30", "D90", "D180"):
        raise ValueError("REPORT_PERIOD must be D7, D30, D90 or D180.")
    client = GraphClient(config["TENANT_ID"], config["CLIENT_ID"], config["KEY_VAULT_URL"], config["SECRET_NAME"])
    url = f"https://graph.microsoft.com/v1.0/reports/getOffice365ActiveUserDetail(period='{config['REPORT_PERIOD']}')"
    response = client.request("GET", url)
    if response.status_code == 302:
        download = response.headers.get("Location", "")
        if urlparse(download).scheme != "https":
            raise ValueError("Report redirect is not HTTPS.")
        response = requests.get(download, timeout=120)
        if response.status_code != 200:
            raise RuntimeError(f"Report download failed: HTTP {response.status_code}.")
    response.encoding = "utf-8-sig"
    reader = csv.DictReader(io.StringIO(response.text.lstrip("\ufeff")))
    if not {"User Principal Name", "Assigned Products"}.issubset(reader.fieldnames or []):
        raise ValueError("The licensing CSV is missing its expected identity or product columns.")
    product_names = {name.strip().upper() for name in config["COPILOT_PRODUCT_NAMES"].split("|") if name.strip()}
    if not product_names:
        raise ValueError("At least one exact Copilot product label is required.")
    rows = [license_record(row, product_names) for row in reader]
    if not rows:
        raise ValueError("Licensing report is empty; the prior snapshot will not be replaced.")
    frame = spark.createDataFrame(rows, "PersonId string, Has_license string, ReportRefreshDate string").dropDuplicates()
    require_unique(frame, ["PersonId"], "Licensing UPNs")
    from pyspark.sql import functions as F
    frame = frame.withColumn("TenantId", F.lit(normalized(config["TENANT_ID"])))
    write_snapshot(spark, frame, config["OUTPUT_TABLE"], config["RUN_ID"] or str(uuid.uuid4()))
