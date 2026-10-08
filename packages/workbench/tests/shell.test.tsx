import { describe, expect, it, vi } from 'vitest'
import { corePageForActivity, coreWorkbenchPageDefinitions, WorkbenchShell, type WorkbenchRouter } from '../src/index.js'
import type { WorkbenchPageChromeProps, WorkbenchPageDefinition } from '../src/types.js'
import type { BrowserRouteState } from '@numenjs/webui'
import { renderToMarkup } from './render.js'

function PluginMain() {
  return <main class="main-workbench">Plugin-owned main</main>
}

function PluginChrome({ page }: WorkbenchPageChromeProps) {
  const PageComponent = page.component
  return <><aside class="primary-sidebar">Plugin-owned sidebar</aside><PageComponent /></>
}

function routerFor(page?: WorkbenchPageDefinition): WorkbenchRouter {
  const state: BrowserRouteState = page ? {
    status: 'READY', pathname: page.path, search: '', parameters: {}, page,
  } : { status: 'NOT_FOUND', pathname: '/missing', search: '', parameters: {} }
  return { beforeLeave: () => () => {}, getSnapshot: () => state, subscribe: () => () => {}, navigate: vi.fn(() => state) }
}

function InspectorChrome({ page }: WorkbenchPageChromeProps) {
  const PageComponent = page.component
  return <><PageComponent /><aside class="inspector" aria-label="Extension inspector">Inspector content</aside></>
}

describe('WorkbenchShell', () => {
  it('renders the documented Workbench regions and primary navigation', async () => {
    const markup = await renderToMarkup(<WorkbenchShell standalonePages={coreWorkbenchPageDefinitions} />)

    expect(markup).toContain('Numen Workbench')
    expect(markup).toContain('aria-label="Command center"')
    expect(markup).toContain('aria-label="Primary navigation"')
    for (const label of ['Home', 'Automations', 'Runs', 'Connections', 'Plugins', 'System']) {
      expect(markup).toContain(`>${label}<`)
    }
    expect(markup).toContain('aria-label="Inspector"')
    expect(markup).toContain('aria-label="Bottom panel"')
    expect(markup).toContain('Preview only')
    expect(markup).not.toContain('>Saved<')
    expect(markup).not.toContain('>Preview</button>')
  })

  it('renders the selected Automation editor and inspector state', async () => {
    const markup = await renderToMarkup(<WorkbenchShell standalonePages={coreWorkbenchPageDefinitions} />)

    for (const label of ['Morning Brief', 'Inbox Triage', 'Weekly Archive']) {
      expect(markup).toContain(label)
    }
    for (const tab of ['Editor', 'Runs', 'Revisions', 'State', 'Settings']) {
      expect(markup).toContain(`>${tab}<`)
    }
    for (const step of ['Trigger', 'Fetch weather', 'Prepare summary', 'Send notification']) {
      expect(markup).toContain(step)
    }
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('{{ summary }}')
    expect(markup).toContain('Message template')
    // Preview data has no Runtime policy metadata; it must not invent editable execution behavior.
    expect(markup).not.toContain('>Execution policy<')
    expect(markup).not.toContain('Continue to next step')
  })

  it('delegates activity-specific workspace chrome to the Page definition', async () => {
    const automationPage = corePageForActivity('automations')
    const markup = await renderToMarkup(<WorkbenchShell standalonePages={[{
      ...automationPage,
      component: PluginMain,
      chrome: { component: PluginChrome },
    }]} />)

    expect(markup).toContain('Plugin-owned sidebar')
    expect(markup).toContain('Plugin-owned main')
    expect(markup).toContain('data-has-sidebar="true"')
    expect(markup).toContain('sidebar-resize-handle')
    expect(markup).toContain('aria-label="Bottom panel"')
    expect(markup).not.toContain('aria-label="Inspector"')
  })

  it('lets a Page extension own panel and status regions without duplicate shell chrome', async () => {
    const automationPage = corePageForActivity('automations')
    const markup = await renderToMarkup(<WorkbenchShell standalonePages={[{
      ...automationPage,
      component: PluginMain,
      chrome: { component: PluginChrome, ownsPanel: true, ownsStatus: true },
    }]} />)

    expect(markup).not.toContain('aria-label="Bottom panel"')
    expect(markup).not.toContain('>Saved<')
  })

  it('uses editor chrome only in the core automation workspace', async () => {
    for (const id of ['numen:home', 'numen:runs', 'numen:system', 'numen:connections', 'numen:credentials', 'numen:plugins', 'numen:run-flow', 'numen:run-timeline', 'numen:run-context', 'numen:automation-snapshot', 'numen:automation-comparison']) {
      const page = coreWorkbenchPageDefinitions.find(item => item.id === id)!
      expect(page, id).toBeDefined()
      const markup = await renderToMarkup(<WorkbenchShell router={routerFor(page)} />)
      expect(markup, id).toContain('data-has-sidebar="false"')
      expect(markup, id).not.toContain('sidebar-resize-handle')
      expect(markup, id).not.toContain('simple-sidebar')
      expect(markup, id).not.toContain('primary-sidebar')
      expect(markup, id).not.toContain('aria-label="Bottom panel"')
      expect(markup, id).not.toContain('status-bar')
    }
    const markup = await renderToMarkup(<WorkbenchShell router={routerFor(corePageForActivity('automations'))} />)
    expect(markup).toContain('data-has-sidebar="true"')
    expect(markup).toContain('sidebar-resize-handle')
    expect(markup).toContain('aria-label="Bottom panel"')
    expect(markup).toContain('status-bar')
    expect(markup).not.toContain('simple-sidebar')
  })

  it('allows extension inspector chrome without reserving a sidebar or its splitter', async () => {
    const page = { ...corePageForActivity('automations'), component: PluginMain,
      chrome: { component: InspectorChrome, hasSidebar: false, hasInspector: true } }
    const markup = await renderToMarkup(<WorkbenchShell router={routerFor(page)} />)
    expect(markup).toContain('data-has-sidebar="false"')
    expect(markup).toContain('aria-label="Extension inspector"')
    expect(markup).toContain('inspector-resize-handle')
    expect(markup).not.toContain('sidebar-resize-handle')
  })

  it('keeps a missing route full width and avoids a fabricated sidebar', async () => {
    const markup = await renderToMarkup(<WorkbenchShell router={routerFor()} />)
    expect(markup).toContain('Page not found')
    expect(markup).toContain('data-has-sidebar="false"')
    expect(markup).not.toContain('sidebar-resize-handle')
    expect(markup).not.toContain('simple-sidebar')
    expect(markup).not.toContain('aria-label="Bottom panel"')
    expect(markup).not.toContain('status-bar')
  })

  it('lets extension chrome disable the global panel while keeping its custom main', async () => {
    const page = { ...corePageForActivity('automations'), component: PluginMain,
      chrome: { component: PluginChrome, hasPanel: false } }
    const markup = await renderToMarkup(<WorkbenchShell router={routerFor(page)} />)
    expect(markup).toContain('Plugin-owned main')
    expect(markup).not.toContain('aria-label="Bottom panel"')
    expect(markup).not.toContain('panel-toggle')
    expect(markup).not.toContain('panel-resize-handle')
  })
})
