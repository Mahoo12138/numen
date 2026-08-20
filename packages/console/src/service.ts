import { Service, type Context, type Logger } from 'cordis'
import type Schema from 'schemastery'

export type ConsoleProcedureKind = 'query' | 'action' | 'subscription'

export interface ConsoleProcedureRef {
  id: string
  version: number
}

interface ConsoleProcedureDefinitionBase<Input> extends ConsoleProcedureRef {
  title: string
  description?: string
  input: Schema<Input>
}

export interface ConsoleQueryDefinition<Input = unknown, Output = unknown>
  extends ConsoleProcedureDefinitionBase<Input> {
  kind: 'query'
  output: Schema<Output>
}

export interface ConsoleActionDefinition<Input = unknown, Output = unknown>
  extends ConsoleProcedureDefinitionBase<Input> {
  kind: 'action'
  output: Schema<Output>
}

export interface ConsoleSubscriptionDefinition<Input = unknown, Event = unknown>
  extends ConsoleProcedureDefinitionBase<Input> {
  kind: 'subscription'
  event: Schema<Event>
}

export type ConsoleProcedureDefinition<Input = unknown, Output = unknown> =
  | ConsoleQueryDefinition<Input, Output>
  | ConsoleActionDefinition<Input, Output>
  | ConsoleSubscriptionDefinition<Input, Output>

export interface SubjectRef {
  type: string
  id: string
}

export interface ConsolePrincipal {
  subject: SubjectRef
  authenticated: boolean
}

export interface ConsoleSession {
  id: string
}

export interface ConsoleRequestContext {
  requestId: string
  principal: ConsolePrincipal
  session?: ConsoleSession
  signal: AbortSignal
  logger: Logger
}

export interface ConsoleAuthenticationRequest {
  method: string
  path: string
  headers: Headers
  remoteAddress?: string
  signal: AbortSignal
}

export interface ConsoleAuthenticationResult {
  principal: ConsolePrincipal
  session?: ConsoleSession
}

export interface ConsoleAuthenticator {
  authenticate(request: ConsoleAuthenticationRequest):
    | ConsoleAuthenticationResult
    | Promise<ConsoleAuthenticationResult>
}

export interface ConsoleProcedureInvocation<Input> {
  input: Input
  request: ConsoleRequestContext
}

export interface ConsoleQueryProvider<Input, Output> {
  query(invocation: ConsoleProcedureInvocation<Input>): Output | Promise<Output>
}

export interface ConsoleActionProvider<Input, Output> {
  action(invocation: ConsoleProcedureInvocation<Input>): Output | Promise<Output>
}

export interface ConsoleSubscriptionInvocation<Input, Event> extends ConsoleProcedureInvocation<Input> {
  emit(event: Event): void | Promise<void>
}

export type ConsoleSubscriptionCleanup = () => void | Promise<void>

export interface ConsoleSubscriptionProvider<Input, Event> {
  subscribe(invocation: ConsoleSubscriptionInvocation<Input, Event>):
    | void
    | ConsoleSubscriptionCleanup
    | Promise<void | ConsoleSubscriptionCleanup>
}

export interface ConsoleProcedureStatus {
  definition: ConsoleProcedureDefinition
  providerAvailable: boolean
}

type AnyQueryProvider = ConsoleQueryProvider<any, any>
type AnyActionProvider = ConsoleActionProvider<any, any>
type AnySubscriptionProvider = ConsoleSubscriptionProvider<any, any>
type AnyProvider = AnyQueryProvider | AnyActionProvider | AnySubscriptionProvider

interface RegistryEntry {
  definition: ConsoleProcedureDefinition<any, any>
  provider?: AnyProvider
  activeSubscriptions: Set<ConsoleSubscriptionCleanup>
}

declare module 'cordis' {
  interface Context {
    console: ConsoleService
  }

  interface Events {
    'numen/console-procedure-change'(ref: ConsoleProcedureRef): void
  }
}

const procedureIdPattern = /^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/

export function consoleProcedureKey(ref: ConsoleProcedureRef): string {
  return `${ref.id}@${ref.version}`
}

export function parseConsoleProcedureKey(value: string): ConsoleProcedureRef | undefined {
  const separator = value.lastIndexOf('@')
  if (separator < 1) return
  const id = value.slice(0, separator)
  const versionText = value.slice(separator + 1)
  if (!procedureIdPattern.test(id) || !/^[1-9]\d*$/.test(versionText)) return
  const version = Number(versionText)
  if (!Number.isSafeInteger(version)) return
  return { id, version }
}

export class ConsoleProcedureNotFoundError extends Error {
  override name = 'ConsoleProcedureNotFoundError'
}

export class ConsoleProcedureUnavailableError extends Error {
  override name = 'ConsoleProcedureUnavailableError'
}

export class ConsoleProcedureKindError extends Error {
  override name = 'ConsoleProcedureKindError'
}

export class ConsoleAuthenticatorUnavailableError extends Error {
  override name = 'ConsoleAuthenticatorUnavailableError'
}

export class ConsoleAuthenticationError extends Error {
  override name = 'ConsoleAuthenticationError'
}

export class ConsoleService extends Service {
  private readonly entries = new Map<string, RegistryEntry>()
  private authenticator?: ConsoleAuthenticator

  constructor(ctx: Context) {
    super(ctx, 'console')
  }

  define<Input, Output>(
    owner: Context,
    definition: ConsoleProcedureDefinition<Input, Output>,
  ): () => void | Promise<void> {
    this.validateDefinition(definition)
    const key = consoleProcedureKey(definition)
    if (this.entries.has(key)) throw new Error(`console procedure already defined: ${key}`)

    return owner.effect(() => {
      const entry: RegistryEntry = {
        definition: definition as ConsoleProcedureDefinition<any, any>,
        activeSubscriptions: new Set(),
      }
      this.entries.set(key, entry)
      this.ctx.emit('numen/console-procedure-change', definition)
      return async () => {
        await this.disposeSubscriptions(entry)
        this.entries.delete(key)
        this.ctx.emit('numen/console-procedure-change', definition)
      }
    }, `console.define(${JSON.stringify(key)})`)
  }

  provideQuery<Input, Output>(
    owner: Context,
    ref: ConsoleProcedureRef,
    provider: ConsoleQueryProvider<Input, Output>,
  ): () => void | Promise<void> {
    return this.provide(owner, ref, 'query', provider as AnyQueryProvider)
  }

  provideAction<Input, Output>(
    owner: Context,
    ref: ConsoleProcedureRef,
    provider: ConsoleActionProvider<Input, Output>,
  ): () => void | Promise<void> {
    return this.provide(owner, ref, 'action', provider as AnyActionProvider)
  }

  provideSubscription<Input, Event>(
    owner: Context,
    ref: ConsoleProcedureRef,
    provider: ConsoleSubscriptionProvider<Input, Event>,
  ): () => void | Promise<void> {
    return this.provide(owner, ref, 'subscription', provider as AnySubscriptionProvider)
  }

  provideAuthenticator(owner: Context, authenticator: ConsoleAuthenticator): () => void | Promise<void> {
    if (this.authenticator) throw new Error('console authenticator already registered')
    return owner.effect(() => {
      this.authenticator = authenticator
      return () => {
        if (this.authenticator === authenticator) delete this.authenticator
      }
    }, 'console.provideAuthenticator()')
  }

  async authenticate(request: ConsoleAuthenticationRequest): Promise<ConsoleAuthenticationResult> {
    if (!this.authenticator) {
      throw new ConsoleAuthenticatorUnavailableError('console authenticator unavailable')
    }
    request.signal.throwIfAborted()
    const identity = await this.authenticator.authenticate(request)
    request.signal.throwIfAborted()
    if (!identity?.principal?.authenticated) {
      throw new ConsoleAuthenticationError('console authentication required')
    }
    const { subject } = identity.principal
    if (!subject || typeof subject.type !== 'string' || !subject.type || typeof subject.id !== 'string' || !subject.id) {
      throw new TypeError('console authenticator returned an invalid principal')
    }
    return identity
  }

  get(ref: ConsoleProcedureRef): ConsoleProcedureStatus | undefined {
    const entry = this.entries.get(consoleProcedureKey(ref))
    if (!entry) return
    return { definition: entry.definition, providerAvailable: !!entry.provider }
  }

  list(): ConsoleProcedureStatus[] {
    return [...this.entries.values()]
      .map(entry => ({ definition: entry.definition, providerAvailable: !!entry.provider }))
      .sort((left, right) => (
        consoleProcedureKey(left.definition).localeCompare(consoleProcedureKey(right.definition))
      ))
  }

  async query<Input, Output>(
    ref: ConsoleProcedureRef,
    input: Input,
    request: ConsoleRequestContext,
  ): Promise<Output> {
    const entry = this.requireEntry(ref, 'query')
    const provider = this.requireProvider<AnyQueryProvider>(ref, entry)
    request.signal.throwIfAborted()
    const parsedInput = entry.definition.input(input)
    const output = await provider.query({ input: parsedInput, request })
    request.signal.throwIfAborted()
    return entry.definition.output(output) as Output
  }

  async action<Input, Output>(
    ref: ConsoleProcedureRef,
    input: Input,
    request: ConsoleRequestContext,
  ): Promise<Output> {
    const entry = this.requireEntry(ref, 'action')
    const provider = this.requireProvider<AnyActionProvider>(ref, entry)
    request.signal.throwIfAborted()
    const parsedInput = entry.definition.input(input)
    const output = await provider.action({ input: parsedInput, request })
    request.signal.throwIfAborted()
    return entry.definition.output(output) as Output
  }

  async subscribe<Input, Event>(
    ref: ConsoleProcedureRef,
    input: Input,
    request: ConsoleRequestContext,
    emit: (event: Event) => void | Promise<void>,
  ): Promise<ConsoleSubscriptionCleanup> {
    const entry = this.requireEntry(ref, 'subscription')
    const provider = this.requireProvider<AnySubscriptionProvider>(ref, entry)
    request.signal.throwIfAborted()
    const parsedInput = entry.definition.input(input)
    let cleanup: ConsoleSubscriptionCleanup | undefined
    let started = false
    let disposeRequested = false
    let disposed = false

    const finalize = async () => {
      if (disposed) return
      disposed = true
      request.signal.removeEventListener('abort', abort)
      entry.activeSubscriptions.delete(dispose)
      await cleanup?.()
    }
    const dispose = async () => {
      if (!started) {
        disposeRequested = true
        return
      }
      await finalize()
    }
    const abort = () => {
      void dispose()
    }
    request.signal.addEventListener('abort', abort, { once: true })

    try {
      const result = await provider.subscribe({
        input: parsedInput,
        request,
        emit: event => emit(entry.definition.event(event) as Event),
      })
      cleanup = result ?? undefined
      started = true
      entry.activeSubscriptions.add(dispose)
      if (disposeRequested || request.signal.aborted) await finalize()
      return dispose
    } catch (error) {
      request.signal.removeEventListener('abort', abort)
      throw error
    }
  }

  private validateDefinition(definition: ConsoleProcedureDefinition<any, any>): void {
    if (!procedureIdPattern.test(definition.id)) {
      throw new TypeError(`invalid console procedure id: ${definition.id}`)
    }
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new TypeError(`invalid console procedure version: ${definition.version}`)
    }
    if (!['query', 'action', 'subscription'].includes(definition.kind)) {
      throw new TypeError(`invalid console procedure kind: ${String(definition.kind)}`)
    }
  }

  private provide(
    owner: Context,
    ref: ConsoleProcedureRef,
    kind: ConsoleProcedureKind,
    provider: AnyProvider,
  ): () => void | Promise<void> {
    const entry = this.requireEntry(ref, kind)
    const key = consoleProcedureKey(ref)
    if (entry.provider) throw new Error(`console procedure provider already registered: ${key}`)
    return owner.effect(() => {
      entry.provider = provider
      this.ctx.emit('numen/console-procedure-change', ref)
      return async () => {
        delete entry.provider
        await this.disposeSubscriptions(entry)
        this.ctx.emit('numen/console-procedure-change', ref)
      }
    }, `console.provide(${JSON.stringify(key)})`)
  }

  private requireEntry(
    ref: ConsoleProcedureRef,
    kind: 'query',
  ): RegistryEntry & { definition: ConsoleQueryDefinition<any, any> }
  private requireEntry(
    ref: ConsoleProcedureRef,
    kind: 'action',
  ): RegistryEntry & { definition: ConsoleActionDefinition<any, any> }
  private requireEntry(
    ref: ConsoleProcedureRef,
    kind: 'subscription',
  ): RegistryEntry & { definition: ConsoleSubscriptionDefinition<any, any> }
  private requireEntry(ref: ConsoleProcedureRef, kind: ConsoleProcedureKind): RegistryEntry
  private requireEntry(ref: ConsoleProcedureRef, kind: ConsoleProcedureKind): RegistryEntry {
    const key = consoleProcedureKey(ref)
    const entry = this.entries.get(key)
    if (!entry) throw new ConsoleProcedureNotFoundError(`console procedure not found: ${key}`)
    if (entry.definition.kind !== kind) {
      throw new ConsoleProcedureKindError(`console procedure ${key} is ${entry.definition.kind}, not ${kind}`)
    }
    return entry
  }

  private requireProvider<Provider extends AnyProvider>(
    ref: ConsoleProcedureRef,
    entry: RegistryEntry,
  ): Provider {
    if (!entry.provider) {
      throw new ConsoleProcedureUnavailableError(`console procedure unavailable: ${consoleProcedureKey(ref)}`)
    }
    return entry.provider as Provider
  }

  private async disposeSubscriptions(entry: RegistryEntry): Promise<void> {
    await Promise.all([...entry.activeSubscriptions].map(dispose => dispose()))
  }
}

export default ConsoleService
