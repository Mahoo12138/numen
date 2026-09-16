import { isNumenValue, isResourceRef, type NumenValue } from '@numen/core'
import '@numen/credentials'
import type { CredentialSecretSnapshot } from '@numen/credentials'
import '@numen/database'
import { Service, type Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import type Schema from 'schemastery'

export interface ConnectionAdapterRef {
  id: string
  version: number
}

export interface ConnectionTypeRef {
  id: string
  version: number
}

/** Stable protocol implemented by one or more Connection Adapters. */
export interface ConnectionTypeDefinition<Runtime = unknown> extends ConnectionTypeRef {
  title: string
  /** Compile-time marker only; Runtime values never enter durable state. */
  readonly runtime?: Runtime
}

export interface ConnectionAdapterDefinition<Config = Record<string, NumenValue>, Runtime = unknown> extends ConnectionAdapterRef {
  title: string
  type: ConnectionTypeRef
  config: Schema<Config>
  credentialType?: string
  /** Compile-time marker tying Provider output to the implemented Connection Type. */
  readonly runtime?: Runtime
}

/** Lifecycle wrapper owned exclusively by ConnectionService. */
export interface ConnectionRuntime<Runtime = unknown> {
  value: Runtime
  close?(): void | Promise<void>
}

export interface ConnectionAdapterOpenContext {
  connection: Connection
  signal: AbortSignal
  credential?: CredentialSecretSnapshot
}

export interface ConnectionAdapterProvider<Runtime = unknown> {
  open(context: ConnectionAdapterOpenContext): Promise<ConnectionRuntime<Runtime>>
}

export type ConnectionRuntimeStatus = 'STOPPED' | 'STARTING' | 'READY' | 'ERROR' | 'STOPPING'

export interface ConnectionRuntimeState {
  connectionId: string
  status: ConnectionRuntimeStatus
  generation?: number
  error?: string
}

export interface Connection {
  id: string
  name: string
  type: ConnectionTypeRef
  adapter: ConnectionAdapterRef
  config: Record<string, NumenValue>
  credentialId?: string
  enabled: boolean
  generation: number
  adapterAvailable: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateConnectionInput {
  name: string
  adapter: ConnectionAdapterRef
  config: Record<string, NumenValue>
  credentialId?: string
  enabled?: boolean
}

export interface UpdateConnectionInput {
  id: string
  expectedGeneration: number
  name?: string
  config?: Record<string, NumenValue>
  credentialId?: string | null
}

export interface ConnectionHealth {
  ready: boolean
  total: number
  enabled: number
  unavailable: number
  starting: number
  runtimeReady: number
  errors: number
}

interface AdapterEntry {
  definition: ConnectionAdapterDefinition
  provider?: ConnectionAdapterProvider
}

interface ActiveRuntime {
  connectionId: string
  generation: number
  provider: ConnectionAdapterProvider
  controller: AbortController
  status: Exclude<ConnectionRuntimeStatus, 'STOPPED'>
  runtime?: ConnectionRuntime
  error?: string
  stopTask?: Promise<void>
}

interface ConnectionRow {
  id: string
  name: string
  adapter_id: string
  adapter_version: number
  type_id: string
  type_version: number
  config_json: string
  credential_id: string | null
  enabled: number
  generation: number
  created_at: string
  updated_at: string
}

export class ConnectionNotFoundError extends Error {
  override name = 'ConnectionNotFoundError'
}

export class ConnectionConflictError extends Error {
  override name = 'ConnectionConflictError'

  constructor(public readonly expectedGeneration: number, public readonly actualGeneration: number) {
    super(`connection generation conflict: expected ${expectedGeneration}, actual ${actualGeneration}`)
  }
}

export class ConnectionBindingError extends Error {
  override name = 'ConnectionBindingError'
}

export class ConnectionRuntimeUnavailableError extends Error {
  override name = 'ConnectionRuntimeUnavailableError'

  constructor(
    public readonly connectionId: string,
    public readonly status: ConnectionRuntimeStatus,
  ) {
    super(`connection runtime is not ready: ${connectionId} (${status})`)
  }
}

declare module 'cordis' {
  interface Context {
    connections: ConnectionService
  }

  interface Events {
    'numen/connection-change'(connectionId: string): void
    'numen/connection-runtime-change'(connectionId: string): void
    'numen/connection-type-change'(ref: ConnectionTypeRef): void
  }
}

const adapterIdPattern = /^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/

function adapterKey(ref: ConnectionAdapterRef): string {
  return `${ref.id}@${ref.version}`
}

export function connectionTypeKey(ref: ConnectionTypeRef): string {
  return `${ref.id}@${ref.version}`
}

function acceptsConnectionType(accepts: string[], ref: ConnectionTypeRef): boolean {
  return !accepts.length || accepts.includes(ref.id) || accepts.includes(connectionTypeKey(ref))
}

function assertConfig(value: unknown): asserts value is Record<string, NumenValue> {
  if (!isNumenValue(value) || !value || typeof value !== 'object' || Array.isArray(value) || isResourceRef(value)) {
    throw new TypeError('connection config must be a Numen object')
  }
}

export class ConnectionService extends Service {
  static inject = ['database', 'credentials']

  private ready = false
  private readonly types = new Map<string, ConnectionTypeDefinition>()
  private readonly adapters = new Map<string, AdapterEntry>()
  private readonly runtimes = new Map<string, ActiveRuntime>()

  constructor(ctx: Context) {
    super(ctx, 'connections')
  }

  async *[Service.init]() {
    this.ctx.on('numen/connection-change', () => this.queueReconcile())
    this.ctx.on('numen/credential-change', credentialId => this.handleCredentialChange(credentialId))
    this.ready = true
    this.queueReconcile()
    yield async () => {
      this.ready = false
      await Promise.all([...this.runtimes.values()].map(runtime => this.stopRuntime(runtime)))
      this.adapters.clear()
      this.types.clear()
    }
  }

  defineType<Runtime>(owner: Context, definition: ConnectionTypeDefinition<Runtime>): () => void {
    if (!adapterIdPattern.test(definition.id)) throw new TypeError(`invalid connection type id: ${definition.id}`)
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new TypeError(`invalid connection type version: ${definition.version}`)
    }
    const key = connectionTypeKey(definition)
    if (this.types.has(key)) throw new Error(`connection type already defined: ${key}`)
    return owner.effect(() => {
      this.types.set(key, definition)
      this.ctx.emit('numen/connection-type-change', definition)
      this.emitTypeConnections(definition)
      return () => {
        this.types.delete(key)
        this.ctx.emit('numen/connection-type-change', definition)
        this.emitTypeConnections(definition)
      }
    }, `connections.defineType(${JSON.stringify(key)})`)
  }

  getType(ref: ConnectionTypeRef): ConnectionTypeDefinition | undefined {
    return this.types.get(connectionTypeKey(ref))
  }

  listTypes(): ConnectionTypeDefinition[] {
    return [...this.types.values()].sort((a, b) => connectionTypeKey(a).localeCompare(connectionTypeKey(b)))
  }

  defineAdapter<Config, Runtime>(owner: Context, definition: ConnectionAdapterDefinition<Config, Runtime>): () => void {
    if (!adapterIdPattern.test(definition.id)) throw new TypeError(`invalid adapter id: ${definition.id}`)
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new TypeError(`invalid adapter version: ${definition.version}`)
    }
    if (!this.getType(definition.type)) throw new Error(`connection type not found: ${connectionTypeKey(definition.type)}`)
    const key = adapterKey(definition)
    if (this.adapters.has(key)) throw new Error(`connection adapter already defined: ${key}`)
    return owner.effect(() => {
      // v12 Connections acquire their explicit Type the first time their Adapter is loaded after migration.
      this.ctx.database.db.prepare(`
        UPDATE connections SET type_id = ?, type_version = ?
        WHERE adapter_id = ? AND adapter_version = ? AND type_id = ''
      `).run(definition.type.id, definition.type.version, definition.id, definition.version)
      this.adapters.set(key, { definition: definition as ConnectionAdapterDefinition })
      this.emitAdapterConnections(definition)
      return () => {
        this.adapters.delete(key)
        this.emitAdapterConnections(definition)
      }
    }, `connections.defineAdapter(${JSON.stringify(key)})`)
  }

  provideAdapter(
    owner: Context,
    ref: ConnectionAdapterRef,
    provider: ConnectionAdapterProvider,
  ): () => void {
    const key = adapterKey(ref)
    const entry = this.adapters.get(key)
    if (!entry) throw new Error(`connection adapter not found: ${key}`)
    if (!this.getType(entry.definition.type)) throw new Error(`connection type not found: ${connectionTypeKey(entry.definition.type)}`)
    if (entry.provider) throw new Error(`connection adapter provider already registered: ${key}`)
    return owner.effect(() => {
      entry.provider = provider
      this.emitAdapterConnections(ref)
      return () => {
        delete entry.provider
        this.emitAdapterConnections(ref)
      }
    }, `connections.provideAdapter(${JSON.stringify(key)})`)
  }

  getAdapter(ref: ConnectionAdapterRef): ConnectionAdapterDefinition | undefined {
    return this.adapters.get(adapterKey(ref))?.definition
  }

  listAdapters(): ConnectionAdapterDefinition[] {
    return [...this.adapters.values()]
      .map(entry => entry.definition)
      .sort((a, b) => adapterKey(a).localeCompare(adapterKey(b)))
  }

  resolveAdapterProvider(ref: ConnectionAdapterRef): ConnectionAdapterProvider | undefined {
    return this.adapters.get(adapterKey(ref))?.provider
  }

  create(input: CreateConnectionInput): Connection {
    const name = input.name.trim()
    if (!name) throw new TypeError('connection name is required')
    const definition = this.requireAdapter(input.adapter)
    const config = this.validateConfig(definition, input.config)
    this.validateCredential(definition, input.credentialId)
    const connectionId = `conn_${randomUUID().replaceAll('-', '')}`
    const now = new Date().toISOString()
    this.ctx.database.db.prepare(`
      INSERT INTO connections (
        id, name, type_id, type_version, adapter_id, adapter_version,
        config_json, credential_id, enabled, generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      connectionId,
      name,
      definition.type.id,
      definition.type.version,
      input.adapter.id,
      input.adapter.version,
      JSON.stringify(config),
      input.credentialId ?? null,
      input.enabled ? 1 : 0,
      now,
      now,
    )
    this.ctx.emit('numen/connection-change', connectionId)
    return this.get(connectionId)!
  }

  get(connectionId: string): Connection | undefined {
    const row = this.ctx.database.db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as ConnectionRow | undefined
    return row ? this.mapConnection(row) : undefined
  }

  list(): Connection[] {
    return (this.ctx.database.db.prepare('SELECT * FROM connections ORDER BY created_at DESC, id').all() as ConnectionRow[])
      .map(row => this.mapConnection(row))
  }

  update(input: UpdateConnectionInput): Connection {
    const current = this.requireConnection(input.id)
    if (current.generation !== input.expectedGeneration) {
      throw new ConnectionConflictError(input.expectedGeneration, current.generation)
    }
    const definition = this.requireAdapter(current.adapter)
    const name = input.name === undefined ? current.name : input.name.trim()
    if (!name) throw new TypeError('connection name is required')
    const config = input.config === undefined ? current.config : this.validateConfig(definition, input.config)
    const credentialId = input.credentialId === undefined ? current.credentialId : (input.credentialId ?? undefined)
    this.validateCredential(definition, credentialId)
    const now = new Date().toISOString()
    const result = this.ctx.database.db.prepare(`
      UPDATE connections
      SET name = ?, config_json = ?, credential_id = ?, generation = generation + 1, updated_at = ?
      WHERE id = ? AND generation = ?
    `).run(name, JSON.stringify(config), credentialId ?? null, now, input.id, input.expectedGeneration)
    if (!result.changes) this.throwConflictOrMissing(input.id, input.expectedGeneration)
    this.ctx.emit('numen/connection-change', input.id)
    return this.get(input.id)!
  }

  remove(connectionId: string, expectedGeneration: number): void {
    const result = this.ctx.database.db.prepare(`
      DELETE FROM connections WHERE id = ? AND generation = ?
    `).run(connectionId, expectedGeneration)
    if (!result.changes) this.throwConflictOrMissing(connectionId, expectedGeneration)
    this.ctx.emit('numen/connection-change', connectionId)
  }

  setEnabled(connectionId: string, expectedGeneration: number, enabled: boolean): Connection {
    const now = new Date().toISOString()
    const result = this.ctx.database.db.prepare(`
      UPDATE connections
      SET enabled = ?, generation = generation + 1, updated_at = ?
      WHERE id = ? AND generation = ? AND enabled != ?
    `).run(enabled ? 1 : 0, now, connectionId, expectedGeneration, enabled ? 1 : 0)
    if (!result.changes) {
      const current = this.requireConnection(connectionId)
      if (current.generation !== expectedGeneration) {
        throw new ConnectionConflictError(expectedGeneration, current.generation)
      }
      return current
    }
    this.ctx.emit('numen/connection-change', connectionId)
    return this.get(connectionId)!
  }

  health(): ConnectionHealth {
    const connections = this.list()
    const runtimes = [...this.runtimes.values()]
    return {
      ready: this.ready,
      total: connections.length,
      enabled: connections.filter(connection => connection.enabled).length,
      unavailable: connections.filter(connection => connection.enabled && !connection.adapterAvailable).length,
      starting: runtimes.filter(runtime => runtime.status === 'STARTING').length,
      runtimeReady: runtimes.filter(runtime => runtime.status === 'READY').length,
      errors: runtimes.filter(runtime => runtime.status === 'ERROR').length,
    }
  }

  getRuntimeState(connectionId: string): ConnectionRuntimeState {
    const runtime = this.runtimes.get(connectionId)
    if (!runtime) return { connectionId, status: 'STOPPED' }
    return {
      connectionId,
      status: runtime.status,
      generation: runtime.generation,
      ...(runtime.error ? { error: runtime.error } : {}),
    }
  }

  /** Resolve durable bindings to READY Runtime values without exposing lifecycle handles. */
  resolveRuntimes(
    connectionIds: Record<string, string>,
    slots?: Array<{ name: string; required: boolean; accepts: string[] }>,
  ): Record<string, unknown> {
    const declared = new Map((slots ?? []).map(slot => [slot.name, slot]))
    for (const name of Object.keys(connectionIds)) {
      if (slots && !declared.has(name)) throw new ConnectionBindingError(`unknown connection slot: ${name}`)
    }
    const resolved: Record<string, unknown> = {}
    for (const slot of slots ?? []) {
      if (slot.required && !connectionIds[slot.name]) throw new ConnectionBindingError(`required connection slot is not bound: ${slot.name}`)
    }
    for (const [name, connectionId] of Object.entries(connectionIds)) {
      const connection = this.get(connectionId)
      if (!connection) throw new ConnectionBindingError(`connection not found: ${connectionId}`)
      const slot = declared.get(name)
      if (slot && !acceptsConnectionType(slot.accepts, connection.type)) {
        throw new ConnectionBindingError(`connection ${connectionId} has incompatible type ${connectionTypeKey(connection.type)} for slot ${name}`)
      }
      const active = this.runtimes.get(connectionId)
      if (!active || active.status !== 'READY' || !active.runtime) {
        throw new ConnectionRuntimeUnavailableError(connectionId, active?.status ?? 'STOPPED')
      }
      resolved[name] = active.runtime.value
    }
    return resolved
  }

  async reconcile(): Promise<void> {
    const connections = new Map(this.list().map(connection => [connection.id, connection]))
    const stops: Promise<void>[] = []
    for (const runtime of this.runtimes.values()) {
      const connection = connections.get(runtime.connectionId)
      const provider = connection ? this.resolveAdapterProvider(connection.adapter) : undefined
      if (
        !connection?.enabled
        || !provider
        || !this.getType(connection.type)
        || provider !== runtime.provider
        || connection.generation !== runtime.generation
      ) {
        stops.push(this.stopRuntime(runtime))
      }
    }
    await Promise.all(stops)

    const starts: Promise<void>[] = []
    for (const connection of connections.values()) {
      if (!connection.enabled || this.runtimes.has(connection.id)) continue
      const provider = this.resolveAdapterProvider(connection.adapter)
      if (provider && this.getType(connection.type)) starts.push(this.openRuntime(connection, provider))
    }
    await Promise.all(starts)
  }

  private requireAdapter(ref: ConnectionAdapterRef): ConnectionAdapterDefinition {
    const definition = this.getAdapter(ref)
    if (!definition) throw new Error(`connection adapter not found: ${adapterKey(ref)}`)
    return definition
  }

  private validateConfig(
    definition: ConnectionAdapterDefinition,
    input: Record<string, NumenValue>,
  ): Record<string, NumenValue> {
    assertConfig(input)
    const config = definition.config(input)
    assertConfig(config)
    return config
  }

  private validateCredential(definition: ConnectionAdapterDefinition, credentialId?: string): void {
    if (!definition.credentialType) {
      if (credentialId) throw new TypeError(`adapter ${adapterKey(definition)} does not accept credentials`)
      return
    }
    if (!credentialId) throw new TypeError(`adapter ${adapterKey(definition)} requires a credential`)
    const credential = this.ctx.credentials.get(credentialId)
    if (!credential) throw new Error(`credential not found: ${credentialId}`)
    if (credential.type.id !== definition.credentialType) {
      throw new TypeError(`credential ${credentialId} has type ${credential.type.id}, expected ${definition.credentialType}`)
    }
  }

  private requireConnection(connectionId: string): Connection {
    const connection = this.get(connectionId)
    if (!connection) throw new ConnectionNotFoundError(`connection not found: ${connectionId}`)
    return connection
  }

  private throwConflictOrMissing(connectionId: string, expectedGeneration: number): never {
    const current = this.get(connectionId)
    if (!current) throw new ConnectionNotFoundError(`connection not found: ${connectionId}`)
    throw new ConnectionConflictError(expectedGeneration, current.generation)
  }

  private mapConnection(row: ConnectionRow): Connection {
    const adapter = { id: row.adapter_id, version: row.adapter_version }
    const type = { id: row.type_id, version: row.type_version }
    return {
      id: row.id,
      name: row.name,
      type,
      adapter,
      config: JSON.parse(row.config_json) as Record<string, NumenValue>,
      ...(row.credential_id ? { credentialId: row.credential_id } : {}),
      enabled: !!row.enabled,
      generation: row.generation,
      adapterAvailable: !!this.types.get(connectionTypeKey(type)) && !!this.adapters.get(adapterKey(adapter))?.provider,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private emitAdapterConnections(ref: ConnectionAdapterRef): void {
    const rows = this.ctx.database.db.prepare(`
      SELECT id FROM connections WHERE adapter_id = ? AND adapter_version = ?
    `).all(ref.id, ref.version) as Array<{ id: string }>
    for (const row of rows) this.ctx.emit('numen/connection-change', row.id)
  }

  private emitTypeConnections(ref: ConnectionTypeRef): void {
    const rows = this.ctx.database.db.prepare(`
      SELECT id FROM connections WHERE type_id = ? AND type_version = ?
    `).all(ref.id, ref.version) as Array<{ id: string }>
    for (const row of rows) this.ctx.emit('numen/connection-change', row.id)
    this.queueReconcile()
  }

  private queueReconcile(): void {
    if (!this.ready) return
    queueMicrotask(() => {
      this.reconcile().catch(() => undefined)
    })
  }

  private async openRuntime(connection: Connection, provider: ConnectionAdapterProvider): Promise<void> {
    const runtime: ActiveRuntime = {
      connectionId: connection.id,
      generation: connection.generation,
      provider,
      controller: new AbortController(),
      status: 'STARTING',
    }
    this.runtimes.set(connection.id, runtime)
    this.ctx.emit('numen/connection-runtime-change', connection.id)
    try {
      const credential = connection.credentialId
        ? this.ctx.credentials.readSecretSnapshot(connection.credentialId)
        : undefined
      const opened = await provider.open({
        connection,
        signal: runtime.controller.signal,
        ...(credential ? { credential } : {}),
      })
      const current = this.get(connection.id)
      if (
        runtime.controller.signal.aborted
        || this.runtimes.get(connection.id) !== runtime
        || !current?.enabled
        || !this.getType(current.type)
        || current.generation !== runtime.generation
        || this.resolveAdapterProvider(current.adapter) !== provider
      ) {
        await opened?.close?.()
        if (this.runtimes.get(connection.id) === runtime) this.runtimes.delete(connection.id)
        return
      }
      runtime.runtime = opened
      runtime.status = 'READY'
      this.ctx.emit('numen/connection-runtime-change', connection.id)
    } catch (error) {
      if (runtime.controller.signal.aborted || this.runtimes.get(connection.id) !== runtime) return
      runtime.status = 'ERROR'
      runtime.error = error instanceof Error ? error.message : String(error)
      this.ctx.emit('numen/connection-runtime-change', connection.id)
    }
  }

  private stopRuntime(runtime: ActiveRuntime): Promise<void> {
    if (runtime.stopTask) return runtime.stopTask
    const task = (async () => {
      if (this.runtimes.get(runtime.connectionId) !== runtime) return
      runtime.status = 'STOPPING'
      this.ctx.emit('numen/connection-runtime-change', runtime.connectionId)
      if (!runtime.controller.signal.aborted) runtime.controller.abort()
      try {
        await runtime.runtime?.close?.()
      } finally {
        if (this.runtimes.get(runtime.connectionId) === runtime) {
          this.runtimes.delete(runtime.connectionId)
          this.ctx.emit('numen/connection-runtime-change', runtime.connectionId)
        }
      }
    })()
    runtime.stopTask = task
    return task
  }

  private handleCredentialChange(credentialId: string): void {
    const rows = this.ctx.database.db.prepare(`
      SELECT id FROM connections WHERE credential_id = ?
    `).all(credentialId) as Array<{ id: string }>
    if (!rows.length) return
    const now = new Date().toISOString()
    this.ctx.database.db.prepare(`
      UPDATE connections SET generation = generation + 1, updated_at = ?
      WHERE credential_id = ?
    `).run(now, credentialId)
    for (const row of rows) this.ctx.emit('numen/connection-change', row.id)
  }
}

export default ConnectionService
