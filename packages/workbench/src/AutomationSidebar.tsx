import { Filter, MoreVertical, Plus } from 'lucide-react'
import { automations } from './model.js'

export interface AutomationSidebarProps {
  activeId: string
  onChange(id: string): void
}

export function AutomationSidebar({ activeId, onChange }: AutomationSidebarProps) {
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
        {automations.map(({ id, label, icon: Icon }) => (
          <div className="automation-row" data-active={activeId === id} key={id}>
            <button className="automation-select" onClick={() => onChange(id)} type="button">
              <Icon aria-hidden="true" size={17} strokeWidth={1.7} />
              <span>{label}</span>
            </button>
            <button aria-label={`More actions for ${label}`} className="row-menu" type="button">
              <MoreVertical size={16} />
            </button>
          </div>
        ))}
      </div>
      <button className="collapse-sidebar" type="button" aria-label="Collapse sidebar">‹‹</button>
    </aside>
  )
}
