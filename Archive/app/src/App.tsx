import { useEffect, useRef, useState } from 'react'
import { useData, type Filters } from './data/store'
import { ACTIVITY, RETURN_CATEGORIES, REVIEWS } from './metrics/agents'
import { RANKS, rankLabel } from './metrics/ranks'
import { AgentHabits, AgentHealth, AgentLeaderboard, AgentTrends, AgentUseCases } from './pages/Agents'
import { Guide } from './pages/Guide'
import { Licence } from './pages/Licence'
import { OverviewLeaderboard, OverviewTrends } from './pages/Overview'
import { PopHabits, PopLeaderboard, PopTrends } from './pages/Population'
import { TABS, useRoute, type Route } from './routes'
import { DataSourceDialog } from './ui/DataSourceDialog'
import { dateLabel, monthLabel } from './ui/format'
import { Segmented, Select } from './ui/primitives'

const AGENT_KEYS: (keyof Filters)[] = ['lic', 'agentType', 'review', 'returnCat', 'activity', 'agent']

function Page({ route }: { route: Route }) {
  const { tab, view } = route
  switch (tab.id) {
    case 'overview':
      return view === 'leaderboard' ? <OverviewLeaderboard /> : <OverviewTrends />
    case 'copilot':
    case 'chat': {
      const pop = tab.id === 'copilot' ? 'licensed' : 'unlicensed'
      if (view === 'leaderboard') return <PopLeaderboard pop={pop} />
      if (view === 'habits') return <PopHabits pop={pop} />
      return <PopTrends pop={pop} />
    }
    case 'agents':
      if (view === 'leaderboard') return <AgentLeaderboard />
      if (view === 'habits') return <AgentHabits />
      if (view === 'health') return <AgentHealth />
      if (view === 'uses') return <AgentUseCases />
      return <AgentTrends />
    case 'licence':
      return <Licence />
    default:
      return <Guide />
  }
}

function FilterBar({ route }: { route: Route }) {
  const { ds, profiles, filters, setFilter, resetFilters } = useData()
  if (route.tab.id === 'guide') return null
  const months = ds.months.map((m) => ({ value: m, label: monthLabel(m) }))
  const isAgents = route.tab.id === 'agents'
  const names = [...profiles.keys()].sort()
  const types = [...new Set([...profiles.values()].map((p) => p.typeCombined).filter(Boolean))].sort()
  const anySet = Object.values(filters).some(Boolean)
  return (
    <div className="filters" role="group" aria-label="Filters">
      <Select label="From" value={filters.from} onChange={(v) => setFilter('from', v)} options={months} allLabel="Start" />
      <Select label="To" value={filters.to} onChange={(v) => setFilter('to', v)} options={months} allLabel="Latest" />
      <Select label="Organisation" value={filters.org} onChange={(v) => setFilter('org', v)} options={ds.orgs.map((o) => ({ value: o, label: o }))} allLabel="All" />
      {route.tab.rank && (
        <Select label="Usage rank" value={filters.rank} onChange={(v) => setFilter('rank', v)} options={RANKS.map((r) => ({ value: r, label: rankLabel(r) }))} allLabel="All users" />
      )}
      {isAgents && (
        <>
          <Select
            label="Licence"
            value={filters.lic}
            onChange={(v) => setFilter('lic', v as Filters['lic'])}
            options={[
              { value: 'L', label: 'Licensed' },
              { value: 'U', label: 'Unlicensed' },
            ]}
            allLabel="All"
          />
          <Select label="Agent type" value={filters.agentType} onChange={(v) => setFilter('agentType', v)} options={types.map((t) => ({ value: t, label: t }))} allLabel="All" />
          <Select label="Review" value={filters.review} onChange={(v) => setFilter('review', v)} options={REVIEWS.map((r) => ({ value: r, label: r }))} allLabel="All" />
          <Select label="Return rate" value={filters.returnCat} onChange={(v) => setFilter('returnCat', v)} options={RETURN_CATEGORIES.map((r) => ({ value: r, label: r }))} allLabel="All" />
          <Select label="Last activity" value={filters.activity} onChange={(v) => setFilter('activity', v)} options={ACTIVITY.map((a) => ({ value: a, label: rankLabel(a) }))} allLabel="All" />
          <Select label="Agent" value={filters.agent} onChange={(v) => setFilter('agent', v)} options={names.map((n) => ({ value: n, label: n }))} allLabel="All" />
        </>
      )}
      {anySet && (
        <button type="button" className="link-btn reset" onClick={resetFilters}>
          Clear filters
        </button>
      )}
    </div>
  )
}

export default function App() {
  const { ds, filters, setFilter } = useData()
  const [route, go] = useRoute()
  const [sourceOpen, setSourceOpen] = useState(false)
  const prevTab = useRef(route.tab.id)

  // Rank and agent slicers belong to one tab, so they reset when the tab changes.
  useEffect(() => {
    if (prevTab.current === route.tab.id) return
    prevTab.current = route.tab.id
    if (filters.rank) setFilter('rank', '')
    for (const k of AGENT_KEYS) if (filters[k]) setFilter(k, '')
  }, [route.tab.id, filters, setFilter])

  const view = route.tab.views.find((v) => v.id === route.view)
  return (
    <div className="shell">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="band">
        <div className="band-inner">
          <div className="band-top">
            <div className="brand">
              <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                <rect width="28" height="28" rx="7" fill="#ffffff" fillOpacity="0.1" />
                <path d="M8 19V10M14 19V13M20 19V7" stroke="#7fe0cf" strokeWidth="2.8" strokeLinecap="round" />
              </svg>
              <div>
                <h1>AI in One</h1>
                <p>Copilot and agent adoption</p>
              </div>
            </div>
            <button type="button" className="source-chip" onClick={() => setSourceOpen(true)}>
              {ds.source === 'sample' && <span className="tag">Sample data</span>}
              <span className="source-dates">
                {dateLabel(ds.minDate)} – {dateLabel(ds.maxDate)}
              </span>
              <span className="source-action">Change data</span>
            </button>
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.id} href={`#/${t.id}`} aria-current={t.id === route.tab.id ? 'page' : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <div className="toolbar">
        <div className="toolbar-inner">
          <div className="page-head">
            <h2>
              {route.tab.label}
              {view && route.tab.views.length > 1 && <span className="crumb"> · {view.label}</span>}
            </h2>
            <p>{route.tab.intro}</p>
          </div>
          {route.tab.views.length > 1 && (
            <Segmented label={`${route.tab.label} views`} value={route.view} options={route.tab.views} onChange={(v) => go(route.tab.id, v)} />
          )}
        </div>
        <FilterBar route={route} />
      </div>
      <main id="main" className="main" tabIndex={-1}>
        <Page route={route} />
      </main>
      <footer className="foot">
        Data prepared by <a href="https://aka.ms/PAX" target="_blank" rel="noreferrer">PAX</a>. Everything is calculated in your browser and never leaves it.
      </footer>
      <DataSourceDialog open={sourceOpen} onClose={() => setSourceOpen(false)} />
    </div>
  )
}
