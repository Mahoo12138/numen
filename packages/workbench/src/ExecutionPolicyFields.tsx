import { Button, NumberLiteralEditor } from '@numenjs/components'
import type { CompileDiagnostic, InvocationPolicy } from '@numenjs/core'
import { AutomationLiteralField } from './AutomationLiteralField.js'
import { nextTick, ref, watch } from 'vue'
import { defineSetupComponent } from './vue-component.js'
import { diagnosticText, t } from './i18n.js'
import { useAutomationInputSession } from './automation-input-session.js'

interface ExecutionPolicyFieldsProps {
  nodeId: string
  policy?: InvocationPolicy
  semantics?: { retrySafe: boolean; defaultTimeoutMs?: number }
  canEdit: boolean
  problems: CompileDiagnostic[]
  focusFieldPath?: string
  focusRequest?: number
  onChange?(nodeId: string, policy?: InvocationPolicy): void
}

function renderPolicy({ nodeId, policy, semantics, canEdit, problems, onChange }: Readonly<ExecutionPolicyFieldsProps>, confirmDiscard: () => boolean) {
  const update = (next: InvocationPolicy) => onChange?.(nodeId, Object.keys(next).length ? next : undefined)
  const numberField = (name: string, label: string, value: number | undefined, minimum: number, commit: (value: number | undefined) => void) => {
    const problem = problems.find(item => item.source?.fieldPath === `policy.${name}`)
    const inputId = `${nodeId}-policy-${name.replaceAll('.', '-')}`
    const problemId = `${inputId}-problem`
    return <div class="schema-field" data-invalid={!!problem}>
      <label class="schema-field-label" for={inputId}>{label}</label>
      <AutomationLiteralField renderer={NumberLiteralEditor} fieldPath={`policy.${name}`} canEdit={canEdit} controlId={nodeId}
        field={{ name, label, type: 'number', schemaType: 'number', required: false, min: minimum, max: Number.MAX_SAFE_INTEGER, step: 1 }}
        inputId={inputId} invalid={!!problem} {...(value !== undefined ? { value } : {})}
        {...(problem ? { describedBy: problemId } : {})}
        onCommit={next => commit(typeof next === 'number' ? next : undefined)} />
      {problem ? <p class="inspector-field-error" id={problemId}>{diagnosticText(problem)}</p> : null}
    </div>
  }
  return <>
    {numberField('timeoutMs', t('workbench.inspector.timeoutMs'), policy?.timeoutMs, 1, value => {
      const { timeoutMs: _timeout, ...rest } = policy ?? {}
      update(value === undefined ? rest : { ...rest, timeoutMs: value })
    })}
    <p class="inspector-field-help">{semantics?.defaultTimeoutMs !== undefined
      ? t('workbench.inspector.timeoutDefault', { value: semantics.defaultTimeoutMs })
      : t('workbench.inspector.timeoutUnset')}</p>
    {semantics?.retrySafe ? <>
      {numberField('retry.maxAttempts', t('workbench.inspector.maxAttempts'), policy?.retry?.maxAttempts, 1, value => {
        const { retry: _retry, ...rest } = policy ?? {}
        update(value === undefined ? rest : { ...rest, retry: { ...policy?.retry, maxAttempts: value } })
      })}
      <p class="inspector-field-help">{t('workbench.inspector.attemptsHelp')}</p>
      {policy?.retry ? numberField('retry.backoffMs', t('workbench.inspector.backoffMs'), policy.retry.backoffMs, 0, value => {
        const { backoffMs: _backoff, ...retry } = policy.retry!
        update({ ...policy, retry: value === undefined ? retry : { ...retry, backoffMs: value } })
      }) : null}
      {policy?.retry ? <p class="inspector-field-help">{t('workbench.inspector.backoffHelp')}</p> : null}
    </> : <p class="inspector-schema-notice" role="status">{t('workbench.inspector.retryUnsafe')}{policy?.retry ? ` ${t('workbench.inspector.existingRetry', { count: policy.retry.maxAttempts })}` : ''}</p>}
    {policy?.retry ? <Button disabled={!canEdit} onClick={() => {
      if (!confirmDiscard()) return
      const { retry: _retry, ...rest } = policy
      update(rest)
    }} type="button">{t('workbench.inspector.removeRetry')}</Button> : null}
    <p class="inspector-field-help">{t('workbench.inspector.policyAuthority')}</p>
    {problems.filter(item => item.source?.fieldPath === 'policy' || item.source?.fieldPath === 'policy.retry').map(problem => <p class="inspector-field-error" key={problem.code}>{diagnosticText(problem)}</p>)}
  </>
}

export const ExecutionPolicyFields = defineSetupComponent<ExecutionPolicyFieldsProps>('ExecutionPolicyFields', ['nodeId', 'policy', 'semantics', 'canEdit', 'problems', 'focusFieldPath', 'focusRequest', 'onChange'], props => {
  const root = ref<HTMLElement>()
  const inputSession = useAutomationInputSession()
  watch(() => [props.nodeId, props.focusRequest] as const, async ([,request], _previous, onCleanup) => {
    if (request === undefined) return
    let current = true
    onCleanup(() => { current = false })
    await nextTick()
    if (!current) return
    const suffix = props.focusFieldPath === 'policy.retry' ? 'retry.maxAttempts' : props.focusFieldPath?.slice('policy.'.length)
    const id = `${props.nodeId}-policy-${suffix?.replaceAll('.', '-')}`
    const field = Array.from(root.value?.querySelectorAll<HTMLElement>('input:not(:disabled)') ?? []).find(item => item.id === id)
    ;(field ?? root.value?.querySelector<HTMLElement>('button:not(:disabled)') ?? root.value)?.focus()
  }, { immediate: true, flush: 'post' })
  return () => <div class="execution-policy-fields" ref={root} tabindex={-1}>{renderPolicy(props, () => inputSession?.confirmDiscard() ?? true)}</div>
})
