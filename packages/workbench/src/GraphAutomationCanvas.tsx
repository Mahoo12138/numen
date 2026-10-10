import { Button, SelectMenu, Input } from '@numenjs/components'
import type { AutomationSource, GraphNodeSource, GraphSource, NumenValue } from '@numenjs/core'
import { VueFlow, Handle, Position, ConnectionMode, MarkerType, useVueFlow, type Node, type Edge, type NodeChange, type EdgeChange, type NodeProps, type Connection, type NodeDragEvent } from '@vue-flow/core'
import { computed, markRaw, nextTick, ref, shallowRef, watch, type VNodeChild } from 'vue'
import { Plus, Minus, Maximize, Network, GitBranch, Play, Zap, Trash2, Copy, List, Link, Unlink, LayoutGrid, Repeat, Focus } from '@lucide/vue'
import type { AutomationStep } from './model.js'
import type { AutomationSourceCommand } from './automation-source-editing.js'
import type { WorkbenchAutomationInsertCatalog } from './contracts.js'
import { defineSetupComponent } from './vue-component.js'
import { statusLabel, t } from './i18n.js'
import { allocateGraphNodeId, allocateGraphEdgeId, graphCopyNodeIds } from './graph-source-editing.js'
import { canvasGraphPositions, graphInputPorts, graphOutputPorts, layoutGraph, graphEndpointKey, parseGraphEndpointKey, type GraphPosition } from './graph-canvas-projection.js'

interface CanvasNodeData {
  title: string
  summary: string
  connections: string
  kind: string
  inputPorts: string[]
  outputPorts: string[]
  active: boolean
  problems: number
}

function CanvasNode(props: NodeProps<CanvasNodeData>) {
  const Icon = props.data.kind === 'graph' ? Play : props.data.kind === 'condition' ? GitBranch : props.data.kind === 'merge' ? Network : props.data.kind === 'foreach' ? Repeat : Zap
  return <div class="graph-node" data-active={props.data.active || props.selected} data-kind={props.data.kind} data-node-id={props.id}>
    <div class="graph-node-heading"><Icon size={17} /><strong>{props.data.title}</strong>{props.data.problems ? <span class="graph-node-problems">{props.data.problems}</span> : null}</div>
    <small class="graph-node-summary">{props.data.summary}</small>
    {props.data.connections ? <small class="graph-node-summary" title={props.data.connections}>{props.data.connections}</small> : null}
    <div class="graph-node-ports">
      <div>{props.data.inputPorts.map(port => <div class="graph-node-port" key={port}><Handle id={port} type="target" position={Position.Left} connectable={props.connectable} /><span>{port}</span></div>)}</div>
      <div>{props.data.outputPorts.map(port => <div class="graph-node-port" key={port}><span>{port}</span><Handle id={port} type="source" position={Position.Right} connectable={props.connectable} /></div>)}</div>
    </div>
  </div>
}

export interface GraphAutomationCanvasProps {
  source: AutomationSource
  graph: GraphSource
  presentation: Record<string, NumenValue>
  steps: AutomationStep[]
  activeStepId: string
  canEdit: boolean
  catalog?: WorkbenchAutomationInsertCatalog
  toolbar?: VNodeChild
  onFocusNode?(nodeId: string): boolean | void
  onOpenScope?(graphId: string): void
  onStepChange(id: string): boolean | void
  onCommand?(command: AutomationSourceCommand, expectedSource?: AutomationSource): boolean
  onPositions?(graphId: string, positions: Record<string, GraphPosition>, expectedSource?: AutomationSource): boolean
}

let canvasId = 0
export const GraphAutomationCanvas = defineSetupComponent<GraphAutomationCanvasProps>('GraphAutomationCanvas', ['source', 'graph', 'presentation', 'steps', 'activeStepId', 'canEdit', 'catalog', 'toolbar', 'onFocusNode', 'onOpenScope', 'onStepChange', 'onCommand', 'onPositions'], props => {
  const id = `numen-graph-${++canvasId}`
  const flow = useVueFlow({ id })
  const nodes = shallowRef<Node<CanvasNodeData>[]>([]), edges = shallowRef<Edge[]>([])
  const nodeTypes = { numen: markRaw(CanvasNode) }
  const showPalette = ref(false), showConnections = ref(false), showOutline = ref(false)
  const search = ref(''), fromKey = ref(''), toKey = ref(''), edgeId = ref<string>()
  const selectedIds = ref<string[]>([])
  let dragSource: AutomationSource | undefined
  const command = (value: AutomationSourceCommand, expectedSource?: AutomationSource) => props.canEdit && !!props.onCommand?.(value, expectedSource)
  const project = () => {
    const positions = canvasGraphPositions(props.graph, props.presentation)
    const steps = new Map(props.steps.map(step => [step.sourceId, step]))
    nodes.value = [props.graph, ...props.graph.nodes].map(node => {
      const step = steps.get(node.id)
      const connections = node.type === 'capability' ? Object.entries(node.connections ?? (node.connection ? { default: node.connection } : {})).map(([slot, connectionId]) => {
        const connection = props.catalog?.connections.find(item => item.id === connectionId)
        return `${slot}: ${connection?.name ?? connectionId}${connection ? ` · ${statusLabel(connection.status)}` : ''}`
      }).join('; ') : ''
      return { id: node.id, type: 'numen', position: positions[node.id]!, selected: selectedIds.value.includes(node.id),
        ariaLabel: `${step?.label ?? node.id} (${node.id})`,
        data: { title: node.type === 'graph' ? t('workbench.graph.start') : step?.label ?? node.id,
          summary: node.type === 'graph' ? t('workbench.graph.explicitStart') : node.id,
          connections,
          kind: node.type, active: props.activeStepId === `source:${node.id}`, problems: step?.problemCount ?? 0,
          inputPorts: node.type === 'graph' ? [] : graphInputPorts(node), outputPorts: graphOutputPorts(node) } }
    })
    edges.value = props.graph.edges.map(edge => ({ id: edge.id, source: edge.from.nodeId, target: edge.to.nodeId,
      sourceHandle: edge.from.port, targetHandle: edge.to.port, type: 'default', markerEnd: MarkerType.ArrowClosed,
      selected: edge.id === edgeId.value, ariaLabel: `${edge.from.nodeId}.${edge.from.port} → ${edge.to.nodeId}.${edge.to.port}` }))
  }
  watch(() => [props.graph, props.presentation, props.activeStepId, props.steps, props.catalog] as const, () => {
    selectedIds.value = selectedIds.value.filter(id => props.graph.nodes.some(node => node.id === id))
    if (edgeId.value && !props.graph.edges.some(edge => edge.id === edgeId.value)) edgeId.value = undefined
    project()
  }, { immediate: true })
  const nextId = (prefix: string, used: string[]) => {
    const reserved = JSON.stringify(props.source)
    let index = 1
    while (used.includes(`${prefix}-${index}`) || reserved.includes(`steps.${prefix}-${index}`)) index++
    return `${prefix}-${index}`
  }
  const newEdgeId = () => allocateGraphEdgeId(props.graph)
  const connect = (connection: Connection) => {
    if (!connection.sourceHandle || !connection.targetHandle) return
    command({ type: 'GRAPH_CONNECT', graphId: props.graph.id, edge: { id: newEdgeId(), from: { nodeId: connection.source, port: connection.sourceHandle }, to: { nodeId: connection.target, port: connection.targetHandle } } })
  }
  const commitPositions = (changed: Array<{ id: string; position: GraphPosition }>, expectedSource?: AutomationSource) => {
    const positions = Object.fromEntries(changed.map(node => [node.id, { ...node.position }]))
    if (!props.canEdit || !props.onPositions?.(props.graph.id, positions, expectedSource)) project()
  }
  const nodesChange = (changes: NodeChange[]) => {
    flow.applyNodeChanges(changes.filter(change => change.type !== 'remove' && change.type !== 'add'))
    selectedIds.value = flow.getSelectedNodes.value.map(node => node.id).filter(id => id !== props.graph.id)
    const removed = changes.filter(change => change.type === 'remove').map(change => change.id).filter(id => id !== props.graph.id)
    if (removed.length) command({ type: 'GRAPH_DELETE_NODES', graphId: props.graph.id, nodeIds: removed })
    const moved = changes.filter((change): change is Extract<NodeChange, { type: 'position' }> => change.type === 'position' && change.dragging === undefined)
    if (moved.length && !dragSource) commitPositions(moved)
  }
  const edgesChange = (changes: EdgeChange[]) => {
    flow.applyEdgeChanges(changes.filter(change => change.type === 'select'))
    for (const change of changes) if (change.type === 'remove') command({ type: 'GRAPH_DISCONNECT', graphId: props.graph.id, edgeId: change.id })
  }
  const dragStop = ({ nodes: moved }: NodeDragEvent) => { commitPositions(moved, dragSource); dragSource = undefined }
  const focus = (nodeId: string) => {
    if (props.onStepChange(`source:${nodeId}`) === false) return
    const node = flow.findNode(nodeId)
    if (node) void flow.setCenter(node.position.x + 96, node.position.y + 48, { zoom: 1, duration: 0 })
  }
  const addNode = (kind: 'condition' | 'merge' | string) => {
    const item = props.catalog?.items.find(item => item.kind === 'capability' && `${item.capability.id}@${item.capability.version}` === kind)
    const nodeId = allocateGraphNodeId(props.source, ['condition', 'merge', 'foreach'].includes(kind) ? kind : 'capability')
    const node: GraphNodeSource | undefined = kind === 'condition' ? { type: 'condition', id: nodeId, condition: { type: 'literal', value: true } }
      : kind === 'merge' ? { type: 'merge', id: nodeId, mode: 'all', inputs: ['first', 'second'] }
      : kind === 'foreach' ? { type: 'foreach', id: nodeId, items: { type: 'literal', value: [] }, concurrency: 1, body: { type: 'graph', version: 1, id: allocateGraphNodeId(props.source, `${nodeId}-body`), nodes: [], edges: [], output: { type: 'ref', path: 'loop.item' } } }
      : item?.kind === 'capability' ? { type: 'capability', id: nodeId, capability: item.capability,
        input: Object.fromEntries((item.inputFields ?? []).flatMap(field => 'defaultValue' in field ? [[field.name, { type: 'literal', value: field.defaultValue! }]] : [])) } : undefined
    if (!node) return
    const inserted = edgeId.value && node.type !== 'merge'
      ? command({ type: 'GRAPH_INSERT_ON_EDGE', graphId: props.graph.id, edgeId: edgeId.value, node, inputPort: 'in', outputPort: node.type === 'condition' ? 'true' : 'out', newEdgeId: newEdgeId() })
      : command({ type: 'GRAPH_ADD_NODE', graphId: props.graph.id, node })
    if (inserted) { showPalette.value = false; void nextTick(() => focus(node.id)) }
  }
  const copySelected = () => {
    const ids = selectedIds.value.length ? selectedIds.value : [props.activeStepId.slice(7)].filter(id => props.graph.nodes.some(node => node.id === id))
    const used = props.steps.flatMap(step => step.sourceId ? [step.sourceId] : [])
    const idMap = Object.fromEntries(graphCopyNodeIds(props.graph, ids).map(id => { const copyId = nextId(`${id}-copy`, used); used.push(copyId); return [id, copyId] }))
    const usedEdges = props.graph.edges.map(edge => edge.id)
    const edgeIdMap = Object.fromEntries(props.graph.edges.filter(edge => ids.includes(edge.from.nodeId) && ids.includes(edge.to.nodeId)).map(edge => {
      const copyId = nextId('edge-copy', usedEdges); usedEdges.push(copyId); return [edge.id, copyId]
    }))
    if (ids.length) command({ type: 'GRAPH_COPY_NODES', graphId: props.graph.id, nodeIds: ids, idMap, edgeIdMap })
  }
  const endpoints = computed(() => ({
    from: [props.graph, ...props.graph.nodes].flatMap(node => graphOutputPorts(node).map(port => ({ value: graphEndpointKey({ nodeId: node.id, port }), label: `${node.id} · ${port}` }))),
    to: props.graph.nodes.flatMap(node => graphInputPorts(node).map(port => ({ value: graphEndpointKey({ nodeId: node.id, port }), label: `${node.id} · ${port}` }))),
  }))
  const applyConnection = () => {
    const from = parseGraphEndpointKey(fromKey.value), to = parseGraphEndpointKey(toKey.value)
    if (!from || !to) return
    if (edgeId.value) command({ type: 'GRAPH_RECONNECT', graphId: props.graph.id, edgeId: edgeId.value, from, to })
    else command({ type: 'GRAPH_CONNECT', graphId: props.graph.id, edge: { id: newEdgeId(), from, to } })
  }
  const selectEdge = (id: string) => {
    edgeId.value = id
    const edge = props.graph.edges.find(edge => edge.id === id)
    if (edge) { fromKey.value = graphEndpointKey(edge.from); toKey.value = graphEndpointKey(edge.to) }
    showConnections.value = true; project()
  }
  const selectNode = (nodeId: string) => {
    if (props.onStepChange(`source:${nodeId}`) !== false) return true
    selectedIds.value = [props.activeStepId.slice(7)].filter(id => props.graph.nodes.some(node => node.id === id))
    project()
    return false
  }
  const focusNode = (nodeId: string) => { if (selectNode(nodeId)) props.onFocusNode?.(nodeId) }
  const openScope = (nodeId: string) => {
    const node = props.graph.nodes.find(node => node.id === nodeId)
    if (node?.type === 'foreach' && props.onStepChange(`source:${node.body.id}`) !== false) props.onOpenScope?.(node.body.id)
  }
  const keyboard = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !(event.target instanceof Element)
      || event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return
    if (!['Backspace', 'Delete'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    if (!props.canEdit) return
    if (selectedIds.value.length) command({ type: 'GRAPH_DELETE_NODES', graphId: props.graph.id, nodeIds: selectedIds.value })
    else if (edgeId.value) command({ type: 'GRAPH_DISCONNECT', graphId: props.graph.id, edgeId: edgeId.value })
  }
  return () => <section class="graph-editor" {...{ onKeydownCapture: keyboard }} aria-label={t('workbench.graph.canvas')}>
    <div class="graph-toolbar">
      {props.toolbar}
      <Button disabled={!props.canEdit} type="button" onClick={() => { showPalette.value = !showPalette.value; showOutline.value = false }} aria-expanded={showPalette.value}><Plus size={14} />{t('workbench.graph.add')}</Button>
      <Button disabled={!props.canEdit} type="button" onClick={() => { edgeId.value = undefined; showConnections.value = !showConnections.value; project() }} aria-expanded={showConnections.value}><Link size={14} />{t('workbench.graph.connect')}</Button>
      <Button disabled={!props.canEdit} type="button" onClick={() => { props.onPositions?.(props.graph.id, layoutGraph(props.graph), props.source); void nextTick(() => flow.fitView({ padding: .18, duration: 0 })) }}><LayoutGrid size={14} />{t('workbench.graph.layout')}</Button>
      <Button type="button" onClick={() => { showOutline.value = !showOutline.value; showPalette.value = false }} aria-expanded={showOutline.value}><List size={14} />{t('workbench.graph.outline')}</Button>
      <Button type="button" disabled={!props.activeStepId} onClick={() => focusNode(props.activeStepId.slice(7))}><Focus size={14} />{t('workbench.graph.focus')}</Button>
      {props.graph.nodes.find(node => node.id === props.activeStepId.slice(7))?.type === 'foreach' ? <Button type="button" onClick={() => openScope(props.activeStepId.slice(7))}><Repeat size={14} />{t('workbench.graph.openLoop')}</Button> : null}
      <Button disabled={!props.canEdit || !selectedIds.value.length} type="button" onClick={copySelected}><Copy size={14} />{t('workbench.graph.copy')}</Button>
      <Button disabled={!props.canEdit || !selectedIds.value.length} type="button" onClick={() => command({ type: 'GRAPH_DELETE_NODES', graphId: props.graph.id, nodeIds: selectedIds.value })}><Trash2 size={14} />{t('workbench.delete')}</Button>
    </div>
    {showConnections.value ? <div class="graph-connection-form">
      <label>{t('workbench.graph.from')}<SelectMenu ariaLabel={t('workbench.graph.from')} value={fromKey.value} options={[{ value: '', label: t('workbench.graph.choosePort') }, ...endpoints.value.from]} onChange={value => { fromKey.value = value }} /></label>
      <label>{t('workbench.graph.to')}<SelectMenu ariaLabel={t('workbench.graph.to')} value={toKey.value} options={[{ value: '', label: t('workbench.graph.choosePort') }, ...endpoints.value.to]} onChange={value => { toKey.value = value }} /></label>
      <Button type="button" disabled={!props.canEdit || !fromKey.value || !toKey.value} onClick={applyConnection}>{t(edgeId.value ? 'workbench.graph.reconnect' : 'workbench.graph.connect')}</Button>
      {edgeId.value ? <Button type="button" disabled={!props.canEdit} onClick={() => command({ type: 'GRAPH_DISCONNECT', graphId: props.graph.id, edgeId: edgeId.value! })}><Unlink size={14} />{t('workbench.graph.disconnect')}</Button> : null}
      <Button type="button" variant="ghost" onClick={() => { showConnections.value = false }}>{t('workbench.graph.close')}</Button>
    </div> : null}
    <div class="graph-stage">
      <VueFlow id={id} nodes={nodes.value} edges={edges.value} nodeTypes={nodeTypes} applyDefault={false} autoConnect={false}
        connectionMode={ConnectionMode.Strict} nodesDraggable={props.canEdit} nodesConnectable={props.canEdit} edgesUpdatable={props.canEdit}
        fitViewOnInit minZoom={.12} maxZoom={2} onlyRenderVisibleElements deleteKeyCode={null}
        onNodesChange={nodesChange} onEdgesChange={edgesChange} onConnect={connect}
        onNodeClick={({ node }) => { edgeId.value = undefined; selectNode(node.id) }} onNodeDoubleClick={({ node }) => props.graph.nodes.find(member => member.id === node.id)?.type === 'foreach' ? openScope(node.id) : focusNode(node.id)}
        onNodeDragStart={() => { dragSource = props.source }} onNodeDragStop={dragStop}
        onSelectionDragStart={() => { dragSource = props.source }} onSelectionDragStop={dragStop}
        onEdgeClick={({ edge }) => selectEdge(edge.id)}
        onEdgeUpdate={({ edge, connection }) => { if (connection.sourceHandle && connection.targetHandle) command({ type: 'GRAPH_RECONNECT', graphId: props.graph.id, edgeId: edge.id, from: { nodeId: connection.source, port: connection.sourceHandle }, to: { nodeId: connection.target, port: connection.targetHandle } }) }} />
      <div class="graph-viewport-controls">
        <Button type="button" size="icon" aria-label={t('workbench.graph.zoomOut')} onClick={() => flow.zoomOut()}><Minus size={14} /></Button>
        <span>{Math.round(flow.viewport.value.zoom * 100)}%</span>
        <Button type="button" size="icon" aria-label={t('workbench.graph.zoomIn')} onClick={() => flow.zoomIn()}><Plus size={14} /></Button>
        <Button type="button" onClick={() => flow.fitView({ padding: .18, duration: 0 })}><Maximize size={14} />{t('workbench.graph.fit')}</Button>
      </div>
      {!props.graph.nodes.length ? <p class="graph-empty-hint">{t('workbench.graph.empty')}</p> : null}
      {showPalette.value || showOutline.value ? <aside class="graph-flyout" aria-label={t(showPalette.value ? 'workbench.graph.add' : 'workbench.graph.outline')}>
        <Input aria-label={t('workbench.graph.search')} placeholder={t('workbench.graph.search')} value={search.value} onInput={event => { search.value = (event.target as HTMLInputElement).value }} />
        {showPalette.value ? <>
          <p>{t(edgeId.value ? 'workbench.graph.insertHint' : 'workbench.graph.addHint')}</p>
          <Button type="button" onClick={() => addNode('condition')}><GitBranch size={15} />{t('workbench.graph.condition')}</Button>
          <Button type="button" onClick={() => addNode('foreach')}><Repeat size={15} />{t('workbench.graph.foreach')}</Button>
          <Button type="button" onClick={() => addNode('merge')}><Network size={15} />{t('workbench.graph.merge')}</Button>
          {props.catalog?.items.filter(item => item.kind === 'capability' && item.title.toLowerCase().includes(search.value.toLowerCase())).map(item => item.kind === 'capability' ? <Button type="button" key={`${item.capability.id}@${item.capability.version}`} onClick={() => addNode(`${item.capability.id}@${item.capability.version}`)}><Zap size={15} />{item.title}</Button> : null)}
        </> : <>
          {props.steps.filter(step => (step.sourceId === props.graph.id || props.graph.nodes.some(node => node.id === step.sourceId)) && `${step.label} ${step.sourceId}`.toLowerCase().includes(search.value.toLowerCase())).map(step => <Button type="button" key={step.id} onClick={() => focus(step.sourceId!)}>{step.label}<small>{step.sourceId}</small></Button>)}
          <details><summary>{t('workbench.graph.edges', { count: props.graph.edges.length })}</summary>{props.graph.edges.map(edge => <Button type="button" key={edge.id} onClick={() => selectEdge(edge.id)}>{edge.from.nodeId}.{edge.from.port} → {edge.to.nodeId}.{edge.to.port}</Button>)}</details>
        </>}
      </aside> : null}
    </div>
    <p class="graph-execution-hint">{t('workbench.graph.executionHint')}</p>
  </section>
})
