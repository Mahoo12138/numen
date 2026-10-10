import type {
  AutomationSource, CapabilitySource, CompileDiagnostic, CoreInstruction, GraphEdge,
  GraphNodeSource, GraphSource, SourceRef, ValueExpr,
} from '@numenjs/core'
import { GraphActivation, GraphActivationComplexityError } from './graph-activation.js'

interface GraphCompilerContext {
  registerNode(id: string): boolean
  report(diagnostic: CompileDiagnostic): void
  hasErrors(): boolean
  validateExpression(expression: ValueExpr, nodeId: string, fieldPath: string): void
  compileCapability(source: CapabilitySource): Extract<CoreInstruction, { op: 'invoke' }> | undefined
}

const memberIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const inputNamePattern = /^[a-zA-Z0-9_$-]+$/
const reservedNames = new Set(['__proto__', 'prototype', 'constructor'])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const compareId = (left: { id: string }, right: { id: string }): number => left.id < right.id ? -1 : left.id > right.id ? 1 : 0

/** Guard recursive expression validation and graph analysis before touching untrusted draft contents. */
function boundedSource(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }]
  const active = new Set<object>()
  let count = 0
  while (pending.length) {
    const item = pending.pop()!
    if (item.exit) { active.delete(item.value as object); continue }
    if (++count > 100_000 || item.depth > 64) return false
    if (!item.value || typeof item.value !== 'object') continue
    if (active.has(item.value)) return false
    active.add(item.value)
    const children = Object.values(item.value)
    if (count + pending.length + children.length > 100_000) return false
    pending.push({ value: item.value, depth: item.depth, exit: true })
    for (const child of children) pending.push({ value: child, depth: item.depth + 1 })
  }
  return true
}

/** Compiles a root graph to a durable graph scope and independent member instructions. */
export function compileGraph(
  graph: GraphSource,
  source: AutomationSource,
  next: string,
  context: GraphCompilerContext,
): Record<string, CoreInstruction> {
  const instructions: Record<string, CoreInstruction> = {}
  const report = (code: string, message: string, nodeId = graph.id, fieldPath?: string): void => context.report({
    severity: 'error', code, message, source: { nodeId, ...(fieldPath ? { fieldPath } : {}) },
  })
  if (!boundedSource(graph)) {
    report('GRAPH_SOURCE_LIMIT_EXCEEDED', 'Graph source exceeds the depth or value limit, or contains cyclic data.')
    return instructions
  }
  if (graph.version !== 1) report('GRAPH_VERSION_UNSUPPORTED', 'Graph version must be 1.', graph.id, 'version')
  if (!memberIdPattern.test(graph.id) || reservedNames.has(graph.id)) {
    report('GRAPH_NODE_ID_INVALID', 'Graph scope id must be addressable as a single steps reference segment.')
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    report('GRAPH_STRUCTURE_INVALID', 'Graph requires nodes and edges arrays.')
    return instructions
  }
  if (graph.nodes.length > 1024 || graph.edges.length > 8192) {
    report('GRAPH_SOURCE_LIMIT_EXCEEDED', 'Graph supports at most 1024 nodes and 8192 edges.')
    return instructions
  }
  const nodes = new Map<string, GraphNodeSource>()
  for (const [index, node] of graph.nodes.entries()) {
    if (!record(node) || typeof node.id !== 'string') {
      report('GRAPH_NODE_INVALID', 'Graph member requires a stable id.', graph.id, `nodes.${index}`)
      continue
    }
    if (!memberIdPattern.test(node.id) || reservedNames.has(node.id)) {
      report('GRAPH_NODE_ID_INVALID', 'Graph node ids must be addressable as a single steps reference segment.', node.id)
    }
    if (!context.registerNode(node.id)) continue
    if (node.type !== 'capability' && node.type !== 'condition' && node.type !== 'merge') {
      report('GRAPH_NODE_UNSUPPORTED', 'Graph supports Capability, Condition, and Merge members.', node.id)
      continue
    }
    nodes.set(node.id, node)
    if (node.type === 'capability') {
      const instruction = context.compileCapability(node)
      if (instruction) instructions[node.id] = instruction
    } else if (node.type === 'condition') {
      context.validateExpression(node.condition, node.id, 'condition')
      if (node.condition?.type === 'literal' && typeof node.condition.value !== 'boolean') {
        report('GRAPH_CONDITION_INVALID', 'Condition literal must be boolean.', node.id, 'condition')
      }
      instructions[node.id] = { op: 'graph_condition', id: node.id, condition: node.condition }
    } else {
      if (node.mode !== 'all' && node.mode !== 'selected') report('GRAPH_MERGE_MODE_INVALID', 'Merge mode must be all or selected.', node.id, 'mode')
      if (!Array.isArray(node.inputs) || !node.inputs.length || node.inputs.some(name => (
        typeof name !== 'string' || !inputNamePattern.test(name) || reservedNames.has(name)
      ))) {
        report('GRAPH_MERGE_INPUTS_INVALID', 'Merge requires non-empty, addressable input names.', node.id, 'inputs')
      } else if (new Set(node.inputs).size !== node.inputs.length) {
        report('GRAPH_MERGE_INPUT_DUPLICATE', 'Merge input names must be unique.', node.id, 'inputs')
      }
      instructions[node.id] = { op: 'graph_merge', id: node.id, mode: node.mode, inputs: node.inputs }
    }
  }
  if (graph.output !== undefined) context.validateExpression(graph.output, graph.id, 'output')
  const incoming = new Map([...nodes.keys()].map(id => [id, [] as GraphEdge[]]))
  const outgoing = new Map([...nodes.keys(), graph.id].map(id => [id, [] as GraphEdge[]]))
  const edgeIds = new Set<string>()
  const endpoints = new Set<string>()
  for (const [index, edge] of graph.edges.entries()) {
    const fieldPath = `edges.${index}`
    if (!record(edge) || typeof edge.id !== 'string' || !edge.id
      || !record(edge.from) || !record(edge.to)
      || typeof edge.from.nodeId !== 'string' || typeof edge.from.port !== 'string'
      || typeof edge.to.nodeId !== 'string' || typeof edge.to.port !== 'string') {
      report('GRAPH_EDGE_INVALID', 'Graph edge requires an id and named source and target ports.', graph.id, fieldPath)
      continue
    }
    if (edgeIds.has(edge.id)) report('GRAPH_EDGE_ID_DUPLICATE', 'Graph edge ids must be unique.', graph.id, fieldPath)
    edgeIds.add(edge.id)
    const endpointKey = JSON.stringify([edge.from.nodeId, edge.from.port, edge.to.nodeId, edge.to.port])
    if (endpoints.has(endpointKey)) report('GRAPH_EDGE_DUPLICATE', 'The same port connection is declared more than once.', graph.id, fieldPath)
    endpoints.add(endpointKey)
    const from = nodes.get(edge.from.nodeId)
    const to = nodes.get(edge.to.nodeId)
    const start = edge.from.nodeId === graph.id
    if (!start && !from || !to) {
      report('GRAPH_EDGE_NODE_MISSING', 'Edge endpoints must belong to this graph; the graph itself cannot receive edges.', graph.id, fieldPath)
      continue
    }
    const validFrom = start ? edge.from.port === 'start'
      : from?.type === 'condition' ? ['true', 'false'].includes(edge.from.port) : edge.from.port === 'out'
    const validTo = to.type === 'merge' ? Array.isArray(to.inputs) && to.inputs.includes(edge.to.port) : edge.to.port === 'in'
    if (!validFrom || !validTo) {
      report('GRAPH_EDGE_PORT_INVALID', 'Edge must connect an available output port to an available input port.', graph.id, fieldPath)
      continue
    }
    if (start && to.type === 'merge') {
      report('GRAPH_START_DATA_INVALID', 'Graph start supplies activation, not a Merge input value.', graph.id, fieldPath)
      continue
    }
    incoming.get(to.id)!.push(edge)
    outgoing.get(edge.from.nodeId)!.push(edge)
  }
  for (const node of nodes.values()) {
    const edges = incoming.get(node.id)!
    if (!edges.length) report('GRAPH_INPUT_MISSING', 'Graph member requires an explicit incoming dependency.', node.id)
    if (node.type === 'merge' && Array.isArray(node.inputs)) {
      for (const input of node.inputs) if (edges.filter(edge => edge.to.port === input).length !== 1) {
        report('GRAPH_MERGE_INPUT_CARDINALITY', 'Each Merge input requires exactly one incoming edge.', node.id, `inputs.${input}`)
      }
    }
  }
  // No analysis follows malformed nodes, expressions, or edges.
  if (context.hasErrors()) return instructions
  const indegree = new Map([...nodes.keys()].map(id => [id, incoming.get(id)!.filter(edge => edge.from.nodeId !== graph.id).length]))
  const ready = [...nodes.values()].filter(node => indegree.get(node.id) === 0).sort(compareId).map(node => node.id)
  const order: string[] = []
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]!
    order.push(id)
    for (const edge of outgoing.get(id)!) {
      const remaining = indegree.get(edge.to.nodeId)! - 1
      indegree.set(edge.to.nodeId, remaining)
      if (remaining === 0) ready.push(edge.to.nodeId)
    }
  }
  if (order.length !== nodes.size) report('GRAPH_CYCLE', 'Graph dependencies must be acyclic.')
  const reachable = new Set<string>([graph.id])
  const pending = [graph.id]
  for (let index = 0; index < pending.length; index++) {
    for (const edge of outgoing.get(pending[index]!) ?? []) if (!reachable.has(edge.to.nodeId)) {
      reachable.add(edge.to.nodeId)
      pending.push(edge.to.nodeId)
    }
  }
  for (const id of nodes.keys()) if (!reachable.has(id)) report('GRAPH_NODE_UNREACHABLE', 'Graph member is unreachable from the explicit start port.', id)
  if (context.hasErrors()) return instructions
  try {
    const proof = new GraphActivation([...nodes.values()].filter(node => node.type === 'condition').map(node => node.id))
    const active = new Map<string, number>([[graph.id, proof.true]])
    const ancestors = new Map<string, Set<string>>([[graph.id, new Set()]])
    for (const id of order) {
      const node = nodes.get(id)!
      const sources = incoming.get(id)!.map(edge => {
        const origin = nodes.get(edge.from.nodeId)
        const activation = active.get(edge.from.nodeId)!
        if (origin?.type !== 'condition') return activation
        const condition = origin.condition.type === 'literal'
          ? origin.condition.value ? proof.true : proof.false
          : proof.condition(origin.id)
        return proof.and(activation, edge.from.port === 'true' ? condition : proof.not(condition))
      })
      const selected = node.type === 'merge' && node.mode === 'selected'
      if (selected) {
        for (let left = 0; left < sources.length; left++) for (let right = left + 1; right < sources.length; right++) {
          if (proof.and(sources[left]!, sources[right]!) !== proof.false) {
            report('GRAPH_MERGE_NOT_EXCLUSIVE', 'Selected Merge inputs can be active together; candidate paths must be structurally exclusive.', id, 'inputs')
          }
        }
      }
      active.set(id, sources.reduce((result, formula) => selected ? proof.or(result, formula) : proof.and(result, formula), selected ? proof.false : proof.true))
      const inherited = new Set<string>()
      for (const edge of incoming.get(id)!) {
        inherited.add(edge.from.nodeId)
        for (const ancestor of ancestors.get(edge.from.nodeId)!) inherited.add(ancestor)
      }
      ancestors.set(id, inherited)
    }
    const check = (path: string, location: SourceRef, consumer?: string, admission = false): void => {
      const problem = (code: string, message: string): void => context.report({ severity: 'error', code, message, source: location })
      const [root, id] = path.split('.')
      if (root === 'input' && source.inputs !== undefined && !Object.hasOwn(source.inputs, id!)) {
        problem('INPUT_REFERENCE_MISSING', `Input ${id} is not declared.`)
      } else if (root === 'loop') {
        problem('LOOP_REFERENCE_OUT_OF_SCOPE', 'Loop references are unavailable in a root graph.')
      } else if (root === 'steps') {
        if (!nodes.has(id!)) problem('STEP_REFERENCE_MISSING', `Referenced graph member ${id} does not exist in this scope.`)
        else if (admission) problem('STEP_REFERENCE_NOT_READY', 'Step references are unavailable before the graph starts.')
        else if (consumer && !ancestors.get(consumer)!.has(id!)) {
          problem('GRAPH_REFERENCE_DEPENDENCY_MISSING', `Reference ${path} requires an explicit dependency path to its consumer.`)
        } else if (!proof.implies(consumer ? active.get(consumer)! : proof.true, active.get(id!)!)) {
          problem('GRAPH_REFERENCE_MAY_SKIP', `Referenced member ${id} can be skipped while this expression is evaluated; use a suitable Merge output.`)
        }
      }
    }
    const expression = (value: ValueExpr, nodeId: string, fieldPath: string, consumer?: string, admission = false): void => {
      const visit = (child: ValueExpr, childPath: string): void => expression(child, nodeId, childPath, consumer, admission)
      switch (value.type) {
        case 'ref': check(value.path, { nodeId, fieldPath }, consumer, admission); break
        case 'template': value.parts.forEach((part, index) => {
          if (typeof part !== 'string') check(part.ref, { nodeId, fieldPath: `${fieldPath}.parts.${index}` }, consumer, admission)
        }); break
        case 'array': value.items.forEach((item, index) => visit(item, `${fieldPath}.${index}`)); break
        case 'object': Object.entries(value.entries).forEach(([key, item]) => visit(item, `${fieldPath}.${key}`)); break
        case 'call': value.arguments.forEach((item, index) => visit(item, `${fieldPath}.arguments.${index}`)); break
      }
    }
    for (const node of nodes.values()) {
      if (node.type === 'capability') Object.entries(node.input).forEach(([key, value]) => expression(value, node.id, `input.${key}`, node.id))
      else if (node.type === 'condition') expression(node.condition, node.id, 'condition', node.id)
    }
    if (graph.output !== undefined) expression(graph.output, graph.id, 'output')
    if (source.policy?.groupBy) expression(source.policy.groupBy, '__policy', 'policy.groupBy', undefined, true)
  } catch (error) {
    if (!(error instanceof GraphActivationComplexityError)) throw error
    report('GRAPH_ACTIVATION_COMPLEXITY_EXCEEDED', error.message)
  }
  instructions[graph.id] = {
    op: 'graph_scope', id: graph.id, version: 1,
    members: [...nodes.keys()].sort(),
    edges: [...graph.edges].sort(compareId).map(edge => ({ ...edge, from: { ...edge.from }, to: { ...edge.to } })),
    ...(graph.output !== undefined ? { output: graph.output } : {}), next,
  }
  return Object.fromEntries(Object.entries(instructions).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}
