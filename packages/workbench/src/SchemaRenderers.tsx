import { isNumenValue, type NumenValue } from '@numen/core'
import type { SchemaRendererDefinition } from '@numen/webui/schema-ui'
import type { Context } from 'cordis'
import type { ComponentType } from 'react'
import { useEffect, useState } from 'react'
import type { WorkbenchAutomationInputField } from './contracts.js'

export interface SchemaLiteralRendererProps {
  canEdit: boolean
  controlId: string
  describedBy?: string
  field: WorkbenchAutomationInputField
  inputId: string
  invalid: boolean
  value?: NumenValue
  onCommit(value?: NumenValue): void
}

export type SchemaLiteralRenderer = ComponentType<SchemaLiteralRendererProps>

function inputAccessibility(props: SchemaLiteralRendererProps) {
  return {
    'aria-describedby': props.describedBy,
    'aria-invalid': props.invalid,
    id: props.inputId,
  }
}

function StringLiteralEditor(props: SchemaLiteralRendererProps) {
  const value = typeof props.value === 'string' ? props.value : ''
  return <input
    {...inputAccessibility(props)}
    defaultValue={value}
    disabled={!props.canEdit}
    key={`${props.controlId}:${props.field.name}:${value}`}
    onBlur={event => {
      const next = event.currentTarget.value
      if (!next && !props.field.required) props.onCommit()
      else if (next !== value) props.onCommit(next)
    }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
    placeholder={props.field.required ? 'Required' : 'Optional'}
    type="text"
  />
}

function NumberLiteralEditor(props: SchemaLiteralRendererProps) {
  const value = typeof props.value === 'number' ? props.value : undefined
  return <input
    {...inputAccessibility(props)}
    defaultValue={value ?? ''}
    disabled={!props.canEdit}
    key={`${props.controlId}:${props.field.name}:${value ?? 'unset'}`}
    {...(props.field.min !== undefined ? { min: props.field.min } : {})}
    {...(props.field.max !== undefined ? { max: props.field.max } : {})}
    {...(props.field.step !== undefined ? { step: props.field.step } : {})}
    onBlur={event => {
      if (!event.currentTarget.value) {
        if (!props.field.required) props.onCommit()
        else event.currentTarget.value = value === undefined ? '' : String(value)
        return
      }
      const next = Number(event.currentTarget.value)
      if (!Number.isFinite(next)) {
        event.currentTarget.value = value === undefined ? '' : String(value)
        return
      }
      if (next !== value) props.onCommit(next)
    }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
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
      if (!event.currentTarget.value) props.onCommit()
      else props.onCommit(event.currentTarget.value === 'true')
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
      if (!event.currentTarget.value) props.onCommit()
      else props.onCommit(options[Number(event.currentTarget.value)]!.value)
    }}
    value={selectedIndex < 0 ? '' : String(selectedIndex)}
  >
    {!props.field.required || selectedIndex < 0
      ? <option value="">{props.field.required ? 'Select…' : 'Not set'}</option>
      : null}
    {options.map((option, index) => <option key={`${index}:${option.label}`} value={index}>{option.label}</option>)}
  </select>
}

function JsonLiteralEditor(props: SchemaLiteralRendererProps) {
  const value = props.value === undefined ? '' : JSON.stringify(props.value, null, 2)
  const [localError, setLocalError] = useState<string>()
  const localProblemId = `${props.controlId}-input-${props.field.name}-json-problem`
  useEffect(() => setLocalError(undefined), [value])
  return <>
    <textarea
      aria-describedby={[props.describedBy, localError ? localProblemId : undefined].filter(Boolean).join(' ') || undefined}
      aria-invalid={props.invalid || !!localError}
      defaultValue={value}
      disabled={!props.canEdit}
      id={props.inputId}
      key={`${props.controlId}:${props.field.name}:${value}`}
      onBlur={event => {
        const text = event.currentTarget.value.trim()
        if (!text && !props.field.required) {
          setLocalError(undefined)
          props.onCommit()
          return
        }
        try {
          const next: unknown = JSON.parse(text)
          if (!isNumenValue(next)) throw new TypeError('Value must be JSON-compatible Numen data.')
          setLocalError(undefined)
          if (JSON.stringify(next) !== JSON.stringify(props.value)) props.onCommit(next)
        } catch (error) {
          setLocalError(error instanceof Error ? error.message : 'Enter valid JSON.')
        }
      }}
      placeholder={props.field.required ? 'Required JSON value' : 'Optional JSON value'}
      rows={4}
    />
    {localError ? <p className="inspector-field-error" id={localProblemId} role="alert">{localError}</p> : null}
  </>
}

export const coreSchemaLiteralRenderers: ReadonlyArray<SchemaRendererDefinition<SchemaLiteralRenderer>> = [
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
