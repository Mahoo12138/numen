import type { AutomationSource, CapabilitySource, CompileDiagnostic, NumenValue, ValueExpr } from '@numen/core'
import type { SchemaUIResolver } from '@numen/webui/schema-ui'
import { AlertCircle } from '@lucide/vue'
import { h, nextTick, ref, watch, watchEffect, type VNodeChild } from 'vue'
import {
  insertTemplateReference,
  magicVariableExpression,
  projectMagicVariables,
  type MagicVariableCandidate,
} from './automation-variable-catalog.js'
import type {
  WorkbenchAutomationConnectionOption,
  WorkbenchAutomationConnectionSlot,
  WorkbenchAutomationInputField,
  WorkbenchAutomationInsertItem,
  WorkbenchAutomationVariableCatalog,
} from './contracts.js'
import { MagicVariablePicker } from './MagicVariablePicker.js'
import type { SchemaLiteralRenderer } from './SchemaRenderers.js'
import { defineSetupComponent } from './vue-component.js'

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
  variables?: MagicVariableCandidate[] | undefined
  onChange?(nodeId: string, fieldName: string, expression?: ValueExpr): void
}

function useSchemaRevision(schemaUI: () => SchemaUIResolver | undefined) {
  const revision = ref(schemaUI()?.getSnapshot() ?? 0)
  watchEffect((onCleanup) => {
    const resolver = schemaUI()
    revision.value = resolver?.getSnapshot() ?? 0
    if (resolver) onCleanup(resolver.subscribe(() => { revision.value = resolver.getSnapshot() }))
  })
  return revision
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

function modeExpression(
  field: WorkbenchAutomationInputField,
  mode: EditableValueMode,
  variables: MagicVariableCandidate[] = [],
): ValueExpr | undefined {
  if (mode === 'reference') {
    const firstDirect = variables.find(variable => variable.compatibility === 'direct')
    return firstDirect ? magicVariableExpression(firstDirect) : { type: 'ref', path: 'trigger.value' }
  }
  if (mode === 'template') return { type: 'template', parts: [''] }
  const value = defaultLiteral(field)
  return value === undefined ? undefined : { type: 'literal', value }
}

const ReferenceEditor = defineSetupComponent<InputFieldProps>('ReferenceEditor', ['nodeId', 'field', 'expression', 'problem', 'canEdit', 'schemaUI', 'variables', 'onChange'], props => {
  const localError = ref<string>()
  const problemId = inputProblemId(props.nodeId, props.field.name)
  const localProblemId = `${problemId}-reference`
  watch(() => props.expression, () => { localError.value = undefined })
  return () => {
    const value = props.expression?.type === 'ref' ? props.expression.path : 'trigger.value'
    return <>
    <div class="magic-variable-editor">
      <input
      aria-describedby={[props.problem ? problemId : undefined, localError.value ? localProblemId : undefined].filter(Boolean).join(' ') || undefined}
      aria-invalid={!!props.problem || !!localError.value}
      value={value}
      disabled={!props.canEdit}
      id={`${props.nodeId}-input-${props.field.name}`}
      key={`${props.nodeId}:${props.field.name}:${value}`}
      onBlur={event => {
        const path = (event.target as HTMLInputElement).value.trim()
        if (!referencePattern.test(path)) {
          localError.value = 'Use a stable path such as trigger.payload or steps.fetch.output.'
          return
        }
        localError.value = undefined
        if (path !== value) props.onChange?.(props.nodeId, props.field.name, { type: 'ref', path })
      }}
      onKeydown={event => { if (event.key === 'Enter') (event.target as HTMLElement).blur() }}
      placeholder="trigger.value"
      type="text"
      />
      <MagicVariablePicker
        candidates={props.variables ?? []}
        disabled={!props.canEdit}
        onSelect={item => props.onChange?.(props.nodeId, props.field.name, magicVariableExpression(item))}
      />
    </div>
    {localError.value ? <p class="inspector-field-error" id={localProblemId} role="alert">{localError.value}</p> : null}
  </>
  }
})

const TemplateEditor = defineSetupComponent<InputFieldProps>('TemplateEditor', ['nodeId', 'field', 'expression', 'problem', 'canEdit', 'schemaUI', 'variables', 'onChange'], props => {
  const localError = ref<string>()
  const textareaRef = ref<HTMLTextAreaElement>()
  const selectionStart = ref(0)
  const selectionEnd = ref(0)
  const problemId = inputProblemId(props.nodeId, props.field.name)
  const localProblemId = `${problemId}-template`
  watch(() => props.expression, () => { localError.value = undefined })
  return () => {
    const value = props.expression?.type === 'template' ? printAutomationTemplate(props.expression) : ''
    const rememberSelection = () => {
      selectionStart.value = textareaRef.value?.selectionStart ?? value.length
      selectionEnd.value = textareaRef.value?.selectionEnd ?? selectionStart.value
    }
    return <>
    <div class="magic-variable-editor magic-variable-template-editor">
      <textarea
      aria-describedby={[props.problem ? problemId : undefined, localError.value ? localProblemId : undefined].filter(Boolean).join(' ') || undefined}
      aria-invalid={!!props.problem || !!localError.value}
      value={value}
      disabled={!props.canEdit}
      id={`${props.nodeId}-input-${props.field.name}`}
      key={`${props.nodeId}:${props.field.name}:${value}`}
      onSelect={rememberSelection}
      onKeyup={rememberSelection}
      onBlur={event => {
        try {
          const next = parseAutomationTemplate((event.target as HTMLInputElement).value)
          localError.value = undefined
          if (JSON.stringify(next) !== JSON.stringify(props.expression)) props.onChange?.(props.nodeId, props.field.name, next)
        } catch (error) {
          localError.value = error instanceof Error ? error.message : 'Enter a valid template.'
        }
      }}
      placeholder="Hello {{ trigger.name }}"
      ref={textareaRef}
      rows={3}
      />
      <MagicVariablePicker
        candidates={props.variables ?? []}
        disabled={!props.canEdit}
        onSelect={item => {
          const current = textareaRef.value?.value ?? value
          const next = insertTemplateReference(current, item.path, selectionStart.value, selectionEnd.value)
          try {
            props.onChange?.(props.nodeId, props.field.name, parseAutomationTemplate(next.value))
            localError.value = undefined
            void nextTick(() => {
              textareaRef.value?.focus()
              textareaRef.value?.setSelectionRange(next.cursor, next.cursor)
            })
          } catch (error) {
            localError.value = error instanceof Error ? error.message : 'Enter a valid template.'
          }
        }}
      />
    </div>
    {localError.value ? <p class="inspector-field-error" id={localProblemId} role="alert">{localError.value}</p> : null}
  </>
  }
})

function renderInputField(props: Readonly<InputFieldProps>) {
  const mode = valueMode(props.expression)
  const problemId = inputProblemId(props.nodeId, props.field.name)
  const inputId = `${props.nodeId}-input-${props.field.name}`
  const LiteralRenderer = props.schemaUI?.resolveRenderer<SchemaLiteralRenderer>({
    ...(props.field.role ? { role: props.field.role } : {}),
    type: props.field.type,
  }, 'editor')
  let editor: VNodeChild
  if (mode === 'reference') editor = <ReferenceEditor {...props} />
  else if (mode === 'template') editor = <TemplateEditor {...props} />
  else if (mode === 'expression') {
    const conversionPath = props.expression?.type === 'call'
      && props.expression.function === 'core:to-string'
      && props.expression.arguments.length === 1
      && props.expression.arguments[0]?.type === 'ref'
      ? props.expression.arguments[0].path
      : undefined
    editor = conversionPath
      ? <div class="inspector-expression-summary"><span>Convert to text</span><code>{conversionPath}</code></div>
      : <div class="inspector-schema-notice"><AlertCircle size={15} /><span>The current structured expression is preserved but has no visual editor.</span></div>
  } else if (LiteralRenderer) {
    editor = h(LiteralRenderer, {
      canEdit: props.canEdit,
      controlId: props.nodeId,
      ...(props.problem ? { describedBy: problemId } : {}),
      field: props.field,
      inputId,
      invalid: !!props.problem,
      onCommit: (value?: NumenValue) => props.onChange?.(
        props.nodeId,
        props.field.name,
        value === undefined ? undefined : { type: 'literal', value },
      ),
      ...(props.expression?.type === 'literal' ? { value: props.expression.value } : {}),
    })
  } else {
    editor = <div class="inspector-schema-notice"><AlertCircle size={15} /><span>No Literal renderer is registered for {props.field.role ?? props.field.type}. The Source value is preserved.</span></div>
  }
  return <FieldShell
    canEdit={props.canEdit}
    description={fieldDescription(props.field, mode)}
    field={props.field}
    inputId={mode === 'expression' ? undefined : inputId}
    mode={mode}
    nodeId={props.nodeId}
    onModeChange={next => props.onChange?.(props.nodeId, props.field.name, modeExpression(props.field, next, props.variables))}
    problem={props.problem}
  >{editor}</FieldShell>
}

interface FieldShellProps {
  field: WorkbenchAutomationInputField
  nodeId: string
  problem?: CompileDiagnostic | undefined
  description?: string | undefined
  inputId?: string | undefined
  mode: ValueMode
  canEdit: boolean
  onModeChange(mode: EditableValueMode): void
}

const FieldShell = defineSetupComponent<FieldShellProps>('FieldShell', ['field', 'nodeId', 'problem', 'description', 'inputId', 'mode', 'canEdit', 'onModeChange'], (props, context) => () => {
  const { field, nodeId, problem, description, inputId, mode, canEdit, onModeChange } = props
  const problemId = inputProblemId(nodeId, field.name)
  return (
    <div class="schema-field" data-invalid={!!problem}>
      <div class="schema-field-row">
        <span class="schema-field-label">
          <label {...(inputId ? { for: inputId } : {})}>{field.label}</label>
          {field.required ? <em>Required</em> : null}
          {field.role ? <code>{field.role}</code> : null}
        </span>
        <span class="schema-value-editor">
          <select
            aria-label={`${field.label} value mode`}
            class="schema-value-mode"
            disabled={!canEdit}
            onChange={event => onModeChange((event.target as HTMLInputElement).value as EditableValueMode)}
            value={mode}
          >
            <option value="literal">Literal</option>
            <option value="reference">Reference</option>
            {field.type === 'string' ? <option value="template">Template</option> : null}
            {mode === 'expression' ? <option disabled value="expression">Expression</option> : null}
          </select>
          <span class="schema-value-control">{context.slots.default?.()}</span>
        </span>
      </div>
      {description ? <p class="inspector-field-help">{description}</p> : null}
      {problem ? <p class="inspector-field-error" id={problemId}>{problem.message}</p> : null}
    </div>
  )
})

const InputField = defineSetupComponent<InputFieldProps>('InputField', ['nodeId', 'field', 'expression', 'problem', 'canEdit', 'schemaUI', 'variables', 'onChange'], props => () => renderInputField(props))

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
  definition: CapabilityCatalogItem
  control: CapabilitySource
  problems: CompileDiagnostic[]
  canEdit: boolean
  source?: AutomationSource
  variableCatalog?: WorkbenchAutomationVariableCatalog
  schemaUI?: SchemaUIResolver
  onChange?(nodeId: string, fieldName: string, expression?: ValueExpr): void
}

export const CapabilityInputFields = defineSetupComponent<CapabilityInputFieldsProps>('CapabilityInputFields', ['nodeId', 'definition', 'control', 'problems', 'canEdit', 'source', 'variableCatalog', 'schemaUI', 'onChange'], props => {
  const revision = useSchemaRevision(() => props.schemaUI)
  return () => {
  revision.value
  if (!props.definition.inputSchemaSupported) {
    return <div class="inspector-schema-notice"><AlertCircle size={15} /><span>This Capability does not expose an object input schema supported by the core Inspector.</span></div>
  }
  if (!props.definition.inputFields.length) return <p class="inspector-summary">This Capability has no configurable inputs.</p>
  return props.definition.inputFields.map(field => {
    const mode = valueMode(props.control.input[field.name])
    const variables = props.source && props.variableCatalog
      ? projectMagicVariables({
          source: props.source,
          nodeId: props.nodeId,
          field,
          catalog: props.variableCatalog,
          mode: mode === 'template' ? 'template' : 'reference',
        })
      : undefined
    return <InputField
      canEdit={props.canEdit}
      expression={props.control.input[field.name]}
      field={field}
      key={field.name}
      nodeId={props.nodeId}
      {...(props.onChange ? { onChange: props.onChange } : {})}
      problem={fieldProblem(props.problems, field.name)}
      {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
      {...(variables ? { variables } : {})}
    />
  })
  }
})
