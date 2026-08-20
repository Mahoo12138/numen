import { CircleHelp, Clock3, Command, Play, Plus, Save, Search, Settings } from 'lucide-react'
import { useState } from 'react'
import { ActivityRail } from './ActivityRail.js'
import { AutomationEditor } from './AutomationEditor.js'
import { AutomationSidebar } from './AutomationSidebar.js'
import { Inspector } from './Inspector.js'
import './styles.css'

const panelTabs = ['Problems', 'Preview', 'Logs'] as const

export function WorkbenchShell() {
  const [activityId, setActivityId] = useState('automations')
  const [automationId, setAutomationId] = useState('morning-brief')
  const [activeTab, setActiveTab] = useState('Editor')
  const [stepId, setStepId] = useState('notification')
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState('Problems')
  const [inspectorOpen, setInspectorOpen] = useState(() => (
    typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(min-width: 1280px)').matches
      : true
  ))

  return (
    <div className="workbench-shell" data-inspector-open={activityId === 'automations' && inspectorOpen}>
      <header className="top-bar">
        <div className="brand"><span className="brand-mark">N</span><strong>Numen Workbench</strong></div>
        <label className="command-center">
          <Search aria-hidden="true" size={17} />
          <input aria-label="Command center" placeholder="Command center" />
          <kbd>⌘K</kbd>
        </label>
        <div className="top-actions">
          <button aria-label="Run automation" className="icon-button" type="button"><Play size={17} /></button>
          <button aria-label="Recent activity" className="icon-button" type="button"><Clock3 size={17} /></button>
          <button aria-label="Create" className="icon-button" type="button"><Plus size={18} /></button>
          <span className="top-divider" />
          <button aria-label="Settings" className="icon-button" type="button"><Settings size={17} /></button>
          <button aria-label="Help" className="icon-button" type="button"><CircleHelp size={17} /></button>
        </div>
      </header>
      <ActivityRail activeId={activityId} onChange={setActivityId} />
      {activityId === 'automations' ? (
        <AutomationSidebar activeId={automationId} onChange={setAutomationId} />
      ) : (
        <aside className="primary-sidebar simple-sidebar">
          <div className="sidebar-heading">{activityId.toUpperCase()}</div>
          <p>Select a {activityId.slice(0, -1) || activityId} to open its workspace.</p>
        </aside>
      )}
      {activityId === 'automations' ? (
        <AutomationEditor
          automationId={automationId}
          activeStepId={stepId}
          activeTab={activeTab}
          onOpenInspector={() => setInspectorOpen(true)}
          onStepChange={(id) => { setStepId(id); setInspectorOpen(true) }}
          onTabChange={setActiveTab}
        />
      ) : (
        <main className="main-workbench secondary-view activity-placeholder">
          <Command size={24} />
          <h1>{activityId[0]!.toUpperCase() + activityId.slice(1)}</h1>
          <p>This activity is ready for its core Page entry.</p>
        </main>
      )}
      <Inspector activeStepId={stepId} open={activityId === 'automations' && inspectorOpen} onClose={() => setInspectorOpen(false)} />
      <section className="bottom-panel" data-open={panelOpen} aria-label="Bottom panel">
        <div className="panel-tablist" role="tablist">
          {panelTabs.map(tab => (
            <button
              aria-selected={panelTab === tab}
              data-active={panelTab === tab}
              key={tab}
              onClick={() => { setPanelTab(tab); setPanelOpen(true) }}
              role="tab"
              type="button"
            >{tab}{tab === 'Problems' ? <span className="problem-count">1</span> : null}</button>
          ))}
          <button
            aria-label={panelOpen ? 'Collapse bottom panel' : 'Expand bottom panel'}
            className="panel-toggle"
            onClick={() => setPanelOpen(value => !value)}
            type="button"
          >⌃</button>
        </div>
        {panelOpen ? <div className="panel-content">{panelTab} output will appear here.</div> : null}
      </section>
      <footer className="status-bar">
        <span className="ready-status"><span className="status-check">✓</span>Ready</span>
        <span><Save size={14} />Saved</span>
      </footer>
      <button
        aria-label="Close inspector overlay"
        className="inspector-backdrop"
        data-open={inspectorOpen}
        onClick={() => setInspectorOpen(false)}
        type="button"
      />
    </div>
  )
}
