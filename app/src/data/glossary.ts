import raw from './glossary.json'

export interface GlossaryEntry {
  page: string
  metric: string
  description: string
  pageOrder: number
  metricOrder: number
}

/** Glossary rows from the PBI, minus pages the PBI edition doesn't ship. */
export const GLOSSARY: GlossaryEntry[] = (raw as GlossaryEntry[]).filter((g) => !g.page.startsWith('Frontier'))

/** Looks up a metric description, preferring a match on the given PBI page. */
export function gloss(metric: string, page?: string): string | undefined {
  const m = metric.toLowerCase()
  const hits = GLOSSARY.filter((g) => g.metric.toLowerCase() === m)
  return (page ? hits.find((g) => g.page.toLowerCase().includes(page.toLowerCase())) : undefined)?.description ?? hits[0]?.description
}
