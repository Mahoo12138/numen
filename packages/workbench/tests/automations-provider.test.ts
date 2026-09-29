import { AutomationService } from '@numenjs/automation'
import { ConsoleService, type ConsoleRequestContext } from '@numenjs/console'
import { CapabilityRegistry } from '@numenjs/core'
import { DatabaseService } from '@numenjs/database'
import { Context, Service, type Logger } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  workbenchAutomationDetailQuery,
  workbenchAutomationsIndexQuery,
  workbenchAutomationsProviderPlugin,
  summarizeAutomationIndex,
  workbenchCreateAutomationAction,
  workbenchArchiveAutomationAction,
  workbenchRestoreAutomationAction,
  workbenchRemoveArchivedAutomationAction,
} from '../src/automations-provider.js'
import { workbenchCreateAutomationActionRef, type WorkbenchAutomationIndexItem } from '../src/contracts.js'
import { workbenchAutomationAuthoringProviderPlugin, workbenchSaveAutomationDraftAction, workbenchSaveAutomationDraftCopyAction, workbenchPublishAutomationDraftAction } from '../src/automation-authoring-provider.js'

function item(overrides: Partial<WorkbenchAutomationIndexItem>): WorkbenchAutomationIndexItem {
  return {
    id: 'auto_11111111111111111111111111111111',
    name: 'Automation',
    enabled: false,
    activationGeneration: 0,
    activeRunCount: 0,
    runCount: 0,
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
      for (const definition of [workbenchCreateAutomationAction, workbenchArchiveAutomationAction, workbenchRestoreAutomationAction, workbenchRemoveArchivedAutomationAction, workbenchAutomationsIndexQuery, workbenchAutomationDetailQuery]) {
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

  it('keeps CRUD and Draft authoring available while optional Trigger health loads and unloads', async () => {
    // Only the optional service boundary is stubbed; actual Cordis injection and Console providers run.
    class WorkbenchMarker extends Service {
      constructor(ctx: Context) { super(ctx, 'workbench') }
    }
    class OptionalTriggerHealth extends Service {
      static inject = ['automations']
      constructor(ctx: Context) { super(ctx, 'triggers') }
      automationHealth(automationId: string) {
        const automation = this.ctx.automations.get(automationId)
        return automation && { status: 'DISABLED' as const, expected: 0, active: 0, activationGeneration: automation.activationGeneration }
      }
    }
    const root = new Context()
    try {
      await root.plugin(DatabaseService, { path: ':memory:' })
      await root.plugin(CapabilityRegistry)
      await root.plugin(AutomationService)
      await root.plugin(ConsoleService)
      await root.plugin(WorkbenchMarker)
      const definitions = [workbenchCreateAutomationAction, workbenchArchiveAutomationAction, workbenchRestoreAutomationAction,
        workbenchRemoveArchivedAutomationAction, workbenchAutomationsIndexQuery, workbenchAutomationDetailQuery,
        workbenchSaveAutomationDraftAction, workbenchSaveAutomationDraftCopyAction, workbenchPublishAutomationDraftAction]
      for (const definition of definitions) root.console.define(root, definition)
      // Use the real inject declarations, not a wrapper overriding the dependency contract.
      await root.plugin(workbenchAutomationsProviderPlugin)
      await root.plugin(workbenchAutomationAuthoringProviderPlugin)
      const offline: string[] = []
      const watchedIds = new Set(definitions.map(definition => definition.id))
      root.on('numen/console-procedure-change', ref => {
        if (watchedIds.has(ref.id) && !root.console.get(ref)?.providerAvailable) offline.push(ref.id)
      })
      const created = await root.console.action(workbenchCreateAutomationActionRef, { name: 'Optional Trigger lifecycle' }, request())
      const automationId = created.automation.id
      const detail = () => root.console.query(workbenchAutomationDetailQuery, { automationId }, request())
      expect((await detail())?.triggerRuntime).toBeUndefined()
      const edit = async (expectedVersion: number) => {
        const source = { ...created.draft.source, inputs: { value: { type: 'number' as const, default: expectedVersion } } }
        const result = await root.console.action(workbenchSaveAutomationDraftAction, { automationId, expectedVersion, source, presentation: {} }, request())
        expect(result.draft.version).toBe(expectedVersion + 1)
        expect((await detail())?.draft.source).toEqual(source)
        for (const definition of definitions) expect(root.console.get(definition)?.providerAvailable).toBe(true)
      }
      await edit(1)

      const health = await root.plugin(OptionalTriggerHealth)
      await expect.poll(async () => (await detail())?.triggerRuntime).toEqual({ status: 'DISABLED', expected: 0, active: 0, activationGeneration: 0 })
      await edit(2)
      await health.dispose()
      await expect.poll(async () => (await detail())?.triggerRuntime).toBeUndefined()
      await edit(3)
      expect(offline).toEqual([])

      const other = await root.console.action(workbenchCreateAutomationActionRef, { name: 'CRUD after Trigger unload' }, request())
      const otherId = other.automation.id
      await root.console.action(workbenchArchiveAutomationAction, { automationId: otherId, expectedActivationGeneration: 0 }, request())
      await root.console.action(workbenchRestoreAutomationAction, { automationId: otherId, expectedActivationGeneration: 1 }, request())
      await root.console.action(workbenchArchiveAutomationAction, { automationId: otherId, expectedActivationGeneration: 2 }, request())
      const archivedAt = root.automations.get(otherId)!.archivedAt!
      await root.console.action(workbenchRemoveArchivedAutomationAction, { automationId: otherId, expectedArchivedAt: archivedAt }, request())
      expect(root.automations.get(otherId)).toBeUndefined()
      expect((await root.console.query(workbenchAutomationsIndexQuery, {}, request())).items.map(automation => automation.id)).toEqual([automationId])
      expect(offline).toEqual([])
    } finally { await root.fiber.dispose() }
  })

})
