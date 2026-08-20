import type { FrontendPage } from '@numen/webui/extensions'
import type { Context } from 'cordis'
import { Activity, Boxes, Cable, Home, Network, Play, Settings } from 'lucide-react'
import type { ComponentType } from 'react'
import { AutomationEditor } from './AutomationEditor.js'
import { coreWorkbenchRoutes, type CoreWorkbenchActivityId } from './routes.js'

export interface WorkbenchPageProps {
  automationId: string
  activeStepId: string
  activeTab: string
  onOpenInspector(): void
  onStepChange(id: string): void
  onTabChange(tab: string): void
}

export type WorkbenchPageComponent = ComponentType<WorkbenchPageProps>

function HomePage() {
  return (
    <main className="main-workbench core-page">
      <header className="core-page-header"><Home size={22} /><div><h1>Home</h1><p>Your personal automation workspace.</p></div></header>
      <section className="core-page-section">
        <h2>Continue working</h2>
        <div className="core-page-list">
          <div><Network size={17} /><span><strong>Morning Brief</strong><small>Automation · Saved</small></span></div>
          <div><Activity size={17} /><span><strong>Recent runs</strong><small>Execution history is ready to inspect.</small></span></div>
        </div>
      </section>
    </main>
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
