// Builds the bundled synthetic sample and the glossary used by the app.
// Usage: node scripts/prepare-sample.mjs [glossary-dax.txt]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const out = path.resolve(here, '..', 'public', 'sample')
fs.mkdirSync(out, { recursive: true })

const sources = {
  interactions: 'Purview_Audit_Synthetic_20260918_000000_Interactions.csv',
  users: 'EntraUsers_MAClicensing_Synthetic_20260918_000000_Users.csv',
  agents: 'Agent365_Synthetic_20260918_000000.csv',
}

const keep = {
  interactions: ['UserKey', 'InteractionDate', 'AgentId', 'AgentName', 'AppHost', 'License Status', 'ThreadId', 'Message_Id', 'CreationDate', 'WeekStart', 'MonthStart'],
  users: ['PersonId', 'DisplayName', 'Organization', 'JobTitle', 'Country', 'Has license', 'UserKey', 'License Status'],
  agents: ['Agent name', 'Supported in', 'Date created', 'Agent creator', 'Agent type (A365)', 'Agent description', 'Created in', 'Title ID', 'Can read Sharepoint sites and files', 'Can read OneDrive files', 'Can extend to Graph connector', 'Contains uploaded files'],
}

for (const [kind, file] of Object.entries(sources)) {
  const text = fs.readFileSync(path.join(root, 'sample-data', file), 'utf8').replace(/^\uFEFF/, '')
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true })
  const rows = parsed.data.map((r) => Object.fromEntries(keep[kind].map((c) => [c, r[c] ?? ''])))
  fs.writeFileSync(path.join(out, `${kind}.csv`), Papa.unparse(rows, { columns: keep[kind] }) + '\n')
  console.log(`${kind}: ${rows.length} rows`)
}

const glossaryDax = process.argv[2]
if (glossaryDax) {
  const dax = fs.readFileSync(glossaryDax, 'utf8')
  const re = /\{\s*"((?:[^"]|"")*)"\s*,\s*"((?:[^"]|"")*)"\s*,\s*"((?:[^"]|"")*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/g
  const unq = (s) => s.replace(/""/g, '"')
  const items = [...dax.matchAll(re)].map((m) => ({
    page: unq(m[1]).replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim(),
    metric: unq(m[2]),
    description: unq(m[3]),
    pageOrder: Number(m[4]),
    metricOrder: Number(m[5]),
  }))
  items.sort((a, b) => a.pageOrder - b.pageOrder || a.metricOrder - b.metricOrder)
  const dest = path.resolve(here, '..', 'src', 'data', 'glossary.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(items, null, 1) + '\n')
  console.log(`glossary: ${items.length} entries`)
}
