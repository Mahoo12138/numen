import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, type AutomationSource } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '../../resources/src/index.js'
import { SchedulerService } from '@numenjs/scheduler'
import { ConsoleService, type ConsoleRequestContext } from '@numenjs/console'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { provideManualRuns, workbenchManualRunFormQuery, workbenchStartManualRunAction } from '../src/manual-run-provider.js'
import { projectWorkbenchRunDetail } from '../src/run-detail-projection.js'

const request = (): ConsoleRequestContext => ({ requestId: 'revision-form-test', principal: { subject: { type: 'user', id: 'owner' }, authenticated: true }, signal: new AbortController().signal, logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger })

describe('published Revision run provider', () => {
  it('binds test forms to inactive Revisions, validates ownership and preserves durable test origin and recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-revision-provider-'))
    const root = new Context()
    try {
      await root.plugin(DatabaseService, { path: join(directory, 'db') })
      await root.plugin(CapabilityRegistry)
      await root.plugin(AutomationService)
      await root.plugin(ResourceService, { path: join(directory, 'resources') })
      await root.plugin(SchedulerService, { autoDispatch: false })
      await root.plugin(ConsoleService)
      root.console.define(root, workbenchManualRunFormQuery)
      root.console.define(root, workbenchStartManualRunAction)
      provideManualRuns(root)
      const source: AutomationSource = { inputs: { text: { type: 'string', default: 'original' } }, triggers: [], flow: { type: 'block', id: 'root', steps: [] } }
      const { automation } = root.automations.create({ name: 'Test target', source })
      await expect(root.console.query(workbenchManualRunFormQuery, { automationId: automation.id, mode: 'revision-test' }, request())).rejects.toMatchObject({ code: 'AUTOMATION_NO_REVISIONS' })
      const first = root.automations.publishDraft(automation.id, 1)
      root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: { ...source, inputs: { count: { type: 'number', default: 5 } } } })
      const second = root.automations.publishDraft(automation.id, 2)
      expect(await root.console.query(workbenchManualRunFormQuery, { automationId: automation.id, mode: 'revision-test' }, request())).toMatchObject({ mode: 'revision-test', revisionId: second.id, inputs: { count: { default: 5 } }, revisions: [{ id: second.id, active: false }, { id: first.id, active: false }] })
      expect(await root.console.query(workbenchManualRunFormQuery, { automationId: automation.id, mode: 'revision-test', revisionId: first.id }, request())).toMatchObject({ revisionId: first.id, inputs: source.inputs })
      const foreign = root.automations.create({ name: 'Other' }).automation
      const foreignRevision = root.automations.publishDraft(foreign.id, 1)
      await expect(root.console.query(workbenchManualRunFormQuery, { automationId: automation.id, mode: 'revision-test', revisionId: foreignRevision.id }, request())).rejects.toMatchObject({ code: 'AUTOMATION_REVISION_NOT_FOUND' })
      const input = { automationId: automation.id, mode: 'revision-test' as const, revisionId: first.id, requestId: 'revision-provider-request-01', input: {}, trigger: null }
      await expect(root.console.action(workbenchStartManualRunAction, { ...input, revisionId: foreignRevision.id }, request())).rejects.toMatchObject({ code: 'AUTOMATION_REVISION_NOT_FOUND' })
      const { trigger: _trigger, ...missingTrigger } = input
      await expect(root.console.action(workbenchStartManualRunAction, missingTrigger as typeof input, request())).rejects.toMatchObject({ code: 'RUN_TRIGGER_INVALID' })
      const accepted = await root.console.action(workbenchStartManualRunAction, input, request())
      const run = root.scheduler.getRun(accepted.runId)!
      expect(run).toMatchObject({ revisionId: first.id, trigger: null, input: { text: 'original' } })
      expect(root.automations.get(automation.id)).toMatchObject({ enabled: false, activationGeneration: 0 })
      expect(root.automations.get(automation.id)?.activeRevisionId).toBeUndefined()
      const detail = projectWorkbenchRunDetail(run, 'Test target', first, root.scheduler.inspectRun(run.id)!, root.scheduler.listExecutionDiagnosticsPage(run.id), root.scheduler.listRunEventsPage(run.id), () => '')
      expect(detail.timeline.items[0]?.detail).toContain('Revision-test')
      expect(detail.timeline.items[0]?.detail).toContain(input.requestId)
      root.automations.activateRevision(automation.id, second.id)
      root.automations.archive(automation.id)
      expect(await root.console.action(workbenchStartManualRunAction, input, request())).toEqual(accepted)
      expect(root.scheduler.listRuns()).toHaveLength(1)
    } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
})
