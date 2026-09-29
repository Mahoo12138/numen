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
  private entries: Array<{ href: string; state: unknown }>
  private index = 0

  constructor(href: string) {
    this.location = { href }
    this.entries = [{ href, state: null }]
    this.history = {
      state: null,
      pushState: (data, _unused, url) => {
        this.entries.splice(++this.index)
        this.entries.push({ state: data, href: new URL(String(url ?? this.location.href), this.location.href).href })
        this.restore()
      },
      replaceState: (data, _unused, url) => {
        this.entries[this.index] = { state: data, href: new URL(String(url ?? this.location.href), this.location.href).href }
        this.restore()
      },
      go: delta => {
        const next = this.index + (delta ?? 0)
        if (next < 0 || next >= this.entries.length) return
        this.index = next
        this.restore()
        for (const listener of this.popStateListeners) listener()
      },
    }
  }

  private restore() {
    const entry = this.entries[this.index]!
    this.location.href = entry.href
    this.history.state = entry.state
  }
  addEventListener(_type: 'popstate', listener: () => void): void { this.popStateListeners.add(listener) }
  removeEventListener(_type: 'popstate', listener: () => void): void { this.popStateListeners.delete(listener) }
  pop(href: string): void {
    this.history.replaceState(null, '', href)
    for (const listener of this.popStateListeners) listener()
  }
}

function page(id: string, path: string) {
  return { id, version: 1, path, title: id, component: { id } }
}

describe('BrowserRouterService', () => {
  it('protects push, replace, back and forward without discarding history entries', async () => {
    const root = new Context()
    try {
      await root.plugin(BrowserExtensionRegistry)
      root.webuiExtensions.page(root, page('home', '/'))
      root.webuiExtensions.page(root, page('editor', '/editor'))
      root.webuiExtensions.page(root, page('runs', '/runs'))
      const environment = new FakeRouterEnvironment('http://numen.local/')
      await root.plugin(BrowserRouterService, { environment })
      root.webuiRouter.navigate({ id: 'editor', version: 1 })
      let allow = false
      const attempts: string[] = []
      const dispose = root.webuiRouter.beforeLeave(attempt => { attempts.push(attempt.reason); return allow })
      const snapshot = root.webuiRouter.getSnapshot()
      root.webuiRouter.navigate({ id: 'runs', version: 1 })
      root.webuiRouter.navigate({ id: 'runs', version: 1 }, { replace: true })
      environment.history.go(-1)
      expect(root.webuiRouter.getSnapshot()).toBe(snapshot)
      expect(environment.location.href).toBe('http://numen.local/editor')
      expect(attempts).toEqual(['navigate', 'navigate', 'popstate'])
      allow = true
      environment.history.go(-1)
      expect(root.webuiRouter.getState().pathname).toBe('/')
      allow = false
      environment.history.go(1)
      expect(root.webuiRouter.getState().pathname).toBe('/')
      expect(environment.location.href).toBe('http://numen.local/')
      dispose()
      environment.history.go(1)
      expect(root.webuiRouter.getState().pathname).toBe('/editor')
      root.webuiRouter.navigate({ id: 'runs', version: 1 })
      environment.history.go(-2)
      expect(root.webuiRouter.getState().pathname).toBe('/')
      environment.history.go(2)
      expect(root.webuiRouter.getState().pathname).toBe('/runs')
    } finally { await root.fiber.dispose() }
  })

  it('keeps guards off registry reconciliation and restores an unknown rejected history entry', async () => {
    const root = new Context()
    try {
      await root.plugin(BrowserExtensionRegistry)
      root.webuiExtensions.page(root, page('editor', '/editor'))
      const environment = new FakeRouterEnvironment('http://numen.local/editor?panel=source')
      await root.plugin(BrowserRouterService, { environment })
      const guard = vi.fn(() => false)
      root.webuiRouter.beforeLeave(guard)
      root.webuiRouter.reconcile(true)
      expect(guard).not.toHaveBeenCalled()
      environment.pop('/external')
      expect(guard).toHaveBeenCalledOnce()
      expect(environment.location.href).toBe('http://numen.local/editor?panel=source')
      expect(root.webuiRouter.getState()).toMatchObject({ pathname: '/editor', search: '?panel=source' })
    } finally { await root.fiber.dispose() }
  })

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

  it('keeps logical Page paths behind a deployment base path', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.page(root, page('core:automations', '/automations'))
    const environment = new FakeRouterEnvironment('http://numen.local/workbench/automations')
    await root.plugin(BrowserRouterService, { environment, basePath: '/workbench/' })

    expect(root.webuiRouter.getState()).toMatchObject({
      status: 'READY',
      pathname: '/automations',
      page: { id: 'core:automations' },
    })
    expect(root.webuiRouter.href({ id: 'core:automations', version: 1 })).toBe('/workbench/automations')
    root.webuiExtensions.page(root, page('core:home', '/'))
    root.webuiRouter.navigate({ id: 'core:home', version: 1 })
    expect(environment.location.href).toBe('http://numen.local/workbench/')
    expect(root.webuiRouter.getState()).toMatchObject({ status: 'READY', pathname: '/' })
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

  it('publishes stable external-store snapshots only until unsubscribe', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.page(root, page('core:home', '/'))
    root.webuiExtensions.page(root, page('core:runs', '/runs'))
    const environment = new FakeRouterEnvironment('http://numen.local/')
    await root.plugin(BrowserRouterService, { environment })
    const listener = vi.fn()
    const unsubscribe = root.webuiRouter.subscribe(listener)
    const firstSnapshot = root.webuiRouter.getSnapshot()

    root.webuiRouter.reconcile()
    expect(root.webuiRouter.getSnapshot()).toBe(firstSnapshot)
    expect(listener).not.toHaveBeenCalled()
    root.webuiRouter.navigate({ id: 'core:runs', version: 1 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(root.webuiRouter.getSnapshot()).not.toBe(firstSnapshot)
    unsubscribe()
    environment.pop('/')
    expect(listener).toHaveBeenCalledTimes(1)
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
