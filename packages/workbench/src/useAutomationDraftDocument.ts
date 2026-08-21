import type { AutomationSource, CompileDiagnostic, NumenValue } from '@numen/core'
import { useCallback, useEffect, useReducer } from 'react'
import {
  workbenchPublishAutomationDraftActionRef,
  workbenchSaveAutomationDraftActionRef,
  type WorkbenchAutomationDetail,
  type WorkbenchAutomationDraft,
  type WorkbenchPublishAutomationDraftInput,
  type WorkbenchPublishAutomationDraftResult,
  type WorkbenchSaveAutomationDraftInput,
  type WorkbenchSaveAutomationDraftResult,
} from './contracts.js'
import type { WorkbenchConsoleClient } from './types.js'

export type AutomationDraftSavePhase =
  | 'UNAVAILABLE'
  | 'CLEAN'
  | 'DIRTY'
  | 'SAVING'
  | 'CONFLICT'
  | 'ERROR'
  | 'RELOADING'

export interface AutomationDraftDocument {
  automationId: string
  source: AutomationSource
  presentation: Record<string, NumenValue>
  version: number
  updatedAt: string
  baseRevisionId?: string
}

interface PendingSave {
  automationId: string
  expectedVersion: number
  source: AutomationSource
  presentation: Record<string, NumenValue>
  editRevision: number
}

interface PendingPublish {
  automationId: string
  expectedVersion: number
}

export interface AutomationDraftDocumentState {
  selectedAutomationId: string | undefined
  document: AutomationDraftDocument | undefined
  savePhase: AutomationDraftSavePhase
  editRevision: number
  pendingSave: PendingSave | undefined
  conflict: { expectedVersion: number; actualVersion: number } | undefined
  saveError: string | undefined
  publishPending: boolean
  pendingPublish: PendingPublish | undefined
  publishError: string | undefined
  problems: CompileDiagnostic[]
}

export type AutomationDraftDocumentAction =
  | { type: 'SELECT'; automationId?: string }
  | { type: 'SERVER'; automationId: string; draft: WorkbenchAutomationDraft }
  | { type: 'ADD_WAIT' }
  | { type: 'SAVE_REQUEST' }
  | { type: 'SAVE_SUCCESS'; result: WorkbenchSaveAutomationDraftResult }
  | { type: 'SAVE_FAILURE'; error: unknown }
  | { type: 'RETRY_SAVE' }
  | { type: 'RELOAD' }
  | { type: 'PUBLISH_REQUEST' }
  | { type: 'PUBLISH_SUCCESS'; result: WorkbenchPublishAutomationDraftResult }
  | { type: 'PUBLISH_FAILURE'; error: unknown }

const initialState: AutomationDraftDocumentState = {
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

function toDocument(automationId: string, draft: WorkbenchAutomationDraft): AutomationDraftDocument {
  return {
    automationId,
    source: draft.source,
    presentation: draft.presentation,
    version: draft.version,
    updatedAt: draft.updatedAt,
    ...(draft.baseRevisionId ? { baseRevisionId: draft.baseRevisionId } : {}),
  }
}

function collectControlIds(source: AutomationSource): Set<string> {
  const ids = new Set(source.triggers.map(trigger => trigger.id))
  const visit = (control: AutomationSource['flow']): void => {
    ids.add(control.id)
    switch (control.type) {
      case 'block':
        control.steps.forEach(visit)
        break
      case 'if':
        visit(control.then)
        if (control.else) visit(control.else)
        break
      case 'parallel':
      case 'race':
        control.branches.forEach(visit)
        break
      case 'foreach':
        visit(control.body)
        break
      default:
        break
    }
  }
  visit(source.flow)
  return ids
}

function availableId(ids: Set<string>, prefix: string): string {
  let suffix = 1
  while (ids.has(`${prefix}-${suffix}`)) suffix += 1
  return `${prefix}-${suffix}`
}

export function appendDefaultWait(source: AutomationSource): AutomationSource {
  const ids = collectControlIds(source)
  const wait = {
    type: 'wait' as const,
    id: availableId(ids, 'wait'),
    durationMs: { type: 'literal' as const, value: 60_000 },
  }
  if (source.flow.type === 'block') {
    return {
      ...source,
      flow: { ...source.flow, steps: [...source.flow.steps, wait] },
    }
  }
  return {
    ...source,
    flow: {
      type: 'block',
      id: availableId(ids, 'flow'),
      steps: [source.flow, wait],
    },
  }
}

function errorRecord(error: unknown): { code?: string; message?: string; details?: unknown } {
  return error && typeof error === 'object' ? error as { code?: string; message?: string; details?: unknown } : {}
}

function conflictFrom(error: unknown): AutomationDraftDocumentState['conflict'] {
  const record = errorRecord(error)
  if (record.code !== 'DRAFT_VERSION_CONFLICT' || !record.details || typeof record.details !== 'object') return
  const { expectedVersion, actualVersion } = record.details as Record<string, unknown>
  if (typeof expectedVersion !== 'number' || typeof actualVersion !== 'number') return
  return { expectedVersion, actualVersion }
}

function diagnosticsFrom(error: unknown): CompileDiagnostic[] {
  const record = errorRecord(error)
  if (record.code !== 'AUTOMATION_PUBLISH_INVALID' || !record.details || typeof record.details !== 'object') return []
  const diagnostics = (record.details as { diagnostics?: unknown }).diagnostics
  return Array.isArray(diagnostics) ? diagnostics as CompileDiagnostic[] : []
}

/** @internal Exported so state transitions can be verified without a browser runtime. */
export function reduceAutomationDraftDocument(
  state: AutomationDraftDocumentState,
  action: AutomationDraftDocumentAction,
): AutomationDraftDocumentState {
  switch (action.type) {
    case 'SELECT':
      if (state.selectedAutomationId === action.automationId) return state
      return {
        ...initialState,
        selectedAutomationId: action.automationId,
      }
    case 'SERVER':
      if (state.selectedAutomationId !== action.automationId) return state
      if (state.savePhase !== 'UNAVAILABLE' && state.savePhase !== 'CLEAN' && state.savePhase !== 'RELOADING') return state
      return {
        ...state,
        document: toDocument(action.automationId, action.draft),
        savePhase: 'CLEAN',
        editRevision: 0,
        publishError: undefined,
        conflict: undefined,
        saveError: undefined,
      }
    case 'ADD_WAIT': {
      if (!state.document || state.savePhase === 'CONFLICT' || state.savePhase === 'RELOADING' || state.publishPending) return state
      return {
        ...state,
        document: { ...state.document, source: appendDefaultWait(state.document.source) },
        savePhase: state.savePhase === 'SAVING' ? 'SAVING' : 'DIRTY',
        editRevision: state.editRevision + 1,
        problems: [],
        publishError: undefined,
        saveError: undefined,
      }
    }
    case 'SAVE_REQUEST':
      if (!state.document || state.savePhase !== 'DIRTY') return state
      return {
        ...state,
        savePhase: 'SAVING',
        pendingSave: {
          automationId: state.document.automationId,
          expectedVersion: state.document.version,
          source: state.document.source,
          presentation: state.document.presentation,
          editRevision: state.editRevision,
        },
      }
    case 'SAVE_SUCCESS': {
      if (!state.document || !state.pendingSave) return state
      const editedDuringSave = state.editRevision !== state.pendingSave.editRevision
      return {
        ...state,
        document: editedDuringSave
          ? {
              ...state.document,
              version: action.result.draft.version,
              updatedAt: action.result.draft.updatedAt,
              ...(action.result.draft.baseRevisionId ? { baseRevisionId: action.result.draft.baseRevisionId } : {}),
            }
          : toDocument(state.document.automationId, action.result.draft),
        savePhase: editedDuringSave ? 'DIRTY' : 'CLEAN',
        pendingSave: undefined,
        conflict: undefined,
        saveError: undefined,
      }
    }
    case 'SAVE_FAILURE': {
      const conflict = conflictFrom(action.error)
      return {
        ...state,
        savePhase: conflict ? 'CONFLICT' : 'ERROR',
        pendingSave: undefined,
        conflict,
        saveError: conflict ? undefined : errorRecord(action.error).message ?? 'Draft autosave failed.',
      }
    }
    case 'RETRY_SAVE':
      return state.savePhase === 'ERROR' ? { ...state, savePhase: 'DIRTY', saveError: undefined } : state
    case 'RELOAD':
      return {
        ...state,
        savePhase: 'RELOADING',
        pendingSave: undefined,
        conflict: undefined,
        saveError: undefined,
      }
    case 'PUBLISH_REQUEST':
      if (!state.document || state.savePhase !== 'CLEAN' || state.publishPending) return state
      return {
        ...state,
        publishPending: true,
        pendingPublish: {
          automationId: state.document.automationId,
          expectedVersion: state.document.version,
        },
        publishError: undefined,
        problems: [],
      }
    case 'PUBLISH_SUCCESS':
      if (!state.document) return state
      return {
        ...state,
        document: toDocument(state.document.automationId, action.result.draft),
        publishPending: false,
        pendingPublish: undefined,
        publishError: undefined,
        problems: [],
      }
    case 'PUBLISH_FAILURE': {
      const problems = diagnosticsFrom(action.error)
      return {
        ...state,
        publishPending: false,
        pendingPublish: undefined,
        problems,
        publishError: problems.length ? undefined : errorRecord(action.error).message ?? 'Publish failed.',
      }
    }
  }
}

export interface AutomationDraftDocumentModel {
  document?: AutomationDraftDocument
  savePhase: AutomationDraftSavePhase
  saveMessage: string
  conflict?: { expectedVersion: number; actualVersion: number }
  saveError?: string
  publishPending: boolean
  publishError?: string
  problems: CompileDiagnostic[]
  canEdit: boolean
  canPublish: boolean
  addWaitStep(): void
  publish(): void
  reload(): void
  retrySave(): void
}

function saveMessage(phase: AutomationDraftSavePhase): string {
  switch (phase) {
    case 'UNAVAILABLE': return 'Waiting for Draft'
    case 'CLEAN': return 'Saved'
    case 'DIRTY': return 'Unsaved changes'
    case 'SAVING': return 'Saving…'
    case 'CONFLICT': return 'Draft conflict'
    case 'ERROR': return 'Save failed'
    case 'RELOADING': return 'Reloading Draft…'
  }
}

export function useAutomationDraftDocument({
  client,
  automationId,
  detail,
  reloadDetail,
  autosaveDelayMs = 600,
}: {
  client?: WorkbenchConsoleClient
  automationId?: string
  detail?: WorkbenchAutomationDetail
  reloadDetail(): void
  autosaveDelayMs?: number
}): AutomationDraftDocumentModel {
  const [state, dispatch] = useReducer(reduceAutomationDraftDocument, initialState)

  useEffect(() => {
    dispatch({ type: 'SELECT', ...(automationId ? { automationId } : {}) })
  }, [automationId])

  useEffect(() => {
    if (automationId && detail?.automation.id === automationId) {
      dispatch({ type: 'SERVER', automationId, draft: detail.draft })
    }
  }, [automationId, detail])

  useEffect(() => {
    if (state.savePhase !== 'DIRTY') return
    const timer = globalThis.setTimeout(() => dispatch({ type: 'SAVE_REQUEST' }), autosaveDelayMs)
    return () => globalThis.clearTimeout(timer)
  }, [autosaveDelayMs, state.editRevision, state.savePhase])

  useEffect(() => {
    if (!client || state.savePhase !== 'SAVING' || !state.pendingSave) return
    const controller = new AbortController()
    const pending = state.pendingSave
    void client.action<WorkbenchSaveAutomationDraftInput, WorkbenchSaveAutomationDraftResult>(
      workbenchSaveAutomationDraftActionRef,
      {
        automationId: pending.automationId,
        expectedVersion: pending.expectedVersion,
        source: pending.source,
        presentation: pending.presentation,
      },
      controller.signal,
    ).then(
      result => dispatch({ type: 'SAVE_SUCCESS', result }),
      error => {
        if (!controller.signal.aborted) dispatch({ type: 'SAVE_FAILURE', error })
      },
    )
    return () => controller.abort()
  }, [client, state.pendingSave, state.savePhase])

  useEffect(() => {
    if (!client || !state.publishPending || !state.pendingPublish) return
    const controller = new AbortController()
    const pending = state.pendingPublish
    void client.action<WorkbenchPublishAutomationDraftInput, WorkbenchPublishAutomationDraftResult>(
      workbenchPublishAutomationDraftActionRef,
      {
        automationId: pending.automationId,
        expectedVersion: pending.expectedVersion,
      },
      controller.signal,
    ).then(
      result => dispatch({ type: 'PUBLISH_SUCCESS', result }),
      error => {
        if (!controller.signal.aborted) dispatch({ type: 'PUBLISH_FAILURE', error })
      },
    )
    return () => controller.abort()
  }, [client, state.pendingPublish, state.publishPending])

  const addWaitStep = useCallback(() => dispatch({ type: 'ADD_WAIT' }), [])
  const publish = useCallback(() => dispatch({ type: 'PUBLISH_REQUEST' }), [])
  const reload = useCallback(() => {
    dispatch({ type: 'RELOAD' })
    reloadDetail()
  }, [reloadDetail])
  const retrySave = useCallback(() => dispatch({ type: 'RETRY_SAVE' }), [])
  const canEdit = !!state.document
    && state.savePhase !== 'CONFLICT'
    && state.savePhase !== 'RELOADING'
    && !state.publishPending
  const canPublish = !!state.document && state.savePhase === 'CLEAN' && !state.publishPending

  return {
    ...(state.document ? { document: state.document } : {}),
    savePhase: state.savePhase,
    saveMessage: saveMessage(state.savePhase),
    ...(state.conflict ? { conflict: state.conflict } : {}),
    ...(state.saveError ? { saveError: state.saveError } : {}),
    publishPending: state.publishPending,
    ...(state.publishError ? { publishError: state.publishError } : {}),
    problems: state.problems,
    canEdit,
    canPublish,
    addWaitStep,
    publish,
    reload,
    retrySave,
  }
}
