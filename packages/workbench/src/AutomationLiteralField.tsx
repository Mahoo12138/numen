import { h, nextTick, ref, watch } from 'vue'
import type { SchemaLiteralRenderer, SchemaLiteralRendererProps } from './SchemaRenderers.js'
import { useAutomationFieldDraft } from './automation-field-draft.js'
import { defineSetupComponent } from './vue-component.js'

interface AutomationLiteralFieldProps extends SchemaLiteralRendererProps {
  renderer: SchemaLiteralRenderer
  fieldPath: string
  focusRequest?: number
}

/** Adds editor-session status to one renderer without owning its field value. */
export const AutomationLiteralField = defineSetupComponent<AutomationLiteralFieldProps>('AutomationLiteralField', [
  'renderer', 'fieldPath', 'focusRequest', 'canEdit', 'autofocus', 'controlId', 'describedBy', 'field', 'inputId', 'invalid', 'value',
  'onDraftStateChange', 'onValidationChange', 'onCommit',
], props => {
  const root = ref<HTMLElement>()
  watch(() => [props.controlId, props.inputId, props.focusRequest] as const, async ([,,request], _previous, onCleanup) => {
    if (request === undefined) return
    let current = true
    onCleanup(() => { current = false })
    await nextTick()
    if (current) (root.value?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled), select:not(:disabled)') ?? root.value)?.focus()
  }, { immediate: true, flush: 'post' })
  const draft = useAutomationFieldDraft(() => props.controlId, () => props.fieldPath)
  return () => {
    const { renderer, fieldPath: _fieldPath, focusRequest: _focusRequest, ...rest } = props
    return <span class="automation-literal-field" ref={root} tabindex={-1}>{h(renderer, { ...rest, key: draft.discardEpoch, onDraftStateChange: state => { draft.report(state); props.onDraftStateChange?.(state) } })}</span>
  }
})
