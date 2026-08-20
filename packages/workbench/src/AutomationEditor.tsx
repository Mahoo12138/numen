import {
  AlignCenter,
  Copy,
  Expand,
  MoreVertical,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { automations, automationSteps } from './model.js'

const tabs = ['Editor', 'Runs', 'Revisions', 'State', 'Settings'] as const

export interface AutomationEditorProps {
  automationId: string
  activeStepId: string
  activeTab: string
  onStepChange(id: string): void
  onTabChange(tab: string): void
  onOpenInspector(): void
}

function ToolbarButton({ label, children }: { label: string; children: React.ReactNode }) {
  return <button aria-label={label} className="toolbar-button" title={label} type="button">{children}</button>
}

export function AutomationEditor({
  automationId,
  activeStepId,
  activeTab,
  onStepChange,
  onTabChange,
  onOpenInspector,
}: AutomationEditorProps) {
  const automation = automations.find(item => item.id === automationId) ?? automations[0]!
  return (
    <main className="main-workbench">
      <header className="entity-header">
        <div className="entity-title-row">
          <div>
            <span className="breadcrumb">Automations / {automation.label}</span>
            <h1>{automation.label}</h1>
          </div>
          <button className="mobile-inspector-button" onClick={onOpenInspector} type="button">Inspector</button>
        </div>
        <nav className="context-tabs" aria-label="Automation sections">
          {tabs.map(tab => (
            <button
              aria-selected={activeTab === tab}
              className="context-tab"
              data-active={activeTab === tab}
              key={tab}
              onClick={() => onTabChange(tab)}
              role="tab"
              type="button"
            >{tab}</button>
          ))}
        </nav>
      </header>
      {activeTab === 'Editor' ? (
        <>
          <div className="editor-toolbar" aria-label="Editor toolbar">
            <div className="toolbar-group">
              <ToolbarButton label="Undo"><Undo2 size={16} /></ToolbarButton>
              <ToolbarButton label="Redo"><Redo2 size={16} /></ToolbarButton>
            </div>
            <div className="toolbar-group">
              <ToolbarButton label="Cut"><Scissors size={16} /></ToolbarButton>
              <ToolbarButton label="Copy"><Copy size={16} /></ToolbarButton>
              <ToolbarButton label="Delete"><Trash2 size={16} /></ToolbarButton>
            </div>
            <div className="toolbar-group toolbar-spacer">
              <ToolbarButton label="Align steps"><AlignCenter size={16} /></ToolbarButton>
            </div>
            <div className="toolbar-group">
              <ToolbarButton label="Zoom out"><ZoomOut size={16} /></ToolbarButton>
              <ToolbarButton label="Zoom in"><ZoomIn size={16} /></ToolbarButton>
              <ToolbarButton label="Fit to view"><Expand size={16} /></ToolbarButton>
            </div>
            <button className="layout-control" type="button">Layout <span>⌄</span></button>
          </div>
          <section className="automation-canvas" aria-label={`${automation.label} automation flow`}>
            <div className="step-flow">
              {automationSteps.map((step, index) => {
                const Icon = step.icon
                const selected = step.id === activeStepId
                return (
                  <div className="step-unit" key={step.id}>
                    <div className="step-index" aria-hidden="true">{index + 1}</div>
                    <button
                      aria-pressed={selected}
                      className="automation-step"
                      data-selected={selected}
                      onClick={() => onStepChange(step.id)}
                      type="button"
                    >
                      <span className="step-icon" data-tone={step.tone}><Icon size={19} strokeWidth={1.7} /></span>
                      <span className="step-copy">
                        <strong>{step.label}</strong>
                        <small>{step.summary}</small>
                      </span>
                      <MoreVertical aria-hidden="true" className="step-menu" size={18} />
                    </button>
                    {index < automationSteps.length - 1 ? (
                      <div className="step-connector" aria-hidden="true"><span><Plus size={13} /></span></div>
                    ) : null}
                  </div>
                )
              })}
              <button className="add-step-button" type="button"><Plus size={15} /> Add step</button>
            </div>
          </section>
        </>
      ) : (
        <section className="secondary-view">
          <h2>{activeTab}</h2>
          <p>This workspace view is owned by its Page extension.</p>
        </section>
      )}
    </main>
  )
}
