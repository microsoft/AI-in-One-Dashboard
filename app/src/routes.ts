import { useEffect, useState } from 'react'

export type TabId = 'overview' | 'copilot' | 'chat' | 'agents' | 'licence' | 'guide'

export interface TabDef {
  id: TabId
  label: string
  intro: string
  views: { id: string; label: string; intro?: string }[]
  rank?: 'licensed' | 'unlicensed' | 'agent'
}

export const TABS: TabDef[] = [
  {
    id: 'overview',
    label: 'Overview',
    intro: 'Microsoft 365 Copilot, Copilot Chat and agents side by side.',
    views: [
      { id: 'trends', label: 'Trends' },
      { id: 'leaderboard', label: 'Leaderboard' },
    ],
  },
  {
    id: 'copilot',
    label: 'M365 Copilot',
    intro: 'People with a Microsoft 365 Copilot licence.',
    views: [
      { id: 'trends', label: 'Trends' },
      { id: 'leaderboard', label: 'Leaderboard' },
      { id: 'habits', label: 'Habits' },
    ],
    rank: 'licensed',
  },
  {
    id: 'chat',
    label: 'Copilot Chat',
    intro: 'People using Copilot Chat without a licence.',
    views: [
      { id: 'trends', label: 'Trends' },
      { id: 'leaderboard', label: 'Leaderboard' },
      { id: 'habits', label: 'Habits' },
    ],
    rank: 'unlicensed',
  },
  {
    id: 'agents',
    label: 'Agents',
    intro: 'Which agents people use, how often, and which need attention.',
    views: [
      { id: 'trends', label: 'Trends' },
      { id: 'leaderboard', label: 'Leaderboard' },
      { id: 'habits', label: 'Habits' },
      { id: 'health', label: 'Health check' },
      { id: 'uses', label: 'Use cases' },
    ],
    rank: 'agent',
  },
  {
    id: 'licence',
    label: 'Licence priority',
    intro: 'Unlicensed Copilot Chat users who would get most from a licence.',
    views: [],
    rank: 'unlicensed',
  },
  {
    id: 'guide',
    label: 'Guide',
    intro: 'What each metric means and how this app differs from the Power BI report.',
    views: [],
  },
]

export interface Route {
  tab: TabDef
  view: string
}

function parse(hash: string): Route {
  const [t, v] = hash.replace(/^#\/?/, '').split('/')
  const tab = TABS.find((x) => x.id === t) ?? TABS[0]
  const view = tab.views.find((x) => x.id === v)?.id ?? tab.views[0]?.id ?? ''
  return { tab, view }
}

export function useRoute(): [Route, (tab: TabId, view?: string) => void] {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => setRoute(parse(location.hash))
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const go = (tab: TabId, view?: string) => {
    location.hash = `/${tab}${view ? `/${view}` : ''}`
  }
  return [route, go]
}
