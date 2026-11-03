export interface Field {
  entity?: string
  kind: string
  name: string
  label: string
  format: string
}

export interface Visual {
  bold: boolean
  id: string
  type: string
  position: { x: number; y: number; width: number; height: number; z: number }
  title: string
  text: string
  textMeasure: string
  roles: Record<string, Field[] | undefined>
  fontSize: number
  color: string
  background: string
  border: boolean
  palette: string[]
  fields: Field[]
}

export interface ReportPage {
  id: string
  name: string
  width: number
  height: number
  visuals: Visual[]
}
