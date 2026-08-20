import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  BrowserExtensionRegistry,
  FrontendExtensionStage,
  startBrowserRuntime,
} from '../src/index.js'

const inspector = { id: 'automation.editor.inspector.after', version: 1 }

describe('BrowserExtensionRegistry', () => {
  it('owns Page, Slot, and Contribution registrations with Cordis Effects', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.slot(root, inspector)
    const extension = (ctx: Context) => {
      ctx.webuiExtensions.page(ctx, {
        id: '@example/foo:settings',
        version: 1,
        path: '/settings/foo',
        title: 'Foo',
        component: { name: 'FooPage' },
      })
      ctx.webuiExtensions.contribute(ctx, {
        id: '@example/foo:inspector',
        slot: inspector,
        content: { name: 'FooInspector' },
      })
    }
    extension.inject = ['webuiExtensions']
    const plugin = await root.plugin(extension)

    expect(root.webuiExtensions.listPages()).toHaveLength(1)
    expect(root.webuiExtensions.listContributions(inspector)).toHaveLength(1)
    await plugin.dispose()
    expect(root.webuiExtensions.listPages()).toEqual([])
    expect(root.webuiExtensions.listContributions(inspector)).toEqual([])
    await root.fiber.dispose()
  })

  it('orders contributions by constraints, numeric order, and stable ID', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.slot(root, inspector)
    const add = (id: string, options: { order?: number; before?: string[]; after?: string[] } = {}) => {
      root.webuiExtensions.contribute(root, { id, slot: inspector, content: id, ...options })
    }
    add('core:middle')
    add('plugin:z-last', { order: 10 })
    add('plugin:a-peer')
    add('plugin:forced-first', { before: ['core:middle'] })
    add('plugin:after-middle', { after: ['core:middle'], order: -100 })

    expect(root.webuiExtensions.listContributions<string>(inspector).map(item => item.id)).toEqual([
      'plugin:a-peer',
      'plugin:forced-first',
      'core:middle',
      'plugin:after-middle',
      'plugin:z-last',
    ])
    await root.fiber.dispose()
  })

  it('rejects collisions, invalid references, and ordering cycles', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.slot(root, inspector)
    root.webuiExtensions.page(root, {
      id: 'core:first', version: 1, path: '/same', title: 'First', component: null,
    })
    expect(() => root.webuiExtensions.page(root, {
      id: 'core:second', version: 1, path: '/same', title: 'Second', component: null,
    })).toThrow('path already registered')
    root.webuiExtensions.page(root, {
      id: 'core:detail', version: 1, path: '/items/:id', title: 'Detail', component: null,
    })
    expect(() => root.webuiExtensions.page(root, {
      id: 'core:ambiguous', version: 1, path: '/items/:name', title: 'Ambiguous', component: null,
    })).toThrow('path already registered')
    expect(() => root.webuiExtensions.page(root, {
      id: 'core:invalid', version: 1, path: '/items/:bad-name', title: 'Invalid', component: null,
    })).toThrow('invalid frontend page parameter')
    expect(() => root.webuiExtensions.page(root, {
      id: 'core:trailing', version: 1, path: '/items/', title: 'Trailing', component: null,
    })).toThrow('invalid frontend page path')
    expect(() => root.webuiExtensions.page(root, {
      id: 'core:empty-segment', version: 1, path: '/items//edit', title: 'Empty', component: null,
    })).toThrow('invalid frontend page path')
    expect(() => root.webuiExtensions.contribute(root, {
      id: 'plugin:missing', slot: { ...inspector, version: 2 }, content: null,
    })).toThrow('slot not found')

    root.webuiExtensions.contribute(root, {
      id: 'plugin:left', slot: inspector, content: null, before: ['plugin:right'],
    })
    expect(() => root.webuiExtensions.contribute(root, {
      id: 'plugin:right', slot: inspector, content: null, before: ['plugin:left'],
    })).toThrow('ordering cycle')
    await root.fiber.dispose()
  })

  it('atomically activates a validated staged snapshot', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.slot(root, inspector)
    root.webuiExtensions.contribute(root, {
      id: 'core:first', slot: inspector, content: 'core',
    })
    const stage = new FrontendExtensionStage()
    stage.page(root, {
      id: 'plugin:page', version: 1, path: '/plugin', title: 'Plugin', component: null,
    })
    stage.contribute(root, {
      id: 'plugin:after', slot: inspector, content: 'plugin', after: ['core:first'],
    })

    expect(root.webuiExtensions.listPages()).toEqual([])
    root.webuiExtensions.activateSnapshot(7, stage)
    expect(root.webuiExtensions.getSnapshotRevision()).toBe(7)
    expect(root.webuiExtensions.listPages().map(page => page.path)).toEqual(['/plugin'])
    expect(root.webuiExtensions.listContributions(inspector).map(item => item.id)).toEqual([
      'core:first',
      'plugin:after',
    ])
    expect(root.webuiExtensions.deactivateSnapshot(6)).toBe(false)
    expect(root.webuiExtensions.deactivateSnapshot(7)).toBe(true)
    expect(root.webuiExtensions.listPages()).toEqual([])
    await root.fiber.dispose()
  })

  it('keeps the active snapshot when a replacement fails validation', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.page(root, {
      id: 'core:home', version: 1, path: '/home', title: 'Home', component: null,
    })
    const first = new FrontendExtensionStage()
    first.page(root, {
      id: 'plugin:first', version: 1, path: '/first', title: 'First', component: null,
    })
    root.webuiExtensions.activateSnapshot(1, first)

    const invalid = new FrontendExtensionStage()
    invalid.page(root, {
      id: 'plugin:collision', version: 1, path: '/home', title: 'Collision', component: null,
    })
    expect(() => root.webuiExtensions.activateSnapshot(2, invalid)).toThrow('path already registered')
    expect(root.webuiExtensions.getSnapshotRevision()).toBe(1)
    expect(root.webuiExtensions.listPages().map(page => page.path)).toEqual(['/first', '/home'])
    expect(() => root.webuiExtensions.activateSnapshot(1, new FrontendExtensionStage())).toThrow('stale')
    await root.fiber.dispose()
  })

  it('validates cross-snapshot ordering and late slot references at activation', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.slot(root, inspector)
    root.webuiExtensions.contribute(root, {
      id: 'core:left', slot: inspector, content: null, before: ['plugin:right'],
    })
    const invalid = new FrontendExtensionStage()
    invalid.contribute(root, {
      id: 'plugin:right', slot: inspector, content: null, before: ['core:left'],
    })

    expect(() => root.webuiExtensions.activateSnapshot(1, invalid)).toThrow('ordering cycle')
    expect(root.webuiExtensions.getSnapshotRevision()).toBeUndefined()

    const stagedSlot = { id: 'plugin:toolbar', version: 1 }
    const valid = new FrontendExtensionStage()
    valid.contribute(root, { id: 'plugin:item', slot: stagedSlot, content: null })
    valid.slot(root, stagedSlot)
    root.webuiExtensions.activateSnapshot(1, valid)
    expect(root.webuiExtensions.listContributions(stagedSlot).map(item => item.id)).toEqual(['plugin:item'])
    await root.fiber.dispose()
  })

  it('starts and stops a composed Browser Cordis Runtime', async () => {
    const routerLocation = { href: 'http://numen.local/' }
    const runtime = await startBrowserRuntime({
      entries: { autoLoad: false },
      router: {
        environment: {
          location: routerLocation,
          history: {
            state: null,
            pushState(_data, _unused, url) {
              if (url !== undefined && url !== null) routerLocation.href = new URL(String(url), routerLocation.href).href
            },
            replaceState(_data, _unused, url) {
              if (url !== undefined && url !== null) routerLocation.href = new URL(String(url), routerLocation.href).href
            },
          },
          addEventListener() {},
          removeEventListener() {},
        },
      },
      console: {
        environment: {
          location: { href: 'http://numen.local/' },
          history: { state: null, replaceState() {} },
          fetch: (async () => Response.json({
            principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
            session: { id: 'session-browser' },
          })) as typeof fetch,
        },
      },
    })
    expect(runtime.context.consoleClient.session).toBeDefined()
    expect(runtime.context.webuiExtensions.listPages()).toEqual([])
    await runtime.stop()
    await runtime.stop()
    expect(runtime.context.consoleClient).toBeUndefined()
  })
})
