import type { ControlSource, GraphNodeSource } from '@numenjs/core'

export type InspectableSourceNode = ControlSource | GraphNodeSource

/** Server traversal budget is separate from the 250-node response/rendering budget. */
export const maximumInspectedSourceNodes = 10_000

export function inspectionSourceChildren(node: InspectableSourceNode): InspectableSourceNode[] {
  switch (node.type) {
    case 'block': return node.steps
    case 'if': return [node.then, ...(node.else ? [node.else] : [])]
    case 'parallel': case 'race': return node.branches
    case 'foreach': return [node.body]
    case 'graph': return node.nodes
    default: return []
  }
}

/** Locate within immutable Source without projecting preceding nodes or returning authored values. */
export function findInspectionSourceNode(root: InspectableSourceNode, nodeId: string): InspectableSourceNode | undefined {
  const pending = [{ node: root, depth: 0 }]
  let count = 0
  while (pending.length) {
    if (++count > maximumInspectedSourceNodes) throw new Error('Source inspection traversal limit reached')
    const { node, depth } = pending.pop()!
    if (depth > 64) continue
    if (node.id === nodeId) return node
    const children = inspectionSourceChildren(node)
    if (children.length > maximumInspectedSourceNodes) throw new Error('Source inspection traversal limit reached')
    for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index]!, depth: depth + 1 })
  }
}
