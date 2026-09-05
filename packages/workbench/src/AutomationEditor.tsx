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
} from '@lucide/vue'
import type { SetupContext } from 'vue'
import { AutomationQuickPicker } from './AutomationQuickPicker.js'
import type {
  WorkbenchAutomationDetail,
  WorkbenchAutomationIndexItem,
  WorkbenchAutomationInsertCatalog,
  WorkbenchAutomationInsertItem,
} from './contracts.js'
import { automations, automationSteps } from './model.js'
import type { AutomationStep } from './model.js'
import type { AutomationActivationView } from './useAutomationActivation.js'
import type { ConsoleQueryState } from './useConsoleQuery.js'

const tabs = ['Editor', 'Runs', 'Revisions', 'State', 'Settings'] as const

export interface AutomationEditorProps {
  automationId?: string
  automations?: WorkbenchAutomationIndexItem[]
  activeStepId: string
  activeTab: string
  detailState?: ConsoleQueryState<WorkbenchAutomationDetail | null>
  insertCatalogState?: ConsoleQueryState<WorkbenchAutomationInsertCatalog>
  steps?: AutomationStep[]
  authoring?: {
    canEdit: boolean
    canPublish: boolean
    canUndo: boolean
    canRedo: boolean
    publishPending: boolean
    conflict?: { expectedVersion: number; actualVersion: number }
    saveError?: string
    publishError?: string
  }
  activation?: AutomationActivationView
  onActivateRevision?(revisionId: string): void
  onSetEnabled?(enabled: boolean): void
  onStepChange(id: string): void
  onTabChange(tab: string): void
  onOpenInspector(): void
  onAutomationChange?(id: string): void
  onInsert?(item: WorkbenchAutomationInsertItem): void
  onReloadInsertCatalog?(): void
  onUndo?(): void
  onRedo?(): void
  onPublish?(): void
  onReloadDraft?(): void
  onRetrySave?(): void
  onReload?(): void
}

function ToolbarButton({ label, disabled = false, onClick }: {
  label: string
  disabled?: boolean
  onClick?(): void
}, context: SetupContext) {
  return <button aria-label={label} class="toolbar-button" disabled={disabled} {...(onClick ? { onClick } : {})} title={label} type="button">{context.slots.default?.()}</button>
}

export function AutomationEditor({
  automationId,
  automations: liveAutomations,
  activeStepId,
  activeTab,
  detailState,
  insertCatalogState,
  steps: projectedSteps,
  authoring,
  activation,
  onActivateRevision,
  onSetEnabled,
  onStepChange,
  onTabChange,
  onOpenInspector,
  onAutomationChange,
  onInsert,
  onReloadInsertCatalog,
  onUndo,
  onRedo,
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
    <main class="main-workbench">
      <header class="entity-header">
        <div class="entity-title-row">
          <div>
            <span class="breadcrumb">Automations / {automationName}</span>
            <div class="automation-title"><h1>{automationName}</h1>{detail ? (
              <span class="automation-badges">
                <em data-tone={detail.automation.enabled ? 'enabled' : 'disabled'}>{detail.automation.enabled ? 'Enabled' : 'Disabled'}</em>
                <em>Draft v{detail.draft.version}</em>
                <em>{latestRevision ? `Published r${latestRevision.number}` : 'No revisions'}</em>
                <em>{activeRevision ? `Active r${activeRevision.number}` : 'Not active'}</em>
              </span>
            ) : null}</div>
          </div>
          <div class="entity-title-actions">
            {detail && activation && onSetEnabled ? <button
              aria-label={detail.automation.enabled ? 'Disable Automation' : 'Enable Automation'}
              aria-checked={detail.automation.enabled}
              role="switch"
              class="automation-enabled-button"
              disabled={activation.pending || (!detail.automation.enabled && !detail.automation.activeRevisionId)}
              onClick={() => onSetEnabled(!detail.automation.enabled)}
              type="button"
            >{activation.pending && !activation.activatingRevisionId ? 'Updating…' : detail.automation.enabled ? 'Disable' : 'Enable'}</button> : null}
            {authoring && onPublish ? (
              <button
                class="publish-button"
                disabled={!authoring.canPublish}
                onClick={onPublish}
                type="button"
              >{authoring.publishPending ? 'Publishing…' : 'Publish'}</button>
            ) : null}
            <button class="mobile-inspector-button" onClick={onOpenInspector} type="button">Inspector</button>
          </div>
        </div>
        {liveAutomations?.length && automationId && onAutomationChange ? (
          <label class="mobile-automation-switcher">
            <span>Automation</span>
            <select aria-label="Select automation" onChange={event => onAutomationChange((event.target as HTMLInputElement).value)} value={automationId}>
              {liveAutomations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        ) : null}
        <nav class="context-tabs" aria-label="Automation sections">
          {tabs.map(tab => (
            <button
              aria-selected={activeTab === tab}
              class="context-tab"
              data-active={activeTab === tab}
              key={tab}
              onClick={() => onTabChange(tab)}
              role="tab"
              type="button"
            >{tab}</button>
          ))}
        </nav>
      </header>
      {activation?.error ? <section class="authoring-notice" data-tone="error" role="alert"><span>{activation.error}</span></section> : null}
      {authoring?.conflict ? (
        <section class="authoring-notice" data-tone="conflict" role="alert">
          <span><strong>Draft changed elsewhere.</strong> Local version {authoring.conflict.expectedVersion} cannot overwrite server version {authoring.conflict.actualVersion}.</span>
          {onReloadDraft ? <button onClick={onReloadDraft} type="button">Reload server Draft</button> : null}
        </section>
      ) : authoring?.saveError ? (
        <section class="authoring-notice" data-tone="error" role="alert">
          <span><strong>Autosave failed.</strong> {authoring.saveError}</span>
          {onRetrySave ? <button onClick={onRetrySave} type="button">Retry autosave</button> : null}
        </section>
      ) : authoring?.publishError ? (
        <section class="authoring-notice" data-tone="error" role="alert">
          <span><strong>Publish failed.</strong> {authoring.publishError}</span>
        </section>
      ) : null}
      {live && (detailState?.status === 'LOADING' || (detailState?.status === 'READY' && detailState.data && !detail)) ? (
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
        <AutomationState
          title={liveAutomations?.length ? 'Automation not found' : 'No automations yet'}
          message={liveAutomations?.length
            ? 'The selected Automation no longer exists. Choose another item from the Sidebar.'
            : 'Create an Automation to begin shaping a Draft.'}
        />
      ) : activeTab === 'Editor' ? (
        <>
          <div class="editor-toolbar" aria-label="Editor toolbar">
            <div class="toolbar-group">
              <ToolbarButton disabled={authoring ? !authoring.canUndo : false} label="Undo" {...(onUndo ? { onClick: onUndo } : {})}><Undo2 size={16} /></ToolbarButton>
              <ToolbarButton disabled={authoring ? !authoring.canRedo : false} label="Redo" {...(onRedo ? { onClick: onRedo } : {})}><Redo2 size={16} /></ToolbarButton>
            </div>
            <div class="toolbar-group">
              <ToolbarButton label="Cut"><Scissors size={16} /></ToolbarButton>
              <ToolbarButton label="Copy"><Copy size={16} /></ToolbarButton>
              <ToolbarButton label="Delete"><Trash2 size={16} /></ToolbarButton>
            </div>
            <div class="toolbar-group toolbar-spacer">
              <ToolbarButton label="Align steps"><AlignCenter size={16} /></ToolbarButton>
            </div>
            <div class="toolbar-group">
              <ToolbarButton label="Zoom out"><ZoomOut size={16} /></ToolbarButton>
              <ToolbarButton label="Zoom in"><ZoomIn size={16} /></ToolbarButton>
              <ToolbarButton label="Fit to view"><Expand size={16} /></ToolbarButton>
            </div>
            <button class="layout-control" type="button">Layout <span>⌄</span></button>
          </div>
          <section class="automation-canvas" aria-label={`${automationName} automation flow`}>
            <div class="step-flow">
              {steps.map((step, index) => {
                const Icon = step.icon
                const selected = step.id === activeStepId
                return (
                  <div class="step-unit" data-depth={Math.min(step.depth ?? 0, 4)} key={step.id}>
                    <div class="step-index" aria-hidden="true">{index + 1}</div>
                    <button
                      aria-pressed={selected}
                      class="automation-step"
                      data-selected={selected}
                      onClick={() => onStepChange(step.id)}
                      type="button"
                    >
                      <span class="step-icon" data-tone={step.tone}><Icon size={19} strokeWidth={1.7} /></span>
                      <span class="step-copy">
                        <strong>{step.label}</strong>
                        <small>{step.summary}</small>
                      </span>
                      {step.problemCount ? (
                        <span aria-label={`${step.problemCount} ${step.problemCount === 1 ? 'problem' : 'problems'}`} class="step-problem-badge">!</span>
                      ) : null}
                      <MoreVertical aria-hidden="true" class="step-menu" size={18} />
                    </button>
                    {index < steps.length - 1 ? (
                      <div class="step-connector" aria-hidden="true"><span><Plus size={13} /></span></div>
                    ) : null}
                  </div>
                )
              })}
              {!steps.length ? <p class="automation-flow-empty">This Draft has no triggers or flow steps yet.</p> : null}
              <AutomationQuickPicker
                disabled={authoring ? !authoring.canEdit : false}
                {...(insertCatalogState ? { state: insertCatalogState } : {})}
                {...(onInsert ? { onInsert } : {})}
                {...(onReloadInsertCatalog ? { onReload: onReloadInsertCatalog } : {})}
              />
            </div>
          </section>
        </>
      ) : activeTab === 'Revisions' && detail ? (
        <section class="automation-revisions">
          <div class="runs-section-heading"><h2>Immutable revisions</h2><span>Newest first</span></div>
          <p class="activation-help">Activate a published Revision, then enable the Automation to accept Trigger events. Existing Runs keep their original Revision.</p>
          {detail.revisions.length ? (
            <div class="revision-list">
              {detail.revisions.map(revision => (
                <article data-active={revision.active} key={revision.id}>
                  <div><strong>Revision {revision.number}</strong>{revision.active ? <em>Active</em> : null}</div>
                  <small>{revision.contentHash}</small>
                  <time datetime={revision.createdAt}>{revision.createdAt}</time>
                  {activation && onActivateRevision ? <button
                    aria-label={`Activate Revision ${revision.number}`}
                    class="revision-activate-button"
                    disabled={revision.active || activation.pending}
                    onClick={() => onActivateRevision(revision.id)}
                    type="button"
                  >{activation.activatingRevisionId === revision.id ? 'Activating…' : revision.active ? 'Active' : 'Activate'}</button> : null}
                </article>
              ))}
            </div>
          ) : <p class="automation-flow-empty">No immutable Revision has been published from this Draft.</p>}
        </section>
      ) : activeTab === 'State' && detail ? (
        <section class="automation-activation-state">
          <h2>Activation</h2>
          <dl>
            <div><dt>Desired state</dt><dd>{detail.automation.enabled ? 'Enabled' : 'Disabled'}</dd></div>
            <div><dt>Active Revision</dt><dd>{activeRevision ? `Revision ${activeRevision.number}` : 'None'}</dd></div>
          </dl>
          <p>{!activeRevision ? 'Publish and activate a Revision before enabling this Automation.'
            : detail.automation.enabled ? 'Trigger subscriptions follow the active Revision. Event delivery depends on available Providers and Connections.'
              : 'Trigger subscriptions are disabled. Existing Runs continue with their original Revision.'}</p>
          <button class="revision-activate-button" onClick={() => onTabChange('Revisions')} type="button">Manage revisions</button>
        </section>
      ) : (
        <section class="secondary-view">
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
    <section aria-busy={busy} class="automation-state" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <p>{message}</p>
      {action ? <button class="secondary-button" {...(onAction ? { onClick: onAction } : {})} type="button">{action}</button> : null}
    </section>
  )
}
