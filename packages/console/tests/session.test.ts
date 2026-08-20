import Server from '@cordisjs/plugin-server'
import { Context } from 'cordis'
import z from 'schemastery'
import { describe, expect, it } from 'vitest'
import {
  ConsoleService,
  SingleUserConsoleAuthService,
  consoleHttpPlugin,
  consoleSessionPlugin,
} from '../src/index.js'

describe('Console browser session bootstrap', () => {
  it('exchanges a bootstrap bearer for an HttpOnly same-origin session cookie', async () => {
    const root = new Context()
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    await root.plugin(ConsoleService)
    await root.plugin(SingleUserConsoleAuthService, {
      token: 'browser-bootstrap-token',
      ownerId: 'browser-owner',
    })
    await root.plugin(consoleSessionPlugin)
    await root.plugin(consoleHttpPlugin)
    try {
      const query = {
        id: 'test:browser-user',
        version: 1,
        kind: 'query' as const,
        title: 'Browser user',
        input: z.object({}),
        output: z.string(),
      }
      root.console.define(root, query)
      root.console.provideQuery(root, query, {
        query: ({ request }) => request.principal.subject.id,
      })
      const baseUrl = root.server.baseUrl
      const rejected = await fetch(`${baseUrl}/api/console/session`, { method: 'POST' })
      expect(rejected.status).toBe(401)

      const bootstrap = await fetch(`${baseUrl}/api/console/session`, {
        method: 'POST',
        headers: { authorization: 'Bearer browser-bootstrap-token' },
      })
      expect(bootstrap.status).toBe(200)
      const documentText = await bootstrap.text()
      expect(JSON.parse(documentText)).toMatchObject({
        principal: { subject: { type: 'user', id: 'browser-owner' }, authenticated: true },
        session: { id: expect.stringMatching(/^session_/) },
      })
      expect(documentText).not.toContain('browser-bootstrap-token')
      const setCookie = bootstrap.headers.get('set-cookie')!
      expect(setCookie).toContain('numen_console_session=')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      expect(setCookie).toContain('Path=/api/console')
      const sessionCookie = setCookie.split(';')[0]!

      const restored = await fetch(`${baseUrl}/api/console/session`, {
        headers: { cookie: sessionCookie, 'sec-fetch-site': 'same-origin' },
      })
      expect(restored.status).toBe(200)
      expect(await restored.json()).toMatchObject({
        principal: { subject: { id: 'browser-owner' } },
      })

      const call = (origin: string) => fetch(`${baseUrl}/api/console/call`, {
        method: 'POST',
        headers: {
          cookie: sessionCookie,
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ kind: 'query', procedure: 'test:browser-user@1', input: {} }),
      })
      const authenticated = await call(baseUrl)
      expect(authenticated.status).toBe(200)
      expect(await authenticated.json()).toMatchObject({ result: 'browser-owner' })
      expect((await call('http://127.0.0.1:9999')).status).toBe(401)

      const logout = await fetch(`${baseUrl}/api/console/session`, {
        method: 'DELETE',
        headers: { cookie: sessionCookie, origin: baseUrl },
      })
      expect(logout.status).toBe(204)
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    } finally {
      await root.fiber.dispose()
    }
  })

  it('can mark browser session cookies Secure for TLS deployments', async () => {
    const root = new Context()
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    await root.plugin(ConsoleService)
    await root.plugin(SingleUserConsoleAuthService, { token: 'secure-token' })
    await root.plugin(consoleSessionPlugin, { secureCookie: true })
    try {
      const response = await fetch(`${root.server.baseUrl}/api/console/session`, {
        method: 'POST',
        headers: { authorization: 'Bearer secure-token' },
      })
      expect(response.headers.get('set-cookie')).toContain('Secure')
    } finally {
      await root.fiber.dispose()
    }
  })
})
