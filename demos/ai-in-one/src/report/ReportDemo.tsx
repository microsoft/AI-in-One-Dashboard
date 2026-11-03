import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useData } from '../data/store'
import type { Row } from '../data/types'
import { days, groupBy, lastCompleteMonth, prompts, ratio, threads, users } from '../metrics/core'
import { bucketOf } from '../metrics/habits'
import { usageRanks } from '../metrics/ranks'
import glossary from '../data/glossary.json'
import { ColumnChart, LineChart, Scatter } from '../ui/charts'
import { Sheet } from '../ui/Sheet'
import { formatValue, measure, profilesOf, type Context, type Value } from './metrics'
import type { Field, ReportPage, Visual } from './types'
import metadata from './layout.json'
import '../index.css'
import './report.css'

const pages: ReportPage[] = metadata.pages
type Filters = { from: string; to: string; org: string; user: string; agent: string; license: string; host: string; rankL: string; rankU: string; rankA: string; type: string; review: string; recency: string; returning: string; creator: string; activity: string }
const EMPTY: Filters = { from: '', to: '', org: '', user: '', agent: '', license: '', host: '', rankL: '', rankU: '', rankA: '', type: '', review: '', recency: '', returning: '', creator: '', activity: '' }
const firstPage = pages[0].id
const readPage = () => pages.find((p) => p.id === location.hash.replace(/^#\/?/, ''))?.id ?? firstPage
const fieldValues = (visual: Visual, role: string) => visual.roles[role] ?? []
const measuresOf = (visual: Visual) => visual.fields.filter((f, index, fields) => f.kind === 'measure' && fields.findIndex((v) => v.name === f.name) === index)
const numeric = (value: Value) => typeof value === 'number' ? value : NaN
const rankCache = new WeakMap<Row[], Map<string, Map<string, string>>>()
const bandCache = new WeakMap<Row[], Map<string, string>>()

function rankOf(row: Row, rows: Row[]) {
  let ranks = rankCache.get(rows)
  if (!ranks) {
    ranks = new Map()
    rankCache.set(rows, ranks)
  }
  const kind = row.isAgent ? 'agent' : row.lic === 'L' ? 'licensed' : 'unlicensed'
  if (!ranks.has(kind)) ranks.set(kind, usageRanks(rows, kind))
  return ranks.get(kind)?.get(row.user) ?? ''
}

function bandOf(row: Row, rows: Row[]) {
  let bands = bandCache.get(rows)
  if (!bands) {
    bands = new Map([...groupBy(rows, (r) => `${r.user}|${r.month}`)].map(([key, values]) => [key, bucketOf(days(values)) ?? '']))
    bandCache.set(rows, bands)
  }
  return bands.get(`${row.user}|${row.month}`) ?? ''
}

function column(name: string, row: Row, context: Context): string {
  const person = context.ds.people.get(row.user)
  const profile = profilesOf(context.ds).get(row.agent)
  switch (name) {
    case 'Date': return row.date
    case 'WeekStart': return row.week
    case 'MonthStart': case 'Month Start': return row.month
    case 'Organization': case 'Reporting team': return row.org
    case 'Company': return row.org
    case 'Division': return person?.title || 'Not supplied'
    case 'Report User': case 'Report People Hierarchy': return person?.name || 'Unknown invented person'
    case 'Usage Rank': return rankOf(row, context.allRows)
    case 'License Status': return row.lic === 'L' ? 'M365 Copilot Licensed' : 'Unlicensed'
    case 'Agent name': return row.agent
    case 'Agent Type Combined': return profile?.typeCombined ?? ''
    case 'Recency': return profile?.activity ?? ''
    case 'Return': return profile?.returnCategory ?? ''
    case 'Review': return profile?.review ?? ''
    case 'Agent creator': return profile?.creator ?? ''
    case 'App': return row.host
    case 'Experience': return row.isAgent ? 'Agents' : row.lic === 'L' ? 'M365 Copilot' : 'Copilot Chat'
    case 'Population': return row.lic === 'L' ? 'Paid (licensed)' : 'Free (unlicensed)'
    case 'Behavior_Enriched': return row.behavior ?? ''
    case 'Band': return bandOf(row, context.rows)
    default:
      if (name.startsWith('Report Reporting Level ')) return person?.name ?? ''
      throw new Error(`Unported report column: ${name}`)
  }
}

function groups(field: Field | undefined, context: Context): [string, Row[]][] {
  if (!field) return [['Selection', context.rows]]
  if (field.name === 'Agent name') return [...groupBy(context.rows.filter((r) => r.isAgent), (r) => r.agent).entries()]
  if (field.name === 'Organization') return [...new Set(context.people.map((p) => p.org))].sort().map((name) => [name, context.rows.filter((r) => r.org === name)])
  if (field.name === 'Date' && context.rows.length) {
    const dates = context.rows.map((r) => r.date).sort()
    const byDate = groupBy(context.rows, (r) => r.date)
    const first = Date.parse(dates[0])
    return Array.from({ length: (Date.parse(dates[dates.length - 1]) - first) / 86400000 + 1 }, (_, i) => {
      const date = new Date(first + i * 86400000).toISOString().slice(0, 10)
      return [date, byDate.get(date) ?? []]
    })
  }
  if (field.name === 'Band') {
    const month = lastCompleteMonth(context.rows.reduce((max, r) => r.date > max ? r.date : max, context.ds.minDate))
    const rows = context.rows.filter((r) => r.month === month && (context.habitKind === 'agent' ? r.isAgent : !r.isAgent))
    return [...groupBy(rows, (r) => bandOf(r, rows))]
  }
  return [...groupBy(context.rows, (r) => column(field.name, r, context)).entries()].filter(([name]) => name !== '').sort(([a], [b]) => a.localeCompare(b))
}

function groupedContext(context: Context, field: Field | undefined, name: string, rows: Row[]): Context {
  const people = field?.name === 'Organization' ? context.people.filter((p) => p.org === name)
    : field?.name === 'Report User' ? context.people.filter((p) => p.name === name) : context.people
  return { ...context, rows, groupName: name, people }
}

function ReportTable({ visual, context, onAgent, guidePage }: { visual: Visual; context: Context; onAgent: (name: string) => void; guidePage: string }) {
  if (visual.fields.some((f) => f.name === 'Metric' && f.kind === 'column')) return <div className="report-table-scroll"><table className="report-table">
    <thead><tr><th>Page</th><th>Metric</th><th>Description</th></tr></thead>
    <tbody>{glossary.filter((g) => !guidePage || g.page === guidePage).map((g, index) => <tr key={index}><th>{g.page}</th><td>{g.metric}</td><td className="report-description">{g.description}</td></tr>)}</tbody>
  </table></div>
  const rowField = fieldValues(visual, 'Rows')[0] ?? fieldValues(visual, 'Values').find((f) => f.kind === 'column')
  const measures = measuresOf(visual)
  if (!rowField) return <div className="report-message">{measures.map((field) => <p key={field.name}>{formatValue(measure(field.name, context), field)}</p>)}</div>
  const data = groups(rowField, context)
  return (
    <div className="report-table-scroll">
      <table className="report-table">
        <thead><tr><th>{rowField.label}</th>{measures.map((f) => <th key={f.name}>{f.label}</th>)}</tr></thead>
        <tbody>
          {data.slice(0, 160).map(([name, rows]) => <tr key={name}>
            <th>{rowField.name === 'Agent name'
              ? <button className="report-row-link" onClick={() => onAgent(name)}>{name}</button>
              : name}</th>
            {measures.map((field) => <td key={field.name}>{formatValue(measure(field.name, groupedContext(context, rowField, name, rows)), field)}</td>)}
          </tr>)}
        </tbody>
      </table>
      {!data.length && <p className="report-message">No activity matches these filters.</p>}
    </div>
  )
}

function ReportChart({ visual, context }: { visual: Visual; context: Context }) {
  const category = fieldValues(visual, 'Category')[0] ?? fieldValues(visual, 'Details')[0] ?? fieldValues(visual, 'Series')[0]
  const fields = [...fieldValues(visual, 'Y'), ...fieldValues(visual, 'Y2')].filter((f) => f.kind === 'measure')
  const dataFields = fields.length ? fields : measuresOf(visual).slice(0, 1)
  const selectedGroups = groups(category, context)
  const data = selectedGroups.map(([key, rows]) => ({
    key,
    values: dataFields.map((f) => numeric(measure(f.name, groupedContext(context, category, key, rows)))),
  }))
  const series = dataFields.map((f, i) => ({ name: f.label, color: visual.palette[i % visual.palette.length], fmt: (n: number) => formatValue(n, f) }))
  const height = Math.max(60, visual.position.height - 58 - (dataFields.length > 1 ? 24 : 0))
  if (visual.type === 'scatterChart') {
    const x = fieldValues(visual, 'X')[0]
    const y = fieldValues(visual, 'Y')[0]
    const size = fieldValues(visual, 'Size')[0]
    return <Scatter points={selectedGroups.map(([name, rows]) => ({
      key: name, label: name,
      x: x ? numeric(measure(x.name, groupedContext(context, category, name, rows))) : NaN,
      y: y ? numeric(measure(y.name, groupedContext(context, category, name, rows))) : NaN,
      size: size ? numeric(measure(size.name, groupedContext(context, category, name, rows))) : users(rows),
    }))} color={visual.palette[0]} xLabel={x?.label ?? ''} yLabel={y?.label ?? ''} sizeLabel={size?.label ?? 'Users'} height={height} label={visual.title} />
  }
  if (visual.type === 'lineChart' || visual.type === 'areaChart') return <LineChart data={data} series={series} height={height} xFmt={(v) => v.slice(5)} label={visual.title} area={visual.type === 'areaChart'} />
  if (visual.type.includes('Column')) return <ColumnChart data={data} series={series} height={height} xFmt={(v) => v.slice(5)} label={visual.title} />
  const top = [...data].sort((a, b) => b.values[0] - a.values[0]).slice(0, 10)
  const maximum = Math.max(1, ...top.flatMap((p) => p.values.filter(Number.isFinite)))
  return <div className="report-bars">{top.map((p) => <div key={p.key}>
    <span title={p.key}>{p.key}</span><div className="report-bar-group">{p.values.map((value, i) => <div key={i} title={`${series[i].name}: ${formatValue(value, dataFields[i])}`}>
      <i style={{ width: `${Number.isFinite(value) ? Math.max(0, value / maximum * 100) : 0}%`, background: series[i].color }} />
      <b>{formatValue(value, dataFields[i])}</b>
    </div>)}</div>
  </div>)}</div>
}

export default function ReportDemo() {
  const { ds } = useData()
  const [pageId, setPageId] = useState(readPage)
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [filterOpen, setFilterOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [monthly, setMonthly] = useState(false)
  const [experienceMetric, setExperienceMetric] = useState('Sessions')
  const [guidePage, setGuidePage] = useState('')
  const [weeklyMetric, setWeeklyMetric] = useState('Sessions')
  useEffect(() => {
    const update = () => { setPageId(readPage()); setMonthly(false) }
    addEventListener('hashchange', update)
    return () => removeEventListener('hashchange', update)
  }, [])
  const page = pages.find((p) => p.id === pageId)!
  const set = (key: keyof Filters, value: string) => setFilters((f) => ({ ...f, [key]: value }))
  const context = useMemo<Context>(() => {
    const activeKeys = new Set(ds.rows.filter((r) => (!filters.from || r.date >= filters.from) && (!filters.to || r.date <= filters.to)).map((r) => r.user))
    const people = [...ds.people.values()].filter((p) => (!filters.org || p.org === filters.org) && (!filters.user || p.name === filters.user) && (!filters.license || (p.hasLicense ? 'L' : 'U') === filters.license)
      && (!filters.activity || (filters.activity === 'Active' ? activeKeys.has(p.key) : !activeKeys.has(p.key))))
    const keys = new Set(people.map((p) => p.key))
    const profiles = profilesOf(ds)
    const ranks = { L: filters.rankL ? usageRanks(ds.rows, 'licensed') : null, U: filters.rankU ? usageRanks(ds.rows, 'unlicensed') : null, A: filters.rankA ? usageRanks(ds.rows, 'agent') : null }
    const catalogAgents = ds.agents.filter((a) => {
      const p = profiles.get(a.name)
      return (!filters.agent || a.name === filters.agent) && (!filters.type || p?.typeCombined === filters.type)
        && (!filters.review || p?.review === filters.review) && (!filters.recency || p?.activity === filters.recency)
        && (!filters.returning || p?.returnCategory === filters.returning) && (!filters.creator || a.creator === filters.creator)
    })
    const agentNames = new Set(catalogAgents.map((a) => a.name))
    const hasAgentFilter = filters.agent || filters.type || filters.review || filters.recency || filters.returning || filters.creator
    const rows = ds.rows.filter((r) => keys.has(r.user) && (!filters.from || r.date >= filters.from) && (!filters.to || r.date <= filters.to)
      && (!hasAgentFilter || agentNames.has(r.agent)) && (!filters.host || r.host === filters.host)
      && (!filters.rankL || r.lic !== 'L' || ranks.L?.get(r.user) === filters.rankL)
      && (!filters.rankU || r.lic !== 'U' || ranks.U?.get(r.user) === filters.rankU)
      && (!filters.rankA || !r.isAgent || ranks.A?.get(r.user) === filters.rankA))
    return { ds, people, rows, allRows: rows, catalogAgents }
  }, [ds, filters])
  const scoped = useMemo<Context>(() => {
    const rows = page.name.includes('M365 Copilot') ? context.rows.filter((r) => r.lic === 'L')
      : page.name.includes('Unlicensed') ? context.rows.filter((r) => r.lic === 'U')
      : /Agents|Agent Details/.test(page.name) ? context.rows.filter((r) => r.isAgent) : context.rows
    return { ...context, rows, habitKind: /Agent/.test(page.name) ? 'agent' : /Unlicensed/.test(page.name) ? 'unlicensed' : 'licensed' }
  }, [context, page.name])
  const drillAgent = (name: string) => {
    set('agent', name)
    location.hash = '/a1093020260000000002'
  }
  const select = (label: string, key: keyof Filters, values: string[]) => <label className="report-select">{label}<select aria-label={label} value={filters[key]} onChange={(e) => set(key, e.target.value)}><option value="">All</option>{values.map((v) => <option key={v}>{v}</option>)}</select></label>
  const dateSelect = <div className="report-dates">
    <label>From<input type="date" aria-label="From date" value={filters.from} min={ds.minDate} max={filters.to || ds.maxDate} onChange={(e) => set('from', e.target.value)} /></label>
    <label>To<input type="date" aria-label="To date" value={filters.to} min={filters.from || ds.minDate} max={ds.maxDate} onChange={(e) => set('to', e.target.value)} /></label>
  </div>
  const action = (text: string) => {
    if (/clear|reset/i.test(text)) setFilters(EMPTY)
    else if (/monthly/i.test(text)) setMonthly(true)
    else if (/weekly/i.test(text)) setMonthly(false)
    else if (/filter|search/i.test(text)) setFilterOpen(true)
    else if (/back/i.test(text)) location.hash = `/${firstPage}`
    else setAboutOpen(true)
  }
  const render = (visual: Visual) => {
    const first = measuresOf(visual)[0]
    if (visual.type === 'cardVisual') return <><h3>{visual.title || first?.label}</h3><div className="report-kpi" style={{ fontSize: Math.min(visual.fontSize * 4 / 3, 32) }}>{first ? formatValue(measure(first.name, scoped), first) : visual.text}</div></>
    if (visual.type === 'tableEx' || visual.type === 'pivotTable') return <><h3>{visual.title}</h3><ReportTable visual={visual} context={scoped} onAgent={drillAgent} guidePage={guidePage} /></>
    if (/Chart$/.test(visual.type)) {
      let variant = visual.title === 'Activity by experience' && experienceMetric === 'Prompts'
        ? { ...visual, roles: { ...visual.roles, Y: [{ kind: 'measure', name: 'Display Prompts - All', label: 'Prompts', format: '#,0' }] } } : visual
      if (page.name.includes('License Prioritization') && visual.type === 'scatterChart') variant = { ...variant, roles: { ...variant.roles, Y: [{ kind: 'measure', name: `Priority Weekly ${weeklyMetric}`, label: `Weekly ${weeklyMetric.toLowerCase()}`, format: '0.0' }] } }
      return <><h3>{visual.title}</h3><ReportChart visual={variant} context={scoped} /></>
    }
    if (visual.type === 'slicer') {
      const field = visual.fields[0]?.name
      if (field === 'Date') return dateSelect
      if (field === 'Experience Metric') return <label className="report-select">Metric<select aria-label="Experience metric" value={experienceMetric} onChange={(e) => setExperienceMetric(e.target.value)}><option>Sessions</option><option>Prompts</option></select></label>
      if (field === 'Agent name') return select('Agent', 'agent', ds.agents.map((a) => a.name))
      if (field === 'Organization') return select('Organisation', 'org', ds.orgs)
      if (field === 'Report User') return select('Person', 'user', [...ds.people.values()].map((p) => p.name))
      if (field === 'License Status') return <label className="report-select">Licence<select aria-label="Licence" value={filters.license} onChange={(e) => set('license', e.target.value)}><option value="">All</option><option value="L">Licensed</option><option value="U">Unlicensed</option></select></label>
      if (field === 'Usage Rank') {
        const kind = /Unlicensed/.test(visual.fields[0]?.entity ?? '') ? 'unlicensed' : /Agent/.test(visual.fields[0]?.entity ?? '') ? 'agent' : 'licensed'
        return select(`${kind} usage rank`, kind === 'agent' ? 'rankA' : kind === 'unlicensed' ? 'rankU' : 'rankL', [...new Set(usageRanks(ds.rows, kind).values())])
      }
      if (field === 'Agent Type Combined') return select('Agent type', 'type', [...new Set([...profilesOf(ds).values()].map((p) => p.typeCombined))])
      if (field === 'Review') return select('Review', 'review', [...new Set([...profilesOf(ds).values()].map((p) => p.review))])
      if (field === 'Recency') return select('Recency', 'recency', [...new Set([...profilesOf(ds).values()].map((p) => p.activity))])
      if (field === 'Return') return select('Return', 'returning', [...new Set([...profilesOf(ds).values()].map((p) => p.returnCategory))])
      if (field === 'Agent creator') return select('Creator', 'creator', [...new Set(ds.agents.map((a) => a.creator))])
      if (field === 'Activity') return select('Directory activity', 'activity', ['Active', 'Inactive'])
      if (field === 'License Weekly Metric') return <label className="report-select">Weekly metric<select aria-label="Weekly metric" value={weeklyMetric} onChange={(e) => setWeeklyMetric(e.target.value)}><option>Sessions</option><option>Prompts</option><option>Active Days</option></select></label>
      return <button className="report-control" onClick={() => setAboutOpen(true)}>{visual.fields[0]?.label || 'Report option'} (not available)</button>
    }
    if (visual.type === 'bookmarkNavigator') return <button className="report-control" onClick={() => setMonthly(!monthly)}>{monthly ? 'Weekly patterns' : 'Monthly comparison'}</button>
    if (visual.type === 'actionButton') return <button className="report-control" aria-label={visual.text || visual.title || 'Report help'} onClick={() => action(visual.text || visual.title)}>{visual.text || visual.title || (visual.position.width < 64 ? '?' : 'Report options')}</button>
    if (visual.type.startsWith('PowerSlicer')) return <label className="report-select">Guide page<select aria-label="Guide page" value={guidePage} onChange={(e) => setGuidePage(e.target.value)}><option value="">All pages</option>{[...new Set(glossary.map((g) => g.page))].map((p) => <option key={p}>{p}</option>)}</select></label>
    if (visual.type === 'textbox' || visual.type === 'shape') {
      const text = visual.textMeasure ? formatValue(measure(visual.textMeasure, scoped)) : visual.text
      return <div className="report-copy" style={visual.type === 'textbox' ? { fontSize: visual.fontSize * 4 / 3, fontWeight: visual.bold ? 600 : 400, color: visual.color } : undefined}>{text}</div>
    }
    throw new Error(`Unported report visual: ${visual.type}`)
  }
  const monthlyGroups = [...groupBy(scoped.rows, (r) => `${r.month}|${r.lic}`).entries()]
  return <div className="report-demo">
    <header className="report-demo-toolbar">
      <a href="../ai-in-one/">App demo</a>
      <label>Report page<select aria-label="Report page" value={pageId} onChange={(e) => { location.hash = `/${e.target.value}` }}>{pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <button onClick={() => setFilterOpen(true)}>Filters</button>
      <button onClick={() => setFilters(EMPTY)}>Reset filters</button>
      <button onClick={() => setAboutOpen(true)}>About the report demo</button>
      <a href="https://ai-datalab.github.io/">DataLab</a>
    </header>
    <p className="report-provenance">Static browser port of AI in One v2.0. All people, organisations and activity are invented. Not a Power BI embed.</p>
    {filters.from && filters.to && filters.from > filters.to && <p className="report-provenance" role="alert">The start date is after the end date. Choose a valid date range or reset the filters.</p>}
    <main className="report-scroll" aria-label={page.name}>
      <div className="report-canvas" style={{ width: page.width, height: page.height }}>
        {page.visuals.map((visual) => {
          const pos = visual.position
          const style: CSSProperties = { left: pos.x, top: pos.y, width: pos.width, height: pos.height, zIndex: Math.floor(pos.z), background: visual.background, border: visual.border ? '1px solid #DCE3ED' : undefined }
          return <section key={visual.id} data-visual={visual.type} className={`report-visual report-${visual.type}`} style={style}>{render(visual)}</section>
        })}
        {monthly && <section className="report-monthly">
          <h2>Monthly sessions and prompts by license population</h2>
          <p>All recorded activity by current-directory license. Per active user in each selected month.</p>
          <table className="report-table"><thead><tr><th>Month</th><th>Population</th><th>Sessions</th><th>Prompts</th><th>Active users</th><th>Sessions / user</th><th>Prompts / user</th></tr></thead><tbody>
            {monthlyGroups.map(([key, rows]) => <tr key={key}><th>{key.split('|')[0].slice(0, 7)}</th><td>{rows[0].lic === 'L' ? 'Paid (licensed)' : 'Free (unlicensed)'}</td><td>{formatValue(threads(rows))}</td><td>{formatValue(prompts(rows))}</td><td>{users(rows)}</td><td>{ratio(threads(rows), users(rows)).toFixed(1)}</td><td>{ratio(prompts(rows), users(rows)).toFixed(1)}</td></tr>)}
          </tbody></table>
          <button onClick={() => setMonthly(false)}>Back to weekly patterns</button>
        </section>}
      </div>
    </main>
    <nav className="report-page-tabs" aria-label="Report pages">{pages.map((p) => <a key={p.id} href={`#/${p.id}`} aria-current={page.id === p.id ? 'page' : undefined}>{p.name}</a>)}</nav>
    <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Report filters">
      <div className="report-filter-fields">
        {dateSelect}
        {select('Organisation', 'org', ds.orgs)}
        {select('Person', 'user', [...ds.people.values()].map((p) => p.name))}
        {select('Agent', 'agent', ds.agents.map((a) => a.name))}
        {select('App', 'host', [...new Set(ds.rows.map((r) => r.host))].sort())}
        {select('Agent type', 'type', [...new Set([...profilesOf(ds).values()].map((p) => p.typeCombined))])}
        <button className="btn" onClick={() => { setFilters(EMPTY); setFilterOpen(false) }}>Clear all filters</button>
      </div>
    </Sheet>
    <Sheet open={aboutOpen} onClose={() => setAboutOpen(false)} title="About this report demo">
      <p>The page names, canvas sizes, visual positions, titles and colours come from the shipping AI in One v2.0 Local CSV Power BI template. Browser charts and local calculations replace the Power BI runtime.</p>
      <p>All data is generated from deterministic rules. No production data, account, tenant, authentication, connector or administrator action is available.</p>
      <p>This demo does not implement Power BI RLS, disclosure-mode enforcement, licence-history attribution, hierarchy administration, export, the Power BI bookmark engine or custom visual runtime. Filters and page navigation are local browser controls; click an agent name to inspect its details.</p>
      <p>Hierarchy tables show top-level rows. Dual-axis charts share one browser scale, and cross-highlighting is unavailable. This is a presentation port with local calculations, not a DAX engine or proof of semantic-model parity. The glossary describes the full report, including features unavailable here.</p>
      <p>Sample records cover current-directory licence status, not licence-history transitions. Report adoption and habit measures use the same local calculation modules as the app demo. Figures describe the invented data, not a benchmark.</p>
      <p>Prompt totals can differ across data sources in the real report because of coverage and timing. This demo has one internally consistent synthetic source.</p>
    </Sheet>
  </div>
}
