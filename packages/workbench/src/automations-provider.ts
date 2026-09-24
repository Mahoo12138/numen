import '@numenjs/automation'
import {
  AutomationActivationConflictError,
  AutomationArchivedError,
  AutomationHasActiveRunsError,
  AutomationNotFoundError,
  AutomationPurgeConflictError,
} from '@numenjs/automation'
import { ConsoleProcedureError, type ConsoleActionDefinition, type ConsoleQueryDefinition } from '@numenjs/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  automationDraftSchema,
  automationIdSchema,
  automationIdentityFields,
  automationRevisionSummarySchema,
} from './automation-schemas.js'
import {
  workbenchAutomationDetailQueryRef,
  workbenchAutomationsIndexQueryRef,
  workbenchArchiveAutomationActionRef,
  workbenchCreateAutomationActionRef,
  workbenchRemoveArchivedAutomationActionRef,
  workbenchRestoreAutomationActionRef,
  type WorkbenchAutomationDetail,
  type WorkbenchAutomationDetailQueryInput,
  type WorkbenchAutomationIndexItem,
  type WorkbenchAutomationsIndex,
  type WorkbenchAutomationsIndexInput,
  type WorkbenchArchiveAutomationInput,
  type WorkbenchAutomationMutationResult,
  type WorkbenchRemoveArchivedAutomationInput,
  type WorkbenchRemoveArchivedAutomationResult,
  type WorkbenchRestoreAutomationInput,
  type WorkbenchCreateAutomationInput,
  type WorkbenchCreateAutomationResult,
} from './contracts.js'

export const workbenchAutomationsIndexQuery: ConsoleQueryDefinition<
  WorkbenchAutomationsIndexInput,
  WorkbenchAutomationsIndex
> = {
  ...workbenchAutomationsIndexQueryRef,
  kind: 'query',
  title: 'Workbench Automations index',
  description: 'Lightweight Automation, Draft, and Revision summaries for the primary Sidebar.',
  input: z.object({ archived: z.boolean() }),
  output: z.object({
    summary: z.object({
      total: z.number().required(),
      enabled: z.number().required(),
      published: z.number().required(),
    }).required(),
    items: z.array(z.object({
      ...automationIdentityFields,
      draftVersion: z.number().required(),
      revisionCount: z.number().required(),
      latestRevisionNumber: z.number(),
      activeRunCount: z.number().required(),
      runCount: z.number().required(),
    })).required(),
  }),
}

const archiveInput = z.object({ automationId: automationIdSchema, expectedActivationGeneration: z.number().step(1).min(0).required() })
const mutationOutput = z.object({ automationId: automationIdSchema.required() })
const archiveAction = (ref: typeof workbenchArchiveAutomationActionRef | typeof workbenchRestoreAutomationActionRef, title: string): ConsoleActionDefinition<WorkbenchArchiveAutomationInput, WorkbenchAutomationMutationResult> => ({
  ...ref, kind: 'action', title,
  input: archiveInput,
  output: mutationOutput,
})

export const workbenchArchiveAutomationAction = archiveAction(workbenchArchiveAutomationActionRef, 'Archive Automation')
export const workbenchRestoreAutomationAction = archiveAction(workbenchRestoreAutomationActionRef, 'Restore Automation')
export const workbenchRemoveArchivedAutomationAction: ConsoleActionDefinition<WorkbenchRemoveArchivedAutomationInput, WorkbenchRemoveArchivedAutomationResult> = {
  ...workbenchRemoveArchivedAutomationActionRef, kind: 'action', title: 'Permanently remove archived Automation',
  input: z.object({ automationId: automationIdSchema, expectedArchivedAt: z.string().required() }),
  output: z.object({ automationId: automationIdSchema.required(), removedRuns: z.number().step(1).min(0).required() }),
}

function publicAutomationLifecycleError(error: unknown): never {
  if (error instanceof AutomationActivationConflictError) throw new ConsoleProcedureError(409, 'AUTOMATION_ACTIVATION_CONFLICT', 'The Automation changed; reload and try again.')
  if (error instanceof AutomationPurgeConflictError) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVE_CONFLICT', 'The archived Automation changed; reload and try again.')
  if (error instanceof AutomationHasActiveRunsError) throw new ConsoleProcedureError(409, 'AUTOMATION_HAS_ACTIVE_RUNS', 'Wait for or cancel active Runs before permanently removing this Automation.', { count: error.count })
  if (error instanceof AutomationArchivedError) throw new ConsoleProcedureError(409, 'AUTOMATION_ARCHIVED', 'Restore this Automation before editing or starting new Runs.')
  if (error instanceof AutomationNotFoundError) throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found.')
  throw error
}

const automationDetail = z.object({
  automation: z.object(automationIdentityFields).required(),
  draft: automationDraftSchema.required(),
  revisions: z.array(automationRevisionSummarySchema).required(),
})

export const workbenchAutomationDetailQuery: ConsoleQueryDefinition<
  WorkbenchAutomationDetailQueryInput,
  WorkbenchAutomationDetail | null
> = {
  ...workbenchAutomationDetailQueryRef,
  kind: 'query',
  title: 'Workbench Automation detail',
  description: 'The current mutable Draft Source and immutable Revision metadata for one Automation.',
  input: z.object({
    automationId: automationIdSchema,
  }),
  output: z.union([automationDetail, z.const(null)]).required(),
}

export const workbenchCreateAutomationAction: ConsoleActionDefinition<
  WorkbenchCreateAutomationInput,
  WorkbenchCreateAutomationResult
> = {
  ...workbenchCreateAutomationActionRef,
  kind: 'action',
  title: 'Create Automation',
  description: 'Create a disabled Automation with an empty mutable Draft.',
  input: z.object({
    name: z.string().min(1).max(200).pattern(/\S/).required(),
  }),
  output: z.object({
    automation: z.object(automationIdentityFields).required(),
    draft: automationDraftSchema.required(),
  }),
}

export function summarizeAutomationIndex(
  items: WorkbenchAutomationIndexItem[],
): WorkbenchAutomationsIndex['summary'] {
  return {
    total: items.length,
    enabled: items.filter(item => item.enabled).length,
    published: items.filter(item => item.revisionCount > 0).length,
  }
}

export function workbenchAutomationsProviderPlugin(ctx: Context): void {
  ctx.console.provideAction(ctx, workbenchCreateAutomationActionRef, {
    action({ input }: { input: WorkbenchCreateAutomationInput }): WorkbenchCreateAutomationResult {
      return ctx.automations.create({ name: input.name })
    },
  })
  ctx.console.provideQuery(ctx, workbenchAutomationsIndexQueryRef, {
    query({ input }: { input: WorkbenchAutomationsIndexInput }): WorkbenchAutomationsIndex {
      const items = ctx.automations.listSummaries(input.archived ?? false)
      return {
        summary: summarizeAutomationIndex(items),
        items,
      }
    },
  })
  ctx.console.provideAction(ctx, workbenchArchiveAutomationActionRef, {
    action({ input }: { input: WorkbenchArchiveAutomationInput }): WorkbenchAutomationMutationResult {
      try { ctx.automations.archive(input.automationId, input.expectedActivationGeneration); return { automationId: input.automationId } }
      catch (error) { return publicAutomationLifecycleError(error) }
    },
  })
  ctx.console.provideAction(ctx, workbenchRestoreAutomationActionRef, {
    action({ input }: { input: WorkbenchRestoreAutomationInput }): WorkbenchAutomationMutationResult {
      try { ctx.automations.restoreArchive(input.automationId, input.expectedActivationGeneration); return { automationId: input.automationId } }
      catch (error) { return publicAutomationLifecycleError(error) }
    },
  })
  ctx.console.provideAction(ctx, workbenchRemoveArchivedAutomationActionRef, {
    action({ input }: { input: WorkbenchRemoveArchivedAutomationInput }): WorkbenchRemoveArchivedAutomationResult {
      try {
        const result = ctx.automations.removeArchived(input.automationId, input.expectedArchivedAt)
        return { automationId: result.automationId, removedRuns: result.runCount }
      } catch (error) { return publicAutomationLifecycleError(error) }
    },
  })
  ctx.console.provideQuery(ctx, workbenchAutomationDetailQueryRef, {
    query({ input }: { input: WorkbenchAutomationDetailQueryInput }): WorkbenchAutomationDetail | null {
      const automation = ctx.automations.get(input.automationId)
      const draft = ctx.automations.getDraft(input.automationId)
      if (!automation || !draft) return null
      return {
        automation,
        draft,
        revisions: ctx.automations.listRevisions(input.automationId).map(revision => ({
          id: revision.id,
          number: revision.number,
          contentHash: revision.contentHash,
          active: automation.activeRevisionId === revision.id,
          createdAt: revision.createdAt,
        })),
      }
    },
  })
}

workbenchAutomationsProviderPlugin.inject = ['workbench', 'console', 'automations']

export default workbenchAutomationsProviderPlugin
