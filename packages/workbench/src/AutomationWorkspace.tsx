import { AutomationInputs } from './AutomationInputs.js'
import { localizeCatalogItem, useWorkbenchI18n } from './i18n.js'
import { AutomationRuns } from './AutomationRuns.js'
import type { SourceRef } from '@numenjs/core'
import { computed, h, inject, onScopeDispose, provide, ref, watch, type ComputedRef, type InjectionKey } from 'vue'
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

const emptyQueryInput: Record<string, never> = {}

const automationWorkspaceKey: InjectionKey<ComputedRef<AutomationEditorProps>> = Symbol('automation-workspace')

export function useAutomationWorkspace(): ComputedRef<AutomationEditorProps> {
  const workspace = inject(automationWorkspaceKey)
  if (!workspace) throw new Error('Automation Page must render inside AutomationPageChrome')
  return workspace
}

export const AutomationPageChrome = defineSetupComponent<WorkbenchPageChromeProps>('AutomationPageChrome', ['page', 'consoleClient', 'schemaUI', 'navigation', 'inspectorOpen', 'onInspectorOpenChange'], props => {
  const { t } = useWorkbenchI18n()
  const confirmedAutomationId = ref<string>()
  const requestedAutomationId = ref('morning-brief')
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
  const archiveAutomation = (automationIdTarget: string, expectedActivationGeneration: number) => runLifecycleAction<WorkbenchArchiveAutomationInput, { automationId: string }>(
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
  const editable = computed(() => !archived.value && !lifecyclePending.value)
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
    ...(effectiveDetailState.value ? { detailState: effectiveDetailState.value } : {}),
    ...(props.consoleClient ? { insertCatalogState: localizedCatalogState.value } : {}),
    ...(props.consoleClient ? { steps: steps.value } : {}),
    ...(props.consoleClient ? {
      automations: liveItems.value,
      onAutomationChange: (id: string) => { requestedAutomationId.value = id },
    } : {}),
    ...(props.consoleClient ? {
      authoring: {
        canEdit: editable.value && authoring.canEdit,
        canPublish: editable.value && authoring.canPublish,
        canUndo: editable.value && authoring.canUndo,
        canRedo: editable.value && authoring.canRedo,
        publishPending: authoring.publishPending,
        ...(authoring.conflict ? { conflict: authoring.conflict } : {}),
        ...(authoring.saveError ? { saveError: authoring.saveError } : {}),
        ...(authoring.publishError ? { publishError: authoring.publishError } : {}),
      },
      ...(editable.value ? { onInsert: authoring.insert } : {}),
      ...(editable.value ? { onDeleteStep: authoring.deleteStep, onMoveStep: authoring.moveStep } : {}),
      onReloadInsertCatalog: reloadInsertCatalog,
      ...(editable.value ? { onUndo: authoring.undo, onRedo: authoring.redo, onPublish: authoring.publish } : {}),
      onReloadDraft: authoring.reload,
      ...(editable.value ? { onRetrySave: authoring.retrySave } : {}),
    } : {}),
    ...(props.consoleClient && authoring.document ? {
      inputSettings: h(AutomationInputs, { inputs: authoring.document.source.inputs, canEdit: editable.value && authoring.canEdit, problems: authoring.problems, onChange: inputs => { if (editable.value) authoring.setAutomationInputs(inputs) }, ...(props.schemaUI ? { schemaUI: props.schemaUI } : {}) }),
      manualRunForm: h(AutomationRuns, { key: authoring.document.automationId, automationId: authoring.document.automationId, archived: archived.value, consoleClient: props.consoleClient, ...(props.schemaUI ? { schemaUI: props.schemaUI } : {}), ...(props.navigation ? { navigation: props.navigation } : {}) }),
    } : {}),
    ...(props.consoleClient && authoring.document && authoring.conflict ? {
      conflictRecovery: h(DraftConflictRecovery, {
        key: authoring.document.automationId,
        client: props.consoleClient, document: authoring.document, conflict: authoring.conflict,
        name: effectiveDetail.value?.automation.name ?? 'Automation',
        onReload: authoring.reload,
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
      const step = steps.value.find(item => item.id === id)
      if (props.consoleClient) authoring.selectNode(step?.sourceId)
      else requestedStepId.value = id
      fieldFocus.value = undefined
      props.onInspectorOpenChange(true)
    },
    onTabChange: tab => { activeTab.value = tab; if (tab !== 'Editor') props.onInspectorOpenChange(false) },
    onReload: reloadDetail,
  }))
  provide(automationWorkspaceKey, workspace)

  const selectProblem = (sourceRef: SourceRef) => {
    const nodeId = sourceRef.nodeId
    if (!nodeId) return
    if (nodeId === '__inputs') { activeTab.value = 'Settings'; props.onInspectorOpenChange(false); return }
    const step = steps.value.find(item => item.sourceId === nodeId)
    if (!step) return
    authoring.selectNode(nodeId)
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
        {...(automationId.value ? { activeId: automationId.value } : {})}
        onChange={id => { requestedAutomationId.value = id }}
        onOpen={(id, tab) => {
          requestedAutomationId.value = id
          activeTab.value = tab
          if (tab !== 'Editor') props.onInspectorOpenChange(false)
        }}
        onCreate={createAutomation}
        onCreateDismiss={() => { createAutomationError.value = undefined }}
        onReload={reloadIndex}
        {...(createAutomationError.value ? { createError: createAutomationError.value } : {})}
        creating={creatingAutomation.value}
        state={indexState}
        onArchiveViewChange={archived => { archiveView.value = archived; lifecycleError.value = undefined }}
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
      />
    </>
  }
})

export const AutomationWorkspacePage = defineSetupComponent<import('./types.js').WorkbenchPageProps>('AutomationWorkspacePage', [], () => {
  const workspace = useAutomationWorkspace()
  return () => <AutomationEditor {...workspace.value} />
})
