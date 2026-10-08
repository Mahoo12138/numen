import type { AutomationSource, ControlSource } from '@numenjs/core'

export type AutomationFlowContainerNode = Extract<ControlSource, { type: 'block' | 'if' | 'foreach' | 'parallel' | 'race' }>

export interface AutomationFlowContainer {
  /** Original Source node; these helpers never clone or modify its contents. */
  node: AutomationFlowContainerNode
  parentId?: string
  /** Placement in its parent, independent of the node's own structural type. */
  role: 'root' | 'block' | 'then' | 'else' | 'body' | 'branch'
  /** Zero-based position in a parallel/race parent's branches. */
  branchIndex?: number
}

type Frame = Omit<AutomationFlowContainer, 'node'> & { node: ControlSource }

/** Only known structural slots are traversed; extension data remains opaque. */
function flowIndex(source: AutomationSource) {
  const containers: AutomationFlowContainer[] = []
  const byId = new Map<string, AutomationFlowContainer>()
  const parents = new Map<string, string | undefined>()
  const visited = new Set<ControlSource>()
  const pending: Frame[] = [{ node: source.flow, role: 'root' }]
  while (pending.length) {
    const frame = pending.pop()!, { node } = frame
    if (visited.has(node)) continue
    visited.add(node)
    parents.set(node.id, frame.parentId)
    if (!['block', 'if', 'foreach', 'parallel', 'race'].includes(node.type)) continue
    const container: AutomationFlowContainer = { ...frame, node: node as AutomationFlowContainerNode }
    containers.push(container)
    byId.set(node.id, container)
    const child = (value: ControlSource, role: AutomationFlowContainer['role'], branchIndex?: number): Frame => ({ node: value, parentId: node.id, role, ...(branchIndex === undefined ? {} : { branchIndex }) })
    switch (node.type) {
      case 'block':
        for (let index = node.steps.length - 1; index >= 0; index--) pending.push(child(node.steps[index]!, 'block'))
        break
      case 'if':
        if (node.else) pending.push(child(node.else, 'else'))
        pending.push(child(node.then, 'then'))
        break
      case 'foreach': pending.push(child(node.body, 'body')); break
      case 'parallel': case 'race':
        for (let index = node.branches.length - 1; index >= 0; index--) pending.push(child(node.branches[index]!, 'branch', index))
        break
    }
  }
  return { containers, byId, parents }
}

/** Structural containers in Source order, including a structural root. */
export function automationFlowContainers(source: AutomationSource): AutomationFlowContainer[] {
  return flowIndex(source).containers
}

/** Structural ancestors from root to node, including the node when structural. */
export function automationContainerPath(source: AutomationSource, nodeId: string): AutomationFlowContainer[] {
  if (source.triggers.some(trigger => trigger.id === nodeId)) return []
  const { byId, parents } = flowIndex(source)
  if (!parents.has(nodeId)) return []
  let id: string | undefined = byId.has(nodeId) ? nodeId : parents.get(nodeId)
  const path: AutomationFlowContainer[] = [], visited = new Set<string>()
  while (id !== undefined && !visited.has(id)) {
    visited.add(id)
    const container = byId.get(id)
    if (!container) return []
    path.push(container)
    id = container.parentId
  }
  return path.reverse()
}

/** A scope restricts folding to its descendants; invalid scopes never mean root. */
export function automationCollapsibleIds(source: AutomationSource, scopeId?: string): string[] {
  const { containers, byId } = flowIndex(source)
  if (scopeId === undefined) return containers.filter(({ node, role }) => role !== 'root' || node.type !== 'block').map(({ node }) => node.id)
  if (!byId.has(scopeId)) return []
  const descendants = new Set([scopeId])
  const result: string[] = []
  for (const container of containers) {
    if (container.parentId === undefined || !descendants.has(container.parentId)) continue
    descendants.add(container.node.id)
    result.push(container.node.id)
  }
  return result
}
