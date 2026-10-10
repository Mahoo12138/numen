import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { coreMigrations, runMigrations } from '../src/migrations.js'
import { captureDraftTestV14Rows, populateDraftTestV14Fixture } from './fixtures/draft-test-v14.js'

describe('output sample and local test migration', () => {
  it('preserves populated v16 history, guards formal snapshots, and rejects downgrade without changing data', () => {
    const db = new Database(':memory:')
    try {
      populateDraftTestV14Fixture(db)
      runMigrations(db, coreMigrations.filter(migration => migration.version <= 16))
      const before = captureDraftTestV14Rows(db)
      expect(runMigrations(db)).toBe(1)
      const after = captureDraftTestV14Rows(db)
      expect(after.automation_output_samples).toEqual([])
      delete after.automation_output_samples
      after.schema_migrations = after.schema_migrations!.filter(row => (row as { version: number }).version <= 16)
      for (const row of after.automation_revisions as Record<string, unknown>[]) { expect(row.local_test_json).toBeNull(); delete row.local_test_json }
      for (const row of after.executions as Record<string, unknown>[]) { expect(row.sample_id).toBeNull(); delete row.sample_id }
      expect(after).toEqual(before)
      expect(() => db.prepare("UPDATE automation_revisions SET local_test_json = '{}' WHERE purpose = 'published'").run()).toThrow(/CHECK/)
      expect(() => db.prepare("INSERT INTO automation_output_samples VALUES ('sample', 'missing', 'node', '{}', 'now')").run()).toThrow(/FOREIGN KEY/)
      const unchanged = captureDraftTestV14Rows(db)
      expect(() => runMigrations(db, coreMigrations.filter(migration => migration.version <= 16))).toThrow('unsupported database schema version 17')
      expect(captureDraftTestV14Rows(db)).toEqual(unchanged)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(runMigrations(db)).toBe(0)
    } finally { db.close() }
  })
})
