import type { AutomationSource, ControlSource, NumenValue, ValueExpr } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { AutomationComparisonLimitError, AutomationComparisonUnavailableError, compareAutomationDocumentPage, compareAutomationDocuments } from '../src/automation-comparison.js'

const literal = (value: NumenValue): ValueExpr => ({ type: 'literal', value })
const wait = (id: string): ControlSource => ({ type: 'wait', id, durationMs: literal(10) })
const block = (id: string, steps: ControlSource[] = []): ControlSource => ({ type: 'block', id, steps })
const source = (steps: ControlSource[] = []): AutomationSource => ({ triggers: [], flow: block('root', steps) })
const document = (source: AutomationSource, presentation: Record<string, NumenValue> = {}) => ({ source, presentation, protocolVersion: 1 })
const compare = (a: AutomationSource, b: AutomationSource, presentationA: Record<string, NumenValue> = {}, presentationB: Record<string, NumenValue> = {}) => compareAutomationDocuments(document(a, presentationA), document(b, presentationB))
const action = (id: string): ControlSource => ({ type: 'capability', id, capability: { id: 'test:action', version: 1 }, input: { secret: literal('PRIVATE_VALUE_OLD') }, connections: { default: 'PRIVATE_CONNECTION_OLD' }, policy: { timeoutMs: 20 } })
const mutable = (value: unknown) => value as Record<string, any>

describe('Bounded Automation semantic comparison', () => {
  it('pages every change beyond 1,000 results without returning authored values or duplicate pages', () => {
    const before = source(Array.from({ length: 300 }, (_, index) => action(`node-${index}`)))
    const after = structuredClone(before)
    for (const node of mutable(after.flow).steps) {
      node.input.secret = literal('PRIVATE_NEW_VALUE')
      node.connections.default = 'PRIVATE_NEW_CONNECTION'
      node.policy.timeoutMs = 100
      node.future = 'PRIVATE_NEW_EXTENSION'
    }
    const collected = []
    let offset = 0
    do {
      const page = compareAutomationDocumentPage(document(before), document(after), offset)
      expect(page.totalChanges).toBe(1_200)
      expect(page.changes.length).toBeLessThanOrEqual(250)
      expect(JSON.stringify(page)).not.toContain('PRIVATE_')
      collected.push(...page.changes)
      if (page.nextChangeOffset === undefined) break
      expect(page.nextChangeOffset).toBeGreaterThan(offset)
      offset = page.nextChangeOffset
    } while (true)
    expect(collected).toHaveLength(1_200)
    expect(new Set(collected.map(change => `${change.nodeId}:${change.category}`)).size).toBe(1_200)
    expect(collected.at(-1)?.nodeId).toBe('node-299')
  })

  it('moves a subtree once amid additions, deletions and parameter edits without moving its descendants', () => {
    const a = source([block('container', [wait('kept-child'), action('parameter-step')]), wait('kept-sibling'), wait('removed'), { type: 'if', id: 'condition', condition: literal(true), then: block('then') }])
    const b = structuredClone(a)
    const steps = mutable(b.flow).steps as ControlSource[]
    const container = steps.shift()!
    mutable(container).steps[1].input.secret = { type: 'ref', path: 'input.PRIVATE_REFERENCE_CANARY' }
    steps.splice(1, 1)
    steps.unshift(wait('added'))
    mutable(steps[2]).then.steps.push(container)
    const changes = compare(a, b)
    expect(changes.filter(item => item.category === 'structure')).toEqual([
      { category: 'structure', kind: 'removed', field: 'node', nodeId: 'removed' },
      { category: 'structure', kind: 'added', field: 'node', nodeId: 'added' },
      { category: 'structure', kind: 'moved', field: 'node', nodeId: 'container' },
    ])
    expect(changes).toContainEqual({ category: 'parameters', kind: 'changed', field: 'input', nodeId: 'parameter-step' })
    expect(JSON.stringify(changes)).not.toContain('PRIVATE_')
    expect(compare(a, structuredClone(a))).toEqual([])
  })

  it('keeps surviving sibling positions stable across insertion and deletion, and minimizes reorder moves', () => {
    const a = source(['a', 'b', 'c', 'removed'].map(wait))
    const b = source(['added', 'a', 'b', 'c'].map(wait))
    expect(compare(a, b).filter(item => item.kind === 'moved')).toEqual([])
    const reordered = source(['added', 'c', 'a', 'b'].map(wait))
    expect(compare(a, reordered).filter(item => item.kind === 'moved')).toEqual([{ category: 'structure', kind: 'moved', field: 'node', nodeId: 'c' }])
  })

  it('distinguishes branch slots and branch reordering while keeping each branch subtree intact', () => {
    const a = source([{ type: 'parallel', id: 'parallel', branches: ['a', 'b', 'c'].map(id => block(id, [wait(`${id}-child`)])) },
      { type: 'if', id: 'if', condition: literal(true), then: block('then', [wait('then-child')]), else: block('else', [wait('else-child')]) }])
    const b = structuredClone(a)
    const parallel = mutable(b.flow).steps[0], conditional = mutable(b.flow).steps[1]
    parallel.branches.unshift(parallel.branches.pop())
    ;[conditional.then, conditional.else] = [conditional.else, conditional.then]
    expect(compare(a, b).filter(item => item.kind === 'moved').map(item => item.nodeId)).toEqual(['c', 'else', 'then'])
  })

  it('reports a changed node type under the same stable ID without deletion and recreation', () => {
    expect(compare(source([wait('same')]), source([block('same', [wait('new-child')])]))).toEqual([
      { category: 'structure', kind: 'added', field: 'node', nodeId: 'new-child' },
      { category: 'structure', kind: 'changed', field: 'type', nodeId: 'same' },
    ])
  })

  it('separates all semantic categories and never returns their authored values, keys, paths or titles', () => {
    const a = source([action('action'), { type: 'extension', id: 'extension', control: { id: 'unknown:control', version: 1 }, input: { PRIVATE_FIELD_OLD: literal('PRIVATE_EXTENSION_OLD') } }])
    a.inputs = { PRIVATE_INPUT_NAME: { type: 'string', title: 'PRIVATE_TITLE_OLD', default: 'PRIVATE_DEFAULT_OLD' } }
    a.policy = { maxActive: 1, overflow: 'queue', groupBy: literal('PRIVATE_GROUP_OLD') }
    a.triggers = [{ id: 'trigger', capability: { id: 'test:trigger', version: 1 }, config: { PRIVATE_CONFIG_NAME: 'PRIVATE_CONFIG_OLD' }, connection: 'PRIVATE_TRIGGER_BINDING_OLD' }]
    mutable(a).PRIVATE_EXTENSION_KEY = 'PRIVATE_TOP_LEVEL_OLD'
    const b = structuredClone(a)
    const step = mutable(b.flow).steps[0]
    step.capability.version = 2
    step.input = { PRIVATE_FIELD_NEW: { type: 'template', parts: ['<img src=x onerror=alert(1)>', { ref: 'input.PRIVATE_PATH_NEW' }] } }
    step.connections.default = 'PRIVATE_CONNECTION_NEW'; step.policy = { timeoutMs: 40, retry: { maxAttempts: 2 } }
    mutable(b.flow).steps[1].input.PRIVATE_FIELD_OLD = literal('PRIVATE_EXTENSION_NEW')
    b.inputs!.PRIVATE_INPUT_NAME!.default = 'PRIVATE_DEFAULT_NEW'
    b.policy!.maxActive = 2
    b.triggers[0]!.capability.version = 2
    b.triggers[0]!.config.PRIVATE_CONFIG_NAME = 'PRIVATE_CONFIG_NEW'
    b.triggers[0]!.connection = 'PRIVATE_TRIGGER_BINDING_NEW'
    mutable(b).PRIVATE_EXTENSION_KEY = 'PRIVATE_TOP_LEVEL_NEW'
    const before = structuredClone({ a, b })
    const changes = compare(a, b, { PRIVATE_PRESENTATION_KEY: 'PRIVATE_PRESENTATION_OLD' }, { PRIVATE_PRESENTATION_KEY: 'PRIVATE_PRESENTATION_NEW' })
    expect(new Set(changes.map(item => item.category))).toEqual(new Set(['structure', 'parameters', 'bindings', 'policies', 'triggers', 'inputs', 'presentation', 'extensions']))
    expect(changes).toContainEqual({ category: 'extensions', kind: 'changed', field: 'extensionFields', nodeId: 'extension' })
    expect(changes.filter(item => item.nodeId === 'extension' && item.category === 'parameters')).toEqual([])
    expect(changes.filter(item => item.category === 'triggers').map(item => item.field)).toEqual(['triggerCapability', 'triggerConfig'])
    expect(JSON.stringify(changes)).not.toMatch(/PRIVATE_|<img|onerror|input\./)
    expect({ a, b }).toEqual(before)
    for (const item of changes) expect(Object.keys(item).every(key => ['category', 'kind', 'field', 'nodeId'].includes(key))).toBe(true)
  })

  it('classifies unknown fields at their actual location as opaque extensions, including expression and policy extras', () => {
    const a = source([action('action')]), b = structuredClone(a)
    const prior = mutable(a.flow).steps[0], next = mutable(b.flow).steps[0]
    prior.input.secret.PRIVATE_EXPRESSION_EXTENSION = { secret: 'OLD' }
    next.input.secret.PRIVATE_EXPRESSION_EXTENSION = { secret: 'NEW' }
    prior.capability.PRIVATE_REF_EXTENSION = 'REF'
    next.policy.PRIVATE_REF_EXTENSION = 'REF'
    prior.PRIVATE_NODE_EXTENSION = 'OLD'; next.PRIVATE_NODE_EXTENSION = 'NEW'
    a.inputs = { input: { type: 'number' } }; b.inputs = { input: { type: 'number' } }
    mutable(a.inputs.input).PRIVATE_DECLARATION_EXTENSION = true
    mutable(b.inputs.input).PRIVATE_DECLARATION_EXTENSION = false
    expect(compare(a, b)).toEqual([
      { category: 'extensions', kind: 'changed', field: 'extensionFields', nodeId: 'action' },
      { category: 'extensions', kind: 'changed', field: 'extensionFields' },
    ])
  })

  it('does not mistake object key insertion order, Trigger order or absent optional empty configuration for changes', () => {
    const a = source([action('action')]), b = structuredClone(a)
    mutable(a.flow).steps[0].input = { value: { type: 'object', entries: { a: literal({ z: 1, a: 2 }), b: literal(3) } } }
    mutable(b.flow).steps[0].input = { value: { entries: { b: literal(3), a: literal({ a: 2, z: 1 }) }, type: 'object' } }
    a.triggers = ['first', 'second'].map(id => ({ id, capability: { id: 'test:trigger', version: 1 }, config: { z: 1, a: 2 } }))
    b.triggers = [...a.triggers].reverse().map(item => ({ ...item, config: { a: 2, z: 1 } }))
    b.inputs = {}; b.policy = {}
    expect(compare(a, b, { z: true, a: false }, { a: false, z: true })).toEqual([])
    a.inputs = { input: { type: 'string' } }; b.inputs = { input: { type: 'string', required: false } }
    expect(compare(a, b)).toEqual([])
  })

  it('keeps ordered expression arrays significant and reports known parameter expressions using fixed field labels', () => {
    const a = source([{ type: 'if', id: 'condition', condition: { type: 'ref', path: 'input.old' }, then: block('then') },
      { type: 'wait', id: 'wait', until: literal('2026-10-08'), durationMs: literal(1) },
      { type: 'foreach', id: 'foreach', items: { type: 'array', items: [literal(1), literal(2)] }, body: block('body'), concurrency: 1 }])
    mutable(a.flow).output = { value: { type: 'call', function: 'unknown:function', arguments: [literal(1)] } }
    const b = structuredClone(a), steps = mutable(b.flow).steps
    steps[0].condition.path = 'input.new'; steps[1].until.value = '2026-10-09'; delete steps[1].durationMs
    steps[2].items.items.reverse(); steps[2].concurrency = 2
    mutable(b.flow).output.value.arguments.push(literal(2))
    expect(compare(a, b).map(item => [item.category, item.field])).toEqual([
      ['parameters', 'output'], ['parameters', 'condition'], ['parameters', 'until'], ['parameters', 'durationMs'], ['parameters', 'items'], ['policies', 'concurrency'],
    ])
  })

  it('normalizes a legacy Connection as the default slot while preserving conflicts and other named slots', () => {
    const a = source([action('action')]), b = structuredClone(a)
    const prior = mutable(a.flow).steps[0], next = mutable(b.flow).steps[0]
    prior.connection = prior.connections.default; delete prior.connections
    expect(compare(a, b)).toEqual([])
    prior.connections = { default: prior.connection }
    expect(compare(a, b)).toEqual([])
    prior.connection = 'PRIVATE_CONFLICT'
    expect(compare(a, b)).toEqual([{ category: 'bindings', kind: 'changed', field: 'connections', nodeId: 'action' }])
    prior.connection = next.connections.default; delete prior.connections
    next.connections = { named: prior.connection }
    expect(compare(a, b)).toEqual([{ category: 'bindings', kind: 'changed', field: 'connections', nodeId: 'action' }])
  })

  it('keeps hidden metadata keys such as __proto__ as data when comparing declarations and bindings', () => {
    const a = source([action('action')]), b = structuredClone(a)
    a.inputs = JSON.parse('{"__proto__":{"type":"string","default":"PRIVATE_OLD"}}')
    b.inputs = JSON.parse('{"__proto__":{"type":"string","default":"PRIVATE_NEW"}}')
    mutable(a.flow).steps[0].connections = JSON.parse('{"__proto__":"PRIVATE_OLD"}')
    mutable(b.flow).steps[0].connections = JSON.parse('{"__proto__":"PRIVATE_NEW"}')
    expect(compare(a, b).map(item => item.category)).toEqual(['bindings', 'inputs'])
    expect(Object.prototype).not.toHaveProperty('default')
  })

  it('aggregates Trigger additions and removals without exposing names or private configuration', () => {
    const a = source(), b = source()
    a.triggers = [{ id: 'removed-trigger', capability: { id: 'test:trigger', version: 1 }, config: { secret: 'PRIVATE_OLD' } }]
    b.triggers = [{ id: 'added-trigger', capability: { id: 'test:trigger', version: 1 }, config: { secret: 'PRIVATE_NEW' } }]
    expect(compare(a, b)).toEqual([{ category: 'triggers', kind: 'removed', field: 'triggers' }, { category: 'triggers', kind: 'added', field: 'triggers' }])
  })

  it.each([
    ['duplicate node identities', () => source([wait('same'), block('same')])],
    ['unknown control shape', () => source([mutable({ id: 'unknown', type: 'PRIVATE_UNKNOWN_TYPE', children: [] }) as ControlSource])],
    ['non-array block children', () => mutable({ triggers: [], flow: { type: 'block', id: 'root', steps: 'PRIVATE_BAD_CHILDREN' } }) as AutomationSource],
    ['invalid branch block', () => source([{ type: 'if', id: 'if', condition: literal(true), then: wait('not-block') as any }])],
    ['missing parameter expression', () => source([{ type: 'if', id: 'if', then: block('then') } as any])],
    ['unknown expression type', () => source([{ type: 'wait', id: 'wait', until: { type: 'PRIVATE_UNKNOWN_EXPR' } } as any])],
    ['malformed literal expression', () => source([{ type: 'wait', id: 'wait', until: { type: 'literal' } } as any])],
    ['malformed capability identity', () => source([{ type: 'capability', id: 'action', capability: { id: 'PRIVATE_BAD_CAP', version: 'invalid' }, input: {} } as any])],
    ['malformed binding', () => source([{ type: 'capability', id: 'action', capability: { id: 'test:action', version: 1 }, input: {}, connections: { default: 1 } } as any])],
    ['invalid input declaration', () => ({ ...source(), inputs: { input: { type: 'PRIVATE_UNKNOWN_DECLARATION' } } }) as AutomationSource],
    ['duplicate Trigger identities', () => ({ ...source(), triggers: [1, 2].map(() => ({ id: 'same', capability: { id: 'test:trigger', version: 1 }, config: {} })) })],
    ['invalid node identity', () => source([wait('<script>PRIVATE_BAD_ID</script>')])],
  ])('rejects %s with a generic failure, on either comparison side', (_name, fixture) => {
    for (const [a, b] of [[fixture(), source()], [source(), fixture()]]) {
      try { compare(a!, b!); expect.fail('Expected an unavailable comparison') } catch (error) {
        expect(error).toBeInstanceOf(AutomationComparisonUnavailableError)
        expect(String(error)).not.toContain('PRIVATE_')
      }
    }
  })

  it('rejects cyclic, non-JSON, non-finite and custom-prototype data before comparison', () => {
    const cycle = source(); mutable(cycle).PRIVATE_CYCLE = cycle
    const date = source(); mutable(date).PRIVATE_DATE = new Date()
    const infinity = source(); mutable(infinity).PRIVATE_INFINITY = Infinity
    const bigInt = source(); mutable(bigInt).PRIVATE_BIGINT = 1n
    for (const invalid of [cycle, date, infinity, bigInt]) expect(() => compare(invalid, source())).toThrow(AutomationComparisonUnavailableError)
  })

  it('checks protocol support before traversing unknown future documents', () => {
    const future = { source: null, presentation: null, protocolVersion: 99 } as unknown as ReturnType<typeof document>
    expect(() => compareAutomationDocuments(future, document(source()))).toThrow(AutomationComparisonUnavailableError)
    expect(() => compareAutomationDocuments(document(source()), future)).toThrow(AutomationComparisonUnavailableError)
  })

  it('accepts exact node and flow-depth bounds and rejects one extra rather than emitting a partial diff', () => {
    expect(compare(source(Array.from({ length: 249 }, (_, index) => wait(`wait-${index}`))), source())).toHaveLength(249)
    const wide = source(Array.from({ length: 9_999 }, (_, index) => wait(`wait-${index}`)))
    expect(compare(wide, wide)).toEqual([])
    expect(() => compare(source(Array.from({ length: 10_000 }, (_, index) => wait(`wait-${index}`))), source())).toThrow(AutomationComparisonLimitError)
    const deep = (depth: number): AutomationSource => {
      let node = wait('leaf')
      for (let index = 0; index < depth; index++) node = block(`depth-${index}`, [node])
      return { triggers: [], flow: node }
    }
    expect(compare(deep(64), deep(64))).toEqual([])
    expect(() => compare(deep(65), source())).toThrow(AutomationComparisonLimitError)
  })

  it('bounds expression depth, Presentation depth and total JSON entries', () => {
    const nestedExpression = (depth: number): ValueExpr => {
      let expr = literal('PRIVATE_LEAF')
      for (let index = 0; index < depth; index++) expr = { type: 'array', items: [expr] }
      return expr
    }
    const a = source([{ type: 'wait', id: 'wait', until: nestedExpression(64) }])
    expect(compare(a, a)).toEqual([])
    expect(() => compare(source([{ type: 'wait', id: 'wait', until: nestedExpression(65) }]), source())).toThrow(AutomationComparisonLimitError)
    let nested: NumenValue = null
    for (let index = 0; index < 65; index++) nested = { child: nested }
    expect(() => compare(source(), source(), { nested })).toThrow(AutomationComparisonLimitError)
    const wide = source(); mutable(wide).PRIVATE_WIDE_DATA = Array.from({ length: 100_000 }, () => null)
    expect(() => compare(wide, source())).toThrow(AutomationComparisonLimitError)
  })

  it('bounds declarations, Triggers, metadata and UTF-8 bytes before generating changes', () => {
    const a = source()
    a.inputs = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`input-${index}`, { type: 'string' as const }]))
    a.triggers = Array.from({ length: 100 }, (_, index) => ({ id: `trigger-${index}`, capability: { id: 'test:trigger', version: 1 }, config: {} }))
    expect(compare(a, a)).toEqual([])
    const extraInput = structuredClone(a); extraInput.inputs!.extra = { type: 'string' }
    expect(() => compare(extraInput, a)).toThrow(AutomationComparisonLimitError)
    const extraTrigger = structuredClone(a); extraTrigger.triggers.push({ ...a.triggers[0]!, id: 'extra' })
    expect(() => compare(a, extraTrigger)).toThrow(AutomationComparisonLimitError)
    expect(compare(source([wait('a'.repeat(160))]), source())).toHaveLength(1)
    expect(() => compare(source([wait('a'.repeat(161))]), source())).toThrow(AutomationComparisonLimitError)
    const bytes = source(); mutable(bytes).PRIVATE_LARGE = '🙂'.repeat(2_100_000)
    expect(() => compare(bytes, source())).toThrow(AutomationComparisonLimitError)
  })

  it('rejects excessive changes as a whole and never pretends a truncated comparison is complete', () => {
    const a = source(Array.from({ length: 249 }, (_, index) => action(`action-${index}`))), b = structuredClone(a)
    for (const step of mutable(b.flow).steps) {
      step.capability.version = 2; step.input.secret.value = 'PRIVATE_NEW'
      step.connections.default = 'PRIVATE_NEW'; step.policy.timeoutMs = 40; step.PRIVATE_EXTENSION = true
    }
    expect(() => compare(a, b)).toThrow(AutomationComparisonLimitError)
  })
})
