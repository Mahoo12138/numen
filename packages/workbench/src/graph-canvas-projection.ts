import type { GraphEndpoint, GraphNodeSource, GraphSource, NumenValue } from '@numenjs/core'

export interface GraphPosition { x: number; y: number }

export function graphInputPorts(node: GraphNodeSource): string[] {
  return node.type === 'merge' ? node.inputs : ['in']
}

export function graphOutputPorts(node: GraphNodeSource | GraphSource): string[] {
  return node.type === 'graph' ? ['start'] : node.type === 'condition' ? ['true', 'false'] : ['out']
}

/** Layout is a deterministic presentation proposal, never an execution order. */
export function layoutGraph(graph: GraphSource): Record<string, GraphPosition> {
  const ids = new Set(graph.nodes.map(node => node.id))
  const pending = new Map(graph.nodes.map(node => [node.id, graph.edges.filter(edge => edge.to.nodeId === node.id && ids.has(edge.from.nodeId)).length]))
  const levels = new Map<string, number>([[graph.id, 0]])
  const ready = graph.nodes.filter(node => pending.get(node.id) === 0).map(node => node.id).sort()
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]!
    const predecessors = graph.edges.filter(edge => edge.to.nodeId === id)
    levels.set(id, predecessors.length ? Math.max(...predecessors.map(edge => levels.get(edge.from.nodeId) ?? 0)) + 1 : 1)
    for (const edge of graph.edges.filter(edge => edge.from.nodeId === id)) {
      const count = pending.get(edge.to.nodeId)
      if (count === undefined) continue
      pending.set(edge.to.nodeId, count - 1)
      if (count === 1) ready.push(edge.to.nodeId)
    }
  }
  const rows = new Map<number, number>()
  const entries: Array<[string, GraphPosition]> = [[graph.id, { x: 32, y: 120 }]]
  for (const node of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const level = levels.get(node.id) ?? 1
    const row = rows.get(level) ?? 0
    rows.set(level, row + 1)
    entries.push([node.id, { x: 32 + level * 252, y: 64 + row * 150 }])
  }
  return Object.fromEntries(entries)
}

export function canvasGraphPositions(graph: GraphSource, presentation: Record<string, NumenValue>): Record<string, GraphPosition> {
  const positions = layoutGraph(graph)
  const root = presentation.graphPositions
  const scope = root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, NumenValue>)[graph.id] : undefined
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    for (const id of Object.keys(positions)) {
      const position = (scope as Record<string, NumenValue>)[id]
      if (position && typeof position === 'object' && !Array.isArray(position) && 'x' in position && 'y' in position && typeof position.x === 'number' && typeof position.y === 'number'
        && Number.isFinite(position.x) && Number.isFinite(position.y)) positions[id] = { x: position.x, y: position.y }
    }
  }
  return positions
}

export function graphEndpointKey(endpoint: GraphEndpoint): string { return JSON.stringify([endpoint.nodeId, endpoint.port]) }
export function parseGraphEndpointKey(value: string): GraphEndpoint | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' ? { nodeId: parsed[0], port: parsed[1] } : undefined
  } catch { return }
}
