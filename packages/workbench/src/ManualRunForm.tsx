import { AutomationInputValidationError, resolveAutomationInputs, type AutomationInputIssue, type NumenValue } from '@numen/core'
import { onScopeDispose, ref, shallowRef } from 'vue'
import { AutomationInputValue } from './AutomationInputs.js'
import { workbenchManualRunFormQueryRef, workbenchStartManualRunActionRef, type WorkbenchManualRunForm, type WorkbenchStartManualRunInput, type WorkbenchStartManualRunResult } from './contracts.js'
import { coreWorkbenchRunFlowRoute } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { defineSetupComponent } from './vue-component.js'

interface ManualRunProps extends WorkbenchPageProps { automationId: string }
export const ManualRunForm = defineSetupComponent<ManualRunProps>('ManualRunForm', ['automationId', 'consoleClient', 'schemaUI', 'navigation'], props => {
  const form = shallowRef<WorkbenchManualRunForm>()
  const values = ref<Record<string, NumenValue>>({})
  const invalid = ref<Record<string, boolean>>({})
  const issues = ref<AutomationInputIssue[]>([])
  const message = ref('')
  const loading = ref(false)
  const pending = ref(false)
  const requiresReload = ref(false)
  const uncertain = ref(false)
  const runId = ref<string>()
  let submission: WorkbenchStartManualRunInput | undefined
  let controller: AbortController | undefined
  let disposed = false
  const load = async () => {
    if (!props.consoleClient || pending.value) return
    controller?.abort()
    const request = controller = new AbortController()
    loading.value = true; form.value = undefined; message.value = ''; issues.value = []; runId.value = undefined; uncertain.value = false; submission = undefined
    try {
      const result = await props.consoleClient.query<{ automationId: string }, WorkbenchManualRunForm>(workbenchManualRunFormQueryRef, { automationId: props.automationId }, request.signal)
      if (disposed || request.signal.aborted) return
      form.value = result
      values.value = Object.fromEntries(Object.entries(result.inputs ?? {}).flatMap(([name, field]) => field.default !== undefined ? [[name, structuredClone(field.default)]] : []))
      invalid.value = {}; requiresReload.value = false
    } catch (error) {
      if (disposed || request.signal.aborted) return
      const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
      message.value = code === 'AUTOMATION_NOT_ACTIVE' ? 'Publish and activate a Revision before starting a Run.' : 'Could not load Run parameters. Try loading again.'
    } finally { if (!disposed && !request.signal.aborted) loading.value = false }
  }
  const start = async () => {
    if (!props.consoleClient || !form.value || pending.value || requiresReload.value || Object.values(invalid.value).some(Boolean)) return
    issues.value = []; message.value = ''; runId.value = undefined
    if (!submission) {
      let input: Record<string, NumenValue>
      try { input = resolveAutomationInputs(form.value, JSON.parse(JSON.stringify(values.value))) } catch (error) {
        if (error instanceof AutomationInputValidationError) issues.value = error.issues
        return
      }
      submission = {
        automationId: props.automationId,
        requestId: globalThis.crypto.randomUUID(),
        expectedRevisionId: form.value.revisionId,
        input,
      }
    }
    const request = controller = new AbortController()
    pending.value = true
    try {
      const result = await props.consoleClient.action<WorkbenchStartManualRunInput, WorkbenchStartManualRunResult>(workbenchStartManualRunActionRef,
        submission, request.signal)
      if (disposed || request.signal.aborted) return
      runId.value = result.runId
      message.value = 'Run accepted.'
      uncertain.value = false; submission = undefined
    } catch (error) {
      if (disposed || request.signal.aborted) return
      const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
      if (code === 'AUTOMATION_INPUT_INVALID' && error && typeof error === 'object' && 'details' in error) {
        issues.value = (error.details as { issues?: AutomationInputIssue[] })?.issues ?? []
        message.value = 'Review the input values.'
        submission = undefined
      } else if (code === 'MANUAL_RUN_REVISION_CONFLICT' || code === 'MANUAL_RUN_REQUEST_CONFLICT') {
        requiresReload.value = true; uncertain.value = false; submission = undefined
        message.value = code === 'MANUAL_RUN_REVISION_CONFLICT' ? 'The active Revision changed. Reload parameters and review the new contract.'
          : 'This Run request conflicts with an earlier submission. Reload parameters before trying again.'
      } else {
        uncertain.value = true
        message.value = 'Run acceptance could not be confirmed. Retry safely with the same request.'
      }
    } finally { if (!disposed && !request.signal.aborted) pending.value = false }
  }
  void load()
  onScopeDispose(() => { disposed = true; controller?.abort() })
  const change = (name: string, value?: NumenValue) => {
    const next = { ...values.value }; if (value === undefined) delete next[name]; else next[name] = value; values.value = next
    issues.value = issues.value.filter(issue => issue.field !== name)
  }
  return () => <section class="automation-manual-run">
    <h2>Run manually</h2>
    <p class="activation-help">Run the active published Revision with your parameters. Trigger subscriptions do not need to be enabled.</p>
    {loading.value ? <p role="status">Loading parameters…</p> : null}
    {form.value ? <form onSubmit={event => { event.preventDefault(); void start() }}>
      <p class="manual-run-revision">Revision {form.value.revisionNumber}</p>
      {form.value.inputs !== undefined ? Object.entries(form.value.inputs).map(([name, field]) => <AutomationInputValue key={name} name={name} declaration={field} prefix="manual-run"
        disabled={pending.value || requiresReload.value || uncertain.value} {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
        {...(values.value[name] !== undefined ? { value: values.value[name] } : {})}
        {...(issues.value.find(issue => issue.field === name) ? { error: issues.value.find(issue => issue.field === name)!.message } : {})}
        onChange={value => change(name, value)} onValidationChange={value => { invalid.value[name] = value }} />)
        : <AutomationInputValue name="parameters" declaration={{ type: 'object', title: 'Parameters', description: 'This Revision accepts a JSON object with undeclared inputs.' }} prefix="manual-run"
          value={values.value} disabled={pending.value || requiresReload.value || uncertain.value} {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
          onChange={value => { values.value = value as Record<string, NumenValue> ?? {} }} onValidationChange={value => { invalid.value.parameters = value }} />}
      {form.value.inputs && !Object.keys(form.value.inputs).length ? <p>No parameters are required.</p> : null}
      <button class="primary-button" type="submit" disabled={pending.value || requiresReload.value || Object.values(invalid.value).some(Boolean)}>{pending.value ? 'Starting…' : uncertain.value ? 'Retry Start Run' : 'Start Run'}</button>
    </form> : null}
    {issues.value.filter(issue => !form.value?.inputs || !Object.hasOwn(form.value.inputs, issue.field)).map((issue, i) => <p class="inspector-field-error" key={i} role="alert">{issue.field}: {issue.message}</p>)}
    {message.value ? <p role={runId.value ? 'status' : 'alert'}>{message.value}</p> : null}
    {runId.value && props.navigation ? <button class="secondary-button" onClick={() => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: runId.value! } })} type="button">View Run</button> : null}
    <button class="secondary-button" disabled={pending.value || loading.value} onClick={() => void load()} type="button">Reload parameters</button>
  </section>
})
