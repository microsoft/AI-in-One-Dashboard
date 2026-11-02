import type { Row } from '../data/types'

export type Pred = (r: Row) => boolean

export const isL: Pred = (r) => r.lic === 'L'
export const isU: Pred = (r) => r.lic === 'U'
export const isAgent: Pred = (r) => r.isAgent
export const isChat: Pred = (r) => !r.isAgent
export const and =
  (...ps: Pred[]): Pred =>
  (r) =>
    ps.every((p) => p(r))

export function countDistinct(rows: Row[], f: (r: Row) => string): number {
  const s = new Set<string>()
  for (const r of rows) {
    const v = f(r)
    if (v !== '') s.add(v)
  }
  return s.size
}

export function groupBy<K extends string>(rows: Row[], f: (r: Row) => K): Map<K, Row[]> {
  const m = new Map<K, Row[]>()
  for (const r of rows) {
    const k = f(r)
    const a = m.get(k)
    if (a) a.push(r)
    else m.set(k, [r])
  }
  return m
}

export const users = (rows: Row[]) => countDistinct(rows, (r) => r.user)
export const threads = (rows: Row[]) => countDistinct(rows, (r) => r.thread)
export const prompts = (rows: Row[]) => countDistinct(rows, (r) => r.msg)
export const days = (rows: Row[]) => countDistinct(rows, (r) => r.date)
export const weeks = (rows: Row[]) => countDistinct(rows, (r) => r.week)

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
export function median(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
export const ratio = (a: number, b: number) => (b ? a / b : NaN)

/** Per-user values over users that have rows matching `p` (DAX AVERAGEX skips blank users). */
export function perUser(rows: Row[], p: Pred, f: (userRows: Row[]) => number): number[] {
  return [...groupBy(rows.filter(p), (r) => r.user).values()].map(f)
}

const perWeek = (rs: Row[]) => ratio(threads(rs), weeks(rs))
const daysPerWeek = (rs: Row[]) => ratio(days(rs), weeks(rs))

const notAutonomous: Pred = (r) => r.host.toLowerCase() !== 'autonomous'

/** Measures from the PBI model, evaluated over an already-filtered set of rows. */
export const M = {
  activeLicensed: (rs: Row[]) => users(rs.filter(isL)),
  activeUnlicensed: (rs: Row[]) => users(rs.filter(isU)),
  agentUsers: (rs: Row[]) => users(rs.filter(isAgent)),
  usersLicensed: (rs: Row[]) => users(rs.filter(isL)),
  usersUnlicensed: (rs: Row[]) => users(rs.filter(isU)),
  activeAgents: (rs: Row[]) => countDistinct(rs.filter(isAgent), (r) => r.agent),
  agentSessions: (rs: Row[]) => threads(rs.filter(isAgent)),
  prompts: (rs: Row[]) => prompts(rs),
  sessionsLicensed: (rs: Row[]) => threads(rs.filter(isL)),
  sessionsUnlicensed: (rs: Row[]) => threads(rs.filter(isU)),
  sessionsLicensedExAgents: (rs: Row[]) => threads(rs.filter(and(isL, isChat, notAutonomous))),

  weeklySessionsLicensed: (rs: Row[]) => mean(perUser(rs, and(isChat, isL), perWeek)),
  weeklySessionsUnlicensed: (rs: Row[]) => mean(perUser(rs, and(isChat, isU), perWeek)),
  weeklySessionsAgent: (rs: Row[]) => mean(perUser(rs, isAgent, perWeek)),
  weeklyDaysLicensed: (rs: Row[]) => mean(perUser(rs, isL, daysPerWeek)),
  weeklyDaysUnlicensed: (rs: Row[]) => mean(perUser(rs, and(isChat, isU), daysPerWeek)),

  sessionsPerUserLicensed: (rs: Row[]) => mean(perUser(rs, isL, threads)),
  sessionsPerUserUnlicensed: (rs: Row[]) => mean(perUser(rs, and(isChat, isU), threads)),
  sessionsPerAgentUser: (rs: Row[]) => mean(perUser(rs, isAgent, threads)),
  agentDaysPerUser: (rs: Row[]) => mean(perUser(rs, isAgent, days)),
  chatDaysPerUser: (rs: Row[]) => mean(perUser(rs, isChat, days)),
  chatDaysPerUserLicensed: (rs: Row[]) => mean(perUser(rs, and(isChat, isL), days)),
  actionsPerUserLicensed: (rs: Row[]) => {
    const c = rs.filter(and(isChat, isL))
    return ratio(prompts(c), users(c))
  },

  pctLicensedUsingAgents: (rs: Row[]) => ratio(users(rs.filter(and(isL, isAgent))), users(rs.filter(isL))),
  pctUnlicensedUsingAgents: (rs: Row[]) => ratio(users(rs.filter((r) => r.isAgent && r.lic !== 'L')), users(rs.filter(isU))),
  agentAdoption: (rs: Row[]) => ratio(users(rs.filter(isAgent)), users(rs)),
  agentReturnRate: (rs: Row[]) => returnRate(rs.filter(isAgent)),

  medianWeeklySessionsUnlicensed: (rs: Row[]) => median(perUser(rs, isU, perWeek)),
  medianWeeklyDaysUnlicensed: (rs: Row[]) => median(perUser(rs, isU, daysPerWeek)),
}

export type MeasureKey = keyof typeof M

export function returnRate(rs: Row[]): number {
  const g = groupBy(rs, (r) => r.user)
  if (!g.size) return NaN
  let repeat = 0
  for (const u of g.values()) if (threads(u) >= 2) repeat++
  return repeat / g.size
}

/** Agent(s) with the most distinct agent users; ties joined with ", ". */
export function topAgents(rs: Row[]): string {
  const g = groupBy(rs.filter(isAgent), (r) => r.agent)
  let best = 0
  let names: string[] = []
  for (const [name, r] of g) {
    const n = users(r)
    if (n > best) {
      best = n
      names = [name]
    } else if (n === best) names.push(name)
  }
  return names.sort().join(', ')
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

/** Last complete month: the month before the month of the latest CreationDate. */
export const lastCompleteMonth = (maxDate: string) => previousMonth(`${maxDate.slice(0, 7)}-01`)

/** Month-over-month change: last complete month against the month before it. */
export function momChange(rs: Row[], maxDate: string, f: (rs: Row[]) => number) {
  const cur = lastCompleteMonth(maxDate)
  const prev = previousMonth(cur)
  const a = f(rs.filter((r) => r.month === cur))
  const b = f(rs.filter((r) => r.month === prev))
  return { value: b ? (a - b) / b : NaN, current: cur, previous: prev }
}

export function series(rs: Row[], key: (r: Row) => string, fs: ((rs: Row[]) => number)[]) {
  const g = groupBy(rs, key)
  return [...g.keys()].sort().map((k) => ({ key: k, values: fs.map((f) => f(g.get(k)!)) }))
}
