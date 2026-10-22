import { useMemo } from 'react'
import type { Row } from '../data/types'
import { byRank, totalLicensed, useData } from '../data/store'
import { gloss } from '../data/glossary'
import { groupBy, isChat, isL, isU, M, momChange, series } from '../metrics/core'
import { flat, pivot } from '../metrics/pivot'
import { RANKS, rankLabel } from '../metrics/ranks'
import { BarList } from '../ui/charts'
import { DataTable } from '../ui/DataTable'
import { dayLabel, dec1, int, monthLabel, signedPct } from '../ui/format'
import { Kpi, KpiRow, Panel } from '../ui/primitives'
import { COLOR, RANK_RAMP } from '../ui/theme'
import { labelCol, measureCol, searchText, usePersonLabel } from './cols'
import { HabitSummary } from './HabitSummary'
import { TrendPair } from './TrendPair'

export type Pop = 'licensed' | 'unlicensed'

/** Everything that differs between the M365 Copilot (licensed) and Copilot Chat (unlicensed) PBI pages. */
const CFG = {
  licensed: {
    page: 'M365 Copilot',
    color: COLOR.licensed,
    tone: 'licensed' as const,
    noun: 'licensed users',
    active: M.activeLicensed,
    sessions: M.sessionsLicensed,
    weekly: M.weeklySessionsLicensed,
    perUser: M.sessionsPerUserLicensed,
    days: M.weeklyDaysLicensed,
    has: (rs: Row[]) => M.activeLicensed(rs) > 0,
    inScope: isL,
  },
  unlicensed: {
    page: 'Chat (Web)',
    color: COLOR.unlicensed,
    tone: 'unlicensed' as const,
    noun: 'unlicensed users',
    active: M.activeUnlicensed,
    sessions: M.sessionsUnlicensed,
    weekly: M.weeklySessionsUnlicensed,
    perUser: M.sessionsPerUserUnlicensed,
    days: M.weeklyDaysUnlicensed,
    has: (rs: Row[]) => M.activeUnlicensed(rs) > 0,
    inScope: (r: Row) => isU(r) && isChat(r),
  },
}

function useScoped(pop: Pop) {
  const { base, ranks, filters } = useData()
  return useMemo(() => byRank(base, ranks[pop], filters.rank), [base, ranks, pop, filters.rank])
}

function PopKpis({ pop, rows }: { pop: Pop; rows: Row[] }) {
  const { ds, filters } = useData()
  const c = CFG[pop]
  const k = useMemo(() => {
    const active = c.active(rows)
    const mom = momChange(rows, ds.maxDate, c.sessions)
    return {
      active,
      total: totalLicensed(ds, filters.org),
      exAgents: M.sessionsLicensedExAgents(rows),
      sessions: c.sessions(rows),
      weekly: c.weekly(rows),
      days: c.days(rows),
      mom,
    }
  }, [rows, ds, filters.org, c])
  const page = `${c.page} - Usage Trends`
  return (
    <KpiRow>
      <Kpi tone={c.tone} label="Active users" value={int(k.active)} sub={pop === 'licensed' ? `of ${int(k.total)} licensed` : 'unlicensed, chat'} help={gloss('Active Users', page)} />
      {pop === 'licensed' && (
        <Kpi label="Inactive licensed users" value={int(k.total - k.active)} sub="licensed, no activity in period" help="Licensed users minus licensed users with Copilot activity in the selected period." />
      )}
      <Kpi
        label={pop === 'licensed' ? 'Sessions (excl. agents)' : 'Total sessions'}
        value={int(pop === 'licensed' ? k.exAgents : k.sessions)}
        sub={pop === 'licensed' ? 'chat sessions, excludes autonomous' : 'distinct conversations'}
        help={gloss(pop === 'licensed' ? 'Total Sessions (excl. Agents)' : 'Total Sessions', page)}
      />
      <Kpi label="Sessions per user per week" value={dec1(k.weekly)} sub="average per active user" help={gloss('Sessions (Weekly - Per User)', page)} />
      <Kpi
        label="Sessions month on month"
        value={signedPct(k.mom.value)}
        trend={k.mom.value}
        sub={`${monthLabel(k.mom.current)} vs ${monthLabel(k.mom.previous)}`}
        help={gloss('MoM % Change (Sessions)', page)}
      />
      <Kpi label="Active days per user per week" value={dec1(k.days)} sub="average per active user" help={gloss('Active Days (Weekly - Per User)', page)} />
    </KpiRow>
  )
}

export function PopTrends({ pop }: { pop: Pop }) {
  const rows = useScoped(pop)
  const { base, ranks } = useData()
  const c = CFG[pop]
  const d = useMemo(() => {
    const byRankTier = groupBy(base, (r) => ranks[pop].get(r.user) ?? '')
    return {
      users: series(rows, (r) => r.week, [c.active]),
      perUser: series(rows, (r) => r.week, [c.perUser]),
      apps: flat(rows.filter(c.inScope), (r) => r.host || '(unknown)', { s: c.sessions }, (rs) => rs.length > 0)
        .map((t) => ({ key: t.id, label: t.data.label, value: t.data.m.s }))
        .sort((a, b) => b.value - a.value),
      ranks: RANKS.map((rk) => ({ key: rk, label: rankLabel(rk), value: c.weekly(byRankTier.get(rk) ?? []) })),
      orgs: [...groupBy(rows, (r) => r.org)]
        .map(([org, rs]) => ({ key: org, label: org, value: c.weekly(rs) }))
        .filter((o) => Number.isFinite(o.value))
        .sort((a, b) => b.value - a.value),
    }
  }, [rows, base, ranks, pop, c])
  return (
    <>
      <PopKpis pop={pop} rows={rows} />
      <div className="grid grid-2">
        <TrendPair
          title="Weekly activity"
          note={`Active ${c.noun} and their average sessions, by week`}
          xFmt={dayLabel}
          top={{ name: 'Active users', data: d.users, series: { name: 'Active users', color: c.color, fmt: int } }}
          bottom={{ name: 'Sessions per active user', data: d.perUser, series: { name: 'Sessions per user', color: c.color, fmt: dec1 } }}
        />
        <Panel title="Sessions by app" note="Where people use Copilot" help={gloss(pop === 'licensed' ? 'Licensed Copilot - Total Sessions by Application' : 'Unlicensed Copilot - Sessions by Application')}>
          <BarList label="Sessions by app" items={d.apps} color={c.color} fmt={int} limit={8} />
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="Weekly sessions by usage rank" note="Average sessions per user per week, for each usage tier">
          <BarList
            label="Weekly sessions by usage rank"
            items={d.ranks.map((r, i) => ({ ...r, color: RANK_RAMP[i] }))}
            color={c.color}
            fmt={dec1}
            keepOrder
          />
        </Panel>
        <Panel title="Weekly sessions by organisation" note="Average sessions per user per week">
          <BarList label="Weekly sessions by organisation" items={d.orgs} color={c.color} fmt={dec1} limit={10} />
        </Panel>
      </div>
    </>
  )
}

export function PopLeaderboard({ pop }: { pop: Pop }) {
  const rows = useScoped(pop)
  const person = usePersonLabel()
  const c = CFG[pop]
  const d = useMemo(() => {
    const ms = { users: c.active, sessions: c.sessions, weekly: c.weekly }
    return {
      people: pivot(rows, (r) => r.org, (r) => r.user, person, ms, c.has),
      apps: flat(rows, (r) => r.host || '(unknown)', ms, c.has),
    }
  }, [rows, person, c])
  const page = `${c.page} - Leaderboard`
  const cols = (first: string) => [
    labelCol(first),
    measureCol('users', 'Active users', int, c.color, gloss('Active Users', page)),
    measureCol('sessions', 'Sessions', int),
    measureCol('weekly', 'Sessions per user per week', dec1, undefined, gloss('Sessions (Weekly - Per User)', page)),
  ]
  return (
    <>
      <PopKpis pop={pop} rows={rows} />
      <Panel title="Usage leaderboard" note="Expand an organisation to see its people">
        <DataTable label={`${c.page} usage leaderboard`} columns={cols('Organisation / person')} rows={d.people} initialSort={{ key: 'users', desc: true }} search={searchText} childNoun="organisations or people" />
      </Panel>
      <Panel title="Usage by app" note="Sessions in each Copilot surface">
        <DataTable label={`${c.page} usage by app`} columns={cols('App')} rows={d.apps} initialSort={{ key: 'sessions', desc: true }} />
      </Panel>
    </>
  )
}

export function PopHabits({ pop }: { pop: Pop }) {
  const rows = useScoped(pop)
  const c = CFG[pop]
  const orgs = useMemo(
    () =>
      pop === 'licensed'
        ? flat(rows, (r) => r.org, { users: M.usersLicensed, x: M.actionsPerUserLicensed }, c.has)
        : flat(rows, (r) => r.org, { users: M.usersUnlicensed, x: M.weeklySessionsUnlicensed }, c.has),
    [rows, pop, c],
  )
  return (
    <>
      <HabitSummary rows={rows} kind={pop} />
      <Panel title="Habits by organisation" note={pop === 'licensed' ? 'Licensed users and Copilot actions per user' : 'Unlicensed users and their weekly sessions'}>
        <DataTable
          label="Habits by organisation"
          columns={[
            labelCol('Organisation'),
            measureCol('users', 'Users', int, c.color),
            pop === 'licensed'
              ? measureCol('x', 'Actions per user', dec1, undefined, gloss('M365 Copilot Actions Per User'))
              : measureCol('x', 'Sessions per user per week', dec1),
          ]}
          rows={orgs}
          initialSort={{ key: 'users', desc: true }}
        />
      </Panel>
    </>
  )
}
