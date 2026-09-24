import { Input, Textarea } from './Input.js'
import { SelectMenu } from './SelectMenu.js'
import { componentText as t } from './i18n.js'
import { isSchemaValue, type SchemaValue, type SchemaField } from './schema.js'
import { ref, watch, type Component } from 'vue'
import { defineSetupComponent, useTextDraft } from './vue-component.js'

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
  onCommit(value?: SchemaValue): void
}

export type SchemaLiteralRenderer = Component<SchemaLiteralRendererProps>

function inputAccessibility(props: SchemaLiteralRendererProps) {
  return {
    class: 'n-schema-input',
    'aria-describedby': props.describedBy,
    'aria-invalid': props.invalid,
    autofocus: props.autofocus,
    id: props.inputId,
  }
}

export const StringLiteralEditor = defineSetupComponent<SchemaLiteralRendererProps>('StringLiteralEditor', ['canEdit', 'autofocus', 'controlId', 'describedBy', 'field', 'inputId', 'invalid', 'value', 'onCommit', 'onValidationChange'], props => {
  const draft = useTextDraft(() => typeof props.value === 'string' ? props.value : '')
  return () => {
    const value = typeof props.value === 'string' ? props.value : ''
    return <Input
      {...inputAccessibility(props)}
      onInput={draft.onInput}
      value={draft.text.value}
      disabled={!props.canEdit}
      key={`${props.controlId}:${props.field.name}:${value}`}
      onBlur={event => {
        const next = (event.target as HTMLInputElement).value
        if (!next && !props.field.required) props.onCommit()
        else if (next !== value) props.onCommit(next)
      }}
      onKeydown={event => { if (event.key === 'Enter') (event.target as HTMLElement).blur() }}
      placeholder={props.field.required ? t('required') : t('optional')}
      type="text"
    />
  }
})

export const NumberLiteralEditor = defineSetupComponent<SchemaLiteralRendererProps>('NumberLiteralEditor', ['canEdit', 'autofocus', 'controlId', 'describedBy', 'field', 'inputId', 'invalid', 'value', 'onCommit', 'onValidationChange'], props => {
  const draft = useTextDraft(() => typeof props.value === 'number' ? String(props.value) : '')
  return () => {
    const value = typeof props.value === 'number' ? props.value : undefined
    return <Input
      {...inputAccessibility(props)}
      onInput={draft.onInput}
      value={draft.text.value}
      disabled={!props.canEdit}
      key={`${props.controlId}:${props.field.name}:${value ?? 'unset'}`}
      {...(props.field.min !== undefined ? { min: props.field.min } : {})}
      {...(props.field.max !== undefined ? { max: props.field.max } : {})}
      {...(props.field.step !== undefined ? { step: props.field.step } : {})}
      onBlur={event => {
        if (!(event.target as HTMLInputElement).value) {
          if (!props.field.required) props.onCommit()
          else { draft.reset(); (event.target as HTMLInputElement).value = value === undefined ? '' : String(value) }
          return
        }
        const next = Number((event.target as HTMLInputElement).value)
        if (!Number.isFinite(next)) {
          draft.reset()
          ;(event.target as HTMLInputElement).value = draft.text.value
          return
        }
        if (next !== value) props.onCommit(next)
      }}
      onKeydown={event => { if (event.key === 'Enter') (event.target as HTMLElement).blur() }}
      placeholder={props.field.required ? t('requiredNumber') : t('optionalNumber')}
      type="number"
    />
  }
})

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

export const JsonLiteralEditor = defineSetupComponent<SchemaLiteralRendererProps>('JsonLiteralEditor', ['canEdit', 'autofocus', 'controlId', 'describedBy', 'field', 'inputId', 'invalid', 'value', 'onCommit', 'onValidationChange'], props => {
  const localError = ref<'validation.json'>()
  const draftText = ref<string>()
  const localProblemId = `${props.controlId}-input-${props.field.name}-json-problem`
  watch(() => props.value, () => { localError.value = undefined; draftText.value = undefined; props.onValidationChange?.(false) })
  return () => {
    const storedValue = props.value === undefined ? '' : JSON.stringify(props.value, null, 2)
    const value = draftText.value ?? storedValue
    return <>
    <Textarea
      class="n-schema-input"
      aria-describedby={[props.describedBy, localError.value ? localProblemId : undefined].filter(Boolean).join(' ') || undefined}
      aria-invalid={props.invalid || !!localError.value}
      value={value}
      disabled={!props.canEdit}
      id={props.inputId}
      key={`${props.controlId}:${props.field.name}:${storedValue}`}
      onInput={event => { draftText.value = (event.target as HTMLTextAreaElement).value; props.onValidationChange?.(true) }}
      onBlur={event => {
        const text = (event.target as HTMLInputElement).value.trim()
        if (!text && !props.field.required) {
          localError.value = undefined
          props.onValidationChange?.(false)
          props.onCommit()
          return
        }
        try {
          const next: unknown = JSON.parse(text)
          if (!isSchemaValue(next)) throw new TypeError('Value must be JSON-compatible data.')
          localError.value = undefined
          props.onValidationChange?.(false)
          if (JSON.stringify(next) !== JSON.stringify(props.value)) props.onCommit(next)
        } catch (error) {
          props.onValidationChange?.(true)
          localError.value = 'validation.json'
        }
      }}
      placeholder={props.field.required ? t('requiredJsonValue') : t('optionalJsonValue')}
      rows={4}
    />
    {localError.value ? <p class="n-field-error inspector-field-error" id={localProblemId} role="alert">{t(localError.value)}</p> : null}
  </>
  }
})

export const DurationLiteralEditor = defineSetupComponent<SchemaLiteralRendererProps>('DurationLiteralEditor', ['canEdit', 'autofocus', 'controlId', 'describedBy', 'field', 'inputId', 'invalid', 'value', 'onCommit', 'onValidationChange'], props => {
  const draft = useTextDraft(() => typeof props.value === 'number' ? String(props.value / 1_000) : '')
  return () => {
    const value = typeof props.value === 'number' ? props.value : undefined
    const seconds = value === undefined ? '' : String(value / 1_000)
    return <span class="input-with-unit expression-duration-input">
      <Input
        {...inputAccessibility(props)}
      onInput={draft.onInput}
        aria-label={t('waitDurationInSeconds')}
        disabled={!props.canEdit}
        key={`${props.controlId}:${props.field.name}:${seconds}`}
        min="0"
        onBlur={event => {
          const raw = (event.target as HTMLInputElement).value
          const nextSeconds = Number(raw)
          const nextDuration = Math.round(nextSeconds * 1_000)
          if (!raw || !Number.isFinite(nextSeconds) || nextSeconds < 0 || !Number.isSafeInteger(nextDuration)) {
            draft.reset()
            ;(event.target as HTMLInputElement).value = seconds
            return
          }
          if (nextDuration !== value) props.onCommit(nextDuration)
        }}
        onKeydown={event => { if (event.key === 'Enter') (event.target as HTMLElement).blur() }}
        placeholder={t('seconds')}
        step="0.001"
        type="number"
        value={draft.text.value}
      />
      <span>s</span>
    </span>
  }
})

function localDateTimeValue(value: SchemaValue | undefined): string {
  if (typeof value !== 'string') return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 19)
}

export const IsoDateTimeLiteralEditor = defineSetupComponent<SchemaLiteralRendererProps>('IsoDateTimeLiteralEditor', ['canEdit', 'autofocus', 'controlId', 'describedBy', 'field', 'inputId', 'invalid', 'value', 'onCommit', 'onValidationChange'], props => {
  const draft = useTextDraft(() => localDateTimeValue(props.value))
  return () => {
    const value = typeof props.value === 'string' ? props.value : undefined
    const localValue = localDateTimeValue(value)
    return <Input
      {...inputAccessibility(props)}
      onInput={draft.onInput}
      aria-label={t('waitUntilDateAndTime')}
      disabled={!props.canEdit}
      key={`${props.controlId}:${props.field.name}:${localValue}`}
      onBlur={event => {
        const raw = (event.target as HTMLInputElement).value
        const parsed = new Date(raw)
        if (!raw || !Number.isFinite(parsed.getTime())) {
          draft.reset()
          ;(event.target as HTMLInputElement).value = localValue
          return
        }
        const next = parsed.toISOString()
        if (next !== value) props.onCommit(next)
      }}
      step="1"
      type="datetime-local"
      value={draft.text.value}
    />
  }
})

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

