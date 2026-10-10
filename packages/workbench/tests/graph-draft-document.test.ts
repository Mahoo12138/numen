import type { AutomationSource, NumenValue } from '@numenjs/core'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { automationGraphPositions, reconcileAutomationPresentation, setAutomationGraphPositions } from '../src/automation-presentation.js'
import type { WorkbenchAutomationDetail, WorkbenchAutomationDraft, WorkbenchSaveAutomationDraftInput } from '../src/contracts.js'
import type { WorkbenchConsoleClient } from '../src/types.js'
import { reduceAutomationDraftDocument, useAutomationDraftDocument, type AutomationDraftDocumentState } from '../src/useAutomationDraftDocument.js'

const source: AutomationSource = { triggers: [], flow: { type: 'graph', id: 'graph', version: 1, nodes: [
  { type: 'capability', id: 'a', capability: { id: 'demo:echo', version: 1 }, input: {} },
  { type: 'condition', id: 'condition', condition: { type: 'literal', value: true } },
  { type: 'merge', id: 'merge', inputs: ['left'], mode: 'all' },
], edges: [
  { id: 'start', from: { nodeId: 'graph', port: 'start' }, to: { nodeId: 'a', port: 'in' } },
  { id: 'a-condition', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'condition', port: 'in' } },
] } }
const presentation: Record<string, NumenValue> = { graphPositions: { graph: { a: { x: 40, y: -20 }, condition: { x: 100, y: 40 } } }, future: { opaque: ['retain', false] } }
const draft = (version = 1, nextSource = source, nextPresentation = presentation): WorkbenchAutomationDraft => ({ source: nextSource, presentation: nextPresentation, version, updatedAt: `2026-10-10T00:00:0${version}.000Z` })
function loaded(): AutomationDraftDocumentState {
  const empty: AutomationDraftDocumentState = { selectedAutomationId: undefined, selectedNodeId: undefined, document: undefined, savePhase: 'UNAVAILABLE', editRevision: 0, undoStack: [], redoStack: [], pendingSave: undefined, conflict: undefined, saveError: undefined, publishPending: false, pendingPublish: undefined, publishError: undefined, problems: [] }
  return reduceAutomationDraftDocument(reduceAutomationDraftDocument(empty, { type: 'SELECT', automationId: 'automation' }), { type: 'SERVER', automationId: 'automation', draft: draft() })
}

describe('Graph presentation in the shared Draft history owner', () => {
  it('updates a position batch once without changing Source and undoes all coordinates together', () => {
    let state = loaded(), original = state.document!, originalSource = state.document!.source
    state = reduceAutomationDraftDocument(state, { type: 'SELECT_NODE', nodeId: 'condition' })
    state = reduceAutomationDraftDocument(state, { type: 'SET_GRAPH_POSITIONS', graphId: 'graph', expectedSource: originalSource, positions: { graph: { x: -200, y: 0 }, a: { x: -100, y: 2 }, condition: { x: 200, y: 3 } } })
    const changed = state.document!.presentation
    expect(state.document!.source).toBe(originalSource)
    expect(state.undoStack).toHaveLength(1)
    expect(state.editRevision).toBe(1)
    expect(state.savePhase).toBe('DIRTY')
    expect(changed.future).toBe(original.presentation.future)
    expect(automationGraphPositions(changed, 'graph')).toEqual({ graph: { x: -200, y: 0 }, a: { x: -100, y: 2 }, condition: { x: 200, y: 3 } })
    expect(reconcileAutomationPresentation(changed, state.document!.source)).toBe(changed)
    expect(reduceAutomationDraftDocument(state, { type: 'SET_GRAPH_POSITIONS', graphId: 'graph', positions: { a: { x: -100, y: 2 } } })).toBe(state)
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.presentation).toBe(original.presentation)
    expect(state.selectedNodeId).toBe('condition')
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document!.presentation).toBe(changed)
    expect(state.document!.source).toBe(originalSource)
    expect(state.selectedNodeId).toBe('condition')
  })

  it('rejects stale Source, stale member ids, invalid coordinates and unavailable scopes atomically', () => {
    const state = loaded()
    for (const action of [
      { graphId: 'graph', positions: { a: { x: 10, y: 30 } }, expectedSource: structuredClone(state.document!.source) },
      { graphId: 'graph', positions: { a: { x: 10, y: 30 }, missing: { x: 1, y: 2 } } },
      { graphId: 'graph', positions: { a: { x: NaN, y: 30 } } },
      { graphId: 'graph', positions: { a: { x: 10, y: Infinity } } },
      { graphId: 'a', positions: { a: { x: 10, y: 30 } } },
      { graphId: 'graph', positions: {} },
    ]) expect(reduceAutomationDraftDocument(state, { type: 'SET_GRAPH_POSITIONS', ...action })).toBe(state)
    const dirty = reduceAutomationDraftDocument(state, { type: 'SET_GRAPH_POSITIONS', graphId: 'graph', positions: { a: { x: 9, y: 9 } } })
    const saving = reduceAutomationDraftDocument(dirty, { type: 'SAVE_REQUEST' })
    const conflict = reduceAutomationDraftDocument(saving, { type: 'SAVE_FAILURE', error: { code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } } })
    for (const readonly of [conflict, reduceAutomationDraftDocument(state, { type: 'RELOAD' }), reduceAutomationDraftDocument(state, { type: 'PUBLISH_REQUEST' })]) {
      expect(reduceAutomationDraftDocument(readonly, { type: 'SET_GRAPH_POSITIONS', graphId: 'graph', positions: { a: { x: 30, y: 40 } } })).toBe(readonly)
    }
  })

  it('keeps latest positions while a prior semantic save completes, and invalid drafts remain saveable', () => {
    let state = loaded()
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'GRAPH_DISCONNECT', graphId: 'graph', edgeId: 'start' } })
    const disconnected = state.document!.source
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    expect(state.pendingSave!.source).toBe(disconnected)
    state = reduceAutomationDraftDocument(state, { type: 'SET_GRAPH_POSITIONS', graphId: 'graph', positions: { a: { x: 300, y: 400 } }, expectedSource: disconnected })
    const newest = state.document!.presentation
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: draft(2, disconnected) } })
    expect(state.document!.presentation).toBe(newest)
    expect(state.document!.source).toBe(disconnected)
    expect(state).toMatchObject({ savePhase: 'DIRTY', document: { version: 2 } })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.source).toBe(disconnected)
    expect(state.document!.presentation).toEqual(presentation)
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.source).toEqual(source)
  })

  it('prunes deleted coordinates and restores them on undo; copy adds members, internal edges and positions in one history entry', () => {
    let state = loaded()
    state = reduceAutomationDraftDocument(state, { type: 'SELECT_NODE', nodeId: 'condition' })
    const before = state.document!
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'GRAPH_DELETE_NODES', graphId: 'graph', nodeIds: ['condition'] } })
    expect(automationGraphPositions(state.document!.presentation, 'graph')).toEqual({ a: { x: 40, y: -20 } })
    expect(state.selectedNodeId).toBe('graph')
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.presentation).toBe(before.presentation)
    expect(state.document!.source).toBe(before.source)
    expect(state.selectedNodeId).toBe('condition')
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'GRAPH_COPY_NODES', graphId: 'graph', nodeIds: ['a', 'condition'], idMap: { a: 'a-copy', condition: 'condition-copy' }, edgeIdMap: { 'a-condition': 'a-condition-copy' } } })
    expect(state.undoStack).toHaveLength(1)
    expect(state.redoStack).toHaveLength(0)
    expect(automationGraphPositions(state.document!.presentation, 'graph')).toEqual({ a: { x: 40, y: -20 }, condition: { x: 100, y: 40 }, 'a-copy': { x: 40, y: -20 }, 'condition-copy': { x: 100, y: 40 } })
    expect(state.selectedNodeId).toBe('condition-copy')
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.source).toBe(before.source)
    expect(state.document!.presentation).toBe(before.presentation)
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.selectedNodeId).toBe('condition-copy')
    expect(automationGraphPositions(state.document!.presentation, 'graph')['condition-copy']).toEqual({ x: 100, y: 40 })
  })

  it('retains opaque presentation fields, reads only finite points and removes obsolete member and graph coordinates', () => {
    const opaque = { ...presentation, graphPositions: { graph: { a: { x: 1, y: 2 }, stale: { x: 3, y: 4 }, condition: { x: 'bad', y: 0 } }, staleGraph: { member: { x: 1, y: 2 } } } }
    expect(automationGraphPositions(opaque, 'graph')).toEqual({ a: { x: 1, y: 2 }, stale: { x: 3, y: 4 } })
    const reconciled = reconcileAutomationPresentation(opaque, source)
    expect(reconciled.graphPositions).toEqual({ graph: { a: { x: 1, y: 2 } } })
    expect(reconciled.future).toBe(presentation.future)
    expect(reconcileAutomationPresentation(reconciled, source)).toBe(reconciled)
    const points = { a: { x: 9, y: 10 } }, updated = setAutomationGraphPositions(reconciled, source, 'graph', points)!
    points.a.x = 99
    expect(automationGraphPositions(updated, 'graph').a).toEqual({ x: 9, y: 10 })
  })

  it('copies and deletes owned body coordinates including each explicit Start in the same document history entry', () => {
    const nested: AutomationSource = { triggers: [], flow: { type: 'graph', id: 'graph', version: 1, nodes: [{
      type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: { type: 'graph', id: 'body', version: 1,
        nodes: [{ type: 'condition', id: 'inside', condition: { type: 'literal', value: true } }], edges: [], output: { type: 'literal', value: null } },
    }], edges: [] } }
    const positioned = { future: presentation.future!, graphPositions: { graph: { graph: { x: 0, y: 1 }, loop: { x: 3, y: 4 } }, body: { body: { x: -10, y: -20 }, inside: { x: 10, y: 20 } } } }
    let state = reduceAutomationDraftDocument(loaded(), { type: 'SERVER', automationId: 'automation', draft: draft(2, nested, positioned) })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'GRAPH_COPY_NODES', graphId: 'graph', nodeIds: ['loop'], idMap: { loop: 'loop-copy', body: 'body-copy', inside: 'inside-copy' }, edgeIdMap: {} } })
    const copied = state.document!
    expect(state.undoStack).toHaveLength(1)
    expect(automationGraphPositions(copied.presentation, 'graph')).toEqual({ graph: { x: 0, y: 1 }, loop: { x: 3, y: 4 }, 'loop-copy': { x: 3, y: 4 } })
    expect(automationGraphPositions(copied.presentation, 'body-copy')).toEqual({ 'body-copy': { x: -10, y: -20 }, 'inside-copy': { x: 10, y: 20 } })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'GRAPH_DELETE_NODES', graphId: 'graph', nodeIds: ['loop'] } })
    expect(automationGraphPositions(state.document!.presentation, 'body')).toEqual({})
    expect(automationGraphPositions(state.document!.presentation, 'body-copy')).toEqual({ 'body-copy': { x: -10, y: -20 }, 'inside-copy': { x: 10, y: 20 } })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.presentation).toBe(copied.presentation)
    expect(state.document!.source).toBe(copied.source)
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.presentation).toEqual(positioned)
  })

  it('serializes public-model position batches through autosave and fences a live Automation switch before its watcher runs', async () => {
    vi.useFakeTimers()
    const scope = effectScope(), id = ref('automation'), writes: WorkbenchSaveAutomationDraftInput[] = []
    let finishFirst!: () => void
    const client = { action: vi.fn(async (_ref, input: WorkbenchSaveAutomationDraftInput) => {
      writes.push(structuredClone(input))
      if (writes.length === 1) await new Promise<void>(resolve => { finishFirst = resolve })
      return { draft: draft(input.expectedVersion + 1, input.source, input.presentation) }
    }), query: vi.fn(), subscribe: vi.fn() } as unknown as WorkbenchConsoleClient
    const model = scope.run(() => useAutomationDraftDocument({ client, automationId: id, detail: () => ({ automation: { id: 'automation' }, draft: draft() }) as WorkbenchAutomationDetail, reloadDetail() {}, autosaveDelayMs: 10 }))!
    try {
      const before = model.document!.source
      expect(model.setGraphPositions({ a: { x: 100, y: 200 } }, 'graph', before)).toBe(true)
      await nextTick(); await vi.advanceTimersByTimeAsync(10)
      expect(writes).toHaveLength(1)
      expect(writes[0]!.source).toEqual(source)
      expect(writes[0]!.presentation.graphPositions).toMatchObject({ graph: { a: { x: 100, y: 200 } } })
      expect(model.setGraphPositions({ a: { x: 300, y: 400 } }, 'graph', before)).toBe(true)
      finishFirst(); await nextTick(); await nextTick(); await nextTick()
      expect(model.document!.presentation.graphPositions).toMatchObject({ graph: { a: { x: 300, y: 400 } } })
      await vi.advanceTimersByTimeAsync(10)
      expect(writes).toHaveLength(2)
      expect(writes[1]!.expectedVersion).toBe(2)
      expect(model.savePhase).toBe('CLEAN')
      const current = model.document
      id.value = 'another-automation'
      expect(model.setGraphPositions({ a: { x: 500, y: 600 } }, 'graph')).toBe(false)
      expect(model.document).toBe(current)
    } finally { scope.stop(); vi.useRealTimers() }
  })
})
