import type { AutomationSource, NumenValue } from '@numenjs/core'
import { findAutomationControl } from './automation-source-editing.js'
import { automationSourceNodeChildren, findAutomationGraph, type AutomationSourceNode } from './graph-source-editing.js'

export type AutomationGraphPosition = { x: number; y: number }
export type AutomationGraphPositions = Record<string, AutomationGraphPosition>
const record = (value: unknown): Record<string, NumenValue> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, NumenValue> : undefined
const position = (value: unknown): value is AutomationGraphPosition => {
  const item = record(value)
  return !!item && typeof item.x === 'number' && Number.isFinite(item.x) && typeof item.y === 'number' && Number.isFinite(item.y)
}
export function automationGraphPositions(presentation: Record<string, NumenValue>, graphId: string): AutomationGraphPositions {
  return Object.fromEntries(Object.entries(record(record(presentation.graphPositions)?.[graphId]) ?? {}).filter((entry): entry is [string, AutomationGraphPosition & NumenValue] => position(entry[1])).map(([id, value]) => [id, { x: value.x, y: value.y }]))
}
/** A drag ends in one batch. Invalid or stale members reject the whole update. */
export function setAutomationGraphPositions(presentation: Record<string, NumenValue>, source: AutomationSource, graphId: string, positions: AutomationGraphPositions): Record<string, NumenValue> | undefined {
  const graph = findAutomationGraph(source, graphId)
  if (!graph || Object.entries(positions).some(([id, point]) => (id !== graph.id && !graph.nodes.some(node => node.id === id)) || !position(point))) return
  const before = automationGraphPositions(presentation, graphId)
  if (Object.entries(positions).every(([id, point]) => before[id]?.x === point.x && before[id]?.y === point.y)) return presentation
  const values = Object.fromEntries(Object.entries(positions).map(([id, point]) => [id, { x: point.x, y: point.y }]))
  return { ...presentation, graphPositions: { ...(record(presentation.graphPositions) ?? {}), [graphId]: { ...before, ...values } } }
}

function reconcileGraphPositions(presentation: Record<string, NumenValue>, source: AutomationSource, options: { idMap?: Record<string, string>; copiedPresentation?: Record<string, NumenValue> }): Record<string, NumenValue> {
  if (!Object.hasOwn(presentation, 'graphPositions')) return presentation
  const previous = record(presentation.graphPositions)
  if (!previous) return presentation
  const pending: AutomationSourceNode[] = [source.flow], next: Record<string, NumenValue> = {}
  while (pending.length) {
    const node = pending.pop()!
    pending.push(...automationSourceNodeChildren(node))
    if (node.type !== 'graph') continue
    const ids = new Set([node.id, ...node.nodes.map(member => member.id)])
    const values: AutomationGraphPositions = Object.fromEntries(Object.entries(automationGraphPositions(presentation, node.id)).filter(([id]) => ids.has(id)))
    const originalGraphId = options.idMap ? Object.entries(options.idMap).find(([, copyId]) => copyId === node.id)?.[0] ?? node.id : node.id
    if (options.idMap) for (const [oldId, point] of Object.entries(automationGraphPositions(options.copiedPresentation ?? presentation, originalGraphId))) {
      const copyId = options.idMap[oldId]
      if (copyId && ids.has(copyId)) values[copyId] = { ...point }
    }
    if (Object.hasOwn(previous, node.id) || Object.keys(values).length) next[node.id] = Object.fromEntries(Object.entries(values).map(([id, point]) => [id, { x: point.x, y: point.y }]))
  }
  return JSON.stringify(previous) === JSON.stringify(next) ? presentation : { ...presentation, graphPositions: next }
}

export function collapsedAutomationNodes(presentation: Record<string, NumenValue>): string[] {
  const value = presentation.collapsedNodes
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

export function automationAncestors(source: AutomationSource, nodeId: string): string[] {
  const visit = (node: AutomationSourceNode, ancestors: string[]): string[] | undefined => {
    if (node.id === nodeId) return ancestors
    for (const child of automationSourceNodeChildren(node)) {
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
  const collapsed = before.length === after.length && before.every((id, index) => id === after[index]) ? presentation : { ...presentation, collapsedNodes: after }
  return reconcileGraphPositions(collapsed, source, options)
}
