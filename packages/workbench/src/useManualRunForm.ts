import { AutomationInputValidationError, isNumenValue, resolveAutomationInputs, type AutomationInputIssue, type NumenValue } from '@numenjs/core'
import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import { workbenchManualRunFormQueryRef, workbenchStartManualRunActionRef, type WorkbenchManualRunForm, type WorkbenchManualRunFormInput, type WorkbenchRunLaunchMode, type WorkbenchStartManualRunInput, type WorkbenchStartManualRunResult } from './contracts.js'
import type { WorkbenchConsoleClient } from './types.js'

export function useManualRunForm(options: { automationId(): string; client(): WorkbenchConsoleClient | undefined }) {
  const form = shallowRef<WorkbenchManualRunForm>()
  const mode = ref<WorkbenchRunLaunchMode>('revision-test')
  const selectedRevisionId = ref('')
  const values = ref<Record<string, NumenValue>>({})
  const triggerText = ref('{}')
  const triggerError = ref(false)
  const invalid = ref<Record<string, boolean>>({})
  const issues = ref<AutomationInputIssue[]>([])
  const message = ref('')
  const loading = ref(false)
  const pending = ref(false)
  const requiresReload = ref(false)
  const uncertain = ref(false)
  const runId = ref<string>()
  const submission = shallowRef<WorkbenchStartManualRunInput>()
  let controller: AbortController | undefined
  let disposed = false

  const load = async (revisionId = selectedRevisionId.value) => {
    const client = options.client()
    // An uncertain response must resolve with the original request before parameters can change.
    if (!client || pending.value || uncertain.value) return false
    controller?.abort()
    const request = controller = new AbortController()
    loading.value = true; message.value = ''; issues.value = []; runId.value = undefined; submission.value = undefined
    try {
      const result = await client.query<WorkbenchManualRunFormInput, WorkbenchManualRunForm>(workbenchManualRunFormQueryRef, {
        automationId: options.automationId(), mode: mode.value,
        ...(mode.value === 'revision-test' && revisionId ? { revisionId } : {}),
      }, request.signal)
      if (disposed || request.signal.aborted) return false
      form.value = result
      selectedRevisionId.value = result.revisionId
      values.value = Object.fromEntries(Object.entries(result.inputs ?? {}).flatMap(([name, field]) => field.default !== undefined ? [[name, structuredClone(field.default)]] : []))
      triggerText.value = mode.value === 'manual' ? '{"type":"manual"}' : '{}'
      triggerError.value = false; invalid.value = {}; requiresReload.value = false
      return true
    } catch (error) {
      if (disposed || request.signal.aborted) return false
      form.value = undefined
      const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
      message.value = code === 'AUTOMATION_NOT_ACTIVE' ? 'workbench.manual.notActive'
        : code === 'AUTOMATION_NO_REVISIONS' ? 'workbench.testRun.noRevisions'
          : code === 'AUTOMATION_ARCHIVED' ? 'workbench.testRun.archived' : 'workbench.manual.loadFailed'
      return false
    } finally { if (!disposed && !request.signal.aborted) loading.value = false }
  }
  const choose = async (nextMode: WorkbenchRunLaunchMode, revisionId = '') => {
    if (pending.value || uncertain.value) return false
    mode.value = nextMode
    selectedRevisionId.value = revisionId
    return load(revisionId)
  }
  const start = async () => {
    const client = options.client()
    if (!client || !form.value || loading.value || pending.value || requiresReload.value || Object.values(invalid.value).some(Boolean)) return false
    issues.value = []; message.value = ''; runId.value = undefined
    if (!submission.value) {
      let trigger: NumenValue
      try {
        trigger = JSON.parse(triggerText.value)
        if (!isNumenValue(trigger)) throw new TypeError('Invalid trigger value')
        triggerError.value = false
      } catch { triggerError.value = true; return false }
      let input: Record<string, NumenValue>
      try { input = resolveAutomationInputs(form.value, JSON.parse(JSON.stringify(values.value))) } catch (error) {
        if (error instanceof AutomationInputValidationError) issues.value = error.issues
        return false
      }
      submission.value = { automationId: options.automationId(), mode: form.value.mode, revisionId: form.value.revisionId,
        requestId: globalThis.crypto.randomUUID(), input, trigger }
    }
    const request = controller = new AbortController()
    pending.value = true
    try {
      const result = await client.action<WorkbenchStartManualRunInput, WorkbenchStartManualRunResult>(workbenchStartManualRunActionRef, submission.value, request.signal)
      if (disposed || request.signal.aborted) return false
      runId.value = result.runId; message.value = 'workbench.manual.accepted'
      uncertain.value = false; submission.value = undefined
      return true
    } catch (error) {
      if (disposed || request.signal.aborted) return false
      const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
      if (code === 'AUTOMATION_INPUT_INVALID' && error && typeof error === 'object' && 'details' in error) {
        issues.value = (error.details as { issues?: AutomationInputIssue[] })?.issues ?? []
        message.value = 'workbench.manual.invalid'; uncertain.value = false; submission.value = undefined
      } else if (code === 'MANUAL_RUN_REVISION_CONFLICT' || code === 'MANUAL_RUN_REQUEST_CONFLICT'
        || code === 'AUTOMATION_REVISION_NOT_FOUND' || code === 'AUTOMATION_NOT_FOUND' || code === 'AUTOMATION_ARCHIVED') {
        requiresReload.value = true; uncertain.value = false; submission.value = undefined
        message.value = code === 'MANUAL_RUN_REVISION_CONFLICT' ? 'workbench.manual.revisionChanged'
          : code === 'AUTOMATION_ARCHIVED' ? 'workbench.testRun.archived' : 'workbench.testRun.rejected'
      } else {
        uncertain.value = true; message.value = 'workbench.manual.uncertain'
      }
      return false
    } finally { if (!disposed && !request.signal.aborted) pending.value = false }
  }
  const change = (name: string, value?: NumenValue) => {
    if (pending.value || uncertain.value) return
    const next = { ...values.value }; if (value === undefined) delete next[name]; else next[name] = value
    values.value = next; issues.value = issues.value.filter(issue => issue.field !== name)
  }
  watch(() => options.automationId(), () => {
    controller?.abort(); pending.value = false; uncertain.value = false; submission.value = undefined; form.value = undefined
    selectedRevisionId.value = ''; requiresReload.value = false
    void load('')
  }, { immediate: true })
  onScopeDispose(() => { disposed = true; controller?.abort() })
  return { form, mode, selectedRevisionId, values, triggerText, triggerError, invalid, issues, message, loading, pending, requiresReload, uncertain, runId, submission, load, choose, start, change }
}
