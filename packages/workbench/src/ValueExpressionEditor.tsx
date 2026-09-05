import {
  coreExpressionFunctions,
  getCoreExpressionFunction,
  type AutomationSource,
  type CompileDiagnostic,
  type CoreExpressionFunctionArgument,
  type CoreExpressionFunctionDefinition,
  type CoreExpressionValueType,
  type NumenValue,
  type ValueExpr,
} from '@numen/core'
import type { SchemaUIResolver } from '@numen/webui/schema-ui'
import { AlertCircle, Plus, Trash2 } from '@lucide/vue'
import { h, nextTick, ref, watch, watchEffect, type VNodeChild } from 'vue'
import {
  insertTemplateReference,
  magicVariableExpression,
  projectMagicVariables,
  targetValueTypes,
  type MagicVariableCandidate,
} from './automation-variable-catalog.js'
import type {
  WorkbenchAutomationInputField,
  WorkbenchAutomationVariableCatalog,
} from './contracts.js'
import { MagicVariablePicker } from './MagicVariablePicker.js'
import type { SchemaLiteralRenderer } from './SchemaRenderers.js'
import { defineSetupComponent } from './vue-component.js'

export type EditableValueMode = 'literal' | 'reference' | 'template' | 'expression'
export type ValueMode = EditableValueMode | 'preserved'

const referencePattern = /^(run|trigger|input|steps|vars|loop|error)(\.[a-zA-Z0-9_$-]+)+$/
const maximumEditableCallDepth = 8

export function valueExpressionMode(expression: ValueExpr | undefined): ValueMode {
  if (expression?.type === 'ref') return 'reference'
  if (expression?.type === 'template') return 'template'
  if (expression?.type === 'call') return 'expression'
  if (expression && expression.type !== 'literal') return 'preserved'
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
  if (plain.includes('{{') || plain.includes('}}')) {
    throw new TypeError('Template braces must contain one valid reference path.')
  }
  return { type: 'template', parts: parts.length ? parts : [''] }
}

export function printAutomationTemplate(expression: Extract<ValueExpr, { type: 'template' }>): string {
  return expression.parts.map(part => typeof part === 'string' ? part : `{{ ${part.ref} }}`).join('')
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

function compatibleFunctions(field: WorkbenchAutomationInputField): CoreExpressionFunctionDefinition[] {
  const targets = targetValueTypes(field)
  return coreExpressionFunctions
    .filter(definition => (
      definition.outputType === 'unknown'
      || targets.has(definition.outputType)
    ))
    .sort((left, right) => Number(left.outputType === 'unknown') - Number(right.outputType === 'unknown'))
}

function expressionTypeField(
  parent: WorkbenchAutomationInputField,
  definition: CoreExpressionFunctionDefinition,
  argument: CoreExpressionFunctionArgument,
  index: number,
): WorkbenchAutomationInputField {
  const label = definition.variadic && index >= definition.arguments.length
    ? `${argument.label} ${index + 1}`
    : argument.label
  if (definition.id === 'core:coalesce' && argument.valueType === 'unknown') {
    const { role: _role, ...parentField } = parent
    return { ...parentField, name: `${parent.name}-argument-${index}`, label, required: true }
  }
  const shared = { name: `${parent.name}-argument-${index}`, label, required: true }
  switch (argument.valueType) {
    case 'string': return { ...shared, type: 'string', schemaType: 'string', defaultValue: '' }
    case 'number': return { ...shared, type: 'number', schemaType: 'number', defaultValue: 0 }
    case 'boolean': return { ...shared, type: 'boolean', schemaType: 'boolean', defaultValue: false }
    case 'object': return { ...shared, type: 'json', schemaType: 'object', defaultValue: {} }
    case 'array': return { ...shared, type: 'json', schemaType: 'array', defaultValue: [] }
    case 'null': return { ...shared, type: 'json', schemaType: 'null', defaultValue: null }
    case 'unknown': return { ...shared, type: 'json', schemaType: 'any', defaultValue: null }
  }
}

function defaultCallArgument(
  parent: WorkbenchAutomationInputField,
  definition: CoreExpressionFunctionDefinition,
  argument: CoreExpressionFunctionArgument,
  index: number,
): ValueExpr {
  return { type: 'literal', value: defaultLiteral(expressionTypeField(parent, definition, argument, index)) ?? null }
}

function createCallExpression(
  field: WorkbenchAutomationInputField,
  definition: CoreExpressionFunctionDefinition,
): Extract<ValueExpr, { type: 'call' }> {
  return {
    type: 'call',
    function: definition.id,
    arguments: definition.arguments.map((argument, index) => defaultCallArgument(field, definition, argument, index)),
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
  if (mode === 'expression') {
    const definition = compatibleFunctions(field)[0]
    return definition ? createCallExpression(field, definition) : undefined
  }
  const value = defaultLiteral(field)
  return value === undefined ? undefined : { type: 'literal', value }
}

function fieldDescription(field: WorkbenchAutomationInputField, mode: ValueMode): string | undefined {
  if (mode === 'reference') return 'Use a stable path such as trigger.payload or steps.fetch.output.'
  if (mode === 'template') return 'Insert references with {{ trigger.value }}. Templates stay structured and never run JavaScript.'
  if (mode === 'expression') return 'Compose a pure, deterministic Call from the stable core function catalog.'
  if (mode === 'preserved') return 'This structured expression is preserved. Choose another mode to replace it.'
  return field.description
}

function inputProblemId(nodeId: string, fieldName: string): string {
  return `${nodeId}-input-${fieldName}-problem`
}

export interface ValueExpressionFieldProps {
  nodeId: string
  field: WorkbenchAutomationInputField
  expression?: ValueExpr
  problem?: CompileDiagnostic
  canEdit: boolean
  schemaUI?: SchemaUIResolver
  source?: AutomationSource
  variableCatalog?: WorkbenchAutomationVariableCatalog
  variables?: MagicVariableCandidate[]
  focusRequest?: number
  depth?: number
  onChange(expression?: ValueExpr): void
}

const ReferenceEditor = defineSetupComponent<ValueExpressionFieldProps>('ReferenceEditor', ['nodeId', 'field', 'expression', 'problem', 'canEdit', 'schemaUI', 'source', 'variableCatalog', 'variables', 'focusRequest', 'depth', 'onChange'], props => {
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
          autofocus={props.focusRequest !== undefined}
          value={value}
          disabled={!props.canEdit}
          id={`${props.nodeId}-input-${props.field.name}`}
          key={`${props.nodeId}:${props.field.name}:${value}:${props.focusRequest ?? 'idle'}`}
          onBlur={event => {
            const path = (event.target as HTMLInputElement).value.trim()
            if (!referencePattern.test(path)) {
              localError.value = 'Use a stable path such as trigger.payload or steps.fetch.output.'
              return
            }
            localError.value = undefined
            if (path !== value) props.onChange({ type: 'ref', path })
          }}
          onKeydown={event => { if (event.key === 'Enter') (event.target as HTMLElement).blur() }}
          placeholder="trigger.value"
          type="text"
        />
        <MagicVariablePicker
          candidates={props.variables ?? []}
          disabled={!props.canEdit}
          onSelect={item => props.onChange(magicVariableExpression(item))}
        />
      </div>
      {localError.value ? <p class="inspector-field-error" id={localProblemId} role="alert">{localError.value}</p> : null}
    </>
  }
})

const TemplateEditor = defineSetupComponent<ValueExpressionFieldProps>('TemplateEditor', ['nodeId', 'field', 'expression', 'problem', 'canEdit', 'schemaUI', 'source', 'variableCatalog', 'variables', 'focusRequest', 'depth', 'onChange'], props => {
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
          autofocus={props.focusRequest !== undefined}
          value={value}
          disabled={!props.canEdit}
          id={`${props.nodeId}-input-${props.field.name}`}
          key={`${props.nodeId}:${props.field.name}:${value}:${props.focusRequest ?? 'idle'}`}
          onSelect={rememberSelection}
          onKeyup={rememberSelection}
          onBlur={event => {
            try {
              const next = parseAutomationTemplate((event.target as HTMLInputElement).value)
              localError.value = undefined
              if (JSON.stringify(next) !== JSON.stringify(props.expression)) props.onChange(next)
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
              props.onChange(parseAutomationTemplate(next.value))
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

function CallExpressionEditor(props: Readonly<ValueExpressionFieldProps> & {
  expression: Extract<ValueExpr, { type: 'call' }>
  depth: number
}) {
  const definitions = compatibleFunctions(props.field)
  const definition = getCoreExpressionFunction(props.expression.function)
  const selectable = definition && !definitions.some(item => item.id === definition.id)
    ? [definition, ...definitions]
    : definitions
  if (props.depth >= maximumEditableCallDepth) {
    return <div class="inspector-schema-notice"><AlertCircle size={15} /><span>This nested Call is preserved beyond the visual editing depth.</span></div>
  }
  return (
    <div class="structured-call-editor">
      <label class="structured-call-function">
        <span>Function</span>
        <select
          aria-label={`${props.field.label} expression function`}
          disabled={!props.canEdit}
          onChange={event => {
            const next = getCoreExpressionFunction((event.target as HTMLInputElement).value)
            if (next) props.onChange(createCallExpression(props.field, next))
          }}
          value={props.expression.function}
        >
          {!definition ? <option value={props.expression.function}>Unavailable · {props.expression.function}</option> : null}
          {selectable.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      {definition ? <p>{definition.description}</p> : (
        <div class="inspector-schema-notice"><AlertCircle size={15} /><span>This function is unavailable. Its Source is preserved until you choose a core function.</span></div>
      )}
      {definition ? (
        <div class="structured-call-arguments">
          {Array.from({
            length: Math.max(props.expression.arguments.length, definition.arguments.length),
          }, (_unused, index) => {
            const argumentExpression = props.expression.arguments[index]
            const argument = definition.arguments[index] ?? definition.variadic
            if (!argument) {
              return <div class="structured-call-extra" key={index}>
                <code>Unexpected argument {index + 1}</code>
                <button
                  aria-label={`Remove unexpected argument ${index + 1}`}
                  disabled={!props.canEdit}
                  onClick={() => props.onChange({
                    ...props.expression,
                    arguments: props.expression.arguments.filter((_item, itemIndex) => itemIndex !== index),
                  })}
                  type="button"
                ><Trash2 aria-hidden="true" size={13} /></button>
              </div>
            }
            const argumentField = expressionTypeField(props.field, definition, argument, index)
            return <div class="structured-call-argument" key={index}>
              <ValueExpressionField
                canEdit={props.canEdit}
                depth={props.depth + 1}
                field={argumentField}
                nodeId={props.nodeId}
                onChange={next => {
                  const argumentsCopy = [...props.expression.arguments]
                  argumentsCopy[index] = next ?? defaultCallArgument(props.field, definition, argument, index)
                  props.onChange({ ...props.expression, arguments: argumentsCopy })
                }}
                {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
                {...(props.source ? { source: props.source } : {})}
                {...(props.variableCatalog ? { variableCatalog: props.variableCatalog } : {})}
                {...(argumentExpression ? { expression: argumentExpression } : {})}
              />
              {definition.variadic && index >= definition.arguments.length ? (
                <button
                  aria-label={`Remove ${argumentField.label}`}
                  class="structured-call-remove"
                  disabled={!props.canEdit}
                  onClick={() => props.onChange({
                    ...props.expression,
                    arguments: props.expression.arguments.filter((_item, itemIndex) => itemIndex !== index),
                  })}
                  type="button"
                ><Trash2 aria-hidden="true" size={13} /></button>
              ) : null}
            </div>
          })}
          {definition.variadic ? (
            <button
              class="structured-call-add"
              disabled={!props.canEdit}
              onClick={() => props.onChange({
                ...props.expression,
                arguments: [
                  ...props.expression.arguments,
                  defaultCallArgument(props.field, definition, definition.variadic!, props.expression.arguments.length),
                ],
              })}
              type="button"
            ><Plus aria-hidden="true" size={13} />Add argument</button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function renderValueExpressionField(props: Readonly<ValueExpressionFieldProps>): VNodeChild {
  const mode = valueExpressionMode(props.expression)
  const problemId = inputProblemId(props.nodeId, props.field.name)
  const inputId = `${props.nodeId}-input-${props.field.name}`
  const variables = props.variables ?? (props.source && props.variableCatalog
    ? projectMagicVariables({
        source: props.source,
        nodeId: props.nodeId,
        field: props.field,
        catalog: props.variableCatalog,
        mode: mode === 'template' ? 'template' : 'reference',
      })
    : [])
  const functions = compatibleFunctions(props.field)
  const LiteralRenderer = props.schemaUI?.resolveRenderer<SchemaLiteralRenderer>({
    ...(props.field.role ? { role: props.field.role } : {}),
    type: props.field.type,
  }, 'editor')
  let editor: VNodeChild
  if (mode === 'reference') editor = <ReferenceEditor {...props} variables={variables} />
  else if (mode === 'template') editor = <TemplateEditor {...props} variables={variables} />
  else if (mode === 'expression' && props.expression?.type === 'call') {
    editor = <CallExpressionEditor {...props} depth={props.depth ?? 0} expression={props.expression} />
  } else if (mode === 'preserved') {
    editor = <div class="inspector-schema-notice"><AlertCircle size={15} /><span>The current structured expression is preserved but has no visual editor.</span></div>
  } else if (LiteralRenderer) {
    editor = h(LiteralRenderer, {
      canEdit: props.canEdit,
      controlId: props.nodeId,
      ...(props.problem ? { describedBy: problemId } : {}),
      field: props.field,
      inputId,
      invalid: !!props.problem,
      ...(props.focusRequest !== undefined ? { autofocus: true, key: props.focusRequest } : {}),
      onCommit: (value?: NumenValue) => props.onChange(value === undefined ? undefined : { type: 'literal', value }),
      ...(props.expression?.type === 'literal' ? { value: props.expression.value } : {}),
    })
  } else {
    editor = <div class="inspector-schema-notice"><AlertCircle size={15} /><span>No Literal renderer is registered for {props.field.role ?? props.field.type}. The Source value is preserved.</span></div>
  }
  const description = fieldDescription(props.field, mode)
  return <FieldShell
    canEdit={props.canEdit}
    field={props.field}
    mode={mode}
    nodeId={props.nodeId}
    onModeChange={next => props.onChange(modeExpression(props.field, next, variables))}
    supportsExpression={functions.length > 0}
    {...(description ? { description } : {})}
    {...(mode === 'literal' ? { inputId } : {})}
    {...(props.problem ? { problem: props.problem } : {})}
  >{editor}</FieldShell>
}

interface FieldShellProps {
  field: WorkbenchAutomationInputField
  nodeId: string
  problem?: CompileDiagnostic
  description?: string
  inputId?: string
  mode: ValueMode
  canEdit: boolean
  supportsExpression: boolean
  onModeChange(mode: EditableValueMode): void
}

const FieldShell = defineSetupComponent<FieldShellProps>('FieldShell', ['field', 'nodeId', 'problem', 'description', 'inputId', 'mode', 'canEdit', 'supportsExpression', 'onModeChange'], (props, context) => () => {
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
            {props.supportsExpression || mode === 'expression' ? <option value="expression">Expression</option> : null}
            {mode === 'preserved' ? <option disabled value="preserved">Structured value</option> : null}
          </select>
          <span class="schema-value-control">{context.slots.default?.()}</span>
        </span>
      </div>
      {description ? <p class="inspector-field-help">{description}</p> : null}
      {problem ? <p class="inspector-field-error" id={problemId}>{problem.message}</p> : null}
    </div>
  )
})

export const ValueExpressionField = defineSetupComponent<ValueExpressionFieldProps>('ValueExpressionField', ['nodeId', 'field', 'expression', 'problem', 'canEdit', 'schemaUI', 'source', 'variableCatalog', 'variables', 'focusRequest', 'depth', 'onChange'], props => {
  const revision = useSchemaRevision(() => props.schemaUI)
  return () => {
    revision.value
    return renderValueExpressionField(props)
  }
})
