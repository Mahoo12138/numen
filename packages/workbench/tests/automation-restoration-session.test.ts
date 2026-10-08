import type { AutomationSource } from '@numenjs/core'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, shallowRef } from 'vue'
import { workbenchAutomationRestoreContentQueryRef, type WorkbenchAutomationDetail, type WorkbenchAutomationRestoreContent, type WorkbenchAutomationRestoreContentQueryInput, type WorkbenchSaveAutomationDraftInput } from '../src/contracts.js'
import type { WorkbenchConsoleClient } from '../src/types.js'
import { useAutomationDraftDocument, type AutomationDraftDocument, type AutomationDraftDocumentModel, type ReplaceAutomationDraftFromSnapshotInput } from '../src/useAutomationDraftDocument.js'
import { useAutomationRestoration } from '../src/useAutomationRestoration.js'

const snapshotA = `rev_${'a'.repeat(32)}`
const snapshotB = `snap_${'b'.repeat(32)}`
const source: AutomationSource = { triggers: [], flow: { type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 10 } } }
const saved = (version = 3): AutomationDraftDocument => ({ automationId: 'automation-1', version, updatedAt: '2026-10-08T00:00:00Z', baseRevisionId: 'current-base', source: structuredClone(source), presentation: {} })
const content = (input: WorkbenchAutomationRestoreContentQueryInput): WorkbenchAutomationRestoreContent => ({
  automationId: input.automationId, expectedDraftVersion: input.expectedDraftVersion,
  identity: { id: input.snapshotId, automationId: input.automationId, purpose: input.snapshotId.startsWith('rev_') ? 'published' : 'draft-test',
    ...(input.snapshotId.startsWith('rev_') ? { number: 1 } : { sourceDraftVersion: 2 }), protocolVersion: 1, irVersion: 1, contentHash: 'fixed-hash', createdAt: '2026-10-01T00:00:00Z' },
  source: { triggers: [], flow: { type: 'block', id: 'restored', steps: [] } }, presentation: { opaque: { retained: true } },
})
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settled = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve() }

function fixture() {
  const scope = effectScope(), automationId = ref<string | undefined>('automation-1'), document = shallowRef<AutomationDraftDocument | undefined>(saved())
  const phase = ref('CLEAN'), publishing = ref(false), archived = ref(false), inputsValid = ref(true)
  const query = vi.fn(async (_ref: unknown, input: WorkbenchAutomationRestoreContentQueryInput, _signal?: AbortSignal) => content(input))
  const client = shallowRef<WorkbenchConsoleClient | undefined>({ query, action: vi.fn(), subscribe: vi.fn() } as unknown as WorkbenchConsoleClient)
  const flushDraft = vi.fn(async (_signal?: AbortSignal) => true)
  const canReplace = () => phase.value === 'CLEAN' && !publishing.value && document.value?.automationId === automationId.value
  const replaceFromSnapshot = vi.fn((input: ReplaceAutomationDraftFromSnapshotInput) => {
    const current = document.value
    if (!current || !canReplace() || current.automationId !== input.automationId || current.version !== input.expectedVersion) return false
    document.value = { ...current, ...structuredClone({ source: input.source, presentation: input.presentation }) }
    phase.value = 'DIRTY'
    return true
  })
  const authoring = { get document() { return document.value }, get canReplaceFromSnapshot() { return canReplace() }, flushDraft, replaceFromSnapshot } as unknown as AutomationDraftDocumentModel
  const commitInputs = vi.fn(() => inputsValid.value), onApplied = vi.fn(), refreshDetail = vi.fn()
  const canPrepare = () => !archived.value && !publishing.value && ['CLEAN', 'DIRTY', 'SAVING'].includes(phase.value)
  const session = scope.run(() => useAutomationRestoration({ client: () => client.value, automationId: () => automationId.value, authoring, canPrepare, commitInputs, onApplied, refreshDetail }))!
  return { scope, automationId, document, phase, publishing, archived, inputsValid, client, query, flushDraft, replaceFromSnapshot, authoring, commitInputs, onApplied, refreshDetail, session }
}

describe('snapshot restoration preparation lifecycle', () => {
  it('waits for focused inputs and the Draft save before querying, then requires a separate explicit Apply', async () => {
    const f = fixture(), save = deferred<boolean>()
    f.phase.value = 'DIRTY'
    f.flushDraft.mockImplementationOnce(() => save.promise)
    try {
      const opening = f.session.open(snapshotA)
      expect(f.session.state).toEqual({ status: 'PREPARING', snapshotId: snapshotA })
      expect(f.session.locked).toBe(true)
      expect(f.commitInputs).toHaveBeenCalledOnce()
      expect(f.flushDraft).toHaveBeenCalledWith(expect.any(AbortSignal))
      expect(f.query).not.toHaveBeenCalled()
      expect(f.session.apply()).toBe(false)
      f.document.value = saved(4); f.phase.value = 'CLEAN'; save.resolve(true)
      await opening
      expect(f.query).toHaveBeenCalledExactlyOnceWith(workbenchAutomationRestoreContentQueryRef, { automationId: 'automation-1', snapshotId: snapshotA, expectedDraftVersion: 4 }, expect.any(AbortSignal))
      expect(f.session.state).toMatchObject({ status: 'READY', content: { expectedDraftVersion: 4 } })
      expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
      expect(f.onApplied).not.toHaveBeenCalled()
      expect(f.session.apply()).toBe(true)
      expect(f.replaceFromSnapshot).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ automationId: 'automation-1', expectedVersion: 4, source: content({ automationId: 'automation-1', snapshotId: snapshotA, expectedDraftVersion: 4 }).source }))
      expect(f.replaceFromSnapshot.mock.calls[0]?.[0]).not.toHaveProperty('expectedDocument')
      expect(f.onApplied).toHaveBeenCalledOnce()
      expect(f.session.state).toBeUndefined()
      expect(f.session.locked).toBe(false)
      expect(f.session.apply()).toBe(false)
    } finally { f.scope.stop() }
  })

  it.each(['save', 'query'] as const)('cancels during %s and ignores a late success without applying content', async stage => {
    const f = fixture(), saving = deferred<boolean>(), querying = deferred<WorkbenchAutomationRestoreContent>()
    if (stage === 'save') f.flushDraft.mockImplementationOnce(() => saving.promise)
    else f.query.mockImplementationOnce(() => querying.promise)
    try {
      const opening = f.session.open(snapshotA)
      await settled()
      const signal = stage === 'save' ? f.flushDraft.mock.calls[0]?.[0] : f.query.mock.calls[0]?.[2]
      expect(signal?.aborted).toBe(false)
      f.session.close()
      expect(signal?.aborted).toBe(true)
      saving.resolve(true); querying.resolve(content({ automationId: 'automation-1', snapshotId: snapshotA, expectedDraftVersion: 3 }))
      await opening
      expect(f.session.state).toBeUndefined()
      expect(f.session.apply()).toBe(false)
      expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
      expect(f.onApplied).not.toHaveBeenCalled()
      expect(f.query).toHaveBeenCalledTimes(stage === 'save' ? 0 : 1)
    } finally { f.scope.stop() }
  })

  it('supersedes an old request and retains the newer fixed snapshot after the old success or failure arrives', async () => {
    for (const outcome of ['success', 'failure'] as const) {
      const f = fixture(), first = deferred<WorkbenchAutomationRestoreContent>()
      f.query.mockImplementationOnce(() => first.promise)
      try {
        const old = f.session.open(snapshotA)
        await settled()
        const obsolete = f.query.mock.calls[0]?.[2]!
        await f.session.open(snapshotB)
        expect(obsolete.aborted).toBe(true)
        expect(f.session.state).toMatchObject({ status: 'READY', snapshotId: snapshotB })
        if (outcome === 'success') first.resolve(content({ automationId: 'automation-1', snapshotId: snapshotA, expectedDraftVersion: 3 }))
        else first.reject({ code: 'PRIVATE_OBSOLETE_ERROR', message: 'PRIVATE_OBSOLETE_MESSAGE' })
        await old
        expect(f.session.state).toMatchObject({ status: 'READY', snapshotId: snapshotB })
        expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
        expect(f.refreshDetail).not.toHaveBeenCalled()
        expect(f.session.apply()).toBe(true)
      } finally { f.scope.stop() }
    }
  })

  it('aborts synchronously on Automation or client changes and ignores late transport responses', async () => {
    for (const target of ['automation', 'client'] as const) {
      const f = fixture(), pending = deferred<WorkbenchAutomationRestoreContent>()
      f.query.mockImplementationOnce(() => pending.promise)
      try {
        const opening = f.session.open(snapshotA)
        await settled()
        const signal = f.query.mock.calls[0]?.[2]!
        if (target === 'automation') f.automationId.value = 'automation-2'
        else f.client.value = { query: vi.fn(), action: vi.fn(), subscribe: vi.fn() }
        expect(signal.aborted).toBe(true)
        expect(f.session.state).toBeUndefined()
        pending.resolve(content({ automationId: 'automation-1', snapshotId: snapshotA, expectedDraftVersion: 3 }))
        await opening
        expect(f.session.apply()).toBe(false)
        expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
      } finally { f.scope.stop() }
    }
  })

  it('checks live Automation identity even if a nonreactive selection changes before its Vue watcher can run', async () => {
    const scope = effectScope(), pending = deferred<WorkbenchAutomationRestoreContent>(), applied = vi.fn()
    let selected = 'automation-1'
    const document = saved(), replace = vi.fn(() => false)
    const query = vi.fn(() => pending.promise), client = { query } as unknown as WorkbenchConsoleClient
    const model = { document, canReplaceFromSnapshot: true, flushDraft: async () => true, replaceFromSnapshot: replace } as unknown as AutomationDraftDocumentModel
    const session = scope.run(() => useAutomationRestoration({ client: () => client, automationId: () => selected, authoring: model, canPrepare: () => true, commitInputs: () => true, onApplied: applied, refreshDetail() {} }))!
    try {
      const opening = session.open(snapshotA)
      await settled()
      selected = 'automation-2'
      pending.resolve(content({ automationId: 'automation-1', snapshotId: snapshotA, expectedDraftVersion: 3 }))
      await opening
      expect(session.state).toMatchObject({ status: 'PREPARING' })
      expect(session.apply()).toBe(false)
      expect(replace).not.toHaveBeenCalled()
      expect(applied).not.toHaveBeenCalled()
    } finally { scope.stop() }
  })

  it('allows a legitimate same-version SERVER refresh while requiring an explicit reprepare for a newer version', async () => {
    const f = fixture()
    try {
      await f.session.open(snapshotA)
      const baseline = f.document.value!
      f.document.value = { ...saved(3), baseRevisionId: 'new-published-base', updatedAt: '2026-10-08T01:00:00Z' }
      expect(f.document.value).not.toBe(baseline)
      expect(f.session.stale).toBe(false)
      expect(f.session.apply()).toBe(true)
      expect(f.document.value).toMatchObject({ version: 3, baseRevisionId: 'new-published-base' })
      f.document.value = saved(4); f.phase.value = 'CLEAN'
      await f.session.open(snapshotB)
      f.document.value = saved(5)
      expect(f.session.stale).toBe(true)
      expect(f.session.state).toMatchObject({ status: 'READY', content: { expectedDraftVersion: 4 } })
      const count = f.query.mock.calls.length
      expect(f.session.apply()).toBe(false)
      expect(f.query).toHaveBeenCalledTimes(count)
      f.session.prepareAgain()
      await vi.waitFor(() => expect(f.session.state).toMatchObject({ status: 'READY', content: { expectedDraftVersion: 5 } }))
      expect(f.query.mock.calls.at(-1)?.[1]).toEqual({ automationId: 'automation-1', snapshotId: snapshotB, expectedDraftVersion: 5 })
      expect(f.session.stale).toBe(false)
      expect(f.session.apply()).toBe(true)
    } finally { f.scope.stop() }
  })

  it('never queries after invalid focused input or a failed save, and never applies input that becomes invalid later', async () => {
    const f = fixture()
    try {
      f.inputsValid.value = false
      await f.session.open(snapshotA)
      expect(f.session.state).toBeUndefined()
      expect(f.flushDraft).not.toHaveBeenCalled()
      expect(f.query).not.toHaveBeenCalled()
      f.inputsValid.value = true
      f.flushDraft.mockResolvedValueOnce(false)
      await f.session.open(snapshotA)
      expect(f.session.state).toEqual({ status: 'ERROR', snapshotId: snapshotA, code: 'DRAFT_NOT_SAVED' })
      expect(f.query).not.toHaveBeenCalled()
      await f.session.open(snapshotA)
      f.inputsValid.value = false
      expect(f.session.apply()).toBe(false)
      expect(f.session.state).toMatchObject({ status: 'READY' })
      expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
      f.inputsValid.value = true
      expect(f.session.apply()).toBe(true)
    } finally { f.scope.stop() }
  })

  it.each(['automation', 'identityAutomation', 'snapshot', 'version', 'malformed'] as const)('rejects a %s identity mismatch with a generic error', async mismatch => {
    const f = fixture()
    f.query.mockImplementationOnce(async (_ref, input) => {
      const result = content(input)
      if (mismatch === 'automation') result.automationId = 'PRIVATE_FOREIGN_AUTOMATION'
      if (mismatch === 'identityAutomation') result.identity.automationId = 'PRIVATE_FOREIGN_AUTOMATION'
      if (mismatch === 'snapshot') result.identity.id = 'PRIVATE_FOREIGN_SNAPSHOT'
      if (mismatch === 'version') result.expectedDraftVersion = 500
      if (mismatch === 'malformed') return undefined as unknown as WorkbenchAutomationRestoreContent
      return result
    })
    try {
      await f.session.open(snapshotA)
      expect(f.session.state).toEqual({ status: 'ERROR', snapshotId: snapshotA, code: 'RESTORE_UNAVAILABLE' })
      expect(JSON.stringify(f.session.state)).not.toContain('PRIVATE_')
      expect(f.session.apply()).toBe(false)
      expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
    } finally { f.scope.stop() }
  })

  it('keeps server errors opaque and refreshes a conflicted baseline without retrying or applying', async () => {
    const f = fixture()
    try {
      f.query.mockRejectedValueOnce(new Error('PRIVATE_NETWORK_BODY'))
      await f.session.open(snapshotA)
      expect(f.session.state).toEqual({ status: 'ERROR', snapshotId: snapshotA, code: 'RESTORE_UNAVAILABLE' })
      f.query.mockRejectedValueOnce({ code: 'AUTOMATION_RESTORE_LIMIT', message: 'PRIVATE_LIMIT_BODY', details: { source: 'PRIVATE_SOURCE_FRAGMENT' } })
      await f.session.open(snapshotA)
      expect(f.session.state).toEqual({ status: 'ERROR', snapshotId: snapshotA, code: 'AUTOMATION_RESTORE_LIMIT' })
      expect(JSON.stringify(f.session.state)).not.toContain('PRIVATE_')
      f.query.mockRejectedValueOnce({ code: 'DRAFT_VERSION_CONFLICT', message: 'PRIVATE_CONFLICT_BODY', details: { expectedVersion: 3, actualVersion: 9 } })
      await f.session.open(snapshotA)
      expect(f.refreshDetail).toHaveBeenCalledOnce()
      expect(f.query).toHaveBeenCalledTimes(3)
      expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
      expect(f.session.state).toEqual({ status: 'ERROR', snapshotId: snapshotA, code: 'DRAFT_VERSION_CONFLICT' })
      f.flushDraft.mockRejectedValueOnce(new Error('PRIVATE_SAVE_BODY'))
      await f.session.open(snapshotA)
      expect(f.session.state).toEqual({ status: 'ERROR', snapshotId: snapshotA, code: 'RESTORE_UNAVAILABLE' })
      expect(f.query).toHaveBeenCalledTimes(3)
    } finally { f.scope.stop() }
  })

  it.each(['save', 'query'] as const)('aborts an in-flight %s on scope disposal and ignores its late result', async stage => {
    const f = fixture(), saving = deferred<boolean>(), querying = deferred<WorkbenchAutomationRestoreContent>()
    if (stage === 'save') f.flushDraft.mockImplementationOnce(() => saving.promise)
    else f.query.mockImplementationOnce(() => querying.promise)
    const opening = f.session.open(snapshotA)
    await settled()
    const signal = stage === 'save' ? f.flushDraft.mock.calls[0]?.[0] : f.query.mock.calls[0]?.[2]
    f.scope.stop()
    expect(signal?.aborted).toBe(true)
    saving.resolve(true); querying.resolve(content({ automationId: 'automation-1', snapshotId: snapshotA, expectedDraftVersion: 3 }))
    await opening
    expect(f.session.state).toBeUndefined()
    expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
    expect(f.onApplied).not.toHaveBeenCalled()
  })

  it.each(['publish', 'archive'] as const)('blocks preparation and Apply around an in-flight %s state change', async blocking => {
    const f = fixture()
    const blocked = blocking === 'publish' ? f.publishing : f.archived
    try {
      blocked.value = true
      await f.session.open(snapshotA)
      expect(f.query).not.toHaveBeenCalled()
      expect(f.flushDraft).not.toHaveBeenCalled()
      blocked.value = false
      const pending = deferred<WorkbenchAutomationRestoreContent>()
      f.query.mockImplementationOnce(() => pending.promise)
      const opening = f.session.open(snapshotA)
      await settled()
      blocked.value = true
      pending.resolve(content({ automationId: 'automation-1', snapshotId: snapshotA, expectedDraftVersion: 3 }))
      await opening
      expect(f.session.stale).toBe(true)
      expect(f.session.apply()).toBe(false)
      expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
      blocked.value = false
      expect(f.session.apply()).toBe(true)
    } finally { f.scope.stop() }
  })

  it('stops after the flush if archiving or publishing starts before content is queried', async () => {
    for (const blocking of ['archive', 'publish'] as const) {
      const f = fixture(), saving = deferred<boolean>()
      f.flushDraft.mockImplementationOnce(() => saving.promise)
      try {
        const opening = f.session.open(snapshotA)
        if (blocking === 'archive') f.archived.value = true
        else f.publishing.value = true
        saving.resolve(true)
        await opening
        expect(f.session.state).toEqual({ status: 'ERROR', snapshotId: snapshotA, code: 'DRAFT_NOT_SAVED' })
        expect(f.query).not.toHaveBeenCalled()
        expect(f.replaceFromSnapshot).not.toHaveBeenCalled()
      } finally { f.scope.stop() }
    }
  })

  it('lets the Draft owner reject an edit committed by Apply before the document can be replaced', async () => {
    const f = fixture()
    try {
      await f.session.open(snapshotA)
      f.commitInputs.mockImplementationOnce(() => { f.phase.value = 'DIRTY'; return true })
      expect(f.session.apply()).toBe(false)
      expect(f.document.value).toEqual(saved())
      expect(f.session.state).toMatchObject({ status: 'READY', content: { expectedDraftVersion: 3 } })
      expect(f.session.stale).toBe(true)
      expect(f.onApplied).not.toHaveBeenCalled()
    } finally { f.scope.stop() }
  })

  it('does not flush or query for malformed snapshot IDs, an absent client or an absent Automation', async () => {
    const f = fixture()
    try {
      for (const id of ['PRIVATE_SOURCE_VALUE', `rev_${'a'.repeat(33)}`, `snap_${'G'.repeat(32)}`]) await f.session.open(id)
      f.client.value = undefined
      await f.session.open(snapshotA)
      f.client.value = { query: f.query, action: vi.fn(), subscribe: vi.fn() } as unknown as WorkbenchConsoleClient
      f.automationId.value = undefined
      await f.session.open(snapshotA)
      expect(f.session.state).toBeUndefined()
      expect(f.commitInputs).not.toHaveBeenCalled()
      expect(f.flushDraft).not.toHaveBeenCalled()
      expect(f.query).not.toHaveBeenCalled()
    } finally { f.scope.stop() }
  })

  it('uses the actual Draft owner to save focused edits before prepare and fences Apply after a synchronous selection change', async () => {
    const scope = effectScope(), automationId = ref('automation-1'), saving = deferred<{ draft: AutomationDraftDocument }>()
    const query = vi.fn(async (_ref: unknown, input: WorkbenchAutomationRestoreContentQueryInput) => content(input)), onApplied = vi.fn()
    const action = vi.fn((_ref: unknown, _input: WorkbenchSaveAutomationDraftInput) => saving.promise)
    const client = { query, action, subscribe: vi.fn() } as unknown as WorkbenchConsoleClient
    const detail = shallowRef({ automation: { id: 'automation-1' }, draft: saved() } as WorkbenchAutomationDetail)
    const authoring = scope.run(() => useAutomationDraftDocument({ client, automationId, detail, reloadDetail() {}, autosaveDelayMs: 60_000 }))!
    const commitInputs = vi.fn(() => true)
    commitInputs.mockImplementationOnce(() => { authoring.setWaitExpression('wait', 'durationMs', { type: 'literal', value: 99 }); return true })
    const session = scope.run(() => useAutomationRestoration({ client: () => client, automationId: () => automationId.value, authoring,
      canPrepare: () => authoring.canPublish, commitInputs, onApplied, refreshDetail() {} }))!
    try {
      const opening = session.open(snapshotA)
      await vi.waitFor(() => expect(action).toHaveBeenCalledOnce())
      expect(query).not.toHaveBeenCalled()
      expect(action.mock.calls[0]?.[1]).toMatchObject({ expectedVersion: 3, source: { flow: { durationMs: { value: 99 } } } })
      saving.resolve({ draft: { ...saved(4), source: action.mock.calls[0]![1].source } })
      await opening
      expect(session.state).toMatchObject({ status: 'READY', content: { expectedDraftVersion: 4 } })
      expect(authoring.document!.version).toBe(4)
      automationId.value = 'automation-2'
      // The author's normal selection watcher has not run yet, but the live identity fence already blocks it.
      expect(authoring.document!.automationId).toBe('automation-1')
      expect(session.apply()).toBe(false)
      expect(authoring.document!.source.flow).toHaveProperty('durationMs.value', 99)
      expect(onApplied).not.toHaveBeenCalled()
    } finally { scope.stop() }
  })
})
