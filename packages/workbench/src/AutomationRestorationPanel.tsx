import { Button } from '@numenjs/components'
import { t } from './i18n.js'
import type { AutomationRestorationState } from './useAutomationRestoration.js'

export function AutomationRestorationPanel({ state, stale, onApply, onCancel, onPrepareAgain }: {
  state: AutomationRestorationState
  stale: boolean
  onApply(): void
  onCancel(): void
  onPrepareAgain(): void
}) {
  const identity = state.status === 'READY' ? state.content.identity : undefined
  const errorKey = state.status !== 'ERROR' ? undefined : state.code === 'DRAFT_VERSION_CONFLICT' ? 'stale'
    : state.code === 'DRAFT_NOT_SAVED' ? 'saveFirst' : state.code === 'AUTOMATION_ARCHIVED' ? 'archived'
      : state.code === 'AUTOMATION_RESTORE_LIMIT' ? 'tooLarge' : 'unavailable'
  return <section class="automation-restoration-panel" aria-labelledby="restoration-title" aria-busy={state.status === 'PREPARING'}>
    <h2 id="restoration-title">{t('workbench.restoration.title')}</h2>
    {identity ? <p class="restoration-identity"><strong>{identity.purpose === 'draft-test' ? t('workbench.draftTest.target', { version: identity.sourceDraftVersion }) : t('workbench.revisionValue0', { value0: identity.number })}</strong>
      <span> → {t('workbench.comparison.draft', { version: state.status === 'READY' ? state.content.expectedDraftVersion : '' })}</span></p> : null}
    <code class="restoration-snapshot-id">{state.snapshotId}</code>
    <p>{t('workbench.restoration.explanation')}</p>
    {state.status === 'PREPARING' ? <p role="status">{t('workbench.restoration.preparing')}</p> : null}
    {stale || errorKey ? <p role="alert">{t(`workbench.restoration.${stale ? 'stale' : errorKey}`)}</p> : null}
    <div class="restoration-actions">
      <Button type="button" onClick={onApply} disabled={state.status !== 'READY' || stale}>{t('workbench.restoration.title')}</Button>
      {stale || state.status === 'ERROR' ? <Button type="button" variant="secondary" onClick={onPrepareAgain}>{t('workbench.restoration.prepareAgain')}</Button> : null}
      <Button type="button" variant="secondary" onClick={onCancel}>{t('workbench.cancel')}</Button>
    </div>
  </section>
}
