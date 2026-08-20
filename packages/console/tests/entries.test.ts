import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { ConsoleEntryRegistry } from '../src/index.js'

describe('ConsoleEntryRegistry', () => {
  it('owns direct frontend entries with Cordis Effects', async () => {
    const root = new Context()
    await root.plugin(ConsoleEntryRegistry)
    const extension = (ctx: Context) => {
      ctx.consoleEntries.addEntry(ctx, {
        id: '@example/foo:webui',
        dev: './client/index.ts',
        prod: './dist/client.js',
      })
    }
    extension.inject = ['consoleEntries']
    const plugin = await root.plugin(extension)

    expect(root.consoleEntries.list()).toEqual([{
      id: '@example/foo:webui',
      dev: './client/index.ts',
      prod: './dist/client.js',
    }])
    expect(root.consoleEntries.resolve('@example/foo:webui', 'dev')).toBe('./client/index.ts')
    await plugin.dispose()
    expect(root.consoleEntries.list()).toEqual([])
    await root.fiber.dispose()
  })

  it('validates staging before atomically replacing and retiring a generation', async () => {
    const root = new Context()
    await root.plugin(ConsoleEntryRegistry)
    const firstOwner = root.extend()
    let disposeFirst: (() => Promise<void>) | undefined
    const retireFirst = vi.fn(async () => disposeFirst?.())
    disposeFirst = await root.consoleEntries.replaceGeneration(firstOwner, {
      scopeId: '@example/foo:webui',
      generation: 1,
      entries: [{ id: '@example/foo:main', prod: './dist/v1.js' }],
      retire: retireFirst,
    })

    await expect(root.consoleEntries.replaceGeneration(root.extend(), {
      scopeId: '@example/foo:webui',
      generation: 2,
      entries: [
        { id: '@example/foo:duplicate', prod: './dist/a.js' },
        { id: '@example/foo:duplicate', prod: './dist/b.js' },
      ],
    })).rejects.toThrow('duplicate staged')
    expect(root.consoleEntries.resolve('@example/foo:main', 'prod')).toBe('./dist/v1.js')
    expect(retireFirst).not.toHaveBeenCalled()

    const secondOwner = root.extend()
    const disposeSecond = await root.consoleEntries.replaceGeneration(secondOwner, {
      scopeId: '@example/foo:webui',
      generation: 2,
      entries: [
        { id: '@example/foo:main', prod: './dist/v2.js' },
        { id: '@example/foo:settings', dev: './client/settings.ts' },
      ],
    })
    expect(retireFirst).toHaveBeenCalledTimes(1)
    expect(root.consoleEntries.list()).toEqual([
      expect.objectContaining({ id: '@example/foo:main', generation: 2, prod: './dist/v2.js' }),
      expect.objectContaining({ id: '@example/foo:settings', generation: 2 }),
    ])

    await disposeFirst?.()
    expect(root.consoleEntries.list()).toHaveLength(2)
    await disposeSecond()
    expect(root.consoleEntries.list()).toEqual([])
    await root.fiber.dispose()
  })

  it('rejects stale generations and cross-scope entry collisions', async () => {
    const root = new Context()
    await root.plugin(ConsoleEntryRegistry)
    await root.consoleEntries.replaceGeneration(root.extend(), {
      scopeId: 'plugin:first',
      generation: 3,
      entries: [{ id: 'shared:entry', prod: './first.js' }],
    })
    await expect(root.consoleEntries.replaceGeneration(root.extend(), {
      scopeId: 'plugin:first',
      generation: 3,
      entries: [{ id: 'shared:entry', prod: './stale.js' }],
    })).rejects.toThrow('stale console entry generation')
    await expect(root.consoleEntries.replaceGeneration(root.extend(), {
      scopeId: 'plugin:second',
      generation: 1,
      entries: [{ id: 'shared:entry', prod: './second.js' }],
    })).rejects.toThrow('already registered')
    expect(() => root.consoleEntries.addEntry(root, { id: 'invalid source', prod: './x.js' }))
      .toThrow('invalid console entry id')
    await root.fiber.dispose()
  })
})
