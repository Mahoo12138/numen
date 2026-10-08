import { Button, StatePanel } from '@numenjs/components'
import { Activity, CircleAlert, CircleCheck, CircleOff, ScrollText, Settings } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { diagnosticText, formatDateTime, t } from './i18n.js'
import { LogsView } from './LogsView.js'
import { workbenchSystemQueryRef, type WorkbenchSystemOverview } from './management-contracts.js'
import { coreWorkbenchRoutes, coreWorkbenchRunFlowRoute } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

export const SystemPage = defineSetupComponent<WorkbenchPageProps>('SystemPage', ['consoleClient', 'navigation'], props => {
  const [state, reload] = useConsoleQuery<Record<string, never>, WorkbenchSystemOverview>(() => props.consoleClient, workbenchSystemQueryRef, {})
  const filter = computed(() => new URLSearchParams(props.navigation?.route.search ?? ''))
  const views = ['health', 'logs'] as const
  type SystemView = typeof views[number]
  const localView = ref<SystemView>('health')
  const activeView = computed<SystemView>(() => {
    if (!props.navigation) return localView.value
    const explicitView = filter.value.get('view')
    if (explicitView !== null) return explicitView === 'logs' ? 'logs' : 'health'
    return filter.value.get('runId') || filter.value.get('connectionId') ? 'logs' : 'health'
  })
  const logsVisited = ref(activeView.value === 'logs')
  watch(activeView, view => { if (view === 'logs') logsVisited.value = true }, { flush: 'sync' })
  const selectView = (view: SystemView) => {
    if (view === activeView.value) return
    if (!props.navigation) {
      localView.value = view
      return
    }
    props.navigation.navigate(coreWorkbenchRoutes.system, { query: { ...Object.fromEntries(filter.value), view } })
  }
  const onTabKeydown = (event: KeyboardEvent, view: SystemView) => {
    const index = views.indexOf(view)
    const next = event.key === 'ArrowRight' ? (index + 1) % views.length
      : event.key === 'ArrowLeft' ? (index + views.length - 1) % views.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    selectView(views[next]!)
    const tabs = (event.currentTarget as HTMLButtonElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs?.[next]?.focus()
  }
  return () => <main class="main-workbench core-page system-logs-page">
    <header class="core-page-header core-page-header-with-actions"><Settings size={22} /><div class="core-page-heading"><h1>{t('workbench.system')}</h1>{activeView.value === 'health' ? <p>{t('workbench.systemHealth.description')}</p> : null}</div>{activeView.value === 'health' ? <div class="core-page-actions"><Button variant="secondary" type="button" onClick={reload}>{t('workbench.management.refresh')}</Button></div> : null}</header>
    <div class="system-view-tabs" role="tablist" aria-label={t('workbench.system')}>
      {views.map(view => <button key={view} class="system-view-tab" id={`system-${view}-tab`} type="button" role="tab" aria-selected={activeView.value === view} aria-controls={`system-${view}`} tabindex={activeView.value === view ? 0 : -1} onClick={() => selectView(view)} onKeydown={event => onTabKeydown(event, view)}>
        {view === 'health' ? <Activity size={16} aria-hidden="true" /> : <ScrollText size={16} aria-hidden="true" />}<span>{t(view === 'health' ? 'workbench.systemHealth.title' : 'workbench.logs.title')}</span>
      </button>)}
    </div>
    {activeView.value === 'health' ? <div class="system-view-panel system-health-region" id="system-health" role="tabpanel" aria-labelledby="system-health-tab" tabindex={0}>
    {state.status === 'ERROR' ? <StatePanel tone="error" title={t('workbench.systemHealth.unavailable')} message={diagnosticText(state)} action={t('workbench.tryAgain')} onAction={reload} /> : null}
    {state.status === 'LOADING' ? <StatePanel message="" busy title={t('workbench.systemHealth.loading')} /> : null}
    {state.status === 'DISABLED' ? <StatePanel title={t('workbench.runtimePreview')} message={t('workbench.systemHealth.unavailable')} /> : null}
    {state.status === 'READY' ? <section class="system-health" aria-label={t('workbench.systemHealth.title')}>
      <p class="system-observed">{t('workbench.systemHealth.observed', { time: formatDateTime(state.data.observedAt) })}</p>
      <div class="system-checks">{state.data.checks.map(check => <article class="system-check" key={check.id} data-check={check.id} id={`system-check-${check.id}`} tabindex={-1}>
        <div class="system-check-heading">
          <h2>{t(`workbench.systemHealth.${check.id}`)}</h2>
          <span class="system-check-status" data-status={check.status}>{check.status === 'ready' ? <CircleCheck size={14} aria-hidden="true" /> : check.status === 'attention' ? <CircleAlert size={14} aria-hidden="true" /> : <CircleOff size={14} aria-hidden="true" />}{t(`workbench.systemHealth.${check.status}`)}</span>
          {check.id === 'connections' ? <Button class="system-check-action" variant="ghost" type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.connections)}>{t('workbench.connections')}</Button> : null}
          {check.id === 'scheduler' ? <Button class="system-check-action" variant="ghost" type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.runs, { query: { status: 'FAILED' } })}>{t('workbench.systemHealth.failedRuns')}</Button> : null}
          {check.id === 'triggers' ? <Button class="system-check-action" variant="ghost" type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.automations)}>{t('workbench.pages.automations')}</Button> : null}
        </div>
        {check.status === 'unavailable' ? <p class="system-check-missing">{t('workbench.systemHealth.missing')}</p> : <dl class="system-check-metrics">{Object.entries(check.values).map(([key, value]) => <div key={key}><dt>{t(`workbench.systemHealth.metric.${key}`)}</dt><dd data-numeric={typeof value === 'number'}>{typeof value === 'string' ? t(`workbench.systemHealth.value.${value}`) : String(value)}</dd></div>)}</dl>}
      </article>)}</div>
    </section> : null}
    </div> : null}
    {logsVisited.value ? <section hidden={activeView.value !== 'logs'} class="system-view-panel core-page-section system-log-section" id="system-logs" role="tabpanel" aria-labelledby="system-logs-tab" tabindex={0}><header><h2>{t('workbench.logs.title')}</h2>
      {filter.value.get('runId') ? <Button type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: filter.value.get('runId')! }, query: { from: filter.value.get('from') ?? undefined } })}>{t('workbench.systemHealth.backRun')}</Button> : null}
      {filter.value.get('connectionId') ? <Button type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.connections, { query: { connectionId: filter.value.get('connectionId')! } })}>{t('workbench.connections')}</Button> : null}
    </header><LogsView active={activeView.value === 'logs'} {...(props.consoleClient ? { consoleClient: props.consoleClient } : {})} {...(filter.value.get('runId') ? { runId: filter.value.get('runId')! } : {})} {...(filter.value.get('connectionId') ? { connectionId: filter.value.get('connectionId')! } : {})} /></section> : null}
  </main>
})
