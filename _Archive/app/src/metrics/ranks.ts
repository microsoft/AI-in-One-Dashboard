import type { Row } from '../data/types'
import { and, groupBy, isAgent, isChat, isL, isU, weeks, type Pred } from './core'

export const RANKS = ['5. Top 10% Users', '4. 75-90% Users', '3. 50-75% Users', '2. 25-50% Users', '1. Bottom 25% Users'] as const
export const NO_USAGE = '0. No Usage'
export type RankPopulation = 'licensed' | 'unlicensed' | 'agent'

const POP: Record<RankPopulation, Pred> = {
  licensed: and(isL, isChat),
  unlicensed: and(isU, isChat),
  agent: isAgent,
}

export const rankLabel = (r: string) => r.replace(/^\d\.\s*/, '')

/** PERCENTILE.INC with linear interpolation. */
export function percentileInc(sorted: number[], p: number): number {
  if (!sorted.length) return NaN
  const rank = p * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

/** Port of the "* User Rankings" tables. Computed once on all data, like a PBI calculated table. */
export function usageRanks(rows: Row[], pop: RankPopulation): Map<string, string> {
  const per = new Map<string, number>()
  for (const [u, rs] of groupBy(rows.filter(POP[pop]), (r) => r.user)) per.set(u, rs.length / weeks(rs))
  const sorted = [...per.values()].sort((a, b) => a - b)
  const [p25, p50, p75, p90] = [0.25, 0.5, 0.75, 0.9].map((p) => percentileInc(sorted, p))
  const out = new Map<string, string>()
  for (const [u, v] of per) {
    out.set(
      u,
      v <= 0 ? NO_USAGE : v >= p90 ? RANKS[0] : v >= p75 ? RANKS[1] : v >= p50 ? RANKS[2] : v >= p25 ? RANKS[3] : RANKS[4],
    )
  }
  return out
}
