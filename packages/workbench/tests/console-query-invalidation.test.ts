import { effectScope, nextTick } from 'vue'
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
