import { onScopeDispose, shallowReactive, toValue, type MaybeRefOrGetter } from 'vue'
import {
  workbenchSetConnectionEnabledActionRef,
  type WorkbenchConnectionIndexItem,
  type WorkbenchSetConnectionEnabledInput,
  type WorkbenchSetConnectionEnabledResult,
} from './contracts.js'
import type { WorkbenchConsoleClient } from './types.js'

interface ConnectionMutation {
  requestedEnabled: boolean
  pending: boolean
  confirmed?: WorkbenchConnectionIndexItem
  error?: string
}

export interface ConnectionDesiredStateView {
  enabled: boolean
  pending: boolean
  requestedEnabled?: boolean
  error?: string
}

export interface ConnectionDesiredState {
  view(connection: WorkbenchConnectionIndexItem): ConnectionDesiredStateView
  setEnabled(connection: WorkbenchConnectionIndexItem, enabled: boolean): void
  retry(connection: WorkbenchConnectionIndexItem): void
  dispose(): void
}

export function createConnectionDesiredState(
  client: MaybeRefOrGetter<WorkbenchConsoleClient | undefined>,
  refresh: () => void,
): ConnectionDesiredState {
  const mutations = shallowReactive(new Map<string, ConnectionMutation>())
  const controllers = new Map<string, AbortController>()
  let disposed = false

  const effectiveConnection = (connection: WorkbenchConnectionIndexItem): WorkbenchConnectionIndexItem => {
    const confirmed = mutations.get(connection.id)?.confirmed
    return confirmed && confirmed.generation > connection.generation ? confirmed : connection
  }

  const setEnabled = (connection: WorkbenchConnectionIndexItem, enabled: boolean) => {
    if (disposed || mutations.get(connection.id)?.pending) return
    const resolvedClient = toValue(client)
    if (!resolvedClient) return
    const effective = effectiveConnection(connection)
    if (effective.enabled === enabled) return

    const controller = new AbortController()
    controllers.set(connection.id, controller)
    mutations.set(connection.id, { requestedEnabled: enabled, pending: true })
    const input: WorkbenchSetConnectionEnabledInput = {
      connectionId: connection.id,
      expectedGeneration: effective.generation,
      enabled,
    }
    void resolvedClient.action<WorkbenchSetConnectionEnabledInput, WorkbenchSetConnectionEnabledResult>(
      workbenchSetConnectionEnabledActionRef,
      input,
      controller.signal,
    ).then(
      result => {
        if (disposed || controller.signal.aborted) return
        mutations.set(connection.id, {
          requestedEnabled: result.connection.enabled,
          pending: false,
          confirmed: result.connection,
        })
        refresh()
      },
      error => {
        if (disposed || controller.signal.aborted) return
        mutations.set(connection.id, {
          requestedEnabled: enabled,
          pending: false,
          error: connectionMutationError(error),
        })
        refresh()
      },
    ).finally(() => {
      if (controllers.get(connection.id) === controller) controllers.delete(connection.id)
    })
  }

  return {
    view(connection) {
      const mutation = mutations.get(connection.id)
      if (!mutation) return { enabled: connection.enabled, pending: false }
      if (mutation.pending) {
        return {
          enabled: mutation.requestedEnabled,
          requestedEnabled: mutation.requestedEnabled,
          pending: true,
        }
      }
      if (mutation.confirmed && mutation.confirmed.generation > connection.generation) {
        return { enabled: mutation.confirmed.enabled, pending: false }
      }
      if (mutation.error && connection.enabled === mutation.requestedEnabled) {
        return { enabled: connection.enabled, pending: false }
      }
      return {
        enabled: connection.enabled,
        requestedEnabled: mutation.requestedEnabled,
        pending: false,
        ...(mutation.error ? { error: mutation.error } : {}),
      }
    },
    setEnabled,
    retry(connection) {
      const mutation = mutations.get(connection.id)
      if (!mutation || mutation.pending || !mutation.error) return
      setEnabled(connection, mutation.requestedEnabled)
    },
    dispose() {
      disposed = true
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      mutations.clear()
    },
  }
}

export function useConnectionDesiredState(
  client: MaybeRefOrGetter<WorkbenchConsoleClient | undefined>,
  refresh: () => void,
): ConnectionDesiredState {
  const state = createConnectionDesiredState(client, refresh)
  onScopeDispose(state.dispose)
  return state
}

function connectionMutationError(error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error
    ? String(error.code)
    : undefined
  if (code === 'CONNECTION_GENERATION_CONFLICT') {
    return 'This Connection changed elsewhere. Review the refreshed state and try again.'
  }
  if (code === 'CONNECTION_NOT_FOUND') {
    return 'This Connection no longer exists. Refresh the list.'
  }
  return error instanceof Error ? error.message : 'The Connection could not be updated. Try again.'
}
