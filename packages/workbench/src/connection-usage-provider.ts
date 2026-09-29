import type {} from '@numenjs/automation'
import type {} from '@numenjs/connections'
import type { AutomationSource, ControlSource } from '@numenjs/core'
import type { ConsoleQueryDefinition } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import { workbenchConnectionUsageRef, type WorkbenchConnectionUsage } from './management-contracts.js'

/** Read only structural bindings, never arbitrary parameter values that happen to contain an ID. */
export function sourceConnectionUsage(source: AutomationSource, id: string): { used: boolean; complete: boolean } {
  let used = source.triggers.some(trigger => Object.values(trigger.connections ?? {}).includes(id))
  let complete = true
  function visit(node: ControlSource): void {
    switch (node.type) {
      case 'capability': used ||= Object.values(node.connections ?? {}).includes(id); break
      case 'block': node.steps.forEach(visit); break
      case 'if': visit(node.then); if (node.else) visit(node.else); break
      case 'parallel': case 'race': node.branches.forEach(visit); break
      case 'foreach': visit(node.body); break
      case 'extension': complete = false; break
    }
  }
  visit(source.flow)
  return { used, complete }
}
export const workbenchConnectionUsageQuery: ConsoleQueryDefinition<Record<string, unknown>, WorkbenchConnectionUsage[]> = {
  ...workbenchConnectionUsageRef, kind: 'query', title: 'Connection usage in current Drafts and active Revisions', input: z.object({}), output: z.array(z.object({
    connectionId: z.string().required(), complete: z.boolean().required(), automations: z.array(z.object({ id: z.string().required(), name: z.string().required(), draft: z.boolean().required(), active: z.boolean().required() })).required(),
  })).required(),
}
export function workbenchConnectionUsageProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchConnectionUsageRef, { query(): WorkbenchConnectionUsage[] {
    const automations = ctx.automations.list().map(automation => ({ automation, draft: ctx.automations.getDraft(automation.id)?.source, active: automation.activeRevisionId ? ctx.automations.getRevision(automation.activeRevisionId)?.source : undefined }))
    return ctx.connections.list().map(connection => {
      let complete = true
      const usages: WorkbenchConnectionUsage['automations'] = []
      for (const { automation, draft, active } of automations) {
        const a = draft ? sourceConnectionUsage(draft, connection.id) : { used: false, complete: true }
        const b = active ? sourceConnectionUsage(active, connection.id) : { used: false, complete: true }
        complete &&= a.complete && b.complete
        if (a.used || b.used) usages.push({ id: automation.id, name: automation.name, draft: a.used, active: b.used })
      }
      return { connectionId: connection.id, automations: usages, complete }
    })
  } })
}
workbenchConnectionUsageProviderPlugin.inject = ['workbench', 'console', 'automations', 'connections']
