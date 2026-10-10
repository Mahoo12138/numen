import { AutomationService } from '@numenjs/automation'
import { ConsoleService, type ConsoleRequestContext } from '@numenjs/console'
import { CapabilityRegistry, type AutomationSource, type GraphSource, type NumenValue } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { SchedulerService } from '@numenjs/scheduler'
import { Context, type Logger } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResourceService } from '../../resources/src/index.js'
import { ReadonlyAutomationFlow } from '../src/ReadonlyAutomationFlow.js'
import { compareAutomationDocuments, AutomationComparisonUnavailableError } from '../src/automation-comparison.js'
import { workbenchAutomationComparisonProviderPlugin, workbenchAutomationComparisonQuery, workbenchAutomationComparisonStateQuery } from '../src/automation-comparison-provider.js'
import { workbenchAutomationSnapshotProviderPlugin, workbenchAutomationSnapshotQuery } from '../src/automation-snapshot-provider.js'
import { projectAutomationSnapshot } from '../src/automation-snapshot-projection.js'
import { workbenchExecutionDataQuery } from '../src/execution-data-provider.js'
import { workbenchManualRunFormQuery, workbenchStartManualRunAction } from '../src/manual-run-provider.js'
import { projectRunFlow, sourceNodeIdForExecution } from '../src/run-detail-projection.js'
import { workbenchCancelRunAction, workbenchRunDetailQuery, workbenchRunsIndexQuery, workbenchRunsProviderPlugin } from '../src/runs-provider.js'
import { renderToMarkup } from './render.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const request = (): ConsoleRequestContext => ({ requestId: 'graph-inspection', principal: { subject: { type: 'user', id: 'owner' }, authenticated: true }, signal: new AbortController().signal, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger })
const source = (): AutomationSource => ({ triggers: [], flow: {
  type: 'graph', id: 'graph', version: 1,
  nodes: [
    { type: 'condition', id: 'decide', condition: { type: 'literal', value: true } },
    { type: 'capability', id: 'left', capability: { id: 'test:graph-value', version: 1 }, input: { value: { type: 'literal', value: 'left value' }, secret: { type: 'literal', value: 'LEFT_PRIVATE_CANARY' } } },
    { type: 'capability', id: 'right', capability: { id: 'test:graph-value', version: 1 }, input: { value: { type: 'literal', value: 'right value' }, secret: { type: 'literal', value: 'RIGHT_PRIVATE_CANARY' } } },
    { type: 'merge', id: 'merged', mode: 'selected', inputs: ['left', 'right'] },
  ],
  edges: [
    { id: 'start', from: { nodeId: 'graph', port: 'start' }, to: { nodeId: 'decide', port: 'in' } },
    { id: 'selected', from: { nodeId: 'decide', port: 'true' }, to: { nodeId: 'left', port: 'in' } },
    { id: 'unselected', from: { nodeId: 'decide', port: 'false' }, to: { nodeId: 'right', port: 'in' } },
    { id: 'merge-left', from: { nodeId: 'left', port: 'out' }, to: { nodeId: 'merged', port: 'left' } },
    { id: 'merge-right', from: { nodeId: 'right', port: 'out' }, to: { nodeId: 'merged', port: 'right' } },
  ], output: { type: 'ref', path: 'steps.merged' },
} })
const document = (value = source(), presentation: Record<string, NumenValue> = {}) => ({ source: value, presentation, protocolVersion: 2, irVersion: 2 })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'numen-graph-inspection-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  await root.plugin(DatabaseService, { path: ':memory:' })
  await root.plugin(CapabilityRegistry)
  const definition = { id: 'test:graph-value', version: 1, kind: 'query' as const, title: 'Frozen Graph value',
    input: z.object({ value: z.string().required().extra('extra', { numen: { execution: 'public' } }), secret: z.string() }), output: z.string(),
    semantics: { sideEffect: false, idempotent: true, retrySafe: true } }
  const unloadDefinition = root.capabilities.define(root, definition)
  const unloadProvider = root.capabilities.provide(root, definition, { async invoke({ input }) { return (input as { value: string }).value } })
  await root.plugin(AutomationService)
  await root.plugin(ResourceService, { path: join(directory, 'resources') })
  await root.plugin(SchedulerService, { autoDispatch: false })
  await root.plugin(ConsoleService)
  root.console.define(root, workbenchRunDetailQuery)
  root.console.define(root, workbenchExecutionDataQuery)
  root.console.define(root, workbenchManualRunFormQuery)
  root.console.define(root, workbenchStartManualRunAction)
  root.console.define(root, workbenchCancelRunAction)
  root.console.define(root, workbenchRunsIndexQuery)
  root.console.define(root, workbenchAutomationSnapshotQuery)
  root.console.define(root, workbenchAutomationComparisonQuery)
  root.console.define(root, workbenchAutomationComparisonStateQuery)
  workbenchRunsProviderPlugin(root)
  workbenchAutomationSnapshotProviderPlugin(root)
  workbenchAutomationComparisonProviderPlugin(root)
  const created = root.automations.create({ name: 'Historical Graph', source: source(), presentation: { positions: { left: { x: 10, y: 20 } } } })
  const revision = root.automations.publishDraft(created.automation.id, 1)
  return { root, ...created, revision, unloadDefinition, unloadProvider,
    detail: (runId: string) => root.console.query(workbenchRunDetailQuery, { runId, executionLimit: 25, eventLimit: 100 }, request()),
    snapshot: () => root.console.query(workbenchAutomationSnapshotQuery, { automationId: created.automation.id, snapshotId: revision.id }, request()),
  }
}

describe('Graph snapshot and Run inspection', () => {
  it('keeps frozen graph topology, condition/merge source metadata and contracts after Draft replacement and definition unload', async () => {
    const { root, automation, revision, snapshot, unloadDefinition } = await fixture()
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: { triggers: [], flow: { type: 'block', id: 'new-draft', steps: [] } } })
    unloadDefinition()
    const draftRead = vi.spyOn(root.automations, 'getDraft').mockImplementation(() => { throw new Error('Historical inspection must not read the current Draft') })
    try {
      const result = await snapshot()
      expect(result).toMatchObject({ compatibility: 'supported', identity: { protocolVersion: 2, irVersion: 2 } })
      const graph = result.flow.root.children[0]!
      expect(graph).toMatchObject({ type: 'graph', children: [], executionCount: 0, graph: { edges: (revision.source.flow as GraphSource).edges } })
      expect(graph.graph!.nodes.map(node => [node.id, node.type, node.status])).toEqual([
        ['decide', 'condition', 'IDLE'], ['left', 'capability', 'IDLE'], ['right', 'capability', 'IDLE'], ['merged', 'merge', 'IDLE'],
      ])
      expect(graph.graph!.nodes.find(node => node.id === 'left')?.title).toBe('Frozen Graph value')
      expect(result.source.nodes.find(node => node.nodeId === 'decide')).toMatchObject({ type: 'condition', expressionFields: [{ field: 'condition', type: 'literal' }] })
      expect(result.source.nodes.find(node => node.nodeId === 'merged')).toMatchObject({ type: 'merge' })
      expect(result.source.nodes.find(node => node.nodeId === 'graph')?.expressionFields).toEqual([{ field: 'output', type: 'ref' }])
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY')
      expect(JSON.stringify(result)).not.toContain('new-draft')
      const markup = await renderToMarkup(<ReadonlyAutomationFlow flow={result.flow} onSelectNode={vi.fn()} />)
      expect(markup).toContain('data-readonly-graph-id="graph"')
      expect(markup).toContain('<ul class="readonly-graph-members">')
      expect(markup).toContain('Members are listed without execution order.')
      expect(markup).toContain('decide.true'); expect(markup).toContain('merged.left')
      expect(markup).toContain('data-run-source-id="merged"')
      expect(markup).not.toContain('Sequence')
      expect(draftRead).not.toHaveBeenCalled()
    } finally { draftRead.mockRestore() }
  })

  it('shows actual selected/skipped members from the Run snapshot and never counts skipped members as executions', async () => {
    const { root, automation, revision, detail } = await fixture()
    root.automations.activateRevision(automation.id, revision.id)
    const run = root.scheduler.startManual(automation.id)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: { triggers: [], flow: { type: 'block', id: 'changed-after-acceptance', steps: [] } } })
    await root.scheduler.dispatchUntilIdle()
    expect(root.scheduler.getRun(run.id)?.status).toBe('COMPLETED')
    const draftRead = vi.spyOn(root.automations, 'getDraft').mockImplementation(() => { throw new Error('Run inspection must not read the current Draft') })
    try {
      const result = await detail(run.id)
      const graph = result.flow.root.children[0]!
      expect(graph.graph!.edges).toEqual((revision.source.flow as GraphSource).edges)
      expect(graph.graph!.nodes.find(node => node.id === 'right')).toMatchObject({ status: 'SKIPPED', executionCount: 0 })
      for (const id of ['decide', 'left', 'merged']) expect(graph.graph!.nodes.find(node => node.id === id)).toMatchObject({ status: 'COMPLETED', executionCount: 1 })
      expect(graph.executionCount).toBe(4) // Scope plus three actual member Executions.
      expect(result.executionSummary.total).toBe(root.scheduler.listExecutions(run.id).length)
      expect(result.executions.some(execution => execution.sourceNodeId === 'right')).toBe(false)
      expect(sourceNodeIdForExecution(revision, 'merged')).toBe('merged')
      expect(sourceNodeIdForExecution(revision, 'decide')).toBe('decide')
      expect(JSON.stringify(result)).not.toContain('changed-after-acceptance')
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY')
      const markup = await renderToMarkup(<ReadonlyAutomationFlow flow={result.flow} showExecutionState onSelectNode={vi.fn()} />)
      expect(markup).toContain('Skipped'); expect(markup).toContain('data-status="SKIPPED"')
      expect(draftRead).not.toHaveBeenCalled()
    } finally { draftRead.mockRestore() }
  })

  it('projects blocked and pending members, then cancelled unstarted members without inventing an Execution', async () => {
    const { root, automation, revision, detail, unloadProvider } = await fixture()
    unloadProvider()
    root.automations.activateRevision(automation.id, revision.id)
    const run = root.scheduler.startManual(automation.id)
    await root.scheduler.dispatchUntilIdle()
    const before = await detail(run.id)
    const members = before.flow.root.children[0]!.graph!.nodes
    expect(members.find(node => node.id === 'left')).toMatchObject({ status: 'BLOCKED', executionCount: 1, blockedReason: expect.any(String) })
    expect(members.find(node => node.id === 'merged')).toMatchObject({ status: 'PENDING', executionCount: 0 })
    const executions = root.scheduler.listExecutions(run.id)
    root.scheduler.cancelRun(run.id, 'USER')
    await root.scheduler.dispatchUntilIdle()
    const after = await detail(run.id)
    expect(after.run.status).toBe('CANCELLED')
    expect(after.flow.root.children[0]!.graph!.nodes.find(node => node.id === 'merged')).toMatchObject({ status: 'CANCELLED', executionCount: 0 })
    expect(after.flow.root.children[0]!.graph!.nodes.find(node => node.id === 'right')).toMatchObject({ status: 'SKIPPED', executionCount: 0 })
    expect(root.scheduler.listExecutions(run.id)).toHaveLength(executions.length)
    expect(after.executionSummary.total).toBe(executions.length)
  })

  it('guards every Source/IR pair before inspecting unknown contents and keeps v1 readable', async () => {
    const { revision } = await fixture()
    for (const [protocolVersion, irVersion] of [[1, 2], [2, 1], [99, 99]]) {
      const unsupported = { ...revision, protocolVersion, irVersion, source: null, contractSnapshot: null, compiledPlan: null } as unknown as typeof revision
      expect(projectAutomationSnapshot(unsupported, 'Unavailable').compatibility).toBe('unsupported-protocol')
      expect(projectRunFlow(unsupported, []).root.id).toBe('__unsupported-revision')
      expect(sourceNodeIdForExecution(unsupported, 'decide')).toBeUndefined()
    }
    const legacy = { ...revision, protocolVersion: 1, irVersion: 1, source: { triggers: [], flow: { type: 'block' as const, id: 'legacy', steps: [] } } }
    expect(projectAutomationSnapshot(legacy, 'Legacy').compatibility).toBe('supported')
    expect(projectRunFlow(legacy, []).root.children[0]?.type).toBe('block')
  })
})

describe('Graph semantic comparison', () => {
  it('ignores authored node/edge order, reports coordinates only as Presentation, and distinguishes edge/condition/merge changes', () => {
    const before = document(), after = document()
    const graph = after.source.flow as GraphSource
    graph.nodes.reverse(); graph.edges.reverse()
    expect(compareAutomationDocuments(before, after)).toEqual([])
    after.presentation = { positions: { left: { x: 400, y: -10 } } }
    expect(compareAutomationDocuments(before, after)).toEqual([{ category: 'presentation', kind: 'changed', field: 'presentation' }])
    graph.edges.find(edge => edge.id === 'selected')!.from.port = 'false'
    const condition = graph.nodes.find(node => node.type === 'condition')!
    if (condition.type !== 'condition') throw new Error('fixture')
    condition.condition = { type: 'literal', value: false }
    const merge = graph.nodes.find(node => node.type === 'merge')!
    if (merge.type !== 'merge') throw new Error('fixture')
    merge.mode = 'all'; merge.inputs = ['changed-private-port', 'right']
    const changes = compareAutomationDocuments(before, after)
    expect(changes).toEqual(expect.arrayContaining([
      { category: 'structure', kind: 'changed', field: 'graphEdges', nodeId: 'graph' },
      { category: 'parameters', kind: 'changed', field: 'condition', nodeId: 'decide' },
      { category: 'structure', kind: 'changed', field: 'mergeMode', nodeId: 'merged' },
      { category: 'structure', kind: 'changed', field: 'mergeInputs', nodeId: 'merged' },
    ]))
    expect(JSON.stringify(changes)).not.toContain('PRIVATE_CANARY')
    expect(JSON.stringify(changes)).not.toContain('changed-private-port')
    expect(changes.some(change => change.kind === 'moved')).toBe(false)
  })

  it('compares Graph snapshots and exact saved Drafts through the provider after later edits, without live contracts', async () => {
    const { root, automation, revision, unloadDefinition } = await fixture()
    const changed = source()
    const graph = changed.flow as GraphSource
    for (const edge of graph.edges) if (edge.from.nodeId === 'decide') edge.from.port = edge.from.port === 'true' ? 'false' : 'true'
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 1, source: changed, presentation: revision.presentation })
    const second = root.automations.publishDraft(automation.id, 2)
    root.automations.saveDraft({ automationId: automation.id, expectedVersion: 2, source: changed, presentation: { positions: { merged: { x: 900, y: 10 } } } })
    unloadDefinition()
    const compare = (left: { kind: 'snapshot'; snapshotId: string }, right: { kind: 'snapshot'; snapshotId: string } | { kind: 'draft'; version: number }) => root.console.query(workbenchAutomationComparisonQuery, { automationId: automation.id, left, right }, request())
    const fixed = await compare({ kind: 'snapshot', snapshotId: revision.id }, { kind: 'snapshot', snapshotId: second.id })
    expect(fixed.changes).toEqual([{ category: 'structure', kind: 'changed', field: 'graphEdges', nodeId: 'graph' }])
    const latest = await compare({ kind: 'snapshot', snapshotId: second.id }, { kind: 'draft', version: 3 })
    expect(latest.changes).toEqual([{ category: 'presentation', kind: 'changed', field: 'presentation' }])
    expect(JSON.stringify(fixed)).not.toContain('PRIVATE_CANARY')
    await expect(compare({ kind: 'snapshot', snapshotId: revision.id }, { kind: 'draft', version: 2 })).rejects.toMatchObject({ code: 'AUTOMATION_COMPARISON_STALE' })
  })

  it('rejects unknown version pairs and malformed duplicate or dangling topology without partial results', () => {
    for (const versions of [{ protocolVersion: 1, irVersion: 2 }, { protocolVersion: 2, irVersion: 1 }, { protocolVersion: 3, irVersion: 3 }]) {
      expect(() => compareAutomationDocuments(document(), { ...document(), ...versions })).toThrow(AutomationComparisonUnavailableError)
    }
    for (const corrupt of ['duplicate', 'dangling', 'type'] as const) {
      const next = document(), graph = next.source.flow as GraphSource
      if (corrupt === 'duplicate') graph.edges.push(graph.edges[0]!)
      else if (corrupt === 'dangling') graph.edges[0]!.to.nodeId = 'missing'
      else graph.version = 99 as 1
      expect(() => compareAutomationDocuments(document(), next)).toThrow(AutomationComparisonUnavailableError)
    }
  })
})
