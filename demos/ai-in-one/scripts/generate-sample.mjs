import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'

// Generated from rules, never from tenant exports or anonymised production records.
const directory = fileURLToPath(new URL('../public/sample/', import.meta.url))
mkdirSync(directory, { recursive: true })
const write = (name, rows) => writeFileSync(`${directory}${name}.csv`, Papa.unparse(rows, { newline: '\n' }) + '\n')
const orgs = ['Aster Works', 'Brindle Labs', 'Cedar Kite', 'Dapple Studio']
const roles = ['Analyst', 'Designer', 'Engineer', 'Project lead']
const people = Array.from({ length: 160 }, (_, i) => ({
  PersonId: `person${i + 1}@example.invalid`,
  DisplayName: `Demo Person ${String(i + 1).padStart(3, '0')}`,
  Organization: orgs[i % orgs.length],
  JobTitle: roles[Math.floor(i / 4) % roles.length],
  Country: ['United Kingdom', 'Canada', 'Australia', 'Germany'][Math.floor(i / 16) % 4],
  'Has license': i % 5 < 3 ? 'TRUE' : 'FALSE',
  UserKey: String(i + 1),
  'License Status': i % 5 < 3 ? 'M365 Copilot Licensed' : 'Unlicensed',
}))
const agents = Array.from({ length: 16 }, (_, i) => ({
  'Agent name': `${['Research', 'Drafting', 'Planning', 'Knowledge'][i % 4]} helper ${i + 1}`,
  'Supported in': 'Copilot; Teams',
  'Date created': `2026-0${1 + i % 5}-01`,
  'Agent creator': `Demo Person ${String(i + 1).padStart(3, '0')}`,
  'Agent type (A365)': ['Shared', 'LOB', 'Shared', 'ThirdParty'][i % 4],
  'Agent description': 'Invented assistant for exploring the synthetic dashboard.',
  'Created in': ['Microsoft 365 Copilot Agent Builder', 'Copilot Studio', 'SharePoint', 'Marketplace'][i % 4],
  'Title ID': `demo-agent-${i + 1}`,
  'Can read Sharepoint sites and files': i % 2 ? 'TRUE' : 'FALSE',
  'Can read OneDrive files': i % 3 ? 'TRUE' : 'FALSE',
  'Can extend to Graph connector': i % 4 ? 'FALSE' : 'TRUE',
  'Contains uploaded files': i % 5 ? 'FALSE' : 'TRUE',
}))
const rows = []
const hosts = ['word', 'excel', 'powerpoint', 'outlook', 'teams', 'bizchat']
for (let day = 0; day < 182; day++) {
  const date = new Date(Date.UTC(2026, 4, 4 + day))
  const iso = date.toISOString().slice(0, 10)
  const monday = new Date(date)
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
  for (let user = 0; user < people.length; user++) {
    if (user % 16 === 15 || (day * 7 + user * 11) % (3 + user % 7) > 2) continue
    const n = 1 + (day + user * 3) % (2 + Math.floor(day / 42))
    for (let message = 0; message < n; message++) {
      const isAgent = (day + user + message) % 4 === 0
      const a = agents[(day + user) % agents.length]
      rows.push({
        UserKey: people[user].UserKey,
        InteractionDate: iso,
        AgentId: isAgent ? a['Title ID'] : '',
        AgentName: isAgent ? a['Agent name'] : '',
        AppHost: hosts[(day + user + message) % hosts.length],
        'License Status': people[user]['License Status'],
        ThreadId: `demo-thread-${day}-${user}-${Math.floor(message / 2)}`,
        Message_Id: `demo-message-${rows.length + 1}`,
        CreationDate: `${iso}T10:00:00.000Z`,
        WeekStart: monday.toISOString().slice(0, 10),
        MonthStart: `${iso.slice(0, 7)}-01`,
        Behavior_Enriched: ['Draft content', 'Analyse information', 'Find knowledge', 'Summarise', 'Plan work', 'Write code'][(user + day + message) % 6],
      })
    }
  }
}
write('users', people)
write('agents', agents)
write('interactions', rows)
console.log(`Invented fixture: ${people.length} people, ${agents.length} agents, ${rows.length} interactions`)
