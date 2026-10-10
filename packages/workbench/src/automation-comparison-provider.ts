import { AutomationDraftInspectionLimitError, AutomationSnapshotInspectionLimitError, DraftConflictError } from '@numenjs/automation'
import { ConsoleProcedureError, type ConsoleQueryDefinition, type ConsoleRequestContext } from '@numenjs/console'
import type { AutomationSource, NumenValue } from '@numenjs/core'
import type { Context } from 'cordis'
import z from 'schemastery'
import { AutomationComparisonLimitError, AutomationComparisonUnavailableError, compareAutomationDocumentPage } from './automation-comparison.js'
import { automationIdSchema } from './automation-schemas.js'
import {
  workbenchAutomationComparisonQueryRef, workbenchAutomationComparisonStateQueryRef,
  type WorkbenchAutomationComparison, type WorkbenchAutomationComparisonIdentity, type WorkbenchAutomationComparisonQueryInput,
  type WorkbenchAutomationComparisonState, type WorkbenchAutomationComparisonTarget,
} from './contracts.js'

const targetSchema = z.union([
  z.object({ kind: z.const('draft').required(), version: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required() }),
  z.object({ kind: z.const('snapshot').required(), snapshotId: z.string().pattern(/^(?:rev|snap)_[a-f0-9]{32}$/).required() }),
]).required()

export const workbenchAutomationComparisonQuery: ConsoleQueryDefinition<WorkbenchAutomationComparisonQueryInput, WorkbenchAutomationComparison> = {
  ...workbenchAutomationComparisonQueryRef, kind: 'query', title: 'Compare fixed Automation documents',
  description: 'Bounded semantic changes between an exact saved Draft version and a snapshot, or two immutable snapshots. Values remain opaque.',
  input: z.object({ automationId: automationIdSchema, left: targetSchema, right: targetSchema,
    changeOffset: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER), changeLimit: z.number().step(1).min(1).max(250) }),
  output: z.any<WorkbenchAutomationComparison>(),
}

export const workbenchAutomationComparisonStateQuery: ConsoleQueryDefinition<{ automationId: string }, WorkbenchAutomationComparisonState> = {
  ...workbenchAutomationComparisonStateQueryRef, kind: 'query', title: 'Read Automation comparison identities',
  description: 'Current saved Draft version and at most 100 published Revision identities, without reading document JSON.',
  input: z.object({ automationId: automationIdSchema }),
  output: z.any<WorkbenchAutomationComparisonState>(),
}

function authenticate(request: ConsoleRequestContext): void {
  if (!request.principal.authenticated) throw new ConsoleProcedureError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.')
  request.signal.throwIfAborted()
}

function notFound(): ConsoleProcedureError {
  return new ConsoleProcedureError(404, 'AUTOMATION_COMPARISON_NOT_FOUND', 'The comparison document was not found in this Automation.')
}

function boundedResult<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 131_072) throw new ConsoleProcedureError(413, 'AUTOMATION_COMPARISON_LIMIT', 'The Automation comparison exceeds its size limit.')
  return result
}

function sanitizeFailure(error: unknown): never {
  if (error instanceof ConsoleProcedureError) throw error
  if (error instanceof DraftConflictError) throw new ConsoleProcedureError(409, 'AUTOMATION_COMPARISON_STALE', 'The saved Draft version changed. Refresh the comparison explicitly.')
  if (error instanceof AutomationDraftInspectionLimitError || error instanceof AutomationSnapshotInspectionLimitError || error instanceof AutomationComparisonLimitError) {
    throw new ConsoleProcedureError(413, 'AUTOMATION_COMPARISON_LIMIT', 'The Automation comparison exceeds its size limit.')
  }
  if (error instanceof AutomationComparisonUnavailableError) throw new ConsoleProcedureError(409, 'AUTOMATION_COMPARISON_UNAVAILABLE', 'The Automation documents could not be compared.')
  // Persisted JSON and unknown Source failures may include private values in their messages.
  throw new ConsoleProcedureError(409, 'AUTOMATION_COMPARISON_UNAVAILABLE', 'The Automation documents could not be compared.')
}

interface ComparisonDocument {
  source: AutomationSource
  presentation: Record<string, NumenValue>
  protocolVersion: number
  irVersion: number
  identity: WorkbenchAutomationComparisonIdentity
}

function resolveDocument(ctx: Context, automationId: string, target: WorkbenchAutomationComparisonTarget): ComparisonDocument {
  if (target.kind === 'draft') {
    const draft = ctx.automations.getDraftForInspection(automationId, target.version)
    if (!draft) throw notFound()
    const version = draft.source.flow?.type === 'graph' ? 2 : 1
    return { source: draft.source, presentation: draft.presentation, protocolVersion: version, irVersion: version, identity: { kind: 'draft', version: draft.version, updatedAt: draft.updatedAt } }
  }
  const snapshot = ctx.automations.getExecutionSnapshotForInspection(target.snapshotId, automationId)
  if (!snapshot) throw notFound()
  return {
    source: snapshot.source, presentation: snapshot.presentation, protocolVersion: snapshot.protocolVersion, irVersion: snapshot.irVersion,
    identity: { kind: 'snapshot', snapshotId: snapshot.id, purpose: snapshot.purpose, createdAt: snapshot.createdAt,
      ...(snapshot.purpose === 'published' ? { number: snapshot.number } : { sourceDraftVersion: snapshot.sourceDraftVersion }),
    },
  }
}

export function workbenchAutomationComparisonProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchAutomationComparisonQueryRef, {
    query({ input, request }: { input: WorkbenchAutomationComparisonQueryInput; request: ConsoleRequestContext }): WorkbenchAutomationComparison {
      authenticate(request)
      if (input.left.kind === 'draft' && input.right.kind === 'draft') throw new ConsoleProcedureError(422, 'AUTOMATION_COMPARISON_TARGETS_INVALID', 'Select a saved Draft and an immutable snapshot, or two immutable snapshots.')
      try {
        const automation = ctx.automations.get(input.automationId)
        if (!automation) throw notFound()
        const left = resolveDocument(ctx, automation.id, input.left)
        const right = resolveDocument(ctx, automation.id, input.right)
        return boundedResult({ automationId: automation.id, automationName: automation.name, left: left.identity, right: right.identity,
          ...compareAutomationDocumentPage(left, right, input.changeOffset, input.changeLimit) })
      } catch (error) { return sanitizeFailure(error) }
    },
  })
  ctx.console.provideQuery(ctx, workbenchAutomationComparisonStateQueryRef, {
    query({ input, request }: { input: { automationId: string }; request: ConsoleRequestContext }): WorkbenchAutomationComparisonState {
      authenticate(request)
      try {
        const state = ctx.automations.getComparisonState(input.automationId)
        if (!state) throw notFound()
        return boundedResult(state)
      } catch (error) { return sanitizeFailure(error) }
    },
  })
}

workbenchAutomationComparisonProviderPlugin.inject = ['workbench', 'console', 'automations']
export default workbenchAutomationComparisonProviderPlugin
