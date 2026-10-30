window.AIO_CONTENT = {
  tour: [
    {
      id: 'explorer', number: 1, title: 'Copilot Usage Explorer', area: 'Start here',
      question: 'How is my team, a manager\'s organization or one agent using Copilot?',
      summary: 'Start with people, prompts and conversations, then narrow the report to the team and dates you need.',
      image: 'assets/screenshots/01-copilot-usage-explorer.png',
      bullets: [
        'Six headlines cover active users, prompts, sessions, prompts per session, active days per user and repeat users.',
        'Daily prompts and sessions sit beside bold 7-day averages; month-start dots mark the Explorer averages.',
        'Switch Activity by experience between sessions and prompts without changing your selected people.',
        'Explore agent usage and inferred activity patterns in the same organizational and date scope.',
        'Reporting team includes a manager\'s direct and indirect reports, excluding the manager.'
      ],
      tip: 'Open Org filters, search Reporting team for a manager, then choose your dates. In Desktop edit mode, use Ctrl+click on report buttons.',
      caution: 'An inferred pattern is a clue, not an outcome. Eligible team membership, not the number of active users, determines the minimum-group check.'
    },
    {
      id: 'license-prioritization', number: 2, title: 'License Prioritization', area: 'Overall',
      question: 'Which groups show patterns that could support a licensing conversation?',
      summary: 'Compare paid and free populations and explore a transparent usage-based prioritization heuristic.',
      image: 'assets/screenshots/02-license-prioritization.png',
      bullets: [
        'Separate licensed directory headcount, active licensed users, inactive licensed users and unlicensed Chat users.',
        'Use independent Paid activity and Free Chat activity selections.',
        'Start with Departments. People & chart includes person search only when your organization permits individual reporting and Minimum Group Size is 1.',
        'Sessions is the default score metric; Prompts substitutes prompt units into the same calculation.',
        'The score weights weekly volume / 10 at 60%, active days per week / 5 at 30%, and volume per active day / 5 at 10%.'
      ],
      tip: 'Compare departments first, then discuss job needs, cost and colleagues\' feedback with the licensing owner.',
      caution: 'Scores are uncapped heuristics, not percentages, validated targets or employee-performance measures. Active licensed includes agent-only and other recorded activity, not just chat.'
    },
    {
      id: 'combined-trends', number: 3, title: 'Copilot Overall: Combined Trends', area: 'Overall',
      question: 'How do M365 Copilot, Copilot Chat and agents compare over time?',
      summary: 'Read side-by-side experience trends and monthly paid/free comparisons in their own populations.',
      image: 'assets/screenshots/03-combined-trends.png',
      bullets: [
        'Compare agent users, unlicensed Chat users, active licensed users, inactive licensed users and licensed headcount.',
        'Read sessions per user over time alongside separate departmental experience bars.',
        'Use the frequency-and-intensity chart to compare departments within an experience.',
        'Monthly comparison uses each month\'s observed paid/free population, distinct active people and per-active-person ratios.',
        'Weekly-only usage-rank controls do not change monthly totals.'
      ],
      tip: 'Keep organization, dates and metric units aligned before comparing experiences or months.',
      caution: 'Experience groups overlap. A person can also have both paid and free observations in a period, so adding cohort counts can overstate distinct people.'
    },
    {
      id: 'combined-leaderboard', number: 4, title: 'Copilot Overall: Combined Leaderboard', area: 'Overall',
      question: 'Which departments use each experience, and how many chat users also use agents?',
      summary: 'Compare departmental chat and agent activity without combining different denominators.',
      image: 'assets/screenshots/04-combined-leaderboard.png',
      bullets: [
        'Read licensed and unlicensed tables separately.',
        'Compare users, prompts, sessions, prompts per session and weekly prompt/session measures.',
        'The agent-use percentage asks how many of that table\'s chat users also used agents.',
        'Agent prompt cells also follow the licensed or chat row\'s minimum-group check.'
      ],
      tip: 'Use the table heading to identify the population before interpreting an agent-use percentage.',
      caution: 'Unknown license information is not unlicensed. Individual rows require Minimum Group Size 1 and must comply with your organization\'s privacy and employee-reporting policies.'
    },
    {
      id: 'agents-trends', number: 5, title: 'Agents: Usage Trends', area: 'Agents',
      question: 'How many people try agents, and how many come back?',
      summary: 'Track reach, repeat use and activity volume across the agents in your selected scope.',
      image: 'assets/screenshots/05-agents-usage-trends.png',
      bullets: [
        'Headlines include active agents, agent users, adoption, weekly prompts and sessions, changes and repeat users.',
        'The trend shows active people on the left axis and total sessions and recorded prompts on the right.',
        'Compare weekly prompts and sessions per user by department.',
        'Explore the Top 5 agents by sessions and paired per-active-week measures by dynamic usage band.',
        'Most organizations means departments reached, not distinct companies or tenants.'
      ],
      tip: 'Compare first-time reach with repeat use over several weeks, then open Agent Details for context.',
      caution: 'Total-volume trends and per-user weekly comparisons have different units. More sessions do not establish greater business value.'
    },
    {
      id: 'agents-habits', number: 6, title: 'Agents: Habit Formation', area: 'Agents',
      question: 'How often do people use agents in a month?',
      summary: 'See the distribution of distinct active days in the printed habit month.',
      image: 'assets/screenshots/06-agents-habit-formation.png',
      bullets: [
        'The habit month is the calendar month before the end of the selected date range.',
        'Fixed bands are Light 1-5, Moderate 6-10, Frequent 11-15 and Daily 16+ distinct active days.',
        'Cards and the previous-month bars describe that printed month.',
        'Department and agent activity tables cover the whole selected period.',
        'The monthly active-day view shows how the habit mix changes over time.'
      ],
      tip: 'Read the printed month before comparing the cards with a selected-period table.',
      caution: 'Zero-day users are outside the four habit bands. Daily is a band label, not evidence of use every working day or time spent.'
    },
    {
      id: 'agents-leaderboard', number: 7, title: 'Agents: Leaderboard', area: 'Agents',
      question: 'Which agents and audiences lead on sessions and prompts?',
      summary: 'Compare agent activity, catalog information and audience detail in one expandable view.',
      image: 'assets/screenshots/07-agents-leaderboard.png',
      bullets: [
        'Catalog agents are counted by Title ID; activity-only agents are shown separately.',
        'Compare users, departments, sessions, prompts, conversation depth and return rate.',
        'Scroll right for Creator, Developer Name, Description, Features and catalog status.',
        'The Creator filter includes matching catalog agents with no usage; Top builder stays stable when an agent is selected.',
        'When individual reporting is permitted by your organization, By user detail adds Most used agent and Agents used for each person.'
      ],
      tip: 'Select an agent and use Agent Details. To browse beyond a scoped drillthrough, choose Open Agent Details.',
      caution: 'Creator is not Developer Name, and listed Features are not proof of actual use. A 0% return rate means active users with no repeat users; a blank can mean no activity or protected detail.'
    },
    {
      id: 'agent-health', number: 8, title: 'Agents: Health Check', area: 'Agents',
      question: 'Which agents should we keep, and which should we review with their owners?',
      summary: 'Use scoped review signals and clear exceptions to guide a conversation with agent owners.',
      image: 'assets/screenshots/08-agents-health-check.png',
      bullets: [
        'Review High impact, Keep, Review and No usage labels for tracked agents.',
        'Users, departments and return rate follow the selected team and dates.',
        'Dormant means previously used, with last activity more than 60 days before the selected end date.',
        'Security Copilot entries say Usage not tracked here; included system entries say System-generated.',
        'Creator and Developer Name remain separate catalog attributes within the viewer\'s access.'
      ],
      tip: 'Read the on-page explanation and check an unexpected label with the owner before taking action.',
      caution: 'Never-used agents are not Dormant. No usage in this dashboard does not prove that an agent is unused everywhere or should be deleted.'
    },
    {
      id: 'agents-use-cases', number: 9, title: 'Agents: Use Cases', area: 'Agents',
      question: 'What might each agent be used for?',
      summary: 'Explore evidence-based activity labels and an engagement comparison, not a value score.',
      image: 'assets/screenshots/09-agents-use-cases.png',
      bullets: [
        'Top 10 engagement requires at least MAX(Minimum Group Size, 5) users for each eligible agent.',
        'The comparison equally averages peer percentile ranks for return rate, sessions per user and prompts per session.',
        'Sessions descending, then agent name ascending, break ties.',
        'Inferred patterns use stored resource, action, context, plugin and app-host evidence, sometimes with agent-name keywords.',
        'Leading patterns use the most agent sessions, with alphabetical ties.'
      ],
      tip: 'Choose an agent you know and validate its likely activities with the people who use it.',
      caution: 'The report does not analyze prompt text or apply AI inference. Engagement and inferred activity are not measured business outcomes; Not enough activity to infer is not an invented category.'
    },
    {
      id: 'agent-details', number: 10, title: 'Agent Details', area: 'Agents',
      question: 'Who uses this agent, how much, where, and do they come back?',
      summary: 'Investigate one or more agents with the same team, date and access context.',
      image: 'assets/screenshots/10-agent-details.png',
      bullets: [
        'Choose agents from the picker when opening the main Agent Details tab.',
        'Headlines cover users, prompts, sessions, prompts per session, departments and repeat users.',
        'Daily prompts and sessions have bold 7-day averages.',
        'Compare usage by department and read activity details within the allowed grouping.',
        'Leaderboard navigation and right-click drillthrough intentionally retain the clicked agent.'
      ],
      tip: 'Use Open Agent Details on the drillthrough view to browse the full agent list while keeping organization and date scope.',
      caution: 'A drillthrough agent filter is intentional, not a broken picker. Individual activity and license-history tooltips require the right access and reporting settings that comply with your organization\'s policies.'
    },
    {
      id: 'm365-trends', number: 11, title: 'M365 Copilot: Usage Trends', area: 'M365 Copilot',
      question: 'How is licensed Microsoft 365 Copilot use trending?',
      summary: 'Read licensed chat activity, weekly comparisons and application mix with explicit units.',
      image: 'assets/screenshots/11-m365-copilot-usage-trends.png',
      bullets: [
        'Headlines include active and inactive licensed people, sessions, weekly measures and month-over-month changes.',
        'The main trend pairs active people with sessions and prompts per active licensed chat user in the same week/date context.',
        'Those trend rates are not divided by active weeks a second time.',
        'Department comparisons and usage-band bars show their labeled weekly prompt/session measures.',
        'Top apps use friendly names such as M365 Copilot Chat for bizchat.'
      ],
      tip: 'Look at people, sessions and app mix together, then ask what changed in the team\'s work.',
      caution: 'Active licensed headlines include all recorded experiences, including agent-only activity. Licensed chat chart populations are narrower; do not assume every number has the same denominator.'
    },
    {
      id: 'm365-habit', number: 12, title: 'M365 Copilot: Habit Formation', area: 'M365 Copilot',
      question: 'Is licensed Copilot becoming a monthly habit?',
      summary: 'Compare licensed chat active-day bands with selected-period departmental usage.',
      image: 'assets/screenshots/12-m365-copilot-habit-formation.png',
      bullets: [
        'The printed habit month is the month before the selected range ends.',
        'Light, Moderate, Frequent and Daily use fixed 1-5, 6-10, 11-15 and 16+ active-day bands.',
        'Previous-month cards and bars describe the printed month, not the full selected range.',
        'The departmental User Activity table covers the full range and includes Users, Prompts per user and distinct licensed chat Sessions.',
        'Department, reporting-level and total session rows calculate in their own context.'
      ],
      tip: 'Use the monthly mix to discuss regularity, and the activity table to understand the wider selected period.',
      caution: 'Do not sum person or license-state rows to recreate distinct session totals. Zero-day people do not belong to an active-day band.'
    },
    {
      id: 'm365-leaderboard', number: 13, title: 'M365 Copilot: Leaderboard', area: 'M365 Copilot',
      question: 'Which departments and apps lead in licensed Copilot use?',
      summary: 'Explore departmental licensed chat activity and application-level comparisons.',
      image: 'assets/screenshots/13-m365-copilot-leaderboard.png',
      bullets: [
        'Compare users, prompts, sessions, prompts per session and weekly measures by department.',
        'Expand an application to see departments and, if your organization permits individual reporting, people.',
        'Dynamic usage bands follow distinct prompts per active week within the selected population.',
        'Date, organization, reporting team, license and viewer access define the comparison scope.'
      ],
      tip: 'Expand M365 Copilot Chat, then a department, to understand where recorded application use is concentrated.',
      caution: 'Usage bands are relative and recalculate with scope; they are not permanent labels or employee-performance grades.'
    },
    {
      id: 'chat-trends', number: 14, title: 'Copilot Chat (Unlicensed): Usage Trends', area: 'Copilot Chat',
      question: 'How often do people without a Copilot license use Chat, and do they return the same day?',
      summary: 'Track recorded unlicensed chat activity separately from agents and other AI experiences.',
      image: 'assets/screenshots/14-chat-usage-trends.png',
      bullets: [
        'Headlines include Chat users, weekly prompts and sessions, month-over-month changes and weekly active days.',
        'The trend shows active people on the left and sessions/prompts per user per active week on the right.',
        'Each person\'s volume is divided by their active weeks before averaging across active unlicensed Chat users.',
        'Compare weekly measures by department and by dynamic usage rank.',
        'Daily repeat-session share counts active people with more than one Chat session that day.'
      ],
      tip: 'Read same-day repeat sessions alongside the weekly pattern rather than treating repeat sessions as value.',
      caution: 'These pages exclude agent, Cowork and unclassified activity. Unknown licensing is not included as unlicensed.'
    },
    {
      id: 'chat-habits', number: 15, title: 'Copilot Chat (Unlicensed): Habit Formation', area: 'Copilot Chat',
      question: 'Is Copilot Chat becoming a regular habit?',
      summary: 'Read unlicensed chat regularity using the same fixed monthly active-day bands.',
      image: 'assets/screenshots/15-chat-habit-formation.png',
      bullets: [
        'The printed habit month is the calendar month before the selected end date.',
        'Bands stay fixed at Light 1-5, Moderate 6-10, Frequent 11-15 and Daily 16+ days.',
        'Cards and previous-month bars use that month; departmental activity uses the whole selected period.',
        'The month-by-month view shows changes in the active-day mix.'
      ],
      tip: 'Align the habit month when comparing this page with the agent and licensed Copilot habit pages.',
      caution: 'Bands count distinct active days, not sessions, hours or all eligible people. Zero-day people are outside the four bands.'
    },
    {
      id: 'chat-leaderboard', number: 16, title: 'Copilot Chat (Unlicensed): Leaderboard', area: 'Copilot Chat',
      question: 'Which departments lead in Copilot Chat use, and how engaged are they?',
      summary: 'Compare recorded chat volume and regularity for people without a Microsoft 365 Copilot license.',
      image: 'assets/screenshots/16-chat-leaderboard.png',
      bullets: [
        'Department rows compare users, prompts, sessions, prompts per session and weekly measures.',
        'Engagement detail includes sessions per active week and last activity.',
        'Departments are the default view. Minimum Group Size 1 enables individual activity only when your organization\'s policies permit it.',
        'Person-level ranks are peer comparisons, not company-wide rankings.'
      ],
      tip: 'Use a department comparison to plan support, then confirm the context with the team.',
      caution: 'High chat volume can reflect useful work, retries or difficult tasks. The figures do not measure productivity or determine license eligibility.'
    },
    {
      id: 'metric-glossary', number: 17, title: 'Metric Glossary & Guide', area: 'Reference',
      question: 'What does this number mean, and how should I read it?',
      summary: 'Use the report\'s own definitions to check a metric, filter or privacy control.',
      image: null,
      bullets: [
        'Filter by Page to see the definitions for the report page you are reading.',
        'The glossary opens on Copilot Usage Explorer definitions.',
        'Read prompts, sessions, populations and time periods in plain language.',
        'Check Minimum Group Size setup and the difference between display grouping and access.',
        'User License Timeline explains First seen observations; it is not an additional report page.'
      ],
      tip: 'Check the page-specific definition before comparing two similarly named measures.',
      caution: 'Minimum Group Size does not anonymize the model or replace row-level security. No screenshot is available for this reference page.'
    }
  ],
  glossary: [
    { term: 'Prompts', definition: 'Distinct recorded user request messages, not agent responses. Repeated copies of the same request do not add another prompt; identifier quality affects counts.', category: 'Activity', aliases: 'requests messages Message_Id deduplication' },
    { term: 'Sessions', definition: 'Distinct person-and-thread conversations in the current selection. The same person returning to the same thread on several days can count once for the whole period.', category: 'Activity', aliases: 'conversations ThreadId user thread distinct' },
    { term: 'Prompts per session', definition: 'Recorded prompts divided by distinct sessions in the same scope. Conversation depth is not duration or business value.', category: 'Activity', aliases: 'conversation depth requests intensity' },
    { term: 'Eligible people', definition: 'People belonging to the selected authorized organization, team and license population, including those with no activity. This headcount drives the normal minimum-group check.', category: 'People', aliases: 'directory headcount people in scope denominator minimum group' },
    { term: 'Active users', definition: 'Distinct people with relevant recorded activity during the selected dates. Multiple recorded license states do not create extra people.', category: 'People', aliases: 'distinct people active population stable identity' },
    { term: 'Active licensed users', definition: 'Licensed people with any recorded experience in scope, including agent-only, Cowork, other AI or unclassified activity. This is broader than licensed chat users.', category: 'People', aliases: 'paid active licensed all activity' },
    { term: 'Inactive licensed users', definition: 'Licensed people with no recorded activity in the same selected scope. Active plus inactive reconciles to licensed directory headcount in that scope.', category: 'People', aliases: 'paid inactive no activity licensed seats' },
    { term: 'Unlicensed Chat users', definition: 'People recorded without a Microsoft 365 Copilot license who have qualifying Copilot Chat activity. Agents and unknown-license people are not silently included.', category: 'People', aliases: 'free chat unpaid Copilot Chat unlicensed' },
    { term: 'Unknown license', definition: 'License evidence is missing or inconclusive. Unknown is kept separate from licensed and unlicensed; it is not assumed to be free.', category: 'People', aliases: 'missing blank tri-state license status' },
    { term: 'Observed license history', definition: 'When collection keeps license history, the report remembers the license information recorded for each person. It uses those observations to group their activity. Changes that happened between observations may not be recorded.', category: 'Time', aliases: 'UserHistory On EffectiveDate temporal snapshot state UserKey' },
    { term: 'First seen', definition: 'The date a license state was observed, not when the license was assigned. Undated evidence remains Unknown; a current snapshot cannot recover earlier transitions.', category: 'Time', aliases: 'EffectiveDate assignment observation timeline' },
    { term: 'Monthly paid/free membership', definition: 'Paid membership includes people with a licensed state at any point in that month. A person can also appear in free membership, so distinct totals can be smaller than the sum.', category: 'Time', aliases: 'overlap monthly comparison cohorts paid free distinct' },
    { term: 'Active days per user', definition: 'Average distinct dates with recorded activity among active users in scope. It is not hours worked or time spent.', category: 'Activity', aliases: 'frequency regularity active dates' },
    { term: 'Per active week', definition: 'A person\'s relevant activity divided by weeks in which that person was active. Read the chart label: some views average these person-level rates; others show totals or per-user rates.', category: 'Time', aliases: 'weekly prompts sessions normalization denominator' },
    { term: 'Repeat users and return rate', definition: 'The share of active users with at least two sessions in the selected period. For agents, 0% means active users but no repeats; blank can mean no activity or protected scope.', category: 'Activity', aliases: 'repeat visits engagement retention return rate' },
    { term: 'Daily repeat-session share', definition: 'The share of active unlicensed Chat users with more than one Chat session that day. This daily measure differs from repeat users across the full period.', category: 'Activity', aliases: 'same day returning chat users' },
    { term: 'Habit month and bands', definition: 'The month before the selected end date. Light is 1-5, Moderate 6-10, Frequent 11-15 and Daily 16+ distinct active days; zero-day people are outside these fixed bands.', category: 'Time', aliases: 'previous selected month habit formation fixed ranges' },
    { term: 'Dynamic usage bands', definition: 'Percentile bands use distinct prompts per active week among active peers in each rank family. Dates and authorized population set thresholds; ties share a band. Independent family selections intersect without recalculating each other.', category: 'Comparisons', aliases: 'rank top ten percent bottom quartile 0 No Usage' },
    { term: 'Individual priority rank', definition: 'A relative unlicensed Chat comparison among selected peers in the same manager team, or the department root. Rank 1 is highest; ties share a rank. Individual reporting must be permitted by your organization\'s policies. This is not a performance rating.', category: 'Comparisons', aliases: 'employee rank licensing peer team leaderboard' },
    { term: 'License priority score', definition: 'An uncapped heuristic: 60% weekly volume / 10, 30% active days per week / 5, and 10% volume per active day / 5. Sessions is default; Prompts uses the same weights and benchmarks in prompt units.', category: 'Comparisons', aliases: '60 30 10 score not percentage heuristic prioritization' },
    { term: 'Reporting team', definition: 'A manager\'s direct and indirect reports, excluding the manager. Overlapping team selections count a person once and never expand the viewer\'s access.', category: 'People', aliases: 'hierarchy manager descendants organization filters' },
    { term: 'Minimum Group Size', definition: 'The smallest eligible group whose results can be displayed. The default is 3 people. A setting of 1 enables individual activity; use it only if your organization\'s privacy and employee-reporting policies permit it. This setting does not replace access controls or anonymize the data.', category: 'Privacy', aliases: 'privacy threshold suppression eligible headcount names By user' },
    { term: 'Reporting hierarchy role', definition: 'RLS matches the signed-in viewer\'s normalized UPN to a directory person and permits their own row and valid descendants. An unmatched identity receives no data.', category: 'Privacy', aliases: 'RLS security access fail closed viewer UPN' },
    { term: 'All data viewers role', definition: 'RLS role for explicitly authorized full-model access, initially with no members. Roles are additive; this role is not restricted by also belonging to Reporting hierarchy.', category: 'Privacy', aliases: 'RLS security full access role membership' },
    { term: 'Creator', definition: 'Catalog ownership metadata: Created by, then legacy Agent creator. Missing values say Not recorded. Creator metadata can be visible at group size 3 without exposing individual usage.', category: 'Agents', aliases: 'owner builder created by ownership top builder' },
    { term: 'Developer Name', definition: 'The agent developer or publisher, separate from Creator. Missing or generic placeholders say Not stated. A third-party store publisher is not a creator in your tenant.', category: 'Agents', aliases: 'publisher third party developer Not stated' },
    { term: 'Agent type', definition: 'Where an agent was created, such as Copilot Studio or Agent Builder. Catalog labels are used when that information is missing. Type is separate from whether the agent matches the catalog.', category: 'Agents', aliases: 'platform Agent Builder Copilot Studio Microsoft agent in-house' },
    { term: 'Catalog status', definition: 'In catalog, Not in Agent 365 catalog (activity only), or Ambiguous catalog match. Catalog agents count distinct Title IDs, not names; export timing can affect matching.', category: 'Agents', aliases: 'TitleID identity activity-only ambiguous match inventory' },
    { term: 'Features', definition: 'Catalog-listed supported surfaces and capabilities, such as Teams, Outlook, SharePoint or files. Listed support does not demonstrate recorded use of that feature.', category: 'Agents', aliases: 'capabilities surfaces support catalog metadata' },
    { term: 'System-generated agents', definition: 'Special catalog entries excluded by default. Include system agents in Org filters to see them; they are not ordinary builder or action-oriented review targets.', category: 'Agents', aliases: 'system agent Include system agents generated' },
    { term: 'Usage not tracked here', definition: 'Security Copilot catalog entries have activity outside this dashboard\'s tracking scope. This label is not evidence that the agent has never been used.', category: 'Agents', aliases: 'Microsoft Security Copilot excluded coverage untracked' },
    { term: 'Dormant and No usage', definition: 'Dormant means previously used with last activity more than 60 days before the selected end. Never-used agents are No usage, not Dormant; labels follow the selected scope.', category: 'Agents', aliases: 'recency last activity Never Used health check review' },
    { term: 'Inferred usage patterns', definition: 'Stored PAX behavior labels use resource/action/context/plugin/app-host evidence and sometimes agent names, not prompt-text analysis or AI inference. Not enough activity to infer explains missing evidence.', category: 'Agents', aliases: 'use cases inferred tasks not outcomes patterns' },
    { term: 'Agent engagement comparison', definition: 'Equal-weight peer percentile ranks for return rate, sessions per user and prompts per session, requiring MAX(Minimum Group Size, 5) users. Sessions, then name, break ties; this is not business value.', category: 'Comparisons', aliases: 'Top 10 use cases engagement ranking' },
    { term: 'Other AI and Unclassified activity', definition: 'Other AI can include non-agent autonomous or logic app hosts. Unclassified preserves activity that cannot be confidently assigned; neither category is automatically unlicensed Chat.', category: 'Activity', aliases: 'experience classification unknown host Cowork' },
    { term: 'Prepared inputs', definition: 'Matching Users and Interactions files prepared by PAX, or the tables required by your chosen Fabric OneLake edition. Raw audit exports cannot be used in place of these prepared inputs.', category: 'Setup', aliases: 'Dashboard AIO processor preparation CSV state keys' },
    { term: 'Fabric OneLake notebook readiness', definition: 'The Fabric OneLake preparation notebook marks its report tables Ready after its checks succeed. The SQL analytics endpoint must also finish synchronizing before Power BI refresh. Do not update tables during that refresh.', category: 'Refresh', aliases: 'Fabric OneLake aio_v2 Ready Publishing generation gate' },
    { term: 'Fabric OneLake PAX readiness', definition: 'PAX must finish updating the matching Fabric OneLake tables before Power BI refresh. Wait for SQL synchronization and keep table updates paused for the entire refresh. Template checks of data structure and user links do not prove every table comes from the same completed update.', category: 'Refresh', aliases: 'PAX tables Fabric OneLake SQL synchronization Agent365 Import' },
    { term: 'Power BI Import', definition: 'Power BI keeps an imported copy of the source data and updates it when the report refreshes. Both Fabric OneLake editions use the Lakehouse SQL analytics endpoint, not Direct Lake. Source access and report-viewer access are separate.', category: 'Refresh', aliases: 'SQL endpoint OneLake connection credentials semantic model' },
    { term: 'Audit coverage', definition: 'Purview audit data supports security and compliance. Coverage, timing and calculations can differ from Viva Insights and the Microsoft 365 admin center; prompts do not measure responses, duration, time saved or performance.', category: 'Activity', aliases: 'Viva MAC differences official usage metrics response counts' }
  ],
  faqs: [
    { q: 'Which edition should I choose?', a: 'Use Fabric OneLake if your team manages data in a Lakehouse: choose the notebook route for notebook collection, or the PAX route for PAX-produced Fabric OneLake tables. The Fabric OneLake PAX template download is coming soon. Use SharePoint for PAX CSV files with cloud refresh. Use Local CSV to try the sample or explore files in Desktop.', category: 'Setup' },
    { q: 'Can I try the report without an administrator or tenant data?', a: 'Yes. Download Local CSV and the three synthetic sample files. Extract the Interactions CSV from the ZIP, put all three CSVs in a local folder, then paste their full paths into the template. The sample needs Power BI Desktop, not PAX or tenant permissions.', category: 'Setup' },
    { q: 'What do I need to export my own data?', a: 'Ask IT to confirm audit logging, data access and the required collection permissions. Open PAX Cookbook Mini-Kitchen, choose AI-in-One and your destination, then follow its download and command instructions. PAX uses PowerShell 7 or later and Python 3.10 or later for preparation. Open the report template in Power BI Desktop.', category: 'Setup' },
    { q: 'Can I load a raw Purview export directly?', a: 'No. Use the dashboard-ready Users and Interactions from the same PAX AIO seed and its appends. If you already have raw audit and directory CSVs, the optional standalone processor can prepare them; PAX is the simpler route because it also collects and maintains the inputs.', category: 'Data' },
    { q: 'Which SharePoint address should I paste?', a: 'Select the file in its document library, open Details, and copy Path. Use the full HTTPS file path, not a sharing/viewer link or the browser address bar. For Local CSV, use File Explorer Copy as path and remove surrounding quotation marks.', category: 'Setup' },
    { q: 'Is the Agent 365 catalog required?', a: 'It is recommended, not required. Leave the optional Agent 365 file parameter blank for activity-only reporting. In the Fabric OneLake PAX edition, leave Load Agent365 catalog false unless a valid, synchronized Agent365 table is available. Enabling it requires access to that table and the catalog information the template expects.', category: 'Data' },
    { q: 'Why do report buttons not respond in Power BI Desktop?', a: 'Hold Ctrl while clicking a report button in Desktop edit mode. Published report readers use a normal click. Clear filters resets selections and expanded tables without moving to another page or changing access rights.', category: 'Troubleshooting' },
    { q: 'Why are names or By user views hidden?', a: 'Minimum Group Size defaults to 3, intentionally hiding individual activity. Keep that setting for team reporting. If your organization\'s privacy and employee-reporting policies permit individual reporting, the report owner can change the existing parameter to 1 under Home > Transform data > Manage parameters, apply changes and clear old person selections. Check with your privacy or HR team if you are unsure.', category: 'Privacy' },
    { q: 'Can a team with only two active users show results?', a: 'Yes, if at least three eligible people belong to the selected authorized group at the default threshold. A team of 20 with two active users can show aggregate results; a team of two cannot. The normal threshold is eligible headcount, not active-user count.', category: 'Privacy' },
    { q: 'Does Minimum Group Size replace access control?', a: 'No. It suppresses report display; it does not anonymize the model. Before sharing, assign appropriate RLS roles, control report/export access and protect source files, SQL and OneLake separately. Workspace Admins, Members and Contributors are not restricted like report Viewers.', category: 'Privacy' },
    { q: 'Why can a viewer open the report but see no data?', a: 'The report owner should check Security role membership for the semantic model, then test the viewer\'s sign-in. The role named Reporting hierarchy needs that sign-in to match a person in the directory. Also check dates and Minimum Group Size. The role named All data viewers gives access to the whole dataset; assign it only when that level of access is appropriate under your organization\'s policies.', category: 'Troubleshooting' },
    { q: 'Why do counts differ from Viva Insights or the admin center?', a: 'Compare the exact people, dates, time zone, license population and activity definition first. Audit coverage, timing and calculations differ from official usage reports. An audit-based all-activity prompt total is not the same metric as a Chat-only prompt headline.', category: 'Data' },
    { q: 'Are active licensed users the same as licensed chat users?', a: 'No. Active licensed includes any recorded experience, including agent-only activity. Chat-specific charts use their own narrower population. Active plus inactive licensed reconciles to licensed directory headcount in the same scope; missing license evidence stays Unknown.', category: 'Data' },
    { q: 'Why can paid and free counts add up to more than the total?', a: 'A person with observed license changes can belong to both populations during a selected period. Monthly paid membership includes a licensed state at any point that month. Count distinct people for totals rather than adding state rows or paid/free groups.', category: 'Data' },
    { q: 'Does First seen tell me when a license was assigned?', a: 'No. It tells you when collection first recorded that license state. If Monday\'s collection shows a person without a license and Friday\'s shows a license, the change happened somewhere in between; the report cannot tell you the exact assignment time. History starts with what collection records and does not recover earlier changes.', category: 'Data' },
    { q: 'Why do habit cards differ from the activity table?', a: 'The cards use the printed month before the selected range ends. Activity tables use the whole selected period. The four habit bands are always 1-5, 6-10, 11-15 and 16+ distinct active days; people with zero days are outside them.', category: 'Data' },
    { q: 'Do agent scores measure productivity or business value?', a: 'No. Engagement combines peer-relative repeat use and conversation-depth signals. Use-case labels come from stored activity evidence, not prompt-text analysis. Confirm the explanation with the team; do not use these figures alone for employee, licensing or agent-removal decisions.', category: 'Data' },
    { q: 'How do I keep file-based data current?', a: 'Use Mini-Kitchen for both the first PAX collection and later updates. First, collect the history you need. For updates, have Mini-Kitchen create a command that adds new days to those same matching files. IT can schedule that command and refresh Power BI after the data update finishes. Mini-Kitchen creates commands; it does not run or schedule them for you.', category: 'Refresh' },
    { q: 'Does scheduled refresh need a gateway?', a: 'SharePoint normally uses an organizational cloud connection without a gateway. Local or network files require a gateway that can read the same paths, or manual Desktop refresh and republishing. Fabric OneLake uses a SQL cloud connection; private networking or your organization\'s policies may add requirements.', category: 'Refresh' },
    { q: 'What is the Fabric OneLake notebook refresh order?', a: 'Run collection, then preparation. Wait for the SQL analytics endpoint to show the completed Fabric OneLake report tables and their Ready status with matching counts. Do not update tables during Power BI refresh. Configure SQL and any optional SharePoint credentials, try Refresh now, then check a scheduled refresh succeeds.', category: 'Refresh' },
    { q: 'Can I use PAX-produced Fabric OneLake tables with the notebook template?', a: 'No. Use the separate Fabric OneLake PAX edition for AIO_Users, AIO_CopilotInteractions and optional Agent365 tables. It needs a completed data update, SQL synchronization and no table writes during the full Power BI refresh. The Fabric OneLake notebook edition uses different prepared tables.', category: 'Refresh' },
    { q: 'Why is a newly enabled audit export nearly empty?', a: 'Enabling audit logging does not recover the past. Allow up to 24 hours for records to appear, then collect again. Check available history and collection dates before requesting an older period.', category: 'Troubleshooting' },
    { q: 'Why is a catalog field or agent activity blank?', a: 'Not recorded is missing Creator; Not stated is missing or generic Developer Name. A blank return rate can mean no activity or protected scope; 0% means active users with no repeats. Security Copilot usage is not tracked here, and system-generated agents are excluded by default. Check scope and the field explanation before changing data.', category: 'Troubleshooting' },
    { q: 'Where should I ask for help?', a: 'Start with your report owner or IT administrator. Tell them which data connection you use, what you were trying to do and the error message, with private details removed. You can also email the Microsoft Copilot Analytics team. Never share real audit exports, prompt content, tenant identifiers, access tokens, secrets or sensitive logs in a public issue.', category: 'Troubleshooting' }
  ],
  permissions: [
    { when: 'Every PAX activity export', permission: 'AuditLogsQuery.Read.All', note: 'Microsoft Graph permission for audit queries. Audit data must also be enabled and available under the tenant\'s licensing and retention policy.' },
    { when: 'Every PAX AI-in-One run', permission: 'User.Read.All and Organization.Read.All', note: 'People, organizational attributes and licensing. Interactive collection uses the signed-in person\'s access; unattended collection needs application permissions with administrator consent.' },
    { when: 'PAX Agent 365 catalog collection', permission: 'CopilotPackages.Read.All and Application.Read.All', note: 'Required only when collecting the recommended catalog. These permissions do not grant Power BI report access.' },
    { when: 'PAX app or managed identity writes to SharePoint', permission: 'Sites.Selected plus a site-specific write grant', note: 'Sites.Selected alone grants access to no sites. An administrator grants the selected identity access only to the intended destination site.' },
    { when: 'Interactive PAX writes to SharePoint', permission: 'Sites.ReadWrite.All', note: 'PAX requests this delegated permission at sign-in; the signed-in person must already be able to edit the destination.' },
    { when: 'PAX -GroupNames filtering', permission: 'GroupMember.Read.All', note: 'Optional; needed only when filtering collection to security groups.' },
    { when: 'Fabric OneLake notebook collectors', permission: 'AuditLogsQuery.Read.All, User.Read.All and Reports.Read.All', note: 'Application permissions with administrator consent. These collectors prepare different Fabric OneLake tables from the PAX route. Store their client secret in Key Vault; never in notebook cells.' },
    { when: 'Running Fabric OneLake notebook preparation', permission: 'Fabric OneLake notebook execution and Lakehouse table-write access', note: 'Active Spark capacity is required. Collectors also need permission to retrieve the designated Key Vault secret. Running preparation directly on processed PAX CSV files does not need Graph collector credentials.' },
    { when: 'Refreshing a Fabric OneLake report', permission: 'SQL endpoint/database access and SELECT on the required tables', note: 'Give the refresh identity access to the chosen Fabric OneLake edition\'s tables. Configure optional SharePoint catalog credentials separately for the Fabric OneLake notebook edition.' },
    { when: 'Refreshing file-based reports', permission: 'Read access to every configured source file', note: 'SharePoint uses the refresh account\'s organizational credentials. Local/network scheduled refresh also needs a gateway identity that can read the exact paths.' },
    { when: 'Sharing the report with viewers', permission: 'Report access plus the correct Power BI security role', note: 'Assign the role named Reporting hierarchy, or All data viewers when full access is appropriate under your policies. The roles combine their permissions. Test real viewer accounts; report security does not protect direct source access.' }
  ],
  resources: [
    { title: 'Power BI Desktop', description: 'Get Microsoft\'s desktop application to open a PBIT template.', kind: 'Microsoft download', href: 'https://aka.ms/powerbidesktop' },
    { title: 'PowerShell', description: 'Install PowerShell 7 or later for the PAX exporter.', kind: 'Microsoft download', href: 'https://aka.ms/PowerShell' },
    { title: 'Audit Copilot activity', description: 'Understand the Purview audit source and its security/compliance purpose.', kind: 'Microsoft Learn', href: 'https://learn.microsoft.com/en-us/purview/audit-copilot' },
    { title: 'Why audit and usage counts differ', description: 'Microsoft explains coverage and timing differences from official Copilot usage reporting.', kind: 'Microsoft Learn', href: 'https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-usage#whats-the-difference-between-the-user-activity-table-and-audit-log' },
    { title: 'Power BI row-level security', description: 'Configure and test viewer access before sharing your report.', kind: 'Microsoft Learn', href: 'https://learn.microsoft.com/en-us/fabric/security/service-admin-row-level-security' },
    { title: 'On-premises data gateway', description: 'Set up scheduled refresh for files on a PC or network share.', kind: 'Microsoft Learn', href: 'https://learn.microsoft.com/en-us/power-bi/connect-data/service-gateway-onprem' },
    { title: 'Power BI refresh', description: 'Configure credentials, connections and refresh for your source.', kind: 'Microsoft Learn', href: 'https://learn.microsoft.com/en-us/power-bi/connect-data/refresh-data' },
    { title: 'Fabric OneLake notebook setup guide', description: 'Detailed setup for Fabric OneLake notebook collection and preparation. The Fabric OneLake PAX route uses different tables.', kind: 'Guide download', href: 'https://raw.githubusercontent.com/microsoft/AI-in-One-Dashboard/preview/Fabric%20OneLake/AI-in-One%20-%20v2.0.0%20-%20Fabric%20OneLake%20Template/README.md' }
  ]
};
