import type { AutomationSource } from '@numen/core'
import { describe, expect, it } from 'vitest'
import type { WorkbenchAutomationDraft } from '../src/contracts.js'
import {
  appendDefaultWait,
  reduceAutomationDraftDocument,
  type AutomationDraftDocumentState,
} from '../src/useAutomationDraftDocument.js'

const source: AutomationSource = {
  triggers: [],
  flow: { type: 'block', id: 'root', steps: [] },
}

function draft(version: number, nextSource: AutomationSource = source): WorkbenchAutomationDraft {
  return {
    source: nextSource,
    presentation: {},
    version,
    updatedAt: `2026-08-21T00:0${version}:00.000Z`,
  }
}

function unavailableState(): AutomationDraftDocumentState {
  return {
    selectedAutomationId: undefined,
    document: undefined,
    savePhase: 'UNAVAILABLE',
    editRevision: 0,
    pendingSave: undefined,
    conflict: undefined,
    saveError: undefined,
    publishPending: false,
    pendingPublish: undefined,
    publishError: undefined,
    problems: [],
  }
}

function loadedState(): AutomationDraftDocumentState {
  let state = reduceAutomationDraftDocument(unavailableState(), { type: 'SELECT', automationId: 'automation-1' })
  state = reduceAutomationDraftDocument(state, { type: 'SERVER', automationId: 'automation-1', draft: draft(1) })
  return state
}

describe('local Automation Draft document', () => {
  it('appends stable wait ids and preserves a non-block flow by wrapping it', () => {
    const once = appendDefaultWait(source)
    const twice = appendDefaultWait(once)

    expect(once.flow).toMatchObject({ type: 'block', steps: [{ id: 'wait-1' }] })
    expect(twice.flow).toMatchObject({ type: 'block', steps: [{ id: 'wait-1' }, { id: 'wait-2' }] })

    const wrapped = appendDefaultWait({
      triggers: [],
      flow: { type: 'wait', id: 'existing', durationMs: { type: 'literal', value: 1_000 } },
    })
    expect(wrapped.flow).toMatchObject({
      type: 'block',
      id: 'flow-1',
      steps: [{ id: 'existing' }, { id: 'wait-1' }],
    })
  })

  it('keeps newer local edits when an earlier autosave completes', () => {
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'ADD_WAIT' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'ADD_WAIT' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: draft(2, appendDefaultWait(source)) } })

    expect(state.savePhase).toBe('DIRTY')
    expect(state.document?.version).toBe(2)
    expect(state.document?.source.flow).toMatchObject({
      type: 'block',
      steps: [{ id: 'wait-1' }, { id: 'wait-2' }],
    })

    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: draft(3, state.document!.source) } })
    expect(state.savePhase).toBe('CLEAN')
    expect(state.document?.version).toBe(3)
  })

  it('protects a conflicted local document until the user explicitly reloads', () => {
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'ADD_WAIT' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, {
      type: 'SAVE_FAILURE',
      error: {
        code: 'DRAFT_VERSION_CONFLICT',
        message: 'Draft version conflict.',
        details: { expectedVersion: 1, actualVersion: 2 },
      },
    })

    expect(state.savePhase).toBe('CONFLICT')
    expect(state.conflict).toEqual({ expectedVersion: 1, actualVersion: 2 })
    const localSource = state.document?.source

    state = reduceAutomationDraftDocument(state, { type: 'SERVER', automationId: 'automation-1', draft: draft(2) })
    expect(state.document?.source).toBe(localSource)

    state = reduceAutomationDraftDocument(state, { type: 'RELOAD' })
    state = reduceAutomationDraftDocument(state, { type: 'SERVER', automationId: 'automation-1', draft: draft(2) })
    expect(state.savePhase).toBe('CLEAN')
    expect(state.document?.version).toBe(2)
    expect(state.document?.source).toEqual(source)
  })

  it('projects authoritative publish diagnostics without changing the Draft', () => {
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'PUBLISH_REQUEST' })
    state = reduceAutomationDraftDocument(state, {
      type: 'PUBLISH_FAILURE',
      error: {
        code: 'AUTOMATION_PUBLISH_INVALID',
        message: 'Automation Draft cannot be published.',
        details: {
          diagnostics: [{
            severity: 'error',
            code: 'WAIT_SOURCE_INVALID',
            message: 'Wait duration must be positive.',
            source: { nodeId: 'wait-1', fieldPath: 'durationMs' },
          }],
        },
      },
    })

    expect(state.publishPending).toBe(false)
    expect(state.publishError).toBeUndefined()
    expect(state.problems).toEqual([expect.objectContaining({ code: 'WAIT_SOURCE_INVALID' })])
    expect(state.document?.version).toBe(1)
  })
})
