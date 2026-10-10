import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { coreMigrations, runMigrations } from '../src/migrations.js'
import { captureDraftTestV14Rows, populateDraftTestV14Fixture } from './fixtures/draft-test-v14.js'

describe('durable graph member migration', () => {
  it('upgrades populated v15 without rewriting history and enforces member identity and skip facts', () => {
    const db = new Database(':memory:')
    try {
      populateDraftTestV14Fixture(db)
      runMigrations(db, coreMigrations.filter(migration => migration.version <= 15))
      const before = captureDraftTestV14Rows(db)
      expect(runMigrations(db)).toBe(1)
      const after = captureDraftTestV14Rows(db)
      after.schema_migrations = after.schema_migrations!.filter(row => (row as { version: number }).version <= 15)
      expect(after.graph_members).toEqual([])
      delete after.graph_members
      expect(after).toEqual(before)
      const execution = db.prepare('SELECT id FROM executions LIMIT 1').get() as { id: string }
      const insert = db.prepare('INSERT INTO graph_members (scope_execution_id, node_id, execution_id, skipped, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      insert.run(execution.id, 'pending', null, 0, 'created', 'updated')
      insert.run(execution.id, 'skipped', null, 1, 'created', 'updated')
      expect(() => insert.run(execution.id, 'pending', null, 0, 'created', 'updated')).toThrow(/UNIQUE/)
      expect(() => insert.run(execution.id, 'invalid', execution.id, 1, 'created', 'updated')).toThrow(/CHECK/)
      expect(() => insert.run('missing', 'orphan', null, 0, 'created', 'updated')).toThrow(/FOREIGN KEY/)
      insert.run(execution.id, 'running', execution.id, 0, 'created', 'updated')
      expect(() => insert.run(execution.id, 'duplicate-execution', execution.id, 0, 'created', 'updated')).toThrow(/UNIQUE/)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(runMigrations(db)).toBe(0)
      // Deleting the run must not strand member facts or block normal retention cleanup.
      db.prepare('DELETE FROM trigger_events WHERE run_id = (SELECT run_id FROM executions WHERE id = ?)').run(execution.id)
      db.prepare('DELETE FROM runs WHERE id = (SELECT run_id FROM executions WHERE id = ?)').run(execution.id)
      expect(db.prepare('SELECT COUNT(*) AS count FROM graph_members').get()).toEqual({ count: 0 })
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally { db.close() }
  })
})
