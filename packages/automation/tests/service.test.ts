import { CapabilityRegistry, type AutomationSource, type CapabilityDefinition } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationService, AutomationCompileError, DraftConflictError, AutomationActivationConflictError, AutomationArchivedError, AutomationHasActiveRunsError, AutomationNotFoundError, AutomationRevisionNotFoundError } from '../src/index.js'
import { draftTestV14Ids as fixtureIds, populateDraftTestV14Fixture } from '../../database/tests/fixtures/draft-test-v14.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const action: CapabilityDefinition = {
  id: 'test:record',
  version: 1,
  kind: 'action',
  title: 'Record value',
  input: z.object({ value: z.string().required() }),
  output: z.object({}),
  semantics: { sideEffect: true, idempotent: true, retrySafe: true },
}

const source: AutomationSource = {
  triggers: [],
  flow: {
    type: 'block',
    id: 'flow',
    steps: [{
      type: 'capability',
      id: 'record',
      capability: { id: 'test:record', version: 1 },
      input: { value: { type: 'literal', value: 'first' } },
    }],
  },
}

async function createContext(path: string): Promise<Context> {
  const root = new Context()
  await root.plugin(DatabaseService, { path })
  await root.plugin(CapabilityRegistry)
  root.capabilities.define(root, action)
  await root.plugin(AutomationService)
  return root
}

describe('AutomationService', () => {
  it('persists draft, immutable revision, activation, and optimistic conflicts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-automation-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const root = await createContext(databasePath)
    const changes: string[] = []
    root.on('numen/automation-change', automationId => changes.push(automationId))

    const created = root.automations.create({ name: 'Morning note', source })
    expect(created.draft.version).toBe(1)
    const updatedSource = structuredClone(source)
    if (updatedSource.flow.type !== 'block' || updatedSource.flow.steps[0]?.type !== 'capability') throw new Error('invalid fixture')
    updatedSource.flow.steps[0].input.value = { type: 'literal', value: 'updated' }
    const draft = root.automations.saveDraft({
      automationId: created.automation.id,
      expectedVersion: 1,
      source: updatedSource,
    })
    expect(draft.version).toBe(2)
    expect(() => root.automations.saveDraft({
      automationId: created.automation.id,
      expectedVersion: 1,
      source,
    })).toThrow(DraftConflictError)

    const revision = root.automations.publishDraft(created.automation.id, 2)
    expect(revision.number).toBe(1)
    expect(revision.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(revision.compiledPlan.entry).toBe('record')
    root.automations.saveDraft({
      automationId: created.automation.id,
      expectedVersion: 2,
      source: updatedSource,
      presentation: { viewport: 'wide' },
    })
    const presentationRevision = root.automations.publishDraft(created.automation.id, 3)
    expect(presentationRevision).toMatchObject({ number: 2, contentHash: revision.contentHash })
    const activated = root.automations.activateRevision(created.automation.id, presentationRevision.id)
    expect(activated).toMatchObject({ enabled: false, activeRevisionId: presentationRevision.id, activationGeneration: 1 })
    const enabled = root.automations.setEnabled(created.automation.id, true)
    expect(enabled).toMatchObject({ enabled: true, activationGeneration: 2 })
    expect(root.automations.listSummaries()).toEqual([expect.objectContaining({
      id: created.automation.id,
      draftVersion: 3,
      revisionCount: 2,
      latestRevisionNumber: 2,
    })])
    expect(changes).toEqual(Array.from({ length: 7 }, () => created.automation.id))
    await root.fiber.dispose()

    const restarted = await createContext(databasePath)
    expect(restarted.automations.get(created.automation.id)).toMatchObject({
      activeRevisionId: presentationRevision.id,
      activationGeneration: 2,
    })
    expect(restarted.automations.getRevision(revision.id)?.contentHash).toBe(revision.contentHash)
    await restarted.fiber.dispose()
  })
  it('fences both desired-state operations and rejects foreign revisions without changing Drafts or history', async () => {
    const root = await createContext(':memory:')
    try {
      const first = root.automations.create({ name: 'First', source })
      const other = root.automations.create({ name: 'Other', source })
      const revision = root.automations.publishDraft(first.automation.id, 1)
      const foreign = root.automations.publishDraft(other.automation.id, 1)
      const draft = root.automations.getDraft(first.automation.id)
      const changes: string[] = []
      root.on('numen/automation-change', id => changes.push(id))
      expect(() => root.automations.activateRevision(first.automation.id, foreign.id, 0)).toThrow(AutomationRevisionNotFoundError)
      expect(() => root.automations.activateRevision('missing', revision.id, 0)).toThrow(AutomationNotFoundError)
      const activated = root.automations.activateRevision(first.automation.id, revision.id, 0)
      expect(activated).toMatchObject({ activationGeneration: 1, enabled: false, activeRevisionId: revision.id })
      expect(() => root.automations.setEnabled(first.automation.id, true, 0)).toThrow(AutomationActivationConflictError)
      expect(() => root.automations.activateRevision(first.automation.id, revision.id, 0)).toThrow(AutomationActivationConflictError)
      expect(root.automations.activateRevision(first.automation.id, revision.id, 1)).toEqual(activated)
      expect(root.automations.setEnabled(first.automation.id, false, 1)).toEqual(activated)
      expect(changes).toEqual([first.automation.id])
      const enabled = root.automations.setEnabled(first.automation.id, true, 1)
      expect(enabled).toMatchObject({ enabled: true, activationGeneration: 2 })
      expect(() => root.automations.setEnabled(first.automation.id, true, 1)).toThrow(AutomationActivationConflictError)
      const disabled = root.automations.setEnabled(first.automation.id, false, 2)
      expect(disabled).toMatchObject({ enabled: false, activeRevisionId: revision.id, activationGeneration: 3 })
      for (const expected of [-1, 0.5, NaN]) expect(() => root.automations.setEnabled(first.automation.id, true, expected)).toThrow(TypeError)
      expect(root.automations.getDraft(first.automation.id)).toEqual(draft)
      expect(root.automations.getRevision(revision.id)).toEqual(revision)
      expect(root.automations.get(other.automation.id)).toMatchObject({ enabled: false, activationGeneration: 0 })
      expect(changes).toHaveLength(3)
    } finally { await root.fiber.dispose() }
  })

  it('saves broken references as drafts but leaves published history and activation intact', async () => {
    const root = await createContext(':memory:')
    try {
      const created = root.automations.create({ name: 'Reference edits', source })
      const id = created.automation.id
      const revision = root.automations.publishDraft(id, 1)
      root.automations.activateRevision(id, revision.id)
      root.automations.setEnabled(id, true)
      const active = root.automations.get(id)
      const broken = structuredClone(source)
      if (broken.flow.type !== 'block' || broken.flow.steps[0]?.type !== 'capability') throw new Error('fixture')
      broken.flow.steps[0].input.value = { type: 'ref', path: 'steps.deleted.value' }
      const draft = root.automations.saveDraft({ automationId: id, expectedVersion: 1, source: broken })
      expect(draft.source).toEqual(broken)
      const beforePublish = root.automations.get(id)
      expect(beforePublish).toMatchObject({ activeRevisionId: active?.activeRevisionId, enabled: active?.enabled, activationGeneration: active?.activationGeneration })
      expect(() => root.automations.publishDraft(id, draft.version)).toThrow(AutomationCompileError)
      expect(root.automations.get(id)).toEqual(beforePublish)
      expect(root.automations.getRevision(revision.id)).toEqual(revision)
      expect(root.automations.listSummaries()[0]?.revisionCount).toBe(1)
      const fixed = root.automations.saveDraft({ automationId: id, expectedVersion: draft.version, source })
      expect(root.automations.publishDraft(id, fixed.version).number).toBe(2)
    } finally { await root.fiber.dispose() }
  })

  it('keeps fixed saved-Draft snapshots separate from published numbering, activation and change notifications', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-draft-snapshot-'))
    directories.push(directory)
    const path = join(directory, 'numen.db')
    const root = await createContext(path)
    let id = ''
    let snapshotId = ''
    try {
      const created = root.automations.create({ name: 'Fixed Draft', source, presentation: { caption: 'first' } })
      id = created.automation.id
      const published = root.automations.publishDraft(id, 1)
      root.automations.activateRevision(id, published.id)
      root.automations.setEnabled(id, true)
      const before = root.automations.get(id)
      const draft = root.automations.getDraft(id)
      const changes: string[] = []
      root.on('numen/automation-change', value => changes.push(value))
      const prepared = root.automations.prepareDraftTestSnapshot(id, 1)
      expect(root.database.db.prepare('SELECT COUNT(*) AS count FROM automation_revisions').get()).toEqual({ count: 1 })
      const snapshot = root.automations.createDraftTestSnapshot(prepared)
      snapshotId = snapshot.id
      expect(snapshot).toMatchObject({ purpose: 'draft-test', sourceDraftVersion: 1, baseRevisionId: published.id, contentHash: published.contentHash, presentation: { caption: 'first' } })
      expect(snapshot).not.toHaveProperty('number')
      expect(root.automations.getRevision(snapshot.id)).toBeUndefined()
      expect(root.automations.getExecutionSnapshot(published.id)).toEqual(published)
      expect(root.automations.listRevisions(id)).toEqual([published])
      expect(root.automations.listSummaries()[0]).toMatchObject({ revisionCount: 1, latestRevisionNumber: 1 })
      expect(() => root.automations.activateRevision(id, snapshot.id)).toThrow(AutomationRevisionNotFoundError)
      expect(root.automations.get(id)).toEqual(before)
      expect(root.automations.getDraft(id)).toEqual(draft)
      expect(changes).toEqual([])
      const next = root.automations.saveDraft({ automationId: id, expectedVersion: 1, source: { triggers: [], flow: { type: 'block', id: 'changed', steps: [] } }, presentation: { caption: 'edited' } })
      expect(root.automations.getExecutionSnapshot(snapshot.id)).toEqual(snapshot)
      const publishedNext = root.automations.publishDraft(id, next.version)
      expect(publishedNext).toMatchObject({ purpose: 'published', number: 2, sourceDraftVersion: 2, baseRevisionId: published.id })
      expect(root.automations.getExecutionSnapshot(snapshot.id)).toEqual(snapshot)
    } finally { await root.fiber.dispose() }
    const restarted = await createContext(path)
    try {
      expect(restarted.automations.getExecutionSnapshot(snapshotId)).toMatchObject({ purpose: 'draft-test', sourceDraftVersion: 1, presentation: { caption: 'first' } })
      expect(restarted.automations.listRevisions(id).map(revision => revision.number)).toEqual([2, 1])
    } finally { await restarted.fiber.dispose() }
  })

  it('counts an Automation with only independent test snapshots as never published', async () => {
    const root = await createContext(':memory:')
    try {
      const { automation } = root.automations.create({ name: 'No publications', source })
      const prepared = root.automations.prepareDraftTestSnapshot(automation.id, 1)
      const first = root.automations.createDraftTestSnapshot(prepared)
      const second = root.automations.createDraftTestSnapshot(prepared)
      expect(second.id).not.toBe(first.id)
      expect(second.contentHash).toBe(first.contentHash)
      expect(root.automations.listSummaries()).toEqual([expect.objectContaining({ id: automation.id, revisionCount: 0, runCount: 0 })])
      expect(root.automations.listSummaries()[0]).not.toHaveProperty('latestRevisionNumber')
      expect(root.automations.listRevisions(automation.id)).toEqual([])
      expect(root.automations.publishDraft(automation.id, 1).number).toBe(1)
    } finally { await root.fiber.dispose() }
  })

  it('rejects stale versions, compilation failure, and archival both before preparation and before insertion', async () => {
    const root = await createContext(':memory:')
    try {
      const { automation } = root.automations.create({ name: 'Fenced Draft', source })
      for (const version of [0, -1, 1.5, NaN]) expect(() => root.automations.prepareDraftTestSnapshot(automation.id, version)).toThrow(TypeError)
      expect(() => root.automations.prepareDraftTestSnapshot('missing', 1)).toThrow(AutomationNotFoundError)
      expect(() => root.automations.prepareDraftTestSnapshot(automation.id, 2)).toThrow(DraftConflictError)
      const prepared = root.automations.prepareDraftTestSnapshot(automation.id, 1)
      root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source })
      expect(() => root.automations.createDraftTestSnapshot(prepared)).toThrow(DraftConflictError)
      const latest = root.automations.prepareDraftTestSnapshot(automation.id, 2)
      const archived = root.automations.archive(automation.id)
      expect(() => root.automations.createDraftTestSnapshot(latest)).toThrow(AutomationArchivedError)
      expect(() => root.automations.prepareDraftTestSnapshot(automation.id, 2)).toThrow(AutomationArchivedError)
      root.automations.restoreArchive(automation.id, archived.activationGeneration)
      const broken = structuredClone(source)
      if (broken.flow.type !== 'block' || broken.flow.steps[0]?.type !== 'capability') throw new Error('fixture')
      broken.flow.steps[0].input.value = { type: 'ref', path: 'steps.missing.value' }
      root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: broken })
      expect(() => root.automations.prepareDraftTestSnapshot(automation.id, 3)).toThrow(AutomationCompileError)
      expect(root.database.db.prepare('SELECT COUNT(*) AS count FROM automation_revisions').get()).toEqual({ count: 0 })
    } finally { await root.fiber.dispose() }
  })

  it('rolls snapshot insertion back when the surrounding acceptance transaction fails', async () => {
    const root = await createContext(':memory:')
    try {
      const { automation } = root.automations.create({ name: 'Atomic acceptance', source })
      const prepared = root.automations.prepareDraftTestSnapshot(automation.id, 1)
      expect(() => root.database.transaction(() => {
        root.automations.createDraftTestSnapshot(prepared)
        throw new Error('acceptance failed after snapshot')
      })).toThrow('acceptance failed after snapshot')
      expect(root.database.db.prepare('SELECT COUNT(*) AS count FROM automation_revisions').get()).toEqual({ count: 0 })
      expect(root.automations.getDraft(automation.id)?.baseRevisionId).toBeUndefined()
    } finally { await root.fiber.dispose() }
  })

  it('retains archived history until explicit removal and then releases only its execution, run and snapshot owners', async () => {
    const root = await createContext(':memory:')
    try {
      const ids = fixtureIds
      const db = root.database.db
      populateDraftTestV14Fixture(db, false)
      db.prepare(`
        INSERT INTO automation_revisions (
          id, automation_id, number, protocol_version, source_json, presentation_json,
          ir_version, compiled_plan_json, dependency_manifest_json, contract_snapshot_json,
          content_hash, created_at, purpose, source_draft_version, base_revision_id
        ) SELECT 'snap_fixture', automation_id, NULL, protocol_version, source_json, presentation_json,
          ir_version, compiled_plan_json, dependency_manifest_json, contract_snapshot_json,
          content_hash, created_at, 'draft-test', 7, ?
          FROM automation_revisions WHERE id = ?
      `).run(ids.revision3, ids.revision1)
      db.prepare('UPDATE runs SET revision_id = ? WHERE id = ?').run('snap_fixture', ids.completedRun)
      const owner = db.prepare('INSERT INTO resource_owners (resource_id, owner_type, owner_id, created_at) VALUES (?, ?, ?, ?)')
      for (const resourceId of [ids.outputResource, ids.sharedResource]) {
        owner.run(resourceId, 'snapshot', 'snap_fixture', 'created')
        owner.run(resourceId, 'run', ids.completedRun, 'created')
      }
      owner.run(ids.sharedResource, 'snapshot', ids.archivedRevision, 'created')
      db.prepare(`INSERT INTO resources (id, name, media_type, size, digest, store_id, state, created_at, updated_at)
        SELECT 'res_run_only', name, media_type, size, digest, store_id, state, created_at, updated_at FROM resources WHERE id = ?`).run(ids.outputResource)
      owner.run('res_run_only', 'run', ids.triggeredRun, 'created')
      db.prepare(`INSERT INTO resources (id, name, media_type, size, digest, store_id, state, created_at, updated_at)
        SELECT 'res_snapshot_only', name, media_type, size, digest, store_id, state, created_at, updated_at FROM resources WHERE id = ?`).run(ids.outputResource)
      owner.run('res_snapshot_only', 'snapshot', 'snap_fixture', 'created')
      const archived = root.automations.archive(ids.automation)
      expect(root.automations.getExecutionSnapshot('snap_fixture')?.purpose).toBe('draft-test')
      expect(db.prepare('SELECT COUNT(*) AS count FROM runs WHERE automation_id = ?').get(ids.automation)).toEqual({ count: 3 })
      const ownersBefore = db.prepare('SELECT * FROM resource_owners ORDER BY resource_id, owner_type, owner_id').all()
      expect(() => root.automations.removeArchived(ids.automation, archived.archivedAt!)).toThrow(AutomationHasActiveRunsError)
      expect(db.prepare('SELECT * FROM resource_owners ORDER BY resource_id, owner_type, owner_id').all()).toEqual(ownersBefore)
      db.prepare("UPDATE executions SET status = 'COMPLETED' WHERE run_id = ?").run(ids.waitingRun)
      db.prepare("UPDATE runs SET status = 'COMPLETED' WHERE id = ?").run(ids.waitingRun)
      const resourcesBefore = db.prepare('SELECT * FROM resources ORDER BY id').all()
      db.exec(`CREATE TRIGGER fail_run_removal BEFORE DELETE ON runs WHEN OLD.automation_id = '${ids.automation}' BEGIN SELECT RAISE(ABORT, 'injected run removal failure'); END;`)
      expect(() => root.automations.removeArchived(ids.automation, archived.archivedAt!)).toThrow('injected run removal failure')
      expect(db.prepare('SELECT * FROM resource_owners ORDER BY resource_id, owner_type, owner_id').all()).toEqual(ownersBefore)
      expect(db.prepare('SELECT * FROM resources ORDER BY id').all()).toEqual(resourcesBefore)
      expect(root.automations.getExecutionSnapshot('snap_fixture')?.purpose).toBe('draft-test')
      expect(db.prepare('SELECT COUNT(*) AS count FROM execution_iterations').get()).toEqual({ count: 1 })
      db.exec('DROP TRIGGER fail_run_removal')
      expect(root.automations.removeArchived(ids.automation, archived.archivedAt!)).toEqual({ automationId: ids.automation, runCount: 3 })
      expect(root.automations.get(ids.automation)).toBeUndefined()
      expect(root.automations.getExecutionSnapshot('snap_fixture')).toBeUndefined()
      expect(root.automations.getRevision(ids.archivedRevision)).toBeDefined()
      for (const table of ['runs', 'executions', 'execution_iterations', 'attempts', 'run_events', 'trigger_events', 'manual_run_requests']) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
      }
      expect(db.prepare("SELECT owner_type, owner_id FROM resource_owners WHERE resource_id = ? ORDER BY owner_type, owner_id").all(ids.sharedResource)).toEqual([
        { owner_type: 'automation', owner_id: ids.archivedAutomation },
        { owner_type: 'automation', owner_id: ids.automation },
        { owner_type: 'snapshot', owner_id: ids.archivedRevision },
      ])
      expect(db.prepare('SELECT gc_after FROM resources WHERE id = ?').get(ids.sharedResource)).toEqual({ gc_after: null })
      for (const resourceId of [ids.outputResource, 'res_run_only', 'res_snapshot_only']) {
        expect(db.prepare('SELECT COUNT(*) AS count FROM resource_owners WHERE resource_id = ?').get(resourceId)).toEqual({ count: 0 })
        expect(db.prepare('SELECT state, gc_after FROM resources WHERE id = ?').get(resourceId)).toEqual({ state: 'COMMITTED', gc_after: expect.any(String) })
      }
      expect(db.prepare('SELECT COUNT(*) AS count FROM resource_leases').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM automation_draft_copy_requests').get()).toEqual({ count: 1 })
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally { await root.fiber.dispose() }
  })

})
