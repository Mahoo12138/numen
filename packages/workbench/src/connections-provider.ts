import '@numen/connections'
import type { ConsoleQueryDefinition } from '@numen/console'
import type { Connection, ConnectionRuntimeState } from '@numen/connections'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchConnectionsIndexQueryRef,
  type WorkbenchConnectionStatus,
  type WorkbenchConnectionsIndex,
} from './contracts.js'

const connectionStatus = z.union([
  'DISABLED',
  'UNAVAILABLE',
  'STOPPED',
  'STARTING',
  'READY',
  'ERROR',
  'STOPPING',
]).required()

export const workbenchConnectionsIndexQuery: ConsoleQueryDefinition<Record<string, unknown>, WorkbenchConnectionsIndex> = {
  ...workbenchConnectionsIndexQueryRef,
  kind: 'query',
  title: 'Workbench Connections index',
  description: 'Durable Connection desired state with current Adapter and Runtime availability.',
  input: z.object({}),
  output: z.object({
    summary: z.object({
      total: z.number().required(),
      enabled: z.number().required(),
      ready: z.number().required(),
      unavailable: z.number().required(),
      errors: z.number().required(),
    }).required(),
    items: z.array(z.object({
      id: z.string().required(),
      name: z.string().required(),
      adapterId: z.string().required(),
      adapterVersion: z.number().required(),
      adapterTitle: z.string().required(),
      enabled: z.boolean().required(),
      adapterAvailable: z.boolean().required(),
      credentialBound: z.boolean().required(),
      status: connectionStatus,
      statusDetail: z.string().required(),
      generation: z.number().required(),
      createdAt: z.string().required(),
      updatedAt: z.string().required(),
    })).required(),
  }),
}

function projectStatus(connection: Connection, runtime: ConnectionRuntimeState): WorkbenchConnectionStatus {
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

export function workbenchConnectionsProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchConnectionsIndexQueryRef, {
    query(): WorkbenchConnectionsIndex {
      const items = ctx.connections.list().map(connection => {
        const runtime = ctx.connections.getRuntimeState(connection.id)
        const adapter = ctx.connections.getAdapter(connection.adapter)
        const status = projectStatus(connection, runtime)
        return {
          id: connection.id,
          name: connection.name,
          adapterId: connection.adapter.id,
          adapterVersion: connection.adapter.version,
          adapterTitle: adapter?.title ?? connection.adapter.id,
          enabled: connection.enabled,
          adapterAvailable: connection.adapterAvailable,
          credentialBound: !!connection.credentialId,
          status,
          statusDetail: statusDetail(status),
          generation: connection.generation,
          createdAt: connection.createdAt,
          updatedAt: connection.updatedAt,
        }
      })
      return {
        summary: {
          total: items.length,
          enabled: items.filter(item => item.enabled).length,
          ready: items.filter(item => item.status === 'READY').length,
          unavailable: items.filter(item => item.status === 'UNAVAILABLE').length,
          errors: items.filter(item => item.status === 'ERROR').length,
        },
        items,
      }
    },
  })
}

workbenchConnectionsProviderPlugin.inject = ['workbench', 'console', 'connections']

export default workbenchConnectionsProviderPlugin
