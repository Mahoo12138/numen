import type { AutomationSource, CapabilitySource, GraphSource } from '@numenjs/core'
import { allocateGraphNodeId } from './graph-source-editing.js'

export type GraphConversion = { source: AutomationSource; graph: GraphSource } | { reason: 'structure' | 'output' | 'identity' }

/** Only a plain sequential capability list has an unchanged invocation/output contract. */
export function previewGraphConversion(source: AutomationSource): GraphConversion {
  const root = source.flow
  if (root.type !== 'block' && root.type !== 'capability') return { reason: 'structure' }
  if (root.type === 'block' && root.output !== undefined) return { reason: 'output' }
  const nodes = root.type === 'capability' ? [root] : root.steps
  if (nodes.some(node => node.type !== 'capability')) return { reason: 'structure' }
  const id = root.type === 'block' ? root.id : allocateGraphNodeId(source, 'graph')
  const ids = [id, ...nodes.map(node => node.id)]
  if (new Set(ids).size !== ids.length || ids.some(value => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value) || source.triggers.some(trigger => trigger.id === value))) return { reason: 'identity' }
  const graph: GraphSource = { type: 'graph', version: 1, id, nodes: structuredClone(nodes) as CapabilitySource[],
    edges: nodes.map((node, index) => ({ id: `sequence-${index + 1}`,
      from: { nodeId: index ? nodes[index - 1]!.id : id, port: index ? 'out' : 'start' }, to: { nodeId: node.id, port: 'in' } })) }
  return { source: { ...structuredClone(source), flow: graph }, graph }
}
