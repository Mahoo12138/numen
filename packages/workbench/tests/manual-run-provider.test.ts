import { AutomationCompileError, AutomationService } from '@numen/automation'
import { CapabilityRegistry, type AutomationSource } from '@numen/core'
import { DatabaseService } from '@numen/database'
import { ResourceService } from '../../resources/src/index.js'
import { SchedulerService } from '@numen/scheduler'
import { ConsoleService, type ConsoleRequestContext } from '@numen/console'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { provideManualRuns, workbenchManualRunFormQuery, workbenchStartManualRunAction } from '../src/manual-run-provider.js'

const request = (): ConsoleRequestContext => ({ requestId: 'manual-run-test', principal: { subject: { type: 'user', id: 'owner' }, authenticated: true }, signal: new AbortController().signal, logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger })

describe('manual Run contract and acceptance', () => {
  it('freezes active input defaults, validates before acceptance, fences revisions, and invokes with resolved input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'numen-manual-run-'))
    const root = new Context()
    try {
      await root.plugin(DatabaseService, { path: join(dir, 'db') })
      await root.plugin(CapabilityRegistry)
      const definition = { id: 'test:echo', version: 1, kind: 'action' as const, title: 'Echo', input: z.object({ message: z.string().required() }), output: z.object({ message: z.string() }), semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
      root.capabilities.define(root, definition)
      const seen: unknown[] = []
      root.capabilities.provide(root, definition, { async invoke({ input }) { seen.push(input); return input } })
      await root.plugin(AutomationService)
      await root.plugin(ResourceService, { path: join(dir, 'resources') })
      await root.plugin(SchedulerService, { autoDispatch: false })
      await root.plugin(ConsoleService)
      root.console.define(root, workbenchManualRunFormQuery)
      root.console.define(root, workbenchStartManualRunAction)
      provideManualRuns(root)
      const source: AutomationSource = { inputs: { message: { type: 'string', required: true }, count: { type: 'number', default: 2 } }, triggers: [], flow: { type: 'capability', id: 'echo', capability: { id: definition.id, version: 1 }, input: { message: { type: 'ref', path: 'input.message' } } } }
      const { automation } = root.automations.create({ name: 'Manual', source })
      await expect(root.console.query(workbenchManualRunFormQuery, { automationId: automation.id }, request())).rejects.toMatchObject({ code: 'AUTOMATION_NOT_ACTIVE' })
      const first = root.automations.publishDraft(automation.id, 1)
      root.automations.activateRevision(automation.id, first.id)
      const form = await root.console.query(workbenchManualRunFormQuery, { automationId: automation.id }, request())
      expect(form).toMatchObject({ revisionId: first.id, inputs: source.inputs })
      const submit = (input: unknown, revisionId = first.id) => root.console.action(workbenchStartManualRunAction, { automationId: automation.id, expectedRevisionId: revisionId, input: input as never }, request())
      for (const invalid of [{}, { message: 1 }, { message: 'ok', unknown: 'hidden' }, []]) await expect(submit(invalid)).rejects.toMatchObject({ status: 422, code: 'AUTOMATION_INPUT_INVALID' })
      expect(root.scheduler.listRuns()).toHaveLength(0)
      const changed = structuredClone(source)
      changed.inputs!.count!.default = 9
      root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: changed })
      const second = root.automations.publishDraft(automation.id, 2)
      const result = await submit({ message: 'hello' })
      expect(root.scheduler.getRun(result.runId)).toMatchObject({ revisionId: first.id, input: { message: 'hello', count: 2 } })
      await root.scheduler.dispatchUntilIdle()
      expect(root.scheduler.getRun(result.runId)?.status).toBe('COMPLETED')
      expect(seen).toEqual([{ message: 'hello' }])
      root.automations.activateRevision(automation.id, second.id)
      await expect(submit({ message: 'old form' })).rejects.toMatchObject({ status: 409, code: 'MANUAL_RUN_REVISION_CONFLICT' })
      expect(root.scheduler.listRuns()).toHaveLength(1)
      const current = await submit({ message: 'current' }, second.id)
      expect(root.scheduler.getRun(current.runId)?.input.count).toBe(9)
      expect(root.scheduler.getRun(result.runId)?.input.count).toBe(2)
      const undeclared = structuredClone(changed); undeclared.inputs = {}
      root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: undeclared })
      expect(() => root.automations.publishDraft(automation.id, 3)).toThrow(AutomationCompileError)
      expect(root.automations.getRevision(first.id)?.source.inputs).toEqual(source.inputs)
    } finally { await root.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
  })
})
