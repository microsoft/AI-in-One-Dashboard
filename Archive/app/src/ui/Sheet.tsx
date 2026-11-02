import { useEffect, useRef, type ReactNode } from 'react'

/** Native <dialog> as a modal or side sheet: focus trap, Escape and backdrop click come from the platform. */
export function Sheet(props: { open: boolean; onClose: () => void; title: string; side?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (props.open && !d.open) d.showModal()
    if (!props.open && d.open) d.close()
  }, [props.open])
  return (
    <dialog
      ref={ref}
      className={props.side ? 'sheet sheet-side' : 'sheet'}
      aria-labelledby="sheet-title"
      onClose={props.onClose}
      onClick={(e) => e.target === ref.current && props.onClose()}
    >
      <div className="sheet-inner">
        <header className="sheet-head">
          <h2 id="sheet-title">{props.title}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  )
}
