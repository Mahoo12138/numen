import { describe, expect, it, vi } from 'vitest'
import type {
  WorkbenchConnectionIndexItem,
  WorkbenchSetConnectionEnabledInput,
  WorkbenchSetConnectionEnabledResult,
} from '../src/contracts.js'
import type { WorkbenchConsoleClient } from '../src/types.js'
import { createConnectionDesiredState } from '../src/useConnectionDesiredState.js'

const connection: WorkbenchConnectionIndexItem = {
  id: 'connection:mail',
  name: 'Mail',
  adapterId: 'mail',
  adapterVersion: 1,
  adapterTitle: 'Mail',
  enabled: false,
  adapterAvailable: true,
  credentialBound: true,
  config: {},
  status: 'DISABLED',
  statusDetail: 'Disabled by configuration.',
  generation: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

function clientWithAction(
  action: WorkbenchConsoleClient['action'],
): WorkbenchConsoleClient {
  return {
    action,
    query: vi.fn(),
    subscribe: vi.fn(),
  }
}

describe('Connection desired-state projection', () => {
  it('projects one optimistic intent and reconciles the confirmed generation', async () => {
    let resolveAction!: (result: WorkbenchSetConnectionEnabledResult) => void
    const action = vi.fn<WorkbenchConsoleClient['action']>(() => new Promise(resolve => {
      resolveAction = resolve as (result: WorkbenchSetConnectionEnabledResult) => void
    }))
    const refresh = vi.fn()
    const state = createConnectionDesiredState(clientWithAction(action), refresh)

    state.setEnabled(connection, true)
    state.setEnabled(connection, true)

    expect(state.view(connection)).toEqual({ enabled: true, requestedEnabled: true, pending: true })
    expect(action).toHaveBeenCalledOnce()
    expect(action.mock.calls[0]?.[1]).toEqual<WorkbenchSetConnectionEnabledInput>({
      connectionId: connection.id,
      expectedGeneration: 1,
      enabled: true,
    })

    const confirmed = { ...connection, enabled: true, generation: 2, status: 'STARTING' as const }
    resolveAction({ connection: confirmed })
    await Promise.resolve()
    await Promise.resolve()

    expect(state.view(connection)).toEqual({ enabled: true, pending: false })
    expect(state.view(confirmed)).toEqual({ enabled: true, requestedEnabled: true, pending: false })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('refreshes after a generation conflict and retries against the latest item', async () => {
    const conflict = Object.assign(new Error('The Connection changed'), {
      code: 'CONNECTION_GENERATION_CONFLICT',
    })
    const action = vi.fn<WorkbenchConsoleClient['action']>()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ connection: { ...connection, generation: 3 } })
    const refresh = vi.fn()
    const state = createConnectionDesiredState(clientWithAction(action), refresh)
    const initiallyEnabled = { ...connection, enabled: true }

    state.setEnabled(initiallyEnabled, false)
    await Promise.resolve()
    await Promise.resolve()

    expect(state.view(initiallyEnabled)).toMatchObject({
      enabled: true,
      requestedEnabled: false,
      pending: false,
      error: 'This Connection changed elsewhere. Review the refreshed state and try again.',
    })
    expect(refresh).toHaveBeenCalledOnce()

    expect(state.view({ ...initiallyEnabled, enabled: false, generation: 2 })).toEqual({
      enabled: false,
      pending: false,
    })

    const refreshed = { ...initiallyEnabled, generation: 2 }
    state.retry(refreshed)
    await Promise.resolve()
    await Promise.resolve()

    expect(action.mock.calls[1]?.[1]).toMatchObject({ expectedGeneration: 2, enabled: false })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('aborts in-flight work when its owning Vue scope is disposed', () => {
    let signal: AbortSignal | undefined
    const action = vi.fn<WorkbenchConsoleClient['action']>((_ref, _input, actionSignal) => {
      signal = actionSignal
      return new Promise(() => {})
    })
    const state = createConnectionDesiredState(clientWithAction(action), vi.fn())

    state.setEnabled(connection, true)
    state.dispose()

    expect(signal?.aborted).toBe(true)
    expect(state.view(connection)).toEqual({ enabled: false, pending: false })
  })
})
