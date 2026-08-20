import type { Request, Response } from '@cordisjs/plugin-server'
import type { Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import z from 'schemastery'
import {
  ConsoleAuthenticationError,
  ConsoleAuthenticatorUnavailableError,
  ConsoleProcedureKindError,
  ConsoleProcedureNotFoundError,
  ConsoleProcedureUnavailableError,
  parseConsoleProcedureKey,
  type ConsoleProcedureKind,
} from './service.js'

export interface ConsoleCallRequest {
  kind: 'query' | 'action'
  procedure: string
  input: unknown
}

export interface ConsoleCallSuccess {
  requestId: string
  result: unknown
}

export interface ConsoleCallFailure {
  requestId: string
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export interface ConsoleHttpConfig {
  path?: string
}

const callSchema = z.object({
  kind: z.union(['query', 'action']).required(),
  procedure: z.string().required(),
  input: z.any().required(),
})

function errorDocument(
  requestId: string,
  code: string,
  message: string,
  details?: unknown,
): ConsoleCallFailure {
  return {
    requestId,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  }
}

function respondError(
  response: Response,
  requestId: string,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  response.status = status
  response.json(errorDocument(requestId, code, message, details))
}

function createAbortController(request: Request, response: Response): {
  controller: AbortController
  dispose(): void
} {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error('console client disconnected'))
  }
  const close = () => {
    if (!response._res.writableEnded) abort()
  }
  request._req.once('aborted', abort)
  response._res.once('close', close)
  return {
    controller,
    dispose() {
      request._req.off('aborted', abort)
      response._res.off('close', close)
    },
  }
}

async function readCall(request: Request): Promise<ConsoleCallRequest> {
  const value = await request.json()
  return callSchema(value) as ConsoleCallRequest
}

async function handleCall(ctx: Context, request: Request, response: Response): Promise<void> {
  const requestId = randomUUID()
  const { controller, dispose } = createAbortController(request, response)
  const logger = ctx.logger(`console:request:${requestId}`)
  response.headers.set('cache-control', 'no-store')
  response.headers.set('x-request-id', requestId)

  try {
    const identity = await ctx.console.authenticate({
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(request._req.socket.remoteAddress ? { remoteAddress: request._req.socket.remoteAddress } : {}),
      signal: controller.signal,
    })
    let call: ConsoleCallRequest
    try {
      call = await readCall(request)
    } catch (error) {
      if (error instanceof z.ValidationError) {
        respondError(response, requestId, 422, 'INPUT_INVALID', 'Console call envelope is invalid', error.message)
      } else {
        respondError(response, requestId, 400, 'JSON_INVALID', 'Request body must be valid JSON')
      }
      return
    }
    const procedure = parseConsoleProcedureKey(call.procedure)
    if (!procedure) {
      respondError(response, requestId, 400, 'PROCEDURE_INVALID', 'Procedure must use <namespace>:<procedure>@version')
      return
    }
    const context = {
      requestId,
      principal: identity.principal,
      ...(identity.session ? { session: identity.session } : {}),
      signal: controller.signal,
      logger,
    }
    const result = call.kind === 'query'
      ? await ctx.console.query(procedure, call.input, context)
      : await ctx.console.action(procedure, call.input, context)
    response.json({ requestId, result } satisfies ConsoleCallSuccess)
  } catch (error) {
    if (controller.signal.aborted) return
    if (error instanceof ConsoleAuthenticationError) {
      respondError(response, requestId, 401, 'AUTHENTICATION_REQUIRED', error.message)
    } else if (error instanceof ConsoleAuthenticatorUnavailableError) {
      respondError(response, requestId, 503, 'AUTHENTICATOR_UNAVAILABLE', error.message)
    } else if (error instanceof ConsoleProcedureNotFoundError) {
      respondError(response, requestId, 404, 'PROCEDURE_NOT_FOUND', error.message)
    } else if (error instanceof ConsoleProcedureKindError) {
      respondError(response, requestId, 409, 'PROCEDURE_KIND_MISMATCH', error.message)
    } else if (error instanceof ConsoleProcedureUnavailableError) {
      respondError(response, requestId, 503, 'PROCEDURE_UNAVAILABLE', error.message)
    } else if (error instanceof z.ValidationError) {
      respondError(response, requestId, 422, 'PROCEDURE_VALIDATION_FAILED', error.message)
    } else {
      logger.error(error)
      respondError(response, requestId, 500, 'INTERNAL_ERROR', 'Console procedure failed')
    }
  } finally {
    dispose()
  }
}

export function consoleHttpPlugin(ctx: Context, config: ConsoleHttpConfig = {}): void {
  ctx.server.post(config.path ?? '/api/console/call', async (request, response) => {
    await handleCall(ctx, request, response)
  })
}

consoleHttpPlugin.inject = ['console', 'server']
