import {
  AutomationCompileError,
  AutomationNotFoundError,
  DraftConflictError,
} from '@numen/automation'
import { ConsoleProcedureError, type ConsoleActionDefinition } from '@numen/console'
import type { AutomationDraft, AutomationRevision, AutomationSource, NumenValue } from '@numen/core'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  automationDraftSchema,
  automationIdSchema,
  automationRevisionSummarySchema,
} from './automation-schemas.js'
import {
  workbenchPublishAutomationDraftActionRef,
  workbenchSaveAutomationDraftActionRef,
  type WorkbenchAutomationDraft,
  type WorkbenchAutomationRevisionSummary,
  type WorkbenchPublishAutomationDraftInput,
  type WorkbenchPublishAutomationDraftResult,
  type WorkbenchSaveAutomationDraftInput,
  type WorkbenchSaveAutomationDraftResult,
} from './contracts.js'

function projectDraft(draft: AutomationDraft): WorkbenchAutomationDraft {
  return {
    ...(draft.baseRevisionId ? { baseRevisionId: draft.baseRevisionId } : {}),
    source: draft.source,
    presentation: draft.presentation,
    version: draft.version,
    updatedAt: draft.updatedAt,
  }
}

function projectRevision(revision: AutomationRevision): WorkbenchAutomationRevisionSummary {
  return {
    id: revision.id,
    number: revision.number,
    contentHash: revision.contentHash,
    active: false,
    createdAt: revision.createdAt,
  }
}

function raisePublicAutomationError(error: unknown): never {
  if (error instanceof DraftConflictError) {
    throw new ConsoleProcedureError(409, 'DRAFT_VERSION_CONFLICT', 'The Automation Draft changed', {
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    })
  }
  if (error instanceof AutomationNotFoundError) {
    throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found')
  }
  if (error instanceof AutomationCompileError) {
    throw new ConsoleProcedureError(422, 'AUTOMATION_PUBLISH_INVALID', 'The Automation Draft cannot be published', {
      diagnostics: error.diagnostics,
    })
  }
  throw error
}

export const workbenchSaveAutomationDraftAction: ConsoleActionDefinition<
  WorkbenchSaveAutomationDraftInput,
  WorkbenchSaveAutomationDraftResult
> = {
  ...workbenchSaveAutomationDraftActionRef,
  kind: 'action',
  title: 'Save Automation Draft',
  description: 'Optimistically persist the complete mutable Source and presentation document.',
  input: z.object({
    automationId: automationIdSchema,
    expectedVersion: z.number().step(1).min(1).required(),
    source: z.any<AutomationSource>().required(),
    presentation: z.any<Record<string, NumenValue>>().required(),
  }),
  output: z.object({
    draft: automationDraftSchema.required(),
  }),
}

export const workbenchPublishAutomationDraftAction: ConsoleActionDefinition<
  WorkbenchPublishAutomationDraftInput,
  WorkbenchPublishAutomationDraftResult
> = {
  ...workbenchPublishAutomationDraftActionRef,
  kind: 'action',
  title: 'Publish Automation Draft',
  description: 'Validate and compile the current Draft into a new immutable Revision without activating it.',
  input: z.object({
    automationId: automationIdSchema,
    expectedVersion: z.number().step(1).min(1).required(),
  }),
  output: z.object({
    draft: automationDraftSchema.required(),
    revision: automationRevisionSummarySchema.required(),
  }),
}

export function workbenchAutomationAuthoringProviderPlugin(ctx: Context): void {
  ctx.console.provideAction(ctx, workbenchSaveAutomationDraftActionRef, {
    action({ input }: { input: WorkbenchSaveAutomationDraftInput }): WorkbenchSaveAutomationDraftResult {
      try {
        return {
          draft: projectDraft(ctx.automations.saveDraft({
            automationId: input.automationId,
            expectedVersion: input.expectedVersion,
            source: input.source,
            presentation: input.presentation,
          })),
        }
      } catch (error) {
        return raisePublicAutomationError(error)
      }
    },
  })
  ctx.console.provideAction(ctx, workbenchPublishAutomationDraftActionRef, {
    action({ input }: { input: WorkbenchPublishAutomationDraftInput }): WorkbenchPublishAutomationDraftResult {
      try {
        const revision = ctx.automations.publishDraft(input.automationId, input.expectedVersion)
        const draft = ctx.automations.getDraft(input.automationId)
        if (!draft) throw new AutomationNotFoundError(`automation not found: ${input.automationId}`)
        return {
          draft: projectDraft(draft),
          revision: projectRevision(revision),
        }
      } catch (error) {
        return raisePublicAutomationError(error)
      }
    },
  })
}

workbenchAutomationAuthoringProviderPlugin.inject = ['workbench', 'console', 'automations']

export default workbenchAutomationAuthoringProviderPlugin
