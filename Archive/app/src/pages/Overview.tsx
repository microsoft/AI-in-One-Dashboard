import { useMemo } from 'react'
import { inactiveLicensed, licensedNote, totalLicensed, useData } from '../data/store'
import { gloss } from '../data/glossary'
import { groupBy, M, series } from '../metrics/core'
import { pivot } from '../metrics/pivot'
import { GroupedBars, LineChart, Scatter } from '../ui/charts'
import { DataTable } from '../ui/DataTable'
import { dayLabel, dec1, int, pct } from '../ui/format'
import { Kpi, KpiRow, Panel } from '../ui/primitives'
import { COLOR } from '../ui/theme'
import { labelCol, measureCol, searchText, usePersonLabel } from './cols'

const P = 'Combined Trends'
const PL = 'Combined Leaderboard'

export function OverviewTrends() {
  const { ds, base, filters } = useData()
  const d = useMemo(() => {
    const byOrg = [...groupBy(base, (r) => r.org)]
    return {
      agentUsers: M.agentUsers(base),
      unlic: M.activeUnlicensed(base),
      lic: M.activeLicensed(base),
      totalLic: totalLicensed(ds, filters.org),
      orgUsers: byOrg
        .map(([org, rs]) => ({ key: org, values: [M.activeLicensed(rs), M.activeUnlicensed(rs), M.agentUsers(rs)] }))
        .sort((a, b) => b.values[0] + b.values[1] - (a.values[0] + a.values[1])),
      weekly: series(base, (r) => r.week, [M.sessionsPerUserLicensed, M.sessionsPerUserUnlicensed, M.sessionsPerAgentUser]),
      scLic: byOrg.map(([org, rs]) => ({ key: org, label: org, x: M.chatDaysPerUserLicensed(rs), y: M.sessionsPerUserLicensed(rs), size: M.activeLicensed(rs) })),
      scUnlic: byOrg.map(([org, rs]) => ({ key: org, label: org, x: M.chatDaysPerUser(rs), y: M.sessionsPerUserUnlicensed(rs), size: M.activeUnlicensed(rs) })),
      scAgent: byOrg.map(([org, rs]) => ({ key: org, label: org, x: M.agentDaysPerUser(rs), y: M.sessionsPerAgentUser(rs), size: M.agentUsers(rs) })),
    }
  }, [base, ds, filters.org])

  return (
    <>
      <KpiRow>
        <Kpi tone="licensed" label="M365 Copilot active users" value={int(d.lic)} sub={licensedNote(ds, d.totalLic, `of ${int(d.totalLic)} licensed`)} help={gloss('M365 Copilot Active Users', P)} />
        <Kpi tone="unlicensed" label="Copilot Chat active users" value={int(d.unlic)} sub="unlicensed" help={gloss('Unlicensed Chat Active Users', P)} />
        <Kpi tone="agent" label="Agent active users" value={int(d.agentUsers)} sub="any licence" help={gloss('Agent Active Users', P)} />
        <Kpi label="Inactive licensed users" value={int(inactiveLicensed(d.totalLic, d.lic))} sub={licensedNote(ds, d.totalLic, 'licensed, no activity in period')} help="Licensed users minus licensed users with Copilot activity in the selected period." />
      </KpiRow>
      <div className="grid grid-2">
        <Panel title="Active users by organisation" note="Licensed, unlicensed and agent users">
          <GroupedBars
            label="Active users by organisation"
            data={d.orgUsers}
            series={[
              { name: 'M365 Copilot (licensed)', color: COLOR.licensed },
              { name: 'Copilot Chat (unlicensed)', color: COLOR.unlicensed },
              { name: 'Agents', color: COLOR.agent },
            ]}
          />
        </Panel>
        <Panel title="Average sessions per active user, by week" note="Each user counted once per group" help={gloss('Weekly M365 Copilot Sessions Per User', P)}>
          <LineChart
            label="Average sessions per active user by week"
            data={d.weekly}
            xFmt={dayLabel}
            series={[
              { name: 'M365 Copilot', color: COLOR.licensed },
              { name: 'Copilot Chat', color: COLOR.unlicensed },
              { name: 'Agents', color: COLOR.agent },
            ]}
          />
        </Panel>
      </div>
      <h2 className="section-title">Usage frequency and intensity by organisation</h2>
      <p className="section-note">Bubbles are organisations, sized by active users. Further right means more active days; higher means more sessions.</p>
      <div className="grid grid-3">
        <Panel title="M365 Copilot" help={gloss('M365 Copilot Active Days Per User', P)}>
          <Scatter label="M365 Copilot frequency and intensity" points={d.scLic} color={COLOR.licensed} xLabel="Active days per user" yLabel="Sessions per active user" sizeLabel="Active users" height={240} />
        </Panel>
        <Panel title="Copilot Chat" help={gloss('Chat Active Days Per User', P)}>
          <Scatter label="Copilot Chat frequency and intensity" points={d.scUnlic} color={COLOR.unlicensed} xLabel="Chat active days per user" yLabel="Sessions per active user" sizeLabel="Active users" height={240} />
        </Panel>
        <Panel title="Agents" help={gloss('Agent Active Days Per User', P)}>
          <Scatter label="Agent frequency and intensity" points={d.scAgent} color={COLOR.agent} xLabel="Agent active days per user" yLabel="Sessions per agent user" sizeLabel="Agent users" height={240} />
        </Panel>
      </div>
    </>
  )
}

export function OverviewLeaderboard() {
  const { ds, base, filters } = useData()
  const person = usePersonLabel()
  const d = useMemo(
    () => ({
      agentUsers: M.agentUsers(base),
      agentWeekly: M.weeklySessionsAgent(base),
      unlic: M.activeUnlicensed(base),
      unlicWeekly: M.weeklySessionsUnlicensed(base),
      lic: M.activeLicensed(base),
      licWeekly: M.weeklySessionsLicensed(base),
      totalLic: totalLicensed(ds, filters.org),
      licPivot: pivot(base, (r) => r.org, (r) => r.user, person, {
        users: M.activeLicensed,
        spu: M.sessionsPerUserLicensed,
        agents: M.pctLicensedUsingAgents,
        aspu: M.sessionsPerAgentUser,
      }, (rs) => M.activeLicensed(rs) > 0),
      unlicPivot: pivot(base, (r) => r.org, (r) => r.user, person, {
        users: M.activeUnlicensed,
        spu: M.sessionsPerUserUnlicensed,
        agents: M.pctUnlicensedUsingAgents,
        aspu: M.sessionsPerAgentUser,
      }, (rs) => M.activeUnlicensed(rs) > 0),
    }),
    [base, ds, filters.org, person],
  )
  const cols = (color: string) => [
    labelCol('Organisation / person'),
    measureCol('users', 'Active users', int, color),
    measureCol('spu', 'Sessions per user', dec1),
    measureCol('agents', 'Using agents', pct),
    measureCol('aspu', 'Agent sessions per agent user', dec1),
  ]
  const search = searchText
  return (
    <>
      <KpiRow>
        <Kpi tone="licensed" label="M365 Copilot users" value={int(d.lic)} sub={<><b>{dec1(d.licWeekly)}</b> sessions per user per week</>} help={gloss('M365 Copilot Users', PL)} />
        <Kpi tone="unlicensed" label="Copilot Chat users" value={int(d.unlic)} sub={<><b>{dec1(d.unlicWeekly)}</b> sessions per user per week</>} help={gloss('Unlicensed Chat Users', PL)} />
        <Kpi tone="agent" label="Agent users" value={int(d.agentUsers)} sub={<><b>{dec1(d.agentWeekly)}</b> sessions per user per week</>} help={gloss('Agent Users', PL)} />
        <Kpi label="Inactive licensed users" value={int(inactiveLicensed(d.totalLic, d.lic))} sub={licensedNote(ds, d.totalLic, `of ${int(d.totalLic)} licensed`)} />
      </KpiRow>
      <Panel title="M365 Copilot (licensed) leaderboard" note="Expand an organisation to see its people" help={gloss('% Copilot Users Using Agents (Licensed)', PL)}>
        <DataTable label="Licensed usage leaderboard" columns={cols(COLOR.licensed)} rows={d.licPivot} initialSort={{ key: 'users', desc: true }} search={search} childNoun="organisations or people" />
      </Panel>
      <Panel title="Copilot Chat (unlicensed) leaderboard" note="Expand an organisation to see its people" help={gloss('% Chat Users Using Agents (Unlicensed)', PL)}>
        <DataTable label="Unlicensed usage leaderboard" columns={cols(COLOR.unlicensed)} rows={d.unlicPivot} initialSort={{ key: 'users', desc: true }} search={search} childNoun="organisations or people" />
      </Panel>
    </>
  )
}
