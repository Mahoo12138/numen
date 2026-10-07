import { AutomationSnapshotInspectionLimitError } from '@numenjs/automation'
import { ConsoleProcedureError, type ConsoleQueryDefinition, type ConsoleRequestContext } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import { automationIdSchema } from './automation-schemas.js'
import { projectAutomationSnapshot } from './automation-snapshot-projection.js'
import { workbenchAutomationSnapshotQueryRef, type WorkbenchAutomationSnapshotDetail, type WorkbenchAutomationSnapshotQueryInput } from './contracts.js'

export const workbenchAutomationSnapshotQuery: ConsoleQueryDefinition<WorkbenchAutomationSnapshotQueryInput, WorkbenchAutomationSnapshotDetail> = {
  ...workbenchAutomationSnapshotQueryRef, kind: 'query', title: 'Inspect an immutable Automation snapshot',
  description: 'Authenticated, bounded Source and presentation inspection using only frozen contracts.',
  input: z.object({ automationId: automationIdSchema, snapshotId: z.string().pattern(/^(?:rev|snap)_[a-f0-9]{32}$/).required() }),
  output: z.any<WorkbenchAutomationSnapshotDetail>(),
}

export function workbenchAutomationSnapshotProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchAutomationSnapshotQueryRef, {
    query({ input, request }: { input: WorkbenchAutomationSnapshotQueryInput; request: ConsoleRequestContext }): WorkbenchAutomationSnapshotDetail {
      if (!request.principal.authenticated) throw new ConsoleProcedureError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.')
      request.signal.throwIfAborted()
      try {
        const automation = ctx.automations.get(input.automationId)
        const snapshot = automation && ctx.automations.getExecutionSnapshotForInspection(input.snapshotId, automation.id)
        if (!automation || !snapshot) throw new ConsoleProcedureError(404, 'AUTOMATION_SNAPSHOT_NOT_FOUND', 'The snapshot was not found in this Automation.')
        const result = projectAutomationSnapshot(snapshot, automation.name)
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 131_072) throw new ConsoleProcedureError(413, 'AUTOMATION_SNAPSHOT_LIMIT', 'The snapshot inspection exceeds its size limit.')
        return result
      } catch (error) {
        if (error instanceof ConsoleProcedureError) throw error
        if (error instanceof AutomationSnapshotInspectionLimitError) throw new ConsoleProcedureError(413, 'AUTOMATION_SNAPSHOT_LIMIT', 'The snapshot inspection exceeds its size limit.')
        // Persisted JSON and arbitrary schema failures can include data fragments in errors.
        throw new ConsoleProcedureError(409, 'AUTOMATION_SNAPSHOT_UNAVAILABLE', 'The snapshot could not be inspected.')
      }
    },
  })
}

workbenchAutomationSnapshotProviderPlugin.inject = ['workbench', 'console', 'automations']
export default workbenchAutomationSnapshotProviderPlugin
