import type { Row } from '../data/types'
import type { TableRow } from '../ui/DataTable'
import { groupBy } from './core'

export interface PivotRec {
  label: string
  sub?: string
  m: Record<string, number>
}

type Measures = Record<string, (rs: Row[]) => number>

const evalAll = (rs: Row[], ms: Measures) => Object.fromEntries(Object.entries(ms).map(([k, f]) => [k, f(rs)]))

/**
 * Two-level pivot like the PBI matrix visuals (e.g. Organization > PersonId).
 * Children are kept only when `keep` is true, mirroring PBI hiding rows whose measures are blank.
 */
export function pivot(
  rows: Row[],
  outer: (r: Row) => string,
  inner: (r: Row) => string,
  innerLabel: (k: string) => { label: string; sub?: string },
  measures: Measures,
  keep: (rs: Row[]) => boolean,
): TableRow<PivotRec>[] {
  const out: TableRow<PivotRec>[] = []
  for (const [o, ors] of groupBy(rows, outer)) {
    if (!keep(ors)) continue
    const children: TableRow<PivotRec>[] = []
    for (const [i, irs] of groupBy(ors, inner)) {
      if (!keep(irs)) continue
      children.push({ id: `${o}::${i}`, data: { ...innerLabel(i), m: evalAll(irs, measures) } })
    }
    out.push({ id: o, data: { label: o, m: evalAll(ors, measures) }, children })
  }
  return out
}

/** Single-level table grouped by one key. */
export function flat(rows: Row[], key: (r: Row) => string, measures: Measures, keep: (rs: Row[]) => boolean): TableRow<PivotRec>[] {
  return [...groupBy(rows, key)]
    .filter(([, rs]) => keep(rs))
    .map(([k, rs]) => ({ id: k, data: { label: k, m: evalAll(rs, measures) } }))
}
