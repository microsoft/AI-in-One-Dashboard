import { useCallback } from 'react'
import { useData } from '../data/store'
import type { PivotRec } from '../metrics/pivot'
import type { Column } from '../ui/DataTable'
import type { Fmt } from '../ui/format'
export function labelCol(label: string, width = '34%'): Column<PivotRec> {
  return {
    key: 'label',
    label,
    width,
    value: (r) => r.label,
    render: (r) => (
      <span className="name-cell">
        <span>{r.label}</span>
        {r.sub && <small>{r.sub}</small>}
      </span>
    ),
  }
}

export function measureCol(key: string, label: string, fmt: Fmt, bar?: string, help?: string): Column<PivotRec> {
  return { key, label, value: (r) => r.m[key], fmt, bar, align: 'right', help }
}

export function usePersonLabel() {
  const { ds } = useData()
  return useCallback(
    (user: string) => {
      const p = ds.people.get(user)
      return p ? { label: p.name, sub: p.title || p.id } : { label: `User ${user}` }
    },
    [ds],
  )
}

export const searchText = (r: PivotRec) => `${r.label} ${r.sub ?? ''}`

