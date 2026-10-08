import { Button, coreSchemaLiteralRenderers, type SchemaDraftState, type SchemaField, type SchemaValue } from '@numenjs/components'
import type { HostConfigSchemaNode } from '@numenjs/config'
import { h, nextTick, onScopeDispose, ref, watch, type VNode } from 'vue'
import { t } from './i18n.js'
import { patchPluginConfig, readPluginConfigPath, type PluginConfigPath } from './plugin-config-editing.js'
import { defineSetupComponent } from './vue-component.js'

export interface PluginConfigurationFormProps {
  schema: HostConfigSchemaNode
  value: Record<string, unknown>
  disabled: boolean
  sessionKey: string
  onChange(value: Record<string, unknown>): void
  onDraftStateChange(state: SchemaDraftState): void
}

const maxVisibleItems = 50
const maxVisibleNodes = 500
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const pathKey = (path: PluginConfigPath) => JSON.stringify(path)
const pathLabel = (path: PluginConfigPath) => path.join('.')
const keepInputFocus = (event: MouseEvent) => event.preventDefault()
const shapeMatches = (node: HostConfigSchemaNode, value: unknown) => node.type === 'json'
  || (node.type === 'object' ? isObject(value) : node.type === 'array' ? Array.isArray(value)
    : node.type === 'enum' ? (node.options ?? []).some(option => Object.is(option.value, value)) : typeof value === node.type)
const emptyItem = (node: HostConfigSchemaNode): unknown => node.type === 'object' ? {} : node.type === 'array' ? []
  : node.type === 'string' ? '' : node.type === 'number' ? 0 : node.type === 'boolean' ? false : node.type === 'enum' ? node.options?.[0]?.value ?? null : null

/** A projection of the page's existing JSON draft. Only literal renderers own unfinished field text. */
export const PluginConfigurationForm = defineSetupComponent<PluginConfigurationFormProps>('PluginConfigurationForm', ['schema', 'value', 'disabled', 'sessionKey', 'onChange', 'onDraftStateChange'], props => {
  const drafts = new Map<string, SchemaDraftState>()
  const fields = new Map<string, { node: HostConfigSchemaNode; mismatch: boolean; field: SchemaField }>()
  const visibleFields = new Set<string>()
  const structuralError = ref('')
  const structuralBusy = ref(false)
  let disposed = false
  let reported: SchemaDraftState | undefined
  const report = () => {
    if (disposed) return
    const state = { dirty: [...drafts.values()].some(value => value.dirty), invalid: [...drafts.values()].some(value => value.invalid) }
    if (reported?.dirty === state.dirty && reported.invalid === state.invalid) return
    reported = state
    props.onDraftStateChange(state)
  }
  const onDraft = (key: string, state: SchemaDraftState) => {
    if (disposed) return
    if (state.dirty || state.invalid) drafts.set(key, state)
    else drafts.delete(key)
    report()
  }
  watch(() => props.sessionKey, () => { drafts.clear(); fields.clear(); structuralError.value = ''; report() }, { flush: 'sync' })
  onScopeDispose(() => { disposed = true; drafts.clear(); props.onDraftStateChange({ dirty: false, invalid: false }) })
  const update = (path: PluginConfigPath, value: unknown, remove = false) => {
    if (props.disabled) return
    const result = patchPluginConfig(props.value, path, remove ? { kind: 'remove' } : { kind: 'set', value })
    if (!result.ok) { structuralError.value = t('workbench.pluginConfig.editFailed'); return }
    structuralError.value = ''
    if (result.changed) props.onChange(result.config)
  }
  const structure = async (action: () => void) => {
    if (props.disabled || structuralBusy.value) return
    if (typeof document !== 'undefined' && typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement) document.activeElement.blur()
    // A valid field's blur updates the parent JSON; wait for that prop before changing the array.
    structuralBusy.value = true
    await nextTick()
    try {
      if (disposed || props.disabled) return
      if ([...drafts.values()].some(value => value.dirty || value.invalid)) { structuralError.value = t('workbench.pluginConfig.pendingInvalid'); return }
      action()
    } finally { structuralBusy.value = false }
  }
  const metadata = (node: HostConfigSchemaNode, path: PluginConfigPath) => <>
    {node.description ? <p class="plugin-config-description">{node.description}</p> : null}
    {node.hasDefault ? <p class="plugin-config-default">{t('workbench.pluginConfig.defaultHint')}</p> : null}
    {path.length ? <small class="plugin-config-requirement">{t(node.required ? 'workbench.pluginConfig.required' : 'workbench.pluginConfig.optional')}</small> : null}
  </>
  const unset = (node: HostConfigSchemaNode, path: PluginConfigPath, present: boolean) => path.length && typeof path.at(-1) === 'string' && !node.required && present
    ? <Button type="button" onMousedown={keepInputFocus} disabled={props.disabled || structuralBusy.value} aria-label={t('workbench.pluginConfig.removeField', { path: pathLabel(path) })}
      onClick={() => { void structure(() => update(path, undefined, true)) }}>{t('workbench.pluginConfig.removeField', { path: pathLabel(path) })}</Button> : null
  let rendered = 0
  function renderChildren<T>(items: readonly T[], render: (item: T, index: number) => VNode): VNode[] {
    const children: VNode[] = []
    for (let index = 0; index < items.length; index++) {
      if (rendered >= maxVisibleNodes) {
        children.push(<p class="plugin-config-limit" key="render-limit">{t('workbench.pluginConfig.renderLimit')}</p>)
        break
      }
      children.push(render(items[index]!, index))
    }
    return children
  }
  const renderNode = (node: HostConfigSchemaNode, path: PluginConfigPath, label: string): VNode => {
    const read = readPluginConfigPath(props.value, path), value = read.present ? read.value : undefined
    const name = pathLabel(path), key = pathKey(path)
    const inputId = `plugin-config-${encodeURIComponent(props.sessionKey)}-${encodeURIComponent(key)}`
    if (++rendered > maxVisibleNodes) return <p key={key} class="plugin-config-limit">{t('workbench.pluginConfig.renderLimit')}</p>
    const mismatch = read.present && !shapeMatches(node, value)
    if (node.type === 'object' && !mismatch) return <fieldset class="plugin-config-object" key={`${props.sessionKey}:${key}`}>
      {path.length ? <legend>{label === name ? label : `${label} (${name})`}</legend> : null}
      {metadata(node, path)}
      {renderChildren(node.fields ?? [], field => renderNode(field, [...path, field.name], field.label))}
      {path.length && !read.present ? <Button type="button" onMousedown={keepInputFocus} disabled={props.disabled || structuralBusy.value}
        onClick={() => { void structure(() => update(path, {})) }}>{t('workbench.pluginConfig.addObject', { path: name })}</Button> : null}
      {unset(node, path, read.present)}
    </fieldset>
    if (node.type === 'array' && node.item && !mismatch) {
      const items = Array.isArray(value) ? value : []
      return <fieldset class="plugin-config-array" key={`${props.sessionKey}:${key}`}>
        <legend>{label === name ? label : `${label} (${name})`}</legend>
        {metadata(node, path)}
        {renderChildren(items.slice(0, maxVisibleItems), (_value, index) => <div class="plugin-config-array-item" key={index}>
          {renderNode(node.item!, [...path, index], `${label} ${index + 1}`)}
          <Button type="button" onMousedown={keepInputFocus} disabled={props.disabled || structuralBusy.value} aria-label={t('workbench.pluginConfig.removeItem', { path: `${name}.${index}` })}
            onClick={() => { void structure(() => update([...path, index], undefined, true)) }}>{t('workbench.pluginConfig.removeItem', { path: `${name}.${index}` })}</Button>
        </div>)}
        {items.length >= maxVisibleItems ? <p class="plugin-config-limit">{t('workbench.pluginConfig.arrayLimit', { count: maxVisibleItems })}</p> : null}
        <div class="plugin-config-actions"><Button type="button" onMousedown={keepInputFocus} disabled={props.disabled || structuralBusy.value || items.length >= maxVisibleItems} aria-label={t('workbench.pluginConfig.addItem', { path: name })}
          onClick={() => { void structure(() => {
            const current = readPluginConfigPath(props.value, path)
            const length = current.present && Array.isArray(current.value) ? current.value.length : 0
            if (length < maxVisibleItems) update([...path, length], emptyItem(node.item!))
          }) }}>{t('workbench.pluginConfig.addItem', { path: name })}</Button>{unset(node, path, read.present)}</div>
      </fieldset>
    }
    const type = mismatch || node.type === 'object' || node.type === 'array' ? 'json' : node.type
    visibleFields.add(key)
    const cached = fields.get(key)
    // Preserve stable metadata identities across validation/status renders. A renderer whose commit
    // was rejected must keep its text until its own next-tick dirty check, rather than resetting it.
    const field: SchemaField = cached?.node === node && cached.mismatch === mismatch && cached.field.type === type
      && cached.field.required === node.required && cached.field.min === (mismatch ? undefined : node.min)
      && cached.field.max === (mismatch ? undefined : node.max) && cached.field.step === (mismatch ? undefined : node.step)
      && cached.field.options === (mismatch ? undefined : node.options) ? cached.field : {
      name: key, label: name, type, schemaType: type,
      required: node.required,
      ...(!mismatch && node.min !== undefined ? { min: node.min } : {}),
      ...(!mismatch && node.max !== undefined ? { max: node.max } : {}),
      ...(!mismatch && node.step !== undefined ? { step: node.step } : {}),
      ...(!mismatch && node.options ? { options: node.options } : {}),
    }
    fields.set(key, { node, mismatch, field })
    const renderer = coreSchemaLiteralRenderers.find(renderer => renderer.type === type)!.editor
    const textEditor = type === 'string' || type === 'number' || type === 'json'
    return <div class="plugin-config-field" key={`${props.sessionKey}:${key}:${type}`} data-config-path={name}>
      <label for={inputId}><span aria-hidden="true">{label === name ? label : `${label} (${name})`}</span><span class="visually-hidden">{name}</span></label>
      {metadata(node, path)}
      {mismatch || node.fallbackReason ? <p class="plugin-config-fallback">{t(mismatch ? 'workbench.pluginConfig.shapeMismatch' : 'workbench.pluginConfig.fallback')}</p> : null}
      {h(renderer, {
        canEdit: !props.disabled && !structuralBusy.value,
        controlId: inputId, inputId, field, invalid: false,
        ...(read.present ? { value: value as SchemaValue } : {}),
        // The shared renderer commits on blur even without an input event; don't normalize untouched data.
        onCommit: (next?: SchemaValue) => {
          if (textEditor && !drafts.get(key)?.dirty) return
          // Restoring a compound shape can expand many controls and push other inputs beyond the
          // rendering budget. Keep every unfinished buffer until those fields have been committed.
          if (mismatch && (node.type === 'object' || node.type === 'array') && (next === undefined || shapeMatches(node, next))
            && [...drafts.entries()].some(([other, state]) => other !== key && (state.dirty || state.invalid))) {
            structuralError.value = t('workbench.pluginConfig.pendingInvalid')
            return
          }
          // The shared optional string editor returns undefined for an empty string. An explicit
          // string already in this configuration stays present; Unset is a separate user action.
          const value = type === 'string' && read.present && next === undefined ? '' : next
          update(path, value, value === undefined)
        },
        onDraftStateChange: (state: SchemaDraftState) => onDraft(key, state),
      })}
      {unset(node, path, read.present)}
    </div>
  }
  return () => {
    rendered = 0
    visibleFields.clear()
    const view = <div class="plugin-config-form" aria-label={t('workbench.pluginConfig.fields')}>
      {renderNode(props.schema, [], '')}
      {structuralError.value ? <p role="alert">{structuralError.value}</p> : null}
    </div>
    for (const key of fields.keys()) if (!visibleFields.has(key)) fields.delete(key)
    return view
  }
})
