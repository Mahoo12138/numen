import { AutomationService } from '@numen/automation'
import { ConsoleProcedureUnavailableError, ConsoleService, type ConsoleRequestContext } from '@numen/console'
import { CapabilityRegistry, type CapabilityDefinition } from '@numen/core'
import { DatabaseService } from '@numen/database'
import { SchedulerService } from '@numen/scheduler'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import { ResourceService } from '../../resources/src/index.js'
import {
  workbenchCancelRunAction,
  workbenchRunDetailQuery,
  workbenchRunsIndexQuery,
  workbenchRunsProviderPlugin,
} from '../src/runs-provider.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function request(): ConsoleRequestContext {
  return {
    requestId: 'run-detail-request',
    principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
    signal: new AbortController().signal,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger,
  }
}

describe('Workbench Run detail Provider', () => {
  it('projects bounded Execution diagnostics and semantic Journal events without raw values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-run-detail-'))
    directories.push(directory)
    const root = new Context()
    await root.plugin(DatabaseService, { path: ':memory:' })
    await root.plugin(CapabilityRegistry)
    const action: CapabilityDefinition = {
      id: 'test:record',
      version: 1,
      kind: 'action',
      title: 'Record value',
      input: z.object({ value: z.string().required() }),
      output: z.object({ value: z.string().required() }),
      semantics: { sideEffect: true, idempotent: true, retrySafe: true },
    }
    root.capabilities.define(root, action)
    let attempt = 0
    root.capabilities.provide(root, action, {
      async invoke({ input }) {
        attempt += 1
        if (attempt === 1) throw new Error('transient provider failure')
        return input
      },
    })
    await root.plugin(AutomationService)
    await root.plugin(ResourceService, { path: join(directory, 'resources') })
    await root.plugin(SchedulerService, { autoDispatch: false })
    await root.plugin(ConsoleService)
    root.console.define(root, workbenchRunDetailQuery)
    root.console.define(root, workbenchCancelRunAction)
    root.console.define(root, workbenchRunsIndexQuery)
    const providerPlugin = (ctx: Context) => workbenchRunsProviderPlugin(ctx)
    providerPlugin.inject = ['console', 'automations', 'scheduler']
    const provider = await root.plugin(providerPlugin)
    const created = root.automations.create({
      name: 'Run diagnostics test',
      source: {
        triggers: [],
        flow: {
          type: 'capability',
          id: 'record',
          capability: { id: action.id, version: action.version },
          input: { value: { type: 'literal', value: 'private payload value' } },
          policy: { retry: { maxAttempts: 2, backoffMs: 0 } },
        },
      },
    })
    const revision = root.automations.publishDraft(created.automation.id, 1)
    root.automations.activateRevision(created.automation.id, revision.id)
    const run = root.scheduler.startManual(created.automation.id)
    await root.scheduler.dispatchUntilIdle()

    const detail = await root.console.query(workbenchRunDetailQuery, {
      runId: run.id,
      executionLimit: 25,
      eventLimit: 100,
    }, request())
    expect(detail).toMatchObject({
      run: {
        id: run.id,
        automationName: 'Run diagnostics test',
        revisionNumber: 1,
        status: 'COMPLETED',
      },
      executionSummary: { total: 2, attempts: 2, completed: 2, failed: 0 },
      flow: {
        root: expect.objectContaining({
          title: 'Flow',
          status: 'COMPLETED',
          executionCount: 1,
          children: [expect.objectContaining({ title: 'Record value', status: 'COMPLETED' })],
        }),
      },
      context: expect.arrayContaining([
        expect.objectContaining({ name: 'run', value: expect.objectContaining({ id: run.id }) }),
        expect.objectContaining({ name: 'steps', value: { record: { value: '[string · 21 chars]' } } }),
      ]),
      executions: expect.arrayContaining([
        expect.objectContaining({
          instructionId: 'record',
          title: 'Record value',
          operation: 'invoke',
          status: 'COMPLETED',
          attempts: [
            expect.objectContaining({ status: 'FAILED', errorSummary: 'transient provider failure' }),
            expect.objectContaining({ status: 'SUCCEEDED' }),
          ],
        }),
      ]),
      timeline: {
        items: expect.arrayContaining([
          expect.objectContaining({ title: 'Attempt Failed', detail: 'transient provider failure' }),
          expect.objectContaining({ title: 'Execution Retry Scheduled' }),
        ]),
      },
    })
    expect(JSON.stringify(detail)).not.toContain('private payload value')

    const cancellable = root.scheduler.startManual(created.automation.id, { password: 'never-project-me' })
    expect(await root.console.action(workbenchCancelRunAction, { runId: cancellable.id }, request())).toMatchObject({
      runId: cancellable.id,
      status: 'CANCELLED',
      cancelReason: 'USER',
    })
    expect(root.scheduler.getRun(cancellable.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'USER' })
    await expect(root.console.action(workbenchCancelRunAction, { runId: 'run_missing' }, request())).rejects.toMatchObject({
      status: 404,
      code: 'RUN_NOT_FOUND',
    })

    const paged = await root.console.query(workbenchRunDetailQuery, {
      runId: run.id,
      executionLimit: 1,
      eventLimit: 2,
    }, request())
    expect(paged).toMatchObject({
      executions: [expect.any(Object)],
      nextExecutionCursor: expect.any(String),
      timeline: { items: [expect.any(Object), expect.any(Object)], nextCursor: expect.any(Number) },
    })
    expect(await root.console.query(workbenchRunDetailQuery, {
      runId: 'run_missing',
      executionLimit: 25,
      eventLimit: 100,
    }, request())).toBeNull()

    await provider.dispose()
    await expect(root.console.query(workbenchRunDetailQuery, {
      runId: run.id,
      executionLimit: 25,
      eventLimit: 100,
    }, request())).rejects.toThrow(ConsoleProcedureUnavailableError)
    await root.fiber.dispose()
  })
})
