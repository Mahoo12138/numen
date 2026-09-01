import '@numen/connections'
import '@numen/credentials'
import type { NumenValue } from '@numen/core'
import {
  ConnectionConflictError,
  ConnectionNotFoundError,
  type Connection,
  type ConnectionAdapterDefinition,
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
  workbenchCreateConnectionActionRef,
  workbenchDeleteConnectionActionRef,
  workbenchSetConnectionEnabledActionRef,
  workbenchUpdateConnectionActionRef,
  type WorkbenchConnectionAdapter,
  type WorkbenchConnectionStatus,
  type WorkbenchConnectionsIndex,
  type WorkbenchCreateConnectionInput,
  type WorkbenchCreateConnectionResult,
  type WorkbenchDeleteConnectionInput,
  type WorkbenchDeleteConnectionResult,
  type WorkbenchSetConnectionEnabledInput,
  type WorkbenchSetConnectionEnabledResult,
  type WorkbenchUpdateConnectionInput,
  type WorkbenchUpdateConnectionResult,
} from './contracts.js'
import { projectWorkbenchConnection } from './connection-projection.js'
import { projectObjectSchema, workbenchSchemaFieldSchema } from './schema-field-projection.js'

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
  config: z.any<Record<string, NumenValue>>().required(),
  credentialId: z.string(),
  status: connectionStatus,
  statusDetail: z.string().required(),
  generation: z.number().required(),
  createdAt: z.string().required(),
  updatedAt: z.string().required(),
})

const connectionAdapterSchema = z.object({
  id: z.string().required(),
  version: z.number().step(1).min(1).required(),
  title: z.string().required(),
  providerAvailable: z.boolean().required(),
  configFields: z.array(workbenchSchemaFieldSchema).required(),
  configSchemaSupported: z.boolean().required(),
  credentialType: z.string(),
  credentials: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    secretVersion: z.number().step(1).min(1).required(),
    typeAvailable: z.boolean().required(),
  })).required(),
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
    adapters: z.array(connectionAdapterSchema).required(),
  }),
}

const connectionConfigSchema = z.any<Record<string, NumenValue>>().required()

export const workbenchCreateConnectionAction: ConsoleActionDefinition<
  WorkbenchCreateConnectionInput,
  WorkbenchCreateConnectionResult
> = {
  ...workbenchCreateConnectionActionRef,
  kind: 'action',
  title: 'Create Connection',
  description: 'Create validated durable Connection configuration in the disabled desired state.',
  input: z.object({
    name: z.string().required(),
    adapterId: z.string().required(),
    adapterVersion: z.number().step(1).min(1).required(),
    config: connectionConfigSchema,
    credentialId: z.string(),
  }),
  output: z.object({ connection: connectionIndexItemSchema.required() }),
}

export const workbenchUpdateConnectionAction: ConsoleActionDefinition<
  WorkbenchUpdateConnectionInput,
  WorkbenchUpdateConnectionResult
> = {
  ...workbenchUpdateConnectionActionRef,
  kind: 'action',
  title: 'Update Connection',
  description: 'Update validated Connection configuration using generation fencing.',
  input: z.object({
    connectionId: z.string().required(),
    expectedGeneration: z.number().step(1).min(1).required(),
    name: z.string().required(),
    config: connectionConfigSchema,
    credentialId: z.string(),
  }),
  output: z.object({ connection: connectionIndexItemSchema.required() }),
}

export const workbenchDeleteConnectionAction: ConsoleActionDefinition<
  WorkbenchDeleteConnectionInput,
  WorkbenchDeleteConnectionResult
> = {
  ...workbenchDeleteConnectionActionRef,
  kind: 'action',
  title: 'Delete Connection',
  description: 'Delete durable Connection configuration using generation fencing.',
  input: z.object({
    connectionId: z.string().required(),
    expectedGeneration: z.number().step(1).min(1).required(),
  }),
  output: z.object({ connectionId: z.string().required() }),
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
  if (error instanceof TypeError
    || (error instanceof Error && /^(connection adapter|credential).* (not found|unavailable)/.test(error.message))) {
    throw new ConsoleProcedureError(422, 'CONNECTION_INVALID', error.message)
  }
  throw error
}

function projectAdapter(ctx: Context, definition: ConnectionAdapterDefinition): WorkbenchConnectionAdapter {
  const config = projectObjectSchema(definition.config)
  return {
    id: definition.id,
    version: definition.version,
    title: definition.title,
    providerAvailable: !!ctx.connections.resolveAdapterProvider(definition),
    configFields: config.fields,
    configSchemaSupported: config.supported,
    ...(definition.credentialType ? { credentialType: definition.credentialType } : {}),
    credentials: definition.credentialType
      ? ctx.credentials.list()
          .filter(credential => credential.type.id === definition.credentialType)
          .map(credential => ({
            id: credential.id,
            name: credential.name,
            secretVersion: credential.secretVersion,
            typeAvailable: credential.typeAvailable,
          }))
      : [],
  }
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
        adapters: ctx.connections.listAdapters().map(definition => projectAdapter(ctx, definition)),
      }
    },
  })
  ctx.console.provideAction(ctx, workbenchCreateConnectionActionRef, {
    action({ input }: { input: WorkbenchCreateConnectionInput }): WorkbenchCreateConnectionResult {
      try {
        const connection = ctx.connections.create({
          name: input.name,
          adapter: { id: input.adapterId, version: input.adapterVersion },
          config: input.config,
          ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        })
        return { connection: projectConnection(ctx, connection) }
      } catch (error) {
        return raisePublicConnectionError(error)
      }
    },
  })
  ctx.console.provideAction(ctx, workbenchUpdateConnectionActionRef, {
    action({ input }: { input: WorkbenchUpdateConnectionInput }): WorkbenchUpdateConnectionResult {
      try {
        const connection = ctx.connections.update({
          id: input.connectionId,
          expectedGeneration: input.expectedGeneration,
          name: input.name,
          config: input.config,
          credentialId: input.credentialId ?? null,
        })
        return { connection: projectConnection(ctx, connection) }
      } catch (error) {
        return raisePublicConnectionError(error)
      }
    },
  })
  ctx.console.provideAction(ctx, workbenchDeleteConnectionActionRef, {
    action({ input }: { input: WorkbenchDeleteConnectionInput }): WorkbenchDeleteConnectionResult {
      try {
        ctx.connections.remove(input.connectionId, input.expectedGeneration)
        return { connectionId: input.connectionId }
      } catch (error) {
        return raisePublicConnectionError(error)
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

workbenchConnectionsProviderPlugin.inject = ['workbench', 'console', 'connections', 'credentials']

export default workbenchConnectionsProviderPlugin
