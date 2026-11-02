import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DataContext, EMPTY_FILTERS, type DataState, type Filters } from './store'
import type { Dataset } from './types'
import { loadFiles as readFiles, loadSample as readSample } from './load'
import { agentProfiles } from '../metrics/agents'
import { usageRanks } from '../metrics/ranks'
import { AgentDrawer } from '../ui/AgentDrawer'

export function DataProvider({ children }: { children: ReactNode }) {
  const [ds, setDs] = useState<Dataset | null>(null)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [agent, setAgent] = useState<string | null>(null)

  const loadSample = useCallback(async () => {
    setError('')
    try {
      setDs(await readSample())
      setFilters(EMPTY_FILTERS)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadFiles = useCallback(async (files: File[]) => {
    const { dataset, found } = await readFiles(files)
    setDs(dataset)
    setFilters(EMPTY_FILTERS)
    return found
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    void loadSample()
  }, [loadSample])

  const profiles = useMemo(() => (ds ? agentProfiles(ds.agents, ds.rows, ds.maxDate) : new Map()), [ds])
  const ranks = useMemo(
    () => ({
      licensed: ds ? usageRanks(ds.rows, 'licensed') : new Map<string, string>(),
      unlicensed: ds ? usageRanks(ds.rows, 'unlicensed') : new Map<string, string>(),
      agent: ds ? usageRanks(ds.rows, 'agent') : new Map<string, string>(),
    }),
    [ds],
  )
  const base = useMemo(() => {
    if (!ds) return []
    const { from, to, org } = filters
    if (!from && !to && !org) return ds.rows
    return ds.rows.filter((r) => (!from || r.month >= from) && (!to || r.month <= to) && (!org || r.org === org))
  }, [ds, filters])

  const setFilter = useCallback(<K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v })), [])
  const resetFilters = useCallback(() => setFilters(EMPTY_FILTERS), [])
  const nameOf = useCallback((user: string) => ds?.people.get(user)?.name ?? `User ${user}`, [ds])

  const value = useMemo<DataState | null>(
    () =>
      ds && {
        ds,
        profiles,
        ranks,
        filters,
        setFilter,
        resetFilters,
        base,
        nameOf,
        openAgent: setAgent,
        loadFiles,
        loadSample,
      },
    [ds, profiles, ranks, filters, setFilter, resetFilters, base, nameOf, loadFiles, loadSample],
  )

  if (!value)
    return (
      <div className="boot" role="status">
        {error ? (
          <>
            <h1>Couldn't load the sample data</h1>
            <p>{error}</p>
            <button type="button" className="btn" onClick={() => void loadSample()}>
              Try again
            </button>
          </>
        ) : (
          <>
            <span className="spinner" aria-hidden="true" />
            <p>Loading Copilot usage…</p>
          </>
        )}
      </div>
    )

  return (
    <DataContext.Provider value={value}>
      {children}
      <AgentDrawer name={agent} onClose={() => setAgent(null)} />
    </DataContext.Provider>
  )
}
