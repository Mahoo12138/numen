import { effectScope, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useManualRunForm } from '../src/useManualRunForm.js'
import type { WorkbenchManualRunForm, WorkbenchStartManualRunInput } from '../src/contracts.js'
import type { WorkbenchConsoleClient } from '../src/types.js'

const form: WorkbenchManualRunForm = { automationId: 'auto', mode: 'revision-test', revisionId: 'rev-first', revisionNumber: 1, revisions: [{ id: 'rev-first', number: 1, active: false }, { id: 'rev-second', number: 2, active: true }], inputs: { message: { type: 'string', required: true, default: 'first default' } } }
const settled = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve() }

describe('Revision Run form request lifecycle', () => {
  it('locks uncertain request parameters and recovers the same accepted Run without changing Revision, input or trigger', async () => {
    const accepted = new Map<string, string>()
    const requests: WorkbenchStartManualRunInput[] = []
    const client = {
      query: vi.fn(async () => structuredClone(form)),
      action: vi.fn(async (_ref, input: WorkbenchStartManualRunInput) => {
        requests.push(structuredClone(input))
        if (!accepted.has(input.requestId)) { accepted.set(input.requestId, 'run-one'); throw new Error('response lost after acceptance') }
        return { runId: accepted.get(input.requestId) }
      }),
    } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const state = scope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client }))!
    try {
      await settled()
      state.triggerText.value = '{"event":"manual fixture"}'
      expect(await state.start()).toBe(false)
      expect(state.uncertain.value).toBe(true)
      state.change('message', 'changed')
      expect(await state.choose('revision-test', 'rev-second')).toBe(false)
      expect(await state.load()).toBe(false)
      expect(client.query).toHaveBeenCalledTimes(1)
      state.triggerText.value = '{"event":"changed outside form"}'
      expect(await state.start()).toBe(true)
      expect(requests[1]).toEqual(requests[0])
      expect(requests[0]).toMatchObject({ revisionId: 'rev-first', mode: 'revision-test', input: { message: 'first default' }, trigger: { event: 'manual fixture' } })
      expect(accepted.size).toBe(1)
      expect(state.runId.value).toBe('run-one')
      expect(state.submission.value).toBeUndefined()
      expect(state.uncertain.value).toBe(false)
    } finally { scope.stop() }
  })

  it('loads a selected Revision contract and rejects malformed trigger data or invalid input before a request', async () => {
    const client = { query: vi.fn(async (_ref, input) => ({ ...form, revisionId: input.revisionId ?? form.revisionId, revisionNumber: input.revisionId ? 2 : 1, inputs: input.revisionId ? { count: { type: 'number', required: true, default: 42 } } : form.inputs })), action: vi.fn(async () => ({ runId: 'run' })) } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const state = scope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client }))!
    try {
      await settled()
      await state.choose('revision-test', 'rev-second')
      expect(state.values.value).toEqual({ count: 42 })
      state.triggerText.value = '{broken'
      expect(await state.start()).toBe(false)
      expect(state.triggerError.value).toBe(true)
      expect(client.action).not.toHaveBeenCalled()
      state.triggerText.value = 'null'
      state.change('count', 'wrong')
      expect(await state.start()).toBe(false)
      expect(state.issues.value[0]?.field).toBe('count')
      state.change('count', 8)
      expect(await state.start()).toBe(true)
      expect(client.action).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ revisionId: 'rev-second', input: { count: 8 }, trigger: null }), expect.any(AbortSignal))
    } finally { scope.stop() }
  })

  it('prevents double submission and treats component disposal as a cancelled response, not a Run cancellation', async () => {
    let resolve!: (value: { runId: string }) => void
    let signal: AbortSignal | undefined
    const client = { query: vi.fn(async () => structuredClone(form)), action: vi.fn((_ref, _input, requestSignal: AbortSignal) => { signal = requestSignal; return new Promise<{ runId: string }>(done => { resolve = done }) }) } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const state = scope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client }))!
    await settled()
    const first = state.start()
    expect(await state.start()).toBe(false)
    expect(client.action).toHaveBeenCalledTimes(1)
    scope.stop()
    expect(signal?.aborted).toBe(true)
    resolve({ runId: 'accepted-on-server' })
    expect(await first).toBe(false)
    expect(state.runId.value).toBeUndefined()
    expect(client.action).toHaveBeenCalledTimes(1)
  })
})
