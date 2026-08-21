import Server from '@cordisjs/plugin-server'
import { Context } from 'cordis'
import z from 'schemastery'
import { describe, expect, it, vi } from 'vitest'
import {
  ConsoleAuthenticationError,
  ConsoleProcedureError,
  ConsoleService,
  consoleHttpPlugin,
  type ConsoleAuthenticationRequest,
} from '../src/index.js'

async function createContext(): Promise<{ root: Context; baseUrl: string }> {
  const root = new Context()
  await root.plugin(Server, { host: '127.0.0.1', port: 0 })
  await root.plugin(ConsoleService)
  return { root, baseUrl: root.server.baseUrl }
}

function call(
  baseUrl: string,
  body: unknown,
  options: { token?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/console/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

function authenticate(requests: ConsoleAuthenticationRequest[]) {
  return ({ headers, ...request }: ConsoleAuthenticationRequest) => {
    requests.push({ headers, ...request })
    if (headers.get('authorization') !== 'Bearer secret') {
      throw new ConsoleAuthenticationError('invalid console credentials')
    }
    return {
      principal: {
        subject: { type: 'user', id: 'server-owner' },
        authenticated: true,
      },
      session: { id: 'server-session' },
    }
  }
}

describe('Console HTTP transport', () => {
  it('builds trusted request context and invokes typed Query and Action procedures', async () => {
    const { root, baseUrl } = await createContext()
    try {
      const authenticationRequests: ConsoleAuthenticationRequest[] = []
      root.console.provideAuthenticator(root, { authenticate: authenticate(authenticationRequests) })
      const query = {
        id: 'test:whoami',
        version: 1,
        kind: 'query' as const,
        title: 'Who am I',
        input: z.object({ value: z.string().required() }),
        output: z.object({
          value: z.string().required(),
          principal: z.string().required(),
          session: z.string().required(),
          requestId: z.string().required(),
        }),
      }
      const action = {
        id: 'test:uppercase',
        version: 1,
        kind: 'action' as const,
        title: 'Uppercase',
        input: z.string(),
        output: z.string(),
      }
      const queryProvider = vi.fn(({ input, request }) => ({
        value: input.value,
        principal: request.principal.subject.id,
        session: request.session?.id ?? '',
        requestId: request.requestId,
      }))
      root.console.define(root, query)
      root.console.provideQuery(root, query, { query: queryProvider })
      root.console.define(root, action)
      root.console.provideAction(root, action, { action: ({ input }) => input.toUpperCase() })
      const transport = await root.plugin(consoleHttpPlugin)

      const response = await call(baseUrl, {
        kind: 'query',
        procedure: 'test:whoami@1',
        input: { value: 'hello', principal: 'client-forged' },
        principal: { subject: { type: 'user', id: 'attacker' }, authenticated: true },
      }, { token: 'secret' })
      expect(response.status).toBe(200)
      const document = await response.json() as { requestId: string; result: Record<string, string> }
      expect(document.result).toEqual({
        value: 'hello',
        principal: 'server-owner',
        session: 'server-session',
        requestId: document.requestId,
      })
      expect(response.headers.get('x-request-id')).toBe(document.requestId)
      expect(authenticationRequests[0]).toMatchObject({
        method: 'POST',
        path: '/api/console/call',
        remoteAddress: '127.0.0.1',
      })

      const actionResponse = await call(baseUrl, {
        kind: 'action',
        procedure: 'test:uppercase@1',
        input: 'hello',
      }, { token: 'secret' })
      expect(actionResponse.status).toBe(200)
      expect(await actionResponse.json()).toMatchObject({ result: 'HELLO' })

      const unauthorized = await call(baseUrl, {
        kind: 'query', procedure: 'test:whoami@1', input: { value: 'ignored' },
      })
      expect(unauthorized.status).toBe(401)
      expect(await unauthorized.json()).toMatchObject({
        error: { code: 'AUTHENTICATION_REQUIRED' },
      })
      expect(queryProvider).toHaveBeenCalledTimes(1)

      await transport.dispose()
      expect((await call(baseUrl, {
        kind: 'query', procedure: 'test:whoami@1', input: { value: 'ignored' },
      }, { token: 'secret' })).status).toBe(404)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('maps protocol, validation, availability, and provider errors without leaking internals', async () => {
    const { root, baseUrl } = await createContext()
    try {
      const authenticationRequests: ConsoleAuthenticationRequest[] = []
      const disposeAuthenticator = root.console.provideAuthenticator(root, {
        authenticate: authenticate(authenticationRequests),
      })
      const query = {
        id: 'test:number',
        version: 1,
        kind: 'query' as const,
        title: 'Number',
        input: z.object({ value: z.number().required() }),
        output: z.number(),
      }
      const unavailable = {
        id: 'test:unavailable',
        version: 1,
        kind: 'action' as const,
        title: 'Unavailable',
        input: z.object({}),
        output: z.object({}),
      }
      const failing = {
        id: 'test:failing',
        version: 1,
        kind: 'action' as const,
        title: 'Failing',
        input: z.object({}),
        output: z.object({}),
      }
      const expectedFailure = {
        id: 'test:expected-failure',
        version: 1,
        kind: 'action' as const,
        title: 'Expected failure',
        input: z.object({}),
        output: z.object({}),
      }
      root.console.define(root, query)
      root.console.provideQuery(root, query, { query: ({ input }) => input.value })
      root.console.define(root, unavailable)
      root.console.define(root, failing)
      root.console.define(root, expectedFailure)
      root.console.provideAction(root, failing, {
        action() {
          throw new Error('private provider details')
        },
      })
      root.console.provideAction(root, expectedFailure, {
        action() {
          throw new ConsoleProcedureError(409, 'VERSION_CONFLICT', 'The document changed', {
            expectedVersion: 2,
            actualVersion: 3,
          })
        },
      })
      await root.plugin(consoleHttpPlugin)

      const cases: Array<[unknown, number, string]> = [
        [{ kind: 'query', procedure: 'invalid', input: {} }, 400, 'PROCEDURE_INVALID'],
        [{ kind: 'query', procedure: 'test:missing@1', input: {} }, 404, 'PROCEDURE_NOT_FOUND'],
        [{ kind: 'action', procedure: 'test:number@1', input: { value: 1 } }, 409, 'PROCEDURE_KIND_MISMATCH'],
        [{ kind: 'query', procedure: 'test:number@1', input: { value: 'bad' } }, 422, 'PROCEDURE_VALIDATION_FAILED'],
        [{ kind: 'action', procedure: 'test:unavailable@1', input: {} }, 503, 'PROCEDURE_UNAVAILABLE'],
      ]
      for (const [body, status, code] of cases) {
        const response = await call(baseUrl, body, { token: 'secret' })
        expect(response.status).toBe(status)
        expect(await response.json()).toMatchObject({ error: { code } })
      }

      const failed = await call(baseUrl, {
        kind: 'action', procedure: 'test:failing@1', input: {},
      }, { token: 'secret' })
      expect(failed.status).toBe(500)
      const failedText = await failed.text()
      expect(failedText).toContain('INTERNAL_ERROR')
      expect(failedText).not.toContain('private provider details')

      const expected = await call(baseUrl, {
        kind: 'action', procedure: 'test:expected-failure@1', input: {},
      }, { token: 'secret' })
      expect(expected.status).toBe(409)
      expect(await expected.json()).toMatchObject({
        error: {
          code: 'VERSION_CONFLICT',
          message: 'The document changed',
          details: { expectedVersion: 2, actualVersion: 3 },
        },
      })

      const invalidJson = await fetch(`${baseUrl}/api/console/call`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: '{',
      })
      expect(invalidJson.status).toBe(400)
      expect(await invalidJson.json()).toMatchObject({ error: { code: 'JSON_INVALID' } })

      await disposeAuthenticator()
      const noAuthenticator = await call(baseUrl, {
        kind: 'query', procedure: 'test:number@1', input: { value: 1 },
      }, { token: 'secret' })
      expect(noAuthenticator.status).toBe(503)
      expect(await noAuthenticator.json()).toMatchObject({
        error: { code: 'AUTHENTICATOR_UNAVAILABLE' },
      })
    } finally {
      await root.fiber.dispose()
    }
  })

  it('propagates client disconnects through the procedure AbortSignal', async () => {
    const { root, baseUrl } = await createContext()
    try {
      root.console.provideAuthenticator(root, { authenticate: authenticate([]) })
      const action = {
        id: 'test:long-action',
        version: 1,
        kind: 'action' as const,
        title: 'Long action',
        input: z.object({}),
        output: z.string(),
      }
      root.console.define(root, action)
      let notifyStarted!: () => void
      const started = new Promise<void>(resolve => {
        notifyStarted = resolve
      })
      let notifyAborted!: () => void
      const aborted = new Promise<void>(resolve => {
        notifyAborted = resolve
      })
      root.console.provideAction(root, action, {
        action({ request }) {
          notifyStarted()
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              notifyAborted()
              reject(request.signal.reason)
            }, { once: true })
          })
        },
      })
      await root.plugin(consoleHttpPlugin)
      const controller = new AbortController()
      const pending = call(baseUrl, {
        kind: 'action', procedure: 'test:long-action@1', input: {},
      }, { token: 'secret', signal: controller.signal })
      await started
      controller.abort()

      await expect(pending).rejects.toThrow()
      await expect(aborted).resolves.toBeUndefined()
    } finally {
      await root.fiber.dispose()
    }
  })
})
