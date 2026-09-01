import { isNumenValue, type NumenValue } from '@numen/core'
import type { SchemaRendererDefinition } from '@numen/webui/schema-ui'
import type { Context } from 'cordis'
import { ref, watch, type Component } from 'vue'
import type { WorkbenchSchemaField } from './contracts.js'
import { defineSetupComponent } from './vue-component.js'

export interface SchemaLiteralRendererProps {
  canEdit: boolean
  autofocus?: boolean
  controlId: string
  describedBy?: string
  field: WorkbenchSchemaField
  inputId: string
  invalid: boolean
  value?: NumenValue
  onCommit(value?: NumenValue): void
}

export type SchemaLiteralRenderer = Component<SchemaLiteralRendererProps>

function inputAccessibility(props: SchemaLiteralRendererProps) {
  return {
    'aria-describedby': props.describedBy,
    'aria-invalid': props.invalid,
    autofocus: props.autofocus,
    id: props.inputId,
  }
}

function StringLiteralEditor(props: SchemaLiteralRendererProps) {
  const value = typeof props.value === 'string' ? props.value : ''
  return <input
    {...inputAccessibility(props)}
    value={value}
    disabled={!props.canEdit}
    key={`${props.controlId}:${props.field.name}:${value}`}
    onBlur={event => {
      const next = (event.target as HTMLInputElement).value
      if (!next && !props.field.required) props.onCommit()
      else if (next !== value) props.onCommit(next)
    }}
    onKeydown={event => { if (event.key === 'Enter') (event.target as HTMLElement).blur() }}
    placeholder={props.field.required ? 'Required' : 'Optional'}
    type="text"
  />
}

function NumberLiteralEditor(props: SchemaLiteralRendererProps) {
  const value = typeof props.value === 'number' ? props.value : undefined
  return <input
    {...inputAccessibility(props)}
    value={value ?? ''}
    disabled={!props.canEdit}
    key={`${props.controlId}:${props.field.name}:${value ?? 'unset'}`}
    {...(props.field.min !== undefined ? { min: props.field.min } : {})}
    {...(props.field.max !== undefined ? { max: props.field.max } : {})}
    {...(props.field.step !== undefined ? { step: props.field.step } : {})}
    onBlur={event => {
      if (!(event.target as HTMLInputElement).value) {
        if (!props.field.required) props.onCommit()
        else (event.target as HTMLInputElement).value = value === undefined ? '' : String(value)
        return
      }
      const next = Number((event.target as HTMLInputElement).value)
      if (!Number.isFinite(next)) {
        (event.target as HTMLInputElement).value = value === undefined ? '' : String(value)
        return
      }
      if (next !== value) props.onCommit(next)
    }}
    onKeydown={event => { if (event.key === 'Enter') (event.target as HTMLElement).blur() }}
    placeholder={props.field.required ? 'Required number' : 'Optional number'}
    type="number"
  />
}

function BooleanLiteralEditor(props: SchemaLiteralRendererProps) {
  const value = typeof props.value === 'boolean' ? String(props.value) : ''
  return <select
    {...inputAccessibility(props)}
    disabled={!props.canEdit}
    onChange={event => {
      if (!(event.target as HTMLInputElement).value) props.onCommit()
      else props.onCommit((event.target as HTMLInputElement).value === 'true')
    }}
    value={value}
  >
    {!props.field.required ? <option value="">Not set</option> : null}
    {props.field.required && !value ? <option disabled value="">Select…</option> : null}
    <option value="true">True</option>
    <option value="false">False</option>
  </select>
}

function EnumLiteralEditor(props: SchemaLiteralRendererProps) {
  const options = props.field.options ?? []
  const literalValue = props.value === undefined ? undefined : JSON.stringify(props.value)
  const selectedIndex = options.findIndex(option => JSON.stringify(option.value) === literalValue)
  return <select
    {...inputAccessibility(props)}
    disabled={!props.canEdit}
    onChange={event => {
      if (!(event.target as HTMLInputElement).value) props.onCommit()
      else props.onCommit(options[Number((event.target as HTMLInputElement).value)]!.value)
    }}
    value={selectedIndex < 0 ? '' : String(selectedIndex)}
  >
    {!props.field.required || selectedIndex < 0
      ? <option value="">{props.field.required ? 'Select…' : 'Not set'}</option>
      : null}
    {options.map((option, index) => <option key={`${index}:${option.label}`} value={index}>{option.label}</option>)}
  </select>
}

const JsonLiteralEditor = defineSetupComponent<SchemaLiteralRendererProps>('JsonLiteralEditor', ['canEdit', 'autofocus', 'controlId', 'describedBy', 'field', 'inputId', 'invalid', 'value', 'onCommit'], props => {
  const localError = ref<string>()
  const localProblemId = `${props.controlId}-input-${props.field.name}-json-problem`
  watch(() => props.value, () => { localError.value = undefined })
  return () => {
    const value = props.value === undefined ? '' : JSON.stringify(props.value, null, 2)
    return <>
    <textarea
      aria-describedby={[props.describedBy, localError.value ? localProblemId : undefined].filter(Boolean).join(' ') || undefined}
      aria-invalid={props.invalid || !!localError.value}
      value={value}
      disabled={!props.canEdit}
      id={props.inputId}
      key={`${props.controlId}:${props.field.name}:${value}`}
      onBlur={event => {
        const text = (event.target as HTMLInputElement).value.trim()
        if (!text && !props.field.required) {
          localError.value = undefined
          props.onCommit()
          return
        }
        try {
          const next: unknown = JSON.parse(text)
          if (!isNumenValue(next)) throw new TypeError('Value must be JSON-compatible Numen data.')
          localError.value = undefined
          if (JSON.stringify(next) !== JSON.stringify(props.value)) props.onCommit(next)
        } catch (error) {
          localError.value = error instanceof Error ? error.message : 'Enter valid JSON.'
        }
      }}
      placeholder={props.field.required ? 'Required JSON value' : 'Optional JSON value'}
      rows={4}
    />
    {localError.value ? <p class="inspector-field-error" id={localProblemId} role="alert">{localError.value}</p> : null}
  </>
  }
})

function DurationLiteralEditor(props: SchemaLiteralRendererProps) {
  const value = typeof props.value === 'number' ? props.value : undefined
  const seconds = value === undefined ? '' : String(value / 1_000)
  return <span class="input-with-unit expression-duration-input">
    <input
      {...inputAccessibility(props)}
      aria-label="Wait duration in seconds"
      disabled={!props.canEdit}
      key={`${props.controlId}:${props.field.name}:${seconds}`}
      min="0"
      onBlur={event => {
        const raw = (event.target as HTMLInputElement).value
        const nextSeconds = Number(raw)
        const nextDuration = Math.round(nextSeconds * 1_000)
        if (!raw || !Number.isFinite(nextSeconds) || nextSeconds < 0 || !Number.isSafeInteger(nextDuration)) {
          (event.target as HTMLInputElement).value = seconds
          return
        }
        if (nextDuration !== value) props.onCommit(nextDuration)
      }}
      onKeydown={event => { if (event.key === 'Enter') (event.target as HTMLElement).blur() }}
      placeholder="seconds"
      step="0.001"
      type="number"
      value={seconds}
    />
    <span>s</span>
  </span>
}

function localDateTimeValue(value: NumenValue | undefined): string {
  if (typeof value !== 'string') return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 19)
}

function IsoDateTimeLiteralEditor(props: SchemaLiteralRendererProps) {
  const value = typeof props.value === 'string' ? props.value : undefined
  const localValue = localDateTimeValue(value)
  return <input
    {...inputAccessibility(props)}
    aria-label="Wait until date and time"
    disabled={!props.canEdit}
    key={`${props.controlId}:${props.field.name}:${localValue}`}
    onBlur={event => {
      const raw = (event.target as HTMLInputElement).value
      const parsed = new Date(raw)
      if (!raw || !Number.isFinite(parsed.getTime())) {
        (event.target as HTMLInputElement).value = localValue
        return
      }
      const next = parsed.toISOString()
      if (next !== value) props.onCommit(next)
    }}
    step="1"
    type="datetime-local"
    value={localValue}
  />
}

export const coreSchemaLiteralRenderers: ReadonlyArray<SchemaRendererDefinition<SchemaLiteralRenderer>> = [
  { id: 'numen:schema-duration-ms', version: 1, role: 'numen/duration-ms', editor: DurationLiteralEditor },
  { id: 'numen:schema-iso-date-time', version: 1, role: 'numen/iso-date-time', editor: IsoDateTimeLiteralEditor },
  { id: 'numen:schema-string', version: 1, type: 'string', editor: StringLiteralEditor },
  { id: 'numen:schema-number', version: 1, type: 'number', editor: NumberLiteralEditor },
  { id: 'numen:schema-boolean', version: 1, type: 'boolean', editor: BooleanLiteralEditor },
  { id: 'numen:schema-enum', version: 1, type: 'enum', editor: EnumLiteralEditor },
  { id: 'numen:schema-json', version: 1, type: 'json', editor: JsonLiteralEditor },
]

export function coreWorkbenchSchemaRenderers(ctx: Context): void {
  for (const renderer of coreSchemaLiteralRenderers) ctx.schemaUI.defineRenderer(ctx, renderer)
}

coreWorkbenchSchemaRenderers.inject = ['schemaUI']

export default coreWorkbenchSchemaRenderers
