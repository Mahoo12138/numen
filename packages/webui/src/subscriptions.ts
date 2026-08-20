import type {
  ConsoleProcedureRef,
  ConsoleSubscriptionServerMessage,
} from '@numen/console'
import type { Context } from 'cordis'

export type BrowserWebSocketFactory = (url: string) => WebSocket
export type ConsoleConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'READY' | 'RECONNECTING'

export interface ConsoleSubscriptionHandlers<Event> {
  event(event: Event): void | Promise<void>
  error?(error: ConsoleSubscriptionError): void | Promise<void>
  complete?(reason: string): void | Promise<void>
}

export type BrowserConsoleSubscription = () => void

export class ConsoleSubscriptionError extends Error {
  override name = 'ConsoleSubscriptionError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

interface DesiredSubscription {
  id: string
  procedure: string
  input: unknown
  handlers: ConsoleSubscriptionHandlers<unknown>
  signal?: AbortSignal
  abort?: () => void
  ready: Promise<void>
  resolveReady(): void
  rejectReady(error: unknown): void
  readySettled: boolean
  sentSocket?: WebSocket
}

declare module 'cordis' {
  interface Events {
    'numen/console-connection-state'(state: ConsoleConnectionState): void
    'numen/console-reconcile'(): void | Promise<void>
  }
}

function socketUrl(baseUrl: string): string {
  const url = new URL('/api/console/subscribe', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

export class BrowserConsoleSubscriptions {
  state: ConsoleConnectionState = 'DISCONNECTED'

  private readonly desired = new Map<string, DesiredSubscription>()
  private socket: WebSocket | undefined
  private connection: Promise<void> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private nextId = 0
  private hasConnected = false
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly baseUrl: string,
    private readonly createWebSocket: BrowserWebSocketFactory,
    private readonly reconnectDelayMs: number,
  ) {}

  async subscribe<Input, Event>(
    ref: ConsoleProcedureRef,
    input: Input,
    handlers: ConsoleSubscriptionHandlers<Event>,
    signal?: AbortSignal,
  ): Promise<BrowserConsoleSubscription> {
    if (this.disposed) throw new Error('browser console subscriptions are disposed')
    signal?.throwIfAborted()
    const id = `browser-${++this.nextId}`
    let resolveReady!: () => void
    let rejectReady!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const subscription: DesiredSubscription = {
      id,
      procedure: `${ref.id}@${ref.version}`,
      input,
      handlers: handlers as ConsoleSubscriptionHandlers<unknown>,
      ...(signal ? { signal } : {}),
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
    }
    if (signal) {
      subscription.abort = () => this.remove(subscription, signal.reason)
      signal.addEventListener('abort', subscription.abort, { once: true })
    }
    this.desired.set(id, subscription)
    try {
      await this.ensureConnected()
      this.sendSubscribe(subscription)
      await ready
    } catch (error) {
      this.remove(subscription, error)
      throw error
    }
    return () => this.remove(subscription)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    for (const subscription of [...this.desired.values()]) {
      this.remove(subscription, new Error('browser console subscriptions disposed'))
    }
    this.socket?.close(1000, 'browser console disposed')
    this.socket = undefined
    this.setState('DISCONNECTED')
  }

  private async ensureConnected(): Promise<void> {
    if (this.disposed) throw new Error('browser console subscriptions are disposed')
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connection) return this.connection
    const reconnecting = this.hasConnected
    this.setState(reconnecting ? 'RECONNECTING' : 'CONNECTING')
    const socket = this.createWebSocket(socketUrl(this.baseUrl))
    this.socket = socket
    const connection = new Promise<void>((resolve, reject) => {
      let opened = false
      socket.addEventListener('open', () => {
        opened = true
        void this.handleOpen(socket, reconnecting).then(resolve, error => {
          reject(error)
          socket.close(1011, 'console reconciliation failed')
        })
      }, { once: true })
      socket.addEventListener('message', event => this.handleMessage(event), false)
      socket.addEventListener('error', () => {
        if (!opened) reject(new Error('console WebSocket connection failed'))
      })
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = undefined
        if (!opened) reject(new Error('console WebSocket closed before opening'))
        this.connection = undefined
        if (this.disposed || !this.desired.size) {
          this.setState('DISCONNECTED')
          return
        }
        this.setState('RECONNECTING')
        this.scheduleReconnect()
      }, { once: true })
    })
    this.connection = connection
    try {
      await connection
    } finally {
      if (this.connection === connection) this.connection = undefined
    }
  }

  private async handleOpen(socket: WebSocket, reconnecting: boolean): Promise<void> {
    if (this.socket !== socket || this.disposed) return
    if (reconnecting) await this.ctx.parallel('numen/console-reconcile')
    this.hasConnected = true
    for (const subscription of this.desired.values()) this.sendSubscribe(subscription)
    this.setState('READY')
  }

  private handleMessage(event: MessageEvent): void {
    let message: ConsoleSubscriptionServerMessage
    try {
      message = JSON.parse(String(event.data)) as ConsoleSubscriptionServerMessage
    } catch {
      return
    }
    if (!('id' in message) || !message.id) return
    const subscription = this.desired.get(message.id)
    if (!subscription) return
    if (message.type === 'ready') {
      if (!subscription.readySettled) {
        subscription.readySettled = true
        subscription.resolveReady()
      }
      return
    }
    if (message.type === 'event') {
      void Promise.resolve(subscription.handlers.event(message.event)).catch(error => {
        this.ctx.logger('console:browser').error(error)
      })
      return
    }
    if (message.type === 'complete') {
      if (!subscription.readySettled) {
        subscription.readySettled = true
        subscription.rejectReady(new ConsoleSubscriptionError(
          'SUBSCRIPTION_COMPLETED',
          `Console subscription completed before ready: ${message.reason}`,
        ))
      }
      this.desired.delete(subscription.id)
      this.detachAbort(subscription)
      void subscription.handlers.complete?.(message.reason)
      this.closeIfIdle()
      return
    }
    if (message.type === 'error') {
      const error = new ConsoleSubscriptionError(message.error.code, message.error.message)
      if (!subscription.readySettled) {
        subscription.readySettled = true
        subscription.rejectReady(error)
        this.desired.delete(subscription.id)
        this.detachAbort(subscription)
        this.closeIfIdle()
      } else {
        void subscription.handlers.error?.(error)
      }
    }
  }

  private sendSubscribe(subscription: DesiredSubscription): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || subscription.sentSocket === this.socket) return
    subscription.sentSocket = this.socket
    this.socket.send(JSON.stringify({
      type: 'subscribe',
      id: subscription.id,
      procedure: subscription.procedure,
      input: subscription.input,
    }))
  }

  private remove(subscription: DesiredSubscription, reason?: unknown): void {
    if (!this.desired.delete(subscription.id)) return
    this.detachAbort(subscription)
    if (!subscription.readySettled) {
      subscription.readySettled = true
      subscription.rejectReady(reason ?? new Error('console subscription cancelled'))
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'unsubscribe', id: subscription.id }))
    }
    this.closeIfIdle()
  }

  private detachAbort(subscription: DesiredSubscription): void {
    if (subscription.signal && subscription.abort) {
      subscription.signal.removeEventListener('abort', subscription.abort)
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.disposed || !this.desired.size) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.ensureConnected().catch(() => this.scheduleReconnect())
    }, this.reconnectDelayMs)
  }

  private closeIfIdle(): void {
    if (this.desired.size) return
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.socket?.close(1000, 'no console subscriptions')
  }

  private setState(state: ConsoleConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.ctx.emit('numen/console-connection-state', state)
  }
}
