import Papa from 'papaparse'
import embeddedSample from 'virtual:embedded-sample'
import type { AgentInfo, Dataset, Lic, Person, Row } from './types'
import { LICENSED, UNKNOWN_ORG, UNLICENSED } from './types'

export type FileKind = 'interactions' | 'users' | 'agents'
type Rec = Record<string, string>

export function parseCsv(text: string): { headers: string[]; rows: Rec[] } {
  const res = Papa.parse<Rec>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })
  return { headers: res.meta.fields ?? [], rows: res.data }
}

export function detectKind(headers: string[]): FileKind | null {
  const h = new Set(headers)
  if (h.has('ThreadId') && h.has('UserKey')) return 'interactions'
  if (h.has('Agent name')) return 'agents'
  if (h.has('UserKey') && (h.has('Organization') || h.has('Has license'))) return 'users'
  return null
}

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

export function toIsoDate(v: string | undefined): string {
  if (!v) return ''
  const s = v.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)
  if (us) return `${us[3]}-${pad(+us[1])}-${pad(+us[2])}`
  const t = Date.parse(s)
  return Number.isNaN(t) ? '' : iso(new Date(t))
}

export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const dow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dow)
  return iso(d)
}

export const monthOf = (date: string) => `${date.slice(0, 7)}-01`

const yes = (v: string | undefined) => ['YES', 'TRUE', 'Y', '1'].includes((v ?? '').trim().toUpperCase())

function licOf(v: string | undefined): Lic {
  const s = (v ?? '').trim().toLowerCase()
  if (s === LICENSED.toLowerCase()) return 'L'
  if (s === UNLICENSED.toLowerCase()) return 'U'
  return 'O'
}

export function buildPeople(recs: Rec[]): Map<string, Person> {
  const map = new Map<string, Person>()
  for (const r of recs) {
    const key = (r['UserKey'] ?? '').trim()
    if (!key) continue
    const id = (r['PersonId_Normalized'] || r['PersonId'] || r['Email'] || key).trim().toLowerCase()
    map.set(key, {
      key,
      id,
      name: (r['DisplayName'] || r['PersonId'] || key).trim(),
      org: (r['Organization'] ?? '').trim() || UNKNOWN_ORG,
      title: (r['JobTitle'] ?? '').trim(),
      country: (r['Country'] ?? '').trim(),
      hasLicense: yes(r['Has license']),
      lic: (r['License Status'] ?? '').trim(),
    })
  }
  return map
}

export function buildAgents(recs: Rec[]): AgentInfo[] {
  return recs
    .filter((r) => (r['Agent name'] ?? '').trim())
    .map((r) => ({
      name: r['Agent name'].trim(),
      supportedIn: r['Supported in'] ?? '',
      created: toIsoDate(r['Date created']),
      creator: (r['Agent creator'] ?? '').trim(),
      typeA365: (r['Agent type (A365)'] ?? '').trim(),
      description: (r['Agent description'] ?? '').trim(),
      createdIn: (r['Created in'] ?? '').trim(),
      titleId: (r['Title ID'] ?? '').trim(),
      sharePoint: yes(r['Can read Sharepoint sites and files']),
      oneDrive: yes(r['Can read OneDrive files']),
      graph: yes(r['Can extend to Graph connector']),
      files: yes(r['Contains uploaded files']),
    }))
}

export function buildDataset(
  interactions: Rec[],
  users: Rec[],
  agents: Rec[],
  source: Dataset['source'],
  label: string,
): Dataset {
  const people = buildPeople(users)
  const rows: Row[] = []
  let maxDate = ''
  let minDate = '9999-12-31'
  for (const r of interactions) {
    const user = (r['UserKey'] ?? '').trim()
    const creation = toIsoDate(r['CreationDate']) || toIsoDate(r['InteractionDate'])
    const date = toIsoDate(r['InteractionDate']) || creation
    if (!user || !date) continue
    const agentId = (r['AgentId'] ?? '').trim()
    rows.push({
      user,
      date,
      creation,
      week: toIsoDate(r['WeekStart']) || mondayOf(date),
      month: toIsoDate(r['MonthStart']) || monthOf(date),
      agentId,
      agent: (r['AgentName'] ?? '').trim(),
      host: (r['AppHost'] ?? '').trim() || '(Unknown)',
      lic: licOf(r['License Status']),
      thread: (r['ThreadId'] ?? '').trim(),
      msg: (r['Message_Id'] ?? '').trim(),
      org: people.get(user)?.org ?? UNKNOWN_ORG,
      isAgent: agentId !== '',
    })
    if (creation > maxDate) maxDate = creation
    if (date < minDate) minDate = date
  }
  const months = [...new Set(rows.map((r) => r.month))].sort()
  const orgs = [...new Set([...rows.map((r) => r.org), ...[...people.values()].map((p) => p.org)])].sort()
  return { rows, people, agents: buildAgents(agents), maxDate, minDate, months, orgs, source, label }
}

async function gunzipBase64(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

async function sampleText(f: string): Promise<string> {
  if (embeddedSample) return gunzipBase64(embeddedSample[f])
  const res = await fetch(`${import.meta.env.BASE_URL}sample/${f}.csv`)
  if (!res.ok) throw new Error(`Could not load sample ${f}.csv (${res.status})`)
  return res.text()
}

export async function loadSample(): Promise<Dataset> {
  const get = async (f: string) => parseCsv(await sampleText(f)).rows
  const [i, u, a] = await Promise.all([get('interactions'), get('users'), get('agents')])
  return buildDataset(i, u, a, 'sample', 'Synthetic sample · Contoso')
}

export async function loadFiles(files: File[]): Promise<{ dataset: Dataset; found: FileKind[] }> {
  const parts: Partial<Record<FileKind, Rec[]>> = {}
  for (const f of files) {
    const { headers, rows } = parseCsv(await f.text())
    const kind = detectKind(headers)
    if (kind) parts[kind] = rows
  }
  if (!parts.interactions) throw new Error('No PAX interactions file found. It needs UserKey and ThreadId columns.')
  const found = Object.keys(parts) as FileKind[]
  const label = files.map((f) => f.name).join(', ')
  return { dataset: buildDataset(parts.interactions, parts.users ?? [], parts.agents ?? [], 'upload', label), found }
}
