import { Button, Input, SelectMenu } from '@numenjs/components'
import { isNumenValue, type AutomationSource, type LocalTestRequest, type NumenValue } from '@numenjs/core'
import { nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useAutomationFieldDraft } from './automation-field-draft.js'
import { useConsoleQuery } from './useConsoleQuery.js'
import { defineSetupComponent } from './vue-component.js'
import type { WorkbenchConsoleClient } from './types.js'
import { formatDateTime, t } from './i18n.js'
import { outputSamplesQueryRef, createOutputSampleActionRef, importOutputSampleActionRef, deleteOutputSampleActionRef, localTestPreviewQueryRef, startLocalTestActionRef,
  type OutputSamplesInput, type OutputSamplesPage, type WorkbenchLocalTestPreview, type StartLocalTestInput, type StartLocalTestResult } from './local-test-contracts.js'

interface Props {
  client: WorkbenchConsoleClient
  automationId: string
  nodeId: string
  source: AutomationSource
  draftVersion: number
  canEdit: boolean
  prepareDraft(signal: AbortSignal): Promise<number | undefined>
  onRun(runId: string): void
}
export const GraphLocalTestPanel = defineSetupComponent<Props>('GraphLocalTestPanel', ['client', 'automationId', 'nodeId', 'source', 'draftVersion', 'canEdit', 'prepareDraft', 'onRun'], props => {
  const open = ref(false), mode = ref<'only-node' | 'to-node'>('only-node'), selected = ref<string[]>([]), offset = ref(0)
  const inputText = ref('{}'), triggerText = ref('null'), sampleText = ref('{}'), sampleNode = ref(props.nodeId), executionId = ref('')
  const pending = ref(false), error = ref(''), preview = shallowRef<WorkbenchLocalTestPreview>(), startRequest = shallowRef<StartLocalTestInput>(), accepted = shallowRef<StartLocalTestResult>()
  const controller = new AbortController()
  const field = useAutomationFieldDraft(() => props.nodeId, () => '__localTest')
  const [samples, reloadSamples] = useConsoleQuery<OutputSamplesInput, OutputSamplesPage>(() => open.value ? props.client : undefined, outputSamplesQueryRef,
    () => ({ automationId: props.automationId, offset: offset.value }))
  onScopeDispose(() => controller.abort())
  watch(() => field.discardEpoch, () => { inputText.value = '{}'; triggerText.value = 'null'; sampleText.value = '{}'; startRequest.value = undefined; preview.value = undefined; error.value = '' })
  watch(() => props.draftVersion, () => { if (!startRequest.value) preview.value = undefined })
  const invalidate = () => { preview.value = undefined; accepted.value = undefined }
  const parse = (text: string): NumenValue => { const value: unknown = JSON.parse(text); if (!isNumenValue(value)) throw new Error(t('workbench.localTest.invalidJSON')); return value }
  const report = () => { if (!controller.signal.aborted) field.report({ dirty: !!startRequest.value || sampleText.value !== '{}' || inputText.value !== '{}' || triggerText.value !== 'null', invalid: false }) }
  const edit = (target: typeof inputText, text: string) => { target.value = text; invalidate(); report() }
  const operation = async (work: () => Promise<void>) => {
    if (pending.value || !props.canEdit) return
    pending.value = true; error.value = ''
    try { await work() } catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause) }
    finally { pending.value = false; report() }
  }
  const prepare = async () => {
    // This form owns these values. Freeze them before asking the document owner to save parameters.
    field.report({ dirty: false, invalid: false })
    return props.prepareDraft(controller.signal)
  }
  const previewTest = () => operation(async () => {
    const input = parse(inputText.value), trigger = parse(triggerText.value)
    if (!input || typeof input !== 'object' || Array.isArray(input) || '$resource' in input) throw new Error(t('workbench.localTest.objectInput'))
    const version = await prepare()
    if (version === undefined) return
    const request: LocalTestRequest = { automationId: props.automationId, expectedDraftVersion: version, targetNodeId: props.nodeId, mode: mode.value,
      sampleIds: [...selected.value], input, trigger }
    const result = await props.client.query<LocalTestRequest, WorkbenchLocalTestPreview>(localTestPreviewQueryRef, request, controller.signal)
    if (!controller.signal.aborted) { preview.value = result; accepted.value = undefined; await nextTick(); document.querySelector('.local-test-preview')?.scrollIntoView({ block: 'nearest' }) }
  })
  const start = () => operation(async () => {
    if (!startRequest.value && preview.value) startRequest.value = { ...preview.value.request, previewHash: preview.value.previewHash, requestId: crypto.randomUUID() }
    if (!startRequest.value) return
    report()
    let result: StartLocalTestResult
    try { result = await props.client.action<StartLocalTestInput, StartLocalTestResult>(startLocalTestActionRef, startRequest.value, controller.signal) }
    catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
      // A definite refusal is safe to revise. Transport failures retain the exact request for recovery.
      if (code !== 'LOCAL_TEST_UNAVAILABLE' && /^(LOCAL_TEST_|SAMPLE_|DRAFT_VERSION_CONFLICT$|AUTOMATION_(ARCHIVED|NOT_FOUND)$|MANUAL_RUN_REQUEST_CONFLICT$|RUN_RESOURCE_UNAVAILABLE$)/.test(code)) {
        startRequest.value = undefined; preview.value = undefined
      }
      throw cause
    }
    if (!controller.signal.aborted) { accepted.value = result; startRequest.value = undefined; preview.value = undefined }
  })
  const createSample = () => operation(async () => {
    const value = parse(sampleText.value), nodeId = sampleNode.value, version = await prepare()
    if (version === undefined) return
    await props.client.action(createOutputSampleActionRef, { automationId: props.automationId, expectedDraftVersion: version, nodeId, value }, controller.signal)
    sampleText.value = '{}'; reloadSamples(); invalidate()
  })
  const importSample = () => operation(async () => {
    await props.client.action(importOutputSampleActionRef, { automationId: props.automationId, executionId: executionId.value }, controller.signal)
    executionId.value = ''; reloadSamples(); invalidate()
  })
  const removeSample = (id: string) => operation(async () => {
    await props.client.action(deleteOutputSampleActionRef, { automationId: props.automationId, sampleId: id }, controller.signal)
    selected.value = selected.value.filter(value => value !== id); reloadSamples(); invalidate()
  })
  const locked = () => pending.value || !props.canEdit || !!startRequest.value
  return () => <section class="graph-local-test">
    <Button type="button" aria-expanded={open.value} onClick={() => { open.value = !open.value }}>{t('workbench.localTest.title')}</Button>
    {open.value ? <div class="local-test-content">
      <p>{t('workbench.localTest.scopeHelp')}</p>
      <div class="local-test-parameters">
        <label>{t('workbench.localTest.mode')}<SelectMenu ariaLabel={t('workbench.localTest.mode')} disabled={locked()} value={mode.value}
          options={['only-node', 'to-node'].map(value => ({ value, label: t(`workbench.localTest.${value}`) }))} onChange={value => { mode.value = value as typeof mode.value; invalidate() }} /></label>
        <label>{t('workbench.localTest.input')}<textarea aria-label={t('workbench.localTest.input')} disabled={locked()} value={inputText.value} onInput={event => edit(inputText, (event.target as HTMLTextAreaElement).value)} /></label>
        <label>{t('workbench.localTest.trigger')}<textarea aria-label={t('workbench.localTest.trigger')} disabled={locked()} value={triggerText.value} onInput={event => edit(triggerText, (event.target as HTMLTextAreaElement).value)} /></label>
      </div>
      <h3>{t('workbench.localTest.samples')}</h3><p>{t('workbench.localTest.samplesHelp')}</p>
      {samples.status === 'READY' ? <div class="local-test-samples">{samples.data.items.map(sample => <article key={sample.id}>
        <label><input type="checkbox" disabled={locked() || sample.nodeId === props.nodeId} checked={selected.value.includes(sample.id)} onChange={event => {
          selected.value = (event.target as HTMLInputElement).checked ? [...selected.value, sample.id] : selected.value.filter(id => id !== sample.id); invalidate()
        }} /><strong>{sample.nodeId}</strong></label>
        <div class="sample-metadata"><code title={sample.id}>{sample.id.slice(-12)}</code><small>{sample.capability.id}@{sample.capability.version} · {formatDateTime(sample.createdAt)}</small>
        <details><summary>{t('workbench.localTest.provenance')}</summary><code>{sample.id}</code><small>{sample.provenance.kind === 'manual' ? t('workbench.localTest.manualSource', { version: sample.provenance.draftVersion }) : `${sample.provenance.runId} · ${sample.provenance.executionId} · ${sample.provenance.snapshotId}`}</small></details></div>
        <Button type="button" disabled={locked()} onClick={() => void removeSample(sample.id)}>{t('workbench.delete')}</Button>
      </article>)}</div> : samples.status === 'ERROR' ? <p role="alert">{t('workbench.localTest.loadFailed')}</p> : null}
      <div><Button type="button" disabled={!offset.value || locked()} onClick={() => { offset.value = Math.max(0, offset.value - 50) }}>{t('workbench.localTest.previousSamples')}</Button>
        <Button type="button" disabled={samples.status !== 'READY' || samples.data.nextOffset === undefined || locked()} onClick={() => { if (samples.status === 'READY' && samples.data.nextOffset !== undefined) offset.value = samples.data.nextOffset }}>{t('workbench.localTest.nextSamples')}</Button></div>
      <details><summary>{t('workbench.localTest.createSample')}</summary>
        <label>{t('workbench.localTest.sampleNode')}<SelectMenu ariaLabel={t('workbench.localTest.sampleNode')} value={sampleNode.value} disabled={locked()}
          options={props.source.flow.type === 'graph' ? props.source.flow.nodes.filter(node => node.type === 'capability').map(node => ({ value: node.id, label: node.id })) : []} onChange={value => { sampleNode.value = value }} /></label>
        <label>{t('workbench.localTest.sampleValue')}<textarea aria-label={t('workbench.localTest.sampleValue')} disabled={locked()} value={sampleText.value} onInput={event => edit(sampleText, (event.target as HTMLTextAreaElement).value)} /></label>
        <Button type="button" disabled={locked()} onClick={() => void createSample()}>{t('workbench.localTest.saveSample')}</Button>
        <label>{t('workbench.localTest.executionId')}<Input aria-label={t('workbench.localTest.executionId')} disabled={locked()} value={executionId.value} onInput={event => { executionId.value = (event.target as HTMLInputElement).value }} /></label>
        <Button type="button" disabled={locked() || !executionId.value} onClick={() => void importSample()}>{t('workbench.localTest.importSample')}</Button>
      </details>
      <Button type="button" disabled={locked()} onClick={() => void previewTest()}>{t('workbench.localTest.preview')}</Button>
      {preview.value ? <section class="local-test-preview" aria-label={t('workbench.localTest.preview')}>
        <h3>{t('workbench.localTest.realCalls')}</h3><ul>{preview.value.calls.map(call => <li key={call.nodeId}><code>{call.nodeId}</code> · {call.capability.id}@{call.capability.version} · {t(call.inputValidation === 'validated' ? 'workbench.localTest.validated' : 'workbench.localTest.runtimeValidation')}{call.sideEffect ? ` · ${t('workbench.localTest.externalWrite')}` : ''}{!call.retrySafe ? ` · ${t('workbench.localTest.unsafeRetry')}` : ''}</li>)}</ul>
        <h3>{t('workbench.localTest.substitutions')}</h3><ul>{preview.value.substitutions.map(sample => <li key={sample.nodeId}><code>{sample.nodeId}</code> ← {sample.sampleId}</li>)}</ul>
        <p>{t('workbench.localTest.writeCount', { count: preview.value.externalWrites.length })}</p>
        <p>{t('workbench.localTest.fixedVersion', { version: preview.value.request.expectedDraftVersion })}</p>
      </section> : null}
      {preview.value || startRequest.value ? <Button type="button" variant="primary" disabled={pending.value || !props.canEdit} onClick={() => void start()}>{t(startRequest.value ? 'workbench.localTest.retry' : 'workbench.localTest.start')}</Button> : null}
      {accepted.value ? <p role="status">{t('workbench.localTest.accepted')} <code>{accepted.value.snapshotId}</code> <Button type="button" onClick={() => { if (accepted.value) props.onRun(accepted.value.runId) }}>{t('workbench.localTest.openRun')}</Button></p> : null}
      {error.value ? <p role="alert">{error.value}</p> : null}
    </div> : null}
  </section>
})
