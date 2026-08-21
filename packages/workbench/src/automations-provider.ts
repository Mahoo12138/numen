import '@numen/automation'
import type { ConsoleQueryDefinition } from '@numen/console'
import type { AutomationSource, NumenValue } from '@numen/core'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  workbenchAutomationDetailQueryRef,
  workbenchAutomationsIndexQueryRef,
  type WorkbenchAutomationDetail,
  type WorkbenchAutomationDetailQueryInput,
  type WorkbenchAutomationsIndex,
} from './contracts.js'

const automationIdentity = {
  id: z.string().required(),
  name: z.string().required(),
  enabled: z.boolean().required(),
  activeRevisionId: z.string(),
  activationGeneration: z.number().required(),
  createdAt: z.string().required(),
  updatedAt: z.string().required(),
}

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
      ...automationIdentity,
      draftVersion: z.number().required(),
      revisionCount: z.number().required(),
      latestRevisionNumber: z.number(),
    })).required(),
  }),
}

const automationDetail = z.object({
  automation: z.object(automationIdentity).required(),
  draft: z.object({
    baseRevisionId: z.string(),
    source: z.any<AutomationSource>().required(),
    presentation: z.any<Record<string, NumenValue>>().required(),
    version: z.number().required(),
    updatedAt: z.string().required(),
  }).required(),
  revisions: z.array(z.object({
    id: z.string().required(),
    number: z.number().required(),
    contentHash: z.string().required(),
    active: z.boolean().required(),
    createdAt: z.string().required(),
  })).required(),
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
    automationId: z.string().pattern(/^auto_[a-f0-9]{32}$/).required(),
  }),
  output: z.union([automationDetail, z.const(null)]).required(),
}

export function workbenchAutomationsProviderPlugin(ctx: Context): void {
  ctx.console.provideQuery(ctx, workbenchAutomationsIndexQueryRef, {
    query(): WorkbenchAutomationsIndex {
      const items = ctx.automations.listSummaries()
      return {
        summary: {
          total: items.length,
          enabled: items.filter(item => item.enabled).length,
          published: items.filter(item => !!item.activeRevisionId).length,
        },
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
