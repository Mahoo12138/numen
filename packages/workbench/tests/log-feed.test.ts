import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { LogQuery, LogSnapshot } from '@numenjs/logging/contracts'
import type { WorkbenchConsoleClient } from '../src/types.js'
import { useLogFeed } from '../src/useLogFeed.js'

const snapshot = (message: string): LogSnapshot => ({ records: [{ id: message, timestamp: '2026-09-24T00:00:00Z', type: 'info', level: 2, namespace: 'test', message }], stream: 'epoch', revision: 1, reset: false, expired: false, retained: 1, evicted: 0, malformed: 0, persistence: 'disabled' })
describe('logs browser lifecycle', () => {
  it('allows slow queries to finish during a continuous notification flood', async () => {
    vi.useFakeTimers()
    const pending: { resolve(value: LogSnapshot): void; signal?: AbortSignal }[] = []
    let event!: (event: unknown) => void
    const client = {
      query: vi.fn((_ref, _input, signal) => new Promise(resolve => pending.push({ resolve: resolve as any, signal }))),
      subscribe: vi.fn(async (_ref, _input, handlers) => { event = handlers.event; return () => {} }),
    } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const feed = scope.run(() => useLogFeed(client, {}, true))!
    try {
      await nextTick()
      for (let index = 0; index < 10; index++) { event({ changed: true }); await vi.advanceTimersByTimeAsync(200) }
      expect(client.query).toHaveBeenCalledTimes(1)
      expect(pending[0]!.signal?.aborted).toBe(false)
      pending[0]!.resolve(snapshot('slow result'))
      await vi.advanceTimersByTimeAsync(0)
      expect(feed.snapshot.value?.records[0]?.message).toBe('slow result')
      await vi.advanceTimersByTimeAsync(200)
      expect(client.query).toHaveBeenCalledTimes(2)
      scope.stop()
      pending[1]!.resolve(snapshot('disposed result'))
      await vi.advanceTimersByTimeAsync(400)
      expect(feed.snapshot.value?.records[0]?.message).toBe('slow result')
    } finally { scope.stop(); vi.useRealTimers() }
  })

  it('rejects late results after filtering and disposal, coalesces notifications, and replaces reconnect data', async () => {
    vi.useFakeTimers()
    const pending: { resolve(value: LogSnapshot): void; signal?: AbortSignal }[] = []
    const subscriptions: { event(event: unknown): void | Promise<void> }[] = []
    const unsubscribe = vi.fn()
    const client = { action: vi.fn(), query: vi.fn((_ref, _input, signal) => new Promise(resolve => pending.push({ resolve: resolve as any, signal }))), subscribe: vi.fn(async (_ref, _input, handlers) => { subscriptions.push(handlers); return unsubscribe }) } as unknown as WorkbenchConsoleClient
    const query = ref<LogQuery>({ namespace: 'first' }), follow = ref(true)
    const scope = effectScope()
    const feed = scope.run(() => useLogFeed(client, query, follow))!
    try {
      await nextTick()
      query.value = { namespace: 'second' }
      await nextTick()
      expect(pending[0]!.signal?.aborted).toBe(true)
      pending[1]!.resolve(snapshot('new result'))
      await Promise.resolve()
      pending[0]!.resolve(snapshot('stale result'))
      await Promise.resolve()
      expect(feed.snapshot.value?.records[0]?.message).toBe('new result')
      for (let i = 0; i < 50; i++) await subscriptions.at(-1)!.event({ changed: true })
      await vi.advanceTimersByTimeAsync(200)
      expect(client.query).toHaveBeenCalledTimes(3)
      pending[2]!.resolve(snapshot('after reconnect'))
      await Promise.resolve()
      expect(feed.snapshot.value?.records).toHaveLength(1)
      expect(feed.snapshot.value?.records[0]?.message).toBe('after reconnect')
      await subscriptions.at(-1)!.event({ changed: true })
      scope.stop()
      await vi.advanceTimersByTimeAsync(500)
      expect(client.query).toHaveBeenCalledTimes(3)
      expect(unsubscribe).toHaveBeenCalledTimes(2)
    } finally { scope.stop(); vi.useRealTimers() }
  })
})
