import type { ConsoleEntryInvalidation, ConsoleEntryManifest, ConsoleEntryManifestItem } from '@numenjs/console'
import type { I18nService, I18nStage } from '@numenjs/i18n'
import { Service, type Context, type Fiber, type Plugin } from 'cordis'
import { BrowserExtensionRegistry, FrontendExtensionStage } from './extensions.js'
import './service.js'

export interface BrowserEntryModule { default: Plugin }
export type BrowserEntryModuleImporter = (url: string) => Promise<unknown>
export interface BrowserEntryLoaderConfig {
  autoLoad?: boolean
  watch?: boolean
  moduleImporter?: BrowserEntryModuleImporter
}
export type BrowserEntryLoaderStatus = 'IDLE' | 'LOADING' | 'READY' | 'ERROR'
export interface BrowserEntryLoaderState {
  status: BrowserEntryLoaderStatus
  revision?: number
  entries: string[]
  error?: { code: string; message: string }
}
export class BrowserEntryLoaderError extends Error {
  override name = 'BrowserEntryLoaderError'
  constructor(public readonly code: string, message: string, options?: ErrorOptions) { super(message, options) }
}
declare module 'cordis' { interface Context { webuiLoader: BrowserEntryLoader } }
interface ActiveBrowserEntry {
  epoch: string
  definition: ConsoleEntryManifestItem
  url: string
  fiber: Fiber
  stage: FrontendExtensionStage
  localeStage?: I18nStage
}
const changedRef = { id: 'console:entries-changed', version: 1 }
function defaultImporter(url: string): Promise<unknown> { return import(/* @vite-ignore */ url) }
function readModule(value: unknown, entry: ConsoleEntryManifestItem): BrowserEntryModule {
  const plugin = (value as { default?: unknown } | null)?.default
  if (typeof plugin !== 'function' && !(plugin && typeof plugin === 'object' && typeof (plugin as { apply?: unknown }).apply === 'function')) {
    throw new BrowserEntryLoaderError('ENTRY_MODULE_INVALID', `frontend Entry does not export a default Cordis plugin: ${entry.id}`)
  }
  return { default: plugin as Plugin }
}
function resolveEntryUrl(entry: ConsoleEntryManifestItem, baseUrl: string): string {
  const base = new URL(baseUrl)
  const url = new URL(entry.url, base)
  if (url.origin !== base.origin) throw new BrowserEntryLoaderError('ENTRY_URL_CROSS_ORIGIN', `frontend Entry URL must be same-origin: ${entry.id}`)
  return url.href
}
function validateAuthority(value: ConsoleEntryInvalidation): void {
  if (!value || typeof value.epoch !== 'string' || !value.epoch || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries)) {
    throw new BrowserEntryLoaderError('ENTRY_MANIFEST_INVALID', 'frontend Entry authority has an invalid shape')
  }
  const ids = new Set<string>()
  for (const entry of value.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || !Number.isSafeInteger(entry.incarnation) || entry.incarnation < 1 || ids.has(entry.id)) {
      throw new BrowserEntryLoaderError('ENTRY_MANIFEST_INVALID', 'frontend Entry authority contains an invalid or repeated identity')
    }
    ids.add(entry.id)
  }
}
function validateManifest(value: ConsoleEntryManifest): ConsoleEntryManifest {
  if (!value || !Array.isArray(value.entries) || !Array.isArray(value.unavailable)) {
    throw new BrowserEntryLoaderError('ENTRY_MANIFEST_INVALID', 'frontend Entry manifest has an invalid shape')
  }
  validateAuthority({ ...value, entries: [...value.entries, ...value.unavailable] })
  for (const entry of value.entries) {
    if (typeof entry.url !== 'string' || !entry.url) throw new BrowserEntryLoaderError('ENTRY_MANIFEST_INVALID', 'frontend Entry manifest contains an invalid URL')
  }
  for (const entry of value.unavailable) {
    if (entry.code !== 'SOURCE_UNRESOLVABLE') throw new BrowserEntryLoaderError('ENTRY_MANIFEST_INVALID', 'frontend Entry manifest contains an invalid availability code')
  }
  return value
}
function asLoaderError(error: unknown): BrowserEntryLoaderError {
  return error instanceof BrowserEntryLoaderError ? error : new BrowserEntryLoaderError('ENTRY_RECONCILE_FAILED', error instanceof Error ? error.message : String(error), { cause: error })
}

export class BrowserEntryLoader extends Service {
  static inject = ['consoleClient', 'webuiExtensions', 'schemaUI']
  private readonly autoLoad: boolean
  private readonly watch: boolean
  private readonly moduleImporter: BrowserEntryModuleImporter
  private active = new Map<string, ActiveBrowserEntry>()
  private authority: ConsoleEntryInvalidation | undefined
  private readonly retiredEpochs = new Set<string>()
  private generation = 0
  private readonly staging = new Map<number, Fiber[]>()
  private fetchController: AbortController | undefined
  private snapshotRevision = 0
  private committedRevision: number | undefined
  private disposed = false
  private state: BrowserEntryLoaderState = { status: 'IDLE', entries: [] }

  constructor(ctx: Context, config: BrowserEntryLoaderConfig = {}) {
    super(ctx, 'webuiLoader')
    this.autoLoad = config.autoLoad ?? true
    this.watch = config.watch ?? true
    this.moduleImporter = config.moduleImporter ?? defaultImporter
  }

  async *[Service.init]() {
    const subscriptionController = new AbortController()
    yield async () => {
      this.disposed = true
      this.invalidatePending()
      subscriptionController.abort()
      this.ctx.webuiExtensions.deactivateSnapshot(this.snapshotRevision)
      this.localeService()?.deactivateSnapshot(this.snapshotRevision)
      await this.disposeFibers([...this.active.values()].map(entry => entry.fiber))
      this.active.clear()
      this.state = { status: 'IDLE', entries: [] }
    }
    if (!this.autoLoad) return
    yield this.ctx.on('numen/console-reconcile', () => this.reconcile().then(() => undefined))
    await this.reconcile()
    if (!this.watch || this.disposed) return
    this.watchEntries(subscriptionController.signal)
  }

  getState(): BrowserEntryLoaderState {
    return { ...this.state, entries: [...this.state.entries], ...(this.state.error ? { error: { ...this.state.error } } : {}) }
  }

  reconcile(): Promise<boolean> {
    if (this.disposed) return Promise.reject(new BrowserEntryLoaderError('ENTRY_LOADER_DISPOSED', 'frontend Entry loader is disposed'))
    this.invalidatePending()
    const generation = this.generation
    const controller = this.fetchController = new AbortController()
    this.state = { status: 'LOADING', ...this.snapshotState() }
    return this.reconcileNow(generation, controller.signal)
  }

  private current(generation: number): boolean { return !this.disposed && this.generation === generation }

  private watchEntries(signal: AbortSignal): void {
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt: AbortController | undefined
    const schedule = () => {
      if (signal.aborted || timer !== undefined) return
      attempt?.abort()
      timer = setTimeout(() => { timer = undefined; connect() }, 500)
    }
    const connect = () => {
      if (signal.aborted) return
      attempt = new AbortController()
      // The initial snapshot closes the gap after startup and after a provider
      // disappears. Ordinary socket reconnects are handled by the shared client.
      void this.ctx.consoleClient.subscribe<Record<string, never>, ConsoleEntryInvalidation>(changedRef, {}, {
        event: notice => {
          if (signal.aborted) return
          validateAuthority(notice)
          if (!this.acceptAuthority(notice) && (this.isStale(notice) || this.state.status !== 'ERROR')) return
          void this.reconcile().catch(error => this.ctx.logger('webui:entries').warn(error))
        },
        complete: schedule,
        error: error => { if (!signal.aborted) { this.fail(error); schedule() } },
      }, attempt.signal).catch(error => {
        if (!signal.aborted) { this.fail(error); schedule() }
      })
    }
    signal.addEventListener('abort', () => {
      if (timer !== undefined) clearTimeout(timer)
      attempt?.abort()
    }, { once: true })
    connect()
  }

  private async reconcileNow(generation: number, signal: AbortSignal): Promise<boolean> {
    const staged: ActiveBrowserEntry[] = []
    const fibers: Fiber[] = []
    this.staging.set(generation, fibers)
    try {
      const manifest = validateManifest(await this.ctx.consoleClient.getEntryManifest(signal))
      if (!this.current(generation)) return false
      if (this.isStale(manifest)) throw new BrowserEntryLoaderError('ENTRY_MANIFEST_STALE', 'frontend Entry manifest is older than the current authority')
      this.acceptAuthority({ ...manifest, entries: [...manifest.entries, ...manifest.unavailable] }, false)
      if (manifest.unavailable.length) {
        throw new BrowserEntryLoaderError('ENTRY_SOURCE_UNAVAILABLE', `frontend Entry sources are unavailable: ${manifest.unavailable.map(entry => entry.id).join(', ')}`)
      }
      const next = new Map<string, ActiveBrowserEntry>()
      for (const entry of [...manifest.entries].sort((left, right) => left.id.localeCompare(right.id))) {
        const url = resolveEntryUrl(entry, this.ctx.consoleClient.baseUrl)
        const previous = this.active.get(entry.id)
        if (previous && previous.epoch === manifest.epoch && previous.definition.incarnation === entry.incarnation && previous.url === url) {
          next.set(entry.id, previous)
          continue
        }
        const module = readModule(await this.moduleImporter(url), entry)
        if (!this.current(generation)) return false
        const stage = new FrontendExtensionStage()
        const localeStage = this.localeService()?.createStage()
        const context = this.ctx.extend({
          baseUrl: url,
          webuiExtensions: stage as unknown as BrowserExtensionRegistry,
          ...(localeStage ? { i18n: localeStage as unknown as I18nService } : {}),
        })
        const fiber = context.plugin(module.default)
        fibers.push(fiber)
        await fiber
        if (!this.current(generation)) return false
        const loaded: ActiveBrowserEntry = { epoch: manifest.epoch, definition: entry, url, fiber, stage, ...(localeStage ? { localeStage } : {}) }
        staged.push(loaded)
        next.set(entry.id, loaded)
      }
      if (!this.current(generation)) return false
      const previous = this.active
      const changed = staged.length > 0 || this.committedRevision === undefined
      if (changed) this.publish(next, manifest.revision)
      this.active = next
      this.committedRevision = manifest.revision
      this.state = { status: 'READY', ...this.snapshotState() }
      fibers.length = 0
      await this.disposeFibers([...previous.values()].filter(entry => next.get(entry.definition.id) !== entry).map(entry => entry.fiber))
      return changed
    } catch (error) {
      if (!this.current(generation)) return false
      return this.fail(error)
    } finally {
      this.staging.delete(generation)
      await this.disposeFibers(fibers)
    }
  }

  private isStale(notice: ConsoleEntryInvalidation): boolean {
    return this.retiredEpochs.has(notice.epoch)
      || Boolean(this.authority?.epoch === notice.epoch && notice.revision < this.authority.revision)
  }

  private acceptAuthority(notice: ConsoleEntryInvalidation, invalidate = true): boolean {
    if (this.isStale(notice)) return false
    const newer = this.authority?.epoch !== notice.epoch || this.authority.revision < notice.revision
    if (!newer) return false
    if (this.authority && this.authority.epoch !== notice.epoch) this.retiredEpochs.add(this.authority.epoch)
    this.authority = notice
    if (invalidate) {
      this.invalidatePending()
    }
    const allowed = new Map(notice.entries.map(entry => [entry.id, entry.incarnation]))
    const revoked = [...this.active.values()].filter(entry => entry.epoch !== notice.epoch || allowed.get(entry.definition.id) !== entry.definition.incarnation)
    if (revoked.length) {
      const next = new Map(this.active)
      for (const entry of revoked) next.delete(entry.definition.id)
      // Revocation commits independently of loading replacements. A missing slot makes
      // surviving contributions invisible; it must never keep its revoked owner alive.
      this.publish(next, notice.revision, true)
      this.active = next
      this.committedRevision = notice.revision
      this.state = { status: 'LOADING', ...this.snapshotState() }
      void this.disposeFibers(revoked.map(entry => entry.fiber))
    }
    return true
  }

  private publish(entries: Map<string, ActiveBrowserEntry>, revision: number, allowMissingSlots = false): void {
    const stage = FrontendExtensionStage.combine([...entries.values()].map(entry => entry.stage))
    const i18n = this.localeService()
    const nextRevision = Math.max(this.snapshotRevision + 1, revision)
    i18n?.validateSnapshot(nextRevision)
    this.ctx.webuiExtensions.activateSnapshot(nextRevision, stage, () => {
      i18n?.activateSnapshots(nextRevision, [...entries.values()].flatMap(entry => entry.localeStage ? [entry.localeStage] : []))
    }, allowMissingSlots)
    this.snapshotRevision = nextRevision
  }

  private invalidatePending(): void {
    this.generation++
    this.fetchController?.abort()
    for (const fibers of this.staging.values()) void this.disposeFibers(fibers)
  }

  private snapshotState(): Pick<BrowserEntryLoaderState, 'revision' | 'entries'> {
    return { ...(this.committedRevision === undefined ? {} : { revision: this.committedRevision }), entries: [...this.active.keys()].sort() }
  }
  private fail(error: unknown): false {
    const failure = asLoaderError(error)
    this.state = { status: 'ERROR', ...this.snapshotState(), error: { code: failure.code, message: failure.message } }
    if (this.committedRevision === undefined) throw failure
    return false
  }
  private localeService(): I18nService | undefined { return this.ctx.get('i18n') as I18nService | undefined }
  private async disposeFibers(fibers: Fiber[]): Promise<void> { await Promise.allSettled([...fibers].reverse().map(fiber => fiber.dispose())) }
}
export default BrowserEntryLoader
