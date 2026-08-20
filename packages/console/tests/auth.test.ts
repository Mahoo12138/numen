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
})
