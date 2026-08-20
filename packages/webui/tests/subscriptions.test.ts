import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserConsoleClient,
  ConsoleSubscriptionError,
  type BrowserConsoleEnvironment,
  type BrowserWebSocketFactory,
  type ConsoleSubscriptionServerMessage,
} from '../src/index.js'

class FakeWebSocket extends EventTarget {
  readyState = WebSocket.CONNECTING
  readonly sent: string[] = []

  constructor(readonly url: string) {
    super()
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(message: ConsoleSubscriptionServerMessage): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error('socket is not open')
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    queueMicrotask(() => this.dispatchEvent(new Event('close')))
  }

  serverClose(): void {
    this.close()
  }
}

function setup(reconnectDelayMs = 0): {
  root: Context
  sockets: FakeWebSocket[]
  install(): Promise<void>
} {
  const root = new Context()
  const sockets: FakeWebSocket[] = []
  const factory: BrowserWebSocketFactory = url => {
    const socket = new FakeWebSocket(url)
    sockets.push(socket)
    return socket as unknown as WebSocket
  }
  const environment: BrowserConsoleEnvironment = {
    location: { href: 'http://numen.local/' },
    history: { state: null, replaceState() {} },
    fetch: (async () => Response.json({
      principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
      session: { id: 'session-browser' },
    })) as BrowserConsoleEnvironment['fetch'],
  }
  return {
    root,
    sockets,
    install: async () => {
      await root.plugin(BrowserConsoleClient, { environment, createWebSocket: factory, reconnectDelayMs })
    },
  }
}

function sent(socket: FakeWebSocket, index = -1): Record<string, unknown> {
  const actual = index < 0 ? socket.sent.length + index : index
  return JSON.parse(socket.sent[actual]!) as Record<string, unknown>
}

describe('Browser Console subscriptions', () => {
  it('multiplexes subscriptions and routes events over one WebSocket', async () => {
    const fixture = setup()
    await fixture.install()
    const events: number[] = []
    const firstPending = fixture.root.consoleClient.subscribe(
      { id: 'test:updates', version: 1 },
      { topic: 'runs' },
      { event: (event: number) => events.push(event) },
    )
    const socket = fixture.sockets[0]!
    expect(socket.url).toBe('ws://numen.local/api/console/subscribe')
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const firstId = String(sent(socket).id)
    socket.receive({ type: 'ready', id: firstId, requestId: 'request-1' })
    const unsubscribeFirst = await firstPending

    const secondPending = fixture.root.consoleClient.subscribe(
      { id: 'test:updates', version: 1 },
      { topic: 'automations' },
      { event: (event: number) => events.push(event * 10) },
    )
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const secondId = String(sent(socket).id)
    socket.receive({ type: 'ready', id: secondId, requestId: 'request-2' })
    const unsubscribeSecond = await secondPending
    expect(fixture.sockets).toHaveLength(1)

    socket.receive({ type: 'event', id: firstId, event: 2 })
    socket.receive({ type: 'event', id: secondId, event: 3 })
    await vi.waitFor(() => expect(events).toEqual([2, 30]))
    unsubscribeFirst()
    expect(sent(socket)).toEqual({ type: 'unsubscribe', id: firstId })
    unsubscribeSecond()
    expect(sent(socket)).toEqual({ type: 'unsubscribe', id: secondId })
    await fixture.root.fiber.dispose()
  })

  it('reconciles current truth before restoring subscriptions after reconnect', async () => {
    const fixture = setup(0)
    await fixture.install()
    const states: string[] = []
    fixture.root.on('numen/console-connection-state', state => states.push(state))
    let beginReconcile!: () => void
    const reconcileStarted = new Promise<void>(resolve => {
      beginReconcile = resolve
    })
    let finishReconcile!: () => void
    const reconcileGate = new Promise<void>(resolve => {
      finishReconcile = resolve
    })
    fixture.root.on('numen/console-reconcile', async () => {
      beginReconcile()
      await reconcileGate
    })
    const events: number[] = []
    const pending = fixture.root.consoleClient.subscribe(
      { id: 'test:updates', version: 1 },
      {},
      { event: (event: number) => events.push(event) },
    )
    const first = fixture.sockets[0]!
    first.open()
    await vi.waitFor(() => expect(first.sent).toHaveLength(1))
    const id = String(sent(first).id)
    first.receive({ type: 'ready', id, requestId: 'request-1' })
    const unsubscribe = await pending

    first.serverClose()
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2))
    const second = fixture.sockets[1]!
    second.open()
    await reconcileStarted
    expect(second.sent).toEqual([])
    finishReconcile()
    await vi.waitFor(() => expect(second.sent).toHaveLength(1))
    expect(sent(second)).toMatchObject({ type: 'subscribe', id })
    second.receive({ type: 'ready', id, requestId: 'request-2' })
    second.receive({ type: 'event', id, event: 7 })
    await vi.waitFor(() => expect(events).toEqual([7]))
    expect(states).toContain('RECONNECTING')
    expect(states.at(-1)).toBe('READY')

    unsubscribe()
    await fixture.root.fiber.dispose()
  })

  it('rejects initial protocol errors and propagates AbortSignal cancellation', async () => {
    const fixture = setup()
    await fixture.install()
    const failed = fixture.root.consoleClient.subscribe(
      { id: 'test:missing', version: 1 },
      {},
      { event() {} },
    )
    const socket = fixture.sockets[0]!
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const id = String(sent(socket).id)
    socket.receive({
      type: 'error',
      id,
      error: { code: 'PROCEDURE_NOT_FOUND', message: 'missing' },
    })
    await expect(failed).rejects.toMatchObject<Partial<ConsoleSubscriptionError>>({
      code: 'PROCEDURE_NOT_FOUND',
    })

    const completed = fixture.root.consoleClient.subscribe(
      { id: 'test:unavailable', version: 1 },
      {},
      { event() {} },
    )
    const secondSocket = fixture.sockets[1]!
    secondSocket.open()
    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1))
    const completedId = String(sent(secondSocket).id)
    secondSocket.receive({
      type: 'complete', id: completedId, reason: 'provider_unavailable',
    })
    await expect(completed).rejects.toMatchObject<Partial<ConsoleSubscriptionError>>({
      code: 'SUBSCRIPTION_COMPLETED',
    })

    const controller = new AbortController()
    controller.abort(new Error('cancelled before subscribe'))
    await expect(fixture.root.consoleClient.subscribe(
      { id: 'test:updates', version: 1 }, {}, { event() {} }, controller.signal,
    )).rejects.toThrow('cancelled before subscribe')
    expect(fixture.sockets).toHaveLength(2)
    await fixture.root.fiber.dispose()
  })
})
