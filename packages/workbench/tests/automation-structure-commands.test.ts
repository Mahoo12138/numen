import type { AutomationSource, BlockSource, ControlSource, ValueExpr } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { validateSourceReferences } from '../../automation/src/reference-validation.js'
import {
  applyAutomationSourceCommand as apply,
  automationInsertTargetError,
  automationNodeCopyError,
  automationRelativeInsertTarget,
  automationStepEditOptions,
  findAutomationControl,
} from '../src/automation-source-editing.js'
import type { WorkbenchAutomationInsertItem } from '../src/contracts.js'

const waitItem: WorkbenchAutomationInsertItem = { kind: 'control', control: 'wait', title: 'Wait', description: 'Wait' }
const triggerItem: WorkbenchAutomationInsertItem = { kind: 'trigger', capability: { id: 'clock', version: 1 }, title: 'Clock', description: 'Clock', inputFields: [] }
const block = (id: string, steps: ControlSource[] = []): BlockSource => ({ type: 'block', id, steps })
const wait = (id: string): ControlSource => ({ type: 'wait', id, durationMs: { type: 'literal', value: 1 } })
const capability = (id: string, input: Record<string, ValueExpr> = {}): ControlSource => ({ type: 'capability', id, capability: { id: 'echo', version: 1 }, input })
const source = (flow: ControlSource = block('root')): AutomationSource => ({ triggers: [], flow })
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(frozen) }
  return value
}
function getBlock(value: AutomationSource, id: string): BlockSource { return findAutomationControl(value, id) as BlockSource }

describe('explicit Source structure commands', () => {
  it('edits and clears invocation policy without mutating input, identity, or other steps', () => {
    const original = frozen(source(block('root', [capability('action', { value: { type: 'ref', path: 'input.value' } }), wait('pause')])))
    const policy = { timeoutMs: 2000, retry: { maxAttempts: 3, backoffMs: 100 } }
    const edited = apply(original, { type: 'SET_INVOCATION_POLICY', nodeId: 'action', policy })
    expect(findAutomationControl(edited.source, 'action')).toMatchObject({ id: 'action', policy, input: { value: { path: 'input.value' } } })
    policy.retry.maxAttempts = 9
    expect(findAutomationControl(edited.source, 'action')).toMatchObject({ policy: { retry: { maxAttempts: 3 } } })
    expect(findAutomationControl(original, 'action')).not.toHaveProperty('policy')
    const cleared = apply(edited.source, { type: 'SET_INVOCATION_POLICY', nodeId: 'action' })
    expect(cleared.source).toEqual(original)
    expect(apply(original, { type: 'SET_INVOCATION_POLICY', nodeId: 'pause', policy }).source).toBe(original)
  })

  it('inserts before, after, in empty nested slots, and at block end without changing other containers', () => {
    const original = frozen(source(block('root', [{ type: 'if', id: 'if', condition: { type: 'literal', value: true }, then: block('then', [wait('first'), wait('last')]), else: block('else') }])))
    const before = automationRelativeInsertTarget(original, 'last', 'before')!
    const inserted = apply(original, { type: 'INSERT', item: waitItem, target: before })
    expect(getBlock(inserted.source, 'then').steps.map(node => node.id)).toEqual(['first', 'wait-1', 'last'])
    const after = automationRelativeInsertTarget(inserted.source, 'wait-1', 'after')!
    expect(after).toEqual({ kind: 'block', blockId: 'then', beforeNodeId: 'last' })
    const second = apply(inserted.source, { type: 'INSERT', item: waitItem, target: after })
    const third = apply(second.source, { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'else' } })
    expect(getBlock(third.source, 'then').steps.map(node => node.id)).toEqual(['first', 'wait-1', 'wait-2', 'last'])
    expect(getBlock(third.source, 'else').steps.map(node => node.id)).toEqual(['wait-3'])
    expect(getBlock(third.source, 'root').steps).toHaveLength(1)
    expect(getBlock(original, 'then').steps.map(node => node.id)).toEqual(['first', 'last'])
  })

  it('rejects stale blocks and anchors instead of silently appending at root', () => {
    const original = source(block('root', [block('child', [wait('anchor')]), wait('outside')]))
    for (const target of [
      { kind: 'block' as const, blockId: 'deleted' },
      { kind: 'block' as const, blockId: 'child', beforeNodeId: 'outside' },
      { kind: 'block' as const, blockId: 'child', beforeNodeId: 'deleted' },
      { kind: 'root' as const },
    ]) {
      const result = apply(original, { type: 'INSERT', item: waitItem, target })
      expect(result.source).toBe(original)
      expect(result.error?.code).toBe('TARGET_INVALID')
    }
    expect(automationInsertTargetError(original, { kind: 'block', blockId: 'child' })).toBeUndefined()
  })

  it('requires an explicit root target for wrapping a single root control', () => {
    const original = frozen(source(wait('single')))
    expect(automationRelativeInsertTarget(original, 'single', 'before')).toEqual({ kind: 'root', beforeNodeId: 'single' })
    const before = apply(original, { type: 'INSERT', item: waitItem, target: { kind: 'root', beforeNodeId: 'single' } })
    expect((before.source.flow as BlockSource).steps.map(node => node.id)).toEqual(['wait-1', 'single'])
    const after = apply(original, { type: 'INSERT', item: waitItem, target: { kind: 'root' } })
    expect((after.source.flow as BlockSource).steps.map(node => node.id)).toEqual(['single', 'wait-1'])
    expect(apply(original, { type: 'INSERT', item: waitItem, target: { kind: 'root', beforeNodeId: 'old-root' } }).source).toBe(original)
  })

  it('keeps root and required-slot move options consistent with command acceptance', () => {
    const original = source({ type: 'if', id: 'single', condition: { type: 'literal', value: true }, then: block('then', [wait('child')]) })
    expect(automationStepEditOptions(original, 'single')).toMatchObject({ canMoveTo: false, canDelete: true, canCopy: true })
    expect(automationStepEditOptions(original, 'then')).toMatchObject({ canMoveTo: false, canDelete: false, canCopy: true })
    expect(automationStepEditOptions(original, 'child')).toMatchObject({ canMoveTo: true, canDelete: true })
    const promoted = apply(original, { type: 'MOVE_TO', nodeId: 'child', target: { kind: 'root', beforeNodeId: 'single' } })
    expect((promoted.source.flow as BlockSource).steps.map(node => node.id)).toEqual(['child', 'single'])
    expect(getBlock(promoted.source, 'then').steps).toEqual([])
  })

  it('keeps triggers in their own ordered list for insert, move, and copy', () => {
    let current = source()
    current = apply(current, { type: 'INSERT', item: triggerItem, target: { kind: 'triggers' } }).source
    current = apply(current, { type: 'INSERT', item: triggerItem, target: { kind: 'triggers', beforeTriggerId: 'trigger-1' } }).source
    expect(current.triggers.map(node => node.id)).toEqual(['trigger-2', 'trigger-1'])
    const moved = apply(current, { type: 'MOVE_TO', nodeId: 'trigger-1', target: { kind: 'triggers', beforeTriggerId: 'trigger-2' } })
    expect(moved.source.triggers.map(node => node.id)).toEqual(['trigger-1', 'trigger-2'])
    const copied = apply(moved.source, { type: 'COPY_TO', nodeId: 'trigger-1', target: { kind: 'triggers' } })
    expect(copied.idMap).toEqual({ 'trigger-1': 'trigger-3' })
    for (const command of [
      { type: 'INSERT' as const, item: triggerItem, target: { kind: 'block' as const, blockId: 'root' } },
      { type: 'INSERT' as const, item: waitItem, target: { kind: 'triggers' as const } },
      { type: 'MOVE_TO' as const, nodeId: 'trigger-1', target: { kind: 'block' as const, blockId: 'root' } },
    ]) expect(apply(current, command).error?.code).toBe('TARGET_INVALID')
  })

  it('manages optional branches and preserves required slots while clearing their full contents', () => {
    let current = source(block('root', [{ type: 'if', id: 'if', condition: { type: 'literal', value: true }, then: block('then', [block('nested', [wait('leaf')])]) }]))
    expect(apply(current, { type: 'DELETE_STEP', nodeId: 'then' }).error?.code).toBe('STRUCTURAL_SLOT')
    expect(automationStepEditOptions(current, 'then').canDelete).toBe(false)
    const cleared = apply(current, { type: 'CLEAR_BLOCK', nodeId: 'then' })
    expect(cleared.removedNodeIds).toEqual(['nested', 'leaf'])
    expect(getBlock(cleared.source, 'then').steps).toEqual([])
    current = apply(current, { type: 'ADD_ELSE', nodeId: 'if' }).source
    current = apply(current, { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'if-else-1' } }).source
    const removed = apply(current, { type: 'REMOVE_ELSE', nodeId: 'if' })
    expect(removed.removedNodeIds).toEqual(['if-else-1', 'wait-1'])
    expect(findAutomationControl(removed.source, 'if')).not.toHaveProperty('else')
    expect(removed.selectedNodeId).toBe('if')
    expect(findAutomationControl(current, 'wait-1')).toBeDefined()
  })

  it.each(['parallel', 'race'] as const)('enforces the compiler minimum of two %s branches and returns removed descendants', type => {
    const original = frozen(source({ type, id: 'fork', branches: [block('one'), block('two')] }))
    expect(apply(original, { type: 'REMOVE_BRANCH', nodeId: 'fork', branchId: 'one' }).error?.code).toBe('MIN_BRANCHES')
    const added = apply(original, { type: 'ADD_BRANCH', nodeId: 'fork' })
    const populated = apply(added.source, { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: added.selectedNodeId! } })
    const removed = apply(populated.source, { type: 'REMOVE_BRANCH', nodeId: 'fork', branchId: added.selectedNodeId! })
    expect(removed.source).toEqual(original)
    expect(removed.removedNodeIds).toEqual([added.selectedNodeId, 'wait-1'])
    expect(apply(populated.source, { type: 'REMOVE_BRANCH', nodeId: 'fork', branchId: 'missing' }).error?.code).toBe('INVALID_BRANCH')
  })

  it('moves a subtree atomically with unchanged IDs and unchanged references, exposing scope diagnostics', () => {
    const producer = capability('producer')
    const consumer = capability('consumer', { value: { type: 'ref', path: 'steps.producer.message' } })
    const original = frozen(source(block('root', [producer, consumer, { type: 'if', id: 'if', condition: { type: 'literal', value: true }, then: block('then') }])))
    expect(validateSourceReferences(original, new Map())).toEqual([])
    const moved = apply(original, { type: 'MOVE_TO', nodeId: 'producer', target: { kind: 'block', blockId: 'then' } })
    expect(getBlock(moved.source, 'then').steps[0]).toBe(producer)
    expect(findAutomationControl(moved.source, 'consumer')).toBe(consumer)
    expect(validateSourceReferences(moved.source, new Map()).map(problem => problem.code)).toContain('STEP_REFERENCE_OUT_OF_SCOPE')
    expect(moved.selectedNodeId).toBe('producer')
    expect(moved.removedNodeIds).toBeUndefined()
    expect(getBlock(original, 'root').steps[0]).toBe(producer)
  })

  it('refuses descendant moves, required-slot moves, and invalid anchors before removing any source', () => {
    const original = source(block('root', [{ type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: block('body', [block('nested')]) }]))
    const cases = [
      { nodeId: 'loop', target: { kind: 'block' as const, blockId: 'nested' }, code: 'DESCENDANT_TARGET' },
      { nodeId: 'loop', target: { kind: 'block' as const, blockId: 'missing' }, code: 'TARGET_INVALID' },
      { nodeId: 'loop', target: { kind: 'block' as const, blockId: 'root', beforeNodeId: 'missing' }, code: 'TARGET_INVALID' },
      { nodeId: 'body', target: { kind: 'block' as const, blockId: 'root' }, code: 'STRUCTURAL_SLOT' },
    ]
    for (const { nodeId, target, code } of cases) {
      const result = apply(original, { type: 'MOVE_TO', nodeId, target })
      expect(result.source).toBe(original)
      expect(result.error?.code).toBe(code)
    }
  })

  it('recognizes no-op moves and accounts for removal before a same-block insertion anchor', () => {
    const original = source(block('root', [wait('a'), wait('b'), wait('c')]))
    for (const beforeNodeId of ['a', 'b']) expect(apply(original, { type: 'MOVE_TO', nodeId: 'a', target: { kind: 'block', blockId: 'root', beforeNodeId } }).source).toBe(original)
    expect(apply(original, { type: 'MOVE_TO', nodeId: 'c', target: { kind: 'block', blockId: 'root' } }).source).toBe(original)
    const moved = apply(original, { type: 'MOVE_TO', nodeId: 'a', target: { kind: 'block', blockId: 'root', beforeNodeId: 'c' } })
    expect(getBlock(moved.source, 'root').steps.map(node => node.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('safe subtree copies', () => {
  it('remaps nested and forward refs across all ValueExpr forms while preserving external refs and literal text', () => {
    const internal = 'steps.later.value'
    const expression: ValueExpr = { type: 'object', entries: {
      array: { type: 'array', items: [{ type: 'ref', path: internal }, { type: 'ref', path: 'steps.external.value' }] },
      template: { type: 'template', parts: ['steps.later.value', { ref: internal }] },
      call: { type: 'call', function: 'core:eq', arguments: [{ type: 'ref', path: internal }, { type: 'ref', path: 'loop.item' }] },
      literal: { type: 'literal', value: { type: 'ref', path: internal } },
    } }
    const subtree = block('group', [capability('first', { data: expression }), {
      type: 'foreach', id: 'each', items: { type: 'ref', path: 'input.rows' }, body: block('body', [capability('later')]),
    }])
    subtree.output = { result: { type: 'ref', path: internal } }
    const original = frozen(source(block('root', [capability('external'), subtree])))
    const result = apply(original, { type: 'COPY_TO', nodeId: 'group', target: { kind: 'block', blockId: 'root' } })
    expect(result.error).toBeUndefined()
    expect(Object.keys(result.idMap!)).toEqual(['group', 'first', 'each', 'body', 'later'])
    const rewritten = `steps.${result.idMap!.later}.value`
    const copiedFirst = findAutomationControl(result.source, result.idMap!.first!) as Extract<ControlSource, { type: 'capability' }>
    expect(copiedFirst.input.data).toEqual({ type: 'object', entries: {
      array: { type: 'array', items: [{ type: 'ref', path: rewritten }, { type: 'ref', path: 'steps.external.value' }] },
      template: { type: 'template', parts: ['steps.later.value', { ref: rewritten }] },
      call: { type: 'call', function: 'core:eq', arguments: [{ type: 'ref', path: rewritten }, { type: 'ref', path: 'loop.item' }] },
      literal: { type: 'literal', value: { type: 'ref', path: internal } },
    } })
    expect(getBlock(result.source, result.idMap!.group!).output?.result).toEqual({ type: 'ref', path: rewritten })
    expect(getBlock(original, 'root').steps).toHaveLength(2)
    expect(new Set(Object.values(result.idMap!)).size).toBe(5)
  })

  it('maps if/wait/loop expressions and preserves self/forward-reference errors in the copied subtree', () => {
    const reference = { type: 'ref' as const, path: 'steps.later.value' }
    const group = block('group', [
      capability('first', { forward: reference, self: { type: 'ref', path: 'steps.first.value' } }),
      capability('later'),
      { type: 'if', id: 'if', condition: reference, then: block('then', [{ type: 'wait', id: 'until', until: reference }]), else: block('else') },
      { type: 'foreach', id: 'each', items: reference, body: block('body', [{ type: 'wait', id: 'duration', durationMs: reference }]) },
    ])
    const original = source(block('root', [group]))
    const result = apply(original, { type: 'COPY_TO', nodeId: 'group', target: { kind: 'block', blockId: 'root' } })
    const path = `steps.${result.idMap!.later}.value`
    expect(findAutomationControl(result.source, result.idMap!.if!)).toMatchObject({ condition: { type: 'ref', path } })
    expect(findAutomationControl(result.source, result.idMap!.until!)).toMatchObject({ until: { type: 'ref', path } })
    expect(findAutomationControl(result.source, result.idMap!.each!)).toMatchObject({ items: { type: 'ref', path } })
    expect(findAutomationControl(result.source, result.idMap!.duration!)).toMatchObject({ durationMs: { type: 'ref', path } })
    const diagnostics = validateSourceReferences(result.source, new Map())
    expect(diagnostics.filter(problem => problem.code === 'STEP_REFERENCE_NOT_READY')).toHaveLength(4)
    expect(diagnostics.filter(problem => problem.source?.nodeId === result.idMap!.first)).toHaveLength(2)
  })

  it('uses clipboard snapshots after source deletion without recycling IDs or sharing mutable values', () => {
    const original = source(block('root', [capability('copied', { value: { type: 'literal', value: { rows: [1, 2] } } })]))
    const deleted = apply(original, { type: 'DELETE_STEP', nodeId: 'copied' }).source
    const result = apply(deleted, { type: 'COPY_TO', nodeId: 'copied', source: frozen(original), target: { kind: 'block', blockId: 'root' } })
    expect(result.selectedNodeId).not.toBe('copied')
    expect(result.idMap?.copied).toBe(result.selectedNodeId)
    const copied = findAutomationControl(result.source, result.selectedNodeId!) as Extract<ControlSource, { type: 'capability' }>
    expect(copied.input).toEqual((findAutomationControl(original, 'copied') as typeof copied).input)
    expect(copied.input).not.toBe((findAutomationControl(original, 'copied') as typeof copied).input)
  })

  it.each(['steps["a"].value', 'steps..value', '${steps.a.value}', 'old:a.value'])('explicitly refuses unrecognized reference format %s', path => {
    const original = source(block('root', [capability('a', { value: { type: 'ref', path } })]))
    const copied = apply(original, { type: 'COPY_TO', nodeId: 'a', target: { kind: 'block', blockId: 'root' } })
    expect(copied.error?.code).toBe('COPY_UNSAFE')
    expect(copied.source).toBe(original)
  })

  it('rejects dotted, ambiguous, duplicate and unknown-expression IDs without guessing references', () => {
    const examples = [
      source(block('root', [capability('a.b')])),
      source(block('root', [capability('a'), capability('a.b'), capability('reader', { value: { type: 'ref', path: 'steps.a.b.value' } })])),
      source(block('root', [capability('a'), capability('a')])),
      source(block('root', [capability('a', { value: { type: 'legacy', payload: 'steps.a.value' } as unknown as ValueExpr })])),
    ]
    for (const original of examples) {
      const copied = apply(original, { type: 'COPY_TO', nodeId: 'root', target: { kind: 'block', blockId: 'root' } })
      expect(copied.source).toBe(original)
      expect(copied.error?.code).toBe('COPY_UNSAFE')
    }
  })

  it('preserves opaque extension payload on movement and refuses copying an ancestor containing it', () => {
    const extension = { type: 'extension', id: 'opaque', control: { id: 'unknown', version: 77 }, input: {}, payload: { ref: 'steps.opaque.value', secretShape: [1, 2] } } as ControlSource
    const original = frozen(source(block('root', [block('group', [extension]), block('destination')])))
    expect(automationNodeCopyError(original, 'group')).toMatch(/extension/)
    const copied = apply(original, { type: 'COPY_TO', nodeId: 'group', target: { kind: 'block', blockId: 'destination' } })
    expect(copied.error?.code).toBe('COPY_UNSAFE')
    const moved = apply(original, { type: 'MOVE_TO', nodeId: 'opaque', target: { kind: 'block', blockId: 'destination' } })
    expect(getBlock(moved.source, 'destination').steps[0]).toBe(extension)
    expect(apply(moved.source, { type: 'DELETE_STEP', nodeId: 'opaque' }).removedNodeIds).toEqual(['opaque'])
  })
})
