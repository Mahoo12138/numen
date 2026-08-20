import type { Dispatch, SetStateAction } from 'react'
import { activities } from './model.js'

export interface ActivityRailProps {
  activeId: string
  onChange: Dispatch<SetStateAction<string>>
}

export function ActivityRail({ activeId, onChange }: ActivityRailProps) {
  return (
    <nav className="activity-rail" aria-label="Primary navigation">
      {activities.map(({ id, label, icon: Icon }) => (
        <button
          aria-current={activeId === id ? 'page' : undefined}
          className="activity-button"
          data-active={activeId === id}
          key={id}
          onClick={() => onChange(id)}
          type="button"
        >
          <Icon aria-hidden="true" size={20} strokeWidth={1.7} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}
