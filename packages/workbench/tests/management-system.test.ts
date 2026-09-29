import { ConsoleService, type ConsoleRequestContext } from '@numenjs/console'
import { DatabaseService } from '@numenjs/database'
import { LoggingService } from '@numenjs/logging'
import { Context, type Logger } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { workbenchSystemProviderPlugin, workbenchSystemQuery } from '../src/system-provider.js'
import { sourceConnectionUsage } from '../src/connection-usage-provider.js'
import type { AutomationSource } from '@numenjs/core'

const request = (): ConsoleRequestContext => ({ requestId: 'health-test', principal: { authenticated: true, subject: { type: 'user', id: 'owner' } }, signal: new AbortController().signal, logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger })

describe('observed management state', () => {
  it('reports missing services and removes stale health on disposal, then observes replacement services', async () => {
    const root = new Context()
    await root.plugin(ConsoleService)
    root.console.define(root, workbenchSystemQuery)
    const plugin = (ctx: Context) => workbenchSystemProviderPlugin(ctx)
    plugin.inject = ['console']
    await root.plugin(plugin)
    const read = () => root.console.query(workbenchSystemQuery, {}, request())
    try {
      expect((await read()).checks.every(check => check.status === 'unavailable')).toBe(true)
      const database = await root.plugin(DatabaseService, { path: ':memory:' })
      const logging = await root.plugin(LoggingService, { console: false })
      await vi.waitFor(async () => expect((await read()).checks.find(check => check.id === 'storage')).toMatchObject({ status: 'ready', values: { migrationVersion: expect.any(Number) } }))
      const snapshot = await read()
      expect(snapshot.checks.find(check => check.id === 'logs')).toMatchObject({ status: 'ready', values: { persistence: 'disabled' } })
      expect(JSON.stringify(snapshot)).not.toContain('path')
      await database.dispose(); await logging.dispose()
      await vi.waitFor(async () => expect((await read()).checks.every(check => check.status === 'unavailable')).toBe(true))
      await root.plugin(DatabaseService, { path: ':memory:' })
      await vi.waitFor(async () => expect((await read()).checks.find(check => check.id === 'storage')?.status).toBe('ready'))
    } finally { await root.fiber.dispose() }
  })

  it('finds nested and trigger bindings without interpreting parameter payloads, and marks dynamic extensions incomplete', () => {
    const source: AutomationSource = {
      triggers: [{ id: 'event', capability: { id: 'test:event', version: 1 }, connections: { default: 'a' }, config: { connection: 'not-a-binding' } }],
      flow: { id: 'root', type: 'block', steps: [
        { id: 'loop', type: 'foreach', items: { type: 'literal', value: [] }, body: { id: 'body', type: 'block', steps: [
          { id: 'condition', type: 'if', condition: { type: 'literal', value: true }, then: { id: 'then', type: 'block', steps: [
            { id: 'invoke', type: 'capability', capability: { id: 'test:call', version: 1 }, connections: { client: 'b' }, input: { sample: { type: 'literal', value: 'not-a-binding' } } },
          ] } },
        ] } },
      ] },
    }
    expect(sourceConnectionUsage(source, 'a')).toEqual({ used: true, complete: true })
    expect(sourceConnectionUsage(source, 'b')).toEqual({ used: true, complete: true })
    expect(sourceConnectionUsage(source, 'not-a-binding')).toEqual({ used: false, complete: true })
    source.flow = { type: 'extension', id: 'dynamic', control: { id: 'test:dynamic', version: 1 }, input: {} }
    expect(sourceConnectionUsage(source, 'b')).toEqual({ used: false, complete: false })
  })
})
