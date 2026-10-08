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
  options: { idMap?: Record<string, string>; copiedPresentation?: Record<string, NumenValue>; revealNodeId?: string; revealWithinNodeId?: string } = {},
): Record<string, NumenValue> {
  let revealAncestors = options.revealNodeId ? automationAncestors(source, options.revealNodeId) : []
  if (options.revealNodeId && options.revealWithinNodeId !== undefined) {
    const scopeIndex = revealAncestors.indexOf(options.revealWithinNodeId)
    // Focus overrides the scope's visibility only in the view. Selecting within
    // it may reveal deeper containers, but must not unfold the persisted scope
    // or its ancestors. An invalid scope never falls back to a global reveal.
    if (scopeIndex < 0 && !options.idMap) return presentation
    revealAncestors = scopeIndex < 0 ? [] : revealAncestors.slice(scopeIndex + 1)
  }
  const before = collapsedAutomationNodes(presentation)
  const nodes = new Set(before.filter(id => !!findAutomationControl(source, id)))
  if (options.idMap) {
    for (const id of collapsedAutomationNodes(options.copiedPresentation ?? presentation)) {
      const copy = options.idMap[id]
      if (copy && findAutomationControl(source, copy)) nodes.add(copy)
    }
  }
  for (const id of revealAncestors) nodes.delete(id)
  const after = [...nodes]
  if (before.length === after.length && before.every((id, index) => id === after[index])) return presentation
  return { ...presentation, collapsedNodes: after }
}
