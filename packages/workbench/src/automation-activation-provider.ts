import {
  AutomationActivationConflictError,
  AutomationNotFoundError,
  AutomationRevisionNotFoundError,
} from '@numen/automation'
import { ConsoleProcedureError, type ConsoleActionDefinition } from '@numen/console'
import type { Context } from 'cordis'
import z from 'schemastery'
import { automationIdSchema, automationIdentityFields } from './automation-schemas.js'
import {
  workbenchActivateAutomationRevisionActionRef,
  workbenchSetAutomationEnabledActionRef,
  type WorkbenchActivateAutomationRevisionInput,
  type WorkbenchSetAutomationEnabledInput,
  type WorkbenchAutomationActivationResult,
} from './contracts.js'

const expectedActivationGeneration = z.number().step(1).min(0).required()
const output = z.object({ automation: z.object(automationIdentityFields).required() })

export const workbenchActivateAutomationRevisionAction: ConsoleActionDefinition<
  WorkbenchActivateAutomationRevisionInput, WorkbenchAutomationActivationResult
> = {
  ...workbenchActivateAutomationRevisionActionRef,
  kind: 'action',
  title: 'Activate Automation Revision',
  description: 'Select a published Revision with generation fencing, preserving Automation enabled state.',
  input: z.object({
    automationId: automationIdSchema,
    revisionId: z.string().pattern(/^rev_[a-f0-9]{32}$/).required(),
    expectedActivationGeneration,
  }),
  output,
}

export const workbenchSetAutomationEnabledAction: ConsoleActionDefinition<
  WorkbenchSetAutomationEnabledInput, WorkbenchAutomationActivationResult
> = {
  ...workbenchSetAutomationEnabledActionRef,
  kind: 'action',
  title: 'Set Automation enabled state',
  description: 'Change durable desired state with generation fencing; existing Runs remain unchanged.',
  input: z.object({ automationId: automationIdSchema, enabled: z.boolean().required(), expectedActivationGeneration }),
  output,
}

function publicActivationError(error: unknown): never {
  if (error instanceof AutomationActivationConflictError) {
    throw new ConsoleProcedureError(409, 'AUTOMATION_ACTIVATION_CONFLICT', 'The Automation activation changed.', {
      expectedActivationGeneration: error.expectedGeneration,
      actualActivationGeneration: error.actualGeneration,
    })
  }
  if (error instanceof AutomationRevisionNotFoundError) {
    throw new ConsoleProcedureError(404, 'AUTOMATION_REVISION_NOT_FOUND', 'The Revision does not belong to this Automation or no longer exists.')
  }
  if (error instanceof AutomationNotFoundError) {
    throw new ConsoleProcedureError(404, 'AUTOMATION_NOT_FOUND', 'The Automation was not found.')
  }
  throw error
}

export function workbenchAutomationActivationProviderPlugin(ctx: Context): void {
  ctx.console.provideAction(ctx, workbenchActivateAutomationRevisionActionRef, {
    action({ input }: { input: WorkbenchActivateAutomationRevisionInput }): WorkbenchAutomationActivationResult {
      try {
        return { automation: ctx.automations.activateRevision(input.automationId, input.revisionId, input.expectedActivationGeneration) }
      } catch (error) { return publicActivationError(error) }
    },
  })
  ctx.console.provideAction(ctx, workbenchSetAutomationEnabledActionRef, {
    action({ input }: { input: WorkbenchSetAutomationEnabledInput }): WorkbenchAutomationActivationResult {
      try {
        return { automation: ctx.automations.setEnabled(input.automationId, input.enabled, input.expectedActivationGeneration) }
      } catch (error) { return publicActivationError(error) }
    },
  })
}
workbenchAutomationActivationProviderPlugin.inject = ['workbench', 'console', 'automations']
