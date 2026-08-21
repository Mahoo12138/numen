import { describe, expect, it } from 'vitest'
import { summarizeAutomationIndex } from '../src/automations-provider.js'
import type { WorkbenchAutomationIndexItem } from '../src/contracts.js'

function item(overrides: Partial<WorkbenchAutomationIndexItem>): WorkbenchAutomationIndexItem {
  return {
    id: 'auto_11111111111111111111111111111111',
    name: 'Automation',
    enabled: false,
    activationGeneration: 0,
    draftVersion: 1,
    revisionCount: 0,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  }
}

describe('Automation index summary', () => {
  it('counts published Revisions independently from activation', () => {
    expect(summarizeAutomationIndex([
      item({ revisionCount: 1 }),
      item({ id: 'auto_22222222222222222222222222222222', enabled: true, revisionCount: 0 }),
    ])).toEqual({ total: 2, enabled: 1, published: 1 })
  })
})
