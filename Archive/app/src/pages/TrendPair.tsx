import type { ReactNode } from 'react'
import type { Point, Series } from '../ui/charts'
import { LineChart } from '../ui/charts'
import { Panel } from '../ui/primitives'

/** Two aligned weekly line charts in one panel; replaces the PBI dual-axis combo charts. */
export function TrendPair(props: {
  title: string
  note?: string
  help?: string
  top: { name: string; data: Point[]; series: Series }
  bottom: { name: string; data: Point[]; series: Series }
  xFmt: (k: string) => string
  footer?: ReactNode
}) {
  return (
    <Panel title={props.title} note={props.note} help={props.help}>
      <div className="trend-pair">
        <div>
          <p className="mini-title">{props.top.name}</p>
          <LineChart label={props.top.name} data={props.top.data} series={[props.top.series]} xFmt={props.xFmt} height={150} area />
        </div>
        <div>
          <p className="mini-title">{props.bottom.name}</p>
          <LineChart label={props.bottom.name} data={props.bottom.data} series={[props.bottom.series]} xFmt={props.xFmt} height={150} />
        </div>
      </div>
      {props.footer}
    </Panel>
  )
}
