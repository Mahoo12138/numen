import Server from '@cordisjs/plugin-server'
import { AutomationDraftInspectionLimitError, AutomationService, DraftConflictError } from '@numenjs/automation'
import { ConsoleAuthenticationError, ConsoleService, consoleHttpPlugin, type ConsoleRequestContext } from '@numenjs/console'
import { CapabilityRegistry, type AutomationSource } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { Context, type Logger } from 'cordis'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workbenchAutomationComparisonProviderPlugin, workbenchAutomationComparisonQuery, workbenchAutomationComparisonStateQuery } from '../src/automation-comparison-provider.js'
import type { WorkbenchAutomationComparisonTarget } from '../src/contracts.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const request = (authenticated = true): ConsoleRequestContext => ({ requestId: 'semantic-comparison', principal: { subject: { type: 'user', id: 'owner' }, authenticated }, signal: new AbortController().signal, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger })
const empty: AutomationSource = { triggers: [], flow: { type: 'block', id: 'empty', steps: [] } }
const snapshot = (snapshotId: string): WorkbenchAutomationComparisonTarget => ({ kind: 'snapshot', snapshotId })
const draft = (version: number): WorkbenchAutomationComparisonTarget => ({ kind: 'draft', version })

async function fixture() {
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  await root.plugin(DatabaseService, { path: ':memory:' })
  await root.plugin(CapabilityRegistry)
  const unload = root.capabilities.define(root, { id: 'test:comparison', version: 1, kind: 'action', title: 'Historical action', input: z.object({ value: z.string().required() }), output: z.object({}), semantics: { sideEffect: false, idempotent: true, retrySafe: true } })
  await root.plugin(AutomationService)
  await root.plugin(ConsoleService)
  root.console.define(root, workbenchAutomationComparisonQuery)
  root.console.define(root, workbenchAutomationComparisonStateQuery)
  workbenchAutomationComparisonProviderPlugin(root)
  const source: AutomationSource = { triggers: [], flow: { type: 'capability', id: 'step', capability: { id: 'test:comparison', version: 1 }, input: { value: { type: 'literal', value: 'BEFORE_PRIVATE_CANARY' } } } }
  const { automation } = root.automations.create({ name: 'Comparison workspace', source, presentation: { label: 'BEFORE_PRESENTATION_CANARY' } })
  const first = root.automations.publishDraft(automation.id, 1)
  const changed = structuredClone(source)
  if (changed.flow.type !== 'capability') throw new Error('fixture')
  changed.flow.input.value = { type: 'literal', value: 'AFTER_PRIVATE_CANARY' }
  root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: changed, presentation: { label: 'AFTER_PRESENTATION_CANARY' } })
  const second = root.automations.publishDraft(automation.id, 2)
  const test = root.automations.createDraftTestSnapshot(root.automations.prepareDraftTestSnapshot(automation.id, 2))
  const compare = (left = snapshot(first.id), right = snapshot(second.id), context = request(), automationId = automation.id) => root.console.query(workbenchAutomationComparisonQuery, { automationId, left, right }, context)
  const state = (context = request(), automationId = automation.id) => root.console.query(workbenchAutomationComparisonStateQuery, { automationId }, context)
  return { root, automation, first, second, test, source, changed, compare, state, unload }
}

describe('Fixed Automation semantic comparison provider', () => {
  it('compares raw hidden values while returning only opaque changes and fixed identities, after archive and definition unload, without writes', async () => {
    const { root, automation, first, second, test, compare, unload } = await fixture()
    root.automations.activateRevision(automation.id, first.id)
    root.automations.setEnabled(automation.id, true)
    root.automations.archive(automation.id)
    unload()
    const changes = vi.fn(), registry = vi.spyOn(root.capabilities, 'get')
    root.on('numen/automation-change', changes)
    const writes = root.database.db.prepare('SELECT total_changes() AS count').get()
    const before = { automation: root.automations.get(automation.id), draft: root.automations.getDraft(automation.id), snapshots: root.database.db.prepare('SELECT * FROM automation_revisions ORDER BY id').all() }
    try {
      const context = request()
      const result = await compare(snapshot(first.id), snapshot(second.id), context)
      expect(result).toMatchObject({ automationId: automation.id, left: { kind: 'snapshot', snapshotId: first.id, purpose: 'published', number: 1 }, right: { kind: 'snapshot', snapshotId: second.id, purpose: 'published', number: 2 }, changes: expect.arrayContaining([
        expect.objectContaining({ category: 'parameters', kind: 'changed', nodeId: 'step' }), expect.objectContaining({ category: 'presentation', kind: 'changed' }),
      ]) })
      expect(JSON.stringify(result)).not.toContain('CANARY')
      const same = await compare(snapshot(second.id), snapshot(test.id))
      expect(same.changes).toEqual([])
      expect(same.right).toMatchObject({ kind: 'snapshot', purpose: 'draft-test', sourceDraftVersion: 2 })
      expect(same.right).not.toHaveProperty('number')
      expect((await compare(draft(2), snapshot(first.id))).left).toMatchObject({ kind: 'draft', version: 2 })
      expect((await compare(snapshot(first.id), draft(2))).right).toMatchObject({ kind: 'draft', version: 2 })
      expect(registry).not.toHaveBeenCalled(); expect(changes).not.toHaveBeenCalled()
      expect(root.database.db.prepare('SELECT total_changes() AS count').get()).toEqual(writes)
      expect({ automation: root.automations.get(automation.id), draft: root.automations.getDraft(automation.id), snapshots: root.database.db.prepare('SELECT * FROM automation_revisions ORDER BY id').all() }).toEqual(before)
      for (const method of ['info', 'warn', 'error', 'debug'] as const) expect(context.logger[method]).not.toHaveBeenCalled()
    } finally { registry.mockRestore() }
  })

  it('checks authentication, abort, valid target identities and foreign Automation membership before document decoding', async () => {
    const { root, first, second, compare, state } = await fixture()
    const other = root.automations.create({ name: 'Other', source: empty })
    const read = vi.spyOn(root.automations, 'getExecutionSnapshot')
    const draftRead = vi.spyOn(root.automations, 'getDraftForInspection')
    try {
      await expect(compare(snapshot(first.id), snapshot(second.id), request(false))).rejects.toMatchObject({ status: 401 })
      await expect(state(request(false))).rejects.toMatchObject({ status: 401 })
      const aborted = request(), abort = new AbortController()
      abort.abort(); aborted.signal = abort.signal
      await expect(compare(snapshot(first.id), snapshot(second.id), aborted)).rejects.toThrow()
      await expect(compare(draft(2), draft(2))).rejects.toMatchObject({ status: 422, code: 'AUTOMATION_COMPARISON_TARGETS_INVALID' })
      expect(draftRead).not.toHaveBeenCalled()
      for (const invalid of [draft(0), draft(1.5), draft(Number.MAX_SAFE_INTEGER + 1), snapshot('rev_INVALID_PRIVATE_CANARY')]) await expect(compare(invalid)).rejects.toThrow()
      root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run('CORRUPT_FOREIGN_CANARY', first.id)
      await expect(compare(snapshot(first.id), draft(1), request(), other.automation.id)).rejects.toMatchObject({ status: 404, code: 'AUTOMATION_COMPARISON_NOT_FOUND' })
      await expect(compare(snapshot(`rev_${'0'.repeat(32)}`))).rejects.toMatchObject({ status: 404 })
      expect(read).not.toHaveBeenCalled()
    } finally { read.mockRestore(); draftRead.mockRestore() }
  })

  it('rejects a changed saved Draft version before parsing its content and requires an explicit fresh version', async () => {
    const { root, automation, source, first, compare } = await fixture()
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source })
    root.database.db.prepare('UPDATE automation_drafts SET source_json = ? WHERE automation_id = ?').run('CORRUPT_CURRENT_DRAFT_CANARY', automation.id)
    expect(() => root.automations.getDraftForInspection(automation.id, 2)).toThrow(DraftConflictError)
    const stale = await compare(snapshot(first.id), draft(2)).catch(error => error)
    expect(stale).toMatchObject({ status: 409, code: 'AUTOMATION_COMPARISON_STALE' })
    expect(stale.details).toBeUndefined(); expect(JSON.stringify(stale)).not.toContain('CANARY')
    await expect(compare(snapshot(first.id), draft(3))).rejects.toMatchObject({ status: 409, code: 'AUTOMATION_COMPARISON_UNAVAILABLE' })
    root.database.db.prepare('UPDATE automation_drafts SET source_json = ? WHERE automation_id = ?').run(JSON.stringify(source), automation.id)
    expect((await compare(snapshot(first.id), draft(3))).right).toMatchObject({ kind: 'draft', version: 3 })
  })

  it('bounds Draft and snapshot persisted UTF-8 data before JSON parsing, including stale oversized Drafts', async () => {
    const { root, automation, first, second, compare } = await fixture()
    const oversized = JSON.stringify({ value: '🙂'.repeat(2_100_000) })
    expect(oversized.length).toBeLessThan(8 * 1024 * 1024)
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(8 * 1024 * 1024)
    root.database.db.prepare('UPDATE automation_drafts SET source_json = ? WHERE automation_id = ?').run(oversized, automation.id)
    expect(() => root.automations.getDraftForInspection(automation.id, 2)).toThrow(AutomationDraftInspectionLimitError)
    await expect(compare(snapshot(first.id), draft(2))).rejects.toMatchObject({ status: 413, code: 'AUTOMATION_COMPARISON_LIMIT' })
    await expect(compare(snapshot(first.id), draft(1))).rejects.toMatchObject({ status: 409, code: 'AUTOMATION_COMPARISON_STALE' })
    const read = vi.spyOn(root.automations, 'getExecutionSnapshot')
    try {
      root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run(oversized, first.id)
      await expect(compare(snapshot(first.id), snapshot(second.id))).rejects.toMatchObject({ status: 413, code: 'AUTOMATION_COMPARISON_LIMIT' })
      expect(read).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
    for (const limit of [0, -1, Infinity, 1.5]) expect(() => root.automations.getDraftForInspection(automation.id, 2, limit)).toThrow(TypeError)
  })

  it('reads bounded staleness and Revision selection metadata without parsing corrupt or oversized document JSON', async () => {
    const { root, automation, first, second, state } = await fixture()
    for (let number = 3; number <= 102; number++) root.database.db.prepare(`
      INSERT INTO automation_revisions (id, automation_id, number, protocol_version, source_json, presentation_json,
        ir_version, compiled_plan_json, dependency_manifest_json, contract_snapshot_json, content_hash, created_at, purpose, source_draft_version)
      SELECT ?, automation_id, ?, protocol_version, source_json, presentation_json, ir_version, compiled_plan_json,
        dependency_manifest_json, contract_snapshot_json, content_hash, created_at, purpose, source_draft_version
      FROM automation_revisions WHERE id = ?
    `).run(`rev_${number.toString(16).padStart(32, '0')}`, number, first.id)
    root.database.db.prepare('UPDATE automation_drafts SET source_json = ?, presentation_json = ? WHERE automation_id = ?').run('CORRUPT_DRAFT_CANARY', 'OVERSIZED_PRESENTATION_CANARY'.repeat(400_000), automation.id)
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ?, compiled_plan_json = ? WHERE automation_id = ?').run('CORRUPT_REVISION_CANARY', 'CORRUPT_IR_CANARY', automation.id)
    const draftRead = vi.spyOn(root.automations, 'getDraft'), snapshotRead = vi.spyOn(root.automations, 'getExecutionSnapshot'), revisionRead = vi.spyOn(root.automations, 'listRevisions')
    const writes = root.database.db.prepare('SELECT total_changes() AS count').get()
    try {
      const metadata = await state()
      expect(metadata).toMatchObject({ automationId: automation.id, automationName: 'Comparison workspace', draftVersion: 2, revisionsTruncated: true })
      expect(metadata.revisions).toHaveLength(100)
      expect(metadata.revisions.map(revision => revision.number)).toEqual(Array.from({ length: 100 }, (_, index) => 102 - index))
      expect(metadata.revisions.some(revision => revision.id === second.id)).toBe(false)
      expect(JSON.stringify(metadata)).not.toContain('CANARY')
      expect(draftRead).not.toHaveBeenCalled(); expect(snapshotRead).not.toHaveBeenCalled(); expect(revisionRead).not.toHaveBeenCalled()
      expect(root.database.db.prepare('SELECT total_changes() AS count').get()).toEqual(writes)
      await expect(state(request(), `auto_${'0'.repeat(32)}`)).rejects.toMatchObject({ status: 404 })
    } finally { draftRead.mockRestore(); snapshotRead.mockRestore(); revisionRead.mockRestore() }
  })

  it('returns fixed safe errors for unsupported protocols, malformed persisted JSON and overlarge output metadata', async () => {
    const { root, automation, first, compare, state } = await fixture()
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = 99, source_json = ? WHERE id = ?').run(JSON.stringify('FUTURE_SOURCE_CANARY'), first.id)
    const unsupported = await compare().catch(error => error)
    expect(unsupported).toMatchObject({ status: 409, code: 'AUTOMATION_COMPARISON_UNAVAILABLE' })
    expect(unsupported.details).toBeUndefined(); expect(JSON.stringify(unsupported)).not.toContain('CANARY')
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run('CORRUPT_PRIVATE_CANARY', first.id)
    const context = request(), failure = await compare(snapshot(first.id), draft(2), context).catch(error => error)
    expect(failure).toMatchObject({ status: 409, code: 'AUTOMATION_COMPARISON_UNAVAILABLE' })
    expect(failure.details).toBeUndefined(); expect(JSON.stringify(failure)).not.toContain('CANARY')
    for (const method of ['info', 'warn', 'error', 'debug'] as const) expect(context.logger[method]).not.toHaveBeenCalled()
    root.database.db.prepare('UPDATE automations SET name = ? WHERE id = ?').run('🙂'.repeat(40_000), automation.id)
    await expect(state()).rejects.toMatchObject({ status: 413, code: 'AUTOMATION_COMPARISON_LIMIT' })
  })

  it('serves authenticated POST-only no-store comparison and metadata over real HTTP without private values in success or errors', async () => {
    const { root, automation, first, second } = await fixture()
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    root.console.provideAuthenticator(root, { authenticate({ headers }) {
      if (headers.get('authorization') !== 'Bearer fixture-token') throw new ConsoleAuthenticationError('Authentication required')
      return { principal: { subject: { type: 'user', id: 'owner' }, authenticated: true } }
    } })
    await root.plugin(consoleHttpPlugin)
    const url = `${root.server.baseUrl}/api/console/call`
    const post = (procedure = 'numen:automation-comparison@1', authenticated = false) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer fixture-token' } : {}) }, body: JSON.stringify({ kind: 'query', procedure, input: { automationId: automation.id, ...(procedure === 'numen:automation-comparison@1' ? { left: snapshot(first.id), right: snapshot(second.id) } : {}) } }) })
    const denied = await post()
    expect(denied.status).toBe(401); expect(denied.headers.get('cache-control')).toBe('no-store')
    for (const procedure of ['numen:automation-comparison@1', 'numen:automation-comparison-state@1']) {
      const allowed = await post(procedure, true)
      expect(allowed.status).toBe(200); expect(allowed.headers.get('cache-control')).toBe('no-store')
      expect(await allowed.text()).not.toContain('CANARY')
    }
    expect((await fetch(url)).status).toBe(405)
    root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run('HTTP_CORRUPT_PRIVATE_CANARY', first.id)
    const corrupt = await post('numen:automation-comparison@1', true)
    expect(corrupt.status).toBe(409); expect(corrupt.headers.get('cache-control')).toBe('no-store')
    expect(await corrupt.json()).toMatchObject({ error: { code: 'AUTOMATION_COMPARISON_UNAVAILABLE', message: 'The Automation documents could not be compared.' } })
  })
})
