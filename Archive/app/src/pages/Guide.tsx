import { useMemo, useState } from 'react'
import { GLOSSARY } from '../data/glossary'
import { Panel } from '../ui/primitives'

const NOTES: { title: string; body: string }[] = [
  {
    title: 'Same numbers, simpler layout',
    body: 'Every measure in the Power BI report is here. Pages are grouped into tabs, and each tab has views for trends, leaderboards and habits.',
  },
  {
    title: 'Charts that changed shape',
    body: 'Treemaps and donuts are shown as ranked bars, and dual-axis charts as two aligned charts. The values are unchanged.',
  },
  {
    title: 'Month on month',
    body: 'Month-on-month change compares the last complete month with the month before it. The Power BI report compares the selected dates with the same dates a month earlier.',
  },
  {
    title: 'Most popular and most versatile agent',
    body: 'Both Power BI cards use the same calculation, so the app shows one "Most popular agent" tile.',
  },
  {
    title: 'Agent health and usage ranks',
    body: 'Like the Power BI calculated columns, agent review status, return categories and usage ranks are worked out on all data, not the selected period.',
  },
  {
    title: 'Not included',
    body: 'The AI narrative visual is not in this edition. Use the KPI tiles and the info tips for the same context.',
  },
  {
    title: 'Privacy',
    body: 'Your data stays in your browser. Charts of sessions by agent hide agents with fewer than three users.',
  },
]

export function Guide() {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    const hits = GLOSSARY.filter((g) => !s || `${g.metric} ${g.description} ${g.page}`.toLowerCase().includes(s))
    const map = new Map<string, typeof hits>()
    for (const h of hits.sort((a, b) => a.pageOrder - b.pageOrder || a.metricOrder - b.metricOrder)) map.set(h.page, [...(map.get(h.page) ?? []), h])
    return [...map]
  }, [q])
  return (
    <div className="grid grid-1-2">
      <Panel title="About this app">
        <dl className="defs">
          {NOTES.map((n) => (
            <div key={n.title}>
              <dt>{n.title}</dt>
              <dd>{n.body}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel
        title="Metric glossary"
        note="Definitions from the Power BI report"
        actions={
          <input className="search" type="search" placeholder="Search metrics" aria-label="Search metrics" value={q} onChange={(e) => setQ(e.target.value)} />
        }
      >
        {groups.length === 0 && <p className="empty">No metrics match “{q}”.</p>}
        {groups.map(([page, items]) => (
          <section key={page} className="gloss-group">
            <h4>{page}</h4>
            <dl className="defs">
              {items.map((g) => (
                <div key={g.metric}>
                  <dt>{g.metric}</dt>
                  <dd>{g.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </Panel>
    </div>
  )
}
