import { diagnosticText, t } from './i18n.js'
import { automationStepEditOptions } from './automation-source-editing.js'
import {
  AlignCenter,
  Copy,
  Expand,
  ChevronDown,
  PanelRight,
  ArrowUp,
  ArrowDown,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue'
import type { SetupContext, VNodeChild } from 'vue'
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
  inputSettings?: VNodeChild
  manualRunForm?: VNodeChild
  conflictRecovery?: VNodeChild
  activation?: AutomationActivationView
  inspectorOpen?: boolean
  onActivateRevision?(revisionId: string): void
  onSetEnabled?(enabled: boolean): void
  onStepChange(id: string): void
  onTabChange(tab: string): void
  onOpenInspector(): void
  onAutomationChange?(id: string): void
  onDeleteStep?(nodeId: string): void
  onMoveStep?(nodeId: string, direction: 'up' | 'down'): void
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
  inspectorOpen,
  conflictRecovery,
  inputSettings,
  manualRunForm,
  onActivateRevision,
  onSetEnabled,
  onStepChange,
  onTabChange,
  onOpenInspector,
  onAutomationChange,
  onInsert,
  onDeleteStep,
  onMoveStep,
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
  const archived = !!detail?.automation.archivedAt
  const steps = detail ? (projectedSteps ?? []) : automationSteps
  const selectedNodeId = steps.find(step => step.id === activeStepId)?.sourceId
  const editOptions = detail ? automationStepEditOptions(detail.draft.source, selectedNodeId) : undefined
  const canEdit = !!authoring?.canEdit
  const latestRevision = detail?.revisions[0]
  const activeRevision = detail?.revisions.find(item => item.active)
  return (
    <main class="main-workbench">
      <header class="entity-header">
        <div class="entity-title-row">
          <div>
            <span class="breadcrumb">{t('workbench.automations')}{automationName}</span>
            <div class="automation-title"><h1>{automationName}</h1>{detail ? (
              <span class="automation-badges">
                {archived ? <em data-tone="archived">{t('workbench.archived')}</em> : null}
                <em data-tone={detail.automation.enabled ? 'enabled' : 'disabled'}>{detail.automation.enabled ? t('workbench.enabled') : t('workbench.disabled')}</em>
                <em>{t('workbench.draftV')}{detail.draft.version}</em>
                <em>{latestRevision ? t('workbench.publishedRValue0', { value0: latestRevision.number }) : t('workbench.noRevisions')}</em>
                <em>{activeRevision ? t('workbench.activeRValue0', { value0: activeRevision.number }) : t('workbench.notActive')}</em>
              </span>
            ) : null}</div>
          </div>
          <div class="entity-title-actions">
            {detail && activation && onSetEnabled ? <button
              aria-label={detail.automation.enabled ? t('workbench.disableAutomation') : t('workbench.enableAutomation')}
              aria-checked={detail.automation.enabled}
              role="switch"
              class="automation-enabled-button"
              disabled={activation.pending || (!detail.automation.enabled && !detail.automation.activeRevisionId)}
              onClick={() => onSetEnabled(!detail.automation.enabled)}
              type="button"
            >{activation.pending && !activation.activatingRevisionId ? t('workbench.updating') : detail.automation.enabled ? t('workbench.disable') : t('workbench.enable')}</button> : null}
            {authoring && onPublish ? (
              <button
                class="publish-button"
                disabled={!authoring.canPublish}
                onClick={onPublish}
                type="button"
              >{authoring.publishPending ? t('workbench.publishing') : t('workbench.publish')}</button>
            ) : null}
            <button
              aria-expanded={inspectorOpen ?? false}
              aria-label={inspectorOpen ? t('workbench.closeInspector') : t('workbench.openInspector')}
              class="mobile-inspector-button"
              data-active={inspectorOpen ?? false}
              onClick={onOpenInspector}
              type="button"
            ><PanelRight aria-hidden="true" size={14} /><span>{t('workbench.inspector')}</span></button>
          </div>
        </div>
        {liveAutomations?.length && automationId && onAutomationChange ? (
          <label class="mobile-automation-switcher">
            <span>{t('workbench.automation')}</span>
            <select aria-label={t('workbench.selectAutomation')} onChange={event => onAutomationChange((event.target as HTMLInputElement).value)} value={automationId}>
              {liveAutomations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        ) : null}
        <nav class="context-tabs" aria-label={t('workbench.automationSections')}>
          {tabs.map(tab => (
            <button
              aria-selected={activeTab === tab}
              class="context-tab"
              data-active={activeTab === tab}
              key={tab}
              onClick={() => onTabChange(tab)}
              role="tab"
              type="button"
            >{t(`workbench.tabs.${tab}`)}</button>
          ))}
        </nav>
      </header>
      {activation?.error ? <section class="authoring-notice" data-tone="error" role="alert"><span>{activation.error}</span></section> : null}
      {archived ? <section class="authoring-notice" data-tone="conflict" role="status"><span>{t('workbench.archivedAutomationReadOnly')}</span></section> : null}
      {authoring?.conflict ? (conflictRecovery ??
        <section class="authoring-notice" data-tone="conflict" role="alert">
          <span><strong>{t('workbench.draftChangedElsewhere')}</strong>{t('workbench.localVersion')}{authoring.conflict.expectedVersion}{t('workbench.cannotOverwriteServerVersion')}{authoring.conflict.actualVersion}.</span>
          {onReloadDraft ? <button onClick={onReloadDraft} type="button">{t('workbench.reloadServerDraft')}</button> : null}
        </section>
      ) : authoring?.saveError ? (
        <section class="authoring-notice" data-tone="error" role="alert">
          <span><strong>{t('workbench.autosaveFailed')}</strong> {authoring.saveError}</span>
          {onRetrySave ? <button onClick={onRetrySave} type="button">{t('workbench.retryAutosave')}</button> : null}
        </section>
      ) : authoring?.publishError ? (
        <section class="authoring-notice" data-tone="error" role="alert">
          <span><strong>{t('workbench.publishFailed')}</strong> {authoring.publishError}</span>
        </section>
      ) : null}
      {live && (detailState?.status === 'LOADING' || (detailState?.status === 'READY' && detailState.data && !detail)) ? (
        <AutomationState title={t('workbench.loadingAutomation')} message={t('workbench.readingTheCurrentDraftSourceAndRevisionHistory')} busy />
      ) : live && detailState?.status === 'ERROR' ? (
        <AutomationState
          title={t('workbench.automationUnavailable')}
          message={diagnosticText(detailState)}
          action={t('workbench.tryAgain')}
          {...(onReload ? { onAction: onReload } : {})}
          tone="error"
        />
      ) : live && detailState?.status === 'READY' && !detailState.data ? (
        <AutomationState
          title={liveAutomations?.length ? t('workbench.automationNotFound') : t('workbench.noAutomationsYet')}
          message={liveAutomations?.length
            ? t('workbench.theSelectedAutomationNoLongerExistsChooseAnotherItemFromTheSidebar')
            : t('workbench.createAnAutomationToBeginShapingADraft')}
        />
      ) : activeTab === 'Editor' ? (
        <>
          <div class="editor-toolbar" aria-label={t('workbench.editorToolbar')}>
            <div class="toolbar-group">
              <ToolbarButton disabled={authoring ? !authoring.canUndo : false} label={t('workbench.undo')} {...(onUndo ? { onClick: onUndo } : {})}><Undo2 size={16} /></ToolbarButton>
              <ToolbarButton disabled={authoring ? !authoring.canRedo : false} label={t('workbench.redo')} {...(onRedo ? { onClick: onRedo } : {})}><Redo2 size={16} /></ToolbarButton>
            </div>
            <div class="toolbar-group">
              <ToolbarButton disabled label={t('workbench.cut')}><Scissors size={16} /></ToolbarButton>
              <ToolbarButton disabled label={t('workbench.copy')}><Copy size={16} /></ToolbarButton>
              <ToolbarButton disabled={!canEdit || !editOptions?.canDelete || !onDeleteStep} label={t('workbench.delete')} onClick={() => selectedNodeId && onDeleteStep?.(selectedNodeId)}><Trash2 size={16} /></ToolbarButton>
              <ToolbarButton disabled={!canEdit || !editOptions?.canMoveUp || !onMoveStep} label={t('workbench.moveUp')} onClick={() => selectedNodeId && onMoveStep?.(selectedNodeId, 'up')}><ArrowUp size={16} /></ToolbarButton>
              <ToolbarButton disabled={!canEdit || !editOptions?.canMoveDown || !onMoveStep} label={t('workbench.moveDown')} onClick={() => selectedNodeId && onMoveStep?.(selectedNodeId, 'down')}><ArrowDown size={16} /></ToolbarButton>
            </div>
            <div class="toolbar-group toolbar-spacer">
              <ToolbarButton label={t('workbench.alignSteps')}><AlignCenter size={16} /></ToolbarButton>
            </div>
            <div class="toolbar-group">
              <ToolbarButton label={t('workbench.zoomOut')}><ZoomOut size={16} /></ToolbarButton>
              <ToolbarButton label={t('workbench.zoomIn')}><ZoomIn size={16} /></ToolbarButton>
              <ToolbarButton label={t('workbench.fitToView')}><Expand size={16} /></ToolbarButton>
            </div>
            <button class="layout-control" type="button">{t('workbench.layout')}<span>⌄</span></button>
          </div>
          <section class="automation-canvas" aria-label={t('workbench.value0AutomationFlow', { value0: automationName })}>
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
                        <span aria-label={t('workbench.problemsCount', { count: step.problemCount })} class="step-problem-badge">!</span>
                      ) : null}
                      <ChevronDown aria-hidden="true" class="step-menu" size={18} />
                    </button>
                    {selected && detail && step.sourceId ? <div class="step-edit-actions" role="group" aria-label={t('workbench.actionsForValue0', { value0: step.label })}>
                      <button disabled={!canEdit || !editOptions?.canMoveUp || !onMoveStep} aria-label={t('workbench.moveValue0Up', { value0: step.label })} onClick={() => onMoveStep?.(step.sourceId!, 'up')} type="button"><ArrowUp size={14} />{t('workbench.moveUp2')}</button>
                      <button disabled={!canEdit || !editOptions?.canMoveDown || !onMoveStep} aria-label={t('workbench.moveValue0Down', { value0: step.label })} onClick={() => onMoveStep?.(step.sourceId!, 'down')} type="button"><ArrowDown size={14} />{t('workbench.moveDown2')}</button>
                      <button disabled={!canEdit || !editOptions?.canDelete || !onDeleteStep} aria-label={t('workbench.deleteValue0', { value0: step.label })} title={t('workbench.deleteThisStepAndItsContentsUndoRestoresIt')} onClick={() => onDeleteStep?.(step.sourceId!)} type="button"><Trash2 size={14} />{t('workbench.delete2')}</button>
                      <p>{editOptions?.canDelete ? t('workbench.moveWithinThisSequenceDeleteIncludesNestedStepsReferencesAreKeptAsWritten') : t('workbench.thisContainerOrTriggerCannotBeRemovedAsASequenceStep')}</p>
                    </div> : null}
                    {index < steps.length - 1 ? (
                      <div class="step-connector" aria-hidden="true"><span><Plus size={13} /></span></div>
                    ) : null}
                  </div>
                )
              })}
              {!steps.length ? <p class="automation-flow-empty">{t('workbench.thisDraftHasNoTriggersOrFlowStepsYet')}</p> : null}
              <AutomationQuickPicker
                disabled={authoring ? !authoring.canEdit : false}
                {...(insertCatalogState ? { state: insertCatalogState } : {})}
                {...(onInsert ? { onInsert } : {})}
                {...(onReloadInsertCatalog ? { onReload: onReloadInsertCatalog } : {})}
              />
            </div>
          </section>
        </>
      ) : activeTab === 'Settings' && inputSettings ? inputSettings : activeTab === 'Runs' && manualRunForm ? manualRunForm : activeTab === 'Revisions' && detail ? (
        <section class="automation-revisions">
          <div class="runs-section-heading"><h2>{t('workbench.immutableRevisions')}</h2><span>{t('workbench.newestFirst')}</span></div>
          <p class="activation-help">{t('workbench.activateAPublishedRevisionThenEnableTheAutomationToAcceptTriggerEventsExistingRunsKeep')}</p>
          {detail.revisions.length ? (
            <div class="revision-list">
              {detail.revisions.map(revision => (
                <article data-active={revision.active} key={revision.id}>
                  <div><strong>{t('workbench.revision')}{revision.number}</strong>{revision.active ? <em>{t('workbench.active')}</em> : null}</div>
                  <small>{revision.contentHash}</small>
                  <time datetime={revision.createdAt}>{revision.createdAt}</time>
                  {activation && onActivateRevision ? <button
                    aria-label={t('workbench.activateRevisionValue0', { value0: revision.number })}
                    class="revision-activate-button"
                    disabled={revision.active || activation.pending}
                    onClick={() => onActivateRevision(revision.id)}
                    type="button"
                  >{activation.activatingRevisionId === revision.id ? t('workbench.activating') : revision.active ? t('workbench.active') : t('workbench.activate')}</button> : null}
                </article>
              ))}
            </div>
          ) : <p class="automation-flow-empty">{t('workbench.noImmutableRevisionHasBeenPublishedFromThisDraft')}</p>}
        </section>
      ) : activeTab === 'State' && detail ? (
        <section class="automation-activation-state">
          <h2>{t('workbench.activation')}</h2>
          <dl>
            <div><dt>{t('workbench.desiredState')}</dt><dd>{detail.automation.enabled ? t('workbench.enabled') : t('workbench.disabled')}</dd></div>
            <div><dt>{t('workbench.activeRevision')}</dt><dd>{activeRevision ? t('workbench.revisionValue0', { value0: activeRevision.number }) : t('workbench.none')}</dd></div>
          </dl>
          <p>{!activeRevision ? t('workbench.publishAndActivateARevisionBeforeEnablingThisAutomation')
            : detail.automation.enabled ? t('workbench.triggerSubscriptionsFollowTheActiveRevisionEventDeliveryDependsOnAvailableProvidersAndConnections')
              : t('workbench.triggerSubscriptionsAreDisabledExistingRunsContinueWithTheirOriginalRevision')}</p>
          <button class="revision-activate-button" onClick={() => onTabChange('Revisions')} type="button">{t('workbench.manageRevisions')}</button>
        </section>
      ) : (
        <section class="secondary-view">
          <h2>{activeTab}</h2>
          <p>{t('workbench.thisWorkspaceViewIsOwnedByItsPageExtension')}</p>
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
