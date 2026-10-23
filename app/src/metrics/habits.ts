import type { Lic, Row } from '../data/types'
import { days, groupBy, isAgent, isChat, lastCompleteMonth, ratio } from './core'

export const BUCKETS = ['1-5', '6-10', '11-15', '16+'] as const
export type Bucket = (typeof BUCKETS)[number]
export const BUCKET_LABEL: Record<Bucket, string> = {
  '1-5': 'Light',
  '6-10': 'Moderate',
  '11-15': 'Frequent',
  '16+': 'Daily',
}

export function bucketOf(n: number): Bucket | null {
  if (n >= 16) return '16+'
  if (n >= 11) return '11-15'
  if (n >= 6) return '6-10'
  if (n >= 1) return '1-5'
  return null
}

interface AdsRow {
  user: string
  month: string
  chatDays: number
  agentDays: number
  lic: Lic
}

/** Port of the ActiveDaysSummary calculated table: one row per user and month. */
export function activeDaysSummary(rows: Row[]): AdsRow[] {
  const out: AdsRow[] = []
  for (const [k, rs] of groupBy(rows, (r) => `${r.user}|${r.month}`)) {
    const [user, month] = k.split('|')
    const chatDays = days(rs.filter(isChat))
    const agentDays = days(rs.filter(isAgent))
    if (!chatDays && !agentDays) continue
    // MIN(License Status): "M365 Copilot Licensed" sorts before "Unlicensed".
    const lic: Lic = rs.some((r) => r.lic === 'L') ? 'L' : rs.some((r) => r.lic === 'U') ? 'U' : 'O'
    out.push({ user, month, chatDays, agentDays, lic })
  }
  return out
}

export type HabitKind = 'licensed' | 'unlicensed' | 'agent'

export interface BucketCounts {
  counts: Record<Bucket, number>
  rates: Record<Bucket, number>
  month: string
}

const empty = () => ({ '1-5': 0, '6-10': 0, '11-15': 0, '16+': 0 }) as Record<Bucket, number>

function perUserAgentDays(rows: Row[], month: string | null) {
  const rs = rows.filter((r) => r.isAgent && (month === null || r.month === month))
  return [...groupBy(rs, (r) => r.user).values()].map(days)
}

/** Habit buckets for the last complete month, as on the PBI habit cards and donuts. */
export function lastMonthBuckets(rows: Row[], kind: HabitKind): BucketCounts {
  const maxDate = rows.reduce((m, r) => (r.creation > m ? r.creation : m), '')
  const month = lastCompleteMonth(maxDate || '1900-01-01')
  const counts = empty()
  let denom: number
  if (kind === 'agent') {
    const perUser = perUserAgentDays(rows, month)
    for (const n of perUser) {
      const b = bucketOf(n)
      if (b) counts[b]++
    }
    denom = perUser.length
  } else {
    const lic: Lic = kind === 'licensed' ? 'L' : 'U'
    const ads = activeDaysSummary(rows).filter((a) => a.month === month && a.lic === lic)
    for (const a of ads) {
      const b = bucketOf(a.chatDays)
      if (b) counts[b]++
    }
    denom = kind === 'licensed' ? new Set(ads.map((a) => a.user)).size : ads.filter((a) => a.chatDays > 0).length
  }
  const rates = empty()
  for (const b of BUCKETS) rates[b] = ratio(counts[b], denom) || 0
  return { counts, rates, month }
}

/** Habit buckets for every month, for the "active days over time" column charts. */
export function monthlyBuckets(rows: Row[], kind: HabitKind) {
  const months = [...new Set(rows.map((r) => r.month))].sort()
  const ads = kind === 'agent' ? [] : activeDaysSummary(rows)
  const lic: Lic = kind === 'licensed' ? 'L' : 'U'
  return months.map((month) => {
    const counts = empty()
    const values =
      kind === 'agent'
        ? perUserAgentDays(rows, month)
        : ads.filter((a) => a.month === month && a.lic === lic).map((a) => a.chatDays)
    for (const n of values) {
      const b = bucketOf(n)
      if (b) counts[b]++
    }
    return { key: month, values: BUCKETS.map((b) => counts[b]) }
  })
}
