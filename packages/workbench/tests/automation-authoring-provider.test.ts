import { AutomationService } from '@numen/automation'
import {
  ConsoleProcedureError,
  ConsoleProcedureUnavailableError,
  ConsoleService,
  type ConsoleRequestContext,
} from '@numen/console'
import { CapabilityRegistry, type AutomationSource } from '@numen/core'
import { DatabaseService } from '@numen/database'
import { Context, type Logger } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  workbenchAutomationAuthoringProviderPlugin,
  workbenchPublishAutomationDraftAction,
  workbenchSaveAutomationDraftAction,
} from '../src/automation-authoring-provider.js'

const validSource: AutomationSource = {
  triggers: [],
  flow: { type: 'block', id: 'flow', steps: [] },
}

const invalidSource: AutomationSource = {
  triggers: [],
  flow: {
    type: 'block',
    id: 'flow',
    steps: [{ type: 'wait', id: 'incomplete-wait' }],
  },
}

function request(): ConsoleRequestContext {
  return {
    requestId: 'authoring-request',
    principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
    signal: new AbortController().signal,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as Logger,
  }
}

describe('Automation authoring Provider', () => {
  it('saves incomplete Drafts optimistically and publishes only valid immutable Revisions', async () => {
    const root = new Context()
    await root.plugin(DatabaseService, { path: ':memory:' })
    await root.plugin(CapabilityRegistry)
    await root.plugin(AutomationService)
    await root.plugin(ConsoleService)
    root.console.define(root, workbenchSaveAutomationDraftAction)
    root.console.define(root, workbenchPublishAutomationDraftAction)
    const authoringProvider = (ctx: Context) => workbenchAutomationAuthoringProviderPlugin(ctx)
    authoringProvider.inject = ['console', 'automations']
    const provider = await root.plugin(authoringProvider)
    const created = root.automations.create({ name: 'Authoring test', source: validSource })

    const saved = await root.console.action(workbenchSaveAutomationDraftAction, {
      automationId: created.automation.id,
      expectedVersion: 1,
      source: invalidSource,
      presentation: { viewport: 'wide' },
    }, request())
    expect(saved).toMatchObject({
      draft: { version: 2, source: invalidSource, presentation: { viewport: 'wide' } },
    })

    await expect(root.console.action(workbenchSaveAutomationDraftAction, {
      automationId: created.automation.id,
      expectedVersion: 1,
      source: validSource,
      presentation: {},
    }, request())).rejects.toMatchObject<Partial<ConsoleProcedureError>>({
      status: 409,
      code: 'DRAFT_VERSION_CONFLICT',
      details: { expectedVersion: 1, actualVersion: 2 },
    })

    await expect(root.console.action(workbenchPublishAutomationDraftAction, {
      automationId: created.automation.id,
      expectedVersion: 1,
    }, request())).rejects.toMatchObject<Partial<ConsoleProcedureError>>({
      status: 409,
      code: 'DRAFT_VERSION_CONFLICT',
      details: { expectedVersion: 1, actualVersion: 2 },
    })

    await expect(root.console.action(workbenchPublishAutomationDraftAction, {
      automationId: created.automation.id,
      expectedVersion: 2,
    }, request())).rejects.toMatchObject<Partial<ConsoleProcedureError>>({
      status: 422,
      code: 'AUTOMATION_PUBLISH_INVALID',
      details: {
        diagnostics: [expect.objectContaining({ code: 'WAIT_SOURCE_INVALID' })],
      },
    })

    const repaired = await root.console.action(workbenchSaveAutomationDraftAction, {
      automationId: created.automation.id,
      expectedVersion: 2,
      source: validSource,
      presentation: { viewport: 'wide' },
    }, request())
    const published = await root.console.action(workbenchPublishAutomationDraftAction, {
      automationId: created.automation.id,
      expectedVersion: repaired.draft.version,
    }, request())
    expect(published).toMatchObject({
      draft: { version: 3, baseRevisionId: published.revision.id },
      revision: { number: 1, active: false },
    })
    expect(root.automations.get(created.automation.id)?.activeRevisionId).toBeUndefined()

    await expect(root.console.action(workbenchPublishAutomationDraftAction, {
      automationId: 'auto_00000000000000000000000000000000',
      expectedVersion: 1,
    }, request())).rejects.toMatchObject<Partial<ConsoleProcedureError>>({
      status: 404,
      code: 'AUTOMATION_NOT_FOUND',
    })

    await provider.dispose()
    await expect(root.console.action(workbenchSaveAutomationDraftAction, {
      automationId: created.automation.id,
      expectedVersion: 3,
      source: validSource,
      presentation: {},
    }, request())).rejects.toThrow(ConsoleProcedureUnavailableError)
    await root.fiber.dispose()
  })
})
