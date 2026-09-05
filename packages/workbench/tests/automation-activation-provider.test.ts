import { AutomationService } from '@numen/automation'
import { CapabilityRegistry } from '@numen/core'
import { DatabaseService } from '@numen/database'
import { ConsoleService, type ConsoleRequestContext } from '@numen/console'
import { Context, type Logger } from 'cordis'
import { describe, expect, it } from 'vitest'
import { workbenchAutomationActivationProviderPlugin, workbenchActivateAutomationRevisionAction, workbenchSetAutomationEnabledAction } from '../src/automation-activation-provider.js'

const request = (): ConsoleRequestContext => ({
  requestId: 'activation-request', principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
  signal: new AbortController().signal, logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger,
})

describe('Automation activation Provider', () => {
  it('keeps publish, activate, and enable separate and exposes safe generation conflicts', async () => {
    const root = new Context()
    try {
      await root.plugin(DatabaseService, { path: ':memory:' })
      await root.plugin(CapabilityRegistry)
      await root.plugin(AutomationService)
      await root.plugin(ConsoleService)
      root.console.define(root, workbenchActivateAutomationRevisionAction)
      root.console.define(root, workbenchSetAutomationEnabledAction)
      const plugin = (ctx: Context) => workbenchAutomationActivationProviderPlugin(ctx)
      plugin.inject = ['console', 'automations']
      const fiber = await root.plugin(plugin)
      const { automation } = root.automations.create({ name: 'Activation test' })
      const revision = root.automations.publishDraft(automation.id, 1)
      expect(root.automations.get(automation.id)).toMatchObject({ enabled: false, activationGeneration: 0 })
      const activated = await root.console.action(workbenchActivateAutomationRevisionAction, {
        automationId: automation.id, revisionId: revision.id, expectedActivationGeneration: 0,
      }, request())
      expect(activated.automation).toMatchObject({ enabled: false, activeRevisionId: revision.id, activationGeneration: 1 })
      await expect(root.console.action(workbenchSetAutomationEnabledAction, {
        automationId: automation.id, enabled: true, expectedActivationGeneration: 0,
      }, request())).rejects.toMatchObject({ status: 409, code: 'AUTOMATION_ACTIVATION_CONFLICT', details: {
        expectedActivationGeneration: 0, actualActivationGeneration: 1,
      } })
      const enabled = await root.console.action(workbenchSetAutomationEnabledAction, {
        automationId: automation.id, enabled: true, expectedActivationGeneration: 1,
      }, request())
      expect(enabled.automation).toMatchObject({ enabled: true, activeRevisionId: revision.id, activationGeneration: 2 })
      const secondRevision = root.automations.publishDraft(automation.id, 1)
      expect(root.automations.get(automation.id)).toEqual(enabled.automation)
      const switched = await root.console.action(workbenchActivateAutomationRevisionAction, {
        automationId: automation.id, revisionId: secondRevision.id, expectedActivationGeneration: 2,
      }, request())
      expect(switched.automation).toMatchObject({ enabled: true, activeRevisionId: secondRevision.id, activationGeneration: 3 })
      await expect(root.console.action(workbenchActivateAutomationRevisionAction, {
        automationId: automation.id, revisionId: revision.id, expectedActivationGeneration: 2,
      }, request())).rejects.toMatchObject({ code: 'AUTOMATION_ACTIVATION_CONFLICT' })
      const other = root.automations.create({ name: 'Other' }).automation
      await expect(root.console.action(workbenchActivateAutomationRevisionAction, {
        automationId: other.id, revisionId: revision.id, expectedActivationGeneration: 0,
      }, request())).rejects.toMatchObject({ status: 404, code: 'AUTOMATION_REVISION_NOT_FOUND' })
      await expect(root.console.action(workbenchSetAutomationEnabledAction, {
        automationId: `auto_${'0'.repeat(32)}`, enabled: false, expectedActivationGeneration: 0,
      }, request())).rejects.toMatchObject({ status: 404, code: 'AUTOMATION_NOT_FOUND' })
      await fiber.dispose()
      for (const ref of [workbenchActivateAutomationRevisionAction, workbenchSetAutomationEnabledAction]) {
        expect(root.console.get(ref)).toMatchObject({ providerAvailable: false })
      }
    } finally { await root.fiber.dispose() }
  })
})
