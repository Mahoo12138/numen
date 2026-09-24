import { diagnosticText, t } from './i18n.js'
import { automationInputTypes, isAutomationInputName, validateAutomationInputDeclarations, type AutomationInputDeclaration, type AutomationSource, type CompileDiagnostic, type NumenValue } from '@numenjs/core'
import type { SchemaUIResolver } from '@numenjs/webui/schema-ui'
import { h, ref } from 'vue'
import type { WorkbenchSchemaField } from './contracts.js'
import { coreSchemaLiteralRenderers, type SchemaLiteralRenderer } from './SchemaRenderers.js'
import { defineSetupComponent } from './vue-component.js'

export function automationInputField(name: string, declaration: AutomationInputDeclaration): WorkbenchSchemaField {
  return { name, label: declaration.title || name, schemaType: declaration.type,
    type: declaration.type === 'object' || declaration.type === 'array' ? 'json' : declaration.type,
    required: !!declaration.required, ...(declaration.description ? { description: declaration.description } : {}),
  }
}
export function AutomationInputValue({ name, declaration, value, disabled = false, schemaUI, prefix, error, onChange, onValidationChange }: {
  name: string; declaration: AutomationInputDeclaration; value?: NumenValue; disabled?: boolean; schemaUI?: SchemaUIResolver;
  prefix: string; error?: string; onChange(value?: NumenValue): void; onValidationChange?(invalid: boolean): void
}) {
  const field = automationInputField(name, declaration)
  const Renderer = schemaUI?.resolveRenderer<SchemaLiteralRenderer>({ type: field.type }, 'editor')
    ?? coreSchemaLiteralRenderers.find(renderer => renderer.type === field.type)?.editor
  const inputId = `${prefix}-${name}`
  return <div class="automation-input-value">
    <label for={inputId}>{field.label}{field.required ? <small>{t('workbench.required')}</small> : null}</label>
    {Renderer ? h(Renderer, { canEdit: !disabled, controlId: prefix, field, inputId, invalid: !!error,
      ...(error ? { describedBy: `${inputId}-error` } : {}), ...(value !== undefined ? { value } : {}), onCommit: onChange,
      ...(onValidationChange ? { onValidationChange } : {}),
    }) : <p>{t('workbench.editorUnavailable')}</p>}
    {field.description ? <p class="activation-help">{field.description}</p> : null}
    {error ? <p class="inspector-field-error" id={`${inputId}-error`} role="alert">{error}</p> : null}
  </div>
}

// Value callbacks are component props, not native change-event listeners on the wrapper.
AutomationInputValue.inheritAttrs = false

interface InputsProps {
  inputs: AutomationSource['inputs']; canEdit: boolean; schemaUI?: SchemaUIResolver; problems: CompileDiagnostic[];
  onChange(inputs: AutomationSource['inputs']): void
}
export const AutomationInputs = defineSetupComponent<InputsProps>('AutomationInputs', ['inputs', 'canEdit', 'schemaUI', 'problems', 'onChange'], props => {
  const name = ref('')
  const error = ref('')
  const update = (key: string, field: AutomationInputDeclaration) => props.onChange({ ...props.inputs, [key]: field })
  const remove = (key: string) => {
    const next = { ...props.inputs }; delete next[key]; props.onChange(next)
  }
  const add = () => {
    const key = name.value.trim()
    if (!isAutomationInputName(key)) { error.value = 'Use a letter, _ or $ first, followed by letters, digits, _, $ or - (up to 64 characters).'; return }
    if (Object.hasOwn(props.inputs ?? {}, key)) { error.value = 'This input already exists.'; return }
    update(key, { type: 'string', required: true }); name.value = ''; error.value = ''
  }
  return () => <section class="automation-input-settings">
    <h2>{t('workbench.automationInputs')}</h2>
    <p class="activation-help">{t('workbench.declareTheValuesThisAutomationAcceptsPublishAndActivateARevisionToUseTheseInputs')}</p>
    {props.inputs === undefined ? <p>{t('workbench.thisAutomationAcceptsUndeclaredInputsAddADeclarationToDefineItsParameterContract')}</p> : !Object.keys(props.inputs ?? {}).length ? <p>{t('workbench.noInputsAreAcceptedByThisContract')}</p> : null}
    {Object.entries(props.inputs ?? {}).map(([key, field]) => field && typeof field === 'object' ? <article class="automation-input-declaration" key={key}>
      <header><code>input.{key}</code><button class="secondary-button" disabled={!props.canEdit} aria-label={t('workbench.removeInputValue0', { value0: key })} onClick={() => remove(key)} type="button">{t('workbench.remove')}</button></header>
      <div class="automation-input-metadata">
        <label>{t('workbench.label')}<input aria-label={t('workbench.labelForValue0', { value0: key })} disabled={!props.canEdit} value={field.title ?? ''} placeholder={key} onChange={event => update(key, { ...field, title: (event.target as HTMLInputElement).value })} /></label>
        <label>{t('workbench.type')}<select aria-label={t('workbench.typeForValue0', { value0: key })} disabled={!props.canEdit} value={field.type} onChange={event => {
          const { default: _default, ...rest } = field
          update(key, { ...rest, type: (event.target as HTMLSelectElement).value as AutomationInputDeclaration['type'] })
        }}>{automationInputTypes.map(type => <option key={type} value={type}>{t(`workbench.valueType.${type}`)}</option>)}</select></label>
        <label class="automation-input-checkbox"><input aria-label={t('workbench.requiredValue0', { value0: key })} type="checkbox" disabled={!props.canEdit} checked={!!field.required} onChange={event => update(key, { ...field, required: (event.target as HTMLInputElement).checked })} />{t('workbench.required')}</label>
      </div>
      <label>{t('workbench.description')}<input aria-label={t('workbench.descriptionForValue0', { value0: key })} disabled={!props.canEdit} value={field.description ?? ''} onChange={event => update(key, { ...field, description: (event.target as HTMLInputElement).value })} /></label>
      <label class="automation-input-checkbox"><input aria-label={t('workbench.useDefaultForValue0', { value0: key })} type="checkbox" disabled={!props.canEdit} checked={Object.hasOwn(field, 'default')} onChange={event => {
        const { default: _default, ...rest } = field
        const defaults = { string: '', number: 0, boolean: false, object: {}, array: [] }
        update(key, (event.target as HTMLInputElement).checked ? { ...rest, default: defaults[field.type] } : rest)
      }} />{t('workbench.useADefaultValue')}</label>
      {Object.hasOwn(field, 'default') ? <AutomationInputValue name={key} declaration={{ ...field, title: t('workbench.defaultValue'), required: true }} prefix="default-input" disabled={!props.canEdit}
        {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})} {...(field.default !== undefined ? { value: field.default } : {})}
        onChange={value => { const { default: _default, ...rest } = field; update(key, value === undefined ? rest : { ...rest, default: value }) }} /> : null}
    </article> : <p key={key}>{t('workbench.input')}{key}{t('workbench.hasAnInvalidDeclaration')}<button disabled={!props.canEdit} onClick={() => remove(key)} type="button">{t('workbench.removeInput')}{key}</button></p>)}
    <form class="automation-input-add" onSubmit={event => { event.preventDefault(); add() }}>
      <label>{t('workbench.inputName')}<input aria-label={t('workbench.newInputName')} disabled={!props.canEdit} value={name.value} onInput={event => { name.value = (event.target as HTMLInputElement).value }} placeholder={t('workbench.message')} /></label>
      <button class="primary-button" disabled={!props.canEdit || Object.keys(props.inputs ?? {}).length >= 64} type="submit">{t('workbench.addInput')}</button>
    </form>
    {error.value ? <p class="inspector-field-error" role="alert">{error.value}</p> : null}
    {props.inputs !== undefined ? <button class="secondary-button" disabled={!props.canEdit} onClick={() => props.onChange(undefined)} type="button">{t('workbench.allowUndeclaredInputs')}</button> : null}
    {[...validateAutomationInputDeclarations(props.inputs), ...props.problems.filter(problem => problem.source?.nodeId === '__inputs')].map((problem, i) => <p key={i} class="inspector-field-error" role="alert">{problem.source?.fieldPath}: {diagnosticText(problem)}</p>)}
  </section>
})
