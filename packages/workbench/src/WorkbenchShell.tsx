import { t, provideWorkbenchI18n, pageTitle } from './i18n.js'
import type { BrowserLocaleService } from '@numen/webui/i18n'
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
  localeService?: BrowserLocaleService
  router?: WorkbenchRouter
  consoleClient?: WorkbenchConsoleClient
  schemaUI?: SchemaUIResolver
  standalonePages?: ReadonlyArray<WorkbenchPageDefinition>
}

function DefaultPageChrome({ page, consoleClient, schemaUI, navigation }: WorkbenchPageChromeProps) {
  const PageComponent = page.component
  return (
    <>
      <aside class="primary-sidebar simple-sidebar">
        <div class="sidebar-heading">{pageTitle(page)}</div>
        <p>{t('workbench.browsePage', { page: pageTitle(page) })}</p>
      </aside>
      {h(PageComponent, {
        ...(consoleClient ? { consoleClient } : {}),
        ...(schemaUI ? { schemaUI } : {}),
        ...(navigation ? { navigation } : {}),
      })}
    </>
  )
}

function NotFoundPageChrome({ pathname }: { pathname: string }) {
  return (
    <>
      <aside class="primary-sidebar simple-sidebar">
        <div class="sidebar-heading">{t('workbench.notFound')}</div>
        <p>{t('workbench.noPageMatchesTheCurrentUrl')}</p>
      </aside>
      <main class="main-workbench secondary-view activity-placeholder">
        <Command size={24} />
        <h1>{t('workbench.pageNotFound')}</h1>
        <p>{t('workbench.noRegisteredPageMatches')}{pathname}.</p>
      </main>
    </>
  )
}

export const WorkbenchShell = defineSetupComponent<WorkbenchShellProps>('WorkbenchShell', ['localeService', 'router', 'consoleClient', 'schemaUI', 'standalonePages'], props => {
  const language = provideWorkbenchI18n(() => props.localeService)
  const { t } = language
  watchEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = language.locale.value
  })
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
    const navigation = props.router ? {
      route: routeState.value,
      navigate: props.router.navigate.bind(props.router),
    } : undefined
    return <div class="workbench-shell" data-inspector-open={hasInspector && inspectorOpen.value}>
      <header class="top-bar">
        <div class="brand"><span class="brand-mark">N</span><strong>Numen Workbench</strong></div>
        <label class="command-center">
          <Search aria-hidden="true" size={17} />
          <input aria-label={t('workbench.commandCenter')} placeholder={t('workbench.commandCenter')} />
          <kbd>⌘K</kbd>
        </label>
        <div class="top-actions">
          {props.localeService ? <label class="language-switcher">
            <span class="visually-hidden">{t('workbench.language')}</span>
            <select aria-label={t('workbench.language')} value={language.preferredLocale.value ?? ''}
              onChange={event => language.setLocale((event.target as HTMLSelectElement).value || undefined)}>
              <option value="">{t('workbench.systemLanguage')}</option>
              <option value="en-US">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label> : null}
          <button aria-label={t('workbench.runAutomation')} class="icon-button" type="button"><Play size={17} /></button>
          <button aria-label={t('workbench.recentActivity')} class="icon-button" type="button"><Clock3 size={17} /></button>
          <button aria-label={t('workbench.create')} class="icon-button" type="button"><Plus size={18} /></button>
          <span class="top-divider" />
          <button aria-label={t('workbench.settings')} class="icon-button" type="button"><Settings size={17} /></button>
          <button aria-label={t('workbench.help')} class="icon-button" type="button"><CircleHelp size={17} /></button>
        </div>
      </header>
      <ActivityRail activeId={activityId} onChange={onActivityChange} />
      {activePage ? (
        h(PageChrome, {
          page: activePage,
          ...(props.consoleClient ? { consoleClient: props.consoleClient } : {}),
          ...(props.schemaUI ? { schemaUI: props.schemaUI } : {}),
          ...(navigation ? { navigation } : {}),
          inspectorOpen: inspectorOpen.value,
          onInspectorOpenChange: (open: boolean) => { inspectorOpen.value = open },
        })
      ) : (
        <NotFoundPageChrome pathname={routeState.value.pathname} />
      )}
      {ownsPanel ? null : <section class="bottom-panel" data-open={panelOpen.value} aria-label={t('workbench.bottomPanel')}>
        <div class="panel-tablist" role="tablist">
          {panelTabs.map(tab => (
            <button
              aria-selected={panelTab.value === tab}
              data-active={panelTab.value === tab}
              key={tab}
              onClick={() => { panelTab.value = tab; panelOpen.value = true }}
              role="tab"
              type="button"
            >{t(`workbench.tabs.${tab}`)}{tab === 'Problems' ? <span class="problem-count">1</span> : null}</button>
          ))}
          <button
            aria-label={panelOpen.value ? t('workbench.collapseBottomPanel') : t('workbench.expandBottomPanel')}
            class="panel-toggle"
            onClick={() => { panelOpen.value = !panelOpen.value }}
            type="button"
          >⌃</button>
        </div>
        {panelOpen.value ? <div class="panel-content">{t('workbench.panelOutput', { panel: t(`workbench.tabs.${panelTab.value}`) })}</div> : null}
      </section>}
      {ownsStatus ? null : <footer class="status-bar">
        <span class="ready-status"><span class="status-check">✓</span>{t('workbench.ready')}</span>
        <span><Save size={14} />{t('workbench.saved')}</span>
      </footer>}
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
