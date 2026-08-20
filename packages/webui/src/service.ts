import type {
  ConsoleEntryManifest,
  ConsoleProcedureRef,
  ConsoleSessionDocument,
} from '@numen/console'
import { Service, type Context } from 'cordis'
import {
  BrowserConsoleSubscriptions,
  type BrowserConsoleSubscription,
  type BrowserWebSocketFactory,
  type ConsoleSubscriptionHandlers,
} from './subscriptions.js'

export interface BrowserConsoleEnvironment {
  fetch: typeof globalThis.fetch
  location: Pick<Location, 'href'>
  history: Pick<History, 'state' | 'replaceState'>
}

export interface BrowserConsoleClientConfig {
  baseUrl?: string
  bootstrapParameter?: string
  environment?: BrowserConsoleEnvironment
  createWebSocket?: BrowserWebSocketFactory
  reconnectDelayMs?: number
}

export interface ConsoleClientCallError {
  requestId?: string
  error?: {
    code?: string
    message?: string
    details?: unknown
  }
}

export class ConsoleClientError extends Error {
  override name = 'ConsoleClientError'

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

declare module 'cordis' {
  interface Context {
    consoleClient: BrowserConsoleClient
  }
}

function procedureKey(ref: ConsoleProcedureRef): string {
  return `${ref.id}@${ref.version}`
}

function defaultEnvironment(): BrowserConsoleEnvironment {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    location: globalThis.location,
    history: globalThis.history,
  }
}

export class BrowserConsoleClient extends Service {
  readonly baseUrl: string
  readonly bootstrapParameter: string
  readonly subscriptions: BrowserConsoleSubscriptions
  session: ConsoleSessionDocument | undefined

  private readonly environment: BrowserConsoleEnvironment

  constructor(ctx: Context, config: BrowserConsoleClientConfig = {}) {
    super(ctx, 'consoleClient')
    this.environment = config.environment ?? defaultEnvironment()
    this.baseUrl = (config.baseUrl ?? new URL(this.environment.location.href).origin).replace(/\/$/, '')
    this.bootstrapParameter = config.bootstrapParameter ?? 'numen-bootstrap'
    const reconnectDelayMs = config.reconnectDelayMs ?? 500
    if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0) {
      throw new TypeError('browser Console reconnectDelayMs must be a non-negative integer')
    }
    this.subscriptions = new BrowserConsoleSubscriptions(
      ctx,
      this.baseUrl,
      config.createWebSocket ?? (url => new globalThis.WebSocket(url)),
      reconnectDelayMs,
    )
  }

  async *[Service.init]() {
    this.session = await this.bootstrapSession()
    yield () => {
      this.subscriptions.dispose()
      this.session = undefined
    }
  }

  async query<Input, Output>(ref: ConsoleProcedureRef, input: Input, signal?: AbortSignal): Promise<Output> {
    return this.call<Input, Output>('query', ref, input, signal)
  }

  async action<Input, Output>(ref: ConsoleProcedureRef, input: Input, signal?: AbortSignal): Promise<Output> {
    return this.call<Input, Output>('action', ref, input, signal)
  }

  subscribe<Input, Event>(
    ref: ConsoleProcedureRef,
    input: Input,
    handlers: ConsoleSubscriptionHandlers<Event>,
    signal?: AbortSignal,
  ): Promise<BrowserConsoleSubscription> {
    return this.subscriptions.subscribe(ref, input, handlers, signal)
  }

  async getEntryManifest(signal?: AbortSignal): Promise<ConsoleEntryManifest> {
    signal?.throwIfAborted()
    const response = await this.environment.fetch(`${this.baseUrl}/api/console/entries`, {
      method: 'GET',
      credentials: 'include',
      ...(signal ? { signal } : {}),
    })
    signal?.throwIfAborted()
    if (!response.ok) await this.throwResponse(response)
    return response.json() as Promise<ConsoleEntryManifest>
  }

  async logout(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const response = await this.environment.fetch(`${this.baseUrl}/api/console/session`, {
      method: 'DELETE',
      credentials: 'include',
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) await this.throwResponse(response)
    this.session = undefined
  }

  private async bootstrapSession(): Promise<ConsoleSessionDocument> {
    const token = this.takeBootstrapToken()
    const response = await this.environment.fetch(`${this.baseUrl}/api/console/session`, {
      method: token === undefined ? 'GET' : 'POST',
      credentials: 'include',
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    })
    if (!response.ok) await this.throwResponse(response)
    return response.json() as Promise<ConsoleSessionDocument>
  }

  private takeBootstrapToken(): string | undefined {
    const url = new URL(this.environment.location.href)
    const parameters = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
    if (!parameters.has(this.bootstrapParameter)) return
    const token = parameters.get(this.bootstrapParameter) ?? ''
    parameters.delete(this.bootstrapParameter)
    const fragment = parameters.toString()
    url.hash = fragment ? `#${fragment}` : ''
    this.environment.history.replaceState(this.environment.history.state, '', url.href)
    return token
  }

  private async call<Input, Output>(
    kind: 'query' | 'action',
    ref: ConsoleProcedureRef,
    input: Input,
    signal?: AbortSignal,
  ): Promise<Output> {
    signal?.throwIfAborted()
    const response = await this.environment.fetch(`${this.baseUrl}/api/console/call`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, procedure: procedureKey(ref), input }),
      ...(signal ? { signal } : {}),
    })
    signal?.throwIfAborted()
    if (!response.ok) await this.throwResponse(response)
    const document = await response.json() as { requestId: string; result: Output }
    return document.result
  }

  private async throwResponse(response: Response): Promise<never> {
    let document: ConsoleClientCallError = {}
    try {
      document = await response.json() as ConsoleClientCallError
    } catch {
      // The status remains authoritative when a proxy returns a non-JSON body.
    }
    throw new ConsoleClientError(
      response.status,
      document.error?.code ?? 'HTTP_ERROR',
      document.error?.message ?? `Console request failed with HTTP ${response.status}`,
      document.requestId,
      document.error?.details,
    )
  }
}

export default BrowserConsoleClient
