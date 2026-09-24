import { SelectMenu } from '@numenjs/components'
import { diagnosticText, t } from './i18n.js'
import type { AutomationSource, CapabilitySource, CompileDiagnostic, NumenValue, TriggerSource, ValueExpr } from '@numenjs/core'
import type { SchemaUIResolver } from '@numenjs/webui/schema-ui'
import { AlertCircle } from '@lucide/vue'
import type {
  WorkbenchAutomationConnectionOption,
  WorkbenchAutomationConnectionSlot,
  WorkbenchAutomationInsertItem,
  WorkbenchAutomationVariableCatalog,
} from './contracts.js'
import {
  ValueExpressionField,
  parseAutomationTemplate,
  printAutomationTemplate,
} from './ValueExpressionEditor.js'
import { h } from 'vue'
import type { SchemaLiteralRenderer } from './SchemaRenderers.js'
import { defineSetupComponent } from './vue-component.js'

export { parseAutomationTemplate, printAutomationTemplate }

type CapabilityCatalogItem = Extract<WorkbenchAutomationInsertItem, { kind: 'capability' }>

function fieldProblem(
  problems: CompileDiagnostic[],
  fieldName: string,
): CompileDiagnostic | undefined {
  const fieldPath = `input.${fieldName}`
  return problems.find(problem => (
    problem.source?.fieldPath === fieldPath
    || problem.source?.fieldPath?.startsWith(`${fieldPath}.`)
  ))
}

function compatibleConnections(
  slot: WorkbenchAutomationConnectionSlot,
  connections: WorkbenchAutomationConnectionOption[],
): WorkbenchAutomationConnectionOption[] {
  if (!slot.accepts.length) return connections
  return connections.filter(connection => (
    slot.accepts.includes(connection.typeId)
    || slot.accepts.includes(`${connection.typeId}@${connection.typeVersion}`)
  ))
}

function connectionLabel(connection: WorkbenchAutomationConnectionOption): string {
  const state = connection.status === 'READY' ? '' : ` · ${connection.status.toLowerCase()}`
  return `${connection.name}${state}`
}

export function CapabilityConnectionFields({
  nodeId,
  slots,
  connections,
  bindings,
  problems,
  canEdit,
  onChange,
}: {
  nodeId: string
  slots: WorkbenchAutomationConnectionSlot[]
  connections: WorkbenchAutomationConnectionOption[]
  bindings: Record<string, string>
  problems: CompileDiagnostic[]
  canEdit: boolean
  onChange?(nodeId: string, slotName: string, connectionId?: string): void
}) {
  return <>{slots.map(slot => {
    const options = compatibleConnections(slot, connections)
    const selected = bindings[slot.name] ?? ''
    const missingSelection = selected && !options.some(option => option.id === selected)
    const problem = problems.find(item => item.source?.fieldPath === `connections.${slot.name}`)
    const problemId = `${nodeId}-connection-${slot.name}-problem`
    return (
      <div class="connection-binding-field" data-invalid={!!problem} key={slot.name}>
        <label>
          <span>{slot.name}{slot.required ? <em>{t('workbench.required')}</em> : null}</span>
          <SelectMenu aria-describedby={problem ? problemId : undefined} aria-invalid={!!problem}
            ariaLabel={t('workbench.value0Connection', { value0: slot.name })} disabled={!canEdit}
            onChange={value => onChange?.(nodeId, slot.name, value || undefined)} value={selected} options={[
              { value: '', label: slot.required ? t('workbench.selectAConnection') : t('workbench.noConnection') },
              ...(missingSelection ? [{ value: selected, label: t('workbench.missing') + selected, disabled: true }] : []),
              ...options.map(connection => ({ value: connection.id, label: connectionLabel(connection) })),
            ]} />
        </label>
        <p class="inspector-field-help">
          {options.length
            ? t('workbench.acceptsValue0', { value0: slot.accepts.length ? slot.accepts.join(', ') : 'any Connection Type' })
            : t('workbench.noCompatibleConnectionsConfiguredValue0', { value0: slot.accepts.length ? ` for ${slot.accepts.join(', ')}` : '' })}
        </p>
        {problem ? <p class="inspector-field-error" id={problemId}>{diagnosticText(problem)}</p> : null}
      </div>
    )
  })}</>
}

interface CapabilityInputFieldsProps {
  nodeId: string
  definition: Pick<CapabilityCatalogItem, 'inputFields' | 'inputSchemaSupported'>
  control: Pick<CapabilitySource, 'input'>
  problems: CompileDiagnostic[]
  canEdit: boolean
  source?: AutomationSource
  variableCatalog?: WorkbenchAutomationVariableCatalog
  schemaUI?: SchemaUIResolver
  focusFieldPath?: string
  focusRequest?: number
  onChange?(nodeId: string, fieldName: string, expression?: ValueExpr): void
}

export const CapabilityInputFields = defineSetupComponent<CapabilityInputFieldsProps>('CapabilityInputFields', ['nodeId', 'definition', 'control', 'problems', 'canEdit', 'source', 'variableCatalog', 'schemaUI', 'focusFieldPath', 'focusRequest', 'onChange'], props => () => {
  if (!props.definition.inputSchemaSupported) {
    return <div class="inspector-schema-notice"><AlertCircle size={15} /><span>{t('workbench.thisStepDoesNotExposeAnObjectInputSchemaSupportedByTheCoreInspector')}</span></div>
  }
  if (!props.definition.inputFields.length) return <p class="inspector-summary">{t('workbench.thisStepHasNoConfigurableInputs')}</p>
  return props.definition.inputFields.map(field => {
    const expression = props.control.input[field.name]
    const problem = fieldProblem(props.problems, field.name)
    return <ValueExpressionField
      canEdit={props.canEdit}
      field={field}
      key={field.name}
      nodeId={props.nodeId}
      onChange={expression => props.onChange?.(props.nodeId, field.name, expression)}
      {...(expression ? { expression } : {})}
      {...(problem ? { problem } : {})}
      {...(props.focusFieldPath === `input.${field.name}` && props.focusRequest !== undefined
        ? { focusRequest: props.focusRequest }
        : {})}
      {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
      {...(props.source ? { source: props.source } : {})}
      {...(props.variableCatalog ? { variableCatalog: props.variableCatalog } : {})}
    />
  })
})

type TriggerCatalogItem = Extract<WorkbenchAutomationInsertItem, { kind: 'trigger' }>

export function TriggerConfigurationFields({
  nodeId,
  definition,
  trigger,
  problems,
  canEdit,
  schemaUI,
  onChange,
}: {
  nodeId: string
  definition: Pick<TriggerCatalogItem, 'inputFields' | 'inputSchemaSupported'>
  trigger: Pick<TriggerSource, 'config'>
  problems: CompileDiagnostic[]
  canEdit: boolean
  schemaUI?: SchemaUIResolver
  onChange?(nodeId: string, fieldName: string, value?: NumenValue): void
}) {
  if (!definition.inputSchemaSupported) {
    return <div class="inspector-schema-notice"><AlertCircle size={15} /><span>{t('workbench.thisTriggerDoesNotExposeAnObjectConfigurationSchemaSupportedByTheCoreInspector')}</span></div>
  }
  if (!definition.inputFields.length) return <p class="inspector-summary">{t('workbench.thisTriggerHasNoConfigurableFields')}</p>
  return <>{definition.inputFields.map((field, index) => {
    const problem = problems.find(item => item.source?.fieldPath === `config.${field.name}`)
      ?? (index === 0 ? problems.find(item => item.source?.fieldPath === 'config') : undefined)
    const problemId = `${nodeId}-config-${field.name}-problem`
    const inputId = `${nodeId}-config-${field.name}`
    const Renderer = schemaUI?.resolveRenderer<SchemaLiteralRenderer>({
      ...(field.role ? { role: field.role } : {}),
      type: field.type,
    }, 'editor')
    return <div class="schema-field" data-invalid={!!problem} key={field.name}>
      <div class="schema-field-row">
        <span class="schema-field-label">
          <label for={inputId}>{field.label}</label>
          {field.required ? <em>{t('workbench.required')}</em> : null}
        </span>
        <span class="schema-value-editor trigger-config-editor">
          <span class="schema-value-control">{Renderer ? h(Renderer, {
            canEdit,
            controlId: nodeId,
            ...(problem ? { describedBy: problemId } : {}),
            field,
            inputId,
            invalid: !!problem,
            onCommit: (value?: NumenValue) => onChange?.(nodeId, field.name, value),
            ...(trigger.config[field.name] !== undefined ? { value: trigger.config[field.name] } : {}),
          }) : <div class="inspector-schema-notice"><AlertCircle size={15} /><span>{t('workbench.noEditorIsRegisteredFor')}{field.role ?? field.type}.</span></div>}</span>
        </span>
      </div>
      {field.description ? <p class="inspector-field-help">{field.description}</p> : null}
      {problem ? <p class="inspector-field-error" id={problemId}>{diagnosticText(problem)}</p> : null}
    </div>
  })}</>
}
