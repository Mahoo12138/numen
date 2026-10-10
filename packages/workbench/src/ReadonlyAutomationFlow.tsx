import { Button } from '@numenjs/components'
import type { WorkbenchRunDetail } from './contracts.js'
import { statusLabel, t } from './i18n.js'
import { ReadonlyGraphCanvas } from './ReadonlyGraphCanvas.js'

type FlowNode = WorkbenchRunDetail['flow']['root']

/** Both views use the immutable Source topology; Graph edges are never rendered as sequence order. */
export function ReadonlyAutomationFlow({ flow, showExecutionState = false, onSelectNode, selectedNodeId }: {
  flow: WorkbenchRunDetail['flow']
  showExecutionState?: boolean
  onSelectNode?: ((id: string) => void) | undefined
  selectedNodeId?: string | undefined
}) {
  return <ol class="run-flow-tree"><ReadonlyFlowNode node={flow.root} depth={0} showExecutionState={showExecutionState}
    onSelectNode={onSelectNode} selectedNodeId={selectedNodeId} selectable={false} showGraphCanvas={!flow.focusedNodeId} /></ol>
}

function ReadonlyFlowNode({ node, depth, showExecutionState, onSelectNode, selectedNodeId, selectable = true, showGraphCanvas = true }: {
  node: FlowNode
  depth: number
  showExecutionState: boolean
  onSelectNode?: ((id: string) => void) | undefined
  selectedNodeId?: string | undefined
  selectable?: boolean
  showGraphCanvas?: boolean
}) {
  return <li>
    <div class="run-flow-node" data-status={showExecutionState ? node.status : undefined} data-selected={node.id === selectedNodeId}>
      <span aria-hidden="true" class="run-flow-marker" />
      <div><strong>{node.title}</strong><p>{node.detail}</p><code>{node.id}</code>
        {showExecutionState && node.blockedReason ? <p>{t('workbench.graph.blockedReason', { reason: node.blockedReason })}</p> : null}</div>
      {showExecutionState ? <em data-status={node.status}>{statusLabel(node.status)}</em> : null}
      {showExecutionState && node.sampledExecutionCount ? <span class="readonly-graph-sample">{t('workbench.readonlyGraph.sample', { count: node.sampledExecutionCount })}</span> : null}
      {onSelectNode && selectable ? <Button data-run-source-id={node.id}
        aria-label={t(showExecutionState ? 'workbench.runData.executionsFor' : 'workbench.snapshots.nodeDetailsFor', { node: node.id })}
        onClick={() => onSelectNode(node.id)} type="button">{t(showExecutionState ? 'workbench.runData.executions' : 'workbench.snapshots.nodeDetails')}</Button> : null}
    </div>
    {node.graph ? <section class="readonly-graph" data-readonly-graph-id={node.id}>
      <p>{t('workbench.graph.topologyHelp')}</p>
      {showGraphCanvas ? <ReadonlyGraphCanvas node={node} showExecutionState={showExecutionState} onSelectNode={onSelectNode} selectedNodeId={selectedNodeId} /> : null}
      <details class="readonly-graph-details" open={!showGraphCanvas}>
        <summary>{t('workbench.readonlyGraph.details')}</summary>
        <h3>{t('workbench.graph.members')}</h3>
        <ul class="readonly-graph-members">{node.graph.nodes.map(member => <ReadonlyFlowNode key={member.id} node={member} depth={depth + 1}
          showExecutionState={showExecutionState} onSelectNode={onSelectNode} selectedNodeId={selectedNodeId} showGraphCanvas={showGraphCanvas} />)}</ul>
        <h3>{t('workbench.graph.edges')}</h3>
        <div class="readonly-graph-edges"><table>
          <thead><tr><th>{t('workbench.graph.edge')}</th><th>{t('workbench.graph.from')}</th><th>{t('workbench.graph.to')}</th></tr></thead>
          <tbody>{node.graph.edges.map(edge => <tr key={edge.id} data-graph-edge-id={edge.id}>
            <td><code>{edge.id}</code></td><td><code>{edge.from.nodeId}.{edge.from.port}</code></td><td><code>{edge.to.nodeId}.{edge.to.port}</code></td>
          </tr>)}</tbody>
        </table></div>
      </details>
    </section> : null}
    {node.children.length ? <ol style={!showExecutionState && depth >= 6 ? { marginInlineStart: 0, paddingInlineStart: 0 } : undefined}>
      {node.children.map(child => <ReadonlyFlowNode key={child.id} node={child} depth={depth + 1} showExecutionState={showExecutionState}
        onSelectNode={onSelectNode} selectedNodeId={selectedNodeId} showGraphCanvas={showGraphCanvas} />)}
    </ol> : null}
  </li>
}
