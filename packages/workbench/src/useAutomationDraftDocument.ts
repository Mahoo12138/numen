import type { AutomationSource, CompileDiagnostic, NumenValue, ValueExpr } from '@numen/core'
import { useCallback, useEffect, useMemo, useReducer } from 'react'
import {
  workbenchPublishAutomationDraftActionRef,
  workbenchSaveAutomationDraftActionRef,
  type WorkbenchAutomationDetail,
  type WorkbenchAutomationDraft,
  type WorkbenchAutomationInsertItem,
  type WorkbenchPublishAutomationDraftInput,
  type WorkbenchPublishAutomationDraftResult,
  type WorkbenchSaveAutomationDraftInput,
  type WorkbenchSaveAutomationDraftResult,
} from './contracts.js'
import {
  applyAutomationSourceCommand,
  automationSourceHasNode,
  type AutomationSourceCommand,
} from './automation-source-editing.js'
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

interface AutomationDraftSnapshot {
  source: AutomationSource
  presentation: Record<string, NumenValue>
  selectedNodeId: string | undefined
}

export interface AutomationDraftDocumentState {
  selectedAutomationId: string | undefined
  selectedNodeId: string | undefined
  document: AutomationDraftDocument | undefined
  savePhase: AutomationDraftSavePhase
  editRevision: number
  undoStack: AutomationDraftSnapshot[]
  redoStack: AutomationDraftSnapshot[]
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
  | { type: 'SELECT_NODE'; nodeId?: string }
  | { type: 'EDIT'; command: AutomationSourceCommand }
  | { type: 'UNDO' }
  | { type: 'REDO' }
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

const historyLimit = 50

function snapshot(
  document: AutomationDraftDocument,
  selectedNodeId: string | undefined,
): AutomationDraftSnapshot {
  return { source: document.source, presentation: document.presentation, selectedNodeId }
}

function canChangeDocument(state: AutomationDraftDocumentState): boolean {
  return !!state.document
    && state.savePhase !== 'CONFLICT'
    && state.savePhase !== 'RELOADING'
    && !state.publishPending
}

function changedState(
  state: AutomationDraftDocumentState,
  document: AutomationDraftDocument,
  undoStack: AutomationDraftSnapshot[],
  redoStack: AutomationDraftSnapshot[],
  selectedNodeId: string | undefined,
): AutomationDraftDocumentState {
  return {
    ...state,
    document,
    savePhase: state.savePhase === 'SAVING' ? 'SAVING' : 'DIRTY',
    editRevision: state.editRevision + 1,
    undoStack,
    redoStack,
    selectedNodeId,
    problems: [],
    publishError: undefined,
    saveError: undefined,
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
      const preserveHistory = state.document?.version === action.draft.version && state.savePhase === 'CLEAN'
      return {
        ...state,
        document: toDocument(action.automationId, action.draft),
        savePhase: 'CLEAN',
        editRevision: 0,
        selectedNodeId: automationSourceHasNode(action.draft.source, state.selectedNodeId)
          ? state.selectedNodeId
          : undefined,
        undoStack: preserveHistory ? state.undoStack : [],
        redoStack: preserveHistory ? state.redoStack : [],
        publishError: undefined,
        conflict: undefined,
        saveError: undefined,
      }
    case 'SELECT_NODE':
      if (!state.document || !automationSourceHasNode(state.document.source, action.nodeId)) {
        return action.nodeId === undefined ? { ...state, selectedNodeId: undefined } : state
      }
      return state.selectedNodeId === action.nodeId ? state : { ...state, selectedNodeId: action.nodeId }
    case 'EDIT': {
      if (!state.document || !canChangeDocument(state)) return state
      const result = applyAutomationSourceCommand(state.document.source, action.command)
      if (result.source === state.document.source) return state
      return changedState(
        state,
        { ...state.document, source: result.source },
        [...state.undoStack.slice(-(historyLimit - 1)), snapshot(state.document, state.selectedNodeId)],
        [],
        result.selectedNodeId ?? state.selectedNodeId,
      )
    }
    case 'UNDO': {
      if (!state.document || !canChangeDocument(state) || !state.undoStack.length) return state
      const previous = state.undoStack.at(-1)!
      return changedState(
        state,
        { ...state.document, source: previous.source, presentation: previous.presentation },
        state.undoStack.slice(0, -1),
        [...state.redoStack.slice(-(historyLimit - 1)), snapshot(state.document, state.selectedNodeId)],
        automationSourceHasNode(previous.source, previous.selectedNodeId) ? previous.selectedNodeId : undefined,
      )
    }
    case 'REDO': {
      if (!state.document || !canChangeDocument(state) || !state.redoStack.length) return state
      const next = state.redoStack.at(-1)!
      return changedState(
        state,
        { ...state.document, source: next.source, presentation: next.presentation },
        [...state.undoStack.slice(-(historyLimit - 1)), snapshot(state.document, state.selectedNodeId)],
        state.redoStack.slice(0, -1),
        automationSourceHasNode(next.source, next.selectedNodeId) ? next.selectedNodeId : undefined,
      )
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
  selectedNodeId?: string
  savePhase: AutomationDraftSavePhase
  saveMessage: string
  conflict?: { expectedVersion: number; actualVersion: number }
  saveError?: string
  publishPending: boolean
  publishError?: string
  problems: CompileDiagnostic[]
  canEdit: boolean
  canPublish: boolean
  canUndo: boolean
  canRedo: boolean
  insert(item: WorkbenchAutomationInsertItem): void
  selectNode(nodeId?: string): void
  setCapabilityConnection(nodeId: string, slotName: string, connectionId?: string): void
  setCapabilityInput(nodeId: string, fieldName: string, expression?: ValueExpr): void
  setWaitDuration(nodeId: string, durationMs: number): void
  undo(): void
  redo(): void
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

  const insert = useCallback((item: WorkbenchAutomationInsertItem) => {
    dispatch({ type: 'EDIT', command: { type: 'INSERT', item } })
  }, [])
  const selectNode = useCallback((nodeId?: string) => {
    dispatch({ type: 'SELECT_NODE', ...(nodeId ? { nodeId } : {}) })
  }, [])
  const setCapabilityConnection = useCallback((nodeId: string, slotName: string, connectionId?: string) => {
    dispatch({
      type: 'EDIT',
      command: { type: 'SET_CAPABILITY_CONNECTION', nodeId, slotName, ...(connectionId ? { connectionId } : {}) },
    })
  }, [])
  const setCapabilityInput = useCallback((nodeId: string, fieldName: string, expression?: ValueExpr) => {
    dispatch({
      type: 'EDIT',
      command: { type: 'SET_CAPABILITY_INPUT', nodeId, fieldName, ...(expression ? { expression } : {}) },
    })
  }, [])
  const setWaitDuration = useCallback((nodeId: string, durationMs: number) => {
    dispatch({ type: 'EDIT', command: { type: 'SET_WAIT_DURATION', nodeId, durationMs } })
  }, [])
  const undo = useCallback(() => dispatch({ type: 'UNDO' }), [])
  const redo = useCallback(() => dispatch({ type: 'REDO' }), [])
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

  return useMemo(() => ({
    ...(state.document ? { document: state.document } : {}),
    ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
    savePhase: state.savePhase,
    saveMessage: saveMessage(state.savePhase),
    ...(state.conflict ? { conflict: state.conflict } : {}),
    ...(state.saveError ? { saveError: state.saveError } : {}),
    publishPending: state.publishPending,
    ...(state.publishError ? { publishError: state.publishError } : {}),
    problems: state.problems,
    canEdit,
    canPublish,
    canUndo: canEdit && !!state.undoStack.length,
    canRedo: canEdit && !!state.redoStack.length,
    insert,
    selectNode,
    setCapabilityConnection,
    setCapabilityInput,
    setWaitDuration,
    undo,
    redo,
    publish,
    reload,
    retrySave,
  }), [
    canEdit,
    canPublish,
    insert,
    publish,
    redo,
    reload,
    retrySave,
    selectNode,
    setCapabilityConnection,
    setCapabilityInput,
    setWaitDuration,
    state.conflict,
    state.document,
    state.problems,
    state.publishError,
    state.publishPending,
    state.redoStack.length,
    state.saveError,
    state.savePhase,
    state.selectedNodeId,
    state.undoStack.length,
    undo,
  ])
}
