import type { AutomationSource, CapabilitySource, CompileDiagnostic, ValueExpr } from '@numen/core'
import type { SchemaUIResolver } from '@numen/webui/schema-ui'
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
    slot.accepts.includes(connection.adapterId)
    || slot.accepts.includes(`${connection.adapterId}@${connection.adapterVersion}`)
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
          <span>{slot.name}{slot.required ? <em>Required</em> : null}</span>
          <select
            aria-describedby={problem ? problemId : undefined}
            aria-invalid={!!problem}
            aria-label={`${slot.name} connection`}
            disabled={!canEdit}
            onChange={event => onChange?.(nodeId, slot.name, (event.target as HTMLInputElement).value || undefined)}
            value={selected}
          >
            <option value="">{slot.required ? 'Select a Connection…' : 'No Connection'}</option>
            {missingSelection ? <option value={selected}>Missing · {selected}</option> : null}
            {options.map(connection => <option key={connection.id} value={connection.id}>{connectionLabel(connection)}</option>)}
          </select>
        </label>
        <p class="inspector-field-help">
          {options.length
            ? `Accepts ${slot.accepts.length ? slot.accepts.join(', ') : 'any Connection Adapter'}.`
            : `No compatible Connections configured${slot.accepts.length ? ` for ${slot.accepts.join(', ')}` : ''}.`}
        </p>
        {problem ? <p class="inspector-field-error" id={problemId}>{problem.message}</p> : null}
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
    return <div class="inspector-schema-notice"><AlertCircle size={15} /><span>This step does not expose an object input schema supported by the core Inspector.</span></div>
  }
  if (!props.definition.inputFields.length) return <p class="inspector-summary">This step has no configurable inputs.</p>
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
