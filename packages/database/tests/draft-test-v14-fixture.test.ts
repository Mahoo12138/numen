import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coreMigrations, runMigrations } from '../src/migrations.js'
import { captureDraftTestV14Rows, draftTestV14Ids as ids, populateDraftTestV14Fixture } from './fixtures/draft-test-v14.js'

describe('Draft test migration legacy v14 fixture (no target migration)', () => {
  it('contains stable published history, a waiting iteration, request recovery and shared resource owners', () => {
    const database = new Database(':memory:')
    try {
      populateDraftTestV14Fixture(database)
      expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 14 })
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(database.pragma('foreign_key_check')).toEqual([])
      expect(database.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(database.prepare('SELECT number FROM automation_revisions WHERE automation_id = ? ORDER BY number').pluck().all(ids.automation)).toEqual([1, 3])
      expect(database.prepare('SELECT base_revision_id, version FROM automation_drafts WHERE automation_id = ?').get(ids.automation)).toEqual({ base_revision_id: ids.revision3, version: 7 })
      expect(database.prepare(`SELECT run.status AS run_status, execution.status AS execution_status,
        iteration.status AS iteration_status FROM execution_iterations iteration
        JOIN executions execution ON execution.id = iteration.root_execution_id
        JOIN runs run ON run.id = execution.run_id`).get()).toEqual({ run_status: 'RUNNING', execution_status: 'WAITING', iteration_status: 'RUNNING' })
      expect(database.prepare(`SELECT COUNT(*) AS count FROM resource_owners WHERE resource_id = ?`).get(ids.sharedResource)).toEqual({ count: 2 })
      expect(database.prepare(`SELECT run.revision_id FROM manual_run_requests request JOIN runs run ON run.id = request.run_id`).get()).toEqual({ revision_id: ids.revision1 })
      expect(database.prepare(`SELECT revision_id, run_id FROM trigger_events`).get()).toEqual({ revision_id: ids.revision3, run_id: ids.triggeredRun })
      expect(database.prepare(`SELECT status, number FROM attempts`).get()).toEqual({ status: 'SUCCEEDED', number: 1 })
      expect(database.prepare(`SELECT COUNT(*) AS count FROM run_events`).get()).toEqual({ count: 8 })
      const before = captureDraftTestV14Rows(database)
      expect(runMigrations(database, coreMigrations.filter(migration => migration.version <= 14))).toBe(0)
      expect(captureDraftTestV14Rows(database)).toEqual(before)
    } finally { database.close() }
  })

  it('preserves every row across WAL backup and reopening an isolated file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-draft-test-v14-fixture-'))
    const path = join(directory, 'legacy.db')
    const backupPath = join(directory, 'backup.db')
    const database = new Database(path)
    let reopened: Database.Database | undefined
    let backup: Database.Database | undefined
    try {
      database.pragma('journal_mode = WAL')
      populateDraftTestV14Fixture(database)
      const before = captureDraftTestV14Rows(database)
      await database.backup(backupPath)
      database.close()
      reopened = new Database(path)
      reopened.pragma('foreign_keys = ON')
      backup = new Database(backupPath, { readonly: true })
      expect(captureDraftTestV14Rows(reopened)).toEqual(before)
      expect(captureDraftTestV14Rows(backup)).toEqual(before)
      expect(reopened.pragma('foreign_key_check')).toEqual([])
      expect(backup.pragma('foreign_key_check')).toEqual([])
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      if (database.open) database.close()
      reopened?.close()
      backup?.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
