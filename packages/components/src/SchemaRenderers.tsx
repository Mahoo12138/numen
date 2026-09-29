import { Input, Textarea } from './Input.js'
import { SelectMenu } from './SelectMenu.js'
import { componentText as t } from './i18n.js'
import type { SchemaValue, SchemaField } from './schema.js'
import { parseSchemaLiteral, type LiteralValidationError } from './schema-literal.js'
import { nextTick, onScopeDispose, ref, watch, type Component } from 'vue'
import { defineSetupComponent } from './vue-component.js'

export interface SchemaDraftState { dirty: boolean; invalid: boolean }

export interface SchemaLiteralRendererProps {
  canEdit: boolean
  autofocus?: boolean
  controlId: string
  describedBy?: string
  field: SchemaField
  inputId: string
  invalid: boolean
  value?: SchemaValue
  onValidationChange?(invalid: boolean): void
  /** Report synchronously on input/validation and clear after commit or disposal. Text stays inside the renderer. */
  onDraftStateChange?(state: SchemaDraftState): void
  onCommit(value?: SchemaValue): void
}

export type SchemaLiteralRenderer = Component<SchemaLiteralRendererProps>

function inputAccessibility(props: SchemaLiteralRendererProps) {
  return {
    class: 'n-schema-input',
    'aria-describedby': props.describedBy,
    'aria-invalid': props.invalid,
    'aria-required': props.field.required,
    autofocus: props.autofocus,
    id: props.inputId,
  }
}

function literalText(field: SchemaField, value: SchemaValue | undefined): string {
  if (field.role === 'numen/duration-ms') return typeof value === 'number' ? String(value / 1_000) : ''
  if (field.role === 'numen/iso-date-time') return localDateTimeValue(value)
  if (field.type === 'json') return value === undefined ? '' : JSON.stringify(value, null, 2)
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function textLiteralEditor(name: string) {
  return defineSetupComponent<SchemaLiteralRendererProps>(name, ['canEdit', 'autofocus', 'controlId', 'describedBy', 'field', 'inputId', 'invalid', 'value', 'onCommit', 'onValidationChange', 'onDraftStateChange'], props => {
    const text = ref(literalText(props.field, props.value))
    const dirty = ref(false)
    const localError = ref<LiteralValidationError>()
    let disposed = false
    const report = (invalid = !!parseSchemaLiteral(text.value, props.field).error) => {
      if (disposed) return
      props.onDraftStateChange?.({ dirty: dirty.value, invalid: dirty.value && invalid })
      props.onValidationChange?.((dirty.value && invalid) || !!localError.value)
    }
    watch(() => [props.controlId, props.field.name, literalText(props.field, props.value)] as const, ([id, field, value], previous) => {
      if (id !== previous[0] || field !== previous[1] || !dirty.value || value === text.value) {
        text.value = value; dirty.value = false; localError.value = undefined
      }
      report()
    })
    onScopeDispose(() => { disposed = true; props.onDraftStateChange?.({ dirty: false, invalid: false }); props.onValidationChange?.(false) })
    const input = (event: Event) => {
      text.value = (event.target as HTMLInputElement).value
      dirty.value = text.value !== literalText(props.field, props.value)
      if (localError.value) localError.value = parseSchemaLiteral(text.value, props.field).error
      report()
    }
    const commit = () => {
      if (!props.canEdit) return
      const parsed = parseSchemaLiteral(text.value, props.field)
      if (parsed.error) { localError.value = parsed.error; report(true); return }
      localError.value = undefined
      const next = parsed.value
      text.value = literalText(props.field, next)
      dirty.value = false
      if (JSON.stringify(next) !== JSON.stringify(props.value)) props.onCommit(next)
      report(false)
      void nextTick(() => {
        dirty.value = text.value !== literalText(props.field, props.value)
        report()
      })
    }
    return () => {
      const isJson = props.field.type === 'json'
      const duration = props.field.role === 'numen/duration-ms'
      const dateTime = props.field.role === 'numen/iso-date-time'
      const number = props.field.type === 'number'
      const problemId = `${props.controlId}-input-${props.field.name}-literal-problem`
      const attrs = {
        ...inputAccessibility(props),
        'aria-describedby': [props.describedBy, localError.value ? problemId : undefined].filter(Boolean).join(' ') || undefined,
        'aria-invalid': props.invalid || !!localError.value,
        disabled: !props.canEdit,
        value: text.value,
        onInput: input,
        onBlur: commit,
      }
      const editor = isJson ? <Textarea {...attrs} rows={4} placeholder={props.field.required ? t('requiredJsonValue') : t('optionalJsonValue')} /> : <Input {...attrs}
        {...(duration ? { 'aria-label': t('waitDurationInSeconds') } : dateTime ? { 'aria-label': t('waitUntilDateAndTime') } : {})}
        {...(number ? { inputmode: 'decimal' as const } : {})}
        type={dateTime ? 'datetime-local' : 'text'}
        {...(dateTime ? { step: '1' } : {})}
        onKeydown={event => { if (event.key === 'Enter' && !event.isComposing) (event.target as HTMLElement).blur() }}
        placeholder={duration ? t('seconds') : number ? props.field.required ? t('requiredNumber') : t('optionalNumber') : props.field.required ? t('required') : t('optional')} />
      return <>
        {duration ? <span class="input-with-unit expression-duration-input">{editor}<span>s</span></span> : editor}
        {localError.value ? <p class="n-field-error inspector-field-error" id={problemId} role="alert">{t(localError.value)}</p> : null}
      </>
    }
  })
}

export const StringLiteralEditor = textLiteralEditor('StringLiteralEditor')
export const NumberLiteralEditor = textLiteralEditor('NumberLiteralEditor')

export function BooleanLiteralEditor(props: SchemaLiteralRendererProps) {
  const value = typeof props.value === 'boolean' ? String(props.value) : ''
  return <SelectMenu {...inputAccessibility(props)} class="schema-select" ariaLabel={props.field.label}
    disabled={!props.canEdit} onChange={value => { if (!value) props.onCommit(); else props.onCommit(value === 'true') }}
    value={value} options={[
      ...(!props.field.required ? [{ value: '', label: t('notSet') }] : !value ? [{ value: '', label: t('select'), disabled: true }] : []),
      { value: 'true', label: t('true') }, { value: 'false', label: t('false') },
    ]} />
}

export function EnumLiteralEditor(props: SchemaLiteralRendererProps) {
  const options = props.field.options ?? []
  const literalValue = props.value === undefined ? undefined : JSON.stringify(props.value)
  const selectedIndex = options.findIndex(option => JSON.stringify(option.value) === literalValue)
  return <SelectMenu {...inputAccessibility(props)} class="schema-select" ariaLabel={props.field.label}
    disabled={!props.canEdit} onChange={value => { if (!value) props.onCommit(); else props.onCommit(options[Number(value)]!.value) }}
    value={selectedIndex < 0 ? '' : String(selectedIndex)} options={[
      ...(!props.field.required || selectedIndex < 0 ? [{ value: '', label: props.field.required ? t('select') : t('notSet'), disabled: props.field.required }] : []),
      ...options.map((option, index) => ({ value: String(index), label: option.label })),
    ]} />
}

export const JsonLiteralEditor = textLiteralEditor('JsonLiteralEditor')
export const DurationLiteralEditor = textLiteralEditor('DurationLiteralEditor')

function localDateTimeValue(value: SchemaValue | undefined): string {
  if (typeof value !== 'string') return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 19)
}

export const IsoDateTimeLiteralEditor = textLiteralEditor('IsoDateTimeLiteralEditor')

export interface LiteralRendererDefinition {
  id: string
  version: number
  role?: string
  type?: string
  editor: SchemaLiteralRenderer
}

export const coreSchemaLiteralRenderers: ReadonlyArray<LiteralRendererDefinition> = [
  { id: 'numen:schema-duration-ms', version: 1, role: 'numen/duration-ms', editor: DurationLiteralEditor },
  { id: 'numen:schema-iso-date-time', version: 1, role: 'numen/iso-date-time', editor: IsoDateTimeLiteralEditor },
  { id: 'numen:schema-string', version: 1, type: 'string', editor: StringLiteralEditor },
  { id: 'numen:schema-number', version: 1, type: 'number', editor: NumberLiteralEditor },
  { id: 'numen:schema-boolean', version: 1, type: 'boolean', editor: BooleanLiteralEditor },
  { id: 'numen:schema-enum', version: 1, type: 'enum', editor: EnumLiteralEditor },
  { id: 'numen:schema-json', version: 1, type: 'json', editor: JsonLiteralEditor },
]
