import { diagnosticText, t, metadataText, formatDateTime, statusLabel } from './i18n.js'
import type { Context } from 'cordis'
import { Activity, Boxes, Cable, Home, Network, Pencil, Play, Plus, Settings } from '@lucide/vue'
import { computed, reactive, ref } from 'vue'
import { AutomationPageChrome, AutomationWorkspacePage } from './AutomationWorkspace.js'
import { RunDetailPage } from './RunDetailPage.js'
import { CredentialsPage } from './CredentialsPage.js'
import { ConnectionConfigurationPanel } from './ConnectionConfigurationPanel.js'
import {
  workbenchConnectionsIndexQueryRef,
  workbenchHomeOverviewQueryRef,
  workbenchRunsIndexQueryRef,
  type WorkbenchConnectionsIndex,
  type WorkbenchHomeOverview,
  type WorkbenchRunsCursor,
  type WorkbenchRunsIndex,
  type WorkbenchRunsQueryInput,
} from './contracts.js'
import {
  coreWorkbenchRoutes,
  coreWorkbenchCredentialsRoute,
  coreWorkbenchRunContextRoute,
  coreWorkbenchRunFlowRoute,
  coreWorkbenchRunTimelineRoute,
  type CoreWorkbenchActivityId,
} from './routes.js'
import type { WorkbenchPageDefinition, WorkbenchPageProps } from './types.js'
import { useConsoleQuery, type ConsoleQueryState } from './useConsoleQuery.js'
import { useConnectionDesiredState, type ConnectionDesiredState } from './useConnectionDesiredState.js'
import { defineSetupComponent } from './vue-component.js'

export type { WorkbenchPageComponent, WorkbenchPageDefinition, WorkbenchPageProps } from './types.js'

const emptyQueryInput: Record<string, never> = {}
const formatTime = formatDateTime

const HomePage = defineSetupComponent<WorkbenchPageProps>('HomePage', ['consoleClient', 'schemaUI'], props => {
  const [overview, reload] = useConsoleQuery<Record<string, never>, WorkbenchHomeOverview>(
    () => props.consoleClient,
    workbenchHomeOverviewQueryRef,
    emptyQueryInput,
    'home',
  )
  return () => (
    <main class="main-workbench core-page">
      <header class="core-page-header"><Home size={22} /><div><h1>{t('workbench.home')}</h1><p>{t('workbench.yourPersonalAutomationWorkspace')}</p></div></header>
      <HomeOverview state={overview} onReload={reload} />
    </main>
  )
})

function HomeOverview({ state, onReload }: {
  state: ConsoleQueryState<WorkbenchHomeOverview>
  onReload(): void
}) {
  if (state.status === 'DISABLED') {
    return <QueryStatePanel title={t('workbench.runtimePreview')} message={t('workbench.openWorkbenchFromARunningNumenRuntimeToLoadCurrentData')} />
  }
  if (state.status === 'LOADING') {
    return <QueryStatePanel busy title={t('workbench.loadingOverview')} message={t('workbench.readingCurrentAutomationRunAndConnectionState')} />
  }
  if (state.status === 'ERROR') {
    return <QueryStatePanel action={t('workbench.tryAgain')} message={diagnosticText(state)} onAction={onReload} title={t('workbench.overviewUnavailable')} tone="error" />
  }
  const { data } = state
  return (
    <div class="home-overview">
      <section aria-label={t('workbench.runtimeSummary')} class="home-metrics">
        <HomeMetric label={t('workbench.automations2')} value={data.automations.total} detail={t('workbench.value0Enabled', { value0: data.automations.enabled })} />
        <HomeMetric label={t('workbench.recentRuns')} value={data.runs.recent.length} detail={t('workbench.value0ActiveValue1Queued', { value0: data.runs.active, value1: data.runs.queued })} />
        <HomeMetric
          label={t('workbench.connections')}
          value={data.connections.total}
          detail={t('workbench.value0ReadyValue1Errors', { value0: data.connections.runtimeReady, value1: data.connections.errors })}
          tone={data.connections.errors || data.connections.unavailable ? 'warning' : 'default'}
        />
      </section>
      <section class="core-page-section home-section">
        <h2>{t('workbench.recentAutomations')}</h2>
        {data.automations.recent.length ? (
          <div class="core-page-list">
            {data.automations.recent.map(automation => (
              <div key={automation.id}>
                <Network size={17} />
                <span><strong>{automation.name}</strong><small>{automation.enabled ? t('workbench.enabled') : t('workbench.disabled')}{t('workbench.updated2')}{formatTime(automation.updatedAt)}</small></span>
              </div>
            ))}
          </div>
        ) : <p class="home-empty">{t('workbench.noAutomationsYetCreateOneToBeginShapingYourWorkspace')}</p>}
      </section>
      <section class="core-page-section home-section">
        <h2>{t('workbench.recentRuns')}</h2>
        {data.runs.recent.length ? (
          <div class="core-page-list">
            {data.runs.recent.map(run => (
              <div key={run.id}>
                <Activity size={17} />
                <span><strong>{run.automationName}</strong><small><em data-status={run.status}>{statusLabel(run.status)}</em>{t('workbench.started2')}{formatTime(run.createdAt)}</small></span>
              </div>
            ))}
          </div>
        ) : <p class="home-empty">{t('workbench.noRunsHaveBeenAcceptedYet')}</p>}
      </section>
    </div>
  )
}

function HomeMetric({ label, value, detail, tone = 'default' }: {
  label: string
  value: number
  detail: string
  tone?: 'default' | 'warning'
}) {
  return <div class="home-metric" data-tone={tone}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
}

function QueryStatePanel({ title, message, busy = false, tone = 'default', action, onAction }: {
  title: string
  message: string
  busy?: boolean
  tone?: 'default' | 'error'
  action?: string
  onAction?(): void
}) {
  return (
    <section aria-busy={busy} class="core-page-section home-state" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <p>{message}</p>
      {action ? <button class="secondary-button home-retry" {...(onAction ? { onClick: onAction } : {})} type="button">{action}</button> : null}
    </section>
  )
}

interface RunsPosition {
  cursor?: WorkbenchRunsCursor
  history: Array<WorkbenchRunsCursor | null>
}

const RunsPage = defineSetupComponent<WorkbenchPageProps>('RunsPage', ['consoleClient', 'schemaUI', 'navigation'], props => {
  const position = reactive<RunsPosition>({ history: [] })
  const input = computed<WorkbenchRunsQueryInput>(() => ({
    limit: 20,
    ...(position.cursor ? { cursor: position.cursor } : {}),
  }))
  const [index, reload] = useConsoleQuery<WorkbenchRunsQueryInput, WorkbenchRunsIndex>(
    () => props.consoleClient,
    workbenchRunsIndexQueryRef,
    input,
    'runs',
  )
  const goNext = () => {
    const next = index.status === 'READY' ? index.data.nextCursor : undefined
    if (!next) return
    position.history.push(position.cursor ?? null)
    position.cursor = next
  }
  const goPrevious = () => {
    const previous = position.history.pop()
    if (previous) position.cursor = previous
    else delete position.cursor
  }
  const openRun = (runId: string) => {
    props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: runId } })
  }
  return () => (
    <main class="main-workbench core-page">
      <header class="core-page-header"><Play size={22} /><div><h1>{t('workbench.runs')}</h1><p>{t('workbench.inspectDurableAutomationExecutionsAndTheirOutcomes')}</p></div></header>
      <RunsIndex
        onNext={goNext}
        onPrevious={goPrevious}
        {...(props.navigation ? { onOpenRun: openRun } : {})}
        onReload={reload}
        state={index}
        canGoPrevious={position.history.length > 0}
      />
    </main>
  )
})

function RunsIndex({ state, canGoPrevious, onNext, onPrevious, onReload, onOpenRun }: {
  state: ConsoleQueryState<WorkbenchRunsIndex>
  canGoPrevious: boolean
  onNext(): void
  onPrevious(): void
  onReload(): void
  onOpenRun?(runId: string): void
}) {
  if (state.status === 'DISABLED') {
    return <QueryStatePanel title={t('workbench.runtimePreview')} message={t('workbench.openWorkbenchFromARunningNumenRuntimeToInspectDurableRuns')} />
  }
  if (state.status === 'LOADING') {
    return <QueryStatePanel busy title={t('workbench.loadingRuns')} message={t('workbench.readingTheLatestDurableExecutionState')} />
  }
  if (state.status === 'ERROR') {
    return <QueryStatePanel action={t('workbench.tryAgain')} message={diagnosticText(state)} onAction={onReload} title={t('workbench.runsUnavailable')} tone="error" />
  }
  const { summary, items, nextCursor } = state.data
  return (
    <div class="runs-index">
      <section aria-label={t('workbench.runSummary')} class="home-metrics runs-metrics">
        <HomeMetric label={t('workbench.total2')} value={summary.total} detail={t('workbench.value0Completed', { value0: summary.completed })} />
        <HomeMetric label={t('workbench.active')} value={summary.active} detail={t('workbench.value0Queued', { value0: summary.queued })} />
        <HomeMetric label={t('workbench.failed3')} value={summary.failed} detail={t('workbench.value0Cancelled', { value0: summary.cancelled })} tone={summary.failed ? 'warning' : 'default'} />
      </section>
      <section class="core-page-section runs-section">
        <div class="runs-section-heading"><h2>{t('workbench.durableRuns')}</h2><span>{t('workbench.newestFirstUpTo20PerPage')}</span></div>
        {items.length ? (
          <div class="runs-table-wrap">
            <table class="runs-table">
              <thead><tr><th>{t('workbench.automation')}</th><th>{t('workbench.status')}</th><th>{t('workbench.started')}</th><th>{t('workbench.duration')}</th><th>{t('workbench.work')}</th></tr></thead>
              <tbody>
                {items.map(run => (
                  <tr key={run.id}>
                    <td>
                      <button
                        aria-label={t('workbench.openRunValue0', { value0: run.id })}
                        class="run-detail-link"
                        disabled={!onOpenRun}
                        onClick={() => onOpenRun?.(run.id)}
                        type="button"
                      ><strong>{run.automationName}</strong><small>{run.id}</small></button>
                    </td>
                    <td><em data-status={run.status}>{statusLabel(run.status)}</em></td>
                    <td>{formatTime(run.startedAt ?? run.createdAt)}</td>
                    <td>{formatRunDuration(run)}</td>
                    <td>{formatCount(run.executionCount, 'execution')} · {formatCount(run.attemptCount, 'attempt')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p class="home-empty">{t('workbench.noRunsHaveBeenAcceptedYet')}</p>}
        <nav aria-label={t('workbench.runPages')} class="runs-pagination">
          <button disabled={!canGoPrevious} onClick={onPrevious} type="button">{t('workbench.previous')}</button>
          <button disabled={!nextCursor} onClick={onNext} type="button">{t('workbench.next')}</button>
        </nav>
      </section>
    </div>
  )
}

function formatRunDuration(run: WorkbenchRunsIndex['items'][number]): string {
  if (!run.startedAt) return t('workbench.notStarted')
  if (!run.finishedAt) return t('workbench.inProgress')
  const duration = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(duration) || duration < 0) return '—'
  if (duration < 1000) return `${duration} ms`
  if (duration < 60_000) return `${(duration / 1000).toFixed(1)} s`
  return `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1000)}s`
}

function formatCount(count: number, singular: string): string {
  return t(singular === 'execution' ? 'workbench.executionCount' : 'workbench.attemptCount', { count })
}

const ConnectionsPage = defineSetupComponent<WorkbenchPageProps>('ConnectionsPage', ['consoleClient', 'schemaUI', 'navigation'], props => {
  const [index, reload, refresh] = useConsoleQuery<Record<string, never>, WorkbenchConnectionsIndex>(
    () => props.consoleClient,
    workbenchConnectionsIndexQueryRef,
    emptyQueryInput,
    'connections',
  )
  const desiredState = useConnectionDesiredState(() => props.consoleClient, refresh)
  const configuration = ref<'create' | string>()
  return () => (
    <main class="main-workbench core-page">
      <header class="core-page-header"><Cable size={22} /><div><h1>{t('workbench.connections')}</h1><p>{t('workbench.manageTheSystemsAndAccountsAvailableToAutomations')}</p></div></header>
      <div class="credential-navigation"><button class="secondary-button" disabled={!props.navigation} onClick={() => props.navigation?.navigate(coreWorkbenchCredentialsRoute)} type="button">{t('workbench.manageCredentials')}</button></div>
      <ConnectionsIndex
        {...(props.consoleClient ? { client: props.consoleClient } : {})}
        {...(configuration.value ? { configuration: configuration.value } : {})}
        desiredState={desiredState}
        {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
        state={index}
        onCloseConfiguration={() => { configuration.value = undefined }}
        onConfigure={connectionId => { configuration.value = connectionId ?? 'create' }}
        onMutated={() => { configuration.value = undefined; refresh() }}
        onReload={reload}
      />
    </main>
  )
})

function ConnectionsIndex({ state, desiredState, client, schemaUI, configuration, onReload, onConfigure, onCloseConfiguration, onMutated }: {
  state: ConsoleQueryState<WorkbenchConnectionsIndex>
  desiredState: ConnectionDesiredState
  client?: WorkbenchPageProps['consoleClient']
  schemaUI?: WorkbenchPageProps['schemaUI']
  configuration?: 'create' | string
  onReload(): void
  onConfigure(connectionId?: string): void
  onCloseConfiguration(): void
  onMutated(): void
}) {
  if (state.status === 'DISABLED') {
    return <QueryStatePanel title={t('workbench.runtimePreview')} message={t('workbench.openWorkbenchFromARunningNumenRuntimeToInspectConnections')} />
  }
  if (state.status === 'LOADING') {
    return <QueryStatePanel busy title={t('workbench.loadingConnections')} message={t('workbench.readingDesiredStateAdapterAvailabilityAndLiveRuntimeHealth')} />
  }
  if (state.status === 'ERROR') {
    return <QueryStatePanel action={t('workbench.tryAgain')} message={diagnosticText(state)} onAction={onReload} title={t('workbench.connectionsUnavailable')} tone="error" />
  }
  const { summary, items } = state.data
  const configuredConnection = configuration && configuration !== 'create'
    ? items.find(item => item.id === configuration)
    : undefined
  return (
    <div class="connections-index">
      <section aria-label={t('workbench.connectionSummary')} class="home-metrics connections-metrics">
        <HomeMetric label={t('workbench.total2')} value={summary.total} detail={t('workbench.value0Enabled', { value0: summary.enabled })} />
        <HomeMetric label={t('workbench.runtimeReady')} value={summary.ready} detail={t('workbench.value0Disabled', { value0: summary.total - summary.enabled })} />
        <HomeMetric
          label={t('workbench.attention')}
          value={summary.unavailable + summary.errors}
          detail={t('workbench.value0UnavailableValue1Errors', { value0: summary.unavailable, value1: summary.errors })}
          tone={summary.unavailable || summary.errors ? 'warning' : 'default'}
        />
      </section>
      <div class="connections-workspace" data-configuring={!!configuration}>
        <section class="core-page-section connections-section">
          <div class="runs-section-heading connection-section-heading"><div><h2>{t('workbench.configuredConnections')}</h2><span>{t('workbench.desiredAndLiveStateAreShownSeparately')}</span></div><button class="secondary-button" disabled={!state.data.adapters.length} onClick={() => onConfigure()} type="button"><Plus size={14} />{t('workbench.newConnection')}</button></div>
          {items.length ? (
          <div class="runs-table-wrap connections-table-wrap">
            <table class="runs-table connections-table">
              <thead><tr><th>{t('workbench.connection3')}</th><th>{t('workbench.status')}</th><th>{t('workbench.adapter')}</th><th>{t('workbench.desired')}</th><th>{t('workbench.updated')}</th><th><span class="visually-hidden">{t('workbench.actions')}</span></th></tr></thead>
              <tbody>
                {items.map(connection => {
                  const desired = desiredState.view(connection)
                  return <tr key={connection.id}>
                    <td><strong>{connection.name}</strong><small>{connection.credentialBound ? t('workbench.credentialBound') : t('workbench.noCredential')}</small></td>
                    <td>
                      <em data-connection-status={connection.status}>{statusLabel(connection.status)}</em>
                      <small class="connection-status-detail">{metadataText(`workbench.connectionStatus.${connection.status}`, connection.statusDetail)}</small>
                    </td>
                    <td><strong>{connection.adapterTitle}</strong><small>{connection.adapterId}@{connection.adapterVersion}</small></td>
                    <td class="connection-desired-cell">
                      <button
                        aria-checked={desired.enabled}
                        aria-label={t('workbench.value0Value1', { value0: desired.enabled ? 'Disable' : 'Enable', value1: connection.name })}
                        class="connection-desired-switch"
                        data-enabled={desired.enabled}
                        disabled={desired.pending}
                        onClick={() => desiredState.setEnabled(connection, !desired.enabled)}
                        role="switch"
                        type="button"
                      >
                        <span aria-hidden="true" />
                        <strong>{desired.pending ? (desired.enabled ? t('workbench.enabling') : t('workbench.disabling')) : (desired.enabled ? t('workbench.enabled') : t('workbench.disabled'))}</strong>
                      </button>
                      {desired.error ? (
                        <span class="connection-action-error" role="alert">
                          {desired.error}
                          <button onClick={() => desiredState.retry(connection)} type="button">{t('workbench.tryAgain')}</button>
                        </span>
                      ) : null}
                    </td>
                    <td>{formatTime(connection.updatedAt)}</td>
                    <td><button aria-label={t('workbench.editValue0', { value0: connection.name })} class="table-action-button" disabled={!state.data.adapters.some(adapter => adapter.id === connection.adapterId && adapter.version === connection.adapterVersion)} onClick={() => onConfigure(connection.id)} type="button"><Pencil size={14} /></button></td>
                  </tr>
                })}
              </tbody>
            </table>
          </div>
          ) : <div class="connection-empty"><p>{t('workbench.noConnectionsAreConfiguredYet')}</p><button class="secondary-button" disabled={!state.data.adapters.length} onClick={() => onConfigure()} type="button"><Plus size={14} />{t('workbench.createTheFirstConnection')}</button></div>}
        </section>
        {configuration ? <ConnectionConfigurationPanel
          adapters={state.data.adapters}
          {...(client ? { client } : {})}
          {...(configuredConnection ? { connection: configuredConnection } : {})}
          onChanged={onMutated}
          onClose={onCloseConfiguration}
          {...(schemaUI ? { schemaUI } : {})}
        /> : null}
      </div>
    </div>
  )
}

function PluginsPage() {
  return <CoreIndexPage icon={Boxes} title={t('workbench.plugins')} description={t('workbench.reviewInstalledCapabilitiesAndExtendNumen')} />
}

function SystemPage() {
  return <CoreIndexPage icon={Settings} title={t('workbench.system')} description={t('workbench.monitorRuntimeHealthDiagnosticsLogsAndSettings')} />
}

function CoreIndexPage({ icon: Icon, title, description }: {
  icon: typeof Home
  title: string
  description: string
}) {
  return (
    <main class="main-workbench core-page">
      <header class="core-page-header"><Icon size={22} /><div><h1>{title}</h1><p>{description}</p></div></header>
      <section class="core-page-section core-page-empty">
        <span>{title}</span>
        <p>{t('workbench.currentRuntimeDataWillAppearHereThroughItsTypedConsoleQuery')}</p>
      </section>
    </main>
  )
}

export const coreWorkbenchPageDefinitions: ReadonlyArray<WorkbenchPageDefinition> = [
  { ...coreWorkbenchRoutes.home, path: '/', title: 'Home', titleKey: 'workbench.pages.home', component: HomePage },
  {
    ...coreWorkbenchRoutes.automations,
    path: '/automations',
    title: 'Automations', titleKey: 'workbench.pages.automations',
    component: AutomationWorkspacePage,
    chrome: { component: AutomationPageChrome, hasInspector: true, ownsPanel: true, ownsStatus: true },
  },
  { ...coreWorkbenchRoutes.runs, path: '/runs', title: 'Runs', titleKey: 'workbench.pages.runs', component: RunsPage },
  { ...coreWorkbenchRunFlowRoute, path: '/runs/:id/flow', title: 'Run', titleKey: 'workbench.pages.run', component: RunDetailPage },
  { ...coreWorkbenchRunTimelineRoute, path: '/runs/:id/timeline', title: 'Run', titleKey: 'workbench.pages.run', component: RunDetailPage },
  { ...coreWorkbenchRunContextRoute, path: '/runs/:id/context', title: 'Run', titleKey: 'workbench.pages.run', component: RunDetailPage },
  { ...coreWorkbenchCredentialsRoute, path: '/connections/credentials', title: 'Credentials', titleKey: 'workbench.pages.credentials', component: CredentialsPage },
  { ...coreWorkbenchRoutes.connections, path: '/connections', title: 'Connections', titleKey: 'workbench.pages.connections', component: ConnectionsPage },
  { ...coreWorkbenchRoutes.plugins, path: '/plugins/installed', title: 'Plugins', titleKey: 'workbench.pages.plugins', component: PluginsPage },
  { ...coreWorkbenchRoutes.system, path: '/system/overview', title: 'System', titleKey: 'workbench.pages.system', component: SystemPage },
]

const pageByActivity = new Map<CoreWorkbenchActivityId, WorkbenchPageDefinition>(
  Object.entries(coreWorkbenchRoutes).map(([activityId, route]) => [
    activityId as CoreWorkbenchActivityId,
    coreWorkbenchPageDefinitions.find(page => page.id === route.id && page.version === route.version)!,
  ]),
)

export function corePageForActivity(activityId: CoreWorkbenchActivityId): WorkbenchPageDefinition {
  return pageByActivity.get(activityId)!
}

export function coreWorkbenchPages(ctx: Context): void {
  for (const page of coreWorkbenchPageDefinitions) ctx.webuiExtensions.page(ctx, page)
}

coreWorkbenchPages.inject = ['webuiExtensions']

export default coreWorkbenchPages
