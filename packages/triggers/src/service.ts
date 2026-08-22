import '@numen/automation'
import {
  capabilityKey,
  isNumenValue,
  isResourceRef,
  type CapabilityDefinition,
  type TriggerBinding,
  type TriggerEmission,
  type TriggerProvider,
} from '@numen/core'
import '@numen/scheduler'
import { Service, type Context } from 'cordis'

export interface TriggerServiceHealth {
  ready: boolean
  desiredSubscriptions: number
  activeSubscriptions: number
  unavailableSubscriptions: number
}

interface DesiredSubscription {
  key: string
  binding: TriggerBinding
  definition: CapabilityDefinition
  provider?: TriggerProvider
}

interface ActiveSubscription extends DesiredSubscription {
  provider: TriggerProvider
  controller: AbortController
  dispose?: () => void
}

declare module 'cordis' {
  interface Context {
    triggers: TriggerService
  }
}

function subscriptionKey(automationId: string, triggerId: string): string {
  return `${automationId}:${triggerId}`
}

export class TriggerService extends Service {
  static inject = ['automations', 'capabilities', 'scheduler']

  private ready = false
  private desiredSubscriptions = 0
  private unavailableSubscriptions = 0
  private readonly active = new Map<string, ActiveSubscription>()

  constructor(ctx: Context) {
    super(ctx, 'triggers')
  }

  async *[Service.init]() {
    this.ctx.on('numen/automation-change', () => this.reconcile())
    this.ctx.on('numen/capability-change', () => this.reconcile())
    this.ready = true
    this.reconcile()
    yield () => {
      this.ready = false
      for (const subscription of this.active.values()) this.disposeSubscription(subscription)
      this.active.clear()
    }
  }

  health(): TriggerServiceHealth {
    return {
      ready: this.ready,
      desiredSubscriptions: this.desiredSubscriptions,
      activeSubscriptions: this.active.size,
      unavailableSubscriptions: this.unavailableSubscriptions,
    }
  }

  reconcile(): void {
    const desired = this.collectDesiredSubscriptions()
    this.desiredSubscriptions = desired.size

    for (const [key, subscription] of this.active) {
      const next = desired.get(key)
      if (
        !next?.provider
        || next.provider !== subscription.provider
        || next.binding.revisionId !== subscription.binding.revisionId
        || next.binding.activationGeneration !== subscription.binding.activationGeneration
      ) {
        this.disposeSubscription(subscription)
        this.active.delete(key)
      }
    }

    let unavailable = 0
    for (const subscription of desired.values()) {
      if (!subscription.provider) {
        unavailable += 1
        continue
      }
      if (this.active.has(subscription.key)) continue
      try {
        this.active.set(subscription.key, this.activateSubscription({
          ...subscription,
          provider: subscription.provider,
        }))
      } catch {
        unavailable += 1
      }
    }
    this.unavailableSubscriptions = unavailable
  }

  private collectDesiredSubscriptions(): Map<string, DesiredSubscription> {
    const desired = new Map<string, DesiredSubscription>()
    for (const automation of this.ctx.automations.list()) {
      if (!automation.enabled || !automation.activeRevisionId) continue
      const revision = this.ctx.automations.getRevision(automation.activeRevisionId)
      if (!revision) continue
      for (const trigger of revision.source.triggers) {
        const status = this.ctx.capabilities.get(trigger.capability)
        if (!status || status.definition.kind !== 'trigger') continue
        const config = status.definition.input(trigger.config)
        if (
          !isNumenValue(config)
          || !config
          || typeof config !== 'object'
          || Array.isArray(config)
          || isResourceRef(config)
        ) continue
        const binding: TriggerBinding = {
          automationId: automation.id,
          revisionId: revision.id,
          activationGeneration: automation.activationGeneration,
          triggerId: trigger.id,
          capability: trigger.capability,
          config,
          connectionIds: trigger.connections ?? (trigger.connection ? { default: trigger.connection } : {}),
        }
        const provider = this.ctx.capabilities.resolveTriggerProvider(trigger.capability)
        desired.set(subscriptionKey(automation.id, trigger.id), {
          key: subscriptionKey(automation.id, trigger.id),
          binding,
          definition: status.definition,
          ...(provider ? { provider } : {}),
        })
      }
    }
    return desired
  }

  private activateSubscription(subscription: DesiredSubscription & { provider: TriggerProvider }): ActiveSubscription {
    const controller = new AbortController()
    const dispose = subscription.provider.activate({
      binding: subscription.binding,
      signal: controller.signal,
      emit: async (emission: TriggerEmission) => {
        if (controller.signal.aborted) return { status: 'stale' }
        const data = subscription.definition.output(emission.data)
        if (!isNumenValue(data)) {
          throw new TypeError(`${capabilityKey(subscription.binding.capability)} emitted a non-Numen value`)
        }
        return this.ctx.scheduler.acceptTrigger(subscription.binding, { ...emission, data })
      },
    })
    return {
      ...subscription,
      provider: subscription.provider,
      controller,
      ...(dispose ? { dispose } : {}),
    }
  }

  private disposeSubscription(subscription: ActiveSubscription): void {
    if (!subscription.controller.signal.aborted) subscription.controller.abort()
    subscription.dispose?.()
  }
}

export default TriggerService
