import { AutomationInputs } from './AutomationInputs.js'
import { localizeCatalogItem, useWorkbenchI18n } from './i18n.js'
import { AutomationRuns } from './AutomationRuns.js'
import type { SourceRef } from '@numenjs/core'
import { computed, h, inject, nextTick, onScopeDispose, provide, ref, watch, type ComputedRef, type InjectionKey } from 'vue'
import { DraftConflictRecovery } from './DraftConflictRecovery.js'
import { AutomationEditor, type AutomationEditorProps } from './AutomationEditor.js'
import { AutomationPanel, AutomationStatusBar } from './AutomationPanel.js'
import { AutomationSidebar } from './AutomationSidebar.js'
import { projectAutomationSteps } from './automation-projection.js'
import {
  workbenchAutomationDetailQueryRef,
  workbenchAutomationInsertCatalogQueryRef,
  workbenchAutomationVariableCatalogQueryRef,
  workbenchAutomationsIndexQueryRef,
  workbenchArchiveAutomationActionRef,
  workbenchCreateAutomationActionRef,
  workbenchRemoveArchivedAutomationActionRef,
  workbenchRestoreAutomationActionRef,
  type WorkbenchAutomationDetail,
  type WorkbenchAutomationDetailQueryInput,
  type WorkbenchAutomationInsertCatalog,
  type WorkbenchAutomationVariableCatalog,
  type WorkbenchAutomationsIndex,
  type WorkbenchCreateAutomationInput,
  type WorkbenchCreateAutomationResult,
  type WorkbenchArchiveAutomationInput,
  type WorkbenchRemoveArchivedAutomationInput,
  type WorkbenchRestoreAutomationInput,
} from './contracts.js'
import { Inspector, type InspectorFieldFocus } from './Inspector.js'
import type { WorkbenchPageChromeProps } from './types.js'
import { useAutomationActivation } from './useAutomationActivation.js'
import { useAutomationDraftDocument } from './useAutomationDraftDocument.js'
import { useConsoleQuery, type ConsoleQueryState } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'
import { automationDocumentNeedsProtection, createAutomationInputSession, provideAutomationInputSession } from './automation-input-session.js'
import { useCommandRegistration } from './commands.js'
import { automationRelativeInsertTarget, automationStepEditOptions } from './automation-source-editing.js'

const emptyQueryInput: Record<string, never> = {}

const automationWorkspaceKey: InjectionKey<ComputedRef<AutomationEditorProps>> = Symbol('automation-workspace')

export function useAutomationWorkspace(): ComputedRef<AutomationEditorProps> {
  const workspace = inject(automationWorkspaceKey)
  if (!workspace) throw new Error('Automation Page must render inside AutomationPageChrome')
  return workspace
}

export const AutomationPageChrome = defineSetupComponent<WorkbenchPageChromeProps>('AutomationPageChrome', ['page', 'consoleClient', 'schemaUI', 'navigation', 'inspectorOpen', 'onInspectorOpenChange'], props => {
  const { t } = useWorkbenchI18n()
  const inputs = createAutomationInputSession(() => globalThis.confirm(t('workbench.document.discardInputs')))
  provideAutomationInputSession(inputs)
  const inputBlocked = ref(false)
  const blurCurrentInput = () => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }
  const allowInputChange = () => { blurCurrentInput(); return inputs.confirmDiscard() }
  const confirmedAutomationId = ref<string>()
  const requestedAutomationId = ref('morning-brief')
  const createRequest = ref(0)
  const activeTab = ref('Editor')
  const archiveView = ref(false)
  const lifecyclePending = ref(false)
  const lifecycleError = ref<string>()
  const requestedStepId = ref('notification')
  const fieldFocus = ref<InspectorFieldFocus>()
  const creatingAutomation = ref(false)
  const createAutomationError = ref<string>()
  let createAutomationController: AbortController | undefined
  let lifecycleController: AbortController | undefined
  onScopeDispose(() => createAutomationController?.abort())
  onScopeDispose(() => lifecycleController?.abort())
  const indexInput = computed(() => ({ archived: archiveView.value }))
  const [indexState, reloadIndex, refreshIndex] = useConsoleQuery<{ archived: boolean }, WorkbenchAutomationsIndex>(
    () => props.consoleClient,
    workbenchAutomationsIndexQueryRef,
    indexInput,
    'automations',
  )
  const [insertCatalogState, reloadInsertCatalog] = useConsoleQuery<Record<string, never>, WorkbenchAutomationInsertCatalog>(
    () => props.consoleClient,
    workbenchAutomationInsertCatalogQueryRef,
    emptyQueryInput,
    'automationCatalog',
  )
  const [variableCatalogState] = useConsoleQuery<Record<string, never>, WorkbenchAutomationVariableCatalog>(
    () => props.consoleClient,
    workbenchAutomationVariableCatalogQueryRef,
    emptyQueryInput,
    'automationCatalog',
  )
  const localizedCatalogState = computed<ConsoleQueryState<WorkbenchAutomationInsertCatalog>>(() => (
    insertCatalogState.status === 'READY'
      ? { status: 'READY', data: { ...insertCatalogState.data, items: insertCatalogState.data.items.map(item => localizeCatalogItem(item, t)) } }
      : insertCatalogState
  ))
  const createAutomation = async (name: string): Promise<boolean> => {
    if (!props.consoleClient || creatingAutomation.value) return false
    if (!allowDocumentLeave()) return false
    createAutomationController?.abort()
    const controller = new AbortController()
    createAutomationController = controller
    creatingAutomation.value = true
    createAutomationError.value = undefined
    try {
      const result = await props.consoleClient.action<WorkbenchCreateAutomationInput, WorkbenchCreateAutomationResult>(
        workbenchCreateAutomationActionRef,
        { name },
        controller.signal,
      )
      if (controller.signal.aborted) return false
      confirmedAutomationId.value = result.automation.id
      requestedAutomationId.value = result.automation.id
      archiveView.value = false
      activeTab.value = 'Editor'
      refreshIndex()
      return true
    } catch (error) {
      if (!controller.signal.aborted) createAutomationError.value = error instanceof Error ? error.message : 'Could not create Automation.'
      return false
    } finally {
      if (createAutomationController === controller) {
        createAutomationController = undefined
        creatingAutomation.value = false
      }
    }
  }
  const runLifecycleAction = async <Input extends object, Output extends object>(
    procedure: { id: string; version: number },
    input: Input,
    success: () => void,
    before?: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (!props.consoleClient || lifecyclePending.value) return false
    const controller = lifecycleController = new AbortController()
    lifecyclePending.value = true
    lifecycleError.value = undefined
    try {
      if (before && !(await before())) return false
      await props.consoleClient.action<Input, Output>(procedure, input, controller.signal)
      if (controller.signal.aborted) return false
      success()
      return true
    } catch (error) {
      if (!controller.signal.aborted) {
        lifecycleError.value = error instanceof Error ? error.message : 'Automation operation failed.'
        refreshIndex()
      }
      return false
    } finally {
      if (lifecycleController === controller) {
        lifecycleController = undefined
        lifecyclePending.value = false
      }
    }
  }
  const restoreAutomation = (automationId: string, expectedActivationGeneration: number) => runLifecycleAction<WorkbenchRestoreAutomationInput, { automationId: string }>(
    workbenchRestoreAutomationActionRef, { automationId, expectedActivationGeneration }, () => { archiveView.value = false },
  )
  const removeArchivedAutomation = (automationId: string, expectedArchivedAt: string) => runLifecycleAction<WorkbenchRemoveArchivedAutomationInput, { automationId: string; removedRuns: number }>(
    workbenchRemoveArchivedAutomationActionRef, { automationId, expectedArchivedAt }, () => {
      if (requestedAutomationId.value === automationId) {
        requestedAutomationId.value = ''
        confirmedAutomationId.value = undefined
      }
      refreshIndex()
    },
  )
  const liveItems = computed(() => indexState.status === 'READY' ? indexState.data.items : [])
  const automationId = computed(() => props.consoleClient
    ? ((requestedAutomationId.value === confirmedAutomationId.value || liveItems.value.some(item => item.id === requestedAutomationId.value)) ? requestedAutomationId.value : liveItems.value[0]?.id)
    : requestedAutomationId.value)
  // Pin confirmed selections so index reordering or a failed refresh cannot discard local edits.
  watch(automationId, id => {
    if (id && props.consoleClient) {
      requestedAutomationId.value = id
      confirmedAutomationId.value = id
    }
  }, { immediate: true })
  const detailInput = computed<WorkbenchAutomationDetailQueryInput>(() => ({
    automationId: automationId.value ?? '',
  }))
  const [queriedDetailState, reloadDetail, refreshDetail] = useConsoleQuery<WorkbenchAutomationDetailQueryInput, WorkbenchAutomationDetail | null>(
    () => props.consoleClient && automationId.value ? props.consoleClient : undefined,
    workbenchAutomationDetailQueryRef,
    detailInput,
    'automations',
  )
  const detailState = computed<ConsoleQueryState<WorkbenchAutomationDetail | null> | undefined>(() => {
    if (!props.consoleClient) return undefined
    if (automationId.value) return queriedDetailState.status === 'DISABLED' ? { status: 'LOADING' } : queriedDetailState
    if (indexState.status === 'ERROR') return indexState
    if (indexState.status === 'READY') return { status: 'READY', data: null }
    return { status: 'LOADING' }
  })
  const detail = computed(() => detailState.value?.status === 'READY' && detailState.value.data?.automation.id === automationId.value
    ? detailState.value.data ?? undefined
    : undefined)
  const activation = useAutomationActivation(() => props.consoleClient, () => { refreshDetail(); refreshIndex() })
  const authoring = useAutomationDraftDocument({
    client: () => props.consoleClient,
    automationId,
    detail,
    reloadDetail,
  })
  const needsProtection = computed(() => automationDocumentNeedsProtection(authoring.savePhase, inputs.hasUncommitted, authoring.publishPending))
  function allowDocumentLeave(): boolean {
    blurCurrentInput()
    return !needsProtection.value || globalThis.confirm(t('workbench.document.leaveUnsaved'))
  }
  const switchAutomation = (id: string): boolean => {
    if (id === automationId.value) return true
    if (!allowDocumentLeave()) return false
    requestedAutomationId.value = id
    return true
  }
  watch(() => props.navigation, (navigation, _previous, cleanup) => {
    const dispose = navigation?.beforeLeave?.(attempt => {
      const target = new URLSearchParams(attempt.search)
      const nextAutomation = target.get('automation')
      if (attempt.pathname === navigation.route.pathname && (!nextAutomation || nextAutomation === automationId.value)) return allowInputChange()
      return allowDocumentLeave()
    })
    if (dispose) cleanup(dispose)
  }, { immediate: true })
  // Router guards already approved an in-place query change. Initial deep links have no local Draft to discard.
  watch(() => props.navigation?.route.search, search => {
    const query = new URLSearchParams(search ?? '')
    const requested = query.get('automation')
    if (requested) { requestedAutomationId.value = requested; confirmedAutomationId.value = requested }
    const tab = query.get('tab')
    if (tab && ['Editor', 'Runs', 'Revisions', 'State', 'Settings'].includes(tab)) activeTab.value = tab
    if (query.get('create') === '1') createRequest.value += 1
  }, { immediate: true })
  watch(needsProtection, (protect, _previous, cleanup) => {
    if (!protect || typeof window === 'undefined') return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    cleanup(() => window.removeEventListener('beforeunload', beforeUnload))
  }, { immediate: true, flush: 'sync' })
  watch(() => inputs.hasUncommitted, pending => { if (!pending) inputBlocked.value = false }, { flush: 'sync' })
  watch(automationId, () => { inputs.clear(); inputBlocked.value = false })
  const publishDraft = () => {
    blurCurrentInput()
    if (inputs.hasUncommitted) { inputBlocked.value = true; return }
    authoring.publish()
  }
  const archiveAutomation = (automationIdTarget: string, expectedActivationGeneration: number) => {
    // Commit focused valid text before lifecyclePending makes the form read-only.
    if (automationId.value === automationIdTarget) {
      blurCurrentInput()
      if (inputs.hasUncommitted) {
        lifecycleError.value = t('workbench.document.applyInputsFirst')
        return Promise.resolve(false)
      }
    }
    return runLifecycleAction<WorkbenchArchiveAutomationInput, { automationId: string }>(
    workbenchArchiveAutomationActionRef, { automationId: automationIdTarget, expectedActivationGeneration }, () => {
      archiveView.value = true
      activeTab.value = 'Runs'
      props.onInspectorOpenChange(false)
    },
    async () => {
      if (automationId.value !== automationIdTarget) return true
      const saved = await authoring.flushDraft(lifecycleController?.signal)
      if (!saved) lifecycleError.value = t('workbench.saveDraftBeforeArchiving')
      return saved
    },
  )
  }
  const effectiveDetail = computed<WorkbenchAutomationDetail | undefined>(() => {
    const queriedDetail = detail.value
    const currentDetail = queriedDetail ? {
      ...queriedDetail,
      automation: activation.view(queriedDetail.automation).automation,
      revisions: queriedDetail.revisions.map(revision => ({
        ...revision, active: revision.id === activation.view(queriedDetail.automation).automation.activeRevisionId,
      })),
    } : undefined
    if (!currentDetail || authoring.document?.automationId !== currentDetail.automation.id) return currentDetail
    const document = authoring.document
    return {
      ...currentDetail,
      draft: {
        source: document.source,
        presentation: document.presentation,
        version: document.version,
        updatedAt: document.updatedAt,
        ...(document.baseRevisionId ? { baseRevisionId: document.baseRevisionId } : {}),
      },
    }
  })
  const effectiveDetailState = computed<ConsoleQueryState<WorkbenchAutomationDetail | null> | undefined>(() => {
    if (detailState.value?.status !== 'READY' || !detailState.value.data || !effectiveDetail.value) return detailState.value
    return { status: 'READY', data: effectiveDetail.value }
  })
  const archived = computed(() => !!effectiveDetail.value?.automation.archivedAt)
  const editable = computed(() => !archived.value && !lifecyclePending.value && !creatingAutomation.value)
  const capabilityTitles = computed(() => new Map(
    localizedCatalogState.value.status === 'READY'
      ? localizedCatalogState.value.data.items.flatMap(item => item.kind === 'capability' || item.kind === 'trigger'
        ? [[`${item.capability.id}@${item.capability.version}`, item.title] as const]
        : item.kind === 'extension' ? [[`control:${item.control.id}@${item.control.version}`, item.title] as const]
        : [])
      : [],
  ))
  const steps = computed(() => (
    effectiveDetail.value ? projectAutomationSteps(effectiveDetail.value.draft.source, authoring.problems, capabilityTitles.value, t) : []
  ))
  const activeStepId = computed(() => {
    const selectedStep = steps.value.find(step => step.sourceId === authoring.selectedNodeId)
    return props.consoleClient
      ? selectedStep?.id ?? steps.value[0]?.id ?? ''
      : requestedStepId.value
  })
  const workspace = computed<AutomationEditorProps>(() => ({
    ...(automationId.value ? { automationId: automationId.value } : {}),
    activeStepId: activeStepId.value,
    activeTab: activeTab.value,
    inspectorOpen: props.inspectorOpen,
    ...(props.inspectorOpen && fieldFocus.value?.fieldPath ? { inspectorFocusNodeId: fieldFocus.value.nodeId } : {}),
    ...(effectiveDetailState.value ? { detailState: effectiveDetailState.value } : {}),
    ...(props.consoleClient ? { insertCatalogState: localizedCatalogState.value } : {}),
    ...(props.consoleClient ? { steps: steps.value } : {}),
    ...(props.consoleClient ? {
      automations: liveItems.value,
      onAutomationChange: switchAutomation,
    } : {}),
    ...(props.consoleClient ? {
      authoring: {
        canEdit: editable.value && authoring.canEdit,
        canPublish: editable.value && authoring.canPublish,
        canUndo: editable.value && authoring.canUndo,
        canRedo: editable.value && authoring.canRedo,
        publishPending: authoring.publishPending,
        savePhase: authoring.savePhase,
        inputBlocked: inputBlocked.value,
        ...(authoring.editError ? { editError: authoring.editError } : {}),
        ...(authoring.conflict ? { conflict: authoring.conflict } : {}),
        ...(authoring.saveError ? { saveError: authoring.saveError } : {}),
        ...(authoring.publishError ? { publishError: authoring.publishError } : {}),
      },
      ...(editable.value ? { onInsert: (item, target) => allowInputChange() && authoring.insert(item, target), onSourceCommand: command => allowInputChange() && authoring.edit(command),
        onCopyStep: authoring.copyStep, onCutStep: authoring.cutStep, onPaste: target => allowInputChange() && authoring.paste(target),
        onToggleCollapse: authoring.toggleCollapse,
      } : {}),
      ...(authoring.clipboard ? { clipboard: authoring.clipboard } : {}),
      collapsedNodes: authoring.collapsedNodes,
      ...(editable.value ? { onDeleteStep: nodeId => { if (allowInputChange()) authoring.deleteStep(nodeId) }, onMoveStep: (nodeId, direction) => { if (allowInputChange()) authoring.moveStep(nodeId, direction) } } : {}),
      onReloadInsertCatalog: reloadInsertCatalog,
      ...(editable.value ? { onUndo: () => { if (allowInputChange()) authoring.undo() }, onRedo: () => { if (allowInputChange()) authoring.redo() }, onPublish: publishDraft } : {}),
      onReloadDraft: () => { if (allowDocumentLeave()) { inputs.discard(); authoring.reload() } },
      ...(editable.value ? { onRetrySave: authoring.retrySave } : {}),
    } : {}),
    ...(props.consoleClient && authoring.document ? {
      inputSettings: h(AutomationInputs, { key: authoring.document.automationId, inputs: authoring.document.source.inputs, canEdit: editable.value && authoring.canEdit, problems: authoring.problems, onChange: inputs => { if (editable.value) authoring.setAutomationInputs(inputs) }, ...(props.schemaUI ? { schemaUI: props.schemaUI } : {}) }),
      manualRunForm: h(AutomationRuns, { key: authoring.document.automationId, automationId: authoring.document.automationId, archived: archived.value, consoleClient: props.consoleClient, ...(props.schemaUI ? { schemaUI: props.schemaUI } : {}), ...(props.navigation ? { navigation: props.navigation } : {}) }),
    } : {}),
    ...(props.consoleClient && authoring.document && authoring.conflict ? {
      conflictRecovery: h(DraftConflictRecovery, {
        key: authoring.document.automationId,
        client: props.consoleClient, document: authoring.document, conflict: authoring.conflict,
        name: effectiveDetail.value?.automation.name ?? 'Automation',
        onReload: () => { inputs.discard(); authoring.reload() },
        onOpenCopy: (id: string) => {
          confirmedAutomationId.value = id
          requestedAutomationId.value = id
          activeTab.value = 'Editor'
          refreshIndex()
        },
      }),
    } : {}),
    ...(props.consoleClient && effectiveDetail.value && !archived.value && !lifecyclePending.value ? {
      activation: activation.view(effectiveDetail.value.automation),
      onActivateRevision: (revisionId: string) => {
        if (effectiveDetail.value) activation.activate(effectiveDetail.value.automation, revisionId)
      },
      onSetEnabled: (enabled: boolean) => {
        if (effectiveDetail.value) activation.setEnabled(effectiveDetail.value.automation, enabled)
      },
    } : {}),
    onOpenInspector: () => props.onInspectorOpenChange(!props.inspectorOpen),
    onStepChange: id => {
      if (id !== activeStepId.value && !allowInputChange()) return
      const step = steps.value.find(item => item.id === id)
      if (props.consoleClient) authoring.selectNode(step?.sourceId, editable.value && authoring.canEdit)
      else requestedStepId.value = id
      fieldFocus.value = undefined
      props.onInspectorOpenChange(true)
    },
    onTabChange: tab => { if (tab !== activeTab.value && !allowInputChange()) return; activeTab.value = tab; if (tab !== 'Editor') props.onInspectorOpenChange(false) },
    onReload: reloadDetail,
  }))
  provide(automationWorkspaceKey, workspace)

  useCommandRegistration(() => {
    if (!props.consoleClient) return []
    const view = workspace.value
    const source = authoring.document?.source
    const selected = steps.value.find(step => step.id === activeStepId.value)?.sourceId
    const options = source ? automationStepEditOptions(source, selected) : undefined
    const target = source && selected ? automationRelativeInsertTarget(source, selected, 'after') : undefined
    const locked = !editable.value || !authoring.canEdit
    const reason = (allowed: boolean | undefined, fallback = 'workbench.commands.unavailableSelection') => locked ? t('workbench.commands.readOnly') : allowed ? undefined : t(fallback)
    const edit = (id: string, label: string, allowed: boolean | undefined, execute: () => void | boolean, shortcut?: import('./commands.js').CommandShortcut, fallback?: string) => ({
      id, label, visible: !!source && activeTab.value === 'Editor', ...(shortcut ? { shortcut } : {}),
      ...(reason(allowed, fallback) ? { disabledReason: reason(allowed, fallback)! } : {}), execute,
    })
    const openRuns = (testRun = false) => {
      if (!allowInputChange()) return false
      activeTab.value = 'Runs'; props.onInspectorOpenChange(false)
      if (testRun) void nextTick(() => {
        const launcher = document.querySelector<HTMLDetailsElement>('.automation-run-launcher')
        if (launcher) { launcher.open = true; launcher.querySelector<HTMLElement>('summary')?.focus() }
      })
      return true
    }
    return [
      edit('automation.undo', t('workbench.undo'), authoring.canUndo, () => view.onUndo?.(), { mod: true, key: 'z' }, 'workbench.commands.noUndo'),
      edit('automation.redo', t('workbench.redo'), authoring.canRedo, () => view.onRedo?.(), { mod: true, shift: true, key: 'z' }, 'workbench.commands.noRedo'),
      edit('automation.copy', t('workbench.copy'), options?.canCopy, () => { if (selected) view.onCopyStep?.(selected) }, { mod: true, key: 'c' }),
      edit('automation.cut', t('workbench.cut'), options?.canMoveTo, () => { if (selected) view.onCutStep?.(selected) }, { mod: true, key: 'x' }),
      edit('automation.paste', t('workbench.structure.pasteAfter'), !!authoring.clipboard && !!target, () => target ? view.onPaste?.(target) : false, { mod: true, key: 'v' }, 'workbench.commands.noPasteTarget'),
      edit('automation.delete', t('workbench.delete'), options?.canDelete, () => { if (selected) view.onDeleteStep?.(selected) }, { key: 'Delete' }),
      edit('automation.moveUp', t('workbench.moveUp'), options?.canMoveUp, () => { if (selected) view.onMoveStep?.(selected, 'up') }, { alt: true, key: 'ArrowUp' }),
      edit('automation.moveDown', t('workbench.moveDown'), options?.canMoveDown, () => { if (selected) view.onMoveStep?.(selected, 'down') }, { alt: true, key: 'ArrowDown' }),
      { id: 'automation.publish', label: t('workbench.publish'), visible: !!source, ...(!view.authoring?.canPublish ? { disabledReason: t('workbench.commands.readOnly') } : {}), execute: publishDraft },
      { id: 'automation.runs', label: t('workbench.viewRuns'), visible: !!source, execute: () => openRuns() },
      { id: 'automation.testRun', label: t('workbench.commands.testRun'), visible: !!source,
        ...(archived.value || !effectiveDetail.value?.revisions.length ? { disabledReason: t(archived.value ? 'workbench.commands.readOnly' : 'workbench.commands.publishFirst') } : {}), execute: () => openRuns(true) },
    ]
  })

  const selectProblem = (sourceRef: SourceRef) => {
    const nodeId = sourceRef.nodeId
    if (!nodeId) return
    if (!allowInputChange()) return
    if (nodeId === '__inputs') { activeTab.value = 'Settings'; props.onInspectorOpenChange(false); return }
    const step = steps.value.find(item => item.sourceId === nodeId)
    if (!step) return
    authoring.selectNode(nodeId, editable.value && authoring.canEdit)
    fieldFocus.value = {
      nodeId,
      ...(sourceRef.fieldPath ? { fieldPath: sourceRef.fieldPath } : {}),
      request: (fieldFocus.value?.request ?? 0) + 1,
    }
    props.onInspectorOpenChange(true)
  }

  return () => {
    const PageComponent = props.page.component
    return <>
      <AutomationSidebar
        createRequest={createRequest.value}
        {...(automationId.value ? { activeId: automationId.value } : {})}
        onChange={switchAutomation}
        onOpen={(id, tab) => {
          if (id !== automationId.value ? !switchAutomation(id) : tab !== activeTab.value && !allowInputChange()) return
          activeTab.value = tab
          if (tab !== 'Editor') props.onInspectorOpenChange(false)
        }}
        onCreate={createAutomation}
        onCreateDismiss={() => { createAutomationError.value = undefined }}
        onReload={reloadIndex}
        {...(createAutomationError.value ? { createError: createAutomationError.value } : {})}
        creating={creatingAutomation.value}
        state={indexState}
        onArchiveViewChange={archived => { if (!allowDocumentLeave()) return; archiveView.value = archived; lifecycleError.value = undefined }}
        onArchive={archiveAutomation}
        onRestore={restoreAutomation}
        onRemoveArchived={removeArchivedAutomation}
        mutationPending={lifecyclePending.value}
        {...(lifecycleError.value ? { mutationError: lifecycleError.value } : {})}
      />
      {h(PageComponent, {
        ...(props.consoleClient ? { consoleClient: props.consoleClient } : {}),
        ...(props.schemaUI ? { schemaUI: props.schemaUI } : {}),
        ...(props.navigation ? { navigation: props.navigation } : {}),
      })}
      <Inspector
        key={automationId.value}
        activeStepId={activeStepId.value}
        canEdit={editable.value && authoring.canEdit}
        {...(localizedCatalogState.value.status === 'READY' ? { catalog: localizedCatalogState.value.data } : {})}
        {...(variableCatalogState.status === 'READY' ? { variableCatalog: variableCatalogState.data } : {})}
        {...(fieldFocus.value ? { fieldFocus: fieldFocus.value } : {})}
        open={props.inspectorOpen}
        problems={authoring.problems}
        {...(authoring.document ? { source: authoring.document.source } : {})}
        {...(props.consoleClient ? { steps: steps.value } : {})}
        onClose={() => props.onInspectorOpenChange(false)}
        onCapabilityConnectionChange={(nodeId, slotName, connectionId) => { if (editable.value) authoring.setCapabilityConnection(nodeId, slotName, connectionId) }}
        onCapabilityInputChange={(nodeId, fieldName, expression) => { if (editable.value) authoring.setCapabilityInput(nodeId, fieldName, expression) }}
        onInvocationPolicyChange={(nodeId, policy) => { if (editable.value) authoring.edit({ type: 'SET_INVOCATION_POLICY', nodeId, ...(policy ? { policy } : {}) }) }}
        onTriggerConfigChange={(nodeId, fieldName, value) => { if (editable.value) authoring.setTriggerConfig(nodeId, fieldName, value) }}
        onExtensionInputChange={(nodeId, fieldName, expression) => { if (editable.value) authoring.setExtensionInput(nodeId, fieldName, expression) }}
        onControlExpressionChange={(nodeId, field, expression) => { if (editable.value) authoring.setControlExpression(nodeId, field, expression) }}
        onWaitExpressionChange={(nodeId, field, expression) => { if (editable.value) authoring.setWaitExpression(nodeId, field, expression) }}
        {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
      />
      <AutomationPanel
        {...(props.consoleClient ? { consoleClient: props.consoleClient } : {})}
        {...(automationId.value ? { automationId: automationId.value } : {})}
        problems={authoring.problems}
        preview={!props.consoleClient}
        onProblemSelect={selectProblem}
      />
      <AutomationStatusBar
        message={authoring.saveMessage}
        phase={authoring.savePhase}
        problemCount={authoring.problems.length}
        preview={!props.consoleClient}
        pendingInput={inputs.hasUncommitted}
      />
    </>
  }
})

export const AutomationWorkspacePage = defineSetupComponent<import('./types.js').WorkbenchPageProps>('AutomationWorkspacePage', [], () => {
  const workspace = useAutomationWorkspace()
  return () => <AutomationEditor {...workspace.value} />
})
