import { createContext, useContext, useMemo, useState } from 'react'
import { AutomationEditor, type AutomationEditorProps } from './AutomationEditor.js'
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
    ? detailState.data
    : undefined
  const steps = useMemo(() => detail ? projectAutomationSteps(detail.draft.source) : [], [detail])
  const activeStepId = consoleClient
    ? (steps.some(step => step.id === requestedStepId) ? requestedStepId : steps[0]?.id ?? '')
    : requestedStepId
  const workspace = useMemo<AutomationEditorProps>(() => ({
    ...(automationId ? { automationId } : {}),
    activeStepId,
    activeTab,
    ...(detailState ? { detailState } : {}),
    ...(consoleClient ? { steps } : {}),
    ...(consoleClient ? { automations: liveItems, onAutomationChange: setRequestedAutomationId } : {}),
    onOpenInspector: () => onInspectorOpenChange(true),
    onStepChange: id => {
      setRequestedStepId(id)
      onInspectorOpenChange(true)
    },
    onTabChange: setActiveTab,
    onReload: reloadDetail,
  }), [activeStepId, activeTab, automationId, consoleClient, detailState, liveItems, onInspectorOpenChange, reloadDetail, steps])
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
    </AutomationWorkspaceContext.Provider>
  )
}

export function AutomationWorkspacePage() {
  return <AutomationEditor {...useAutomationWorkspace()} />
}
