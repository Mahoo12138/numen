import { AutomationService } from '@numen/automation'
import { ConsoleService, type ConsoleRequestContext } from '@numen/console'
import { CapabilityRegistry } from '@numen/core'
import { DatabaseService } from '@numen/database'
import { Context, type Logger } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  workbenchAutomationDetailQuery,
  workbenchAutomationsIndexQuery,
  workbenchAutomationsProviderPlugin,
  summarizeAutomationIndex,
  workbenchCreateAutomationAction,
} from '../src/automations-provider.js'
import { workbenchCreateAutomationActionRef, type WorkbenchAutomationIndexItem } from '../src/contracts.js'

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

const request = (): ConsoleRequestContext => ({
  requestId: 'create-automation-request',
  principal: { subject: { type: 'user', id: 'test' }, authenticated: true },
  signal: new AbortController().signal,
  logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger,
})

describe('Automation index summary', () => {
  it('counts published Revisions independently from activation', () => {
    expect(summarizeAutomationIndex([
      item({ revisionCount: 1 }),
      item({ id: 'auto_22222222222222222222222222222222', enabled: true, revisionCount: 0 }),
    ])).toEqual({ total: 2, enabled: 1, published: 1 })
  })

  it('creates an empty disabled Automation through the Workbench Action', async () => {
    const root = new Context()
    try {
      await root.plugin(DatabaseService, { path: ':memory:' })
      await root.plugin(CapabilityRegistry)
      await root.plugin(AutomationService)
      await root.plugin(ConsoleService)
      for (const definition of [workbenchCreateAutomationAction, workbenchAutomationsIndexQuery, workbenchAutomationDetailQuery]) {
        root.console.define(root, definition)
      }
      const plugin = (ctx: Context) => workbenchAutomationsProviderPlugin(ctx)
      plugin.inject = ['console', 'automations']
      await root.plugin(plugin)

      const result = await root.console.action(workbenchCreateAutomationActionRef, { name: '  First automation  ' }, request())
      expect(result).toMatchObject({
        automation: { name: 'First automation', enabled: false, activationGeneration: 0 },
        draft: { version: 1, source: { triggers: [], flow: { type: 'block', steps: [] } } },
      })
    } finally {
      await root.fiber.dispose()
    }
  })
})
