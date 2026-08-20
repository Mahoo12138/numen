import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkbenchShell } from '../src/index.js'

describe('WorkbenchShell', () => {
  it('renders the documented Workbench regions and primary navigation', () => {
    const markup = renderToStaticMarkup(<WorkbenchShell />)

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
    const markup = renderToStaticMarkup(<WorkbenchShell />)

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
})
