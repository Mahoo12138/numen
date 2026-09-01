import type { AutomationSource } from '@numen/core'
import { describe, expect, it } from 'vitest'
import type {
  WorkbenchAutomationControlKind,
  WorkbenchAutomationDraft,
  WorkbenchAutomationInsertItem,
} from '../src/contracts.js'
import { applyAutomationSourceCommand } from '../src/automation-source-editing.js'
import {
  reduceAutomationDraftDocument,
  type AutomationDraftDocumentState,
} from '../src/useAutomationDraftDocument.js'

const source: AutomationSource = {
  triggers: [],
  flow: { type: 'block', id: 'root', steps: [] },
}

function controlItem(control: WorkbenchAutomationControlKind): WorkbenchAutomationInsertItem {
  return { kind: 'control', control, title: control, description: `${control} control` }
}

const waitItem = controlItem('wait')

function insert(nextSource: AutomationSource, item: WorkbenchAutomationInsertItem = waitItem): AutomationSource {
  return applyAutomationSourceCommand(nextSource, { type: 'INSERT', item }).source
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
    selectedNodeId: undefined,
    document: undefined,
    savePhase: 'UNAVAILABLE',
    editRevision: 0,
    undoStack: [],
    redoStack: [],
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
    const once = insert(source)
    const twice = insert(once)

    expect(once.flow).toMatchObject({ type: 'block', steps: [{ id: 'wait-1' }] })
    expect(twice.flow).toMatchObject({ type: 'block', steps: [{ id: 'wait-1' }, { id: 'wait-2' }] })

    const wrapped = insert({
      triggers: [],
      flow: { type: 'wait', id: 'existing', durationMs: { type: 'literal', value: 1_000 } },
    })
    expect(wrapped.flow).toMatchObject({
      type: 'block',
      id: 'flow-1',
      steps: [{ id: 'existing' }, { id: 'wait-1' }],
    })
  })

  it('inserts structured controls and capability references through the same command seam', () => {
    let edited = source
    for (const control of ['if', 'parallel', 'race', 'foreach'] as const) {
      edited = insert(edited, controlItem(control))
    }
    edited = insert(edited, {
      kind: 'capability',
      capability: { id: 'test:weather', version: 2 },
      capabilityKind: 'query',
      title: 'Weather',
      providerAvailable: false,
      connectionSlots: ['account'],
      connectionRequirements: [{ name: 'account', required: true, accepts: ['test:weather'] }],
      inputSchemaSupported: true,
      inputFields: [{
        name: 'units',
        label: 'Units',
        type: 'enum',
        schemaType: 'union',
        required: false,
        defaultValue: 'metric',
        options: [{ label: 'metric', value: 'metric' }, { label: 'imperial', value: 'imperial' }],
      }],
    })

    expect(edited.flow).toMatchObject({
      type: 'block',
      steps: [
        { type: 'if', id: 'if-1', then: { type: 'block', id: 'if-1-then-1', steps: [] } },
        { type: 'parallel', id: 'parallel-1', branches: [{ id: 'parallel-1-branch-1' }, { id: 'parallel-1-branch-2' }] },
        { type: 'race', id: 'race-1', branches: [{ id: 'race-1-branch-1' }, { id: 'race-1-branch-2' }] },
        { type: 'foreach', id: 'foreach-1', body: { id: 'foreach-1-body-1' }, concurrency: 1 },
        {
          type: 'capability',
          id: 'capability-1',
          capability: { id: 'test:weather', version: 2 },
          input: { units: { type: 'literal', value: 'metric' } },
        },
      ],
    })
  })

  it('edits Capability expressions and named Connection bindings as Source commands', () => {
    const capabilitySource: AutomationSource = {
      triggers: [],
      flow: {
        type: 'capability',
        id: 'weather',
        capability: { id: 'test:weather', version: 1 },
        connection: 'legacy-connection',
        input: { city: { type: 'ref', path: 'trigger.city' } },
      },
    }
    const withInput = applyAutomationSourceCommand(capabilitySource, {
      type: 'SET_CAPABILITY_INPUT',
      nodeId: 'weather',
      fieldName: 'city',
      expression: { type: 'literal', value: 'Hangzhou' },
    }).source
    const withConnection = applyAutomationSourceCommand(withInput, {
      type: 'SET_CAPABILITY_CONNECTION',
      nodeId: 'weather',
      slotName: 'account',
      connectionId: 'conn-weather',
    }).source

    expect(withConnection.flow).toMatchObject({
      type: 'capability',
      input: { city: { type: 'literal', value: 'Hangzhou' } },
      connections: { account: 'conn-weather' },
    })
    expect(JSON.stringify(withConnection)).not.toContain('legacy-connection')

    const withReference = applyAutomationSourceCommand(withConnection, {
      type: 'SET_CAPABILITY_INPUT',
      nodeId: 'weather',
      fieldName: 'city',
      expression: { type: 'ref', path: 'trigger.city' },
    }).source
    const withTemplate = applyAutomationSourceCommand(withReference, {
      type: 'SET_CAPABILITY_INPUT',
      nodeId: 'weather',
      fieldName: 'city',
      expression: { type: 'template', parts: ['Weather in ', { ref: 'trigger.city' }] },
    }).source
    expect(withTemplate.flow).toMatchObject({
      type: 'capability',
      input: { city: { type: 'template', parts: ['Weather in ', { ref: 'trigger.city' }] } },
    })

    const cleared = applyAutomationSourceCommand(withTemplate, {
      type: 'SET_CAPABILITY_CONNECTION',
      nodeId: 'weather',
      slotName: 'account',
    }).source
    const withoutInput = applyAutomationSourceCommand(cleared, {
      type: 'SET_CAPABILITY_INPUT',
      nodeId: 'weather',
      fieldName: 'city',
    }).source
    expect(cleared.flow).not.toHaveProperty('connections')
    expect(withoutInput.flow).toMatchObject({ type: 'capability', input: {} })
  })

  it('keeps newer local edits when an earlier autosave completes', () => {
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item: waitItem } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'INSERT', item: waitItem } })
    expect(state.selectedNodeId).toBe('wait-2')
    state = reduceAutomationDraftDocument(state, {
      type: 'SAVE_SUCCESS',
      result: { draft: draft(2, insert(source)) },
    })

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
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item: waitItem } })
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

  it('edits nested Wait expressions through one Source command and enforces one wake source', () => {
    const nested: AutomationSource = {
      triggers: [],
      flow: {
        type: 'if',
        id: 'condition',
        condition: { type: 'literal', value: true },
        then: {
          type: 'block',
          id: 'then',
          steps: [{ type: 'wait', id: 'nested-wait', until: { type: 'literal', value: 'later' } }],
        },
      },
    }

    const edited = applyAutomationSourceCommand(nested, {
      type: 'SET_WAIT_EXPRESSION',
      nodeId: 'nested-wait',
      field: 'durationMs',
      expression: { type: 'call', function: 'core:add', arguments: [
        { type: 'ref', path: 'input.baseDelay' },
        { type: 'literal', value: 12_500 },
      ] },
    }).source
    expect(edited.flow).toMatchObject({
      type: 'if',
      then: {
        steps: [{
          type: 'wait',
          id: 'nested-wait',
          durationMs: { type: 'call', function: 'core:add' },
        }],
      },
    })
    expect(JSON.stringify(edited)).not.toContain('until')
    const until = applyAutomationSourceCommand(edited, {
      type: 'SET_WAIT_EXPRESSION',
      nodeId: 'nested-wait',
      field: 'until',
      expression: { type: 'ref', path: 'trigger.resumeAt' },
    }).source
    expect(until.flow).toMatchObject({
      type: 'if',
      then: { steps: [{ until: { type: 'ref', path: 'trigger.resumeAt' } }] },
    })
    expect(JSON.stringify(until)).not.toContain('durationMs')
    expect(applyAutomationSourceCommand(until, {
      type: 'SET_WAIT_EXPRESSION',
      nodeId: 'missing',
      field: 'durationMs',
      expression: { type: 'literal', value: 1_000 },
    }).source).toBe(until)
  })

  it('maintains bounded full-document undo and redo history across saved edits', () => {
    let state = loadedState()
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'INSERT', item: waitItem } })
    state = reduceAutomationDraftDocument(state, {
      type: 'EDIT',
      command: {
        type: 'SET_WAIT_EXPRESSION',
        nodeId: 'wait-1',
        field: 'durationMs',
        expression: { type: 'literal', value: 5_000 },
      },
    })

    expect(state.undoStack).toHaveLength(2)
    expect(state.redoStack).toHaveLength(0)
    expect(state.document?.source.flow).toMatchObject({ steps: [{ durationMs: { value: 5_000 } }] })

    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document?.source.flow).toMatchObject({ steps: [{ durationMs: { value: 60_000 } }] })
    expect(state.redoStack).toHaveLength(1)

    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document?.source.flow).toMatchObject({ steps: [] })
    expect(state.selectedNodeId).toBeUndefined()

    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document?.source.flow).toMatchObject({ steps: [{ durationMs: { value: 60_000 } }] })
    expect(state.selectedNodeId).toBe('wait-1')

    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, {
      type: 'SAVE_SUCCESS',
      result: { draft: draft(2, state.document!.source) },
    })
    expect(state.savePhase).toBe('CLEAN')
    expect(state.undoStack).toHaveLength(1)
    expect(state.redoStack).toHaveLength(1)
  })

  it('caps history and preserves an undo made while autosave is in flight', () => {
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item: waitItem } })
    for (let durationMs = 1; durationMs <= 55; durationMs += 1) {
      state = reduceAutomationDraftDocument(state, {
        type: 'EDIT',
        command: {
          type: 'SET_WAIT_EXPRESSION',
          nodeId: 'wait-1',
          field: 'durationMs',
          expression: { type: 'literal', value: durationMs },
        },
      })
    }
    expect(state.undoStack).toHaveLength(50)

    const requestedSource = state.document!.source
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    const undoneSource = state.document!.source
    state = reduceAutomationDraftDocument(state, {
      type: 'SAVE_SUCCESS',
      result: { draft: draft(2, requestedSource) },
    })

    expect(state.savePhase).toBe('DIRTY')
    expect(state.document?.version).toBe(2)
    expect(state.document?.source).toBe(undoneSource)
    expect(state.document?.source).not.toBe(requestedSource)
  })

  it('preserves history across same-version refresh and resets it for an external version', () => {
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item: waitItem } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, {
      type: 'SAVE_SUCCESS',
      result: { draft: draft(2, state.document!.source) },
    })
    expect(state.undoStack).toHaveLength(1)

    state = reduceAutomationDraftDocument(state, {
      type: 'SERVER',
      automationId: 'automation-1',
      draft: draft(2, state.document!.source),
    })
    expect(state.undoStack).toHaveLength(1)

    state = reduceAutomationDraftDocument(state, {
      type: 'SERVER',
      automationId: 'automation-1',
      draft: draft(3),
    })
    expect(state.undoStack).toHaveLength(0)
    expect(state.redoStack).toHaveLength(0)
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
