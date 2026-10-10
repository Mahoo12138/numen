import { AutomationService } from '@numenjs/automation'
import { ConsoleService, type ConsoleRequestContext } from '@numenjs/console'
import { CapabilityRegistry, type AutomationSource, type GraphSource, type NumenValue } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { ResourceService } from '../../resources/src/index.js'
import { SchedulerService } from '@numenjs/scheduler'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workbenchAutomationSnapshotProviderPlugin, workbenchAutomationSnapshotQuery } from '../src/automation-snapshot-provider.js'
import { workbenchAutomationComparisonProviderPlugin, workbenchAutomationComparisonQuery, workbenchAutomationComparisonStateQuery } from '../src/automation-comparison-provider.js'
import { workbenchAutomationRestorationProviderPlugin, workbenchAutomationRestoreContentQuery } from '../src/automation-restoration-provider.js'
import { workbenchAutomationAuthoringProviderPlugin, workbenchSaveAutomationDraftAction, workbenchPublishAutomationDraftAction, workbenchSaveAutomationDraftCopyAction } from '../src/automation-authoring-provider.js'
import { workbenchRunDetailQuery, workbenchRunsProviderPlugin, workbenchRunsIndexQuery, workbenchCancelRunAction } from '../src/runs-provider.js'
import { workbenchManualRunFormQuery, workbenchStartManualRunAction } from '../src/manual-run-provider.js'
import { workbenchExecutionDataQuery } from '../src/execution-data-provider.js'
import { sourceNodeIdForExecution } from '../src/run-detail-projection.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const request = (authenticated = true): ConsoleRequestContext => ({ requestId: 'large-fixed-read', principal: { subject: { type: 'user', id: 'owner' }, authenticated }, signal: new AbortController().signal, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger })
const literal = (value: NumenValue) => ({ type: 'literal' as const, value })
const ref = (path: string) => ({ type: 'ref' as const, path })
const visible = <T extends z>(schema: T): T => schema.extra('extra', { numen: { execution: 'public' } }) as T
const action = (id: string, value = id) => ({ type: 'capability' as const, id, capability: { id: 'test:fixed', version: 1 }, input: { safe: literal(value), secret: literal('PRIVATE_VALUE_CANARY') } })
const empty: AutomationSource = { triggers: [], flow: { type: 'graph', version: 1, id: 'current', nodes: [], edges: [] } }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'numen-large-fixed-read-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  await root.plugin(DatabaseService, { path: join(directory, 'numen.db') })
  await root.plugin(CapabilityRegistry)
  const fields = () => z.object({ safe: visible(z.string()), secret: z.string().role('secret') })
  const definition = { id: 'test:fixed', version: 1, kind: 'action' as const, title: 'Frozen fixed action', input: fields(), output: fields(), semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
  const unload = root.capabilities.define(root, definition), invoke = vi.fn(async ({ input }) => input)
  const removeProvider = root.capabilities.provide(root, definition, { invoke })
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(ConsoleService)
  for (const procedure of [workbenchAutomationSnapshotQuery, workbenchAutomationComparisonQuery, workbenchAutomationComparisonStateQuery,
    workbenchAutomationRestoreContentQuery, workbenchSaveAutomationDraftAction, workbenchPublishAutomationDraftAction, workbenchSaveAutomationDraftCopyAction,
    workbenchRunDetailQuery, workbenchRunsIndexQuery, workbenchCancelRunAction, workbenchManualRunFormQuery, workbenchStartManualRunAction, workbenchExecutionDataQuery]) root.console.define(root, procedure)
  workbenchAutomationSnapshotProviderPlugin(root)
  workbenchAutomationComparisonProviderPlugin(root)
  workbenchAutomationRestorationProviderPlugin(root)
  workbenchAutomationAuthoringProviderPlugin(root)
  workbenchRunsProviderPlugin(root)
  return { root, invoke, unload: () => { removeProvider(); unload() } }
}

const historicalRows = (root: Context) => Object.fromEntries(['automation_revisions', 'runs', 'executions', 'attempts', 'run_events', 'graph_members', 'execution_iterations']
  .map(table => [table, root.database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))

describe('Large immutable Graph inspection pipeline', () => {
  it('point-reads node 300, pages fixed comparisons and restores the full document without changing history', async () => {
    const { root, invoke, unload } = await fixture()
    const graph: GraphSource = { type: 'graph', id: 'flow', version: 1, nodes: Array.from({ length: 300 }, (_, i) => action(`node${i + 1}`)),
      edges: Array.from({ length: 300 }, (_, i) => ({ id: `edge${i + 1}`, from: { nodeId: 'flow', port: 'start' }, to: { nodeId: `node${i + 1}`, port: 'in' } })), output: ref('steps.node300') }
    const source: AutomationSource = { triggers: [], flow: graph }
    const presentation = { graphPositions: { node300: { x: 4_200, y: 120 } }, futureLayout: { private: 'PRIVATE_LAYOUT_CANARY' } }
    const { automation } = root.automations.create({ name: 'Large fixed graph', source, presentation })
    const first = root.automations.publishDraft(automation.id, 1)
    const run = root.scheduler.startRevisionTest(automation.id, first.id, {}, null, 'fixed-300-request')
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(invoke).toHaveBeenCalledTimes(300)
    const next = structuredClone(source)
    if (next.flow.type !== 'graph') throw new Error('fixture')
    next.flow.nodes = next.flow.nodes.map(node => action(node.id, `changed ${node.id}`))
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: next, presentation })
    const second = root.automations.publishDraft(automation.id, 2)
    root.automations.activateRevision(automation.id, second.id)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: empty, presentation: {} })
    unload()
    const live = vi.spyOn(root.capabilities, 'get'), before = historicalRows(root)
    try {
      const defaultView = await root.console.query(workbenchAutomationSnapshotQuery, { automationId: automation.id, snapshotId: first.id }, request())
      expect(defaultView.source.nodes.length).toBeLessThanOrEqual(250)
      expect(defaultView.source.nodes.length).toBeGreaterThan(0)
      expect(defaultView.source.nodes.some(node => node.nodeId === 'node300')).toBe(false)
      expect(defaultView.flow.truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(defaultView))).toBeLessThanOrEqual(131_072)
      const focused = await root.console.query(workbenchAutomationSnapshotQuery, { automationId: automation.id, snapshotId: first.id, sourceNodeId: 'node300' }, request())
      expect(focused.source.nodes).toMatchObject([{ nodeId: 'node300', input: { value: { safe: 'node300' }, hidden: 1 } }])
      expect(focused.flow).toMatchObject({ focusedNodeId: 'node300', truncated: false, root: { children: [{ id: 'node300', title: 'Frozen fixed action' }] } })
      expect(Buffer.byteLength(JSON.stringify(focused))).toBeLessThan(131_072)
      expect(JSON.stringify(focused)).not.toContain('CANARY')
      expect(sourceNodeIdForExecution(first, 'node300')).toBe('node300')
      const defaultRun = await root.console.query(workbenchRunDetailQuery, { runId: run.id, executionLimit: 50, eventLimit: 1 }, request())
      expect(defaultRun.flow.truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(defaultRun))).toBeLessThanOrEqual(131_072)
      const detail = await root.console.query(workbenchRunDetailQuery, { runId: run.id, sourceNodeId: 'node300', executionLimit: 1, eventLimit: 1 }, request())
      expect(detail.flow).toMatchObject({ focusedNodeId: 'node300', truncated: false, root: { children: [{ id: 'node300', status: 'COMPLETED', executionCount: 1 }] } })
      expect(detail.executions).toMatchObject([{ sourceNodeId: 'node300', operation: 'invoke', status: 'COMPLETED' }])
      const value = await root.console.query(workbenchExecutionDataQuery, { runId: run.id, executionId: detail.executions[0]!.id }, request())
      expect(value).toMatchObject({ sourceNodeId: 'node300', output: { value: { safe: 'node300' }, hidden: 1 } })
      expect(JSON.stringify(value)).not.toContain('CANARY')
      const targets = { automationId: automation.id, left: { kind: 'snapshot' as const, snapshotId: first.id }, right: { kind: 'snapshot' as const, snapshotId: second.id } }
      const page1 = await root.console.query(workbenchAutomationComparisonQuery, targets, request())
      expect(page1).toMatchObject({ totalChanges: 300, nextChangeOffset: 250 })
      expect(page1.changes).toHaveLength(250)
      const page2 = await root.console.query(workbenchAutomationComparisonQuery, { ...targets, changeOffset: page1.nextChangeOffset }, request())
      expect(page2.changes).toHaveLength(50)
      expect(page2.changes.at(-1)).toMatchObject({ nodeId: 'node300', category: 'parameters', field: 'input' })
      expect(new Set([...page1.changes, ...page2.changes].map(change => change.nodeId)).size).toBe(300)
      expect(page2.nextChangeOffset).toBeUndefined()
      expect(JSON.stringify([page1, page2])).not.toContain('CANARY')
      const content = await root.console.query(workbenchAutomationRestoreContentQuery, { automationId: automation.id, snapshotId: first.id, expectedDraftVersion: 3 }, request())
      expect(content.source).toEqual(source); expect(content.presentation).toEqual(presentation)
      await root.console.action(workbenchSaveAutomationDraftAction, { automationId: automation.id, expectedVersion: 3, source: content.source, presentation: content.presentation }, request())
      expect(root.automations.getDraft(automation.id)).toMatchObject({ version: 4, source, presentation })
      expect(root.automations.get(automation.id)?.activeRevisionId).toBe(second.id)
      expect(historicalRows(root)).toEqual(before)
      expect(live).not.toHaveBeenCalled()
    } finally { live.mockRestore() }
  })

  it('compares and restores nested Graph foreach while inspecting the exact inner execution', async () => {
    const { root, unload } = await fixture()
    const body: GraphSource = { type: 'graph', id: 'body', version: 1, nodes: [{ ...action('work'), input: { safe: ref('loop.item'), secret: literal('PRIVATE_INNER_CANARY') } }],
      edges: [{ id: 'body-work', from: { nodeId: 'body', port: 'start' }, to: { nodeId: 'work', port: 'in' } }], output: ref('steps.work') }
    const source: AutomationSource = { triggers: [], flow: { type: 'graph', id: 'flow', version: 1,
      nodes: [{ type: 'foreach', id: 'each', items: literal(['first', 'second']), concurrency: 2, body }],
      edges: [{ id: 'flow-each', from: { nodeId: 'flow', port: 'start' }, to: { nodeId: 'each', port: 'in' } }], output: ref('steps.each') } }
    const { automation } = root.automations.create({ name: 'Nested fixed graph', source })
    const first = root.automations.publishDraft(automation.id, 1)
    const run = root.scheduler.startRevisionTest(automation.id, first.id, {}, null, 'fixed-nested-request')
    await root.scheduler.dispatchUntilIdle()
    const next = structuredClone(source)
    if (next.flow.type !== 'graph' || next.flow.nodes[0]?.type !== 'foreach') throw new Error('fixture')
    next.flow.nodes[0].concurrency = 1
    next.flow.nodes[0].body.output = literal(null)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: next })
    const second = root.automations.publishDraft(automation.id, 2)
    unload()
    const comparison = await root.console.query(workbenchAutomationComparisonQuery, { automationId: automation.id,
      left: { kind: 'snapshot', snapshotId: first.id }, right: { kind: 'snapshot', snapshotId: second.id } }, request())
    expect(comparison.changes).toEqual([{ category: 'policies', kind: 'changed', field: 'concurrency', nodeId: 'each' }, { category: 'parameters', kind: 'changed', field: 'output', nodeId: 'body' }])
    const detail = await root.console.query(workbenchRunDetailQuery, { runId: run.id, sourceNodeId: 'work', executionLimit: 1, eventLimit: 1 }, request())
    expect(detail.flow.root.children[0]).toMatchObject({ id: 'work', status: 'COMPLETED', executionCount: 2 })
    expect(detail.nextExecutionCursor).toBeTruthy()
    const value = await root.console.query(workbenchExecutionDataQuery, { runId: run.id, executionId: detail.executions[0]!.id }, request())
    expect(value.sourceNodeId).toBe('work')
    expect(JSON.stringify(value)).not.toContain('CANARY')
    const content = await root.console.query(workbenchAutomationRestoreContentQuery, { automationId: automation.id, snapshotId: first.id, expectedDraftVersion: 2 }, request())
    expect(content.source).toEqual(source)
    await root.console.action(workbenchSaveAutomationDraftAction, { automationId: automation.id, expectedVersion: 2, source: content.source, presentation: content.presentation }, request())
    expect(root.automations.getDraft(automation.id)).toMatchObject({ version: 3, source })
  })

  it('pins paginated Draft comparisons and rejects invalid or unauthorized point reads before decoding', async () => {
    const { root } = await fixture()
    const source: AutomationSource = { triggers: [], flow: { type: 'graph', id: 'flow', version: 1, nodes: [action('first'), action('last')],
      edges: ['first', 'last'].map(id => ({ id, from: { nodeId: 'flow', port: 'start' }, to: { nodeId: id, port: 'in' } })) } }
    const { automation } = root.automations.create({ name: 'Pinned pages', source })
    const snapshot = root.automations.publishDraft(automation.id, 1)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: empty })
    const input = { automationId: automation.id, left: { kind: 'snapshot' as const, snapshotId: snapshot.id }, right: { kind: 'draft' as const, version: 2 }, changeLimit: 1 }
    const page = await root.console.query(workbenchAutomationComparisonQuery, input, request())
    expect(page.nextChangeOffset).toBe(1)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source })
    await expect(root.console.query(workbenchAutomationComparisonQuery, { ...input, changeOffset: page.nextChangeOffset }, request())).rejects.toMatchObject({ code: 'AUTOMATION_COMPARISON_STALE', status: 409 })
    const read = vi.spyOn(root.automations, 'getExecutionSnapshotForInspection')
    const point = { automationId: automation.id, snapshotId: snapshot.id, sourceNodeId: 'last' }
    try {
      await expect(root.console.query(workbenchAutomationSnapshotQuery, point, request(false))).rejects.toMatchObject({ status: 401 })
      for (const sourceNodeId of ['', 'n'.repeat(161)]) await expect(root.console.query(workbenchAutomationSnapshotQuery, { ...point, sourceNodeId }, request())).rejects.toThrow()
      for (const changeLimit of [0, 251, 1.5]) await expect(root.console.query(workbenchAutomationComparisonQuery, { ...input, changeLimit }, request())).rejects.toThrow()
      for (const changeOffset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(root.console.query(workbenchAutomationComparisonQuery, { ...input, changeOffset }, request())).rejects.toThrow()
      expect(read).not.toHaveBeenCalled()
      const foreign = root.automations.create({ name: 'Foreign', source: empty })
      root.database.db.prepare('UPDATE automation_revisions SET source_json = ? WHERE id = ?').run('PRIVATE_CORRUPT_CANARY', snapshot.id)
      await expect(root.console.query(workbenchAutomationSnapshotQuery, { ...point, automationId: foreign.automation.id }, request())).rejects.toMatchObject({ status: 404 })
      const failure = await root.console.query(workbenchAutomationSnapshotQuery, point, request()).catch(error => error)
      expect(failure).toMatchObject({ status: 409, code: 'AUTOMATION_SNAPSHOT_UNAVAILABLE' })
      expect(JSON.stringify(failure)).not.toContain('CANARY')
    } finally { read.mockRestore() }
  })

  it('identifies a sampled Execution without inventing a Provider invocation or Attempt', async () => {
    const { root, invoke } = await fixture()
    const source: AutomationSource = { triggers: [], flow: { type: 'graph', id: 'flow', version: 1,
      nodes: [action('upstream'), { ...action('target'), input: { safe: ref('steps.upstream.safe'), secret: literal('PRIVATE_TARGET_CANARY') } }],
      edges: [{ id: 'start', from: { nodeId: 'flow', port: 'start' }, to: { nodeId: 'upstream', port: 'in' } },
        { id: 'target', from: { nodeId: 'upstream', port: 'out' }, to: { nodeId: 'target', port: 'in' } }], output: ref('steps.target') } }
    const { automation } = root.automations.create({ name: 'Sampled fixed run', source })
    const sample = root.automations.createOutputSample({ automationId: automation.id, expectedDraftVersion: 1, nodeId: 'upstream', value: { safe: 'sampled value', secret: 'PRIVATE_SAMPLE_CANARY' } })
    const input = { automationId: automation.id, expectedDraftVersion: 1, targetNodeId: 'target', mode: 'only-node' as const, sampleIds: [sample.id], input: {}, trigger: null }
    const preview = root.automations.previewLocalTest(input)
    const run = await root.scheduler.startLocalTest({ ...input, previewHash: preview.previewHash, requestId: 'sampled-inspection-request' })
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    expect(invoke).toHaveBeenCalledTimes(1)
    root.automations.deleteOutputSample(automation.id, sample.id)
    const detail = await root.console.query(workbenchRunDetailQuery, { runId: run.id, sourceNodeId: 'upstream', executionLimit: 1, eventLimit: 1 }, request())
    expect(detail.executions).toMatchObject([{ sampleId: sample.id, operation: 'graph_value', title: 'Sample output', attempts: [], status: 'COMPLETED' }])
    const data = await root.console.query(workbenchExecutionDataQuery, { runId: run.id, executionId: detail.executions[0]!.id }, request())
    expect(data).toMatchObject({ sampleId: sample.id, sourceNodeId: 'upstream', provenance: 'execution-current', output: { value: { safe: 'sampled value' }, hidden: 1 } })
    expect(data.attempt).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('CANARY')
  })
})
