import type { AutomationSource, BlockSource, ControlSource } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { resolveAutomationDropTarget as resolve, validateAutomationDrop as validate } from '../src/automation-drag.js'
import { applyAutomationSourceCommand as apply, findAutomationControl } from '../src/automation-source-editing.js'

const block = (id: string, steps: ControlSource[] = []): BlockSource => ({ type: 'block', id, steps })
const wait = (id: string): ControlSource => ({ type: 'wait', id, durationMs: { type: 'literal', value: 1 } })
const source = (flow: ControlSource = block('root')): AutomationSource => ({ triggers: [], flow })
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(frozen) }
  return value
}
const steps = (value: AutomationSource, id: string) => (findAutomationControl(value, id) as BlockSource).steps.map(node => node.id)

function nestedSource(): AutomationSource {
  return frozen(source(block('root', [
    wait('first'),
    { type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: block('then', [wait('child')]), else: block('else') },
    { type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: block('body', [block('nested', [wait('leaf')])]) },
    { type: 'parallel', id: 'parallel', branches: [block('branch-one', [wait('parallel-child')]), block('branch-two')] },
    { type: 'race', id: 'race', branches: [block('race-one'), block('race-two')] },
    wait('last'),
  ])))
}

describe('Automation drag intent', () => {
  it('resolves nested before/after positions without changing the Source during hover', () => {
    const current = nestedSource(), original = JSON.stringify(current)
    expect(resolve(current, 'last', 'child', 'before')).toEqual({ allowed: true, noOp: false, target: { kind: 'block', blockId: 'then', beforeNodeId: 'child' } })
    expect(resolve(current, 'first', 'child', 'after')).toEqual({ allowed: true, noOp: false, target: { kind: 'block', blockId: 'then' } })
    expect(resolve(current, 'child', 'condition', 'after')).toEqual({ allowed: true, noOp: false, target: { kind: 'block', blockId: 'root', beforeNodeId: 'loop' } })
    expect(JSON.stringify(current)).toBe(original)
    expect(steps(current, 'then')).toEqual(['child'])
    expect(steps(current, 'root')).toEqual(['first', 'condition', 'loop', 'parallel', 'race', 'last'])
  })

  it('accepts empty and occupied actual blocks as inside targets, including fixed receiver slots', () => {
    const current = nestedSource()
    for (const blockId of ['root', 'then', 'else', 'body', 'nested', 'branch-one', 'branch-two', 'race-one', 'race-two']) {
      expect(resolve(current, 'first', blockId, 'inside')).toEqual({ allowed: true, noOp: false, target: { kind: 'block', blockId } })
    }
    for (const nodeId of ['first', 'condition', 'loop', 'parallel', 'race', 'missing']) {
      expect(resolve(current, 'last', nodeId, 'inside')).toMatchObject({ allowed: false, error: { code: 'TARGET_INVALID' } })
    }
  })

  it('rejects before/after required slots instead of changing the container or falling back to root', () => {
    const current = nestedSource()
    for (const nodeId of ['root', 'then', 'else', 'body', 'branch-one', 'branch-two', 'race-one', 'race-two']) {
      for (const placement of ['before', 'after'] as const) {
        expect(resolve(current, 'first', nodeId, placement)).toMatchObject({ allowed: false, error: { code: 'TARGET_INVALID' } })
      }
    }
    // A Block that is an actual sequence member remains a movable sibling.
    expect(resolve(current, 'child', 'nested', 'before')).toEqual({ allowed: true, noOp: false, target: { kind: 'block', blockId: 'body', beforeNodeId: 'nested' } })
  })

  it('cannot drag root, branch or body identities while their nested steps remain movable', () => {
    const current = nestedSource()
    for (const nodeId of ['root', 'then', 'else', 'body', 'branch-one', 'branch-two', 'race-one', 'race-two']) {
      expect(resolve(current, nodeId, 'last', 'before')).toMatchObject({ allowed: false, error: { code: 'STRUCTURAL_SLOT' } })
    }
    expect(resolve(current, 'nested', 'then', 'inside')).toMatchObject({ allowed: true, noOp: false })
    expect(resolve(current, 'leaf', 'then', 'inside')).toMatchObject({ allowed: true, noOp: false })
  })

  it.each([
    ['condition', 'then', 'inside'], ['condition', 'child', 'before'],
    ['loop', 'nested', 'inside'], ['loop', 'leaf', 'after'],
    ['parallel', 'branch-two', 'inside'], ['parallel', 'parallel-child', 'before'],
    ['race', 'race-two', 'inside'], ['nested', 'nested', 'inside'],
  ] as const)('rejects ancestor %s dropped %s %s without detaching any node', (nodeId, targetId, placement) => {
    const current = nestedSource(), original = JSON.stringify(current)
    expect(resolve(current, nodeId, targetId, placement)).toMatchObject({ allowed: false, error: { code: 'DESCENDANT_TARGET' } })
    expect(JSON.stringify(current)).toBe(original)
  })

  it('retains existing same-position no-ops and resolves reordered sibling anchors before removal', () => {
    const current = frozen(source(block('root', [wait('a'), wait('b'), wait('c')])))
    for (const [nodeId, targetId, placement] of [
      ['a', 'a', 'before'], ['a', 'a', 'after'], ['a', 'b', 'before'],
      ['b', 'a', 'after'], ['c', 'c', 'after'], ['c', 'root', 'inside'],
    ] as const) expect(resolve(current, nodeId, targetId, placement)).toMatchObject({ allowed: true, noOp: true })
    const later = resolve(current, 'a', 'b', 'after')
    expect(later).toEqual({ allowed: true, noOp: false, target: { kind: 'block', blockId: 'root', beforeNodeId: 'c' } })
    if (!later.allowed) throw new Error('Expected a valid target')
    expect(steps(apply(current, { type: 'MOVE_TO', nodeId: 'a', target: later.target }).source, 'root')).toEqual(['b', 'a', 'c'])
    const earlier = resolve(current, 'c', 'a', 'before')
    if (!earlier.allowed) throw new Error('Expected a valid target')
    expect(steps(apply(current, { type: 'MOVE_TO', nodeId: 'c', target: earlier.target }).source, 'root')).toEqual(['c', 'a', 'b'])
  })

  it('keeps triggers in their own sequence and recognizes trigger no-ops', () => {
    const current = frozen({ ...source(block('root', [wait('step')])), triggers: ['t1', 't2', 't3'].map(id => ({ id, capability: { id: 'timer', version: 1 }, config: {} })) })
    expect(resolve(current, 't1', 't2', 'after')).toEqual({ allowed: true, noOp: false, target: { kind: 'triggers', beforeTriggerId: 't3' } })
    expect(resolve(current, 't3', 't1', 'before')).toEqual({ allowed: true, noOp: false, target: { kind: 'triggers', beforeTriggerId: 't1' } })
    expect(resolve(current, 't1', 't2', 'before')).toMatchObject({ allowed: true, noOp: true })
    expect(resolve(current, 't3', 't3', 'after')).toMatchObject({ allowed: true, noOp: true })
    for (const result of [resolve(current, 't1', 'root', 'inside'), resolve(current, 't1', 'step', 'before'), resolve(current, 'step', 't1', 'after'), resolve(current, 'step', 't1', 'inside')]) {
      expect(result).toMatchObject({ allowed: false, error: { code: 'TARGET_INVALID' } })
    }
    expect(validate(current, 't3', { kind: 'triggers' })).toEqual({ allowed: true, noOp: true })
  })

  it('permits explicit promotion beside a non-Block root but never moves the root identity', () => {
    const current = frozen(source({ type: 'if', id: 'single', condition: { type: 'literal', value: true }, then: block('then', [wait('child')]) }))
    expect(resolve(current, 'child', 'single', 'before')).toEqual({ allowed: true, noOp: false, target: { kind: 'root', beforeNodeId: 'single' } })
    expect(resolve(current, 'child', 'single', 'after')).toEqual({ allowed: true, noOp: false, target: { kind: 'root' } })
    expect(resolve(current, 'single', 'then', 'inside')).toMatchObject({ allowed: false, error: { code: 'STRUCTURAL_SLOT' } })
    expect(resolve(current, 'single', 'single', 'before')).toMatchObject({ allowed: false, error: { code: 'STRUCTURAL_SLOT' } })
  })

  it('rejects missing source, target and anchors against the latest document without fallback', () => {
    const current = nestedSource()
    expect(resolve(current, 'gone', 'last', 'before')).toMatchObject({ allowed: false, error: { code: 'NODE_NOT_FOUND' } })
    for (const placement of ['before', 'after', 'inside'] as const) expect(resolve(current, 'first', 'gone', placement)).toMatchObject({ allowed: false, error: { code: 'TARGET_INVALID' } })
    const captured = resolve(current, 'first', 'child', 'before')
    if (!captured.allowed) throw new Error('Expected a captured target')
    const deletedAnchor = apply(current, { type: 'DELETE_STEP', nodeId: 'child' }).source
    expect(validate(deletedAnchor, 'first', captured.target)).toMatchObject({ allowed: false, error: { code: 'TARGET_INVALID' } })
    const movedAnchor = apply(current, { type: 'MOVE_TO', nodeId: 'child', target: { kind: 'block', blockId: 'else' } }).source
    expect(validate(movedAnchor, 'first', captured.target)).toMatchObject({ allowed: false, error: { code: 'TARGET_INVALID' } })
    const deletedTarget = apply(current, { type: 'DELETE_STEP', nodeId: 'condition' }).source
    expect(validate(deletedTarget, 'first', captured.target)).toMatchObject({ allowed: false, error: { code: 'TARGET_INVALID' } })
    const deletedSource = apply(current, { type: 'DELETE_STEP', nodeId: 'first' }).source
    expect(validate(deletedSource, 'first', captured.target)).toMatchObject({ allowed: false, error: { code: 'NODE_NOT_FOUND' } })
  })

  it('preserves opaque payloads, references and selected identity when dispatching the resolved command once', () => {
    const opaque = { type: 'extension', id: 'opaque', control: { id: 'unknown', version: 9 }, input: {}, future: { paths: ['steps.opaque.value'], values: [1, false] } } as ControlSource
    const consumer: ControlSource = { type: 'capability', id: 'consumer', capability: { id: 'echo', version: 1 }, input: { value: { type: 'ref', path: 'steps.opaque.value' } } }
    const current = frozen(source(block('root', [block('group', [opaque]), consumer, block('destination')])))
    const original = JSON.stringify(current)
    for (let count = 0; count < 3; count++) expect(resolve(current, 'group', 'destination', 'inside')).toMatchObject({ allowed: true, noOp: false })
    expect(JSON.stringify(current)).toBe(original)
    const resolved = resolve(current, 'group', 'destination', 'inside')
    if (!resolved.allowed) throw new Error('Expected a valid target')
    const result = apply(current, { type: 'MOVE_TO', nodeId: 'group', target: resolved.target })
    expect(result.selectedNodeId).toBe('group')
    expect(result.idMap).toBeUndefined()
    expect(findAutomationControl(result.source, 'opaque')).toBe(opaque)
    expect(findAutomationControl(result.source, 'consumer')).toBe(consumer)
    expect(steps(result.source, 'destination')).toEqual(['group'])
    expect(steps(result.source, 'root')).toEqual(['consumer', 'destination'])
  })
})
