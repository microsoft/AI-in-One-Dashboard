import type { Filters } from '../data/store'
import type { Row } from '../data/types'
import type { AgentProfile } from './agents'
import { byRank } from '../data/store'

const AGENT_KEYS = ['agentType', 'review', 'returnCat', 'activity', 'agent'] as const

export const hasAgentFilter = (f: Filters) => AGENT_KEYS.some((k) => f[k])

export function profileMatches(p: AgentProfile | undefined, f: Filters): boolean {
  if (!hasAgentFilter(f)) return true
  if (!p) return false
  return (
    (!f.agentType || p.typeCombined === f.agentType) &&
    (!f.review || p.review === f.review) &&
    (!f.returnCat || p.returnCategory === f.returnCat) &&
    (!f.activity || p.activity === f.activity) &&
    (!f.agent || p.name === f.agent)
  )
}

/** Rows for the Agents tab: agent rank, licence and agent attribute slicers. */
export function agentScope(base: Row[], f: Filters, profiles: Map<string, AgentProfile>, ranks: Map<string, string>): Row[] {
  let rows = byRank(base, ranks, f.rank)
  if (f.lic) rows = rows.filter((r) => r.lic === f.lic)
  if (hasAgentFilter(f)) rows = rows.filter((r) => r.isAgent && profileMatches(profiles.get(r.agent), f))
  return rows
}

/** Agents 365 inventory after the agent attribute slicers (organisation does not apply to inventory). */
export const agentInventory = (profiles: Map<string, AgentProfile>, f: Filters) =>
  [...profiles.values()].filter((p) => profileMatches(p, f))

/** Most Popular Agent Creator: the Agent Builder creator whose agents reach the most agent users. */
export function topCreator(rows: Row[], profiles: Map<string, AgentProfile>): string {
  const byCreator = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.isAgent) continue
    const p = profiles.get(r.agent)
    if (!p || p.typeCombined !== 'Agent Builder' || !p.creator) continue
    const s = byCreator.get(p.creator) ?? new Set<string>()
    s.add(r.user)
    byCreator.set(p.creator, s)
  }
  let best = 0
  let names: string[] = []
  for (const [c, s] of byCreator) {
    if (s.size > best) {
      best = s.size
      names = [c]
    } else if (s.size === best) names.push(c)
  }
  return names.sort().join(', ')
}

export const MIN_AGENT_USERS = 3
