import { Button } from '@numenjs/components'
import type { HostConfigImpact, HostConfigImpactNode } from '@numenjs/config'
import { formatDateTime, metadataText, t } from './i18n.js'
import { coreWorkbenchAutomationSnapshotRoute, coreWorkbenchRoutes, coreWorkbenchRunFlowRoute } from './routes.js'
import type { WorkbenchNavigation } from './types.js'

export interface PluginImpactPreviewProps { impact: HostConfigImpact; navigation?: WorkbenchNavigation }

/** Render only the Host's observed relationships; the browser never infers dependencies. */
export function PluginImpactPreview({ impact, navigation }: PluginImpactPreviewProps) {
  const byKey = new Map(impact.nodes.map(node => [node.key, node]))
  const identity = (node: HostConfigImpactNode) => node.kind === 'registration'
    ? `${node.id}@${node.version} · ${t(`workbench.ownership.role.${node.role}`)}` : node.id
  const open = (node: HostConfigImpactNode) => {
    if (node.kind === 'connection') navigation?.navigate(coreWorkbenchRoutes.connections, { query: { connectionId: node.id } })
    else if (node.kind === 'revision') navigation?.navigate(coreWorkbenchAutomationSnapshotRoute, { parameters: { automationId: node.automationId, snapshotId: node.id } })
    else if (node.kind === 'run') navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: node.id } })
  }
  return <section class="plugin-impact" aria-label={t('workbench.impact.title')} data-impact-status={impact.status}>
    <header><h3>{t('workbench.impact.title')}</h3><time datetime={impact.computedAt}>{t('workbench.impact.computedAt', { time: formatDateTime(impact.computedAt) })}</time></header>
    <p class="plugin-impact-summary">{t(`workbench.impact.status.${impact.status}`)}</p>
    <p>{t(impact.operationEffect === 'metadata-only' ? 'workbench.impact.metadataOnly' : 'workbench.impact.scope')}</p>
    {impact.truncated ? <p class="plugin-impact-notice" role="status">{t('workbench.impact.truncated')}</p> : null}
    {(['registration', 'connection', 'revision', 'run'] as const).map(kind => {
      const nodes = impact.nodes.filter(node => node.kind === kind)
      return nodes.length ? <section class="plugin-impact-group" key={kind}>
        <h4>{t(`workbench.impact.group.${kind}`, { count: nodes.length })}</h4>
        <ul>{nodes.map(node => <li key={node.key} data-impact-node-kind={node.kind} data-impact-id={node.id}>
          <header><code>{identity(node)}</code>
            {node.kind !== 'registration' ? <Button type="button" disabled={!navigation} aria-label={t('workbench.impact.open', { id: node.id })} onClick={() => open(node)}>{t('workbench.impact.view')}</Button> : null}
          </header>
          {node.kind === 'registration' ? <>
            <small>{t(`workbench.ownership.kind.${node.registrationKind}`)} · {t('workbench.impact.observedAt', { time: formatDateTime(node.observedAt) })}</small>
            <p>{t(`workbench.impact.role.${node.role}`)}</p>
          </> : node.kind === 'connection' ? <small>{t(node.enabled ? 'workbench.status.ENABLED' : 'workbench.status.DISABLED')}</small>
            : node.kind === 'revision' ? <small>{t('workbench.impact.automation', { id: node.automationId })}{node.active ? ` · ${t(node.automationEnabled ? 'workbench.status.ENABLED' : 'workbench.status.DISABLED')}` : ''} · {t(node.active ? 'workbench.impact.activeRevision' : 'workbench.impact.runSnapshot')} · {t(node.purpose === 'draft-test' ? 'workbench.impact.draftTest' : 'workbench.impact.published')}</small>
              : node.kind === 'run' ? <>
                <small>{t('workbench.impact.automation', { id: node.automationId })} · {metadataText(`workbench.status.${node.status}`, node.status)}</small>
                <p class="plugin-impact-run-condition" data-impact-run-condition={node.condition}>{t(`workbench.impact.run.${node.condition}`)}</p>
                {node.executions.length ? <details><summary>{t('workbench.impact.executions', { count: node.executions.length })}</summary><ul>
                  {node.executions.map(execution => <li key={execution.id}><code>{execution.id}</code> · {metadataText(`workbench.status.${execution.status}`, execution.status)}{execution.attemptStatus ? ` · ${metadataText(`workbench.status.${execution.attemptStatus}`, execution.attemptStatus)}` : ''}<small>{t(`workbench.impact.execution.${execution.scope}`)}</small>{execution.outcomeUnknown ? <small>{t('workbench.impact.historicalOutcomeUnknown')}</small> : null}</li>)}
                </ul></details> : null}
                {node.executionTruncated ? <small>{t('workbench.impact.executionTruncated')}</small> : null}
              </> : null}
        </li>)}</ul>
      </section> : null
    })}
    {impact.edges.length ? <details class="plugin-impact-edges"><summary>{t('workbench.impact.edges', { count: impact.edges.length })}</summary><ol>
      {impact.edges.map((edge, index) => <li key={index} data-impact-relation={edge.relation}>
        <div><code>{byKey.has(edge.from) ? identity(byKey.get(edge.from)!) : edge.from}</code><span aria-hidden="true"> → </span><code>{byKey.has(edge.to) ? identity(byKey.get(edge.to)!) : edge.to}</code></div>
        <p>{t(`workbench.impact.relation.${edge.relation}`)}</p>
        <small>{t('workbench.impact.evidence', { source: t(`workbench.impact.source.${edge.source}`) })}{edge.observedAt ? ` · ${formatDateTime(edge.observedAt)}` : ''}</small>
        {edge.executionId ? <small>{t('workbench.impact.executionEvidence', { id: edge.executionId })}</small> : null}
      </li>)}
    </ol></details> : null}
    {impact.history.length ? <details class="plugin-impact-history"><summary>{t('workbench.impact.history', { count: impact.history.length })}</summary>
      <p>{t('workbench.impact.historyExplanation')}</p><ul>{impact.history.map((item, index) => <li key={index}>
        <code>{item.entryId} → {item.registration.id}@{item.registration.version}</code> · {t(`workbench.ownership.role.${item.role}`)}<small>{t('workbench.impact.observedAt', { time: formatDateTime(item.observedAt) })}</small>
      </li>)}</ul>
    </details> : null}
    <details class="plugin-impact-coverage" open={impact.status === 'unknown' || impact.truncated}>
      <summary>{t('workbench.impact.coverage')}</summary>
      {impact.unknownReasons.length ? <ul class="plugin-impact-unknown">{impact.unknownReasons.map((reason, index) => <li key={index} data-impact-unknown={reason.code}>
        {t(`workbench.impact.unknown.${reason.code}`)}{reason.entryId ? <> · <code>{reason.entryId}</code></> : null}<small>{t(`workbench.impact.source.${reason.source}`)}</small>
      </li>)}</ul> : null}
      <ul>{impact.coverage.map(item => <li key={item.source} data-impact-source={item.source} data-impact-coverage={item.status}>
        <strong>{t(`workbench.impact.source.${item.source}`)}</strong> · {t(`workbench.impact.coverage.${item.status}`)}
        {item.status !== 'excluded' ? <small>{t('workbench.impact.scanned', { count: item.scanned, limit: item.limit })}</small> : null}
        {item.truncated ? <small>{t('workbench.impact.sourceTruncated')}</small> : null}
        {item.reasons.length ? <small>{item.reasons.map(reason => metadataText(`workbench.impact.reason.${reason}`, reason)).join(' · ')}</small> : null}
      </li>)}</ul>
    </details>
    {impact.operationEffect === 'runtime' ? <p class="plugin-impact-footnote">{t('workbench.impact.noReplay')}</p> : null}
  </section>
}
