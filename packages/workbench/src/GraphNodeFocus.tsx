import { Button, SelectMenu } from '@numenjs/components'
import type { AutomationSource } from '@numenjs/core'
import { computed, ref, watch, type VNodeChild } from 'vue'
import type { WorkbenchConsoleClient } from './types.js'
import { defineSetupComponent } from './vue-component.js'
import { t, statusLabel } from './i18n.js'
import { findAutomationNode } from './graph-source-editing.js'
import { completeInspectedValue, graphFocusInputSources, observedValuePaths } from './graph-node-focus-model.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { useExecutionData } from './useExecutionData.js'
import { workbenchRunsIndexQueryRef, workbenchRunDetailQueryRef, type WorkbenchAutomationInsertCatalog, type WorkbenchAutomationVariableCatalog, type WorkbenchRunsIndex, type WorkbenchRunsQueryInput, type WorkbenchRunDetail, type WorkbenchRunDetailQueryInput, type WorkbenchInspectedValue } from './contracts.js'

export interface GraphNodeFocusProps {
  automationId: string
  nodeId: string
  source: AutomationSource
  draftVersion: number
  draftDirty: boolean
  canEdit: boolean
  client?: WorkbenchConsoleClient
  catalog?: WorkbenchAutomationInsertCatalog
  variableCatalog?: WorkbenchAutomationVariableCatalog
  parameters: VNodeChild
  localTest?: VNodeChild
  onClose(): boolean
  onReference?(fieldName: string, path: string, dependencyNodeId?: string): boolean
}

export const GraphNodeFocus = defineSetupComponent<GraphNodeFocusProps>('GraphNodeFocus', ['automationId', 'nodeId', 'source', 'draftVersion', 'draftDirty', 'canEdit', 'client', 'catalog', 'variableCatalog', 'parameters', 'localTest', 'onClose', 'onReference'], props => {
  const tab = ref<'input' | 'parameters' | 'output'>('parameters'), targetField = ref(''), runId = ref(''), executionId = ref(''), historyNodeId = ref(props.nodeId), copied = ref<string>()
  const node = computed(() => findAutomationNode(props.source, props.nodeId))
  const definition = computed(() => node.value?.type === 'capability' ? props.catalog?.items.find(item => item.kind === 'capability' && node.value?.type === 'capability' && item.capability.id === node.value.capability.id && item.capability.version === node.value.capability.version) : undefined)
  const outputDefinition = computed(() => node.value?.type === 'capability' ? props.variableCatalog?.definitions.find(item => node.value?.type === 'capability' && item.capability.id === node.value.capability.id && item.capability.version === node.value.capability.version) : undefined)
  const inputs = computed(() => graphFocusInputSources(props.source, props.nodeId, props.catalog, props.variableCatalog))
  const otherSources = computed(() => graphFocusInputSources(props.source, props.nodeId, props.catalog, props.variableCatalog, true).filter(item => !inputs.value.some(input => input.nodeId === item.nodeId)))
  const [runs] = useConsoleQuery<WorkbenchRunsQueryInput, WorkbenchRunsIndex>(() => props.client, workbenchRunsIndexQueryRef, () => ({ automationId: props.automationId, limit: 20 }), 'runs')
  const [run] = useConsoleQuery<WorkbenchRunDetailQueryInput, WorkbenchRunDetail>(() => runId.value ? props.client : undefined, workbenchRunDetailQueryRef,
    () => ({ runId: runId.value, sourceNodeId: historyNodeId.value, executionLimit: 50, eventLimit: 1 }), 'runs')
  const data = useExecutionData(() => props.client, runId)
  watch(() => [runId.value, historyNodeId.value], () => { executionId.value = ''; data.close() }, { flush: 'sync' })
  watch(() => props.nodeId, value => { historyNodeId.value = value; targetField.value = ''; tab.value = 'parameters'; copied.value = undefined }, { flush: 'sync' })
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); copied.value = t('workbench.focus.copied') }
    catch { copied.value = t('workbench.focus.copyFailed') }
  }
  const isCurrent = computed(() => run.status === 'READY' && run.data.run.snapshotPurpose === 'draft-test' && run.data.run.sourceDraftVersion === props.draftVersion && !props.draftDirty)
  const execution = computed(() => run.status === 'READY' ? run.data.executions.find(item => item.id === executionId.value && item.sourceNodeId === historyNodeId.value) : undefined)
  const inspected = computed(() => data.state.value.status === 'READY' && data.state.value.data.runId === runId.value && data.state.value.data.executionId === executionId.value && data.state.value.data.sourceNodeId === historyNodeId.value ? data.state.value.data : undefined)
  const reference = (path: string, dependencyNodeId?: string) => { if (targetField.value && props.onReference?.(targetField.value, path, dependencyNodeId)) tab.value = 'parameters' }
  const valuePanel = (value: WorkbenchInspectedValue, paths: boolean) => <div class="focus-execution-value">
    {!completeInspectedValue(value) ? <p role="status">{t('workbench.focus.restricted')}</p> : <Button type="button" onClick={() => { void copy(JSON.stringify(value.value, null, 2)) }}>{t('workbench.focus.copyValue')}</Button>}
    <pre>{JSON.stringify(value.value, null, 2)}</pre>
    {paths && completeInspectedValue(value) ? <details><summary>{t('workbench.focus.observed')}</summary>
      {observedValuePaths(value.value, `steps.${historyNodeId.value}`).map(item => <div class="focus-field" key={item.path}><code>{item.path}</code><small>{t('workbench.focus.unverified')}</small>
        <Button type="button" onClick={() => { void copy(item.path) }}>{t('workbench.focus.copyReference')}</Button>
        {historyNodeId.value !== props.nodeId ? <Button type="button" disabled={!props.canEdit || !targetField.value} onClick={() => reference(item.path)}>{t('workbench.focus.reference')}</Button> : null}
      </div>)}
    </details> : null}
  </div>
  return () => <section class="graph-node-focus" aria-label={t('workbench.focus.title')}>
    <header><div><h2>{definition.value?.title ?? props.nodeId}</h2><code>{props.nodeId}</code></div><Button type="button" onClick={props.onClose}>{t('workbench.focus.back')}</Button></header>
    {props.localTest}
    <nav class="focus-tabs" aria-label={t('workbench.focus.title')}>{(['input', 'parameters', 'output'] as const).map(value => <Button type="button" aria-pressed={tab.value === value} onClick={() => { tab.value = value }}>{t(`workbench.focus.${value}`)}</Button>)}</nav>
    <div class="focus-history">
      <strong>{t('workbench.focus.history')}</strong>
      <SelectMenu ariaLabel={t('workbench.focus.chooseRun')} value={runId.value} options={[{ value: '', label: t('workbench.focus.chooseRun') }, ...(runs.status === 'READY' ? runs.data.items.map(item => ({ value: item.id, label: `${item.id} · ${statusLabel(item.status)} · ${item.snapshotPurpose ?? 'published'}${item.sourceDraftVersion ? ` v${item.sourceDraftVersion}` : ''}` })) : [])]} onChange={value => { runId.value = value }} />
      <SelectMenu ariaLabel={t('workbench.focus.source')} value={historyNodeId.value} options={[{ value: props.nodeId, label: props.nodeId }, ...inputs.value.map(input => ({ value: input.nodeId, label: `${input.title} · ${input.nodeId}` }))]} onChange={value => { historyNodeId.value = value }} />
      <SelectMenu ariaLabel={t('workbench.focus.chooseExecution')} value={executionId.value} options={[{ value: '', label: t('workbench.focus.chooseExecution') }, ...(run.status === 'READY' ? run.data.executions.map(item => ({ value: item.id, label: `${item.id} · ${statusLabel(item.status)}${item.loopIndex !== undefined ? ` · #${item.loopIndex}` : ''}` })) : [])]} onChange={value => { executionId.value = value; data.close() }} />
      <Button type="button" disabled={!execution.value} onClick={() => { if (execution.value) data.open(execution.value.id) }}>{t('workbench.focus.inspect')}</Button>
      {run.status === 'READY' && execution.value ? <p class="focus-provenance">Run <code>{run.data.run.id}</code> · Snapshot <code>{run.data.run.revisionId}</code> · Execution <code>{execution.value.id}</code>{execution.value.scopeExecutionId ? <> · Scope <code>{execution.value.scopeExecutionId}</code></> : null}<br />{t(isCurrent.value ? 'workbench.focus.same' : 'workbench.focus.old')}</p> : <p>{t('workbench.focus.noHistory')}</p>}
      {run.status === 'ERROR' || runs.status === 'ERROR' || data.state.value.status === 'ERROR' ? <p role="alert">{t('workbench.focus.failed')}</p> : null}
      {execution.value?.sampleId ? <p>{t('workbench.localTest.sampled')} · <code>{execution.value.sampleId}</code></p> : null}
      {copied.value ? <p role="status">{copied.value}</p> : null}
    </div>
    <div class="focus-columns" data-tab={tab.value}>
      <section class="focus-input"><h3>{t('workbench.focus.input')}</h3>
        {definition.value && 'inputFields' in definition.value ? <label>{t('workbench.focus.target')}<SelectMenu ariaLabel={t('workbench.focus.target')} value={targetField.value} options={[{ value: '', label: t('workbench.focus.target') }, ...definition.value.inputFields.map(field => ({ value: field.name, label: field.label }))]} onChange={value => { targetField.value = value }} /></label> : null}
        {Object.keys(props.source.inputs ?? {}).length ? <section class="focus-source"><h4>{t('workbench.variableGroups.input')}</h4>{Object.entries(props.source.inputs ?? {}).map(([name, field]) => <div class="focus-field" key={name}><strong>{field.title ?? name}</strong><code>{`input.${name}`}</code><small>{field.type}</small><Button type="button" disabled={!props.canEdit || !targetField.value} onClick={() => reference(`input.${name}`)}>{t('workbench.focus.reference')}</Button></div>)}</section> : null}
        {!inputs.value.length ? <p>{t('workbench.focus.noInput')}</p> : null}
        {inputs.value.map(input => <section class="focus-source" key={input.nodeId}><h4>{input.title}</h4><p><code>{input.nodeId}</code> · {input.ports.join(', ')}</p>
          <small>{t('workbench.focus.schema')}</small>{input.fields.map(field => <div class="focus-field" key={field.path}><strong>{field.label}</strong><code>{field.path}</code><small>{field.type}{!field.verified ? ` · ${t('workbench.focus.unverified')}` : ''}</small><Button type="button" disabled={!props.canEdit || !targetField.value} onClick={() => reference(field.path)}>{t('workbench.focus.reference')}</Button></div>)}
        </section>)}
        {otherSources.value.length && node.value?.type === 'capability' ? <details class="focus-source"><summary>{t('workbench.focus.otherSources')}</summary>{otherSources.value.map(input => <section key={input.nodeId}><h4>{input.title} · {input.nodeId}</h4>
          {input.needsDependency ? <p>{t('workbench.inspector.warning.missing-dependency')}</p> : null}
          {input.fields.map(field => <div class="focus-field" key={field.path}><code>{field.path}</code><small>{field.type}{!field.verified ? ` · ${t('workbench.focus.unverified')}` : ''}</small>
            <Button type="button" disabled={!props.canEdit || !targetField.value} onClick={() => reference(field.path)}>{t('workbench.focus.reference')}</Button>
            {input.needsDependency ? <Button type="button" disabled={!props.canEdit || !targetField.value} onClick={() => reference(field.path, input.nodeId)}>{t('workbench.focus.referenceAndDependency')}</Button> : null}
          </div>)}
        </section>)}</details> : null}
        {inspected.value ? historyNodeId.value === props.nodeId ? valuePanel(inspected.value.input, false) : valuePanel(inspected.value.output, true) : null}
      </section>
      <section class="focus-parameters"><h3>{t('workbench.focus.parameters')}</h3>{props.parameters}</section>
      <section class="focus-output"><h3>{t('workbench.focus.output')}</h3><small>{t('workbench.focus.schema')}</small>
        {outputDefinition.value?.outputFields.length ? outputDefinition.value.outputFields.map(field => <div class="focus-field" key={field.path.join('.')}><strong>{field.label}</strong><code>{['steps', props.nodeId, ...field.path].join('.')}</code><small>{field.schemaType}{field.valueType === 'unknown' ? ` · ${t('workbench.focus.unverified')}` : ''}</small></div>) : <p>{t('workbench.focus.empty')}</p>}
        {inspected.value && historyNodeId.value === props.nodeId ? valuePanel(inspected.value.output, true) : null}
      </section>
    </div>
  </section>
})
