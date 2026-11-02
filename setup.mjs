export function renderSetup(h, currentStep = 'prepare') {
  const { e, icon, productLogo, editionLogo, eyebrow, external, dl, note, release, policy, miniKitchenPanel, collectionOptions, reference, navigation } = h;
  if (!navigation.pages.some(page => page.step === currentStep)) throw new Error('Unsupported setup page.');
  const templates = new Map(release.templates.map(item => [item.id, item]));
  const routes = [
    {
      id: 'sharepoint', title: 'SharePoint', tag: 'A shared cloud report', symbol: 'people', color: 'blue',
      fit: 'Share report data in the cloud',
      headline: 'A shared home for your report data.',
      summary: 'For business teams that want regular reporting from files in SharePoint, without introducing Fabric OneLake.',
      audience: 'A report owner working with an IT partner to share an ongoing adoption picture.',
      need: 'A SharePoint document library, permission to collect the data and Power BI access for your intended audience.',
      responsibility: 'Your IT or reporting partner prepares the files with PAX. The report owner connects the report and manages access.',
      operation: 'Update the same files with PAX, then refresh Power BI. Cloud refresh usually does not need a gateway.',
      journey: ['PAX prepares your data', 'SharePoint keeps the files', 'Power BI shows the report'],
      detail: 'sharepoint-setup', destination: 'sharepoint', badge: 'Cloud sharing',
      reportSource: 'Processed CSVs in SharePoint'
    },
    {
      id: 'local', title: 'Local CSV', tag: 'Your own exploration', symbol: 'chart', color: 'purple',
      fit: 'Explore prepared files on your PC',
      headline: 'Start on your own computer.',
      summary: 'For a report owner exploring prepared files in Power BI Desktop, before deciding how to share more widely.',
      audience: 'An analyst or business professional who wants to explore their organization’s prepared data on a PC.',
      need: 'Power BI Desktop and matching report-ready files from your data team. Choose the sample if you do not have your own data yet.',
      responsibility: 'Your data partner can prepare the files with PAX. You open the report and choose the questions to explore.',
      operation: 'Update the same files, then refresh in Desktop. Scheduled sharing through Power BI Service needs a gateway that can read them.',
      journey: ['PAX prepares your data', 'Your PC keeps the files', 'Desktop shows the report'],
      detail: 'local-setup', destination: 'local', badge: 'Explore on your PC',
      reportSource: 'Processed CSVs on your PC'
    },
    {
      id: 'fabric', title: 'Fabric OneLake: Notebooks', tag: 'Your data team operates it', symbol: 'layers', color: 'teal',
      compactTitle: 'Fabric notebooks', fit: 'Collect and prepare in OneLake',
      headline: 'An established data platform. A familiar report.',
      summary: 'For organizations whose data team wants to collect and prepare information inside Fabric OneLake.',
      audience: 'Business stakeholders supported by a data team that already operates Fabric OneLake.',
      need: 'An available Fabric environment, a Lakehouse and a data partner who can set up the supplied notebooks and permissions.',
      responsibility: 'Your data team operates the collection and preparation. You work with the same AI-in-One report experience.',
      operation: 'Run collection and preparation, allow the reporting connection to catch up, then refresh Power BI.',
      journey: ['Notebooks collect information', 'OneLake holds prepared data', 'Power BI shows the report'],
      detail: 'fabric-notebooks', badge: 'Notebook collection',
      reportSource: 'Notebook-prepared Lakehouse tables'
    },
    {
      id: 'pax-fabric', title: 'Fabric OneLake: PAX', tag: 'A separate PAX connection', symbol: 'layers', color: 'blue',
      fit: 'Use PAX-prepared OneLake tables',
      headline: 'For PAX-prepared data in OneLake.',
      summary: 'For a team connecting directly to the Fabric OneLake tables prepared by PAX, rather than the notebook route.',
      audience: 'A reporting team working with a data partner who uses PAX and Fabric OneLake together.',
      need: 'PAX-prepared OneLake tables, read access to their SQL analytics endpoint and the Fabric OneLake: PAX report template.',
      responsibility: 'PAX prepares this route’s data. It does not use or replace the notebook edition’s prepared tables.',
      operation: 'Finish the supported PAX table-update process, wait for SQL synchronization, then refresh Power BI. Mini-Kitchen does not build Fabric Tables update commands.',
      journey: ['PAX prepares your data', 'OneLake holds PAX tables', 'Power BI imports the report data'],
      detail: 'fabric-pax', destination: 'fabric-tables', badge: 'PAX collection',
      reportSource: 'PAX-prepared OneLake tables'
    },
    {
      id: 'sample', title: 'Try the sample', tag: 'No organization data needed', symbol: 'play', color: 'purple',
      fit: 'Explore fictional data without tenant access',
      headline: 'See the report before you collect anything.',
      summary: 'Explore fictional people, teams and activity in the Local CSV edition. No tenant access or PAX collection is needed.',
      audience: 'Anyone who wants to understand the report before involving IT or choosing a live-data connection.',
      need: 'Power BI Desktop, the Local CSV template and the three sample files supplied here.',
      responsibility: 'You download the sample, open the template and explore. All the sample information is fictional.',
      operation: 'There is no collection to schedule. When you are ready for your organization’s data, choose a live-data edition.',
      journey: ['Get the fictional sample', 'Open the Local CSV template', 'Explore the report'],
      detail: 'local-setup', badge: 'A no-access trial'
    }
  ];
  for (const route of routes.filter(route => route.id !== 'sample')) {
    const template = templates.get(route.id);
    if (!template) throw new Error(`Missing report template: ${route.id}`);
    route.pending = template.status !== 'available';
  }
  const scoped = (ids, html) => `<div data-setup-editions="${ids}" hidden>${html}</div>`;
  const inNewTab = html => html.replace(/<a\b(?![^>]*\btarget=)([^>]*)>/g, '<a$1 target="_blank" rel="noopener noreferrer">');
  const intro = (id, title, why) => `<header class="kitchen-screen-heading"><h3 id="${id}-title" tabindex="-1">${title}</h3><p>${why}</p></header>`;
  const flow = route => `<ol class="edition-journey" aria-label="${e(route.journeyLabel || 'How this edition works')}">${route.journey.map((label, index) => `<li><span class="edition-journey-icon">${icon(route.journeyIcons?.[index] || (index === 0 ? route.symbol : index === 1 ? 'layers' : 'chart'))}</span><span>${e(label)}</span>${index < 2 ? icon('arrow') : ''}</li>`).join('')}</ol>`;
  const overview = (route, showDetail = true) => `<div class="edition-overview" data-edition-color="${route.color}">
    <div class="edition-hero">${editionLogo(route.id)}<div>${eyebrow(route.tag)}<h3>${e(route.headline)}</h3><p>${e(route.summary)}</p></div><span class="edition-badge">${e(route.badge)}</span></div>
    ${flow(route)}
    <div class="edition-story-grid"><article>${icon('people')}<h4>Who it fits</h4><p>${e(route.audience)}</p></article><article>${icon('check')}<h4>What you need</h4><p>${e(route.need)}</p></article><article>${icon('shield')}<h4>Who does what</h4><p>${e(route.responsibility)}</p></article><article>${icon('clock')}<h4>Keeping it current</h4><p>${e(route.operation)}</p></article></div>
    ${route.pending ? note('Coming soon means not available to download.', 'You can explore this planned connection and its PAX setup, but you cannot complete the report connection yet. The notebook edition is not a substitute.') : ''}
    ${showDetail ? `<button class="text-button edition-detail-toggle" type="button" data-edition-show-detail>Read the detailed setup steps ${icon('book')}</button>` : ''}
  </div>`;
  function detail(route) {
    if (route.id === 'sample') return `<h3>Explore the sample in three moves.</h3><ol class="plain-steps"><li>Install Power BI Desktop and download the Local CSV template and three sample files.</li><li>Extract the activity CSV from its ZIP. Keep the matching sample files together.</li><li>Open the template, enter the full paths and select Load. Every person, team and activity in the sample is fictional.</li></ol><p>The guide will show the matching downloads and fields as you continue.</p>`;
    const markup = reference();
    const section = new RegExp(`<(section|article)\\b[^>]*\\bid="${route.detail}"[^>]*>([\\s\\S]*?)<\\/\\1>`).exec(markup);
    if (!section) throw new Error(`Missing edition instructions: ${route.detail}`);
    return section[2].replace(/<h2>/g, '<h3>').replace(/<\/h2>/g, '</h3>')
      .replace(/<a\b[^>]*href="(?:get-started|setup-(?:collect|open|share))\.html[^"]*"[^>]*>([\s\S]*?)<\/a>/g, '$1')
      .replace(/href="#([^"]+)"/g, 'href="setup-reference.html#$1"');
  }
  const editionOption = route => {
    const about = `<button type="button" class="edition-picker-about" data-edition-preview="${route.id}" aria-describedby="edition-card-title-${route.id}" aria-haspopup="dialog" aria-controls="edition-dialog"><span>About this edition</span>${icon('arrow')}</button>`;
    const method = route.destination
      ? `<button type="button" class="edition-picker-pax" data-open-pax aria-haspopup="dialog" aria-controls="pax-dialog">${icon('info')}<span>Uses PAX</span></button>`
      : '';
    return `<article class="edition-picker-option${route.id === 'sample' ? ' edition-picker-sample' : ''}" data-edition-color="${route.color}" aria-labelledby="edition-card-title-${route.id}">
      <label class="edition-picker-select">${editionLogo(route.id)}<span class="edition-picker-copy"><strong id="edition-card-title-${route.id}">${e(route.title)}</strong><span id="edition-card-description-${route.id}">${e(route.fit)}</span>${route.pending ? '<span class="edition-picker-unavailable">Coming soon</span>' : ''}</span><input type="radio" id="kitchen-edition-${route.id}" name="kitchen-edition" value="${route.id}" data-kitchen-edition required aria-labelledby="edition-card-title-${route.id}" aria-describedby="edition-card-description-${route.id}"></label>
      <div class="edition-picker-actions">${route.id === 'sample' ? '' : method}${about}</div>
    </article>`;
  };
  const editionChoices = `<fieldset id="setup-collect-editions" class="edition-picker-fieldset"><legend class="sr-only">AI-in-One edition</legend><div class="edition-picker-grid">${routes.filter(route => route.id !== 'sample').map(editionOption).join('')}</div>${routes.filter(route => route.id === 'sample').map(editionOption).join('')}</fieldset>`;
  const pax = {
    journeyLabel: 'From setup choices to report-ready data',
    journey: ['Choose with Mini-Kitchen', 'PAX collects and prepares', 'Explore in your dashboards'],
    journeyIcons: ['book', 'download', 'chart'],
    features: [
      {
        symbol: 'chart', title: 'Copilot and Microsoft 365, together',
        text: 'Collect Copilot and AI agent activity, with optional wider Microsoft 365 usage alongside it. Focus the collection on the dates, people, groups or agents that matter to your questions.'
      },
      {
        symbol: 'people', title: 'People and licensing in context',
        text: 'Bring in organizational details and Copilot licensing so activity has a team and people context. Optional access-group checks distinguish holding a license from being allowed to use Copilot.'
      },
      {
        symbol: 'agent', title: 'A richer picture of your agents',
        text: 'The expanded Agent 365 catalog brings together descriptions, declared capabilities, sharing, usage and creator/developer details where available. Missing information stays visible as missing, rather than being guessed.'
      },
      {
        symbol: 'layers', title: 'Several dashboards. One collection.',
        text: 'Prepare compatible inputs for AI-in-One, ValueLens, M365 Usage and Cowork Adoption in the same run. Your data team does not need a separate collection for every dashboard.'
      },
      {
        symbol: 'clock', title: 'History that keeps growing',
        text: 'Start with First collection (seed), then Update existing history (append). Incremental catch-up collects missing whole days for supported CSV histories, and your IT partner can schedule repeat runs instead of starting from scratch each time.'
      },
      {
        symbol: 'download', title: 'Report-ready data, where you need it',
        text: 'Prepare analysis-ready files for a local folder or SharePoint, or deliver files and tables into Fabric OneLake. Choose the destination and matching report connection that fit your team.'
      },
      {
        symbol: 'check', title: 'Better equipped for bigger jobs',
        text: 'Parallel collection, memory-aware processing and compact dashboard summaries help handle larger data sets. Saved checkpoints support resuming interrupted work, while output checks flag incomplete or conflicting results instead of quietly declaring success.'
      },
      {
        symbol: 'shield', title: 'Privacy-conscious preparation',
        text: 'Optional de-identification masks supported personal identifiers in report data and retained source exports, with additional protection for personal agent details. Your organization decides who may see the data and how it should be used.'
      }
    ]
  };
  const paxOverview = () => `<div class="edition-overview pax-overview" data-edition-color="blue">
    <div class="edition-hero">${productLogo('pax')}<div>${eyebrow('PAX v2.0 · Collect. Connect. Keep current.')}<h3>More of the story. Less data preparation.</h3><p>PAX brings Copilot, agent and Microsoft 365 activity together with people and licensing information, then prepares it for meaningful reporting. It is the data-preparation engine behind the PAX-supported AI-in-One editions—and can serve several dashboards from one collection.</p></div><a class="edition-badge pax-product-link" href="https://aka.ms/PAX-Prerelease" target="_blank" rel="noopener noreferrer" data-pax-repository>Portable Audit eXporter ${icon('external')}<span class="sr-only"> (opens the PAX repository in a new tab)</span></a></div>
    <section class="setup-route-feature pax-kitchen-intro" aria-labelledby="pax-kitchen-title">${productLogo('mini-kitchen')}<div>${eyebrow('Your easier starting point')}<h3 id="pax-kitchen-title">Mini-Kitchen makes the setup yours.</h3><p>This popup is tailored to AI-in-One. Choose its edition, dates, people and destination through guided choices. Mini-Kitchen builds a copy-ready PAX command—no need to write the command from scratch.</p><p>Return to the same setup popup to choose an edition and prepare data, then open or refresh the report and arrange sharing. Copy the command before closing. You or your IT partner run the downloaded PAX script in your own environment; Mini-Kitchen does not sign in to your organization or collect its data.</p></div></section>
    ${flow(pax)}
    <section class="pax-feature-section" aria-labelledby="pax-features-title">${eyebrow('What PAX v2.0 brings to the table')}<h3 id="pax-features-title">A broader picture. A repeatable process.</h3><div class="edition-story-grid pax-feature-grid">${pax.features.map(feature => `<article>${icon(feature.symbol)}<h4>${e(feature.title)}</h4><p>${e(feature.text)}</p></article>`).join('')}</div></section>
    <details class="route-detail pax-technical"><summary>For IT: collection, history and privacy details</summary><div><p><strong>Report inputs:</strong> the AI-in-One file-based editions use matching processed Users and Interactions CSVs, plus an optional Agent 365 catalog. Raw audit exports are not a substitute.</p><p><strong>Incremental collection:</strong> watermark updates collect missing whole days into supported Local, SharePoint or Fabric Files CSV histories. Saved checkpoints support resuming the same collection; compatible append histories keep people and activity references consistent.</p><p><strong>Licensing observations:</strong> optional user history records observed states going forward and needs a compatible report. It does not reconstruct license changes that were never collected.</p><p><strong>Privacy:</strong> de-identification protects designated fields, not every possible identifier or free-text field. Treat it as an additional control, not a guarantee of anonymity, and protect recovery material and source access separately.</p></div></details>
    <div class="pax-role-note">${icon('people')}<p><strong>A clear division of work.</strong> Your IT or data partner manages permissions and runs PAX. PAX prepares the data; AI-in-One helps report owners and business teams explore adoption and use. Collection and Power BI refresh are separate steps, both controlled by your team.</p></div>
  </div>`;
  const opening = route => {
    const template = templates.get(route.id === 'sample' ? 'local' : route.id);
    if (!template || route.pending) return '';
    return scoped(route.id, `<div class="setup-template-download">${editionLogo(route.id)}<div><h4>${e(template.title)} template</h4><p>Open the .pbit file in Power BI Desktop.</p></div><div class="setup-template-action">${external('Download template', template.href, 'button button-primary')}<span class="setup-download-tag">Default folder: Downloads</span></div></div>
      <div id="parameters-${route.id}" class="setup-parameters"><h4>Enter your matching connection details.</h4><dl class="parameter-list">${template.parameters.map(parameter => `<dt>${e(parameter.name)}</dt><dd>${e(parameter.value)}</dd>`).join('')}</dl>
      <p>${e(template.note)}</p>
      ${route.id === 'sample' ? '<p><strong>Copilot Interactions File</strong> uses the extracted sample activity CSV, not its ZIP. <strong>Org Data File</strong> uses the sample people CSV; <strong>Agent 365</strong> uses the sample agent CSV. Use all three matching sample files with this Local CSV template.</p>' : ''}
      ${route.id === 'fabric' ? '<p>Your data team supplies the SQL analytics endpoint hostname and Lakehouse database name. This edition uses SQL Import, not Direct Lake. Connect only after the prepared tables and their matching Ready publication have synchronized to SQL. The optional Agent 365 catalog uses a direct SharePoint CSV path with its own source credentials.</p>' : ''}
      ${route.id === 'pax-fabric' ? '<p>Connect to the PAX-prepared <strong>AIO_Users</strong> and <strong>AIO_CopilotInteractions</strong> tables through the SQL analytics endpoint. Use <strong>PAX SQL Schema</strong> for their actual physical schema. Leave <strong>Load Agent365 catalog</strong> false unless the matching <strong>Agent365</strong> table is available, synchronized and readable. This is SQL Import, not Direct Lake, and needs no SharePoint catalog connection. Wait for the full PAX data update and SQL synchronization before loading; keep table writes paused throughout refresh.</p>' : ''}
      ${['local', 'sharepoint'].includes(route.id) ? '<p>Use processed Interactions and Users files from the same collection history, plus its Agent 365 catalog if collected. Raw audit exports cannot replace these report-ready files.</p>' : ''}
      <p>Keep <strong>Minimum Group Size at 3</strong> for team-level reporting. ${route.id === 'sample' ? 'The sample is fictional; leave the default while exploring.' : policy}</p><p>Select <strong>Load</strong> and sign in to the source if prompted. Check the people and dates in Copilot Usage Explorer.</p></div>`);
  };
  const choices = `<div id="setup-edition-choices" class="edition-picker">
    <header class="edition-picker-header"><h3 id="kitchen-choices-title" tabindex="-1">Choose your edition</h3></header>
    ${editionChoices}
  </div>`;
  const prepare = `
    ${intro('kitchen-prepare', 'Prepare your data', 'AI-in-One uses matching, processed activity and people data.')}
    <input type="hidden" id="kitchen-destination" value="">
    ${scoped('local sharepoint pax-fabric', `
      <fieldset id="kitchen-run" class="kitchen-collection"><legend>Collection type</legend><div class="kitchen-choice-box kitchen-collection-options">${collectionOptions}</div></fieldset>
      <div id="pax-fabric-availability" class="notice notice-warning" data-setup-editions="pax-fabric" hidden>${icon('info')}<div><strong>Fabric table updates</strong><p>Mini-Kitchen cannot generate table-update commands. Have your data team update the tables using its supported process, then connect or refresh the report.</p></div></div>
      <div class="kitchen-ready-shortcut" id="kitchen-ready-shortcut" hidden><span>Already have report-ready data?</span><button type="button" class="text-button" id="kitchen-ready-data">Use prepared data</button></div>
      <nav class="kitchen-reference-links" aria-label="Report setup help">${external('Ask IT for help', 'setup-reference.html#it-request')}</nav>
    `)}
    <div id="notebook-setup" data-setup-editions="fabric" hidden>
      <ol class="kitchen-task-grid"><li><h4>Set up access</h4><p>IT confirms Fabric capacity, Lakehouse access, audit retention and administrator consent for the collector application's <code>AuditLogsQuery.Read.All</code>, <code>User.Read.All</code> and <code>Reports.Read.All</code> permissions.</p></li><li><h4>Configure the notebooks</h4><p>Attach all four notebooks to the same Lakehouse. Store the client secret in Azure Key Vault; the notebook account needs secret-read and table-write access.</p></li><li><h4>Collect and prepare</h4><p>Run the audit, organization and licensing collectors, then the preparation notebook. The supplied pipeline can coordinate the runs.</p></li><li><h4>Confirm readiness</h4><p>Wait for the prepared tables and their matching <strong>Ready</strong> publication to synchronize to SQL. Pause table writes during report refresh.</p></li></ol>
      <nav class="kitchen-reference-links" aria-label="Notebook resources">${dl('fabric-guide')}${external('Download notebooks', 'downloads.html#fabric-onelake-notebooks')}</nav>
    </div>
    ${scoped('sample', `
      <div class="kitchen-sample-intro"><h4>Three files. No collection needed.</h4><p>The sample is fictional and requires no tenant access. Extract the activity CSV from its ZIP and keep all three files together. Allow about <strong>469 MB</strong> for the extracted activity file.</p></div>
      <div class="sample-downloads">${['sample-users', 'sample-agents', 'sample-interactions'].map(id => `<div>${dl(id)}</div>`).join('')}</div>
      <p>The report uses the Local CSV template in ${external('Power BI Desktop', 'https://www.microsoft.com/en-us/download/details.aspx?id=58494')}.</p>
    `)}`;
  const open = `
    ${intro('kitchen-open', 'Connect your report', 'Use the template and connection details for your selected edition.')}
    <div data-setup-mode="initial">
      ${routes.map(opening).join('')}
    </div>
    <div data-setup-mode="update" hidden>
      ${scoped('local sharepoint', `<div id="keep-current" class="setup-update-guide"><h4>Keep your existing report connection.</h4><p>You are updating existing history (append), not starting a new report. <strong>Do not download or reconnect another template</strong> just to add new activity. Refreshing the existing connection reads the updated history without replacing the report’s source paths.</p>
        ${scoped('sharepoint', '<p>Let PAX finish updating the matching SharePoint files and wait for synchronization. Refresh Power BI using the existing organizational OAuth2 credentials with read access to those same files. A gateway is normally unnecessary.</p>')}
        ${scoped('local', '<p>Let PAX finish updating the matching local files. Select Refresh in Power BI Desktop, or use the existing gateway connection that can read those same paths for scheduled Power BI Service refresh.</p>')}
        <p>Update the matching processed <strong>Interactions</strong> and <strong>Users</strong> files already connected to this report, plus its <strong>Agent 365</strong> catalog if used. Keep the existing history mode and the <strong>Copilot Interactions File</strong>, <strong>Org Data File</strong> and <strong>Agent 365</strong> parameter paths; a new Users file elsewhere will not update this connection.</p><p>Wait for collection, preparation and synchronization to finish successfully before refreshing. Check that the refreshed report shows the people and dates you expected. The website does not run PAX or verify its results for you.</p></div>`)}
      ${scoped('pax-fabric', '<div class="setup-update-guide"><h4>Refresh your existing PAX report connection.</h4><p>Keep the current <strong>Fabric SQL Endpoint</strong>, <strong>Fabric Lakehouse</strong>, <strong>PAX SQL Schema</strong> and <strong>Load Agent365 catalog</strong> settings. Do not download or reconnect another template to add new activity.</p><p>Have your data team finish its supported table-update process, wait for SQL synchronization, then refresh Power BI. Keep all table writes paused throughout the SQL Import refresh. Mini-Kitchen cannot build Fabric Tables update commands; it does not replace your data team&#39;s update process.</p></div>')}
    </div>`;
  const share = `
    ${intro('kitchen-share', 'Sharing and refresh', 'Set viewer access and keep the report current.')}
    ${scoped('sample', '<div class="kitchen-sample-intro"><h4>Explore the sample in Desktop</h4><p>Use the User Guide to understand the report views and measures. The fictional sample needs no collection or refresh schedule.</p></div>')}
    ${scoped('sharepoint local fabric pax-fabric', `<ol class="kitchen-task-grid"><li><h4>Publish the report</h4><p>Publish to the approved Power BI workspace. Confirm sharing licenses or capacity with IT.</p></li><li><h4>Assign viewer roles</h4><p>Use <strong>Reporting hierarchy</strong> for a viewer's own organization, or <strong>All data viewers</strong> for approved full-dataset access. Test representative accounts.</p></li><li><h4>Choose how to share</h4><p>Use a Power BI app or Viewer access. Workspace Admins, Members and Contributors are not restricted by row-level security like Viewers.</p></li><li><h4>Schedule refresh</h4><p>Configure source credentials, test <strong>Refresh now</strong>, then schedule refresh after collection and preparation. Confirm a later scheduled run succeeds.</p></li></ol>
      <div class="kitchen-refresh-card">
      ${scoped('sharepoint', '<p><strong>Your SharePoint refresh:</strong> configure organizational OAuth2 credentials with read access to each matching file. Run PAX first and wait for successful completion and synchronization. A gateway is normally unnecessary.</p>')}
      ${scoped('local', '<p><strong>Your Local CSV refresh:</strong> configure an on-premises data gateway that can read the same local or network paths for scheduled Service refresh. Otherwise, refresh in Desktop and republish after updates finish.</p>')}
      ${scoped('fabric', '<p><strong>Your Fabric OneLake notebook refresh:</strong> finish collection and preparation, then wait for SQL to show the completed tables with a matching Ready publication. Use a SQL cloud connection for Power BI Import refresh, not Direct Lake. Keep table writers and report refresh non-overlapping. Configure separate SharePoint source credentials if the optional Agent 365 catalog is used; private networking or tenant policies may add requirements.</p>')}
      ${scoped('pax-fabric', '<p><strong>Your Fabric OneLake PAX refresh:</strong> configure a SQL cloud connection with read access to the PAX tables. Finish the full table update, wait for SQL synchronization and keep table writes paused throughout Power BI Import refresh. This is not Direct Lake and does not use the notebook edition&#39;s Ready publication or SharePoint catalog source. Enable the optional Agent365 table only when it is synchronized and readable; private networking or tenant policies may add requirements.</p>')}
      </div>
      <div class="refresh-flow" aria-label="Refresh order"><span>Prepare or update data</span>${icon('arrow')}<span>Finish preparation and synchronization</span>${icon('arrow')}<span>Refresh Power BI</span></div>
      <div class="kitchen-security-note"><p><strong>Source access and viewer access are separate.</strong> Keep <strong>Minimum Group Size at 3</strong> for team-level reporting. ${policy}</p><p>De-identification can change sign-in identities and break ordinary Reporting hierarchy matching. Agree an approved security arrangement; never disable security as a workaround. Protect recovery material and source exports.</p></div>`)}
    <nav class="kitchen-reference-links" aria-label="Report help">${external('User Guide', 'user-guide.html')}${external('Power BI refresh and credentials', 'setup-reference.html#refresh')}</nav>`;
  const editionMatrix = `<div class="table-wrap setup-edition-matrix" tabindex="0" role="region" aria-label="Compare data preparation for the four editions">
    <table><caption>How each edition gets its data.</caption><thead><tr><th scope="col">Edition</th><th scope="col">Extraction &amp; processing</th><th scope="col">Prepared report data</th><th scope="col">Mini-Kitchen</th></tr></thead><tbody>${routes.filter(route => route.id !== 'sample').map(route => `<tr data-setup-matrix-edition="${route.id}"><th scope="row">${e(route.title)}${route.pending ? '<span class="setup-template-status">Report template coming soon</span>' : ''}</th><td>${route.destination ? 'PAX' : 'Supplied Fabric notebooks (no PAX)'}</td><td>${e(route.reportSource)}</td><td>${route.destination ? 'Builds your PAX command' : '<strong>Not used</strong>'}</td></tr>`).join('')}</tbody></table>
  </div>`;
  return inNewTab(`
    <div data-setup-flow data-setup-page="${e(currentStep)}" class="setup-flow setup-pages" id="setup-flow" data-no-auto-link>
      ${miniKitchenPanel({ choices, prepare, open, share, editionMatrix })}
      <dialog id="edition-dialog" class="edition-dialog" aria-labelledby="edition-dialog-title"><header class="edition-dialog-header"><div><p class="eyebrow">Find your fit</p><h2 id="edition-dialog-title"></h2></div><button type="button" class="icon-button" id="edition-dialog-close" aria-label="Close edition overview">&times;</button></header><div class="edition-dialog-body" tabindex="-1"><button type="button" class="text-button" id="edition-dialog-back" hidden>Back to the overview</button><div id="edition-dialog-content"></div></div><footer class="edition-dialog-footer"><button type="button" class="button button-primary" id="edition-dialog-choose" data-edition-select>Choose this edition ${icon('arrow')}</button></footer></dialog>
      <dialog id="pax-dialog" class="edition-dialog pax-dialog" aria-labelledby="pax-dialog-title"><header class="edition-dialog-header"><div><p class="eyebrow">Meet the product</p><h2 id="pax-dialog-title">Meet PAX.</h2></div><button type="button" class="icon-button" id="pax-dialog-close" aria-label="Close PAX overview">&times;</button></header><div class="edition-dialog-body" data-no-auto-link>${paxOverview()}</div><footer class="edition-dialog-footer"><div class="pax-dialog-more" data-no-auto-link><a class="text-link" href="https://aka.ms/PAX-Prerelease" target="_blank" rel="noopener noreferrer" data-pax-repository>PAX files and technical documentation ${icon('external')}<span class="sr-only"> (opens a new tab)</span></a></div><div class="pax-dialog-actions"><button type="button" class="button button-secondary" id="pax-dialog-return">Back to where I was</button><a class="button button-primary" href="https://aka.ms/Mini-Kitchen" target="_blank" rel="noopener noreferrer" data-pax-kitchen>Full Mini-Kitchen (optional) ${icon('external')}<span class="sr-only"> (opens a new tab)</span></a></div></footer></dialog>
      ${routes.map(route => `<template id="edition-overview-${route.id}" data-setup-edition="${route.id}" data-edition-title="${e(route.title)}" data-edition-label="${e(route.compactTitle || route.title)}" data-edition-available="${!route.pending}">${overview(route)}</template><template id="edition-detail-${route.id}">${detail(route)}</template>`).join('')}
    </div>`.replace(/^[ \t]+$/gm, ''));
}
