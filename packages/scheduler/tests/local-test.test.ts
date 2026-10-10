import { AutomationService, LocalTestError, OutputSampleError } from '@numenjs/automation'
import { CapabilityRegistry, type AutomationSource, type CapabilityDefinition, type GraphSource, type LocalTestRequest, type NumenValue } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '@numenjs/resources'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SchedulerService } from '../src/service.js'

const directories: string[] = [], contexts = new Set<Context>()
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of contexts) await root.fiber.dispose()
  contexts.clear()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function directory() { const path = await mkdtemp(join(tmpdir(), 'numen-local-test-')); directories.push(path); return path }
const publicText = () => z.string().extra('extra', { numen: { execution: 'public' } })
function definition(kind: 'query' | 'transform' | 'write', version = 1, publicOutput = true): CapabilityDefinition {
  return { id: `test:${kind}`, version, kind: kind === 'query' ? 'query' : 'action', title: kind,
    input: z.object({ value: z.string().required() }), output: publicOutput ? publicText() : z.string(),
    semantics: { sideEffect: kind === 'write', idempotent: kind !== 'write', retrySafe: kind !== 'write' } }
}
async function context(path: string, calls: string[], invoke?: (kind: string, input: string) => Promise<NumenValue>, publicOutput = true) {
  const root = new Context(); contexts.add(root)
  await root.plugin(DatabaseService, { path: join(path, 'db') })
  await root.plugin(CapabilityRegistry)
  for (const kind of ['query', 'transform', 'write'] as const) for (const version of [1, 2]) {
    const contract = definition(kind, version, publicOutput)
    root.capabilities.define(root, contract)
    root.capabilities.provide(root, contract, { invoke: async ({ input }) => {
      const value = (input as { value: string }).value
      calls.push(`${kind}:${value}`)
      return invoke ? invoke(kind, value) : value
    } })
  }
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(path, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  return root
}
const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from: { nodeId: from, port: from === 'graph' ? 'start' : 'out' }, to: { nodeId: to, port: 'in' } })
function source(): AutomationSource {
  return { triggers: [], flow: { type: 'graph', id: 'graph', version: 1, nodes: [
    { type: 'capability', id: 'a', capability: { id: 'test:query', version: 1 }, input: { value: { type: 'literal', value: 'A' } } },
    { type: 'capability', id: 'b', capability: { id: 'test:query', version: 1 }, input: { value: { type: 'literal', value: 'B' } } },
    { type: 'capability', id: 'transform', capability: { id: 'test:transform', version: 1 }, input: { value: { type: 'template', parts: [{ ref: 'steps.a' }, '+', { ref: 'steps.b' }] } } },
    { type: 'capability', id: 'write', capability: { id: 'test:write', version: 1 }, input: { value: { type: 'ref', path: 'steps.transform' } } },
  ], edges: [edge('graph', 'a'), edge('graph', 'b'), edge('a', 'transform'), edge('b', 'transform'), edge('transform', 'write')], output: { type: 'ref', path: 'steps.write' } } }
}
function request(automationId: string, sampleIds: string[] = [], overrides: Partial<LocalTestRequest> = {}): LocalTestRequest {
  return { automationId, expectedDraftVersion: 1, targetNodeId: 'transform', mode: 'only-node', sampleIds, input: {}, trigger: null, ...overrides }
}
function samples(root: Context, automationId: string) {
  return ['a', 'b'].map(nodeId => root.automations.createOutputSample({ automationId, expectedDraftVersion: 1, nodeId, value: `fixed-${nodeId}` }))
}
async function start(root: Context, input: LocalTestRequest, requestId = 'local-test-request-01') {
  const preview = root.automations.previewLocalTest(input)
  return root.scheduler.startLocalTest({ ...input, previewHash: preview.previewHash, requestId })
}
const counts = (root: Context) => ['runs', 'automation_revisions', 'manual_run_requests', 'resource_owners'].map(table =>
  (root.database.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total)
const result = (root: Context, runId: string) => root.scheduler.listExecutions(runId).find(execution => execution.instructionId === '__complete')?.output
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

describe('persisted samples and explicit local tests', () => {
  it('runs only the selected Capability repeatedly and leaves formal calls, activation, and immutable snapshots isolated', async () => {
    const calls: string[] = [], root = await context(await directory(), calls)
    const { automation } = root.automations.create({ name: 'Scoped', source: source() })
    const revision = root.automations.publishDraft(automation.id, 1)
    root.automations.activateRevision(automation.id, revision.id)
    const before = root.automations.get(automation.id), fixed = samples(root, automation.id)
    const input = request(automation.id, fixed.map(sample => sample.id))
    const preview = root.automations.previewLocalTest(input)
    expect(preview.calls).toEqual([{ nodeId: 'transform', capability: { id: 'test:transform', version: 1 }, sideEffect: false, retrySafe: true, inputValidation: 'validated' }])
    expect(preview.externalWrites).toEqual([])
    expect(preview.substitutions.map(item => item.nodeId)).toEqual(['a', 'b'])
    const first = await start(root, input)
    await root.scheduler.dispatchUntilIdle()
    const second = await start(root, input, 'local-test-request-02')
    await root.scheduler.dispatchUntilIdle()
    expect(calls).toEqual(['transform:fixed-a+fixed-b', 'transform:fixed-a+fixed-b'])
    expect(result(root, second.id)).toBe('fixed-a+fixed-b')
    const executions = root.scheduler.listExecutions(first.id)
    expect(executions.filter(execution => execution.sampleId).map(execution => execution.sampleId).sort()).toEqual(fixed.map(sample => sample.id).sort())
    expect(root.scheduler.listAttempts(first.id)).toHaveLength(1)
    expect(root.scheduler.listEvents(first.id).filter(event => event.type === 'ExecutionSampled')).toHaveLength(2)
    const snapshot = root.automations.getExecutionSnapshot(first.revisionId)!
    expect(snapshot).toMatchObject({ purpose: 'draft-test', localTest: { mode: 'only-node', samples: fixed } })
    expect(snapshot.source).toEqual(source())
    for (const sample of fixed) expect(root.automations.deleteOutputSample(automation.id, sample.id)).toBe(true)
    expect(root.automations.getExecutionSnapshot(first.revisionId)).toEqual(snapshot)
    expect((await root.scheduler.startLocalTest({ ...input, previewHash: preview.previewHash, requestId: 'local-test-request-01' })).id).toBe(first.id)
    const formal = root.scheduler.startManual(automation.id)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(formal.id)?.status).toBe('COMPLETED')
    expect(calls.slice(2).sort()).toEqual(['query:A', 'query:B', 'transform:A+B', 'write:A+B'].sort())
    expect(root.scheduler.listExecutions(formal.id).some(execution => execution.sampleId)).toBe(false)
    expect(root.automations.get(automation.id)).toEqual(before)
    expect(root.automations.listRevisions(automation.id)).toEqual([revision])
  })

  it('previews the actual dependency closure, excludes downstream effects, and marks dynamic inputs for runtime validation', async () => {
    const calls: string[] = [], root = await context(await directory(), calls)
    const { automation } = root.automations.create({ name: 'Closure', source: source() })
    const preview = root.automations.previewLocalTest(request(automation.id, [], { mode: 'to-node' }))
    expect(preview.scope.nodeIds).toEqual(['a', 'b', 'transform'])
    expect(preview.calls.every(call => call.inputValidation === 'runtime')).toBe(true)
    expect(preview.externalWrites).toEqual([])
    const run = await start(root, preview.request)
    await root.scheduler.dispatchUntilIdle()
    expect(calls.sort()).toEqual(['query:A', 'query:B', 'transform:A+B'].sort())
    expect(result(root, run.id)).toBe('A+B')
    expect(root.automations.previewLocalTest(request(automation.id, [], { mode: 'to-node', targetNodeId: 'write' })).externalWrites).toEqual(['write'])
    expect(() => root.automations.previewLocalTest(request(automation.id))).toThrow(LocalTestError)
  })

  it('retains explicit transitive data dependencies when a middle output is substituted', async () => {
    const calls: string[] = [], root = await context(await directory(), calls)
    const candidate = source(), graph = candidate.flow as GraphSource
    graph.edges = [edge('graph', 'a'), edge('a', 'b'), edge('b', 'transform'), edge('transform', 'write')]
    const { automation } = root.automations.create({ name: 'Transitive', source: candidate })
    const sample = root.automations.createOutputSample({ automationId: automation.id, expectedDraftVersion: 1, nodeId: 'b', value: 'cached-B' })
    expect(() => root.automations.previewLocalTest(request(automation.id, [sample.id]))).toThrow('every upstream dependency')
    const run = await start(root, request(automation.id, [sample.id], { mode: 'to-node' }))
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(calls).toEqual(['query:A', 'transform:A+cached-B'])
    expect(result(root, run.id)).toBe('A+cached-B')
  })

  it('persists manual provenance and reuses the same contract after fresh Schema UIDs on restart', async () => {
    const path = await directory(), root = await context(path, [])
    const { automation } = root.automations.create({ name: 'Restart sample', source: source() })
    const fixed = samples(root, automation.id)
    expect(fixed[0]).toMatchObject({ automationId: automation.id, nodeId: 'a', integrity: 'complete', provenance: { kind: 'manual', draftVersion: 1 } })
    await root.fiber.dispose(); contexts.delete(root)
    const calls: string[] = [], restarted = await context(path, calls)
    expect(restarted.automations.listOutputSamples(automation.id).sort((a, b) => a.nodeId.localeCompare(b.nodeId)))
      .toEqual(fixed.map(({ value: _value, contract: _contract, ...metadata }) => metadata))
    for (const sample of fixed) expect(restarted.automations.getOutputSample(automation.id, sample.id)).toEqual(sample)
    const run = await start(restarted, request(automation.id, fixed.map(sample => sample.id)))
    await restarted.scheduler.dispatchUntilIdle()
    expect(result(restarted, run.id)).toBe('fixed-a+fixed-b')
    expect(calls).toEqual(['transform:fixed-a+fixed-b'])
  })

  it('imports complete real execution data with snapshot provenance and refuses caller-supplied projections', async () => {
    const root = await context(await directory(), [])
    const { automation } = root.automations.create({ name: 'Import', source: source() })
    const run = await start(root, request(automation.id, [], { mode: 'to-node' }))
    await root.scheduler.dispatchUntilIdle()
    const execution = root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'a')!
    const sample = root.automations.importOutputSample({ automationId: automation.id, executionId: execution.id })
    expect(sample).toMatchObject({ value: 'A', integrity: 'complete', provenance: { kind: 'execution', snapshotId: run.revisionId, runId: run.id, executionId: execution.id } })
    expect(() => root.automations.importOutputSample({ automationId: automation.id, executionId: execution.id, value: '[Redacted]' } as never)).toThrow('never projected data')
    const fixed = samples(root, automation.id)
    const local = await start(root, request(automation.id, fixed.map(item => item.id)), 'local-import-sampled-01')
    await root.scheduler.dispatchUntilIdle()
    const sampled = root.scheduler.listExecutions(local.id).find(item => item.sampleId)!
    expect(() => root.automations.importOutputSample({ automationId: automation.id, executionId: sampled.id })).toThrow('real Capability')
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = 99 WHERE id = ?').run(run.revisionId)
    expect(() => root.automations.importOutputSample({ automationId: automation.id, executionId: execution.id })).toThrow('protocol is unsupported')
  })

  it.each([['private', 'ordinary'], ['public', '[Redacted]'], ['public', 'x'.repeat(1024 * 1024 + 1)]] as const)('rejects %s or incomplete persisted import (%#)', async (classification, value) => {
    const root = await context(await directory(), [], async () => value, classification === 'public')
    const candidate = source(), graph = candidate.flow as GraphSource
    graph.nodes = graph.nodes.slice(0, 1); graph.edges = [edge('graph', 'a')]; graph.output = { type: 'ref', path: 'steps.a' }
    const { automation } = root.automations.create({ name: 'Unusable data', source: candidate })
    const run = await start(root, request(automation.id, [], { targetNodeId: 'a', mode: 'to-node' }))
    await root.scheduler.dispatchUntilIdle()
    const execution = root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'a')!
    expect(() => root.automations.importOutputSample({ automationId: automation.id, executionId: execution.id })).toThrow(OutputSampleError)
    expect(root.automations.listOutputSamples(automation.id)).toEqual([])
  })

  it('gates historical sample imports by protocol and stored bytes before decoding snapshots', async () => {
    const root = await context(await directory(), [])
    const { automation } = root.automations.create({ name: 'Historical import bounds', source: source() })
    const run = await start(root, request(automation.id, [], { mode: 'to-node' }))
    await root.scheduler.dispatchUntilIdle()
    const execution = root.scheduler.listExecutions(run.id).find(item => item.instructionId === 'a')!
    const original = root.database.db.prepare('SELECT source_json FROM automation_revisions WHERE id = ?').get(run.revisionId) as { source_json: string }
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = 99, source_json = ? WHERE id = ?')
      .run('future-format-private-fragment', run.revisionId)
    expect(() => root.automations.importOutputSample({ automationId: automation.id, executionId: execution.id }))
      .toThrow(expect.objectContaining({ code: 'SAMPLE_PROTOCOL_UNSUPPORTED' }))
    root.database.db.prepare('UPDATE automation_revisions SET protocol_version = 2, ir_version = 1 WHERE id = ?').run(run.revisionId)
    expect(() => root.automations.importOutputSample({ automationId: automation.id, executionId: execution.id }))
      .toThrow(expect.objectContaining({ code: 'SAMPLE_PROTOCOL_UNSUPPORTED' }))
    root.database.db.prepare('UPDATE automation_revisions SET ir_version = 2, source_json = ?, presentation_json = ? WHERE id = ?')
      .run(original.source_json, JSON.stringify({ historical: 'x'.repeat(8 * 1024 * 1024) }), run.revisionId)
    expect(() => root.automations.importOutputSample({ automationId: automation.id, executionId: execution.id }))
      .toThrow(expect.objectContaining({ code: 'SAMPLE_LIMIT' }))
    expect(root.automations.listOutputSamples(automation.id)).toEqual([])
  })

  it('rejects unknown local-test scope versions before real calls even without sample substitutions', async () => {
    const calls: string[] = [], root = await context(await directory(), calls)
    const { automation } = root.automations.create({ name: 'Future local-test scope', source: source() })
    const run = await start(root, request(automation.id, [], { mode: 'to-node' }))
    root.database.db.prepare("UPDATE automation_revisions SET local_test_json = json_set(local_test_json, '$.version', 99) WHERE id = ?").run(run.revisionId)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(calls).toEqual([])
    expect(root.scheduler.listAttempts(run.id)).toEqual([])
  })

  it.each([{ nested: [{ $resource: 'temporary' }] }, '[Hidden: field is not classified for inspection]', '[Inspection limit reached]', 42])('rejects resource, incomplete, or schema-invalid manual sample %#', async value => {
    const root = await context(await directory(), [])
    const { automation } = root.automations.create({ name: 'Invalid sample', source: source() })
    expect(() => root.automations.createOutputSample({ automationId: automation.id, expectedDraftVersion: 1, nodeId: 'a', value })).toThrow(OutputSampleError)
    expect(root.automations.listOutputSamples(automation.id)).toEqual([])
  })

  it('rejects deleted samples, changed contracts, invalid fixed inputs and stale previews before persistence', async () => {
    const root = await context(await directory(), []), candidate = source()
    const { automation } = root.automations.create({ name: 'Stale', source: candidate })
    const fixed = samples(root, automation.id), input = request(automation.id, fixed.map(item => item.id))
    const preview = root.automations.previewLocalTest(input), before = counts(root)
    await expect(root.scheduler.startLocalTest({ ...input, trigger: { changed: true }, previewHash: preview.previewHash, requestId: 'local-stale-preview-01' })).rejects.toThrow('stale')
    const graph = candidate.flow as GraphSource
    const node = graph.nodes[0]!
    if (node.type !== 'capability') throw Error('fixture')
    node.capability.version = 2
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: candidate })
    expect(() => root.automations.previewLocalTest({ ...input, expectedDraftVersion: 2 })).toThrow('no longer matches')
    expect(counts(root)).toEqual(before)
    root.automations.deleteOutputSample(automation.id, fixed[0]!.id)
    expect(() => root.automations.previewLocalTest({ ...input, expectedDraftVersion: 2 })).toThrow('deleted')
  })

  it('rechecks sample deletion after asynchronous resource preflight and rolls back all acceptance identities', async () => {
    const root = await context(await directory(), []), entered = deferred(), release = deferred()
    const { automation } = root.automations.create({ name: 'Delete race', source: source() })
    const fixed = samples(root, automation.id), resource = await root.resources.stage({ name: 'input', mediaType: 'text/plain', content: Buffer.from('test') })
    const input = request(automation.id, fixed.map(item => item.id), { input: { file: resource.ref } })
    const preview = root.automations.previewLocalTest(input), before = counts(root)
    const real = root.resources.preflight.bind(root.resources)
    vi.spyOn(root.resources, 'preflight').mockImplementation(async id => { await real(id); entered.resolve(); await release.promise })
    const launch = root.scheduler.startLocalTest({ ...input, previewHash: preview.previewHash, requestId: 'local-delete-race-01' })
    await entered.promise
    root.automations.deleteOutputSample(automation.id, fixed[0]!.id)
    release.resolve()
    await expect(launch).rejects.toThrow('deleted')
    expect(counts(root)).toEqual(before)
  })

  it('recovers the accepted local-test identity across concurrent preflights even after its samples are deleted', async () => {
    const path = await directory(), first = await context(path, []), entered = deferred(), release = deferred()
    const { automation } = first.automations.create({ name: 'Concurrent local acceptance', source: source() })
    const fixed = samples(first, automation.id), resource = await first.resources.stage({ name: 'request', mediaType: 'text/plain', content: Buffer.from('fixed') })
    const input = request(automation.id, fixed.map(sample => sample.id), { input: { file: resource.ref } })
    const preview = first.automations.previewLocalTest(input)
    const acceptedRequest = { ...input, previewHash: preview.previewHash, requestId: 'local-concurrent-acceptance-01' }
    const real = first.resources.preflight.bind(first.resources)
    vi.spyOn(first.resources, 'preflight').mockImplementation(async id => { await real(id); entered.resolve(); await release.promise })
    const pending = first.scheduler.startLocalTest(acceptedRequest)
    try {
      await entered.promise
      const calls: string[] = [], second = await context(path, calls)
      const accepted = await second.scheduler.startLocalTest(acceptedRequest)
      for (const sample of fixed) second.automations.deleteOutputSample(automation.id, sample.id)
      release.resolve()
      expect((await pending).id).toBe(accepted.id)
      expect(second.database.db.prepare('SELECT id FROM runs').all()).toEqual([{ id: accepted.id }])
      expect(second.database.db.prepare("SELECT id FROM automation_revisions WHERE purpose = 'draft-test'").all()).toEqual([{ id: accepted.revisionId }])
      await second.scheduler.dispatchUntilIdle()
      expect(result(second, accepted.id)).toBe('fixed-a+fixed-b')
      expect(calls).toEqual(['transform:fixed-a+fixed-b'])
      expect(second.scheduler.listAttempts(accepted.id)).toHaveLength(1)
      expect(second.scheduler.listEvents(accepted.id).filter(event => event.type === 'ExecutionSampled')).toHaveLength(2)
    } finally { release.resolve(); await pending.catch(() => {}) }
  })

  it('does not replay an interrupted unsafe target and fences its late result after cancellation', async () => {
    const path = await directory(), calls: string[] = [], started = deferred(), release = deferred()
    const first = await context(path, calls, async (kind, value) => { if (kind === 'write') { started.resolve(); await release.promise }; return value })
    const { automation } = first.automations.create({ name: 'Unsafe local target', source: source() })
    const sample = first.automations.createOutputSample({ automationId: automation.id, expectedDraftVersion: 1, nodeId: 'transform', value: 'fixed transform' })
    const input = request(automation.id, [sample.id], { targetNodeId: 'write' })
    expect(first.automations.previewLocalTest(input).externalWrites).toEqual(['write'])
    const run = await start(first, input), pending = first.scheduler.dispatchUntilIdle()
    try {
      await started.promise
      const secondCalls: string[] = [], second = await context(path, secondCalls)
      await second.scheduler.dispatchUntilIdle()
      expect(secondCalls).toEqual([])
      expect(second.scheduler.listExecutions(run.id).find(item => item.instructionId === 'write')).toMatchObject({ status: 'BLOCKED', blockedReason: 'OUTCOME_UNKNOWN' })
      expect(second.scheduler.listAttempts(run.id).map(attempt => attempt.status)).toEqual(['OUTCOME_UNKNOWN'])
      second.scheduler.cancelRun(run.id)
      await second.scheduler.dispatchUntilIdle()
      release.resolve(); await pending
      expect(second.scheduler.getRun(run.id)?.status).toBe('CANCELLED')
      expect(second.scheduler.listExecutions(run.id).find(item => item.instructionId === 'write')?.status).toBe('CANCELLED')
      expect(calls).toEqual(['write:fixed transform'])
    } finally { release.resolve(); await pending }
  })

  it('rejects oversized selected samples before constructing or accepting a local snapshot', async () => {
    const root = await context(await directory(), []), candidate = source(), graph = candidate.flow as GraphSource
    graph.nodes.push({ type: 'capability', id: 'c', capability: { id: 'test:query', version: 1 }, input: { value: { type: 'literal', value: 'C' } } })
    graph.edges.push(edge('graph', 'c'), edge('c', 'transform'))
    const { automation } = root.automations.create({ name: 'Aggregate bound', source: candidate })
    const fixed = ['a', 'b', 'c'].map(nodeId => root.automations.createOutputSample({ automationId: automation.id, expectedDraftVersion: 1, nodeId, value: 'x'.repeat(950_000) }))
    const before = counts(root)
    expect(() => root.automations.previewLocalTest(request(automation.id, fixed.map(item => item.id)))).toThrow('aggregate limit')
    expect(() => root.automations.previewLocalTest(request(automation.id, Array(1024).fill(fixed[0]!.id)))).toThrow('unique sample ids')
    expect(counts(root)).toEqual(before)
    expect(root.automations.listOutputSamples(automation.id).every(item => !Object.hasOwn(item, 'value') && !Object.hasOwn(item, 'contract'))).toBe(true)
  })

  it('refuses unsupported local scope boundaries and validates dynamic fixed reference paths before launch', async () => {
    const root = await context(await directory(), []), candidate = source(), graph = candidate.flow as GraphSource
    const { automation } = root.automations.create({ name: 'Scope and field validation', source: candidate })
    const fixed = samples(root, automation.id)
    const transform = graph.nodes.find(node => node.id === 'transform')!
    if (transform.type !== 'capability') throw Error('fixture')
    transform.input.value = { type: 'ref', path: 'steps.a.missing' }
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: candidate })
    expect(() => root.automations.previewLocalTest(request(automation.id, fixed.map(item => item.id), { expectedDraftVersion: 2 }))).toThrow('Fixed target input')
    graph.nodes.unshift({ type: 'condition', id: 'choice', condition: { type: 'literal', value: true } })
    graph.edges[0] = { ...edge('choice', 'a'), from: { nodeId: 'choice', port: 'true' } }
    graph.edges.push(edge('graph', 'choice'))
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: candidate })
    expect(() => root.automations.previewLocalTest(request(automation.id, [], { mode: 'to-node', expectedDraftVersion: 3 }))).toThrow('ordinary Capability subgraph')
  })

  it('preflights Graph Source resource constants and retains their snapshot ownership', async () => {
    const root = await context(await directory(), []), candidate = source(), graph = candidate.flow as GraphSource
    const resource = await root.resources.stage({ name: 'fixed source', mediaType: 'text/plain', content: Buffer.from('source data') })
    graph.output = { type: 'literal', value: resource.ref }
    const { automation } = root.automations.create({ name: 'Graph resource source', source: candidate })
    const fixed = samples(root, automation.id)
    const run = await start(root, request(automation.id, fixed.map(item => item.id)))
    const snapshot = root.automations.getExecutionSnapshot(run.revisionId)!
    const storedWithoutLocalTest = root.database.db.prepare(`SELECT length(CAST(source_json AS BLOB)) + length(CAST(presentation_json AS BLOB))
      + length(CAST(compiled_plan_json AS BLOB)) + length(CAST(dependency_manifest_json AS BLOB)) + length(CAST(contract_snapshot_json AS BLOB)) AS bytes
      FROM automation_revisions WHERE id = ?`).get(snapshot.id) as { bytes: number }
    expect(() => root.automations.getExecutionSnapshotForInspection(snapshot.id, automation.id, storedWithoutLocalTest.bytes)).toThrow('stored data limit')
    expect(root.database.db.prepare("SELECT owner_id FROM resource_owners WHERE owner_type = 'snapshot' AND resource_id = ?").all(resource.id)).toEqual([{ owner_id: run.revisionId }])
    await root.resources.store.delete(resource.digest)
    const before = counts(root)
    await expect(start(root, request(automation.id, fixed.map(item => item.id)), 'local-resource-missing-01')).rejects.toThrow('resource')
    expect(counts(root)).toEqual(before)
  })

  it('rejects sample instructions in formal snapshots before invoking any Provider', async () => {
    const calls: string[] = [], root = await context(await directory(), calls)
    const { automation } = root.automations.create({ name: 'Formal guard', source: source() })
    const revision = root.automations.publishDraft(automation.id, 1)
    root.automations.activateRevision(automation.id, revision.id)
    revision.compiledPlan.instructions.a = { op: 'graph_value', id: 'a', sampleId: 'invalid', value: 'pretend' }
    root.database.db.prepare('UPDATE automation_revisions SET compiled_plan_json = ? WHERE id = ?').run(JSON.stringify(revision.compiledPlan), revision.id)
    const run = root.scheduler.startManual(automation.id)
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('FAILED')
    expect(calls).toEqual([])
    expect(root.scheduler.listAttempts(run.id)).toEqual([])
  })
})
