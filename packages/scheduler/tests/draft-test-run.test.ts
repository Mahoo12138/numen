import { AutomationCompileError, DraftConflictError, AutomationRevisionNotFoundError, AutomationService } from '@numenjs/automation'
import { AutomationInputValidationError, CapabilityRegistry, ControlRegistry, type AutomationSource, type NumenValue } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '../../resources/src/index.js'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManualRunRequestConflictError, SchedulerService } from '../src/index.js'

const directories: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'numen-draft-test-'))
  directories.push(result)
  return result
}

async function context(path: string) {
  const root = new Context()
  contexts.push(root)
  await root.plugin(DatabaseService, { path: join(path, 'db') })
  await root.plugin(CapabilityRegistry)
  await root.plugin(ControlRegistry)
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(path, 'resources'), gcGraceMs: 0 })
  await root.plugin(SchedulerService, { autoDispatch: false })
  return root
}

const empty: AutomationSource = { triggers: [], flow: { type: 'block', id: 'flow', steps: [] } }
const action = {
  id: 'test:resource', version: 1, kind: 'action' as const, title: 'Resource consumer',
  input: z.object({ file: z.object({ $resource: z.string().required() }).required() }), output: z.object({ value: z.string().required() }),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
}

function acceptedCounts(root: Context) {
  return Object.fromEntries(['automation_revisions', 'runs', 'run_events', 'manual_run_requests', 'resource_owners'].map(table => [table,
    (root.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  ]))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('saved Draft test Run acceptance', () => {
  it('runs never-published disabled Drafts and resolves their defaults without changing Draft, activation or release numbering', async () => {
    const root = await context(await directory())
    const source: AutomationSource = { ...empty, inputs: { message: { type: 'string', default: 'saved default' } } }
    const { automation } = root.automations.create({ name: 'Unpublished', source })
    const before = root.automations.get(automation.id), draftBefore = root.automations.getDraft(automation.id)
    const changed = vi.fn(); root.on('numen/automation-change', changed)
    const run = await root.scheduler.startDraftTest(automation.id, 1, {}, { event: 'explicit' }, 'draft-test-unpublished-01')
    const snapshot = root.automations.getExecutionSnapshot(run.revisionId)!
    expect(snapshot).toMatchObject({ purpose: 'draft-test', sourceDraftVersion: 1, source, presentation: {}, protocolVersion: 1 })
    expect(snapshot).not.toHaveProperty('number')
    expect(run).toMatchObject({ status: 'QUEUED', input: { message: 'saved default' }, trigger: { event: 'explicit' } })
    expect(root.automations.get(automation.id)).toEqual(before)
    expect(root.automations.getDraft(automation.id)).toEqual(draftBefore)
    expect(root.automations.listRevisions(automation.id)).toEqual([])
    expect(root.automations.listSummaries().find(item => item.id === automation.id)).toMatchObject({ revisionCount: 0, runCount: 1 })
    expect(root.automations.getRevision(snapshot.id)).toBeUndefined()
    expect(() => root.automations.activateRevision(automation.id, snapshot.id)).toThrow(AutomationRevisionNotFoundError)
    expect(() => root.scheduler.startRevisionTest(automation.id, snapshot.id, {}, {}, 'draft-test-as-release-01')).toThrow(AutomationRevisionNotFoundError)
    expect(changed).not.toHaveBeenCalled()
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(root.scheduler.listEvents(run.id)[0]).toMatchObject({ type: 'RunAccepted', payload: { source: 'draft-test', snapshotId: snapshot.id, revisionId: snapshot.id, sourceDraftVersion: 1, requestId: 'draft-test-unpublished-01' } })
    const published = root.automations.publishDraft(automation.id, 1)
    expect(published.number).toBe(1)
    expect(root.automations.listRevisions(automation.id).map(item => item.id)).toEqual([published.id])
    expect(() => root.scheduler.startRevisionTest(automation.id, published.id, {}, { event: 'explicit' }, 'draft-test-unpublished-01')).toThrow(ManualRunRequestConflictError)
  })

  it('uses complete raw launch content for deduplication across two connections, new requests and restart after edit/archive/compiler unload', async () => {
    const path = await directory(), root = await context(path), peer = await context(path)
    const resource = await root.resources.stage({ name: 'default', mediaType: 'text/plain', content: Buffer.from('retained') })
    const control = { kind: 'extension' as const, id: 'test:empty-control', version: 1, title: 'Empty', description: '', input: z.object({}), lower: ({ nodeId }: { nodeId: string }) => ({ type: 'block' as const, id: nodeId, steps: [] }) }
    const unload = root.controls.defineControl(root, control)
    peer.controls.defineControl(peer, control)
    const source: AutomationSource = { inputs: { file: { type: 'object', default: resource.ref } }, triggers: [], flow: { type: 'extension', id: 'extension', control: { id: control.id, version: control.version }, input: {} } }
    const { automation } = root.automations.create({ name: 'Two clients', source })
    const requestId = 'draft-test-two-connections-01'
    const [first, second] = await Promise.all([
      root.scheduler.startDraftTest(automation.id, 1, {}, { file: resource.ref }, requestId),
      peer.scheduler.startDraftTest(automation.id, 1, {}, { file: resource.ref }, requestId),
    ])
    expect(second.id).toBe(first.id)
    expect(acceptedCounts(root)).toMatchObject({ automation_revisions: 1, runs: 1, run_events: 1, manual_run_requests: 1, resource_owners: 2 })
    // Explicit default and omitted default resolve equally but are different raw requests.
    await expect(root.scheduler.startDraftTest(automation.id, 1, { file: resource.ref }, { file: resource.ref }, requestId)).rejects.toBeInstanceOf(ManualRunRequestConflictError)
    await expect(root.scheduler.startDraftTest(automation.id, 2, {}, { file: resource.ref }, requestId)).rejects.toBeInstanceOf(ManualRunRequestConflictError)
    await expect(root.scheduler.startDraftTest(automation.id, 1, {}, null, requestId)).rejects.toBeInstanceOf(ManualRunRequestConflictError)
    const independent = await root.scheduler.startDraftTest(automation.id, 1, {}, { file: resource.ref }, 'draft-test-independent-01')
    expect(independent.revisionId).not.toBe(first.revisionId)
    unload()
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: empty })
    root.automations.archive(automation.id)
    await root.fiber.dispose(); await peer.fiber.dispose()
    const restarted = await context(path)
    expect((await restarted.scheduler.startDraftTest(automation.id, 1, {}, { file: resource.ref }, requestId)).id).toBe(first.id)
    expect(restarted.scheduler.listRuns()).toHaveLength(2)
    expect(restarted.automations.getExecutionSnapshot(first.revisionId)?.source).toEqual(source)
    await expect(restarted.scheduler.startDraftTest(automation.id, 2, {}, {}, 'draft-test-new-archived-01')).rejects.toThrow('archived')
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.listRuns().every(run => run.status === 'COMPLETED')).toBe(true)
    expect(restarted.scheduler.listEvents(first.id).filter(event => event.type === 'RunAccepted')).toHaveLength(1)
  })

  it('rejects compilation, input/version validation and missing resource bytes before accepting any identity', async () => {
    const root = await context(await directory())
    const { automation } = root.automations.create({ name: 'Invalid', source: { ...empty, inputs: { required: { type: 'string', required: true } } } })
    const before = acceptedCounts(root)
    await expect(root.scheduler.startDraftTest(automation.id, 1, {}, null, 'draft-test-invalid-input-01')).rejects.toBeInstanceOf(AutomationInputValidationError)
    await expect(root.scheduler.startDraftTest(automation.id, 2, { required: 'ok' }, null, 'draft-test-invalid-version-01')).rejects.toBeInstanceOf(DraftConflictError)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: { triggers: [], flow: { type: 'capability', id: 'missing', capability: { id: 'missing:action', version: 1 }, input: {} } } })
    await expect(root.scheduler.startDraftTest(automation.id, 2, {}, null, 'draft-test-invalid-compile-01')).rejects.toBeInstanceOf(AutomationCompileError)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: empty })
    const missing = await root.resources.stage({ name: 'removed', mediaType: 'text/plain', content: Buffer.from('missing') })
    await root.resources.store.delete(missing.digest)
    await expect(root.scheduler.startDraftTest(automation.id, 3, { file: missing.ref }, null, 'draft-test-invalid-object-01')).rejects.toThrow('resource')
    await expect(root.scheduler.startDraftTest(automation.id, 3, { file: { $resource: 'missing-id' } }, null, 'draft-test-invalid-ref-01')).rejects.toThrow('resource')
    expect(acceptedCounts(root)).toEqual(before)
    expect(root.resources.get(missing.id)?.state).toBe('STAGED')
  })

  it.each(['version', 'archive', 'gc', 'unlink'] as const)('rechecks %s after asynchronous resource preflight and rolls back the complete acceptance', async mode => {
    const root = await context(await directory())
    const resource = await root.resources.stage({ name: 'race', mediaType: 'text/plain', content: Buffer.from('race'), stagingTtlMs: 0 })
    const { automation } = root.automations.create({ name: 'Race', source: empty })
    const before = acceptedCounts(root), entered = deferred(), release = deferred()
    const preflight = root.resources.preflight.bind(root.resources)
    vi.spyOn(root.resources, 'preflight').mockImplementation(async resourceId => {
      const result = await preflight(resourceId); entered.resolve(); await release.promise; return result
    })
    const accepting = root.scheduler.startDraftTest(automation.id, 1, { file: resource.ref }, null, `draft-test-race-${mode}-0001`)
    await entered.promise
    if (mode === 'version') root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: empty })
    else if (mode === 'archive') root.automations.archive(automation.id)
    else if (mode === 'gc') await root.resources.collectGarbage(new Date(Date.now() + 10_000))
    else await root.resources.store.delete(resource.digest)
    release.resolve()
    await expect(accepting).rejects.toThrow(mode === 'version' ? 'version' : mode === 'archive' ? 'archived' : 'resource')
    expect(acceptedCounts(root)).toEqual(before)
    expect(root.resources.get(resource.id)?.state).toBe(mode === 'gc' ? 'GONE' : 'STAGED')
  })

  it.each(['owner', 'event', 'request'] as const)('rolls back snapshot, Run, requests, journal and resource promotion when the %s write fails', async mode => {
    const root = await context(await directory())
    const resources = await Promise.all(['first', 'second'].map(value => root.resources.stage({ name: value, mediaType: 'text/plain', content: Buffer.from(value) })))
    const source: AutomationSource = { ...empty, inputs: { first: { type: 'object', default: resources[0]!.ref }, second: { type: 'object', default: resources[1]!.ref } } }
    const { automation } = root.automations.create({ name: 'Atomic', source })
    const before = acceptedCounts(root), changes = vi.fn(); root.on('numen/run-change', changes)
    if (mode === 'owner') {
      const commit = root.resources.commitOwner.bind(root.resources)
      vi.spyOn(root.resources, 'commitOwner').mockImplementation((resourceId, owner) => {
        const result = commit(resourceId, owner)
        if (resourceId === resources[1]!.id) throw new Error('injected owner write failure')
        return result
      })
    } else {
      const table = mode === 'event' ? 'run_events' : 'manual_run_requests'
      root.database.db.exec(`CREATE TRIGGER fail_accept BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected ${mode} write failure'); END`)
    }
    await expect(root.scheduler.startDraftTest(automation.id, 1, {}, null, `draft-test-rollback-${mode}-01`)).rejects.toThrow('injected')
    expect(acceptedCounts(root)).toEqual(before)
    expect(resources.map(resource => root.resources.get(resource.id)?.state)).toEqual(['STAGED', 'STAGED'])
    expect(resources.map(resource => root.resources.get(resource.id)?.stagedExpiresAt)).toEqual(resources.map(resource => resource.stagedExpiresAt))
    await Promise.resolve(); expect(changes).not.toHaveBeenCalled()
  })

  it('freezes input and trigger across preflight and retains all static/default/IR/Presentation references through Wait, parallel recovery and shared cleanup', async () => {
    const path = await directory(), root = await context(path)
    const resources = await Promise.all(['source', 'lowered', 'presentation', 'input', 'trigger'].map(value => root.resources.stage({ name: value, mediaType: 'text/plain', content: Buffer.from(value), stagingTtlMs: 0 })))
    const [sourceResource, lowered, presentation, inputResource, triggerResource] = resources
    root.capabilities.define(root, action)
    const observed: string[] = []
    root.capabilities.provide(root, action, { async invoke({ input }) {
      const file = (input as { file: { $resource: string } }).file
      const chunks: Buffer[] = []; for await (const chunk of root.resources.open(file.$resource)) chunks.push(Buffer.from(chunk))
      const value = Buffer.concat(chunks).toString(); observed.push(value); return { value }
    } })
    const unload = root.controls.defineControl(root, {
      kind: 'extension', id: 'test:lowered-resource', version: 1, title: 'Lowered resource', description: '', input: z.object({}),
      lower: ({ nodeId }) => ({ type: 'capability', id: nodeId, capability: { id: action.id, version: action.version }, input: { file: { type: 'literal', value: lowered!.ref } } }),
    })
    const source: AutomationSource = { inputs: { file: { type: 'object', default: sourceResource!.ref }, explicit: { type: 'object' } }, triggers: [], flow: { type: 'parallel', id: 'parallel', branches: [
      { type: 'block', id: 'left', steps: [{ type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 60_000 } }, { type: 'extension', id: 'lowered', control: { id: 'test:lowered-resource', version: 1 }, input: {} }] },
      { type: 'block', id: 'right', steps: [{ type: 'capability', id: 'default', capability: { id: action.id, version: action.version }, input: { file: { type: 'ref', path: 'input.file' } } }] },
    ] } }
    const { automation } = root.automations.create({ name: 'Durable resources', source, presentation: { attachment: presentation!.ref } })
    root.resources.commitOwner(presentation!.id, { type: 'external', id: 'shared' })
    const rawInput: Record<string, NumenValue> = { explicit: inputResource!.ref }, rawTrigger: { file: NumenValue } = { file: triggerResource!.ref }
    const entered = deferred(), release = deferred(), preflight = root.resources.preflight.bind(root.resources)
    const preflightSpy = vi.spyOn(root.resources, 'preflight').mockImplementationOnce(async resourceId => { const result = await preflight(resourceId); entered.resolve(); await release.promise; return result })
    const acceptance = root.scheduler.startDraftTest(automation.id, 1, rawInput, rawTrigger, 'draft-test-resource-restart-01')
    await entered.promise
    rawInput.explicit = null; rawTrigger.file = null
    release.resolve()
    const run = await acceptance; preflightSpy.mockRestore()
    expect(run.input).toEqual({ file: sourceResource!.ref, explicit: inputResource!.ref })
    expect(run.trigger).toEqual({ file: triggerResource!.ref })
    expect(root.resources.listOwners(sourceResource!.id)).toEqual(expect.arrayContaining([{ type: 'snapshot', id: run.revisionId }, { type: 'run', id: run.id }]))
    expect(root.resources.listOwners(lowered!.id)).toEqual([{ type: 'snapshot', id: run.revisionId }])
    expect(root.resources.listOwners(inputResource!.id)).toEqual([{ type: 'run', id: run.id }])
    expect(root.resources.listOwners(triggerResource!.id)).toEqual([{ type: 'run', id: run.id }])
    await root.scheduler.dispatchUntilIdle()
    expect(observed).toEqual(['source'])
    expect(root.scheduler.listExecutions(run.id).some(execution => execution.status === 'WAITING')).toBe(true)
    unload()
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: empty, presentation: {} })
    root.automations.archive(automation.id)
    expect(() => root.automations.removeArchived(automation.id, root.automations.get(automation.id)!.archivedAt!)).toThrow('active')
    await root.fiber.dispose()
    const restarted = await context(path)
    restarted.capabilities.define(restarted, action)
    restarted.capabilities.provide(restarted, action, { async invoke({ input }) {
      const chunks: Buffer[] = []; for await (const chunk of restarted.resources.open((input as { file: { $resource: string } }).file.$resource)) chunks.push(Buffer.from(chunk))
      const value = Buffer.concat(chunks).toString(); observed.push(value); return { value }
    } })
    expect(restarted.controls.get({ id: 'test:lowered-resource', version: 1 })).toBeUndefined()
    await restarted.resources.collectGarbage(new Date(Date.now() + 24 * 60 * 60_000))
    expect(resources.map(resource => restarted.resources.get(resource.id)?.state)).toEqual(Array(5).fill('COMMITTED'))
    restarted.database.db.prepare("UPDATE executions SET wake_at = ? WHERE run_id = ? AND status = 'WAITING'").run(new Date(0).toISOString(), run.id)
    await restarted.scheduler.dispatchUntilIdle()
    expect(restarted.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(observed).toEqual(['source', 'lowered'])
    expect(restarted.scheduler.inspectRun(run.id)?.instructionExecutions).toEqual(expect.arrayContaining([expect.objectContaining({ instructionId: 'lowered', statusCounts: expect.objectContaining({ COMPLETED: 1 }) })]))
    expect(restarted.automations.getExecutionSnapshot(run.revisionId)?.source).toEqual(source)
    restarted.automations.removeArchived(automation.id, restarted.automations.get(automation.id)!.archivedAt!)
    expect(acceptedCounts(restarted)).toEqual({ automation_revisions: 0, runs: 0, run_events: 0, manual_run_requests: 0, resource_owners: 1 })
    await restarted.resources.collectGarbage(new Date(Date.now() + 24 * 60 * 60_000))
    expect(resources.map(resource => restarted.resources.get(resource.id)?.state)).toEqual(['GONE', 'GONE', 'COMMITTED', 'GONE', 'GONE'])
    const chunks: Buffer[] = []; for await (const chunk of restarted.resources.open(presentation!.id)) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks).toString()).toBe('presentation')
  })
})
