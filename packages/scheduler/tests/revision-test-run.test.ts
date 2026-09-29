import { AutomationRevisionNotFoundError, AutomationService } from '@numenjs/automation'
import { AutomationInputValidationError, CapabilityRegistry, type AutomationSource } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { ManualRunRequestConflictError, SchedulerService } from '../src/index.js'

async function context(directory: string) {
  const root = new Context()
  await root.plugin(DatabaseService, { path: join(directory, 'db') })
  await root.plugin(CapabilityRegistry)
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  return root
}
const empty: AutomationSource = { inputs: { message: { type: 'string', required: true } }, triggers: [], flow: { type: 'block', id: 'flow', steps: [] } }

describe('published Revision test Runs', () => {
  it('executes an inactive published contract and explicit trigger data without changing activation or subscription generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-revision-test-'))
    const root = await context(directory)
    try {
      const definition = { id: 'test:effect', version: 1, kind: 'action' as const, title: 'Effect', input: z.object({ message: z.string().required(), event: z.string().required() }), output: z.object({}), semantics: { sideEffect: true, idempotent: false, retrySafe: false } }
      root.capabilities.define(root, definition)
      const calls: unknown[] = []
      root.capabilities.provide(root, definition, { async invoke({ input }) { calls.push(input); return {} } })
      const source: AutomationSource = { ...empty, inputs: { message: { type: 'string', default: 'published default' } }, flow: { type: 'capability', id: 'effect', capability: definition, input: { message: { type: 'ref', path: 'input.message' }, event: { type: 'ref', path: 'trigger.event' } } } }
      const { automation } = root.automations.create({ name: 'Inactive test', source })
      const first = root.automations.publishDraft(automation.id, 1)
      root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: { ...source, inputs: { message: { type: 'string', default: 'different default' } } } })
      const second = root.automations.publishDraft(automation.id, 2)
      const before = root.automations.get(automation.id)
      let activationChanges = 0
      root.on('numen/automation-change', () => { activationChanges++ })
      const run = root.scheduler.startRevisionTest(automation.id, first.id, {}, { event: 'explicit event' }, 'revision-test-inactive-0001')
      expect(run).toMatchObject({ revisionId: first.id, input: { message: 'published default' }, trigger: { event: 'explicit event' } })
      await root.scheduler.dispatchUntilIdle()
      expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
      expect(calls).toEqual([{ message: 'published default', event: 'explicit event' }])
      expect(root.automations.get(automation.id)).toEqual(before)
      expect(activationChanges).toBe(0)
      expect(root.scheduler.listRunEventsPage(run.id).items.find(event => event.type === 'RunAccepted')).toMatchObject({ type: 'RunAccepted', payload: { source: 'revision-test', revisionId: first.id, requestId: 'revision-test-inactive-0001' } })
      root.automations.activateRevision(automation.id, second.id)
      const activeBefore = root.automations.get(automation.id)
      root.scheduler.startRevisionTest(automation.id, first.id, {}, { event: 'second event' }, 'revision-test-inactive-0002')
      expect(root.automations.get(automation.id)).toEqual(activeBefore)
    } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects foreign revisions and invalid inputs atomically and keeps request IDs scoped to complete launch content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-revision-validation-'))
    const root = await context(directory)
    try {
      const a = root.automations.create({ name: 'A', source: empty }).automation
      const b = root.automations.create({ name: 'B', source: empty }).automation
      const revision = root.automations.publishDraft(a.id, 1), foreign = root.automations.publishDraft(b.id, 1)
      expect(() => root.scheduler.startRevisionTest(a.id, foreign.id, { message: 'ok' }, {}, 'revision-test-foreign-01')).toThrow(AutomationRevisionNotFoundError)
      expect(() => root.scheduler.startRevisionTest(a.id, revision.id, {}, {}, 'revision-test-invalid-01')).toThrow(AutomationInputValidationError)
      expect(root.scheduler.listRuns()).toEqual([])
      expect(root.database.db.prepare('SELECT * FROM manual_run_requests').all()).toEqual([])
      const requestId = 'revision-test-conflict-01'
      const accepted = root.scheduler.startRevisionTest(a.id, revision.id, { message: 'ok' }, { event: 'A' }, requestId)
      for (const [input, trigger] of [[{ message: 'changed' }, { event: 'A' }], [{ message: 'ok' }, { event: 'B' }]] as const) {
        expect(() => root.scheduler.startRevisionTest(a.id, revision.id, input, trigger, requestId)).toThrow(ManualRunRequestConflictError)
      }
      root.automations.activateRevision(a.id, revision.id)
      expect(() => root.scheduler.startManual(a.id, { message: 'ok' }, { event: 'A' }, revision.id, requestId)).toThrow(ManualRunRequestConflictError)
      expect(root.scheduler.listRuns().map(run => run.id)).toEqual([accepted.id])
    } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('recovers an uncertain accepted request after restart and archive without launching another Run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-revision-recovery-'))
    let root = await context(directory)
    try {
      const { automation } = root.automations.create({ name: 'Recovery', source: empty })
      const revision = root.automations.publishDraft(automation.id, 1)
      const requestId = 'revision-test-recovery-01'
      const first = root.scheduler.startRevisionTest(automation.id, revision.id, { message: 'retained' }, null, requestId)
      root.automations.archive(automation.id)
      await root.fiber.dispose()
      root = await context(directory)
      expect(root.scheduler.startRevisionTest(automation.id, revision.id, { message: 'retained' }, null, requestId).id).toBe(first.id)
      expect(root.scheduler.listRuns()).toHaveLength(1)
      expect(root.scheduler.listRunEventsPage(first.id).items).toHaveLength(1)
      expect(root.automations.getRevision(revision.id)?.source).toEqual(empty)
      expect(() => root.scheduler.startRevisionTest(automation.id, revision.id, { message: 'retained' }, null, 'revision-test-new-after-archive')).toThrow('archived')
    } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
})
