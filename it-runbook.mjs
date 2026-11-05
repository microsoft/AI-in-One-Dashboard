export function renderItRunbook(h) {
  const { e, icon, pageHead, external, button, dl, release, searchAttr } = h;
  const routes = release.templates;
  const template = id => {
    const item = routes.find(route => route.id === id);
    if (!item || item.status !== 'available' || !item.href) throw new Error(`Missing available IT template: ${id}`);
    return external(`Download ${item.title} template`, item.href, 'button button-secondary');
  };
  const code = (text, language = 'powershell') => `<pre class="it-code"><code class="language-${language}">${e(text)}</code></pre>`;
  const editionTag = `<span class="it-edition-tag"><span class="sr-only">Edition: </span><span data-it-current-route>${e(routes[0].title)}</span></span>`;
  const section = (id, number, title, body, attributes = '') => `<section class="it-runbook-section" ${searchAttr(id, title)} ${attributes}><header><span class="it-step-number" aria-hidden="true">${number}</span><h2>${title}</h2>${body.includes('data-it-routes=') ? editionTag : ''}</header>${body}</section>`;
  const table = (heads, rows, rowAttributes = []) => `<div class="table-wrap" tabindex="0" role="region" aria-label="${e(heads.join(', '))}"><table><thead><tr>${heads.map(head => `<th scope="col">${e(head)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, rowIndex) => `<tr ${rowAttributes[rowIndex] || ''}>${row.map((cell, index) => `<${index ? 'td' : 'th scope="row"'}>${cell}</${index ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const select = (name, label, options, extra = '') => `<label class="it-request-field" for="it-${name}"><span>${label}</span><select id="it-${name}" name="${name}" ${extra}>${options.map(([value, text]) => `<option value="${value}">${e(text)}</option>`).join('')}</select></label>`;
  const text = (name, label, extra = '') => `<label class="it-request-field" for="it-${name}"><span>${label}</span><textarea id="it-${name}" name="${name}" rows="2" ${extra}></textarea></label>`;
  const sharedSql = `<p>Share the Lakehouse/SQL endpoint with the refresh identity using item <strong>Read</strong>, then grant <code>SELECT</code> on only the prepared tables. Broad “Read all with SQL” also exposes other tables, including raw data; do not grant Spark read-all merely for report refresh.</p>`;
  const certificate = `# Run as the identity that will own the scheduled task.
# IT supplies a certificate with a usable private key in that account's
# CurrentUser store or the approved LocalMachine store.
$Auth = @{
    Auth = 'AppRegistration'
    TenantId = '<tenant GUID>'
    ClientId = '<application client GUID>'
    ClientCertificateThumbprint = '<certificate thumbprint>'
    ClientCertificateStoreLocation = 'LocalMachine'
}
if ($env:GRAPH_CLIENT_SECRET) {
    throw 'Remove the unintended secret from this certificate-only task environment.'
}`;
  const seed = destination => `$Pax = 'C:\\PAX\\<actual downloaded script filename>.ps1'
$Seed = @{
    Dashboard = 'AIO'
    StartDate = '<inclusive start YYYY-MM-DD>'
    EndDate = '<exclusive end YYYY-MM-DD>'
    UserHistory = 'On' # New guided datasets retain observed license states.
}
$Destination = '${destination}'`;
  const append = (sharepoint, tables = false) => `$Pax = 'C:\\PAX\\<actual downloaded script filename>.ps1'
$Update = @{
    Dashboard = 'AIO'
    Watermark = $true
    UserHistory = 'On' # Must match the existing Users history; do not silently convert Off.
    AppendFile = '${tables ? 'https://onelake.dfs.fabric.microsoft.com/<workspace-id>/<lakehouse-id>/Tables/<schema>/AIO_CopilotInteractions' : `<${sharepoint ? 'direct HTTPS URL' : 'full local path'} to processed Interactions CSV>`}'
    AppendUserInfo = '${tables ? 'https://onelake.dfs.fabric.microsoft.com/<workspace-id>/<lakehouse-id>/Tables/<schema>/AIO_Users' : `<${sharepoint ? 'direct HTTPS URL' : 'full local path'} to matching processed Users CSV>`}'
}
# If this dataset uses the catalog, also set:
# $Update.AppendAgent365Info = '${tables ? 'https://onelake.dfs.fabric.microsoft.com/<workspace-id>/<lakehouse-id>/Tables/<schema>/Agent365' : `<exact matching processed Agent365 CSV ${sharepoint ? 'URL' : 'path'}>`}'
# Do not add StartDate or EndDate to Watermark.
# Only a history with NO saved watermark needs WatermarkStartDate.`;
  const invocation = update => `<div data-it-auth="manual">${code(`& $Pax @${update ? 'Update' : 'Seed -OutputPath $Destination'}`)}</div>
    <div data-it-auth="certificate">${code(`& $Pax @${update ? 'Update' : 'Seed'} @Auth${update ? ' -Force' : ' -OutputPath $Destination'}`)}</div>
    <div data-it-auth="secret">${code(`& $Pax @${update ? 'Update' : 'Seed'} -Auth AppRegistration${update ? ' -Force' : ' -OutputPath $Destination'}`)}</div>
    <div data-it-auth="identity">${code(`& $Pax @${update ? 'Update' : 'Seed'} -Auth ManagedIdentity${update ? ' -Force' : ' -OutputPath $Destination'}`)}</div>`;
  const siteGrant = `POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
Content-Type: application/json

{
  "roles": ["write"],
  "grantedToIdentities": [{
    "application": {
      "id": "<collector application client ID>",
      "displayName": "AIO PAX collector"
    }
  }]
}`;
  const notebookConfig = `# Set in the first parameter cell of ALL THREE collector notebooks.
TENANT_ID = "<source tenant GUID>"
CLIENT_ID = "<Graph application client GUID>"
KEY_VAULT_URL = "https://<vault-name>.vault.azure.net/"
SECRET_NAME = "<name holding the client-secret VALUE>"
RUN_ID = ""  # Manual runs can use generated UUIDs.

# Audit notebook: first historical collection uses an explicit UTC window.
MODE = "backfill"
START_UTC = "<inclusive start, e.g. 2026-10-01T00:00:00Z>"
END_UTC = "<exclusive end, e.g. 2026-11-01T00:00:00Z>"
# After this first backfill, use MODE = "incremental".
# Keep OVERLAP_DAYS = 7; the audit merge deduplicates TenantId + RecordId.

# Preparation notebook: set TENANT_ID to the same tenant.
# Keep default raw/output table names; RUN_ID = "" for manual collections.`;
  const sql = (pax = false) => `-- Run by a SQL administrator on the Lakehouse SQL analytics endpoint.
-- Use the actual schema (dbo shown) and approved refresh principal.
GRANT SELECT ON OBJECT::dbo.${pax ? 'AIO_Users' : 'aio_v2_users'} TO [<refresh-user@contoso.com>];
GRANT SELECT ON OBJECT::dbo.${pax ? 'AIO_CopilotInteractions' : 'aio_v2_interactions'} TO [<refresh-user@contoso.com>];
${pax ? '-- If the PAX catalog is enabled:\n-- GRANT SELECT ON OBJECT::dbo.Agent365 TO [<refresh-user@contoso.com>];' : 'GRANT SELECT ON OBJECT::dbo.aio_v2_publication TO [<refresh-user@contoso.com>];'}`;
  return `<div class="it-runbook">
  ${pageHead('AI-in-One deployment', 'IT deployment runbook', 'Configure collection, permissions, report access and refresh. Choose the edition to show only its deployment instructions.')}
  <div class="container it-runbook-controls"><div class="it-route-select">${select('runbook-route', 'Storage tier / edition', routes.map(route => [route.id, route.title]))}</div><a class="text-link it-request-shortcut" href="#it-request">Prepare a note for IT ${icon('arrow')}</a></div>
  <div class="container it-runbook-layout">
  <nav class="it-runbook-nav" aria-label="IT deployment steps"><a href="#administrator">Prepare the environment</a><a href="#permissions">Grant permissions</a><a href="#collection">Collect the data</a><a href="#report-connection">Connect the report</a><a href="#refresh">Publish and refresh</a><a href="#recurring">Operate and recover</a><a href="#acceptance">Check the handover</a><a href="#it-request">Note for IT (optional)</a></nav>
  <div class="it-runbook-content">
  ${section('administrator', '1', 'Prepare the environment', `
    <div data-it-routes="sharepoint local pax-fabric"><ol><li>Install ${external('PowerShell 7+', 'https://aka.ms/PowerShell')} and ${external('Python 3.10+', 'https://www.python.org/downloads/')} on the collection computer. Allow approved module/package installation, outbound Graph/storage access and a writable working folder. PowerShell must use FullLanguage mode.</li><li>${dl('pax-script', 'Download the PAX v2 script')} and keep its actual filename and version.</li><li>Run as the intended collection account. Check <code>$PSVersionTable.PSVersion</code>, <code>$ExecutionContext.SessionState.LanguageMode</code> and <code>python --version</code>.</li></ol><p data-it-routes="pax-fabric">Fabric Delta output also requires Az.Accounts, pyarrow and deltalake, an active Fabric capacity and a target Lakehouse.</p></div>
    <div data-it-routes="fabric"><h3>Prepare Fabric</h3><ol><li>Use an active Fabric-capable capacity and a workspace with a dedicated Lakehouse. PPU alone is not a notebook/Lakehouse capacity.</li><li>Give the actual notebook execution identity workspace Contributor or higher and the required Key Vault secret-read access. An interactive run and a scheduled/pipeline run may use different identities; test the configured execution connection.</li><li>Reserve the same default Lakehouse for all four imported notebooks. Do not overlap collection/preparation with the report refresh.</li></ol></div>
    <p><strong>Agree the reporting scope:</strong> dates, people, viewer access and refresh frequency must follow the organization's approvals. Identify the collection operator and report owner; keep credentials out of tickets and this site.</p>
  `)}
  ${section('permissions', '2', 'Grant collection and storage permissions', `
    <div data-it-routes="sharepoint local pax-fabric">
      <label class="it-request-field" for="it-auth-path"><span>PAX sign-in method</span><select id="it-auth-path"><option value="manual">Manual browser / device code</option><option value="certificate">Unattended app registration + certificate</option><option value="secret">Unattended app registration + environment secret</option><option value="identity">Managed identity on its Azure host</option></select></label>
      <h3>Source and storage permissions</h3>${table(['Feature', 'Required permission / access', 'When it applies'], [
        ['AIO live audit', '<code>AuditLogsQuery.Read.All</code>', 'Delegated for manual sign-in; Application for app-only'],
        ['Live people and licensing', '<code>User.Read.All</code>, <code>Organization.Read.All</code>', 'Same permission type as the chosen sign-in method'],
        ['People/group expansion', '<code>GroupMember.Read.All</code>', 'If GroupNames or Copilot access-group qualification is selected'],
        ['Agent 365 catalog', '<code>CopilotPackages.Read.All</code>', 'Catalog requires Agent 365 service/license eligibility; delegated callers also need a supported administrator role'],
        ['Catalog creator enrichment', '<code>Application.Read.All</code>', 'Requested by the current guided/catalog workflow; not the catalog API minimum'],
        ['Email notification', '<code>Mail.Send</code>', 'Only if PAX notifications are enabled'],
        ['SharePoint uploads', 'Microsoft Graph <strong>Delegated</strong> <code>Sites.ReadWrite.All</code>', 'Manual sign-in; the collection account also needs library/folder Edit access'],
        ['SharePoint uploads', 'Microsoft Graph <strong>Application</strong> <code>Sites.Selected</code> + a site-specific <strong>write</strong> grant', 'App or managed identity; consent alone does not grant site access'],
        ['SharePoint report refresh', '<strong>Read</strong> access to every processed CSV', 'The Power BI refresh account does not need collector write permissions']
      ], { 6: 'data-it-routes="sharepoint" data-it-auth="manual"', 7: 'data-it-routes="sharepoint" data-it-auth="certificate secret identity"', 8: 'data-it-routes="sharepoint"' })}
      <article id="delegated-permissions" data-it-auth="manual"><h3>Manual browser / device code</h3><ol><li>Use PAX's default browser sign-in, or <code>-Auth DeviceCode</code>. Authorize the requested delegated scopes with tenant administrator consent as required.</li><li>The reviewed PAX implementation uses the Graph PowerShell default application for these modes. A new custom app registration, client ID or Redirect URI is <strong>not</strong> selected by supplying PAX tenant/client flags.</li><li>Assign the operator the approved audit-search authorization. Microsoft documents Purview Audit Reader/Audit Manager for search/export and Security Reader/Administrator for general delegated Graph Security access. Prove an audit query with the intended account; do not substitute a Global Administrator account as the standard operator.</li><li>For delegated catalog collection, verify AI Administrator or Global Administrator and Agent 365 entitlement. For scheduled collection, choose app-only instead; browser/device modes require a person.</li></ol></article>
      <article id="application-permissions" data-it-auth="certificate secret"><h3>Register an unattended application</h3><ol><li>Entra admin center → <strong>App registrations → New registration</strong>. Select the source organization's single tenant. Record <strong>Directory (tenant) ID</strong> and <strong>Application (client) ID</strong>, not the app object ID. Client-credentials sign-in needs no interactive Redirect URI or public-client setting.</li><li><strong>API permissions → Add a permission → Microsoft Graph → Application permissions</strong>. Add only the applicable entries in the matrix. Have an authorized tenant administrator grant admin consent; confirm “Granted for” the source tenant. Privileged Role Administrator can grant Graph application permissions; Application/Cloud Application Administrator alone is not sufficient for Graph app roles.</li><li data-it-auth="certificate">In <strong>Certificates &amp; secrets → Certificates</strong>, upload the public certificate. Install its corresponding private key for the scheduled account, grant that account private-key access, and record thumbprint/store. Keep <code>GRAPH_CLIENT_SECRET</code> out of the certificate-only process because a secret can take precedence.</li><li data-it-auth="secret">In <strong>Certificates &amp; secrets → Client secrets</strong>, create the approved short-lived credential. Store its <strong>Value</strong>, not secret ID, in the organization's secret store. Inject <code>GRAPH_TENANT_ID</code>, <code>GRAPH_CLIENT_ID</code> and <code>GRAPH_CLIENT_SECRET</code> into the task's process. Do not put secret values in scripts, URLs, tickets or Mini-Kitchen.</li><li>Record rotation/expiry ownership. Validate authentication as the actual task identity before enabling a schedule.</li></ol></article>
      <div data-it-auth="certificate">${code(certificate)}</div>
      <article data-it-auth="identity"><h3>Azure managed identity</h3><ol><li>Assign the managed identity to the Azure PowerShell host. Grant the applicable Graph application roles with tenant administrator consent to its service principal; there is no client secret and it is not configured under App registrations.</li><li>Use <code>-Auth ManagedIdentity</code>. For a user-assigned identity, configure <code>AZURE_CLIENT_ID</code> on the host; do not use <code>-ClientId</code> to select it.</li><li>Grant destination access independently and run a collection using that resource's identity. A laptop cannot impersonate the host's managed identity.</li></ol></article>
    </div>
    <div data-it-routes="fabric" id="notebook-permissions"><h3>Notebook Graph application + Key Vault</h3><ol><li>Register a single-tenant app in the source tenant. Add Microsoft Graph <strong>Application</strong> permissions <code>AuditLogsQuery.Read.All</code>, <code>User.Read.All</code> and <code>Reports.Read.All</code>; grant tenant administrator consent.</li><li>Create a client secret and store its <strong>Value</strong> in Azure Key Vault under an IT-chosen secret name. The supplied collectors implement client-secret authentication; choosing a certificate without adapting them will not work.</li><li>Grant the <strong>notebook execution identity</strong> <em>Key Vault Secrets User</em> in an RBAC vault, or secret Get in an access-policy vault. Key Vault Reader/Contributor does not grant secret-value reads. Confirm networking allows access.</li><li>Keep tenant/client IDs as notebook parameters. Only the client-secret value must be in Key Vault. Plan rotation and test the actual scheduled execution connection.</li></ol></div>
    <article id="sharepoint-permissions" class="it-storage-permissions" data-it-routes="sharepoint"><h3>SharePoint storage permissions</h3>
      <p>Apply the SharePoint permissions listed above to the destination site and library. Prepare the output folder before collection.</p>
      <div data-it-auth="manual"><ol><li>Consent to Microsoft Graph <strong>Delegated</strong> <code>Sites.ReadWrite.All</code> for the PAX sign-in application.</li><li>Give the signed-in collection account <strong>Edit</strong> access to the destination library/folder. Graph consent does not give the user access to a site.</li></ol></div>
      <div data-it-auth="certificate secret identity"><ol><li>Add Microsoft Graph <strong>Application</strong> <code>Sites.Selected</code> to the collector app (or the managed identity's service principal), and grant administrator consent.</li><li>Separately grant that principal <strong>write</strong> on the destination site using the site's ID and the collector's application/client ID. Consent to Sites.Selected alone grants <strong>no site access</strong>.</li></ol>
        <p>An authorized grant administrator can use the request below. Their Graph session needs <code>Sites.FullControl.All</code>; a delegated administrator also needs SharePoint Administrator or higher and membership of the target site. This elevated permission is for the <strong>granting session, not the collector</strong>.</p>
        ${code(siteGrant, 'http')}
        <p>If an existing policy-approved collector already uses Application <code>Sites.ReadWrite.All</code>, it has tenant-wide site-write access and does not also need a Selected-site grant. Prefer the site-scoped grant for a new deployment.</p>
      </div>
      <p><strong>Report refresh:</strong> give the report's organizational account <strong>Read</strong> access to every processed CSV in the library. It does not need the collector's write permission. Test an upload as the collector and a file read as the refresh account.</p>
      <nav class="kitchen-reference-links" aria-label="SharePoint permission references">${external('Selected permissions', 'https://learn.microsoft.com/en-us/graph/permissions-selected-overview')}${external('Grant site access', 'https://learn.microsoft.com/en-us/graph/api/site-post-permissions?view=graph-rest-1.0')}</nav>
    </article>
    <div class="it-storage-permissions" data-it-routes="local"><h3>Local file access</h3><p>The collection account needs write access to the output folder; the Desktop reader needs read access. Service refresh also needs an available gateway and file-source credentials that can read the same files.</p></div>
    <div class="it-storage-permissions" data-it-routes="fabric pax-fabric"><h3>OneLake storage and SQL access</h3><p>The collection/notebook execution identity needs workspace Contributor or higher. App or managed-identity access also requires the applicable scoped Fabric tenant setting. The report-refresh identity needs Lakehouse/SQL endpoint <strong>Read</strong> and <strong>SELECT on prepared tables only</strong>; the grants are in step 4. Graph consent does not grant these storage permissions.</p></div>
    <nav class="kitchen-reference-links" aria-label="Identity references">${external('Graph audit query permissions', 'https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0')}<span data-it-routes="sharepoint local pax-fabric">${external('App-only Graph PowerShell', 'https://learn.microsoft.com/en-us/powershell/microsoftgraph/app-only')}</span>${external('Admin consent', 'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent')}<span data-it-routes="fabric">${external('Key Vault secret access', 'https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide')}</span></nav>
  `)}
  ${section('collection', '3', 'Collect and verify the report inputs', `
    <div data-it-routes="sharepoint local pax-fabric"><h3>First PAX collection</h3><ol><li>Confirm audit logging and available retention for the approved UTC window. Start is inclusive; EndDate is exclusive. Expired records cannot be recovered by choosing older dates.</li><li>Use <a href="get-started.html">AIO's command builder</a> or adapt the example below. <code>-Dashboard AIO</code> includes Users collection, rollup and combined output. For a restricted population use the builder's people/group fields.</li><li>Add <code>-IncludeAgent365Info</code> only if the optional catalog is licensed and authorized. Run in PowerShell 7, then check successful completion and the reported <strong>processed</strong> Users/Interactions/catalog paths. Raw exports and partial outputs are not report inputs.</li></ol>
    <div data-it-routes="sharepoint">${code(seed('<direct HTTPS URL to the destination SharePoint folder>'))}</div>
    <div data-it-routes="local">${code(seed('C:\\PAX\\<output folder>'))}</div>
    <div data-it-routes="pax-fabric">${code(seed('https://onelake.dfs.fabric.microsoft.com/<workspace-id>/<lakehouse-id>'))}</div>
    <p>Run with the sign-in method configured in step 2:</p>${invocation(false)}
    <p>PAX creates a run log automatically; <code>-OutputPathLog</code> only overrides its destination. Keep log/output destinations on the same storage tier.<span data-it-routes="pax-fabric"> OneLake logs go under Files.</span></p>
    <div data-it-routes="local sharepoint pax-fabric"><h3>Later updates: catch up the same history</h3><div data-it-routes="sharepoint">${code(append(true))}</div><div data-it-routes="local">${code(append(false))}</div><div data-it-routes="pax-fabric">${code(append(false, true))}</div>${invocation(true)}<p>Do not combine OutputPath and AppendFile. The PAX v2.0 release workflow establishes watermark state only after the complete dated seed verifies. Later catch-up needs no start/end dates or WatermarkStartDate. An older history with no state needs a genuine first day; an existing state refuses that bootstrap override.</p><p>Retain the existing UserHistory, schema and privacy settings. New guided histories use On, but an existing Off history must not be silently converted. Observations cannot reconstruct license changes from before collection began. Use the existing matching Users and optional catalog append targets; do not redirect them to fresh timestamped outputs.</p><p data-it-auth="certificate secret identity">Save the validated command in a protected wrapper and schedule <code>pwsh.exe -NoProfile -File &lt;wrapper.ps1&gt;</code> as the approved task identity. Keep runs non-overlapping; progress advances only after successful complete-set publication.</p></div>
    <div data-it-routes="pax-fabric"><h3>Fabric Tables destination</h3><p>For a seed, set OutputPath to <code>https://onelake.dfs.fabric.microsoft.com/&lt;workspace-id&gt;/&lt;lakehouse-id&gt;</code>, not a table leaf, Fabric portal URL or Files CSV path. A non-default schema uses the supported Tables/schema destination. PAX prepares <code>AIO_Users</code> and <code>AIO_CopilotInteractions</code>, plus <code>Agent365</code> if selected. Updates name those same table paths with the appropriate append switches.</p><p>Commands here target the PAX v2.0 production release contract, including Tables append and watermark. The download remains the current prerelease until formal release; retain its actual identity and verify that the build used supports the intended workflow. Graph authentication does not grant OneLake access; validate the separate storage context.</p></div></div>
    <div data-it-routes="fabric"><h3>Deploy the supplied self-contained notebooks</h3><ol><li>Import <code>Copilot_Audit_Log_Direct_Ingester.ipynb</code>, <code>Copilot_Org_Data_Direct_Ingester.ipynb</code>, <code>Copilot_Licensed_Users_Direct_Ingester.ipynb</code> and <code>Copilot_Report_Data_Preparation.ipynb</code>. Attach and pin the same default Lakehouse in all four. No src/scripts uploads or shared-import notebook are required.</li><li>Set the first parameter cell in all three collectors as below. Set TENANT_ID in preparation to the same tenant; retain its default raw/output names. Use dbo in schema-enabled Lakehouses.</li><li>With Power BI refresh paused, run audit, organization and licensing collectors successfully, then preparation. Verify known manager UPNs, identifiable licensing report UPNs and its Report Refresh Date. Inputs must pass the package's freshness checks; do not bypass privacy settings or fabricate hierarchy links.</li><li>The collectors write raw tables; preparation publishes <code>aio_v2_users</code>, <code>aio_v2_interactions</code> and <code>aio_v2_publication</code>. Wait for matching Ready generation/counts in the SQL endpoint, not merely Delta storage.</li></ol>${code(notebookConfig, 'python')}
      <p><strong>Recurring runs:</strong> set audit MODE to incremental after backfill. The three collectors may run in parallel; preparation runs only when all succeed. The provided pipeline needs your workspace/notebook IDs and parameters <code>TENANT_ID</code>, <code>CLIENT_ID</code>, <code>KEY_VAULT_URL</code>, <code>SECRET_NAME</code>, <code>RunId</code> and <code>EnableOrgDataPull</code>. It does not publish or refresh Power BI. Keep execution and model refresh non-overlapping.</p>
      <p>Manager expansion and licensing reports must work in the source tenant with its approved visibility. If those acceptance checks fail, resolve the supported source/permissions with IT; do not grant broader directory access blindly or silently remove relationships.</p>
      <p><strong>Optional Agent 365 catalog:</strong> these notebooks do not collect it. A separate PAX collection can supply a processed SharePoint CSV; use ${external('the SharePoint collection and permissions instructions', 'setup-reference.html?edition=sharepoint#permissions')}. Supply its direct URL to the template and update it before report refresh. Leave the parameter blank when no catalog is needed.</p>
      <nav class="kitchen-reference-links" aria-label="Notebook deployment files">${dl('notebook-audit')}${dl('notebook-org')}${dl('notebook-licenses')}${dl('notebook-prepare')}${dl('pipeline')}${dl('fabric-guide')}</nav>
    </div>
  `)}
  ${section('report-connection', '4', 'Open the matching template', `
    <p>Install current Power BI Desktop for the report owner. Set Minimum Group Size to <strong>3</strong>, or 1 only with the organization's individual-detail approval. Select Load and use approved source-reader credentials.</p>
    <article id="sharepoint-setup" data-it-routes="sharepoint"><h3>SharePoint</h3><p>For each processed CSV use the library item's <strong>Details → Path</strong>, not a sharing/view link.</p>${table(['Parameter', 'Value'], [['Copilot Interactions File', 'Direct HTTPS path to processed Interactions CSV'], ['Org Data File', 'Direct HTTPS path to matching processed Users CSV'], ['Agent 365 (highly recommended)', 'Direct catalog CSV path if used; otherwise blank']])}<p>Use an organizational account with read access. Configure its OAuth2/cloud credentials for all file sources after publishing. Directly reachable SharePoint Online CSVs normally need no on-premises gateway; cross-tenant OAuth scenarios can be restricted.</p>${template('sharepoint')}</article>
    <article id="local-setup" data-it-routes="local"><h3>Local CSV</h3>${table(['Parameter', 'Value'], [['Copilot Interactions File', 'Full processed Interactions CSV path'], ['Org Data File', 'Full matching processed Users CSV path'], ['Agent 365 (highly recommended)', 'Full catalog CSV path if used; otherwise blank']])}<p>Remove surrounding quotes from Copy as path. Desktop reads local files; the Service needs a configured gateway on an available computer that can read the same paths. Publishing a PBIX does not make laptop files reachable.</p>${template('local')}</article>
    <article id="fabric-notebooks" data-it-routes="fabric"><h3>Fabric OneLake: Notebooks</h3>${sharedSql}${code(sql(), 'sql')}${table(['Parameter', 'Value'], [['Fabric SQL Endpoint', 'SQL analytics endpoint hostname, no https://'], ['Fabric Lakehouse', 'Actual SQL database/Lakehouse name'], ['Agent 365 (highly recommended)', 'Optional direct SharePoint catalog CSV; configure its separate credentials']])}<p>Imports the three aio_v2_* tables. Verify one Ready publication row and a common SnapshotId matching both outputs. SQL synchronization is asynchronous; use generation/count checks, not a fixed wait timer.</p>${template('fabric')}</article>
    <article id="fabric-pax" data-it-routes="pax-fabric"><h3>Fabric OneLake: PAX</h3>${sharedSql}${code(sql(true), 'sql')}${table(['Parameter', 'Value'], [['Fabric SQL Endpoint', 'SQL analytics endpoint hostname, no https://'], ['Fabric Lakehouse', 'Actual database name'], ['PAX SQL Schema', 'Physical schema containing the PAX tables, usually dbo'], ['Load Agent365 catalog', 'False unless the matching Agent365 table is synchronized and readable']])}<p>This uses PAX-produced AIO_* tables, not notebook outputs or a SharePoint catalog. Independent table reads/schema checks do not prove an atomic publication; all writes must remain paused through SQL Import refresh.</p>${template('pax-fabric')}</article>
    <p data-it-routes="fabric pax-fabric">This template uses <strong>SQL Import, not Direct Lake</strong>. Use supported Microsoft Entra SQL authentication, not SQL username/password. Configure the precise hostname/database connection.</p>
  `)}
  ${section('refresh', '5', 'Publish, secure and schedule', `
    <ol><li>Publish to the approved Power BI workspace as the intended semantic-model owner. Confirm the publisher's license and a compatible viewer license/capacity model. Pro/shared workspaces need suitable paid viewer licenses; PPU workspaces need PPU; F64+ or qualifying Premium capacity can support Free viewers.</li><li>Semantic model → <strong>Settings → Gateway and cloud connections</strong>: map the exact cloud source or gateway, configure approved reader credentials, run Refresh now, and inspect refresh history. The model owner configures schedule/credentials; merely granting write/refresh permission is not equivalent.</li><li>Semantic model → <strong>Security</strong>: assign the approved audiences to <strong>Reporting hierarchy</strong> (their own organization) or <strong>All data viewers</strong> (unrestricted dataset). Roles are additive; All data viewers overrides the intended hierarchy restriction.</li><li>Distribute through an app or Viewer access. Workspace Admins/Members/Contributors bypass normal viewer RLS; do not use those roles just to view. Test as actual Viewer/app identities, including an unmatched account expected to see no hierarchy data.</li><li>If scheduled updates are needed, run source updates first, confirm readiness, then refresh the model.<span data-it-routes="fabric pax-fabric"> Keep table writes separate from Import refresh.</span> Test the configured schedule with its actual collection and refresh identities.</li></ol>
    <p>Minimum Group Size suppresses small groups; it is not anonymization or an access boundary. De-identification can break ordinary sign-in identity matching. Use an approved security arrangement; never disable RLS as a workaround.</p>
    <nav class="kitchen-reference-links" aria-label="Power BI deployment references">${external('Scheduled refresh', 'https://learn.microsoft.com/en-us/power-bi/connect-data/refresh-scheduled-refresh')}${external('Row-level security', 'https://learn.microsoft.com/en-us/fabric/security/service-admin-row-level-security')}${external('Cloud connections', 'https://learn.microsoft.com/en-us/power-bi/connect-data/service-connect-cloud-data-sources')}${external('Fabric licensing', 'https://learn.microsoft.com/en-us/fabric/enterprise/licenses')}</nav>
  `)}
  ${section('recurring', '6', 'Operate and recover', `
    <p>Record the actual source paths/table schema, reviewed script/notebook version, history/privacy settings, collection identity, update-window tracking, refresh identity/owner, scheduler, credential rotation and alert owner. Do not store secret values in the ticket.</p>
    ${table(['Failure', 'Operator action'], [
      ['401/403 collecting Graph data', 'Check the actual principal, delegated vs Application permission type, admin consent and applicable audit/catalog roles. Destination write access is a separate check.'],
      ['Users keys / schema / history mismatch', 'Use the matched processed pair and unchanged UserHistory/privacy mode. Do not switch mode or concatenate incompatible histories.'],
      ['Report refresh fails', 'Test as the configured refresh identity against the exact paths/SQL connection or gateway, not only as the interactive admin.'],
      ['Viewer sees no data', 'Verify role membership, source UPN/manager links and Minimum Group Size. Test as Viewer; do not manufacture links or grant Contributor to bypass security.']
    ])}
    <p data-it-routes="sharepoint"><strong>SharePoint upload 403:</strong> verify the selected site's write grant for app-only collection, or delegated consent plus the user's library access.</p>
    <p data-it-routes="fabric pax-fabric"><strong>OneLake write / SQL-read failure:</strong> check the actual principal, workspace access, scoped tenant setting and separate storage/SQL credentials. Wait for synchronization before refreshing.</p>
    <p data-it-routes="fabric"><strong>Notebook failure:</strong> verify secret-value Get / Key Vault Secrets User on the execution identity and vault networking. For preparation/Ready failures, recollect stale inputs and finish preparation; do not fabricate timestamps or Ready markers.</p>
  `)}
  ${section('acceptance', '7', 'Check the handover', `
    <ul class="check-list"><li>Approved dates, people and optional catalog choice are implemented; unavailable history or entitlement is documented.</li><li>The intended principal completes collection, and matching processed Users/Interactions plus any catalog are readable.</li><li>The matching template loads expected people, dates, teams and activity. Raw exports are not used as report inputs.</li><li>Refresh succeeds, including any configured schedule, and the latest intended update appears.<span data-it-routes="fabric pax-fabric"> Table writes remain separate from Import refresh.</span></li><li>Real viewers get the intended hierarchy or approved full-data access; an unmatched hierarchy identity gets no accidental access.</li><li>The owner has the report/app location, operating contacts and known limitations. IT retains the source paths, versions, credential ownership and recovery instructions.</li></ul>
    <div class="button-row">${button('Return to Setup Guide', 'get-started.html')}${button('User Guide', 'user-guide.html', 'secondary')}</div>
  `)}
  <section class="it-runbook-section it-request-section" ${searchAttr('it-request', 'Note for IT')}><header><h2>Need help from IT?</h2><span class="it-optional-label">Optional</span></header>
    <p>Create a message asking your IT team to help set up the <strong data-it-current-route>${e(routes[0].title)}</strong> edition of AI-in-One. Add any helpful details below.</p>
    <form id="it-request-form" class="it-request-form" aria-describedby="it-request-explainer">
      ${text('audience', 'Who will use the report? (optional)', 'maxlength="2000" placeholder="Team, group or intended report owner"')}
      ${text('notes', 'Anything IT should know? (optional)', 'maxlength="4000" placeholder="For example: reporting dates, existing data location or a required refresh schedule. Do not include passwords or secrets."')}
      <div class="it-request-action"><button class="button button-primary" type="submit" disabled>Generate note ${icon('arrow')}</button><p id="it-request-explainer">Only creates text on this page. Nothing is sent, saved or submitted. Copy it into your company's helpdesk, email or Teams yourself.</p></div>
      <p id="it-request-status" role="status"></p>
    </form>
    <div id="it-request-result" class="it-request-result" hidden><h3>Your note for IT</h3><p>Review and copy this text into your organization's normal request channel.</p><div class="button-row"><button type="button" class="button button-primary" id="it-request-copy">Copy note</button><button type="button" class="button button-secondary" id="it-request-select">Select text</button></div><label class="sr-only" for="it-request-text">Generated note for IT</label><textarea id="it-request-text" rows="1" readonly></textarea></div>
    <noscript><p>To ask IT for help without JavaScript, copy this page's address and identify your chosen storage tier.</p></noscript>
  </section>
  </div></div></div>`;
}
