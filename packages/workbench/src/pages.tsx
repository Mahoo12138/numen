import type { FrontendPage } from '@numen/webui/extensions'
import type { Context } from 'cordis'
import { Activity, Boxes, Cable, Home, Network, Play, Settings } from 'lucide-react'
import { AutomationEditor } from './AutomationEditor.js'
import {
  workbenchHomeOverviewQueryRef,
  type WorkbenchHomeOverview,
  type WorkbenchHomeRun,
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
    return <HomeState title="Runtime preview" message="Open Workbench from a running Numen Runtime to load current data." />
  }
  if (state.status === 'LOADING') {
    return <HomeState busy title="Loading overview" message="Reading current Automation, Run, and Connection state…" />
  }
  if (state.status === 'ERROR') {
    return <HomeState action="Try again" message={state.message} onAction={onReload} title="Overview unavailable" tone="error" />
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

function HomeState({ title, message, busy = false, tone = 'default', action, onAction }: {
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

function RunsPage() {
  return <CoreIndexPage icon={Play} title="Runs" description="Inspect durable automation executions and their outcomes." />
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
