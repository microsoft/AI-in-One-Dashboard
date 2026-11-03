import { useData } from '../data/store'
import { Sheet } from './Sheet'

export function DataSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { loadSample } = useData()
  return (
    <Sheet open={open} onClose={onClose} title="About this demo">
      <p>Every person, organisation, agent and interaction is invented. Nothing is connected to a tenant, and no data can be uploaded here.</p>
      <p>Navigate the dashboard, change filters and open agent details. All calculations run locally in your browser.</p>
      <button type="button" className="btn" onClick={() => { void loadSample(); onClose() }}>
        Reset sample and filters
      </button>
    </Sheet>
  )
}
