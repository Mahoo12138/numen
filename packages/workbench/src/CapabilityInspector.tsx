import type { CapabilitySource, CompileDiagnostic, NumenValue, ValueExpr } from '@numen/core'
import type { SchemaUIResolver } from '@numen/webui/schema-ui'
import { AlertCircle } from 'lucide-react'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type {
  WorkbenchAutomationConnectionOption,
  WorkbenchAutomationConnectionSlot,
  WorkbenchAutomationInputField,
  WorkbenchAutomationInsertItem,
} from './contracts.js'
import type { SchemaLiteralRenderer } from './SchemaRenderers.js'

type CapabilityCatalogItem = Extract<WorkbenchAutomationInsertItem, { kind: 'capability' }>

type EditableValueMode = 'literal' | 'reference' | 'template'
type ValueMode = EditableValueMode | 'expression'

const referencePattern = /^(run|trigger|input|steps|vars|loop|error)(\.[a-zA-Z0-9_$-]+)+$/

function valueMode(expression: ValueExpr | undefined): ValueMode {
  if (expression?.type === 'ref') return 'reference'
  if (expression?.type === 'template') return 'template'
  if (expression && expression.type !== 'literal') return 'expression'
  return 'literal'
}

export function parseAutomationTemplate(value: string): Extract<ValueExpr, { type: 'template' }> {
  const parts: Array<string | { ref: string }> = []
  const pattern = /\{\{\s*([^{}]+?)\s*}}/g
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index
    const path = match[1]!.trim()
    const text = value.slice(cursor, index)
    if (text) parts.push(text)
    if (!referencePattern.test(path)) throw new TypeError(`Invalid reference path: ${path}`)
    parts.push({ ref: path })
    cursor = index + match[0].length
  }
  const tail = value.slice(cursor)
  if (tail) parts.push(tail)
  const plain = value.replace(pattern, '')
  if (plain.includes('{{') || plain.includes('}}')) throw new TypeError('Template braces must contain one valid reference path.')
  return { type: 'template', parts: parts.length ? parts : [''] }
}

export function printAutomationTemplate(expression: Extract<ValueExpr, { type: 'template' }>): string {
  return expression.parts.map(part => typeof part === 'string' ? part : `{{ ${part.ref} }}`).join('')
}

function fieldProblem(
  problems: CompileDiagnostic[],
  fieldName: string,
): CompileDiagnostic | undefined {
  return problems.find(problem => problem.source?.fieldPath === `input.${fieldName}`)
}

function fieldDescription(field: WorkbenchAutomationInputField, mode: ValueMode): string | undefined {
  if (mode === 'reference') return 'Use a stable path such as trigger.payload or steps.fetch.output.'
  if (mode === 'template') return 'Insert references with {{ trigger.value }}. Templates remain structured and never run JavaScript.'
  if (mode === 'expression') return 'This structured expression is preserved. Choose another mode to replace it.'
  return field.description
}

function inputProblemId(nodeId: string, fieldName: string): string {
  return `${nodeId}-input-${fieldName}-problem`
}

interface InputFieldProps {
  nodeId: string
  field: WorkbenchAutomationInputField
  expression?: ValueExpr | undefined
  problem?: CompileDiagnostic | undefined
  canEdit: boolean
  schemaUI?: SchemaUIResolver | undefined
  onChange?(nodeId: string, fieldName: string, expression?: ValueExpr): void
}

function useSchemaRevision(schemaUI: SchemaUIResolver | undefined): void {
  const subscribe = useCallback((listener: () => void) => schemaUI?.subscribe(listener) ?? (() => {}), [schemaUI])
  const getSnapshot = useCallback(() => schemaUI?.getSnapshot() ?? 0, [schemaUI])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function defaultLiteral(field: WorkbenchAutomationInputField): NumenValue | undefined {
  if (field.defaultValue !== undefined) return field.defaultValue
  if (!field.required) return
  switch (field.type) {
    case 'string': return ''
    case 'number': return field.min ?? 0
    case 'boolean': return false
    case 'enum': return field.options?.[0]?.value ?? ''
    case 'json':
      if (field.schemaType === 'object') return {}
      if (field.schemaType === 'array') return []
      return null
  }
}

function modeExpression(field: WorkbenchAutomationInputField, mode: EditableValueMode): ValueExpr | undefined {
  if (mode === 'reference') return { type: 'ref', path: 'trigger.value' }
  if (mode === 'template') return { type: 'template', parts: [''] }
  const value = defaultLiteral(field)
  return value === undefined ? undefined : { type: 'literal', value }
}

function ReferenceEditor({ nodeId, field, expression, problem, canEdit, onChange }: InputFieldProps) {
  const value = expression?.type === 'ref' ? expression.path : 'trigger.value'
  const [localError, setLocalError] = useState<string>()
  const problemId = inputProblemId(nodeId, field.name)
  const localProblemId = `${problemId}-reference`
  useEffect(() => setLocalError(undefined), [value])
  return <>
    <input
      aria-describedby={[problem ? problemId : undefined, localError ? localProblemId : undefined].filter(Boolean).join(' ') || undefined}
      aria-invalid={!!problem || !!localError}
      defaultValue={value}
      disabled={!canEdit}
      id={`${nodeId}-input-${field.name}`}
      key={`${nodeId}:${field.name}:${value}`}
      onBlur={event => {
        const path = event.currentTarget.value.trim()
        if (!referencePattern.test(path)) {
          setLocalError('Use a stable path such as trigger.payload or steps.fetch.output.')
          return
        }
        setLocalError(undefined)
        if (path !== value) onChange?.(nodeId, field.name, { type: 'ref', path })
      }}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
      placeholder="trigger.value"
      type="text"
    />
    {localError ? <p className="inspector-field-error" id={localProblemId} role="alert">{localError}</p> : null}
  </>
}

function TemplateEditor({ nodeId, field, expression, problem, canEdit, onChange }: InputFieldProps) {
  const value = expression?.type === 'template' ? printAutomationTemplate(expression) : ''
  const [localError, setLocalError] = useState<string>()
  const problemId = inputProblemId(nodeId, field.name)
  const localProblemId = `${problemId}-template`
  useEffect(() => setLocalError(undefined), [value])
  return <>
    <textarea
      aria-describedby={[problem ? problemId : undefined, localError ? localProblemId : undefined].filter(Boolean).join(' ') || undefined}
      aria-invalid={!!problem || !!localError}
      defaultValue={value}
      disabled={!canEdit}
      id={`${nodeId}-input-${field.name}`}
      key={`${nodeId}:${field.name}:${value}`}
      onBlur={event => {
        try {
          const next = parseAutomationTemplate(event.currentTarget.value)
          setLocalError(undefined)
          if (JSON.stringify(next) !== JSON.stringify(expression)) onChange?.(nodeId, field.name, next)
        } catch (error) {
          setLocalError(error instanceof Error ? error.message : 'Enter a valid template.')
        }
      }}
      placeholder="Hello {{ trigger.name }}"
      rows={3}
    />
    {localError ? <p className="inspector-field-error" id={localProblemId} role="alert">{localError}</p> : null}
  </>
}

function InputField(props: InputFieldProps) {
  const mode = valueMode(props.expression)
  const problemId = inputProblemId(props.nodeId, props.field.name)
  const inputId = `${props.nodeId}-input-${props.field.name}`
  const LiteralRenderer = props.schemaUI?.resolveRenderer<SchemaLiteralRenderer>({
    ...(props.field.role ? { role: props.field.role } : {}),
    type: props.field.type,
  }, 'editor')
  let editor: React.ReactNode
  if (mode === 'reference') editor = <ReferenceEditor {...props} />
  else if (mode === 'template') editor = <TemplateEditor {...props} />
  else if (mode === 'expression') {
    editor = <div className="inspector-schema-notice"><AlertCircle size={15} /><span>The current structured expression is preserved but has no visual editor.</span></div>
  } else if (LiteralRenderer) {
    editor = <LiteralRenderer
      canEdit={props.canEdit}
      controlId={props.nodeId}
      {...(props.problem ? { describedBy: problemId } : {})}
      field={props.field}
      inputId={inputId}
      invalid={!!props.problem}
      onCommit={value => props.onChange?.(
        props.nodeId,
        props.field.name,
        value === undefined ? undefined : { type: 'literal', value },
      )}
      {...(props.expression?.type === 'literal' ? { value: props.expression.value } : {})}
    />
  } else {
    editor = <div className="inspector-schema-notice"><AlertCircle size={15} /><span>No Literal renderer is registered for {props.field.role ?? props.field.type}. The Source value is preserved.</span></div>
  }
  return <FieldShell
    canEdit={props.canEdit}
    description={fieldDescription(props.field, mode)}
    field={props.field}
    inputId={mode === 'expression' ? undefined : inputId}
    mode={mode}
    nodeId={props.nodeId}
    onModeChange={next => props.onChange?.(props.nodeId, props.field.name, modeExpression(props.field, next))}
    problem={props.problem}
  >{editor}</FieldShell>
}

function FieldShell({ field, nodeId, problem, description, inputId, mode, canEdit, onModeChange, children }: {
  field: WorkbenchAutomationInputField
  nodeId: string
  problem?: CompileDiagnostic | undefined
  description?: string | undefined
  inputId?: string | undefined
  mode: ValueMode
  canEdit: boolean
  onModeChange(mode: EditableValueMode): void
  children: React.ReactNode
}) {
  const problemId = inputProblemId(nodeId, field.name)
  return (
    <div className="schema-field" data-invalid={!!problem}>
      <div className="schema-field-row">
        <span className="schema-field-label">
          <label {...(inputId ? { htmlFor: inputId } : {})}>{field.label}</label>
          {field.required ? <em>Required</em> : null}
          {field.role ? <code>{field.role}</code> : null}
        </span>
        <span className="schema-value-editor">
          <select
            aria-label={`${field.label} value mode`}
            className="schema-value-mode"
            disabled={!canEdit}
            onChange={event => onModeChange(event.currentTarget.value as EditableValueMode)}
            value={mode}
          >
            <option value="literal">Literal</option>
            <option value="reference">Reference</option>
            {field.type === 'string' ? <option value="template">Template</option> : null}
            {mode === 'expression' ? <option disabled value="expression">Expression</option> : null}
          </select>
          <span className="schema-value-control">{children}</span>
        </span>
      </div>
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

export function CapabilityInputFields({ nodeId, definition, control, problems, canEdit, schemaUI, onChange }: {
  nodeId: string
  definition: CapabilityCatalogItem
  control: CapabilitySource
  problems: CompileDiagnostic[]
  canEdit: boolean
  schemaUI?: SchemaUIResolver
  onChange?(nodeId: string, fieldName: string, expression?: ValueExpr): void
}) {
  useSchemaRevision(schemaUI)
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
      {...(schemaUI ? { schemaUI } : {})}
    />
  ))
}
