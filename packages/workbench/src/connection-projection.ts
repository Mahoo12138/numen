import type { Connection, ConnectionRuntimeState } from '@numen/connections'
import type { WorkbenchConnectionIndexItem, WorkbenchConnectionStatus } from './contracts.js'

function connectionStatus(connection: Connection, runtime: ConnectionRuntimeState): WorkbenchConnectionStatus {
  if (!connection.enabled) return 'DISABLED'
  if (!connection.adapterAvailable) return 'UNAVAILABLE'
  return runtime.status
}

function statusDetail(status: WorkbenchConnectionStatus): string {
  switch (status) {
    case 'DISABLED': return 'Disabled by configuration'
    case 'UNAVAILABLE': return 'Adapter provider unavailable'
    case 'STOPPED': return 'Runtime is stopped'
    case 'STARTING': return 'Runtime is starting'
    case 'READY': return 'Runtime is ready'
    case 'ERROR': return 'Runtime failed to start'
    case 'STOPPING': return 'Runtime is stopping'
  }
}

/** Projects one Connection without exposing credential secrets or runtime errors. */
export function projectWorkbenchConnection(
  connection: Connection,
  runtime: ConnectionRuntimeState,
  adapterTitle: string,
): WorkbenchConnectionIndexItem {
  const status = connectionStatus(connection, runtime)
  return {
    id: connection.id,
    name: connection.name,
    adapterId: connection.adapter.id,
    adapterVersion: connection.adapter.version,
    adapterTitle,
    enabled: connection.enabled,
    adapterAvailable: connection.adapterAvailable,
    credentialBound: !!connection.credentialId,
    config: connection.config,
    ...(connection.credentialId ? { credentialId: connection.credentialId } : {}),
    status,
    statusDetail: statusDetail(status),
    generation: connection.generation,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  }
}
