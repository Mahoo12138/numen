import { Button, SelectMenu, Textarea } from '@numenjs/components'
import { t } from './i18n.js'
import type { NumenValue, SourceRef } from '@numenjs/core'
import { AutomationInputValue } from './AutomationInputs.js'
import type { WorkbenchRunLaunchMode, WorkbenchStartManualRunResult } from './contracts.js'
import { coreWorkbenchRunFlowRoute } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { defineSetupComponent } from './vue-component.js'
import { useManualRunForm } from './useManualRunForm.js'
import { onScopeDispose, watch } from 'vue'

interface ManualRunProps extends WorkbenchPageProps {
  automationId: string; initialMode?: WorkbenchRunLaunchMode
  canStartNewRun?: boolean
  prepareDraft?(signal: AbortSignal): Promise<number | undefined>
  currentDraftChanged?(version: number): boolean
  onAccepted?(result: WorkbenchStartManualRunResult): void
  onLocate?(source: SourceRef): void
  onClose?(): void
  onProtectionChange?(protect: boolean): void
}
export const ManualRunForm = defineSetupComponent<ManualRunProps>('ManualRunForm', ['automationId', 'consoleClient', 'schemaUI', 'navigation', 'initialMode', 'canStartNewRun', 'prepareDraft', 'currentDraftChanged', 'onAccepted', 'onLocate', 'onClose', 'onProtectionChange'], props => {
  const state = useManualRunForm({ automationId: () => props.automationId, client: () => props.consoleClient,
    ...(props.initialMode ? { initialMode: props.initialMode } : {}),
    ...(props.prepareDraft ? { prepareDraft: (signal: AbortSignal) => props.prepareDraft!(signal) } : {}),
    onAccepted: result => props.onAccepted?.(result),
  })
  const { form, mode, values, triggerText, triggerError, invalid, issues, diagnostics, message, loading, pending, requiresReload, uncertain, runId, load, choose, start, change } = state
  watch(state.needsProtection, protect => props.onProtectionChange?.(protect), { immediate: true, flush: 'sync' })
  onScopeDispose(() => props.onProtectionChange?.(false))
  return () => {
    const locked = pending.value || loading.value || uncertain.value
    return <section class="automation-manual-run">
      <h2>{t(mode.value === 'draft-test' ? 'workbench.draftTest.title' : 'workbench.testRun.title')}</h2>
      {mode.value === 'draft-test' ? <p class="activation-help">{t('workbench.draftTest.saveHelp')}</p> : null}
      <p class="activation-help">{t('workbench.testRun.effects')}</p>
      <p class="activation-help">{t('workbench.testRun.triggerHelp')}</p>
      {props.canStartNewRun === false ? <p role="status">{t('workbench.draftTest.archivedSession')}</p> : null}
      {mode.value !== 'draft-test' ? <label class="inspector-field"><span>{t('workbench.testRun.mode')}</span><SelectMenu ariaLabel={t('workbench.testRun.mode')}
        value={mode.value} disabled={locked} options={[
          { value: 'revision-test', label: t('workbench.testRun.publishedRevision') },
          { value: 'manual', label: t('workbench.testRun.activeRevision') },
        ]} onChange={value => void choose(value as WorkbenchRunLaunchMode)} /></label> : null}
      {form.value?.mode === 'revision-test' ? <label class="inspector-field"><span>{t('workbench.revision')}</span><SelectMenu ariaLabel={t('workbench.testRun.selectRevision')}
        value={form.value.revisionId} disabled={locked} options={form.value.revisions.map(item => ({ value: item.id, label: `#${item.number}${item.active ? ` · ${t('workbench.testRun.activeLabel')}` : ''}` }))}
        onChange={value => void choose('revision-test', value)} /></label> : null}
      {loading.value ? <p role="status">{t('workbench.loadingParameters')}</p> : null}
      {form.value ? <form onSubmit={event => {
        event.preventDefault()
        if (props.canStartNewRun === false && !uncertain.value) return
        // Enter and pointer submission both commit the focused valid field before freezing the request.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        void start()
      }}>
        <p class="manual-run-revision">{form.value.mode === 'draft-test' ? t('workbench.draftTest.target', { version: form.value.draftVersion }) : `${t('workbench.revision')} ${form.value.revisionNumber}`}</p>
        {form.value.mode === 'draft-test' && props.currentDraftChanged?.(form.value.draftVersion) ? <p role="status">{t('workbench.draftTest.parametersStale')}</p> : null}
        {form.value.inputs !== undefined ? Object.entries(form.value.inputs).map(([name, field]) => <AutomationInputValue key={`${state.parametersEpoch.value}:${name}`} name={name} declaration={field} prefix="manual-run"
          disabled={locked || requiresReload.value} {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
          {...(values.value[name] !== undefined ? { value: values.value[name] } : {})}
          {...(issues.value.find(issue => issue.field === name) ? { error: issues.value.find(issue => issue.field === name)!.message } : {})}
          onChange={value => change(name, value)} onValidationChange={value => { invalid.value[name] = value }} onDraftStateChange={value => { state.uncommitted.value[name] = value.dirty || value.invalid }} />)
          : <AutomationInputValue key={state.parametersEpoch.value} name="parameters" declaration={{ type: 'object', title: t('workbench.parameters'), description: t('workbench.undeclaredParameters') }} prefix="manual-run"
            value={values.value} disabled={locked || requiresReload.value} {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
            onChange={value => { values.value = value as Record<string, NumenValue> ?? {} }} onValidationChange={value => { invalid.value.parameters = value }} onDraftStateChange={value => { state.uncommitted.value.parameters = value.dirty || value.invalid }} />}
        {form.value.inputs && !Object.keys(form.value.inputs).length ? <p>{t('workbench.noParametersAreRequired')}</p> : null}
        <label class="inspector-field"><span>{t('workbench.testRun.triggerData')}</span><Textarea aria-label={t('workbench.testRun.triggerData')}
          value={triggerText.value} disabled={locked || requiresReload.value} rows={4} spellcheck={false} aria-invalid={triggerError.value}
          onInput={event => { triggerText.value = (event.target as HTMLTextAreaElement).value; triggerError.value = false }} />
          {triggerError.value ? <small role="alert">{t('workbench.testRun.triggerInvalid')}</small> : null}</label>
        <div class="manual-run-actions">
          <Button variant="primary" class="primary-button" type="submit" disabled={pending.value || loading.value || requiresReload.value || (props.canStartNewRun === false && !uncertain.value) || Object.values(invalid.value).some(Boolean)}>{pending.value ? t('workbench.starting') : uncertain.value ? t('workbench.retryStartRun') : t(mode.value === 'draft-test' ? 'workbench.draftTest.start' : 'workbench.startRun')}</Button>
          <Button variant="secondary" class="secondary-button" disabled={locked || props.canStartNewRun === false} onClick={() => void load()} type="button">{t(mode.value === 'draft-test' ? 'workbench.draftTest.reload' : 'workbench.reloadParameters')}</Button>
        </div>
      </form> : null}
      {issues.value.filter(issue => !form.value?.inputs || !Object.hasOwn(form.value.inputs, issue.field)).map((issue, i) => <p class="inspector-field-error" key={i} role="alert">{issue.field}: {issue.message}</p>)}
      {message.value ? <p role={runId.value ? 'status' : 'alert'}>{t(message.value)}</p> : null}
      {diagnostics.value.map((diagnostic, index) => <p role="alert" key={index}><code>{diagnostic.code}</code>: {diagnostic.message}
        {diagnostic.source && props.onLocate ? <Button type="button" onClick={() => props.onLocate?.(diagnostic.source!)}>{t('workbench.runData.locate')}</Button> : null}</p>)}
      {uncertain.value && state.submission.value ? <p>{t('workbench.testRun.requestId')} <code>{state.submission.value.requestId}</code></p> : null}
      {runId.value && props.navigation && mode.value !== 'draft-test' ? <div class="manual-run-result-actions"><Button variant="secondary" class="secondary-button" onClick={() => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: runId.value! } })} type="button">{t('workbench.viewRun')}</Button></div> : null}
      {!form.value ? <div class="manual-run-actions"><Button variant="secondary" class="secondary-button" disabled={locked || props.canStartNewRun === false} onClick={() => void load()} type="button">{t(mode.value === 'draft-test' ? 'workbench.draftTest.reload' : 'workbench.reloadParameters')}</Button></div> : null}
      {props.onClose ? <Button type="button" onClick={() => props.onClose?.()}>{t('workbench.draftTest.close')}</Button> : null}
    </section>
  }
})
