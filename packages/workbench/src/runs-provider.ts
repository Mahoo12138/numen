import { automationIdSchema, automationSourceNodeIdSchema } from './automation-schemas.js'
import { provideManualRuns } from './manual-run-provider.js'
import { AutomationSnapshotInspectionLimitError } from '@numenjs/automation'
import '@numenjs/scheduler'
import { isSupportedAutomationVersion, type NumenValue } from '@numenjs/core'
import {
  ConsoleProcedureError,
  type ConsoleActionDefinition,
  type ConsoleQueryDefinition,
} from '@numenjs/console'
import type { ExecutionListCursor, RunListCursor, RunListFilters } from '@numenjs/scheduler'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchRunDetailQueryRef,
  workbenchCancelRunActionRef,
  workbenchRunsIndexQueryRef,
  type WorkbenchCancelRunInput,
  type WorkbenchCancelRunResult,
  type WorkbenchRunDetail,
  type WorkbenchRunsIndex,
} from './contracts.js'
import { projectRunFlow, projectWorkbenchRunDetail } from './run-detail-projection.js'
import { provideExecutionData } from './execution-data-provider.js'

const runStatus = z.union([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLING',
  'CANCELLED',
]).required()

function encodeCursor(cursor: RunListCursor | ExecutionListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function keysetCursorInput(label: string) {
  return z.transform(
    z.string().pattern(/^[A-Za-z0-9_-]+$/),
    (value): RunListCursor | undefined => {
      if (value === undefined) return
      try {
        const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<RunListCursor>
        if (typeof cursor.createdAt !== 'string' || !cursor.createdAt || typeof cursor.id !== 'string' || !cursor.id || encodeCursor(cursor as RunListCursor) !== value) throw new Error()
        return cursor as RunListCursor
      } catch {
        throw new z.ValidationError(`invalid ${label} cursor`, {})
      }
    },
    true,
  )
}

const runCursorInput = keysetCursorInput('Runs')
const executionCursorInput = keysetCursorInput('Execution diagnostics')

interface WorkbenchRunsProviderInput extends RunListFilters {
  limit: number
  cursor: (RunListCursor & RunListFilters) | undefined
}

interface WorkbenchRunDetailProviderInput {
  runId: string
  sourceNodeId?: string
  flowNodeId?: string
  executionId?: string
  executionLimit: number
  executionCursor: ExecutionListCursor | undefined
  eventLimit: number
  eventCursor: number | undefined
}

const executionStatus = z.union([
  'RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'COMPLETED',
  'FAILED', 'CANCELLING', 'CANCELLED', 'TIMED_OUT',
]).required()

const attemptStatus = z.union([
  'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED',
  'INTERRUPTED', 'OUTCOME_UNKNOWN',
]).required()

const cancellationReason = z.union([
  'USER', 'PARENT', 'RACE', 'TIMEOUT', 'PROVIDER_DISPOSED',
  'CONNECTION_DISPOSED', 'RECONFIGURED', 'SHUTDOWN', 'CREDENTIAL_ROTATED',
])

export const workbenchCancelRunAction: ConsoleActionDefinition<
  WorkbenchCancelRunInput,
  WorkbenchCancelRunResult
> = {
  ...workbenchCancelRunActionRef,
  kind: 'action',
  title: 'Cancel Run',
  description: 'Persist user cancellation intent and propagate it through the Run execution scope.',
  input: z.object({ runId: z.string().required() }),
  output: z.object({
    runId: z.string().required(),
    status: runStatus,
    cancelReason: cancellationReason,
    finishedAt: z.string(),
  }),
}

export const workbenchRunsIndexQuery: ConsoleQueryDefinition<Record<string, unknown>, WorkbenchRunsIndex> = {
  ...workbenchRunsIndexQueryRef,
  kind: 'query',
  title: 'Workbench Runs index',
  description: 'A bounded keyset page of durable Runs and their current status summary.',
  input: z.object({
    limit: z.number().step(1).min(1).max(50).required(),
    cursor: runCursorInput,
    automationId: automationIdSchema.required(false),
    status: runStatus.required(false),
  }),
  output: z.object({
    summary: z.object({
      total: z.number().required(),
      queued: z.number().required(),
      active: z.number().required(),
      completed: z.number().required(),
      failed: z.number().required(),
      cancelled: z.number().required(),
    }).required(),
    items: z.array(z.object({
      id: z.string().required(),
      automationId: z.string().required(),
      automationName: z.string().required(),
      revisionId: z.string().required(),
      snapshotPurpose: z.union(['published', 'draft-test']),
      sourceDraftVersion: z.number().step(1).min(1),
      status: runStatus,
      createdAt: z.string().required(),
      startedAt: z.string(),
      finishedAt: z.string(),
      executionCount: z.number().required(),
      attemptCount: z.number().required(),
    })).required(),
    nextCursor: z.string(),
  }),
}

export const workbenchRunDetailQuery: ConsoleQueryDefinition<Record<string, unknown>, WorkbenchRunDetail | null> = {
  ...workbenchRunDetailQueryRef,
  kind: 'query',
  title: 'Workbench Run detail',
  description: 'A bounded durable Run snapshot with Execution diagnostics and semantic Journal events.',
  input: z.object({
    runId: z.string().required(),
    sourceNodeId: automationSourceNodeIdSchema,
    flowNodeId: automationSourceNodeIdSchema,
    executionId: z.string().max(200),
    executionLimit: z.number().step(1).min(1).max(50).required(),
    executionCursor: executionCursorInput,
    eventLimit: z.number().step(1).min(1).max(100).required(),
    eventCursor: z.number().step(1).min(1),
  }),
  output: z.union([z.object({
    run: z.object({
      id: z.string().required(),
      automationId: z.string().required(),
      automationName: z.string().required(),
      revisionId: z.string().required(),
      revisionNumber: z.number(),
      snapshotPurpose: z.union(['published', 'draft-test']),
      sourceDraftVersion: z.number().step(1).min(1),
      status: runStatus,
      groupKey: z.string(),
      cancelReason: cancellationReason,
      createdAt: z.string().required(),
      startedAt: z.string(),
      finishedAt: z.string(),
    }).required(),
    executionSummary: z.object({
      total: z.number().required(),
      attempts: z.number().required(),
      runnable: z.number().required(),
      running: z.number().required(),
      waiting: z.number().required(),
      blocked: z.number().required(),
      completed: z.number().required(),
      failed: z.number().required(),
      cancelling: z.number().required(),
      cancelled: z.number().required(),
      timedOut: z.number().required(),
    }).required(),
    flow: z.any<WorkbenchRunDetail['flow']>().required(),
    context: z.array(z.object({
      name: z.union(['run', 'trigger', 'input', 'steps', 'vars', 'loop', 'error']).required(),
      value: z.any<NumenValue>(),
      truncated: z.boolean().required(),
    })).required(),
    executions: z.array(z.object({
      id: z.string().required(),
      instructionId: z.string().required(),
      sourceNodeId: z.string(),
      sampleId: z.string(),
      title: z.string().required(),
      operation: z.string().required(),
      status: executionStatus,
      parentExecutionId: z.string(),
      scopeExecutionId: z.string(),
      scopeBranch: z.number(),
      loopIndex: z.number(),
      blockedReason: z.string(),
      generation: z.number().required(),
      createdAt: z.string().required(),
      updatedAt: z.string().required(),
      attempts: z.array(z.object({
        id: z.string().required(),
        number: z.number().required(),
        status: attemptStatus,
        providerRef: z.string().required(),
        errorSummary: z.string(),
        startedAt: z.string().required(),
        finishedAt: z.string(),
      })).required(),
    })).required(),
    nextExecutionCursor: z.string(),
    timeline: z.object({
      total: z.number().required(),
      items: z.array(z.object({
        sequence: z.number().required(),
        type: z.string().required(),
        title: z.string().required(),
        detail: z.string(),
        executionId: z.string(),
        attemptId: z.string(),
        occurredAt: z.string().required(),
      })).required(),
      nextCursor: z.number(),
    }).required(),
  }), z.const(null)]),
}

export function workbenchRunsProviderPlugin(ctx: Context): void {
  provideManualRuns(ctx)
  provideExecutionData(ctx)
  ctx.console.provideQuery(ctx, workbenchRunsIndexQueryRef, {
    query({ input }: { input: WorkbenchRunsProviderInput }): WorkbenchRunsIndex {
      if (input.automationId && !ctx.automations.get(input.automationId)) throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found.')
      const filters: RunListFilters = { ...(input.automationId ? { automationId: input.automationId } : {}), ...(input.status ? { status: input.status } : {}) }
      if (input.cursor && (input.cursor.automationId !== filters.automationId || input.cursor.status !== filters.status)) {
        throw new ConsoleProcedureError(400, 'RUN_CURSOR_SCOPE_MISMATCH', 'The cursor belongs to another Automation or status filter.')
      }
      const page = ctx.scheduler.listRunSummariesPage(input.limit, input.cursor, filters)
      const counts = ctx.scheduler.getRunStatusCounts(input.automationId)
      const automationNames = new Map(ctx.automations.list(true).map(automation => [automation.id, automation.name]))
      return {
        summary: {
          total: Object.values(counts).reduce((sum, count) => sum + count, 0),
          queued: counts.QUEUED,
          active: counts.RUNNING + counts.CANCELLING,
          completed: counts.COMPLETED,
          failed: counts.FAILED,
          cancelled: counts.CANCELLED,
        },
        items: page.items.map(run => {
          const snapshot = ctx.automations.getExecutionSnapshotIdentity(run.revisionId)
          return {
            id: run.id,
            automationId: run.automationId,
            automationName: automationNames.get(run.automationId) ?? 'Unknown automation',
            revisionId: run.revisionId,
            ...(snapshot ? { snapshotPurpose: snapshot.purpose, ...(snapshot.purpose === 'draft-test' ? { sourceDraftVersion: snapshot.sourceDraftVersion } : {}) } : {}),
            status: run.status,
            createdAt: run.createdAt,
            ...(run.startedAt ? { startedAt: run.startedAt } : {}),
            ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
            executionCount: run.executionCount,
            attemptCount: run.attemptCount,
          }
        }),
        ...(page.nextCursor ? { nextCursor: encodeCursor({ ...page.nextCursor, ...filters }) } : {}),
      }
    },
  })
  ctx.console.provideQuery(ctx, workbenchRunDetailQueryRef, {
    query({ input }: { input: WorkbenchRunDetailProviderInput }): WorkbenchRunDetail | null {
      try {
        const run = ctx.scheduler.getRun(input.runId)
        if (!run) return null
        const automation = ctx.automations.get(run.automationId)
        const revision = ctx.automations.getExecutionSnapshotForInspection(run.revisionId, run.automationId)
        const supportedRevision = revision && isSupportedAutomationVersion(revision.protocolVersion, revision.irVersion) ? revision : undefined
        const inspection = ctx.scheduler.inspectRun(run.id)!
        const diagnostics = ctx.scheduler.listExecutionDiagnosticsPage(
          run.id,
          input.executionLimit,
          input.executionCursor,
          {
            ...(input.sourceNodeId ? { instructionIds: Object.keys(supportedRevision?.compiledPlan.instructions ?? {}).filter(id =>
              (supportedRevision?.compiledPlan.sourceMap?.[id]?.nodeId ?? id) === input.sourceNodeId) } : {}),
            ...(input.executionId ? { executionId: input.executionId } : {}),
          },
        )
        const events = ctx.scheduler.listRunEventsPage(run.id, input.eventLimit, input.eventCursor)
        const result = projectWorkbenchRunDetail(
          run,
          automation?.name ?? 'Unknown automation',
          revision,
          inspection,
          diagnostics,
          events,
          encodeCursor,
          input.flowNodeId,
        )
        let maximumNodes = 250
        while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 131_072 && maximumNodes > 1) {
          maximumNodes = Math.max(1, Math.floor(maximumNodes / 2))
          result.flow = projectRunFlow(revision, inspection.instructionExecutions, inspection.graphMembers, result.flow.focusedNodeId, maximumNodes)
        }
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 131_072) throw new ConsoleProcedureError(413, 'RUN_DETAIL_LIMIT', 'The Run inspection exceeds its size limit.')
        return result
      } catch (error) {
        if (error instanceof ConsoleProcedureError) throw error
        if (error instanceof AutomationSnapshotInspectionLimitError) throw new ConsoleProcedureError(413, 'RUN_DETAIL_LIMIT', 'The Run inspection exceeds its size limit.')
        throw new ConsoleProcedureError(409, 'RUN_DETAIL_UNAVAILABLE', 'The Run could not be inspected.')
      }
    },
  })
  ctx.console.provideAction(ctx, workbenchCancelRunActionRef, {
    action({ input }: { input: WorkbenchCancelRunInput }): WorkbenchCancelRunResult {
      if (!ctx.scheduler.getRun(input.runId)) {
        throw new ConsoleProcedureError(404, 'RUN_NOT_FOUND', 'The Run was not found')
      }
      const run = ctx.scheduler.cancelRun(input.runId, 'USER')
      return {
        runId: run.id,
        status: run.status,
        ...(run.cancelReason ? { cancelReason: run.cancelReason } : {}),
        ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      }
    },
  })
}

workbenchRunsProviderPlugin.inject = ['workbench', 'console', 'automations', 'scheduler']

export default workbenchRunsProviderPlugin
