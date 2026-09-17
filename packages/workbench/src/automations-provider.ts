import '@numen/automation'
import type { ConsoleActionDefinition, ConsoleQueryDefinition } from '@numen/console'
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
  workbenchCreateAutomationActionRef,
  type WorkbenchAutomationDetail,
  type WorkbenchAutomationDetailQueryInput,
  type WorkbenchAutomationIndexItem,
  type WorkbenchAutomationsIndex,
  type WorkbenchCreateAutomationInput,
  type WorkbenchCreateAutomationResult,
} from './contracts.js'

export const workbenchAutomationsIndexQuery: ConsoleQueryDefinition<
  Record<string, unknown>,
  WorkbenchAutomationsIndex
> = {
  ...workbenchAutomationsIndexQueryRef,
  kind: 'query',
  title: 'Workbench Automations index',
  description: 'Lightweight Automation, Draft, and Revision summaries for the primary Sidebar.',
  input: z.object({}),
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
    })).required(),
  }),
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
    query(): WorkbenchAutomationsIndex {
      const items = ctx.automations.listSummaries()
      return {
        summary: summarizeAutomationIndex(items),
        items,
      }
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
