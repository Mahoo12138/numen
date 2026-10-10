import { describe, expect, it } from 'vitest'
import type { AutomationSource, CapabilitySource, ControlSource } from '@numenjs/core'
import { previewGraphConversion } from '../src/graph-conversion.js'

const capability = (id: string): CapabilitySource => ({ type: 'capability', id, capability: { id: 'echo', version: 1 }, input: {} })
describe('explicit conservative Graph conversion', () => {
  it('preserves every call, reference, policy and connection once while adding sequential dependencies', () => {
    const source: AutomationSource = { inputs: { message: { type: 'string', default: '' } }, triggers: [], policy: { maxActive: 1 }, flow: {
      type: 'block', id: 'flow', steps: [capability('a'), { ...capability('b'), connections: { primary: 'connection-1' },
        input: { message: { type: 'ref', path: 'steps.a.message' } }, policy: { timeoutMs: 200 } }],
    } }
    const before = structuredClone(source), result = previewGraphConversion(source)
    expect(source).toEqual(before)
    expect('reason' in result).toBe(false)
    if ('reason' in result) return
    expect(result.graph.nodes).toEqual(source.flow.type === 'block' ? source.flow.steps : [])
    expect(result.graph.edges).toEqual([
      { id: 'sequence-1', from: { nodeId: 'flow', port: 'start' }, to: { nodeId: 'a', port: 'in' } },
      { id: 'sequence-2', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
    ])
    expect(result.source.inputs).toEqual(source.inputs)
    expect(result.source.policy).toEqual(source.policy)
    result.graph.nodes[0]!.id = 'changed'
    expect(source).toEqual(before)
  })
  it('gives a single capability a separate start identity without rebinding dangling references', () => {
    const result = previewGraphConversion({ triggers: [], flow: { ...capability('graph-1'), input: { stale: { type: 'ref', path: 'steps.graph-2.value' } } } })
    expect(result).toMatchObject({ graph: { id: 'graph-3', nodes: [{ id: 'graph-1' }] } })
  })
  it.each<ControlSource>([
    { type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'body', steps: [] } },
    { type: 'parallel', id: 'parallel', branches: [] }, { type: 'race', id: 'race', branches: [] },
    { type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: { type: 'block', id: 'body', steps: [] } },
    { type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 1 } },
    { type: 'extension', id: 'custom', control: { id: 'plugin:custom', version: 1 }, input: {} },
  ])('refuses unproven %s semantics without dropping the unsupported node', flow => {
    const source: AutomationSource = { triggers: [], flow: { type: 'block', id: 'flow', steps: [capability('first'), flow] } }
    const before = structuredClone(source)
    expect(previewGraphConversion(source)).toEqual({ reason: 'structure' })
    expect(source).toEqual(before)
  })
  it('rejects explicit output and duplicate/unsafe identities', () => {
    expect(previewGraphConversion({ triggers: [], flow: { type: 'block', id: 'flow', steps: [], output: { type: 'literal', value: [] } } })).toEqual({ reason: 'output' })
    for (const nodes of [[capability('flow')], [capability('bad.id')], [capability('a'), capability('a')]]) {
      expect(previewGraphConversion({ triggers: [], flow: { type: 'block', id: 'flow', steps: nodes } })).toEqual({ reason: 'identity' })
    }
  })
})
