import { Button } from '@numenjs/components'
import { GitBranch, Maximize, Minus, Network, Play, Plus, Repeat, Zap } from '@lucide/vue'
import { Handle, MarkerType, Position, VueFlow, useVueFlow, type Edge, type Node, type NodeProps } from '@vue-flow/core'
import { markRaw, shallowRef, watch } from 'vue'
import type { WorkbenchRunFlowNode, WorkbenchRunFlowStatus } from './contracts.js'
import { statusLabel, t } from './i18n.js'
import { defineSetupComponent } from './vue-component.js'

export interface ReadonlyGraphNodeData {
  title: string
  detail: string
  kind: WorkbenchRunFlowNode['type']
  inputPorts: string[]
  outputPorts: string[]
  status?: WorkbenchRunFlowStatus
  executionCount?: number
  blockedReason?: string
  sampledExecutionCount?: number
  active: boolean
}

/** A view model of the supplied safe projection. It never reconstructs authoring Source. */
export function projectReadonlyGraph(node: WorkbenchRunFlowNode, showExecutionState = false, selectedNodeId?: string): {
  nodes: Node<ReadonlyGraphNodeData>[]
  edges: Edge[]
} {
  if (!node.graph) return { nodes: [], edges: [] }
  const members = [node, ...node.graph.nodes]
  const ids = new Set(members.map(member => member.id))
  const inputPorts = new Map<string, Set<string>>(), outputPorts = new Map<string, Set<string>>()
  for (const member of members) {
    inputPorts.set(member.id, new Set(member === node ? [] : member.type === 'merge' ? [] : ['in']))
    outputPorts.set(member.id, new Set(member === node ? ['start'] : member.type === 'condition' ? ['true', 'false'] : ['out']))
  }
  const edges: Edge[] = []
  for (const edge of node.graph.edges) {
    // A bounded projection may omit endpoints. The exact edge remains in the accessible table.
    if (!ids.has(edge.from.nodeId) || !ids.has(edge.to.nodeId)) continue
    inputPorts.get(edge.to.nodeId)!.add(edge.to.port)
    outputPorts.get(edge.from.nodeId)!.add(edge.from.port)
    edges.push({ id: edge.id, source: edge.from.nodeId, target: edge.to.nodeId,
      sourceHandle: edge.from.port, targetHandle: edge.to.port,
      type: 'smoothstep', markerEnd: MarkerType.ArrowClosed,
      label: `${edge.from.port} → ${edge.to.port}`,
      ariaLabel: `${edge.id}: ${edge.from.nodeId}.${edge.from.port} → ${edge.to.nodeId}.${edge.to.port}`,
      focusable: false, selectable: false, updatable: false, deletable: false })
  }
  const heights = new Map(members.map(member => [member.id, 210 + Math.max(inputPorts.get(member.id)!.size, outputPorts.get(member.id)!.size) * 20]))
  const positions = layoutReadonlyGraph(node.id, [...ids], edges, heights)
  return {
    nodes: members.map(member => ({ id: member.id, type: 'readonly-numen', position: positions.get(member.id)!,
      draggable: false, connectable: false, selectable: false, focusable: false, deletable: false,
      ariaLabel: `${member.title} (${member.id})`,
      data: { title: member === node ? t('workbench.graph.start') : member.title, detail: member.detail,
        kind: member.type, active: member.id === selectedNodeId,
        inputPorts: [...inputPorts.get(member.id)!].sort(), outputPorts: [...outputPorts.get(member.id)!].sort(),
        ...(showExecutionState ? { status: member.status, executionCount: member.executionCount,
          ...(member.blockedReason ? { blockedReason: member.blockedReason } : {}),
          ...(member.sampledExecutionCount ? { sampledExecutionCount: member.sampledExecutionCount } : {}) } : {}),
      },
    })),
    edges,
  }
}

function layoutReadonlyGraph(startId: string, ids: string[], edges: Edge[], heights: Map<string, number>): Map<string, { x: number; y: number }> {
  const incoming = new Map(ids.map(id => [id, 0])), outgoing = new Map(ids.map(id => [id, [] as string[]]))
  const level = new Map(ids.map(id => [id, id === startId ? 0 : 1]))
  for (const edge of edges) {
    incoming.set(edge.target, incoming.get(edge.target)! + 1)
    outgoing.get(edge.source)!.push(edge.target)
  }
  const ready = ids.filter(id => incoming.get(id) === 0).sort()
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]!
    for (const target of outgoing.get(id)!.sort()) {
      level.set(target, Math.max(level.get(target)!, level.get(id)! + 1))
      incoming.set(target, incoming.get(target)! - 1)
      if (incoming.get(target) === 0) ready.push(target)
    }
  }
  // No edge or dependency is invented for disconnected members or malformed cyclic projections.
  const rows = new Map<number, number>()
  return new Map([startId, ...ids.filter(id => id !== startId).sort()].map(id => {
    const column = level.get(id)!, y = rows.get(column) ?? 32
    rows.set(column, y + heights.get(id)!)
    return [id, { x: 28 + column * 310, y }]
  }))
}

export function ReadonlyGraphNode(props: NodeProps<ReadonlyGraphNodeData> & { onInspect?: ((id: string) => void) | undefined }) {
  const Icon = props.data.kind === 'graph' ? Play : props.data.kind === 'condition' ? GitBranch
    : props.data.kind === 'merge' ? Network : props.data.kind === 'foreach' ? Repeat : Zap
  const title = <><Icon size={16} /><strong>{props.data.title}</strong></>
  return <div class="readonly-graph-node" data-readonly-node-id={props.id} data-status={props.data.status} data-selected={props.data.active}>
    {props.onInspect ? <button type="button" class="readonly-graph-node-heading nodrag nopan"
      aria-label={t('workbench.readonlyGraph.inspect', { node: props.id })}
      onClick={event => { event.stopPropagation(); props.onInspect?.(props.id) }}>{title}</button>
      : <div class="readonly-graph-node-heading">{title}</div>}
    <code>{props.id}</code>
    <p class="readonly-graph-node-detail" title={props.data.detail}>{props.data.detail}</p>
    {props.data.status ? <div class="readonly-graph-node-state"><em>{statusLabel(props.data.status)}</em>
      <small>{t('workbench.readonlyGraph.executions', { count: props.data.executionCount ?? 0 })}</small></div> : null}
    {props.data.sampledExecutionCount ? <span class="readonly-graph-sample">{t('workbench.readonlyGraph.sample', { count: props.data.sampledExecutionCount })}</span> : null}
    {props.data.blockedReason ? <p class="readonly-graph-node-blocked" title={props.data.blockedReason}>{t('workbench.graph.blockedReason', { reason: props.data.blockedReason })}</p> : null}
    <div class="readonly-graph-node-ports">
      <div>{props.data.inputPorts.map(port => <div class="readonly-graph-node-port" key={port}>
        <Handle id={port} type="target" position={Position.Left} connectable={false} /><span title={port}>{port}</span>
      </div>)}</div>
      <div>{props.data.outputPorts.map(port => <div class="readonly-graph-node-port" key={port}>
        <span title={port}>{port}</span><Handle id={port} type="source" position={Position.Right} connectable={false} />
      </div>)}</div>
    </div>
  </div>
}

export interface ReadonlyGraphCanvasProps {
  node: WorkbenchRunFlowNode
  showExecutionState?: boolean
  selectedNodeId?: string | undefined
  onSelectNode?: ((id: string) => void) | undefined
}

let nextCanvasId = 0
export const ReadonlyGraphCanvas = defineSetupComponent<ReadonlyGraphCanvasProps>('ReadonlyGraphCanvas', ['node', 'showExecutionState', 'selectedNodeId', 'onSelectNode'], props => {
  const id = `numen-readonly-graph-${++nextCanvasId}`
  const flow = useVueFlow({ id })
  const nodes = shallowRef<Node<ReadonlyGraphNodeData>[]>([]), edges = shallowRef<Edge[]>([])
  const nodeTypes = { 'readonly-numen': markRaw((nodeProps: NodeProps<ReadonlyGraphNodeData>) => <ReadonlyGraphNode {...nodeProps} onInspect={props.onSelectNode} />) }
  watch(() => [props.node, props.showExecutionState, props.selectedNodeId] as const, () => {
    const projection = projectReadonlyGraph(props.node, props.showExecutionState, props.selectedNodeId)
    nodes.value = projection.nodes; edges.value = projection.edges
  }, { immediate: true })
  return () => <section class="readonly-graph-canvas" aria-label={t('workbench.readonlyGraph.canvas', { graph: props.node.id })}>
    <div class="readonly-graph-viewport">
      <VueFlow id={id} nodes={nodes.value} edges={edges.value} nodeTypes={nodeTypes}
        applyDefault={false} autoConnect={false} nodesDraggable={false} nodesConnectable={false}
        edgesUpdatable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
        deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        fitViewOnInit minZoom={.08} maxZoom={2} onlyRenderVisibleElements zoomOnDoubleClick={false}
        onNodesChange={changes => flow.applyNodeChanges(changes.filter(change => change.type === 'dimensions'))}
        onNodeClick={({ node }) => props.onSelectNode?.(node.id)} />
    </div>
    <div class="readonly-graph-viewport-controls">
      <Button type="button" size="icon" aria-label={t('workbench.graph.zoomOut')} onClick={() => flow.zoomOut()}><Minus size={14} /></Button>
      <span>{Math.round(flow.viewport.value.zoom * 100)}%</span>
      <Button type="button" size="icon" aria-label={t('workbench.graph.zoomIn')} onClick={() => flow.zoomIn()}><Plus size={14} /></Button>
      <Button type="button" onClick={() => flow.fitView({ padding: .18, duration: 0 })}><Maximize size={14} />{t('workbench.graph.fit')}</Button>
    </div>
    {edges.value.length !== (props.node.graph?.edges.length ?? 0) ? <p class="readonly-graph-canvas-warning">{t('workbench.readonlyGraph.missingEndpoints')}</p> : null}
  </section>
})
