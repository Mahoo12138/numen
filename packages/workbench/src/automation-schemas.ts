import type { AutomationSource, NumenValue } from '@numen/core'
import z from 'schemastery'

export const automationIdSchema = z.string().pattern(/^auto_[a-f0-9]{32}$/).required()

export const automationIdentityFields = {
  id: z.string().required(),
  name: z.string().required(),
  enabled: z.boolean().required(),
  activeRevisionId: z.string(),
  activationGeneration: z.number().required(),
  createdAt: z.string().required(),
  updatedAt: z.string().required(),
}

export const automationDraftSchema = z.object({
  baseRevisionId: z.string(),
  source: z.any<AutomationSource>().required(),
  presentation: z.any<Record<string, NumenValue>>().required(),
  version: z.number().step(1).min(1).required(),
  updatedAt: z.string().required(),
})

export const automationRevisionSummarySchema = z.object({
  id: z.string().required(),
  number: z.number().step(1).min(1).required(),
  contentHash: z.string().required(),
  active: z.boolean().required(),
  createdAt: z.string().required(),
})
