import { redactText } from '@numenjs/logging'
import { Service, type Context, type Fiber, resolveConfig } from 'cordis'
import type { Entry, EntryOptions } from '@cordisjs/plugin-loader'
import {
  commitManagedConfig, flattenRuntimeEntries, HostConfigError, mutateManagedConfig, readManagedConfig,
  type HostConfigService, type HostConfigSnapshot, type HostConfigPreview, type HostConfigMutationResult,
  type HostConfigMutationRequest, type HostConfigOperation, type HostPluginState, type ManagedConfigDocument, type RuntimeEntry,
} from '@numenjs/config'

export function toCordisEntry(entry: RuntimeEntry): EntryOptions {
  return { id: entry.id, name: entry.name, config: entry.children ? entry.children.map(toCordisEntry) : entry.config, disabled: entry.disabled, ...(entry.children ? { group: true } : {}) }
}

declare module 'cordis' { interface Context { hostConfig: HostConfigService } }

interface HostConfigurationOptions {
  filename: string
  builtins: ReadonlySet<string>
  safeMode: boolean
  fingerprint: string
  onSaved?(document: ManagedConfigDocument): void
}

const stateNames: HostPluginState[] = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']
const sensitiveKey = /secret|token|password|credential|authorization|cookie|private.?key|api.?key|^auth$|^key$/i
interface ConfigSchemaShape {
  type?: string
  meta?: { role?: string }
  dict?: Record<string, unknown>
  inner?: unknown
  list?: unknown[]
}
function schemaAlternatives(schemas: unknown[], seen = new Set<unknown>()): ConfigSchemaShape[] {
  return schemas.flatMap(schema => {
    if (!schema || (typeof schema !== 'object' && typeof schema !== 'function') || seen.has(schema)) return []
    seen.add(schema)
    const shape = schema as ConfigSchemaShape
    return shape.type === 'union' || shape.type === 'intersect'
      ? schemaAlternatives(shape.list ?? [], seen) : [shape]
  })
}
function safeConfig(value: unknown, schemas: unknown[] = []): { value: unknown; sensitive: boolean } {
  const alternatives = schemaAlternatives(schemas)
  if (alternatives.some(schema => schema.meta?.role === 'secret')) return { value: '[redacted]', sensitive: true }
  if (typeof value === 'string') {
    const redacted = redactText(value)
    return { value: redacted, sensitive: redacted !== value }
  }
  if (Array.isArray(value)) {
    const children = value.map(child => safeConfig(child, alternatives.map(schema => schema.inner)))
    return { value: children.map(child => child.value), sensitive: children.some(child => child.sensitive) }
  }
  if (!value || typeof value !== 'object') return { value, sensitive: false }
  let sensitive = false
  const entries = Object.entries(value).map(([key, child]) => {
    if (sensitiveKey.test(key)) { sensitive = true; return [key, '[redacted]'] }
    const childSchemas = alternatives.map(schema => schema.type === 'dict' ? schema.inner : schema.dict?.[key])
    const result = safeConfig(child, childSchemas); sensitive ||= result.sensitive
    return [key, result.value]
  })
  return { value: Object.fromEntries(entries), sensitive }
}

function owningEntry(fiber: Fiber): string | undefined {
  let current: Fiber | undefined = fiber
  while (current?.runtime) {
    if (current.entry) return current.entry.id
    current = current.parent.fiber
  }
  return undefined
}

function actualState(entry: Entry | undefined): HostPluginState {
  if (!entry) return 'UNLOADED'
  let ancestor: Entry | undefined = entry
  while (ancestor) {
    if (ancestor.options.disabled) return 'DISABLED'
    ancestor = ancestor.parent.ctx.fiber.entry
  }
  return entry.fiber ? stateNames[entry.fiber.state] ?? 'UNLOADED' : 'UNLOADED'
}

/** The host owns desired state and disk writes; Console/Workbench consume only this service. */
export class HostConfigurationService extends Service implements HostConfigService {
  static inject = ['loader']
  private queue: Promise<unknown> = Promise.resolve()
  private attemptedFingerprint: string

  constructor(ctx: Context, private readonly options: HostConfigurationOptions) {
    super(ctx, 'hostConfig')
    this.attemptedFingerprint = options.fingerprint
  }

  private document(): Promise<ManagedConfigDocument> { return readManagedConfig(this.options.filename, this.options.builtins, this.options.safeMode) }
  private allFibers(): Fiber[] { return [...this.ctx.registry.values()].flatMap(runtime => [...runtime.fibers]) }
  private protectedIds(entries: RuntimeEntry[]): Set<string> {
    const all = flattenRuntimeEntries(entries)
    const result = new Set(all.filter(entry => ['cordis:console', 'cordis:workbench', 'cordis:server'].includes(entry.name)).map(entry => entry.id))
    // Protect real alternative providers of the current management channel as well.
    for (const name of ['console', 'consoleAuth', 'consoleSession', 'consoleEntries', 'server', 'workbench']) {
      const provider = this.ctx.get(name) as { ctx?: Context } | undefined
      const owner = provider?.ctx && owningEntry(provider.ctx.fiber)
      if (owner) result.add(owner)
    }
    for (const id of [...result]) {
      let entry = all.find(entry => entry.id === id)
      while (entry?.parentId) { result.add(entry.parentId); entry = all.find(parent => parent.id === entry!.parentId) }
    }
    return result
  }

  private schema(entry: RuntimeEntry | undefined): unknown {
    if (!entry) return undefined
    return this.ctx.loader.store[entry.id]?.fiber?.runtime?.Config
      ?? (entry.builtin ? this.ctx.loader.builtins[entry.name.slice(7)]?.Config : undefined)
  }

  private snapshot(document: ManagedConfigDocument): HostConfigSnapshot {
    const all = flattenRuntimeEntries(document.entries)
    const protectedIds = this.protectedIds(document.entries)
    const fibers = this.allFibers()
    const restartRequired = document.fingerprint !== this.attemptedFingerprint
    return {
      fingerprint: document.fingerprint, version: document.config.version,
      writable: document.config.version === 2 && !restartRequired,
      ...(document.config.version !== 2 ? { readOnlyReason: 'Version 1 is read-only. Explicitly migrate the configuration first.' } : restartRequired ? { readOnlyReason: 'Configuration changed outside this host. Restart to apply and reconcile it before editing.' } : {}),
      safeMode: this.options.safeMode, restartRequired,
      entries: all.map(entry => {
        const runtime = this.ctx.loader.store[entry.id]
        const safe = safeConfig(entry.config, [this.schema(entry)])
        const protectedEntry = protectedIds.has(entry.id)
        const configEditable = !entry.children && !safe.sensitive && !protectedEntry && !!runtime?.fiber?.runtime
        return {
          id: entry.id, key: entry.key, name: entry.name,
          packageName: entry.name === 'cordis:console' ? '@numenjs/console' : entry.name === 'cordis:workbench' ? '@numenjs/workbench' : entry.name,
          packageVersion: null, installed: entry.builtin ? true : runtime?.fiber?.runtime ? true : null,
          ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }), group: !!entry.children,
          ...(entry.label === undefined ? {} : { label: entry.label }), ...(entry.collapsed === undefined ? {} : { collapsed: entry.collapsed }),
          selfEnabled: entry.selfEnabled ?? !entry.disabled, effectiveEnabled: entry.effectiveEnabled ?? !entry.disabled,
          actualState: actualState(runtime), ...(entry.children ? { children: entry.children.map(child => child.id) } : {}),
          config: configEditable ? safe.value as Record<string, unknown> : {}, configEditable,
          ...(!configEditable ? { configReadOnlyReason: entry.children ? 'Use group operations.' : safe.sensitive ? 'Secret-bearing configuration must be edited locally.' : protectedEntry ? 'This entry is required by the current management channel. Edit it locally.' : 'Load the plugin before editing its configuration.' } : {}),
          protected: protectedEntry,
          internal: fibers.filter(fiber => fiber.uid !== runtime?.fiber?.uid && owningEntry(fiber) === entry.id).map(fiber => ({
            diagnosticId: `fiber:${fiber.uid ?? 'pending'}`, name: fiber.name, state: stateNames[fiber.state] ?? 'UNLOADED', dependencies: Object.keys(fiber.inject), ownerEntryId: entry.id,
          })),
        }
      }),
    }
  }

  async read(): Promise<HostConfigSnapshot> { return this.snapshot(await this.document()) }

  private async prepare(document: ManagedConfigDocument, input: HostConfigMutationRequest): Promise<ManagedConfigDocument> {
    if (document.fingerprint !== input.fingerprint) throw new HostConfigError('CONFIG_CONFLICT', 'Configuration changed. Refresh the state and keep your local edits for review.')
    if (document.fingerprint !== this.attemptedFingerprint) throw new HostConfigError('RESTART_REQUIRED', 'Configuration was edited outside this host. Restart to reconcile it before editing.')
    const operation = input.operation
    const all = flattenRuntimeEntries(document.entries)
    const selected = all.find(entry => entry.id === operation.id)
    const protectedIds = this.protectedIds(document.entries)
    if (protectedIds.has(operation.id) && ((operation.kind === 'setEnabled' && !operation.enabled) || ['move', 'removeGroup', 'setConfig'].includes(operation.kind))) throw new HostConfigError('MANAGEMENT_CHANNEL_PROTECTED', 'This change would interrupt the current management channel. Edit the host configuration locally and restart instead.')
    if (operation.kind === 'setConfig') {
      if (safeConfig(selected?.config, [this.schema(selected)]).sensitive || safeConfig(operation.config, [this.schema(selected)]).sensitive) throw new HostConfigError('SECRET_CONFIG_READ_ONLY', 'Secret-bearing configuration must be edited locally.')
      const runtime = this.ctx.loader.store[operation.id]?.fiber?.runtime
      if (!runtime) throw new HostConfigError('PLUGIN_UNAVAILABLE', 'The plugin must be loaded before its configuration can be edited.')
      try { resolveConfig(runtime, operation.config) } catch { throw new HostConfigError('PLUGIN_CONFIG_INVALID', 'Plugin configuration does not match its schema. Values are omitted.') }
    }
    const next = mutateManagedConfig(document, operation, this.options.builtins, this.options.safeMode)
    // Guard indirect changes, including moves beneath a disabled group.
    for (const entry of flattenRuntimeEntries(next.entries)) {
      if (protectedIds.has(entry.id) && all.find(old => old.id === entry.id)?.effectiveEnabled && !entry.effectiveEnabled) throw new HostConfigError('MANAGEMENT_CHANNEL_PROTECTED', 'A protected management entry would become unavailable.')
    }
    return next
  }

  async preview(input: HostConfigMutationRequest): Promise<HostConfigPreview> {
    const document = await this.document()
    const all = flattenRuntimeEntries(document.entries)
    const target = all.find(entry => entry.id === input.operation.id)
    let blockedReason: string | undefined
    try { await this.prepare(document, input) } catch (error) { if (error instanceof HostConfigError) blockedReason = error.message; else throw error }
    // Cordis get() is the supported dynamic optional lookup. Do not use
    // injected property getters on the always-available host service.
    const capabilities = this.ctx.get('capabilities') as Context['capabilities'] | undefined
    const connections = this.ctx.get('connections') as Context['connections'] | undefined
    const automations = this.ctx.get('automations') as Context['automations'] | undefined
    const statuses = capabilities?.list() ?? []
    return {
      fingerprint: document.fingerprint,
      operation: input.operation.kind === 'setConfig' ? { ...input.operation, config: safeConfig(input.operation.config, [this.schema(target)]).value as Record<string, unknown> } : input.operation,
      affectedEntryIds: target ? flattenRuntimeEntries([target]).map(entry => entry.id) : [],
      impact: {
        status: 'unknown', message: 'Dependency impact cannot be proven complete. Listed objects are potentially related; running external effects cannot be undone by this change.',
        connections: connections?.list().slice(0, 100).map(connection => connection.id) ?? [],
        capabilities: statuses.filter(item => item.definition.kind !== 'trigger').slice(0, 100).map(item => `${item.definition.id}@${item.definition.version}`),
        triggers: statuses.filter(item => item.definition.kind === 'trigger').slice(0, 100).map(item => `${item.definition.id}@${item.definition.version}`),
        automations: automations?.list().slice(0, 100).map(automation => automation.id) ?? [],
      }, ...(blockedReason ? { blockedReason } : {}),
    }
  }

  apply(input: HostConfigMutationRequest): Promise<HostConfigMutationResult> {
    const task = this.queue.then(() => this.applySerialized(input))
    this.queue = task.catch(() => undefined)
    return task
  }

  private async applySerialized(input: HostConfigMutationRequest): Promise<HostConfigMutationResult> {
    const next = await commitManagedConfig(this.options.filename, input.fingerprint, current => this.prepare(current, input), this.options.builtins, this.options.safeMode)
    this.attemptedFingerprint = next.fingerprint
    this.options.onSaved?.(next)
    let runtimeApplied = true
    try {
      await this.applyRuntime(input.operation, next.entries)
      const rows = this.snapshot(next).entries
      const target = rows.find(entry => entry.id === input.operation.id)
      const affected = target ? new Set(flattenRuntimeEntries(flattenRuntimeEntries(next.entries).filter(entry => entry.id === target.id)).map(entry => entry.id)) : new Set<string>()
      runtimeApplied = !rows.some(entry => affected.has(entry.id) && (entry.actualState === 'FAILED' || entry.actualState === 'UNLOADED' || entry.internal.some(child => child.state === 'FAILED')))
    } catch { runtimeApplied = false }
    const snapshot = this.snapshot(next)
    return { saved: true, runtimeApplied, fingerprint: next.fingerprint, restartRequired: false, snapshot,
      ...(!runtimeApplied ? { error: { code: 'RUNTIME_APPLY_FAILED', message: 'Configuration was saved, but the runtime did not apply it successfully. Inspect plugin status and correct its configuration; the host will not retry automatically.' } } : {}),
    }
  }

  private async applyRuntime(operation: HostConfigOperation, entries: RuntimeEntry[]): Promise<void> {
    const all = flattenRuntimeEntries(entries)
    const entry = all.find(entry => entry.id === operation.id)
    if (operation.kind === 'createGroup') {
      const created = all.find(entry => entry.key === `group:${operation.id}` && entry.parentId === operation.parentId)!
      await this.ctx.loader.create(toCordisEntry(created), operation.parentId ?? null)
    } else if (operation.kind === 'removeGroup') this.ctx.loader.remove(operation.id)
    else if (operation.kind === 'move') await this.ctx.loader.update(operation.id, {}, operation.parentId ?? null)
    else if (operation.kind === 'setEnabled') await this.ctx.loader.update(operation.id, { disabled: entry!.disabled })
    else if (operation.kind === 'setConfig') await this.ctx.loader.update(operation.id, { config: entry!.config })
    await this.ctx.loader.await()
  }
}
