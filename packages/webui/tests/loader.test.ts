import type { ConsoleEntryManifest } from '@numen/console'
import { Context, type Plugin } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserConsoleClient,
  BrowserEntryLoader,
  BrowserEntryLoaderError,
  BrowserExtensionRegistry,
  type BrowserConsoleEnvironment,
  type BrowserEntryModuleImporter,
} from '../src/index.js'

const session = {
  principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
  session: { id: 'session_browser' },
}

function browserEnvironment(readManifest: () => ConsoleEntryManifest): BrowserConsoleEnvironment {
  return {
    location: { href: 'http://numen.local/' },
    history: { state: null, replaceState() {} },
    fetch: (async (input: string | URL | Request) => {
      if (String(input).endsWith('/session')) return Response.json(session)
      return Response.json(readManifest())
    }) as typeof fetch,
  }
}

function pagePlugin(
  id: string,
  path: string,
  onDispose?: () => void,
): Plugin {
  const plugin = (ctx: Context) => {
    ctx.webuiExtensions.page(ctx, { id, version: 1, path, title: id, component: { id } })
    if (onDispose) ctx.effect(() => onDispose)
  }
  plugin.inject = ['webuiExtensions']
  return plugin
}

describe('BrowserEntryLoader', () => {
  it('keeps modules staged until the complete manifest activates atomically', async () => {
    const manifest: ConsoleEntryManifest = {
      revision: 1,
      entries: [
        { id: 'plugin:page', url: '/assets/1/page.js' },
        { id: 'plugin:slot', url: '/assets/1/slot.js' },
      ],
      unavailable: [],
    }
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    await root.plugin(BrowserConsoleClient, { environment: browserEnvironment(() => manifest) })
    const slot = { id: 'plugin:toolbar', version: 1 }
    const importer = vi.fn<BrowserEntryModuleImporter>(async (url) => {
      if (url.endsWith('/page.js')) {
        return { default: pagePlugin('plugin:page', '/plugin') }
      }
      expect(root.webuiExtensions.listPages()).toEqual([])
      const plugin = (ctx: Context) => {
        ctx.webuiExtensions.contribute(ctx, {
          id: 'plugin:item', slot, content: { id: 'item' },
        })
        ctx.webuiExtensions.slot(ctx, slot)
      }
      plugin.inject = ['webuiExtensions']
      return { default: plugin }
    })

    await root.plugin(BrowserEntryLoader, { moduleImporter: importer })

    expect(root.webuiExtensions.getSnapshotRevision()).toBe(1)
    expect(root.webuiExtensions.listPages().map(page => page.path)).toEqual(['/plugin'])
    expect(root.webuiExtensions.listContributions(slot).map(item => item.id)).toEqual(['plugin:item'])
    expect(root.webuiLoader.getState()).toEqual({
      status: 'READY', revision: 1, entries: ['plugin:page', 'plugin:slot'],
    })
    await root.fiber.dispose()
  })

  it('retires the old fibers only after a successful replacement', async () => {
    let manifest: ConsoleEntryManifest = {
      revision: 1,
      entries: [{ id: 'plugin:entry', url: '/assets/1/entry.js' }],
      unavailable: [],
    }
    const retired: string[] = []
    const importer = vi.fn<BrowserEntryModuleImporter>(async (url) => ({
      default: url.includes('/1/')
        ? pagePlugin('plugin:v1', '/v1', () => retired.push('v1'))
        : pagePlugin('plugin:v2', '/v2', () => retired.push('v2')),
    }))
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    await root.plugin(BrowserConsoleClient, { environment: browserEnvironment(() => manifest) })
    await root.plugin(BrowserEntryLoader, { moduleImporter: importer })

    manifest = {
      revision: 2,
      entries: [{ id: 'plugin:entry', url: '/assets/2/entry.js' }],
      unavailable: [],
    }
    await root.parallel('numen/console-reconcile')
    expect(root.webuiExtensions.listPages().map(page => page.path)).toEqual(['/v2'])
    expect(retired).toEqual(['v1'])

    await expect(root.webuiLoader.reconcile()).resolves.toBe(false)
    expect(importer).toHaveBeenCalledTimes(2)
    await root.fiber.dispose()
    expect(retired).toEqual(['v1', 'v2'])
  })

  it('disposes a failed generation and retains the active snapshot', async () => {
    let manifest: ConsoleEntryManifest = {
      revision: 1,
      entries: [{ id: 'plugin:stable', url: '/assets/1/stable.js' }],
      unavailable: [],
    }
    let stagedDisposals = 0
    const importer = vi.fn<BrowserEntryModuleImporter>(async (url) => {
      if (url.endsWith('/stable.js')) return { default: pagePlugin('plugin:stable', '/stable') }
      if (url.endsWith('/a-stage.js')) {
        return { default: pagePlugin('plugin:staged', '/staged', () => stagedDisposals++) }
      }
      return { default: null }
    })
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    await root.plugin(BrowserConsoleClient, { environment: browserEnvironment(() => manifest) })
    await root.plugin(BrowserEntryLoader, { moduleImporter: importer })

    manifest = {
      revision: 2,
      entries: [
        { id: 'plugin:a-stage', url: '/assets/2/a-stage.js' },
        { id: 'plugin:z-bad', url: '/assets/2/z-bad.js' },
      ],
      unavailable: [],
    }
    await expect(root.webuiLoader.reconcile()).resolves.toBe(false)
    expect(stagedDisposals).toBe(1)
    expect(root.webuiExtensions.getSnapshotRevision()).toBe(1)
    expect(root.webuiExtensions.listPages().map(page => page.path)).toEqual(['/stable'])
    expect(root.webuiLoader.getState()).toMatchObject({
      status: 'ERROR',
      revision: 1,
      entries: ['plugin:stable'],
      error: { code: 'ENTRY_MODULE_INVALID' },
    })
    await root.fiber.dispose()
  })

  it('rolls back staged fibers when atomic registry activation rejects a collision', async () => {
    let manifest: ConsoleEntryManifest = {
      revision: 1,
      entries: [{ id: 'plugin:stable', url: '/assets/1/stable.js' }],
      unavailable: [],
    }
    let stagedDisposals = 0
    const importer = vi.fn<BrowserEntryModuleImporter>(async (url) => ({
      default: url.endsWith('/stable.js')
        ? pagePlugin('plugin:stable', '/stable')
        : pagePlugin('plugin:collision', '/core', () => stagedDisposals++),
    }))
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    root.webuiExtensions.page(root, {
      id: 'core:home', version: 1, path: '/core', title: 'Core', component: null,
    })
    await root.plugin(BrowserConsoleClient, { environment: browserEnvironment(() => manifest) })
    await root.plugin(BrowserEntryLoader, { moduleImporter: importer })

    manifest = {
      revision: 2,
      entries: [{ id: 'plugin:collision', url: '/assets/2/collision.js' }],
      unavailable: [],
    }
    await expect(root.webuiLoader.reconcile()).resolves.toBe(false)
    expect(stagedDisposals).toBe(1)
    expect(root.webuiExtensions.getSnapshotRevision()).toBe(1)
    expect(root.webuiExtensions.listPages().map(page => page.path)).toEqual(['/core', '/stable'])
    expect(root.webuiLoader.getState()).toMatchObject({
      status: 'ERROR', revision: 1, error: { code: 'ENTRY_RECONCILE_FAILED' },
    })
    await root.fiber.dispose()
  })

  it('rejects an unavailable initial snapshot', async () => {
    const manifest: ConsoleEntryManifest = {
      revision: 1,
      entries: [],
      unavailable: [{ id: 'plugin:missing', code: 'SOURCE_UNRESOLVABLE' }],
    }
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    await root.plugin(BrowserConsoleClient, { environment: browserEnvironment(() => manifest) })

    await expect(root.plugin(BrowserEntryLoader)).rejects.toMatchObject<Partial<BrowserEntryLoaderError>>({
      code: 'ENTRY_SOURCE_UNAVAILABLE',
    })
    expect(root.webuiExtensions.getSnapshotRevision()).toBeUndefined()
    await root.fiber.dispose()
  })

  it('rejects cross-origin Entry module URLs before importing code', async () => {
    const manifest: ConsoleEntryManifest = {
      revision: 1,
      entries: [{ id: 'plugin:remote', url: 'https://untrusted.example/entry.js' }],
      unavailable: [],
    }
    const importer = vi.fn<BrowserEntryModuleImporter>()
    const root = new Context()
    await root.plugin(BrowserExtensionRegistry)
    await root.plugin(BrowserConsoleClient, { environment: browserEnvironment(() => manifest) })

    await expect(root.plugin(BrowserEntryLoader, { moduleImporter: importer }))
      .rejects.toMatchObject<Partial<BrowserEntryLoaderError>>({ code: 'ENTRY_URL_CROSS_ORIGIN' })
    expect(importer).not.toHaveBeenCalled()
    await root.fiber.dispose()
  })
})
