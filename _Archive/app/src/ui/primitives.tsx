import { useId, useState, type ReactNode } from 'react'

export function InfoTip({ text, label }: { text?: string; label: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!text) return null
  return (
    <span className="info" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="info-btn"
        aria-label={`About ${label}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        i
      </button>
      {open && (
        <span role="tooltip" id={id} className="info-pop">
          {text}
        </span>
      )}
    </span>
  )
}

export function Panel(props: {
  title: string
  note?: string
  help?: string
  actions?: ReactNode
  children: ReactNode
  span?: 1 | 2 | 3
  className?: string
}) {
  return (
    <section className={`panel span-${props.span ?? 1} ${props.className ?? ''}`} aria-label={props.title}>
      <header className="panel-head">
        <div>
          <h3>
            {props.title}
            <InfoTip text={props.help} label={props.title} />
          </h3>
          {props.note && <p className="panel-note">{props.note}</p>}
        </div>
        {props.actions}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  )
}

export interface KpiProps {
  label: string
  value: string
  sub?: ReactNode
  help?: string
  tone?: 'licensed' | 'unlicensed' | 'agent' | 'neutral'
  trend?: number
  wide?: boolean
}

export function Kpi({ label, value, sub, help, tone = 'neutral', trend, wide }: KpiProps) {
  const dir = trend === undefined || !Number.isFinite(trend) ? '' : trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'
  return (
    <div className={`kpi tone-${tone} ${wide ? 'kpi-wide' : ''}`}>
      <div className="kpi-label">
        <span>{label}</span>
        <InfoTip text={help} label={label} />
      </div>
      <div className={`kpi-value ${dir ? `trend-${dir}` : ''} ${value.length > 18 ? 'kpi-value-text' : ''}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

export const KpiRow = ({ children }: { children: ReactNode }) => <div className="kpi-row">{children}</div>
export const Grid = ({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) => (
  <div className={`grid grid-${cols}`}>{children}</div>
)

export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented" role="tablist" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={props.value === o.id}
          className={props.value === o.id ? 'on' : ''}
          onClick={() => props.onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Select(props: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  allLabel?: string
}) {
  const id = useId()
  return (
    <label className={`field ${props.value ? 'field-set' : ''}`} htmlFor={id}>
      <span>{props.label}</span>
      <select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.allLabel !== undefined && <option value="">{props.allLabel}</option>}
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.label}>
          <span className="swatch" style={{ background: i.color }} />
          {i.label}
          {i.value && <b>{i.value}</b>}
        </li>
      ))}
    </ul>
  )
}
