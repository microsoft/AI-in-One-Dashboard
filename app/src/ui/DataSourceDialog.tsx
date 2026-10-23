import { useState } from 'react'
import { useData } from '../data/store'
import { dateLabel, int } from './format'
import { Sheet } from './Sheet'

const KIND_LABEL: Record<string, string> = {
  interactions: 'Copilot interactions',
  users: 'Users and licences',
  agents: 'Agent 365 inventory',
}

export function DataSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ds, loadFiles, loadSample } = useData()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const pick = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    setMsg(null)
    try {
      const found = await loadFiles([...files])
      const missing = Object.keys(KIND_LABEL).filter((k) => !found.includes(k))
      setMsg({
        ok: true,
        text: `Loaded ${found.map((k) => KIND_LABEL[k]).join(', ')}.${missing.length ? ` Not found: ${missing.map((k) => KIND_LABEL[k]).join(', ')}, so related measures will be blank.` : ''}`,
      })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Data source">
      <div className="source">
        <dl className="kv">
          <dt>Now showing</dt>
          <dd>{ds.source === 'sample' ? 'Synthetic sample data' : ds.label}</dd>
          <dt>Dates</dt>
          <dd>
            {dateLabel(ds.minDate)} to {dateLabel(ds.maxDate)}
          </dd>
          <dt>Interactions</dt>
          <dd>{int(ds.rows.length)}</dd>
          <dt>People</dt>
          <dd>{int(ds.people.size)}</dd>
          <dt>Agents</dt>
          <dd>{int(ds.agents.length)}</dd>
        </dl>
        <h3>Use your own PAX export</h3>
        <p>
          Select the CSV files created by the <a href="https://aka.ms/PAX" target="_blank" rel="noreferrer">PAX tool</a>: the Copilot interactions file, plus the users file and the Agent 365 file if you have them. Files are read in your browser and never uploaded.
        </p>
        <label className="drop">
          <input type="file" accept=".csv,text/csv" multiple disabled={busy} onChange={(e) => void pick(e.target.files)} />
          <span className="btn btn-primary">{busy ? 'Reading files…' : 'Choose CSV files'}</span>
          <small>Files are recognised by their column headers, so names don't matter.</small>
        </label>
        {msg && (
          <p className={msg.ok ? 'notice' : 'notice notice-error'} role={msg.ok ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
        {ds.source !== 'sample' && (
          <button type="button" className="link-btn" onClick={() => void loadSample().then(() => setMsg({ ok: true, text: 'Back to the sample data.' }))}>
            Go back to the sample data
          </button>
        )}
      </div>
    </Sheet>
  )
}
