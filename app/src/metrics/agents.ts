import type { AgentInfo, Row } from '../data/types'
import { groupBy, isAgent, returnRate, users } from './core'

export interface AgentProfile extends AgentInfo {
  typeCombined: string
  totalUsers: number
  orgCount: number
  lastUsed: string
  activity: string
  review: string
  features: string
  returnRateValue: number
  returnCategory: string
}

export const ACTIVITY = [
  '1. Active (Last 7 days)',
  '2. Recent (Last 30 days)',
  '3. Inactive (30-60 days)',
  '4. Dormant (60-90 days)',
  '5. Redundant (90+ days)',
  '6. New (Not Yet Used)',
  '7. Never Used (Recent)',
  '8. Never Used (Stale)',
]
export const REVIEWS = ['🔥 High Impact', '✅ Keep', '⚠️ Review', '💤 Dormant', '🆕 New', '❌ Never Used']
export const RETURN_CATEGORIES = ['High', 'Medium', 'Low', 'No Usage']

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

const THRESHOLDS: Record<string, { low: number; min: number; hiUsers: number; hiOrgs: number }> = {
  FirstParty: { low: 20, min: 10, hiUsers: 100, hiOrgs: 10 },
  'Agent Builder': { low: 5, min: 2, hiUsers: 30, hiOrgs: 3 },
}
const DEFAULT_T = { low: 10, min: 5, hiUsers: 50, hiOrgs: 5 }

export function activityStatus(lastUsed: string, created: string, maxDate: string): string {
  if (lastUsed) {
    const d = dayDiff(lastUsed, maxDate)
    if (d <= 7) return ACTIVITY[0]
    if (d <= 30) return ACTIVITY[1]
    if (d <= 60) return ACTIVITY[2]
    if (d <= 90) return ACTIVITY[3]
    return ACTIVITY[4]
  }
  const age = created ? dayDiff(created, maxDate) : Infinity
  if (age <= 14) return ACTIVITY[5]
  if (age <= 90) return ACTIVITY[6]
  return ACTIVITY[7]
}

export function reviewOf(activity: string, type: string, users: number, orgs: number): string {
  const t = THRESHOLDS[type] ?? DEFAULT_T
  const n = Number(activity[0])
  if (n === 6) return '🆕 New'
  if (n === 7 || n === 8) return '❌ Never Used'
  if (n === 1 || n === 2) return users >= t.hiUsers && orgs >= t.hiOrgs ? '🔥 High Impact' : '✅ Keep'
  if (n === 3) return users < t.low ? '⚠️ Review' : '✅ Keep'
  if (n === 4) return users < t.min ? '💤 Dormant' : users < t.low ? '⚠️ Review' : '✅ Keep'
  if (n === 5) return users < t.low ? '💤 Dormant' : '⚠️ Review'
  return '✅ Keep'
}

export function featuresOf(a: AgentInfo): { platforms: string[]; capabilities: string[] } {
  const s = a.supportedIn.toLowerCase()
  const platforms = [
    s.includes('teams') && '💬 in Teams',
    s.includes('outlook') && '📧 in Outlook',
    s.includes('office') && '📄 in Office',
  ].filter(Boolean) as string[]
  const capabilities = [
    a.sharePoint && '📁 SharePoint',
    a.oneDrive && '☁️ OneDrive',
    a.graph && '🔌 Graph',
    a.files && '📎 Files',
  ].filter(Boolean) as string[]
  return { platforms, capabilities }
}

const returnCategory = (r: number) => (Number.isNaN(r) ? 'No Usage' : r >= 0.5 ? 'High' : r >= 0.2 ? 'Medium' : 'Low')

/** Port of the Agents 365 calculated columns. Uses all data, like the PBI calculated columns. */
export function agentProfiles(agents: AgentInfo[], rows: Row[], maxDate: string): Map<string, AgentProfile> {
  const byAgent = groupBy(rows.filter(isAgent), (r) => r.agent)
  const allByName = groupBy(rows, (r) => r.agent)
  const out = new Map<string, AgentProfile>()
  for (const a of agents) {
    const rs = allByName.get(a.name) ?? []
    const agentRows = byAgent.get(a.name) ?? []
    const typeCombined =
      a.typeA365 === 'Shared' && a.createdIn === 'Microsoft 365 Copilot Agent Builder' ? 'Agent Builder' : a.typeA365
    const totalUsers = users(rs)
    const orgCount = new Set(rs.map((r) => r.org)).size
    const lastUsed = agentRows.reduce((m, r) => (r.date > m ? r.date : m), '')
    const activity = activityStatus(lastUsed, a.created, maxDate)
    const f = featuresOf(a)
    const rr = returnRate(rs)
    out.set(a.name, {
      ...a,
      typeCombined,
      totalUsers,
      orgCount,
      lastUsed,
      activity,
      review: reviewOf(activity, typeCombined, totalUsers, orgCount),
      features: [f.platforms.join(' '), f.capabilities.join(' ')].filter(Boolean).join(' | '),
      returnRateValue: rr,
      returnCategory: returnCategory(rr),
    })
  }
  return out
}
