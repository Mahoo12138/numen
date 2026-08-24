import type { FrontendExtensionRef } from '@numen/webui/extensions'
import type { SchemaUIResolver } from '@numen/webui/schema-ui'
import type {
  BrowserNavigateOptions,
  BrowserRouteState,
} from '@numen/webui/router'
import { CircleHelp, Clock3, Command, Play, Plus, Save, Search, Settings } from '@lucide/vue'
import { h, ref, shallowRef, watchEffect } from 'vue'
import { ActivityRail } from './ActivityRail.js'
import {
  activityIdForRoute,
  coreWorkbenchRoutes,
  type CoreWorkbenchActivityId,
} from './routes.js'
import './styles.css'
import type {
  WorkbenchConsoleClient,
  WorkbenchPageChromeProps,
  WorkbenchPageDefinition,
} from './types.js'
import { defineSetupComponent } from './vue-component.js'

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
  consoleClient?: WorkbenchConsoleClient
  schemaUI?: SchemaUIResolver
  standalonePages?: ReadonlyArray<WorkbenchPageDefinition>
}

function DefaultPageChrome({ page, consoleClient, schemaUI }: WorkbenchPageChromeProps) {
  const PageComponent = page.component
  return (
    <>
      <aside class="primary-sidebar simple-sidebar">
        <div class="sidebar-heading">{page.title.toUpperCase()}</div>
        <p>Browse {page.title.toLowerCase()} in the main workspace.</p>
      </aside>
      {h(PageComponent, { ...(consoleClient ? { consoleClient } : {}), ...(schemaUI ? { schemaUI } : {}) })}
    </>
  )
}

function NotFoundPageChrome({ pathname }: { pathname: string }) {
  return (
    <>
      <aside class="primary-sidebar simple-sidebar">
        <div class="sidebar-heading">NOT FOUND</div>
        <p>No Page matches the current URL.</p>
      </aside>
      <main class="main-workbench secondary-view activity-placeholder">
        <Command size={24} />
        <h1>Page not found</h1>
        <p>No registered Page matches {pathname}.</p>
      </main>
    </>
  )
}

export const WorkbenchShell = defineSetupComponent<WorkbenchShellProps>('WorkbenchShell', ['router', 'consoleClient', 'schemaUI', 'standalonePages'], props => {
  const standaloneActivityId = ref<CoreWorkbenchActivityId>('automations')
  const panelOpen = ref(false)
  const panelTab = ref('Problems')
  const inspectorOpen = ref(
    typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(min-width: 1280px)').matches
      : true
  )
  const routeState = shallowRef(props.router?.getSnapshot() ?? standaloneRouteState)

  watchEffect((onCleanup) => {
    const router = props.router
    if (!router) {
      routeState.value = standaloneRouteState
      return
    }
    routeState.value = router.getSnapshot()
    onCleanup(router.subscribe(() => { routeState.value = router.getSnapshot() }))
  })

  const onActivityChange = (nextActivityId: CoreWorkbenchActivityId) => {
    if (props.router) {
      props.router.navigate(coreWorkbenchRoutes[nextActivityId])
    } else {
      standaloneActivityId.value = nextActivityId
    }
  }

  return () => {
    const routedActivityId = activityIdForRoute(routeState.value.page)
    const activityId = props.router ? routedActivityId : standaloneActivityId.value
    const activePage = (props.router
      ? routeState.value.page
      : (props.standalonePages ?? []).find(page => activityIdForRoute(page) === standaloneActivityId.value)
    ) as WorkbenchPageDefinition | undefined
    const PageChrome = activePage?.chrome?.component ?? DefaultPageChrome
    const hasInspector = !!activePage?.chrome?.hasInspector
    const ownsPanel = !!activePage?.chrome?.ownsPanel
    const ownsStatus = !!activePage?.chrome?.ownsStatus
    return <div class="workbench-shell" data-inspector-open={hasInspector && inspectorOpen.value}>
      <header class="top-bar">
        <div class="brand"><span class="brand-mark">N</span><strong>Numen Workbench</strong></div>
        <label class="command-center">
          <Search aria-hidden="true" size={17} />
          <input aria-label="Command center" placeholder="Command center" />
          <kbd>⌘K</kbd>
        </label>
        <div class="top-actions">
          <button aria-label="Run automation" class="icon-button" type="button"><Play size={17} /></button>
          <button aria-label="Recent activity" class="icon-button" type="button"><Clock3 size={17} /></button>
          <button aria-label="Create" class="icon-button" type="button"><Plus size={18} /></button>
          <span class="top-divider" />
          <button aria-label="Settings" class="icon-button" type="button"><Settings size={17} /></button>
          <button aria-label="Help" class="icon-button" type="button"><CircleHelp size={17} /></button>
        </div>
      </header>
      <ActivityRail activeId={activityId} onChange={onActivityChange} />
      {activePage ? (
        h(PageChrome, {
          page: activePage,
          ...(props.consoleClient ? { consoleClient: props.consoleClient } : {}),
          ...(props.schemaUI ? { schemaUI: props.schemaUI } : {}),
          inspectorOpen: inspectorOpen.value,
          onInspectorOpenChange: (open: boolean) => { inspectorOpen.value = open },
        })
      ) : (
        <NotFoundPageChrome pathname={routeState.value.pathname} />
      )}
      {ownsPanel ? null : <section class="bottom-panel" data-open={panelOpen.value} aria-label="Bottom panel">
        <div class="panel-tablist" role="tablist">
          {panelTabs.map(tab => (
            <button
              aria-selected={panelTab.value === tab}
              data-active={panelTab.value === tab}
              key={tab}
              onClick={() => { panelTab.value = tab; panelOpen.value = true }}
              role="tab"
              type="button"
            >{tab}{tab === 'Problems' ? <span class="problem-count">1</span> : null}</button>
          ))}
          <button
            aria-label={panelOpen.value ? 'Collapse bottom panel' : 'Expand bottom panel'}
            class="panel-toggle"
            onClick={() => { panelOpen.value = !panelOpen.value }}
            type="button"
          >⌃</button>
        </div>
        {panelOpen.value ? <div class="panel-content">{panelTab.value} output will appear here.</div> : null}
      </section>}
      {ownsStatus ? null : <footer class="status-bar">
        <span class="ready-status"><span class="status-check">✓</span>Ready</span>
        <span><Save size={14} />Saved</span>
      </footer>}
      <button
        aria-label="Close inspector overlay"
        class="inspector-backdrop"
        data-open={hasInspector && inspectorOpen.value}
        onClick={() => { inspectorOpen.value = false }}
        type="button"
      />
    </div>
  }
})
