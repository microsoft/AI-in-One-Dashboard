const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const nf2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export type Fmt = (n: number) => string

const ok = (n: number) => typeof n === 'number' && Number.isFinite(n)
export const DASH = '–'

export const int: Fmt = (n) => (ok(n) ? nf0.format(n) : DASH)
export const dec1: Fmt = (n) => (ok(n) ? nf1.format(n) : DASH)
export const dec2: Fmt = (n) => (ok(n) ? nf2.format(n) : DASH)
export const pct: Fmt = (n) => (ok(n) ? `${nf1.format(n * 100)}%` : DASH)
export const pct0: Fmt = (n) => (ok(n) ? `${nf0.format(n * 100)}%` : DASH)
export const signedPct: Fmt = (n) => (ok(n) ? `${n > 0 ? '+' : n < 0 ? '−' : ''}${nf1.format(Math.abs(n) * 100)}%` : DASH)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const monthLabel = (iso: string) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : DASH)
export const monthShort = (iso: string) => (iso ? MONTHS[Number(iso.slice(5, 7)) - 1] : DASH)
export const dayLabel = (iso: string) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : DASH)
export const dateLabel = (iso: string) => (iso ? `${dayLabel(iso)} ${iso.slice(0, 4)}` : DASH)

/** "Nice" axis maximum and ticks. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toPrecision(10)))
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(10)))
  return ticks
}

export const compact: Fmt = (n) => {
  if (!ok(n)) return DASH
  if (Math.abs(n) >= 1000) return `${nf1.format(n / 1000)}k`
  return Number.isInteger(n) ? nf0.format(n) : nf1.format(n)
}
