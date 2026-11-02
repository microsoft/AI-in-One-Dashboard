import { useState, type ReactNode } from 'react'
import { useWidth } from './useWidth'
import { compact, dec1, int, niceTicks, type Fmt } from './format'
import { Empty, Legend } from './primitives'

export interface Series {
  name: string
  color: string
  fmt?: Fmt
}
export interface Point {
  key: string
  values: number[]
}

const fin = (n: number) => (Number.isFinite(n) ? n : 0)

function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x + 12, 4), width - 200)
  return (
    <div className="chart-tip" style={{ left, top: Math.max(y - 8, 0) }}>
      {children}
    </div>
  )
}

function YAxis({ ticks, y, w, fmt }: { ticks: number[]; y: (v: number) => number; w: number; fmt: Fmt }) {
  return (
    <g className="axis">
      {ticks.map((t) => (
        <g key={t} transform={`translate(0,${y(t)})`}>
          <line x1={44} x2={w - 8} className="grid-line" />
          <text x={38} dy="0.32em" textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
    </g>
  )
}

/** Line / area chart over an ordered x axis (weeks or months). */
export function LineChart(props: {
  data: Point[]
  series: Series[]
  xFmt: (k: string) => string
  height?: number
  area?: boolean
  label: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const h = props.height ?? 220
  const { data, series } = props
  if (!data.length) return <Empty>No activity in this period.</Empty>
  const max = Math.max(...data.flatMap((d) => d.values.map(fin)))
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1]
  const L = 44
  const R = 12
  const T = 10
  const B = 26
  const x = (i: number) => (data.length === 1 ? (L + width - R) / 2 : L + (i * (width - L - R)) / (data.length - 1))
  const y = (v: number) => T + (1 - fin(v) / top) * (h - T - B)
  const every = Math.ceil(data.length / Math.max(2, Math.floor(width / 80)))
  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={h} role="img" aria-label={props.label}>
        <YAxis ticks={ticks} y={y} w={width} fmt={compact} />
        {series.map((s, si) => {
          const pts = data.map((d, i) => `${x(i)},${y(d.values[si])}`)
          return (
            <g key={s.name}>
              {props.area && (
                <path
                  d={`M${x(0)},${y(0)} L${pts.join(' L')} L${x(data.length - 1)},${y(0)} Z`}
                  fill={s.color}
                  opacity={0.12}
                />
              )}
              <polyline points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth={2.25} strokeLinejoin="round" />
              {data.map((d, i) => (
                <circle key={d.key} cx={x(i)} cy={y(d.values[si])} r={hover === i ? 4.5 : 2.5} fill={s.color} />
              ))}
            </g>
          )
        })}
        <g className="axis">
          {data.map((d, i) =>
            i % every === 0 ? (
              <text key={d.key} x={x(i)} y={h - 8} textAnchor="middle">
                {props.xFmt(d.key)}
              </text>
            ) : null,
          )}
        </g>
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={h - B} className="guide" />}
        <rect
          x={L}
          y={0}
          width={width - L - R}
          height={h - B}
          fill="transparent"
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGRectElement).getBoundingClientRect()
            const i = Math.round(((e.clientX - r.left) / r.width) * (data.length - 1))
            setHover(Math.max(0, Math.min(data.length - 1, i)))
          }}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <Tip x={x(hover)} y={20} width={width}>
          <strong>{props.xFmt(data[hover].key)}</strong>
          {series.map((s, si) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}: <b>{(s.fmt ?? dec1)(data[hover].values[si])}</b>
            </span>
          ))}
        </Tip>
      )}
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.name, color: s.color }))} />}
    </div>
  )
}

/** Vertical columns per period, stacked or clustered. */
export function ColumnChart(props: {
  data: Point[]
  series: Series[]
  xFmt: (k: string) => string
  stacked?: boolean
  height?: number
  label: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const h = props.height ?? 240
  const { data, series, stacked } = props
  if (!data.length) return <Empty>No activity in this period.</Empty>
  const max = Math.max(...data.map((d) => (stacked ? d.values.reduce((a, b) => a + fin(b), 0) : Math.max(...d.values.map(fin)))))
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1]
  const L = 44
  const R = 8
  const T = 10
  const B = 26
  const band = (width - L - R) / data.length
  const gw = Math.min(band * 0.72, stacked ? 56 : 18 * series.length)
  const y = (v: number) => T + (1 - v / top) * (h - T - B)
  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={h} role="img" aria-label={props.label}>
        <YAxis ticks={ticks} y={y} w={width} fmt={compact} />
        {data.map((d, i) => {
          const x0 = L + i * band + (band - gw) / 2
          let acc = 0
          return (
            <g key={d.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={L + i * band} y={T} width={band} height={h - T - B} className={hover === i ? 'col-hover on' : 'col-hover'} />
              {d.values.map((v, si) => {
                const val = fin(v)
                if (stacked) {
                  const yTop = y(acc + val)
                  const r = <rect key={si} x={x0} y={yTop} width={gw} height={Math.max(0, y(acc) - yTop)} fill={series[si].color} />
                  acc += val
                  return r
                }
                const bw = gw / series.length
                return <rect key={si} x={x0 + si * bw} y={y(val)} width={Math.max(1, bw - 2)} height={y(0) - y(val)} fill={series[si].color} rx={2} />
              })}
              <text x={L + i * band + band / 2} y={h - 8} textAnchor="middle" className="axis-text">
                {props.xFmt(d.key)}
              </text>
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <Tip x={L + hover * band + band / 2} y={20} width={width}>
          <strong>{props.xFmt(data[hover].key)}</strong>
          {series.map((s, si) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}: <b>{(s.fmt ?? int)(data[hover].values[si])}</b>
            </span>
          ))}
        </Tip>
      )}
      <Legend items={series.map((s) => ({ label: s.name, color: s.color }))} />
    </div>
  )
}

export interface BarItem {
  key: string
  label: string
  value: number
  hint?: string
  color?: string
}

/** Ranked horizontal bars. Replaces the PBI treemaps and single-measure org column charts. */
export function BarList(props: {
  items: BarItem[]
  color: string
  fmt?: Fmt
  limit?: number
  onSelect?: (key: string) => void
  selected?: string
  label: string
  keepOrder?: boolean
}) {
  const [all, setAll] = useState(false)
  const fmt = props.fmt ?? int
  const valid = props.items.filter((i) => Number.isFinite(i.value))
  const items = props.keepOrder ? valid : [...valid].sort((a, b) => b.value - a.value)
  if (!items.length) return <Empty>Nothing to show for these filters.</Empty>
  const limit = props.limit ?? 8
  const shown = all ? items : items.slice(0, limit)
  const max = Math.max(...items.map((i) => i.value)) || 1
  return (
    <div className="barlist" aria-label={props.label}>
      <ol>
        {shown.map((i) => {
          const inner = (
            <>
              <span className="bl-label" title={i.label}>
                {i.label}
                {i.hint && <small>{i.hint}</small>}
              </span>
              <span className="bl-track">
                <span className="bl-bar" style={{ width: `${(i.value / max) * 100}%`, background: i.color ?? props.color }} />
              </span>
              <span className="bl-value">{fmt(i.value)}</span>
            </>
          )
          return (
            <li key={i.key} className={props.selected === i.key ? 'sel' : ''}>
              {props.onSelect ? (
                <button type="button" onClick={() => props.onSelect!(i.key)} aria-pressed={props.selected === i.key}>
                  {inner}
                </button>
              ) : (
                <div>{inner}</div>
              )}
            </li>
          )
        })}
      </ol>
      {items.length > limit && (
        <button type="button" className="link-btn" onClick={() => setAll((a) => !a)}>
          {all ? 'Show top ' + limit : `Show all ${items.length}`}
        </button>
      )}
    </div>
  )
}

/** Horizontal grouped bars: one row per category with a bar per series. */
export function GroupedBars(props: { data: { key: string; values: number[] }[]; series: Series[]; label: string }) {
  if (!props.data.length) return <Empty>Nothing to show for these filters.</Empty>
  const max = Math.max(...props.data.flatMap((d) => d.values.map(fin))) || 1
  return (
    <div className="grouped" aria-label={props.label}>
      <ol>
        {props.data.map((d) => (
          <li key={d.key}>
            <span className="gb-label" title={d.key}>
              {d.key}
            </span>
            <span className="gb-bars">
              {d.values.map((v, si) => (
                <span key={si} className="gb-row">
                  <span className="gb-bar" style={{ width: `${(fin(v) / max) * 100}%`, background: props.series[si].color }} />
                  <span className="gb-val">{(props.series[si].fmt ?? int)(v)}</span>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
      <Legend items={props.series.map((s) => ({ label: s.name, color: s.color }))} />
    </div>
  )
}

export interface ScatterPoint {
  key: string
  label: string
  x: number
  y: number
  size: number
}

/** Bubble scatter. Optional median cross-hair splits the plot into quadrants. */
export function Scatter(props: {
  points: ScatterPoint[]
  color: string
  xLabel: string
  yLabel: string
  sizeLabel: string
  xFmt?: Fmt
  yFmt?: Fmt
  quadrants?: { x: number; y: number; label: string }
  height?: number
  label: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<string | null>(null)
  const pts = props.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  if (!pts.length) return <Empty>Nothing to plot for these filters.</Empty>
  const h = props.height ?? 260
  const L = 44
  const R = 16
  const T = 14
  const B = 40
  const xt = niceTicks(Math.max(...pts.map((p) => p.x)))
  const yt = niceTicks(Math.max(...pts.map((p) => p.y)))
  const xMax = xt[xt.length - 1]
  const yMax = yt[yt.length - 1]
  const sx = (v: number) => L + (v / xMax) * (width - L - R)
  const sy = (v: number) => T + (1 - v / yMax) * (h - T - B)
  const sMax = Math.max(...pts.map((p) => p.size)) || 1
  const r = (s: number) => 4 + Math.sqrt(s / sMax) * 14
  const xFmt = props.xFmt ?? dec1
  const yFmt = props.yFmt ?? dec1
  const hp = pts.find((p) => p.key === hover)
  // Label the biggest bubbles first and skip any label that would collide with one already placed.
  const labelled = new Set<string>()
  const boxes: { x1: number; x2: number; y1: number; y2: number }[] = []
  for (const p of [...pts].sort((a, b) => b.size - a.size)) {
    if (labelled.size >= 6) break
    const half = (p.label.length * 6.2) / 2 + 3
    const cy = sy(p.y) - r(p.size) - 8
    const box = { x1: sx(p.x) - half, x2: sx(p.x) + half, y1: cy - 8, y2: cy + 6 }
    if (box.x1 < 0 || box.x2 > width) continue
    if (boxes.some((b) => b.x1 < box.x2 && box.x1 < b.x2 && b.y1 < box.y2 && box.y1 < b.y2)) continue
    boxes.push(box)
    labelled.add(p.key)
  }
  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={h} role="img" aria-label={props.label}>
        <YAxis ticks={yt} y={sy} w={width} fmt={compact} />
        <g className="axis">
          {xt.map((t) => (
            <text key={t} x={sx(t)} y={h - 22} textAnchor="middle">
              {compact(t)}
            </text>
          ))}
          <text x={(L + width - R) / 2} y={h - 4} textAnchor="middle" className="axis-title">
            {props.xLabel}
          </text>
        </g>
        {props.quadrants && (
          <g className="quadrant">
            <rect
              x={sx(props.quadrants.x)}
              y={T}
              width={Math.max(0, width - R - sx(props.quadrants.x))}
              height={Math.max(0, sy(props.quadrants.y) - T)}
            />
            <line x1={sx(props.quadrants.x)} x2={sx(props.quadrants.x)} y1={T} y2={h - B} />
            <line x1={L} x2={width - R} y1={sy(props.quadrants.y)} y2={sy(props.quadrants.y)} />
            <text x={width - R - 6} y={T + 14} textAnchor="end">
              {props.quadrants.label}
            </text>
          </g>
        )}
        {pts.map((p) => (
          <g key={p.key} onMouseEnter={() => setHover(p.key)} onMouseLeave={() => setHover(null)}>
            <circle
              cx={sx(p.x)}
              cy={sy(p.y)}
              r={r(p.size)}
              fill={props.color}
              fillOpacity={hover === p.key ? 0.85 : 0.5}
              stroke={props.color}
              strokeWidth={1.25}
            />
            {labelled.has(p.key) && (
              <text x={sx(p.x)} y={sy(p.y) - r(p.size) - 4} textAnchor="middle" className="point-label">
                {p.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      <p className="axis-y-title">{props.yLabel}</p>
      {hp && (
        <Tip x={sx(hp.x)} y={sy(hp.y)} width={width}>
          <strong>{hp.label}</strong>
          <span>
            {props.xLabel}: <b>{xFmt(hp.x)}</b>
          </span>
          <span>
            {props.yLabel}: <b>{yFmt(hp.y)}</b>
          </span>
          <span>
            {props.sizeLabel}: <b>{int(hp.size)}</b>
          </span>
        </Tip>
      )}
    </div>
  )
}

/** 100% bar with a value legend. Replaces the PBI donuts. */
export function Distribution(props: { items: { label: string; value: number; color: string }[]; fmt?: Fmt; label: string }) {
  const total = props.items.reduce((a, b) => a + fin(b.value), 0)
  if (!total) return <Empty>No users in this period.</Empty>
  const fmt = props.fmt ?? int
  return (
    <div className="dist" aria-label={props.label}>
      <div className="dist-bar" role="img" aria-label={props.items.map((i) => `${i.label} ${Math.round((fin(i.value) / total) * 100)}%`).join(', ')}>
        {props.items.map((i) =>
          fin(i.value) > 0 ? (
            <span key={i.label} style={{ flexGrow: fin(i.value), background: i.color }} title={`${i.label}: ${fmt(i.value)}`} />
          ) : null,
        )}
      </div>
      <ul className="dist-legend">
        {props.items.map((i) => (
          <li key={i.label}>
            <span className="swatch" style={{ background: i.color }} />
            <span className="dl-label">{i.label}</span>
            <span className="dl-val">{fmt(i.value)}</span>
            <span className="dl-pct">{Math.round((fin(i.value) / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
