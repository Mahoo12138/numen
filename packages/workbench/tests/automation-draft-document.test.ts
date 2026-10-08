import type { AutomationSource } from '@numenjs/core'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, shallowRef } from 'vue'
import type {
  WorkbenchAutomationControlKind,
  WorkbenchAutomationDetail,
  WorkbenchAutomationDraft,
  WorkbenchAutomationInsertItem,
  WorkbenchSaveAutomationDraftInput,
} from '../src/contracts.js'
import { applyAutomationSourceCommand } from '../src/automation-source-editing.js'
import { resolveAutomationDropTarget } from '../src/automation-drag.js'
import type { WorkbenchConsoleClient } from '../src/types.js'
import {
  canPublishAutomationDraft,
  useAutomationDraftDocument,
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
  return applyAutomationSourceCommand(nextSource, { type: 'INSERT', item, target: item.kind === 'trigger' ? { kind: 'triggers' } : nextSource.flow.type === 'block' ? { kind: 'block', blockId: nextSource.flow.id } : { kind: 'root' } }).source
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
  it('keeps input declarations in full-document history through concurrent autosave', () => {
    let state = loadedState()
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'SET_AUTOMATION_INPUTS', inputs: { message: { type: 'string', required: true } } } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    const saved = state.document!.source
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'SET_AUTOMATION_INPUTS', inputs: {} } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: draft(2, saved) } })
    expect(state).toMatchObject({ savePhase: 'DIRTY', document: { source: { inputs: {} } } })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.source.inputs).toEqual({ message: { type: 'string', required: true } })
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document!.source.inputs).toEqual({})
    expect(state.document!.source.flow).toEqual(saved.flow)
  })

  it('keeps deletion and sorting in full-document history and preserves edits made during autosave', () => {
    let state = loadedState()
    for (let i = 0; i < 3; i++) state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    const savedSource = state.document!.source
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'MOVE_STEP', nodeId: 'wait-3', direction: 'up' } })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'DELETE_STEP', nodeId: 'wait-3' } })
    expect(state.selectedNodeId).toBe('wait-2')
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: draft(2, savedSource) } })
    expect(state).toMatchObject({ savePhase: 'DIRTY', document: { version: 2, source: { flow: { steps: [{ id: 'wait-1' }, { id: 'wait-2' }] } } } })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.selectedNodeId).toBe('wait-3')
    expect(state.document!.source.flow).toMatchObject({ steps: [{ id: 'wait-1' }, { id: 'wait-3' }, { id: 'wait-2' }] })
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    for (const nodeId of ['wait-2', 'wait-1']) state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'DELETE_STEP', nodeId } })
    expect(state.selectedNodeId).toBeUndefined()
    expect(state.document!.source.flow).toMatchObject({ steps: [] })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_FAILURE', error: { code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 2, actualVersion: 3 } } })
    expect(reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'DELETE_STEP', nodeId: 'wait-1' } })).toBe(state)
  })

  it('enters recovery on a publish version conflict and ignores older server Drafts after reload', () => {
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'PUBLISH_REQUEST' })
    const local = state.document
    state = reduceAutomationDraftDocument(state, { type: 'PUBLISH_FAILURE', error: {
      code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 3 },
    } })
    expect(state).toMatchObject({ savePhase: 'CONFLICT', publishPending: false, document: local })
    state = reduceAutomationDraftDocument(state, { type: 'RELOAD' })
    state = reduceAutomationDraftDocument(state, { type: 'SERVER', automationId: 'automation-1', draft: draft(3) })
    const current = state
    expect(reduceAutomationDraftDocument(state, { type: 'SERVER', automationId: 'automation-1', draft: draft(2) })).toBe(current)
  })

  it('inserts and edits extension inputs through document history without altering the versioned reference', () => {
    const item: WorkbenchAutomationInsertItem = {
      kind: 'extension', control: { id: 'test:pause', version: 2 }, title: 'Pause', description: '', inputSchemaSupported: true,
      inputFields: [{ name: 'duration', label: 'Duration', type: 'number', schemaType: 'number', required: true, defaultValue: 10 }],
    }
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item, target: { kind: 'block', blockId: 'root' } } })
    const inserted = state.document!.source
    expect(inserted.flow).toMatchObject({ steps: [{ type: 'extension', id: 'control-1', control: item.control, input: { duration: { type: 'literal', value: 10 } } }] })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'SET_EXTENSION_INPUT', nodeId: 'control-1', fieldName: 'duration', expression: { type: 'ref', path: 'input.duration' } } })
    expect(state.document!.source.flow).toMatchObject({ steps: [{ control: item.control, input: { duration: { type: 'ref', path: 'input.duration' } } }] })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.source).toEqual(inserted)
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document!.source.flow).toMatchObject({ steps: [{ input: { duration: { type: 'ref' } } }] })
  })

  it('inserts, configures, reorders, and deletes Trigger declarations through document history', () => {
    const triggerItem: WorkbenchAutomationInsertItem = {
      kind: 'trigger', capability: { id: 'schedule:cron', version: 1 }, title: 'Cron Schedule',
      providerAvailable: true, connectionSlots: [], connectionRequirements: [], inputSchemaSupported: true,
      inputFields: [
        { name: 'cron', label: 'Cron', type: 'string', schemaType: 'string', required: true },
        { name: 'timezone', label: 'Timezone', type: 'string', schemaType: 'string', required: false, defaultValue: 'UTC' },
      ],
    }
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item: triggerItem, target: { kind: 'triggers' } } })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'INSERT', item: triggerItem, target: { kind: 'triggers' } } })
    expect(state.document!.source.triggers).toMatchObject([
      { id: 'trigger-1', capability: triggerItem.capability, config: { timezone: 'UTC' } },
      { id: 'trigger-2', capability: triggerItem.capability, config: { timezone: 'UTC' } },
    ])
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: {
      type: 'SET_TRIGGER_CONFIG', nodeId: 'trigger-2', fieldName: 'cron', value: '* * * * *',
    } })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: {
      type: 'MOVE_STEP', nodeId: 'trigger-2', direction: 'up',
    } })
    expect(state.document!.source.triggers[0]).toMatchObject({ id: 'trigger-2', config: { cron: '* * * * *', timezone: 'UTC' } })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'DELETE_STEP', nodeId: 'trigger-1' } })
    expect(state.document!.source.triggers.map(trigger => trigger.id)).toEqual(['trigger-2'])
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.source.triggers).toHaveLength(2)
  })

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
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } } })
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
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } } })
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

  it('edits nested control expressions without changing branches and preserves history through autosave', () => {
    const nested: AutomationSource = {
      triggers: [],
      flow: {
        type: 'foreach', id: 'each', concurrency: 3,
        items: { type: 'literal', value: [] },
        body: { type: 'block', id: 'body', steps: [{
          type: 'if', id: 'check', condition: { type: 'literal', value: true },
          then: { type: 'block', id: 'yes', steps: [] },
          else: { type: 'block', id: 'no', steps: [] },
        }] },
      },
    }
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'SERVER', automationId: 'automation-1', draft: draft(2, nested) })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: {
      type: 'SET_CONTROL_EXPRESSION', nodeId: 'check', field: 'condition',
      expression: { type: 'call', function: 'core:equal', arguments: [
        { type: 'ref', path: 'loop.item' }, { type: 'literal', value: 'ready' },
      ] },
    } })
    const conditionSource = state.document!.source
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: {
      type: 'SET_CONTROL_EXPRESSION', nodeId: 'each', field: 'items',
      expression: { type: 'ref', path: 'input.items' },
    } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: draft(3, conditionSource) } })
    expect(state.savePhase).toBe('DIRTY')
    expect(state.document?.source.flow).toMatchObject({
      concurrency: 3, items: { type: 'ref', path: 'input.items' },
      body: { steps: [{ condition: { type: 'call' }, then: { id: 'yes' }, else: { id: 'no' } }] },
    })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document?.source).toEqual(conditionSource)
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document?.source).toEqual(nested)
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document?.source).toEqual(conditionSource)
    for (const nodeId of ['missing', 'each']) {
      expect(applyAutomationSourceCommand(nested, {
        type: 'SET_CONTROL_EXPRESSION', nodeId, field: 'condition', expression: { type: 'literal', value: false },
      }).source).toBe(nested)
    }
    expect(nested.flow).toMatchObject({ items: { type: 'literal', value: [] } })
  })

  it('maintains bounded full-document undo and redo history across saved edits', () => {
    let state = loadedState()
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } } })
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
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } } })
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
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'EDIT', command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } } })
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

  it('queues one Publish request through the save caused by a focused field losing focus', () => {
    let state = reduceAutomationDraftDocument(loadedState(), {
      type: 'EDIT',
      command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } },
    })
    expect(state.savePhase).toBe('DIRTY')
    expect(canPublishAutomationDraft(state)).toBe(true)

    state = reduceAutomationDraftDocument(state, { type: 'PUBLISH_REQUEST' })
    expect(canPublishAutomationDraft(state)).toBe(false)
    expect(state).toMatchObject({
      savePhase: 'SAVING',
      publishPending: true,
      pendingSave: { expectedVersion: 1 },
      pendingPublish: undefined,
    })

    state = reduceAutomationDraftDocument(state, {
      type: 'SAVE_SUCCESS',
      result: { draft: draft(2, state.document!.source) },
    })
    expect(state).toMatchObject({
      savePhase: 'CLEAN',
      publishPending: true,
      pendingSave: undefined,
      pendingPublish: { expectedVersion: 2 },
    })
  })

  it('publishes the newest snapshot when an edit already landed during autosave', () => {
    let state = reduceAutomationDraftDocument(loadedState(), {
      type: 'EDIT',
      command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } },
    })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    const firstSaveSource = state.pendingSave!.source
    state = reduceAutomationDraftDocument(state, {
      type: 'EDIT',
      command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } },
    })
    state = reduceAutomationDraftDocument(state, { type: 'PUBLISH_REQUEST' })

    state = reduceAutomationDraftDocument(state, {
      type: 'SAVE_SUCCESS',
      result: { draft: draft(2, firstSaveSource) },
    })
    expect(state).toMatchObject({
      savePhase: 'SAVING',
      publishPending: true,
      pendingSave: { expectedVersion: 2, editRevision: 2 },
      pendingPublish: undefined,
    })
    expect(state.pendingSave!.source.flow).toMatchObject({ steps: [{ id: 'wait-1' }, { id: 'wait-2' }] })

    state = reduceAutomationDraftDocument(state, {
      type: 'SAVE_SUCCESS',
      result: { draft: draft(3, state.pendingSave!.source) },
    })
    expect(state).toMatchObject({
      savePhase: 'CLEAN',
      publishPending: true,
      pendingSave: undefined,
      pendingPublish: { expectedVersion: 3 },
    })
  })
})


describe('structural history and presentation', () => {
  const nested: AutomationSource = {
    triggers: [], flow: { type: 'block', id: 'root', steps: [{
      type: 'if', id: 'condition', condition: { type: 'literal', value: true },
      then: { type: 'block', id: 'then', steps: [{ type: 'wait', id: 'waiting', durationMs: { type: 'literal', value: 1 } }] },
      else: { type: 'block', id: 'else', steps: [{ type: 'wait', id: 'fallback', durationMs: { type: 'literal', value: 2 } }] },
    }] },
  }
  function prepared() {
    return reduceAutomationDraftDocument(loadedState(), { type: 'SERVER', automationId: 'automation-1', draft: {
      ...draft(2, nested), presentation: { collapsedNodes: ['else'], untouched: { value: 'opaque' } },
    } })
  }

  it('restores nonempty branch, presentation and selection with one undo while a save completes late', () => {
    let state = reduceAutomationDraftDocument(prepared(), { type: 'SELECT_NODE', nodeId: 'condition' })
    const before = state.document!
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'REMOVE_ELSE', nodeId: 'condition' } })
    expect(state.undoStack).toHaveLength(1)
    expect(state.document!.presentation).toEqual({ collapsedNodes: [], untouched: { value: 'opaque' } })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    const saving = state.document!
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: { ...draft(3, saving.source), presentation: saving.presentation } } })
    expect(state.savePhase).toBe('DIRTY')
    expect(state.document!.source).toEqual(before.source)
    expect(state.document!.presentation).toEqual(before.presentation)
    expect(state.selectedNodeId).toBe('condition')
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document!.source).toEqual(saving.source)
    expect(state.document!.presentation).toEqual(saving.presentation)
  })

  it('moves into a collapsed receiver with one undo and keeps the restored document after a late save', () => {
    let state = reduceAutomationDraftDocument(prepared(), { type: 'SELECT_NODE', nodeId: 'waiting' })
    const before = state.document!
    const intent = resolveAutomationDropTarget(before.source, 'waiting', 'else', 'inside')
    if (!intent.allowed) throw new Error('Expected a valid collapsed receiver')
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'MOVE_TO', nodeId: 'waiting', target: intent.target } })
    expect(state.undoStack).toHaveLength(1)
    expect(state.selectedNodeId).toBe('waiting')
    expect(state.document!.presentation).toEqual({ collapsedNodes: [], untouched: { value: 'opaque' } })
    const moved = state.document!
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: { ...draft(3, moved.source), presentation: moved.presentation } } })
    expect(state.document!.source).toEqual(before.source)
    expect(state.document!.presentation).toEqual(before.presentation)
    expect(state.selectedNodeId).toBe('waiting')
    expect(state.savePhase).toBe('DIRTY')
    expect(state.undoStack).toHaveLength(0)
    expect(state.redoStack).toHaveLength(1)
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document!.source).toEqual(moved.source)
    expect(state.document!.presentation).toEqual(moved.presentation)
  })

  it('copies presentation from the clipboard snapshot and leaves a stale insertion out of history', () => {
    let state = prepared()
    const copied = state.document!
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'DELETE_STEP', nodeId: 'condition' } })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', copiedPresentation: copied.presentation,
      command: { type: 'COPY_TO', nodeId: 'condition', target: { kind: 'block', blockId: 'root' }, source: copied.source },
    })
    const flow = state.document!.source.flow
    if (flow.type !== 'block' || flow.steps[0]?.type !== 'if') throw new Error('fixture copy expected')
    const copy = flow.steps[0]
    expect(copy.id).not.toBe('condition')
    expect(state.document!.presentation.collapsedNodes).toEqual([copy.else!.id])
    const before = state
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'else' } } })
    expect(state.document).toBe(before.document)
    expect(state.undoStack).toBe(before.undoStack)
    expect(state.editError).toBe('TARGET_INVALID')
  })

  it('selects a hidden descendant for read-only viewing without changing draft or save history', () => {
    const before = prepared()
    const state = reduceAutomationDraftDocument(before, { type: 'SELECT_NODE', nodeId: 'fallback', reveal: false })
    expect(state.selectedNodeId).toBe('fallback')
    expect(state.document).toBe(before.document)
    expect(state.document!.presentation.collapsedNodes).toEqual(['else'])
    expect(state.undoStack).toBe(before.undoStack)
    expect(state.redoStack).toBe(before.redoStack)
    expect(state.editRevision).toBe(before.editRevision)
    expect(state.savePhase).toBe('CLEAN')
    expect(state.pendingSave).toBe(before.pendingSave)
  })

  it('reveals selected descendants without unlocking a conflicted document', () => {
    let state = prepared()
    state = reduceAutomationDraftDocument(state, { type: 'COLLAPSE', nodeId: 'condition', collapsed: true })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_FAILURE', error: { code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 2, actualVersion: 3 } } })
    const document = state.document
    state = reduceAutomationDraftDocument(state, { type: 'SELECT_NODE', nodeId: 'fallback' })
    expect(state.savePhase).toBe('CONFLICT')
    expect(state.document).toBe(document)
    expect(state.selectedNodeId).toBe('fallback')
    let editable = reduceAutomationDraftDocument(prepared(), { type: 'SELECT_NODE', nodeId: 'fallback' })
    expect(editable.document!.presentation.collapsedNodes).toEqual([])
    expect(editable.savePhase).toBe('DIRTY')
    expect(editable.document!.source).toBe(nested)
  })
})


it('keeps Copy immutable, makes Cut atomic at paste, and clears clipboard on Automation changes', async () => {
  const initial: AutomationSource = { triggers: [], flow: { type: 'block', id: 'root', steps: [
    { type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 10 } },
    { type: 'if', id: 'if', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'then', steps: [] } },
  ] } }
  const id = ref('automation-1')
  const scope = effectScope()
  const model = scope.run(() => useAutomationDraftDocument({
    automationId: id,
    detail: () => ({ automation: { id: 'automation-1' }, draft: draft(1, initial) }) as WorkbenchAutomationDetail,
    reloadDetail() {}, autosaveDelayMs: 60_000,
  }))!
  try {
    model.copyStep('wait')
    model.setWaitExpression('wait', 'durationMs', { type: 'literal', value: 99 })
    model.deleteStep('wait')
    expect(model.paste({ kind: 'block', blockId: 'then' })).toBe(true)
    const inserted = model.selectedNodeId!
    expect(model.document!.source.flow).toMatchObject({ steps: [{ then: { steps: [{ durationMs: { value: 10 } }] } }] })
    model.cutStep(inserted)
    const beforePaste = model.document!.source
    expect(model.paste({ kind: 'block', blockId: 'deleted-target' })).toBe(false)
    expect(model.document!.source).toBe(beforePaste)
    expect(model.clipboard?.mode).toBe('cut')
    expect(model.paste({ kind: 'block', blockId: 'root' })).toBe(true)
    expect(model.selectedNodeId).toBe(inserted)
    expect(model.clipboard).toBeUndefined()
    model.undo()
    expect(model.document!.source).toEqual(beforePaste)
    model.cutStep(inserted)
    model.deleteStep(inserted)
    expect(model.clipboard).toBeUndefined()
    model.undo()
    model.copyStep(inserted)
    id.value = 'automation-2'
    await nextTick()
    expect(model.clipboard).toBeUndefined()
    expect(model.document).toBeUndefined()
  } finally { scope.stop() }
})

describe('full-document snapshot restoration', () => {
  const original: AutomationSource = { triggers: [], flow: { type: 'block', id: 'root', steps: [
    { type: 'wait', id: 'selected', durationMs: { type: 'literal', value: 10 } },
  ] } }
  const restored: AutomationSource = { triggers: [{ id: 'trigger', capability: { id: 'unavailable:trigger', version: 9 }, config: { opaque: { retained: true } } }],
    inputs: { message: { type: 'string', default: { $resource: 'opaque-resource' } } },
    flow: { type: 'block', id: 'root', steps: [{ type: 'extension', id: 'control', control: { id: 'unavailable:control', version: 4 }, input: { future: { type: 'call', function: 'unavailable:function', arguments: [{ type: 'literal', value: { untouched: 'snapshot' } }] } } }] },
  }
  const originalPresentation = { collapsedNodes: ['original-stale-id'], opaque: { nested: ['original'] } }
  const restoredPresentation = { collapsedNodes: ['root', 'snapshot-stale-id'], future: { nested: ['snapshot'] } }

  function prepared() {
    const state = reduceAutomationDraftDocument(loadedState(), { type: 'SERVER', automationId: 'automation-1', draft: {
      ...draft(3, original), presentation: originalPresentation, baseRevisionId: 'rev-current-base',
    } })
    return reduceAutomationDraftDocument(state, { type: 'SELECT_NODE', nodeId: 'selected', reveal: false })
  }
  function restore(state: AutomationDraftDocumentState, overrides: Partial<{ automationId: string; expectedVersion: number; source: AutomationSource; presentation: typeof restoredPresentation }> = {}) {
    return reduceAutomationDraftDocument(state, { type: 'REPLACE_FROM_SNAPSHOT', automationId: 'automation-1', expectedVersion: 3,
      source: restored, presentation: restoredPresentation, expectedDocument: state.document!, ...overrides })
  }

  it('replaces opaque Source and Presentation in one history entry without changing saved identity or lineage', () => {
    const before = prepared()
    const incomingSource = structuredClone(restored) as AutomationSource & { unknownSource?: unknown }
    incomingSource.unknownSource = { future: { private: ['keep', null, 9] } }
    const incomingPresentation = structuredClone(restoredPresentation)
    let state = restore(before, { source: incomingSource, presentation: incomingPresentation })
    expect(state).toMatchObject({ savePhase: 'DIRTY', editRevision: before.editRevision + 1, selectedNodeId: undefined,
      document: { version: 3, updatedAt: before.document!.updatedAt, baseRevisionId: 'rev-current-base', source: incomingSource, presentation: incomingPresentation } })
    expect(state.undoStack).toEqual([{ source: before.document!.source, presentation: before.document!.presentation, selectedNodeId: 'selected' }])
    expect(state.redoStack).toEqual([])
    expect(state.document!.source).not.toBe(incomingSource)
    expect(state.document!.presentation).not.toBe(incomingPresentation)
    incomingSource.unknownSource = 'mutated after apply'
    incomingPresentation.future.nested.push('mutated after apply')
    expect((state.document!.source as typeof incomingSource).unknownSource).toEqual({ future: { private: ['keep', null, 9] } })
    expect(state.document!.presentation).toEqual(restoredPresentation)
    const replacement = state.document!
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document).toEqual(before.document)
    expect(state.selectedNodeId).toBe('selected')
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document).toEqual(replacement)
    expect(state.selectedNodeId).toBeUndefined()
  })

  it('retains a surviving selected node without revealing it or reconciling historical Presentation', () => {
    const before = prepared()
    const incoming = structuredClone(original)
    const state = restore(before, { source: incoming, presentation: restoredPresentation })
    expect(state.selectedNodeId).toBe('selected')
    expect(state.document!.presentation.collapsedNodes).toEqual(['root', 'snapshot-stale-id'])
    expect(state.document!.presentation).toEqual(restoredPresentation)
    expect(state.undoStack).toHaveLength(1)
  })

  it('records an accepted same-content restoration as one explicit operation, preserves older Undo and clears Redo', () => {
    // Build redo through a normal edit and Undo, then complete its existing CAS save.
    let state = reduceAutomationDraftDocument(prepared(), { type: 'EDIT', command: { type: 'INSERT', item: waitItem, target: { kind: 'block', blockId: 'root' } } })
    state = reduceAutomationDraftDocument(state, { type: 'EDIT', command: { type: 'SET_WAIT_EXPRESSION', nodeId: 'selected', field: 'durationMs', expression: { type: 'literal', value: 99 } } })
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: { ...draft(4, state.document!.source), presentation: state.document!.presentation, baseRevisionId: 'rev-current-base' } } })
    expect(state.redoStack).toHaveLength(1)
    const undoCount = state.undoStack.length, current = state.document!
    state = reduceAutomationDraftDocument(state, { type: 'REPLACE_FROM_SNAPSHOT', automationId: 'automation-1', expectedVersion: 4, expectedDocument: current, source: current.source, presentation: current.presentation })
    expect(state.undoStack).toHaveLength(undoCount + 1)
    expect(state.redoStack).toEqual([])
    expect(state.savePhase).toBe('DIRTY')
    expect(state.document).toEqual(current)
    expect(state.document).not.toBe(current)
  })

  it.each(['UNAVAILABLE', 'DIRTY', 'SAVING', 'CONFLICT', 'ERROR', 'RELOADING'] as const)('rejects a restore in %s without changing any state', savePhase => {
    const state = { ...prepared(), savePhase }
    expect(restore(state)).toBe(state)
  })

  it('rejects foreign, stale, switched, publishing and replaced same-version documents without changing history', () => {
    const state = prepared()
    expect(restore(state, { automationId: 'automation-other' })).toBe(state)
    expect(restore(state, { expectedVersion: 2 })).toBe(state)
    expect(restore(state, { expectedVersion: 4 })).toBe(state)
    const switched = { ...state, selectedAutomationId: 'automation-other' }
    expect(restore(switched)).toBe(switched)
    for (const blocked of [
      { ...state, publishPending: true },
      { ...state, pendingPublish: { automationId: 'automation-1', expectedVersion: 3 } },
      { ...state, pendingSave: { automationId: 'automation-1', expectedVersion: 3, source: original, presentation: originalPresentation, editRevision: 0 } },
    ]) expect(restore(blocked)).toBe(blocked)
    const reloaded = reduceAutomationDraftDocument(state, { type: 'SERVER', automationId: 'automation-1', draft: { ...draft(3, original), presentation: originalPresentation, baseRevisionId: 'rev-new-base' } })
    expect(reloaded.document).not.toBe(state.document)
    expect(reduceAutomationDraftDocument(reloaded, { type: 'REPLACE_FROM_SNAPSHOT', automationId: 'automation-1', expectedVersion: 3, expectedDocument: state.document!, source: restored, presentation: restoredPresentation })).toBe(reloaded)
  })

  it('preserves the restored edit against stale SERVER updates and saves Undo as a later CAS version', () => {
    const before = prepared()
    let state = restore(before)
    expect(reduceAutomationDraftDocument(state, { type: 'SERVER', automationId: 'automation-1', draft: { ...draft(4, original), presentation: originalPresentation } })).toBe(state)
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    expect(state.pendingSave).toMatchObject({ expectedVersion: 3, source: restored, presentation: restoredPresentation })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: { ...draft(4, restored), presentation: restoredPresentation, baseRevisionId: 'rev-current-base' } } })
    expect(state.savePhase).toBe('CLEAN')
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document).toMatchObject({ version: 4, baseRevisionId: 'rev-current-base', source: original, presentation: originalPresentation })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    expect(state.pendingSave).toMatchObject({ expectedVersion: 4, source: original, presentation: originalPresentation })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: { ...draft(5, original), presentation: originalPresentation, baseRevisionId: 'rev-current-base' } } })
    expect(state).toMatchObject({ savePhase: 'CLEAN', document: { version: 5, baseRevisionId: 'rev-current-base' }, selectedNodeId: 'selected' })
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document).toMatchObject({ version: 5, source: restored, presentation: restoredPresentation })
  })

  it('clears a pending Cut on an accepted restore and leaves clipboard untouched on rejection', () => {
    const scope = effectScope()
    const model = scope.run(() => useAutomationDraftDocument({
      automationId: 'automation-1', detail: () => ({ automation: { id: 'automation-1' }, draft: { ...draft(3, original), presentation: originalPresentation } }) as WorkbenchAutomationDetail,
      reloadDetail() {}, autosaveDelayMs: 60_000,
    }))!
    try {
      model.cutStep('selected')
      expect(model.clipboard).toEqual({ mode: 'cut', nodeId: 'selected' })
      expect(model.replaceFromSnapshot({ automationId: 'automation-1', expectedVersion: 2, source: restored, presentation: restoredPresentation })).toBe(false)
      expect(model.clipboard).toEqual({ mode: 'cut', nodeId: 'selected' })
      expect(model.replaceFromSnapshot({ automationId: 'automation-1', expectedVersion: 3, source: original, presentation: originalPresentation })).toBe(true)
      expect(model.clipboard).toBeUndefined()
    } finally { scope.stop() }
  })

  it('keeps the existing bounded history when applying repeated full-document operations', () => {
    let state = prepared()
    for (let index = 0; index < 55; index++) {
      const version = state.document!.version
      state = reduceAutomationDraftDocument(state, { type: 'REPLACE_FROM_SNAPSHOT', automationId: 'automation-1', expectedVersion: version, source: restored, presentation: { iteration: index } })
      state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
      state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: { ...draft(version + 1, state.document!.source), presentation: state.document!.presentation, baseRevisionId: 'rev-current-base' } } })
    }
    expect(state.undoStack).toHaveLength(50)
    expect(state.document).toMatchObject({ version: 58, baseRevisionId: 'rev-current-base' })
    expect(state.undoStack[0]!.presentation).toEqual({ iteration: 4 })
  })

  it('runs restore, autosave, Undo and Redo through the same authoring model and CAS action', async () => {
    vi.useFakeTimers()
    const id = ref('automation-1'), scope = effectScope(), writes: WorkbenchSaveAutomationDraftInput[] = []
    let savedVersion = 3
    const client = {
      action: vi.fn(async (_ref, input: WorkbenchSaveAutomationDraftInput) => {
        expect(input.automationId).toBe('automation-1')
        expect(input.expectedVersion).toBe(savedVersion)
        writes.push(structuredClone(input))
        savedVersion++
        return { draft: { ...draft(savedVersion, structuredClone(input.source)), presentation: structuredClone(input.presentation), baseRevisionId: 'rev-current-base' } }
      }),
      query: vi.fn(), subscribe: vi.fn(),
    } as unknown as WorkbenchConsoleClient
    const detail = shallowRef({ automation: { id: 'automation-1' }, draft: { ...draft(3, original), presentation: originalPresentation, baseRevisionId: 'rev-current-base' } } as WorkbenchAutomationDetail)
    const model = scope.run(() => useAutomationDraftDocument({ client, automationId: id, detail, reloadDetail() {}, autosaveDelayMs: 10 }))!
    try {
      model.selectNode('selected', false)
      model.copyStep('selected')
      expect(model.clipboard?.mode).toBe('copy')
      const baseline = model.document!
      expect(model.canReplaceFromSnapshot).toBe(true)
      expect(model.replaceFromSnapshot({ automationId: id.value, expectedVersion: 3, expectedDocument: baseline, source: restored, presentation: restoredPresentation })).toBe(true)
      expect(model.clipboard).toBeUndefined()
      expect(model.canReplaceFromSnapshot).toBe(false)
      expect(model.replaceFromSnapshot({ automationId: id.value, expectedVersion: 3, source: original, presentation: originalPresentation })).toBe(false)
      detail.value = { ...detail.value, draft: { ...draft(4, original), presentation: originalPresentation, baseRevisionId: 'rev-current-base' } }
      await nextTick()
      expect(model.document!.source).toEqual(restored)
      await vi.advanceTimersByTimeAsync(10)
      await nextTick()
      expect(model).toMatchObject({ savePhase: 'CLEAN', document: { version: 4, baseRevisionId: 'rev-current-base' } })
      expect(writes[0]).toMatchObject({ expectedVersion: 3, source: restored, presentation: restoredPresentation })
      model.undo()
      expect(model.selectedNodeId).toBe('selected')
      expect(await model.flushDraft()).toBe(true)
      expect(model.document).toMatchObject({ version: 5, source: original, presentation: originalPresentation, baseRevisionId: 'rev-current-base' })
      model.redo()
      expect(await model.flushDraft()).toBe(true)
      expect(model.document).toMatchObject({ version: 6, source: restored, presentation: restoredPresentation, baseRevisionId: 'rev-current-base' })
      expect(writes.map(input => input.expectedVersion)).toEqual([3, 4, 5])
      model.cutStep('control')
      expect(model.clipboard?.mode).toBe('cut')
      id.value = 'automation-other'
      expect(model.canReplaceFromSnapshot).toBe(false)
      expect(model.replaceFromSnapshot({ automationId: 'automation-1', expectedVersion: 6, source: original, presentation: originalPresentation })).toBe(false)
      expect(model.clipboard?.mode).toBe('cut')
      await nextTick()
      expect(model.document).toBeUndefined()
      expect(model.clipboard).toBeUndefined()
    } finally { scope.stop(); vi.useRealTimers() }
  })
})

describe('batch collapse Presentation edits', () => {
  const nested: AutomationSource = { triggers: [{ id: 'trigger', capability: { id: 'timer', version: 1 }, config: {} }], flow: { type: 'block', id: 'root', steps: [
    { type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 10 } },
    { type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'then', steps: [] }, else: { type: 'block', id: 'else', steps: [] } },
    { type: 'foreach', id: 'loop', items: { type: 'literal', value: [] }, body: { type: 'block', id: 'body', steps: [] } },
    { type: 'parallel', id: 'parallel', branches: [{ type: 'block', id: 'parallel-one', steps: [] }, { type: 'block', id: 'parallel-two', steps: [] }] },
    { type: 'race', id: 'race', branches: [{ type: 'block', id: 'race-one', steps: [] }, { type: 'block', id: 'race-two', steps: [] }] },
    { type: 'capability', id: 'call', capability: { id: 'echo', version: 1 }, input: {} },
    { type: 'extension', id: 'opaque', control: { id: 'future:opaque', version: 8 }, input: {} },
  ] } }
  const presentation = { collapsedNodes: ['else', 'legacy-stale-id'], viewport: { x: 7, y: 11, scale: 0.5 }, future: { state: ['opaque', 4, false] } }
  function prepared(): AutomationDraftDocumentState {
    let state = reduceAutomationDraftDocument(loadedState(), { type: 'SERVER', automationId: 'automation-1', draft: { ...draft(2, nested), presentation, baseRevisionId: 'published-base' } })
    state = reduceAutomationDraftDocument(state, { type: 'SELECT_NODE', nodeId: 'wait', reveal: false })
    return state
  }

  it('edits all requested real containers in one full-document history entry without changing Source or opaque Presentation', () => {
    const before = prepared()
    const targets = ['condition', 'then', 'else', 'loop', 'body', 'parallel', 'parallel-one', 'parallel-two', 'race', 'race-one', 'race-two', 'condition', 'root', 'wait', 'call', 'opaque', 'trigger', 'missing']
    const changed = reduceAutomationDraftDocument(before, { type: 'COLLAPSE_MANY', nodeIds: targets, collapsed: true })
    expect(changed.document!.source).toBe(nested)
    expect(changed.document).toMatchObject({ version: 2, baseRevisionId: 'published-base' })
    expect(changed).toMatchObject({ savePhase: 'DIRTY', editRevision: 1, selectedNodeId: 'wait' })
    expect(changed.undoStack).toEqual([{ source: nested, presentation, selectedNodeId: 'wait' }])
    expect(changed.redoStack).toEqual([])
    expect(changed.document!.presentation.collapsedNodes).toEqual(['else', 'legacy-stale-id', 'condition', 'then', 'loop', 'body', 'parallel', 'parallel-one', 'parallel-two', 'race', 'race-one', 'race-two'])
    expect(changed.document!.presentation.viewport).toBe(presentation.viewport)
    expect(changed.document!.presentation.future).toBe(presentation.future)
    expect(before.document!.presentation).toBe(presentation)
    expect(presentation.collapsedNodes).toEqual(['else', 'legacy-stale-id'])
    const undone = reduceAutomationDraftDocument(changed, { type: 'UNDO' })
    expect(undone.document!.source).toBe(nested)
    expect(undone.document!.presentation).toBe(presentation)
    expect(undone.undoStack).toEqual([])
    expect(undone.redoStack).toHaveLength(1)
    const redone = reduceAutomationDraftDocument(undone, { type: 'REDO' })
    expect(redone.document!.source).toBe(nested)
    expect(redone.document!.presentation).toBe(changed.document!.presentation)
    expect(redone.undoStack).toHaveLength(1)
    expect(redone.redoStack).toEqual([])
  })

  it('changes only valid targets and preserves collapsed states outside the requested set', () => {
    const before = prepared()
    before.document = { ...before.document!, presentation: { ...presentation, collapsedNodes: ['else', 'condition', 'loop', 'legacy-stale-id', 'root', 'wait', 'trigger'] } }
    const changed = reduceAutomationDraftDocument(before, { type: 'COLLAPSE_MANY', nodeIds: ['condition', 'condition', 'root', 'wait', 'trigger', 'legacy-stale-id', 'missing'], collapsed: false })
    expect(changed.document!.presentation.collapsedNodes).toEqual(['else', 'loop', 'legacy-stale-id', 'root', 'wait', 'trigger'])
    expect(changed.undoStack).toHaveLength(1)
    expect(changed.document!.source).toBe(before.document!.source)
    const allInvalid = reduceAutomationDraftDocument(changed, { type: 'COLLAPSE_MANY', nodeIds: ['root', 'wait', 'call', 'opaque', 'trigger', 'missing'], collapsed: true })
    expect(allInvalid).toBe(changed)
  })

  it('ignores duplicates, empty sets and no-ops without clearing redo, advancing revision or scheduling a save', () => {
    const before = prepared()
    const changed = reduceAutomationDraftDocument(before, { type: 'COLLAPSE_MANY', nodeIds: ['condition', 'condition'], collapsed: true })
    expect(reduceAutomationDraftDocument(changed, { type: 'COLLAPSE_MANY', nodeIds: ['condition', 'condition'], collapsed: true })).toBe(changed)
    const undone = reduceAutomationDraftDocument(changed, { type: 'UNDO' })
    for (const action of [
      { type: 'COLLAPSE_MANY' as const, nodeIds: [], collapsed: true },
      { type: 'COLLAPSE_MANY' as const, nodeIds: ['condition', 'condition'], collapsed: false },
      { type: 'COLLAPSE_MANY' as const, nodeIds: ['else', 'else'], collapsed: true },
      { type: 'COLLAPSE_MANY' as const, nodeIds: ['root', 'missing', 'call'], collapsed: false },
    ]) expect(reduceAutomationDraftDocument(undone, action)).toBe(undone)
    expect(undone.redoStack).toHaveLength(1)
    const otherChange = reduceAutomationDraftDocument(undone, { type: 'COLLAPSE_MANY', nodeIds: ['loop'], collapsed: true })
    expect(otherChange.redoStack).toEqual([])
    expect(otherChange.undoStack).toHaveLength(1)
    expect(otherChange.editRevision).toBe(undone.editRevision + 1)
  })

  it('allows a non-Block root container to collapse and uses identical eligibility for individual toggles', () => {
    const rootSource: AutomationSource = { triggers: [], flow: { type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'then', steps: [] } } }
    const before = reduceAutomationDraftDocument(loadedState(), { type: 'SERVER', automationId: 'automation-1', draft: draft(2, rootSource) })
    const changed = reduceAutomationDraftDocument(before, { type: 'COLLAPSE_MANY', nodeIds: ['condition', 'then'], collapsed: true })
    expect(changed.document!.presentation.collapsedNodes).toEqual(['condition', 'then'])
    const individual = reduceAutomationDraftDocument(prepared(), { type: 'COLLAPSE', nodeId: 'condition', collapsed: true })
    expect(individual.document!.presentation.collapsedNodes).toEqual(['else', 'legacy-stale-id', 'condition'])
    for (const nodeId of ['root', 'wait', 'call', 'opaque', 'trigger', 'missing']) {
      expect(reduceAutomationDraftDocument(individual, { type: 'COLLAPSE', nodeId, collapsed: true })).toBe(individual)
    }
  })

  it('keeps later batch edits and Undo/Redo intact after an earlier autosave acknowledgement', () => {
    let state = reduceAutomationDraftDocument(prepared(), { type: 'COLLAPSE_MANY', nodeIds: ['condition', 'loop'], collapsed: true })
    const first = state.document!.presentation
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    const pending = state.pendingSave
    state = reduceAutomationDraftDocument(state, { type: 'COLLAPSE_MANY', nodeIds: ['condition'], collapsed: false })
    const latest = state.document!.presentation
    expect(state.savePhase).toBe('SAVING')
    expect(state.pendingSave).toBe(pending)
    expect(pending?.presentation).toBe(first)
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.presentation).toBe(first)
    state = reduceAutomationDraftDocument(state, { type: 'REDO' })
    expect(state.document!.presentation).toBe(latest)
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: { ...draft(3, nested), presentation: first, baseRevisionId: 'published-base' } } })
    expect(state).toMatchObject({ savePhase: 'DIRTY', pendingSave: undefined, document: { version: 3, source: nested, baseRevisionId: 'published-base' } })
    expect(state.document!.presentation).toBe(latest)
    expect(state.undoStack).toHaveLength(2)
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_REQUEST' })
    expect(state.pendingSave).toMatchObject({ expectedVersion: 3, presentation: latest })
    state = reduceAutomationDraftDocument(state, { type: 'SAVE_SUCCESS', result: { draft: { ...draft(4, nested), presentation: latest } } })
    expect(state.savePhase).toBe('CLEAN')
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.presentation).toBe(first)
    expect(state.document!.version).toBe(4)
    state = reduceAutomationDraftDocument(state, { type: 'UNDO' })
    expect(state.document!.presentation).toBe(presentation)
    expect(state.document!.source).toBe(nested)
  })

  it('does not modify unavailable, conflicted, reloading or publishing documents', () => {
    const before = prepared()
    let conflict = reduceAutomationDraftDocument(before, { type: 'COLLAPSE_MANY', nodeIds: ['condition'], collapsed: true })
    conflict = reduceAutomationDraftDocument(conflict, { type: 'SAVE_REQUEST' })
    conflict = reduceAutomationDraftDocument(conflict, { type: 'SAVE_FAILURE', error: { code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 2, actualVersion: 3 } } })
    const readonly = [unavailableState(), conflict, reduceAutomationDraftDocument(before, { type: 'RELOAD' }), reduceAutomationDraftDocument(before, { type: 'PUBLISH_REQUEST' })]
    for (const state of readonly) {
      expect(reduceAutomationDraftDocument(state, { type: 'COLLAPSE_MANY', nodeIds: ['condition', 'loop', 'else'], collapsed: true })).toBe(state)
      expect(reduceAutomationDraftDocument(state, { type: 'COLLAPSE_MANY', nodeIds: ['condition', 'else'], collapsed: false })).toBe(state)
    }
    expect(conflict.document!.presentation.collapsedNodes).toEqual(['else', 'legacy-stale-id', 'condition'])
  })

  it('batches through the public model and existing autosave action, retaining latest Presentation across a deferred save', async () => {
    vi.useFakeTimers()
    const scope = effectScope(), writes: WorkbenchSaveAutomationDraftInput[] = []
    let savedVersion = 2
    let finishFirst!: () => void
    const client = {
      action: vi.fn(async (_ref, input: WorkbenchSaveAutomationDraftInput) => {
        expect(input.expectedVersion).toBe(savedVersion)
        writes.push(structuredClone(input))
        if (writes.length === 1) await new Promise<void>(resolve => { finishFirst = resolve })
        savedVersion++
        return { draft: { ...draft(savedVersion, input.source), presentation: input.presentation, baseRevisionId: 'published-base' } }
      }), query: vi.fn(), subscribe: vi.fn(),
    } as unknown as WorkbenchConsoleClient
    const model = scope.run(() => useAutomationDraftDocument({ client, automationId: 'automation-1',
      detail: () => ({ automation: { id: 'automation-1' }, draft: { ...draft(2, nested), presentation, baseRevisionId: 'published-base' } }) as WorkbenchAutomationDetail,
      reloadDetail() {}, autosaveDelayMs: 10,
    }))!
    try {
      const before = model.document
      model.setCollapsed([], true)
      model.setCollapsed(['root', 'wait', 'missing'], true)
      model.setCollapsed(['else'], true)
      await vi.advanceTimersByTimeAsync(20)
      expect(model.document).toBe(before)
      expect(model.canUndo).toBe(false)
      expect(writes).toEqual([])
      model.setCollapsed(['condition', 'loop', 'condition'], true)
      const first = model.document!.presentation
      await nextTick(); await vi.advanceTimersByTimeAsync(10)
      expect(model.savePhase).toBe('SAVING')
      expect(writes).toHaveLength(1)
      expect(writes[0]?.presentation).toEqual(first)
      model.setCollapsed(['condition'], false)
      const latest = model.document!.presentation
      finishFirst(); await nextTick(); await nextTick(); await nextTick()
      expect(model.savePhase).toBe('DIRTY')
      expect(model.document!.version).toBe(3)
      expect(model.document!.presentation).toBe(latest)
      expect(await model.flushDraft()).toBe(true)
      expect(writes).toHaveLength(2)
      expect(writes[1]).toMatchObject({ expectedVersion: 3, presentation: latest, source: nested })
      expect(model.document!.source).toBe(nested)
      model.undo()
      expect(model.document!.presentation).toBe(first)
      expect(await model.flushDraft()).toBe(true)
      model.redo()
      expect(model.document!.presentation).toBe(latest)
      expect(await model.flushDraft()).toBe(true)
      const saved = model.document
      model.setCollapsed(['loop', 'loop'], true)
      await vi.advanceTimersByTimeAsync(20)
      expect(model.document).toBe(saved)
      expect(writes.map(write => write.expectedVersion)).toEqual([2, 3, 4, 5])
    } finally { scope.stop(); vi.useRealTimers() }
  })
})


describe('history input preservation', () => {
  function fixture(client?: WorkbenchConsoleClient) {
    const initial: AutomationSource = { triggers: [], flow: { type: 'block', id: 'root', steps: [
      { type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 10 } },
      { type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'then', steps: [] } },
    ] } }
    const id = ref('automation-1'), scope = effectScope()
    const detail = shallowRef({ automation: { id: 'automation-1' }, draft: draft(1, initial) } as WorkbenchAutomationDetail)
    const model = scope.run(() => useAutomationDraftDocument({ client, automationId: id, detail, reloadDetail() {}, autosaveDelayMs: 60_000 }))!
    model.selectNode('wait', false)
    return { model, scope, initial, id, detail }
  }

  it('allows presentation-only Undo and Redo without changing Source, selection or pending-save state', () => {
    const { model, scope, initial } = fixture()
    try {
      expect(model.historyPreservesInputs('undo')).toBe(false)
      expect(model.historyPreservesInputs('redo')).toBe(false)
      model.setCollapsed(['condition', 'then'], true)
      const collapsed = model.document
      expect(model.historyPreservesInputs('undo')).toBe(true)
      expect(model.historyPreservesInputs('redo')).toBe(false)
      expect(model.document).toBe(collapsed)
      expect(model.document!.source).toBe(initial)
      expect(model.selectedNodeId).toBe('wait')
      expect(model.savePhase).toBe('DIRTY')
      model.undo()
      expect(model.historyPreservesInputs('undo')).toBe(false)
      expect(model.historyPreservesInputs('redo')).toBe(true)
      model.redo()
      expect(model.historyPreservesInputs('undo')).toBe(true)
      expect(model.historyPreservesInputs('redo')).toBe(false)
    } finally { scope.stop() }
  })

  it('recognizes equal Source content after real saved responses clone it for Undo and Redo', async () => {
    let version = 1
    const client = { action: vi.fn(async (_ref, input: WorkbenchSaveAutomationDraftInput) => ({
      draft: { ...draft(++version, structuredClone(input.source)), presentation: structuredClone(input.presentation) },
    })), query: vi.fn(), subscribe: vi.fn() } as unknown as WorkbenchConsoleClient
    const { model, scope, initial } = fixture(client)
    try {
      model.setCollapsed(['condition'], true)
      expect(await model.flushDraft()).toBe(true)
      expect(model.document!.source).not.toBe(initial)
      expect(model.document!.source).toEqual(initial)
      expect(model.historyPreservesInputs('undo')).toBe(true)
      model.undo()
      const beforeSave = model.document!.source
      expect(await model.flushDraft()).toBe(true)
      expect(model.document!.source).not.toBe(beforeSave)
      expect(model.historyPreservesInputs('redo')).toBe(true)
      model.redo()
      expect(model.historyPreservesInputs('undo')).toBe(true)
      expect(model.selectedNodeId).toBe('wait')
    } finally { scope.stop() }
  })

  it('requires input protection when either history direction changes Source content even with the same selection', () => {
    const { model, scope } = fixture()
    try {
      model.setWaitExpression('wait', 'durationMs', { type: 'literal', value: 20 })
      expect(model.selectedNodeId).toBe('wait')
      expect(model.historyPreservesInputs('undo')).toBe(false)
      model.undo()
      expect(model.selectedNodeId).toBe('wait')
      expect(model.historyPreservesInputs('redo')).toBe(false)
      model.redo()
      model.setCollapsed(['condition'], true)
      expect(model.historyPreservesInputs('undo')).toBe(true)
      model.undo()
      // A blur commit adds a new Source edit on top of presentation history;
      // callers must recheck after blur rather than reuse the previous true.
      model.setWaitExpression('wait', 'durationMs', { type: 'literal', value: 30 })
      expect(model.historyPreservesInputs('undo')).toBe(false)
      expect(model.historyPreservesInputs('redo')).toBe(false)
    } finally { scope.stop() }
  })

  it('requires input protection for selection changes despite identical Source content', () => {
    const { model, scope } = fixture()
    try {
      model.setCollapsed(['condition'], true)
      expect(model.historyPreservesInputs('undo')).toBe(true)
      model.selectNode('condition', false)
      expect(model.historyPreservesInputs('undo')).toBe(false)
      model.undo()
      expect(model.selectedNodeId).toBe('wait')
      expect(model.historyPreservesInputs('redo')).toBe(false)
      model.selectNode('condition', false)
      expect(model.historyPreservesInputs('redo')).toBe(true)
    } finally { scope.stop() }
  })

  it('conservatively rejects equal-looking Source values with different JSON property order', async () => {
    const client = { action: vi.fn(async (_ref, input: WorkbenchSaveAutomationDraftInput) => ({ draft: {
      ...draft(2, { flow: structuredClone(input.source.flow), triggers: structuredClone(input.source.triggers) }), presentation: input.presentation,
    } })), query: vi.fn(), subscribe: vi.fn() } as unknown as WorkbenchConsoleClient
    const { model, scope, initial } = fixture(client)
    try {
      model.setCollapsed(['condition'], true)
      expect(await model.flushDraft()).toBe(true)
      expect(model.document!.source).toEqual(initial)
      expect(model.historyPreservesInputs('undo')).toBe(false)
    } finally { scope.stop() }
  })

  it.each(['conflict', 'reloading', 'publishing', 'automation-change'] as const)('rejects history bypass while the document is %s', async mode => {
    const client = mode === 'conflict' ? { action: vi.fn(async () => {
      throw { code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } }
    }), query: vi.fn(), subscribe: vi.fn() } as unknown as WorkbenchConsoleClient : undefined
    const { model, scope, id } = fixture(client)
    try {
      model.setCollapsed(['condition'], true)
      expect(model.historyPreservesInputs('undo')).toBe(true)
      if (mode === 'conflict') expect(await model.flushDraft()).toBe(false)
      else if (mode === 'reloading') model.reload()
      else if (mode === 'publishing') model.publish()
      else id.value = 'automation-other'
      expect(model.historyPreservesInputs('undo')).toBe(false)
      expect(model.historyPreservesInputs('redo')).toBe(false)
      if (mode === 'automation-change') {
        await nextTick()
        expect(model.document).toBeUndefined()
        expect(model.historyPreservesInputs('undo')).toBe(false)
      }
    } finally { scope.stop() }
  })
})

describe('focused-scope selection', () => {
  const nested: AutomationSource = { triggers: [], flow: { type: 'block', id: 'root', steps: [{
    type: 'foreach', id: 'scope', items: { type: 'literal', value: [] }, body: { type: 'block', id: 'body', steps: [{
      type: 'if', id: 'condition', condition: { type: 'literal', value: true }, then: { type: 'block', id: 'then', steps: [{ type: 'wait', id: 'leaf', durationMs: { type: 'literal', value: 1 } }] },
      else: { type: 'block', id: 'else', steps: [] },
    }] },
  }] } }
  const presentation = { collapsedNodes: ['root', 'scope', 'body', 'condition', 'then', 'else'], future: { opaque: ['retained'] } }
  function prepared() {
    return reduceAutomationDraftDocument(loadedState(), { type: 'SERVER', automationId: 'automation-1', draft: { ...draft(2, nested), presentation } })
  }

  it('passes the public focus scope through selection, revealing interior ancestors without new history', () => {
    const scope = effectScope()
    const model = scope.run(() => useAutomationDraftDocument({ automationId: 'automation-1',
      detail: () => ({ automation: { id: 'automation-1' }, draft: { ...draft(2, nested), presentation } }) as WorkbenchAutomationDetail,
      reloadDetail() {}, autosaveDelayMs: 60_000,
    }))!
    try {
      model.selectNode('leaf', true, 'scope')
      expect(model.selectedNodeId).toBe('leaf')
      expect(model.document!.presentation.collapsedNodes).toEqual(['root', 'scope', 'else'])
      expect(model.document!.source).toBe(nested)
      expect(model.document!.presentation.future).toBe(presentation.future)
      expect(model.canUndo).toBe(false)
      expect(model.canRedo).toBe(false)
      expect(model.savePhase).toBe('DIRTY')
      const revealed = model.document
      model.selectNode('leaf', true, 'scope')
      expect(model.document).toBe(revealed)
      model.selectNode('scope', true, 'scope')
      expect(model.document).toBe(revealed)
      expect(model.collapsedNodes).toContain('scope')
    } finally { scope.stop() }
  })

  it('does not add or clear full-document history when revealing within a valid scope', () => {
    const before = reduceAutomationDraftDocument(prepared(), { type: 'COLLAPSE_MANY', nodeIds: ['condition'], collapsed: false })
    const state = reduceAutomationDraftDocument(before, { type: 'SELECT_NODE', nodeId: 'leaf', revealWithinNodeId: 'scope' })
    expect(state.undoStack).toBe(before.undoStack)
    expect(state.redoStack).toBe(before.redoStack)
    expect(state.document!.presentation.collapsedNodes).toEqual(['root', 'scope', 'else'])
    expect(state.document!.source).toBe(before.document!.source)
  })

  it.each(['missing', 'else', 'leaf', ''] as const)('updates selection without revealing outside invalid focus %s', revealWithinNodeId => {
    const before = prepared()
    const state = reduceAutomationDraftDocument(before, { type: 'SELECT_NODE', nodeId: 'leaf', revealWithinNodeId })
    expect(state.selectedNodeId).toBe('leaf')
    expect(state.document).toBe(before.document)
    expect(state.savePhase).toBe('CLEAN')
    expect(state.editRevision).toBe(0)
    expect(state.undoStack).toBe(before.undoStack)
    expect(state.redoStack).toBe(before.redoStack)
  })

  it('keeps a conflicted or explicitly read-only scoped selection from writing Presentation', () => {
    const before = prepared()
    const conflict = reduceAutomationDraftDocument(before, { type: 'SAVE_FAILURE', error: { code: 'DRAFT_VERSION_CONFLICT', details: { expectedVersion: 2, actualVersion: 3 } } })
    for (const [state, reveal] of [[conflict, true], [before, false]] as const) {
      const selected = reduceAutomationDraftDocument(state, { type: 'SELECT_NODE', nodeId: 'leaf', reveal, revealWithinNodeId: 'scope' })
      expect(selected.selectedNodeId).toBe('leaf')
      expect(selected.document).toBe(state.document)
      expect(selected.savePhase).toBe(state.savePhase)
      expect(selected.editRevision).toBe(state.editRevision)
      expect(selected.undoStack).toBe(state.undoStack)
    }
  })
})
