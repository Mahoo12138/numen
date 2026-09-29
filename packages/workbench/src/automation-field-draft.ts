import { onScopeDispose, ref, watch } from 'vue'
import type { SchemaDraftState } from '@numenjs/components'
import { useAutomationInputSession } from './automation-input-session.js'

/** The session stores only status; each renderer retains its own uncommitted text. */
export function useAutomationFieldDraft(nodeId: () => string, fieldPath: () => string) {
  const session = useAutomationInputSession()
  const state = ref<SchemaDraftState>({ dirty: false, invalid: false })
  let key = `${nodeId()}:${fieldPath()}`
  watch(() => `${nodeId()}:${fieldPath()}`, next => {
    session?.removeField(key)
    key = next
    state.value = { dirty: false, invalid: false }
  }, { flush: 'sync' })
  onScopeDispose(() => session?.removeField(key))
  return {
    state,
    get discardEpoch() { return session?.discardEpoch ?? 0 },
    report(next: SchemaDraftState) { state.value = next; session?.setField(key, next) },
    confirmDiscard() { return session?.confirmDiscard() ?? true },
  }
}
