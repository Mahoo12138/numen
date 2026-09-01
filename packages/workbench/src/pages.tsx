import type { Context } from 'cordis'
import { Activity, Boxes, Cable, Home, Network, Play, Settings } from '@lucide/vue'
import { computed, reactive } from 'vue'
import { AutomationPageChrome, AutomationWorkspacePage } from './AutomationWorkspace.js'
import { RunDetailPage } from './RunDetailPage.js'
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
import { coreWorkbenchRoutes, coreWorkbenchRunTimelineRoute, type CoreWorkbenchActivityId } from './routes.js'
import type { WorkbenchPageDefinition, WorkbenchPageProps } from './types.js'
import { useConsoleQuery, type ConsoleQueryState } from './useConsoleQuery.js'
import { useConnectionDesiredState, type ConnectionDesiredState } from './useConnectionDesiredState.js'
import { defineSetupComponent } from './vue-component.js'

export type { WorkbenchPageComponent, WorkbenchPageDefinition, WorkbenchPageProps } from './types.js'

const emptyQueryInput: Record<string, never> = {}
const timeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : timeFormatter.format(date)
}

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase()
}

const HomePage = defineSetupComponent<WorkbenchPageProps>('HomePage', ['consoleClient', 'schemaUI'], props => {
  const [overview, reload] = useConsoleQuery<Record<string, never>, WorkbenchHomeOverview>(
    () => props.consoleClient,
    workbenchHomeOverviewQueryRef,
    emptyQueryInput,
    'home',
  )
  return () => (
    <main class="main-workbench core-page">
      <header class="core-page-header"><Home size={22} /><div><h1>Home</h1><p>Your personal automation workspace.</p></div></header>
      <HomeOverview state={overview} onReload={reload} />
    </main>
  )
})

function HomeOverview({ state, onReload }: {
  state: ConsoleQueryState<WorkbenchHomeOverview>
  onReload(): void
}) {
  if (state.status === 'DISABLED') {
    return <QueryStatePanel title="Runtime preview" message="Open Workbench from a running Numen Runtime to load current data." />
  }
  if (state.status === 'LOADING') {
    return <QueryStatePanel busy title="Loading overview" message="Reading current Automation, Run, and Connection state…" />
  }
  if (state.status === 'ERROR') {
    return <QueryStatePanel action="Try again" message={state.message} onAction={onReload} title="Overview unavailable" tone="error" />
  }
  const { data } = state
  return (
    <div class="home-overview">
      <section aria-label="Runtime summary" class="home-metrics">
        <HomeMetric label="Automations" value={data.automations.total} detail={`${data.automations.enabled} enabled`} />
        <HomeMetric label="Recent runs" value={data.runs.recent.length} detail={`${data.runs.active} active · ${data.runs.queued} queued`} />
        <HomeMetric
          label="Connections"
          value={data.connections.total}
          detail={`${data.connections.runtimeReady} ready · ${data.connections.errors} errors`}
          tone={data.connections.errors || data.connections.unavailable ? 'warning' : 'default'}
        />
      </section>
      <section class="core-page-section home-section">
        <h2>Recent automations</h2>
        {data.automations.recent.length ? (
          <div class="core-page-list">
            {data.automations.recent.map(automation => (
              <div key={automation.id}>
                <Network size={17} />
                <span><strong>{automation.name}</strong><small>{automation.enabled ? 'Enabled' : 'Disabled'} · Updated {formatTime(automation.updatedAt)}</small></span>
              </div>
            ))}
          </div>
        ) : <p class="home-empty">No automations yet. Create one to begin shaping your workspace.</p>}
      </section>
      <section class="core-page-section home-section">
        <h2>Recent runs</h2>
        {data.runs.recent.length ? (
          <div class="core-page-list">
            {data.runs.recent.map(run => (
              <div key={run.id}>
                <Activity size={17} />
                <span><strong>{run.automationName}</strong><small><em data-status={run.status}>{statusLabel(run.status)}</em> · Started {formatTime(run.createdAt)}</small></span>
              </div>
            ))}
          </div>
        ) : <p class="home-empty">No runs have been accepted yet.</p>}
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
    props.navigation?.navigate(coreWorkbenchRunTimelineRoute, { parameters: { id: runId } })
  }
  return () => (
    <main class="main-workbench core-page">
      <header class="core-page-header"><Play size={22} /><div><h1>Runs</h1><p>Inspect durable automation executions and their outcomes.</p></div></header>
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
    return <QueryStatePanel title="Runtime preview" message="Open Workbench from a running Numen Runtime to inspect durable Runs." />
  }
  if (state.status === 'LOADING') {
    return <QueryStatePanel busy title="Loading Runs" message="Reading the latest durable execution state…" />
  }
  if (state.status === 'ERROR') {
    return <QueryStatePanel action="Try again" message={state.message} onAction={onReload} title="Runs unavailable" tone="error" />
  }
  const { summary, items, nextCursor } = state.data
  return (
    <div class="runs-index">
      <section aria-label="Run summary" class="home-metrics runs-metrics">
        <HomeMetric label="Total" value={summary.total} detail={`${summary.completed} completed`} />
        <HomeMetric label="Active" value={summary.active} detail={`${summary.queued} queued`} />
        <HomeMetric label="Failed" value={summary.failed} detail={`${summary.cancelled} cancelled`} tone={summary.failed ? 'warning' : 'default'} />
      </section>
      <section class="core-page-section runs-section">
        <div class="runs-section-heading"><h2>Durable Runs</h2><span>Newest first · up to 20 per page</span></div>
        {items.length ? (
          <div class="runs-table-wrap">
            <table class="runs-table">
              <thead><tr><th>Automation</th><th>Status</th><th>Started</th><th>Duration</th><th>Work</th></tr></thead>
              <tbody>
                {items.map(run => (
                  <tr key={run.id}>
                    <td>
                      <button
                        aria-label={`Open Run ${run.id}`}
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
        ) : <p class="home-empty">No runs have been accepted yet.</p>}
        <nav aria-label="Run pages" class="runs-pagination">
          <button disabled={!canGoPrevious} onClick={onPrevious} type="button">Previous</button>
          <button disabled={!nextCursor} onClick={onNext} type="button">Next</button>
        </nav>
      </section>
    </div>
  )
}

function formatRunDuration(run: WorkbenchRunsIndex['items'][number]): string {
  if (!run.startedAt) return 'Not started'
  if (!run.finishedAt) return 'In progress'
  const duration = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(duration) || duration < 0) return '—'
  if (duration < 1000) return `${duration} ms`
  if (duration < 60_000) return `${(duration / 1000).toFixed(1)} s`
  return `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1000)}s`
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

const ConnectionsPage = defineSetupComponent<WorkbenchPageProps>('ConnectionsPage', ['consoleClient', 'schemaUI'], props => {
  const [index, reload, refresh] = useConsoleQuery<Record<string, never>, WorkbenchConnectionsIndex>(
    () => props.consoleClient,
    workbenchConnectionsIndexQueryRef,
    emptyQueryInput,
    'connections',
  )
  const desiredState = useConnectionDesiredState(() => props.consoleClient, refresh)
  return () => (
    <main class="main-workbench core-page">
      <header class="core-page-header"><Cable size={22} /><div><h1>Connections</h1><p>Manage the systems and accounts available to automations.</p></div></header>
      <ConnectionsIndex desiredState={desiredState} state={index} onReload={reload} />
    </main>
  )
})

function ConnectionsIndex({ state, desiredState, onReload }: {
  state: ConsoleQueryState<WorkbenchConnectionsIndex>
  desiredState: ConnectionDesiredState
  onReload(): void
}) {
  if (state.status === 'DISABLED') {
    return <QueryStatePanel title="Runtime preview" message="Open Workbench from a running Numen Runtime to inspect Connections." />
  }
  if (state.status === 'LOADING') {
    return <QueryStatePanel busy title="Loading Connections" message="Reading desired state, Adapter availability, and live Runtime health…" />
  }
  if (state.status === 'ERROR') {
    return <QueryStatePanel action="Try again" message={state.message} onAction={onReload} title="Connections unavailable" tone="error" />
  }
  const { summary, items } = state.data
  return (
    <div class="connections-index">
      <section aria-label="Connection summary" class="home-metrics connections-metrics">
        <HomeMetric label="Total" value={summary.total} detail={`${summary.enabled} enabled`} />
        <HomeMetric label="Runtime ready" value={summary.ready} detail={`${summary.total - summary.enabled} disabled`} />
        <HomeMetric
          label="Attention"
          value={summary.unavailable + summary.errors}
          detail={`${summary.unavailable} unavailable · ${summary.errors} errors`}
          tone={summary.unavailable || summary.errors ? 'warning' : 'default'}
        />
      </section>
      <section class="core-page-section connections-section">
        <div class="runs-section-heading"><h2>Configured Connections</h2><span>Desired and live state are shown separately</span></div>
        {items.length ? (
          <div class="runs-table-wrap connections-table-wrap">
            <table class="runs-table connections-table">
              <thead><tr><th>Connection</th><th>Status</th><th>Adapter</th><th>Desired</th><th>Updated</th></tr></thead>
              <tbody>
                {items.map(connection => {
                  const desired = desiredState.view(connection)
                  return <tr key={connection.id}>
                    <td><strong>{connection.name}</strong><small>{connection.credentialBound ? 'Credential bound' : 'No credential'}</small></td>
                    <td>
                      <em data-connection-status={connection.status}>{statusLabel(connection.status)}</em>
                      <small class="connection-status-detail">{connection.statusDetail}</small>
                    </td>
                    <td><strong>{connection.adapterTitle}</strong><small>{connection.adapterId}@{connection.adapterVersion}</small></td>
                    <td class="connection-desired-cell">
                      <button
                        aria-checked={desired.enabled}
                        aria-label={`${desired.enabled ? 'Disable' : 'Enable'} ${connection.name}`}
                        class="connection-desired-switch"
                        data-enabled={desired.enabled}
                        disabled={desired.pending}
                        onClick={() => desiredState.setEnabled(connection, !desired.enabled)}
                        role="switch"
                        type="button"
                      >
                        <span aria-hidden="true" />
                        <strong>{desired.pending ? (desired.enabled ? 'Enabling…' : 'Disabling…') : (desired.enabled ? 'Enabled' : 'Disabled')}</strong>
                      </button>
                      {desired.error ? (
                        <span class="connection-action-error" role="alert">
                          {desired.error}
                          <button onClick={() => desiredState.retry(connection)} type="button">Try again</button>
                        </span>
                      ) : null}
                    </td>
                    <td>{formatTime(connection.updatedAt)}</td>
                  </tr>
                })}
              </tbody>
            </table>
          </div>
        ) : <p class="home-empty">No Connections are configured yet.</p>}
      </section>
    </div>
  )
}

function PluginsPage() {
  return <CoreIndexPage icon={Boxes} title="Plugins" description="Review installed capabilities and extend Numen." />
}

function SystemPage() {
  return <CoreIndexPage icon={Settings} title="System" description="Monitor runtime health, diagnostics, logs, and settings." />
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
        <p>Current runtime data will appear here through its typed Console Query.</p>
      </section>
    </main>
  )
}

export const coreWorkbenchPageDefinitions: ReadonlyArray<WorkbenchPageDefinition> = [
  { ...coreWorkbenchRoutes.home, path: '/', title: 'Home', component: HomePage },
  {
    ...coreWorkbenchRoutes.automations,
    path: '/automations',
    title: 'Automations',
    component: AutomationWorkspacePage,
    chrome: { component: AutomationPageChrome, hasInspector: true, ownsPanel: true, ownsStatus: true },
  },
  { ...coreWorkbenchRoutes.runs, path: '/runs', title: 'Runs', component: RunsPage },
  { ...coreWorkbenchRunTimelineRoute, path: '/runs/:id/timeline', title: 'Run', component: RunDetailPage },
  { ...coreWorkbenchRoutes.connections, path: '/connections', title: 'Connections', component: ConnectionsPage },
  { ...coreWorkbenchRoutes.plugins, path: '/plugins/installed', title: 'Plugins', component: PluginsPage },
  { ...coreWorkbenchRoutes.system, path: '/system/overview', title: 'System', component: SystemPage },
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
