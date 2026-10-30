(() => {
  const repository = 'https://raw.githubusercontent.com/microsoft/AI-in-One-Dashboard/preview/';
  const file = path => repository + path.split('/').map(encodeURIComponent).join('/');
  const notebooks = 'Fabric OneLake/AI-in-One - v2.0.0 - Fabric OneLake Template/';
  const detailPolicy = '3 by default. Use 1 for individual activity only if your organization\'s privacy and employee-reporting policies allow it.';
  window.AIO_RELEASE = {
    version: '2.0',
    channel: 'Public preview',
    templates: [
      {
        id: 'fabric', title: 'Fabric OneLake: notebooks',
        subtitle: 'Collect and prepare data inside Fabric OneLake.',
        bestFor: 'Your team wants a notebook-managed collection and refresh process.',
        chooseWhen: 'You already use Fabric OneLake, want to retain more history, and have a team to operate collection notebooks.',
        effort: 'More preparation: collector permissions, Key Vault and four notebooks.',
        automation: 'Schedule notebook collection and preparation, then Power BI refresh.',
        source: 'Fabric OneLake tables prepared by the included notebooks. An optional Agent 365 catalog uses a SharePoint CSV.',
        refresh: 'Run collection, then preparation. Wait for the SQL analytics endpoint to finish synchronizing before refreshing Power BI.',
        status: 'available',
        href: file('templates/AI-in-One-v2.0.0-Fabric-OneLake-Template.pbit'),
        file: 'AI-in-One-v2.0.0-Fabric-OneLake-Template.pbit',
        parameters: [
          { name: 'Fabric SQL Endpoint', value: 'The SQL analytics endpoint hostname, without https://' },
          { name: 'Fabric Lakehouse', value: 'The Lakehouse database name' },
          { name: 'Agent 365', value: 'Optional direct SharePoint CSV path, or leave blank' },
          { name: 'Minimum Group Size', value: detailPolicy }
        ],
        note: 'Use the Fabric OneLake notebook instructions and matching notebooks. This template does not connect directly to PAX-produced Fabric OneLake tables.'
      },
      {
        id: 'pax-fabric', title: 'Fabric OneLake: PAX',
        subtitle: 'Connect to data PAX has prepared in Fabric OneLake.',
        bestFor: 'Your team already uses PAX to maintain processed data in Fabric OneLake.',
        chooseWhen: 'PAX already prepares your data as Fabric OneLake tables. Do not select the notebook edition as a substitute.',
        effort: 'Existing PAX Lakehouse and SQL access required. Report template coming soon.',
        automation: 'Schedule PAX updates, wait for SQL synchronization, then refresh Power BI.',
        source: 'PAX-produced Fabric OneLake Users and Interactions tables, plus an optional Agent365 table.',
        refresh: 'Let PAX finish the full data update, then wait for SQL synchronization. No table updates may overlap the Power BI refresh.',
        status: 'pending', href: null,
        file: 'AI-in-One-v2.0.0-Fabric-OneLake-PAX-Template.pbit',
        parameters: [
          { name: 'Fabric SQL Endpoint', value: 'The SQL analytics endpoint hostname, without https://' },
          { name: 'Fabric Lakehouse', value: 'The Lakehouse database name' },
          { name: 'PAX SQL Schema', value: 'The schema containing your PAX-produced Fabric OneLake tables; usually dbo' },
          { name: 'Load Agent365 catalog', value: 'Leave false unless the Fabric OneLake Agent365 table is available and synchronized' },
          { name: 'Minimum Group Size', value: detailPolicy }
        ],
        note: 'Download coming soon. This Fabric OneLake route does not use the notebook edition\'s collectors or preparation tables.'
      },
      {
        id: 'sharepoint', title: 'SharePoint',
        subtitle: 'Keep PAX CSV files in a document library.',
        bestFor: 'Your team wants scheduled cloud refresh from CSV files, usually without a gateway.',
        chooseWhen: 'You want a shared cloud report from PAX CSV files without introducing Fabric OneLake.',
        effort: 'Collection permissions, a SharePoint library and matching CSV connections.',
        automation: 'Schedule PAX to update the files, then use Power BI cloud refresh.',
        source: 'Matching dashboard-ready PAX Users and Interactions CSV files, plus an optional Agent 365 catalog.',
        refresh: 'Run PAX first. Then refresh Power BI using an organizational account with read access to each SharePoint file.',
        status: 'available',
        href: file('templates/AI-in-One-v2.0.0-SharePoint-Template.pbit'),
        file: 'AI-in-One-v2.0.0-SharePoint-Template.pbit',
        parameters: [
          { name: 'Copilot Interactions File', value: 'The direct HTTPS path to your processed Interactions CSV' },
          { name: 'Org Data File', value: 'The direct HTTPS path to the matching processed Users CSV' },
          { name: 'Agent 365', value: 'The direct HTTPS catalog CSV path, or leave blank' },
          { name: 'Minimum Group Size', value: detailPolicy }
        ],
        note: 'In SharePoint, select the file, open Details and copy Path. Do not use a sharing link or the browser address bar.'
      },
      {
        id: 'local', title: 'Local CSV',
        subtitle: 'Open files on your PC or a network folder.',
        bestFor: 'You want to try the sample or explore files in Power BI Desktop.',
        chooseWhen: 'You want to try the sample, analyze files on your PC, or start with a small pilot.',
        effort: 'Lowest effort for a trial: Desktop plus the prepared sample files.',
        automation: 'Refresh manually in Desktop, or use scheduled PAX updates and a gateway for Service refresh.',
        source: 'Matching processed PAX CSV files, or the fictional sample files.',
        refresh: 'Refresh in Desktop. Scheduled Power BI Service refresh requires a gateway that can read the same file paths.',
        status: 'available',
        href: file('templates/AI-in-One-v2.0.0-Local-CSV-Template.pbit'),
        file: 'AI-in-One-v2.0.0-Local-CSV-Template.pbit',
        parameters: [
          { name: 'Copilot Interactions File', value: 'The full local path to your Interactions CSV' },
          { name: 'Org Data File', value: 'The full local path to the matching Users CSV' },
          { name: 'Agent 365', value: 'The full local catalog CSV path, or leave blank' },
          { name: 'Minimum Group Size', value: detailPolicy }
        ],
        note: 'Paste full paths without surrounding quotation marks. For the sample, extract the Interactions CSV from the ZIP first.'
      }
    ],
    downloads: [
      {
        id: 'interpretation', title: 'Interpretation guide',
        description: 'Understand the numbers, privacy settings and reporting limitations.',
        kind: 'PDF', file: 'AI-in-One-v2.0.0-Interpretation-Guide.pdf',
        href: file('AI-in-One-v2.0.0-Interpretation-Guide.pdf'), group: 'Guides and presentations'
      },
      {
        id: 'storyboard', title: 'Leadership storyboard',
        description: 'Present the report and guide an adoption conversation.',
        kind: 'PowerPoint', file: 'AI-in-One-v2.0.0-Storyboard.pptx',
        href: file('AI-in-One-v2.0.0-Storyboard.pptx'), group: 'Guides and presentations'
      },
      {
        id: 'whats-new', title: 'What is new in v2.0',
        description: 'A downloadable overview of what is new, with report screenshots.',
        kind: 'PDF', file: 'AI-in-One-v2.0.0-Whats-New.pdf',
        href: file('AI-in-One-v2.0.0-Whats-New.pdf'), group: 'Guides and presentations'
      },
      {
        id: 'sample-users', title: 'Sample people and organization',
        description: 'Fictional people and teams. Use this file for Org Data File.',
        kind: 'CSV', file: 'AIO_Realistic_Users.csv',
        href: file('sample-data/AIO_Realistic_Users.csv'), group: 'Try fictional sample data'
      },
      {
        id: 'sample-agents', title: 'Sample agent catalog',
        description: 'Fictional agents. Use this file for the optional Agent 365 parameter.',
        kind: 'CSV', file: 'AIO_Realistic_Agents.csv',
        href: file('sample-data/AIO_Realistic_Agents.csv'), group: 'Try fictional sample data'
      },
      {
        id: 'sample-interactions', title: 'Sample Copilot and agent activity',
        description: 'Extract the Interactions CSV from this ZIP before opening the template. The extracted file is about 469 MB. All activity is fictional.',
        kind: 'ZIP', file: 'AIO_Realistic_Interactions.zip',
        href: file('sample-data/AIO_Realistic_Interactions.zip'), group: 'Try fictional sample data'
      },
      {
        id: 'fabric-guide', title: 'Fabric OneLake notebook setup guide',
        description: 'Detailed collector, Lakehouse, pipeline and refresh instructions for the Fabric OneLake notebook route.',
        kind: 'Markdown', file: 'Fabric-OneLake-Notebook-Setup.md',
        href: file(notebooks + 'README.md'), group: 'Fabric OneLake notebooks'
      },
      {
        id: 'notebook-audit', title: 'Fabric OneLake audit collector',
        description: 'Collect Copilot audit activity into your Lakehouse.',
        kind: 'Notebook', file: 'Copilot_Audit_Log_Direct_Ingester.ipynb',
        href: file(notebooks + 'notebooks/Copilot_Audit_Log_Direct_Ingester.ipynb'), group: 'Fabric OneLake notebooks'
      },
      {
        id: 'notebook-org', title: 'Fabric OneLake organization collector',
        description: 'Collect directory information and reporting relationships.',
        kind: 'Notebook', file: 'Copilot_Org_Data_Direct_Ingester.ipynb',
        href: file(notebooks + 'notebooks/Copilot_Org_Data_Direct_Ingester.ipynb'), group: 'Fabric OneLake notebooks'
      },
      {
        id: 'notebook-licenses', title: 'Fabric OneLake licensing collector',
        description: 'Collect current license information. This is a snapshot, not an assignment history.',
        kind: 'Notebook', file: 'Copilot_Licensed_Users_Direct_Ingester.ipynb',
        href: file(notebooks + 'notebooks/Copilot_Licensed_Users_Direct_Ingester.ipynb'), group: 'Fabric OneLake notebooks'
      },
      {
        id: 'notebook-prepare', title: 'Fabric OneLake report preparation',
        description: 'Check the collected data and prepare the report tables.',
        kind: 'Notebook', file: 'Copilot_Report_Data_Preparation.ipynb',
        href: file(notebooks + 'notebooks/Copilot_Report_Data_Preparation.ipynb'), group: 'Fabric OneLake notebooks'
      },
      {
        id: 'pipeline', title: 'Fabric OneLake collection pipeline',
        description: 'Coordinate the collectors and preparation. Your administrator connects it to the correct notebooks and Lakehouse.',
        kind: 'JSON', file: 'pipeline-content.json',
        href: file(notebooks + 'pipelines/CopilotAdoptionPipeline.DataPipeline/pipeline-content.json'), group: 'Fabric OneLake notebooks'
      },
      {
        id: 'processor', title: 'Standalone data processor',
        description: 'For specialists who already have raw audit and directory exports. PAX normally handles this preparation for you.',
        kind: 'Python', file: 'Purview_CopilotInteraction_Processor_v4.2.3.py',
        href: file('scripts/Purview_CopilotInteraction_Processor_v4.2.3.py'), group: 'Advanced data preparation'
      }
    ],
    pax: {
      version: '2.0', href: 'https://aka.ms/Mini-Kitchen',
      repository: 'https://aka.ms/PAX-Prerelease'
    },
    video: {
      href: 'https://github.com/user-attachments/assets/e66ac19e-d4bd-45d3-85ef-485d0707c155',
      poster: 'assets/whats-new-poster.jpg'
    },
    setupVideo: {
      href: 'https://www.youtube.com/watch?v=bcXXCiljPZw',
      embed: 'https://www.youtube-nocookie.com/embed/bcXXCiljPZw?autoplay=0&rel=0'
    }
  };
})();
