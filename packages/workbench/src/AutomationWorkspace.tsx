import { createContext, useContext, useMemo, useState } from 'react'
import { AutomationEditor, type AutomationEditorProps } from './AutomationEditor.js'
import { AutomationSidebar } from './AutomationSidebar.js'
import { Inspector } from './Inspector.js'
import type { WorkbenchPageChromeProps } from './types.js'

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
  const [automationId, setAutomationId] = useState('morning-brief')
  const [activeTab, setActiveTab] = useState('Editor')
  const [activeStepId, setActiveStepId] = useState('notification')
  const workspace = useMemo<AutomationEditorProps>(() => ({
    automationId,
    activeStepId,
    activeTab,
    onOpenInspector: () => onInspectorOpenChange(true),
    onStepChange: id => {
      setActiveStepId(id)
      onInspectorOpenChange(true)
    },
    onTabChange: setActiveTab,
  }), [activeStepId, activeTab, automationId, onInspectorOpenChange])
  const PageComponent = page.component

  return (
    <AutomationWorkspaceContext.Provider value={workspace}>
      <AutomationSidebar activeId={automationId} onChange={setAutomationId} />
      <PageComponent {...(consoleClient ? { consoleClient } : {})} />
      <Inspector
        activeStepId={activeStepId}
        open={inspectorOpen}
        onClose={() => onInspectorOpenChange(false)}
      />
    </AutomationWorkspaceContext.Provider>
  )
}

export function AutomationWorkspacePage() {
  return <AutomationEditor {...useAutomationWorkspace()} />
}
