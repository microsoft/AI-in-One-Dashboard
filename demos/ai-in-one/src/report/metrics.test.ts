import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildDataset, parseCsv } from '../data/load'
import layout from './layout.json'
import { formatValue, measure, type Context } from './metrics'

const read = (file: string) => parseCsv(readFileSync(`public/sample/${file}.csv`, 'utf8')).rows
const ds = buildDataset(read('interactions'), read('users'), read('agents'), 'sample', 'Invented data')
const context: Context = { ds, people: [...ds.people.values()], rows: ds.rows, allRows: ds.rows }

describe('Power BI presentation port', () => {
  it('covers every visible measure without invented fallback values', () => {
    const names = new Set(layout.pages.flatMap((p) => p.visuals.flatMap((v) => [
      ...v.fields.filter((f) => f.kind === 'measure').map((f) => f.name), v.textMeasure,
    ])).filter(Boolean))
    const failures: string[] = []
    for (const name of names) {
      try {
        expect(formatValue(measure(name, context)), name).not.toContain('NaN')
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    expect(failures).toEqual([])
    expect(layout.pages).toHaveLength(17)
  })
  it('uses ratio-of-counts for prompts and keeps directory inactivity explicit', () => {
    expect(measure('Card Prompts', context)).toBe(ds.rows.length)
    expect(measure('Card Active Users', context)).toBe(150)
    expect(measure('Display Inactive Licensed Users - Licensed', context)).toBe(6)
    expect(measure('Display Total Copilot Licensed Users', context)).toBe(96)
    expect(measure('Display Prompts per Session - All', context)).toBe(
      new Set(ds.rows.map((r) => r.msg)).size / new Set(ds.rows.map((r) => r.thread)).size,
    )
    expect(() => measure('Unknown metric', context)).toThrow('Unported report measure')
  })
  it('counts zero-activity calendar days in seven-day averages', () => {
    const rows = [
      { ...ds.rows[0], date: '2026-05-04', msg: 'demo-1', thread: 'demo-session-1' },
      { ...ds.rows[0], date: '2026-05-10', msg: 'demo-2', thread: 'demo-session-2' },
    ]
    expect(measure('Prompts 7-day average', { ...context, rows: [rows[1]], allRows: rows, groupName: '2026-05-10' })).toBeCloseTo(2 / 7)
  })
  it('keeps chat-only licensed metrics distinct from agent activity', () => {
    const rows = [
      { ...ds.rows[0], user: '1', lic: 'L' as const, isAgent: true },
      { ...ds.rows[1], user: '2', lic: 'L' as const, isAgent: false, agent: '', agentId: '' },
    ]
    const selected = { ...context, rows, allRows: rows }
    expect(measure('Display NoOfActiveChatUsers (Licensed) - Licensed', selected)).toBe(1)
    expect(measure('Display % Copilot Users Using Agents (Licensed) - Licensed', selected)).toBe(0)
    const overlapping = [...rows, { ...rows[0], user: '2' }]
    expect(measure('Display % Copilot Users Using Agents (Licensed) - Licensed', { ...selected, rows: overlapping })).toBe(1)
    expect(measure('Priority Person Rank', selected)).toBeNull()
  })
})
