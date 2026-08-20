import '@numen/automation'
import '@numen/connections'
import '@numen/scheduler'
import type { ConsoleQueryDefinition } from '@numen/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchHomeOverviewQueryRef,
  type WorkbenchHomeOverview,
  type WorkbenchRunStatus,
} from './contracts.js'

const runStatus = z.union([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLING',
  'CANCELLED',
]).required()

export const workbenchHomeOverviewQuery: ConsoleQueryDefinition<Record<string, unknown>, WorkbenchHomeOverview> = {
  ...workbenchHomeOverviewQueryRef,
  kind: 'query',
  title: 'Workbench home overview',
  description: 'Current Automation, Run, and Connection summaries for the Workbench Home Page.',
  input: z.object({}),
  output: z.object({
    automations: z.object({
      total: z.number().required(),
      enabled: z.number().required(),
      recent: z.array(z.object({
        id: z.string().required(),
        name: z.string().required(),
        enabled: z.boolean().required(),
        updatedAt: z.string().required(),
      })).required(),
    }).required(),
    runs: z.object({
      queued: z.number().required(),
      active: z.number().required(),
      recent: z.array(z.object({
        id: z.string().required(),
        automationId: z.string().required(),
        automationName: z.string().required(),
        status: runStatus,
        createdAt: z.string().required(),
        finishedAt: z.string(),
      })).required(),
    }).required(),
    connections: z.object({
      ready: z.boolean().required(),
      total: z.number().required(),
      enabled: z.number().required(),
      runtimeReady: z.number().required(),
      unavailable: z.number().required(),
      errors: z.number().required(),
    }).required(),
  }),
}

export function workbenchHomeProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchHomeOverviewQueryRef, {
    query(): WorkbenchHomeOverview {
      const automations = ctx.automations.list()
      const automationNames = new Map(automations.map(automation => [automation.id, automation.name]))
      const runs = ctx.scheduler.listRuns(5)
      const scheduler = ctx.scheduler.health()
      const connections = ctx.connections.health()
      return {
        automations: {
          total: automations.length,
          enabled: automations.filter(automation => automation.enabled).length,
          recent: automations.slice(0, 5).map(automation => ({
            id: automation.id,
            name: automation.name,
            enabled: automation.enabled,
            updatedAt: automation.updatedAt,
          })),
        },
        runs: {
          queued: scheduler.queuedRuns,
          active: scheduler.runningRuns + scheduler.cancellingRuns,
          recent: runs.map(run => ({
            id: run.id,
            automationId: run.automationId,
            automationName: automationNames.get(run.automationId) ?? 'Unknown automation',
            status: run.status as WorkbenchRunStatus,
            createdAt: run.createdAt,
            ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
          })),
        },
        connections: {
          ready: connections.ready,
          total: connections.total,
          enabled: connections.enabled,
          runtimeReady: connections.runtimeReady,
          unavailable: connections.unavailable,
          errors: connections.errors,
        },
      }
    },
  })
}

workbenchHomeProviderPlugin.inject = ['workbench', 'console', 'automations', 'scheduler', 'connections']

export default workbenchHomeProviderPlugin
