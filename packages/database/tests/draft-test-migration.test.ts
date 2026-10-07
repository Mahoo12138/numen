import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { coreMigrations, runMigrations, type Migration } from '../src/migrations.js'
import { captureDraftTestV14Rows, draftTestV14Ids as ids, populateDraftTestV14Fixture } from './fixtures/draft-test-v14.js'

const legacyMigrations = coreMigrations.filter(migration => migration.version <= 14)
const snapshotMigration = coreMigrations.find(migration => migration.version === 15)!

function legacyRows(database: Database.Database) {
  const rows = captureDraftTestV14Rows(database)
  rows.schema_migrations = rows.schema_migrations!.filter(row => (row as { version: number }).version <= 14)
  rows.automation_revisions = rows.automation_revisions!.map(row => {
    const { purpose, source_draft_version, base_revision_id, ...legacy } = row as Record<string, unknown>
    return legacy
  })
  return rows
}

function schema(database: Database.Database) {
  return database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all()
}

function insertSnapshot(database: Database.Database, id: string, overrides: Record<string, unknown>) {
  const original = database.prepare('SELECT * FROM automation_revisions WHERE id = ?').get(ids.revision1) as Record<string, unknown>
  const row = { ...original, id, number: null, purpose: 'draft-test', source_draft_version: 7, ...overrides }
  const columns = Object.keys(row)
  database.prepare(`INSERT INTO automation_revisions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(row))
}

describe('Draft test execution snapshot migration', () => {
  it('creates the constrained schema from an empty database and leaves foreign keys enabled', () => {
    const database = new Database(':memory:')
    try {
      database.pragma('foreign_keys = ON')
      expect(runMigrations(database)).toBe(15)
      expect(runMigrations(database)).toBe(0)
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(database.pragma('foreign_key_check')).toEqual([])
      const number = (database.pragma('table_info(automation_revisions)') as Array<{ name: string; notnull: number }>).find(column => column.name === 'number')
      expect(number?.notnull).toBe(0)
      expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 15 })
    } finally { database.close() }
  })

  it('preserves every v14 legacy value, foreign key, index and publication-number gap', () => {
    const database = new Database(':memory:')
    try {
      populateDraftTestV14Fixture(database)
      const before = captureDraftTestV14Rows(database)
      const indexes = database.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' ORDER BY name").all()
      const runForeignKeys = database.pragma('foreign_key_list(runs)')
      const triggerForeignKeys = database.pragma('foreign_key_list(trigger_events)')
      expect(runMigrations(database)).toBe(1)
      expect(legacyRows(database)).toEqual(before)
      expect(database.prepare('SELECT purpose, source_draft_version, base_revision_id FROM automation_revisions').all())
        .toEqual(Array.from({ length: 3 }, () => ({ purpose: 'published', source_draft_version: null, base_revision_id: null })))
      expect(database.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS number FROM automation_revisions WHERE automation_id = ? AND purpose = 'published'").get(ids.automation)).toEqual({ number: 4 })
      expect(database.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' ORDER BY name").all()).toEqual(indexes)
      expect(database.pragma('foreign_key_list(runs)')).toEqual(runForeignKeys)
      expect(database.pragma('foreign_key_list(trigger_events)')).toEqual(triggerForeignKeys)
      expect(database.pragma('foreign_key_check')).toEqual([])
      expect(database.pragma('integrity_check', { simple: true })).toBe('ok')
      const migrated = captureDraftTestV14Rows(database)
      expect(runMigrations(database)).toBe(0)
      expect(captureDraftTestV14Rows(database)).toEqual(migrated)
    } finally { database.close() }
  })

  it('upgrades a v12 history graph without recompilation or rewriting saved content', () => {
    const database = new Database(':memory:')
    try {
      database.pragma('foreign_keys = ON')
      runMigrations(database, coreMigrations.filter(migration => migration.version <= 12))
      database.exec(`
        INSERT INTO automations (id, name, active_revision_id, created_at, updated_at) VALUES ('auto_v12', 'v12', 'rev_v12', 'created', 'updated');
        INSERT INTO automation_drafts (automation_id, source_json, presentation_json, version, base_revision_id, updated_at) VALUES ('auto_v12', '{"unavailablePlugin":true}', '{"old":true}', 8, 'rev_v12', 'updated');
        INSERT INTO automation_revisions (id, automation_id, number, protocol_version, source_json, presentation_json, ir_version, compiled_plan_json, dependency_manifest_json, contract_snapshot_json, content_hash, created_at)
          VALUES ('rev_v12', 'auto_v12', 3, 1, '{"unavailablePlugin":true}', '{"old":true}', 1, '{"fixed":true}', '{}', '{}', 'old-hash', 'created');
        INSERT INTO runs (id, automation_id, revision_id, status, trigger_json, input_json, created_at) VALUES ('run_v12', 'auto_v12', 'rev_v12', 'QUEUED', '{}', '{}', 'created');
      `)
      const revision = database.prepare('SELECT * FROM automation_revisions').get()
      const draft = database.prepare('SELECT * FROM automation_drafts').get()
      const run = database.prepare('SELECT * FROM runs').get()
      expect(runMigrations(database)).toBe(3)
      expect(database.prepare('SELECT * FROM automation_revisions').get()).toEqual({ ...revision as object, purpose: 'published', source_draft_version: null, base_revision_id: null })
      expect(database.prepare('SELECT * FROM automation_drafts').get()).toEqual(draft)
      expect(database.prepare('SELECT * FROM runs').get()).toEqual(run)
      expect(database.pragma('foreign_key_check')).toEqual([])
    } finally { database.close() }
  })

  it('enforces both purpose combinations on inserts and updates while allowing independent NULL numbers', () => {
    const database = new Database(':memory:')
    try {
      populateDraftTestV14Fixture(database)
      runMigrations(database)
      insertSnapshot(database, 'snapshot_first', {})
      insertSnapshot(database, 'snapshot_second', {})
      const invalid = [
        { purpose: 'unknown' }, { purpose: null }, { number: 4 }, { source_draft_version: null },
        { source_draft_version: 0 }, { source_draft_version: 1.5 }, { source_draft_version: 'invalid' },
        { purpose: 'published', number: null }, { purpose: 'published', number: 0 },
        { purpose: 'published', number: -1 }, { purpose: 'published', number: 4.5 },
        { purpose: 'published', number: 'invalid' }, { purpose: 'published', number: 4, source_draft_version: -1 },
      ]
      invalid.forEach((overrides, index) => expect(() => insertSnapshot(database, `invalid_${index}`, overrides)).toThrow())
      expect(() => insertSnapshot(database, 'duplicate_published', { purpose: 'published', number: 3 })).toThrow(/UNIQUE/)
      expect(() => database.prepare('UPDATE automation_revisions SET number = 4 WHERE id = ?').run('snapshot_first')).toThrow(/CHECK/)
      expect(() => database.prepare('UPDATE automation_revisions SET source_draft_version = NULL WHERE id = ?').run('snapshot_first')).toThrow(/CHECK/)
      expect(() => database.prepare('UPDATE automation_revisions SET number = NULL WHERE id = ?').run(ids.revision1)).toThrow(/CHECK/)
      insertSnapshot(database, 'published_4', { purpose: 'published', number: 4, source_draft_version: null })
      expect(database.pragma('foreign_key_check')).toEqual([])
    } finally { database.close() }
  })

  it.each(['first-ddl', 'after-ddl', 'legacy-constraint', 'marker'] as const)('rolls back schema, values and marker after %s failure, then retries cleanly', failure => {
    const database = new Database(':memory:')
    try {
      populateDraftTestV14Fixture(database)
      if (failure === 'legacy-constraint') database.prepare('UPDATE automation_revisions SET number = 0 WHERE id = ?').run(ids.revision1)
      if (failure === 'marker') database.exec("CREATE TRIGGER fail_snapshot_marker BEFORE INSERT ON schema_migrations WHEN NEW.version = 15 BEGIN SELECT RAISE(ABORT, 'marker failure'); END;")
      const before = captureDraftTestV14Rows(database)
      const beforeSchema = schema(database)
      const migration: Migration = { ...snapshotMigration, up(db) {
        if (failure === 'first-ddl') {
          db.exec('ALTER TABLE automation_revisions ALTER COLUMN number DROP NOT NULL')
          throw new Error('injected first DDL failure')
        }
        snapshotMigration.up(db)
        if (failure === 'after-ddl') throw new Error('injected post DDL failure')
      } }
      expect(() => runMigrations(database, [...legacyMigrations, migration])).toThrow()
      expect(captureDraftTestV14Rows(database)).toEqual(before)
      expect(schema(database)).toEqual(beforeSchema)
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(database.pragma('foreign_key_check')).toEqual([])
      if (failure === 'legacy-constraint') database.prepare('UPDATE automation_revisions SET number = 1 WHERE id = ?').run(ids.revision1)
      if (failure === 'marker') database.exec('DROP TRIGGER fail_snapshot_marker')
      expect(runMigrations(database)).toBe(1)
      expect(database.pragma('foreign_key_check')).toEqual([])
    } finally { database.close() }
  })

  it('rejects a newer schema before an older runner can use it, without changing any rows', () => {
    const database = new Database(':memory:')
    try {
      populateDraftTestV14Fixture(database)
      runMigrations(database)
      const before = captureDraftTestV14Rows(database)
      expect(() => runMigrations(database, legacyMigrations)).toThrow('unsupported database schema version 15')
      expect(captureDraftTestV14Rows(database)).toEqual(before)
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
    } finally { database.close() }
  })

  it.each(['3.52.0', '3.9.0'])('refuses unsupported SQLite %s before changing the legacy schema', version => {
    const database = new Database(':memory:')
    try {
      populateDraftTestV14Fixture(database)
      const before = captureDraftTestV14Rows(database)
      const beforeSchema = schema(database)
      const originalPrepare = database.prepare.bind(database)
      const spy = vi.spyOn(database, 'prepare').mockImplementation(sql => {
        if (sql === 'SELECT sqlite_version() AS version') return { get: () => ({ version }) } as Database.Statement
        return originalPrepare(sql)
      })
      try {
        expect(() => runMigrations(database)).toThrow(`requires SQLite 3.53 or later; found ${version}`)
      } finally { spy.mockRestore() }
      expect(captureDraftTestV14Rows(database)).toEqual(before)
      expect(schema(database)).toEqual(beforeSchema)
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(runMigrations(database)).toBe(1)
    } finally { database.close() }
  })
})
