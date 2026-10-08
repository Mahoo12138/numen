import { Button } from '@numenjs/components'
import { computed, nextTick, ref, watch } from 'vue'
import { ReadonlyAutomationFlow } from './ReadonlyAutomationFlow.js'
import { workbenchAutomationSnapshotQueryRef, type WorkbenchAutomationSnapshotDetail, type WorkbenchAutomationSnapshotQueryInput } from './contracts.js'
import { formatDateTime, t } from './i18n.js'
import { coreWorkbenchRoutes, coreWorkbenchRunFlowRoute } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { useConsoleQuery, type ConsoleQueryState } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'

export const AutomationSnapshotPage = defineSetupComponent<WorkbenchPageProps>('AutomationSnapshotPage', ['consoleClient', 'schemaUI', 'navigation'], props => {
  const input = computed<WorkbenchAutomationSnapshotQueryInput>(() => ({
    automationId: props.navigation?.route.parameters.automationId ?? '',
    snapshotId: props.navigation?.route.parameters.snapshotId ?? '',
  }))
  // Immutable IDs stay fixed across Draft edits and plugin invalidation. Refresh is explicit.
  const [state, reload] = useConsoleQuery<WorkbenchAutomationSnapshotQueryInput, WorkbenchAutomationSnapshotDetail | null>(
    () => props.consoleClient && input.value.automationId && input.value.snapshotId ? props.consoleClient : undefined,
    workbenchAutomationSnapshotQueryRef, input,
  )
  const selectedNode = ref<string>()
  watch(input, () => { selectedNode.value = undefined }, { flush: 'sync' })
  const locateNode = (nodeId: string) => {
    const snapshotId = input.value.snapshotId
    selectedNode.value = nodeId
    void nextTick(() => {
      if (input.value.snapshotId !== snapshotId) return
      const target = [...document.querySelectorAll<HTMLElement>('[data-snapshot-node]')].find(item => item.dataset.snapshotNode === nodeId)
      target?.focus()
      target?.scrollIntoView({ block: 'nearest' })
    })
  }
  const openAutomation = () => props.navigation?.navigate(coreWorkbenchRoutes.automations, { query: { automation: input.value.automationId, tab: 'Revisions' } })
  const fromRun = computed(() => new URLSearchParams(props.navigation?.route.search ?? '').get('fromRun'))
  return () => <main class="main-workbench core-page automation-snapshot-page">
    <header class="core-page-header snapshot-header">
      <div>
        <h1>{state.status === 'READY' && state.data ? snapshotTitle(state.data) : t('workbench.snapshots.title')}</h1>
        <p>{t('workbench.snapshots.readonly')}</p>
      </div>
      <div class="snapshot-actions">
        {state.status === 'READY' && state.data && state.data.compatibility !== 'unsupported-protocol' ? <Button type="button" variant="secondary" onClick={() => props.navigation?.navigate(coreWorkbenchRoutes.automations, { query: { automation: input.value.automationId, tab: 'Revisions', restoreSnapshot: input.value.snapshotId } })}>{t('workbench.restoration.title')}</Button> : null}
        {fromRun.value ? <Button type="button" variant="secondary" onClick={() => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: fromRun.value! } })}>{t('workbench.snapshots.returnRun')}</Button> : null}
        <Button type="button" variant="secondary" onClick={openAutomation}>{t('workbench.navigation.openAutomation')}</Button>
        <Button type="button" variant="secondary" onClick={reload} disabled={state.status === 'LOADING' || state.status === 'DISABLED'}>{t('workbench.management.refresh')}</Button>
      </div>
    </header>
    <AutomationSnapshotContent state={state} onReload={reload} onSelectNode={locateNode} selectedNodeId={selectedNode.value} />
  </main>
})

function snapshotTitle(detail: WorkbenchAutomationSnapshotDetail): string {
  return t('workbench.snapshots.identityTitle', { identity: detail.identity.purpose === 'draft-test'
    ? t('workbench.draftTest.target', { version: detail.identity.sourceDraftVersion })
    : t('workbench.revisionValue0', { value0: detail.identity.number }) })
}

export function AutomationSnapshotContent({ state, onReload, onSelectNode, selectedNodeId }: {
  state: ConsoleQueryState<WorkbenchAutomationSnapshotDetail | null>
  onReload(): void
  onSelectNode?: ((id: string) => void) | undefined
  selectedNodeId?: string | undefined
}) {
  if (state.status === 'DISABLED') return <SnapshotNotice message={t('workbench.snapshots.runtimeRequired')} />
  if (state.status === 'LOADING') return <SnapshotNotice message={t('workbench.snapshots.loading')} busy />
  if (state.status === 'ERROR') return <SnapshotNotice message={t(state.code === 'AUTOMATION_SNAPSHOT_LIMIT' ? 'workbench.snapshots.tooLarge' : 'workbench.snapshots.unavailable')} error onReload={onReload} />
  if (!state.data) return <SnapshotNotice message={t('workbench.snapshots.notFound')} />
  const detail = state.data
  return <div class="automation-snapshot-content">
    <section class="snapshot-facts" aria-label={t('workbench.snapshots.facts')}>
      <dl>
        <div><dt>{t('workbench.automation')}</dt><dd>{detail.automationName}</dd></div>
        <div><dt>{t('workbench.snapshots.id')}</dt><dd><code>{detail.identity.id}</code></dd></div>
        <div><dt>{t('workbench.snapshots.created')}</dt><dd>{formatDateTime(detail.identity.createdAt)}</dd></div>
        <div><dt>{t('workbench.snapshots.format')}</dt><dd>Source {detail.identity.protocolVersion} · IR {detail.identity.irVersion}</dd></div>
        <div><dt>{t('workbench.snapshots.hash')}</dt><dd><code>{detail.identity.contentHash}</code></dd></div>
      </dl>
    </section>
    {detail.compatibility === 'unsupported-protocol' ? <SnapshotNotice message={t('workbench.snapshots.unsupported')} /> : <>
      <p class="snapshot-inspection-note">{t('workbench.snapshots.classification')}</p>
      <section class="snapshot-section" aria-labelledby="snapshot-flow-title">
        <h2 id="snapshot-flow-title">{t('workbench.flow')}</h2>
        <ReadonlyAutomationFlow flow={detail.flow} onSelectNode={onSelectNode} selectedNodeId={selectedNodeId} />
        {detail.flow.truncated ? <p role="status">{t('workbench.snapshots.truncated')}</p> : null}
      </section>
      <section class="snapshot-section" aria-labelledby="snapshot-inputs-title">
        <h2 id="snapshot-inputs-title">{t('workbench.snapshots.inputs')}</h2>
        {detail.inputs.length ? <ul class="snapshot-inputs">{detail.inputs.map(input => <li key={input.name}>
          <code>input.{input.name}</code><span>{input.type}</span><span>{input.required ? t('workbench.required') : t('workbench.optional')}</span>
          {input.hasDefault ? <span>{t('workbench.snapshots.hasDefault')}</span> : null}
        </li>)}</ul> : <p>{t('workbench.snapshots.noInputs')}</p>}
        {detail.inputsTruncated ? <p role="status">{t('workbench.snapshots.truncated')}</p> : null}
      </section>
      <section class="snapshot-section" aria-labelledby="snapshot-source-title">
        <h2 id="snapshot-source-title">{t('workbench.snapshots.source')}</h2>
        <div class="snapshot-source-nodes">{detail.source.nodes.map(node => <article data-snapshot-node={node.nodeId} tabindex={-1} key={node.nodeId}>
          <h3><code>{node.nodeId}</code> · {node.type}</h3>
          {node.capability || node.control ? <p><code>{(node.capability ?? node.control)!.id}@{(node.capability ?? node.control)!.version}</code></p> : null}
          {node.connectionBindingCount ? <p>{t('workbench.snapshots.bindings', { count: node.connectionBindingCount })}</p> : null}
          {node.input.available ? <pre>{JSON.stringify(node.input.value, null, 2)}</pre> : null}
          {node.input.hidden ? <p>{t('workbench.snapshots.hiddenValues', { count: node.input.hidden })}</p> : null}
          {node.expressionFields.length ? <ul>{node.expressionFields.map(field => <li key={field.field}><code>{field.field}</code> · {field.type}</li>)}</ul> : null}
          {node.policy ? <details><summary>{t('workbench.snapshots.policy')}</summary><pre>{JSON.stringify(node.policy, null, 2)}</pre></details> : null}
          {node.input.truncated ? <p role="status">{t('workbench.snapshots.truncated')}</p> : null}
        </article>)}</div>
        {detail.source.truncated ? <p role="status">{t('workbench.snapshots.truncated')}</p> : null}
        <h3>{t('workbench.snapshots.triggers')}</h3>
        {detail.source.triggers.length ? detail.source.triggers.map(trigger => <article class="snapshot-trigger" key={trigger.id}>
          <strong><code>{trigger.id}</code> · {trigger.capability.id}@{trigger.capability.version}</strong>
          <pre>{JSON.stringify(trigger.config.value, null, 2)}</pre>
          {trigger.config.truncated ? <p role="status">{t('workbench.snapshots.truncated')}</p> : null}
        </article>) : <p>{t('workbench.snapshots.noTriggers')}</p>}
        <details><summary>{t('workbench.snapshots.policy')}</summary><pre>{JSON.stringify(detail.source.policy, null, 2)}</pre></details>
      </section>
      <section class="snapshot-section" aria-labelledby="snapshot-presentation-title">
        <h2 id="snapshot-presentation-title">{t('workbench.snapshots.presentation')}</h2>
        <p>{t('workbench.snapshots.collapsedNodes')}</p>
        <pre>{JSON.stringify(detail.presentation.collapsedNodes, null, 2)}</pre>
        {detail.presentation.hiddenFields ? <p>{t('workbench.snapshots.hiddenPresentation', { count: detail.presentation.hiddenFields })}</p> : null}
        {detail.presentation.truncated ? <p role="status">{t('workbench.snapshots.truncated')}</p> : null}
      </section>
    </>}
  </div>
}

function SnapshotNotice({ message, error = false, busy = false, onReload }: { message: string; error?: boolean; busy?: boolean; onReload?: (() => void) | undefined }) {
  return <section class="run-detail-state snapshot-notice" aria-busy={busy} role={error ? 'alert' : 'status'}>
    <p>{message}</p>{onReload ? <Button type="button" onClick={onReload}>{t('workbench.tryAgain')}</Button> : null}
  </section>
}
