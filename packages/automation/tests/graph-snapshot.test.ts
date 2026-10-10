import { CapabilityRegistry, type AutomationSource, type GraphSource } from '@numenjs/core'
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

async function context(path: string) {
  const ctx = new Context()
  await ctx.plugin(DatabaseService, { path })
  await ctx.plugin(CapabilityRegistry)
  ctx.capabilities.define(ctx, { id: 'test:value', version: 1, kind: 'query', title: 'Value',
    input: z.object({ value: z.string().required() }), output: z.string(), semantics: { sideEffect: false, idempotent: true, retrySafe: true } })
  await ctx.plugin(AutomationService)
  return ctx
}

describe('graph snapshot persistence and version compatibility', () => {
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
})
