import type { AutomationSource, ControlSource, NumenValue } from '@numenjs/core'
import { findAutomationControl } from './automation-source-editing.js'

export function collapsedAutomationNodes(presentation: Record<string, NumenValue>): string[] {
  const value = presentation.collapsedNodes
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

function controlChildren(node: ControlSource): ControlSource[] {
  switch (node.type) {
    case 'block': return node.steps
    case 'if': return [node.then, ...(node.else ? [node.else] : [])]
    case 'parallel': case 'race': return node.branches
    case 'foreach': return [node.body]
    default: return []
  }
}

export function automationAncestors(source: AutomationSource, nodeId: string): string[] {
  const visit = (node: ControlSource, ancestors: string[]): string[] | undefined => {
    if (node.id === nodeId) return ancestors
    for (const child of controlChildren(node)) {
      const found = visit(child, [...ancestors, node.id])
      if (found) return found
    }
    return undefined
  }
  return visit(source.flow, []) ?? []
}

/** Only presentation fields owned by this editor are transformed. Opaque fields stay intact. */
export function reconcileAutomationPresentation(
  presentation: Record<string, NumenValue>,
  source: AutomationSource,
  options: { idMap?: Record<string, string>; copiedPresentation?: Record<string, NumenValue>; revealNodeId?: string } = {},
): Record<string, NumenValue> {
  const before = collapsedAutomationNodes(presentation)
  const nodes = new Set(before.filter(id => !!findAutomationControl(source, id)))
  if (options.idMap) {
    for (const id of collapsedAutomationNodes(options.copiedPresentation ?? presentation)) {
      const copy = options.idMap[id]
      if (copy && findAutomationControl(source, copy)) nodes.add(copy)
    }
  }
  if (options.revealNodeId) {
    for (const id of automationAncestors(source, options.revealNodeId)) nodes.delete(id)
  }
  const after = [...nodes]
  if (before.length === after.length && before.every((id, index) => id === after[index])) return presentation
  return { ...presentation, collapsedNodes: after }
}
