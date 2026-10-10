import { Button } from '@numenjs/components'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { AutomationDraftDocument } from './useAutomationDraftDocument.js'
import type { WorkbenchConsoleClient } from './types.js'
import { workbenchSaveAutomationDraftCopyActionRef, type WorkbenchSaveAutomationDraftCopyInput, type WorkbenchSaveAutomationDraftCopyResult } from './contracts.js'
import { previewGraphConversion } from './graph-conversion.js'
import { GraphAutomationCanvas } from './GraphAutomationCanvas.js'
import { projectAutomationSteps } from './automation-projection.js'
import { defineSetupComponent } from './vue-component.js'
import { t } from './i18n.js'
import { useAutomationFieldDraft } from './automation-field-draft.js'

interface Props {
  client: WorkbenchConsoleClient
  document: AutomationDraftDocument
  name: string
  canConvert: boolean
  beforeConvert(): boolean
  onOpenCopy(id: string): void
}
export const GraphConversionPanel = defineSetupComponent<Props>('GraphConversionPanel', ['client', 'document', 'name', 'canConvert', 'beforeConvert', 'onOpenCopy'], props => {
  const open = ref(false), pending = ref(false), error = ref(''), copyId = ref(''), selected = ref('')
  const request = shallowRef<WorkbenchSaveAutomationDraftCopyInput>()
  const preview = computed(() => request.value?.source.flow.type === 'graph'
    ? { source: request.value.source, graph: request.value.source.flow }
    : previewGraphConversion(props.document.source))
  const presentation = computed(() => request.value?.presentation ?? props.document.presentation)
  const controller = new AbortController()
  const field = useAutomationFieldDraft(() => props.document.automationId, () => '__graphConversion')
  const report = () => { if (!controller.signal.aborted) field.report({ dirty: pending.value || (!!request.value && !copyId.value), invalid: false }) }
  watch(() => field.discardEpoch, report)
  onScopeDispose(() => controller.abort())
  const convert = async () => {
    if (!props.canConvert || pending.value) return
    if (!request.value) {
      if (!props.beforeConvert()) return
      const result = preview.value
      if ('reason' in result) return
      request.value = { automationId: props.document.automationId, name: `${props.name} (Graph)`.slice(0, 200),
        requestId: crypto.randomUUID(), source: result.source, presentation: structuredClone(props.document.presentation) }
    }
    pending.value = true; error.value = ''; report()
    try {
      const copy = await props.client.action<WorkbenchSaveAutomationDraftCopyInput, WorkbenchSaveAutomationDraftCopyResult>(workbenchSaveAutomationDraftCopyActionRef, request.value, controller.signal)
      if (!controller.signal.aborted) copyId.value = copy.automationId
    } catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause) }
    finally { pending.value = false; report() }
  }
  return () => <section class="graph-conversion-panel">
    <Button type="button" aria-expanded={open.value} onClick={() => { open.value = !open.value }}>{t('workbench.graph.conversionPreview')}</Button>
    {open.value ? <>
      <p>{t('workbench.graph.conversionHelp')}</p>
      {'reason' in preview.value ? <p role="status">{t(`workbench.graph.conversion.${preview.value.reason}`)}</p> : <>
        <div class="graph-conversion-preview"><GraphAutomationCanvas source={preview.value.source} graph={preview.value.graph} presentation={presentation.value}
          steps={projectAutomationSteps(preview.value.source)} activeStepId={selected.value} canEdit={false} onStepChange={id => { selected.value = id }} /></div>
        {copyId.value ? <Button type="button" onClick={() => props.onOpenCopy(copyId.value)}>{t('workbench.openSavedCopy')}</Button>
          : <Button type="button" disabled={pending.value || !props.canConvert} onClick={() => void convert()}>{t(pending.value ? 'workbench.savingCopy' : request.value ? 'workbench.retrySavingCopy' : 'workbench.graph.convertCopy')}</Button>}
      </>}
      {error.value ? <p role="alert">{error.value}</p> : null}
    </> : null}
  </section>
})
