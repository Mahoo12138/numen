import { FormSection, Input, SelectMenu } from '@numenjs/components'
import type { AutomationSource, CompileDiagnostic, GraphForEachSource, GraphConditionSource, GraphMergeSource, GraphSource } from '@numenjs/core'
import { ref, watch } from 'vue'
import type { SchemaUIResolver } from '@numenjs/webui/schema-ui'
import { useAutomationFieldDraft } from './automation-field-draft.js'
import type { AutomationSourceCommand } from './automation-source-editing.js'
import type { WorkbenchAutomationVariableCatalog } from './contracts.js'
import { ValueExpressionField } from './ValueExpressionEditor.js'
import { defineSetupComponent } from './vue-component.js'
import { t } from './i18n.js'

interface Props {
  node: GraphSource | GraphMergeSource | GraphConditionSource | GraphForEachSource
  source: AutomationSource
  graphId: string
  canEdit: boolean
  schemaUI?: SchemaUIResolver
  problems: CompileDiagnostic[]
  variableCatalog?: WorkbenchAutomationVariableCatalog
  onCommand?(command: AutomationSourceCommand): boolean
}

export const GraphNodeConfiguration = defineSetupComponent<Props>('GraphNodeConfiguration', ['node', 'source', 'graphId', 'canEdit', 'schemaUI', 'problems', 'variableCatalog', 'onCommand'], props => {
  const portText = ref(props.node.type === 'merge' ? props.node.inputs.join(', ') : '')
  const concurrency = ref(props.node.type === 'foreach' ? String(props.node.concurrency ?? 1) : '1')
  const draft = useAutomationFieldDraft(() => props.node.id, () => props.node.type === 'foreach' ? 'concurrency' : 'inputs')
  const ports = () => portText.value.split(',').map(value => value.trim())
  const invalid = () => ports().some(value => !/^[a-zA-Z0-9_$-]+$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) || new Set(ports()).size !== ports().length
  const invalidConcurrency = () => !/^[1-9][0-9]*$/.test(concurrency.value) || !Number.isSafeInteger(Number(concurrency.value))
  const report = () => draft.report({ dirty: props.node.type === 'foreach' ? concurrency.value !== String(props.node.concurrency ?? 1) : props.node.type === 'merge' && portText.value !== props.node.inputs.join(', '), invalid: props.node.type === 'foreach' ? invalidConcurrency() : props.node.type === 'merge' && invalid() })
  watch(() => [props.node.type === 'merge' ? props.node.inputs : props.node.type === 'foreach' ? props.node.concurrency : undefined, props.node.id, draft.discardEpoch] as const, () => { concurrency.value = props.node.type === 'foreach' ? String(props.node.concurrency ?? 1) : '1'; portText.value = props.node.type === 'merge' ? props.node.inputs.join(', ') : ''; report() })
  const commit = () => {
    if (props.node.type !== 'merge' || !props.canEdit || invalid()) return report()
    if (portText.value === props.node.inputs.join(', ')) return
    draft.report({ dirty: false, invalid: false })
    if (!props.onCommand?.({ type: 'GRAPH_SET_MERGE', graphId: props.graphId, nodeId: props.node.id, mode: props.node.mode, inputs: ports() })) report()
  }
  const commitConcurrency = () => {
    if (props.node.type !== 'foreach' || !props.canEdit || invalidConcurrency()) return report()
    draft.report({ dirty: false, invalid: false })
    if (!props.onCommand?.({ type: 'GRAPH_SET_FOREACH_CONCURRENCY', graphId: props.graphId, nodeId: props.node.id, concurrency: Number(concurrency.value) })) report()
  }
  return () => props.node.type === 'foreach' ? <FormSection title={t('workbench.graph.foreach')}>
    <ValueExpressionField {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})} nodeId={props.node.id} source={props.source} canEdit={props.canEdit}
      field={{ name: 'items', label: t('workbench.graph.items'), type: 'json', schemaType: 'array', required: true }} expression={props.node.items}
      {...(props.variableCatalog ? { variableCatalog: props.variableCatalog } : {})}
      onChange={expression => { if (expression) props.onCommand?.({ type: 'SET_CONTROL_EXPRESSION', nodeId: props.node.id, field: 'items', expression }) }} />
    <label>{t('workbench.graph.concurrency')}<Input aria-label={t('workbench.graph.concurrency')} value={concurrency.value} disabled={!props.canEdit} aria-invalid={invalidConcurrency()}
      onInput={event => { concurrency.value = (event.target as HTMLInputElement).value; report() }} onBlur={commitConcurrency}
      onKeydown={event => { if (event.key === 'Enter' && !event.isComposing) (event.target as HTMLElement).blur() }} /></label>
    {invalidConcurrency() ? <p class="inspector-field-error" role="alert">{t('workbench.graph.concurrencyInvalid')}</p> : null}
    <p class="activation-help">{t('workbench.graph.foreachHelp')}</p>
  </FormSection> : props.node.type === 'merge' ? <FormSection title={t('workbench.graph.merge')}>
    <label>{t('workbench.graph.mode')}<SelectMenu ariaLabel={t('workbench.graph.mode')} disabled={!props.canEdit} value={props.node.mode}
      options={['all', 'selected'].map(value => ({ value, label: t(`workbench.graph.merge.${value}`) }))}
      onChange={value => { if (props.node.type === 'merge') props.onCommand?.({ type: 'GRAPH_SET_MERGE', graphId: props.graphId, nodeId: props.node.id, mode: value as 'all' | 'selected', inputs: props.node.inputs }) }} /></label>
    <p class="activation-help">{t(props.node.mode === 'all' ? 'workbench.graph.allHelp' : 'workbench.graph.selectedHelp')}</p>
    <label>{t('workbench.graph.inputs')}<Input aria-label={t('workbench.graph.inputs')} aria-invalid={invalid()} value={portText.value} disabled={!props.canEdit}
      onInput={event => { portText.value = (event.target as HTMLInputElement).value; report() }} onBlur={commit}
      onKeydown={event => { if (event.key === 'Enter' && !event.isComposing) (event.target as HTMLElement).blur() }} /></label>
    <p class="activation-help">{t('workbench.graph.inputsHelp')}</p>
    {invalid() ? <p class="inspector-field-error" role="alert">{t('workbench.graph.inputsInvalid')}</p> : null}
  </FormSection> : <FormSection title={t(props.node.type === 'condition' ? 'workbench.graph.condition' : 'workbench.graph.output')}>
    <ValueExpressionField {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})} nodeId={props.node.id} source={props.source} canEdit={props.canEdit}
      field={props.node.type === 'condition'
        ? { name: 'condition', label: t('workbench.graph.condition'), type: 'boolean', schemaType: 'boolean', required: true }
        : { name: 'output', label: t('workbench.graph.output'), type: 'json', schemaType: 'any', required: false }}
      {...(props.node.type === 'condition' ? { expression: props.node.condition } : props.node.output ? { expression: props.node.output } : {})}
      {...(props.variableCatalog ? { variableCatalog: props.variableCatalog } : {})}
      onChange={expression => {
        if (props.node.type === 'condition' && expression) props.onCommand?.({ type: 'SET_CONTROL_EXPRESSION', nodeId: props.node.id, field: 'condition', expression })
        else if (props.node.type === 'graph') props.onCommand?.({ type: 'GRAPH_SET_OUTPUT', graphId: props.node.id, ...(expression ? { expression } : {}) })
      }} />
    <p class="activation-help">{t(props.node.type === 'condition' ? 'workbench.graph.conditionPorts' : 'workbench.graph.outputHelp')}</p>
  </FormSection>
})
