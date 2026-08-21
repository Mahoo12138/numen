import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { corePageForActivity, coreWorkbenchPageDefinitions, WorkbenchShell } from '../src/index.js'
import type { WorkbenchPageChromeProps } from '../src/types.js'

function PluginMain() {
  return <main className="main-workbench">Plugin-owned main</main>
}

function PluginChrome({ page }: WorkbenchPageChromeProps) {
  const PageComponent = page.component
  return <><aside className="primary-sidebar">Plugin-owned sidebar</aside><PageComponent /></>
}

describe('WorkbenchShell', () => {
  it('renders the documented Workbench regions and primary navigation', () => {
    const markup = renderToStaticMarkup(<WorkbenchShell standalonePages={coreWorkbenchPageDefinitions} />)

    expect(markup).toContain('Numen Workbench')
    expect(markup).toContain('aria-label="Command center"')
    expect(markup).toContain('aria-label="Primary navigation"')
    for (const label of ['Home', 'Automations', 'Runs', 'Connections', 'Plugins', 'System']) {
      expect(markup).toContain(`>${label}<`)
    }
    expect(markup).toContain('aria-label="Inspector"')
    expect(markup).toContain('aria-label="Bottom panel"')
    expect(markup).toContain('Ready')
    expect(markup).toContain('Saved')
  })

  it('renders the selected Automation editor and inspector state', () => {
    const markup = renderToStaticMarkup(<WorkbenchShell standalonePages={coreWorkbenchPageDefinitions} />)

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
    expect(markup).toContain('Continue to next step')
  })

  it('delegates activity-specific workspace chrome to the Page definition', () => {
    const automationPage = corePageForActivity('automations')
    const markup = renderToStaticMarkup(<WorkbenchShell standalonePages={[{
      ...automationPage,
      component: PluginMain,
      chrome: { component: PluginChrome },
    }]} />)

    expect(markup).toContain('Plugin-owned sidebar')
    expect(markup).toContain('Plugin-owned main')
    expect(markup).not.toContain('aria-label="Inspector"')
  })

  it('lets a Page extension own panel and status regions without duplicate shell chrome', () => {
    const automationPage = corePageForActivity('automations')
    const markup = renderToStaticMarkup(<WorkbenchShell standalonePages={[{
      ...automationPage,
      component: PluginMain,
      chrome: { component: PluginChrome, ownsPanel: true, ownsStatus: true },
    }]} />)

    expect(markup).not.toContain('aria-label="Bottom panel"')
    expect(markup).not.toContain('>Saved<')
  })
})
