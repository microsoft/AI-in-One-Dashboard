import { useMemo } from 'react'
import { useData } from '../data/store'
import { isAgent, M, series } from '../metrics/core'
import { featuresOf } from '../metrics/agents'
import { LineChart } from './charts'
import { dateLabel, dayLabel, int, pct, dec1 } from './format'
import { Sheet } from './Sheet'
import { COLOR } from './theme'

/** Agent detail: replaces the PBI "Agent Details" cards that react to a selected agent. */
export function AgentDrawer({ name, onClose }: { name: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!name} onClose={onClose} title={name ?? ''} side>
      {name && <AgentDetail name={name} />}
    </Sheet>
  )
}

function AgentDetail({ name }: { name: string }) {
  const { base, profiles } = useData()
  const p = profiles.get(name)
  const d = useMemo(() => {
    const rs = base.filter((r) => isAgent(r) && r.agent === name)
    return {
      users: M.agentUsers(rs),
      sessions: M.agentSessions(rs),
      spu: M.sessionsPerAgentUser(rs),
      weekly: series(rs, (r) => r.week, [M.agentUsers]),
    }
  }, [base, name])
  const f = p ? featuresOf(p) : null
  return (
    <div className="detail">
      {p ? (
        <>
          <p className="detail-type">
            {p.typeCombined}
            {p.review && <span className="review-tag">{p.review}</span>}
          </p>
          {p.description && <p className="detail-desc">{p.description}</p>}
        </>
      ) : (
        <p className="detail-desc">This agent isn't in the Agent 365 inventory export, so only usage is shown.</p>
      )}
      <h3>In the selected period</h3>
      <dl className="stat-grid">
        <div>
          <dt>Users</dt>
          <dd>{int(d.users)}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>{int(d.sessions)}</dd>
        </div>
        <div>
          <dt>Sessions per user</dt>
          <dd>{dec1(d.spu)}</dd>
        </div>
      </dl>
      {d.weekly.length > 1 && (
        <LineChart label={`Weekly users of ${name}`} data={d.weekly} series={[{ name: 'Users', color: COLOR.agent, fmt: int }]} xFmt={dayLabel} height={140} area />
      )}
      {p && (
        <>
          <h3>Across all data</h3>
          <dl className="kv">
            <dt>Total users</dt>
            <dd>{int(p.totalUsers)}</dd>
            <dt>Organisations</dt>
            <dd>{int(p.orgCount)}</dd>
            <dt>Return rate</dt>
            <dd>
              {pct(p.returnRateValue)} <small>({p.returnCategory})</small>
            </dd>
            <dt>Last used</dt>
            <dd>{p.lastUsed ? dateLabel(p.lastUsed) : 'Never'}</dd>
            <dt>Activity</dt>
            <dd>{p.activity.replace(/^\d\.\s*/, '')}</dd>
            <dt>Created</dt>
            <dd>
              {p.created ? dateLabel(p.created) : '–'}
              {p.createdIn && <small> in {p.createdIn}</small>}
            </dd>
            <dt>Creator</dt>
            <dd>{p.creator || '–'}</dd>
            <dt>Works in</dt>
            <dd>{f?.platforms.length ? f.platforms.join(' · ') : '–'}</dd>
            <dt>Knowledge</dt>
            <dd>{f?.capabilities.length ? f.capabilities.join(' · ') : '–'}</dd>
          </dl>
        </>
      )}
    </div>
  )
}
