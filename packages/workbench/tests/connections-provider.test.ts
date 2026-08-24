import {
  ConsoleProcedureError,
  ConsoleProcedureUnavailableError,
  ConsoleService,
  type ConsoleRequestContext,
} from '@numen/console'
import { ConnectionService } from '@numen/connections'
import { CredentialService } from '@numen/credentials'
import { DatabaseService } from '@numen/database'
import { Context, type Logger } from 'cordis'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import {
  workbenchConnectionsIndexQuery,
  workbenchConnectionsProviderPlugin,
  workbenchSetConnectionEnabledAction,
} from '../src/connections-provider.js'

function request(): ConsoleRequestContext {
  return {
    requestId: 'connection-action-request',
    principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
    signal: new AbortController().signal,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger,
  }
}

describe('Workbench Connections Provider', () => {
  it('projects and changes desired state with generation fencing and public errors', async () => {
    const root = new Context()
    await root.plugin(DatabaseService, { path: ':memory:' })
    await root.plugin(CredentialService)
    await root.plugin(ConnectionService)
    await root.plugin(ConsoleService)
    root.console.define(root, workbenchConnectionsIndexQuery)
    root.console.define(root, workbenchSetConnectionEnabledAction)
    const providerPlugin = (ctx: Context) => workbenchConnectionsProviderPlugin(ctx)
    providerPlugin.inject = ['console', 'connections']
    const provider = await root.plugin(providerPlugin)
    const adapter = { id: 'test:http', version: 1, title: 'HTTP Adapter', config: z.object({}) }
    root.connections.defineAdapter(root, adapter)
    root.connections.provideAdapter(root, adapter, { async open() {} })
    const created = root.connections.create({ name: 'Primary API', adapter, config: {} })

    expect(await root.console.query(workbenchConnectionsIndexQuery, {}, request())).toMatchObject({
      summary: { total: 1, enabled: 0, ready: 0 },
      items: [expect.objectContaining({
        id: created.id,
        adapterTitle: 'HTTP Adapter',
        enabled: false,
        generation: 1,
        status: 'DISABLED',
      })],
    })

    const enabled = await root.console.action(workbenchSetConnectionEnabledAction, {
      connectionId: created.id,
      expectedGeneration: 1,
      enabled: true,
    }, request())
    expect(enabled.connection).toMatchObject({ enabled: true, generation: 2 })

    const idempotent = await root.console.action(workbenchSetConnectionEnabledAction, {
      connectionId: created.id,
      expectedGeneration: 2,
      enabled: true,
    }, request())
    expect(idempotent.connection).toMatchObject({ enabled: true, generation: 2 })

    await expect(root.console.action(workbenchSetConnectionEnabledAction, {
      connectionId: created.id,
      expectedGeneration: 1,
      enabled: false,
    }, request())).rejects.toMatchObject<Partial<ConsoleProcedureError>>({
      status: 409,
      code: 'CONNECTION_GENERATION_CONFLICT',
      details: { expectedGeneration: 1, actualGeneration: 2 },
    })
    await expect(root.console.action(workbenchSetConnectionEnabledAction, {
      connectionId: 'conn_missing',
      expectedGeneration: 1,
      enabled: true,
    }, request())).rejects.toMatchObject<Partial<ConsoleProcedureError>>({
      status: 404,
      code: 'CONNECTION_NOT_FOUND',
    })

    await provider.dispose()
    await expect(root.console.action(workbenchSetConnectionEnabledAction, {
      connectionId: created.id,
      expectedGeneration: 2,
      enabled: false,
    }, request())).rejects.toThrow(ConsoleProcedureUnavailableError)
    await root.fiber.dispose()
  })
})
