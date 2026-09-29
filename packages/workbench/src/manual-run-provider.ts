import { AutomationArchivedError, AutomationNotFoundError, AutomationRevisionNotFoundError } from '@numenjs/automation'
import { ConsoleProcedureError, type ConsoleActionDefinition, type ConsoleQueryDefinition } from '@numenjs/console'
import { AutomationInputValidationError, isNumenValue } from '@numenjs/core'
import { ManualRunRequestConflictError, ManualRunRevisionConflictError } from '@numenjs/scheduler'
import type { Context } from 'cordis'
import z from 'schemastery'
import { automationIdSchema } from './automation-schemas.js'
import { workbenchManualRunFormQueryRef, workbenchStartManualRunActionRef, type WorkbenchManualRunForm, type WorkbenchManualRunFormInput, type WorkbenchStartManualRunInput, type WorkbenchStartManualRunResult } from './contracts.js'

const revisionIdSchema = z.string().pattern(/^rev_[a-f0-9]{32}$/)
const modeSchema = z.union(['manual', 'revision-test']).required()
export const workbenchManualRunFormQuery: ConsoleQueryDefinition<WorkbenchManualRunFormInput, WorkbenchManualRunForm> = {
  ...workbenchManualRunFormQueryRef, kind: 'query', title: 'Run parameters for a published Revision',
  input: z.object({ automationId: automationIdSchema, mode: modeSchema, revisionId: revisionIdSchema }),
  output: z.object({ automationId: z.string().required(), mode: modeSchema, revisionId: z.string().required(), revisionNumber: z.number().required(), inputs: z.any(), revisions: z.array(z.object({ id: z.string().required(), number: z.number().required(), active: z.boolean().required() })).required() }),
}
export const workbenchStartManualRunAction: ConsoleActionDefinition<WorkbenchStartManualRunInput, WorkbenchStartManualRunResult> = {
  ...workbenchStartManualRunActionRef, kind: 'action', title: 'Start Run from a published Revision',
  input: z.object({
    automationId: automationIdSchema,
    requestId: z.string().pattern(/^[a-zA-Z0-9_-]{16,80}$/).required(),
    mode: modeSchema,
    revisionId: revisionIdSchema.required(),
    input: z.any().required(),
    // Presence and NumenValue are checked below so an explicit JSON null remains valid.
    trigger: z.any(),
  }),
  output: z.object({ runId: z.string().required() }),
}

export function provideManualRuns(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchManualRunFormQueryRef, {
    query({ input }: { input: WorkbenchManualRunFormInput }): WorkbenchManualRunForm {
      const automation = ctx.automations.get(input.automationId)
      if (!automation) throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found.')
      if (automation.archivedAt) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVED', 'Restore this Automation before starting a new Run.')
      const revisions = ctx.automations.listRevisions(automation.id)
      const revisionId = input.mode === 'manual' ? automation.activeRevisionId : input.revisionId ?? revisions[0]?.id
      if (!revisionId) throw new ConsoleProcedureError(409, input.mode === 'manual' ? 'AUTOMATION_NOT_ACTIVE' : 'AUTOMATION_NO_REVISIONS', input.mode === 'manual' ? 'Activate a published Revision before running the active version.' : 'Publish a Revision before starting a test Run.')
      const revision = revisions.find(item => item.id === revisionId)
      if (!revision) throw new ConsoleProcedureError(404, 'AUTOMATION_REVISION_NOT_FOUND', 'The selected Revision does not belong to this Automation.')
      return {
        automationId: automation.id, mode: input.mode, revisionId: revision.id, revisionNumber: revision.number,
        revisions: revisions.map(item => ({ id: item.id, number: item.number, active: item.id === automation.activeRevisionId })),
        ...(revision.source.inputs !== undefined ? { inputs: revision.source.inputs } : {}),
      }
    },
  })
  ctx.console.provideAction(ctx, workbenchStartManualRunActionRef, {
    action({ input }: { input: WorkbenchStartManualRunInput }): WorkbenchStartManualRunResult {
      if (!isNumenValue(input.trigger)) throw new ConsoleProcedureError(422, 'RUN_TRIGGER_INVALID', 'Trigger data must be a JSON value.')
      // Scheduler resolves an accepted requestId before rejecting a retry after activation or archive changes.
      try {
        const run = input.mode === 'revision-test'
          ? ctx.scheduler.startRevisionTest(input.automationId, input.revisionId, input.input, input.trigger, input.requestId)
          : ctx.scheduler.startManual(input.automationId, input.input, input.trigger, input.revisionId, input.requestId)
        return { runId: run.id }
      } catch (error) {
        if (error instanceof AutomationRevisionNotFoundError) throw new ConsoleProcedureError(404, 'AUTOMATION_REVISION_NOT_FOUND', 'The selected Revision does not belong to this Automation.')
        if (error instanceof AutomationNotFoundError) throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found.')
        if (error instanceof AutomationArchivedError) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVED', 'Restore this Automation before starting a new Run.')
        if (error instanceof ManualRunRequestConflictError) throw new ConsoleProcedureError(409, 'MANUAL_RUN_REQUEST_CONFLICT', error.message)
        if (error instanceof ManualRunRevisionConflictError) throw new ConsoleProcedureError(409, 'MANUAL_RUN_REVISION_CONFLICT', error.message)
        if (error instanceof AutomationInputValidationError) throw new ConsoleProcedureError(422, 'AUTOMATION_INPUT_INVALID', error.message, { issues: error.issues })
        throw error
      }
    },
  })
}
