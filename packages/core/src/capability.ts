import { Service, type Context } from 'cordis'
import type Schema from 'schemastery'
import type { CapabilityRef } from './automation.js'
import type { NumenValue } from './value.js'

export type CapabilityKind = 'trigger' | 'query' | 'action'

export interface CapabilitySemantics {
  sideEffect: boolean
  idempotent: boolean
  retrySafe: boolean
  defaultTimeoutMs?: number
}

export interface ConnectionSlot {
  name: string
  required: boolean
  accepts: string[]
}

export interface CapabilityDefinition<Input = NumenValue, Output = NumenValue> extends CapabilityRef {
  kind: CapabilityKind
  title: string
  description?: string
  input: Schema<Input>
  output: Schema<Output>
  semantics: CapabilitySemantics
  connections?: ConnectionSlot[]
}

export interface CapabilityInvocation<Input = NumenValue> {
  input: Input
  connectionIds: Record<string, string>
  signal: AbortSignal
  idempotencyKey?: string
}

export interface CapabilityProvider<Input = NumenValue, Output = NumenValue> {
  invoke(invocation: CapabilityInvocation<Input>): Promise<Output>
}

export interface TriggerBinding {
  automationId: string
  revisionId: string
  activationGeneration: number
  triggerId: string
  capability: CapabilityRef
  config: Record<string, NumenValue>
  connectionIds: Record<string, string>
}

export interface TriggerEmission<Output = NumenValue> {
  data: Output
  occurredAt?: string
  eventId?: string
  subject?: string
  checkpoint?: NumenValue
}

export interface TriggerAcceptance {
  status: 'accepted' | 'duplicate' | 'stale'
  runId?: string
}

export interface TriggerActivation<Output = NumenValue> {
  binding: TriggerBinding
  signal: AbortSignal
  emit(emission: TriggerEmission<Output>): Promise<TriggerAcceptance>
}

export interface TriggerProvider<Output = NumenValue> {
  activate(activation: TriggerActivation<Output>): void | (() => void)
}

export interface CapabilityStatus {
  definition: CapabilityDefinition
  providerAvailable: boolean
}

interface RegistryEntry {
  definition: CapabilityDefinition
  provider?: CapabilityProvider
  triggerProvider?: TriggerProvider
}

declare module 'cordis' {
  interface Context {
    capabilities: CapabilityRegistry
  }

  interface Events {
    'numen/capability-change'(ref: CapabilityRef): void
  }
}

const idPattern = /^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/

export function capabilityKey(ref: CapabilityRef): string {
  return `${ref.id}@${ref.version}`
}

export class CapabilityRegistry extends Service {
  private readonly entries = new Map<string, RegistryEntry>()

  constructor(ctx: Context) {
    super(ctx, 'capabilities')
  }

  define(owner: Context, definition: CapabilityDefinition): () => void {
    if (!idPattern.test(definition.id)) {
      throw new TypeError(`invalid capability id: ${definition.id}`)
    }
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new TypeError(`invalid capability version: ${definition.version}`)
    }
    const key = capabilityKey(definition)
    if (this.entries.has(key)) throw new Error(`capability already defined: ${key}`)

    return owner.effect(() => {
      this.entries.set(key, { definition })
      this.ctx.emit('numen/capability-change', definition)
      return () => {
        this.entries.delete(key)
        this.ctx.emit('numen/capability-change', definition)
      }
    }, `capabilities.define(${JSON.stringify(key)})`)
  }

  provide<Input, Output>(
    owner: Context,
    ref: CapabilityRef,
    provider: CapabilityProvider<Input, Output>,
  ): () => void {
    const key = capabilityKey(ref)
    const entry = this.entries.get(key)
    if (!entry) throw new Error(`capability definition missing: ${key}`)
    if (entry.definition.kind === 'trigger') {
      throw new Error(`trigger capability requires provideTrigger(): ${key}`)
    }
    if (entry.provider) throw new Error(`capability provider already registered: ${key}`)

    return owner.effect(() => {
      entry.provider = provider as CapabilityProvider
      this.ctx.emit('numen/capability-change', ref)
      return () => {
        delete entry.provider
        this.ctx.emit('numen/capability-change', ref)
      }
    }, `capabilities.provide(${JSON.stringify(key)})`)
  }

  provideTrigger<Output>(
    owner: Context,
    ref: CapabilityRef,
    provider: TriggerProvider<Output>,
  ): () => void {
    const key = capabilityKey(ref)
    const entry = this.entries.get(key)
    if (!entry) throw new Error(`capability definition missing: ${key}`)
    if (entry.definition.kind !== 'trigger') {
      throw new Error(`capability is not a trigger: ${key}`)
    }
    if (entry.triggerProvider) throw new Error(`trigger provider already registered: ${key}`)

    return owner.effect(() => {
      entry.triggerProvider = provider as TriggerProvider
      this.ctx.emit('numen/capability-change', ref)
      return () => {
        delete entry.triggerProvider
        this.ctx.emit('numen/capability-change', ref)
      }
    }, `capabilities.provideTrigger(${JSON.stringify(key)})`)
  }

  get(ref: CapabilityRef): CapabilityStatus | undefined {
    const entry = this.entries.get(capabilityKey(ref))
    if (!entry) return
    return {
      definition: entry.definition,
      providerAvailable: entry.definition.kind === 'trigger' ? !!entry.triggerProvider : !!entry.provider,
    }
  }

  resolveProvider<Input, Output>(ref: CapabilityRef): CapabilityProvider<Input, Output> | undefined {
    return this.entries.get(capabilityKey(ref))?.provider as CapabilityProvider<Input, Output> | undefined
  }

  resolveTriggerProvider<Output>(ref: CapabilityRef): TriggerProvider<Output> | undefined {
    return this.entries.get(capabilityKey(ref))?.triggerProvider as TriggerProvider<Output> | undefined
  }

  list(): CapabilityStatus[] {
    return [...this.entries.values()]
      .map(entry => ({
        definition: entry.definition,
        providerAvailable: entry.definition.kind === 'trigger' ? !!entry.triggerProvider : !!entry.provider,
      }))
      .sort((a, b) => capabilityKey(a.definition).localeCompare(capabilityKey(b.definition)))
  }
}

export default CapabilityRegistry
