import { useMemo } from 'react'
import { useData } from '../data/store'
import { gloss } from '../data/glossary'
import type { AgentProfile } from '../metrics/agents'
import { REVIEWS } from '../metrics/agents'
import { groupBy, isAgent, M, momChange, prompts, returnRate, series, threads, topAgents, users } from '../metrics/core'
import { flat, pivot } from '../metrics/pivot'
import { agentInventory, agentScope, MIN_AGENT_USERS, topCreator } from '../metrics/scope'
import { BarList } from '../ui/charts'
import { DataTable, type Column, type TableRow } from '../ui/DataTable'
import { dateLabel, dayLabel, dec1, int, monthLabel, pct, signedPct } from '../ui/format'
import { Kpi, KpiRow, Panel } from '../ui/primitives'
import { COLOR, REVIEW_COLOR } from '../ui/theme'
import { labelCol, measureCol, searchText, usePersonLabel } from './cols'
import { HabitSummary } from './HabitSummary'
import { TrendPair } from './TrendPair'

interface AgentRec {
  name: string
  type: string
  users: number
  sessions: number
  spu: number
  prompts: number
  returnRate: number
  creator: string
  description: string
  features: string
  orgCount: number
  lastUsed: string
  review: string
  activity: string
}

function useAgentData() {
  const { base, filters, profiles, ranks } = useData()
  return useMemo(() => {
    const rows = agentScope(base, filters, profiles, ranks.agent)
    const inventory = agentInventory(profiles, filters)
    const usage = groupBy(rows.filter(isAgent), (r) => r.agent)
    const recs: AgentRec[] = [...usage].map(([name, rs]) => {
      const p = profiles.get(name)
      const u = users(rs)
      return {
        name,
        type: p?.typeCombined ?? '(not in inventory)',
        users: u,
        sessions: threads(rs),
        spu: M.sessionsPerAgentUser(rs),
        prompts: prompts(rs),
        returnRate: returnRate(rs),
        creator: p?.creator ?? '',
        description: p?.description ?? '',
        features: p?.features ?? '',
        orgCount: p?.orgCount ?? NaN,
        lastUsed: p?.lastUsed ?? '',
        review: p?.review ?? '',
        activity: p?.activity ?? '',
      }
    })
    return { rows, inventory, recs }
  }, [base, filters, profiles, ranks])
}

const LB = 'Agents - Leaderboard'

function AgentKpis({ variant }: { variant: 'usage' | 'health' }) {
  const { ds, base, profiles } = useData()
  const { rows, inventory } = useAgentData()
  const k = useMemo(
    () => ({
      active: M.activeAgents(rows),
      users: M.agentUsers(rows),
      adoption: users(rows.filter(isAgent)) / (users(base) || NaN),
      weekly: M.weeklySessionsAgent(rows),
      mom: momChange(rows, ds.maxDate, M.agentSessions),
      ret: M.agentReturnRate(rows),
      high: inventory.filter((p) => p.review === '🔥 High Impact').length,
      dormant: inventory.filter((p) => p.review === '💤 Dormant').length,
      top: topAgents(rows),
      creator: topCreator(rows, profiles),
    }),
    [rows, base, ds.maxDate, inventory, profiles],
  )
  const P = 'Agents - Usage Trends'
  return (
    <KpiRow>
      <Kpi tone="agent" label="Active agents" value={int(k.active)} sub={`${int(inventory.length)} in inventory`} help="Distinct agents with at least one interaction in the selected period." />
      {variant === 'usage' ? (
        <>
          <Kpi tone="agent" label="Agent users" value={int(k.users)} sub={`${pct(k.adoption)} of active Copilot users`} help={gloss('Users Adopt Agents', P)} />
          <Kpi label="Agent sessions per user per week" value={dec1(k.weekly)} sub="average per agent user" help={gloss('Weekly Agent Sessions Per User')} />
          <Kpi label="Agent sessions month on month" value={signedPct(k.mom.value)} trend={k.mom.value} sub={`${monthLabel(k.mom.current)} vs ${monthLabel(k.mom.previous)}`} help={gloss('Agent Sessions MoM %', P)} />
        </>
      ) : (
        <>
          <Kpi label="High impact agents" value={int(k.high)} sub="wide reach, recently used" help={gloss('High Impact Agents', LB)} />
          <Kpi label="Dormant agents" value={int(k.dormant)} sub="few users, not used for 60+ days" help={gloss('Dormant Agents', LB)} />
        </>
      )}
      <Kpi label="Agent return rate" value={pct(k.ret)} sub="users with 2+ agent sessions" help={gloss('Agent Return Rate', P)} />
      <Kpi wide label="Most popular agent" value={k.top || '–'} sub="most distinct users" help={`${gloss('Most Popular Agent', P) ?? ''} The PBI also shows "Most Versatile Agent", which uses the same calculation.`} />
      {variant === 'health' && <Kpi wide label="Most popular creator" value={k.creator || '–'} sub="Agent Builder agents, most users" help={gloss('Top Builder', LB)} />}
    </KpiRow>
  )
}

function useSessionsByAgent() {
  const { recs } = useAgentData()
  return useMemo(
    () =>
      recs
        .filter((r) => r.users >= MIN_AGENT_USERS)
        .map((r) => ({ key: r.name, label: r.name, value: r.sessions, hint: r.type })),
    [recs],
  )
}

const PRIVACY = `Agents with fewer than ${MIN_AGENT_USERS} users are hidden to protect privacy.`

export function AgentTrends() {
  const { openAgent } = useData()
  const { rows } = useAgentData()
  const items = useSessionsByAgent()
  const d = useMemo(
    () => ({
      users: series(rows.filter(isAgent), (r) => r.week, [M.agentUsers]),
      sessions: series(rows.filter(isAgent), (r) => r.week, [M.agentSessions]),
      orgs: [...groupBy(rows, (r) => r.org)]
        .map(([org, rs]) => ({ key: org, label: org, value: M.weeklySessionsAgent(rs) }))
        .filter((o) => Number.isFinite(o.value)),
    }),
    [rows],
  )
  return (
    <>
      <AgentKpis variant="usage" />
      <div className="grid grid-2">
        <Panel title="Sessions by agent" note={`Select an agent for details. ${PRIVACY}`} help={gloss('Number of Sessions by Agent')}>
          <BarList label="Sessions by agent" items={items} color={COLOR.agent} fmt={int} limit={10} onSelect={openAgent} />
        </Panel>
        <TrendPair
          title="Weekly agent activity"
          note="Agent users and agent sessions, by week"
          xFmt={dayLabel}
          top={{ name: 'Agent users', data: d.users, series: { name: 'Agent users', color: COLOR.agent, fmt: int } }}
          bottom={{ name: 'Agent sessions', data: d.sessions, series: { name: 'Agent sessions', color: COLOR.agent, fmt: int } }}
        />
      </div>
      <Panel title="Weekly agent sessions by organisation" note="Average agent sessions per agent user per week">
        <BarList label="Weekly agent sessions by organisation" items={d.orgs} color={COLOR.agent} fmt={dec1} limit={10} />
      </Panel>
    </>
  )
}

export function AgentHabits() {
  const { openAgent } = useData()
  const { rows, recs } = useAgentData()
  const orgs = useMemo(
    () => flat(rows, (r) => r.org, { users: M.agentUsers, weekly: M.weeklySessionsAgent }, (rs) => M.agentUsers(rs) > 0),
    [rows],
  )
  const activity: TableRow<AgentRec>[] = recs.map((r) => ({ id: r.name, data: r }))
  return (
    <>
      <HabitSummary rows={rows} kind="agent" />
      <div className="grid grid-2">
        <Panel title="Agent activity" note="Users and sessions per agent. Select a row for details.">
          <DataTable
            label="Agent activity"
            columns={[nameCol, { key: 'users', label: 'Users', value: (r) => r.users, fmt: int, align: 'right', bar: COLOR.agent }, { key: 'sessions', label: 'Sessions', value: (r) => r.sessions, fmt: int, align: 'right' }]}
            rows={activity}
            initialSort={{ key: 'users', desc: true }}
            onRowClick={(r) => openAgent(r.name)}
            pageSize={10}
          />
        </Panel>
        <Panel title="Agent habits by organisation" note="Agent users and their weekly agent sessions">
          <DataTable
            label="Agent habits by organisation"
            columns={[labelCol('Organisation', '50%'), measureCol('users', 'Agent users', int, COLOR.agent), measureCol('weekly', 'Sessions per user per week', dec1)]}
            rows={orgs}
            initialSort={{ key: 'users', desc: true }}
            pageSize={10}
          />
        </Panel>
      </div>
    </>
  )
}

const nameCol: Column<AgentRec> = {
  key: 'name',
  label: 'Agent',
  width: '24%',
  value: (r) => r.name,
  render: (r) => (
    <span className="name-cell">
      <span>{r.name}</span>
      {r.type && <small>{r.type}</small>}
    </span>
  ),
}
const textCol = (key: keyof AgentRec, label: string, width?: string): Column<AgentRec> => ({
  key,
  label,
  width,
  value: (r) => String(r[key] ?? ''),
  render: (r) => <span className="wrap-cell">{String(r[key] || '–')}</span>,
})

export function AgentLeaderboard() {
  const { openAgent } = useData()
  const person = usePersonLabel()
  const { rows, recs } = useAgentData()
  const people = useMemo(
    () => pivot(rows, (r) => r.org, (r) => r.user, person, { users: M.agentUsers, sessions: M.agentSessions, spu: M.sessionsPerAgentUser }, (rs) => M.agentUsers(rs) > 0),
    [rows, person],
  )
  return (
    <>
      <AgentKpis variant="health" />
      <Panel title="Agent user leaderboard" note="Expand an organisation to see its people">
        <DataTable
          label="Agent user leaderboard"
          columns={[labelCol('Organisation / person'), measureCol('users', 'Agent users', int, COLOR.agent), measureCol('sessions', 'Agent sessions', int), measureCol('spu', 'Sessions per agent user', dec1)]}
          rows={people}
          initialSort={{ key: 'users', desc: true }}
          search={searchText}
          childNoun="organisations or people"
        />
      </Panel>
      <Panel title="Agents" note="Usage in the selected period. Select a row for details.">
        <DataTable
          label="Agents leaderboard"
          columns={[
            nameCol,
            { key: 'users', label: 'Users', value: (r) => r.users, fmt: int, align: 'right', bar: COLOR.agent },
            { key: 'sessions', label: 'Sessions', value: (r) => r.sessions, fmt: int, align: 'right' },
            { key: 'spu', label: 'Sessions per user', value: (r) => r.spu, fmt: dec1, align: 'right' },
            { key: 'ret', label: 'Return rate', value: (r) => r.returnRate, fmt: pct, align: 'right', help: gloss('Agent Return Rate', LB) },
            textCol('creator', 'Creator', '14%'),
            textCol('description', 'Description', '26%'),
          ]}
          rows={recs.map((r) => ({ id: r.name, data: r }))}
          initialSort={{ key: 'users', desc: true }}
          onRowClick={(r) => openAgent(r.name)}
          search={(r) => `${r.name} ${r.creator} ${r.type}`}
        />
        <FeatureLegend />
      </Panel>
    </>
  )
}

function FeatureLegend() {
  return (
    <p className="legend-text">
      <b>Features:</b> 💬 Teams · 📧 Outlook · 📄 Office apps · 📁 SharePoint · ☁️ OneDrive · 🔌 Graph connectors · 📎 Files
    </p>
  )
}

export function AgentHealth() {
  const { ds, filters, setFilter, openAgent } = useData()
  const { inventory } = useAgentData()
  const counts = REVIEWS.map((r) => ({ key: r, label: r, value: inventory.filter((p) => p.review === r).length, color: REVIEW_COLOR[r] }))
  const toRec = (p: AgentProfile): AgentRec => ({
    name: p.name,
    type: p.typeCombined,
    users: p.totalUsers,
    sessions: NaN,
    spu: NaN,
    prompts: NaN,
    returnRate: p.returnRateValue,
    creator: p.creator,
    description: p.description,
    features: p.features,
    orgCount: p.orgCount,
    lastUsed: p.lastUsed,
    review: p.review,
    activity: p.activity,
  })
  return (
    <>
      <AgentKpis variant="health" />
      {ds.agents.length === 0 && (
        <p className="notice" role="status">
          Load the Agent 365 file to see each agent's review status. Use <b>Change data</b> to add it.
        </p>
      )}
      <Panel title="Agents by review status" note="Select a status to filter the review table">
        <div className="grid grid-2">
          <BarList
            label="Agents by review status"
            items={counts}
            color={COLOR.agent}
            keepOrder
            selected={filters.review}
            onSelect={(k) => setFilter('review', filters.review === k ? '' : k)}
          />
          <dl className="defs defs-grid">
            <div>
              <dt>🔥 High impact</dt>
              <dd>Used in the last 30 days by many users across several organisations.</dd>
            </div>
            <div>
              <dt>✅ Keep</dt>
              <dd>Recently used, or still used by enough people.</dd>
            </div>
            <div>
              <dt>⚠️ Review</dt>
              <dd>Usage is fading. Check whether it is still needed.</dd>
            </div>
            <div>
              <dt>💤 Dormant</dt>
              <dd>Few users and no use for 60+ days. Candidate to retire.</dd>
            </div>
            <div>
              <dt>🆕 New</dt>
              <dd>Created in the last 14 days and not used yet.</dd>
            </div>
            <div>
              <dt>❌ Never used</dt>
              <dd>Created more than 14 days ago and never used.</dd>
            </div>
          </dl>
        </div>
      </Panel>
      <Panel title="Agent activity review" note="All agents in the inventory, across all data. Select a row for details.">
        <DataTable
          label="Agent activity review"
          columns={[
            nameCol,
            { key: 'users', label: 'Users', width: '13%', value: (r) => r.users, fmt: int, align: 'right', bar: COLOR.agent },
            { key: 'orgs', label: 'Orgs', width: '6%', value: (r) => r.orgCount, fmt: int, align: 'right' },
            { key: 'last', label: 'Last used', width: '10%', value: (r) => r.lastUsed, render: (r) => (r.lastUsed ? dateLabel(r.lastUsed) : 'Never') },
            { key: 'ret', label: 'Return rate', width: '9%', value: (r) => r.returnRate, fmt: pct, align: 'right' },
            { key: 'review', label: 'Review', width: '12%', value: (r) => r.review, render: (r) => <span className="review-tag">{r.review}</span> },
            textCol('features', 'Features', '14%'),
            textCol('creator', 'Creator', '12%'),
          ]}
          rows={inventory.map((p) => ({ id: p.name, data: toRec(p) }))}
          initialSort={{ key: 'users', desc: true }}
          onRowClick={(r) => openAgent(r.name)}
          search={(r) => `${r.name} ${r.creator} ${r.review}`}
        />
        <FeatureLegend />
      </Panel>
    </>
  )
}

export function AgentUseCases() {
  const { openAgent } = useData()
  const { recs } = useAgentData()
  const items = useSessionsByAgent()
  return (
    <>
      <Panel title="What agents are used for" note="Each agent's description, reach and features. Select a row for details." help={gloss('Users', 'Agents - Use Cases')}>
        <DataTable
          label="Agent use cases"
          columns={[
            nameCol,
            { key: 'users', label: 'Users', width: '14%', value: (r) => r.users, fmt: int, align: 'right', bar: COLOR.agent },
            { key: 'prompts', label: 'Prompts', width: '10%', value: (r) => r.prompts, fmt: int, align: 'right' },
            textCol('features', 'Features', '16%'),
            textCol('description', 'Description', '36%'),
          ]}
          rows={recs.map((r) => ({ id: r.name, data: r }))}
          initialSort={{ key: 'users', desc: true }}
          onRowClick={(r) => openAgent(r.name)}
          search={(r) => `${r.name} ${r.description}`}
        />
        <FeatureLegend />
      </Panel>
      <Panel title="Sessions by agent" note={PRIVACY} help={gloss('Total Agent Sessions', 'Agents - Use Cases')}>
        <BarList label="Sessions by agent" items={items} color={COLOR.agent} fmt={int} limit={12} onSelect={openAgent} />
      </Panel>
    </>
  )
}
