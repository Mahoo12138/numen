import { BrowserExtensionRegistry, type BrowserRouteState } from '@numen/webui'
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { renderToMarkup } from './render.js'
import {
  corePageForActivity,
  coreWorkbenchPageDefinitions,
  coreWorkbenchPages,
  coreWorkbenchRunTimelineRoute,
  coreWorkbenchRunContextRoute,
  coreWorkbenchRunFlowRoute,
  coreWorkbenchRunRoutes,
  coreWorkbenchRoutes,
  coreWorkbenchCredentialsRoute,
  WorkbenchShell,
  type WorkbenchRouter,
} from '../src/index.js'

function routerFor(state: BrowserRouteState): WorkbenchRouter {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    navigate: vi.fn(() => state),
  }
}

describe('core Workbench Pages', () => {
  it('registers all core product Pages with Effect ownership', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    const fiber = await root.plugin(coreWorkbenchPages)

    expect(root.webuiExtensions.listPages().map(page => ({ id: page.id, path: page.path }))).toEqual([
      { id: 'numen:home', path: '/' },
      { id: 'numen:automations', path: '/automations' },
      { id: 'numen:connections', path: '/connections' },
      { id: 'numen:credentials', path: '/connections/credentials' },
      { id: 'numen:plugins', path: '/plugins/installed' },
      { id: 'numen:runs', path: '/runs' },
      { id: 'numen:run-context', path: '/runs/:id/context' },
      { id: 'numen:run-flow', path: '/runs/:id/flow' },
      { id: 'numen:run-timeline', path: '/runs/:id/timeline' },
      { id: 'numen:system', path: '/system/overview' },
    ])
    expect(coreWorkbenchPageDefinitions).toHaveLength(10)
    await fiber.dispose()
    expect(root.webuiExtensions.listPages()).toEqual([])
    await root.fiber.dispose()
  })

  it('derives the active Activity and Page component from Router truth', async () => {
    const page = corePageForActivity('home')
    const markup = await renderToMarkup(<WorkbenchShell router={routerFor({
      status: 'READY', pathname: '/', search: '', parameters: {}, page,
    })} />)

    expect(markup).toContain('Your personal automation workspace.')
    expect(markup).toContain('Open Workbench from a running Numen Runtime')
    expect(markup).toMatch(/aria-current="page"[^>]*class="activity-button"[^>]*>.*?Home/s)
    expect(markup).not.toContain('Morning Brief automation flow')
  })

  it('exposes stable Route refs for navigation without raw paths', () => {
    expect(coreWorkbenchRoutes).toEqual({
      home: { id: 'numen:home', version: 1 },
      automations: { id: 'numen:automations', version: 1 },
      runs: { id: 'numen:runs', version: 1 },
      connections: { id: 'numen:connections', version: 1 },
      plugins: { id: 'numen:plugins', version: 1 },
      system: { id: 'numen:system', version: 1 },
    })
    expect(coreWorkbenchRunTimelineRoute).toEqual({ id: 'numen:run-timeline', version: 1 })
    expect(coreWorkbenchRunFlowRoute).toEqual({ id: 'numen:run-flow', version: 1 })
    expect(coreWorkbenchRunContextRoute).toEqual({ id: 'numen:run-context', version: 1 })
    expect(coreWorkbenchRunRoutes).toEqual({
      flow: coreWorkbenchRunFlowRoute,
      timeline: coreWorkbenchRunTimelineRoute,
      context: coreWorkbenchRunContextRoute,
    })
  })

  it('keeps Run detail routes inside the Runs activity', async () => {
    const page = coreWorkbenchPageDefinitions.find(item => item.id === coreWorkbenchRunTimelineRoute.id)!
    const markup = await renderToMarkup(<WorkbenchShell router={routerFor({
      status: 'READY',
      pathname: '/runs/run_11111111111111111111111111111111/timeline',
      search: '',
      parameters: { id: 'run_11111111111111111111111111111111' },
      page,
    })} />)

    expect(markup).toContain('Run detail')
    expect(markup).toContain('Back to Runs')
    expect(markup).toMatch(/aria-current="page"[^>]*class="activity-button"[^>]*>.*?Runs/s)
  })
  it('keeps Credential management in the Connections activity', async () => {
    const page = coreWorkbenchPageDefinitions.find(item => item.id === coreWorkbenchCredentialsRoute.id)!
    const markup = await renderToMarkup(<WorkbenchShell router={routerFor({
      status: 'READY', pathname: '/connections/credentials', search: '', parameters: {}, page,
    })} />)
    expect(markup).toContain('Back to Connections')
    expect(markup).toMatch(/aria-current="page"[^>]*class="activity-button"[^>]*>.*?Connections/s)
  })

})
