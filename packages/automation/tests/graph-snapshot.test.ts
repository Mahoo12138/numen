import { CapabilityRegistry, type AutomationSource, type CapabilitySource, type GraphForEachSource, type GraphSource } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { AutomationCompileError, AutomationService } from '../src/index.js'

const source = (): AutomationSource => ({ triggers: [], flow: {
  type: 'graph', id: 'graph', version: 1,
  nodes: [
    { type: 'capability', id: 'a', capability: { id: 'test:value', version: 1 }, input: { value: { type: 'literal', value: 'A' } } },
    { type: 'capability', id: 'b', capability: { id: 'test:value', version: 1 }, input: { value: { type: 'literal', value: 'B' } } },
    { type: 'merge', id: 'join', mode: 'all', inputs: ['first', 'second'] },
  ],
  edges: [
    { id: 'start-a', from: { nodeId: 'graph', port: 'start' }, to: { nodeId: 'a', port: 'in' } },
    { id: 'start-b', from: { nodeId: 'graph', port: 'start' }, to: { nodeId: 'b', port: 'in' } },
    { id: 'a-join', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'join', port: 'first' } },
    { id: 'b-join', from: { nodeId: 'b', port: 'out' }, to: { nodeId: 'join', port: 'second' } },
  ], output: { type: 'ref', path: 'steps.join' },
} })

function nestedSource(): AutomationSource {
  const leaf = source().flow as GraphSource
  leaf.id = 'leaf'
  for (const edge of leaf.edges) if (edge.from.nodeId === 'graph') edge.from.nodeId = 'leaf'
  ;(leaf.nodes[0] as CapabilitySource).input.value = { type: 'ref', path: 'loop.item' }
  ;(leaf.nodes[1] as CapabilitySource).input.value = { type: 'ref', path: 'steps.seed' }
  const inner: GraphForEachSource = { type: 'foreach', id: 'inner', items: { type: 'ref', path: 'loop.item' }, body: leaf }
  const body: GraphSource = { type: 'graph', id: 'body', version: 1, nodes: [inner],
    edges: [{ id: 'body-start', from: { nodeId: 'body', port: 'start' }, to: { nodeId: 'inner', port: 'in' } }],
    output: { type: 'ref', path: 'steps.inner' } }
  const each: GraphForEachSource = { type: 'foreach', id: 'each', items: { type: 'literal', value: [['A', 'B'], ['C']] }, body }
  return { triggers: [], flow: { type: 'graph', id: 'graph', version: 1, nodes: [
    { type: 'capability', id: 'seed', capability: { id: 'test:value', version: 1 }, input: { value: { type: 'literal', value: 'seed' } } }, each,
  ], edges: [
    { id: 'start-seed', from: { nodeId: 'graph', port: 'start' }, to: { nodeId: 'seed', port: 'in' } },
    { id: 'seed-each', from: { nodeId: 'seed', port: 'out' }, to: { nodeId: 'each', port: 'in' } },
  ], output: { type: 'ref', path: 'steps.each' } } }
}

function nestedScopes(candidate: AutomationSource) {
  const graph = candidate.flow as GraphSource
  const each = graph.nodes.find(node => node.id === 'each') as GraphForEachSource
  const inner = each.body.nodes[0] as GraphForEachSource
  return { graph, each, inner, leaf: inner.body }
}

async function context(path: string, minimumOutputLength?: number) {
  const ctx = new Context()
  await ctx.plugin(DatabaseService, { path })
  await ctx.plugin(CapabilityRegistry)
  ctx.capabilities.define(ctx, { id: 'test:value', version: 1, kind: 'query', title: 'Value',
    input: z.object({ value: z.string().required() }), output: minimumOutputLength === undefined ? z.string() : z.string().min(minimumOutputLength), semantics: { sideEffect: false, idempotent: true, retrySafe: true } })
  await ctx.plugin(AutomationService)
  return ctx
}

describe('graph snapshot persistence and version compatibility', () => {
  it('keeps Graph fingerprints stable across Schema UIDs but changes them for contract constraints', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-graph-contract-hash-'))
    let root = await context(join(directory, 'db.sqlite'))
    try {
      const { automation } = root.automations.create({ name: 'Stable contract fingerprint', source: source() })
      const before = root.automations.publishDraft(automation.id, 1)
      await root.fiber.dispose()
      root = await context(join(directory, 'db.sqlite'))
      const restarted = root.automations.prepareDraftTestSnapshot(automation.id, 1)
      expect(restarted.contractSnapshot).not.toEqual(before.contractSnapshot)
      expect(restarted.contentHash).toBe(before.contentHash)
      await root.fiber.dispose()
      root = await context(join(directory, 'db.sqlite'), 2)
      expect(root.automations.prepareDraftTestSnapshot(automation.id, 1).contentHash).not.toBe(before.contentHash)
      expect(root.automations.getExecutionSnapshot(before.id)).toEqual(before)
    } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps old activated revisions, writes immutable graph v2 snapshots, and restores exact content after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-graph-snapshot-'))
    let root = await context(join(directory, 'db.sqlite'))
    try {
      const created = root.automations.create({ name: 'Versioned graph' })
      const id = created.automation.id
      const historical = root.automations.publishDraft(id, 1)
      root.automations.activateRevision(id, historical.id)
      const activation = root.automations.get(id)
      const draft = root.automations.saveDraft({ automationId: id, expectedVersion: 1, source: source(), presentation: { positions: { a: { x: 10, y: 20 } } } })
      const published = root.automations.publishDraft(id, draft.version)
      expect(published).toMatchObject({ protocolVersion: 2, irVersion: 2, compiledPlan: { irVersion: 2 }, number: 2 })
      const testSnapshot = root.automations.createDraftTestSnapshot(root.automations.prepareDraftTestSnapshot(id, draft.version))
      expect(testSnapshot).toMatchObject({ protocolVersion: 2, irVersion: 2, purpose: 'draft-test', sourceDraftVersion: draft.version })
      expect(root.automations.get(id)).toMatchObject({ activeRevisionId: historical.id, activationGeneration: activation!.activationGeneration })
      expect(root.automations.getRevision(historical.id)).toEqual(historical)
      expect(root.automations.listRevisions(id)).toHaveLength(2)
      root.automations.saveDraft({ automationId: id, expectedVersion: draft.version, source: { triggers: [], flow: { type: 'block', id: 'new', steps: [] } } })
      await root.fiber.dispose()
      root = await context(join(directory, 'db.sqlite'))
      expect(root.automations.getExecutionSnapshot(published.id)).toEqual(published)
      expect(root.automations.getExecutionSnapshot(testSnapshot.id)).toEqual(testSnapshot)
      for (const snapshot of [published, testSnapshot]) {
        const content = root.automations.getExecutionSnapshotContentForInspection(snapshot.id, id)!
        expect(content.source).toEqual(source())
        expect(content.presentation).toEqual(draft.presentation)
        const current = root.automations.getDraft(id)!
        const restored = root.automations.saveDraft({ automationId: id, expectedVersion: current.version, source: content.source, presentation: content.presentation })
        expect(restored.source).toEqual(snapshot.source)
      }
      expect(root.automations.get(id)).toMatchObject({ activeRevisionId: historical.id, activationGeneration: activation!.activationGeneration })
    } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('separates layout and authored array order from semantic changes, while disconnected drafts remain saveable', async () => {
    const root = await context(':memory:')
    try {
      const { automation, draft } = root.automations.create({ name: 'Graph hash', source: source() })
      const first = root.automations.publishDraft(automation.id, draft.version)
      const reordered = source(), graph = reordered.flow as GraphSource
      graph.nodes.reverse(); graph.edges.reverse()
      const moved = root.automations.saveDraft({ automationId: automation.id, expectedVersion: draft.version, source: reordered, presentation: { positions: { a: { x: 999, y: -15 } } } })
      const second = root.automations.publishDraft(automation.id, moved.version)
      expect(second.source).toEqual(reordered)
      expect(second.contentHash).toBe(first.contentHash)
      graph.output = { type: 'literal', value: 'changed' }
      const changed = root.automations.saveDraft({ automationId: automation.id, expectedVersion: moved.version, source: reordered })
      expect(root.automations.publishDraft(automation.id, changed.version).contentHash).not.toBe(first.contentHash)
      graph.edges = graph.edges.filter(edge => edge.id !== 'start-a')
      const disconnected = root.automations.saveDraft({ automationId: automation.id, expectedVersion: changed.version, source: reordered })
      expect(disconnected.source).toEqual(reordered)
      expect(() => root.automations.prepareDraftTestSnapshot(automation.id, disconnected.version)).toThrow(AutomationCompileError)
      expect(root.automations.listRevisions(automation.id)).toHaveLength(3)
    } finally { await root.fiber.dispose() }
  })

  it('rejects unknown or mismatched Source/IR versions before decoding restoration content', async () => {
    const root = await context(':memory:')
    try {
      const { automation } = root.automations.create({ name: 'Version guard' })
      const revision = root.automations.publishDraft(automation.id, 1)
      for (const [protocol, ir] of [[1, 2], [2, 1], [99, 99]]) {
        root.database.db.prepare('UPDATE automation_revisions SET protocol_version = ?, ir_version = ?, source_json = ? WHERE id = ?').run(protocol, ir, 'not-json', revision.id)
        expect(() => root.automations.getExecutionSnapshotContentForInspection(revision.id, automation.id)).toThrow('snapshot content protocol is unavailable')
      }
    } finally { await root.fiber.dispose() }
  })

  it('normalizes nested Graph member order while retaining iteration and expression semantics in the hash', async () => {
    const root = await context(':memory:')
    try {
      const { automation, draft } = root.automations.create({ name: 'Nested graph hash', source: nestedSource() })
      const first = root.automations.publishDraft(automation.id, draft.version)
      const reordered = nestedSource()
      const { graph, each, leaf } = nestedScopes(reordered)
      for (const scope of [graph, each.body, leaf]) { scope.nodes.reverse(); scope.edges.reverse() }
      let version = root.automations.saveDraft({ automationId: automation.id, expectedVersion: draft.version, source: reordered }).version
      const second = root.automations.publishDraft(automation.id, version)
      expect(second.contentHash).toBe(first.contentHash)
      expect(second.source).toEqual(reordered)
      expect(second.compiledPlan).toEqual(first.compiledPlan)
      const mutations: Array<(candidate: ReturnType<typeof nestedScopes>) => void> = [
        ({ each }) => { each.items = { type: 'literal', value: [['C'], ['A', 'B']] } },
        ({ inner }) => { inner.concurrency = 2 },
        ({ leaf }) => { leaf.output = { type: 'literal', value: null } },
        ({ leaf }) => { (leaf.nodes[0] as CapabilitySource).input.value = { type: 'template', parts: ['changed:', { ref: 'loop.item' }] } },
        ({ leaf }) => { leaf.edges[1]!.from = { nodeId: 'a', port: 'out' } },
      ]
      for (const mutate of mutations) {
        const changed = nestedSource()
        mutate(nestedScopes(changed))
        version = root.automations.saveDraft({ automationId: automation.id, expectedVersion: version, source: changed }).version
        expect(root.automations.publishDraft(automation.id, version).contentHash).not.toBe(first.contentHash)
      }
      expect(root.automations.getRevision(first.id)).toEqual(first)
    } finally { await root.fiber.dispose() }
  })

  it('round-trips nested body scopes and collection outputs through immutable snapshots and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-nested-graph-snapshot-'))
    let root = await context(join(directory, 'db.sqlite'))
    try {
      const candidate = nestedSource()
      const { automation, draft } = root.automations.create({ name: 'Nested graph persistence', source: candidate })
      const revision = root.automations.publishDraft(automation.id, draft.version)
      const snapshot = root.automations.createDraftTestSnapshot(root.automations.prepareDraftTestSnapshot(automation.id, draft.version))
      expect(revision.compiledPlan.instructions.inner).toMatchObject({ op: 'graph_iterate', body: 'leaf', items: { type: 'ref', path: 'loop.item' } })
      expect(revision.compiledPlan.instructions.leaf).toMatchObject({ next: '__inner.iteration.complete' })
      await root.fiber.dispose()
      root = await context(join(directory, 'db.sqlite'))
      for (const expected of [revision, snapshot]) {
        expect(root.automations.getExecutionSnapshot(expected.id)).toEqual(expected)
        expect(root.automations.getExecutionSnapshotContentForInspection(expected.id, automation.id)?.source).toEqual(candidate)
      }
    } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
})
