import { shallowReactive } from 'vue'
import {
  workbenchAutomationDetailQueryRef,
  workbenchSaveAutomationDraftCopyActionRef,
  type WorkbenchAutomationDetail,
  type WorkbenchAutomationDetailQueryInput,
  type WorkbenchAutomationDraft,
  type WorkbenchSaveAutomationDraftCopyInput,
  type WorkbenchSaveAutomationDraftCopyResult,
} from './contracts.js'
import type { WorkbenchConsoleClient } from './types.js'
import type { AutomationDraftDocument } from './useAutomationDraftDocument.js'

export function createDraftConflictRecovery(client: WorkbenchConsoleClient, document: AutomationDraftDocument, minimumServerVersion: number) {
  const local: AutomationDraftDocument = JSON.parse(JSON.stringify(document))
  const state = shallowReactive({
    comparing: false,
    server: undefined as WorkbenchAutomationDraft | undefined,
    compareError: undefined as string | undefined,
    saving: false,
    copy: undefined as WorkbenchSaveAutomationDraftCopyResult | undefined,
    copyError: undefined as string | undefined,
    request: undefined as WorkbenchSaveAutomationDraftCopyInput | undefined,
  })
  let disposed = false
  let queryController: AbortController | undefined
  let copyController: AbortController | undefined
  return {
    local,
    state,
    async compare(): Promise<void> {
      if (disposed) return
      queryController?.abort()
      const controller = new AbortController()
      queryController = controller
      state.comparing = true
      state.compareError = undefined
      try {
        const detail = await client.query<WorkbenchAutomationDetailQueryInput, WorkbenchAutomationDetail | null>(
          workbenchAutomationDetailQueryRef, { automationId: local.automationId }, controller.signal,
        )
        if (disposed || controller.signal.aborted) return
        if (!detail || detail.automation.id !== local.automationId) throw new Error('The original Automation is no longer available.')
        if (detail.draft.version < Math.max(minimumServerVersion, state.server?.version ?? 0)) throw new Error('The server returned an older Draft. Refresh the comparison.')
        state.server = detail.draft
      } catch (error) {
        if (!disposed && !controller.signal.aborted) state.compareError = error instanceof Error ? error.message : 'Could not load the server Draft.'
      } finally {
        if (!disposed && !controller.signal.aborted) state.comparing = false
      }
    },
    async saveCopy(name: string): Promise<void> {
      if (disposed || state.saving || state.copy) return
      if (!state.request && (!name.trim() || name.trim().length > 200)) {
        state.copyError = 'Enter a copy name with 1 to 200 characters.'
        return
      }
      // Keep the exact request after uncertain failures. A retry must not create another Automation.
      state.request ??= {
        requestId: globalThis.crypto.randomUUID(), automationId: local.automationId, name: name.trim(),
        source: local.source, presentation: local.presentation,
      }
      const controller = new AbortController()
      copyController = controller
      state.saving = true
      state.copyError = undefined
      try {
        const result = await client.action<WorkbenchSaveAutomationDraftCopyInput, WorkbenchSaveAutomationDraftCopyResult>(
          workbenchSaveAutomationDraftCopyActionRef, state.request, controller.signal,
        )
        if (!disposed && !controller.signal.aborted) state.copy = result
      } catch (error) {
        if (!disposed && !controller.signal.aborted) state.copyError = error instanceof Error ? error.message : 'Could not save the copy. Retry to check the same request.'
      } finally {
        if (!disposed && !controller.signal.aborted) state.saving = false
      }
    },
    dispose() {
      disposed = true
      queryController?.abort()
      copyController?.abort()
    },
  }
}
