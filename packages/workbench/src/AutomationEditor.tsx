import { Button, SelectMenu } from '@numenjs/components'
import { diagnosticText, t } from './i18n.js'
import { automationStepEditOptions } from './automation-source-editing.js'
import type { AutomationInsertTarget, AutomationSourceCommand } from './automation-source-editing.js'
import { StructuredAutomationFlow, type AutomationClipboardView } from './StructuredAutomationFlow.js'
import {
  Copy,
  ClipboardPaste,
  ChevronDown,
  PanelRight,
  ArrowUp,
  ArrowDown,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
} from '@lucide/vue'
import type { VNodeChild } from 'vue'
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
import { shortcutLabel, useWorkbenchCommands } from './commands.js'
import { defineSetupComponent } from './vue-component.js'

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
    savePhase?: import('./useAutomationDraftDocument.js').AutomationDraftSavePhase
    inputBlocked?: boolean
    conflict?: { expectedVersion: number; actualVersion: number }
    saveError?: string
    publishError?: string
    editError?: string
  }
  inputSettings?: VNodeChild
  manualRunForm?: VNodeChild
  draftTestForm?: VNodeChild
  draftTestSessionActive?: boolean
  conflictRecovery?: VNodeChild
  activation?: AutomationActivationView
  inspectorOpen?: boolean
  inspectorFocusNodeId?: string
  onActivateRevision?(revisionId: string): void
  onViewSnapshot?(snapshotId: string): void
  onCompareRevision?(revisionId: string): void
  onSetEnabled?(enabled: boolean): void
  onStepChange(id: string): void
  onTabChange(tab: string): void
  onOpenInspector(): void
  onAutomationChange?(id: string): void
  onDeleteStep?(nodeId: string): void
  onMoveStep?(nodeId: string, direction: 'up' | 'down'): void
  onInsert?(item: WorkbenchAutomationInsertItem, target: AutomationInsertTarget): boolean
  onSourceCommand?(command: AutomationSourceCommand): boolean
  clipboard?: AutomationClipboardView
  collapsedNodes?: string[]
  onCopyStep?(nodeId: string): void
  onCutStep?(nodeId: string): void
  onPaste?(target: AutomationInsertTarget): boolean
  onToggleCollapse?(nodeId: string, collapsed: boolean): void
  onReloadInsertCatalog?(): void
  onUndo?(): void
  onRedo?(): void
  onPublish?(): void
  onTestDraft?(): void
  onReloadDraft?(): void
  onRetrySave?(): void
  onReload?(): void
}

interface ToolbarButtonProps {
  label: string
  disabled?: boolean
  description?: string | undefined
  commandId?: string
  onClick?(): void
}
const ToolbarButton = defineSetupComponent<ToolbarButtonProps>('ToolbarButton', ['label', 'disabled', 'description', 'commandId', 'onClick'], (props, context) => {
  const commands = useWorkbenchCommands()
  return () => {
    const { label, disabled = false, onClick, description, commandId } = props
    const command = commandId ? commands?.find(commandId) : undefined
    const title = command?.disabledReason ?? description ?? (command?.shortcut ? `${label} (${shortcutLabel(command.shortcut)})` : label)
    return <Button variant="ghost" size="icon" aria-label={label} class="toolbar-button" disabled={command ? !!command.disabledReason : disabled} {...(commandId && command ? { onClick: () => commands?.execute(commandId) } : onClick ? { onClick } : {})} title={title} type="button">{context.slots.default?.()}</Button>
  }
})

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
  inspectorFocusNodeId,
  conflictRecovery,
  inputSettings,
  manualRunForm,
  draftTestForm,
  draftTestSessionActive,
  onActivateRevision,
  onViewSnapshot,
  onCompareRevision,
  onSetEnabled,
  onStepChange,
  onTabChange,
  onOpenInspector,
  onAutomationChange,
  onInsert,
  onSourceCommand,
  clipboard,
  collapsedNodes,
  onCopyStep,
  onCutStep,
  onPaste,
  onToggleCollapse,
  onDeleteStep,
  onMoveStep,
  onReloadInsertCatalog,
  onUndo,
  onRedo,
  onPublish,
  onTestDraft,
  onReloadDraft,
  onRetrySave,
  onReload,
}: AutomationEditorProps) {
  const commands = useWorkbenchCommands()
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
  const triggerRuntime = detail?.triggerRuntime?.activationGeneration === detail?.automation.activationGeneration
    ? detail?.triggerRuntime : undefined
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
                <em>{t('workbench.draftV')}{detail.draft.version}{authoring?.savePhase ? ` · ${t(`workbench.save.${authoring.savePhase}`)}` : ''}</em>
                <em>{latestRevision ? t('workbench.publishedRValue0', { value0: latestRevision.number }) : t('workbench.noRevisions')}</em>
                <em>{activeRevision ? t('workbench.activeRValue0', { value0: activeRevision.number }) : t('workbench.notActive')}</em>
              </span>
            ) : null}</div>
            {detail ? <p class="automation-trigger-status" role="status">
              {t('workbench.document.triggerRuntime')}: {t(`workbench.document.trigger.${triggerRuntime?.status ?? 'UNKNOWN'}`)}
              {triggerRuntime?.expected ? ` (${triggerRuntime.active}/${triggerRuntime.expected})` : ''}
            </p> : null}
          </div>
          <div class="entity-title-actions">
            {onTestDraft ? <Button variant="secondary" disabled={!draftTestSessionActive && !authoring?.canPublish} type="button"
              onMousedown={event => { if (event.button === 0) event.preventDefault() }}
              onClick={onTestDraft}>{t(draftTestSessionActive ? 'workbench.draftTest.show' : 'workbench.draftTest.open')}</Button> : null}
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
              <Button variant="primary"
                class="publish-button"
                disabled={!authoring.canPublish}
                // The command commits focused fields. Delay blur until click so status
                // wrapping cannot move this button between mouse down and mouse up.
                onMousedown={event => { if (event.button === 0) event.preventDefault() }}
                onClick={() => commands ? commands.execute('automation.publish') : onPublish()}
                type="button"
              >{authoring.publishPending ? t('workbench.publishing') : t('workbench.publish')}</Button>
            ) : null}
            <Button
              aria-expanded={inspectorOpen ?? false}
              aria-label={inspectorOpen ? t('workbench.closeInspector') : t('workbench.openInspector')}
              class="mobile-inspector-button"
              data-active={inspectorOpen ?? false}
              onClick={onOpenInspector}
              type="button"
            ><PanelRight aria-hidden="true" size={14} /><span>{t('workbench.inspector')}</span></Button>
          </div>
        </div>
        {liveAutomations?.length && automationId && onAutomationChange ? (
          <label class="mobile-automation-switcher">
            <span>{t('workbench.automation')}</span>
            <SelectMenu ariaLabel={t('workbench.selectAutomation')} onChange={onAutomationChange} value={automationId}
              options={liveAutomations.map(item => ({ value: item.id, label: item.name }))} />
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
      {draftTestForm}
      {authoring?.inputBlocked ? <section class="authoring-notice" data-tone="error" role="alert">{t('workbench.document.applyInputsFirst')}</section> : null}
      {authoring?.editError ? <section class="authoring-notice" data-tone="error" role="alert"><span>{t(`workbench.structure.errors.${authoring.editError}`) === `workbench.structure.errors.${authoring.editError}` ? authoring.editError : t(`workbench.structure.errors.${authoring.editError}`)}</span></section> : null}
      {activation?.error ? <section class="authoring-notice" data-tone="error" role="alert"><span>{activation.error}</span></section> : null}
      {archived ? <section class="authoring-notice" data-tone="conflict" role="status"><span>{t('workbench.archivedAutomationReadOnly')}</span></section> : null}
      {authoring?.conflict ? (conflictRecovery ??
        <section class="authoring-notice" data-tone="conflict" role="alert">
          <span><strong>{t('workbench.draftChangedElsewhere')}</strong>{t('workbench.localVersion')}{authoring.conflict.expectedVersion}{t('workbench.cannotOverwriteServerVersion')}{authoring.conflict.actualVersion}.</span>
          {onReloadDraft ? <Button onClick={onReloadDraft} type="button">{t('workbench.reloadServerDraft')}</Button> : null}
        </section>
      ) : authoring?.saveError ? (
        <section class="authoring-notice" data-tone="error" role="alert">
          <span><strong>{t('workbench.autosaveFailed')}</strong> {authoring.saveError}</span>
          {onRetrySave ? <Button onClick={onRetrySave} type="button">{t('workbench.retryAutosave')}</Button> : null}
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
              <ToolbarButton disabled={!authoring?.canUndo || !onUndo} commandId="automation.undo" label={t('workbench.undo')} {...(onUndo ? { onClick: onUndo } : {})}><Undo2 size={16} /></ToolbarButton>
              <ToolbarButton disabled={!authoring?.canRedo || !onRedo} commandId="automation.redo" label={t('workbench.redo')} {...(onRedo ? { onClick: onRedo } : {})}><Redo2 size={16} /></ToolbarButton>
            </div>
            <div class="toolbar-group">
              <ToolbarButton disabled={!canEdit || !editOptions?.canMoveTo || !onCutStep} commandId="automation.cut" label={t('workbench.cut')} onClick={() => selectedNodeId && onCutStep?.(selectedNodeId)}><Scissors size={16} /></ToolbarButton>
              <ToolbarButton disabled={!canEdit || !editOptions?.canCopy || !onCopyStep} commandId="automation.copy" label={t('workbench.copy')} description={!editOptions?.canCopy ? t('workbench.structure.errors.COPY_UNSAFE') : undefined} onClick={() => selectedNodeId && onCopyStep?.(selectedNodeId)}><Copy size={16} /></ToolbarButton>
              <ToolbarButton commandId="automation.paste" disabled={!clipboard} label={t('workbench.structure.pasteAfter')}><ClipboardPaste size={16} /></ToolbarButton>
              <ToolbarButton disabled={!canEdit || !editOptions?.canDelete || !onDeleteStep} commandId="automation.delete" label={t('workbench.delete')} onClick={() => selectedNodeId && onDeleteStep?.(selectedNodeId)}><Trash2 size={16} /></ToolbarButton>
              <ToolbarButton disabled={!canEdit || !editOptions?.canMoveUp || !onMoveStep} commandId="automation.moveUp" label={t('workbench.moveUp')} onClick={() => selectedNodeId && onMoveStep?.(selectedNodeId, 'up')}><ArrowUp size={16} /></ToolbarButton>
              <ToolbarButton disabled={!canEdit || !editOptions?.canMoveDown || !onMoveStep} commandId="automation.moveDown" label={t('workbench.moveDown')} onClick={() => selectedNodeId && onMoveStep?.(selectedNodeId, 'down')}><ArrowDown size={16} /></ToolbarButton>
            </div>
          </div>
          <section class="automation-canvas" aria-label={t('workbench.value0AutomationFlow', { value0: automationName })}>
            <div class="step-flow">
              {detail ? <StructuredAutomationFlow
                key={detail.automation.id}
                source={detail.draft.source}
                steps={steps}
                activeStepId={activeStepId}
                {...(inspectorFocusNodeId ? { inspectorFocusNodeId } : {})}
                canEdit={canEdit}
                onStepChange={onStepChange}
                {...(insertCatalogState ? { insertCatalogState } : {})}
                {...(clipboard ? { clipboard } : {})}
                {...(collapsedNodes ? { collapsedNodes } : {})}
                {...(onInsert ? { onInsert } : {})}
                {...(onSourceCommand ? { onSourceCommand } : {})}
                {...(onDeleteStep ? { onDeleteStep } : {})}
                {...(onMoveStep ? { onMoveStep } : {})}
                {...(onCopyStep ? { onCopyStep } : {})}
                {...(onCutStep ? { onCutStep } : {})}
                {...(onPaste ? { onPaste } : {})}
                {...(onToggleCollapse ? { onToggleCollapse } : {})}
                {...(onReloadInsertCatalog ? { onReloadInsertCatalog } : {})}
              /> : <>
                {steps.map((step, index) => {
                  const Icon = step.icon
                  const selected = step.id === activeStepId
                  return <div class="step-unit" key={step.id}>
                    <div class="step-index" aria-hidden="true">{index + 1}</div>
                    <button aria-pressed={selected} class="automation-step" data-selected={selected} onClick={() => onStepChange(step.id)} type="button">
                      <span class="step-icon" data-tone={step.tone}><Icon size={19} strokeWidth={1.7} /></span>
                      <span class="step-copy"><strong>{step.label}</strong><small>{step.summary}</small></span>
                      <ChevronDown aria-hidden="true" class="step-menu" size={18} />
                    </button>
                    {index < steps.length - 1 ? <div class="step-connector" aria-hidden="true"><span><Plus size={13} /></span></div> : null}
                  </div>
                })}
                <AutomationQuickPicker disabled />
              </>}
            </div>
          </section>
        </>
      ) : activeTab === 'Settings' && inputSettings ? inputSettings : activeTab === 'Runs' && manualRunForm ? manualRunForm : activeTab === 'Revisions' && detail ? (
        <section class="automation-revisions">
          <div class="runs-section-heading"><h2>{t('workbench.immutableRevisions')}</h2><span>{t('workbench.newestFirst')}</span>
            {onCompareRevision && detail.revisions[0] ? <Button type="button" variant="secondary" onClick={() => onCompareRevision(detail.revisions[0]!.id)}>{t('workbench.comparison.title')}</Button> : null}
          </div>
          <p class="activation-help">{t('workbench.activateAPublishedRevisionThenEnableTheAutomationToAcceptTriggerEventsExistingRunsKeep')}</p>
          {detail.revisions.length ? (
            <div class="revision-list">
              {detail.revisions.map(revision => (
                <article data-active={revision.active} key={revision.id}>
                  <div><strong>{t('workbench.revision')}{revision.number}</strong>{revision.active ? <em>{t('workbench.active')}</em> : null}</div>
                  <small>{revision.contentHash}</small>
                  <time datetime={revision.createdAt}>{revision.createdAt}</time>
                  {onViewSnapshot ? <Button variant="secondary" aria-label={t('workbench.snapshots.viewRevision', { number: revision.number })}
                    type="button" onClick={() => onViewSnapshot(revision.id)}>{t('workbench.snapshots.view')}</Button> : null}
                  {onCompareRevision ? <Button variant="secondary" aria-label={t('workbench.comparison.compareRevision', { number: revision.number })}
                    type="button" onClick={() => onCompareRevision(revision.id)}>{t('workbench.comparison.withDraft')}</Button> : null}
                  {activation && onActivateRevision ? <Button
                    aria-label={t('workbench.activateRevisionValue0', { value0: revision.number })}
                    class="revision-activate-button"
                    disabled={revision.active || activation.pending}
                    onClick={() => onActivateRevision(revision.id)}
                    type="button"
                  >{activation.activatingRevisionId === revision.id ? t('workbench.activating') : revision.active ? t('workbench.active') : t('workbench.activate')}</Button> : null}
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
          <Button class="revision-activate-button" onClick={() => onTabChange('Revisions')} type="button">{t('workbench.manageRevisions')}</Button>
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
      {action ? <Button variant="secondary" class="secondary-button" {...(onAction ? { onClick: onAction } : {})} type="button">{action}</Button> : null}
    </section>
  )
}
