import { DatabaseService } from '@numen/database'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConnectionConflictError,
  ConnectionService,
  type ConnectionAdapterDefinition,
} from '../src/index.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const adapter: ConnectionAdapterDefinition = {
  id: 'test:http',
  version: 1,
  title: 'HTTP',
  config: z.object({ baseUrl: z.string().required() }),
}

async function createContext(path: string, defineAdapter = true): Promise<Context> {
  const root = new Context()
  await root.plugin(DatabaseService, { path })
  await root.plugin(ConnectionService)
  if (defineAdapter) root.connections.defineAdapter(root, adapter)
  return root
}

describe('ConnectionService', () => {
  it('persists validated desired state with optimistic generation changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-connections-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const root = await createContext(databasePath)
    expect(() => root.connections.create({
      name: 'Invalid',
      adapter,
      config: {},
    })).toThrow()

    const created = root.connections.create({
      name: 'Primary API',
      adapter,
      config: { baseUrl: 'https://example.test' },
      credentialId: 'cred_primary',
    })
    expect(created).toMatchObject({
      enabled: false,
      generation: 1,
      adapterAvailable: true,
      config: { baseUrl: 'https://example.test' },
    })
    const updated = root.connections.update({
      id: created.id,
      expectedGeneration: 1,
      name: 'Primary API v2',
      config: { baseUrl: 'https://api.example.test' },
    })
    expect(updated).toMatchObject({ name: 'Primary API v2', generation: 2 })
    expect(() => root.connections.update({
      id: created.id,
      expectedGeneration: 1,
      name: 'Stale edit',
    })).toThrow(ConnectionConflictError)
    const enabled = root.connections.setEnabled(created.id, 2, true)
    expect(enabled).toMatchObject({ enabled: true, generation: 3 })
    expect(root.connections.health()).toMatchObject({ ready: true, total: 1, enabled: 1, unavailable: 0 })
    await root.fiber.dispose()

    const restarted = await createContext(databasePath, false)
    expect(restarted.connections.get(created.id)).toMatchObject({
      enabled: true,
      generation: 3,
      adapterAvailable: false,
    })
    expect(restarted.connections.health()).toMatchObject({ total: 1, enabled: 1, unavailable: 1 })
    restarted.connections.defineAdapter(restarted, adapter)
    expect(restarted.connections.get(created.id)?.adapterAvailable).toBe(true)
    await restarted.fiber.dispose()
  })

  it('tracks adapter definitions through Cordis effects', async () => {
    const root = await createContext(':memory:', false)
    const dispose = root.connections.defineAdapter(root, adapter)
    expect(root.connections.listAdapters()).toHaveLength(1)
    expect(() => root.connections.defineAdapter(root, adapter)).toThrow('already defined')
    dispose()
    expect(root.connections.listAdapters()).toHaveLength(0)
    await root.fiber.dispose()
  })
})
