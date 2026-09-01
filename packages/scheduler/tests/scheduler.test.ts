import { AutomationService } from '@numen/automation'
import {
  CapabilityRegistry,
  type AutomationSource,
  type CapabilityDefinition,
  type NumenValue,
} from '@numen/core'
import { DatabaseService } from '@numen/database'
import { ResourceService } from '@numen/resources'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

const triggerDefinition: CapabilityDefinition = {
  id: 'test:event',
  version: 1,
  kind: 'trigger',
  title: 'Event',
  input: z.object({ channel: z.string().required() }),
  output: z.object({ value: z.string().required() }),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
}

async function createContext(
  databasePath: string,
  definition = actionDefinition(),
  invoke?: (input: NumenValue, signal: AbortSignal, connectionIds: Record<string, string>) => Promise<NumenValue>,
): Promise<Context> {
  const root = new Context()
  await root.plugin(DatabaseService, { path: databasePath })
  await root.plugin(CapabilityRegistry)
  root.capabilities.define(root, definition)
  root.capabilities.define(root, triggerDefinition)
  if (invoke) {
    root.capabilities.provide(root, definition, {
      async invoke({ input, signal, connectionIds }) {
        return invoke(input, signal, connectionIds)
      },
    })
  }
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(dirname(databasePath), 'resources') })
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
  it('pages recent Run summaries with deterministic keyset cursors and status counts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'))
    const automationId = publish(root, { triggers: [], flow: { type: 'block', id: 'flow', steps: [] } })
    const changes: string[] = []
    root.on('numen/run-change', runId => changes.push(runId))
    const first = root.scheduler.startManual(automationId)
    const second = root.scheduler.startManual(automationId)
    const third = root.scheduler.startManual(automationId)
    await Promise.resolve()
    expect(new Set(changes)).toEqual(new Set([first.id, second.id, third.id]))
    const acceptedChangeCount = changes.length
    root.database.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:01.000Z', first.id)
    root.database.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:02.000Z', second.id)
    root.database.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:03.000Z', third.id)

    expect(root.scheduler.listRuns(2).map(run => run.id)).toEqual([third.id, second.id])
    const firstPage = root.scheduler.listRunSummariesPage(2)
    expect(firstPage.items.map(run => ({ id: run.id, executions: run.executionCount, attempts: run.attemptCount })))
      .toEqual([
        { id: third.id, executions: 0, attempts: 0 },
        { id: second.id, executions: 0, attempts: 0 },
      ])
    expect(firstPage.nextCursor).toEqual({ createdAt: '2026-01-01T00:00:02.000Z', id: second.id })
    expect(root.scheduler.listRunSummariesPage(2, firstPage.nextCursor).items.map(run => run.id)).toEqual([first.id])
    expect(root.scheduler.getRunStatusCounts()).toMatchObject({ QUEUED: 3, RUNNING: 0, COMPLETED: 0 })
    expect(() => root.scheduler.listRuns(0)).toThrow('between 1 and 100')
    expect(() => root.scheduler.listRuns(101)).toThrow('between 1 and 100')
    expect(() => root.scheduler.listRunSummariesPage(51)).toThrow('between 1 and 50')
    await root.scheduler.dispatchUntilIdle()
    await Promise.resolve()
    expect(root.scheduler.getRunStatusCounts()).toMatchObject({ QUEUED: 0, COMPLETED: 3 })
    expect(changes.length).toBeGreaterThan(acceptedChangeCount)
    await root.fiber.dispose()
  })

  it('pages bounded Execution diagnostics and append-only Run Journal events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const root = await createContext(
      join(directory, 'numen.db'),
      actionDefinition(),
      async input => input,
    )
    const automationId = publish(root, linearSource)
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    const firstExecutions = root.scheduler.listExecutionDiagnosticsPage(run.id, 2)
    const secondExecutions = root.scheduler.listExecutionDiagnosticsPage(
      run.id,
      2,
      firstExecutions.nextCursor,
    )
    const diagnosticIds = [...firstExecutions.items, ...secondExecutions.items]
      .map(item => item.execution.id)
    expect(new Set(diagnosticIds)).toEqual(new Set(root.scheduler.listExecutions(run.id).map(item => item.id)))
    expect(firstExecutions.statusCounts).toMatchObject({ COMPLETED: 4, FAILED: 0, BLOCKED: 0 })
    expect(firstExecutions.attemptCount).toBe(2)
    expect([...firstExecutions.items, ...secondExecutions.items].flatMap(item => item.attempts)).toHaveLength(2)
    expect(secondExecutions.nextCursor).toBeUndefined()

    const firstEvents = root.scheduler.listRunEventsPage(run.id, 3)
    const secondEvents = root.scheduler.listRunEventsPage(run.id, 3, firstEvents.nextCursor)
    expect(firstEvents.total).toBe(root.scheduler.listEvents(run.id).length)
    expect(firstEvents.items.map(event => event.sequence)).toEqual(
      [...firstEvents.items.map(event => event.sequence)].sort((left, right) => right - left),
    )
    const firstSequences = new Set(firstEvents.items.map(event => event.sequence))
    expect(secondEvents.items.every(event => !firstSequences.has(event.sequence))).toBe(true)
    expect(() => root.scheduler.listExecutionDiagnosticsPage(run.id, 51)).toThrow('between 1 and 50')
    expect(() => root.scheduler.listRunEventsPage(run.id, 101)).toThrow('between 1 and 100')
    expect(() => root.scheduler.listRunEventsPage(run.id, 10, 0)).toThrow('positive integer')
    await root.fiber.dispose()
  })

  it('evaluates structured Call and Reference expressions for durable Wait sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'))
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'block',
        id: 'flow',
        steps: [
          {
            type: 'wait',
            id: 'computed-duration',
            durationMs: {
              type: 'call',
              function: 'core:add',
              arguments: [
                { type: 'ref', path: 'input.delayMs' },
                { type: 'literal', value: 0 },
              ],
            },
          },
          {
            type: 'wait',
            id: 'referenced-time',
            until: { type: 'ref', path: 'input.resumeAt' },
          },
        ],
      },
    })
    const run = root.scheduler.startManual(automationId, {
      delayMs: 0,
      resumeAt: '2000-01-01T00:00:00.000Z',
    })

    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(root.scheduler.listEvents(run.id).filter(event => event.type === 'ExecutionWaiting')).toHaveLength(2)
    await root.fiber.dispose()
  })

  it('passes named Connection bindings from compiled IR to the Capability Provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const connected = {
      ...actionDefinition(),
      connections: [{ name: 'account', required: true, accepts: [] }],
    }
    let observed: Record<string, string> | undefined
    const root = await createContext(join(directory, 'numen.db'), connected, async (input, _signal, connectionIds) => {
      observed = connectionIds
      return input
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'record',
        capability: { id: connected.id, version: connected.version },
        connections: { account: 'conn-account' },
        input: { value: { type: 'literal', value: 'bound' } },
      },
    })

    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(observed).toEqual({ account: 'conn-account' })
    await root.fiber.dispose()
  })

  it('executes ForEach with durable loop bindings and a bounded concurrency window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    let active = 0
    let maxActive = 0
    const values: string[] = []
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async input => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => setImmediate(resolve))
      active -= 1
      values.push((input as { value: string }).value)
      return input
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'foreach',
        id: 'each',
        items: { type: 'ref', path: 'input.items' },
        concurrency: 2,
        body: {
          type: 'block',
          id: 'each-body',
          steps: [{
            type: 'capability',
            id: 'record-item',
            capability: { id: 'test:record', version: 1 },
            input: {
              value: { type: 'template', parts: [{ ref: 'loop.index' }, ':', { ref: 'loop.item' }] },
            },
          }],
        },
      },
    })
    const run = root.scheduler.startManual(automationId, { items: ['a', 'b', 'c', 'd'] })
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(maxActive).toBe(2)
    expect(values.sort()).toEqual(['0:a', '1:b', '2:c', '3:d'])
    const bodyExecutions = root.scheduler.listExecutions(run.id)
      .filter(execution => execution.instructionId === 'record-item')
      .sort((a, b) => a.loopIndex! - b.loopIndex!)
    expect(bodyExecutions.map(execution => [execution.loopIndex, execution.loopItem]))
      .toEqual([[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd']])
    const iterations = root.database.db.prepare(`
      SELECT item_index, status FROM execution_iterations ORDER BY item_index
    `).all() as Array<{ item_index: number; status: string }>
    expect(iterations).toEqual([
      { item_index: 0, status: 'COMPLETED' },
      { item_index: 1, status: 'COMPLETED' },
      { item_index: 2, status: 'COMPLETED' },
      { item_index: 3, status: 'COMPLETED' },
    ])
    await root.fiber.dispose()
  })

  it('keeps step bindings isolated through nested scopes in concurrent iterations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    let outerStarted = 0
    let releaseOuters!: () => void
    const bothOutersStarted = new Promise<void>(resolve => {
      releaseOuters = resolve
    })
    const values: string[] = []
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async input => {
      const value = (input as { value: string }).value
      values.push(value)
      if (value.startsWith('outer:')) {
        outerStarted += 1
        if (outerStarted === 2) releaseOuters()
        await bothOutersStarted
      }
      return input
    })
    const nestedBranch = (id: string, stepId: string) => ({
      type: 'block' as const,
      id,
      steps: [{
        type: 'capability' as const,
        id: stepId,
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'ref' as const, path: 'steps.capture.value' } },
      }],
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'foreach',
        id: 'each',
        items: { type: 'literal', value: ['a', 'b'] },
        concurrency: 2,
        body: {
          type: 'block',
          id: 'each-body',
          steps: [
            {
              type: 'capability',
              id: 'capture',
              capability: { id: 'test:record', version: 1 },
              input: { value: { type: 'template', parts: ['outer:', { ref: 'loop.item' }] } },
            },
            {
              type: 'parallel',
              id: 'nested',
              branches: [nestedBranch('left-branch', 'left'), nestedBranch('right-branch', 'right')],
            },
          ],
        },
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(values.sort()).toEqual([
      'outer:a', 'outer:a', 'outer:a',
      'outer:b', 'outer:b', 'outer:b',
    ])
    await root.fiber.dispose()
  })

  it('fails ForEach fast and cancels running and pending items', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    let startSlow: (() => void) | undefined
    const slowStarted = new Promise<void>(resolve => {
      startSlow = resolve
    })
    const calls: string[] = []
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async (input, signal) => {
      const value = (input as { value: string }).value
      calls.push(value)
      if (value === 'bad') {
        await slowStarted
        throw new Error('bad item')
      }
      if (value === 'slow') {
        startSlow?.()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return input
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'foreach',
        id: 'each',
        items: { type: 'literal', value: ['bad', 'slow', 'pending'] },
        concurrency: 2,
        body: {
          type: 'block',
          id: 'each-body',
          steps: [{
            type: 'capability',
            id: 'record-item',
            capability: { id: 'test:record', version: 1 },
            input: { value: { type: 'ref', path: 'loop.item' } },
          }],
        },
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(calls.sort()).toEqual(['bad', 'slow'])
    expect(root.scheduler.listAttempts(run.id).map(attempt => attempt.status).sort())
      .toEqual(['ABORTED', 'FAILED'])
    const statuses = root.database.db.prepare(`
      SELECT status FROM execution_iterations ORDER BY item_index
    `).pluck().all() as string[]
    expect(statuses).toEqual(['FAILED', 'CANCELLED', 'CANCELLED'])
    expect(root.scheduler.listEvents(run.id).map(event => event.type)).toContain('ExecutionIterationFailed')
    await root.fiber.dispose()
  })

  it('restores a partially dispatched ForEach window after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const root = await createContext(databasePath)
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'foreach',
        id: 'each',
        items: { type: 'literal', value: ['a', 'b', 'c'] },
        concurrency: 2,
        body: { type: 'block', id: 'empty-body', steps: [] },
      },
    })
    const run = root.scheduler.startManual(automationId)
    await expect(root.scheduler.dispatchUntilIdle(1)).rejects.toThrow('exceeded')
    expect(root.database.db.prepare(`
      SELECT status FROM execution_iterations ORDER BY item_index
    `).pluck().all()).toEqual(['RUNNING', 'RUNNING', 'PENDING'])
    await root.fiber.dispose()

    const restarted = await createContext(databasePath)
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(restarted.database.db.prepare(`
      SELECT status FROM execution_iterations ORDER BY item_index
    `).pluck().all()).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED'])
    await restarted.fiber.dispose()
  })

  it('completes an empty ForEach without dispatching a body execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'))
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'foreach',
        id: 'each',
        items: { type: 'literal', value: [] },
        body: {
          type: 'block',
          id: 'each-body',
          steps: [{
            type: 'capability',
            id: 'record-item',
            capability: { id: 'test:record', version: 1 },
            input: { value: { type: 'ref', path: 'loop.item' } },
          }],
        },
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(root.scheduler.listExecutions(run.id).some(execution => (
      execution.instructionId === 'record-item'
    ))).toBe(false)
    expect(root.scheduler.listEvents(run.id).map(event => event.type))
      .toContain('ExecutionIterationCompleted')
    await root.fiber.dispose()
  })

  it('fails ForEach when its items expression is not an array', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'))
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'foreach',
        id: 'each',
        items: { type: 'literal', value: 'not-an-array' },
        body: { type: 'block', id: 'empty-body', steps: [] },
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(root.scheduler.listExecutions(run.id)).toEqual([
      expect.objectContaining({ instructionId: 'each', status: 'FAILED' }),
    ])
    expect(root.scheduler.listEvents(run.id)).toContainEqual(
      expect.objectContaining({
        type: 'ExecutionFailed',
        payload: expect.objectContaining({
          error: expect.objectContaining({ message: 'ForEach items must evaluate to an array' }),
        }),
      }),
    )
    await root.fiber.dispose()
  })

  it('runs Parallel branches concurrently and joins before the successor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    let active = 0
    let maxActive = 0
    const completed: string[] = []
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async input => {
      const value = (input as { value: string }).value
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => setImmediate(resolve))
      active -= 1
      completed.push(value)
      return input
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'block',
        id: 'flow',
        steps: [
          {
            type: 'parallel',
            id: 'parallel-work',
            branches: [
              {
                type: 'block',
                id: 'left-branch',
                steps: [{
                  type: 'capability',
                  id: 'left',
                  capability: { id: 'test:record', version: 1 },
                  input: { value: { type: 'literal', value: 'left' } },
                }],
              },
              {
                type: 'block',
                id: 'right-branch',
                steps: [{
                  type: 'capability',
                  id: 'right',
                  capability: { id: 'test:record', version: 1 },
                  input: { value: { type: 'literal', value: 'right' } },
                }],
              },
            ],
          },
          {
            type: 'capability',
            id: 'after',
            capability: { id: 'test:record', version: 1 },
            input: { value: { type: 'literal', value: 'after' } },
          },
        ],
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(maxActive).toBe(2)
    expect(completed.slice(0, 2).sort()).toEqual(['left', 'right'])
    expect(completed[2]).toBe('after')
    const executions = root.scheduler.listExecutions(run.id)
    const fork = executions.find(execution => execution.instructionId === 'parallel-work')!
    expect(fork.status).toBe('COMPLETED')
    expect(executions.filter(execution => execution.scopeExecutionId === fork.id)).toHaveLength(4)
    expect(executions.every(execution => execution.status === 'COMPLETED')).toBe(true)
    expect(root.scheduler.listEvents(run.id).map(event => event.type)).toEqual(expect.arrayContaining([
      'ExecutionForked',
      'ExecutionJoined',
    ]))
    await root.fiber.dispose()
  })

  it('fails Parallel fast and aborts sibling branches without running the successor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    let startRight: (() => void) | undefined
    const rightStarted = new Promise<void>(resolve => {
      startRight = resolve
    })
    const calls: string[] = []
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async (input, signal) => {
      const value = (input as { value: string }).value
      calls.push(value)
      if (value === 'left') {
        await rightStarted
        throw new Error('left failed')
      }
      if (value === 'right') {
        startRight?.()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return input
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'block',
        id: 'flow',
        steps: [
          {
            type: 'parallel',
            id: 'parallel-work',
            branches: [
              {
                type: 'block',
                id: 'left-branch',
                steps: [{
                  type: 'capability',
                  id: 'left',
                  capability: { id: 'test:record', version: 1 },
                  input: { value: { type: 'literal', value: 'left' } },
                }],
              },
              {
                type: 'block',
                id: 'right-branch',
                steps: [{
                  type: 'capability',
                  id: 'right',
                  capability: { id: 'test:record', version: 1 },
                  input: { value: { type: 'literal', value: 'right' } },
                }],
              },
            ],
          },
          {
            type: 'capability',
            id: 'after',
            capability: { id: 'test:record', version: 1 },
            input: { value: { type: 'literal', value: 'after' } },
          },
        ],
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(calls.sort()).toEqual(['left', 'right'])
    expect(root.scheduler.listAttempts(run.id).map(attempt => attempt.status).sort())
      .toEqual(['ABORTED', 'FAILED'])
    expect(root.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'parallel-work')?.status)
      .toBe('FAILED')
    expect(root.scheduler.listExecutions(run.id).some(execution => execution.instructionId === 'after')).toBe(false)
    expect(root.scheduler.listEvents(run.id).map(event => event.type)).toContain('ExecutionScopeFailed')
    await root.fiber.dispose()
  })

  it('recovers a durable all-children-complete Fork by creating its Join on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const root = await createContext(databasePath)
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'parallel',
        id: 'parallel-work',
        branches: [
          { type: 'block', id: 'left-branch', steps: [] },
          { type: 'block', id: 'right-branch', steps: [] },
        ],
      },
    })
    const run = root.scheduler.startManual(automationId)
    await expect(root.scheduler.dispatchUntilIdle(1)).rejects.toThrow('exceeded')
    const fork = root.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'parallel-work')!
    expect(fork.status).toBe('WAITING')
    root.database.db.prepare(`
      UPDATE executions SET status = 'COMPLETED', output_json = 'null'
      WHERE scope_execution_id = ?
    `).run(fork.id)
    await root.fiber.dispose()

    const restarted = await createContext(databasePath)
    expect(restarted.scheduler.listExecutions(run.id).find(execution => execution.id === fork.id)?.status)
      .toBe('COMPLETED')
    expect(restarted.scheduler.listExecutions(run.id).some(execution => execution.instructionId === '__parallel-work.join'))
      .toBe(true)
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    await restarted.fiber.dispose()
  })

  it('commits the first successful Race branch and aborts the loser with RACE', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    let startSlow: (() => void) | undefined
    const slowStarted = new Promise<void>(resolve => {
      startSlow = resolve
    })
    const calls: string[] = []
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async (input, signal) => {
      const value = (input as { value: string }).value
      calls.push(value)
      if (value === 'fast') {
        await slowStarted
        return input
      }
      if (value === 'slow') {
        startSlow?.()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return input
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'block',
        id: 'flow',
        steps: [
          {
            type: 'race',
            id: 'fastest',
            branches: [
              {
                type: 'block',
                id: 'fast-branch',
                steps: [{
                  type: 'capability',
                  id: 'fast',
                  capability: { id: 'test:record', version: 1 },
                  input: { value: { type: 'literal', value: 'fast' } },
                }],
              },
              {
                type: 'block',
                id: 'slow-branch',
                steps: [{
                  type: 'capability',
                  id: 'slow',
                  capability: { id: 'test:record', version: 1 },
                  input: { value: { type: 'literal', value: 'slow' } },
                }],
              },
            ],
          },
          {
            type: 'capability',
            id: 'after-race',
            capability: { id: 'test:record', version: 1 },
            input: { value: { type: 'literal', value: 'after' } },
          },
        ],
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(calls).toEqual(expect.arrayContaining(['fast', 'slow', 'after']))
    expect(root.scheduler.listAttempts(run.id).map(attempt => attempt.status).sort())
      .toEqual(['ABORTED', 'SUCCEEDED', 'SUCCEEDED'])
    expect(root.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'slow')?.status)
      .toBe('CANCELLED')
    expect(root.scheduler.listEvents(run.id).map(event => event.type)).toContain('ExecutionRaceWon')
    expect(root.scheduler.listEvents(run.id)).toContainEqual(expect.objectContaining({
      type: 'ExecutionCancelled',
      payload: expect.objectContaining({ reason: 'RACE' }),
    }))
    await root.fiber.dispose()
  })

  it('keeps a Race alive after one branch fails and fails only when all branches fail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    let failAll = false
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async input => {
      const value = (input as { value: string }).value
      if (value === 'failure' || failAll) throw new Error(`${value} failed`)
      return input
    })
    const source: AutomationSource = {
      triggers: [],
      flow: {
        type: 'race',
        id: 'race',
        branches: [
          {
            type: 'block',
            id: 'failure-branch',
            steps: [{
              type: 'capability',
              id: 'failure',
              capability: { id: 'test:record', version: 1 },
              input: { value: { type: 'literal', value: 'failure' } },
            }],
          },
          {
            type: 'block',
            id: 'success-branch',
            steps: [{
              type: 'capability',
              id: 'success',
              capability: { id: 'test:record', version: 1 },
              input: { value: { type: 'literal', value: 'success' } },
            }],
          },
        ],
      },
    }
    const automationId = publish(root, source)
    const successfulRun = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(successfulRun.id)?.status).toBe('COMPLETED')
    expect(root.scheduler.listAttempts(successfulRun.id).map(attempt => attempt.status).sort())
      .toEqual(['FAILED', 'SUCCEEDED'])

    failAll = true
    const failedRun = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(failedRun.id)?.status).toBe('FAILED')
    expect(root.scheduler.listAttempts(failedRun.id).map(attempt => attempt.status)).toEqual(['FAILED', 'FAILED'])
    expect(root.scheduler.listEvents(failedRun.id).filter(event => event.type === 'ExecutionRaceBranchFailed'))
      .toHaveLength(2)
    await root.fiber.dispose()
  })




  it('commits ResourceRef outputs to an Execution owner in the success transaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'))
    const resource = await root.resources.stage({
      name: 'Capability output',
      mediaType: 'text/plain',
      content: Buffer.from('owned output'),
    })
    const resourceCapability: CapabilityDefinition = {
      id: 'test:resource',
      version: 1,
      kind: 'action',
      title: 'Return resource',
      input: z.object({}),
      output: z.object({ resource: z.object({ $resource: z.string().required() }) }),
      semantics: { sideEffect: false, idempotent: true, retrySafe: true },
    }
    let outputRef = resource.ref
    root.capabilities.define(root, resourceCapability)
    root.capabilities.provide(root, resourceCapability, {
      async invoke() {
        return { resource: outputRef }
      },
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'resource-step',
        capability: resourceCapability,
        input: {},
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(root.resources.get(resource.id)?.state).toBe('COMMITTED')
    const execution = root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'resource-step')!
    expect(root.resources.listOwners(resource.id)).toEqual([{ type: 'execution', id: execution.id }])

    outputRef = { $resource: 'res_missing' }
    const invalidRun = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(invalidRun.id)?.status).toBe('FAILED')
    expect(root.scheduler.listAttempts(invalidRun.id).map(attempt => attempt.status)).toEqual(['FAILED'])
    expect(root.scheduler.listExecutions(invalidRun.id)[0]?.status).toBe('FAILED')
    await root.fiber.dispose()
  })

  it('durably accepts and deduplicates active trigger emissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async input => input)
    const source: AutomationSource = {
      triggers: [{
        id: 'event',
        capability: { id: 'test:event', version: 1 },
        config: { channel: 'updates' },
      }],
      flow: {
        type: 'capability',
        id: 'record',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'ref', path: 'trigger.value' } },
      },
    }
    const automationId = publish(root, source)
    const automation = root.automations.setEnabled(automationId, true)
    const binding = {
      automationId,
      revisionId: automation.activeRevisionId!,
      activationGeneration: automation.activationGeneration,
      triggerId: 'event',
      capability: { id: 'test:event', version: 1 },
      config: { channel: 'updates' },
      connectionIds: {},
    }

    const accepted = root.scheduler.acceptTrigger(binding, {
      data: { value: 'durable' },
      eventId: 'event-1',
      subject: 'subject-1',
      checkpoint: { cursor: 1 },
    })
    expect(accepted).toMatchObject({ status: 'accepted', runId: expect.any(String) })
    expect(root.scheduler.acceptTrigger(binding, {
      data: { value: 'ignored duplicate' },
      eventId: 'event-1',
    })).toEqual({ status: 'duplicate', runId: accepted.runId })
    expect(root.scheduler.acceptTrigger({ ...binding, activationGeneration: binding.activationGeneration - 1 }, {
      data: { value: 'stale' },
      eventId: 'event-2',
    })).toEqual({ status: 'stale' })
    expect((root.database.db.prepare('SELECT COUNT(*) AS count FROM trigger_events').get() as { count: number }).count)
      .toBe(1)

    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(accepted.runId!)?.status).toBe('COMPLETED')
    expect(root.scheduler.getRun(accepted.runId!)?.trigger).toEqual({ value: 'durable' })
    await root.fiber.dispose()
  })

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

  it('retries known failures as new Attempts and eventually completes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    let calls = 0
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async input => {
      calls += 1
      if (calls < 3) throw new Error(`transient failure ${calls}`)
      return input
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'record',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'literal', value: 'retry' } },
        policy: { retry: { maxAttempts: 3, backoffMs: 0 } },
      },
    })

    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(calls).toBe(3)
    expect(root.scheduler.listAttempts(run.id).map(attempt => attempt.status))
      .toEqual(['FAILED', 'FAILED', 'SUCCEEDED'])
    expect(root.scheduler.listEvents(run.id).filter(event => event.type === 'ExecutionRetryScheduled'))
      .toHaveLength(2)
    await root.fiber.dispose()
  })

  it('blocks an unsafe timed-out Attempt as OUTCOME_UNKNOWN instead of retrying', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(false), async (_input, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'record',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'literal', value: 'timeout' } },
        policy: { timeoutMs: 5 },
      },
    })

    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()

    expect(root.scheduler.getRun(run.id)?.status).toBe('RUNNING')
    expect(root.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['TIMED_OUT'])
    expect(root.scheduler.listExecutions(run.id)[0]).toMatchObject({
      status: 'BLOCKED',
      blockedReason: 'OUTCOME_UNKNOWN',
    })
    await root.fiber.dispose()
  })

  it('propagates cancellation to an active invocation and persists terminal state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const root = await createContext(join(directory, 'numen.db'), actionDefinition(), async (_input, signal) => {
      markStarted?.()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'record',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'literal', value: 'cancel' } },
      },
    })
    const run = root.scheduler.startManual(automationId)
    const dispatch = root.scheduler.dispatchUntilIdle()
    await started

    expect(root.scheduler.cancelRun(run.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'USER' })
    await dispatch

    expect(root.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['ABORTED'])
    expect(root.scheduler.listExecutions(run.id).map(execution => execution.status)).toEqual(['CANCELLED'])
    expect(root.scheduler.listEvents(run.id).map(event => event.type)).toEqual(expect.arrayContaining([
      'RunCancellationRequested',
      'ExecutionCancelled',
      'RunCancelled',
    ]))
    await root.fiber.dispose()
  })

  it('finishes durable cancellation intent during restart recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-scheduler-'))
    directories.push(directory)
    const databasePath = join(directory, 'numen.db')
    const root = await createContext(databasePath)
    const automationId = publish(root, {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'record',
        capability: { id: 'test:record', version: 1 },
        input: { value: { type: 'literal', value: 'recover-cancel' } },
      },
    })
    const run = root.scheduler.startManual(automationId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.listExecutions(run.id)[0]?.status).toBe('BLOCKED')
    root.database.db.prepare(`
      UPDATE runs SET status = 'CANCELLING', cancel_reason = 'SHUTDOWN' WHERE id = ?
    `).run(run.id)
    await root.fiber.dispose()

    const restarted = await createContext(databasePath)
    expect(restarted.scheduler.getRun(run.id)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'SHUTDOWN',
    })
    expect(restarted.scheduler.listExecutions(run.id)[0]?.status).toBe('CANCELLED')
    expect(restarted.scheduler.listEvents(run.id).at(-1)?.type).toBe('RunCancelled')
    await restarted.fiber.dispose()
  })
})
