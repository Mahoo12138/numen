import type { ResourceRef } from '@numen/core'
import '@numen/database'
import { Service, type Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import { LocalResourceStore, type ResourceContent } from './local-store.js'

export type ResourceState = 'STAGED' | 'COMMITTED' | 'DELETING' | 'GONE'

export interface ResourceOwner {
  type: string
  id: string
}

export interface ResourceMetadata {
  id: string
  ref: ResourceRef
  name: string
  mediaType: string
  size: number
  digest: string
  storeId: string
  state: ResourceState
  stagedExpiresAt?: string
  gcAfter?: string
  createdAt: string
  updatedAt: string
  goneAt?: string
}

export interface ResourceLease {
  id: string
  resourceId: string
  holder: string
  expiresAt: string
  createdAt: string
}

export interface StageResourceInput {
  name: string
  mediaType: string
  content: ResourceContent
  stagingTtlMs?: number
}

export interface ResourceConfig {
  path: string
  stagingTtlMs?: number
  gcGraceMs?: number
  temporaryMaxAgeMs?: number
}

export interface ResourceHealth {
  ready: boolean
  staged: number
  committed: number
  deleting: number
  gone: number
  activeLeases: number
}

interface ResourceRow {
  id: string
  name: string
  media_type: string
  size: number
  digest: string
  store_id: string
  state: ResourceState
  staged_expires_at: string | null
  gc_after: string | null
  created_at: string
  updated_at: string
  gone_at: string | null
}

interface LeaseRow {
  id: string
  resource_id: string
  holder: string
  expires_at: string
  created_at: string
}

export class ResourceNotFoundError extends Error {
  override name = 'ResourceNotFoundError'
}

declare module 'cordis' {
  interface Context {
    resources: ResourceService
  }
}

const ownerPartPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/
const mediaTypePattern = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/

function resolveStorePath(ctx: Context, path: string): string {
  if (isAbsolute(path)) return path
  if (ctx.baseUrl?.startsWith('file:')) return fileURLToPath(new URL(path.replaceAll(sep, '/'), ctx.baseUrl))
  return resolve(path)
}

function mapResource(row: ResourceRow): ResourceMetadata {
  return {
    id: row.id,
    ref: { $resource: row.id },
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    digest: row.digest,
    storeId: row.store_id,
    state: row.state,
    ...(row.staged_expires_at ? { stagedExpiresAt: row.staged_expires_at } : {}),
    ...(row.gc_after ? { gcAfter: row.gc_after } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.gone_at ? { goneAt: row.gone_at } : {}),
  }
}

function mapLease(row: LeaseRow): ResourceLease {
  return {
    id: row.id,
    resourceId: row.resource_id,
    holder: row.holder,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

export class ResourceService extends Service {
  static inject = ['database']

  readonly store: LocalResourceStore
  private ready = false
  private readonly stagingTtlMs: number
  private readonly gcGraceMs: number
  private readonly temporaryMaxAgeMs: number

  constructor(ctx: Context, public config: ResourceConfig) {
    super(ctx, 'resources')
    if (!config.path) throw new TypeError('resources.path is required')
    this.stagingTtlMs = this.duration(config.stagingTtlMs ?? 60 * 60_000, 'stagingTtlMs')
    this.gcGraceMs = this.duration(config.gcGraceMs ?? 60 * 60_000, 'gcGraceMs')
    this.temporaryMaxAgeMs = this.duration(config.temporaryMaxAgeMs ?? 24 * 60 * 60_000, 'temporaryMaxAgeMs')
    this.store = new LocalResourceStore(resolveStorePath(ctx, config.path))
  }

  async *[Service.init]() {
    await this.store.init()
    await this.store.cleanupTemporary(new Date(Date.now() - this.temporaryMaxAgeMs))
    this.ready = true
    await this.collectGarbage()
    yield () => {
      this.ready = false
    }
  }

  async stage(input: StageResourceInput): Promise<ResourceMetadata> {
    const name = input.name.trim()
    if (!name) throw new TypeError('resource name is required')
    if (!mediaTypePattern.test(input.mediaType)) throw new TypeError(`invalid media type: ${input.mediaType}`)
    const ttlMs = this.duration(input.stagingTtlMs ?? this.stagingTtlMs, 'stagingTtlMs')
    const stored = await this.store.write(input.content)
    const resourceId = `res_${randomUUID().replaceAll('-', '')}`
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    try {
      this.ctx.database.db.prepare(`
        INSERT INTO resources (
          id, name, media_type, size, digest, store_id, state,
          staged_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'local', 'STAGED', ?, ?, ?)
      `).run(
        resourceId,
        name,
        input.mediaType,
        stored.size,
        stored.digest,
        new Date(nowMs + ttlMs).toISOString(),
        now,
        now,
      )
    } catch (error) {
      const referenced = this.ctx.database.db.prepare(`
        SELECT 1 FROM resources WHERE digest = ? AND state != 'GONE' LIMIT 1
      `).get(stored.digest)
      if (!referenced) await this.store.delete(stored.digest)
      throw error
    }
    return this.get(resourceId)!
  }

  get(resourceId: string): ResourceMetadata | undefined {
    const row = this.ctx.database.db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId) as ResourceRow | undefined
    return row ? mapResource(row) : undefined
  }

  list(): ResourceMetadata[] {
    return (this.ctx.database.db.prepare('SELECT * FROM resources ORDER BY created_at DESC, id').all() as ResourceRow[])
      .map(mapResource)
  }

  open(resourceId: string): Readable {
    const resource = this.requireReadable(resourceId)
    return this.store.read(resource.digest)
  }

  commitOwner(resourceId: string, owner: ResourceOwner): ResourceMetadata {
    this.validateOwner(owner)
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const resource = this.requireResource(resourceId)
      if (resource.state !== 'STAGED' && resource.state !== 'COMMITTED') {
        throw new Error(`resource cannot be committed from ${resource.state}`)
      }
      this.ctx.database.db.prepare(`
        INSERT OR IGNORE INTO resource_owners (resource_id, owner_type, owner_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(resourceId, owner.type, owner.id, now)
      this.ctx.database.db.prepare(`
        UPDATE resources
        SET state = 'COMMITTED', staged_expires_at = NULL, gc_after = NULL, updated_at = ?
        WHERE id = ? AND state IN ('STAGED', 'COMMITTED')
      `).run(now, resourceId)
    })
    return this.get(resourceId)!
  }

  listOwners(resourceId: string): ResourceOwner[] {
    this.requireResource(resourceId)
    return (this.ctx.database.db.prepare(`
      SELECT owner_type, owner_id FROM resource_owners
      WHERE resource_id = ? ORDER BY owner_type, owner_id
    `).all(resourceId) as Array<{ owner_type: string; owner_id: string }>)
      .map(row => ({ type: row.owner_type, id: row.owner_id }))
  }

  removeOwner(resourceId: string, owner: ResourceOwner): ResourceMetadata {
    this.validateOwner(owner)
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    this.ctx.database.transaction(() => {
      const resource = this.requireResource(resourceId)
      if (resource.state !== 'COMMITTED') throw new Error(`resource is not committed: ${resourceId}`)
      this.ctx.database.db.prepare(`
        DELETE FROM resource_owners WHERE resource_id = ? AND owner_type = ? AND owner_id = ?
      `).run(resourceId, owner.type, owner.id)
      const { count } = this.ctx.database.db.prepare(`
        SELECT COUNT(*) AS count FROM resource_owners WHERE resource_id = ?
      `).get(resourceId) as { count: number }
      if (!count) {
        this.ctx.database.db.prepare(`
          UPDATE resources SET gc_after = ?, updated_at = ? WHERE id = ? AND state = 'COMMITTED'
        `).run(new Date(nowMs + this.gcGraceMs).toISOString(), now, resourceId)
      }
    })
    return this.get(resourceId)!
  }

  acquireLease(resourceId: string, holderInput: string, durationMs: number): ResourceLease {
    const holder = holderInput.trim()
    if (!holder) throw new TypeError('resource lease holder is required')
    const leaseDuration = this.duration(durationMs, 'lease duration')
    this.requireReadable(resourceId)
    const leaseId = `lease_${randomUUID().replaceAll('-', '')}`
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    this.ctx.database.db.prepare(`
      INSERT INTO resource_leases (id, resource_id, holder, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(leaseId, resourceId, holder, new Date(nowMs + leaseDuration).toISOString(), now)
    return this.getLease(leaseId)!
  }

  getLease(leaseId: string): ResourceLease | undefined {
    const row = this.ctx.database.db.prepare('SELECT * FROM resource_leases WHERE id = ?').get(leaseId) as LeaseRow | undefined
    return row ? mapLease(row) : undefined
  }

  releaseLease(leaseId: string): boolean {
    return !!this.ctx.database.db.prepare('DELETE FROM resource_leases WHERE id = ?').run(leaseId).changes
  }

  async collectGarbage(nowInput = new Date()): Promise<number> {
    const now = nowInput.toISOString()
    this.ctx.database.db.prepare('DELETE FROM resource_leases WHERE expires_at <= ?').run(now)
    const rows = this.ctx.database.db.prepare(`
      SELECT resources.* FROM resources
      WHERE resources.state = 'DELETING'
         OR (
           resources.state = 'STAGED'
           AND resources.staged_expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM resource_leases
             WHERE resource_leases.resource_id = resources.id AND resource_leases.expires_at > ?
           )
         )
         OR (
           resources.state = 'COMMITTED'
           AND resources.gc_after IS NOT NULL AND resources.gc_after <= ?
           AND NOT EXISTS (
             SELECT 1 FROM resource_owners WHERE resource_owners.resource_id = resources.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM resource_leases
             WHERE resource_leases.resource_id = resources.id AND resource_leases.expires_at > ?
           )
         )
      ORDER BY resources.created_at, resources.id
    `).all(now, now, now, now) as ResourceRow[]
    let collected = 0
    for (const row of rows) {
      const claimed = this.ctx.database.db.prepare(`
        UPDATE resources SET state = 'DELETING', updated_at = ?
        WHERE id = ? AND state IN ('STAGED', 'COMMITTED', 'DELETING')
      `).run(now, row.id)
      if (!claimed.changes) continue
      const shared = this.ctx.database.db.prepare(`
        SELECT 1 FROM resources
        WHERE digest = ? AND id != ? AND state != 'GONE' LIMIT 1
      `).get(row.digest, row.id)
      if (!shared) await this.store.delete(row.digest)
      this.ctx.database.db.prepare(`
        UPDATE resources
        SET state = 'GONE', staged_expires_at = NULL, gc_after = NULL,
            updated_at = ?, gone_at = ?
        WHERE id = ? AND state = 'DELETING'
      `).run(now, now, row.id)
      collected += 1
    }
    return collected
  }

  health(): ResourceHealth {
    const counts = this.ctx.database.db.prepare(`
      SELECT
        SUM(CASE WHEN state = 'STAGED' THEN 1 ELSE 0 END) AS staged,
        SUM(CASE WHEN state = 'COMMITTED' THEN 1 ELSE 0 END) AS committed,
        SUM(CASE WHEN state = 'DELETING' THEN 1 ELSE 0 END) AS deleting,
        SUM(CASE WHEN state = 'GONE' THEN 1 ELSE 0 END) AS gone
      FROM resources
    `).get() as { staged: number | null; committed: number | null; deleting: number | null; gone: number | null }
    const { count: activeLeases } = this.ctx.database.db.prepare(`
      SELECT COUNT(*) AS count FROM resource_leases WHERE expires_at > ?
    `).get(new Date().toISOString()) as { count: number }
    return {
      ready: this.ready,
      staged: counts.staged ?? 0,
      committed: counts.committed ?? 0,
      deleting: counts.deleting ?? 0,
      gone: counts.gone ?? 0,
      activeLeases,
    }
  }

  private requireResource(resourceId: string): ResourceMetadata {
    const resource = this.get(resourceId)
    if (!resource) throw new ResourceNotFoundError(`resource not found: ${resourceId}`)
    return resource
  }

  private requireReadable(resourceId: string): ResourceMetadata {
    const resource = this.requireResource(resourceId)
    if (resource.state !== 'STAGED' && resource.state !== 'COMMITTED') {
      throw new Error(`resource is not readable: ${resourceId} (${resource.state})`)
    }
    return resource
  }

  private validateOwner(owner: ResourceOwner): void {
    if (!ownerPartPattern.test(owner.type) || !ownerPartPattern.test(owner.id)) {
      throw new TypeError('resource owner type and id must be stable identifiers')
    }
  }

  private duration(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`)
    return value
  }
}

export default ResourceService
