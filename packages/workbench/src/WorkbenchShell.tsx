import { PanelResizeHandle } from './PanelResizeHandle.js'
import { provideWorkbenchLayout } from './workbench-layout.js'
import { Button, SelectMenu, ResizeHandle } from '@numenjs/components'
import { LogsView } from './LogsView.js'
import { t, provideWorkbenchI18n } from './i18n.js'
import type { BrowserLocaleService } from '@numenjs/webui/i18n'
import type { FrontendExtensionRef } from '@numenjs/webui/extensions'
import type { SchemaUIResolver } from '@numenjs/webui/schema-ui'
import type {
  BrowserNavigateOptions,
  BrowserRouteState,
} from '@numenjs/webui/router'
import { Clock3, Command, Play, Plus, Search, Settings } from '@lucide/vue'
import { computed, h, onMounted, onScopeDispose, ref, shallowRef, watchEffect } from 'vue'
import { ActivityRail } from './ActivityRail.js'
import {
  activityIdForRoute,
  coreWorkbenchRoutes,
  type CoreWorkbenchActivityId,
} from './routes.js'
import '@vue-flow/core/dist/style.css'
import './styles.css'
import './graph-node-focus.css'
import './readonly-graph-canvas.css'
import type {
  WorkbenchConsoleClient,
  WorkbenchPageChromeProps,
  WorkbenchPageDefinition,
} from './types.js'
import { defineSetupComponent } from './vue-component.js'

import { CommandCenter } from './CommandCenter.js'
import { installCommandShortcuts, provideWorkbenchCommands, shortcutLabel } from './commands.js'
const standaloneRouteState: BrowserRouteState = {
  status: 'NOT_FOUND', pathname: '/', search: '', parameters: {},
}

export interface WorkbenchRouter {
  getSnapshot(): BrowserRouteState
  subscribe(listener: () => void): () => void
  navigate(ref: FrontendExtensionRef, options?: BrowserNavigateOptions): BrowserRouteState
  beforeLeave(guard: import('@numenjs/webui/router').BrowserNavigationGuard): () => void
}

export interface WorkbenchShellProps {
  localeService?: BrowserLocaleService
  router?: WorkbenchRouter
  consoleClient?: WorkbenchConsoleClient
  schemaUI?: SchemaUIResolver
  standalonePages?: ReadonlyArray<WorkbenchPageDefinition>
}

function DefaultPageChrome({ page, consoleClient, schemaUI, navigation }: WorkbenchPageChromeProps) {
  const PageComponent = page.component
  return h(PageComponent, {
    ...(consoleClient ? { consoleClient } : {}),
    ...(schemaUI ? { schemaUI } : {}),
    ...(navigation ? { navigation } : {}),
  })
}

function NotFoundPageChrome({ pathname }: { pathname: string }) {
  return (
    <main class="main-workbench secondary-view activity-placeholder">
      <Command size={24} />
      <h1>{t('workbench.pageNotFound')}</h1>
      <p>{t('workbench.noRegisteredPageMatches')}{pathname}.</p>
    </main>
  )
}

export const WorkbenchShell = defineSetupComponent<WorkbenchShellProps>('WorkbenchShell', ['localeService', 'router', 'consoleClient', 'schemaUI', 'standalonePages'], props => {
  const language = provideWorkbenchI18n(() => props.localeService)
  const { t } = language
  watchEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = language.locale.value
  })
  const standaloneActivityId = ref<CoreWorkbenchActivityId>('automations')
  const commandCenterOpen = ref(false)
  const commands = provideWorkbenchCommands()
  let removeShortcuts: (() => void) | undefined
  onMounted(() => { removeShortcuts = installCommandShortcuts(commands) })
  onScopeDispose(() => removeShortcuts?.())
  const inspectorOpen = ref(
    typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(min-width: 1280px)').matches
      : true
  )
  const routeState = shallowRef(props.router?.getSnapshot() ?? standaloneRouteState)
  const shell = ref<HTMLElement>()
  const currentPage = computed(() => (props.router
    ? routeState.value.page
    : (props.standalonePages ?? []).find(page => activityIdForRoute(page) === standaloneActivityId.value)
  ) as WorkbenchPageDefinition | undefined)
  // Command providers read page props. Keep this identity stable across command-state renders.
  const navigation = computed(() => props.router ? {
    route: routeState.value,
    navigate: props.router.navigate.bind(props.router),
    beforeLeave: props.router.beforeLeave.bind(props.router),
  } : undefined)
  // Existing extension chrome keeps its sidebar unless it explicitly opts out.
  const hasSidebar = computed(() => currentPage.value?.chrome?.hasSidebar ?? !!currentPage.value?.chrome?.component)
  const hasPanel = computed(() => currentPage.value?.chrome?.hasPanel
    ?? !!(currentPage.value?.chrome?.component || currentPage.value?.chrome?.ownsPanel))
  const hasStatus = computed(() => !!(currentPage.value?.chrome?.component || currentPage.value?.chrome?.ownsStatus))
  const layout = provideWorkbenchLayout(shell, inspectorOpen, hasSidebar, computed(() => !!currentPage.value?.chrome?.hasInspector))
  const sidebarExpanded = computed(() => hasSidebar.value && layout.sidebarOpen.value)
  const { panelOpen } = layout


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
    const activeActivity = props.router ? activityIdForRoute(routeState.value.page) : standaloneActivityId.value
    if (activeActivity === nextActivityId && hasSidebar.value && !layout.sidebarOpen.value) {
      layout.sidebarOpen.value = true
      return
    }
    if (nextActivityId === 'automations') layout.sidebarOpen.value = true
    if (props.router) {
      props.router.navigate(coreWorkbenchRoutes[nextActivityId])
    } else {
      standaloneActivityId.value = nextActivityId
    }
  }
  const commitResize = (key: 'sidebar' | 'inspector') => {
    layout.save()
    const open = key === 'sidebar' ? layout.sidebarOpen.value : inspectorOpen.value
    if (!open) shell.value?.querySelector<HTMLElement>(key === 'sidebar' ? '.activity-button[data-active="true"]' : '.mobile-inspector-button')?.focus({ preventScroll: true })
  }

  const removeCommands = commands.register(() => [
    { id: 'workbench.commandCenter', label: t('workbench.commandCenter'), shortcut: { mod: true, key: 'k' }, allowInInput: true, execute: () => { commandCenterOpen.value = true } },
    ...Object.keys(coreWorkbenchRoutes).map(id => ({ id: `workbench.open.${id}`, label: t('workbench.commands.openPage', { page: t(`workbench.navigation.${id}`) }), execute: () => onActivityChange(id as CoreWorkbenchActivityId) })),
    { id: 'workbench.panel', label: t('workbench.commands.togglePanel'), visible: hasPanel.value, shortcut: { mod: true, key: 'j' }, execute: () => { if (hasPanel.value) panelOpen.value = !panelOpen.value } },
    { id: 'workbench.sidebar', label: t('workbench.commands.toggleSidebar'), visible: hasSidebar.value, shortcut: { mod: true, key: 'b' }, execute: () => { if (hasSidebar.value) layout.sidebarOpen.value = !layout.sidebarOpen.value } },
    { id: 'workbench.inspector', label: t('workbench.commands.toggleInspector'), visible: !!currentPage.value?.chrome?.hasInspector, execute: () => { inspectorOpen.value = !inspectorOpen.value } },
    { id: 'automation.new', label: t('workbench.createAutomation'), shortcut: { mod: true, alt: true, key: 'n' }, ...(props.router && props.consoleClient ? {} : { disabledReason: t('workbench.commands.runtimeRequired') }), execute: () => { layout.sidebarOpen.value = true; props.router?.navigate(coreWorkbenchRoutes.automations, { query: { create: 1 } }) } },
  ])
  onScopeDispose(removeCommands)

  return () => {
    const routedActivityId = activityIdForRoute(routeState.value.page)
    const activityId = props.router ? routedActivityId : standaloneActivityId.value
    const activePage = currentPage.value
    const PageChrome = activePage?.chrome?.component ?? DefaultPageChrome
    const hasInspector = !!activePage?.chrome?.hasInspector
    const ownsPanel = !!activePage?.chrome?.ownsPanel
    const ownsStatus = !!activePage?.chrome?.ownsStatus
    return <div class="workbench-shell" ref={shell} data-has-sidebar={sidebarExpanded.value} data-inspector-open={hasInspector && inspectorOpen.value}
      style={{ '--wb-sidebar-width': `${layout.sizes.value.sidebar}px`, '--wb-inspector-width': `${layout.sizes.value.inspector}px`, '--wb-panel-height': `${layout.sizes.value.panel}px`, '--wb-status-height': hasStatus.value ? '24px' : '0px' }}>
      <header class="top-bar">
        <div class="brand"><span class="brand-mark">N</span><strong>Numen Workbench</strong></div>
        <button class="command-center" aria-label={t('workbench.commandCenter')} onClick={() => commands.execute('workbench.commandCenter')} type="button">
          <Search aria-hidden="true" size={17} /><span>{t('workbench.commandCenter')}</span><kbd>{shortcutLabel({ mod: true, key: 'k' })}</kbd>
        </button>
        <div class="top-actions">
          {props.localeService ? <label class="language-switcher">
            <span class="visually-hidden">{t('workbench.language')}</span>
            <SelectMenu ariaLabel={t('workbench.language')} value={language.preferredLocale.value ?? ''}
              onChange={value => language.setLocale(value || undefined)} options={[
                { value: '', label: t('workbench.systemLanguage') },
                { value: 'en-US', label: 'English' }, { value: 'zh-CN', label: '简体中文' },
              ]} />
          </label> : null}
          {commands.find('automation.testRun') ? <Button variant="ghost" size="icon" aria-label={t('workbench.testRun.title')} title={commands.find('automation.testRun')?.disabledReason} disabled={!!commands.find('automation.testRun')?.disabledReason} class="icon-button" onClick={() => commands.execute('automation.testRun')} type="button"><Play size={17} /></Button> : null}
          <Button variant="ghost" size="icon" aria-label={t('workbench.recentActivity')} class="icon-button" onClick={() => commands.execute('workbench.open.runs')} type="button"><Clock3 size={17} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('workbench.create')} title={commands.find('automation.new')?.disabledReason} disabled={!!commands.find('automation.new')?.disabledReason} class="icon-button" onClick={() => commands.execute('automation.new')} type="button"><Plus size={18} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('workbench.settings')} class="icon-button" onClick={() => commands.execute('workbench.open.system')} type="button"><Settings size={17} /></Button>
        </div>
      </header>
      <ActivityRail activeId={activityId} onChange={onActivityChange} />
      {activePage ? (
        h(PageChrome, {
          page: activePage,
          ...(props.consoleClient ? { consoleClient: props.consoleClient } : {}),
          ...(props.schemaUI ? { schemaUI: props.schemaUI } : {}),
          ...(navigation.value ? { navigation: navigation.value } : {}),
          inspectorOpen: inspectorOpen.value,
          onInspectorOpenChange: (open: boolean) => { inspectorOpen.value = open },
        })
      ) : (
        <NotFoundPageChrome pathname={routeState.value.pathname} />
      )}
      {hasSidebar.value && !layout.sizes.value.mobile ? <ResizeHandle class="sidebar-resize-handle" ariaLabel={t('workbench.resize.sidebar')}
        title={t('workbench.resize.hint')} axis="x" value={layout.sidebarOpen.value ? layout.sizes.value.sidebar : 0} min={180} max={layout.sizes.value.sidebarMax}
        collapsed={!layout.sidebarOpen.value} onCollapsedChange={collapsed => layout.setCollapsed('sidebar', collapsed)}
        onChange={value => layout.resize('sidebar', value)} onCommit={() => commitResize('sidebar')} onCancel={layout.cancel} onReset={() => layout.reset('sidebar')} /> : null}
      {hasInspector && !layout.sizes.value.mobile ? <ResizeHandle class="inspector-resize-handle"
        ariaLabel={t('workbench.resize.inspector')} title={t('workbench.resize.hint')} axis="x" direction={-1}
        value={inspectorOpen.value ? layout.sizes.value.inspector : 0} min={260} max={layout.sizes.value.inspectorMax}
        collapsed={!inspectorOpen.value} onCollapsedChange={collapsed => layout.setCollapsed('inspector', collapsed)}
        onChange={value => layout.resize('inspector', value)} onCommit={() => commitResize('inspector')} onCancel={layout.cancel} onReset={() => layout.reset('inspector')} /> : null}
      {ownsPanel || !hasPanel.value ? null : <section class="bottom-panel" data-open={panelOpen.value} aria-label={t('workbench.bottomPanel')}>
        <PanelResizeHandle />
        <div class="panel-tablist" role="tablist">
          <button aria-selected="true" data-active="true" onClick={() => { panelOpen.value = true }} role="tab" type="button">{t('workbench.tabs.Logs')}</button>
          <button
            aria-label={panelOpen.value ? t('workbench.collapseBottomPanel') : t('workbench.expandBottomPanel')}
            class="panel-toggle"
            onClick={() => commands.execute('workbench.panel')}
            type="button"
          >⌃</button>
        </div>
        {panelOpen.value ? <div class="panel-content logs-panel-content"><LogsView compact {...(props.consoleClient ? { consoleClient: props.consoleClient } : {})} /></div> : null}
      </section>}
      {ownsStatus || !hasStatus.value ? null : <footer class="status-bar"><span>{activePage ? activePage.titleKey ? t(activePage.titleKey) : activePage.title : t('workbench.notFound')}</span></footer>}
      <CommandCenter open={commandCenterOpen.value} registry={commands} onClose={() => { commandCenterOpen.value = false }} />
      <button
        aria-label={t('workbench.closeInspectorOverlay')}
        class="inspector-backdrop"
        data-open={hasInspector && inspectorOpen.value}
        onClick={() => { inspectorOpen.value = false }}
        type="button"
      />
    </div>
  }
})
