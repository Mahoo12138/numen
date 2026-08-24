import type { SourceRef } from '@numen/core'
import { computed, h, inject, provide, ref, type ComputedRef, type InjectionKey } from 'vue'
import { AutomationEditor, type AutomationEditorProps } from './AutomationEditor.js'
import { AutomationPanel, AutomationStatusBar } from './AutomationPanel.js'
import { AutomationSidebar } from './AutomationSidebar.js'
import { projectAutomationSteps } from './automation-projection.js'
import {
  workbenchAutomationDetailQueryRef,
  workbenchAutomationInsertCatalogQueryRef,
  workbenchAutomationsIndexQueryRef,
  type WorkbenchAutomationDetail,
  type WorkbenchAutomationDetailQueryInput,
  type WorkbenchAutomationInsertCatalog,
  type WorkbenchAutomationsIndex,
} from './contracts.js'
import { Inspector, type InspectorFieldFocus } from './Inspector.js'
import type { WorkbenchPageChromeProps } from './types.js'
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

export const AutomationPageChrome = defineSetupComponent<WorkbenchPageChromeProps>('AutomationPageChrome', ['page', 'consoleClient', 'schemaUI', 'inspectorOpen', 'onInspectorOpenChange'], props => {
  const requestedAutomationId = ref('morning-brief')
  const activeTab = ref('Editor')
  const requestedStepId = ref('notification')
  const fieldFocus = ref<InspectorFieldFocus>()
  const [indexState, reloadIndex] = useConsoleQuery<Record<string, never>, WorkbenchAutomationsIndex>(
    () => props.consoleClient,
    workbenchAutomationsIndexQueryRef,
    emptyQueryInput,
    'automations',
  )
  const [insertCatalogState, reloadInsertCatalog] = useConsoleQuery<Record<string, never>, WorkbenchAutomationInsertCatalog>(
    () => props.consoleClient,
    workbenchAutomationInsertCatalogQueryRef,
    emptyQueryInput,
    'automationCatalog',
  )
  const liveItems = computed(() => indexState.status === 'READY' ? indexState.data.items : [])
  const automationId = computed(() => props.consoleClient
    ? (liveItems.value.some(item => item.id === requestedAutomationId.value) ? requestedAutomationId.value : liveItems.value[0]?.id)
    : requestedAutomationId.value)
  const detailInput = computed<WorkbenchAutomationDetailQueryInput>(() => ({
    automationId: automationId.value ?? '',
  }))
  const [queriedDetailState, reloadDetail] = useConsoleQuery<WorkbenchAutomationDetailQueryInput, WorkbenchAutomationDetail | null>(
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
  const authoring = useAutomationDraftDocument({
    client: () => props.consoleClient,
    automationId,
    detail,
    reloadDetail,
  })
  const effectiveDetail = computed<WorkbenchAutomationDetail | undefined>(() => {
    const currentDetail = detail.value
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
  const capabilityTitles = computed(() => new Map(
    insertCatalogState.status === 'READY'
      ? insertCatalogState.data.items.flatMap(item => item.kind === 'capability'
        ? [[`${item.capability.id}@${item.capability.version}`, item.title] as const]
        : [])
      : [],
  ))
  const steps = computed(() => (
    effectiveDetail.value ? projectAutomationSteps(effectiveDetail.value.draft.source, authoring.problems, capabilityTitles.value) : []
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
    ...(effectiveDetailState.value ? { detailState: effectiveDetailState.value } : {}),
    ...(props.consoleClient ? { insertCatalogState } : {}),
    ...(props.consoleClient ? { steps: steps.value } : {}),
    ...(props.consoleClient ? {
      automations: liveItems.value,
      onAutomationChange: (id: string) => { requestedAutomationId.value = id },
    } : {}),
    ...(props.consoleClient ? {
      authoring: {
        canEdit: authoring.canEdit,
        canPublish: authoring.canPublish,
        canUndo: authoring.canUndo,
        canRedo: authoring.canRedo,
        publishPending: authoring.publishPending,
        ...(authoring.conflict ? { conflict: authoring.conflict } : {}),
        ...(authoring.saveError ? { saveError: authoring.saveError } : {}),
        ...(authoring.publishError ? { publishError: authoring.publishError } : {}),
      },
      onInsert: authoring.insert,
      onReloadInsertCatalog: reloadInsertCatalog,
      onUndo: authoring.undo,
      onRedo: authoring.redo,
      onPublish: authoring.publish,
      onReloadDraft: authoring.reload,
      onRetrySave: authoring.retrySave,
    } : {}),
    onOpenInspector: () => props.onInspectorOpenChange(true),
    onStepChange: id => {
      const step = steps.value.find(item => item.id === id)
      if (props.consoleClient) authoring.selectNode(step?.sourceId)
      else requestedStepId.value = id
      fieldFocus.value = undefined
      props.onInspectorOpenChange(true)
    },
    onTabChange: tab => { activeTab.value = tab },
    onReload: reloadDetail,
  }))
  provide(automationWorkspaceKey, workspace)

  const selectProblem = (sourceRef: SourceRef) => {
    const nodeId = sourceRef.nodeId
    if (!nodeId) return
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
        onReload={reloadIndex}
        state={indexState}
      />
      {h(PageComponent, { ...(props.consoleClient ? { consoleClient: props.consoleClient } : {}), ...(props.schemaUI ? { schemaUI: props.schemaUI } : {}) })}
      <Inspector
        activeStepId={activeStepId.value}
        canEdit={authoring.canEdit}
        {...(insertCatalogState.status === 'READY' ? { catalog: insertCatalogState.data } : {})}
        {...(fieldFocus.value ? { fieldFocus: fieldFocus.value } : {})}
        open={props.inspectorOpen}
        problems={authoring.problems}
        {...(authoring.document ? { source: authoring.document.source } : {})}
        {...(props.consoleClient ? { steps: steps.value } : {})}
        onClose={() => props.onInspectorOpenChange(false)}
        onCapabilityConnectionChange={authoring.setCapabilityConnection}
        onCapabilityInputChange={authoring.setCapabilityInput}
        onWaitDurationChange={authoring.setWaitDuration}
        {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
      />
      <AutomationPanel
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
