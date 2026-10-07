import { AutomationArchivedError, AutomationCompileError, AutomationNotFoundError, AutomationRevisionNotFoundError, DraftConflictError } from '@numenjs/automation'
import { ConsoleProcedureError, type ConsoleActionDefinition, type ConsoleQueryDefinition } from '@numenjs/console'
import { AutomationInputValidationError, isNumenValue } from '@numenjs/core'
import { DraftTestResourceUnavailableError, ManualRunRequestConflictError, ManualRunRevisionConflictError } from '@numenjs/scheduler'
import type { Context } from 'cordis'
import z from 'schemastery'
import { automationIdSchema } from './automation-schemas.js'
import { workbenchManualRunFormQueryRef, workbenchStartManualRunActionRef, type WorkbenchManualRunForm, type WorkbenchManualRunFormInput, type WorkbenchStartManualRunInput, type WorkbenchStartManualRunResult } from './contracts.js'

const revisionIdSchema = z.string().pattern(/^rev_[a-f0-9]{32}$/)
const publishedModeSchema = z.union(['manual', 'revision-test']).required()
const draftVersionSchema = z.number().step(1).min(1).required()
export const workbenchManualRunFormQuery: ConsoleQueryDefinition<WorkbenchManualRunFormInput, WorkbenchManualRunForm> = {
  ...workbenchManualRunFormQueryRef, kind: 'query', title: 'Run parameters for a fixed version',
  input: z.union([
    z.object({ automationId: automationIdSchema, mode: publishedModeSchema, revisionId: revisionIdSchema }),
    z.object({ automationId: automationIdSchema, mode: z.const('draft-test').required(), expectedDraftVersion: draftVersionSchema }),
  ]),
  output: z.union([
    z.object({ automationId: z.string().required(), mode: publishedModeSchema, revisionId: z.string().required(), revisionNumber: z.number().required(), inputs: z.any(), revisions: z.array(z.object({ id: z.string().required(), number: z.number().required(), active: z.boolean().required() })).required() }),
    z.object({ automationId: z.string().required(), mode: z.const('draft-test').required(), draftVersion: draftVersionSchema, inputs: z.any() }),
  ]),
}
export const workbenchStartManualRunAction: ConsoleActionDefinition<WorkbenchStartManualRunInput, WorkbenchStartManualRunResult> = {
  ...workbenchStartManualRunActionRef, kind: 'action', title: 'Start Run from a fixed version',
  input: z.union([z.object({
    automationId: automationIdSchema,
    requestId: z.string().pattern(/^[a-zA-Z0-9_-]{16,80}$/).required(),
    mode: publishedModeSchema,
    revisionId: revisionIdSchema.required(),
    input: z.any().required(),
    // Presence and NumenValue are checked below so an explicit JSON null remains valid.
    trigger: z.any(),
  }), z.object({
    automationId: automationIdSchema,
    requestId: z.string().pattern(/^[a-zA-Z0-9_-]{16,80}$/).required(),
    mode: z.const('draft-test').required(), expectedDraftVersion: draftVersionSchema,
    input: z.any().required(), trigger: z.any(),
  })]),
  output: z.object({ runId: z.string().required(), snapshotId: z.string(), sourceDraftVersion: z.number().step(1).min(1) }),
}

export function provideManualRuns(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchManualRunFormQueryRef, {
    query({ input }: { input: WorkbenchManualRunFormInput }): WorkbenchManualRunForm {
      const automation = ctx.automations.get(input.automationId)
      if (!automation) throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found.')
      if (automation.archivedAt) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVED', 'Restore this Automation before starting a new Run.')
      if (input.mode === 'draft-test') {
        const draft = ctx.automations.getDraft(automation.id)!
        if (draft.version !== input.expectedDraftVersion) throw new ConsoleProcedureError(409, 'DRAFT_VERSION_CONFLICT', 'The Automation Draft changed', { expectedVersion: input.expectedDraftVersion, actualVersion: draft.version })
        return { automationId: automation.id, mode: 'draft-test', draftVersion: draft.version, ...(draft.source.inputs !== undefined ? { inputs: draft.source.inputs } : {}) }
      }
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
    async action({ input }: { input: WorkbenchStartManualRunInput }): Promise<WorkbenchStartManualRunResult> {
      if (!isNumenValue(input.trigger)) throw new ConsoleProcedureError(422, 'RUN_TRIGGER_INVALID', 'Trigger data must be a JSON value.')
      // Scheduler resolves an accepted requestId before rejecting a retry after activation or archive changes.
      try {
        if (input.mode === 'draft-test') {
          const run = await ctx.scheduler.startDraftTest(input.automationId, input.expectedDraftVersion, input.input, input.trigger, input.requestId)
          const snapshot = ctx.automations.getExecutionSnapshot(run.revisionId)
          if (snapshot?.purpose !== 'draft-test') throw new Error('Draft test result has no snapshot')
          return { runId: run.id, snapshotId: snapshot.id, sourceDraftVersion: snapshot.sourceDraftVersion }
        }
        const run = input.mode === 'revision-test'
          ? ctx.scheduler.startRevisionTest(input.automationId, input.revisionId, input.input, input.trigger, input.requestId)
          : ctx.scheduler.startManual(input.automationId, input.input, input.trigger, input.revisionId, input.requestId)
        return { runId: run.id }
      } catch (error) {
        if (error instanceof DraftConflictError) throw new ConsoleProcedureError(409, 'DRAFT_VERSION_CONFLICT', 'The Automation Draft changed', { expectedVersion: error.expectedVersion, actualVersion: error.actualVersion })
        if (error instanceof AutomationCompileError) throw new ConsoleProcedureError(422, 'AUTOMATION_DRAFT_TEST_INVALID', 'The Draft cannot be tested.', {
          diagnostics: error.diagnostics.map(diagnostic => ({ ...diagnostic,
            // Schema exceptions can contain raw literal/config values. Keep the location,
            // code and severity without transporting the exception's value echo.
            message: diagnostic.code === 'INPUT_SCHEMA_INVALID' ? 'The input does not match the Capability schema.'
              : diagnostic.code === 'TRIGGER_SCHEMA_INVALID' ? 'The Trigger configuration does not match its schema.' : diagnostic.message,
          })),
        })
        if (error instanceof AutomationRevisionNotFoundError) throw new ConsoleProcedureError(404, 'AUTOMATION_REVISION_NOT_FOUND', 'The selected Revision does not belong to this Automation.')
        if (error instanceof AutomationNotFoundError) throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found.')
        if (error instanceof AutomationArchivedError) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVED', 'Restore this Automation before starting a new Run.')
        if (error instanceof ManualRunRequestConflictError) throw new ConsoleProcedureError(409, 'MANUAL_RUN_REQUEST_CONFLICT', error.message)
        if (error instanceof ManualRunRevisionConflictError) throw new ConsoleProcedureError(409, 'MANUAL_RUN_REVISION_CONFLICT', error.message)
        if (error instanceof AutomationInputValidationError) throw new ConsoleProcedureError(422, 'AUTOMATION_INPUT_INVALID', error.message, { issues: error.issues })
        if (error instanceof DraftTestResourceUnavailableError) throw new ConsoleProcedureError(422, 'RUN_RESOURCE_UNAVAILABLE', 'A referenced resource is unavailable.')
        if (error instanceof TypeError) throw new ConsoleProcedureError(422, 'RUN_DATA_INVALID', 'Run data or resource references are invalid.')
        throw error
      }
    },
  })
}
