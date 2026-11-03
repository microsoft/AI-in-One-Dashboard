import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDataset, parseCsv } from './load'
import { M, prompts, threads, users } from '../metrics/core'

const read = (file: string) => parseCsv(readFileSync(`public/sample/${file}.csv`, 'utf8')).rows
const data = buildDataset(read('interactions'), read('users'), read('agents'), 'sample', 'Invented data')

describe('invented public fixture', () => {
  it('contains only rule-generated identities and complete joins', () => {
    expect(data.people.size).toBe(160)
    expect(data.agents).toHaveLength(16)
    expect(data.rows.length).toBeGreaterThan(30000)
    for (const person of data.people.values()) {
      expect(person.id).toMatch(/^person\d+@example\.invalid$/)
      expect(person.name).toMatch(/^Demo Person \d{3}$/)
    }
    const agents = new Set(data.agents.map((a) => a.titleId))
    for (const row of data.rows) {
      expect(data.people.has(row.user)).toBe(true)
      if (row.isAgent) expect(agents.has(row.agentId)).toBe(true)
    }
  })
  it('keeps cohort metrics reconcilable and filters meaningful', () => {
    expect(M.activeLicensed(data.rows) + M.activeUnlicensed(data.rows)).toBe(users(data.rows))
    expect(prompts(data.rows)).toBe(data.rows.length)
    expect(threads(data.rows)).toBeLessThanOrEqual(prompts(data.rows))
    const parts = data.orgs.map((o) => data.rows.filter((r) => r.org === o))
    expect(parts.reduce((s, rs) => s + prompts(rs), 0)).toBe(prompts(data.rows))
    expect(new Set(parts.map(prompts)).size).toBeGreaterThan(1)
  })
})
