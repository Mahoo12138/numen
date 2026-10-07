import { DatabaseService } from '@numenjs/database'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResourceNotFoundError, ResourceService } from '../src/index.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createContext(databasePath: string, storePath: string): Promise<Context> {
  const root = new Context()
  await root.plugin(DatabaseService, { path: databasePath })
  await root.plugin(ResourceService, {
    path: storePath,
    stagingTtlMs: 0,
    gcGraceMs: 0,
  })
  return root
}

async function readText(root: Context, resourceId: string): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of root.resources.open(resourceId)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function pauseDelete(root: Context, digest: string) {
  let started!: () => void
  let resume!: () => void
  const paused = new Promise<void>(resolve => { started = resolve })
  const resumed = new Promise<void>(resolve => { resume = resolve })
  const original = root.resources.store.delete.bind(root.resources.store)
  const spy = vi.spyOn(root.resources.store, 'delete').mockImplementation(async value => {
    if (value === digest) {
      started()
      await resumed
    }
    return original(value)
  })
  return { paused, resume, spy }
}

function orderCandidates(root: Context, resourceIds: string[]): void {
  const update = root.database.db.prepare('UPDATE resources SET created_at = ? WHERE id = ?')
  resourceIds.forEach((resourceId, index) => update.run(new Date(index).toISOString(), resourceId))
}

describe('ResourceService', () => {
  it.each(['STAGED', 'COMMITTED'] as const)('rechecks %s expiration after reading the GC candidate list', async state => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const first = await root.resources.stage({ name: 'First', mediaType: 'text/plain', content: Buffer.from('first expiration') })
    const second = await root.resources.stage({ name: 'Second', mediaType: 'text/plain', content: Buffer.from('second expiration') })
    if (state === 'COMMITTED') {
      root.resources.commitOwner(second.id, { type: 'run', id: 'removed_run' })
      root.resources.removeOwner(second.id, { type: 'run', id: 'removed_run' })
    }
    orderCandidates(root, [first.id, second.id])
    const deletion = pauseDelete(root, first.digest)
    const collection = root.resources.collectGarbage(new Date(Date.now() + 1))
    await deletion.paused
    try {
      const expiryColumn = state === 'STAGED' ? 'staged_expires_at' : 'gc_after'
      root.database.db.prepare(`UPDATE resources SET ${expiryColumn} = ? WHERE id = ?`)
        .run(new Date(Date.now() + 60_000).toISOString(), second.id)
    } finally {
      deletion.resume()
    }
    const collected = await collection
    try {
      expect(collected).toBe(1)
      expect(root.resources.get(second.id)?.state).toBe(state)
      expect(await readText(root, second.id)).toBe('second expiration')
    } finally {
      await root.fiber.dispose()
    }
  })

  it('does not treat a newly expired lease as GC protection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const first = await root.resources.stage({ name: 'First', mediaType: 'text/plain', content: Buffer.from('expired lease first') })
    const second = await root.resources.stage({ name: 'Second', mediaType: 'text/plain', content: Buffer.from('expired lease second') })
    orderCandidates(root, [first.id, second.id])
    const deletion = pauseDelete(root, first.digest)
    const collection = root.resources.collectGarbage(new Date(Date.now() + 1_000))
    await deletion.paused
    try {
      root.resources.acquireLease(second.id, 'expired_accept', 0)
    } finally {
      deletion.resume()
    }
    const collected = await collection
    try {
      expect(collected).toBe(2)
      expect(root.resources.get(second.id)?.state).toBe('GONE')
      expect(await root.resources.store.has(second.digest)).toBe(false)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('serializes overlapping collections and recovers after an unlink failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const resource = await root.resources.stage({ name: 'Retry delete', mediaType: 'text/plain', content: Buffer.from('retry gc') })
    const deletion = pauseDelete(root, resource.digest)
    deletion.spy.mockRejectedValueOnce(new Error('injected unlink failure'))
    try {
      await expect(root.resources.collectGarbage(new Date(Date.now() + 1))).rejects.toThrow('injected unlink failure')
      expect(root.resources.get(resource.id)?.state).toBe('DELETING')
      expect(await root.resources.store.has(resource.digest)).toBe(true)
      const first = root.resources.collectGarbage(new Date(Date.now() + 1))
      const second = root.resources.collectGarbage(new Date(Date.now() + 1))
      await deletion.paused
      expect(deletion.spy).toHaveBeenCalledTimes(2)
      deletion.resume()
      expect(await Promise.all([first, second])).toEqual([1, 0])
      expect(deletion.spy).toHaveBeenCalledTimes(2)
      expect(root.resources.get(resource.id)?.state).toBe('GONE')
      expect(await root.resources.store.has(resource.digest)).toBe(false)
    } finally {
      deletion.resume()
      await root.fiber.dispose()
    }
  })

  it('preflights metadata and physical readability without creating retention owners', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const resource = await root.resources.stage({ name: 'Preflight', mediaType: 'text/plain', content: Buffer.from('preflight'), stagingTtlMs: 60_000 })
    try {
      expect(await root.resources.preflight(resource.id)).toMatchObject({ id: resource.id, state: 'STAGED' })
      expect(root.resources.listOwners(resource.id)).toEqual([])
      root.resources.commitOwner(resource.id, { type: 'snapshot', id: 'snapshot_preflight' })
      expect(await root.resources.preflight(resource.id)).toMatchObject({ id: resource.id, state: 'COMMITTED' })
      await expect(root.resources.preflight('res_missing')).rejects.toBeInstanceOf(ResourceNotFoundError)
      expect(() => root.resources.assertAcceptable('res_missing')).toThrow(ResourceNotFoundError)
      await root.resources.store.delete(resource.digest)
      await expect(root.resources.preflight(resource.id)).rejects.toThrow(`resource object is not readable: ${resource.id}`)
      await expect(root.resources.preflight(resource.id)).rejects.toBeInstanceOf(ResourceNotFoundError)
      expect(() => root.resources.assertAcceptable(resource.id)).toThrow(ResourceNotFoundError)
      expect(root.resources.get(resource.id)?.state).toBe('COMMITTED')
      expect(root.resources.listOwners(resource.id)).toEqual([{ type: 'snapshot', id: 'snapshot_preflight' }])
    } finally {
      await root.fiber.dispose()
    }
  })

  it('rejects acceptance after GC has claimed a preflighted resource', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const storePath = join(directory, 'store')
    const root = await createContext(databasePath, storePath)
    const other = await createContext(databasePath, storePath)
    const resource = await root.resources.stage({ name: 'Claimed', mediaType: 'text/plain', content: Buffer.from('claimed') })
    await other.resources.preflight(resource.id)
    const deletion = pauseDelete(root, resource.digest)
    const collection = root.resources.collectGarbage(new Date(Date.now() + 1))
    await deletion.paused
    try {
      expect(other.resources.get(resource.id)?.state).toBe('DELETING')
      expect(() => other.database.transaction(() => other.resources.commitOwner(resource.id, { type: 'snapshot', id: 'rejected_snapshot' })))
        .toThrow('resource cannot be committed from DELETING')
      expect(() => other.resources.acquireLease(resource.id, 'rejected_lease', 60_000)).toThrow('resource is not readable')
      await expect(other.resources.preflight(resource.id)).rejects.toThrow('resource is not readable')
      await expect(other.resources.preflight(resource.id)).rejects.toBeInstanceOf(ResourceNotFoundError)
      expect(() => other.resources.assertAcceptable(resource.id)).toThrow(ResourceNotFoundError)
      expect(other.resources.listOwners(resource.id)).toEqual([])
    } finally {
      deletion.resume()
    }
    await collection
    try {
      expect(() => other.resources.commitOwner(resource.id, { type: 'snapshot', id: 'rejected_snapshot' }))
        .toThrow('resource cannot be committed from GONE')
      await expect(other.resources.preflight(resource.id)).rejects.toThrow('resource is not readable')
      await expect(other.resources.preflight(resource.id)).rejects.toBeInstanceOf(ResourceNotFoundError)
      expect(() => other.resources.assertAcceptable(resource.id)).toThrow(ResourceNotFoundError)
      expect(await other.resources.store.has(resource.digest)).toBe(false)
    } finally {
      await other.fiber.dispose()
      await root.fiber.dispose()
    }
  })

  it('rolls owner and metadata changes back with an outer acceptance transaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const staged = await root.resources.stage({ name: 'Staged', mediaType: 'text/plain', content: Buffer.from('rollback staged'), stagingTtlMs: 60_000 })
    const committed = await root.resources.stage({ name: 'Committed', mediaType: 'text/plain', content: Buffer.from('rollback committed'), stagingTtlMs: 60_000 })
    root.resources.commitOwner(committed.id, { type: 'automation', id: 'removed_owner' })
    root.resources.removeOwner(committed.id, { type: 'automation', id: 'removed_owner' })
    const before = [root.resources.get(staged.id), root.resources.get(committed.id)]
    try {
      await root.resources.preflight(staged.id)
      await root.resources.preflight(committed.id)
      expect(() => root.database.transaction(() => {
        root.resources.commitOwner(staged.id, { type: 'snapshot', id: 'rollback_snapshot' })
        root.resources.commitOwner(committed.id, { type: 'run', id: 'rollback_run' })
        throw new Error('injected acceptance failure')
      })).toThrow('injected acceptance failure')
      expect([root.resources.get(staged.id), root.resources.get(committed.id)]).toEqual(before)
      expect(root.resources.listOwners(staged.id)).toEqual([])
      expect(root.resources.listOwners(committed.id)).toEqual([])
      expect(await readText(root, staged.id)).toBe('rollback staged')
      expect(await readText(root, committed.id)).toBe('rollback committed')
    } finally {
      await root.fiber.dispose()
    }
  })

  it('rechecks physical readability within acceptance after successful preflight', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const kept = await root.resources.stage({ name: 'Kept', mediaType: 'text/plain', content: Buffer.from('kept bytes'), stagingTtlMs: 60_000 })
    const lost = await root.resources.stage({ name: 'Lost', mediaType: 'text/plain', content: Buffer.from('lost bytes'), stagingTtlMs: 60_000 })
    try {
      await root.resources.preflight(kept.id)
      await root.resources.preflight(lost.id)
      await root.resources.store.delete(lost.digest)
      expect(() => root.database.transaction(() => {
        root.resources.assertAcceptable(kept.id)
        root.resources.commitOwner(kept.id, { type: 'snapshot', id: 'physical_rollback_snapshot' })
        root.resources.assertAcceptable(lost.id)
        root.resources.commitOwner(lost.id, { type: 'run', id: 'physical_rollback_run' })
      })).toThrow(`resource object is not readable: ${lost.id}`)
      expect(root.resources.get(kept.id)).toEqual(kept)
      expect(root.resources.get(lost.id)).toEqual(lost)
      expect(root.resources.listOwners(kept.id)).toEqual([])
      expect(root.resources.listOwners(lost.id)).toEqual([])
      expect(await readText(root, kept.id)).toBe('kept bytes')
    } finally {
      await root.fiber.dispose()
    }
  })

  it('keeps snapshot and run owners durable across restart until both are released', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const storePath = join(directory, 'store')
    const root = await createContext(databasePath, storePath)
    const resource = await root.resources.stage({ name: 'Historical', mediaType: 'text/plain', content: Buffer.from('history bytes') })
    await root.resources.preflight(resource.id)
    root.database.transaction(() => {
      root.resources.assertAcceptable(resource.id)
      root.resources.commitOwner(resource.id, { type: 'snapshot', id: 'snapshot_history' })
      root.resources.commitOwner(resource.id, { type: 'run', id: 'run_history' })
    })
    await root.fiber.dispose()
    const restarted = await createContext(databasePath, storePath)
    try {
      expect(restarted.resources.listOwners(resource.id)).toEqual([
        { type: 'run', id: 'run_history' },
        { type: 'snapshot', id: 'snapshot_history' },
      ])
      expect(await restarted.resources.collectGarbage(new Date(Date.now() + 24 * 60 * 60_000))).toBe(0)
      expect(await readText(restarted, resource.id)).toBe('history bytes')
      restarted.resources.removeOwner(resource.id, { type: 'snapshot', id: 'snapshot_history' })
      expect(restarted.resources.get(resource.id)).not.toHaveProperty('gcAfter')
      expect(await restarted.resources.collectGarbage(new Date(Date.now() + 24 * 60 * 60_000))).toBe(0)
      expect(await readText(restarted, resource.id)).toBe('history bytes')
      restarted.resources.removeOwner(resource.id, { type: 'run', id: 'run_history' })
      expect(await restarted.resources.collectGarbage(new Date(Date.now() + 1))).toBe(1)
      expect(restarted.resources.get(resource.id)?.state).toBe('GONE')
      expect(await restarted.resources.store.has(resource.digest)).toBe(false)
    } finally {
      await restarted.fiber.dispose()
    }
  })

  it.each(['owner', 'lease'] as const)('rechecks a stale GC candidate protected by a new %s from another connection', async protection => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const storePath = join(directory, 'store')
    const root = await createContext(databasePath, storePath)
    const other = await createContext(databasePath, storePath)
    const first = await root.resources.stage({ name: 'First', mediaType: 'text/plain', content: Buffer.from('first') })
    const second = await root.resources.stage({ name: 'Protected', mediaType: 'text/plain', content: Buffer.from('second') })
    orderCandidates(root, [first.id, second.id])
    const deletion = pauseDelete(root, first.digest)
    const collection = root.resources.collectGarbage(new Date(Date.now() + 1))
    await deletion.paused
    try {
      if (protection === 'owner') other.resources.commitOwner(second.id, { type: 'snapshot', id: 'snapshot_1' })
      else other.resources.acquireLease(second.id, 'accept_1', 60_000)
    } finally {
      deletion.resume()
    }
    const collected = await collection
    try {
      expect(collected).toBe(1)
      expect(root.resources.get(first.id)?.state).toBe('GONE')
      expect(root.resources.get(second.id)?.state).toBe(protection === 'owner' ? 'COMMITTED' : 'STAGED')
      expect(await readText(other, second.id)).toBe('second')
      expect(await other.resources.store.has(second.digest)).toBe(true)
    } finally {
      await other.fiber.dispose()
      await root.fiber.dispose()
    }
  })

  it('keeps shared physical content when a stale duplicate candidate gains an owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const first = await root.resources.stage({ name: 'Pause', mediaType: 'text/plain', content: Buffer.from('pause') })
    const duplicateA = await root.resources.stage({ name: 'Shared A', mediaType: 'text/plain', content: Buffer.from('shared race') })
    const duplicateB = await root.resources.stage({ name: 'Shared B', mediaType: 'text/plain', content: Buffer.from('shared race') })
    orderCandidates(root, [first.id, duplicateA.id, duplicateB.id])
    const deletion = pauseDelete(root, first.digest)
    const collection = root.resources.collectGarbage(new Date(Date.now() + 1))
    await deletion.paused
    try {
      root.resources.commitOwner(duplicateB.id, { type: 'run', id: 'run_shared' })
    } finally {
      deletion.resume()
    }
    const collected = await collection
    try {
      expect(collected).toBe(2)
      expect(root.resources.get(duplicateA.id)?.state).toBe('GONE')
      expect(root.resources.get(duplicateB.id)?.state).toBe('COMMITTED')
      expect(await readText(root, duplicateB.id)).toBe('shared race')
      expect(deletion.spy).not.toHaveBeenCalledWith(duplicateB.digest)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('rejects staging shared content while its last physical object is being deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const storePath = join(directory, 'store')
    const root = await createContext(databasePath, storePath)
    const other = await createContext(databasePath, storePath)
    const first = await root.resources.stage({ name: 'Deleting', mediaType: 'text/plain', content: Buffer.from('shared staging race') })
    const deletion = pauseDelete(root, first.digest)
    const collection = root.resources.collectGarbage(new Date(Date.now() + 1))
    await deletion.paused
    let stageError: unknown
    try {
      await other.resources.stage({ name: 'New duplicate', mediaType: 'text/plain', content: Buffer.from('shared staging race'), stagingTtlMs: 60_000 })
    } catch (error) {
      stageError = error
    } finally {
      deletion.resume()
    }
    await collection
    try {
      expect(stageError).toBeInstanceOf(Error)
      expect(String(stageError)).toContain('being deleted')
      expect(root.resources.list()).toHaveLength(1)
      expect(await root.resources.store.has(first.digest)).toBe(false)
      const restaged = await other.resources.stage({ name: 'After delete', mediaType: 'text/plain', content: Buffer.from('shared staging race'), stagingTtlMs: 60_000 })
      expect(await readText(other, restaged.id)).toBe('shared staging race')
    } finally {
      await other.fiber.dispose()
      await root.fiber.dispose()
    }
  })

  it('rejects publication when GC removed shared bytes after writing and before metadata insertion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const previous = await root.resources.stage({ name: 'Previous', mediaType: 'text/plain', content: Buffer.from('write publication race') })
    const write = root.resources.store.write.bind(root.resources.store)
    const spy = vi.spyOn(root.resources.store, 'write').mockImplementationOnce(async content => {
      const stored = await write(content)
      await root.resources.collectGarbage(new Date(Date.now() + 1))
      return stored
    })
    try {
      await expect(root.resources.stage({ name: 'Missing duplicate', mediaType: 'text/plain', content: Buffer.from('write publication race'), stagingTtlMs: 60_000 }))
        .rejects.toMatchObject({ code: 'ENOENT' })
      expect(root.resources.list()).toHaveLength(1)
      expect(root.resources.get(previous.id)?.state).toBe('GONE')
      expect(await root.resources.store.has(previous.digest)).toBe(false)
      spy.mockRestore()
      const accepted = await root.resources.stage({ name: 'New content', mediaType: 'text/plain', content: Buffer.from('write publication race'), stagingTtlMs: 60_000 })
      expect(await readText(root, accepted.id)).toBe('write publication race')
    } finally {
      spy.mockRestore()
      await root.fiber.dispose()
    }
  })

  it('does not unlink newly accepted shared bytes while cleaning up a failed metadata insertion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const storePath = join(directory, 'store')
    const root = await createContext(databasePath, storePath)
    const other = await createContext(databasePath, storePath)
    root.database.db.exec(`
      CREATE TRIGGER reject_test_resource BEFORE INSERT ON resources WHEN NEW.name = 'Rejected'
      BEGIN SELECT RAISE(ABORT, 'injected metadata insertion failure'); END
    `)
    const originalDelete = root.resources.store.delete.bind(root.resources.store)
    let started!: () => void
    let resume!: () => void
    const cleanupPaused = new Promise<void>(resolve => { started = resolve })
    const cleanupResumed = new Promise<void>(resolve => { resume = resolve })
    vi.spyOn(root.resources.store, 'delete').mockImplementation(async digest => {
      started()
      await cleanupResumed
      return originalDelete(digest)
    })
    const failed = root.resources.stage({ name: 'Rejected', mediaType: 'text/plain', content: Buffer.from('failed publication race') })
      .catch(error => error as Error)
    // If cleanup yields after its no-owner check, publish another reference in
    // that window. Synchronous cleanup completes before this publication begins.
    await Promise.race([cleanupPaused, failed])
    let accepted: Awaited<ReturnType<typeof other.resources.stage>>
    try {
      accepted = await other.resources.stage({ name: 'Accepted', mediaType: 'text/plain', content: Buffer.from('failed publication race'), stagingTtlMs: 60_000 })
    } finally {
      resume()
    }
    const error = await failed
    try {
      expect(String(error)).toContain('injected metadata insertion failure')
      expect(root.resources.list().map(resource => resource.id)).toEqual([accepted.id])
      expect(await readText(other, accepted.id)).toBe('failed publication race')
    } finally {
      await other.fiber.dispose()
      await root.fiber.dispose()
    }
  })

  it('stages, commits, owns, and recovers resource metadata and bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const storePath = join(directory, 'store')
    const root = await createContext(databasePath, storePath)
    const staged = await root.resources.stage({
      name: 'Greeting',
      mediaType: 'text/plain',
      content: Buffer.from('durable bytes'),
      stagingTtlMs: 60_000,
    })
    expect(staged).toMatchObject({
      ref: { $resource: staged.id },
      state: 'STAGED',
      size: 13,
      storeId: 'local',
    })
    expect(staged).not.toHaveProperty('path')
    const committed = root.resources.commitOwner(staged.id, { type: 'run', id: 'run_1' })
    expect(committed).toMatchObject({ state: 'COMMITTED' })
    expect(committed).not.toHaveProperty('stagedExpiresAt')
    expect(root.resources.listOwners(staged.id)).toEqual([{ type: 'run', id: 'run_1' }])
    expect(await readText(root, staged.id)).toBe('durable bytes')
    await root.fiber.dispose()

    const restarted = await createContext(databasePath, storePath)
    expect(restarted.resources.get(staged.id)).toMatchObject({ state: 'COMMITTED' })
    expect(await readText(restarted, staged.id)).toBe('durable bytes')
    await restarted.fiber.dispose()
  })

  it('protects unowned resources with leases and collects them after release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const staged = await root.resources.stage({
      name: 'Temporary',
      mediaType: 'application/octet-stream',
      content: Buffer.from('temporary'),
    })
    const lease = root.resources.acquireLease(staged.id, 'attempt_1', 60_000)
    expect(await root.resources.collectGarbage(new Date(Date.now() + 1))).toBe(0)
    expect(root.resources.get(staged.id)?.state).toBe('STAGED')
    expect(root.resources.releaseLease(lease.id)).toBe(true)
    expect(await root.resources.collectGarbage(new Date(Date.now() + 1))).toBe(1)
    expect(root.resources.get(staged.id)?.state).toBe('GONE')
    expect(await root.resources.store.has(staged.digest)).toBe(false)
  })

  it('honors owners and safely removes deduplicated physical content once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), join(directory, 'store'))
    const owned = await root.resources.stage({
      name: 'Owned',
      mediaType: 'text/plain',
      content: Buffer.from('shared'),
      stagingTtlMs: 60_000,
    })
    root.resources.commitOwner(owned.id, { type: 'automation', id: 'auto_1' })
    expect(await root.resources.collectGarbage(new Date(Date.now() + 1))).toBe(0)
    root.resources.removeOwner(owned.id, { type: 'automation', id: 'auto_1' })

    const duplicate = await root.resources.stage({
      name: 'Duplicate',
      mediaType: 'text/plain',
      content: Buffer.from('shared'),
    })
    expect(duplicate.digest).toBe(owned.digest)
    expect(await root.resources.collectGarbage(new Date(Date.now() + 1))).toBe(2)
    expect(root.resources.get(owned.id)?.state).toBe('GONE')
    expect(root.resources.get(duplicate.id)?.state).toBe('GONE')
    expect(await root.resources.store.has(owned.digest)).toBe(false)
    expect(root.resources.health()).toMatchObject({ staged: 0, committed: 0, deleting: 0, gone: 2 })
    await root.fiber.dispose()
  })

  it('finishes a durable DELETING resource during restart recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-resources-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const storePath = join(directory, 'store')
    const root = await createContext(databasePath, storePath)
    const resource = await root.resources.stage({
      name: 'Interrupted delete',
      mediaType: 'application/octet-stream',
      content: Buffer.from('recover deletion'),
      stagingTtlMs: 60_000,
    })
    root.database.db.prepare(`
      UPDATE resources SET state = 'DELETING' WHERE id = ?
    `).run(resource.id)
    await root.fiber.dispose()

    const restarted = await createContext(databasePath, storePath)
    expect(restarted.resources.get(resource.id)?.state).toBe('GONE')
    expect(await restarted.resources.store.has(resource.digest)).toBe(false)
    await restarted.fiber.dispose()
  })
})
