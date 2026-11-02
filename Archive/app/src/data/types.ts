export type Lic = 'L' | 'U' | 'O'

export interface Row {
  user: string
  date: string
  week: string
  month: string
  creation: string
  agentId: string
  agent: string
  host: string
  lic: Lic
  thread: string
  msg: string
  org: string
  isAgent: boolean
}

export interface Person {
  key: string
  id: string
  name: string
  org: string
  title: string
  country: string
  hasLicense: boolean
  lic: string
}

export interface AgentInfo {
  name: string
  supportedIn: string
  created: string
  creator: string
  typeA365: string
  description: string
  createdIn: string
  titleId: string
  sharePoint: boolean
  oneDrive: boolean
  graph: boolean
  files: boolean
}

export interface Dataset {
  rows: Row[]
  people: Map<string, Person>
  agents: AgentInfo[]
  maxDate: string
  minDate: string
  months: string[]
  orgs: string[]
  source: 'sample' | 'upload'
  label: string
}

export const LICENSED = 'M365 Copilot Licensed'
export const UNLICENSED = 'Unlicensed'
export const UNKNOWN_ORG = '(No organisation)'
