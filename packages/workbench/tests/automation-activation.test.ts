import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchAutomationIdentity, WorkbenchAutomationActivationResult } from '../src/contracts.js'
import type { WorkbenchConsoleClient } from '../src/types.js'
import { createAutomationActivation } from '../src/useAutomationActivation.js'

const automation: WorkbenchAutomationIdentity = {
  id: 'auto_test', name: 'Test', enabled: false, activationGeneration: 0,
  createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
}
const client = (action: WorkbenchConsoleClient['action']): WorkbenchConsoleClient => ({ action, query: vi.fn(), subscribe: vi.fn() })

describe('Automation activation lifecycle', () => {
  it('serializes mutations and keeps confirmed generations ahead of stale Query responses', async () => {
    let resolve!: (result: WorkbenchAutomationActivationResult) => void
    const action = vi.fn<WorkbenchConsoleClient['action']>(() => new Promise(next => { resolve = next as typeof resolve }))
    const refresh = vi.fn()
    const state = createAutomationActivation(client(action), refresh)
    state.activate(automation, 'rev_one')
    state.setEnabled(automation, true)
    expect(action).toHaveBeenCalledOnce()
    expect(state.view(automation)).toMatchObject({ pending: true, activatingRevisionId: 'rev_one', automation })
    const activated = { ...automation, activeRevisionId: 'rev_one', activationGeneration: 1 }
    resolve({ automation: activated })
    await Promise.resolve()
    expect(state.view(automation)).toMatchObject({ pending: false, automation: activated })
    state.setEnabled(automation, true)
    expect(action.mock.calls[1]?.[1]).toMatchObject({ expectedActivationGeneration: 1, enabled: true })
    expect(state.view(automation).automation).toEqual(activated)
    const enabled = { ...activated, enabled: true, activationGeneration: 2 }
    resolve({ automation: enabled })
    await Promise.resolve()
    expect(state.view(automation).automation).toEqual(enabled)
    const external = { ...activated, activationGeneration: 3 }
    expect(state.view(external).automation).toEqual(external)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('refreshes conflicts without retrying automatically and isolates different Automation selections', async () => {
    const action = vi.fn<WorkbenchConsoleClient['action']>().mockRejectedValueOnce({ code: 'AUTOMATION_ACTIVATION_CONFLICT' })
      .mockResolvedValueOnce({ automation: { ...automation, enabled: true, activationGeneration: 3 } })
    const refresh = vi.fn()
    const state = createAutomationActivation(client(action), refresh)
    state.setEnabled(automation, true)
    await Promise.resolve()
    expect(state.view(automation)).toMatchObject({ pending: false, error: expect.stringContaining('changed elsewhere') })
    expect(state.view({ ...automation, id: 'other' })).toEqual({ automation: { ...automation, id: 'other' }, pending: false })
    expect(action).toHaveBeenCalledOnce()
    state.setEnabled({ ...automation, activationGeneration: 2 }, true)
    await Promise.resolve()
    expect(action.mock.calls[1]?.[1]).toMatchObject({ expectedActivationGeneration: 2 })
    expect(state.view(automation).error).toBeUndefined()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('aborts on disposal and ignores late results', async () => {
    let resolve!: (result: WorkbenchAutomationActivationResult) => void
    const action = vi.fn<WorkbenchConsoleClient['action']>(() => new Promise(next => { resolve = next as typeof resolve }))
    const refresh = vi.fn()
    const state = createAutomationActivation(client(action), refresh)
    state.activate(automation, 'rev_one')
    const signal = action.mock.calls[0]?.[2]
    state.dispose()
    resolve({ automation: { ...automation, activeRevisionId: 'rev_one', activationGeneration: 1 } })
    await Promise.resolve()
    expect(signal?.aborted).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
    expect(state.view(automation)).toEqual({ automation, pending: false })
  })
})
