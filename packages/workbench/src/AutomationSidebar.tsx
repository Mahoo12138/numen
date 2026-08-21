import { Filter, MoreVertical, Network, Plus } from 'lucide-react'
import type { WorkbenchAutomationsIndex } from './contracts.js'
import { automations } from './model.js'
import type { ConsoleQueryState } from './useConsoleQuery.js'

export interface AutomationSidebarProps {
  activeId?: string
  onChange(id: string): void
  onReload?(): void
  state?: ConsoleQueryState<WorkbenchAutomationsIndex>
}

export function AutomationSidebar({ activeId, onChange, onReload, state }: AutomationSidebarProps) {
  const preview = !state || state.status === 'DISABLED'
  return (
    <aside className="primary-sidebar" aria-label="Automations">
      <div className="sidebar-heading">
        <span>AUTOMATIONS</span>
        <div className="sidebar-actions">
          <button aria-label="Create automation" className="icon-button" type="button"><Plus size={16} /></button>
          <button aria-label="Filter automations" className="icon-button" type="button"><Filter size={15} /></button>
        </div>
      </div>
      <div className="automation-list">
        {preview ? automations.map(({ id, label, icon: Icon }) => (
          <div className="automation-row" data-active={activeId === id} key={id}>
            <button className="automation-select" onClick={() => onChange(id)} type="button">
              <Icon aria-hidden="true" size={17} strokeWidth={1.7} />
              <span>{label}</span>
            </button>
            <button aria-label={`More actions for ${label}`} className="row-menu" type="button">
              <MoreVertical size={16} />
            </button>
          </div>
        )) : null}
        {state?.status === 'LOADING' ? <p className="automation-sidebar-state" role="status">Loading automations…</p> : null}
        {state?.status === 'ERROR' ? (
          <div className="automation-sidebar-state" role="alert">
            <strong>Automations unavailable</strong>
            <span>{state.message}</span>
            <button onClick={onReload} type="button">Try again</button>
          </div>
        ) : null}
        {state?.status === 'READY' && !state.data.items.length ? (
          <p className="automation-sidebar-state">No automations yet.</p>
        ) : null}
        {state?.status === 'READY' ? state.data.items.map(item => (
          <div className="automation-row automation-row-live" data-active={activeId === item.id} key={item.id}>
            <button className="automation-select" onClick={() => onChange(item.id)} type="button">
              <Network aria-hidden="true" size={17} strokeWidth={1.7} />
              <span>
                <strong>{item.name}</strong>
                <small>Draft v{item.draftVersion} · {item.revisionCount} revision{item.revisionCount === 1 ? '' : 's'}</small>
              </span>
            </button>
            <button aria-label={`More actions for ${item.name}`} className="row-menu" type="button">
              <MoreVertical size={16} />
            </button>
          </div>
        )) : null}
      </div>
      <button className="collapse-sidebar" type="button" aria-label="Collapse sidebar">‹‹</button>
    </aside>
  )
}
