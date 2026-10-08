import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { workbenchAutomationRestoreContentQueryRef, type WorkbenchAutomationRestoreContent, type WorkbenchAutomationRestoreContentQueryInput } from './contracts.js'
import type { AutomationDraftDocumentModel } from './useAutomationDraftDocument.js'
import type { WorkbenchConsoleClient } from './types.js'

export type AutomationRestorationState =
  | { status: 'PREPARING'; snapshotId: string }
  | { status: 'READY'; snapshotId: string; content: WorkbenchAutomationRestoreContent }
  | { status: 'ERROR'; snapshotId: string; code: string }

export function useAutomationRestoration(options: {
  client(): WorkbenchConsoleClient | undefined
  automationId(): string | undefined
  authoring: AutomationDraftDocumentModel
  canPrepare(): boolean
  commitInputs(): boolean
  onApplied(): void
  refreshDetail(): void
}) {
  const state = shallowRef<AutomationRestorationState>()
  let controller: AbortController | undefined
  const close = () => { controller?.abort(); controller = undefined; state.value = undefined }
  onScopeDispose(close)
  watch(options.automationId, close, { flush: 'sync' })
  watch(options.client, close, { flush: 'sync' })
  const stale = computed(() => {
    const current = state.value
    if (current?.status !== 'READY') return false
    const draft = options.authoring.document
    return draft?.automationId !== current.content.automationId || draft.version !== current.content.expectedDraftVersion
      || !options.authoring.canReplaceFromSnapshot || !options.canPrepare()
  })
  const open = async (snapshotId: string) => {
    close()
    if (!/^(?:rev|snap)_[a-f0-9]{32}$/.test(snapshotId)) return
    const client = options.client(), automationId = options.automationId()
    if (!client || !automationId || !options.canPrepare() || !options.commitInputs()) return
    const pending = new AbortController()
    controller = pending
    state.value = { status: 'PREPARING', snapshotId }
    const current = () => controller === pending && !pending.signal.aborted && automationId === options.automationId() && client === options.client()
    try {
      if (!(await options.authoring.flushDraft(pending.signal))) {
        if (current()) state.value = { status: 'ERROR', snapshotId, code: 'DRAFT_NOT_SAVED' }
        return
      }
      if (!current()) return
      const draft = options.authoring.document
      if (!draft || draft.automationId !== automationId || !options.canPrepare() || !options.authoring.canReplaceFromSnapshot) {
        state.value = { status: 'ERROR', snapshotId, code: 'DRAFT_NOT_SAVED' }
        return
      }
      const expectedDraftVersion = draft.version
      const content = await client.query<WorkbenchAutomationRestoreContentQueryInput, WorkbenchAutomationRestoreContent>(
        workbenchAutomationRestoreContentQueryRef, { automationId, snapshotId, expectedDraftVersion }, pending.signal,
      )
      if (!current()) return
      if (content.automationId !== automationId || content.identity.automationId !== automationId || content.identity.id !== snapshotId || content.expectedDraftVersion !== expectedDraftVersion) throw new Error('Invalid restoration identity')
      state.value = { status: 'READY', snapshotId, content }
    } catch (error) {
      if (!current()) return
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'RESTORE_UNAVAILABLE'
      state.value = { status: 'ERROR', snapshotId, code }
      // Re-read a stale baseline without ever discarding local edits or replaying a write.
      if (code === 'DRAFT_VERSION_CONFLICT') options.refreshDetail()
    }
  }
  const apply = (): boolean => {
    const current = state.value
    if (current?.status !== 'READY' || stale.value || !options.commitInputs()) return false
    const content = current.content
    if (!options.authoring.replaceFromSnapshot({ automationId: content.automationId, expectedVersion: content.expectedDraftVersion, source: content.source, presentation: content.presentation })) return false
    close()
    options.onApplied()
    return true
  }
  return {
    get state() { return state.value },
    get locked() { return !!state.value },
    get stale() { return stale.value },
    open, close, apply,
    prepareAgain: () => { const snapshotId = state.value?.snapshotId; if (snapshotId) void open(snapshotId) },
  }
}
