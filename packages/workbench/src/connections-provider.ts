import '@numen/connections'
import {
  ConnectionConflictError,
  ConnectionNotFoundError,
  type Connection,
} from '@numen/connections'
import {
  ConsoleProcedureError,
  type ConsoleActionDefinition,
  type ConsoleQueryDefinition,
} from '@numen/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchConnectionsIndexQueryRef,
  workbenchSetConnectionEnabledActionRef,
  type WorkbenchConnectionStatus,
  type WorkbenchConnectionsIndex,
  type WorkbenchSetConnectionEnabledInput,
  type WorkbenchSetConnectionEnabledResult,
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

const connectionIndexItemSchema = z.object({
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
})

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
    items: z.array(connectionIndexItemSchema).required(),
  }),
}

export const workbenchSetConnectionEnabledAction: ConsoleActionDefinition<
  WorkbenchSetConnectionEnabledInput,
  WorkbenchSetConnectionEnabledResult
> = {
  ...workbenchSetConnectionEnabledActionRef,
  kind: 'action',
  title: 'Set Connection enabled state',
  description: 'Optimistically update durable Connection desired state using generation fencing.',
  input: z.object({
    connectionId: z.string().required(),
    expectedGeneration: z.number().step(1).min(1).required(),
    enabled: z.boolean().required(),
  }),
  output: z.object({
    connection: connectionIndexItemSchema.required(),
  }),
}

function projectConnection(ctx: Context, connection: Connection) {
  const runtime = ctx.connections.getRuntimeState(connection.id)
  const adapter = ctx.connections.getAdapter(connection.adapter)
  return projectWorkbenchConnection(connection, runtime, adapter?.title ?? connection.adapter.id)
}

function raisePublicConnectionError(error: unknown): never {
  if (error instanceof ConnectionConflictError) {
    throw new ConsoleProcedureError(409, 'CONNECTION_GENERATION_CONFLICT', 'The Connection changed', {
      expectedGeneration: error.expectedGeneration,
      actualGeneration: error.actualGeneration,
    })
  }
  if (error instanceof ConnectionNotFoundError) {
    throw new ConsoleProcedureError(404, 'CONNECTION_NOT_FOUND', 'The Connection was not found')
  }
  throw error
}

export function workbenchConnectionsProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchConnectionsIndexQueryRef, {
    query(): WorkbenchConnectionsIndex {
      const items = ctx.connections.list().map(connection => projectConnection(ctx, connection))
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
  ctx.console.provideAction(ctx, workbenchSetConnectionEnabledActionRef, {
    action({ input }: { input: WorkbenchSetConnectionEnabledInput }): WorkbenchSetConnectionEnabledResult {
      try {
        const connection = ctx.connections.setEnabled(
          input.connectionId,
          input.expectedGeneration,
          input.enabled,
        )
        return { connection: projectConnection(ctx, connection) }
      } catch (error) {
        return raisePublicConnectionError(error)
      }
    },
  })
}

workbenchConnectionsProviderPlugin.inject = ['workbench', 'console', 'connections']

export default workbenchConnectionsProviderPlugin
