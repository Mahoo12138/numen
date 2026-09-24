import type { AutomationSource, BlockSource, ControlSource } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { applyAutomationSourceCommand as apply, automationStepEditOptions as options } from '../src/automation-source-editing.js'
import { projectAutomationSteps } from '../src/automation-projection.js'

const wait = (id: string): ControlSource => ({ type: 'wait', id, durationMs: { type: 'literal', value: 10 } })
const block = (id: string, steps: ControlSource[]): BlockSource => ({ type: 'block', id, steps })
const source = (flow: ControlSource): AutomationSource => ({ triggers: [], flow })

describe('Canvas structural Source commands', () => {
  it('moves a whole subtree within its sequence while preserving identity, expressions, and unrelated blocks', () => {
    const branch = block('then', [wait('nested')])
    const condition: ControlSource = { type: 'if', id: 'condition', condition: { type: 'ref', path: 'input.flag' }, then: branch }
    const original = source(block('root', [wait('first'), condition, wait('last')]))
    const next = apply(original, { type: 'MOVE_STEP', nodeId: 'condition', direction: 'up' })
    expect(next.selectedNodeId).toBe('condition')
    expect(next.source.flow).toMatchObject({ steps: [{ id: 'condition', then: branch }, { id: 'first' }, { id: 'last' }] })
    if (next.source.flow.type !== 'block') throw Error('fixture')
    expect(next.source.flow.steps[0]).toBe(condition)
    expect(projectAutomationSteps(next.source).map(step => step.sourceId)).toEqual(['condition', 'then', 'nested', 'first', 'last'])
    expect(original.flow).toMatchObject({ steps: [{ id: 'first' }, { id: 'condition' }, { id: 'last' }] })
  })

  it.each(['if', 'foreach', 'parallel', 'race'] as const)('edits %s sequence children without deleting or moving required slots', type => {
    const body = block('body', [wait('a'), wait('b')])
    const flow: ControlSource = type === 'if' ? { type, id: 'parent', condition: { type: 'literal', value: true }, then: body, else: block('else', []) }
      : type === 'foreach' ? { type, id: 'parent', items: { type: 'literal', value: [] }, body, concurrency: 2 }
      : { type, id: 'parent', branches: [body, block('other', [])] }
    const original = source(flow)
    expect(options(original, 'body')).toEqual({ canDelete: false, canMoveUp: false, canMoveDown: false })
    expect(apply(original, { type: 'DELETE_STEP', nodeId: 'body' }).source).toBe(original)
    expect(apply(original, { type: 'MOVE_STEP', nodeId: 'body', direction: 'up' }).source).toBe(original)
    const moved = apply(original, { type: 'MOVE_STEP', nodeId: 'a', direction: 'down' })
    expect(projectAutomationSteps(moved.source).filter(step => ['a', 'b'].includes(step.sourceId!)).map(step => step.sourceId)).toEqual(['b', 'a'])
    const removed = apply(moved.source, { type: 'DELETE_STEP', nodeId: 'a' })
    expect(removed.selectedNodeId).toBe('b')
    const empty = apply(removed.source, { type: 'DELETE_STEP', nodeId: 'b' })
    expect(empty.selectedNodeId).toBe('body')
    expect(projectAutomationSteps(empty.source).some(step => step.sourceId === 'body')).toBe(true)
  })

  it('deletes complete subtrees, selects adjacent siblings, and clears selection after the final step', () => {
    const original = source(block('root', [wait('a'), block('group', [wait('nested')]), wait('c')]))
    const removed = apply(original, { type: 'DELETE_STEP', nodeId: 'group' })
    expect(removed.selectedNodeId).toBe('c')
    expect(projectAutomationSteps(removed.source).map(step => step.sourceId)).toEqual(['a', 'c'])
    const previous = apply(removed.source, { type: 'DELETE_STEP', nodeId: 'c' })
    expect(previous.selectedNodeId).toBe('a')
    const empty = apply(previous.source, { type: 'DELETE_STEP', nodeId: 'a' })
    expect(empty).toHaveProperty('selectedNodeId', undefined)
    expect(empty.source.flow).toEqual(block('root', []))
    expect(projectAutomationSteps(original)).toHaveLength(4)
  })

  it('keeps a valid empty flow when removing a root leaf or structured control and deletes Trigger declarations', () => {
    const original = { ...source(wait('root')), triggers: [{ id: 'trigger', capability: { id: 'test:event', version: 1 }, config: {} }] }
    expect(apply(original, { type: 'DELETE_STEP', nodeId: 'root' }).source).toEqual({ ...original, flow: block('root', []) })
    expect(options(original, 'trigger').canDelete).toBe(true)
    expect(apply(original, { type: 'DELETE_STEP', nodeId: 'trigger' })).toEqual({
      source: { ...original, triggers: [] },
      selectedNodeId: undefined,
    })
    const root = source({ type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: block('body', [wait('child')]) })
    expect(projectAutomationSteps(apply(root, { type: 'DELETE_STEP', nodeId: 'loop' }).source)).toEqual([])
  })

  it('treats boundary moves and missing IDs as no-ops', () => {
    const original = source(block('root', [wait('only')]))
    expect(options(original, 'only')).toEqual({ canDelete: true, canMoveUp: false, canMoveDown: false })
    for (const direction of ['up', 'down'] as const) expect(apply(original, { type: 'MOVE_STEP', nodeId: 'only', direction }).source).toBe(original)
    expect(apply(original, { type: 'DELETE_STEP', nodeId: 'missing' }).source).toBe(original)
  })

  it('preserves unknown extension payloads on moves and does not reuse IDs still referenced after deletion', () => {
    const extension: ControlSource = { type: 'extension', id: 'wait-1', control: { id: 'missing:control', version: 9 }, input: { opaque: { type: 'literal', value: { a: 1 } } } }
    const original = source(block('root', [extension, { type: 'wait', id: 'consumer', durationMs: { type: 'ref', path: 'steps.wait-1.value' } }]))
    const moved = apply(original, { type: 'MOVE_STEP', nodeId: 'wait-1', direction: 'down' })
    if (moved.source.flow.type !== 'block') throw Error('fixture')
    expect(moved.source.flow.steps[1]).toBe(extension)
    const deleted = apply(original, { type: 'DELETE_STEP', nodeId: 'wait-1' })
    const inserted = apply(deleted.source, { type: 'INSERT', item: { kind: 'control', control: 'wait', title: 'Wait', description: '' } })
    expect(inserted.selectedNodeId).toBe('wait-2')
    expect(inserted.source.flow).toMatchObject({ steps: [{ id: 'consumer', durationMs: { type: 'ref', path: 'steps.wait-1.value' } }, { id: 'wait-2' }] })
  })
})
