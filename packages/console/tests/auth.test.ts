import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  ConsoleAuthenticationError,
  ConsoleAuthenticatorUnavailableError,
  ConsoleService,
  SingleUserConsoleAuthService,
} from '../src/index.js'

function request(token: string) {
  return {
    method: 'POST',
    path: '/api/console/call',
    headers: new Headers({ authorization: `Bearer ${token}` }),
    remoteAddress: '127.0.0.1',
    signal: new AbortController().signal,
  }
}

describe('SingleUserConsoleAuthService', () => {
  it('authenticates a fixed bearer token as the configured owner', async () => {
    const root = new Context()
    await root.plugin(ConsoleService)
    const auth = await root.plugin(SingleUserConsoleAuthService, {
      token: 'test-console-token',
      ownerId: 'miles',
    })

    await expect(root.console.authenticate(request('test-console-token'))).resolves.toEqual({
      principal: {
        subject: { type: 'user', id: 'miles' },
        authenticated: true,
      },
      session: expect.objectContaining({ id: expect.stringMatching(/^session_/) }),
    })
    await expect(root.console.authenticate(request('wrong-token')))
      .rejects.toThrow(ConsoleAuthenticationError)

    await auth.dispose()
    await expect(root.console.authenticate(request('test-console-token')))
      .rejects.toThrow(ConsoleAuthenticatorUnavailableError)
    await root.fiber.dispose()
  })

  it('generates an in-memory bootstrap token when none is configured', async () => {
    const root = new Context()
    await root.plugin(ConsoleService)
    await root.plugin(SingleUserConsoleAuthService)
    const token = root.consoleAuth.getBootstrapToken()

    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    await expect(root.console.authenticate(request(token))).resolves.toMatchObject({
      principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
    })
    await root.fiber.dispose()
  })

  it('accepts browser session cookies only for matching Origin and Host', async () => {
    const root = new Context()
    await root.plugin(ConsoleService)
    await root.plugin(SingleUserConsoleAuthService, { token: 'bootstrap-token' })
    const { cookieValue } = root.consoleAuth.exchangeBootstrapToken(
      new Headers({ authorization: 'Bearer bootstrap-token' }),
    )
    const browserRequest = {
      method: 'POST',
      path: '/api/console/call',
      headers: new Headers({
        cookie: `numen_console_session=${cookieValue}`,
        host: '127.0.0.1:5140',
        origin: 'http://127.0.0.1:5140',
      }),
      signal: new AbortController().signal,
    }

    await expect(root.console.authenticate(browserRequest)).resolves.toMatchObject({
      principal: { authenticated: true },
    })
    browserRequest.headers.set('origin', 'http://127.0.0.1:9999')
    await expect(root.console.authenticate(browserRequest)).rejects.toThrow(ConsoleAuthenticationError)
    browserRequest.headers.delete('origin')
    await expect(root.console.authenticate(browserRequest)).rejects.toThrow(ConsoleAuthenticationError)
    await root.fiber.dispose()
  })
})
