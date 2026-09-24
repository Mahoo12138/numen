import { logsChangedRef, logsQueryRef, type LogQuery, type LogSnapshot } from '@numenjs/logging/contracts'
import type {} from '@numenjs/logging'
import type { ConsoleQueryDefinition, ConsoleSubscriptionDefinition } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'

const cursor = z.object({ stream: z.string().max(200).required(), sequence: z.natural().min(1).required() })
const fields = {
  automationId: z.string().max(200), runId: z.string().max(200), executionId: z.string().max(200),
  attemptId: z.string().max(200), connectionId: z.string().max(200), triggerId: z.string().max(200),
  requestId: z.string().max(200), traceId: z.string().max(200),
}
export const workbenchLogsQuery: ConsoleQueryDefinition<LogQuery, LogSnapshot> = {
  ...logsQueryRef, kind: 'query', title: 'Runtime logs',
  input: z.object({ ...fields, limit: z.natural().min(1).max(200), before: z.union([z.const(undefined), cursor]), maxLevel: z.natural().max(3), namespace: z.string().max(200), search: z.string().max(200) }),
  output: z.object({
    records: z.array(z.object({
      ...fields, id: z.string().required(), timestamp: z.string().required(), type: z.union(['error', 'warn', 'info', 'debug']).required(),
      level: z.natural().max(3).required(), namespace: z.string().required(), message: z.string().required(), pluginPath: z.string(), fiberId: z.natural(),
    })).required(),
    stream: z.string().required(), revision: z.natural().required(), next: z.union([z.const(undefined), cursor]), reset: z.boolean().required(), expired: z.boolean().required(), retained: z.natural().required(), evicted: z.natural().required(), malformed: z.natural().required(),
    persistence: z.union(['ready', 'disabled', 'failed']).required(),
  }),
}
export const workbenchLogsChanged: ConsoleSubscriptionDefinition<Record<string, unknown>, { changed: true }> = {
  ...logsChangedRef, kind: 'subscription', title: 'Runtime log updates', input: z.object({}), event: z.object({ changed: z.const(true).required() }),
}

export function workbenchLogsProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery<LogQuery, LogSnapshot>(ctx, logsQueryRef, { query: ({ input }) => ctx.logs.query(input) })
  ctx.console.provideSubscription(ctx, logsChangedRef, {
    subscribe({ emit, request }) {
      let disposed = false
      let sending = false
      let pending = false
      const send = async () => {
        if (disposed) return
        if (sending) { pending = true; return }
        sending = true
        try {
          do { pending = false; await emit({ changed: true }) } while (pending && !disposed)
        } catch { disposed = true; unsubscribe() }
        finally { sending = false }
      }
      const unsubscribe = ctx.logs.subscribe(() => { void send() })
      const dispose = () => { disposed = true; unsubscribe(); request.signal.removeEventListener('abort', dispose) }
      request.signal.addEventListener('abort', dispose, { once: true })
      // Reconnect barrier: clients fetch an authoritative bounded snapshot, never append duplicates.
      void send()
      return dispose
    },
  })
}
workbenchLogsProviderPlugin.inject = ['workbench', 'console', 'logs']
