import Database from 'better-sqlite3'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseService, runMigrations, coreMigrations } from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('DatabaseService', () => {
  it('upgrades a populated v12 database and marks legacy Connections for Adapter-owned type adoption', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db, coreMigrations.filter(migration => migration.version <= 12))
      db.prepare('INSERT INTO automations (id, name, enabled, activation_generation, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)').run('auto_existing', 'Existing', 'now', 'now')
      db.prepare('INSERT INTO automation_drafts (automation_id, source_json, presentation_json, version, updated_at) VALUES (?, ?, ?, 3, ?)').run('auto_existing', '{"flow":{"type":"unknown"}}', '{"x":5}', 'now')
      db.prepare('INSERT INTO connections (id, name, adapter_id, adapter_version, config_json, enabled, generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)')
        .run('conn_existing', 'Existing', 'legacy:adapter', 2, '{}', 'now', 'now')
      const before = db.prepare('SELECT * FROM automation_drafts').get()
      expect(runMigrations(db)).toBe(2)
      expect(db.prepare('SELECT * FROM automation_drafts').get()).toEqual(before)
      expect(db.prepare('SELECT COUNT(*) AS count FROM automation_draft_copy_requests').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM manual_run_requests').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT type_id, type_version FROM connections WHERE id = ?').get('conn_existing'))
        .toEqual({ type_id: '', type_version: 1 })
      expect(runMigrations(db)).toBe(0)
    } finally { db.close() }
  })

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
    expect(tables).toContain('automation_draft_copy_requests')
    expect(tables).toContain('manual_run_requests')
    expect(tables).toContain('attempts')
    expect(tables).toContain('run_events')
    expect(tables).toContain('trigger_events')
    expect(tables).toContain('connections')
    expect(tables).toContain('credentials')
    expect(tables).toContain('resources')
    expect(tables).toContain('resource_owners')
    expect(tables).toContain('resource_leases')
    expect(tables).toContain('execution_iterations')
    expect(root.database.health()).toMatchObject({ ready: true, migrationVersion: 14 })
    expect(runMigrations(root.database.db)).toBe(0)

    await root.fiber.dispose()
  })

  it('rolls back a failed migration', async () => {
    const root = new Context()
    await root.plugin(DatabaseService, { path: ':memory:' })

    expect(() => runMigrations(root.database.db, [{
      version: 15,
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
