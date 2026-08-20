import type { ConsoleProcedureRef } from '@numen/console'
import { useCallback, useEffect, useState } from 'react'
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
): [ConsoleQueryState<Output>, () => void] {
  const [reloadGeneration, setReloadGeneration] = useState(0)
  const [state, setState] = useState<ConsoleQueryState<Output>>(
    client ? { status: 'LOADING' } : { status: 'DISABLED' },
  )
  const reload = useCallback(() => setReloadGeneration(value => value + 1), [])

  useEffect(() => {
    if (!client) {
      setState({ status: 'DISABLED' })
      return
    }
    const controller = new AbortController()
    setState({ status: 'LOADING' })
    void client.query<Input, Output>(ref, input, controller.signal).then(
      data => {
        if (!controller.signal.aborted) setState({ status: 'READY', data })
      },
      error => {
        if (controller.signal.aborted) return
        setState({
          status: 'ERROR',
          message: error instanceof Error ? error.message : 'The Console Query failed.',
        })
      },
    )
    return () => controller.abort()
  }, [client, input, ref.id, ref.version, reloadGeneration])

  return [state, reload]
}
