import '@numen/automation'
import '@numen/connections'
import type { ConsoleSubscriptionDefinition } from '@numen/console'
import '@numen/scheduler'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchInvalidationSubscriptionRef,
  type WorkbenchInvalidationEvent,
  type WorkbenchInvalidationScope,
} from './contracts.js'

const scopeOrder: WorkbenchInvalidationScope[] = ['home', 'automations', 'automationCatalog', 'runs', 'connections', 'credentials']
const invalidationScope = z.union(scopeOrder).required()

export const workbenchInvalidationSubscription: ConsoleSubscriptionDefinition<
  Record<string, unknown>,
  WorkbenchInvalidationEvent
> = {
  ...workbenchInvalidationSubscriptionRef,
  kind: 'subscription',
  title: 'Workbench data invalidation',
  description: 'Coalesced domain change notifications for visible Workbench Queries.',
  input: z.object({}),
  event: z.object({
    scopes: z.array(invalidationScope).required(),
  }),
}

export function workbenchInvalidationProviderPlugin(ctx: Context): void {
  ctx.console.provideSubscription(ctx, workbenchInvalidationSubscriptionRef, {
    subscribe({ emit, request }) {
      let disposed = false
      let scheduled = false
      const pending = new Set<WorkbenchInvalidationScope>()
      const send = (event: WorkbenchInvalidationEvent) => {
        void Promise.resolve(emit(event)).catch(error => request.logger.warn(error))
      }
      const flush = () => {
        scheduled = false
        if (disposed || !pending.size) return
        const scopes = scopeOrder.filter(scope => pending.delete(scope))
        send({ scopes })
      }
      const invalidate = (...scopes: WorkbenchInvalidationScope[]) => {
        for (const scope of scopes) pending.add(scope)
        if (scheduled) return
        scheduled = true
        queueMicrotask(flush)
      }
      const disposeAutomation = ctx.on('numen/automation-change', () => invalidate('home', 'automations'))
      const disposeCapability = ctx.on('numen/capability-change', () => invalidate('automationCatalog'))
      const disposeRun = ctx.on('numen/run-change', () => invalidate('home', 'runs'))
      const disposeConnection = ctx.on('numen/connection-change', () => invalidate('home', 'automationCatalog', 'connections', 'credentials'))
      const disposeCredential = ctx.on('numen/credential-change', () => invalidate('credentials', 'connections'))
      const disposeCredentialType = ctx.on('numen/credential-type-change', () => invalidate('credentials', 'connections'))
      const disposeConnectionRuntime = ctx.on('numen/connection-runtime-change', () => invalidate('home', 'automationCatalog', 'connections'))

      // This initial event is a reconnect barrier. The browser ignores it during first setup,
      // then treats it as an invalidation whenever the WebSocket subscription is restored.
      send({ scopes: [...scopeOrder] })

      return () => {
        disposed = true
        pending.clear()
        disposeAutomation()
        disposeCapability()
        disposeRun()
        disposeCredential()
        disposeCredentialType()
        disposeConnection()
        disposeConnectionRuntime()
      }
    },
  })
}

workbenchInvalidationProviderPlugin.inject = [
  'workbench',
  'console',
  'automations',
  'capabilities',
  'scheduler',
  'connections',
]

export default workbenchInvalidationProviderPlugin
