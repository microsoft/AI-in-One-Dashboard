# Copilot Interactions Audit Log Scripts

This folder contains PowerShell scripts to retrieve and export Microsoft Copilot interaction audit logs from Microsoft 365 using the Microsoft Graph API.

## Prerequisites

- PowerShell 5.1 or higher
- Microsoft.Graph.Beta.Security PowerShell module (automatically installed by scripts)
- Microsoft 365 tenant with appropriate permissions
- Account with `AuditLogsQuery.Read.All` scope access

## Scripts

### 1. `create-query.ps1`

**Purpose**: Creates a new audit log query with specified date range and optional filters.

**Usage**:
```powershell
# With defaults (last 7 days)
./create-query.ps1

# With custom date range
./create-query.ps1 -startDate "2025-11-01" -endDate "2025-12-01"
```

**What it does**:
- Connects to Microsoft Graph
- Creates a new audit log query for CopilotInteraction records
- Query name is auto-generated from start and end dates
- Supports optional filtering by user principal name (UPN)
- Returns the query ID for use in other scripts

**Key Parameters**:
- `$startDate`: Query start date (default: 7 days ago)
- `$endDate`: Query end date (default: today)
- `$queryName`: Auto-generated from date range

**Output**:
- Query ID displayed in console
- Use this ID with `get-copilot-interactions.ps1`

**Function**: `CreateAuditLogQuery`
- `displayName` (required): Name for the query
- `filterStartDateTime` (required): Start date/time
- `filterEndDateTime` (required): End date/time
- `userPrincipalNameFilters` (optional): Array of user UPNs to filter

---

### 2. `get-copilot-interactions.ps1`

**Purpose**: Retrieves completed audit log query results and exports them to CSV with incremental streaming.

**Usage**:
```powershell
./get-copilot-interactions.ps1 -AuditLogQueryId "0008ebf6-7ffc-43f1-ae84-ab65cf312733"
```

**What it does**:
- Connects to Microsoft Graph
- Checks if the audit log query has completed
- Retrieves query results with automatic pagination handling
- Streams results directly to CSV file (memory efficient for 1M+ records)
- Flushes data after each page to ensure persistence

**Key Parameters**:
- `$AuditLogQueryId`: The query ID from `create-query.ps1` (update this in the script)
- `$outputCSV`: Auto-generated filename with timestamp and query ID

**Output**:
- CSV file named: `CopilotInteractionsReport-[timestamp]-[queryId].csv`
- Headers: service, objectId, id, administrativeUnits, operation, clientIp, userId, organizationId, userType, userPrincipalName, auditLogRecordType, auditData, createdDateTime
- Each row contains one audit log record with nested JSON in `auditData` column

**Functions**:
- `GetCopilotInteractionsAndExport`: Fetches and streams records to CSV
- `CheckIfQuerySucceeded`: Verifies query completion status

**Key Features**:
- **Incremental Export**: Writes directly to CSV as pages are retrieved (no memory buildup)
- **Pagination Support**: Automatically handles Microsoft Graph pagination
- **JSON Serialization**: Nested objects converted to JSON with depth support
- **Progress Tracking**: Displays record count and status messages
- **UTF-8 Encoding**: Proper character encoding for international characters


---

### 3. `get-copilot-users.ps1`

**Purpose**: Retrieves list of users who have interacted with Copilot.

**Usage**:
```powershell
# With defaults
./get-copilot-users.ps1

# With custom values
./get-copilot-users.ps1 -outputCSV ".\MyCustomName.csv" -tempCSVLocation ".\custom-temp.csv"
```

**What it does**:
- Connects to Microsoft Graph
- Queries audit logs for CopilotInteraction records
- Extracts unique users
- Exports user list to CSV

**Output**:
- CSV file with user information and interaction statistics

---

## Workflow

### Basic Usage Flow

1. **Create a new query**:
   ```powershell
   ./create-query.ps1
   # Note the returned Query ID
   ```

2. **Wait for query completion** (queries can take minutes to hours depending on data volume)

3. **Export results**:
   ```powershell
   # Update $AuditLogQueryId in the script with the ID from step 1
   ./get-copilot-interactions.ps1 -AuditLogQueryId "0008ebf6-7ffc-43f1-ae84-ab65cf312733"
   ```

4. **Analyze the CSV**:
   - Open in Excel, Power BI, or your analysis tool
   - AuditData column contains detailed interaction JSON


## Output Format

### CSV Columns

| Column | Type | Description |
|--------|------|-------------|
| service | string | Service name (Copilot) |
| objectId | string/null | Object ID |
| id | string | Unique record ID |
| administrativeUnits | array | Administrative units |
| operation | string | Operation type (CopilotInteraction) |
| clientIp | string/null | Client IP address |
| userId | string | User ID (GUID) |
| organizationId | string | Organization ID (GUID) |
| userType | string | User type (Regular, etc.) |
| userPrincipalName | string | User email address |
| auditLogRecordType | string | Record type (CopilotInteraction) |
| auditData | JSON | Nested audit data (see below) |
| createdDateTime | datetime | Record creation timestamp |

### auditData JSON Structure

Contains detailed interaction information:
```json
{
  "Operation": "CopilotInteraction",
  "Workload": "Copilot",
  "Id": "record-id",
  "ClientIP": "ip-address",
  "ClientRegion": "region",
  "UserId": "user@company.com",
  "AppIdentity": "copilot-agent-id",
  "CopilotLogVersion": "1.0.0.0",
  "CopilotEventData": {
    "AppHost": "Copilot Studio|Word|Teams|etc.",
    "ThreadId": "Teams thread ID",
    "Messages": "message data",
    "AccessedResources": "resources accessed"
  }
}
```

## Performance Considerations

- **Large datasets**: Scripts are optimized for 1M+ records using streaming export
- **Query wait time**: Audit log queries can take 5-60 minutes depending on data volume
- **CSV file size**: Expect 100-500 bytes per record
- **Memory usage**: Stays constant regardless of dataset size due to streaming approach

## Troubleshooting

### "Query status: pending"
The audit log query is still processing. Wait a few minutes and run `get-copilot-interactions.ps1` again.

## Contact

For questions or issues, contact: alexgrover@microsoft.com
