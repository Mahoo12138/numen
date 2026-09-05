import { onScopeDispose, shallowReactive, toValue, type MaybeRefOrGetter } from 'vue'
import {
  workbenchActivateAutomationRevisionActionRef,
  workbenchSetAutomationEnabledActionRef,
  type WorkbenchAutomationIdentity,
  type WorkbenchAutomationActivationResult,
  type WorkbenchActivateAutomationRevisionInput,
  type WorkbenchSetAutomationEnabledInput,
} from './contracts.js'
import type { WorkbenchConsoleClient } from './types.js'

type ActivationIntent = { type: 'activate'; revisionId: string } | { type: 'enabled'; enabled: boolean }
interface Mutation {
  pending: boolean
  intent: ActivationIntent
  confirmed?: WorkbenchAutomationIdentity
  error?: string
}
export interface AutomationActivationView {
  automation: WorkbenchAutomationIdentity
  pending: boolean
  activatingRevisionId?: string
  error?: string
}
export interface AutomationActivation {
  view(automation: WorkbenchAutomationIdentity): AutomationActivationView
  activate(automation: WorkbenchAutomationIdentity, revisionId: string): void
  setEnabled(automation: WorkbenchAutomationIdentity, enabled: boolean): void
  dispose(): void
}

function activationError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'AUTOMATION_ACTIVATION_CONFLICT') return 'Activation changed elsewhere. Review the refreshed state before trying again.'
  if (code === 'AUTOMATION_REVISION_NOT_FOUND') return 'That Revision is unavailable. Refresh the Revision list and choose again.'
  if (code === 'AUTOMATION_NOT_FOUND') return 'This Automation no longer exists.'
  return 'The activation request failed. Review the refreshed state before trying again.'
}

export function createAutomationActivation(
  client: MaybeRefOrGetter<WorkbenchConsoleClient | undefined>,
  refresh: () => void,
): AutomationActivation {
  const mutations = shallowReactive(new Map<string, Mutation>())
  const controllers = new Map<string, AbortController>()
  let disposed = false
  const effective = (automation: WorkbenchAutomationIdentity) => {
    const confirmed = mutations.get(automation.id)?.confirmed
    return confirmed && confirmed.activationGeneration > automation.activationGeneration ? confirmed : automation
  }
  const mutate = (automation: WorkbenchAutomationIdentity, intent: ActivationIntent) => {
    const resolvedClient = toValue(client)
    if (disposed || !resolvedClient || mutations.get(automation.id)?.pending) return
    const current = effective(automation)
    if (intent.type === 'activate' ? current.activeRevisionId === intent.revisionId : current.enabled === intent.enabled) return
    const controller = new AbortController()
    controllers.set(automation.id, controller)
    mutations.set(automation.id, { pending: true, intent, confirmed: current })
    const identity = { automationId: current.id, expectedActivationGeneration: current.activationGeneration }
    const request = intent.type === 'activate'
      ? resolvedClient.action<WorkbenchActivateAutomationRevisionInput, WorkbenchAutomationActivationResult>(
          workbenchActivateAutomationRevisionActionRef, { ...identity, revisionId: intent.revisionId }, controller.signal,
        )
      : resolvedClient.action<WorkbenchSetAutomationEnabledInput, WorkbenchAutomationActivationResult>(
          workbenchSetAutomationEnabledActionRef, { ...identity, enabled: intent.enabled }, controller.signal,
        )
    void request.then(result => {
      if (disposed || controller.signal.aborted) return
      mutations.set(automation.id, { pending: false, intent, confirmed: result.automation })
      refresh()
    }, error => {
      if (disposed || controller.signal.aborted) return
      mutations.set(automation.id, { pending: false, intent, confirmed: current, error: activationError(error) })
      refresh()
    }).finally(() => {
      if (controllers.get(automation.id) === controller) controllers.delete(automation.id)
    })
  }
  return {
    view(automation) {
      const mutation = mutations.get(automation.id)
      return {
        automation: effective(automation), pending: !!mutation?.pending,
        ...(mutation?.pending && mutation.intent.type === 'activate' ? { activatingRevisionId: mutation.intent.revisionId } : {}),
        ...(mutation?.error ? { error: mutation.error } : {}),
      }
    },
    activate: (automation, revisionId) => mutate(automation, { type: 'activate', revisionId }),
    setEnabled: (automation, enabled) => mutate(automation, { type: 'enabled', enabled }),
    dispose() {
      disposed = true
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      mutations.clear()
    },
  }
}

export function useAutomationActivation(
  client: MaybeRefOrGetter<WorkbenchConsoleClient | undefined>,
  refresh: () => void,
): AutomationActivation {
  const activation = createAutomationActivation(client, refresh)
  onScopeDispose(activation.dispose)
  return activation
}
