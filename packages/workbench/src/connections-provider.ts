import '@numen/connections'
import type { ConsoleQueryDefinition } from '@numen/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchConnectionsIndexQueryRef,
  type WorkbenchConnectionStatus,
  type WorkbenchConnectionsIndex,
} from './contracts.js'
import { projectWorkbenchConnection } from './connection-projection.js'

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

export function workbenchConnectionsProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchConnectionsIndexQueryRef, {
    query(): WorkbenchConnectionsIndex {
      const items = ctx.connections.list().map(connection => {
        const runtime = ctx.connections.getRuntimeState(connection.id)
        const adapter = ctx.connections.getAdapter(connection.adapter)
        return projectWorkbenchConnection(connection, runtime, adapter?.title ?? connection.adapter.id)
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
