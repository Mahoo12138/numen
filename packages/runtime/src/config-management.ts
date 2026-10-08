import { redactText } from '@numenjs/logging'
import { Service, type Context, type Fiber, resolveConfig } from 'cordis'
import type { Entry, EntryOptions } from '@cordisjs/plugin-loader'
import {
  commitManagedConfig, flattenRuntimeEntries, HostConfigError, inspectHostConfigSchema, mutateManagedConfig, readManagedConfig, sensitiveConfigKey,
  type HostConfigService, type HostConfigSnapshot, type HostConfigPreview, type HostConfigMutationResult,
  type HostConfigMutationRequest, type HostConfigOperation, type HostPluginState, type ManagedConfigDocument, type RuntimeEntry,
  type HostRegistrationRef, type HostRegistrationDiagnosis,
} from '@numenjs/config'
import { owningEntry, RegistrationOwnership } from './registration-ownership.js'

export function toCordisEntry(entry: RuntimeEntry): EntryOptions {
  return { id: entry.id, name: entry.name, config: entry.children ? entry.children.map(toCordisEntry) : entry.config, disabled: entry.disabled, ...(entry.children ? { group: true } : {}) }
}

declare module 'cordis' {
  interface Context { hostConfig: HostConfigService }
  interface Events { 'numen/host-config-change'(): void }
}

interface HostConfigurationOptions {
  filename: string
  builtins: ReadonlySet<string>
  safeMode: boolean
  fingerprint: string
  onSaved?(document: ManagedConfigDocument): void
}

const stateNames: HostPluginState[] = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']
// Schema-wide classification happens once through inspectHostConfigSchema.
// Never revisit the live Schema while copying values into transport data.
function safeConfig(value: unknown): { value: unknown; sensitive: boolean; unsafe: boolean } {
  type Container = Record<string, unknown> | unknown[]
  type Frame = { kind: 'value'; source: unknown; target: Container; key: string } | { kind: 'leave'; source: object }
  const holder: Record<string, unknown> = {}
  const frames: Frame[] = [{ kind: 'value', source: value, target: holder, key: 'value' }]
  const active = new Set<object>()
  let sensitive = false
  let unsafe = false
  while (frames.length) {
    const frame = frames.pop()!
    if (frame.kind === 'leave') { active.delete(frame.source); continue }
    const { source, target, key } = frame
    let copy = source
    if (typeof source === 'string') {
      copy = redactText(source)
      sensitive ||= copy !== source
    } else if (source !== null && typeof source === 'object') {
      const array = Array.isArray(source)
      const prototype = Object.getPrototypeOf(source)
      if ((!array && prototype !== Object.prototype && prototype !== null) || active.has(source) || Object.getOwnPropertySymbols(source).length) { unsafe = true; continue }
      active.add(source)
      frames.push({ kind: 'leave', source })
      copy = array ? [] : {}
      const names = Object.getOwnPropertyNames(source)
      const keys = array ? names.filter(name => name !== 'length') : names
      if (array && (keys.length !== source.length || keys.some((name, index) => name !== String(index)))) { unsafe = true; continue }
      for (let index = keys.length - 1; index >= 0; index--) {
        const childKey = keys[index]!, descriptor = Object.getOwnPropertyDescriptor(source, childKey)!
        // JSON ignores non-enumerable values and invokes enumerable getters.
        // Either behavior loses the original configuration's representation.
        if (!('value' in descriptor) || !descriptor.enumerable) { unsafe = true; continue }
        if (sensitiveConfigKey.test(childKey)) {
          sensitive = true
          Object.defineProperty(copy, childKey, { value: '[redacted]', enumerable: true, configurable: true, writable: true })
        } else frames.push({ kind: 'value', source: descriptor.value, target: copy as Container, key: childKey })
      }
    } else if (!(source === null || typeof source === 'boolean' || typeof source === 'number' && Number.isFinite(source))) { unsafe = true; continue }
    Object.defineProperty(target, key, { value: copy, enumerable: true, configurable: true, writable: true })
  }
  return { value: unsafe ? {} : holder.value, sensitive, unsafe }
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
  private readonly ownership = new RegistrationOwnership()

  constructor(ctx: Context, private readonly options: HostConfigurationOptions) {
    super(ctx, 'hostConfig')
    this.attemptedFingerprint = options.fingerprint
    ctx.on('numen/registration-change', (registration, active) => {
      this.ownership.observe(registration, active, id => this.ctx.loader.store[id]?.options.name)
    })
    ctx.on('internal/status', () => ctx.emit('numen/host-config-change'))
  }

  async diagnose(refs: HostRegistrationRef[]): Promise<HostRegistrationDiagnosis[]> {
    if (refs.length > 64) throw new HostConfigError('DIAGNOSTIC_LIMIT', 'At most 64 registrations can be inspected at once.')
    return this.ownership.diagnose(refs, await this.read())
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
        const schema = this.schema(entry)
        const inspection = inspectHostConfigSchema(schema)
        const safe = safeConfig(entry.config)
        const protectedEntry = protectedIds.has(entry.id)
        const configEditable = !entry.children && !safe.sensitive && !safe.unsafe && !inspection.sensitive && !protectedEntry && !!runtime?.fiber?.runtime && !!inspection.schema
        return {
          id: entry.id, key: entry.key, name: entry.name,
          packageName: entry.name === 'cordis:console' ? '@numenjs/console' : entry.name === 'cordis:workbench' ? '@numenjs/workbench' : entry.name,
          packageVersion: null, installed: entry.builtin ? true : runtime?.fiber?.runtime ? true : null,
          ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }), group: !!entry.children,
          ...(entry.label === undefined ? {} : { label: entry.label }), ...(entry.collapsed === undefined ? {} : { collapsed: entry.collapsed }),
          selfEnabled: entry.selfEnabled ?? !entry.disabled, effectiveEnabled: entry.effectiveEnabled ?? !entry.disabled,
          actualState: actualState(runtime), ...(entry.children ? { children: entry.children.map(child => child.id) } : {}),
          config: configEditable ? safe.value as Record<string, unknown> : {}, configEditable,
          ...(configEditable ? { configSchema: inspection.schema } : {}),
          ...(!configEditable ? { configReadOnlyReason: entry.children ? 'Use group operations.' : safe.sensitive || inspection.sensitive ? 'Secret-bearing configuration must be edited locally.' : protectedEntry ? 'This entry is required by the current management channel. Edit it locally.' : !runtime?.fiber?.runtime ? 'Load the plugin before editing its configuration.' : safe.unsafe ? 'Configuration contains values that cannot be represented losslessly as JSON. Edit it locally.' : 'The plugin does not expose an inspectable configuration schema. Edit it locally.' } : {}),
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
      const schema = this.schema(selected)
      const inspection = inspectHostConfigSchema(schema)
      const currentConfig = safeConfig(selected?.config)
      const requestedConfig = safeConfig(operation.config)
      if (inspection.sensitive || currentConfig.sensitive || requestedConfig.sensitive) throw new HostConfigError('SECRET_CONFIG_READ_ONLY', 'Secret-bearing configuration must be edited locally.')
      const runtime = this.ctx.loader.store[operation.id]?.fiber?.runtime
      if (!runtime) throw new HostConfigError('PLUGIN_UNAVAILABLE', 'The plugin must be loaded before its configuration can be edited.')
      if (!inspection.schema) throw new HostConfigError('PLUGIN_SCHEMA_UNAVAILABLE', 'The plugin does not expose an inspectable configuration schema. Edit it locally.')
      if (currentConfig.unsafe || requestedConfig.unsafe) throw new HostConfigError('PLUGIN_CONFIG_NOT_JSON', 'Configuration contains values that cannot be represented losslessly as JSON. Edit it locally.')
      // A validator may normalize or mutate its input. Validate a detached copy;
      // the file must retain the user's explicit values and unknown fields.
      try { resolveConfig(runtime, structuredClone(operation.config)) } catch { throw new HostConfigError('PLUGIN_CONFIG_INVALID', 'Plugin configuration does not match its schema. Values are omitted.') }
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
      operation: input.operation.kind === 'setConfig' ? { ...input.operation, config: this.snapshot(document).entries.find(entry => entry.id === target?.id)?.configEditable ? safeConfig(input.operation.config).value as Record<string, unknown> : {} } : input.operation,
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
    this.ctx.emit('numen/host-config-change')
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
