import '@numen/automation'
import '@numen/scheduler'
import type { ConsoleQueryDefinition } from '@numen/console'
import type { RunListCursor } from '@numen/scheduler'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchRunsIndexQueryRef,
  type WorkbenchRunsIndex,
} from './contracts.js'

const runStatus = z.union([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLING',
  'CANCELLED',
]).required()

function encodeCursor(cursor: RunListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

const cursorInput = z.transform(
  z.string().pattern(/^[A-Za-z0-9_-]+$/),
  (value): RunListCursor | undefined => {
    if (value === undefined) return
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<RunListCursor>
      if (!cursor.createdAt || !cursor.id || encodeCursor(cursor as RunListCursor) !== value) throw new Error()
      return { createdAt: cursor.createdAt, id: cursor.id }
    } catch {
      throw new z.ValidationError('invalid Runs cursor', {})
    }
  },
  true,
)

interface WorkbenchRunsProviderInput {
  limit: number
  cursor: RunListCursor | undefined
}

export const workbenchRunsIndexQuery: ConsoleQueryDefinition<Record<string, unknown>, WorkbenchRunsIndex> = {
  ...workbenchRunsIndexQueryRef,
  kind: 'query',
  title: 'Workbench Runs index',
  description: 'A bounded keyset page of durable Runs and their current status summary.',
  input: z.object({
    limit: z.number().step(1).min(1).max(50).required(),
    cursor: cursorInput,
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
}

workbenchRunsProviderPlugin.inject = ['workbench', 'console', 'automations', 'scheduler']

export default workbenchRunsProviderPlugin
