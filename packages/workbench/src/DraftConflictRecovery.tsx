import { t } from './i18n.js'
import { computed, ref, shallowRef, watch } from 'vue'
import { compareAutomationDrafts } from './draft-comparison.js'
import { createDraftConflictRecovery } from './draft-conflict-recovery.js'
import type { WorkbenchConsoleClient } from './types.js'
import type { AutomationDraftDocument } from './useAutomationDraftDocument.js'
import { defineSetupComponent } from './vue-component.js'

interface Props {
  client: WorkbenchConsoleClient
  document: AutomationDraftDocument
  conflict: { expectedVersion: number; actualVersion: number }
  name: string
  onReload(): void
  onOpenCopy(id: string): void
}

export const DraftConflictRecovery = defineSetupComponent<Props>('DraftConflictRecovery', ['client', 'document', 'conflict', 'name', 'onReload', 'onOpenCopy'], props => {
  const open = ref(false)
  const name = ref(`${props.name} (copy)`.slice(0, 200))
  const recovery = shallowRef<ReturnType<typeof createDraftConflictRecovery>>()
  watch(() => [props.client, props.document.automationId, props.conflict.actualVersion] as const, (_value, _old, onCleanup) => {
    const controller = createDraftConflictRecovery(props.client, props.document, props.conflict.actualVersion)
    recovery.value = controller
    if (open.value) void controller.compare()
    onCleanup(() => controller.dispose())
  }, { immediate: true })
  const comparison = computed(() => recovery.value?.state.server
    ? compareAutomationDrafts(recovery.value.local, recovery.value.state.server)
    : undefined)
  return () => {
    const controller = recovery.value!
    const state = controller.state
    return <section class="draft-recovery" aria-label={t('workbench.draftConflictRecovery')}>
      <div class="authoring-notice" data-tone="conflict" role="alert">
        <span><strong>{t('workbench.draftChangedElsewhere')}</strong>{t('workbench.yourLocalChangesArePreservedLocalV')}{props.conflict.expectedVersion}{t('workbench.serverV')}{props.conflict.actualVersion}.</span>
        <button aria-expanded={open.value} onClick={() => {
          open.value = !open.value
          if (open.value && !state.server) void controller.compare()
        }} type="button">{open.value ? t('workbench.hideComparison') : t('workbench.compareAndRecover')}</button>
      </div>
      {open.value ? <div class="draft-recovery-content">
        <div class="draft-recovery-heading">
          <div><h2>{t('workbench.compareDrafts')}</h2><p>{t('workbench.localChangesStayPausedUntilYouChooseHowToRecover')}</p></div>
          <button disabled={state.comparing} onClick={() => void controller.compare()} type="button">{state.comparing ? t('workbench.loadingServerDraft') : t('workbench.refreshComparison')}</button>
        </div>
        {state.compareError ? <p role="alert">{state.compareError}</p> : null}
        {comparison.value && state.server ? <>
          <p>{t('workbench.comparingLocalV')}{controller.local.version}{t('workbench.withServerV')}{state.server.version}{t('workbench.theServerMayHaveNewerChangesAfterThisSnapshot')}</p>
          {comparison.value.differences.length ? <div class="draft-differences" aria-label={t('workbench.draftDifferences')}>
            {comparison.value.differences.map(item => <article key={item.path}>
              <h3>{item.path}</h3>
              <div class="draft-difference-values">
                <div><strong>{t('workbench.local')}</strong><pre>{item.local}</pre></div>
                <div><strong>{t('workbench.server')}</strong><pre>{item.server}</pre></div>
              </div>
            </article>)}
          </div> : <p>{t('workbench.sourceAndPresentationAreIdentical')}</p>}
          {comparison.value.truncated ? <p>{t('workbench.comparisonLimitReachedOnlyTheFirstDifferencesAreShownSavingACopyPreservesTheComplete')}</p> : null}
        </> : null}
        <div class="draft-recovery-actions">
          <div>
            <h3>{t('workbench.keepLocalChangesAsACopy')}</h3>
            <p>{t('workbench.theNewAutomationStartsDisabledWithNoPublishedRevisions')}</p>
            <label>{t('workbench.copyName')}<input aria-label={t('workbench.draftCopyName')} maxlength={200} disabled={!!state.request} value={name.value} onInput={event => { name.value = (event.target as HTMLInputElement).value }} /></label>
            {state.copy ? <p role="status">{t('workbench.saved2')}{state.copy.name}”. <button onClick={() => props.onOpenCopy(state.copy!.automationId)} type="button">{t('workbench.openSavedCopy')}</button></p>
              : <button disabled={state.saving || !name.value.trim()} onClick={() => void controller.saveCopy(name.value)} type="button">{state.saving ? t('workbench.savingCopy') : state.copyError && state.request ? t('workbench.retrySavingCopy') : t('workbench.saveLocalAsCopy')}</button>}
            {state.copyError ? <p role="alert">{state.copyError}</p> : null}
          </div>
          <div>
            <h3>{t('workbench.continueFromTheServer')}</h3>
            <p>{t('workbench.thisDiscardsThisTabSLocalEditsAndUndoHistoryThenLoadsTheLatestServer')}</p>
            <button disabled={!state.server || state.comparing || state.saving} onClick={props.onReload} type="button">{t('workbench.discardLocalAndReloadLatest')}</button>
          </div>
        </div>
      </div> : null}
    </section>
  }
})
