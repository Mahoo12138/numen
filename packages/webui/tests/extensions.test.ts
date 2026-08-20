import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { BrowserExtensionRegistry, startBrowserRuntime } from '../src/index.js'

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

  it('starts and stops a composed Browser Cordis Runtime', async () => {
    const runtime = await startBrowserRuntime({
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
