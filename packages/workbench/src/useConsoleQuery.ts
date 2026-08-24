import type { ConsoleProcedureRef } from '@numen/console'
import { shallowReactive, toValue, watchEffect, type MaybeRefOrGetter } from 'vue'
import {
  workbenchInvalidationSubscriptionRef,
  type WorkbenchInvalidationEvent,
  type WorkbenchInvalidationScope,
} from './contracts.js'
import type { WorkbenchConsoleClient } from './types.js'

export type ConsoleQueryState<Output> =
  | { status: 'DISABLED' }
  | { status: 'LOADING' }
  | { status: 'READY'; data: Output }
  | { status: 'ERROR'; message: string }

export function useConsoleQuery<Input, Output>(
  client: MaybeRefOrGetter<WorkbenchConsoleClient | undefined>,
  ref: ConsoleProcedureRef,
  input: MaybeRefOrGetter<Input>,
  invalidationScope?: WorkbenchInvalidationScope,
): [ConsoleQueryState<Output>, () => void] {
  const state = shallowReactive<ConsoleQueryState<Output>>(
    toValue(client) ? { status: 'LOADING' } : { status: 'DISABLED' },
  )
  let reloadCurrent: () => void = () => {}
  const reload = () => reloadCurrent()
  const setState = (next: ConsoleQueryState<Output>) => {
    delete (state as Partial<{ data: Output }>).data
    delete (state as Partial<{ message: string }>).message
    Object.assign(state, next)
  }

  watchEffect((onCleanup) => {
    const resolvedClient = toValue(client)
    const resolvedInput = toValue(input)
    if (!resolvedClient) {
      reloadCurrent = () => {}
      setState({ status: 'DISABLED' })
      return
    }
    const lifecycle = new AbortController()
    let queryController: AbortController | undefined
    let unsubscribe: (() => void) | undefined
    let acceptInvalidations = false

    const execute = (foreground: boolean) => {
      queryController?.abort()
      const controller = new AbortController()
      queryController = controller
      if (foreground) setState({ status: 'LOADING' })
      void resolvedClient.query<Input, Output>(ref, resolvedInput, controller.signal).then(
        data => {
          if (!controller.signal.aborted && !lifecycle.signal.aborted) setState({ status: 'READY', data })
        },
        error => {
          if (controller.signal.aborted || lifecycle.signal.aborted) return
          setState({
            status: 'ERROR',
            message: error instanceof Error ? error.message : 'The Console Query failed.',
          })
        },
      )
    }
    reloadCurrent = () => execute(true)

    void (async () => {
      if (invalidationScope) {
        try {
          unsubscribe = await resolvedClient.subscribe<Record<string, never>, WorkbenchInvalidationEvent>(
            workbenchInvalidationSubscriptionRef,
            {},
            {
              event: event => {
                if (acceptInvalidations && event.scopes.includes(invalidationScope)) execute(false)
              },
            },
            lifecycle.signal,
          )
        } catch {
          if (lifecycle.signal.aborted) return
        }
      }
      if (lifecycle.signal.aborted) return
      acceptInvalidations = true
      execute(true)
    })()

    onCleanup(() => {
      reloadCurrent = () => {}
      lifecycle.abort()
      queryController?.abort()
      unsubscribe?.()
    })
  })

  return [state, reload]
}
