import type { FrontendPage } from '@numen/webui/extensions'
import type { Context } from 'cordis'
import { Activity, Boxes, Cable, Home, Network, Play, Settings } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AutomationEditor } from './AutomationEditor.js'
import {
  workbenchHomeOverviewQueryRef,
  workbenchRunsIndexQueryRef,
  type WorkbenchHomeOverview,
  type WorkbenchHomeRun,
  type WorkbenchRunsCursor,
  type WorkbenchRunsIndex,
  type WorkbenchRunsQueryInput,
} from './contracts.js'
import { coreWorkbenchRoutes, type CoreWorkbenchActivityId } from './routes.js'
import type { WorkbenchPageComponent, WorkbenchPageProps } from './types.js'
import { useConsoleQuery, type ConsoleQueryState } from './useConsoleQuery.js'

export type { WorkbenchPageComponent, WorkbenchPageProps } from './types.js'

const emptyQueryInput: Record<string, never> = {}
const timeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : timeFormatter.format(date)
}

function statusLabel(status: WorkbenchHomeRun['status']): string {
  return status.charAt(0) + status.slice(1).toLowerCase()
}

function HomePage({ consoleClient }: WorkbenchPageProps) {
  const [overview, reload] = useConsoleQuery<Record<string, never>, WorkbenchHomeOverview>(
    consoleClient,
    workbenchHomeOverviewQueryRef,
    emptyQueryInput,
  )
  return (
    <main className="main-workbench core-page">
      <header className="core-page-header"><Home size={22} /><div><h1>Home</h1><p>Your personal automation workspace.</p></div></header>
      <HomeOverview state={overview} onReload={reload} />
    </main>
  )
}

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
    <div className="home-overview">
      <section aria-label="Runtime summary" className="home-metrics">
        <HomeMetric label="Automations" value={data.automations.total} detail={`${data.automations.enabled} enabled`} />
        <HomeMetric label="Recent runs" value={data.runs.recent.length} detail={`${data.runs.active} active · ${data.runs.queued} queued`} />
        <HomeMetric
          label="Connections"
          value={data.connections.total}
          detail={`${data.connections.runtimeReady} ready · ${data.connections.errors} errors`}
          tone={data.connections.errors || data.connections.unavailable ? 'warning' : 'default'}
        />
      </section>
      <section className="core-page-section home-section">
        <h2>Recent automations</h2>
        {data.automations.recent.length ? (
          <div className="core-page-list">
            {data.automations.recent.map(automation => (
              <div key={automation.id}>
                <Network size={17} />
                <span><strong>{automation.name}</strong><small>{automation.enabled ? 'Enabled' : 'Disabled'} · Updated {formatTime(automation.updatedAt)}</small></span>
              </div>
            ))}
          </div>
        ) : <p className="home-empty">No automations yet. Create one to begin shaping your workspace.</p>}
      </section>
      <section className="core-page-section home-section">
        <h2>Recent runs</h2>
        {data.runs.recent.length ? (
          <div className="core-page-list">
            {data.runs.recent.map(run => (
              <div key={run.id}>
                <Activity size={17} />
                <span><strong>{run.automationName}</strong><small><em data-status={run.status}>{statusLabel(run.status)}</em> · Started {formatTime(run.createdAt)}</small></span>
              </div>
            ))}
          </div>
        ) : <p className="home-empty">No runs have been accepted yet.</p>}
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
  return <div className="home-metric" data-tone={tone}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
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
    <section aria-busy={busy} className="core-page-section home-state" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <p>{message}</p>
      {action ? <button className="secondary-button home-retry" onClick={onAction} type="button">{action}</button> : null}
    </section>
  )
}

function AutomationsPage(props: WorkbenchPageProps) {
  return <AutomationEditor {...props} />
}

interface RunsPosition {
  cursor?: WorkbenchRunsCursor
  history: Array<WorkbenchRunsCursor | null>
}

function RunsPage({ consoleClient }: WorkbenchPageProps) {
  const [position, setPosition] = useState<RunsPosition>({ history: [] })
  const input = useMemo<WorkbenchRunsQueryInput>(() => ({
    limit: 20,
    ...(position.cursor ? { cursor: position.cursor } : {}),
  }), [position.cursor])
  const [index, reload] = useConsoleQuery<WorkbenchRunsQueryInput, WorkbenchRunsIndex>(
    consoleClient,
    workbenchRunsIndexQueryRef,
    input,
  )
  const next = index.status === 'READY' ? index.data.nextCursor : undefined
  const goNext = () => {
    if (!next) return
    setPosition(current => ({
      cursor: next,
      history: [...current.history, current.cursor ?? null],
    }))
  }
  const goPrevious = () => {
    setPosition(current => {
      const previous = current.history.at(-1)
      return {
        ...(previous ? { cursor: previous } : {}),
        history: current.history.slice(0, -1),
      }
    })
  }
  return (
    <main className="main-workbench core-page">
      <header className="core-page-header"><Play size={22} /><div><h1>Runs</h1><p>Inspect durable automation executions and their outcomes.</p></div></header>
      <RunsIndex
        onNext={goNext}
        onPrevious={goPrevious}
        onReload={reload}
        state={index}
        canGoPrevious={position.history.length > 0}
      />
    </main>
  )
}

function RunsIndex({ state, canGoPrevious, onNext, onPrevious, onReload }: {
  state: ConsoleQueryState<WorkbenchRunsIndex>
  canGoPrevious: boolean
  onNext(): void
  onPrevious(): void
  onReload(): void
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
    <div className="runs-index">
      <section aria-label="Run summary" className="home-metrics runs-metrics">
        <HomeMetric label="Total" value={summary.total} detail={`${summary.completed} completed`} />
        <HomeMetric label="Active" value={summary.active} detail={`${summary.queued} queued`} />
        <HomeMetric label="Failed" value={summary.failed} detail={`${summary.cancelled} cancelled`} tone={summary.failed ? 'warning' : 'default'} />
      </section>
      <section className="core-page-section runs-section">
        <div className="runs-section-heading"><h2>Durable Runs</h2><span>Newest first · up to 20 per page</span></div>
        {items.length ? (
          <div className="runs-table-wrap">
            <table className="runs-table">
              <thead><tr><th>Automation</th><th>Status</th><th>Started</th><th>Duration</th><th>Work</th></tr></thead>
              <tbody>
                {items.map(run => (
                  <tr key={run.id}>
                    <td><strong>{run.automationName}</strong><small>{run.id}</small></td>
                    <td><em data-status={run.status}>{statusLabel(run.status)}</em></td>
                    <td>{formatTime(run.startedAt ?? run.createdAt)}</td>
                    <td>{formatRunDuration(run)}</td>
                    <td>{formatCount(run.executionCount, 'execution')} · {formatCount(run.attemptCount, 'attempt')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="home-empty">No runs have been accepted yet.</p>}
        <nav aria-label="Run pages" className="runs-pagination">
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

function ConnectionsPage() {
  return <CoreIndexPage icon={Cable} title="Connections" description="Manage the systems and accounts available to automations." />
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
    <main className="main-workbench core-page">
      <header className="core-page-header"><Icon size={22} /><div><h1>{title}</h1><p>{description}</p></div></header>
      <section className="core-page-section core-page-empty">
        <span>{title}</span>
        <p>Current runtime data will appear here through its typed Console Query.</p>
      </section>
    </main>
  )
}

export const coreWorkbenchPageDefinitions: ReadonlyArray<FrontendPage<WorkbenchPageComponent>> = [
  { ...coreWorkbenchRoutes.home, path: '/', title: 'Home', component: HomePage },
  { ...coreWorkbenchRoutes.automations, path: '/automations', title: 'Automations', component: AutomationsPage },
  { ...coreWorkbenchRoutes.runs, path: '/runs', title: 'Runs', component: RunsPage },
  { ...coreWorkbenchRoutes.connections, path: '/connections', title: 'Connections', component: ConnectionsPage },
  { ...coreWorkbenchRoutes.plugins, path: '/plugins/installed', title: 'Plugins', component: PluginsPage },
  { ...coreWorkbenchRoutes.system, path: '/system/overview', title: 'System', component: SystemPage },
]

const pageByActivity = new Map<CoreWorkbenchActivityId, FrontendPage<WorkbenchPageComponent>>(
  coreWorkbenchPageDefinitions.map(page => [activityIdForPage(page), page]),
)

function activityIdForPage(page: FrontendPage): CoreWorkbenchActivityId {
  const entry = Object.entries(coreWorkbenchRoutes).find(([, route]) => (
    route.id === page.id && route.version === page.version
  ))
  if (!entry) throw new Error(`core Workbench Page has no activity: ${page.id}@${page.version}`)
  return entry[0] as CoreWorkbenchActivityId
}

export function corePageForActivity(activityId: CoreWorkbenchActivityId): FrontendPage<WorkbenchPageComponent> {
  return pageByActivity.get(activityId)!
}

export function coreWorkbenchPages(ctx: Context): void {
  for (const page of coreWorkbenchPageDefinitions) ctx.webuiExtensions.page(ctx, page)
}

coreWorkbenchPages.inject = ['webuiExtensions']

export default coreWorkbenchPages
