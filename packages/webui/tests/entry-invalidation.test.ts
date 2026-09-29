import type { ConsoleEntryInvalidation, ConsoleEntryManifest, ConsoleSubscriptionServerMessage } from '@numenjs/console'
import { I18nService } from '@numenjs/i18n'
import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserConsoleClient, BrowserEntryLoader, BrowserExtensionRegistry, SchemaUIRegistry, type BrowserEntryModuleImporter } from '../src/index.js'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function manifest(revision: number, entries: Array<[string, string, number?]>, epoch = 'first'): ConsoleEntryManifest {
  return { epoch, revision, entries: entries.map(([id, url, incarnation = 1]) => ({ id, url, incarnation })), unavailable: [] }
}
function authority(value: ConsoleEntryManifest): ConsoleEntryInvalidation {
  return { epoch: value.epoch, revision: value.revision, entries: [...value.entries, ...value.unavailable].map(({ id, incarnation }) => ({ id, incarnation })) }
}
function pageModule(id: string, disposed = () => {}, installed = () => {}) {
  return { default(ctx: Context) {
    installed()
    ctx.webuiExtensions.page(ctx, { id, version: 1, path: `/${id}`, title: id, component: { id } })
    ctx.i18n.define(ctx, 'en-US', { [id]: `label:${id}` })
    ctx.effect(() => disposed)
  } }
}
class Socket extends EventTarget {
  readyState = WebSocket.CONNECTING
  id = ''
  constructor(private readonly initial: () => ConsoleEntryInvalidation, fail = false) {
    super()
    queueMicrotask(() => {
      if (fail) { this.close(); return }
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }
  send(data: string) {
    const message = JSON.parse(data)
    if (message.type !== 'subscribe') return
    this.id = message.id
    queueMicrotask(() => {
      this.receive({ type: 'event', id: this.id, event: this.initial() })
      this.receive({ type: 'ready', id: this.id, requestId: 'entry-watch' })
    })
  }
  receive(message: ConsoleSubscriptionServerMessage) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })) }
  close() {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    queueMicrotask(() => this.dispatchEvent(new Event('close')))
  }
}
async function setup(initial: ConsoleEntryManifest, importer: BrowserEntryModuleImporter, firstConnectionFails = false) {
  const root = new Context()
  roots.push(root)
  let current = initial
  let nextRead: (() => Promise<ConsoleEntryManifest>) | undefined
  const sockets: Socket[] = []
  await root.plugin(I18nService)
  await root.plugin(BrowserExtensionRegistry)
  await root.plugin(SchemaUIRegistry)
  await root.plugin(BrowserConsoleClient, {
    reconnectDelayMs: 0,
    environment: {
      location: { href: 'http://numen.local/' }, history: { state: null, replaceState() {} },
      fetch: async input => {
        if (String(input).endsWith('/session')) return Response.json({ principal: { subject: { type: 'user', id: 'owner' }, authenticated: true }, session: { id: 'test' } })
        const read = nextRead
        nextRead = undefined
        return Response.json(read ? await read() : current)
      },
    },
    createWebSocket() {
      const socket = new Socket(() => authority(current), firstConnectionFails && sockets.length === 0)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
  })
  await root.plugin(BrowserEntryLoader, { moduleImporter: importer })
  await vi.waitFor(() => expect(sockets.at(-1)?.id).not.toBe(''), { timeout: 2000 })
  return {
    root, sockets,
    set(value: ConsoleEntryManifest) { current = value },
    push(value = current) { sockets.at(-1)!.receive({ type: 'event', id: sockets.at(-1)!.id, event: authority(value) }) },
    nextRead(read: () => Promise<ConsoleEntryManifest>) { nextRead = read },
  }
}

describe('online Entry coordination', () => {
  it('recovers the watch after initial connection failure and provider withdrawal', async () => {
    const importer = vi.fn<BrowserEntryModuleImporter>(async () => pageModule('stable'))
    const fixture = await setup(manifest(1, [['stable', '/stable.js']]), importer, true)
    expect(fixture.sockets).toHaveLength(2)
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState().status).toBe('READY'))
    const socket = fixture.sockets.at(-1)!
    socket.receive({ type: 'complete', id: socket.id, reason: 'provider_unavailable' })
    fixture.set(manifest(2, []))
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(3), { timeout: 2000 })
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState()).toMatchObject({ status: 'READY', entries: [] }))
    expect(importer).toHaveBeenCalledOnce()
  })

  it('keeps an unrelated active page and its in-memory state mounted while adding and removing Entries', async () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()
    const importer = vi.fn<BrowserEntryModuleImporter>(async url => url.endsWith('/workbench.js')
      ? pageModule('workbench', unmounted, mounted) : pageModule('other'))
    const fixture = await setup(manifest(1, [['workbench', '/workbench.js']]), importer)
    const page = fixture.root.webuiExtensions.listPages()[0]
    const changed = vi.fn()
    fixture.root.on('numen/webui-extension-change', (kind, id) => { if (kind === 'page' && id === 'workbench@1') changed() })
    fixture.set(manifest(2, [['workbench', '/workbench.js'], ['other', '/other.js']]))
    fixture.push()
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState().entries).toEqual(['other', 'workbench']))
    expect(fixture.root.webuiExtensions.getPage({ id: 'workbench', version: 1 })).toBe(page)
    expect(mounted).toHaveBeenCalledOnce()
    expect(unmounted).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    fixture.set(manifest(3, [['workbench', '/workbench.js']]))
    fixture.push()
    expect(fixture.root.webuiExtensions.listPages().map(item => item.id)).toEqual(['workbench'])
    expect(mounted).toHaveBeenCalledOnce()
    expect(unmounted).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })

  it('revokes immediately while another replacement imports, and ignores its late completion', async () => {
    const gate = deferred<unknown>()
    const revoked = vi.fn()
    const late = vi.fn()
    const importer = vi.fn<BrowserEntryModuleImporter>(async url => {
      if (url.endsWith('/pending.js')) return gate.promise
      return pageModule(url.endsWith('/victim.js') ? 'victim' : 'stable', revoked)
    })
    const fixture = await setup(manifest(1, [['victim', '/victim.js'], ['stable', '/stable.js']]), importer)
    fixture.set(manifest(2, [['victim', '/victim.js'], ['stable', '/pending.js']]))
    fixture.push()
    await vi.waitFor(() => expect(importer).toHaveBeenCalledWith('http://numen.local/pending.js'))
    fixture.set(manifest(3, [['stable', '/stable.js']]))
    fixture.push()
    expect(fixture.root.webuiExtensions.getPage({ id: 'victim', version: 1 })).toBeUndefined()
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledOnce())
    gate.resolve(pageModule('late', () => {}, late))
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState()).toMatchObject({ status: 'READY', revision: 3, entries: ['stable'] }))
    expect(late).not.toHaveBeenCalled()
    expect(fixture.root.i18n.text([], 'victim')).toBe('victim')
    expect(fixture.root.webuiExtensions.listPages().map(item => item.id)).toEqual(['stable'])
  })

  it('keeps authorized old versions on failure, but never restores withdrawn or reincarnated Entries', async () => {
    const oldDisposed = vi.fn()
    const fixture = await setup(manifest(1, [['stable', '/stable.js'], ['victim', '/victim.js']]), async url => {
      if (url.includes('bad')) throw new Error('new module unavailable')
      return pageModule(url.endsWith('stable.js') ? 'stable' : 'victim', oldDisposed)
    })
    fixture.set(manifest(2, [['stable', '/bad-stable.js']]))
    fixture.push()
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState().status).toBe('ERROR'))
    expect(fixture.root.webuiExtensions.listPages().map(item => item.id)).toEqual(['stable'])
    expect(oldDisposed).toHaveBeenCalledOnce()
    fixture.set(manifest(3, [['stable', '/bad-reinstalled.js', 3]]))
    fixture.push()
    expect(fixture.root.webuiExtensions.listPages()).toEqual([])
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState().status).toBe('ERROR'))
    expect(oldDisposed).toHaveBeenCalledTimes(2)
  })

  it('removes revoked Entries even when another authorized source cannot be resolved', async () => {
    const fixture = await setup(manifest(1, [['stable', '/stable.js'], ['victim', '/victim.js']]), async url => pageModule(url.endsWith('/stable.js') ? 'stable' : 'victim'))
    fixture.set({ epoch: 'first', revision: 2, entries: [], unavailable: [{ id: 'stable', incarnation: 1, code: 'SOURCE_UNRESOLVABLE' }] })
    fixture.push()
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState().error?.code).toBe('ENTRY_SOURCE_UNAVAILABLE'))
    expect(fixture.root.webuiExtensions.listPages().map(item => item.id)).toEqual(['stable'])
    expect(fixture.root.i18n.text([], 'stable')).toBe('label:stable')
    expect(fixture.root.i18n.text([], 'victim')).toBe('victim')
  })

  it('disposes partially staged resources as soon as a newer notice fences their pending import', async () => {
    const gate = deferred<unknown>()
    const stagedDisposed = vi.fn()
    const importer = vi.fn<BrowserEntryModuleImporter>(async url => {
      if (url.endsWith('/pending.js')) return gate.promise
      return pageModule(url.endsWith('/staged.js') ? 'staged' : 'stable', stagedDisposed)
    })
    const fixture = await setup(manifest(1, [['stable', '/stable.js']]), importer)
    fixture.set(manifest(2, [['stable', '/stable.js'], ['a-staged', '/staged.js'], ['z-pending', '/pending.js']]))
    fixture.push()
    await vi.waitFor(() => expect(importer).toHaveBeenCalledWith('http://numen.local/pending.js'))
    fixture.set(manifest(3, [['stable', '/stable.js']]))
    fixture.push()
    await vi.waitFor(() => expect(stagedDisposed).toHaveBeenCalledOnce())
    gate.resolve(pageModule('pending'))
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState()).toMatchObject({ status: 'READY', entries: ['stable'] }))
    expect(stagedDisposed).toHaveBeenCalledOnce()
    expect(fixture.root.webuiExtensions.listPages().map(item => item.id)).toEqual(['stable'])
  })

  it('rejects late manifests and stale reconnect snapshots while accepting a new epoch with a reset revision', async () => {
    const importer = vi.fn<BrowserEntryModuleImporter>(async url => pageModule(url.includes('new') ? 'new' : 'old'))
    const fixture = await setup(manifest(50, [['old', '/old.js']]), importer)
    const gate = deferred<ConsoleEntryManifest>()
    fixture.nextRead(() => gate.promise)
    const pending = fixture.root.webuiLoader.reconcile()
    fixture.set(manifest(51, []))
    fixture.push()
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState()).toMatchObject({ status: 'READY', entries: [] }))
    gate.resolve(manifest(50, [['old', '/old.js']]))
    await expect(pending).resolves.toBe(false)
    expect(fixture.root.webuiExtensions.listPages()).toEqual([])
    const first = fixture.sockets[0]!
    fixture.set(manifest(1, [['new', '/new.js']], 'second'))
    first.close()
    await vi.waitFor(() => expect(fixture.root.webuiLoader.getState()).toMatchObject({ status: 'READY', revision: 1, entries: ['new'] }))
    first.receive({ type: 'event', id: first.id, event: authority(manifest(99, [['old', '/old.js']])) })
    fixture.push(manifest(100, [['old', '/old.js']]))
    await expect(fixture.root.webuiLoader.reconcile()).resolves.toBe(false)
    expect(fixture.root.webuiExtensions.listPages().map(item => item.id)).toEqual(['new'])
    fixture.set(manifest(0, [['old', '/old.js']], 'second'))
    await expect(fixture.root.webuiLoader.reconcile()).resolves.toBe(false)
    expect(fixture.root.webuiLoader.getState().error?.code).toBe('ENTRY_MANIFEST_STALE')
    expect(fixture.root.webuiExtensions.listPages().map(item => item.id)).toEqual(['new'])
  })

  it('does not wait for an unresolved import on shutdown or run a late plugin after disposal', async () => {
    const gate = deferred<unknown>()
    const late = vi.fn()
    const fixture = await setup(manifest(1, [['stable', '/stable.js']]), async url => url.includes('pending') ? gate.promise : pageModule('stable'))
    fixture.set(manifest(2, [['pending', '/pending.js']]))
    const pending = fixture.root.webuiLoader.reconcile()
    await Promise.resolve()
    await fixture.root.fiber.dispose()
    gate.resolve(pageModule('late', () => {}, late))
    await expect(pending).resolves.toBe(false)
    expect(late).not.toHaveBeenCalled()
  })
})
