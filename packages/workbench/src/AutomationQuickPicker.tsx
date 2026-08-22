import {
  Braces,
  Clock3,
  GitBranch,
  Layers3,
  ListTree,
  Plus,
  Search,
  Shuffle,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkbenchAutomationControlKind,
  WorkbenchAutomationInsertCatalog,
  WorkbenchAutomationInsertItem,
} from './contracts.js'
import type { ConsoleQueryState } from './useConsoleQuery.js'

const controlIcons = {
  wait: Clock3,
  if: GitBranch,
  parallel: Layers3,
  race: Shuffle,
  foreach: ListTree,
} satisfies Record<WorkbenchAutomationControlKind, typeof Clock3>

function searchableText(item: WorkbenchAutomationInsertItem): string {
  if (item.kind === 'control') return `${item.title} ${item.description} ${item.control}`.toLowerCase()
  return [
    item.title,
    item.description,
    item.capability.id,
    item.capability.version,
    item.capabilityKind,
    ...item.connectionSlots,
  ].filter(Boolean).join(' ').toLowerCase()
}

function PickerItem({ item, onInsert }: {
  item: WorkbenchAutomationInsertItem
  onInsert(item: WorkbenchAutomationInsertItem): void
}) {
  const Icon = item.kind === 'control' ? controlIcons[item.control] : Sparkles
  const ref = item.kind === 'capability' ? `${item.capability.id}@${item.capability.version}` : item.control
  return (
    <button className="quick-picker-item" onClick={() => onInsert(item)} role="option" type="button">
      <span className="quick-picker-item-icon" data-kind={item.kind}><Icon size={16} /></span>
      <span className="quick-picker-item-copy">
        <span><strong>{item.title}</strong><em>{item.kind === 'control' ? 'Control' : item.capabilityKind}</em></span>
        <small>{item.description ?? ref}</small>
        <code>{ref}</code>
      </span>
      {item.kind === 'capability' ? (
        <span className="quick-picker-item-meta">
          {!item.providerAvailable ? <em data-tone="warning">Provider unavailable</em> : null}
          {item.connectionSlots.length ? <small>{item.connectionSlots.length} connection {item.connectionSlots.length === 1 ? 'slot' : 'slots'}</small> : null}
        </span>
      ) : null}
    </button>
  )
}

export function AutomationQuickPicker({ state, disabled = false, onInsert, onReload }: {
  state?: ConsoleQueryState<WorkbenchAutomationInsertCatalog>
  disabled?: boolean
  onInsert?(item: WorkbenchAutomationInsertItem): void
  onReload?(): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const live = !!state && state.status !== 'DISABLED'

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const items = state?.status === 'READY' ? state.data.items : []
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? items.filter(item => searchableText(item).includes(normalized)) : items
  }, [items, query])
  const controls = filtered.filter(item => item.kind === 'control')
  const capabilities = filtered.filter(item => item.kind === 'capability')

  const insert = (item: WorkbenchAutomationInsertItem) => {
    onInsert?.(item)
    setOpen(false)
  }

  if (!live) {
    return <button className="add-step-button" disabled={disabled} type="button"><Plus size={15} /> Add step</button>
  }

  return (
    <div className="quick-picker-anchor" onKeyDown={event => {
      if (event.key === 'Escape') setOpen(false)
    }}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="add-step-button"
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        type="button"
      ><Plus size={15} /> Add step</button>
      {open ? (
        <section aria-label="Add automation step" className="quick-picker" role="dialog">
          <header>
            <div><strong>Add step</strong><small>Controls and registered capabilities</small></div>
            <button aria-label="Close step picker" onClick={() => setOpen(false)} type="button"><X size={16} /></button>
          </header>
          <label className="quick-picker-search">
            <Search aria-hidden="true" size={15} />
            <input
              aria-label="Search controls and capabilities"
              onChange={event => setQuery(event.target.value)}
              placeholder="Search controls and capabilities…"
              ref={inputRef}
              value={query}
            />
          </label>
          <div className="quick-picker-results" role="listbox">
            {state.status === 'LOADING' ? <p className="quick-picker-state">Loading insert catalog…</p> : null}
            {state.status === 'ERROR' ? (
              <div className="quick-picker-state" role="alert">
                <Braces size={18} />
                <p>{state.message}</p>
                {onReload ? <button onClick={onReload} type="button">Try again</button> : null}
              </div>
            ) : null}
            {state.status === 'READY' && controls.length ? (
              <section className="quick-picker-group">
                <h3>Controls</h3>
                {controls.map(item => <PickerItem item={item} key={`control:${item.kind === 'control' ? item.control : ''}`} onInsert={insert} />)}
              </section>
            ) : null}
            {state.status === 'READY' && capabilities.length ? (
              <section className="quick-picker-group">
                <h3>Capabilities</h3>
                {capabilities.map(item => (
                  <PickerItem
                    item={item}
                    key={item.kind === 'capability' ? `capability:${item.capability.id}@${item.capability.version}` : ''}
                    onInsert={insert}
                  />
                ))}
              </section>
            ) : null}
            {state.status === 'READY' && !filtered.length ? (
              <p className="quick-picker-state">No controls or capabilities match “{query.trim()}”.</p>
            ) : null}
          </div>
          <footer>Unavailable providers can still be composed in a Draft and resolved before publish.</footer>
        </section>
      ) : null}
    </div>
  )
}
