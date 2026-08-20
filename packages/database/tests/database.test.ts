import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseService, runMigrations } from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('DatabaseService', () => {
  it('creates the durable domain schema and is idempotent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-database-'))
    temporaryDirectories.push(directory)
    const root = new Context()
    await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })

    const tables = root.database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all() as string[]
    expect(tables).toContain('automations')
    expect(tables).toContain('attempts')
    expect(tables).toContain('run_events')
    expect(tables).toContain('trigger_events')
    expect(tables).toContain('connections')
    expect(tables).toContain('credentials')
    expect(tables).toContain('resources')
    expect(tables).toContain('resource_owners')
    expect(tables).toContain('resource_leases')
    expect(tables).toContain('execution_iterations')
    expect(root.database.health()).toMatchObject({ ready: true, migrationVersion: 10 })
    expect(runMigrations(root.database.db)).toBe(0)

    await root.fiber.dispose()
  })

  it('rolls back a failed migration', async () => {
    const root = new Context()
    await root.plugin(DatabaseService, { path: ':memory:' })

    expect(() => runMigrations(root.database.db, [{
      version: 11,
      name: 'broken',
      up(database) {
        database.exec('CREATE TABLE should_rollback (id TEXT);')
        throw new Error('migration failed')
      },
    }])).toThrow('migration failed')

    const exists = root.database.db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'should_rollback'")
      .get() as { count: number }
    expect(exists.count).toBe(0)
    await root.fiber.dispose()
  })
})
