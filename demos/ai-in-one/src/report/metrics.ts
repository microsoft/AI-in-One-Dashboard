import type { AgentInfo, Dataset, Person, Row } from '../data/types'
import { agentProfiles } from '../metrics/agents'
import type { AgentProfile } from '../metrics/agents'
import { countDistinct, days, groupBy, isAgent, isChat, isL, isU, lastCompleteMonth, mean, median, momChange, prompts, ratio, returnRate, threads, topAgents, users, weeks } from '../metrics/core'
import { bucketOf, lastMonthBuckets, type Bucket, type HabitKind } from '../metrics/habits'
import type { Field } from './types'

export interface Context {
  ds: Dataset
  rows: Row[]
  people: Person[]
  allRows: Row[]
  groupName?: string
  catalogAgents?: AgentInfo[]
  habitKind?: HabitKind
}

export type Value = string | number | null
const perUser = (rows: Row[], metric: (rows: Row[]) => number) => [...groupBy(rows, (r) => r.user).values()].map(metric)
const maxDate = (rows: Row[]) => rows.reduce((max, r) => r.date > max ? r.date : max, '')
const profileCache = new WeakMap<Dataset, Map<string, AgentProfile>>()
export function profilesOf(ds: Dataset) {
  let profiles = profileCache.get(ds)
  if (!profiles) {
    profiles = agentProfiles(ds.agents, ds.rows, ds.maxDate)
    profileCache.set(ds, profiles)
  }
  return profiles
}

export function cohort(name: string, rows: Row[]): Row[] {
  let out = rows
  if (/Unlicensed|Combined Chat| - Chat|Card Chat|Free Chat|Free Users|Priority |License View Scatter/.test(name)) out = out.filter(isU)
  else if (/Licensed|Paid Users|Card Licensed/.test(name)) out = out.filter(isL)
  if (/ - Agent|Agent (sessions|prompts)|Agent Prompts - Combined|Card Agent|Person Agent/.test(name)) out = out.filter(isAgent)
  if (/group 3fb2d7/.test(name)) out = out.filter(isL)
  if (/group ee92e5/.test(name)) out = out.filter(isU)
  if (/Chat Sessions|Chat Prompts|excl\. Agents|Licensed Copilot Only|Unlicensed Chat/.test(name)) out = out.filter(isChat)
  if (/NoOfActiveChatUsers|Sessions \(Licensed Users Only\)|Per Active User \(Licensed\)|PromptsSubmitted - (Chat|Licensed)|Prompts per Session - (Chat|Licensed)/.test(name)) out = out.filter(isChat)
  if (/Per User Per Week.*Licensed|Per User Per Week.*Unlicensed/.test(name) && !/Agent/.test(name)) out = out.filter(isChat)
  return out
}

export function measure(rawName: string, context: Context): Value {
  const { ds, people, allRows, groupName } = context
  const name = rawName.replace(/ - group [a-z0-9]+$/, '')
  const rs = cohort(rawName, context.rows)
  const n = users(rs)
  const selectedAgent = groupName && ds.agents.find((a) => a.name === groupName)
  const agent = selectedAgent || (new Set(rs.map((r) => r.agent).filter(Boolean)).size === 1 ? ds.agents.find((a) => a.name === rs.find((r) => r.agent)?.agent) : undefined)
  const profile = agent && profilesOf(ds).get(agent.name)
  const active = new Set(rs.map((r) => r.user))
  const licensed = people.filter((p) => p.hasLicense)
  const free = people.filter((p) => !p.hasLicense)
  const profiles = profilesOf(ds)
  const availableAgents = (context.catalogAgents ?? ds.agents).filter((a) => {
    if (selectedAgent) return a.name === selectedAgent.name
    const p = profiles.get(a.name)
    if (groupName && [...profiles.values()].some((v) => v.review === groupName)) return p?.review === groupName
    return true
  })
  if (/Scope Summary|Active Filter Summary|License Activity Filter Summary/.test(name)) {
    return `${people.length} invented people | ${maxDate(allRows) ? `${allRows.reduce((s, r) => r.date < s ? r.date : s, maxDate(allRows))} to ${maxDate(allRows)}` : 'No activity in selection'}`
  }
  if (name.startsWith('Report Activity Status') || name === 'License Activity Status') return `${n} active users from ${people.length} invented people.`
  if (name === 'Scope Diagnostics') return 'Static browser port | Invented data only | No tenant or Power BI connection'
  if (name === 'Agent Details Metadata') return profile ? `${profile.typeCombined} | Catalog metadata available` : 'Select an agent in the filters or agent usage table.'
  if (name === 'Report Agent Drill Hint') return 'Click an agent name for details. Hierarchy expansion is not available in this static demo.'
  if (name === 'Agent Visibility Message') return rs.some(isAgent) ? 'Invented agent activity | No disclosure enforcement in this public demo' : 'No agent activity in the selected scope.'
  if (name === 'Agent Detail Title') return `${agent?.name ?? 'All selected agents'} | ${countDistinct(rs.filter(isAgent), (r) => r.agentId)} active agents`
  if (name === 'Display Most Organizations Summary - Agent') {
    const ranked = [...groupBy(rs.filter(isAgent), (r) => r.agent)].map(([key, rows]) => ({ key, count: countDistinct(rows, (r) => r.org) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    return ranked.length ? `Most organizations: ${ranked[0].key}` : 'No agent activity in this scope.'
  }
  if (name === 'Builder Summary (Stable)') {
    const builders = ds.agents.filter((a) => profiles.get(a.name)?.typeCombined === 'Agent Builder')
    const ranked = [...new Set(builders.map((a) => a.creator))].map((creator) => ({
      creator, count: users(allRows.filter((r) => builders.some((a) => a.name === r.agent && a.creator === creator))),
    })).filter((b) => b.count > 0).sort((a, b) => b.count - a.count || a.creator.localeCompare(b.creator))
    return ranked.length ? `Top builder: ${ranked[0].creator}` : 'No recorded builder activity'
  }
  if (name === 'Habit Reporting Month') return lastCompleteMonth(maxDate(rs) || ds.maxDate)
  if (name === 'Raw AppHost') return [...new Set(rs.map((r) => r.host))].join(', ')
  if (name.includes('Most Used Agent')) return topAgents(rs) || 'No activity'
  if (/Description/.test(name)) return agent?.description || 'Select one agent to inspect its description.'
  if (/Agent Type|Row Agent Type/.test(name)) return profile?.typeCombined || (availableAgents.length ? 'Multiple types' : 'No agent selected')
  if (/Creator|Developer Name/i.test(name)) return agent?.creator || 'Select one agent'
  if (/Features/.test(name)) return profile?.features || 'Select one agent'
  if (/Catalog Status|Catalog status/.test(name)) return agent ? 'Catalog metadata available' : 'Multiple catalog agents'
  if (/Usage Coverage/.test(name)) return agent ? (rs.some(isAgent) ? 'Activity observed' : 'No activity observed') : 'Invented activity and catalog metadata'
  if (/Agent Review/.test(name)) return profile?.review || 'Select one agent'
  if (/Inferred Activity/.test(name)) return rs.length ? 'Synthetic activity; not a production classification' : 'Not enough activity to infer'
  if (/Last Activity|Last Agent Activity/.test(name)) return maxDate(rs) || 'No recorded activity'
  if (/Total Copilot Licensed Users|Paid Users \(directory\)/.test(name)) return licensed.length
  if (/Inactive Licensed|Inactive Paid/.test(name)) return licensed.filter((p) => !active.has(p.key)).length
  if (/Inactive Free/.test(name)) return free.filter((p) => !active.has(p.key)).length
  if (/License Active Paid/.test(name)) return licensed.filter((p) => active.has(p.key)).length
  if (/License Active Free/.test(name)) return free.filter((p) => active.has(p.key)).length
  if (/Activity-only Agents/.test(name)) return countDistinct(rs.filter((r) => r.isAgent && !ds.agents.some((a) => a.titleId === r.agentId)), (r) => r.agentId)
  if (/Catalog Agents|DISTINCTCOUNT Agents|Agents in Selection/.test(name)) return availableAgents.length
  if (/Active Agents \(Real\)|Agents Used/.test(name)) return countDistinct(rs.filter(isAgent), (r) => r.agentId)
  if (/High Impact Agents/.test(name)) return availableAgents.filter((a) => profiles.get(a.name)?.review.includes('High Impact')).length
  if (/Dormant Agents/.test(name)) return availableAgents.filter((a) => profiles.get(a.name)?.activity.startsWith('4.')).length
  if (/Org Count|Detail Organizations/.test(name)) return countDistinct(rs, (r) => r.org)
  if (/Agent Adoption|% Copilot Users Using Agents|% Chat Users Using Agents/.test(name)) {
    const population = /Licensed/.test(rawName) ? context.rows.filter(isL)
      : /Unlicensed/.test(rawName) ? context.rows.filter(isU) : context.rows
    const eligible = new Set(population.filter(isChat).map((r) => r.user))
    return ratio(users(population.filter((r) => r.isAgent && eligible.has(r.user))), eligible.size)
  }
  if (/Return Rate|Repeat Rate|Repeat Usage Rate/.test(name)) return returnRate(rs)
  if (name === 'Display Top 10 Agent Engagement') {
    const stats = [...groupBy(allRows.filter(isAgent), (r) => r.agent).entries()]
      .filter(([, rows]) => users(rows) >= 5 && threads(rows) > 0)
      .map(([key, rows]) => ({ key, values: [returnRate(rows), ratio(threads(rows), users(rows)), ratio(prompts(rows), threads(rows))] }))
    const current = stats.find((s) => s.key === agent?.name)
    if (!current) return null
    if (stats.length === 1) return 1
    return current.values.reduce((sum, value, i) => sum + stats.filter((s) => s.values[i] < value).length, 0) / (3 * (stats.length - 1))
  }
  if (/MoM/.test(name)) return momChange(rs, ds.maxDate, /Prompts/.test(name) ? prompts : threads).value
  const bucket = /1-5|6-10|11-15|16\+/.exec(name)?.[0] as Bucket | undefined
  if (bucket) {
    const kind: HabitKind = /Agent/.test(name) ? 'agent' : /Licensed/.test(name) ? 'licensed' : 'unlicensed'
    if (/Last Month/.test(name)) {
      const b = lastMonthBuckets(context.rows, kind)
      return /Rate/.test(name) ? b.rates[bucket] : b.counts[bucket]
    }
    const rows = kind === 'agent' ? rs.filter(isAgent) : rs.filter(isChat)
    return perUser(rows, days).filter((d) => bucketOf(d) === bucket).length
  }
  if (name === 'Priority Person Rank') {
    if (users(rs) !== 1) return null
    const scores = [...groupBy(allRows.filter(isU), (r) => r.user).entries()]
      .map(([key, rows]) => ({ key, score: ratio(threads(rows), weeks(rows)) }))
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    const key = rs[0]?.user
    return key ? scores.findIndex((s) => s.key === key) + 1 : null
  }
  if (name === 'Priority Weekly Sessions') return median(perUser(rs, (r) => ratio(threads(r), weeks(r))))
  if (name === 'Priority Weekly Active Days') return median(perUser(rs, (r) => ratio(days(r), weeks(r))))
  if (name === 'Priority Weekly Prompts') return median(perUser(rs, (r) => ratio(prompts(r), weeks(r))))
  if (/7-day average/.test(name)) {
    const end = groupName && /^\d{4}-\d\d-\d\d$/.test(groupName) ? groupName : maxDate(rs)
    if (!end) return null
    const population = cohort(rawName, allRows)
    const first = population.reduce((min, r) => r.date < min ? r.date : min, end)
    const selected = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(end) - i * 86400000).toISOString().slice(0, 10)).filter((date) => date >= first)
    const f = /prompts/i.test(name) ? prompts : threads
    return mean(selected.map((date) => f(population.filter((r) => r.date === date))))
  }
  if (/Month Start Trend/.test(name)) return /Prompts/.test(name) ? prompts(rs) : threads(rs)
  if (/Prompts per Session|Average Prompts per Session/.test(name)) return ratio(prompts(rs), threads(rs))
  if (/Per User Per Week/.test(name)) {
    const metric = /Prompts/.test(name) ? prompts : /Days/.test(name) ? days : threads
    return mean(perUser(rs, (rows) => ratio(metric(rows), weeks(rows))))
  }
  if (/Per Active.*User|Sessions per User|Active Days per User|ActionsPerUser/i.test(name)) {
    const metric = /Prompts|Actions/i.test(name) ? prompts : /Days/i.test(name) ? days : threads
    return mean(perUser(rs, metric))
  }
  if (/Detail Active Days/.test(name)) return days(rs)
  if (/Habit Users/.test(name)) return users(/Agent/.test(name) ? rs.filter(isAgent) : rs.filter(isChat))
  if (/Prompts/.test(name)) return prompts(rs)
  if (/Sessions|Engagement Top 10/.test(name)) return threads(rs)
  if (/Users|UserKey/.test(name)) {
    if (/Last Month/.test(name)) return users(rs.filter((r) => r.month === lastCompleteMonth(ds.maxDate)))
    return n
  }
  throw new Error(`Unported report measure: ${rawName}`)
}

export function formatValue(value: Value, field?: Field): string {
  if (value === null || typeof value === 'number' && !Number.isFinite(value)) return '--'
  if (typeof value === 'string') return value
  if (field?.format.includes('%')) return new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 }).format(value)
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: field?.format.includes('.0') ? 1 : 0 }).format(value)
}
