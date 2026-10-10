import type { AutomationSource, GraphSource, NumenValue } from '@numenjs/core'
import type { WorkbenchAutomationInsertCatalog, WorkbenchAutomationVariableCatalog, WorkbenchInspectedValue } from './contracts.js'
import { automationSourceNodeChildren, type AutomationSourceNode } from './graph-source-editing.js'

export function graphContainingNode(source: AutomationSource, nodeId: string): GraphSource | undefined {
  const pending: AutomationSourceNode[] = [source.flow]
  while (pending.length) {
    const node = pending.pop()!
    if (node.type === 'graph' && (node.id === nodeId || node.nodes.some(member => member.id === nodeId))) return node
    pending.push(...automationSourceNodeChildren(node))
  }
}

export interface GraphFocusInputSource {
  nodeId: string
  title: string
  ports: string[]
  needsDependency?: boolean
  fields: Array<{ path: string; label: string; type: string; verified: boolean }>
}

export function graphFocusInputSources(source: AutomationSource, nodeId: string, catalog?: WorkbenchAutomationInsertCatalog, variables?: WorkbenchAutomationVariableCatalog, includeUnconnected = false): GraphFocusInputSource[] {
  const graph = graphContainingNode(source, nodeId)
  if (!graph) return []
  const upstream = new Set<string>(), pending = [nodeId]
  while (pending.length) {
    const target = pending.pop()!
    for (const edge of graph.edges.filter(edge => edge.to.nodeId === target)) if (!upstream.has(edge.from.nodeId)) { upstream.add(edge.from.nodeId); pending.push(edge.from.nodeId) }
  }
  const connected = [...new Set(graph.edges.filter(edge => edge.to.nodeId === nodeId && edge.from.nodeId !== graph.id).map(edge => edge.from.nodeId))]
  const ids = includeUnconnected ? graph.nodes.filter(node => node.id !== nodeId && node.type !== 'condition').map(node => node.id) : connected
  return ids.flatMap(id => {
    const member = graph.nodes.find(node => node.id === id)
    if (!member) return []
    const contract = member.type === 'capability' ? variables?.definitions.find(item => item.capability.id === member.capability.id && item.capability.version === member.capability.version) : undefined
    const title = member.type === 'capability' ? catalog?.items.find(item => item.kind === 'capability' && item.capability.id === member.capability.id && item.capability.version === member.capability.version)?.title ?? member.capability.id : member.id
    return [{ nodeId: id, title, ports: graph.edges.filter(edge => edge.to.nodeId === nodeId && edge.from.nodeId === id).map(edge => `${edge.from.port} → ${edge.to.port}`),
      ...(includeUnconnected && !upstream.has(id) ? { needsDependency: true } : {}),
      fields: contract?.outputFields.length ? contract.outputFields.map(field => ({ path: ['steps', id, ...field.path].join('.'), label: field.label, type: field.schemaType, verified: field.valueType !== 'unknown' }))
        : [{ path: `steps.${id}`, label: id, type: member.type === 'foreach' ? 'array' : 'unknown', verified: member.type === 'foreach' }],
    }]
  })
}

export function completeInspectedValue(value: WorkbenchInspectedValue): boolean { return value.available && value.hidden === 0 && !value.truncated }

/** Dynamic keys containing dots cannot be represented by the current dot-path AST. */
export function observedValuePaths(value: NumenValue, prefix: string, limit = 100): Array<{ path: string; value: NumenValue }> {
  const result: Array<{ path: string; value: NumenValue }> = []
  const visit = (item: NumenValue, path: string, depth: number) => {
    if (result.length >= limit || depth > 8) return
    result.push({ path, value: item })
    if (item && typeof item === 'object' && !('kind' in item && item.kind === 'resource')) {
      for (const [key, child] of Object.entries(item)) if (/^[a-zA-Z0-9_$-]+$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key)) visit(child as NumenValue, `${path}.${key}`, depth + 1)
    }
  }
  visit(value, prefix, 0)
  return result
}
