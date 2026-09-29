import type { Context } from 'cordis'
import z from 'schemastery'
import type { ConsoleEntryInvalidation } from './entries.js'
import type { ConsoleSubscriptionDefinition } from './service.js'

export const consoleEntriesChanged: ConsoleSubscriptionDefinition<Record<string, unknown>, ConsoleEntryInvalidation> = {
  id: 'console:entries-changed',
  version: 1,
  kind: 'subscription',
  title: 'Console Entry invalidation',
  input: z.object({}),
  event: z.object({
    epoch: z.string().required(),
    revision: z.number().min(0).step(1).required(),
    entries: z.array(z.object({
      id: z.string().required(),
      incarnation: z.number().min(1).step(1).required(),
    })).required(),
  }),
}

/** Remains available while Console is online, including during Workbench teardown. */
export function consoleEntryChangesPlugin(ctx: Context): void {
  ctx.console.define(ctx, consoleEntriesChanged)
  ctx.console.provideSubscription(ctx, consoleEntriesChanged, {
    subscribe({ emit, request }) {
      let disposed = false
      let pending = ctx.consoleEntries.getSnapshot()
      let sending = false
      const flush = async () => {
        if (sending || disposed || request.signal.aborted) return
        sending = true
        try {
          while (!disposed && !request.signal.aborted) {
            const current = pending
            await emit(current)
            if (current === pending) break
          }
        } catch (error) {
          if (!disposed && !request.signal.aborted) request.logger.warn(error)
        } finally {
          sending = false
        }
      }
      const off = ctx.on('numen/console-entry-change', () => {
        pending = ctx.consoleEntries.getSnapshot()
        void flush()
      })
      void flush()
      return () => { disposed = true; off() }
    },
  })
}

consoleEntryChangesPlugin.inject = ['console', 'consoleEntries']
