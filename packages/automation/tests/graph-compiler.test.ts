import type { AutomationSource, CapabilityDefinition, CapabilitySource, GraphEdge, GraphNodeSource, GraphSource, ValueExpr } from '@numenjs/core'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { AutomationCompileError, compileAutomation } from '../src/compiler.js'

const definition: CapabilityDefinition = {
  id: 'test:value', version: 1, kind: 'action', title: 'Value',
  input: z.object({ value: z.any().required() }), output: z.object({ value: z.any() }),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
}
const resolver = { get: () => ({ definition, providerAvailable: true }) }
const literal = (value: boolean | number | string | null): ValueExpr => ({ type: 'literal', value })
const ref = (path: string): ValueExpr => ({ type: 'ref', path })
const action = (id: string, value: ValueExpr = literal(1)): CapabilitySource => ({
  type: 'capability', id, capability: { id: definition.id, version: 1 }, input: { value },
})
const condition = (id: string): GraphNodeSource => ({ type: 'condition', id, condition: ref(`input.${id}`) })
const merge = (id: string, mode: 'all' | 'selected', ...inputs: string[]): GraphNodeSource => ({ type: 'merge', id, mode, inputs })
const edge = (from: string, to: string, fromPort = 'out', toPort = 'in'): GraphEdge => ({
  id: `${from}-${fromPort}-${to}-${toPort}`, from: { nodeId: from, port: fromPort }, to: { nodeId: to, port: toPort },
})
const start = (to: string): GraphEdge => edge('flow', to, 'start')
const graph = (nodes: GraphNodeSource[], edges: GraphEdge[], output?: ValueExpr): GraphSource => ({
  type: 'graph', id: 'flow', version: 1, nodes, edges, ...(output ? { output } : {}),
})
const source = (flow: GraphSource): AutomationSource => ({ triggers: [], flow })
const simple = (): GraphSource => graph([action('one')], [start('one')], ref('steps.one.value'))
const branch = (): GraphSource => graph([
  condition('choice'), action('yes'), action('no'), merge('selected', 'selected', 'yes', 'no'), action('after', ref('steps.selected.value')),
], [start('choice'), edge('choice', 'yes', 'true'), edge('choice', 'no', 'false'),
  edge('yes', 'selected', 'out', 'yes'), edge('no', 'selected', 'out', 'no'), edge('selected', 'after')], ref('steps.after.value'))
function errors(flow: GraphSource, candidate = source(flow)) {
  try { compileAutomation(candidate, resolver) } catch (error) {
    expect(error).toBeInstanceOf(AutomationCompileError)
    return (error as AutomationCompileError).diagnostics
  }
  throw Error('Expected compile failure')
}

describe('graph compilation', () => {
  it('emits a versioned graph scope, independent invokes, and an explicit fixed result without changing the Source', () => {
    const candidate = source(simple())
    const original = structuredClone(candidate)
    const result = compileAutomation(candidate, resolver)
    expect(result.plan).toEqual({ irVersion: 2, entry: 'flow', instructions: {
      __complete: { op: 'complete', id: '__complete', output: ref('steps.flow') },
      flow: { op: 'graph_scope', id: 'flow', version: 1, members: ['one'], edges: [start('one')], output: ref('steps.one.value'), next: '__complete' },
      one: { op: 'invoke', id: 'one', capability: { id: definition.id, version: 1 }, input: { type: 'object', entries: { value: literal(1) } } },
    } })
    expect(result.dependencyManifest.capabilities).toEqual([{ id: definition.id, version: 1, kind: 'action' }])
    expect(result.contractSnapshot.capabilities).toEqual([expect.objectContaining({ id: definition.id, outputSchema: expect.any(Object) })])
    expect(candidate).toEqual(original)
  })

  it('preserves pure Structured IR v1 and allows an empty Graph scope', () => {
    const legacy = compileAutomation({ triggers: [], flow: action('one') }, resolver).plan
    expect(legacy.irVersion).toBe(1)
    expect(legacy.instructions.one).toMatchObject({ op: 'invoke', next: '__complete' })
    expect(legacy.instructions.__complete).toEqual({ op: 'complete', id: '__complete' })
    expect(compileAutomation(source(graph([], [])), resolver).plan.instructions.flow).toEqual({
      op: 'graph_scope', id: 'flow', version: 1, members: [], edges: [], next: '__complete',
    })
  })

  it('supports shared downstream, cross-dependencies, and transitive references independent of authoring order', () => {
    const flow = graph([action('last', { type: 'object', entries: { first: ref('steps.first.value'), second: ref('steps.second.value') } }),
      action('second'), action('first'), action('middle', ref('steps.first.value'))], [
      start('first'), start('second'), edge('first', 'middle'), edge('middle', 'last'), edge('second', 'last'),
    ], ref('steps.last.value'))
    const first = compileAutomation(source(flow), resolver)
    flow.nodes.reverse(); flow.edges.reverse()
    expect(compileAutomation(source(flow), resolver)).toEqual(first)
    expect(Object.values(first.plan.instructions).filter(item => item.op === 'invoke')).toHaveLength(4)
    for (const instruction of Object.values(first.plan.instructions)) if (instruction.op === 'invoke') expect(instruction).not.toHaveProperty('next')
  })

  it('compiles 300 members without truncation and retains shared expression objects as separate authored fields', () => {
    const shared = literal('shared')
    const nodes = Array.from({ length: 300 }, (_, index) => action(`node-${index}`, index % 2 ? ref(`steps.node-${index - 1}.value`) : shared))
    const edges = [start('node-0'), ...nodes.slice(1).map((node, index) => edge(`node-${index}`, node.id))]
    const result = compileAutomation(source(graph(nodes, edges, ref('steps.node-299.value'))), resolver)
    expect(result.plan.instructions.flow).toMatchObject({ members: expect.any(Array) })
    const scope = result.plan.instructions.flow
    if (scope?.op !== 'graph_scope') throw Error('fixture')
    expect(scope.members).toHaveLength(300)
    expect(scope.edges).toHaveLength(300)
    expect(result.plan.instructions['node-299']).toMatchObject({ op: 'invoke' })
  })

  it('emits named all-input merges and selected merges with their output contracts intact', () => {
    const all = graph([action('left'), action('right'), merge('together', 'all', 'leftValue', 'rightValue'),
      action('after', ref('steps.together.leftValue.value'))], [start('left'), start('right'),
      edge('left', 'together', 'out', 'leftValue'), edge('right', 'together', 'out', 'rightValue'), edge('together', 'after')], ref('steps.together'))
    expect(compileAutomation(source(all), resolver).plan.instructions.together).toEqual({
      op: 'graph_merge', id: 'together', mode: 'all', inputs: ['leftValue', 'rightValue'],
    })
    const result = compileAutomation(source(branch()), resolver)
    expect(result.plan.instructions.choice).toEqual({ op: 'graph_condition', id: 'choice', condition: ref('input.choice') })
    expect(result.plan.instructions.selected).toEqual({ op: 'graph_merge', id: 'selected', mode: 'selected', inputs: ['yes', 'no'] })
  })

  it('proves exclusivity through nested conditions and prior selected merges', () => {
    const flow = graph([condition('outer'), condition('inner'), action('a'), action('b'), action('c'),
      merge('inner-result', 'selected', 'a', 'b'), merge('result', 'selected', 'inner', 'outer')], [
      start('outer'), edge('outer', 'inner', 'true'), edge('outer', 'c', 'false'),
      edge('inner', 'a', 'true'), edge('inner', 'b', 'false'),
      edge('a', 'inner-result', 'out', 'a'), edge('b', 'inner-result', 'out', 'b'),
      edge('inner-result', 'result', 'out', 'inner'), edge('c', 'result', 'out', 'outer'),
    ], ref('steps.result'))
    expect(() => compileAutomation(source(flow), resolver)).not.toThrow()
  })

  it('rejects independently selected branches that can both succeed', () => {
    const flow = graph([condition('left'), condition('right'), action('a'), action('b'), merge('bad', 'selected', 'a', 'b')], [
      start('left'), start('right'), edge('left', 'a', 'true'), edge('right', 'b', 'false'),
      edge('a', 'bad', 'out', 'a'), edge('b', 'bad', 'out', 'b'),
    ])
    expect(errors(flow)).toContainEqual(expect.objectContaining({ code: 'GRAPH_MERGE_NOT_EXCLUSIVE', source: { nodeId: 'bad', fieldPath: 'inputs' } }))
  })

  it('requires structural exclusivity even when separate condition expressions look equivalent', () => {
    const left: GraphNodeSource = { type: 'condition', id: 'left', condition: ref('input.choice') }
    const right: GraphNodeSource = { type: 'condition', id: 'right', condition: ref('input.choice') }
    const flow = graph([left, right, merge('bad', 'selected', 'yes', 'no')], [
      start('left'), start('right'), edge('left', 'bad', 'true', 'yes'), edge('right', 'bad', 'false', 'no'),
    ])
    expect(errors(flow)).toContainEqual(expect.objectContaining({ code: 'GRAPH_MERGE_NOT_EXCLUSIVE' }))
  })

  it('treats null and empty arrays as ordinary values rather than activation states', () => {
    const flow = graph([action('null-value', literal(null)), action('empty', { type: 'array', items: [] }), merge('result', 'all', 'null', 'empty')], [
      start('null-value'), start('empty'), edge('null-value', 'result', 'out', 'null'), edge('empty', 'result', 'out', 'empty'),
    ], ref('steps.result'))
    const nullable = { ...definition, input: z.object({ value: z.any() }) }
    expect(() => compileAutomation(source(flow), { get: () => ({ definition: nullable, providerAvailable: true }) })).not.toThrow()
  })

  it.each([
    ['unsupported version', (flow: GraphSource) => { (flow as { version: number }).version = 2 }, 'GRAPH_VERSION_UNSUPPORTED'],
    ['dotted scope id', (flow: GraphSource) => { flow.id = 'scope.dotted' }, 'GRAPH_NODE_ID_INVALID'],
    ['dotted member id', (flow: GraphSource) => { flow.nodes[0]!.id = 'a.b' }, 'GRAPH_NODE_ID_INVALID'],
    ['reserved member id', (flow: GraphSource) => { flow.nodes[0]!.id = 'constructor' }, 'GRAPH_NODE_ID_INVALID'],
    ['duplicate member', (flow: GraphSource) => { flow.nodes.push(action('one')) }, 'DUPLICATE_NODE_ID'],
    ['member matches scope', (flow: GraphSource) => { flow.nodes.push(action('flow')) }, 'DUPLICATE_NODE_ID'],
    ['duplicate edge id', (flow: GraphSource) => { flow.nodes.push(action('two')); flow.edges.push({ ...start('two'), id: flow.edges[0]!.id }) }, 'GRAPH_EDGE_ID_DUPLICATE'],
    ['duplicate endpoints', (flow: GraphSource) => { flow.edges.push({ ...start('one'), id: 'copy' }) }, 'GRAPH_EDGE_DUPLICATE'],
    ['missing source', (flow: GraphSource) => { flow.edges[0]!.from.nodeId = 'elsewhere' }, 'GRAPH_EDGE_NODE_MISSING'],
    ['missing target', (flow: GraphSource) => { flow.edges[0]!.to.nodeId = 'elsewhere' }, 'GRAPH_EDGE_NODE_MISSING'],
    ['target scope', (flow: GraphSource) => { flow.edges[0]!.to.nodeId = 'flow' }, 'GRAPH_EDGE_NODE_MISSING'],
    ['source input port', (flow: GraphSource) => { flow.edges.push(edge('one', 'one', 'in')) }, 'GRAPH_EDGE_PORT_INVALID'],
    ['target output port', (flow: GraphSource) => { flow.edges[0]!.to.port = 'out' }, 'GRAPH_EDGE_PORT_INVALID'],
    ['unknown start port', (flow: GraphSource) => { flow.edges[0]!.from.port = 'out' }, 'GRAPH_EDGE_PORT_INVALID'],
    ['last dependency removed', (flow: GraphSource) => { flow.edges = [] }, 'GRAPH_INPUT_MISSING'],
    ['cycle', (flow: GraphSource) => { flow.nodes.push(action('two')); flow.edges.push(edge('one', 'two'), edge('two', 'one')) }, 'GRAPH_CYCLE'],
    ['unsupported nested graph member', (flow: GraphSource) => { flow.nodes.push({ ...graph([], []), id: 'nested' } as unknown as GraphNodeSource) }, 'GRAPH_NODE_UNSUPPORTED'],
    ['unsupported wait member', (flow: GraphSource) => { flow.nodes.push({ type: 'wait', id: 'wait', durationMs: literal(1) } as unknown as GraphNodeSource) }, 'GRAPH_NODE_UNSUPPORTED'],
  ] as const)('diagnoses %s without altering the draft', (_label, change, code) => {
    const flow = simple()
    change(flow)
    const original = structuredClone(flow)
    expect(errors(flow)).toContainEqual(expect.objectContaining({ code }))
    expect(flow).toEqual(original)
  })

  it('diagnoses disconnected components without inferring new entry nodes', () => {
    const flow = graph([action('a'), action('b')], [edge('a', 'b'), edge('b', 'a')])
    const diagnostics = errors(flow)
    expect(diagnostics.filter(item => item.code === 'GRAPH_NODE_UNREACHABLE').map(item => item.source?.nodeId)).toEqual(['a', 'b'])
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'GRAPH_CYCLE' }))
  })

  it.each([
    [merge('merge', 'all', 'value', 'value'), [], 'GRAPH_MERGE_INPUT_DUPLICATE'],
    [merge('merge', 'all', ''), [], 'GRAPH_MERGE_INPUTS_INVALID'],
    [merge('merge', 'all', 'a.b'), [], 'GRAPH_MERGE_INPUTS_INVALID'],
    [merge('merge', 'all', 'constructor'), [], 'GRAPH_MERGE_INPUTS_INVALID'],
    [merge('merge', 'all', 'value'), [edge('flow', 'merge', 'start', 'value')], 'GRAPH_START_DATA_INVALID'],
    [merge('merge', 'all', 'value'), [edge('one', 'merge', 'out', 'wrong')], 'GRAPH_EDGE_PORT_INVALID'],
    [merge('merge', 'all', 'value'), [edge('one', 'merge', 'out', 'value'), edge('two', 'merge', 'out', 'value')], 'GRAPH_MERGE_INPUT_CARDINALITY'],
    [merge('merge', 'all', 'value', 'other'), [edge('one', 'merge', 'out', 'value')], 'GRAPH_MERGE_INPUT_CARDINALITY'],
  ] as const)('validates merge declarations and input cardinality (%#)', (node, connections, code) => {
    expect(errors(graph([action('one'), action('two'), node], [start('one'), start('two'), ...connections])))
      .toContainEqual(expect.objectContaining({ code }))
  })

  it('keeps nested graph scopes unsupported in ordinary Blocks and ForEach bodies', () => {
    for (const candidate of [
      { triggers: [], flow: { type: 'block', id: 'block', steps: [simple()] } },
      { triggers: [], flow: { type: 'foreach', id: 'each', items: { type: 'array', items: [] }, body: { type: 'block', id: 'body', steps: [simple()] } } },
    ] satisfies AutomationSource[]) {
      expect(errors(simple(), candidate)).toContainEqual(expect.objectContaining({ code: 'GRAPH_SCOPE_UNSUPPORTED', source: { nodeId: 'flow' } }))
    }
  })

  it('retains Capability contract, Connection, retry, and expression validation', () => {
    const connected = { ...definition, connections: [{ name: 'account', required: true, accepts: ['test:adapter'] }], semantics: { ...definition.semantics, retrySafe: false } }
    const flow = simple()
    const member = flow.nodes[0] as CapabilitySource
    member.policy = { retry: { maxAttempts: 2 } }
    member.input.value = { type: 'call', function: 'missing:function', arguments: [] }
    try {
      compileAutomation(source(flow), { get: () => ({ definition: connected, providerAvailable: true }) })
      throw Error('Expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationCompileError)
      expect((error as AutomationCompileError).diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
        'CONNECTION_REQUIRED', 'RETRY_UNSAFE', 'EXPRESSION_FUNCTION_UNAVAILABLE',
      ]))
    }
  })

  it('shares the global authored identity registry with triggers and freezes named Connection dependencies', () => {
    const trigger: CapabilityDefinition = { ...definition, kind: 'trigger', id: 'test:trigger', input: z.object({}) }
    const connected: CapabilityDefinition = { ...definition, connections: [{ name: 'account', required: true, accepts: ['test:adapter'] }] }
    const registry = { get: ({ id }: { id: string }) => ({ definition: id === trigger.id ? trigger : connected, providerAvailable: true }) }
    const flow = simple()
    const member = flow.nodes[0] as CapabilitySource
    member.connections = { account: 'saved-connection' }
    const candidate = { ...source(flow), triggers: [{ id: 'event', capability: { id: trigger.id, version: 1 }, config: {} }] }
    const result = compileAutomation(candidate, registry, { get: id => ({ id, type: { id: 'test:adapter', version: 1 }, adapter: { id: 'test:transport', version: 1 } }) })
    expect(result.plan.instructions.one).toMatchObject({ connections: { account: 'saved-connection' } })
    expect(result.dependencyManifest.capabilities).toContainEqual(expect.objectContaining({ id: definition.id, connectionIds: { account: 'saved-connection' } }))
    candidate.triggers[0]!.id = 'one'
    expect(() => compileAutomation(candidate, registry)).toThrow(AutomationCompileError)
  })

  it('bounds malformed Source, cycles, depth, and expression shapes with diagnostics', () => {
    const raw = (value: unknown): GraphSource => value as GraphSource
    for (const candidate of [
      { ...simple(), nodes: null }, { ...simple(), edges: {} },
      { ...simple(), nodes: [null] }, { ...simple(), edges: [null] },
      graph([{ type: 'condition', id: 'one', condition: { type: 'template', parts: [null] } as unknown as ValueExpr }], [start('one')]),
      graph([action('one', { type: 'ref', path: ['input.one'] } as unknown as ValueExpr)], [start('one')]),
    ]) expect(errors(raw(candidate)).length).toBeGreaterThan(0)
    const cyclic = simple()
    cyclic.output = { type: 'array', items: [] }
    cyclic.output.items.push(cyclic.output)
    expect(errors(cyclic)).toContainEqual(expect.objectContaining({ code: 'GRAPH_SOURCE_LIMIT_EXCEEDED' }))
    const deep = simple()
    deep.output = literal(1)
    for (let depth = 0; depth < 70; depth++) deep.output = { type: 'array', items: [deep.output] }
    expect(errors(deep)).toContainEqual(expect.objectContaining({ code: 'GRAPH_SOURCE_LIMIT_EXCEEDED' }))
  })
})

describe('graph reference availability', () => {
  it.each([
    ['self', ref('steps.one.value'), 'GRAPH_REFERENCE_DEPENDENCY_MISSING'],
    ['missing', ref('steps.absent.value'), 'STEP_REFERENCE_MISSING'],
    ['undeclared input', ref('input.absent'), 'INPUT_REFERENCE_MISSING'],
    ['loop', ref('loop.item'), 'LOOP_REFERENCE_OUT_OF_SCOPE'],
  ] as const)('rejects %s references at their exact field', (_label, value, code) => {
    const flow = graph([action('one', value)], [start('one')])
    expect(errors(flow, { ...source(flow), inputs: {} })).toContainEqual(expect.objectContaining({ code, source: { nodeId: 'one', fieldPath: 'input.value' } }))
  })

  it('diagnoses a missing explicit dependency and accepts it only after the edge is added', () => {
    const flow = graph([action('a'), action('b', ref('steps.a.value'))], [start('a'), start('b')])
    expect(errors(flow)).toContainEqual(expect.objectContaining({ code: 'GRAPH_REFERENCE_DEPENDENCY_MISSING' }))
    flow.edges.push(edge('a', 'b'))
    expect(() => compileAutomation(source(flow), resolver)).not.toThrow()
  })

  it('rejects a branch-only ancestor after selected merge and accepts the selected output', () => {
    const flow = branch()
    const after = flow.nodes.find(node => node.id === 'after') as CapabilitySource
    after.input.value = ref('steps.yes.value')
    expect(errors(flow)).toContainEqual(expect.objectContaining({ code: 'GRAPH_REFERENCE_MAY_SKIP', source: { nodeId: 'after', fieldPath: 'input.value' } }))
    after.input.value = ref('steps.selected.value')
    expect(() => compileAutomation(source(flow), resolver)).not.toThrow()
  })

  it('allows branch-specific references when another required edge proves that branch is active', () => {
    const flow = branch()
    delete flow.output
    const after = flow.nodes.find(node => node.id === 'after') as CapabilitySource
    after.input.value = ref('steps.yes.value')
    flow.edges.push(edge('choice', 'after', 'true'))
    expect(() => compileAutomation(source(flow), resolver)).not.toThrow()
  })

  it('requires graph output references to be unconditionally available, including nested expressions', () => {
    const flow = branch()
    flow.output = { type: 'object', entries: {
      value: { type: 'array', items: [{ type: 'call', function: 'core:to-string', arguments: [ref('steps.yes.value')] }] },
      label: { type: 'template', parts: ['Result ', { ref: 'steps.no.value' }] },
      opaque: { type: 'literal', value: { type: 'ref', path: 'steps.absent.value' } },
    } }
    expect(errors(flow).filter(item => item.code === 'GRAPH_REFERENCE_MAY_SKIP').map(item => item.source?.fieldPath))
      .toEqual(['output.value.0.arguments.0', 'output.label.parts.1'])
    flow.output = ref('steps.selected')
    expect(() => compileAutomation(source(flow), resolver)).not.toThrow()
  })

  it('uses literal boolean conditions in activation proofs and rejects non-boolean literals', () => {
    const flow = branch()
    const choice = flow.nodes[0]!
    if (choice.type !== 'condition') throw Error('fixture')
    choice.condition = literal(true)
    flow.output = ref('steps.yes.value')
    expect(() => compileAutomation(source(flow), resolver)).not.toThrow()
    choice.condition = literal(false)
    expect(errors(flow)).toContainEqual(expect.objectContaining({ code: 'GRAPH_REFERENCE_MAY_SKIP' }))
    choice.condition = literal('true')
    expect(errors(flow)).toContainEqual(expect.objectContaining({ code: 'GRAPH_CONDITION_INVALID' }))
  })

  it('checks admission expressions before allowing step output references', () => {
    const flow = simple()
    expect(errors(flow, { ...source(flow), policy: { groupBy: ref('steps.one.value') } }))
      .toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_NOT_READY', source: { nodeId: '__policy', fieldPath: 'policy.groupBy' } }))
    expect(() => compileAutomation({ ...source(flow), policy: { groupBy: ref('input.group') } }, resolver)).not.toThrow()
  })

  it('terminates exponential activation proofs with an explicit complexity diagnostic', () => {
    const nodes: GraphNodeSource[] = [action('sink')]
    const edges: GraphEdge[] = []
    // With all x variables ordered before y, equality of these bit vectors has an exponential ROBDD.
    for (let index = 0; index < 16; index++) {
      const x = `x${index}`, y = `y${index}`, yes = `equal-yes-${index}`, no = `equal-no-${index}`, result = `pair-${index}`
      nodes.push(condition(x), condition(y), action(yes), action(no), merge(result, 'selected', 'yes', 'no'))
      edges.push(start(x), start(y), edge(x, yes, 'true'), edge(y, yes, 'true'), edge(x, no, 'false'), edge(y, no, 'false'),
        edge(yes, result, 'out', 'yes'), edge(no, result, 'out', 'no'), edge(result, 'sink'))
    }
    expect(errors(graph(nodes, edges))).toContainEqual(expect.objectContaining({ code: 'GRAPH_ACTIVATION_COMPLEXITY_EXCEEDED' }))
  })
})
