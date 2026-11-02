import type { Row } from '../data/types'
import { days, groupBy, isU, median, threads, weeks } from './core'

export interface PriorityRow {
  key: string
  label: string
  users: number
  sessionsPerWeek: number
  daysPerWeek: number
  score: number
  rank: number
}

export function priorityScore(s: number, d: number): number {
  if (!(s > 0) || !(d > 0)) return NaN
  return (0.6 * s) / 10 + (0.3 * d) / 5 + (0.1 * (s / d)) / 5
}

function denseRank<T extends { score: number; rank: number }>(items: T[]): T[] {
  const scores = [...new Set(items.filter((i) => !Number.isNaN(i.score)).map((i) => i.score))].sort((a, b) => b - a)
  for (const i of items) i.rank = Number.isNaN(i.score) ? NaN : scores.indexOf(i.score) + 1
  return items.sort((a, b) => (a.rank || Infinity) - (b.rank || Infinity))
}

function perUserStats(rows: Row[]) {
  return [...groupBy(rows.filter(isU), (r) => r.user)].map(([user, rs]) => {
    const w = weeks(rs)
    return { user, org: rs[0].org, s: threads(rs) / w, d: days(rs) / w }
  })
}

/** License Priority Rank (Dynamic): users ranked on their own score, orgs on the score of their medians. */
export function licencePriority(rows: Row[], nameOf: (user: string) => string) {
  const stats = perUserStats(rows)
  const people = denseRank(
    stats.map((u) => ({
      key: u.user,
      label: nameOf(u.user),
      org: u.org,
      users: 1,
      sessionsPerWeek: u.s,
      daysPerWeek: u.d,
      score: priorityScore(u.s, u.d),
      rank: NaN,
    })),
  )
  const byOrg = new Map<string, typeof stats>()
  for (const u of stats) byOrg.set(u.org, [...(byOrg.get(u.org) ?? []), u])
  const orgs = denseRank(
    [...byOrg].map(([org, us]) => {
      const s = median(us.map((u) => u.s))
      const d = median(us.map((u) => u.d))
      return { key: org, label: org, users: us.length, sessionsPerWeek: s, daysPerWeek: d, score: priorityScore(s, d), rank: NaN }
    }),
  )
  return { people, orgs }
}
