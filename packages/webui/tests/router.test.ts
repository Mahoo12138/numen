import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserExtensionRegistry,
  FrontendExtensionStage,
  BrowserRouterService,
  type BrowserRouterEnvironment,
  type BrowserRouteState,
} from '../src/index.js'

class FakeRouterEnvironment implements BrowserRouterEnvironment {
  location: { href: string }
  history: BrowserRouterEnvironment['history']
  private readonly popStateListeners = new Set<() => void>()

  constructor(href: string) {
    this.location = { href }
    this.history = {
      state: null,
      pushState: (data, _unused, url) => {
        this.history.state = data
        if (url !== undefined && url !== null) this.location.href = new URL(String(url), this.location.href).href
      },
      replaceState: (data, _unused, url) => {
        this.history.state = data
        if (url !== undefined && url !== null) this.location.href = new URL(String(url), this.location.href).href
      },
    }
  }

  addEventListener(_type: 'popstate', listener: () => void): void {
    this.popStateListeners.add(listener)
  }

  removeEventListener(_type: 'popstate', listener: () => void): void {
    this.popStateListeners.delete(listener)
  }

  pop(href: string): void {
    this.location.href = new URL(href, this.location.href).href
    for (const listener of this.popStateListeners) listener()
  }
}

function page(id: string, path: string) {
  return { id, version: 1, path, title: id, component: { id } }
}

describe('BrowserRouterService', () => {
  it('matches the current URL and decodes dynamic Page parameters', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.page(root, page('core:automation', '/automations/:id/editor'))
    root.webuiExtensions.page(root, page('core:automations', '/automations'))
    const environment = new FakeRouterEnvironment('http://numen.local/automations/morning%20brief/editor?panel=logs')
    await root.plugin(BrowserRouterService, { environment })

    expect(root.webuiRouter.getState()).toMatchObject({
      status: 'READY',
      pathname: '/automations/morning%20brief/editor',
      search: '?panel=logs',
      parameters: { id: 'morning brief' },
      page: { id: 'core:automation', version: 1 },
    })
    await root.fiber.dispose()
  })

  it('builds hrefs and navigates by stable Route ID', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.page(root, page('core:automation', '/automations/:id/editor'))
    const environment = new FakeRouterEnvironment('http://numen.local/')
    await root.plugin(BrowserRouterService, { environment })

    expect(root.webuiRouter.href(
      { id: 'core:automation', version: 1 },
      { parameters: { id: 'daily brief' }, query: { view: 'flow', debug: false } },
    )).toBe('/automations/daily%20brief/editor?debug=false&view=flow')
    expect(root.webuiRouter.navigate(
      { id: 'core:automation', version: 1 },
      { parameters: { id: 'daily brief' }, replace: true },
    )).toMatchObject({ status: 'READY', parameters: { id: 'daily brief' } })
    expect(environment.location.href).toBe('http://numen.local/automations/daily%20brief/editor')
    expect(environment.history.state).toMatchObject({
      numenRoute: { id: 'core:automation', version: 1 },
    })
    expect(() => root.webuiRouter.href(
      { id: 'core:automation', version: 1 },
    )).toThrow('parameter is required')
    expect(() => root.webuiRouter.href(
      { id: 'core:missing', version: 1 },
    )).toThrow('route not found')
    await root.fiber.dispose()
  })

  it('reconciles popstate and Page Effect lifecycle changes', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    const environment = new FakeRouterEnvironment('http://numen.local/runs/run-1')
    await root.plugin(BrowserRouterService, { environment })
    const states: BrowserRouteState[] = []
    root.on('numen/webui-route-change', state => states.push(state))
    expect(root.webuiRouter.getState().status).toBe('NOT_FOUND')

    const extension = (ctx: Context) => {
      ctx.webuiExtensions.page(ctx, page('core:run', '/runs/:id'))
    }
    extension.inject = ['webuiExtensions']
    const fiber = await root.plugin(extension)
    expect(root.webuiRouter.getState()).toMatchObject({
      status: 'READY', parameters: { id: 'run-1' }, page: { id: 'core:run' },
    })

    environment.pop('/missing')
    expect(root.webuiRouter.getState()).toMatchObject({ status: 'NOT_FOUND', pathname: '/missing' })
    environment.pop('/runs/run-2')
    expect(root.webuiRouter.getState()).toMatchObject({ status: 'READY', parameters: { id: 'run-2' } })
    await fiber.dispose()
    expect(root.webuiRouter.getState().status).toBe('NOT_FOUND')
    expect(states.map(state => state.status)).toEqual(['READY', 'NOT_FOUND', 'READY', 'NOT_FOUND'])
    await root.fiber.dispose()
  })

  it('does not emit duplicate route changes for an unchanged URL', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.page(root, page('core:home', '/'))
    const environment = new FakeRouterEnvironment('http://numen.local/')
    await root.plugin(BrowserRouterService, { environment })
    const listener = vi.fn()
    root.on('numen/webui-route-change', listener)

    root.webuiRouter.reconcile()
    root.webuiRouter.reconcile()
    expect(listener).not.toHaveBeenCalled()
    await root.fiber.dispose()
  })

  it('reconciles the active Page object after an atomic snapshot replacement', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    const environment = new FakeRouterEnvironment('http://numen.local/automations')
    await root.plugin(BrowserRouterService, { environment })
    const listener = vi.fn()
    root.on('numen/webui-route-change', listener)
    const first = new FrontendExtensionStage()
    first.page(root, {
      ...page('core:automations', '/automations'), component: { generation: 1 },
    })
    root.webuiExtensions.activateSnapshot(1, first)
    expect(root.webuiRouter.getState().page?.component).toEqual({ generation: 1 })

    const second = new FrontendExtensionStage()
    second.page(root, {
      ...page('core:automations', '/automations'), component: { generation: 2 },
    })
    root.webuiExtensions.activateSnapshot(2, second)
    expect(root.webuiRouter.getState().page?.component).toEqual({ generation: 2 })
    expect(listener).toHaveBeenCalledTimes(2)
    await root.fiber.dispose()
  })
})
