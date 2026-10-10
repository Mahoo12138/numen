import type { AutomationSource, ControlSource, GraphEdge, GraphEndpoint, GraphNodeSource, GraphSource, ValueExpr } from '@numenjs/core'

export type AutomationSourceNode = ControlSource | GraphNodeSource
export type GraphSourceCommand =
  | { type: 'GRAPH_CREATE_EMPTY'; graphId: string }
  | { type: 'GRAPH_ADD_NODE'; graphId: string; node: GraphNodeSource }
  | { type: 'GRAPH_CONNECT'; graphId: string; edge: GraphEdge }
  | { type: 'GRAPH_RECONNECT'; graphId: string; edgeId: string; from?: GraphEndpoint; to?: GraphEndpoint }
  | { type: 'GRAPH_DISCONNECT'; graphId: string; edgeId: string }
  | { type: 'GRAPH_DELETE_NODES'; graphId: string; nodeIds: string[] }
  | { type: 'GRAPH_INSERT_ON_EDGE'; graphId: string; edgeId: string; node: GraphNodeSource; inputPort: string; outputPort: string; newEdgeId: string }
  | { type: 'GRAPH_SET_MERGE'; graphId: string; nodeId: string; mode: 'all' | 'selected'; inputs: string[] }
  | { type: 'GRAPH_SET_FOREACH_CONCURRENCY'; graphId: string; nodeId: string; concurrency?: number }
  | { type: 'GRAPH_SET_OUTPUT'; graphId: string; expression?: ValueExpr }
  | { type: 'GRAPH_SET_INPUT_WITH_DEPENDENCY'; graphId: string; nodeId: string; fieldName: string; expression: ValueExpr; edge: GraphEdge }
  | { type: 'GRAPH_COPY_NODES'; graphId: string; nodeIds: string[]; idMap: Record<string, string>; edgeIdMap: Record<string, string> }

export interface GraphSourceCommandError {
  code: 'GRAPH_NOT_FOUND' | 'GRAPH_NOT_EMPTY' | 'GRAPH_NODE_INVALID' | 'GRAPH_NODE_NOT_FOUND' | 'GRAPH_ID_CONFLICT'
    | 'GRAPH_EDGE_NOT_FOUND' | 'GRAPH_EDGE_INVALID' | 'GRAPH_PORT_INVALID' | 'GRAPH_PORT_IN_USE' | 'GRAPH_DUPLICATE_EDGE'
    | 'GRAPH_CYCLE' | 'GRAPH_COPY_INVALID'
  message: string
}
export interface GraphSourceCommandResult {
  source: AutomationSource
  selectedNodeId?: string
  removedNodeIds?: string[]
  idMap?: Record<string, string>
  error?: GraphSourceCommandError
}
const reserved = new Set(['__proto__', 'prototype', 'constructor'])
const validNodeId = (id: string) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) && !reserved.has(id)
const validPort = (port: string) => typeof port === 'string' && /^[a-zA-Z0-9_$-]+$/.test(port) && !reserved.has(port)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const problem = (code: GraphSourceCommandError['code'], message: string): GraphSourceCommandError => ({ code, message })

export function automationSourceNodeChildren(node: AutomationSourceNode): AutomationSourceNode[] {
  switch (node.type) {
    case 'block': return node.steps
    case 'if': return [node.then, ...(node.else ? [node.else] : [])]
    case 'parallel': case 'race': return node.branches
    case 'foreach': return [node.body]
    case 'graph': return node.nodes
    default: return []
  }
}
export function findAutomationNode(source: AutomationSource, nodeId: string): AutomationSourceNode | undefined {
  const pending: AutomationSourceNode[] = [source.flow]
  while (pending.length) {
    const node = pending.pop()!
    if (node.id === nodeId) return node
    pending.push(...automationSourceNodeChildren(node))
  }
}
export function findAutomationGraph(source: AutomationSource, graphId: string): GraphSource | undefined {
  const node = findAutomationNode(source, graphId)
  return node?.type === 'graph' ? node : undefined
}
/** Includes owned body scope ids so a copied loop cannot duplicate global Source identities. */
export function graphCopyNodeIds(graph: GraphSource, nodeIds: string[]): string[] {
  const ids: string[] = []
  const visit = (node: AutomationSourceNode): void => { ids.push(node.id); automationSourceNodeChildren(node).forEach(visit) }
  for (const id of nodeIds) { const node = graph.nodes.find(node => node.id === id); if (node) visit(node) }
  return ids
}

/** Replaces one explicit Graph scope without changing any surrounding Structured semantics. */
export function replaceAutomationGraph(source: AutomationSource, graphId: string, edit: (graph: GraphSource) => GraphSource): AutomationSource {
  const visit = (node: AutomationSourceNode): AutomationSourceNode => {
    const map = <T extends AutomationSourceNode>(nodes: T[]): T[] => {
      const next = nodes.map(child => visit(child) as T)
      return next.every((child, index) => child === nodes[index]) ? nodes : next
    }
    if (node.type === 'graph') {
      if (node.id === graphId) return edit(node)
      const nodes = map(node.nodes)
      return nodes === node.nodes ? node : { ...node, nodes }
    }
    if (node.type === 'block') { const steps = map(node.steps); return steps === node.steps ? node : { ...node, steps } }
    if (node.type === 'parallel' || node.type === 'race') { const branches = map(node.branches); return branches === node.branches ? node : { ...node, branches } }
    if (node.type === 'foreach') { const body = visit(node.body); return body === node.body ? node : { ...node, body } as typeof node }
    if (node.type === 'if') {
      const then = visit(node.then) as typeof node.then, other = node.else ? visit(node.else) as typeof node.else : undefined
      return then === node.then && other === node.else ? node : { ...node, then, ...(other ? { else: other } : {}) }
    }
    return node
  }
  const flow = visit(source.flow) as ControlSource
  return flow === source.flow ? source : { ...source, flow }
}

function allIds(source: AutomationSource): Set<string> {
  const ids = new Set(source.triggers.map(node => node.id)), pending: AutomationSourceNode[] = [source.flow]
  while (pending.length) { const node = pending.pop()!; ids.add(node.id); pending.push(...automationSourceNodeChildren(node)) }
  // A deleted target's dangling reference must not silently bind to a later new node.
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const item = value as Record<string, unknown>
    if (item.type === 'ref' && typeof item.path === 'string' && item.path.startsWith('steps.')) ids.add(item.path.split('.')[1]!)
    if (item.type === 'template' && Array.isArray(item.parts)) for (const part of item.parts) if (part && typeof part.ref === 'string' && part.ref.startsWith('steps.')) ids.add(part.ref.split('.')[1]!)
    for (const child of Object.values(item)) visit(child)
  }
  visit(source)
  return ids
}
export function allocateGraphNodeId(source: AutomationSource, prefix = 'node'): string {
  const base = validNodeId(prefix) ? prefix : 'node', ids = allIds(source)
  let index = 1
  while (ids.has(`${base}-${index}`)) index++
  return `${base}-${index}`
}
export function allocateGraphEdgeId(graph: GraphSource, prefix = 'edge'): string {
  const ids = new Set(graph.edges.map(edge => edge.id))
  let index = 1
  while (ids.has(`${prefix}-${index}`)) index++
  return `${prefix}-${index}`
}

function nodeError(source: AutomationSource, node: GraphNodeSource): GraphSourceCommandError | undefined {
  if (!node || !['capability', 'condition', 'merge', 'foreach'].includes(node.type)) return problem('GRAPH_NODE_INVALID', 'Graph members require a supported type.')
  const ids = allIds(source), pending: AutomationSourceNode[] = [node]
  while (pending.length) {
    const member = pending.pop()!
    if (!member || !validNodeId(member.id) || !['capability', 'condition', 'merge', 'foreach', 'graph'].includes(member.type)) return problem('GRAPH_NODE_INVALID', 'Graph members require a valid stable id and supported type.')
    if (ids.has(member.id)) return problem('GRAPH_ID_CONFLICT', 'The node id is already used or referenced.')
    ids.add(member.id)
    if (member.type === 'graph' && (member.version !== 1 || !Array.isArray(member.nodes) || !Array.isArray(member.edges))) return problem('GRAPH_NODE_INVALID', 'A ForEach body requires an explicit Graph scope.')
    if (member.type === 'foreach' && member.body?.type !== 'graph') return problem('GRAPH_NODE_INVALID', 'A ForEach body requires an explicit Graph scope.')
    if (member.type === 'merge' && (!['all', 'selected'].includes(member.mode) || !Array.isArray(member.inputs) || member.inputs.some(port => !validPort(port)) || new Set(member.inputs).size !== member.inputs.length)) return problem('GRAPH_PORT_INVALID', 'Merge input names must be valid and unique.')
    pending.push(...automationSourceNodeChildren(member))
  }
}

/** Structural editing checks only. Missing incoming paths and expression readiness are compiler diagnostics. */
function topologyError(graph: GraphSource): GraphSourceCommandError | undefined {
  const nodes = new Map(graph.nodes.map(node => [node.id, node])), ids = new Set<string>(), endpoints = new Set<string>(), mergeInputs = new Set<string>()
  const outgoing = new Map(graph.nodes.map(node => [node.id, [] as string[]])), degrees = new Map(graph.nodes.map(node => [node.id, 0]))
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || !edge.from || !edge.to || ids.has(edge.id)) return problem('GRAPH_EDGE_INVALID', 'Edges require unique ids and explicit endpoints.')
    ids.add(edge.id)
    const from = nodes.get(edge.from.nodeId), to = nodes.get(edge.to.nodeId), start = edge.from.nodeId === graph.id
    if ((!start && !from) || !to) return problem('GRAPH_NODE_NOT_FOUND', 'The edge endpoint no longer belongs to this Graph.')
    if ((start ? edge.from.port !== 'start' : from!.type === 'condition' ? !['true', 'false'].includes(edge.from.port) : edge.from.port !== 'out')
      || (to.type === 'merge' ? !to.inputs.includes(edge.to.port) || start : edge.to.port !== 'in')) return problem('GRAPH_PORT_INVALID', 'The edge uses an unavailable port.')
    const key = JSON.stringify([edge.from.nodeId, edge.from.port, edge.to.nodeId, edge.to.port])
    if (endpoints.has(key)) return problem('GRAPH_DUPLICATE_EDGE', 'The same ports are already connected.')
    endpoints.add(key)
    if (to.type === 'merge') {
      const target = JSON.stringify([to.id, edge.to.port])
      if (mergeInputs.has(target)) return problem('GRAPH_PORT_IN_USE', 'A Merge input can have only one incoming edge.')
      mergeInputs.add(target)
    }
    if (!start) { outgoing.get(from!.id)!.push(to.id); degrees.set(to.id, degrees.get(to.id)! + 1) }
  }
  const ready = [...degrees].filter(([, degree]) => degree === 0).map(([id]) => id)
  for (let index = 0; index < ready.length; index++) for (const next of outgoing.get(ready[index]!)!) {
    degrees.set(next, degrees.get(next)! - 1)
    if (!degrees.get(next)) ready.push(next)
  }
  if (ready.length !== nodes.size) return problem('GRAPH_CYCLE', 'This connection would create a dependency cycle.')
}

function rewriteExpression(expression: ValueExpr, ids: Record<string, string>): ValueExpr {
  const path = (value: string): string => {
    const [root, id, ...tail] = value.split('.')
    return root === 'steps' && id && Object.hasOwn(ids, id) ? [root, ids[id], ...tail].join('.') : value
  }
  switch (expression.type) {
    case 'literal': return expression
    case 'ref': return { ...expression, path: path(expression.path) }
    case 'template': return { ...expression, parts: expression.parts.map(part => typeof part === 'string' ? part : { ...part, ref: path(part.ref) }) }
    case 'array': return { ...expression, items: expression.items.map(item => rewriteExpression(item, ids)) }
    case 'object': return { ...expression, entries: Object.fromEntries(Object.entries(expression.entries).map(([name, item]) => [name, rewriteExpression(item, ids)])) }
    case 'call': return { ...expression, arguments: expression.arguments.map(item => rewriteExpression(item, ids)) }
  }
}

function copyGraphNode(node: GraphNodeSource, all: Record<string, string>, visible: Record<string, string>): GraphNodeSource {
  const copy = { ...structuredClone(node), id: all[node.id]! }
  if (copy.type === 'capability') copy.input = Object.fromEntries(Object.entries(copy.input).map(([name, expression]) => [name, rewriteExpression(expression, visible)]))
  else if (copy.type === 'condition') copy.condition = rewriteExpression(copy.condition, visible)
  else if (copy.type === 'foreach') {
    copy.items = rewriteExpression(copy.items, visible)
    const local = { ...visible, ...Object.fromEntries(copy.body.nodes.map(member => [member.id, all[member.id]!])) }
    const body = copy.body
    copy.body = { ...body, id: all[body.id]!, nodes: body.nodes.map(member => copyGraphNode(member, all, local)),
      edges: body.edges.map(edge => ({ ...edge, from: { ...edge.from, nodeId: all[edge.from.nodeId] ?? edge.from.nodeId }, to: { ...edge.to, nodeId: all[edge.to.nodeId] ?? edge.to.nodeId } })),
      ...(body.output ? { output: rewriteExpression(body.output, local) } : {}),
    }
  }
  return copy
}

export function applyGraphSourceCommand(source: AutomationSource, command: GraphSourceCommand): GraphSourceCommandResult {
  const fail = (error: GraphSourceCommandError): GraphSourceCommandResult => ({ source, error })
  if (command.type === 'GRAPH_CREATE_EMPTY') {
    if (source.flow.type !== 'block' || source.flow.steps.length || source.flow.output !== undefined) return fail(problem('GRAPH_NOT_EMPTY', 'Only an empty Structured flow can create a new Graph.'))
    if (!validNodeId(command.graphId) || (allIds(source).has(command.graphId) && command.graphId !== source.flow.id)) return fail(problem('GRAPH_ID_CONFLICT', 'Choose a valid unused Graph id.'))
    return { source: { ...source, flow: { type: 'graph', id: command.graphId, version: 1, nodes: [], edges: [] } }, selectedNodeId: command.graphId }
  }
  const graph = findAutomationGraph(source, command.graphId)
  if (!graph) return fail(problem('GRAPH_NOT_FOUND', 'The Graph scope no longer exists.'))
  let next = graph
  const metadata: Omit<GraphSourceCommandResult, 'source' | 'error'> = {}
  switch (command.type) {
    case 'GRAPH_ADD_NODE': {
      const error = nodeError(source, command.node); if (error) return fail(error)
      next = { ...graph, nodes: [...graph.nodes, structuredClone(command.node)] }; metadata.selectedNodeId = command.node.id
      break
    }
    case 'GRAPH_CONNECT': next = { ...graph, edges: [...graph.edges, structuredClone(command.edge)] }; break
    case 'GRAPH_RECONNECT': {
      const edge = graph.edges.find(edge => edge.id === command.edgeId)
      if (!edge) return fail(problem('GRAPH_EDGE_NOT_FOUND', 'The edge no longer exists.'))
      const replacement = { ...edge, ...(command.from ? { from: structuredClone(command.from) } : {}), ...(command.to ? { to: structuredClone(command.to) } : {}) }
      if (same(edge, replacement)) return { source }
      next = { ...graph, edges: graph.edges.map(item => item === edge ? replacement : item) }; break
    }
    case 'GRAPH_DISCONNECT':
      if (!graph.edges.some(edge => edge.id === command.edgeId)) return fail(problem('GRAPH_EDGE_NOT_FOUND', 'The edge no longer exists.'))
      next = { ...graph, edges: graph.edges.filter(edge => edge.id !== command.edgeId) }; break
    case 'GRAPH_DELETE_NODES': {
      const ids = new Set(command.nodeIds)
      if (!ids.size) return { source }
      if ([...ids].some(id => !graph.nodes.some(node => node.id === id))) return fail(problem('GRAPH_NODE_NOT_FOUND', 'A selected member no longer belongs to this Graph.'))
      next = { ...graph, nodes: graph.nodes.filter(node => !ids.has(node.id)), edges: graph.edges.filter(edge => !ids.has(edge.from.nodeId) && !ids.has(edge.to.nodeId)) }
      metadata.removedNodeIds = graphCopyNodeIds(graph, [...ids]); metadata.selectedNodeId = graph.id; break
    }
    case 'GRAPH_INSERT_ON_EDGE': {
      const edge = graph.edges.find(edge => edge.id === command.edgeId)
      if (!edge) return fail(problem('GRAPH_EDGE_NOT_FOUND', 'The insertion edge no longer exists.'))
      const error = nodeError(source, command.node); if (error) return fail(error)
      next = { ...graph, nodes: [...graph.nodes, structuredClone(command.node)], edges: [
        ...graph.edges.map(item => item === edge ? { ...edge, to: { nodeId: command.node.id, port: command.inputPort } } : item),
        { id: command.newEdgeId, from: { nodeId: command.node.id, port: command.outputPort }, to: { ...edge.to } },
      ] }; metadata.selectedNodeId = command.node.id; break
    }
    case 'GRAPH_SET_MERGE': {
      const node = graph.nodes.find(node => node.id === command.nodeId)
      if (node?.type !== 'merge') return fail(problem('GRAPH_NODE_NOT_FOUND', 'The Merge member no longer exists.'))
      if (!['all', 'selected'].includes(command.mode) || command.inputs.some(port => !validPort(port)) || new Set(command.inputs).size !== command.inputs.length) return fail(problem('GRAPH_PORT_INVALID', 'Merge input names must be valid and unique.'))
      if (graph.edges.some(edge => edge.to.nodeId === node.id && !command.inputs.includes(edge.to.port))) return fail(problem('GRAPH_PORT_IN_USE', 'Disconnect edges before removing their Merge input ports.'))
      if (node.mode === command.mode && same(node.inputs, command.inputs)) return { source }
      next = { ...graph, nodes: graph.nodes.map(item => item === node ? { ...node, mode: command.mode, inputs: [...command.inputs] } : item) }; break
    }
    case 'GRAPH_SET_OUTPUT': {
      if (same(graph.output, command.expression)) return { source }
      const { output: _output, ...rest } = graph
      next = command.expression ? { ...rest, output: structuredClone(command.expression) } : rest; break
    }
    case 'GRAPH_SET_FOREACH_CONCURRENCY': {
      const node = graph.nodes.find(node => node.id === command.nodeId)
      if (node?.type !== 'foreach') return fail(problem('GRAPH_NODE_NOT_FOUND', 'The ForEach member no longer exists.'))
      if (command.concurrency !== undefined && (!Number.isSafeInteger(command.concurrency) || command.concurrency < 1)) return fail(problem('GRAPH_NODE_INVALID', 'Concurrency must be a positive safe integer.'))
      if (node.concurrency === command.concurrency) return { source }
      const { concurrency: _concurrency, ...rest } = node
      const edited = command.concurrency === undefined ? rest : { ...rest, concurrency: command.concurrency }
      next = { ...graph, nodes: graph.nodes.map(member => member === node ? edited : member) }; break
    }
    case 'GRAPH_SET_INPUT_WITH_DEPENDENCY': {
      const node = graph.nodes.find(node => node.id === command.nodeId)
      if (node?.type !== 'capability' || !command.fieldName || command.edge.to.nodeId !== node.id) return fail(problem('GRAPH_NODE_INVALID', 'The explicit dependency must target the Capability whose input changes.'))
      next = { ...graph, nodes: graph.nodes.map(item => item === node ? { ...node, input: { ...node.input, [command.fieldName]: structuredClone(command.expression) } } : item), edges: [...graph.edges, structuredClone(command.edge)] }; break
    }
    case 'GRAPH_COPY_NODES': {
      const selected = new Set(command.nodeIds), ids = allIds(source), copied: GraphNodeSource[] = []
      if (!selected.size) return { source }
      const subtree = graphCopyNodeIds(graph, command.nodeIds)
      if (selected.size !== command.nodeIds.length || command.nodeIds.some(id => !graph.nodes.some(node => node.id === id)) || new Set(subtree).size !== subtree.length || Object.keys(command.idMap).length !== subtree.length) return fail(problem('GRAPH_COPY_INVALID', 'Copy requires one explicit new id for every selected member and owned body scope.'))
      for (const id of subtree) {
        const newId = command.idMap[id]
        if (!Object.hasOwn(command.idMap, id) || !newId || !validNodeId(newId) || ids.has(newId)) return fail(problem('GRAPH_COPY_INVALID', 'The member selection or new id mapping is invalid.'))
        ids.add(newId)
      }
      const visible = Object.fromEntries(command.nodeIds.map(id => [id, command.idMap[id]!]))
      for (const id of command.nodeIds) copied.push(copyGraphNode(graph.nodes.find(node => node.id === id)!, command.idMap, visible))
      const internal = graph.edges.filter(edge => selected.has(edge.from.nodeId) && selected.has(edge.to.nodeId))
      if (Object.keys(command.edgeIdMap).length !== internal.length || internal.some(edge => !Object.hasOwn(command.edgeIdMap, edge.id))) return fail(problem('GRAPH_COPY_INVALID', 'Copy requires explicit ids for all copied internal edges.'))
      next = { ...graph, nodes: [...graph.nodes, ...copied], edges: [...graph.edges, ...internal.map(edge => ({ ...structuredClone(edge), id: command.edgeIdMap[edge.id]!, from: { ...edge.from, nodeId: command.idMap[edge.from.nodeId]! }, to: { ...edge.to, nodeId: command.idMap[edge.to.nodeId]! } }))] }
      metadata.idMap = { ...command.idMap }; metadata.selectedNodeId = copied.at(-1)!.id; break
    }
  }
  // Disconnection, deletion and parameter edits must remain possible in an already-invalid Draft.
  if (['GRAPH_CONNECT', 'GRAPH_RECONNECT', 'GRAPH_INSERT_ON_EDGE', 'GRAPH_SET_INPUT_WITH_DEPENDENCY', 'GRAPH_COPY_NODES'].includes(command.type)) {
    const error = topologyError(next); if (error) return fail(error)
  }
  return { source: replaceAutomationGraph(source, graph.id, () => next), ...metadata }
}
