import { useMemo } from 'react'
import { byRank, inactiveLicensed, licensedNote, totalLicensed, useData } from '../data/store'
import { gloss } from '../data/glossary'
import { M, median } from '../metrics/core'
import { licencePriority } from '../metrics/licence'
import { Scatter } from '../ui/charts'
import { DataTable, type Column, type TableRow } from '../ui/DataTable'
import { dec1, dec2, int } from '../ui/format'
import { Kpi, KpiRow, Panel } from '../ui/primitives'
import { COLOR } from '../ui/theme'

const P = 'License Prioritisation'

interface Rec {
  label: string
  sub?: string
  users: number
  s: number
  d: number
  score: number
  rank: number
}

const cols: Column<Rec>[] = [
  {
    key: 'rank',
    label: 'Priority',
    width: '9%',
    align: 'right',
    value: (r) => (Number.isFinite(r.rank) ? r.rank : Infinity),
    render: (r) => (Number.isFinite(r.rank) ? <span className="rank-pill">{r.rank}</span> : '–'),
    help: gloss('License Priority Rank', P),
  },
  {
    key: 'label',
    label: 'Organisation / person',
    width: '35%',
    value: (r) => r.label,
    render: (r) => (
      <span className="name-cell">
        <span>{r.label}</span>
        {r.sub && <small>{r.sub}</small>}
      </span>
    ),
  },
  { key: 'users', label: 'Unlicensed users', value: (r) => r.users, fmt: int, align: 'right', bar: COLOR.unlicensed },
  { key: 's', label: 'Sessions per week (median)', value: (r) => r.s, fmt: dec1, align: 'right', help: gloss('Median Sessions Per User (Weekly)', P) },
  { key: 'd', label: 'Active days per week (median)', value: (r) => r.d, fmt: dec1, align: 'right', help: gloss('Median Active Days (Weekly)', P) },
  { key: 'score', label: 'Score', value: (r) => r.score, fmt: dec2, align: 'right' },
]

export function Licence() {
  const { ds, base, ranks, filters, nameOf } = useData()
  const d = useMemo(() => {
    const rows = byRank(base, ranks.unlicensed, filters.rank)
    const { people, orgs } = licencePriority(rows, nameOf)
    const tree: TableRow<Rec>[] = orgs.map((o) => ({
      id: o.key,
      data: { label: o.label, users: o.users, s: o.sessionsPerWeek, d: o.daysPerWeek, score: o.score, rank: o.rank },
      children: people
        .filter((p) => p.org === o.key)
        .map((p) => ({
          id: `${o.key}::${p.key}`,
          data: { label: p.label, sub: ds.people.get(p.key)?.title, users: 1, s: p.sessionsPerWeek, d: p.daysPerWeek, score: p.score, rank: p.rank },
        })),
    }))
    return {
      tree,
      points: orgs.map((o) => ({ key: o.key, label: o.label, x: o.daysPerWeek, y: o.sessionsPerWeek, size: o.users })),
      mx: median(orgs.map((o) => o.daysPerWeek).filter(Number.isFinite)),
      my: median(orgs.map((o) => o.sessionsPerWeek).filter(Number.isFinite)),
      unlic: M.activeUnlicensed(rows),
      lic: M.activeLicensed(base),
      total: totalLicensed(ds, filters.org),
      top: orgs[0]?.label,
    }
  }, [base, ranks, filters.rank, filters.org, nameOf, ds])

  return (
    <>
      <KpiRow>
        <Kpi tone="unlicensed" label="Unlicensed active users" value={int(d.unlic)} sub="candidates for a licence" help={gloss('Unlicensed Active Users', P)} />
        <Kpi tone="licensed" label="Licensed active users"         value={int(d.lic)} sub={licensedNote(ds, d.total, `of ${int(d.total)} licensed`)} help={gloss('Licensed Active Users', P)} />
                <Kpi label="Inactive licensed users" value={int(inactiveLicensed(d.total, d.lic))} sub={licensedNote(ds, d.total, 'licences that could be reassigned')} />
        <Kpi wide label="Top priority organisation" value={d.top ?? '–'} sub="highest score from its users' medians" />
      </KpiRow>
      <div className="grid grid-2-1">
        <Panel
          title="Where licences would add most value"
          note="Organisations by their unlicensed users' median weekly activity. The shaded area is above the median on both measures."
          help={gloss('License Priority Rank', P)}
        >
          <Scatter
            label="Licence priority by organisation"
            points={d.points}
            color={COLOR.unlicensed}
            xLabel="Active days per week (median)"
            yLabel="Sessions per week (median)"
            sizeLabel="Unlicensed users"
            xFmt={dec1}
            yFmt={dec1}
            quadrants={Number.isFinite(d.mx) && Number.isFinite(d.my) ? { x: d.mx, y: d.my, label: 'High priority' } : undefined}
            height={320}
          />
        </Panel>
        <Panel title="How the priority score works">
          <dl className="defs">
            <dt>60% sessions</dt>
            <dd>Weekly sessions per user, scaled against 10 a week.</dd>
            <dt>30% active days</dt>
            <dd>Weekly active days per user, scaled against 5 a week.</dd>
            <dt>10% depth</dt>
            <dd>Sessions per active day, scaled against 5.</dd>
          </dl>
          <p className="legend-text">People are ranked on their own score. Organisations are ranked on the score of their users' medians. Rank 1 is the strongest case for a licence.</p>
        </Panel>
      </div>
      <Panel title="Licence priority list" note="Unlicensed Copilot Chat users. Expand an organisation to see its people.">
        <DataTable label="Licence priority list" columns={cols} rows={d.tree} initialSort={{ key: 'rank' }} search={(r) => `${r.label} ${r.sub ?? ''}`} childNoun="organisations or people" />
      </Panel>
    </>
  )
}
