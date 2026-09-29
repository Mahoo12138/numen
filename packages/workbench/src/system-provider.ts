import type {} from '@numenjs/database'
import type {} from '@numenjs/scheduler'
import type {} from '@numenjs/triggers'
import type {} from '@numenjs/connections'
import type {} from '@numenjs/logging'
import type { ConsoleQueryDefinition } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import { workbenchSystemQueryRef, type WorkbenchSystemCheck, type WorkbenchSystemOverview } from './management-contracts.js'

export const workbenchSystemQuery: ConsoleQueryDefinition<Record<string, unknown>, WorkbenchSystemOverview> = {
  ...workbenchSystemQueryRef, kind: 'query', title: 'System health snapshot', input: z.object({}),
  output: z.object({ observedAt: z.string().required(), checks: z.array(z.object({
    id: z.union(['storage', 'scheduler', 'triggers', 'connections', 'logs']).required(),
    status: z.union(['ready', 'attention', 'unavailable']).required(), values: z.dict(z.union([z.number(), z.string(), z.boolean()])).required(),
  })).required() }),
}
export function workbenchSystemProviderPlugin(ctx: Context): void {
  const readers = new Map<WorkbenchSystemCheck['id'], () => WorkbenchSystemCheck>()
  function attach(id: WorkbenchSystemCheck['id'], child: Context, read: () => WorkbenchSystemCheck) {
    child.fiber.effect(() => { readers.set(id, read); return () => { if (readers.get(id) === read) readers.delete(id) } })
  }
  ctx.inject(['database'], child => attach('storage', child, () => {
    const { ready, migrationVersion } = child.database.health()
    return { id: 'storage', status: ready ? 'ready' : 'attention', values: { migrationVersion } }
  }))
  ctx.inject(['scheduler'], child => attach('scheduler', child, () => {
    const { ready, ...values } = child.scheduler.health()
    return { id: 'scheduler', status: !ready || values.blockedExecutions ? 'attention' : 'ready', values }
  }))
  ctx.inject(['triggers'], child => attach('triggers', child, () => {
    const { ready, ...values } = child.triggers.health()
    return { id: 'triggers', status: !ready || values.unavailableSubscriptions ? 'attention' : 'ready', values }
  }))
  ctx.inject(['connections'], child => attach('connections', child, () => {
    const { ready, ...values } = child.connections.health()
    return { id: 'connections', status: !ready || values.errors || values.unavailable ? 'attention' : 'ready', values }
  }))
  ctx.inject(['logs'], child => attach('logs', child, () => {
    const { persistence, retained, evicted, malformed } = child.logs.query({ limit: 1 })
    return { id: 'logs', status: persistence === 'failed' || malformed ? 'attention' : 'ready', values: { persistence, retained, evicted, malformed } }
  }))
  ctx.console.provideQuery(ctx, workbenchSystemQueryRef, { query(): WorkbenchSystemOverview {
    return { observedAt: new Date().toISOString(), checks: (['storage', 'scheduler', 'triggers', 'connections', 'logs'] as const).map(id => {
      try { return readers.get(id)?.() ?? { id, status: 'unavailable', values: {} } }
      catch { return { id, status: 'unavailable', values: {} } }
    }) }
  } })
}
workbenchSystemProviderPlugin.inject = ['workbench', 'console']
