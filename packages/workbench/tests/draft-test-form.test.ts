import { effectScope, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchManualRunForm, WorkbenchManualRunFormInput, WorkbenchStartManualRunInput } from '../src/contracts.js'
import type { WorkbenchConsoleClient } from '../src/types.js'
import { useManualRunForm } from '../src/useManualRunForm.js'

const form = (version = 7): WorkbenchManualRunForm => ({ automationId: 'auto', mode: 'draft-test', draftVersion: version, inputs: { message: { type: 'string', required: true, default: `saved v${version}` } } })
const settled = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve() }

describe('saved Draft test form lifecycle', () => {
  it('guards valid focused buffers, remounts parameters on same-version reload and blocks acceptance after a failed reload', async () => {
    let rejectReload!: (reason: unknown) => void
    const query = vi.fn().mockResolvedValue(form(7))
    const action = vi.fn(async () => ({ runId: 'previous-run', snapshotId: 'previous-snapshot', sourceDraftVersion: 7 }))
    const prepareDraft = vi.fn(async (): Promise<number | undefined> => 7)
    const client = { query, action } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const state = scope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client, initialMode: 'draft-test', prepareDraft }))!
    try {
      await vi.waitFor(() => expect(state.form.value).toBeDefined())
      const initialEpoch = state.parametersEpoch.value
      expect(initialEpoch).toBeGreaterThan(0)
      // SchemaField has a valid local text buffer, but its blur has not emitted a new value.
      state.uncommitted.value = { message: true }
      expect(state.values.value).toEqual({ message: 'saved v7' })
      expect(state.invalid.value).toEqual({})
      expect(state.needsProtection.value).toBe(true)
      state.change('message', 'committed after blur')
      state.uncommitted.value = { message: false }
      expect(state.needsProtection.value).toBe(true)
      state.change('message', 'saved v7')
      expect(state.needsProtection.value).toBe(false)
      state.invalid.value = { message: true }
      state.uncommitted.value = { message: true }
      expect(await state.load()).toBe(true)
      expect(state.form.value).toMatchObject({ draftVersion: 7 })
      expect(state.parametersEpoch.value).toBe(initialEpoch + 1)
      expect(state.invalid.value).toEqual({})
      expect(state.uncommitted.value).toEqual({})
      expect(state.needsProtection.value).toBe(false)
      expect(await state.start()).toBe(true)
      expect(state.runId.value).toBe('previous-run')
      const epochBeforeFailure = state.parametersEpoch.value
      state.change('message', 'retain committed parameter')
      state.invalid.value = { message: true }
      state.uncommitted.value = { message: true }
      query.mockImplementationOnce(() => new Promise((_, reject) => { rejectReload = reject }))
      const reloading = state.load()
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3))
      expect(state.loading.value).toBe(true)
      expect(state.runId.value).toBeUndefined()
      expect(await state.start()).toBe(false)
      rejectReload(new Error('parameters response unavailable'))
      expect(await reloading).toBe(false)
      expect(state.loading.value).toBe(false)
      expect(state.form.value).toMatchObject({ draftVersion: 7 })
      expect(state.values.value).toEqual({ message: 'retain committed parameter' })
      expect(state.invalid.value).toEqual({ message: true })
      expect(state.uncommitted.value).toEqual({ message: true })
      expect(state.needsProtection.value).toBe(true)
      expect(state.requiresReload.value).toBe(true)
      expect(state.runId.value).toBeUndefined()
      expect(state.message.value).toBe('workbench.manual.loadFailed')
      expect(state.parametersEpoch.value).toBe(epochBeforeFailure)
      expect(await state.start()).toBe(false)
      expect(action).toHaveBeenCalledTimes(1)
      // A failed Draft save has the same retention boundary and never queries a newer target.
      prepareDraft.mockResolvedValueOnce(undefined)
      expect(await state.load()).toBe(false)
      expect(query).toHaveBeenCalledTimes(3)
      expect(state.form.value).toMatchObject({ draftVersion: 7 })
      expect(state.values.value).toEqual({ message: 'retain committed parameter' })
      expect(state.invalid.value).toEqual({ message: true })
      expect(state.uncommitted.value).toEqual({ message: true })
      expect(state.needsProtection.value).toBe(true)
      expect(state.requiresReload.value).toBe(true)
      expect(state.parametersEpoch.value).toBe(epochBeforeFailure)
      expect(state.message.value).toBe('workbench.draftTest.saveRequired')
      expect(await state.start()).toBe(false)
    } finally { scope.stop() }
  })

  it('waits for focused fields and in-flight saving to produce a server version before loading parameters', async () => {
    let resolveSave!: (version: number | undefined) => void
    let saveSignal: AbortSignal | undefined
    const prepareDraft = vi.fn((signal: AbortSignal) => { saveSignal = signal; return new Promise<number | undefined>(resolve => { resolveSave = resolve }) })
    const client = { query: vi.fn(async () => form(7)), action: vi.fn(async () => ({ runId: 'run', snapshotId: 'snapshot', sourceDraftVersion: 7 })) } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const state = scope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client, initialMode: 'draft-test', prepareDraft }))!
    try {
      expect(state.loading.value).toBe(true)
      expect(client.query).not.toHaveBeenCalled()
      expect(await state.start()).toBe(false)
      resolveSave(7)
      await vi.waitFor(() => expect(state.form.value).toMatchObject({ mode: 'draft-test', draftVersion: 7 }))
      expect(client.query).toHaveBeenCalledWith(expect.anything(), { automationId: 'auto', mode: 'draft-test', expectedDraftVersion: 7 }, expect.any(AbortSignal))
      expect(state.values.value).toEqual({ message: 'saved v7' })
      expect(state.needsProtection.value).toBe(false)
      state.change('message', 'edited parameters')
      expect(state.needsProtection.value).toBe(true)
      expect(await state.start()).toBe(true)
      expect(client.action).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: 'draft-test', expectedDraftVersion: 7, input: { message: 'edited parameters' } }), expect.any(AbortSignal))
      expect(state.accepted.value).toEqual({ runId: 'run', snapshotId: 'snapshot', sourceDraftVersion: 7 })
      expect(state.needsProtection.value).toBe(false)
    } finally { scope.stop() }
    expect(saveSignal?.aborted).toBe(false)
  })

  it('blocks invalid local Draft fields and disposal during save without loading or submitting an older version', async () => {
    const prepareDraft = vi.fn(async () => undefined)
    const client = { query: vi.fn(async () => form()), action: vi.fn() } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const state = scope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client, initialMode: 'draft-test', prepareDraft }))!
    await settled()
    expect(state.message.value).toBe('workbench.draftTest.saveRequired')
    expect(state.form.value).toBeUndefined()
    expect(await state.start()).toBe(false)
    expect(client.query).not.toHaveBeenCalled()
    expect(client.action).not.toHaveBeenCalled()
    scope.stop()

    let signal!: AbortSignal, resolve!: (version: number) => void
    const pendingScope = effectScope()
    pendingScope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client, initialMode: 'draft-test', prepareDraft: saveSignal => { signal = saveSignal; return new Promise<number>(done => { resolve = done }) } }))
    pendingScope.stop()
    expect(signal.aborted).toBe(true)
    resolve(9)
    await settled()
    expect(client.query).not.toHaveBeenCalled()
  })

  it('freezes the exact Draft version and full request across uncertain acceptance, preventing implicit saves and parameter changes', async () => {
    const requests: WorkbenchStartManualRunInput[] = []
    const prepareDraft = vi.fn(async () => 7), onAccepted = vi.fn()
    const client = {
      query: vi.fn(async () => form()),
      action: vi.fn(async (_ref, input: WorkbenchStartManualRunInput) => {
        requests.push(structuredClone(input))
        if (requests.length === 1) throw new Error('response lost after server commit')
        return { runId: 'run-original', snapshotId: 'snapshot-original', sourceDraftVersion: 7 }
      }),
    } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const state = scope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client, initialMode: 'draft-test', prepareDraft, onAccepted }))!
    try {
      await vi.waitFor(() => expect(state.form.value).toBeDefined())
      state.triggerText.value = '{"event":"frozen trigger"}'
      state.change('message', 'frozen input')
      expect(await state.start()).toBe(false)
      expect(state.uncertain.value).toBe(true)
      expect(state.needsProtection.value).toBe(true)
      state.change('message', 'attempted change')
      expect(state.values.value.message).toBe('frozen input')
      expect(await state.load()).toBe(false)
      expect(await state.choose('revision-test')).toBe(false)
      prepareDraft.mockResolvedValue(8)
      state.triggerText.value = '{"event":"mutated outside disabled form"}'
      expect(await state.start()).toBe(true)
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
      expect(requests[0]).toMatchObject({ mode: 'draft-test', expectedDraftVersion: 7, input: { message: 'frozen input' }, trigger: { event: 'frozen trigger' } })
      expect(requests[0]).not.toHaveProperty('revisionId')
      expect(prepareDraft).toHaveBeenCalledTimes(1)
      expect(client.query).toHaveBeenCalledTimes(1)
      expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ runId: 'run-original', snapshotId: 'snapshot-original', sourceDraftVersion: 7 })
      expect(state.uncertain.value).toBe(false)
      expect(state.submission.value).toBeUndefined()
    } finally { scope.stop() }
  })

  it('requires an explicit latest-save reload after a version conflict and keeps Source diagnostics for a compile rejection', async () => {
    let version = 7
    const prepareDraft = vi.fn(async () => version)
    const query = vi.fn(async (_ref, input: WorkbenchManualRunFormInput) => form(input.mode === 'draft-test' ? input.expectedDraftVersion : 0))
    const diagnostic = { severity: 'error', code: 'CAPABILITY_MISSING', message: 'Capability unavailable.', source: { nodeId: 'missing', fieldPath: 'capability' } }
    const action = vi.fn().mockRejectedValueOnce({ code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 7, actualVersion: 8 } }).mockRejectedValueOnce({ code: 'AUTOMATION_DRAFT_TEST_INVALID', details: { diagnostics: [diagnostic] } })
    const client = { query, action } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const state = scope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client, initialMode: 'draft-test', prepareDraft }))!
    try {
      await vi.waitFor(() => expect(state.form.value).toBeDefined())
      state.change('message', 'parameter awaiting confirmation')
      version = 8
      expect(await state.start()).toBe(false)
      expect(state.requiresReload.value).toBe(true)
      expect(state.uncertain.value).toBe(false)
      expect(state.submission.value).toBeUndefined()
      expect(state.form.value).toMatchObject({ draftVersion: 7 })
      expect(state.values.value.message).toBe('parameter awaiting confirmation')
      expect(state.needsProtection.value).toBe(true)
      expect(await state.start()).toBe(false)
      expect(query).toHaveBeenCalledTimes(1)
      expect(prepareDraft).toHaveBeenCalledTimes(1)
      expect(action).toHaveBeenCalledTimes(1)
      expect(await state.load()).toBe(true)
      expect(state.form.value).toMatchObject({ draftVersion: 8 })
      expect(state.values.value).toEqual({ message: 'saved v8' })
      expect(state.requiresReload.value).toBe(false)
      expect(await state.start()).toBe(false)
      expect(state.message.value).toBe('workbench.draftTest.invalid')
      expect(state.diagnostics.value).toEqual([diagnostic])
      expect(state.requiresReload.value).toBe(true)
      expect(state.uncertain.value).toBe(false)
      expect(state.submission.value).toBeUndefined()
    } finally { scope.stop() }
  })

  it('treats resource rejection as definite non-acceptance and guards malformed parameter/trigger buffers', async () => {
    const client = { query: vi.fn(async () => form()), action: vi.fn().mockRejectedValueOnce({ code: 'RUN_RESOURCE_UNAVAILABLE' }).mockResolvedValue({ runId: 'run', snapshotId: 'snapshot', sourceDraftVersion: 7 }) } as unknown as WorkbenchConsoleClient
    const scope = effectScope()
    const state = scope.run(() => useManualRunForm({ automationId: () => 'auto', client: () => client, initialMode: 'draft-test', prepareDraft: async () => 7 }))!
    try {
      await vi.waitFor(() => expect(state.form.value).toBeDefined())
      state.invalid.value = { message: true }
      expect(state.needsProtection.value).toBe(true)
      expect(await state.start()).toBe(false)
      state.invalid.value = {}
      state.triggerText.value = '{incomplete'
      expect(await state.start()).toBe(false)
      expect(state.triggerError.value).toBe(true)
      expect(state.needsProtection.value).toBe(true)
      expect(client.action).not.toHaveBeenCalled()
      state.triggerText.value = '{}'
      expect(await state.start()).toBe(false)
      expect(state.message.value).toBe('workbench.draftTest.invalidData')
      expect(state.uncertain.value).toBe(false)
      expect(state.requiresReload.value).toBe(false)
      expect(state.submission.value).toBeUndefined()
      state.change('message', 'corrected after definite rejection')
      expect(await state.start()).toBe(true)
    } finally { scope.stop() }
  })
})
