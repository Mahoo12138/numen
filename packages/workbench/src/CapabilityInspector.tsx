import { isNumenValue, type CapabilitySource, type CompileDiagnostic, type NumenValue, type ValueExpr } from '@numen/core'
import { AlertCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  WorkbenchAutomationConnectionOption,
  WorkbenchAutomationConnectionSlot,
  WorkbenchAutomationInputField,
  WorkbenchAutomationInsertItem,
} from './contracts.js'

type CapabilityCatalogItem = Extract<WorkbenchAutomationInsertItem, { kind: 'capability' }>

function expressionMode(expression: ValueExpr | undefined): string | undefined {
  if (!expression || expression.type === 'literal') return
  switch (expression.type) {
    case 'ref': return 'Reference'
    case 'template': return 'Template'
    case 'array':
    case 'object': return 'Structured expression'
    case 'call': return 'Expression'
  }
}

function fieldProblem(
  problems: CompileDiagnostic[],
  fieldName: string,
): CompileDiagnostic | undefined {
  return problems.find(problem => problem.source?.fieldPath === `input.${fieldName}`)
}

function fieldDescription(field: WorkbenchAutomationInputField, expression: ValueExpr | undefined): string | undefined {
  return expressionMode(expression)
    ? `${expressionMode(expression)} mode is active. Committing this field replaces it with a literal value.`
    : field.description
}

function inputProblemId(nodeId: string, fieldName: string): string {
  return `${nodeId}-input-${fieldName}-problem`
}

function StringField({ nodeId, field, expression, problem, canEdit, onChange }: InputFieldProps) {
  const value = expression?.type === 'literal' && typeof expression.value === 'string' ? expression.value : ''
  return (
    <FieldShell field={field} nodeId={nodeId} problem={problem} description={fieldDescription(field, expression)}>
      <input
        aria-describedby={problem ? inputProblemId(nodeId, field.name) : undefined}
        aria-invalid={!!problem}
        aria-label={field.label}
        defaultValue={value}
        disabled={!canEdit}
        key={`${nodeId}:${field.name}:${value}`}
        onBlur={event => {
          const next = event.currentTarget.value
          if (!next && !field.required) onChange?.(nodeId, field.name)
          else if (next !== value || expression?.type !== 'literal') onChange?.(nodeId, field.name, next)
        }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
        placeholder={field.required ? 'Required' : 'Optional'}
        type="text"
      />
    </FieldShell>
  )
}

function NumberField({ nodeId, field, expression, problem, canEdit, onChange }: InputFieldProps) {
  const value = expression?.type === 'literal' && typeof expression.value === 'number' ? expression.value : undefined
  return (
    <FieldShell field={field} nodeId={nodeId} problem={problem} description={fieldDescription(field, expression)}>
      <input
        aria-describedby={problem ? inputProblemId(nodeId, field.name) : undefined}
        aria-invalid={!!problem}
        aria-label={field.label}
        defaultValue={value ?? ''}
        disabled={!canEdit}
        key={`${nodeId}:${field.name}:${value ?? 'unset'}`}
        {...(field.min !== undefined ? { min: field.min } : {})}
        {...(field.max !== undefined ? { max: field.max } : {})}
        {...(field.step !== undefined ? { step: field.step } : {})}
        onBlur={event => {
          if (!event.currentTarget.value) {
            if (!field.required) onChange?.(nodeId, field.name)
            else event.currentTarget.value = value === undefined ? '' : String(value)
            return
          }
          const next = Number(event.currentTarget.value)
          if (!Number.isFinite(next)) {
            event.currentTarget.value = value === undefined ? '' : String(value)
            return
          }
          if (next !== value || expression?.type !== 'literal') onChange?.(nodeId, field.name, next)
        }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
        placeholder={field.required ? 'Required number' : 'Optional number'}
        type="number"
      />
    </FieldShell>
  )
}

function BooleanField({ nodeId, field, expression, problem, canEdit, onChange }: InputFieldProps) {
  const value = expression?.type === 'literal' && typeof expression.value === 'boolean'
    ? String(expression.value)
    : ''
  return (
    <FieldShell field={field} nodeId={nodeId} problem={problem} description={fieldDescription(field, expression)}>
      <select
        aria-describedby={problem ? inputProblemId(nodeId, field.name) : undefined}
        aria-invalid={!!problem}
        aria-label={field.label}
        disabled={!canEdit}
        onChange={event => {
          if (!event.currentTarget.value) onChange?.(nodeId, field.name)
          else onChange?.(nodeId, field.name, event.currentTarget.value === 'true')
        }}
        value={value}
      >
        {!field.required ? <option value="">Not set</option> : null}
        {field.required && !value ? <option disabled value="">Select…</option> : null}
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    </FieldShell>
  )
}

function EnumField({ nodeId, field, expression, problem, canEdit, onChange }: InputFieldProps) {
  const options = field.options ?? []
  const literalValue = expression?.type === 'literal' ? JSON.stringify(expression.value) : undefined
  const selectedIndex = options.findIndex(option => JSON.stringify(option.value) === literalValue)
  return (
    <FieldShell field={field} nodeId={nodeId} problem={problem} description={fieldDescription(field, expression)}>
      <select
        aria-describedby={problem ? inputProblemId(nodeId, field.name) : undefined}
        aria-invalid={!!problem}
        aria-label={field.label}
        disabled={!canEdit}
        onChange={event => {
          if (!event.currentTarget.value) onChange?.(nodeId, field.name)
          else onChange?.(nodeId, field.name, options[Number(event.currentTarget.value)]!.value)
        }}
        value={selectedIndex < 0 ? '' : String(selectedIndex)}
      >
        {!field.required || selectedIndex < 0 ? <option value="">{field.required ? 'Select…' : 'Not set'}</option> : null}
        {options.map((option, index) => <option key={`${index}:${option.label}`} value={index}>{option.label}</option>)}
      </select>
    </FieldShell>
  )
}

function JsonField({ nodeId, field, expression, problem, canEdit, onChange }: InputFieldProps) {
  const literal = expression?.type === 'literal' ? expression.value : undefined
  const value = literal === undefined ? '' : JSON.stringify(literal, null, 2)
  const [localError, setLocalError] = useState<string>()
  const effectiveProblem = localError
    ? { severity: 'error', code: 'INPUT_JSON_INVALID', message: localError } as CompileDiagnostic
    : problem
  useEffect(() => setLocalError(undefined), [value])
  return (
    <FieldShell field={field} nodeId={nodeId} problem={effectiveProblem} description={fieldDescription(field, expression)} wide>
      <textarea
        aria-describedby={effectiveProblem ? inputProblemId(nodeId, field.name) : undefined}
        aria-invalid={!!effectiveProblem}
        aria-label={`${field.label} JSON`}
        defaultValue={value}
        disabled={!canEdit}
        key={`${nodeId}:${field.name}:${value}`}
        onBlur={event => {
          const text = event.currentTarget.value.trim()
          if (!text && !field.required) {
            setLocalError(undefined)
            onChange?.(nodeId, field.name)
            return
          }
          try {
            const next: unknown = JSON.parse(text)
            if (!isNumenValue(next)) throw new TypeError('Value must be JSON-compatible Numen data.')
            setLocalError(undefined)
            if (JSON.stringify(next) !== JSON.stringify(literal) || expression?.type !== 'literal') {
              onChange?.(nodeId, field.name, next)
            }
          } catch (error) {
            setLocalError(error instanceof Error ? error.message : 'Enter valid JSON.')
          }
        }}
        placeholder={field.required ? 'Required JSON value' : 'Optional JSON value'}
        rows={4}
      />
    </FieldShell>
  )
}

interface InputFieldProps {
  nodeId: string
  field: WorkbenchAutomationInputField
  expression?: ValueExpr | undefined
  problem?: CompileDiagnostic | undefined
  canEdit: boolean
  onChange?(nodeId: string, fieldName: string, value?: NumenValue): void
}

function InputField(props: InputFieldProps) {
  switch (props.field.type) {
    case 'string': return <StringField {...props} />
    case 'number': return <NumberField {...props} />
    case 'boolean': return <BooleanField {...props} />
    case 'enum': return <EnumField {...props} />
    case 'json': return <JsonField {...props} />
  }
}

function FieldShell({ field, nodeId, problem, description, wide = false, children }: {
  field: WorkbenchAutomationInputField
  nodeId: string
  problem?: CompileDiagnostic | undefined
  description?: string | undefined
  wide?: boolean
  children: React.ReactNode
}) {
  const problemId = inputProblemId(nodeId, field.name)
  return (
    <div className="schema-field" data-invalid={!!problem} data-wide={wide}>
      <label>
        <span>{field.label}{field.required ? <em>Required</em> : null}{field.role ? <code>{field.role}</code> : null}</span>
        <span>{children}</span>
      </label>
      {description ? <p className="inspector-field-help">{description}</p> : null}
      {problem ? <p className="inspector-field-error" id={problemId}>{problem.message}</p> : null}
    </div>
  )
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
  return slots.map(slot => {
    const options = compatibleConnections(slot, connections)
    const selected = bindings[slot.name] ?? ''
    const missingSelection = selected && !options.some(option => option.id === selected)
    const problem = problems.find(item => item.source?.fieldPath === `connections.${slot.name}`)
    const problemId = `${nodeId}-connection-${slot.name}-problem`
    return (
      <div className="connection-binding-field" data-invalid={!!problem} key={slot.name}>
        <label>
          <span>{slot.name}{slot.required ? <em>Required</em> : null}</span>
          <select
            aria-describedby={problem ? problemId : undefined}
            aria-invalid={!!problem}
            aria-label={`${slot.name} connection`}
            disabled={!canEdit}
            onChange={event => onChange?.(nodeId, slot.name, event.currentTarget.value || undefined)}
            value={selected}
          >
            <option value="">{slot.required ? 'Select a Connection…' : 'No Connection'}</option>
            {missingSelection ? <option value={selected}>Missing · {selected}</option> : null}
            {options.map(connection => <option key={connection.id} value={connection.id}>{connectionLabel(connection)}</option>)}
          </select>
        </label>
        <p className="inspector-field-help">
          {options.length
            ? `Accepts ${slot.accepts.length ? slot.accepts.join(', ') : 'any Connection Adapter'}.`
            : `No compatible Connections configured${slot.accepts.length ? ` for ${slot.accepts.join(', ')}` : ''}.`}
        </p>
        {problem ? <p className="inspector-field-error" id={problemId}>{problem.message}</p> : null}
      </div>
    )
  })
}

export function CapabilityInputFields({ nodeId, definition, control, problems, canEdit, onChange }: {
  nodeId: string
  definition: CapabilityCatalogItem
  control: CapabilitySource
  problems: CompileDiagnostic[]
  canEdit: boolean
  onChange?(nodeId: string, fieldName: string, value?: NumenValue): void
}) {
  if (!definition.inputSchemaSupported) {
    return <div className="inspector-schema-notice"><AlertCircle size={15} /><span>This Capability does not expose an object input schema supported by the core Inspector.</span></div>
  }
  if (!definition.inputFields.length) return <p className="inspector-summary">This Capability has no configurable inputs.</p>
  return definition.inputFields.map(field => (
    <InputField
      canEdit={canEdit}
      expression={control.input[field.name]}
      field={field}
      key={field.name}
      nodeId={nodeId}
      {...(onChange ? { onChange } : {})}
      problem={fieldProblem(problems, field.name)}
    />
  ))
}
