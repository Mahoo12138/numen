import type { Request } from '@cordisjs/plugin-server'
import type { Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'
import type { RawData, WebSocket } from 'ws'
import {
  ConsoleAuthenticationError,
  ConsoleAuthenticatorUnavailableError,
  ConsoleProcedureKindError,
  ConsoleProcedureNotFoundError,
  ConsoleProcedureUnavailableError,
  parseConsoleProcedureKey,
  type ConsoleAuthenticationResult,
  type ConsoleSubscriptionCleanup,
} from './service.js'

export interface ConsoleWebSocketConfig {
  path?: string
  maxMessageBytes?: number
  maxBufferedBytes?: number
}

export type ConsoleSubscriptionClientMessage =
  | { type: 'subscribe'; id: string; procedure: string; input: unknown }
  | { type: 'unsubscribe'; id: string }

export type ConsoleSubscriptionServerMessage =
  | { type: 'ready'; id: string; requestId: string }
  | { type: 'event'; id: string; event: unknown }
  | { type: 'complete'; id: string; reason: 'provider_unavailable' }
  | { type: 'unsubscribed'; id: string }
  | { type: 'error'; id?: string; error: { code: string; message: string } }

interface ActiveSubscription {
  controller: AbortController
  unlink(): void
  dispose: ConsoleSubscriptionCleanup
}

const clientIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/

function byteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0)
  return data.byteLength
}

function text(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

function refuse(request: Request, status: 401 | 503, reason: string): void {
  if (request._req.socket.destroyed) return
  request._req.socket.write([
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n'))
  request._req.socket.destroy()
}

async function send(
  socket: WebSocket,
  message: ConsoleSubscriptionServerMessage,
  maxBufferedBytes: number,
): Promise<void> {
  if (socket.readyState !== socket.OPEN) return
  if (socket.bufferedAmount > maxBufferedBytes) {
    socket.close(1013, 'console subscription backpressure')
    throw new Error('console subscription backpressure limit exceeded')
  }
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(message), error => error ? reject(error) : resolve())
  })
}

function parseMessage(data: RawData, maxMessageBytes: number): ConsoleSubscriptionClientMessage {
  if (byteLength(data) > maxMessageBytes) throw new RangeError('console subscription message is too large')
  const value = JSON.parse(text(data)) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('console subscription message must be an object')
  }
  const message = value as Record<string, unknown>
  if (message.type !== 'subscribe' && message.type !== 'unsubscribe') {
    throw new TypeError('console subscription message type is invalid')
  }
  if (typeof message.id !== 'string' || !clientIdPattern.test(message.id)) {
    throw new TypeError('console subscription id is invalid')
  }
  if (message.type === 'unsubscribe') return { type: 'unsubscribe', id: message.id }
  if (typeof message.procedure !== 'string' || !('input' in message)) {
    throw new TypeError('console subscribe message requires procedure and input')
  }
  return { type: 'subscribe', id: message.id, procedure: message.procedure, input: message.input }
}

function protocolError(error: unknown): { code: string; message: string } {
  if (error instanceof ConsoleProcedureNotFoundError) {
    return { code: 'PROCEDURE_NOT_FOUND', message: error.message }
  }
  if (error instanceof ConsoleProcedureKindError) {
    return { code: 'PROCEDURE_KIND_MISMATCH', message: error.message }
  }
  if (error instanceof ConsoleProcedureUnavailableError) {
    return { code: 'PROCEDURE_UNAVAILABLE', message: error.message }
  }
  if (error instanceof z.ValidationError) {
    return { code: 'PROCEDURE_VALIDATION_FAILED', message: error.message }
  }
  if (error instanceof RangeError) return { code: 'MESSAGE_TOO_LARGE', message: error.message }
  if (error instanceof SyntaxError) return { code: 'JSON_INVALID', message: 'Message must be valid JSON' }
  if (error instanceof TypeError) return { code: 'MESSAGE_INVALID', message: error.message }
  return { code: 'INTERNAL_ERROR', message: 'Console subscription failed' }
}

async function authenticate(
  ctx: Context,
  request: Request,
  signal: AbortSignal,
): Promise<ConsoleAuthenticationResult | undefined> {
  try {
    return await ctx.console.authenticate({
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(request._req.socket.remoteAddress ? { remoteAddress: request._req.socket.remoteAddress } : {}),
      signal,
    })
  } catch (error) {
    if (error instanceof ConsoleAuthenticationError) {
      refuse(request, 401, 'Unauthorized')
      return
    }
    if (error instanceof ConsoleAuthenticatorUnavailableError) {
      refuse(request, 503, 'Service Unavailable')
      return
    }
    throw error
  }
}

export function consoleWebSocketPlugin(ctx: Context, config: ConsoleWebSocketConfig = {}): void {
  const path = config.path ?? '/api/console/subscribe'
  const maxMessageBytes = config.maxMessageBytes ?? 1024 * 1024
  const maxBufferedBytes = config.maxBufferedBytes ?? 1024 * 1024
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new TypeError('console WebSocket maxMessageBytes must be a positive integer')
  }
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
    throw new TypeError('console WebSocket maxBufferedBytes must be a positive integer')
  }

  ctx.server.ws(path, async (request, accept) => {
    const socketController = new AbortController()
    const identity = await authenticate(ctx, request, socketController.signal)
    if (!identity) return
    const socket = await accept()
    const subscriptions = new Map<string, ActiveSubscription>()
    let sequence = Promise.resolve()

    const stop = async (id: string, notify: boolean) => {
      const active = subscriptions.get(id)
      if (!active) return false
      subscriptions.delete(id)
      active.unlink()
      if (!active.controller.signal.aborted) active.controller.abort(new Error('console subscription stopped'))
      await active.dispose()
      if (notify) await send(socket, { type: 'unsubscribed', id }, maxBufferedBytes)
      return true
    }
    const stopAll = async () => {
      await Promise.all([...subscriptions.keys()].map(id => stop(id, false)))
    }
    socket.once('close', () => {
      if (!socketController.signal.aborted) socketController.abort(new Error('console socket closed'))
      void stopAll()
    })

    const handle = async (data: RawData) => {
      let message: ConsoleSubscriptionClientMessage
      try {
        message = parseMessage(data, maxMessageBytes)
      } catch (error) {
        await send(socket, { type: 'error', error: protocolError(error) }, maxBufferedBytes)
        return
      }
      if (message.type === 'unsubscribe') {
        if (!await stop(message.id, true)) {
          await send(socket, {
            type: 'error',
            id: message.id,
            error: { code: 'SUBSCRIPTION_NOT_FOUND', message: `Subscription not found: ${message.id}` },
          }, maxBufferedBytes)
        }
        return
      }
      if (subscriptions.has(message.id)) {
        await send(socket, {
          type: 'error',
          id: message.id,
          error: { code: 'SUBSCRIPTION_EXISTS', message: `Subscription already exists: ${message.id}` },
        }, maxBufferedBytes)
        return
      }
      const procedure = parseConsoleProcedureKey(message.procedure)
      if (!procedure) {
        await send(socket, {
          type: 'error',
          id: message.id,
          error: { code: 'PROCEDURE_INVALID', message: 'Procedure must use <namespace>:<procedure>@version' },
        }, maxBufferedBytes)
        return
      }

      const controller = new AbortController()
      const close = () => controller.abort(socketController.signal.reason)
      socketController.signal.addEventListener('abort', close, { once: true })
      const unlink = () => socketController.signal.removeEventListener('abort', close)
      const requestId = randomUUID()
      try {
        const dispose = await ctx.console.subscribe(procedure, message.input, {
          requestId,
          principal: identity.principal,
          ...(identity.session ? { session: identity.session } : {}),
          signal: controller.signal,
          logger: ctx.logger(`console:subscription:${requestId}`),
        }, event => send(socket, { type: 'event', id: message.id, event }, maxBufferedBytes), async () => {
          const active = subscriptions.get(message.id)
          if (!active) return
          subscriptions.delete(message.id)
          active.unlink()
          if (!active.controller.signal.aborted) {
            active.controller.abort(new Error('console subscription provider unavailable'))
          }
          await send(socket, {
            type: 'complete',
            id: message.id,
            reason: 'provider_unavailable',
          }, maxBufferedBytes)
        })
        subscriptions.set(message.id, { controller, unlink, dispose })
        await send(socket, { type: 'ready', id: message.id, requestId }, maxBufferedBytes)
      } catch (error) {
        unlink()
        if (!controller.signal.aborted) controller.abort(error)
        await send(socket, { type: 'error', id: message.id, error: protocolError(error) }, maxBufferedBytes)
      }
    }

    socket.on('message', data => {
      sequence = sequence.then(() => handle(data)).catch(error => {
        ctx.logger('console:subscription').error(error)
        socket.close(1011, 'console subscription failure')
      })
    })
  })
}

consoleWebSocketPlugin.inject = ['console', 'server']
