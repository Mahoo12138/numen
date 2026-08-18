import { DatabaseService } from '@numen/database'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResourceService } from '../src/index.js'

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

describe('ResourceService', () => {
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
