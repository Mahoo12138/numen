import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { AutomationEditor, type AutomationEditorProps } from './AutomationEditor.js'
import { AutomationPanel, AutomationStatusBar } from './AutomationPanel.js'
import { AutomationSidebar } from './AutomationSidebar.js'
import { projectAutomationSteps } from './automation-projection.js'
import {
  workbenchAutomationDetailQueryRef,
  workbenchAutomationsIndexQueryRef,
  type WorkbenchAutomationDetail,
  type WorkbenchAutomationDetailQueryInput,
  type WorkbenchAutomationsIndex,
} from './contracts.js'
import { Inspector } from './Inspector.js'
import type { WorkbenchPageChromeProps } from './types.js'
import { useAutomationDraftDocument } from './useAutomationDraftDocument.js'
import { useConsoleQuery, type ConsoleQueryState } from './useConsoleQuery.js'

const emptyQueryInput: Record<string, never> = {}

const AutomationWorkspaceContext = createContext<AutomationEditorProps | undefined>(undefined)

export function useAutomationWorkspace(): AutomationEditorProps {
  const workspace = useContext(AutomationWorkspaceContext)
  if (!workspace) throw new Error('Automation Page must render inside AutomationPageChrome')
  return workspace
}

export function AutomationPageChrome({
  page,
  consoleClient,
  inspectorOpen,
  onInspectorOpenChange,
}: WorkbenchPageChromeProps) {
  const [requestedAutomationId, setRequestedAutomationId] = useState('morning-brief')
  const [activeTab, setActiveTab] = useState('Editor')
  const [requestedStepId, setRequestedStepId] = useState('notification')
  const [indexState, reloadIndex] = useConsoleQuery<Record<string, never>, WorkbenchAutomationsIndex>(
    consoleClient,
    workbenchAutomationsIndexQueryRef,
    emptyQueryInput,
    'automations',
  )
  const liveItems = indexState.status === 'READY' ? indexState.data.items : []
  const automationId = consoleClient
    ? (liveItems.some(item => item.id === requestedAutomationId) ? requestedAutomationId : liveItems[0]?.id)
    : requestedAutomationId
  const detailInput = useMemo<WorkbenchAutomationDetailQueryInput>(() => ({
    automationId: automationId ?? '',
  }), [automationId])
  const [queriedDetailState, reloadDetail] = useConsoleQuery<WorkbenchAutomationDetailQueryInput, WorkbenchAutomationDetail | null>(
    consoleClient && automationId ? consoleClient : undefined,
    workbenchAutomationDetailQueryRef,
    detailInput,
    'automations',
  )
  const detailState = useMemo<ConsoleQueryState<WorkbenchAutomationDetail | null> | undefined>(() => {
    if (!consoleClient) return undefined
    if (automationId) return queriedDetailState.status === 'DISABLED' ? { status: 'LOADING' } : queriedDetailState
    if (indexState.status === 'ERROR') return indexState
    if (indexState.status === 'READY') return { status: 'READY', data: null }
    return { status: 'LOADING' }
  }, [automationId, consoleClient, indexState, queriedDetailState])
  const detail = detailState?.status === 'READY' && detailState.data?.automation.id === automationId
    ? detailState.data ?? undefined
    : undefined
  const authoring = useAutomationDraftDocument({
    ...(consoleClient ? { client: consoleClient } : {}),
    ...(automationId ? { automationId } : {}),
    ...(detail ? { detail } : {}),
    reloadDetail,
  })
  const effectiveDetail = useMemo<WorkbenchAutomationDetail | undefined>(() => {
    if (!detail || authoring.document?.automationId !== detail.automation.id) return detail
    const document = authoring.document
    return {
      ...detail,
      draft: {
        source: document.source,
        presentation: document.presentation,
        version: document.version,
        updatedAt: document.updatedAt,
        ...(document.baseRevisionId ? { baseRevisionId: document.baseRevisionId } : {}),
      },
    }
  }, [authoring.document, detail])
  const effectiveDetailState = useMemo<ConsoleQueryState<WorkbenchAutomationDetail | null> | undefined>(() => {
    if (detailState?.status !== 'READY' || !detailState.data || !effectiveDetail) return detailState
    return { status: 'READY', data: effectiveDetail }
  }, [detailState, effectiveDetail])
  const steps = useMemo(() => effectiveDetail ? projectAutomationSteps(effectiveDetail.draft.source) : [], [effectiveDetail])
  const activeStepId = consoleClient
    ? (steps.some(step => step.id === requestedStepId) ? requestedStepId : steps[0]?.id ?? '')
    : requestedStepId
  const workspace = useMemo<AutomationEditorProps>(() => ({
    ...(automationId ? { automationId } : {}),
    activeStepId,
    activeTab,
    ...(effectiveDetailState ? { detailState: effectiveDetailState } : {}),
    ...(consoleClient ? { steps } : {}),
    ...(consoleClient ? { automations: liveItems, onAutomationChange: setRequestedAutomationId } : {}),
    ...(consoleClient ? {
      authoring: {
        savePhase: authoring.savePhase,
        saveMessage: authoring.saveMessage,
        canEdit: authoring.canEdit,
        canPublish: authoring.canPublish,
        publishPending: authoring.publishPending,
        problemCount: authoring.problems.length,
        ...(authoring.conflict ? { conflict: authoring.conflict } : {}),
        ...(authoring.saveError ? { saveError: authoring.saveError } : {}),
        ...(authoring.publishError ? { publishError: authoring.publishError } : {}),
      },
      onAddWaitStep: authoring.addWaitStep,
      onPublish: authoring.publish,
      onReloadDraft: authoring.reload,
      onRetrySave: authoring.retrySave,
    } : {}),
    onOpenInspector: () => onInspectorOpenChange(true),
    onStepChange: id => {
      setRequestedStepId(id)
      onInspectorOpenChange(true)
    },
    onTabChange: setActiveTab,
    onReload: reloadDetail,
  }), [
    activeStepId,
    activeTab,
    automationId,
    authoring,
    consoleClient,
    effectiveDetailState,
    liveItems,
    onInspectorOpenChange,
    reloadDetail,
    steps,
  ])
  const selectProblem = useCallback((nodeId: string) => {
    const step = steps.find(item => item.sourceId === nodeId)
    if (!step) return
    setRequestedStepId(step.id)
    onInspectorOpenChange(true)
  }, [onInspectorOpenChange, steps])
  const PageComponent = page.component

  return (
    <AutomationWorkspaceContext.Provider value={workspace}>
      <AutomationSidebar
        {...(automationId ? { activeId: automationId } : {})}
        onChange={setRequestedAutomationId}
        onReload={reloadIndex}
        state={indexState}
      />
      <PageComponent {...(consoleClient ? { consoleClient } : {})} />
      <Inspector
        activeStepId={activeStepId}
        open={inspectorOpen}
        {...(consoleClient ? { steps } : {})}
        onClose={() => onInspectorOpenChange(false)}
      />
      <AutomationPanel
        problems={authoring.problems}
        preview={!consoleClient}
        onProblemSelect={selectProblem}
      />
      <AutomationStatusBar
        message={authoring.saveMessage}
        phase={authoring.savePhase}
        problemCount={authoring.problems.length}
        preview={!consoleClient}
      />
    </AutomationWorkspaceContext.Provider>
  )
}

export function AutomationWorkspacePage() {
  return <AutomationEditor {...useAutomationWorkspace()} />
}
