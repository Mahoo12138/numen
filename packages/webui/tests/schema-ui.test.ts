import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserExtensionRegistry,
  FrontendExtensionStage,
  SchemaUIRegistry,
} from '../src/index.js'

describe('SchemaUIRegistry', () => {
  it('resolves role renderers before type fallbacks and owns them with Effects', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    await root.plugin(SchemaUIRegistry)
    const listener = vi.fn()
    root.schemaUI.subscribe(listener)
    const typeRenderer = { name: 'StringEditor' }
    const roleViewer = { name: 'ExpressionViewer' }
    const rolePlugin = (ctx: Context) => {
      ctx.schemaUI.defineRenderer(ctx, {
        id: 'test:expression-viewer',
        version: 1,
        role: 'numen/expression',
        viewer: roleViewer,
      })
    }
    rolePlugin.inject = ['schemaUI']
    const typePlugin = (ctx: Context) => {
      ctx.schemaUI.defineRenderer(ctx, {
        id: 'test:string-editor',
        version: 1,
        type: 'string',
        editor: typeRenderer,
      })
    }
    typePlugin.inject = ['schemaUI']
    const roleFiber = await root.plugin(rolePlugin)
    const typeFiber = await root.plugin(typePlugin)

    expect(root.schemaUI.resolveRenderer({ role: 'numen/expression', type: 'string' }, 'viewer')).toBe(roleViewer)
    expect(root.schemaUI.resolveRenderer({ role: 'numen/expression', type: 'string' }, 'editor')).toBe(typeRenderer)
    expect(root.schemaUI.resolveRenderer({ type: 'string' }, 'editor')).toBe(typeRenderer)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(root.schemaUI.getSnapshot()).toBe(2)

    await typeFiber.dispose()
    expect(root.schemaUI.resolveRenderer({ type: 'string' }, 'editor')).toBeUndefined()
    await roleFiber.dispose()
    expect(root.schemaUI.resolveRenderer({ role: 'numen/expression', type: 'string' }, 'viewer')).toBeUndefined()
    expect(root.schemaUI.getSnapshot()).toBe(4)
    await root.fiber.dispose()
  })

  it('rejects shallow or colliding renderer registrations', async () => {
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    await root.plugin(SchemaUIRegistry)
    expect(() => root.schemaUI.defineRenderer(root, {
      id: 'test:empty', version: 1, type: 'string',
    })).toThrow('requires an editor, viewer, or compact')
    expect(() => root.schemaUI.defineRenderer(root, {
      id: 'test:ambiguous', version: 1, type: 'string', role: 'numen/expression', editor: null,
    })).toThrow('exactly one role or type')
    root.schemaUI.defineRenderer(root, {
      id: 'test:string', version: 1, type: 'string', editor: null,
    })
    expect(() => root.schemaUI.defineRenderer(root, {
      id: 'test:string-collision', version: 1, type: 'string', editor: null,
    })).toThrow('target already registered')
    const stage = new FrontendExtensionStage()
    stage.defineSchemaRenderer(root, {
      id: 'test:staged-string', version: 1, type: 'string', editor: null,
    })
    expect(() => root.webuiExtensions.activateSnapshot(1, stage)).toThrow('target already registered')
    expect(root.webuiExtensions.getSnapshotRevision()).toBeUndefined()
    await root.fiber.dispose()
  })
})
