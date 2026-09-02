import '@numen/automation'
import '@numen/scheduler'
import type { NumenValue } from '@numen/core'
import {
  ConsoleProcedureError,
  type ConsoleActionDefinition,
  type ConsoleQueryDefinition,
} from '@numen/console'
import type { ExecutionListCursor, RunListCursor } from '@numen/scheduler'
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
import { projectWorkbenchRunDetail } from './run-detail-projection.js'

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
        if (!cursor.createdAt || !cursor.id || encodeCursor(cursor as RunListCursor) !== value) throw new Error()
        return { createdAt: cursor.createdAt, id: cursor.id }
      } catch {
        throw new z.ValidationError(`invalid ${label} cursor`, {})
      }
    },
    true,
  )
}

const runCursorInput = keysetCursorInput('Runs')
const executionCursorInput = keysetCursorInput('Execution diagnostics')

interface WorkbenchRunsProviderInput {
  limit: number
  cursor: RunListCursor | undefined
}

interface WorkbenchRunDetailProviderInput {
  runId: string
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
  ctx.console.provideQuery(ctx, workbenchRunsIndexQueryRef, {
    query({ input }: { input: WorkbenchRunsProviderInput }): WorkbenchRunsIndex {
      const page = ctx.scheduler.listRunSummariesPage(input.limit, input.cursor)
      const counts = ctx.scheduler.getRunStatusCounts()
      const automationNames = new Map(ctx.automations.list().map(automation => [automation.id, automation.name]))
      return {
        summary: {
          total: Object.values(counts).reduce((sum, count) => sum + count, 0),
          queued: counts.QUEUED,
          active: counts.RUNNING + counts.CANCELLING,
          completed: counts.COMPLETED,
          failed: counts.FAILED,
          cancelled: counts.CANCELLED,
        },
        items: page.items.map(run => ({
          id: run.id,
          automationId: run.automationId,
          automationName: automationNames.get(run.automationId) ?? 'Unknown automation',
          revisionId: run.revisionId,
          status: run.status,
          createdAt: run.createdAt,
          ...(run.startedAt ? { startedAt: run.startedAt } : {}),
          ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
          executionCount: run.executionCount,
          attemptCount: run.attemptCount,
        })),
        ...(page.nextCursor ? { nextCursor: encodeCursor(page.nextCursor) } : {}),
      }
    },
  })
  ctx.console.provideQuery(ctx, workbenchRunDetailQueryRef, {
    query({ input }: { input: WorkbenchRunDetailProviderInput }): WorkbenchRunDetail | null {
      const run = ctx.scheduler.getRun(input.runId)
      if (!run) return null
      const automation = ctx.automations.get(run.automationId)
      const revision = ctx.automations.getRevision(run.revisionId)
      const inspection = ctx.scheduler.inspectRun(run.id)!
      const diagnostics = ctx.scheduler.listExecutionDiagnosticsPage(
        run.id,
        input.executionLimit,
        input.executionCursor,
      )
      const events = ctx.scheduler.listRunEventsPage(run.id, input.eventLimit, input.eventCursor)
      return projectWorkbenchRunDetail(
        run,
        automation?.name ?? 'Unknown automation',
        revision,
        inspection,
        diagnostics,
        events,
        encodeCursor,
      )
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
