import { inject, provide, reactive, ref, type InjectionKey } from 'vue'

export interface AutomationFieldDraftState {
  dirty: boolean
  invalid: boolean
}

/** Tracks pending field state only. The actual text stays in its editor. */
export interface AutomationInputSession {
  readonly hasUncommitted: boolean
  readonly hasInvalid: boolean
  /** Changes only when pending field input is explicitly discarded. Editors reset from Source. */
  readonly discardEpoch: number
  setField(key: string, state: AutomationFieldDraftState): void
  removeField(key: string): void
  confirmDiscard(): boolean
  discard(): void
  clear(): void
}

const inputSessionKey: InjectionKey<AutomationInputSession> = Symbol('automation-input-session')

export function createAutomationInputSession(confirm: () => boolean): AutomationInputSession {
  const fields = reactive(new Map<string, AutomationFieldDraftState>())
  const discardEpoch = ref(0)
  const session: AutomationInputSession = {
    get hasUncommitted() { return [...fields.values()].some(field => field.dirty || field.invalid) },
    get hasInvalid() { return [...fields.values()].some(field => field.invalid) },
    get discardEpoch() { return discardEpoch.value },
    setField(key, state) {
      const previous = fields.get(key)
      if (previous?.dirty === state.dirty && previous.invalid === state.invalid) return
      if (state.dirty || state.invalid) fields.set(key, { ...state })
      else fields.delete(key)
    },
    removeField(key) { fields.delete(key) },
    confirmDiscard() {
      if (!session.hasUncommitted) return true
      if (!confirm()) return false
      session.discard()
      return true
    },
    discard() { fields.clear(); discardEpoch.value += 1 },
    clear() { fields.clear() },
  }
  return session
}

export function provideAutomationInputSession(session: AutomationInputSession): void {
  provide(inputSessionKey, session)
}

export function useAutomationInputSession(): AutomationInputSession | undefined {
  return inject(inputSessionKey, undefined)
}

export function automationDocumentNeedsProtection(phase: string, pendingInput = false, publishing = false): boolean {
  return pendingInput || publishing || phase === 'DIRTY' || phase === 'SAVING' || phase === 'ERROR' || phase === 'CONFLICT'
}
