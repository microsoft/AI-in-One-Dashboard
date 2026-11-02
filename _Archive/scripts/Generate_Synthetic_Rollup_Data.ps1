<#
.SYNOPSIS
    Generates synthetic (fictional) demo data in the AI-in-One Dashboard
    Rollup Edition input format.

.DESCRIPTION
    Produces the three CSV files the Rollup Edition PBIT consumes:

        <Prefix>_Interactions_<timestamp>.csv   -> "Copilot Interactions File" parameter
        <Prefix>_Users_<timestamp>.csv          -> "Org Data File" parameter
        Agent365_<timestamp>.csv                -> "Agent 365 (highly recommended)" parameter

    Column names, ordering, value domains and all derived/classification
    columns are ported verbatim from scripts/Rollup_Processor_v3.0.0.py so the
    output is a drop-in substitute for real PAX rollup output.

    NO REAL TENANT DATA IS USED OR REQUIRED. Every user, agent, document and
    interaction is invented for the fictional "Contoso Ltd" tenant.

.EXAMPLE
    .\Generate_Synthetic_Rollup_Data.ps1 -OutDir "C:\Data\Synthetic"

.EXAMPLE
    .\Generate_Synthetic_Rollup_Data.ps1 -UserCount 800 -Days 180 -Seed 7
#>
[CmdletBinding()]
param(
    [string] $OutDir = '',
    [int]    $UserCount = 150,
    [int]    $Days = 90,
    [datetime] $EndDate = [datetime]::Today,
    [int]    $Seed = 20260918,
    [double] $LicensedShare = 0.55,
    [string] $Domain = 'contoso.com',
    [string] $Prefix = 'Purview_Audit_Synthetic',
    [string] $UsersPrefix = 'EntraUsers_MAClicensing_Synthetic',
    [switch] $Quiet
)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) {
    $root = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
    $OutDir = Join-Path $root 'sample-data'
}
$rand = [System.Random]::new($Seed)

function Get-Rand { $rand.NextDouble() }
function Get-RandInt([int]$minInclusive, [int]$maxExclusive) { $rand.Next($minInclusive, $maxExclusive) }
function Get-RandItem($array) { $array[$rand.Next(0, $array.Count)] }

# Weighted pick over an array of hashtables each carrying a numeric 'W' key.
function New-WeightedPicker($items) {
    $cum = New-Object 'double[]' $items.Count
    $total = 0.0
    for ($i = 0; $i -lt $items.Count; $i++) {
        $total += [double]$items[$i].W
        $cum[$i] = $total
    }
    [pscustomobject]@{ Items = $items; Cum = $cum; Total = $total }
}
function Get-WeightedItem($picker) {
    $r = $rand.NextDouble() * $picker.Total
    $cum = $picker.Cum
    for ($i = 0; $i -lt $cum.Length; $i++) {
        if ($r -le $cum[$i]) { return $picker.Items[$i] }
    }
    return $picker.Items[$picker.Items.Count - 1]
}

# ---------------------------------------------------------------------------
# Classification logic — verbatim ports of Rollup_Processor_v3.0.0.py
# ---------------------------------------------------------------------------

$LicenseTruthy = @('YES', 'TRUE', 'Y', '1')
$ActiveResActionTokens = @('send', 'draft', 'create', 'post', 'invoke', 'write', 'patch', 'execute')

function Get-LicenseStatus([string]$hasLicenseRaw) {
    if ($LicenseTruthy -contains $hasLicenseRaw.Trim().ToUpperInvariant()) { 'M365 Copilot Licensed' } else { 'Unlicensed' }
}

function Get-Environment([string]$hasLicenseRaw, [string]$agentName, [string]$agentId, [string]$appHost) {
    $h = $appHost.ToLowerInvariant()
    $hasAgent = ($agentName.Trim() -ne '') -or ($agentId.Trim() -ne '')
    if ($h -eq 'autonomous' -or $h -eq 'logic app') { return 'Autonomous Agent' }
    if ($h -like '*cowork*') { return 'Cowork' }
    if ($hasAgent) { return 'Agents' }
    if ($LicenseTruthy -contains $hasLicenseRaw.Trim().ToUpperInvariant()) { return 'Licensed M365 Copilot' }
    return 'Unlicensed Chat'
}

function Get-IsSensitive([string]$sensLabel, [string]$resourceSensLabel) {
    if ($sensLabel.Trim() -or $resourceSensLabel.Trim()) { 'TRUE' } else { 'FALSE' }
}

function Get-AiModel([string]$modelName) {
    $m = $modelName.ToUpperInvariant()
    if (-not $m -or $m -eq 'NULL') { return 'Embedded App (no model logged)' }
    if ($m -like '*DEEP_LEO*') { return 'GPT-4 (Standard)' }
    if ($m -like '*REASONING*') { return 'Reasoning Model (o1/o3)' }
    if ($m -like '*OFFENSIVE*') { return 'Safety Filter (blocked)' }
    if ($m -like '*GPT-41*' -or $m -like '*GPT-4.1*') { return 'GPT-4.1 (Next Gen)' }
    if ($m -like '*O3-MINI*' -or $m -like '*O3MINI*') { return 'o3-mini (Reasoning)' }
    if ($m -like '*O3*' -or $m -like '*O1*') { return 'Reasoning Model (o-series)' }
    if ($m -like '*GPT-5*' -or $m -like '*GPT5*') { return 'GPT-5 (Next Gen)' }
    if ($m -like '*CLAUDE*') { return 'Claude (Anthropic)' }
    if ($m -like '*GEMINI*') { return 'Gemini (Google)' }
    if ($m -like '*LLAMA*' -or $m -like '*META*') { return 'LLaMA (Meta)' }
    if ($m -like '*PHI*') { return 'Phi (Microsoft Small Model)' }
    return $modelName
}

function Get-ResourceBehavior([string]$resType, [string]$resAction, [string]$siteUrl, [bool]$isActive) {
    if (@('sendemailv2', 'draftemail', 'senddraftemail', 'updatedraftemail') -contains $resAction) { return 'Email Drafting' }
    if ($resType -eq 'emailmessage') { if ($isActive) { return 'Email Drafting' } else { return 'Email Summarising' } }
    if ($resAction -eq 'mcp_meetingmanagement') { return 'Meeting Scheduling' }
    if (@('event', 'teamsmeeting') -contains $resType) { return 'Meeting Prep' }
    if (@('postmessagetoconversation', 'createchat') -contains $resAction) { return 'Teams Messaging' }
    if (@('teamsmessage', 'teamschat', 'teamschannel') -contains $resType) { return 'Teams Messaging' }
    if (@('flow', 'connector', 'http') -contains $resType) { return 'Workflow Execution' }
    if (@('executedatasetquery', 'getitems', 'getalltables', 'gettableviews') -contains $resAction) { return 'Data Querying' }
    if (@('xlsx', 'csv', 'xlsm', 'xlsb', 'xls') -contains $resType) { if ($isActive) { return 'Excel Assistance' } else { return 'Spreadsheet Review' } }
    if ($resType -eq 'peopleinferenceanswer') { return 'People Lookup' }
    if (@('listitem', 'aspx') -contains $resType) { return 'Enterprise Searching' }
    if ($resType -eq 'websearchquery') { return 'Web Searching' }
    if ($resType -eq 'pdf') { return 'PDF Analysis' }
    if ((@('py', 'js', 'java', 'tsx', 'jsx', 'css', 'php', 'sh') -contains $resType) -and $isActive) { return 'Code Writing' }
    if (@('py', 'sql', 'js', 'java', 'json', 'xml', 'html', 'yaml', 'yml', 'txt') -contains $resType) { return 'Code Analysis' }
    if ((@('png', 'jpg', 'jpeg', 'svg', 'gif') -contains $resType) -and $isActive) { return 'Image Generation' }
    if (@('png', 'jpg', 'jpeg', 'gif') -contains $resType) { return 'Image / Media Analysis' }
    if (@('streamvideo', 'mp4', 'mov', 'webm', 'mkv') -contains $resType) { return 'Video Summarising' }
    if (@('planid', 'taskids') -contains $resType) { return 'Task Management' }
    if ($resType -eq 'looppage') { return 'Real-time Collaboration' }
    if ($resType -eq 'http://schema.skype.com/hyperlink') {
        foreach ($t in @('github.com', 'stackoverflow.com', 'npmjs.com', 'pypi.org', 'docker.com', 'kubernetes.io', 'leetcode.com')) {
            if ($siteUrl.Contains($t)) { return 'Code Analysis' }
        }
        foreach ($t in @('learning.cloud.microsoft', 'coursera.org', 'udemy.com')) {
            if ($siteUrl.Contains($t)) { return 'Agent: Coaching' }
        }
        if ($siteUrl.Contains('sharepoint.com')) { return 'Enterprise Searching' }
        return 'Web Searching'
    }
    if (@('external', 'http') -contains $resType) { return 'Web Searching' }
    if (@('docx', 'doc', 'rtf') -contains $resType) {
        if ($isActive) { return 'Document Drafting' }
        if ($resAction -eq 'read') { return 'File Retrieval' }
        return 'Document Summarising'
    }
    if (@('pptx', 'ppt', 'potx') -contains $resType) {
        if ($isActive) { return 'Presentation Creation' }
        if ($resAction -eq 'read') { return 'File Retrieval' }
        return 'Presentation Summarising'
    }
    if ($siteUrl.Contains('service-now.com') -or $siteUrl.Contains('servicenow.com')) { return 'Agent: IT & Service Desk' }
    if ($siteUrl.Contains('dynamics.com')) { return 'Agent: Sales & Customer' }
    return ''
}

function Get-ContextBehavior([string]$appHost, [string]$ctxType, [bool]$isActive) {
    if ($ctxType -eq 'teamsmeeting') { return 'Meeting Prep' }
    if ($ctxType -eq 'streamvideo') { return 'Video Summarising' }
    if ($ctxType -eq 'docx') { if ($appHost -eq 'word' -and $isActive) { return 'Document Drafting' } else { return 'Document Summarising' } }
    if (@('xlsx', 'xlsm', 'xlsb', 'xls', 'csv') -contains $ctxType) { return 'Spreadsheet Review' }
    if (@('pptx', 'pptm') -contains $ctxType) { if ($appHost -eq 'powerpoint' -and $isActive) { return 'Presentation Creation' } else { return 'Presentation Summarising' } }
    if (@('teamschat', 'teamschannel') -contains $ctxType) { return 'Teams Messaging' }
    if ($ctxType -eq 'aspx') { return 'Enterprise Searching' }
    if (@('outlook', 'outlooksidepane') -contains $appHost) { if ($isActive) { return 'Email Drafting' } else { return 'Email Summarising' } }
    if ($appHost -eq 'excel') { return 'Excel Assistance' }
    if ($appHost -eq 'word') { if ($isActive) { return 'Document Drafting' } else { return 'Document Summarising' } }
    if ($appHost -eq 'powerpoint') { if ($isActive) { return 'Presentation Creation' } else { return 'Presentation Summarising' } }
    if ($appHost -eq 'stream') { return 'Video Summarising' }
    if ($appHost -eq 'sharepoint') { return 'SharePoint Access' }
    if ($appHost -eq 'designer') { return 'Image Generation' }
    if ($appHost -eq 'onenote') { return 'Note Taking' }
    if ($appHost -eq 'forms') { return 'Form / Survey Work' }
    if ($appHost -eq 'planner') { return 'Task Management' }
    if (@('loop', 'whiteboard', 'vivaengage') -contains $appHost) { return 'Real-time Collaboration' }
    if ($appHost -eq 'copilot studio') { return 'Domain-Specific Agent' }
    if (@('autonomous', 'logic app') -contains $appHost) { return 'Workflow Execution' }
    if (@('datawarehousing core', 'power bi') -contains $appHost) { return 'Data Querying' }
    return 'General Chat'
}

function Get-BehaviorCategory([string]$appHost, [string]$ctxType, [string]$resType, [string]$resAction, [string]$siteUrl, [string]$pluginId) {
    $appHostL = $appHost.ToLowerInvariant()
    $ctxL = $ctxType.ToLowerInvariant()
    $resTL = $resType.ToLowerInvariant()
    $resAL = $resAction.ToLowerInvariant()
    $siteL = $siteUrl.ToLowerInvariant()
    $pluginL = $pluginId.ToLowerInvariant()

    $isActive = $false
    foreach ($tok in $ActiveResActionTokens) { if ($resAL.Contains($tok)) { $isActive = $true; break } }

    $fromResource = Get-ResourceBehavior $resTL $resAL $siteL $isActive
    if ($fromResource) { return $fromResource }
    if ($pluginL -eq 'enterprisesearch') { return 'Enterprise Searching' }
    return (Get-ContextBehavior $appHostL $ctxL $isActive)
}

$GenericQaBehaviors = @('General Q&A', 'M365 Chat Q&A', 'Teams Q&A', 'Browser Q&A', 'General Chat')
$AgentNameRules = @(
    @{ Tokens = @('coach', 'mentor', 'learning', 'career'); Label = 'Agent: Coaching' },
    @{ Tokens = @('research', 'analyst', 'analy'); Label = 'Agent: Research & Analysis' },
    @{ Tokens = @('sales', 'commercial', 'customer', 'crm', 'revenue'); Label = 'Agent: Sales & Customer' },
    @{ Tokens = @('hr', 'recruit', 'talent', 'onboard', 'people'); Label = 'Agent: HR & People' },
    @{ Tokens = @('policy', 'compliance', 'legal', 'audit', 'risk'); Label = 'Agent: Compliance & Policy' },
    @{ Tokens = @('service', 'support', 'help', 'ticket', 'incident'); Label = 'Agent: IT & Service Desk' },
    @{ Tokens = @('summar', 'draft', 'translat', 'editor'); Label = 'Agent: Content Generation' },
    @{ Tokens = @('data', 'report', 'dashboard', 'metric'); Label = 'Agent: Data & Reporting' },
    @{ Tokens = @('knowledge', 'faq', 'wiki', 'buddy', 'guide'); Label = 'Agent: Knowledge Base' },
    @{ Tokens = @('idea', 'brainstorm', 'creative', 'design'); Label = 'Agent: Ideation & Creative' }
)

function Get-BehaviorEnriched([string]$behaviorCategory, [string]$agentName, [string]$environment) {
    if ($environment -ne 'Agents' -and $environment -ne 'Autonomous Agent') { return $behaviorCategory }
    if ($GenericQaBehaviors -notcontains $behaviorCategory) { return $behaviorCategory }
    $nameL = $agentName.ToLowerInvariant()
    foreach ($rule in $AgentNameRules) {
        foreach ($t in $rule.Tokens) { if ($nameL.Contains($t)) { return $rule.Label } }
    }
    return 'Agent: General Purpose'
}

function Get-AutonomyPattern([string]$environment) {
    switch ($environment) {
        'Licensed M365 Copilot' { '1 - Copilot' }
        'Agents' { '2 - Agent-Assisted' }
        'Autonomous Agent' { '3 - Autonomous' }
        default { '' }
    }
}

function Get-BehaviorSource([string]$behaviorCategory, [string]$environment, [string]$agentName, [string]$pluginName, [string]$appHost) {
    $agent = $agentName.Trim()
    $plugin = $pluginName.Trim()
    $app = $appHost.Trim()
    if ($environment -eq 'Autonomous Agent') {
        $source = 'Autonomous Agent'
        if ($agent) { $source = "Autonomous Agent: $agent" }
    }
    elseif ($environment -eq 'Agents' -and $agent) { $source = "Agent: $agent" }
    elseif ($plugin) { $source = "$app ($plugin)" }
    elseif ($app) { $source = $app }
    else { $source = 'Copilot Chat' }
    return "$behaviorCategory $([char]0x2192) $source"
}

$VoTimeEmail = @('Email Summarising', 'Email Triage', 'Email Thread Summary')
$VoTimeMeet = @('Meeting Prep', 'Video Summarising')
$VoTimeDoc = @('Document Summarising', 'Presentation Summarising', 'Note Taking')
$VoSearch = @('Web Searching', 'Enterprise Searching', 'File Retrieval', 'PDF Analysis', 'SharePoint Access', 'People Lookup', 'Agent: Knowledge Base')
$VoComm = @('Teams Messaging', 'Meeting Scheduling')
$VoSheet = @('Spreadsheet Review', 'Spreadsheet Analysis', 'Excel Assistance')
$VoContent = @('Email Drafting', 'Document Drafting', 'Presentation Creation', 'Image Generation', 'Image / Media Analysis', 'Image/Media Analysis', 'Agent: Content Generation', 'Agent: Ideation & Creative')
$VoTeamCollab = @('Real-time Collaboration', 'Form / Survey Work')
$VoData = @('Data Querying', 'Agent: Data & Reporting', 'Agent: Research & Analysis')
$VoCode = @('Code Writing', 'Code Analysis', 'Code Analysis (URL)')
$VoCoach = @('Agent: Coaching', 'Agent: Coaching (URL)')
$VoDomain = @('Domain-Specific Agent', 'Cross-Org Agent')

function Get-ValueOutcome([string]$behaviorEnriched, [string]$environment, [string]$isSensitive) {
    $b = $behaviorEnriched
    if ($VoTimeEmail -contains $b) { return 'Time Saved (Email)' }
    if ($VoTimeMeet -contains $b) { return 'Time Saved (Meetings)' }
    if ($VoTimeDoc -contains $b) { return 'Time Saved (Documents)' }
    if ($VoSearch -contains $b) { return 'Search Time Saved' }
    if ($VoComm -contains $b) { return 'Communication Time Saved' }
    if ($VoSheet -contains $b) { return 'Spreadsheet Time Saved' }
    if ($VoContent -contains $b) { return 'Content Output' }
    if ($VoTeamCollab -contains $b) { return 'Team Collaboration' }
    if ($b -eq 'Workflow Execution' -or $environment -eq 'Autonomous Agent') { return 'Workflow Automation' }
    if ($b -eq 'Task Management') { return 'Task Coordination' }
    if ($isSensitive -eq 'TRUE' -and $environment -ne 'Agents' -and $environment -ne 'Autonomous Agent') { return 'Compliance & Risk' }
    if ($VoData -contains $b) { return 'Data-Driven Decisions' }
    if ($VoCode -contains $b) { return 'Coding Capability' }
    if ($VoCoach -contains $b) { return 'Skills Development' }
    if ($b -eq 'Agent: Sales & Customer') { return 'Revenue Enablement' }
    if ($b -eq 'Agent: IT & Service Desk') { return 'Service Desk Deflection' }
    if ($b -eq 'Agent: Compliance & Policy') { return 'Compliance & Risk' }
    if ($b -eq 'Agent: HR & People') { return 'HR Expertise' }
    if ($VoDomain -contains $b) { return 'Specialist Expertise' }
    return 'General AI Productivity'
}

# ---------------------------------------------------------------------------
# Synthetic population (fictional Contoso Ltd)
# ---------------------------------------------------------------------------

$FirstNames = @('Aisha', 'Alex', 'Amara', 'Andre', 'Anika', 'Benedikt', 'Bianca', 'Carlos', 'Cathy', 'Chen', 'Chloe', 'Daniel',
    'Deepa', 'Diego', 'Elena', 'Eli', 'Emeka', 'Erin', 'Fatima', 'Felix', 'Gabriel', 'Grace', 'Hana', 'Harold',
    'Ines', 'Ivan', 'Jasmin', 'Javier', 'Jonas', 'Julia', 'Kai', 'Karin', 'Kenji', 'Lars', 'Laura', 'Leon',
    'Liam', 'Lina', 'Lucas', 'Maja', 'Marco', 'Maria', 'Mateo', 'Mei', 'Nadia', 'Niall', 'Nina', 'Noah',
    'Olivia', 'Omar', 'Paula', 'Pedro', 'Priya', 'Rafael', 'Rania', 'Ravi', 'Rosa', 'Sanjay', 'Sara', 'Sofia',
    'Sven', 'Tariq', 'Thomas', 'Tomas', 'Valentina', 'Viktor', 'Wei', 'Yara', 'Yusuf', 'Zoe')
$LastNames = @('Adeyemi', 'Alvarez', 'Andersen', 'Bauer', 'Bennett', 'Bianchi', 'Brandt', 'Carlson', 'Chen', 'Costa',
    'Dubois', 'Eriksen', 'Ferrari', 'Fischer', 'Garcia', 'Gruber', 'Hansen', 'Hoffmann', 'Ibrahim', 'Jensen',
    'Kaur', 'Keller', 'Kowalski', 'Kumar', 'Larsen', 'Lehmann', 'Lindqvist', 'Lopez', 'Martins', 'Mensah',
    'Meyer', 'Moreau', 'Murphy', 'Nakamura', 'Novak', 'Okafor', 'Olsen', 'Pereira', 'Petrov', 'Quinn',
    'Rossi', 'Ruiz', 'Sanchez', 'Schmidt', 'Silva', 'Singh', 'Sorensen', 'Tanaka', 'Vargas', 'Virtanen',
    'Walsh', 'Weber', 'Wright', 'Yilmaz', 'Zhang')

$Orgs = @(
    @{ Name = 'Sales'; W = 16; Titles = @('Account Executive', 'Sales Manager', 'Inside Sales Representative', 'Sales Director', 'Solution Specialist') },
    @{ Name = 'Marketing'; W = 9; Titles = @('Marketing Manager', 'Content Strategist', 'Campaign Specialist', 'Brand Manager', 'Product Marketing Manager') },
    @{ Name = 'Finance'; W = 9; Titles = @('Financial Analyst', 'Controller', 'Accounts Payable Specialist', 'Finance Manager', 'FP&A Analyst') },
    @{ Name = 'Engineering'; W = 20; Titles = @('Software Engineer', 'Senior Software Engineer', 'Engineering Manager', 'Site Reliability Engineer', 'QA Engineer', 'Data Engineer') },
    @{ Name = 'Human Resources'; W = 6; Titles = @('HR Business Partner', 'Recruiter', 'People Operations Specialist', 'HR Director', 'Learning Specialist') },
    @{ Name = 'IT Operations'; W = 10; Titles = @('IT Support Specialist', 'Systems Administrator', 'Service Desk Analyst', 'IT Manager', 'Identity Engineer') },
    @{ Name = 'Legal & Compliance'; W = 4; Titles = @('Legal Counsel', 'Compliance Officer', 'Contracts Manager', 'Privacy Analyst') },
    @{ Name = 'Customer Success'; W = 11; Titles = @('Customer Success Manager', 'Support Engineer', 'Renewals Specialist', 'Onboarding Consultant') },
    @{ Name = 'Operations'; W = 9; Titles = @('Operations Analyst', 'Supply Chain Planner', 'Process Manager', 'Logistics Coordinator') },
    @{ Name = 'Executive'; W = 2; Titles = @('Chief Operating Officer', 'Chief Financial Officer', 'VP Strategy', 'Chief Information Officer') },
    @{ Name = 'Research & Development'; W = 4; Titles = @('Research Scientist', 'Product Researcher', 'Innovation Lead') }
)
$OrgPicker = New-WeightedPicker $Orgs

$Locations = @(
    @{ Country = 'United Kingdom'; City = 'London'; Office = 'London HQ'; W = 22 },
    @{ Country = 'United States'; City = 'Redmond'; Office = 'Redmond Campus'; W = 20 },
    @{ Country = 'United States'; City = 'Austin'; Office = 'Austin Hub'; W = 9 },
    @{ Country = 'Ireland'; City = 'Dublin'; Office = 'Dublin Office'; W = 10 },
    @{ Country = 'Germany'; City = 'Munich'; Office = 'Munich Office'; W = 9 },
    @{ Country = 'India'; City = 'Bengaluru'; Office = 'Bengaluru Centre'; W = 12 },
    @{ Country = 'Singapore'; City = 'Singapore'; Office = 'Singapore Office'; W = 6 },
    @{ Country = 'Australia'; City = 'Sydney'; Office = 'Sydney Office'; W = 5 },
    @{ Country = 'Brazil'; City = 'Sao Paulo'; Office = 'Sao Paulo Office'; W = 4 },
    @{ Country = 'Japan'; City = 'Tokyo'; Office = 'Tokyo Office'; W = 3 }
)
$LocationPicker = New-WeightedPicker $Locations

if (-not $Quiet) { Write-Host "Building synthetic population ($UserCount users)..." }

$users = New-Object System.Collections.Generic.List[object]
$usedUpns = @{}
for ($i = 1; $i -le $UserCount; $i++) {
    $first = Get-RandItem $FirstNames
    $last = Get-RandItem $LastNames
    $base = ("{0}.{1}" -f $first, $last).ToLowerInvariant()
    $upnLocal = $base
    $n = 2
    while ($usedUpns.ContainsKey($upnLocal)) { $upnLocal = "$base$n"; $n++ }
    $usedUpns[$upnLocal] = $true

    $org = Get-WeightedItem $OrgPicker
    $loc = Get-WeightedItem $LocationPicker

    # Licence propensity is org-weighted so the dashboard shows an uneven rollout.
    $orgBoost = switch ($org.Name) {
        'Sales' { 0.22 } 'Executive' { 0.40 } 'Engineering' { 0.12 }
        'Customer Success' { 0.10 } 'Legal & Compliance' { -0.10 }
        'Operations' { -0.12 } 'Human Resources' { -0.05 } default { 0.0 }
    }
    $licensed = ((Get-Rand) -lt [Math]::Min(0.95, [Math]::Max(0.05, $LicensedShare + $orgBoost)))

    # Engagement archetype drives active days + prompt volume.
    $r = Get-Rand
    if ($r -lt 0.12) { $arch = 'Power'; $intensity = 1.9 + (Get-Rand) }
    elseif ($r -lt 0.42) { $arch = 'Regular'; $intensity = 0.7 + (Get-Rand) * 0.6 }
    elseif ($r -lt 0.78) { $arch = 'Occasional'; $intensity = 0.18 + (Get-Rand) * 0.3 }
    elseif ($r -lt 0.92) { $arch = 'Trialist'; $intensity = 0.05 + (Get-Rand) * 0.1 }
    else { $arch = 'Dormant'; $intensity = 0.0 }
    if (-not $licensed) { $intensity = $intensity * 0.45 }

    $users.Add([pscustomobject]@{
            UserKey     = $i
            Upn         = "$upnLocal@$Domain"
            DisplayName = "$first $last"
            Organization = $org.Name
            JobTitle    = (Get-RandItem $org.Titles)
            Country     = $loc.Country
            City        = $loc.City
            Office      = $loc.Office
            Manager     = ''
            HasLicense  = $(if ($licensed) { 'TRUE' } else { 'FALSE' })
            Archetype   = $arch
            Intensity   = $intensity
            # Individual onboarding offset (days from window start) for the ramp.
            OnboardDay  = [int]([Math]::Floor((Get-Rand) * $Days * 0.55))
            AgentAffinity = (Get-Rand)
        })
}

# Managers: pick a random senior peer inside the same org.
$byOrg = @{}
foreach ($u in $users) {
    if (-not $byOrg.ContainsKey($u.Organization)) { $byOrg[$u.Organization] = New-Object System.Collections.Generic.List[object] }
    $byOrg[$u.Organization].Add($u)
}
foreach ($u in $users) {
    $peers = $byOrg[$u.Organization]
    if ($peers.Count -gt 1) {
        do { $m = $peers[(Get-RandInt 0 $peers.Count)] } while ($m.Upn -eq $u.Upn)
        $u.Manager = $m.Upn
    }
}

# ---------------------------------------------------------------------------
# Agent catalog (fictional)
# ---------------------------------------------------------------------------

function New-Guid36 {
    $bytes = New-Object 'byte[]' 16
    $rand.NextBytes($bytes)
    ([guid]::new($bytes)).ToString()
}

$AgentDefs = @(
    @{ Name = 'HR Onboarding Buddy'; Type = 'Declarative agent'; Creator = 'People Technology Team'; Org = 'Human Resources'; W = 9; Desc = 'Answers new-starter questions about benefits; payroll and first-week setup.' },
    @{ Name = 'Sales Deal Coach'; Type = 'Declarative agent'; Creator = 'Revenue Operations'; Org = 'Sales'; W = 13; Desc = 'Summarises opportunity history and suggests next best actions for sellers.' },
    @{ Name = 'IT Service Desk Assistant'; Type = 'Declarative agent'; Creator = 'IT Operations'; Org = 'IT Operations'; W = 14; Desc = 'Deflects common IT tickets and walks users through self-service fixes.' },
    @{ Name = 'Policy & Compliance Advisor'; Type = 'Declarative agent'; Creator = 'Legal Technology'; Org = 'Legal & Compliance'; W = 6; Desc = 'Explains internal policy wording and flags approval routes.' },
    @{ Name = 'Market Research Analyst'; Type = 'Declarative agent'; Creator = 'Strategy Office'; Org = 'Marketing'; W = 8; Desc = 'Pulls competitor and market context into briefing notes.' },
    @{ Name = 'Finance Reporting Agent'; Type = 'Declarative agent'; Creator = 'Finance Systems'; Org = 'Finance'; W = 7; Desc = 'Explains variance drivers from the monthly reporting pack.' },
    @{ Name = 'Customer Support Triage'; Type = 'Declarative agent'; Creator = 'Customer Success Ops'; Org = 'Customer Success'; W = 10; Desc = 'Classifies inbound support cases and drafts first responses.' },
    @{ Name = 'Engineering Knowledge Base'; Type = 'Declarative agent'; Creator = 'Developer Experience'; Org = 'Engineering'; W = 9; Desc = 'Surfaces internal engineering runbooks and architecture decisions.' },
    @{ Name = 'Career Learning Mentor'; Type = 'Declarative agent'; Creator = 'Learning & Development'; Org = 'Human Resources'; W = 5; Desc = 'Recommends learning paths aligned to role and skills gaps.' },
    @{ Name = 'Contract Draft Editor'; Type = 'Declarative agent'; Creator = 'Legal Technology'; Org = 'Legal & Compliance'; W = 4; Desc = 'Drafts and redlines standard clauses from the approved template library.' },
    @{ Name = 'Supply Chain Data Reporter'; Type = 'Declarative agent'; Creator = 'Operations Analytics'; Org = 'Operations'; W = 6; Desc = 'Answers questions over shipment and inventory dashboards.' },
    @{ Name = 'Campaign Ideation Studio'; Type = 'Declarative agent'; Creator = 'Brand Studio'; Org = 'Marketing'; W = 5; Desc = 'Brainstorms campaign concepts and creative variants.' },
    @{ Name = 'Procurement Helpdesk'; Type = 'Declarative agent'; Creator = 'Procurement Systems'; Org = 'Operations'; W = 4; Desc = 'Guides requesters through purchase request and vendor onboarding steps.' },
    @{ Name = 'Security Incident Responder'; Type = 'Autonomous agent'; Creator = 'Security Engineering'; Org = 'IT Operations'; W = 5; Desc = 'Enriches security alerts and opens triage records without user prompting.' },
    @{ Name = 'Invoice Processing Bot'; Type = 'Autonomous agent'; Creator = 'Finance Systems'; Org = 'Finance'; W = 5; Desc = 'Reads supplier invoices and posts matched records to the ledger.' },
    @{ Name = 'Weekly Metrics Publisher'; Type = 'Autonomous agent'; Creator = 'Operations Analytics'; Org = 'Operations'; W = 4; Desc = 'Publishes the weekly operating metrics digest on a schedule.' },
    @{ Name = 'Travel Policy Guide'; Type = 'Declarative agent'; Creator = 'People Technology Team'; Org = 'Human Resources'; W = 3; Desc = 'Answers travel and expense policy questions for requesters.' },
    @{ Name = 'Product Feedback Analyst'; Type = 'Declarative agent'; Creator = 'Product Operations'; Org = 'Research & Development'; W = 4; Desc = 'Clusters product feedback themes from survey and ticket text.' }
)

$publisherGuid = New-Guid36
$agents = New-Object System.Collections.Generic.List[object]
foreach ($a in $AgentDefs) {
    $titleId = New-Guid36
    $creatorUser = $null
    $candidates = $byOrg[$a.Org]
    if ($candidates -and $candidates.Count -gt 0) { $creatorUser = $candidates[(Get-RandInt 0 $candidates.Count)] }
    $created = $EndDate.AddDays(-1 * (Get-RandInt ($Days + 20) ($Days + 420)))
    $agents.Add([pscustomobject]@{
            Name       = $a.Name
            TitleId    = $titleId
            AgentId    = "$publisherGuid.$titleId"
            AppId      = New-Guid36
            Type       = $a.Type
            Creator    = $a.Creator
            CreatorId  = $(if ($creatorUser) { $creatorUser.Upn } else { "agent.factory@$Domain" })
            Desc       = $a.Desc
            Autonomous = ($a.Type -eq 'Autonomous agent')
            Created    = $created
            W          = $a.W
            LastUsed   = $null
        })
}
$declarativeAgents = @($agents | Where-Object { -not $_.Autonomous })
$autonomousAgents = @($agents | Where-Object { $_.Autonomous })
$declarativePicker = New-WeightedPicker $declarativeAgents
$autonomousPicker = New-WeightedPicker $autonomousAgents

# ---------------------------------------------------------------------------
# Interaction scenarios
# ---------------------------------------------------------------------------
# Each scenario carries the raw audit-shaped inputs; every derived column is
# computed by the ported classification functions above.

$SensitivityLabels = @((New-Guid36), (New-Guid36), (New-Guid36))
$SiteRoot = "https://contoso.sharepoint.com/sites"
$SharePointSites = @("$SiteRoot/SalesEnablement", "$SiteRoot/FinanceHub", "$SiteRoot/Engineering", "$SiteRoot/HRPortal", "$SiteRoot/Operations")

function New-Scenario($h) { $h }

$LicensedScenarios = @(
    New-Scenario @{ W = 15; AppHost = 'outlook'; Ctx = 'emailmessage'; ResType = 'emailmessage'; ResAction = 'read' }
    New-Scenario @{ W = 11; AppHost = 'outlook'; Ctx = 'emailmessage'; ResType = 'emailmessage'; ResAction = 'draftemail' }
    New-Scenario @{ W = 4; AppHost = 'outlook'; Ctx = 'event'; ResType = 'event'; ResAction = 'read' }
    New-Scenario @{ W = 8; AppHost = 'word'; Ctx = 'docx'; ResType = 'docx'; ResAction = '' }
    New-Scenario @{ W = 7; AppHost = 'word'; Ctx = 'docx'; ResType = 'docx'; ResAction = 'create' }
    New-Scenario @{ W = 3; AppHost = 'word'; Ctx = 'docx'; ResType = 'docx'; ResAction = 'read' }
    New-Scenario @{ W = 6; AppHost = 'excel'; Ctx = 'xlsx'; ResType = 'xlsx'; ResAction = 'read' }
    New-Scenario @{ W = 4; AppHost = 'excel'; Ctx = 'xlsx'; ResType = 'xlsx'; ResAction = 'write' }
    New-Scenario @{ W = 5; AppHost = 'powerpoint'; Ctx = 'pptx'; ResType = 'pptx'; ResAction = 'create' }
    New-Scenario @{ W = 3; AppHost = 'powerpoint'; Ctx = 'pptx'; ResType = 'pptx'; ResAction = '' }
    New-Scenario @{ W = 9; AppHost = 'teams'; Ctx = 'teamsmeeting'; ResType = 'teamsmeeting'; ResAction = 'read' }
    New-Scenario @{ W = 8; AppHost = 'teams'; Ctx = 'teamschat'; ResType = 'teamsmessage'; ResAction = 'postmessagetoconversation' }
    New-Scenario @{ W = 5; AppHost = 'teams'; Ctx = 'teamschannel'; ResType = 'teamschannel'; ResAction = 'read' }
    New-Scenario @{ W = 12; AppHost = 'bizchat'; Ctx = ''; ResType = 'listitem'; ResAction = 'read'; PluginId = 'EnterpriseSearch'; PluginName = 'Enterprise Search'; UseSite = $true }
    New-Scenario @{ W = 9; AppHost = 'bizchat'; Ctx = ''; ResType = 'websearchquery'; ResAction = 'read'; PluginId = 'BingWebSearch'; PluginName = 'Bing Web Search' }
    New-Scenario @{ W = 7; AppHost = 'bizchat'; Ctx = ''; ResType = ''; ResAction = '' }
    New-Scenario @{ W = 4; AppHost = 'bizchat'; Ctx = ''; ResType = 'pdf'; ResAction = 'read' }
    New-Scenario @{ W = 3; AppHost = 'bizchat'; Ctx = ''; ResType = 'peopleinferenceanswer'; ResAction = 'read'; PluginId = 'PeopleSearch'; PluginName = 'People Search' }
    New-Scenario @{ W = 4; AppHost = 'sharepoint'; Ctx = 'aspx'; ResType = 'aspx'; ResAction = 'read'; UseSite = $true }
    New-Scenario @{ W = 3; AppHost = 'stream'; Ctx = 'streamvideo'; ResType = 'streamvideo'; ResAction = 'read' }
    New-Scenario @{ W = 3; AppHost = 'designer'; Ctx = ''; ResType = 'png'; ResAction = 'create' }
    New-Scenario @{ W = 3; AppHost = 'onenote'; Ctx = ''; ResType = ''; ResAction = '' }
    New-Scenario @{ W = 2; AppHost = 'planner'; Ctx = ''; ResType = 'planid'; ResAction = 'getitems' }
    New-Scenario @{ W = 3; AppHost = 'loop'; Ctx = ''; ResType = 'looppage'; ResAction = 'read' }
    New-Scenario @{ W = 2; AppHost = 'forms'; Ctx = ''; ResType = ''; ResAction = '' }
    New-Scenario @{ W = 4; AppHost = 'power bi'; Ctx = ''; ResType = ''; ResAction = 'executedatasetquery' }
    New-Scenario @{ W = 3; AppHost = 'bizchat'; Ctx = ''; ResType = 'py'; ResAction = 'write' }
    New-Scenario @{ W = 3; AppHost = 'bizchat'; Ctx = ''; ResType = 'json'; ResAction = 'read' }
    New-Scenario @{ W = 2; AppHost = 'cowork'; Ctx = ''; ResType = ''; ResAction = '' }
)
$LicensedPicker = New-WeightedPicker $LicensedScenarios

$UnlicensedScenarios = @(
    New-Scenario @{ W = 30; AppHost = 'bizchat'; Ctx = ''; ResType = ''; ResAction = '' }
    New-Scenario @{ W = 14; AppHost = 'bizchat'; Ctx = ''; ResType = 'websearchquery'; ResAction = 'read'; PluginId = 'BingWebSearch'; PluginName = 'Bing Web Search' }
    New-Scenario @{ W = 8; AppHost = 'teams'; Ctx = 'teamschat'; ResType = ''; ResAction = '' }
    New-Scenario @{ W = 5; AppHost = 'bizchat'; Ctx = ''; ResType = 'http://schema.skype.com/hyperlink'; ResAction = 'read'; Site = 'https://learn.microsoft.com/copilot' }
    New-Scenario @{ W = 4; AppHost = 'word'; Ctx = 'docx'; ResType = ''; ResAction = '' }
    New-Scenario @{ W = 3; AppHost = 'excel'; Ctx = 'xlsx'; ResType = ''; ResAction = '' }
)
$UnlicensedPicker = New-WeightedPicker $UnlicensedScenarios

$AgentScenarios = @(
    New-Scenario @{ W = 34; AppHost = 'bizchat'; Ctx = ''; ResType = ''; ResAction = '' }
    New-Scenario @{ W = 22; AppHost = 'teams'; Ctx = ''; ResType = ''; ResAction = '' }
    New-Scenario @{ W = 14; AppHost = 'copilot studio'; Ctx = ''; ResType = ''; ResAction = '' }
    New-Scenario @{ W = 8; AppHost = 'bizchat'; Ctx = ''; ResType = 'listitem'; ResAction = 'read'; PluginId = 'EnterpriseSearch'; PluginName = 'Enterprise Search'; UseSite = $true }
    New-Scenario @{ W = 6; AppHost = 'bizchat'; Ctx = ''; ResType = 'http://schema.skype.com/hyperlink'; ResAction = 'read'; Site = 'https://contoso.service-now.com/incident' }
    New-Scenario @{ W = 5; AppHost = 'bizchat'; Ctx = ''; ResType = 'http://schema.skype.com/hyperlink'; ResAction = 'read'; Site = 'https://contoso.crm.dynamics.com/opportunity' }
    New-Scenario @{ W = 5; AppHost = 'teams'; Ctx = ''; ResType = 'http://schema.skype.com/hyperlink'; ResAction = 'read'; Site = 'https://learning.cloud.microsoft/paths' }
)
$AgentPicker = New-WeightedPicker $AgentScenarios

$AutonomousScenarios = @(
    New-Scenario @{ W = 10; AppHost = 'autonomous'; Ctx = ''; ResType = 'flow'; ResAction = 'invoke' }
    New-Scenario @{ W = 5; AppHost = 'logic app'; Ctx = ''; ResType = 'connector'; ResAction = 'execute' }
    New-Scenario @{ W = 4; AppHost = 'autonomous'; Ctx = ''; ResType = 'emailmessage'; ResAction = 'sendemailv2' }
)
$AutonomousPicker = New-WeightedPicker $AutonomousScenarios

$Models = @(
    @{ Name = 'gpt-4o-2024-11-20'; W = 26 },
    @{ Name = 'gpt-41-2025-04-14'; W = 30 },
    @{ Name = 'gpt-5-2025-08-07'; W = 22 },
    @{ Name = 'o3-mini-2025-01-31'; W = 8 },
    @{ Name = 'deep_leo_v2'; W = 6 },
    @{ Name = ''; W = 8 }
)
$ModelPicker = New-WeightedPicker $Models

# ---------------------------------------------------------------------------
# Generate the fact rows
# ---------------------------------------------------------------------------

$FactHeader = @(
    'UserKey', 'InteractionDate', 'AgentId', 'AgentName', 'AppHost', 'Environment', 'License Status',
    'Context_Type', 'Behavior_Category', 'Behavior_Enriched', 'AI_Model', 'Is_Sensitive',
    'Autonomy_Pattern', 'AppIdentity_AppId', 'AISystemPlugin_Name', 'ThreadId', 'Message_Id',
    'CreationDate', 'WeekStart', 'MonthStart', 'UserMonthKey', 'Has license', 'Resource_Count',
    'SensitivityLabelId', 'AccessedResource_Type', 'AccessedResource_Action', 'AccessedResource_SiteUrl',
    'AccessedResource_SensitivityLabelId', 'AppIdentity_DisplayName', 'AISystemPlugin_Id',
    'ModelTransparencyDetails_ModelName', 'Agent_TitleID', 'Message_isPrompt',
    'Behavior_Source', 'Value_Outcome', 'ActivityDate'
)

if (-not $Quiet) { Write-Host "Generating interactions over $Days days ending $($EndDate.ToString('yyyy-MM-dd'))..." }

$startDate = $EndDate.AddDays(-1 * ($Days - 1))
$rows = New-Object System.Collections.Generic.List[string[]]
$messageId = 0
$threadId = 0

# Cache of derived date strings keyed on yyyy-MM-dd (mirrors the processor cache).
$dateCache = @{}
function Get-DateStrings([datetime]$d) {
    $key = $d.ToString('yyyy-MM-dd')
    if ($dateCache.ContainsKey($key)) { return $dateCache[$key] }
    $dow = [int]$d.DayOfWeek           # Sunday = 0
    $mondayOffset = ($dow + 6) % 7      # Monday-based, matching Python weekday()
    $v = [pscustomobject]@{
        Creation = "$($key)T00:00:00.000Z"
        Interaction = $key
        Week = $d.AddDays(-1 * $mondayOffset).ToString('yyyy-MM-dd')
        Month = (Get-Date -Year $d.Year -Month $d.Month -Day 1).ToString('yyyy-MM-dd')
    }
    $dateCache[$key] = $v
    return $v
}

foreach ($u in $users) {
    if ($u.Intensity -le 0) { continue }
    $hasLicenseRaw = $u.HasLicense
    $licenseStatus = Get-LicenseStatus $hasLicenseRaw
    $userMonthPrefix = $u.Upn

    for ($dayIdx = 0; $dayIdx -lt $Days; $dayIdx++) {
        if ($dayIdx -lt $u.OnboardDay) { continue }
        $day = $startDate.AddDays($dayIdx)
        $dow = [int]$day.DayOfWeek
        $dayFactor = switch ($dow) { 0 { 0.10 } 6 { 0.14 } 1 { 1.12 } 5 { 0.82 } default { 1.0 } }

        # Org-wide adoption ramp: usage grows across the window.
        $ramp = 0.45 + 0.85 * ($dayIdx / [double][Math]::Max(1, $Days - 1))
        $expected = $u.Intensity * $dayFactor * $ramp
        if ((Get-Rand) -ge $expected) {
            # Still allow the occasional burst day for heavy users.
            if (-not ($u.Archetype -eq 'Power' -and (Get-Rand) -lt 0.25)) { continue }
        }

        $sessions = 1
        if ($u.Archetype -eq 'Power') { $sessions = 2 + (Get-RandInt 0 4) }
        elseif ($u.Archetype -eq 'Regular') { $sessions = 1 + (Get-RandInt 0 2) }

        for ($s = 0; $s -lt $sessions; $s++) {
            # Choose the interaction surface for this session.
            $agent = $null
            $isAutonomous = $false
            $r = Get-Rand
            $agentChance = 0.10 + 0.35 * $u.AgentAffinity
            if ($u.HasLicense -ne 'TRUE') { $agentChance = $agentChance * 0.35 }
            if ($r -lt 0.035) {
                $agent = Get-WeightedItem $autonomousPicker
                $isAutonomous = $true
                $scenario = Get-WeightedItem $AutonomousPicker
            }
            elseif ($r -lt (0.035 + $agentChance)) {
                $agent = Get-WeightedItem $declarativePicker
                $scenario = Get-WeightedItem $AgentPicker
            }
            elseif ($u.HasLicense -eq 'TRUE') {
                $scenario = Get-WeightedItem $LicensedPicker
            }
            else {
                $scenario = Get-WeightedItem $UnlicensedPicker
            }

            $appHost = [string]$scenario.AppHost
            $ctxType = [string]$scenario.Ctx
            $resType = [string]$scenario.ResType
            $resAction = [string]$scenario.ResAction
            $pluginId = [string]$scenario.PluginId
            $pluginName = [string]$scenario.PluginName
            $siteUrl = [string]$scenario.Site
            if ($scenario.UseSite -eq $true) { $siteUrl = (Get-RandItem $SharePointSites) }

            $agentId = ''
            $agentName = ''
            $agentTitleId = ''
            $appIdentityAppId = ''
            $appIdentityDisplay = ''
            if ($agent) {
                $agentId = $agent.AgentId
                $agentName = $agent.Name
                $agentTitleId = $agent.TitleId
                $appIdentityAppId = $agent.AppId
                $appIdentityDisplay = $agent.Name
                if ($null -eq $agent.LastUsed -or $day -gt $agent.LastUsed) { $agent.LastUsed = $day }
            }

            $modelName = [string](Get-WeightedItem $ModelPicker).Name
            if ($isAutonomous) { $modelName = 'gpt-41-2025-04-14' }

            # Sensitivity labels appear on a minority of interactions.
            $sensLabel = ''
            $resSensLabel = ''
            if ((Get-Rand) -lt 0.07) { $sensLabel = Get-RandItem $SensitivityLabels }
            if ($resType -and (Get-Rand) -lt 0.05) { $resSensLabel = Get-RandItem $SensitivityLabels }

            $resourceCount = 1
            if ($resType) { $resourceCount = 1 + (Get-RandInt 0 4) }

            $environment = Get-Environment $hasLicenseRaw $agentName $agentId $appHost
            $autonomy = Get-AutonomyPattern $environment
            $aiModel = Get-AiModel $modelName
            $isSensitive = Get-IsSensitive $sensLabel $resSensLabel
            $behaviorCategory = Get-BehaviorCategory $appHost $ctxType $resType $resAction $siteUrl $pluginId
            $behaviorEnriched = Get-BehaviorEnriched $behaviorCategory $agentName $environment
            $behaviorSource = Get-BehaviorSource $behaviorCategory $environment $agentName $pluginName $appHost
            $valueOutcome = Get-ValueOutcome $behaviorEnriched $environment $isSensitive

            $ds = Get-DateStrings $day
            $userMonthKey = "$userMonthPrefix|$($ds.Month.Substring(0,7))"

            $threadId++
            $prompts = 1
            $pr = Get-Rand
            if ($pr -gt 0.82) { $prompts = 5 + (Get-RandInt 0 6) }
            elseif ($pr -gt 0.55) { $prompts = 3 + (Get-RandInt 0 2) }
            elseif ($pr -gt 0.30) { $prompts = 2 }
            if ($isAutonomous) { $prompts = 1 + (Get-RandInt 0 3) }

            for ($p = 0; $p -lt $prompts; $p++) {
                $messageId++
                $rows.Add([string[]]@(
                        $u.UserKey, $ds.Interaction, $agentId, $agentName, $appHost, $environment, $licenseStatus,
                        $ctxType, $behaviorCategory, $behaviorEnriched, $aiModel, $isSensitive,
                        $autonomy, $appIdentityAppId, $pluginName, $threadId, $messageId,
                        $ds.Creation, $ds.Week, $ds.Month, $userMonthKey, $hasLicenseRaw, $resourceCount,
                        $sensLabel, $resType, $resAction, $siteUrl,
                        $resSensLabel, $appIdentityDisplay, $pluginId,
                        $modelName, $agentTitleId, 'TRUE',
                        $behaviorSource, $valueOutcome, $ds.Interaction
                    ))
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Write output
# ---------------------------------------------------------------------------

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path
$stamp = $EndDate.ToString('yyyyMMdd') + '_000000'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Format-CsvField([string]$value) {
    if ($null -eq $value) { return '' }
    if ($value.IndexOfAny([char[]]@(',', '"', "`n", "`r")) -ge 0) {
        return '"' + $value.Replace('"', '""') + '"'
    }
    return $value
}

function Write-Csv([string]$path, [string[]]$header, $rowList, [switch]$NoQuoting) {
    $sw = New-Object System.IO.StreamWriter($path, $false, $utf8NoBom)
    try {
        $sw.NewLine = "`n"
        $sw.WriteLine(($header -join ','))
        foreach ($row in $rowList) {
            if ($NoQuoting) {
                $clean = foreach ($f in $row) { ([string]$f).Replace(',', ';').Replace('"', '').Replace("`r", ' ').Replace("`n", ' ') }
                $sw.WriteLine(($clean -join ','))
            }
            else {
                $sw.WriteLine((($row | ForEach-Object { Format-CsvField ([string]$_) }) -join ','))
            }
        }
    }
    finally { $sw.Dispose() }
}

$factPath = Join-Path $OutDir "$($Prefix)_$($stamp)_Interactions.csv"
Write-Csv $factPath $FactHeader $rows

# Users dim — header order mirrors the processor: renamed Entra columns first,
# then the injected UserKey / PersonId_Normalized / License Status / TotalEmployees.
$usersHeader = @('PersonId', 'DisplayName', 'Email', 'Organization', 'JobTitle', 'Country', 'City', 'Office',
    'Manager', 'Has license', 'UserKey', 'PersonId_Normalized', 'License Status', 'TotalEmployees')
$userRows = New-Object System.Collections.Generic.List[string[]]
$total = $users.Count
foreach ($u in $users) {
    $userRows.Add([string[]]@(
            $u.Upn, $u.DisplayName, $u.Upn, $u.Organization, $u.JobTitle, $u.Country, $u.City, $u.Office,
            $u.Manager, $u.HasLicense, $u.UserKey, $u.Upn.ToLowerInvariant(), (Get-LicenseStatus $u.HasLicense), $total
        ))
}
$usersPath = Join-Path $OutDir "$($UsersPrefix)_$($stamp)_Users.csv"
Write-Csv $usersPath $usersHeader $userRows

# Agent 365 inventory — the PBIT reads this with QuoteStyle.None, so values
# must not contain commas or quotes (Write-Csv -NoQuoting enforces that).
$a365Header = @('Agent name', 'Supported in', 'Date created', 'Agent creator', 'Agent type (A365)',
    'Version', 'Availability', 'Agent creator ID', 'Agent description', 'Created in',
    'Last updated', 'Custom actions', 'Title ID', 'Sensitivity',
    'Can read OneDrive and Sharepoint items', 'OneDrive and Sharepoint items',
    'Can read OneDrive files', 'OneDrive files', 'OneDrive sites',
    'Can read Sharepoint sites and files', 'Sharepoint files', 'Sharepoint sites',
    'Can extend to Graph connector', 'Graph connector details',
    'Can generate images using user prompt', 'Can use code interpreter',
    'Contains uploaded files', 'Uploaded files')

$SupportedIn = @('Microsoft 365 Copilot Chat', 'Microsoft Teams; Microsoft 365 Copilot Chat', 'Microsoft Teams', 'Microsoft 365 Copilot Chat; Word; Outlook')
$CreatedIn = @('Copilot Studio', 'Agent Builder', 'Copilot Studio Lite')
$Availability = @('Everyone in the organization', 'Specific users and groups', 'Only me')
$Sensitivity = @('General', 'Confidential', 'Highly Confidential', 'Public')

$a365Rows = New-Object System.Collections.Generic.List[string[]]
foreach ($a in ($agents | Sort-Object Name)) {
    $yn = { param($p) if ((Get-Rand) -lt $p) { 'Yes' } else { 'No' } }
    $canOdSp = & $yn 0.6
    $canOd = & $yn 0.4
    $canSp = & $yn 0.7
    $canGraph = & $yn 0.25
    $lastUpdated = if ($a.LastUsed) { $a.LastUsed } else { $a.Created.AddDays((Get-RandInt 5 60)) }
    $a365Rows.Add([string[]]@(
            $a.Name,
            (Get-RandItem $SupportedIn),
            $a.Created.ToString('yyyy-MM-ddTHH:mm:ss'),
            $a.Creator,
            $a.Type,
            ('{0}.{1}.{2}' -f (Get-RandInt 1 4), (Get-RandInt 0 12), (Get-RandInt 0 40)),
            (Get-RandItem $Availability),
            $a.CreatorId,
            $a.Desc,
            (Get-RandItem $CreatedIn),
            $lastUpdated.ToString('yyyy-MM-ddTHH:mm:ss'),
            $(if ((Get-Rand) -lt 0.35) { (Get-RandInt 1 6).ToString() } else { '0' }),
            $a.TitleId,
            (Get-RandItem $Sensitivity),
            $canOdSp, $(if ($canOdSp -eq 'Yes') { 'All items the user can access' } else { 'None' }),
            $canOd, $(if ($canOd -eq 'Yes') { 'All files the user can access' } else { 'None' }),
            $(if ($canOd -eq 'Yes') { 'contoso-my.sharepoint.com' } else { 'None' }),
            $canSp, $(if ($canSp -eq 'Yes') { 'All files the user can access' } else { 'None' }),
            $(if ($canSp -eq 'Yes') { (Get-RandItem $SharePointSites) } else { 'None' }),
            $canGraph, $(if ($canGraph -eq 'Yes') { 'ServiceNow connector' } else { 'None' }),
            (& $yn 0.3), (& $yn 0.2),
            $(if ((Get-Rand) -lt 0.4) { 'Yes' } else { 'No' }),
            $(if ((Get-Rand) -lt 0.4) { 'Knowledge pack PDF set' } else { 'None' })
        ))
}
$a365Path = Join-Path $OutDir "Agent365_Synthetic_$($stamp).csv"
Write-Csv $a365Path $a365Header $a365Rows -NoQuoting

if (-not $Quiet) {
    $activeUsers = ($rows | ForEach-Object { $_[0] } | Sort-Object -Unique).Count
    Write-Host ""
    Write-Host "Synthetic rollup data written to: $OutDir"
    Write-Host ("  Interactions rows : {0:N0}" -f $rows.Count)
    Write-Host ("  Threads           : {0:N0}" -f $threadId)
    Write-Host ("  Users (dim)       : {0:N0}" -f $users.Count)
    Write-Host ("  Active users      : {0:N0}" -f $activeUsers)
    Write-Host ("  Agents (A365)     : {0:N0}" -f $agents.Count)
    Write-Host ""
    Write-Host "Point the PBIT parameters at:"
    Write-Host "  Copilot Interactions File      -> $factPath"
    Write-Host "  Org Data File                  -> $usersPath"
    Write-Host "  Agent 365 (highly recommended) -> $a365Path"
}
