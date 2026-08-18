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
  if (defineAdapter) {
    root.connections.defineAdapter(root, adapter)
    root.connections.provideAdapter(root, adapter, { async open() {} })
  }
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
    expect(restarted.connections.get(created.id)?.adapterAvailable).toBe(false)
    restarted.connections.provideAdapter(restarted, adapter, { async open() {} })
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

  it('opens, recreates, and stops generation-fenced runtimes', async () => {
    const root = await createContext(':memory:', false)
    root.connections.defineAdapter(root, adapter)
    const opens: number[] = []
    let closes = 0
    root.connections.provideAdapter(root, adapter, {
      async open({ connection }) {
        opens.push(connection.generation)
        return {
          close() {
            closes += 1
          },
        }
      },
    })
    const created = root.connections.create({
      name: 'Runtime API',
      adapter,
      config: { baseUrl: 'https://example.test' },
      enabled: true,
    })
    await root.connections.reconcile()
    expect(root.connections.getRuntimeState(created.id)).toMatchObject({ status: 'READY', generation: 1 })

    const updated = root.connections.update({
      id: created.id,
      expectedGeneration: 1,
      config: { baseUrl: 'https://next.example.test' },
    })
    await root.connections.reconcile()
    expect(opens).toEqual([1, 2])
    expect(closes).toBe(1)
    expect(root.connections.getRuntimeState(created.id)).toMatchObject({ status: 'READY', generation: 2 })

    root.connections.setEnabled(created.id, updated.generation, false)
    await root.connections.reconcile()
    expect(root.connections.getRuntimeState(created.id)).toEqual({ connectionId: created.id, status: 'STOPPED' })
    expect(closes).toBe(2)
    await root.fiber.dispose()
  })

  it('projects adapter open failures without losing desired enabled state', async () => {
    const root = await createContext(':memory:', false)
    root.connections.defineAdapter(root, adapter)
    root.connections.provideAdapter(root, adapter, {
      async open() {
        throw new Error('authentication failed')
      },
    })
    const created = root.connections.create({
      name: 'Broken API',
      adapter,
      config: { baseUrl: 'https://example.test' },
      enabled: true,
    })
    await root.connections.reconcile()
    expect(root.connections.get(created.id)?.enabled).toBe(true)
    expect(root.connections.getRuntimeState(created.id)).toMatchObject({
      status: 'ERROR',
      error: 'authentication failed',
    })
    expect(root.connections.health()).toMatchObject({ errors: 1, runtimeReady: 0 })
    await root.fiber.dispose()
  })

  it('fences a late runtime opened for an obsolete generation', async () => {
    const root = await createContext(':memory:', false)
    root.connections.defineAdapter(root, adapter)
    let releaseFirst: ((runtime: { close(): void }) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    let staleCloses = 0
    root.connections.provideAdapter(root, adapter, {
      async open({ connection }) {
        if (connection.generation === 1) {
          markStarted?.()
          return new Promise(resolve => {
            releaseFirst = resolve
          })
        }
        return {}
      },
    })
    const created = root.connections.create({
      name: 'Slow API',
      adapter,
      config: { baseUrl: 'https://slow.example.test' },
      enabled: true,
    })
    const firstReconcile = root.connections.reconcile()
    await started
    root.connections.update({
      id: created.id,
      expectedGeneration: 1,
      config: { baseUrl: 'https://new.example.test' },
    })
    await root.connections.reconcile()
    expect(root.connections.getRuntimeState(created.id)).toMatchObject({ status: 'READY', generation: 2 })

    releaseFirst?.({ close: () => { staleCloses += 1 } })
    await firstReconcile
    expect(staleCloses).toBe(1)
    expect(root.connections.getRuntimeState(created.id)).toMatchObject({ status: 'READY', generation: 2 })
    await root.fiber.dispose()
  })
})
