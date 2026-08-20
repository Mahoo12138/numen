import type { ConsoleEntryManifest, ConsoleEntryManifestItem } from '@numen/console'
import { Service, type Context, type Fiber, type Plugin } from 'cordis'
import {
  BrowserExtensionRegistry,
  FrontendExtensionStage,
} from './extensions.js'
import './service.js'

export interface BrowserEntryModule {
  default: Plugin
}

export type BrowserEntryModuleImporter = (url: string) => Promise<unknown>

export interface BrowserEntryLoaderConfig {
  autoLoad?: boolean
  moduleImporter?: BrowserEntryModuleImporter
}

export type BrowserEntryLoaderStatus = 'IDLE' | 'LOADING' | 'READY' | 'ERROR'

export interface BrowserEntryLoaderState {
  status: BrowserEntryLoaderStatus
  revision?: number
  entries: string[]
  error?: {
    code: string
    message: string
  }
}

export class BrowserEntryLoaderError extends Error {
  override name = 'BrowserEntryLoaderError'

  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

declare module 'cordis' {
  interface Context {
    webuiLoader: BrowserEntryLoader
  }
}

interface ActiveBrowserSnapshot {
  revision: number
  entries: string[]
  fibers: Fiber[]
}

function defaultImporter(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url)
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === 'function'
    || Boolean(value && typeof value === 'object' && typeof (value as { apply?: unknown }).apply === 'function')
}

function readModule(value: unknown, entry: ConsoleEntryManifestItem): BrowserEntryModule {
  const candidate = value as { default?: unknown } | null
  if (!candidate || !isPlugin(candidate.default)) {
    throw new BrowserEntryLoaderError(
      'ENTRY_MODULE_INVALID',
      `frontend Entry does not export a default Cordis plugin: ${entry.id}`,
    )
  }
  return { default: candidate.default }
}

function resolveEntryUrl(entry: ConsoleEntryManifestItem, baseUrl: string): string {
  const base = new URL(baseUrl)
  const url = new URL(entry.url, base)
  if (url.origin !== base.origin) {
    throw new BrowserEntryLoaderError(
      'ENTRY_URL_CROSS_ORIGIN',
      `frontend Entry URL must be same-origin: ${entry.id}`,
    )
  }
  return url.href
}

function validateManifest(value: ConsoleEntryManifest): ConsoleEntryManifest {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new BrowserEntryLoaderError('ENTRY_MANIFEST_INVALID', 'frontend Entry manifest has an invalid revision')
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.unavailable)) {
    throw new BrowserEntryLoaderError('ENTRY_MANIFEST_INVALID', 'frontend Entry manifest has an invalid shape')
  }
  const ids = new Set<string>()
  for (const entry of value.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.url !== 'string' || !entry.url) {
      throw new BrowserEntryLoaderError('ENTRY_MANIFEST_INVALID', 'frontend Entry manifest contains an invalid entry')
    }
    if (ids.has(entry.id)) {
      throw new BrowserEntryLoaderError('ENTRY_MANIFEST_INVALID', `frontend Entry manifest repeats an id: ${entry.id}`)
    }
    ids.add(entry.id)
  }
  if (value.unavailable.length) {
    const unavailable = value.unavailable.map(item => item.id).sort().join(', ')
    throw new BrowserEntryLoaderError(
      'ENTRY_SOURCE_UNAVAILABLE',
      `frontend Entry sources are unavailable: ${unavailable}`,
    )
  }
  return value
}

function asLoaderError(error: unknown): BrowserEntryLoaderError {
  if (error instanceof BrowserEntryLoaderError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BrowserEntryLoaderError('ENTRY_RECONCILE_FAILED', message, { cause: error })
}

export class BrowserEntryLoader extends Service {
  static inject = ['consoleClient', 'webuiExtensions']

  private readonly autoLoad: boolean
  private readonly moduleImporter: BrowserEntryModuleImporter
  private active: ActiveBrowserSnapshot | undefined
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private state: BrowserEntryLoaderState = { status: 'IDLE', entries: [] }

  constructor(
    ctx: Context,
    config: BrowserEntryLoaderConfig = {},
  ) {
    super(ctx, 'webuiLoader')
    this.autoLoad = config.autoLoad ?? true
    this.moduleImporter = config.moduleImporter ?? defaultImporter
  }

  async *[Service.init]() {
    if (this.autoLoad) {
      await this.reconcile()
      const disposeListener = this.ctx.on('numen/console-reconcile', () => this.reconcile().then(() => undefined))
      yield disposeListener
    }
    yield async () => {
      this.disposed = true
      await this.queue
      if (!this.active) return
      this.ctx.webuiExtensions.deactivateSnapshot(this.active.revision)
      await this.disposeFibers(this.active.fibers)
      this.active = undefined
      this.state = { status: 'IDLE', entries: [] }
    }
  }

  getState(): BrowserEntryLoaderState {
    return {
      ...this.state,
      entries: [...this.state.entries],
      ...(this.state.error ? { error: { ...this.state.error } } : {}),
    }
  }

  reconcile(): Promise<boolean> {
    const task = this.queue.then(() => this.reconcileNow())
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async reconcileNow(): Promise<boolean> {
    if (this.disposed) throw new BrowserEntryLoaderError('ENTRY_LOADER_DISPOSED', 'frontend Entry loader is disposed')
    this.state = {
      status: 'LOADING',
      ...(this.active ? { revision: this.active.revision, entries: [...this.active.entries] } : { entries: [] }),
    }
    let manifest: ConsoleEntryManifest
    try {
      manifest = validateManifest(await this.ctx.consoleClient.getEntryManifest())
    } catch (error) {
      return this.fail(error)
    }
    if (manifest.revision === this.active?.revision) {
      this.state = {
        status: 'READY',
        revision: this.active.revision,
        entries: [...this.active.entries],
      }
      return false
    }

    const stage = new FrontendExtensionStage()
    const fibers: Fiber[] = []
    const entries = [...manifest.entries].sort((left, right) => left.id.localeCompare(right.id))
    try {
      for (const entry of entries) {
        const url = resolveEntryUrl(entry, this.ctx.consoleClient.baseUrl)
        const module = readModule(await this.moduleImporter(url), entry)
        const stagingContext = this.ctx.extend({
          baseUrl: url,
          webuiExtensions: stage as unknown as BrowserExtensionRegistry,
        })
        fibers.push(await stagingContext.plugin(module.default))
      }
      this.ctx.webuiExtensions.activateSnapshot(manifest.revision, stage)
    } catch (error) {
      await this.disposeFibers(fibers)
      return this.fail(error)
    }

    const previous = this.active
    this.active = {
      revision: manifest.revision,
      entries: entries.map(entry => entry.id),
      fibers,
    }
    this.state = {
      status: 'READY',
      revision: this.active.revision,
      entries: [...this.active.entries],
    }
    if (previous) await this.disposeFibers(previous.fibers)
    return true
  }

  private fail(error: unknown): false {
    const failure = asLoaderError(error)
    this.state = {
      status: 'ERROR',
      ...(this.active ? { revision: this.active.revision, entries: [...this.active.entries] } : { entries: [] }),
      error: { code: failure.code, message: failure.message },
    }
    if (!this.active) throw failure
    return false
  }

  private async disposeFibers(fibers: Fiber[]): Promise<void> {
    await Promise.allSettled([...fibers].reverse().map(fiber => fiber.dispose()))
  }
}

export default BrowserEntryLoader
