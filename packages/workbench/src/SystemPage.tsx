import { Button, StatePanel } from '@numenjs/components'
import { Settings } from '@lucide/vue'
import { computed } from 'vue'
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
  return () => <main class="main-workbench core-page system-logs-page">
    <header class="core-page-header"><Settings size={22} /><div><h1>{t('workbench.system')}</h1><p>{t('workbench.systemHealth.description')}</p></div><Button variant="secondary" type="button" onClick={reload}>{t('workbench.management.refresh')}</Button></header>
    {state.status === 'ERROR' ? <StatePanel tone="error" title={t('workbench.systemHealth.unavailable')} message={diagnosticText(state)} action={t('workbench.tryAgain')} onAction={reload} /> : null}
    {state.status === 'LOADING' ? <StatePanel message="" busy title={t('workbench.systemHealth.loading')} /> : null}
    {state.status === 'DISABLED' ? <StatePanel title={t('workbench.runtimePreview')} message={t('workbench.systemHealth.unavailable')} /> : null}
    {state.status === 'READY' ? <section aria-label={t('workbench.systemHealth.title')}>
      <p class="system-observed">{t('workbench.systemHealth.observed', { time: formatDateTime(state.data.observedAt) })}</p>
      <div class="system-checks">{state.data.checks.map(check => <article class="core-page-section system-check" key={check.id}>
        <h2>{t(`workbench.systemHealth.${check.id}`)}<span data-status={check.status}>{t(`workbench.systemHealth.${check.status}`)}</span></h2>
        {check.status === 'unavailable' ? <p>{t('workbench.systemHealth.missing')}</p> : <dl>{Object.entries(check.values).map(([key, value]) => <div key={key}><dt>{t(`workbench.systemHealth.metric.${key}`)}</dt><dd>{typeof value === 'string' ? t(`workbench.systemHealth.value.${value}`) : String(value)}</dd></div>)}</dl>}
        {check.id === 'connections' ? <Button type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.connections)}>{t('workbench.connections')}</Button> : null}
        {check.id === 'scheduler' ? <Button type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.runs, { query: { status: 'FAILED' } })}>{t('workbench.systemHealth.failedRuns')}</Button> : null}
        {check.id === 'triggers' ? <Button type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.automations)}>{t('workbench.pages.automations')}</Button> : null}
      </article>)}</div>
    </section> : null}
    <section class="core-page-section system-log-section"><header><h2>{t('workbench.logs.title')}</h2>
      {filter.value.get('runId') ? <Button type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: filter.value.get('runId')! }, query: { from: filter.value.get('from') ?? undefined } })}>{t('workbench.systemHealth.backRun')}</Button> : null}
      {filter.value.get('connectionId') ? <Button type="button" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.connections, { query: { connectionId: filter.value.get('connectionId')! } })}>{t('workbench.connections')}</Button> : null}
    </header><LogsView {...(props.consoleClient ? { consoleClient: props.consoleClient } : {})} {...(filter.value.get('runId') ? { runId: filter.value.get('runId')! } : {})} {...(filter.value.get('connectionId') ? { connectionId: filter.value.get('connectionId')! } : {})} /></section>
  </main>
})
