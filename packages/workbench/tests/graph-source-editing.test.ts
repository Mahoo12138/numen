import type { AutomationSource, GraphEdge, GraphNodeSource, GraphSource, ValueExpr } from '@numenjs/core'
import { describe, expect, it } from 'vitest'
import { applyAutomationSourceCommand, automationInsertTargetError, automationSourceHasNode, automationStepEditOptions, findAutomationControl, findAutomationNode } from '../src/automation-source-editing.js'
import { allocateGraphEdgeId, allocateGraphNodeId, applyGraphSourceCommand, findAutomationGraph, graphCopyNodeIds, type GraphSourceCommand } from '../src/graph-source-editing.js'

const capability = (id: string, input: Record<string, ValueExpr> = {}): GraphNodeSource => ({ type: 'capability', id, capability: { id: 'demo:echo', version: 1 }, input })
const edge = (id: string, from: string, to: string, out = 'out', input = 'in'): GraphEdge => ({ id, from: { nodeId: from, port: out }, to: { nodeId: to, port: input } })
function source(): AutomationSource {
  return { inputs: { message: { type: 'string' } }, triggers: [], flow: { type: 'graph', id: 'graph', version: 1,
    nodes: [capability('a'), { type: 'condition', id: 'choice', condition: { type: 'ref', path: 'steps.a.output.ok' } }, capability('b', { message: { type: 'ref', path: 'steps.a.output.message' } }),
      { type: 'merge', id: 'join', mode: 'selected', inputs: ['chosen', 'other'] }],
    edges: [edge('start', 'graph', 'a', 'start'), edge('a-choice', 'a', 'choice'), edge('chosen', 'choice', 'b', 'true'), edge('b-join', 'b', 'join', 'out', 'chosen'), edge('other', 'choice', 'join', 'false', 'other')],
    output: { type: 'ref', path: 'steps.b.output' },
  } }
}
const graph = (value: AutomationSource): GraphSource => findAutomationGraph(value, 'graph')!
function apply(value: AutomationSource, command: GraphSourceCommand): AutomationSource {
  const result = applyAutomationSourceCommand(value, command)
  expect(result.error).toBeUndefined()
  return result.source
}

describe('explicit Graph Source commands', () => {
  it('creates a Graph only by explicitly replacing an empty Structured flow', () => {
    const empty: AutomationSource = { inputs: { title: { type: 'string' } }, triggers: [], flow: { type: 'block', id: 'root', steps: [] } }
    const created = apply(empty, { type: 'GRAPH_CREATE_EMPTY', graphId: 'root' })
    expect(created).toEqual({ ...empty, flow: { type: 'graph', id: 'root', version: 1, nodes: [], edges: [] } })
    expect(created.inputs).toBe(empty.inputs)
    for (const flow of [{ type: 'block', id: 'root', steps: [capability('a')] }, { type: 'block', id: 'root', steps: [], output: { type: 'literal', value: null } }, source().flow]) {
      const value = { ...empty, flow } as AutomationSource
      expect(applyGraphSourceCommand(value, { type: 'GRAPH_CREATE_EMPTY', graphId: 'new' })).toMatchObject({ source: value, error: { code: 'GRAPH_NOT_EMPTY' } })
    }
    expect(automationInsertTargetError(created, { kind: 'root' }, 'step')).toBeDefined()
    expect(empty.flow.type).toBe('block')
    expect(automationStepEditOptions(created, 'root').canDelete).toBe(false)
    expect(applyAutomationSourceCommand(created, { type: 'DELETE_STEP', nodeId: 'root' })).toMatchObject({ source: created, error: { code: 'STRUCTURAL_SLOT' } })
  })

  it('adds disconnected members with owned payloads and never supplies an implicit start edge', () => {
    const before = source(), node = capability('orphan', { message: { type: 'literal', value: { nested: ['keep'] } } })
    const added = apply(before, { type: 'GRAPH_ADD_NODE', graphId: 'graph', node })
    expect(graph(added).edges).toBe(graph(before).edges)
    expect(graph(added).nodes.at(-1)).toEqual(node)
    expect(graph(added).nodes.at(-1)).not.toBe(node)
    expect(graph(before).nodes).toHaveLength(4)
    expect(applyGraphSourceCommand(added, { type: 'GRAPH_ADD_NODE', graphId: 'graph', node }).error?.code).toBe('GRAPH_ID_CONFLICT')
    expect(applyGraphSourceCommand(added, { type: 'GRAPH_ADD_NODE', graphId: 'missing', node: capability('new') }).error?.code).toBe('GRAPH_NOT_FOUND')
  })

  it.each([
    ['missing endpoint', edge('new', 'gone', 'a'), 'GRAPH_NODE_NOT_FOUND'],
    ['output used as input', edge('new', 'a', 'b', 'out', 'out'), 'GRAPH_PORT_INVALID'],
    ['condition out', edge('new', 'choice', 'a'), 'GRAPH_PORT_INVALID'],
    ['scope input', edge('new', 'a', 'graph'), 'GRAPH_NODE_NOT_FOUND'],
    ['scope invalid port', edge('new', 'graph', 'b', 'out'), 'GRAPH_PORT_INVALID'],
    ['start to merge', edge('new', 'graph', 'join', 'start', 'other'), 'GRAPH_PORT_INVALID'],
    ['duplicate ports', edge('new', 'a', 'choice'), 'GRAPH_DUPLICATE_EDGE'],
    ['duplicate edge id', edge('a-choice', 'graph', 'b', 'start'), 'GRAPH_EDGE_INVALID'],
    ['occupied merge port', edge('new', 'a', 'join', 'out', 'chosen'), 'GRAPH_PORT_IN_USE'],
    ['cycle', edge('new', 'b', 'a'), 'GRAPH_CYCLE'],
  ])('rejects %s atomically', (_name, invalid, code) => {
    const before = source(), snapshot = structuredClone(before)
    const result = applyGraphSourceCommand(before, { type: 'GRAPH_CONNECT', graphId: 'graph', edge: invalid as GraphEdge })
    expect(result.error?.code).toBe(code)
    expect(result.source).toBe(before)
    expect(before).toEqual(snapshot)
  })

  it('reconnects an existing edge without changing its identity, and disconnect leaves nodes, parameters and output intact', () => {
    const before = source()
    const reconnected = apply(before, { type: 'GRAPH_RECONNECT', graphId: 'graph', edgeId: 'a-choice', from: { nodeId: 'graph', port: 'start' } })
    expect(graph(reconnected).edges.find(item => item.id === 'a-choice')).toEqual(edge('a-choice', 'graph', 'choice', 'start'))
    expect(applyGraphSourceCommand(reconnected, { type: 'GRAPH_RECONNECT', graphId: 'graph', edgeId: 'a-choice', from: { nodeId: 'choice', port: 'true' } })).toMatchObject({ source: reconnected, error: { code: 'GRAPH_CYCLE' } })
    expect(apply(reconnected, { type: 'GRAPH_RECONNECT', graphId: 'graph', edgeId: 'a-choice', from: { nodeId: 'graph', port: 'start' } })).toBe(reconnected)
    const disconnected = apply(reconnected, { type: 'GRAPH_DISCONNECT', graphId: 'graph', edgeId: 'start' })
    expect(graph(disconnected).nodes).toBe(graph(reconnected).nodes)
    expect(graph(disconnected).output).toBe(graph(reconnected).output)
    expect(graph(disconnected).edges.some(item => item.to.nodeId === 'a')).toBe(false)
    expect(applyGraphSourceCommand(disconnected, { type: 'GRAPH_DISCONNECT', graphId: 'graph', edgeId: 'start' }).error?.code).toBe('GRAPH_EDGE_NOT_FOUND')
  })

  it('inserts on an edge in one command with explicit ports and rolls back the whole edit on an invalid port', () => {
    const before = source(), node: GraphNodeSource = { type: 'condition', id: 'second-choice', condition: { type: 'literal', value: false } }
    const command = { type: 'GRAPH_INSERT_ON_EDGE' as const, graphId: 'graph', edgeId: 'a-choice', node, inputPort: 'in', outputPort: 'false', newEdgeId: 'second-choice-choice' }
    const inserted = apply(before, command)
    expect(graph(inserted).edges.find(item => item.id === 'a-choice')).toEqual(edge('a-choice', 'a', 'second-choice'))
    expect(graph(inserted).edges.at(-1)).toEqual(edge('second-choice-choice', 'second-choice', 'choice', 'false'))
    expect(applyGraphSourceCommand(before, { ...command, outputPort: 'out' })).toMatchObject({ source: before, error: { code: 'GRAPH_PORT_INVALID' } })
    expect(graph(before).nodes).toHaveLength(4)
  })

  it('deletes only selected members and incident edges, keeping dangling expressions and reserving their ids', () => {
    const before = source(), result = applyGraphSourceCommand(before, { type: 'GRAPH_DELETE_NODES', graphId: 'graph', nodeIds: ['a', 'choice'] })
    expect(result).toMatchObject({ removedNodeIds: ['a', 'choice'], selectedNodeId: 'graph' })
    expect(graph(result.source).nodes.map(node => node.id)).toEqual(['b', 'join'])
    expect(graph(result.source).edges.map(item => item.id)).toEqual(['b-join'])
    expect(findAutomationNode(result.source, 'b')).toBe(findAutomationNode(before, 'b'))
    expect(graph(result.source).output).toBe(graph(before).output)
    expect(applyGraphSourceCommand(result.source, { type: 'GRAPH_ADD_NODE', graphId: 'graph', node: capability('a') }).error?.code).toBe('GRAPH_ID_CONFLICT')
    const waiting: AutomationSource = { triggers: [], flow: { type: 'graph', id: 'graph', version: 1, nodes: [capability('node-1', { message: { type: 'template', parts: ['x', { ref: 'steps.node-2.output' }] } })], edges: [] } }
    expect(allocateGraphNodeId(waiting)).toBe('node-3')
    expect(allocateGraphEdgeId({ ...graph(waiting), edges: [edge('edge-1', 'graph', 'node-1', 'start')] })).toBe('edge-2')
  })

  it('requires an explicit disconnection before removing a Merge input and permits incomplete drafts', () => {
    const before = source(), command = { type: 'GRAPH_SET_MERGE' as const, graphId: 'graph', nodeId: 'join', mode: 'all' as const, inputs: ['chosen'] }
    expect(applyGraphSourceCommand(before, command)).toMatchObject({ source: before, error: { code: 'GRAPH_PORT_IN_USE' } })
    let changed = apply(before, { type: 'GRAPH_DISCONNECT', graphId: 'graph', edgeId: 'other' })
    changed = apply(changed, command)
    expect(findAutomationNode(changed, 'join')).toMatchObject({ mode: 'all', inputs: ['chosen'] })
    changed = apply(changed, { type: 'GRAPH_DISCONNECT', graphId: 'graph', edgeId: 'b-join' })
    changed = apply(changed, { ...command, inputs: [] })
    expect(findAutomationNode(changed, 'join')).toMatchObject({ inputs: [] })
    const noOutput = apply(changed, { type: 'GRAPH_SET_OUTPUT', graphId: 'graph' })
    expect(graph(noOutput)).not.toHaveProperty('output')
    expect(apply(noOutput, { type: 'GRAPH_SET_OUTPUT', graphId: 'graph' })).toBe(noOutput)
    const output: ValueExpr = { type: 'ref', path: 'steps.missing.output' }
    expect(graph(apply(noOutput, { type: 'GRAPH_SET_OUTPUT', graphId: 'graph', expression: output })).output).toEqual(output)
  })

  it('updates a parameter and its explicit dependency atomically without inferring other dependencies', () => {
    const before = apply(source(), { type: 'GRAPH_ADD_NODE', graphId: 'graph', node: capability('orphan') })
    const command = { type: 'GRAPH_SET_INPUT_WITH_DEPENDENCY' as const, graphId: 'graph', nodeId: 'orphan', fieldName: 'message', expression: { type: 'ref' as const, path: 'steps.b.output.message' }, edge: edge('dependency', 'b', 'orphan') }
    const changed = apply(before, command)
    expect(findAutomationNode(changed, 'orphan')).toMatchObject({ input: { message: command.expression } })
    expect(graph(changed).edges.at(-1)).toEqual(command.edge)
    expect(applyGraphSourceCommand(before, { ...command, edge: edge('dependency', 'missing', 'orphan') })).toMatchObject({ source: before, error: { code: 'GRAPH_NODE_NOT_FOUND' } })
    expect(findAutomationNode(before, 'orphan')).toMatchObject({ input: {} })
    expect(applyGraphSourceCommand(before, { ...command, edge: edge('dependency', 'b', 'a') }).error?.code).toBe('GRAPH_NODE_INVALID')
  })

  it('copies only selected internal topology and rewrites typed internal references without touching external refs or literal data', () => {
    const expression: ValueExpr = { type: 'object', entries: {
      mixed: { type: 'array', items: [{ type: 'ref', path: 'steps.a.output' }, { type: 'ref', path: 'steps.external.output' }, { type: 'template', parts: ['steps.a.output', { ref: 'steps.a.output.message' }] }] },
      call: { type: 'call', function: 'add', arguments: [{ type: 'ref', path: 'steps.a.output.value' }, { type: 'literal', value: 1 }] },
      literal: { type: 'literal', value: { type: 'ref', path: 'steps.a.output' } },
    } }
    let before = source()
    before = applyAutomationSourceCommand(before, { type: 'SET_CAPABILITY_INPUT', nodeId: 'b', fieldName: 'message', expression }).source
    const result = applyGraphSourceCommand(before, { type: 'GRAPH_COPY_NODES', graphId: 'graph', nodeIds: ['a', 'choice', 'b'], idMap: { a: 'a-copy', choice: 'choice-copy', b: 'b-copy' }, edgeIdMap: { 'a-choice': 'a-choice-copy', chosen: 'chosen-copy' } })
    expect(result.error).toBeUndefined()
    expect(graph(result.source).edges.slice(graph(before).edges.length)).toEqual([edge('a-choice-copy', 'a-copy', 'choice-copy'), edge('chosen-copy', 'choice-copy', 'b-copy', 'true')])
    expect(findAutomationNode(result.source, 'choice-copy')).toMatchObject({ condition: { path: 'steps.a-copy.output.ok' } })
    expect(findAutomationNode(result.source, 'b-copy')).toMatchObject({ input: { message: { entries: {
      mixed: { items: [{ path: 'steps.a-copy.output' }, { path: 'steps.external.output' }, { parts: ['steps.a.output', { ref: 'steps.a-copy.output.message' }] }] },
      call: { arguments: [{ path: 'steps.a-copy.output.value' }, { type: 'literal', value: 1 }] },
      literal: { value: { type: 'ref', path: 'steps.a.output' } },
    } } } })
    expect(graph(result.source).output).toBe(graph(before).output)
    expect(findAutomationNode(before, 'b')).toMatchObject({ input: { message: expression } })
    const invalid = applyGraphSourceCommand(before, { type: 'GRAPH_COPY_NODES', graphId: 'graph', nodeIds: ['a', 'choice'], idMap: { a: 'a-copy', choice: 'choice-copy' }, edgeIdMap: {} })
    expect(invalid).toMatchObject({ source: before, error: { code: 'GRAPH_COPY_INVALID' } })
  })

  it('keeps explicit graphId scopes isolated and allows existing inspector commands to find Graph members', () => {
    const memberGraph = graph(source())
    const before: AutomationSource = { triggers: [], flow: { type: 'block', id: 'outer', steps: [{ type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: { type: 'block', id: 'body', steps: [memberGraph] } }] } }
    let changed = applyAutomationSourceCommand(before, { type: 'SET_CAPABILITY_INPUT', nodeId: 'b', fieldName: 'message', expression: { type: 'literal', value: 'edited' } }).source
    changed = applyAutomationSourceCommand(changed, { type: 'SET_CAPABILITY_CONNECTION', nodeId: 'b', slotName: 'account', connectionId: 'connection-1' }).source
    changed = applyAutomationSourceCommand(changed, { type: 'SET_INVOCATION_POLICY', nodeId: 'b', policy: { timeoutMs: 2000 } }).source
    changed = applyAutomationSourceCommand(changed, { type: 'SET_CONTROL_EXPRESSION', nodeId: 'choice', field: 'condition', expression: { type: 'literal', value: false } }).source
    expect(findAutomationControl(changed, 'b')).toMatchObject({ input: { message: { value: 'edited' } }, connections: { account: 'connection-1' }, policy: { timeoutMs: 2000 } })
    expect(findAutomationNode(changed, 'choice')).toMatchObject({ condition: { value: false } })
    expect(findAutomationControl(changed, 'choice')).toBeUndefined()
    expect(automationSourceHasNode(changed, 'choice')).toBe(true)
    expect(automationSourceHasNode(changed, 'join')).toBe(true)
    expect(findAutomationNode(before, 'choice')).toMatchObject({ condition: { type: 'ref' } })
    expect(graph(apply(changed, { type: 'GRAPH_ADD_NODE', graphId: 'graph', node: capability('nested-new') })).nodes).toHaveLength(5)
    expect(applyGraphSourceCommand(changed, { type: 'GRAPH_ADD_NODE', graphId: 'body', node: capability('nested-new') }).error?.code).toBe('GRAPH_NOT_FOUND')
  })
})

function loopSource(): AutomationSource {
  return { triggers: [], flow: { type: 'graph', id: 'graph', version: 1, nodes: [capability('outer'), {
    type: 'foreach', id: 'loop', items: { type: 'ref', path: 'steps.outer.output' }, concurrency: 2,
    body: { type: 'graph', id: 'body', version: 1, nodes: [capability('inner', { parent: { type: 'ref', path: 'steps.outer.output' }, external: { type: 'ref', path: 'steps.external.output' } }), {
      type: 'foreach', id: 'nested', items: { type: 'ref', path: 'steps.inner.output' },
      body: { type: 'graph', id: 'nested-body', version: 1, nodes: [capability('deep', { first: { type: 'ref', path: 'steps.outer.output' }, second: { type: 'ref', path: 'steps.inner.output' }, loop: { type: 'ref', path: 'loop.item' } })],
        edges: [edge('start', 'nested-body', 'deep', 'start')], output: { type: 'ref', path: 'steps.deep.output' } },
    }], edges: [edge('start', 'body', 'inner', 'start'), edge('inner-nested', 'inner', 'nested')], output: { type: 'ref', path: 'steps.nested.output' } },
  }], edges: [edge('start', 'graph', 'outer', 'start'), edge('outer-loop', 'outer', 'loop')] } }
}

describe('Graph ForEach scope commands', () => {
  it('edits only the explicit nested scope and uses existing Inspector commands inside the body', () => {
    const before = loopSource(), rootEdges = graph(before).edges
    let changed = apply(before, { type: 'GRAPH_ADD_NODE', graphId: 'nested-body', node: capability('deep-next') })
    changed = apply(changed, { type: 'GRAPH_CONNECT', graphId: 'nested-body', edge: edge('deep-next', 'deep', 'deep-next') })
    expect(graph(changed).edges).toBe(rootEdges)
    expect(findAutomationGraph(changed, 'nested-body')!.nodes.map(node => node.id)).toEqual(['deep', 'deep-next'])
    expect(applyGraphSourceCommand(changed, { type: 'GRAPH_CONNECT', graphId: 'body', edge: edge('cross-scope', 'inner', 'deep') })).toMatchObject({ source: changed, error: { code: 'GRAPH_NODE_NOT_FOUND' } })
    changed = applyAutomationSourceCommand(changed, { type: 'SET_CAPABILITY_INPUT', nodeId: 'deep', fieldName: 'value', expression: { type: 'ref', path: 'loop.item' } }).source
    changed = applyAutomationSourceCommand(changed, { type: 'SET_CAPABILITY_CONNECTION', nodeId: 'deep', slotName: 'account', connectionId: 'deep-account' }).source
    changed = applyAutomationSourceCommand(changed, { type: 'SET_CONTROL_EXPRESSION', nodeId: 'nested', field: 'items', expression: { type: 'literal', value: [] } }).source
    changed = apply(changed, { type: 'GRAPH_SET_FOREACH_CONCURRENCY', graphId: 'body', nodeId: 'nested', concurrency: 4 })
    expect(findAutomationNode(changed, 'deep')).toMatchObject({ input: { value: { path: 'loop.item' } }, connections: { account: 'deep-account' } })
    expect(findAutomationNode(changed, 'nested')).toMatchObject({ items: { type: 'literal', value: [] }, concurrency: 4 })
    expect(findAutomationNode(before, 'nested')).toMatchObject({ items: { type: 'ref' } })
    expect(applyGraphSourceCommand(changed, { type: 'GRAPH_SET_FOREACH_CONCURRENCY', graphId: 'body', nodeId: 'nested', concurrency: 0 })).toMatchObject({ source: changed, error: { code: 'GRAPH_NODE_INVALID' } })
    expect(findAutomationNode(apply(changed, { type: 'GRAPH_SET_FOREACH_CONCURRENCY', graphId: 'body', nodeId: 'nested' }), 'nested')).not.toHaveProperty('concurrency')
  })

  it.each([['loop'], ['outer', 'loop']])('copies nested scope identity and lexically visible references for selection %j', (...selection) => {
    const before = loopSource(), nodeIds = selection as string[], ids = graphCopyNodeIds(graph(before), nodeIds)
    expect(ids).toEqual(nodeIds.includes('outer') ? ['outer', 'loop', 'body', 'inner', 'nested', 'nested-body', 'deep'] : ['loop', 'body', 'inner', 'nested', 'nested-body', 'deep'])
    const idMap = Object.fromEntries(ids.map(id => [id, `${id}-copy`]))
    const changed = apply(before, { type: 'GRAPH_COPY_NODES', graphId: 'graph', nodeIds, idMap, edgeIdMap: nodeIds.includes('outer') ? { 'outer-loop': 'outer-loop-copy' } : {} })
    const parent = nodeIds.includes('outer') ? 'steps.outer-copy.output' : 'steps.outer.output'
    expect(findAutomationNode(changed, 'loop-copy')).toMatchObject({ items: { path: parent }, concurrency: 2, body: { id: 'body-copy', output: { path: 'steps.nested-copy.output' } } })
    expect(findAutomationNode(changed, 'inner-copy')).toMatchObject({ input: { parent: { path: parent }, external: { path: 'steps.external.output' } } })
    expect(findAutomationNode(changed, 'nested-copy')).toMatchObject({ items: { path: 'steps.inner-copy.output' }, body: { id: 'nested-body-copy', output: { path: 'steps.deep-copy.output' } } })
    expect(findAutomationNode(changed, 'deep-copy')).toMatchObject({ input: { first: { path: parent }, second: { path: 'steps.inner-copy.output' }, loop: { path: 'loop.item' } } })
    expect(findAutomationGraph(changed, 'body-copy')!.edges).toEqual([edge('start', 'body-copy', 'inner-copy', 'start'), edge('inner-nested', 'inner-copy', 'nested-copy')])
    expect(findAutomationGraph(changed, 'nested-body-copy')!.edges).toEqual([edge('start', 'nested-body-copy', 'deep-copy', 'start')])
    expect(graph(changed).edges.filter(item => item.from.nodeId === 'graph' && item.to.nodeId.endsWith('-copy'))).toEqual([])
    expect(applyGraphSourceCommand(before, { type: 'GRAPH_COPY_NODES', graphId: 'graph', nodeIds: ['loop'], idMap: { loop: 'loop-copy' }, edgeIdMap: {} }).error?.code).toBe('GRAPH_COPY_INVALID')
  })

  it('reserves all body identities when adding and removes descendant ids when deleting a loop', () => {
    const before = loopSource()
    const loop = structuredClone(findAutomationNode(before, 'loop')) as GraphNodeSource
    loop.id = 'new-loop'
    expect(applyGraphSourceCommand(before, { type: 'GRAPH_ADD_NODE', graphId: 'graph', node: loop }).error?.code).toBe('GRAPH_ID_CONFLICT')
    expect(applyGraphSourceCommand(before, { type: 'GRAPH_ADD_NODE', graphId: 'graph', node: capability('deep') }).error?.code).toBe('GRAPH_ID_CONFLICT')
    const result = applyGraphSourceCommand(before, { type: 'GRAPH_DELETE_NODES', graphId: 'graph', nodeIds: ['loop'] })
    expect(result.removedNodeIds).toEqual(['loop', 'body', 'inner', 'nested', 'nested-body', 'deep'])
    expect(findAutomationNode(result.source, 'deep')).toBeUndefined()
    expect(graph(result.source).nodes.map(node => node.id)).toEqual(['outer'])
  })
})
