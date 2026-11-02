import { createContext, useContext } from 'react'
import type { Dataset, Row } from './types'
import type { AgentProfile } from '../metrics/agents'
import type { RankPopulation } from '../metrics/ranks'

export interface Filters {
  from: string
  to: string
  org: string
  rank: string
  lic: '' | 'L' | 'U'
  agentType: string
  review: string
  returnCat: string
  activity: string
  agent: string
}

export const EMPTY_FILTERS: Filters = {
  from: '',
  to: '',
  org: '',
  rank: '',
  lic: '',
  agentType: '',
  review: '',
  returnCat: '',
  activity: '',
  agent: '',
}

export interface DataState {
  ds: Dataset
  profiles: Map<string, AgentProfile>
  ranks: Record<RankPopulation, Map<string, string>>
  filters: Filters
  setFilter: <K extends keyof Filters>(k: K, v: Filters[K]) => void
  resetFilters: () => void
  /** Rows after the period and organisation filters. */
  base: Row[]
  nameOf: (user: string) => string
  openAgent: (name: string | null) => void
  loadFiles: (files: File[]) => Promise<string[]>
  loadSample: () => Promise<void>
}

export const DataContext = createContext<DataState | null>(null)

export function useData(): DataState {
  const v = useContext(DataContext)
  if (!v) throw new Error('useData must be used inside DataProvider')
  return v
}

/** Applies the usage-rank filter for a population (ranks are computed on all data, like the PBI). */
export function byRank(rows: Row[], ranks: Map<string, string>, rank: string): Row[] {
  return rank ? rows.filter((r) => ranks.get(r.user) === rank) : rows
}

/** Total Licensed Users: people whose "Has license" is yes, within the organisation filter. */
export function totalLicensed(ds: Dataset, org: string): number {
  const ids = new Set<string>()
  for (const p of ds.people.values()) if (p.hasLicense && (!org || p.org === org)) ids.add(p.id)
  return ids.size
}

/** Inactive licensed users, never negative. NaN (shown as a dash) when nobody is licensed, e.g. no users file. */
export function inactiveLicensed(total: number, active: number): number {
  return total > 0 ? Math.max(0, total - active) : NaN
}

/** KPI sub-text for licence totals, with a hint when the users file is missing or nobody in view is licensed. */
export function licensedNote(ds: Dataset, total: number, note: string): string {
  if (total > 0) return note
  return ds.people.size ? 'no licensed users in this view' : 'load the users file to see licences'
}
