import { LoggingService, withLogContext, logsQueryRef, logsChangedRef, type LogSnapshot } from '@numenjs/logging'
import { ConsoleService, type ConsoleRequestContext } from '@numenjs/console'
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { workbenchLogsChanged, workbenchLogsProviderPlugin, workbenchLogsQuery } from '../src/logs-provider.js'

describe('logs Console transport contract', () => {
  it('validates filters, coalesces floods behind a slow subscriber, restores reconnect snapshots, and cleans up on abort', async () => {
    const ctx = new Context()
    await ctx.plugin(LoggingService, { capacity: 20, console: false })
    await ctx.plugin(ConsoleService)
    ctx.console.define(ctx, workbenchLogsQuery); ctx.console.define(ctx, workbenchLogsChanged)
    workbenchLogsProviderPlugin(ctx)
    const controller = new AbortController()
    const request: ConsoleRequestContext = { requestId: 'logs-test', principal: { authenticated: true, subject: { type: 'user', id: 'owner' } }, signal: controller.signal, logger: ctx.logger('test') }
    try {
      let finish!: () => void, active = 0, maximum = 0
      const emit = vi.fn(async () => {
        active++; maximum = Math.max(maximum, active)
        if (emit.mock.calls.length === 1) await new Promise<void>(resolve => { finish = resolve })
        active--
      })
      const dispose = await ctx.console.subscribe(logsChangedRef, {}, request, emit)
      for (let i = 0; i < 100; i++) withLogContext({ runId: i % 2 ? 'run-a' : 'run-b' }, () => ctx.logger('plugin:detail').info('record-%d', i))
      await new Promise(resolve => setTimeout(resolve, 230))
      expect(emit).toHaveBeenCalledOnce()
      finish()
      await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2))
      expect(maximum).toBe(1)
      const snapshot = await ctx.console.query<{}, LogSnapshot>(logsQueryRef, { runId: 'run-a', namespace: 'plugin', limit: 5 }, request)
      expect(snapshot.records).toHaveLength(5)
      expect(snapshot.records.every(record => record.runId === 'run-a')).toBe(true)
      expect(snapshot.evicted).toBe(80)
      for (const input of [{ limit: 201 }, { maxLevel: -1 }, { search: 'x'.repeat(201) }]) await expect(ctx.console.query(logsQueryRef, input, request)).rejects.toThrow()
      controller.abort()
      await dispose()
      ctx.logger('plugin').info('after abort')
      await new Promise(resolve => setTimeout(resolve, 230))
      expect(emit).toHaveBeenCalledTimes(2)
      const reconnect = vi.fn()
      const stop = await ctx.console.subscribe(logsChangedRef, {}, { ...request, signal: new AbortController().signal }, reconnect)
      expect(reconnect).toHaveBeenCalledOnce()
      await stop()
    } finally { await ctx.fiber.dispose() }
  })
})
