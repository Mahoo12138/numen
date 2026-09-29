import { Button, SelectMenu, Textarea } from '@numenjs/components'
import { t } from './i18n.js'
import type { NumenValue } from '@numenjs/core'
import { AutomationInputValue } from './AutomationInputs.js'
import type { WorkbenchRunLaunchMode } from './contracts.js'
import { coreWorkbenchRunFlowRoute } from './routes.js'
import type { WorkbenchPageProps } from './types.js'
import { defineSetupComponent } from './vue-component.js'
import { useManualRunForm } from './useManualRunForm.js'

interface ManualRunProps extends WorkbenchPageProps { automationId: string }
export const ManualRunForm = defineSetupComponent<ManualRunProps>('ManualRunForm', ['automationId', 'consoleClient', 'schemaUI', 'navigation'], props => {
  const state = useManualRunForm({ automationId: () => props.automationId, client: () => props.consoleClient })
  const { form, mode, values, triggerText, triggerError, invalid, issues, message, loading, pending, requiresReload, uncertain, runId, load, choose, start, change } = state
  return () => {
    const locked = pending.value || loading.value || uncertain.value
    return <section class="automation-manual-run">
      <h2>{t('workbench.testRun.title')}</h2>
      <p class="activation-help">{t('workbench.testRun.effects')}</p>
      <p class="activation-help">{t('workbench.testRun.triggerHelp')}</p>
      <label class="inspector-field"><span>{t('workbench.testRun.mode')}</span><SelectMenu ariaLabel={t('workbench.testRun.mode')}
        value={mode.value} disabled={locked} options={[
          { value: 'revision-test', label: t('workbench.testRun.publishedRevision') },
          { value: 'manual', label: t('workbench.testRun.activeRevision') },
        ]} onChange={value => void choose(value as WorkbenchRunLaunchMode)} /></label>
      {mode.value === 'revision-test' && form.value ? <label class="inspector-field"><span>{t('workbench.revision')}</span><SelectMenu ariaLabel={t('workbench.testRun.selectRevision')}
        value={form.value.revisionId} disabled={locked} options={form.value.revisions.map(item => ({ value: item.id, label: `#${item.number}${item.active ? ` · ${t('workbench.testRun.activeLabel')}` : ''}` }))}
        onChange={value => void choose('revision-test', value)} /></label> : null}
      {loading.value ? <p role="status">{t('workbench.loadingParameters')}</p> : null}
      {form.value ? <form onSubmit={event => {
        event.preventDefault()
        // Enter and pointer submission both commit the focused valid field before freezing the request.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        void start()
      }}>
        <p class="manual-run-revision">{t('workbench.revision')} {form.value.revisionNumber}</p>
        {form.value.inputs !== undefined ? Object.entries(form.value.inputs).map(([name, field]) => <AutomationInputValue key={`${form.value!.revisionId}:${name}`} name={name} declaration={field} prefix="manual-run"
          disabled={locked || requiresReload.value} {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
          {...(values.value[name] !== undefined ? { value: values.value[name] } : {})}
          {...(issues.value.find(issue => issue.field === name) ? { error: issues.value.find(issue => issue.field === name)!.message } : {})}
          onChange={value => change(name, value)} onValidationChange={value => { invalid.value[name] = value }} />)
          : <AutomationInputValue name="parameters" declaration={{ type: 'object', title: t('workbench.parameters'), description: t('workbench.undeclaredParameters') }} prefix="manual-run"
            value={values.value} disabled={locked || requiresReload.value} {...(props.schemaUI ? { schemaUI: props.schemaUI } : {})}
            onChange={value => { values.value = value as Record<string, NumenValue> ?? {} }} onValidationChange={value => { invalid.value.parameters = value }} />}
        {form.value.inputs && !Object.keys(form.value.inputs).length ? <p>{t('workbench.noParametersAreRequired')}</p> : null}
        <label class="inspector-field"><span>{t('workbench.testRun.triggerData')}</span><Textarea aria-label={t('workbench.testRun.triggerData')}
          value={triggerText.value} disabled={locked || requiresReload.value} rows={4} spellcheck={false} aria-invalid={triggerError.value}
          onInput={event => { triggerText.value = (event.target as HTMLTextAreaElement).value; triggerError.value = false }} />
          {triggerError.value ? <small role="alert">{t('workbench.testRun.triggerInvalid')}</small> : null}</label>
        <div class="manual-run-actions">
          <Button variant="primary" class="primary-button" type="submit" disabled={pending.value || loading.value || requiresReload.value || Object.values(invalid.value).some(Boolean)}>{pending.value ? t('workbench.starting') : uncertain.value ? t('workbench.retryStartRun') : t('workbench.startRun')}</Button>
          <Button variant="secondary" class="secondary-button" disabled={locked} onClick={() => void load()} type="button">{t('workbench.reloadParameters')}</Button>
        </div>
      </form> : null}
      {issues.value.filter(issue => !form.value?.inputs || !Object.hasOwn(form.value.inputs, issue.field)).map((issue, i) => <p class="inspector-field-error" key={i} role="alert">{issue.field}: {issue.message}</p>)}
      {message.value ? <p role={runId.value ? 'status' : 'alert'}>{t(message.value)}</p> : null}
      {uncertain.value && state.submission.value ? <p>{t('workbench.testRun.requestId')} <code>{state.submission.value.requestId}</code></p> : null}
      {runId.value && props.navigation ? <div class="manual-run-result-actions"><Button variant="secondary" class="secondary-button" onClick={() => props.navigation?.navigate(coreWorkbenchRunFlowRoute, { parameters: { id: runId.value! } })} type="button">{t('workbench.viewRun')}</Button></div> : null}
      {!form.value ? <div class="manual-run-actions"><Button variant="secondary" class="secondary-button" disabled={locked} onClick={() => void load()} type="button">{t('workbench.reloadParameters')}</Button></div> : null}
    </section>
  }
})
