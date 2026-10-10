import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchRunDetail, WorkbenchRunFlowNode } from '../src/contracts.js'
import { projectReadonlyGraph } from '../src/ReadonlyGraphCanvas.js'
import { ReadonlyAutomationFlow } from '../src/ReadonlyAutomationFlow.js'
import { renderToMarkup } from './render.js'

const member = (id: string, type: WorkbenchRunFlowNode['type'] = 'capability', status: WorkbenchRunFlowNode['status'] = 'IDLE', executionCount = 0): WorkbenchRunFlowNode => ({
  id, type, title: id, detail: `${type} metadata`, status, executionCount, children: [],
})
const edge = (id: string, from: string, port: string, to: string, input = 'in') => ({ id, from: { nodeId: from, port }, to: { nodeId: to, port: input } })
function graph(): WorkbenchRunFlowNode {
  return { ...member('root', 'graph', 'COMPLETED', 4), graph: {
    nodes: [member('choose', 'condition', 'COMPLETED', 1), { ...member('left', 'capability', 'COMPLETED', 1), sampledExecutionCount: 1 }, member('right', 'capability', 'SKIPPED'), member('join', 'merge', 'PENDING'), member('disconnected', 'capability', 'PENDING')],
    edges: [edge('begin', 'root', 'start', 'choose'), edge('true-branch', 'choose', 'true', 'left'), edge('false-branch', 'choose', 'false', 'right'), edge('left-join', 'left', 'out', 'join', 'success'), edge('right-join', 'right', 'out', 'join', 'fallback')],
  } }
}
function flow(root: WorkbenchRunFlowNode, focusedNodeId?: string): WorkbenchRunDetail['flow'] {
  return { root: { ...member('__flow', 'block'), children: [root] }, truncated: false, ...(focusedNodeId ? { focusedNodeId } : {}) }
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value) }
  return value
}

describe('immutable read-only Graph canvas', () => {
  it('preserves true dependencies, branch/merge ports and unconnected nodes without mutating the projection', () => {
    const fixed = frozen(graph()), before = JSON.stringify(fixed)
    const canvas = projectReadonlyGraph(fixed, true, 'right')
    expect(canvas.nodes).toHaveLength(6)
    expect(canvas.edges.map(item => ({ id: item.id, from: { nodeId: item.source, port: item.sourceHandle }, to: { nodeId: item.target, port: item.targetHandle } }))).toEqual(fixed.graph!.edges)
    expect(canvas.nodes.find(item => item.id === 'choose')!.data).toMatchObject({ inputPorts: ['in'], outputPorts: ['false', 'true'] })
    expect(canvas.nodes.find(item => item.id === 'join')!.data).toMatchObject({ inputPorts: ['fallback', 'success'], outputPorts: ['out'], status: 'PENDING', executionCount: 0 })
    expect(canvas.nodes.find(item => item.id === 'right')!.data).toMatchObject({ status: 'SKIPPED', executionCount: 0, active: true })
    expect(canvas.nodes.find(item => item.id === 'left')!.data).toMatchObject({ status: 'COMPLETED', executionCount: 1, sampledExecutionCount: 1 })
    expect(canvas.edges.some(item => item.target === 'disconnected')).toBe(false)
    expect(canvas.nodes.every(item => item.draggable === false && item.connectable === false && item.deletable === false)).toBe(true)
    expect(canvas.edges.every(item => item.updatable === false && item.deletable === false)).toBe(true)
    expect(JSON.stringify(fixed)).toBe(before)
  })

  it('lays out topology independently of member and edge array order, including disconnected roots', () => {
    const fixed = graph(), reordered = graph()
    reordered.graph!.nodes.reverse(); reordered.graph!.edges.reverse()
    const positions = (node: WorkbenchRunFlowNode) => Object.fromEntries(projectReadonlyGraph(node).nodes.map(item => [item.id, item.position]))
    expect(positions(reordered)).toEqual(positions(fixed))
    const actual = positions(fixed)
    expect(actual.left!.x).toBe(actual.right!.x)
    expect(actual.join!.x).toBeGreaterThan(actual.left!.x)
    expect(actual.choose!.x).toBeGreaterThan(actual.root!.x)
    expect(actual.disconnected!.x).toBe(actual.choose!.x)
    expect(actual.disconnected!.y).not.toBe(actual.choose!.y)
  })

  it('does not leak Run status, blocked reasons or sample counts into Snapshot presentation', () => {
    const fixed = graph()
    fixed.graph!.nodes[0]!.blockedReason = 'stored provider reason'
    const snapshot = projectReadonlyGraph(fixed)
    for (const node of snapshot.nodes) {
      expect(node.data).not.toHaveProperty('status')
      expect(node.data).not.toHaveProperty('executionCount')
      expect(node.data).not.toHaveProperty('blockedReason')
      expect(node.data).not.toHaveProperty('sampledExecutionCount')
    }
    expect(projectReadonlyGraph(fixed, true).nodes.find(node => node.id === 'choose')!.data.blockedReason).toBe('stored provider reason')
  })

  it('keeps an empty graph empty and handles partial or cyclic safe projections without fabricating topology', async () => {
    const empty = { ...member('empty', 'graph'), graph: { nodes: [], edges: [] } }
    expect(projectReadonlyGraph(empty).nodes.map(node => node.id)).toEqual(['empty'])
    expect(projectReadonlyGraph(empty).edges).toEqual([])
    const partial = graph()
    partial.graph!.edges.push(edge('outside-view', 'missing', 'out', 'join', 'omitted'))
    partial.graph!.edges.push(edge('cycle', 'join', 'out', 'choose'))
    const canvas = projectReadonlyGraph(partial)
    expect(canvas.nodes.some(node => node.id === 'missing')).toBe(false)
    expect(canvas.edges.some(node => node.id === 'outside-view')).toBe(false)
    expect(canvas.edges.some(node => node.id === 'cycle')).toBe(true)
    expect(canvas.nodes.every(node => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true)
    const markup = await renderToMarkup(<ReadonlyAutomationFlow flow={flow(partial)} />)
    expect(markup).toContain('Some edge endpoints are outside this view')
    expect(markup).toContain('data-graph-edge-id="outside-view"')
    expect(markup).toContain('missing.out')
  })

  it('renders a real VueFlow overview and an expandable keyboard list with exact metadata and sample attribution', async () => {
    const fixed = graph()
    fixed.graph!.nodes[0]!.title = '<script>bad()</script>'
    const markup = await renderToMarkup(<ReadonlyAutomationFlow flow={flow(fixed)} showExecutionState selectedNodeId="right" onSelectNode={vi.fn()} />)
    expect(markup).toContain('class="vue-flow')
    expect(markup).toContain('aria-label="Read-only graph root"')
    expect(markup).toContain('<details class="readonly-graph-details">')
    expect(markup).toContain('<summary>Member and connection list</summary>')
    expect(markup).toContain('aria-label="Executions for right"')
    expect(markup).toContain('data-status="SKIPPED" data-selected="true"')
    expect(markup).toContain('data-status="PENDING"')
    expect(markup).toContain('Sample · 1')
    expect(markup).toContain('choose.true')
    expect(markup).toContain('join.success')
    expect(markup).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(markup).not.toContain('<script>')
  })

  it('preserves the singleton focused-node row without mounting a misleading overview canvas', async () => {
    const selected = member('nested-scope-member', 'capability', 'SKIPPED')
    const markup = await renderToMarkup(<ReadonlyAutomationFlow flow={flow(selected, selected.id)} showExecutionState onSelectNode={vi.fn()} />)
    expect(markup).toContain('data-run-source-id="nested-scope-member"')
    expect(markup).toContain('Skipped')
    expect(markup).not.toContain('readonly-graph-canvas')
    const scopeMarkup = await renderToMarkup(<ReadonlyAutomationFlow flow={flow(graph(), 'root')} />)
    expect(scopeMarkup).toContain('<details class="readonly-graph-details" open>')
    expect(scopeMarkup).not.toContain('readonly-graph-canvas')
  })
})
