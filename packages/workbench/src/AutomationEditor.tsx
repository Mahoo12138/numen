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
import type { WorkbenchAutomationDetail, WorkbenchAutomationIndexItem } from './contracts.js'
import { automations, automationSteps } from './model.js'
import type { AutomationStep } from './model.js'
import type { AutomationDraftSavePhase } from './useAutomationDraftDocument.js'
import type { ConsoleQueryState } from './useConsoleQuery.js'

const tabs = ['Editor', 'Runs', 'Revisions', 'State', 'Settings'] as const

export interface AutomationEditorProps {
  automationId?: string
  automations?: WorkbenchAutomationIndexItem[]
  activeStepId: string
  activeTab: string
  detailState?: ConsoleQueryState<WorkbenchAutomationDetail | null>
  steps?: AutomationStep[]
  authoring?: {
    savePhase: AutomationDraftSavePhase
    saveMessage: string
    canEdit: boolean
    canPublish: boolean
    publishPending: boolean
    problemCount: number
    conflict?: { expectedVersion: number; actualVersion: number }
    saveError?: string
    publishError?: string
  }
  onStepChange(id: string): void
  onTabChange(tab: string): void
  onOpenInspector(): void
  onAutomationChange?(id: string): void
  onAddWaitStep?(): void
  onPublish?(): void
  onReloadDraft?(): void
  onRetrySave?(): void
  onReload?(): void
}

function ToolbarButton({ label, children }: { label: string; children: React.ReactNode }) {
  return <button aria-label={label} className="toolbar-button" title={label} type="button">{children}</button>
}

export function AutomationEditor({
  automationId,
  automations: liveAutomations,
  activeStepId,
  activeTab,
  detailState,
  steps: projectedSteps,
  authoring,
  onStepChange,
  onTabChange,
  onOpenInspector,
  onAutomationChange,
  onAddWaitStep,
  onPublish,
  onReloadDraft,
  onRetrySave,
  onReload,
}: AutomationEditorProps) {
  const previewAutomation = automations.find(item => item.id === automationId) ?? automations[0]!
  const live = !!detailState && detailState.status !== 'DISABLED'
  const detail = detailState?.status === 'READY'
    && detailState.data?.automation.id === automationId
    ? detailState.data
    : undefined
  const automationName = detail?.automation.name ?? (live ? 'Automation' : previewAutomation.label)
  const steps = detail ? (projectedSteps ?? []) : automationSteps
  const latestRevision = detail?.revisions[0]
  const activeRevision = detail?.revisions.find(item => item.active)
  return (
    <main className="main-workbench">
      <header className="entity-header">
        <div className="entity-title-row">
          <div>
            <span className="breadcrumb">Automations / {automationName}</span>
            <div className="automation-title"><h1>{automationName}</h1>{detail ? (
              <span className="automation-badges">
                <em data-tone={detail.automation.enabled ? 'enabled' : 'disabled'}>{detail.automation.enabled ? 'Enabled' : 'Disabled'}</em>
                <em>Draft v{detail.draft.version}</em>
                <em>{latestRevision ? `Published r${latestRevision.number}` : 'No revisions'}</em>
                <em>{activeRevision ? `Active r${activeRevision.number}` : 'Not active'}</em>
              </span>
            ) : null}</div>
          </div>
          <div className="entity-title-actions">
            {authoring && onPublish ? (
              <button
                className="publish-button"
                disabled={!authoring.canPublish}
                onClick={onPublish}
                type="button"
              >{authoring.publishPending ? 'Publishing…' : 'Publish'}</button>
            ) : null}
            <button className="mobile-inspector-button" onClick={onOpenInspector} type="button">Inspector</button>
          </div>
        </div>
        {liveAutomations?.length && automationId && onAutomationChange ? (
          <label className="mobile-automation-switcher">
            <span>Automation</span>
            <select aria-label="Select automation" onChange={event => onAutomationChange(event.target.value)} value={automationId}>
              {liveAutomations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        ) : null}
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
      {authoring?.conflict ? (
        <section className="authoring-notice" data-tone="conflict" role="alert">
          <span><strong>Draft changed elsewhere.</strong> Local version {authoring.conflict.expectedVersion} cannot overwrite server version {authoring.conflict.actualVersion}.</span>
          {onReloadDraft ? <button onClick={onReloadDraft} type="button">Reload server Draft</button> : null}
        </section>
      ) : authoring?.saveError ? (
        <section className="authoring-notice" data-tone="error" role="alert">
          <span><strong>Autosave failed.</strong> {authoring.saveError}</span>
          {onRetrySave ? <button onClick={onRetrySave} type="button">Retry autosave</button> : null}
        </section>
      ) : authoring?.publishError ? (
        <section className="authoring-notice" data-tone="error" role="alert">
          <span><strong>Publish failed.</strong> {authoring.publishError}</span>
        </section>
      ) : null}
      {live && (!automationId || detailState?.status === 'LOADING' || (detailState?.status === 'READY' && detailState.data && !detail)) ? (
        <AutomationState title="Loading automation" message="Reading the current Draft Source and Revision history…" busy />
      ) : live && detailState?.status === 'ERROR' ? (
        <AutomationState
          title="Automation unavailable"
          message={detailState.message}
          action="Try again"
          {...(onReload ? { onAction: onReload } : {})}
          tone="error"
        />
      ) : live && detailState?.status === 'READY' && !detailState.data ? (
        <AutomationState title="Automation not found" message="The selected Automation no longer exists. Choose another item from the Sidebar." />
      ) : activeTab === 'Editor' ? (
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
          <section className="automation-canvas" aria-label={`${automationName} automation flow`}>
            <div className="step-flow">
              {steps.map((step, index) => {
                const Icon = step.icon
                const selected = step.id === activeStepId
                return (
                  <div className="step-unit" data-depth={Math.min(step.depth ?? 0, 4)} key={step.id}>
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
                    {index < steps.length - 1 ? (
                      <div className="step-connector" aria-hidden="true"><span><Plus size={13} /></span></div>
                    ) : null}
                  </div>
                )
              })}
              {!steps.length ? <p className="automation-flow-empty">This Draft has no triggers or flow steps yet.</p> : null}
              <button
                className="add-step-button"
                disabled={authoring ? !authoring.canEdit : false}
                onClick={onAddWaitStep}
                type="button"
              ><Plus size={15} /> {authoring ? 'Add wait step' : 'Add step'}</button>
            </div>
          </section>
        </>
      ) : activeTab === 'Revisions' && detail ? (
        <section className="automation-revisions">
          <div className="runs-section-heading"><h2>Immutable revisions</h2><span>Newest first</span></div>
          {detail.revisions.length ? (
            <div className="revision-list">
              {detail.revisions.map(revision => (
                <article data-active={revision.active} key={revision.id}>
                  <div><strong>Revision {revision.number}</strong>{revision.active ? <em>Active</em> : null}</div>
                  <small>{revision.contentHash}</small>
                  <time dateTime={revision.createdAt}>{revision.createdAt}</time>
                </article>
              ))}
            </div>
          ) : <p className="automation-flow-empty">No immutable Revision has been published from this Draft.</p>}
        </section>
      ) : (
        <section className="secondary-view">
          <h2>{activeTab}</h2>
          <p>This workspace view is owned by its Page extension.</p>
        </section>
      )}
    </main>
  )
}

function AutomationState({ title, message, busy = false, tone = 'default', action, onAction }: {
  title: string
  message: string
  busy?: boolean
  tone?: 'default' | 'error'
  action?: string
  onAction?(): void
}) {
  return (
    <section aria-busy={busy} className="automation-state" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <p>{message}</p>
      {action ? <button className="secondary-button" onClick={onAction} type="button">{action}</button> : null}
    </section>
  )
}
