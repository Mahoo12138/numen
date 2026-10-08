import { effectScope, nextTick, shallowRef, watchEffect } from 'vue'
import { expect, it, vi } from 'vitest'
import type { WorkbenchInvalidationEvent } from '../src/contracts.js'
import type { WorkbenchConsoleClient } from '../src/types.js'
import { useConsoleQuery } from '../src/useConsoleQuery.js'

it('refreshes usage for either domain and recovers a failed read without accepting late responses after disposal', async () => {
  let emit!: (value: WorkbenchInvalidationEvent) => void
  let complete!: (value: unknown) => void
  const unsubscribe = vi.fn()
  const query = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{ connectionId: 'new' }]).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const client = { query, subscribe: vi.fn(async (_ref, _input, handlers) => { emit = handlers.event; return unsubscribe }) } as unknown as WorkbenchConsoleClient
  const scope = effectScope()
  const [state, reload] = scope.run(() => useConsoleQuery(() => client, { id: 'usage', version: 1 }, {}, ['connections', 'automations']))!
  await vi.waitFor(() => expect(state.status).toBe('READY'))
  emit({ scopes: ['runs'] }); await nextTick(); expect(query).toHaveBeenCalledTimes(1)
  emit({ scopes: ['connections'] })
  await vi.waitFor(() => expect(state.status).toBe('ERROR'))
  reload()
  await vi.waitFor(() => expect(state).toMatchObject({ status: 'READY', data: [{ connectionId: 'new' }] }))
  emit({ scopes: ['automations'] })
  expect(query).toHaveBeenCalledTimes(4)
  scope.stop(); complete([{ connectionId: 'stale' }]); await nextTick()
  expect(state).toMatchObject({ status: 'READY', data: [{ connectionId: 'new' }] })
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(query.mock.calls.at(-1)?.[2].aborted).toBe(true)
})

it('keeps the discriminated query state valid for synchronous consumers across refresh, loading, errors and disabling', async () => {
  const scope = effectScope(), failures: unknown[] = [], observed: string[] = []
  const query = vi.fn().mockResolvedValueOnce({ items: ['first'] }).mockResolvedValueOnce({ items: ['refreshed'] })
    .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'OFFLINE' })).mockResolvedValueOnce({ items: ['recovered'] })
    .mockRejectedValueOnce(new Error('offline again'))
  const client = shallowRef<WorkbenchConsoleClient | undefined>({ query } as unknown as WorkbenchConsoleClient)
  const [state, reload, refresh] = scope.run(() => useConsoleQuery<Record<string, never>, { items: string[] }>(client, { id: 'index', version: 1 }, {}))!
  scope.run(() => watchEffect(() => {
    try {
      // Mirrors liveItems -> automationId -> the restoration controller's synchronous watcher.
      if (state.status === 'READY') observed.push(`READY:${state.data.items.join(',')}`)
      else if (state.status === 'ERROR') observed.push(`ERROR:${state.message.length}:${state.code ?? ''}`)
      else observed.push(state.status)
    } catch (error) { failures.push(error) }
  }, { flush: 'sync' }))
  try {
    await vi.waitFor(() => expect(state).toMatchObject({ status: 'READY', data: { items: ['first'] } }))
    refresh()
    expect(state.status).toBe('READY')
    await vi.waitFor(() => expect(state).toMatchObject({ status: 'READY', data: { items: ['refreshed'] } }))
    refresh()
    await vi.waitFor(() => expect(state).toMatchObject({ status: 'ERROR', message: 'offline', code: 'OFFLINE' }))
    expect(state).not.toHaveProperty('data')
    reload()
    expect(state).toEqual({ status: 'LOADING' })
    await vi.waitFor(() => expect(state).toEqual({ status: 'READY', data: { items: ['recovered'] } }))
    reload()
    expect(state).toEqual({ status: 'LOADING' })
    await vi.waitFor(() => expect(state).toEqual({ status: 'ERROR', message: 'offline again' }))
    client.value = undefined
    await nextTick()
    expect(state).toEqual({ status: 'DISABLED' })
    expect(observed).toContain('READY:first')
    expect(observed).toContain('READY:refreshed')
    expect(observed).toContain('READY:recovered')
    expect(observed).toContain('ERROR:7:OFFLINE')
    expect(failures).toEqual([])
  } finally { scope.stop() }
})
