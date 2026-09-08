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
    return <section class="draft-recovery" aria-label="Draft conflict recovery">
      <div class="authoring-notice" data-tone="conflict" role="alert">
        <span><strong>Draft changed elsewhere.</strong> Your local changes are preserved. Local v{props.conflict.expectedVersion}; server v{props.conflict.actualVersion}.</span>
        <button aria-expanded={open.value} onClick={() => {
          open.value = !open.value
          if (open.value && !state.server) void controller.compare()
        }} type="button">{open.value ? 'Hide comparison' : 'Compare and recover'}</button>
      </div>
      {open.value ? <div class="draft-recovery-content">
        <div class="draft-recovery-heading">
          <div><h2>Compare Drafts</h2><p>Local changes stay paused until you choose how to recover.</p></div>
          <button disabled={state.comparing} onClick={() => void controller.compare()} type="button">{state.comparing ? 'Loading server Draft…' : 'Refresh comparison'}</button>
        </div>
        {state.compareError ? <p role="alert">{state.compareError}</p> : null}
        {comparison.value && state.server ? <>
          <p>Comparing local v{controller.local.version} with server v{state.server.version}. The server may have newer changes after this snapshot.</p>
          {comparison.value.differences.length ? <div class="draft-differences" aria-label="Draft differences">
            {comparison.value.differences.map(item => <article key={item.path}>
              <h3>{item.path}</h3>
              <div class="draft-difference-values">
                <div><strong>Local</strong><pre>{item.local}</pre></div>
                <div><strong>Server</strong><pre>{item.server}</pre></div>
              </div>
            </article>)}
          </div> : <p>Source and presentation are identical.</p>}
          {comparison.value.truncated ? <p>Comparison limit reached. Only the first differences are shown; saving a copy preserves the complete document.</p> : null}
        </> : null}
        <div class="draft-recovery-actions">
          <div>
            <h3>Keep local changes as a copy</h3>
            <p>The new Automation starts disabled, with no published Revisions.</p>
            <label>Copy name<input aria-label="Draft copy name" maxlength={200} disabled={!!state.request} value={name.value} onInput={event => { name.value = (event.target as HTMLInputElement).value }} /></label>
            {state.copy ? <p role="status">Saved “{state.copy.name}”. <button onClick={() => props.onOpenCopy(state.copy!.automationId)} type="button">Open saved copy</button></p>
              : <button disabled={state.saving || !name.value.trim()} onClick={() => void controller.saveCopy(name.value)} type="button">{state.saving ? 'Saving copy…' : state.copyError && state.request ? 'Retry saving copy' : 'Save local as copy'}</button>}
            {state.copyError ? <p role="alert">{state.copyError}</p> : null}
          </div>
          <div>
            <h3>Continue from the server</h3>
            <p>This discards this tab’s local edits and undo history, then loads the latest server Draft.</p>
            <button disabled={!state.server || state.comparing || state.saving} onClick={props.onReload} type="button">Discard local and reload latest</button>
          </div>
        </div>
      </div> : null}
    </section>
  }
})
