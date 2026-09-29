import { onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { workbenchExecutionDataQueryRef, type WorkbenchExecutionData, type WorkbenchExecutionDataInput } from './contracts.js'
import type { WorkbenchConsoleClient } from './types.js'

export type ExecutionDataState = { status: 'CLOSED' | 'LOADING' | 'ERROR' } | { status: 'READY'; data: WorkbenchExecutionData }

/** Deliberately does not subscribe, prefetch, cache, persist, or expose payloads to navigation. */
export function useExecutionData(client: MaybeRefOrGetter<WorkbenchConsoleClient | undefined>, runId: MaybeRefOrGetter<string>) {
  const state = shallowRef<ExecutionDataState>({ status: 'CLOSED' })
  let current: AbortController | undefined
  const close = () => {
    current?.abort()
    current = undefined
    state.value = { status: 'CLOSED' }
  }
  watch(() => [toValue(runId), toValue(client)], close, { flush: 'sync' })
  onScopeDispose(close)
  const open = (executionId: string, attemptId?: string) => {
    close()
    const resolvedClient = toValue(client)
    const id = toValue(runId)
    if (!resolvedClient || !id) return
    const controller = new AbortController()
    current = controller
    state.value = { status: 'LOADING' }
    void resolvedClient.query<WorkbenchExecutionDataInput, WorkbenchExecutionData>(workbenchExecutionDataQueryRef,
      { runId: id, executionId, ...(attemptId ? { attemptId } : {}) }, controller.signal).then(data => {
      if (current !== controller || controller.signal.aborted) return
      state.value = { status: 'READY', data }
    }, () => {
      if (current === controller && !controller.signal.aborted) state.value = { status: 'ERROR' }
    })
  }
  return { state, open, close }
}
