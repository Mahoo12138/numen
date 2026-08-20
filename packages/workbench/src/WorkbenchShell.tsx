import type {
  FrontendExtensionRef,
  FrontendPage,
} from '@numen/webui/extensions'
import type {
  BrowserNavigateOptions,
  BrowserRouteState,
} from '@numen/webui/router'
import { CircleHelp, Clock3, Command, Play, Plus, Save, Search, Settings } from 'lucide-react'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { ActivityRail } from './ActivityRail.js'
import { AutomationSidebar } from './AutomationSidebar.js'
import { Inspector } from './Inspector.js'
import {
  corePageForActivity,
  type WorkbenchPageComponent,
} from './pages.js'
import {
  activityIdForRoute,
  coreWorkbenchRoutes,
  type CoreWorkbenchActivityId,
} from './routes.js'
import './styles.css'

const panelTabs = ['Problems', 'Preview', 'Logs'] as const
const standaloneRouteState: BrowserRouteState = {
  status: 'NOT_FOUND', pathname: '/', search: '', parameters: {},
}

export interface WorkbenchRouter {
  getSnapshot(): BrowserRouteState
  subscribe(listener: () => void): () => void
  navigate(ref: FrontendExtensionRef, options?: BrowserNavigateOptions): BrowserRouteState
}

export interface WorkbenchShellProps {
  router?: WorkbenchRouter
}

export function WorkbenchShell({ router }: WorkbenchShellProps = {}) {
  const [standaloneActivityId, setStandaloneActivityId] = useState<CoreWorkbenchActivityId>('automations')
  const [automationId, setAutomationId] = useState('morning-brief')
  const [activeTab, setActiveTab] = useState('Editor')
  const [stepId, setStepId] = useState('notification')
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState('Problems')
  const [inspectorOpen, setInspectorOpen] = useState(() => (
    typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(min-width: 1280px)').matches
      : true
  ))
  const subscribe = useCallback((listener: () => void) => (
    router?.subscribe(listener) ?? (() => {})
  ), [router])
  const getSnapshot = useCallback(() => router?.getSnapshot() ?? standaloneRouteState, [router])
  const routeState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const routedActivityId = activityIdForRoute(routeState.page)
  const activityId = router ? routedActivityId : standaloneActivityId
  const isAutomations = activityId === 'automations'
  const activePage = (router
    ? routeState.page
    : corePageForActivity(standaloneActivityId)) as FrontendPage<WorkbenchPageComponent> | undefined
  const PageComponent = activePage?.component
  const onActivityChange = useCallback((nextActivityId: CoreWorkbenchActivityId) => {
    if (router) {
      router.navigate(coreWorkbenchRoutes[nextActivityId])
    } else {
      setStandaloneActivityId(nextActivityId)
    }
    if (nextActivityId === 'automations') {
      setInspectorOpen(
        typeof globalThis.matchMedia !== 'function'
        || globalThis.matchMedia('(min-width: 1280px)').matches,
      )
    }
  }, [router])

  return (
    <div className="workbench-shell" data-inspector-open={isAutomations && inspectorOpen}>
      <header className="top-bar">
        <div className="brand"><span className="brand-mark">N</span><strong>Numen Workbench</strong></div>
        <label className="command-center">
          <Search aria-hidden="true" size={17} />
          <input aria-label="Command center" placeholder="Command center" />
          <kbd>⌘K</kbd>
        </label>
        <div className="top-actions">
          <button aria-label="Run automation" className="icon-button" type="button"><Play size={17} /></button>
          <button aria-label="Recent activity" className="icon-button" type="button"><Clock3 size={17} /></button>
          <button aria-label="Create" className="icon-button" type="button"><Plus size={18} /></button>
          <span className="top-divider" />
          <button aria-label="Settings" className="icon-button" type="button"><Settings size={17} /></button>
          <button aria-label="Help" className="icon-button" type="button"><CircleHelp size={17} /></button>
        </div>
      </header>
      <ActivityRail activeId={activityId} onChange={onActivityChange} />
      {isAutomations ? (
        <AutomationSidebar activeId={automationId} onChange={setAutomationId} />
      ) : (
        <aside className="primary-sidebar simple-sidebar">
          <div className="sidebar-heading">{activePage?.title.toUpperCase() ?? 'NOT FOUND'}</div>
          <p>{activePage ? `Browse ${activePage.title.toLowerCase()} in the main workspace.` : 'No Page matches the current URL.'}</p>
        </aside>
      )}
      {PageComponent ? (
        <PageComponent
          automationId={automationId}
          activeStepId={stepId}
          activeTab={activeTab}
          onOpenInspector={() => setInspectorOpen(true)}
          onStepChange={(id) => { setStepId(id); setInspectorOpen(true) }}
          onTabChange={setActiveTab}
        />
      ) : (
        <main className="main-workbench secondary-view activity-placeholder">
          <Command size={24} />
          <h1>Page not found</h1>
          <p>No registered Page matches {routeState.pathname}.</p>
        </main>
      )}
      <Inspector activeStepId={stepId} open={isAutomations && inspectorOpen} onClose={() => setInspectorOpen(false)} />
      <section className="bottom-panel" data-open={panelOpen} aria-label="Bottom panel">
        <div className="panel-tablist" role="tablist">
          {panelTabs.map(tab => (
            <button
              aria-selected={panelTab === tab}
              data-active={panelTab === tab}
              key={tab}
              onClick={() => { setPanelTab(tab); setPanelOpen(true) }}
              role="tab"
              type="button"
            >{tab}{tab === 'Problems' ? <span className="problem-count">1</span> : null}</button>
          ))}
          <button
            aria-label={panelOpen ? 'Collapse bottom panel' : 'Expand bottom panel'}
            className="panel-toggle"
            onClick={() => setPanelOpen(value => !value)}
            type="button"
          >⌃</button>
        </div>
        {panelOpen ? <div className="panel-content">{panelTab} output will appear here.</div> : null}
      </section>
      <footer className="status-bar">
        <span className="ready-status"><span className="status-check">✓</span>Ready</span>
        <span><Save size={14} />Saved</span>
      </footer>
      <button
        aria-label="Close inspector overlay"
        className="inspector-backdrop"
        data-open={inspectorOpen}
        onClick={() => setInspectorOpen(false)}
        type="button"
      />
    </div>
  )
}
