import { AutomationService } from '@numenjs/automation'
import { CapabilityRegistry, type AutomationSource, type CapabilityDefinition, type GraphEdge, type GraphNodeSource, type NumenValue, type ValueExpr } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SchedulerService } from '../src/service.js'

const directories: string[] = []
const contexts = new Set<Context>()
afterEach(async () => {
  for (const root of contexts) await root.fiber.dispose()
  contexts.clear()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const literal = (value: NumenValue): ValueExpr => ({ type: 'literal', value })
const ref = (path: string): ValueExpr => ({ type: 'ref', path })
function node(id: string, input: Record<string, ValueExpr> = {}, policy?: { timeoutMs?: number; retry?: { maxAttempts: number; backoffMs?: number } }): GraphNodeSource {
  return { type: 'capability', id, capability: { id: 'test:graph', version: 1 }, input: { value: literal(id), ...input }, ...(policy ? { policy } : {}) }
}
function edge(from: string, to: string, port = 'in', fromPort = from === 'graph' ? 'start' : 'out'): GraphEdge {
  return { id: `${from}-${fromPort}-${to}-${port}`, from: { nodeId: from, port: fromPort }, to: { nodeId: to, port } }
}
function source(nodes: GraphNodeSource[], edges: GraphEdge[], output?: ValueExpr): AutomationSource {
  return { triggers: [], flow: { type: 'graph', id: 'graph', version: 1, nodes, edges, ...(output ? { output } : {}) } }
}
function definition(retrySafe = true): CapabilityDefinition {
  return { id: 'test:graph', version: 1, kind: 'action', title: 'Graph test', input: z.any(), output: z.any(), semantics: { sideEffect: true, idempotent: retrySafe, retrySafe } }
}
async function context(path: string, invoke?: (input: Record<string, NumenValue>, signal: AbortSignal) => Promise<NumenValue>, retrySafe = true, maxConcurrentExecutions = 16) {
  const root = new Context()
  contexts.add(root)
  await root.plugin(DatabaseService, { path })
  await root.plugin(CapabilityRegistry)
  root.capabilities.define(root, definition(retrySafe))
  if (invoke) root.capabilities.provide(root, definition(retrySafe), { invoke: ({ input, signal }) => invoke(input as Record<string, NumenValue>, signal) })
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(dirname(path), 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false, maxConcurrentExecutions })
  return root
}
async function databasePath() {
  const dir = await mkdtemp(join(tmpdir(), 'numen-graph-scheduler-'))
  directories.push(dir)
  return join(dir, 'numen.db')
}
function publish(root: Context, graph: AutomationSource) {
  const { automation } = root.automations.create({ name: 'Graph scheduler', source: graph })
  const revision = root.automations.publishDraft(automation.id, 1)
  expect([revision.protocolVersion, revision.irVersion, revision.compiledPlan.irVersion]).toEqual([2, 2, 2])
  root.automations.activateRevision(automation.id, revision.id)
  return root.scheduler.startManual(automation.id)
}
async function close(root: Context) { await root.fiber.dispose(); contexts.delete(root) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const outputs = (root: Context, runId: string) => Object.fromEntries(root.scheduler.listExecutions(runId).map(execution => [execution.instructionId, execution.output]))

describe('durable graph scheduler', () => {
  it('releases independent dependencies early, runs a shared node once, and preserves named output with null and arrays', async () => {
    const calls: string[] = [], slow = deferred()
    const root = await context(await databasePath(), async input => {
      calls.push(input.value as string)
      if (input.value === 'slow') await slow.promise
      if (input.value === 'shared') return null
      if (input.value === 'early') return []
      return input
    })
    const run = publish(root, source([
      node('shared'), node('slow'), node('early', { from: ref('steps.shared') }), node('both', { shared: ref('steps.shared'), slow: ref('steps.slow') }),
      { type: 'merge', id: 'merged', mode: 'all', inputs: ['early', 'both'] },
    ], [edge('graph', 'shared'), edge('graph', 'slow'), edge('shared', 'early'), edge('shared', 'both'), edge('slow', 'both'), edge('early', 'merged', 'early'), edge('both', 'merged', 'both')], ref('steps.merged')))
    const task = root.scheduler.dispatchUntilIdle()
    try {
      await vi.waitFor(() => expect(calls).toContain('early'))
      expect(calls).not.toContain('both')
      slow.resolve(); await task
      expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
      expect(calls.filter(call => call === 'shared')).toHaveLength(1)
      expect(outputs(root, run.id).merged).toEqual({ early: [], both: { value: 'both', shared: null, slow: { value: 'slow' } } })
      expect(outputs(root, run.id).__complete).toEqual(outputs(root, run.id).merged)
      expect(root.scheduler.listGraphMembers(run.id).every(member => member.status === 'COMPLETED')).toBe(true)
    } finally { slow.resolve(); await task }
  })

  it.each([true, false])('persists the skipped condition path without fake executions (choice %s)', async choice => {
    const calls: string[] = []
    const root = await context(await databasePath(), async input => { calls.push(input.value as string); return input.value === 'yes' ? [] : null })
    const run = publish(root, source([
      { type: 'condition', id: 'choice', condition: literal(choice) }, node('yes'), node('no'),
      { type: 'merge', id: 'selected', mode: 'selected', inputs: ['yes', 'no'] }, node('after', { from: ref('steps.selected') }),
    ], [edge('graph', 'choice'), edge('choice', 'yes', 'in', 'true'), edge('choice', 'no', 'in', 'false'), edge('yes', 'selected', 'yes'), edge('no', 'selected', 'no'), edge('selected', 'after')], ref('steps.selected')))
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(calls).toEqual([choice ? 'yes' : 'no', 'after'])
    expect(root.scheduler.listGraphMembers(run.id).find(member => member.nodeId === (choice ? 'no' : 'yes'))).toMatchObject({ status: 'SKIPPED' })
    expect(root.scheduler.listExecutions(run.id).some(execution => execution.instructionId === (choice ? 'no' : 'yes'))).toBe(false)
    expect(outputs(root, run.id).__complete).toEqual(choice ? [] : null)
    expect(root.scheduler.listEvents(run.id).filter(event => event.type === 'GraphMemberSkipped')).toHaveLength(1)
  })

  it('propagates an entirely skipped selected merge and downstream chain without hanging', async () => {
    const invoke = vi.fn(async () => null)
    const root = await context(await databasePath(), invoke)
    const run = publish(root, source([
      { type: 'condition', id: 'outer', condition: literal(false) }, { type: 'condition', id: 'inner', condition: literal(true) },
      node('yes'), node('no'), { type: 'merge', id: 'selected', mode: 'selected', inputs: ['yes', 'no'] }, node('after'),
    ], [edge('graph', 'outer'), edge('outer', 'inner', 'in', 'true'), edge('inner', 'yes', 'in', 'true'), edge('inner', 'no', 'in', 'false'), edge('yes', 'selected', 'yes'), edge('no', 'selected', 'no'), edge('selected', 'after')]))
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(invoke).not.toHaveBeenCalled()
    expect(root.scheduler.listGraphMembers(run.id).filter(member => member.status === 'SKIPPED')).toHaveLength(5)
  })

  it('fails fast, cancels an active sibling, and does not dispatch its pending downstream', async () => {
    const started = deferred(), release = deferred(), calls: string[] = []
    let siblingSignal: AbortSignal | undefined
    const root = await context(await databasePath(), async (input, signal) => {
      calls.push(input.value as string)
      if (input.value === 'slow') { siblingSignal = signal; started.resolve(); await release.promise; return 'late' }
      if (input.value === 'bad') { await started.promise; throw new Error('known failure') }
      return input
    })
    const run = publish(root, source([node('bad'), node('slow'), node('after')], [edge('graph', 'bad'), edge('graph', 'slow'), edge('slow', 'after')]))
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(siblingSignal?.aborted).toBe(true)
    expect(calls).not.toContain('after')
    expect(root.scheduler.listGraphMembers(run.id).find(member => member.nodeId === 'after')).toMatchObject({ status: 'CANCELLED' })
    release.resolve(); await new Promise(resolve => setImmediate(resolve))
    expect(root.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'slow')).toMatchObject({ status: 'CANCELLED' })
  })

  it('persists cancellation while providers ignore abort and rejects their late result', async () => {
    const started = deferred(), release = deferred()
    const path = await databasePath()
    const root = await context(path, async () => { started.resolve(); await release.promise; return 'late' })
    const run = publish(root, source([node('first'), node('after')], [edge('graph', 'first'), edge('first', 'after')]))
    const task = root.scheduler.dispatchUntilIdle()
    await started.promise
    root.scheduler.cancelRun(run.id)
    await task
    release.resolve(); await new Promise(resolve => setImmediate(resolve))
    expect(root.scheduler.getRun(run.id)?.status).toBe('CANCELLED')
    expect(root.scheduler.listGraphMembers(run.id).map(member => member.status)).toEqual(['CANCELLED', 'CANCELLED'])
    const before = root.scheduler.listExecutions(run.id)
    await close(root)
    const invoked = vi.fn(async () => null)
    const restarted = await context(path, invoked)
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.listExecutions(run.id)).toEqual(before)
    expect(invoked).not.toHaveBeenCalled()
  })

  it('retries within one member execution and releases dependants only after success', async () => {
    const calls: string[] = []
    const root = await context(await databasePath(), async input => {
      calls.push(input.value as string)
      if (input.value === 'first' && calls.length === 1) throw new Error('try again')
      return input
    })
    const run = publish(root, source([node('first', {}, { retry: { maxAttempts: 2, backoffMs: 0 } }), node('after')], [edge('graph', 'first'), edge('first', 'after')]))
    await root.scheduler.dispatchUntilIdle()
    expect(calls).toEqual(['first', 'first', 'after'])
    expect(root.scheduler.listExecutions(run.id).filter(execution => execution.instructionId === 'first')).toHaveLength(1)
    expect(root.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['FAILED', 'SUCCEEDED', 'SUCCEEDED'])
  })

  it.each([true, false])('restores interrupted member identity across SQLite reopen (retry safe %s)', async retrySafe => {
    const path = await databasePath(), root = await context(path, undefined, retrySafe)
    const run = publish(root, source([node('first'), node('after')], [edge('graph', 'first'), edge('first', 'after')]))
    await root.scheduler.dispatchUntilIdle()
    const member = root.scheduler.listGraphMembers(run.id).find(member => member.nodeId === 'first')!
    const now = new Date().toISOString()
    root.database.db.prepare("UPDATE executions SET status = 'RUNNING', blocked_reason = NULL WHERE id = ?").run(member.executionId)
    root.database.db.prepare("INSERT INTO attempts (id, execution_id, number, status, provider_ref, started_at) VALUES ('interrupted', ?, 1, 'RUNNING', 'test:graph@1', ?)").run(member.executionId, now)
    await close(root)
    const calls: string[] = []
    const restarted = await context(path, async input => { calls.push(input.value as string); return input }, retrySafe)
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.listGraphMembers(run.id).find(next => next.nodeId === 'first')?.executionId).toBe(member.executionId)
    if (retrySafe) {
      expect(calls).toEqual(['first', 'after'])
      expect(restarted.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
      expect(restarted.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['INTERRUPTED', 'SUCCEEDED', 'SUCCEEDED'])
    } else {
      expect(calls).toEqual([])
      expect(restarted.scheduler.getRun(run.id)?.status).toBe('RUNNING')
      expect(restarted.scheduler.listGraphMembers(run.id).find(next => next.nodeId === 'first')).toMatchObject({ status: 'BLOCKED', blockedReason: 'OUTCOME_UNKNOWN' })
      expect(restarted.scheduler.listGraphMembers(run.id).find(next => next.nodeId === 'after')).toMatchObject({ status: 'PENDING' })
    }
  })

  it('recovers persisted skip and a completed member after reopen without duplicate dispatch or events', async () => {
    const path = await databasePath(), root = await context(path)
    const run = publish(root, source([
      { type: 'condition', id: 'choice', condition: literal(true) }, node('yes'), node('no'),
      { type: 'merge', id: 'selected', mode: 'selected', inputs: ['yes', 'no'] }, node('after', { from: ref('steps.selected') }),
    ], [edge('graph', 'choice'), edge('choice', 'yes', 'in', 'true'), edge('choice', 'no', 'in', 'false'), edge('yes', 'selected', 'yes'), edge('no', 'selected', 'no'), edge('selected', 'after')], ref('steps.selected')))
    await root.scheduler.dispatchUntilIdle()
    const yes = root.scheduler.listGraphMembers(run.id).find(member => member.nodeId === 'yes')!
    root.database.db.prepare("UPDATE executions SET status = 'COMPLETED', output_json = '[]', blocked_reason = NULL WHERE id = ?").run(yes.executionId)
    await close(root)
    const calls: string[] = []
    const restarted = await context(path, async input => { calls.push(input.value as string); return input })
    await restarted.scheduler.dispatchUntilIdle()
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(calls).toEqual(['after'])
    expect(restarted.scheduler.listGraphMembers(run.id).find(member => member.nodeId === 'yes')?.executionId).toBe(yes.executionId)
    expect(restarted.scheduler.listExecutions(run.id).filter(execution => execution.instructionId === 'selected')).toHaveLength(1)
    expect(restarted.scheduler.listEvents(run.id).filter(event => event.type === 'GraphMemberSkipped')).toHaveLength(1)
    expect(outputs(restarted, run.id).__complete).toEqual([])
  })

  it('defensively rejects multiple successful selected inputs instead of choosing one', async () => {
    const calls: string[] = []
    const root = await context(await databasePath(), async input => { calls.push(input.value as string); return input })
    const run = publish(root, source([
      { type: 'condition', id: 'choice', condition: literal(true) }, node('yes'), node('no'),
      { type: 'merge', id: 'selected', mode: 'selected', inputs: ['yes', 'no'] }, node('after'),
    ], [edge('graph', 'choice'), edge('choice', 'yes', 'in', 'true'), edge('choice', 'no', 'in', 'false'), edge('yes', 'selected', 'yes'), edge('no', 'selected', 'no'), edge('selected', 'after')]))
    const snapshot = root.automations.getExecutionSnapshot(run.revisionId)!
    const graph = snapshot.compiledPlan.instructions.graph!
    if (graph.op !== 'graph_scope') throw new Error('graph scope expected')
    // Corrupt a valid frozen plan to exercise the runtime invariant separately from compiler validation.
    graph.edges.find(edge => edge.to.nodeId === 'no')!.from.port = 'true'
    root.database.db.prepare('UPDATE automation_revisions SET compiled_plan_json = ? WHERE id = ?').run(JSON.stringify(snapshot.compiledPlan), run.revisionId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(calls.sort()).toEqual(['no', 'yes'])
    expect(root.scheduler.listExecutions(run.id).some(execution => ['selected', 'after'].includes(execution.instructionId))).toBe(false)
    expect(JSON.stringify(root.scheduler.listEvents(run.id))).toContain('multiple successful')
  })

  it.each([[3, 3, 3], [1, 2, 2], [2, 1, 1], [2, 2, 3]])('rejects persisted unsupported protocol/IR %s/%s/%s before calling providers', async (protocol, ir, planIr) => {
    const invoke = vi.fn(async () => null)
    const root = await context(await databasePath(), invoke)
    const run = publish(root, source([node('first')], [edge('graph', 'first')]))
    const snapshot = root.automations.getExecutionSnapshot(run.revisionId)!
    snapshot.compiledPlan.irVersion = planIr
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = ?, ir_version = ?, compiled_plan_json = ? WHERE id = ?').run(protocol, ir, JSON.stringify(snapshot.compiledPlan), run.revisionId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(root.scheduler.listExecutions(run.id)).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
    expect(JSON.stringify(root.scheduler.listEvents(run.id))).toContain('unsupported execution snapshot')
  })

  it('keeps a graph member binding inside its scope when another execution shares the instruction id', async () => {
    const path = await databasePath(), root = await context(path)
    const run = publish(root, source([node('first'), node('after', { from: ref('steps.first') })], [edge('graph', 'first'), edge('first', 'after')]))
    await root.scheduler.dispatchUntilIdle()
    const first = root.scheduler.listGraphMembers(run.id).find(member => member.nodeId === 'first')!
    root.database.db.prepare("UPDATE executions SET status = 'COMPLETED', output_json = ?, blocked_reason = NULL WHERE id = ?").run(JSON.stringify('correct-scope'), first.executionId)
    root.database.db.prepare(`INSERT INTO executions (id, run_id, instruction_id, status, output_json, generation, created_at, updated_at)
      VALUES ('unrelated-scope', ?, 'first', 'COMPLETED', '"wrong-scope"', 0, '9999', '9999')`).run(run.id)
    await close(root)
    const received: NumenValue[] = []
    const restarted = await context(path, async input => { received.push(input.from!); return input })
    await restarted.scheduler.dispatchUntilIdle()
    expect(received).toEqual(['correct-scope'])
  })

  it('uses the global concurrency limit for ready graph members', async () => {
    let active = 0, maximum = 0, started = 0
    const release = deferred()
    const root = await context(await databasePath(), async () => {
      started += 1; active += 1; maximum = Math.max(maximum, active)
      await release.promise
      active -= 1
      return null
    })
    const nodes = Array.from({ length: 20 }, (_, index) => node(`member${index}`))
    const run = publish(root, source(nodes, nodes.map(node => edge('graph', node.id))))
    const task = root.scheduler.dispatchUntilIdle()
    try {
      await vi.waitFor(() => expect(started).toBe(16))
      expect(maximum).toBe(16)
      release.resolve(); await task
      expect(started).toBe(20)
      expect(maximum).toBe(16)
      expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    } finally { release.resolve(); await task }
  })

  it('does not release dependants after an unsafe timeout with an unknown outcome', async () => {
    const never = deferred(), calls: string[] = []
    const root = await context(await databasePath(), async input => { calls.push(input.value as string); await never.promise; return null }, false)
    const run = publish(root, source([node('first', {}, { timeoutMs: 10 }), node('after')], [edge('graph', 'first'), edge('first', 'after')]))
    await root.scheduler.dispatchUntilIdle()
    expect(calls).toEqual(['first'])
    expect(root.scheduler.getRun(run.id)?.status).toBe('RUNNING')
    expect(root.scheduler.listGraphMembers(run.id).find(member => member.nodeId === 'first')).toMatchObject({ status: 'BLOCKED', blockedReason: 'OUTCOME_UNKNOWN' })
    expect(root.scheduler.listGraphMembers(run.id).find(member => member.nodeId === 'after')).toMatchObject({ status: 'PENDING' })
    never.resolve()
  })


  it('fails a persisted waiting graph with an unsupported snapshot during recovery before resolving providers', async () => {
    const path = await databasePath(), root = await context(path)
    const run = publish(root, source([node('first'), node('after')], [edge('graph', 'first'), edge('first', 'after')]))
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.listGraphMembers(run.id).find(member => member.nodeId === 'first')?.status).toBe('BLOCKED')
    const snapshot = root.automations.getExecutionSnapshot(run.revisionId)!
    snapshot.compiledPlan.irVersion = 3
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = 3, ir_version = 3, compiled_plan_json = ? WHERE id = ?').run(JSON.stringify(snapshot.compiledPlan), run.revisionId)
    await close(root)
    const invoke = vi.fn(async () => null)
    const restarted = await context(path, invoke)
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(restarted.scheduler.listGraphMembers(run.id).map(member => member.status)).toEqual(['CANCELLED', 'CANCELLED'])
    expect(invoke).not.toHaveBeenCalled()
  })


  it.each((['success', 'failure', 'timeout'] as const).flatMap(outcome => [false, true].map(cancelled => ({ outcome, cancelled }))))('fences a superseded $outcome result while another scheduler owns the newer attempt (cancelled $cancelled)', async ({ outcome, cancelled }) => {
    const path = await databasePath(), oldStarted = deferred(), newStarted = deferred(), oldRelease = deferred(), newRelease = deferred()
    if (outcome === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let staleOutput: NumenValue = 'OLD ATTEMPT'
    const first = await context(path, async () => {
      oldStarted.resolve(); await oldRelease.promise
      if (outcome === 'failure') throw new Error('STALE FAILURE')
      return staleOutput
    })
    const resource = await first.resources.stage({ name: 'stale.txt', mediaType: 'text/plain', content: Buffer.from('stale result') })
    staleOutput = resource.ref
    const run = publish(first, source([node('one', {}, outcome === 'timeout' ? { timeoutMs: 100 } : undefined)], [edge('graph', 'one')], ref('steps.one')))
    const firstTask = first.scheduler.dispatchUntilIdle()
    let secondTask: Promise<number> | undefined
    try {
      await oldStarted.promise
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(60)
      const second = await context(path, async () => { newStarted.resolve(); await newRelease.promise; return 'NEW ATTEMPT' })
      secondTask = second.scheduler.dispatchUntilIdle()
      await newStarted.promise
      expect(second.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['INTERRUPTED', 'RUNNING'])
      expect(second.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'one')?.generation).toBe(2)
      if (cancelled) second.scheduler.cancelRun(run.id)
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(40)
      else oldRelease.resolve()
      await firstTask
      expect(second.scheduler.getRun(run.id)?.status).toBe(cancelled ? 'CANCELLED' : 'RUNNING')
      expect(second.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'one')).toMatchObject({ status: cancelled ? 'CANCELLED' : 'RUNNING', generation: 2 })
      expect(second.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['INTERRUPTED', cancelled ? 'ABORTED' : 'RUNNING'])
      expect(first.database.db.prepare('SELECT COUNT(*) AS count FROM resource_owners WHERE resource_id = ?').get(resource.id)).toEqual({ count: 0 })
      expect(second.scheduler.listEvents(run.id).some(event => ['ExecutionCompleted', 'AttemptFailed', 'AttemptTimedOut'].includes(event.type))).toBe(false)
      newRelease.resolve(); await secondTask
      expect(second.scheduler.getRun(run.id)?.status).toBe(cancelled ? 'CANCELLED' : 'COMPLETED')
      expect(outputs(second, run.id).__complete).toBe(cancelled ? undefined : 'NEW ATTEMPT')
      expect(second.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['INTERRUPTED', cancelled ? 'ABORTED' : 'SUCCEEDED'])
      expect(first.database.db.prepare('SELECT COUNT(*) AS count FROM resource_owners WHERE resource_id = ?').get(resource.id)).toEqual({ count: 0 })
    } finally {
      oldRelease.resolve(); newRelease.resolve()
      await Promise.allSettled([firstTask, ...(secondTask ? [secondTask] : [])])
      vi.useRealTimers()
    }
  })


  it.each(['graph-opcode-in-v1', 'graph-source-in-v1', 'unknown-opcode-in-v2'] as const)('rejects %s before executing a frozen plan', async corruption => {
    const invoke = vi.fn(async () => null)
    const root = await context(await databasePath(), invoke)
    const run = publish(root, source([node('first')], [edge('graph', 'first')]))
    const snapshot = root.automations.getExecutionSnapshot(run.revisionId)!
    if (corruption !== 'unknown-opcode-in-v2') {
      snapshot.compiledPlan.irVersion = 1
      if (corruption === 'graph-opcode-in-v1') snapshot.source.flow = { type: 'block', id: 'legacy', steps: [] }
      if (corruption === 'graph-source-in-v1') {
        const first = snapshot.compiledPlan.instructions.first!
        if (first.op !== 'invoke') throw new Error('invoke expected')
        snapshot.compiledPlan = { irVersion: 1, entry: 'first', instructions: { first: { ...first, next: '__complete' }, __complete: { op: 'complete', id: '__complete' } } }
      }
    } else {
      ;(snapshot.compiledPlan.instructions as Record<string, unknown>).unsupported = { op: 'future_instruction', id: 'unsupported' }
    }
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = ?, ir_version = ?, compiled_plan_json = ?, source_json = ? WHERE id = ?')
      .run(snapshot.compiledPlan.irVersion, snapshot.compiledPlan.irVersion, JSON.stringify(snapshot.compiledPlan), JSON.stringify(snapshot.source), run.revisionId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(root.scheduler.listExecutions(run.id)).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })


  it('rejects a current generation result after durable cancellation intent but before propagation', async () => {
    const started = deferred(), release = deferred()
    let output: NumenValue = null
    const root = await context(await databasePath(), async () => { started.resolve(); await release.promise; return output })
    const resource = await root.resources.stage({ name: 'cancelled.txt', mediaType: 'text/plain', content: Buffer.from('cancelled result') })
    output = resource.ref
    const run = publish(root, source([node('one')], [edge('graph', 'one')], ref('steps.one')))
    const task = root.scheduler.dispatchUntilIdle()
    try {
      await started.promise
      // Persisted boundary between cancelRun's intent transaction and its propagation transaction.
      root.database.db.prepare("UPDATE runs SET status = 'CANCELLING', cancel_reason = 'USER' WHERE id = ?").run(run.id)
      release.resolve(); await task
      expect(root.scheduler.getRun(run.id)?.status).toBe('CANCELLED')
      expect(root.scheduler.listExecutions(run.id).find(execution => execution.instructionId === 'one')?.status).toBe('CANCELLED')
      expect(root.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['ABORTED'])
      expect(root.resources.listOwners(resource.id)).toEqual([])
      expect(root.scheduler.listEvents(run.id).some(event => event.type === 'ExecutionCompleted')).toBe(false)
    } finally { release.resolve(); await task }
  })

})
