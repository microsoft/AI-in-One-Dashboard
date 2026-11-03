import type { Row } from '../data/types'
import { gloss } from '../data/glossary'
import { BUCKETS, BUCKET_LABEL, lastMonthBuckets, monthlyBuckets, type HabitKind } from '../metrics/habits'
import { ColumnChart, Distribution } from '../ui/charts'
import { int, monthLabel, monthShort, pct } from '../ui/format'
import { Kpi, KpiRow, Panel } from '../ui/primitives'
import { RAMP } from '../ui/theme'
const HABIT_PAGE: Record<HabitKind, string> = { licensed: 'M365 Copilot - Habit', unlicensed: 'Chat (Web) - Habit', agent: 'Agents - Habit' }
const HABIT_SUFFIX: Record<HabitKind, string> = { licensed: 'Licensed', unlicensed: 'Chat', agent: 'Agent' }
const HABIT_NOUN: Record<HabitKind, string> = { licensed: 'licensed users', unlicensed: 'unlicensed chat users', agent: 'agent users' }

/** Last-month habit cards, distribution and monthly columns: shared by the three habit views. */
export function HabitSummary({ rows, kind }: { rows: Row[]; kind: HabitKind }) {
  const last = lastMonthBuckets(rows, kind)
  const monthly = monthlyBuckets(rows, kind)
  const series = BUCKETS.map((b, i) => ({ name: `${b} days · ${BUCKET_LABEL[b]}`, color: RAMP[i], fmt: int }))
  return (
    <>
      <KpiRow>
        {BUCKETS.map((b) => (
          <Kpi
            key={b}
            label={`${BUCKET_LABEL[b]} · ${b} days`}
            value={int(last.counts[b])}
            sub={`${pct(last.rates[b])} of ${HABIT_NOUN[kind]} in ${monthLabel(last.month)}`}
            help={gloss(`${b} Active Days (${HABIT_SUFFIX[kind]})`, HABIT_PAGE[kind])}
          />
        ))}
      </KpiRow>
      <div className="grid grid-2">
        <Panel
          title="Users by habit, last complete month"
          note={`Active days in ${monthLabel(last.month)}`}
        >
          <Distribution
            label="Share of users by active-day bucket"
            items={BUCKETS.map((b, i) => ({ label: `${BUCKET_LABEL[b]} (${b} days)`, value: last.counts[b], color: RAMP[i] }))}
          />
        </Panel>
        <Panel title="Active days over time" note="Users in each active-day bucket, by month">
          <ColumnChart label="Users by active-day bucket per month" data={monthly} series={series} xFmt={monthShort} stacked />
        </Panel>
      </div>
    </>
  )
}
