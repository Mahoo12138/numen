import { isNumenValue, isResourceRef, type NumenValue } from '@numen/core'
import '@numen/database'
import { Service, type Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import type Schema from 'schemastery'

export interface ConnectionAdapterRef {
  id: string
  version: number
}

export interface ConnectionAdapterDefinition<Config = Record<string, NumenValue>> extends ConnectionAdapterRef {
  title: string
  config: Schema<Config>
  credentialType?: string
}

export interface Connection {
  id: string
  name: string
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
}

interface ConnectionRow {
  id: string
  name: string
  adapter_id: string
  adapter_version: number
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

declare module 'cordis' {
  interface Context {
    connections: ConnectionService
  }

  interface Events {
    'numen/connection-change'(connectionId: string): void
  }
}

const adapterIdPattern = /^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/

function adapterKey(ref: ConnectionAdapterRef): string {
  return `${ref.id}@${ref.version}`
}

function assertConfig(value: unknown): asserts value is Record<string, NumenValue> {
  if (!isNumenValue(value) || !value || typeof value !== 'object' || Array.isArray(value) || isResourceRef(value)) {
    throw new TypeError('connection config must be a Numen object')
  }
}

export class ConnectionService extends Service {
  static inject = ['database']

  private ready = false
  private readonly adapters = new Map<string, ConnectionAdapterDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'connections')
  }

  async *[Service.init]() {
    this.ready = true
    yield () => {
      this.ready = false
      this.adapters.clear()
    }
  }

  defineAdapter(owner: Context, definition: ConnectionAdapterDefinition): () => void {
    if (!adapterIdPattern.test(definition.id)) throw new TypeError(`invalid adapter id: ${definition.id}`)
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new TypeError(`invalid adapter version: ${definition.version}`)
    }
    const key = adapterKey(definition)
    if (this.adapters.has(key)) throw new Error(`connection adapter already defined: ${key}`)
    return owner.effect(() => {
      this.adapters.set(key, definition)
      this.emitAdapterConnections(definition)
      return () => {
        this.adapters.delete(key)
        this.emitAdapterConnections(definition)
      }
    }, `connections.defineAdapter(${JSON.stringify(key)})`)
  }

  getAdapter(ref: ConnectionAdapterRef): ConnectionAdapterDefinition | undefined {
    return this.adapters.get(adapterKey(ref))
  }

  listAdapters(): ConnectionAdapterDefinition[] {
    return [...this.adapters.values()].sort((a, b) => adapterKey(a).localeCompare(adapterKey(b)))
  }

  create(input: CreateConnectionInput): Connection {
    const name = input.name.trim()
    if (!name) throw new TypeError('connection name is required')
    const definition = this.requireAdapter(input.adapter)
    const config = this.validateConfig(definition, input.config)
    const connectionId = `conn_${randomUUID().replaceAll('-', '')}`
    const now = new Date().toISOString()
    this.ctx.database.db.prepare(`
      INSERT INTO connections (
        id, name, adapter_id, adapter_version, config_json, credential_id,
        enabled, generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      connectionId,
      name,
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
    return {
      ready: this.ready,
      total: connections.length,
      enabled: connections.filter(connection => connection.enabled).length,
      unavailable: connections.filter(connection => connection.enabled && !connection.adapterAvailable).length,
    }
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
    return {
      id: row.id,
      name: row.name,
      adapter,
      config: JSON.parse(row.config_json) as Record<string, NumenValue>,
      ...(row.credential_id ? { credentialId: row.credential_id } : {}),
      enabled: !!row.enabled,
      generation: row.generation,
      adapterAvailable: this.adapters.has(adapterKey(adapter)),
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
}

export default ConnectionService
