import type { AutomationSource, BlockSource, ControlSource } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import {
  applyAutomationSourceCommand as apply,
  automationMovableNodeIds,
  automationStepEditOptions,
} from '../src/automation-source-editing.js'

const wait = (id: string): ControlSource => ({ type: 'wait', id, durationMs: { type: 'literal', value: 1 } })
const block = (id: string, steps: ControlSource[] = []): BlockSource => ({ type: 'block', id, steps })
const source = (flow: ControlSource = block('root')): AutomationSource => ({ triggers: [], flow })
const trigger = (id: string) => ({ id, capability: { id: 'clock', version: 1 }, config: {} })
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(frozen) }
  return value
}

describe('render-time movable node membership', () => {
  it('includes nested sequence members and triggers while retaining every required structural slot', () => {
    const original = frozen({
      ...source(block('root', [
        { type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: block('then', [wait('then-child')]), else: block('else', [wait('else-child')]) },
        { type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: block('body', [block('nested', [wait('deep-child')])]) },
        { type: 'parallel', id: 'parallel', branches: [block('parallel-one', [wait('parallel-child')]), block('parallel-two')] },
        { type: 'race', id: 'race', branches: [block('race-one'), block('race-two', [wait('race-child')])] },
        block('empty-sequence-member'),
      ])),
      triggers: [trigger('timer'), trigger('event')],
    })
    const movable = automationMovableNodeIds(original)
    const expected = ['timer', 'event', 'condition', 'then-child', 'else-child', 'loop', 'nested', 'deep-child', 'parallel', 'parallel-child', 'race', 'race-child', 'empty-sequence-member']
    expect([...movable].sort()).toEqual(expected.sort())
    for (const id of [...expected, 'root', 'then', 'else', 'body', 'parallel-one', 'parallel-two', 'race-one', 'race-two', 'missing', '']) {
      expect(movable.has(id), id).toBe(automationStepEditOptions(original, id).canMoveTo)
    }
  })

  it('handles a leaf root, a structured root, and empty collections without making root movable', () => {
    expect([...automationMovableNodeIds(source())]).toEqual([])
    expect([...automationMovableNodeIds(source(wait('single')))]).toEqual([])
    const original = source({ type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: block('then', [wait('child')]) })
    expect([...automationMovableNodeIds(original)]).toEqual(['child'])
    expect(automationStepEditOptions(original, 'condition')).toMatchObject({ canDelete: true, canMoveTo: false })
  })

  it('preserves ID existence semantics for duplicate structural IDs and excludes empty IDs', () => {
    const original = {
      ...source(block('shared-root', [
        wait('shared-root'),
        { type: 'if', id: 'condition', condition: { type: 'literal' as const, value: true }, then: block('shared-slot') },
        wait('shared-slot'), wait('duplicate'), wait('duplicate'), wait(''), wait('dotted.id'),
      ])),
      triggers: [trigger(''), trigger('duplicate'), trigger('trigger-only')],
    }
    const movable = automationMovableNodeIds(original)
    expect([...movable].sort()).toEqual(['shared-root', 'condition', 'shared-slot', 'duplicate', 'dotted.id', 'trigger-only'].sort())
    for (const id of [...movable, '', 'absent']) expect(movable.has(id), id).toBe(automationStepEditOptions(original, id).canMoveTo)
    expect(automationStepEditOptions(original, 'shared-slot').canCopy).toBe(false)
  })

  it('allows an unavailable extension to move without allowing copy or traversing opaque payloads', () => {
    const extension: ControlSource = {
      type: 'extension', id: 'opaque', control: { id: 'unavailable', version: 9 },
      input: { data: { type: 'literal', value: { type: 'block', id: 'not-a-control', steps: [{ type: 'wait', id: 'not-a-child' }] } } },
    }
    const original = frozen(source(block('root', [extension, block('destination')])))
    expect(automationStepEditOptions(original, 'opaque')).toMatchObject({ canMoveTo: true, canCopy: false })
    expect([...automationMovableNodeIds(original)]).toEqual(['opaque', 'destination'])
    const moved = apply(original, { type: 'MOVE_TO', nodeId: 'opaque', target: { kind: 'block', blockId: 'destination' } })
    expect(moved.error).toBeUndefined()
    expect(moved.source.flow).toEqual(block('root', [block('destination', [extension])]))
    expect(apply(original, { type: 'COPY_TO', nodeId: 'opaque', target: { kind: 'block', blockId: 'destination' } }).error?.code).toBe('COPY_UNSAFE')
  })

  it('only reads structural membership, even when payload access would invoke costly work', () => {
    let payloadReads = 0
    const extension: ControlSource = { type: 'extension', id: 'opaque', control: { id: 'unavailable', version: 9 }, input: {} }
    const declaration = trigger('timer')
    const rejectPayloadRead = () => { payloadReads += 1; throw new Error('Payload inspection is unrelated to move eligibility.') }
    Object.defineProperty(extension, 'input', { enumerable: true, get: rejectPayloadRead })
    Object.defineProperty(declaration, 'config', { enumerable: true, get: rejectPayloadRead })
    expect([...automationMovableNodeIds({ ...source(block('root', [extension])), triggers: [declaration] })]).toEqual(['timer', 'opaque'])
    expect(payloadReads).toBe(0)
  })

  it('keeps incomplete waits and unrecognized expressions movable without enabling unsafe copies', () => {
    const unfinished: ControlSource = { type: 'wait', id: 'unfinished' }
    const invalid = { type: 'wait', id: 'invalid-expression', durationMs: { type: 'future-expression', opaque: true } } as unknown as ControlSource
    const original = source(block('root', [unfinished, invalid, block('destination')]))
    expect([...automationMovableNodeIds(original)]).toEqual(['unfinished', 'invalid-expression', 'destination'])
    expect(automationStepEditOptions(original, 'invalid-expression')).toMatchObject({ canMoveTo: true, canCopy: false })
    const moved = apply(original, { type: 'MOVE_TO', nodeId: invalid.id, target: { kind: 'block', blockId: 'destination' } })
    expect(moved.error).toBeUndefined()
    expect(moved.source.flow).toEqual(block('root', [unfinished, block('destination', [invalid])]))
  })

  it('rebuilds membership for both immutable Source replacements and edited objects without changing earlier snapshots', () => {
    const original = frozen({ ...source(block('root', [wait('before')])), triggers: [trigger('timer')] })
    const previous = automationMovableNodeIds(original)
    const removed = apply(original, { type: 'DELETE_STEP', nodeId: 'before' }).source
    const next = automationMovableNodeIds(removed)
    expect([...previous]).toEqual(['timer', 'before'])
    expect([...next]).toEqual(['timer'])
    expect(next).not.toBe(previous)
    const mutable = source(block('root', [wait('old')]))
    const old = automationMovableNodeIds(mutable)
    if (mutable.flow.type !== 'block') throw new Error('fixture')
    mutable.flow.steps.splice(0, 1, wait('new'))
    mutable.triggers.push(trigger('new-trigger'))
    expect([...automationMovableNodeIds(mutable)]).toEqual(['new-trigger', 'new'])
    expect([...old]).toEqual(['old'])
  })

  it('does not let a previous membership snapshot bypass current command validation', () => {
    const original = frozen(source(block('root', [
      { type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: block('body', [block('nested')]) },
      wait('removed'), block('destination'),
    ])))
    const previous = automationMovableNodeIds(original)
    expect(previous.has('removed')).toBe(true)
    const current = apply(original, { type: 'DELETE_STEP', nodeId: 'removed' }).source
    for (const [nodeId, blockId, code] of [
      ['removed', 'destination', 'NODE_NOT_FOUND'],
      ['body', 'destination', 'STRUCTURAL_SLOT'],
      ['loop', 'nested', 'DESCENDANT_TARGET'],
      ['loop', 'deleted-destination', 'TARGET_INVALID'],
    ] as const) {
      const result = apply(current, { type: 'MOVE_TO', nodeId, target: { kind: 'block', blockId } })
      expect(result.error?.code).toBe(code)
      expect(result.source).toBe(current)
    }
    expect(previous.has('removed')).toBe(true)
    expect(automationMovableNodeIds(current).has('removed')).toBe(false)
  })

  it('builds membership with bounded structural reads and answers 1000 node queries without revisiting Source', () => {
    let idReads = 0
    const steps = Array.from({ length: 1000 }, (_, index) => {
      const id = `step-${index}`
      const node = wait(id)
      Object.defineProperty(node, 'id', { enumerable: true, get: () => { idReads += 1; return id } })
      return node
    })
    const movable = automationMovableNodeIds(source(block('root', steps)))
    expect(movable.size).toBe(1000)
    expect(idReads).toBeGreaterThanOrEqual(1000)
    expect(idReads).toBeLessThanOrEqual(3000)
    const afterBuild = idReads
    for (let index = 0; index < 1000; index += 1) expect(movable.has(`step-${index}`)).toBe(true)
    expect(idReads).toBe(afterBuild)
  })
})
