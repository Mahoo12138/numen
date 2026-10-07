import { Button } from '@numenjs/components'
import type { WorkbenchRunDetail } from './contracts.js'
import { statusLabel, t } from './i18n.js'

type FlowNode = WorkbenchRunDetail['flow']['root']

/** The same immutable tree is used by Run inspection and snapshot inspection. */
export function ReadonlyAutomationFlow({ flow, showExecutionState = false, onSelectNode, selectedNodeId }: {
  flow: WorkbenchRunDetail['flow']
  showExecutionState?: boolean
  onSelectNode?: ((id: string) => void) | undefined
  selectedNodeId?: string | undefined
}) {
  return <ol class="run-flow-tree"><ReadonlyFlowNode node={flow.root} depth={0} showExecutionState={showExecutionState}
    onSelectNode={onSelectNode} selectedNodeId={selectedNodeId} selectable={false} /></ol>
}

function ReadonlyFlowNode({ node, depth, showExecutionState, onSelectNode, selectedNodeId, selectable = true }: {
  node: FlowNode
  depth: number
  showExecutionState: boolean
  onSelectNode?: ((id: string) => void) | undefined
  selectedNodeId?: string | undefined
  selectable?: boolean
}) {
  return <li>
    <div class="run-flow-node" data-status={showExecutionState ? node.status : undefined} data-selected={node.id === selectedNodeId}>
      <span aria-hidden="true" class="run-flow-marker" />
      <div><strong>{node.title}</strong><p>{node.detail}</p><code>{node.id}</code></div>
      {showExecutionState ? <em data-status={node.status}>{statusLabel(node.status)}</em> : null}
      {onSelectNode && selectable ? <Button data-run-source-id={node.id}
        aria-label={t(showExecutionState ? 'workbench.runData.executionsFor' : 'workbench.snapshots.nodeDetailsFor', { node: node.id })}
        onClick={() => onSelectNode(node.id)} type="button">{t(showExecutionState ? 'workbench.runData.executions' : 'workbench.snapshots.nodeDetails')}</Button> : null}
    </div>
    {node.children.length ? <ol style={!showExecutionState && depth >= 6 ? { marginInlineStart: 0, paddingInlineStart: 0 } : undefined}>
      {node.children.map(child => <ReadonlyFlowNode key={child.id} node={child} depth={depth + 1} showExecutionState={showExecutionState}
        onSelectNode={onSelectNode} selectedNodeId={selectedNodeId} />)}
    </ol> : null}
  </li>
}
