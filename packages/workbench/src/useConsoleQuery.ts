import type { ConsoleProcedureRef } from '@numen/console'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  client: WorkbenchConsoleClient | undefined,
  ref: ConsoleProcedureRef,
  input: Input,
  invalidationScope?: WorkbenchInvalidationScope,
): [ConsoleQueryState<Output>, () => void] {
  const [state, setState] = useState<ConsoleQueryState<Output>>(
    client ? { status: 'LOADING' } : { status: 'DISABLED' },
  )
  const reloadRef = useRef<() => void>(() => {})
  const reload = useCallback(() => reloadRef.current(), [])

  useEffect(() => {
    if (!client) {
      reloadRef.current = () => {}
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
      void client.query<Input, Output>(ref, input, controller.signal).then(
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
    reloadRef.current = () => execute(true)

    void (async () => {
      if (invalidationScope) {
        try {
          unsubscribe = await client.subscribe<Record<string, never>, WorkbenchInvalidationEvent>(
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

    return () => {
      reloadRef.current = () => {}
      lifecycle.abort()
      queryController?.abort()
      unsubscribe?.()
    }
  }, [client, input, invalidationScope, ref.id, ref.version])

  return [state, reload]
}
