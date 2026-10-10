import type { AutomationSource, CapabilityDefinition, CapabilitySource, GraphEdge, GraphForEachSource, GraphNodeSource, GraphSource, NumenValue, ValueExpr } from '@numenjs/core'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import { AutomationCompileError, compileAutomation } from '../src/compiler.js'

const definition: CapabilityDefinition = {
  id: 'test:value', version: 1, kind: 'query', title: 'Value',
  input: z.object({ value: z.any() }), output: z.any(),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
}
const resolver = { get: () => ({ definition, providerAvailable: true }) }
const literal = (value: NumenValue): ValueExpr => ({ type: 'literal', value })
const ref = (path: string): ValueExpr => ({ type: 'ref', path })
const action = (id: string, value: ValueExpr = literal('value')): CapabilitySource => ({
  type: 'capability', id, capability: { id: definition.id, version: 1 }, input: { value },
})
const edge = (from: string, to: string, fromPort = 'out', toPort = 'in'): GraphEdge => ({
  id: `${from}-${fromPort}-${to}-${toPort}`, from: { nodeId: from, port: fromPort }, to: { nodeId: to, port: toPort },
})
const graph = (id: string, nodes: GraphNodeSource[], edges: GraphEdge[], output?: ValueExpr): GraphSource => ({
  type: 'graph', id, version: 1, nodes, edges, ...(output === undefined ? {} : { output }),
})
const body = (value = ref('loop.item')): GraphSource => graph('body', [action('work', value)], [edge('body', 'work', 'start')], ref('steps.work'))
const each = (scope = body()): GraphForEachSource => ({ type: 'foreach', id: 'each', items: literal([1, 2]), body: scope })
const flow = (member = each()): GraphSource => graph('flow', [member], [edge('flow', member.id, 'start')], ref(`steps.${member.id}`))
const source = (value: GraphSource): AutomationSource => ({ triggers: [], flow: value })
const compile = (value: GraphSource) => compileAutomation(source(value), resolver)
function errors(value: GraphSource, candidate = source(value)) {
  try { compileAutomation(candidate, resolver) } catch (error) {
    expect(error).toBeInstanceOf(AutomationCompileError)
    return (error as AutomationCompileError).diagnostics
  }
  throw Error('Expected compile failure')
}

describe('explicit graph ForEach compilation', () => {
  it('emits an independent iteration, its own body scope, and a completion sentinel without changing Source', () => {
    const candidate = flow()
    const original = structuredClone(candidate)
    const compiled = compile(candidate)
    expect(compiled.plan.irVersion).toBe(2)
    expect(compiled.plan.instructions.each).toEqual({ op: 'graph_iterate', id: 'each', items: literal([1, 2]), body: 'body', concurrency: 1 })
    expect(compiled.plan.instructions.body).toEqual({ op: 'graph_scope', id: 'body', version: 1, members: ['work'],
      edges: [edge('body', 'work', 'start')], output: ref('steps.work'), next: '__each.iteration.complete' })
    expect(compiled.plan.instructions['__each.iteration.complete']).toEqual({ op: 'scope_complete', id: '__each.iteration.complete' })
    expect(compiled.plan.instructions.flow).toMatchObject({ members: ['each'], next: '__complete', output: ref('steps.each') })
    expect(compiled.plan.instructions.work).not.toHaveProperty('next')
    expect(compiled.dependencyManifest.capabilities).toHaveLength(1)
    expect(candidate).toEqual(original)
  })

  it('accepts empty item arrays and an explicitly null body output, with no implicit expansion', () => {
    const loop = each(graph('empty-body', [], [], literal(null)))
    loop.items = literal([])
    loop.concurrency = 100
    const result = compile(flow(loop))
    expect(result.plan.instructions.each).toMatchObject({ items: literal([]), concurrency: 100 })
    expect(result.plan.instructions['empty-body']).toMatchObject({ output: literal(null), members: [] })
  })

  it('keeps ordinary tree ForEach IR and completion semantics unchanged', () => {
    const result = compileAutomation({ triggers: [], flow: { type: 'foreach', id: 'legacy', items: literal([1, 2]),
      body: { type: 'block', id: 'legacy-body', steps: [action('legacy-work', ref('loop.item'))] } } }, resolver)
    expect(result.plan.irVersion).toBe(1)
    expect(result.plan.instructions.legacy).toMatchObject({ op: 'iterate' })
    expect(Object.values(result.plan.instructions).some(instruction => instruction.op === 'graph_scope' || instruction.op === 'graph_iterate')).toBe(false)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects invalid concurrency %s', concurrency => {
    const loop = each(); loop.concurrency = concurrency
    expect(errors(flow(loop))).toContainEqual(expect.objectContaining({ code: 'FOREACH_CONCURRENCY_INVALID', source: { nodeId: 'each', fieldPath: 'concurrency' } }))
  })

  it.each([null, true, 1, 'array', { value: [] }])('rejects known non-array items %#', items => {
    const loop = each(); loop.items = literal(items)
    expect(errors(flow(loop))).toContainEqual(expect.objectContaining({ code: 'FOREACH_ITEMS_INVALID' }))
  })

  it('requires a Graph body and an explicit body output', () => {
    const absent = each(); delete absent.body.output
    expect(errors(flow(absent))).toContainEqual(expect.objectContaining({ code: 'GRAPH_FOREACH_OUTPUT_REQUIRED' }))
    const wrong = each(); (wrong as unknown as { body: unknown }).body = { type: 'block', id: 'block', steps: [] }
    expect(errors(flow(wrong))).toContainEqual(expect.objectContaining({ code: 'GRAPH_FOREACH_BODY_INVALID' }))
  })

  it('requires every nested member and graph id to be globally unique', () => {
    const sameMember = each(body()); sameMember.body.nodes[0]!.id = 'each'
    expect(errors(flow(sameMember))).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_NODE_ID' }))
    const sameScope = each(body()); sameScope.body.id = 'flow'
    expect(errors(flow(sameScope))).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_NODE_ID' }))
    const sibling = each(body()); sibling.id = 'sibling'
    const candidate = graph('flow', [each(), sibling], [edge('flow', 'each', 'start'), edge('flow', 'sibling', 'start')])
    expect(errors(candidate)).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_NODE_ID' }))
  })

  it('inherits only explicit upstream outputs and allows collecting the completed ForEach result', () => {
    const loop = each(body({ type: 'object', entries: { parent: ref('steps.before'), item: ref('loop.item'), index: ref('loop.index') } }))
    loop.items = ref('steps.before')
    const candidate = graph('flow', [action('before', literal([1, 2])), loop, action('after', ref('steps.each'))], [
      edge('flow', 'before', 'start'), edge('before', 'each'), edge('each', 'after'),
    ], ref('steps.after'))
    expect(() => compile(candidate)).not.toThrow()
    loop.body.output = ref('steps.before')
    expect(() => compile(candidate)).not.toThrow()
    candidate.edges = [edge('flow', 'before', 'start'), edge('flow', 'each', 'start'), edge('each', 'after')]
    expect(errors(candidate)).toContainEqual(expect.objectContaining({ code: 'GRAPH_REFERENCE_DEPENDENCY_MISSING', source: { nodeId: 'each', fieldPath: 'items' } }))
  })

  it('rejects body reads from an unrelated outer branch, its own loop, or another loop body', () => {
    for (const path of ['steps.unrelated', 'steps.each', 'steps.other-work']) {
      const other: GraphForEachSource = { ...each(graph('other-body', [action('other-work')], [edge('other-body', 'other-work', 'start')], ref('steps.other-work'))), id: 'other' }
      const loop = each(body(ref(path)))
      const candidate = graph('flow', [action('unrelated'), loop, other], [edge('flow', 'unrelated', 'start'), edge('flow', 'each', 'start'), edge('flow', 'other', 'start')])
      expect(errors(candidate)).toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_OUT_OF_SCOPE', source: { nodeId: 'work', fieldPath: 'input.value' } }))
    }
  })

  it('rejects outer references and edges into an iteration body', () => {
    const candidate = flow(); candidate.output = ref('steps.work')
    expect(errors(candidate)).toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_OUT_OF_SCOPE' }))
    candidate.output = ref('steps.each'); candidate.edges.push(edge('work', 'each'))
    expect(errors(candidate)).toContainEqual(expect.objectContaining({ code: 'GRAPH_EDGE_NODE_MISSING' }))
    const inner = flow(); (inner.nodes[0] as GraphForEachSource).body.edges.push(edge('each', 'work'))
    expect(errors(inner)).toContainEqual(expect.objectContaining({ code: 'GRAPH_EDGE_NODE_MISSING' }))
  })

  it('proves parent output availability relative to the hosting iteration activation', () => {
    const loop = each(body(ref('steps.yes')))
    const choice: GraphNodeSource = { type: 'condition', id: 'choice', condition: ref('input.choice') }
    const candidate = graph('flow', [choice, action('yes'), action('no'), loop], [edge('flow', 'choice', 'start'),
      edge('choice', 'yes', 'true'), edge('choice', 'no', 'false'), edge('yes', 'each')])
    expect(() => compile(candidate)).not.toThrow()
    candidate.nodes.push({ type: 'merge', id: 'selected', mode: 'selected', inputs: ['yes', 'no'] })
    candidate.edges = candidate.edges.filter(item => item.to.nodeId !== 'each')
    candidate.edges.push(edge('yes', 'selected', 'out', 'yes'), edge('no', 'selected', 'out', 'no'), edge('selected', 'each'))
    expect(errors(candidate)).toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_OUT_OF_SCOPE', source: { nodeId: 'work', fieldPath: 'input.value' } }))
    loop.body.output = ref('steps.selected'); (loop.body.nodes[0] as CapabilitySource).input.value = ref('steps.selected')
    expect(() => compile(candidate)).not.toThrow()
  })

  it('rejects conditionally missing body output and accepts a stable selected merge', () => {
    const inner = graph('body', [{ type: 'condition', id: 'choice', condition: ref('loop.item') }, action('yes'), action('no')], [
      edge('body', 'choice', 'start'), edge('choice', 'yes', 'true'), edge('choice', 'no', 'false'),
    ], ref('steps.yes'))
    const candidate = flow(each(inner))
    expect(errors(candidate)).toContainEqual(expect.objectContaining({ code: 'GRAPH_REFERENCE_MAY_SKIP', source: { nodeId: 'body', fieldPath: 'output' } }))
    inner.nodes.push({ type: 'merge', id: 'selected', mode: 'selected', inputs: ['yes', 'no'] })
    inner.edges.push(edge('yes', 'selected', 'out', 'yes'), edge('no', 'selected', 'out', 'no'))
    inner.output = ref('steps.selected')
    expect(() => compile(candidate)).not.toThrow()
  })

  it('uses the nearest loop in nested items and body expressions while preserving inherited ancestors', () => {
    const inner = each(graph('inner-body', [action('inner-work', { type: 'array', items: [ref('loop.item'), ref('loop.index'), ref('steps.outer-work'), ref('steps.before')] })],
      [edge('inner-body', 'inner-work', 'start')], ref('steps.inner-work')))
    inner.id = 'inner'; inner.items = ref('loop.item')
    const outer = each(graph('outer-body', [action('outer-work', ref('loop.item')), inner], [edge('outer-body', 'outer-work', 'start'), edge('outer-work', 'inner')], ref('steps.inner')))
    outer.items = ref('steps.before')
    const candidate = graph('flow', [action('before', literal([[1], [2]])), outer], [edge('flow', 'before', 'start'), edge('before', 'each')], ref('steps.each'))
    const first = compile(candidate)
    expect(first.plan.instructions.inner).toMatchObject({ op: 'graph_iterate', items: ref('loop.item'), body: 'inner-body' })
    expect(first.plan.instructions['outer-body']).toMatchObject({ members: ['inner', 'outer-work'], next: '__each.iteration.complete' })
    expect(first.plan.instructions['inner-body']).toMatchObject({ members: ['inner-work'], next: '__inner.iteration.complete' })
    for (const value of [candidate, outer.body, inner.body]) { value.nodes.reverse(); value.edges.reverse() }
    expect(compile(candidate)).toEqual(first)
    outer.body.output = ref('steps.inner-work')
    expect(errors(candidate)).toContainEqual(expect.objectContaining({ code: 'STEP_REFERENCE_OUT_OF_SCOPE' }))
  })

  it('validates loop and step references inside compound items, output, and admission expressions', () => {
    const loop = each(); loop.items = { type: 'array', items: [{ type: 'object', entries: { value: ref('loop.item') } }] }
    expect(errors(flow(loop))).toContainEqual(expect.objectContaining({ code: 'LOOP_REFERENCE_OUT_OF_SCOPE', source: { nodeId: 'each', fieldPath: 'items.0.value' } }))
    loop.items = literal([1]); loop.body.output = { type: 'template', parts: ['item:', { ref: 'loop.item' }] }
    const candidate = flow(loop)
    expect(() => compile(candidate)).not.toThrow()
    expect(errors(candidate, { ...source(candidate), policy: { groupBy: ref('loop.item') } })).toContainEqual(expect.objectContaining({ code: 'LOOP_REFERENCE_OUT_OF_SCOPE' }))
  })
})
