import { AutomationService } from '@numen/automation'
import {
  CapabilityRegistry,
  type AutomationSource,
  type CapabilityDefinition,
  type NumenValue,
} from '@numen/core'
import { DatabaseService } from '@numen/database'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import { SchedulerService } from '../src/index.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function actionDefinition(retrySafe = true): CapabilityDefinition {
  return {
    id: 'test:record',
    version: 1,
    kind: 'action',
    title: 'Record',
    input: z.object({ value: z.string().required() }),
    output: z.object({ value: z.string().required() }),
    semantics: { sideEffect: true, idempotent: retrySafe, retrySafe },
  }
}

async function createContext(
  databasePath: string,
  definition = actionDefinition(),
  invoke?: (input: NumenValue) => Promise<NumenValue>,
): Promise<Context> {
  const root = new Context()
  await root.plugin(DatabaseService, { path: databasePath })
  await root.plugin(CapabilityRegistry)
  root.capabilities.define(root, definition)
  if (invoke) {
    root.capabilities.provide(root, definition, {
      async invoke({ input }) {
        return invoke(input)
      },
    })
  }
  await root.plugin(AutomationService)
  await root.plugin(SchedulerService, { autoDispatch: false })
  return root
}

function publish(root: Context, source: AutomationSource): string {
  const created = root.automations.create({ name: 'Scheduler test', source })
  const revision = root.automations.publishDraft(created.automation.id, 1)
  root.automations.activateRevision(created.automation.id, revision.id)
  return created.automation.id
}

const linearSource: AutomationSource = {
  triggers: [],
  flow: {
    type: 'block',
    id: 'flow',
    steps: [
      {
        type: 'capability',
        id: 'first',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'literal', value: 'alpha' } },
      },
      {
        type: 'capability',
        id: 'second',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'ref', path: 'steps.first.value' } },
      },
      {
        type: 'wait',
        id: 'timer',
        durationMs: { type: 'literal', value: 0 },
      },
    ],
  },
}

describe('SchedulerService', () => {
  it('executes Core IR durably, resolves step refs, waits, and journals every transition', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const calls: string[] = []
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async (input) => {
      const value = (input as { value: string }).value
      calls.push(value)
      return { value }
    })
    const automationId = publish(root, linearSource)
    const accepted = root.scheduler.startManual(automationId)
    expect(accepted.status).toBe('QUEUED')

    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(accepted.id)?.status).toBe('COMPLETED')
    expect(calls).toEqual(['alpha', 'alpha'])
    expect(root.scheduler.listAttempts(accepted.id).map(attempt => attempt.status)).toEqual(['SUCCEEDED', 'SUCCEEDED'])
    expect(root.scheduler.listExecutions(accepted.id).map(execution => execution.status))
      .toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED'])
    const events = root.scheduler.listEvents(accepted.id)
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1))
    expect(events.map(event => event.type)).toContain('ExecutionWaiting')
    expect(events.at(-1)?.type).toBe('RunCompleted')
    await root.fiber.dispose()
  })

  it('blocks when a Provider is absent and resumes when it returns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'))
    const source: AutomationSource = {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'record',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'literal', value: 'blocked' } },
      },
    }
    const automationId = publish(root, source)
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('RUNNING')
    expect(root.scheduler.listExecutions(run.id)[0]).toMatchObject({
      status: 'BLOCKED',
      blockedReason: 'PROVIDER_UNAVAILABLE',
    })

    root.capabilities.provide(root, { id: 'test:record', version: 1 }, {
      async invoke({ input }) {
        return input
      },
    })
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(root.scheduler.listEvents(run.id).map(event => event.type)).toContain('ExecutionUnblocked')
    await root.fiber.dispose()
  })

  it('recovers interrupted retry-safe Attempts as a new Attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const root = await createContext(databasePath)
    const source: AutomationSource = {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'record',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'literal', value: 'recover' } },
      },
    }
    const automationId = publish(root, source)
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    const execution = root.scheduler.listExecutions(run.id)[0]!
    const now = new Date().toISOString()
    root.database.transaction(() => {
      root.database.db.prepare(`
        UPDATE executions SET status = 'RUNNING', blocked_reason = NULL, updated_at = ? WHERE id = ?
      `).run(now, execution.id)
      root.database.db.prepare(`
        INSERT INTO attempts (id, execution_id, number, status, provider_ref, started_at)
        VALUES ('attempt_crashed', ?, 1, 'RUNNING', 'test:record@1', ?)
      `).run(execution.id, now)
    })
    await root.fiber.dispose()

    const restarted = await createContext(databasePath, actionDefinition(), async input => input)
    expect(restarted.scheduler.listAttempts(run.id)[0]?.status).toBe('INTERRUPTED')
    expect(restarted.scheduler.listExecutions(run.id)[0]?.status).toBe('RUNNABLE')
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(restarted.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['INTERRUPTED', 'SUCCEEDED'])
    await restarted.fiber.dispose()
  })

  it('blocks unsafe interrupted Attempts as OUTCOME_UNKNOWN', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const unsafe = actionDefinition(false)
    const root = await createContext(databasePath, unsafe)
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'record',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'literal', value: 'unknown' } },
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    const execution = root.scheduler.listExecutions(run.id)[0]!
    const now = new Date().toISOString()
    root.database.db.prepare(`
      UPDATE executions SET status = 'RUNNING', blocked_reason = NULL, updated_at = ? WHERE id = ?
    `).run(now, execution.id)
    root.database.db.prepare(`
      INSERT INTO attempts (id, execution_id, number, status, provider_ref, started_at)
      VALUES ('attempt_unsafe', ?, 1, 'RUNNING', 'test:record@1', ?)
    `).run(execution.id, now)
    await root.fiber.dispose()

    const restarted = await createContext(databasePath, unsafe, async input => input)
    expect(restarted.scheduler.listAttempts(run.id)[0]?.status).toBe('OUTCOME_UNKNOWN')
    expect(restarted.scheduler.listExecutions(run.id)[0]).toMatchObject({
      status: 'BLOCKED',
      blockedReason: 'OUTCOME_UNKNOWN',
    })
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(run.id)?.status).toBe('RUNNING')
    await restarted.fiber.dispose()
  })
})
