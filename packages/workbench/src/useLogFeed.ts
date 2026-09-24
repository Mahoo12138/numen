import { logsChangedRef, logsQueryRef, type LogQuery, type LogSnapshot } from '@numenjs/logging/contracts'
import { ref, shallowRef, toValue, watchEffect, type MaybeRefOrGetter } from 'vue'
import type { WorkbenchConsoleClient } from './types.js'

/** Reconnects replace a bounded snapshot. Lifecycle fences protect against late Query results. */
export function useLogFeed(client: MaybeRefOrGetter<WorkbenchConsoleClient | undefined>, query: MaybeRefOrGetter<LogQuery>, follow: MaybeRefOrGetter<boolean>) {
  const snapshot = shallowRef<LogSnapshot>()
  const loading = ref(false)
  const failed = ref(false)
  const live = ref(false)
  const retry = ref(0)
  watchEffect(onCleanup => {
    const currentClient = toValue(client), input = { ...toValue(query) }, following = toValue(follow)
    retry.value
    const lifecycle = new AbortController()
    let current: AbortController | undefined
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let fetching = false
    let pendingRefresh = false
    snapshot.value = undefined
    failed.value = false
    live.value = false
    if (!currentClient) { loading.value = false; return }
    const fetch = () => {
      if (fetching) { pendingRefresh = true; return }
      fetching = true
      const request = current = new AbortController()
      loading.value = true
      void currentClient.query<LogQuery, LogSnapshot>(logsQueryRef, input, request.signal).then(value => {
        if (!request.signal.aborted && !lifecycle.signal.aborted) { snapshot.value = value; failed.value = false }
      }, () => {
        if (!request.signal.aborted && !lifecycle.signal.aborted) failed.value = true
      }).finally(() => {
        fetching = false
        if (request.signal.aborted || lifecycle.signal.aborted) return
        loading.value = false
        if (pendingRefresh) { pendingRefresh = false; refresh() }
      })
    }
    const refresh = () => {
      if (lifecycle.signal.aborted || timer) return
      timer = setTimeout(() => { timer = undefined; fetch() }, 200)
    }
    fetch()
    if (following) void currentClient.subscribe(logsChangedRef, {}, { event: refresh }, lifecycle.signal).then(dispose => {
      if (lifecycle.signal.aborted) { dispose(); return }
      unsubscribe = dispose
      live.value = true
      refresh()
    }, () => { if (!lifecycle.signal.aborted) { live.value = false; failed.value = true } })
    onCleanup(() => { lifecycle.abort(); current?.abort(); clearTimeout(timer); unsubscribe?.() })
  })
  return { snapshot, loading, failed, live, reload: () => { retry.value++ } }
}
