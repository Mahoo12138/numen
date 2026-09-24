import { AutomationArchivedError } from '@numenjs/automation'
import { ConsoleProcedureError, type ConsoleActionDefinition, type ConsoleQueryDefinition } from '@numenjs/console'
import { AutomationInputValidationError } from '@numenjs/core'
import { ManualRunRequestConflictError, ManualRunRevisionConflictError } from '@numenjs/scheduler'
import type { Context } from 'cordis'
import z from 'schemastery'
import { automationIdSchema } from './automation-schemas.js'
import { workbenchManualRunFormQueryRef, workbenchStartManualRunActionRef, type WorkbenchManualRunForm, type WorkbenchStartManualRunInput, type WorkbenchStartManualRunResult } from './contracts.js'

export const workbenchManualRunFormQuery: ConsoleQueryDefinition<{ automationId: string }, WorkbenchManualRunForm> = {
  ...workbenchManualRunFormQueryRef, kind: 'query', title: 'Manual Run parameters',
  input: z.object({ automationId: automationIdSchema }),
  output: z.object({ automationId: z.string().required(), revisionId: z.string().required(), revisionNumber: z.number().required(), inputs: z.any() }),
}
export const workbenchStartManualRunAction: ConsoleActionDefinition<WorkbenchStartManualRunInput, WorkbenchStartManualRunResult> = {
  ...workbenchStartManualRunActionRef, kind: 'action', title: 'Start manual Run',
  input: z.object({
    automationId: automationIdSchema,
    requestId: z.string().pattern(/^[a-zA-Z0-9_-]{16,80}$/).required(),
    expectedRevisionId: z.string().pattern(/^rev_[a-f0-9]{32}$/).required(),
    input: z.any().required(),
  }),
  output: z.object({ runId: z.string().required() }),
}
function activeRevision(ctx: Context, automationId: string) {
  const automation = ctx.automations.get(automationId)
  if (!automation) throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found.')
  if (automation.archivedAt) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVED', 'Restore this Automation before starting a new Run.')
  if (!automation.activeRevisionId) throw new ConsoleProcedureError(409, 'AUTOMATION_NOT_ACTIVE', 'Publish and activate a Revision before starting a Run.')
  return ctx.automations.getRevision(automation.activeRevisionId)!
}
export function provideManualRuns(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchManualRunFormQueryRef, {
    query({ input }: { input: { automationId: string } }): WorkbenchManualRunForm {
      const revision = activeRevision(ctx, input.automationId)
      return { automationId: input.automationId, revisionId: revision.id, revisionNumber: revision.number,
        ...(revision.source.inputs !== undefined ? { inputs: revision.source.inputs } : {}),
      }
    },
  })
  ctx.console.provideAction(ctx, workbenchStartManualRunActionRef, {
    action({ input }: { input: WorkbenchStartManualRunInput }): WorkbenchStartManualRunResult {
      const automation = ctx.automations.get(input.automationId)
      if (!automation) throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found.')
      // Let Scheduler resolve an accepted requestId before rejecting a retry for an archived Automation.
      if (!automation.archivedAt && !automation.activeRevisionId) throw new ConsoleProcedureError(409, 'AUTOMATION_NOT_ACTIVE', 'Publish and activate a Revision before starting a Run.')
      try {
        const run = ctx.scheduler.startManual(input.automationId, input.input, { type: 'manual' }, input.expectedRevisionId, input.requestId)
        return { runId: run.id }
      } catch (error) {
        if (error instanceof AutomationArchivedError) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVED', 'Restore this Automation before starting a new Run.')
        if (error instanceof ManualRunRequestConflictError) throw new ConsoleProcedureError(409, 'MANUAL_RUN_REQUEST_CONFLICT', error.message)
        if (error instanceof ManualRunRevisionConflictError) throw new ConsoleProcedureError(409, 'MANUAL_RUN_REVISION_CONFLICT', error.message)
        if (error instanceof AutomationInputValidationError) throw new ConsoleProcedureError(422, 'AUTOMATION_INPUT_INVALID', error.message, { issues: error.issues })
        throw error
      }
    },
  })
}
