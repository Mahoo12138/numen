import Server from '@cordisjs/plugin-server'
import { Context } from 'cordis'
import { once } from 'node:events'
import z from 'schemastery'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  ConsoleService,
  SingleUserConsoleAuthService,
  consoleWebSocketPlugin,
  type ConsoleSubscriptionProvider,
  type ConsoleSubscriptionServerMessage,
} from '../src/index.js'

async function createContext(): Promise<{ root: Context; url: string }> {
  const root = new Context()
  await root.plugin(Server, { host: '127.0.0.1', port: 0 })
  await root.plugin(ConsoleService)
  await root.plugin(SingleUserConsoleAuthService, { token: 'socket-secret', ownerId: 'socket-owner' })
  return { root, url: `${root.server.baseUrl.replace('http:', 'ws:')}/api/console/subscribe` }
}

async function open(url: string, token = 'socket-secret'): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  await once(socket, 'open')
  return socket
}

function nextMessage(socket: WebSocket): Promise<ConsoleSubscriptionServerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('message', message)
      socket.off('error', error)
    }
    const message = (data: WebSocket.RawData) => {
      cleanup()
      resolve(JSON.parse(data.toString()) as ConsoleSubscriptionServerMessage)
    }
    const error = (cause: Error) => {
      cleanup()
      reject(cause)
    }
    socket.once('message', message)
    socket.once('error', error)
  })
}

async function exchange(
  socket: WebSocket,
  message: unknown,
): Promise<ConsoleSubscriptionServerMessage> {
  const response = nextMessage(socket)
  socket.send(JSON.stringify(message))
  return response
}

describe('Console WebSocket transport', () => {
  it('streams typed events and cleans up on unsubscribe and socket close', async () => {
    const { root, url } = await createContext()
    try {
      const definition = {
        id: 'test:updates',
        version: 1,
        kind: 'subscription' as const,
        title: 'Updates',
        input: z.object({ topic: z.string().required() }),
        event: z.object({ value: z.number().required() }),
      }
      const publishers = new Map<string, (event: { value: number }) => void | Promise<void>>()
      const cleanups: Array<ReturnType<typeof vi.fn>> = []
      const principals: string[] = []
      root.console.define(root, definition)
      const provider = {
        subscribe({ input, request, emit }) {
          const cleanup = vi.fn(() => publishers.delete(input.topic))
          cleanups.push(cleanup)
          principals.push(request.principal.subject.id)
          publishers.set(input.topic, emit)
          return cleanup
        },
      } satisfies ConsoleSubscriptionProvider<{ topic: string }, { value: number }>
      let disposeProvider = root.console.provideSubscription(root, definition, provider)
      await root.plugin(consoleWebSocketPlugin)
      const socket = await open(url)

      const ready = await exchange(socket, {
        type: 'subscribe', id: 'sub-1', procedure: 'test:updates@1', input: { topic: 'runs' },
      })
      expect(ready).toMatchObject({ type: 'ready', id: 'sub-1', requestId: expect.any(String) })
      expect(principals).toEqual(['socket-owner'])

      const event = nextMessage(socket)
      await publishers.get('runs')?.({ value: 42 })
      expect(await event).toEqual({ type: 'event', id: 'sub-1', event: { value: 42 } })

      expect(await exchange(socket, { type: 'unsubscribe', id: 'sub-1' }))
        .toEqual({ type: 'unsubscribed', id: 'sub-1' })
      expect(cleanups[0]).toHaveBeenCalledTimes(1)

      await exchange(socket, {
        type: 'subscribe', id: 'sub-2', procedure: 'test:updates@1', input: { topic: 'automations' },
      })
      const completed = nextMessage(socket)
      await disposeProvider()
      expect(await completed).toEqual({
        type: 'complete', id: 'sub-2', reason: 'provider_unavailable',
      })
      expect(cleanups[1]).toHaveBeenCalledTimes(1)

      disposeProvider = root.console.provideSubscription(root, definition, provider)
      await exchange(socket, {
        type: 'subscribe', id: 'sub-3', procedure: 'test:updates@1', input: { topic: 'connections' },
      })
      const closed = once(socket, 'close')
      socket.close()
      await closed
      await vi.waitFor(() => expect(cleanups[2]).toHaveBeenCalledTimes(1))
    } finally {
      await root.fiber.dispose()
    }
  })

  it('isolates protocol errors without terminating other subscriptions', async () => {
    const { root, url } = await createContext()
    try {
      const subscription = {
        id: 'test:updates',
        version: 1,
        kind: 'subscription' as const,
        title: 'Updates',
        input: z.object({ topic: z.string().required() }),
        event: z.number(),
      }
      const query = {
        id: 'test:query',
        version: 1,
        kind: 'query' as const,
        title: 'Query',
        input: z.object({}),
        output: z.object({}),
      }
      const unavailable = {
        id: 'test:unavailable',
        version: 1,
        kind: 'subscription' as const,
        title: 'Unavailable',
        input: z.object({}),
        event: z.object({}),
      }
      root.console.define(root, subscription)
      root.console.provideSubscription(root, subscription, { subscribe: () => () => {} })
      root.console.define(root, query)
      root.console.provideQuery(root, query, { query: () => ({}) })
      root.console.define(root, unavailable)
      await root.plugin(consoleWebSocketPlugin)
      const socket = await open(url)

      const invalidJson = nextMessage(socket)
      socket.send('{')
      expect(await invalidJson).toMatchObject({ type: 'error', error: { code: 'JSON_INVALID' } })
      const cases: Array<[unknown, string]> = [
        [{ type: 'subscribe', id: 'bad-procedure', procedure: 'invalid', input: {} }, 'PROCEDURE_INVALID'],
        [{ type: 'subscribe', id: 'missing', procedure: 'test:missing@1', input: {} }, 'PROCEDURE_NOT_FOUND'],
        [{ type: 'subscribe', id: 'query', procedure: 'test:query@1', input: {} }, 'PROCEDURE_KIND_MISMATCH'],
        [{ type: 'subscribe', id: 'invalid-input', procedure: 'test:updates@1', input: {} }, 'PROCEDURE_VALIDATION_FAILED'],
        [{ type: 'subscribe', id: 'unavailable', procedure: 'test:unavailable@1', input: {} }, 'PROCEDURE_UNAVAILABLE'],
        [{ type: 'unsubscribe', id: 'unknown' }, 'SUBSCRIPTION_NOT_FOUND'],
      ]
      for (const [message, code] of cases) {
        expect(await exchange(socket, message)).toMatchObject({ type: 'error', error: { code } })
      }

      await exchange(socket, {
        type: 'subscribe', id: 'active', procedure: 'test:updates@1', input: { topic: 'runs' },
      })
      expect(await exchange(socket, {
        type: 'subscribe', id: 'active', procedure: 'test:updates@1', input: { topic: 'runs' },
      })).toMatchObject({ type: 'error', id: 'active', error: { code: 'SUBSCRIPTION_EXISTS' } })
      expect(socket.readyState).toBe(WebSocket.OPEN)
      const closed = once(socket, 'close')
      socket.close()
      await closed
    } finally {
      await root.fiber.dispose()
    }
  })

  it('rejects unauthenticated upgrades before accepting a WebSocket', async () => {
    const { root, url } = await createContext()
    try {
      await root.plugin(consoleWebSocketPlugin)
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(url)
        socket.once('unexpected-response', (_request, response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        socket.once('error', reject)
      })
      expect(status).toBe(401)
    } finally {
      await root.fiber.dispose()
    }
  })
})
