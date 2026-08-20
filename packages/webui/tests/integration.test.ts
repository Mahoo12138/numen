import Server from '@cordisjs/plugin-server'
import {
  ConsoleService,
  SingleUserConsoleAuthService,
  consoleHttpPlugin,
  consoleSessionPlugin,
} from '@numen/console'
import { Context } from 'cordis'
import z from 'schemastery'
import { expect, it } from 'vitest'
import { BrowserConsoleClient, type BrowserConsoleEnvironment } from '../src/index.js'

it('boots a browser Cordis client and calls a real authenticated Console server', async () => {
  const server = new Context()
  await server.plugin(Server, { host: '127.0.0.1', port: 0 })
  await server.plugin(ConsoleService)
  await server.plugin(SingleUserConsoleAuthService, {
    token: 'integration-bootstrap-token',
    ownerId: 'integration-owner',
  })
  await server.plugin(consoleSessionPlugin)
  await server.plugin(consoleHttpPlugin)
  const browser = new Context()
  try {
    const query = {
      id: 'test:identity',
      version: 1,
      kind: 'query' as const,
      title: 'Identity',
      input: z.object({}),
      output: z.string(),
    }
    server.console.define(server, query)
    server.console.provideQuery(server, query, {
      query: ({ request }) => request.principal.subject.id,
    })

    const baseUrl = server.server.baseUrl
    let sessionCookie: string | undefined
    const location = { href: `${baseUrl}/#numen-bootstrap=integration-bootstrap-token` }
    const environment: BrowserConsoleEnvironment = {
      location,
      history: {
        state: null,
        replaceState(_data, _unused, url) {
          location.href = String(url)
        },
      },
      async fetch(input, init = {}) {
        const headers = new Headers(init.headers)
        if (sessionCookie) {
          headers.set('cookie', sessionCookie)
          headers.set('origin', baseUrl)
        }
        const response = await fetch(input, { ...init, headers })
        const setCookie = response.headers.get('set-cookie')
        if (setCookie) sessionCookie = setCookie.split(';')[0]
        return response
      },
    }
    await browser.plugin(BrowserConsoleClient, { environment })

    expect(location.href).toBe(`${baseUrl}/`)
    expect(browser.consoleClient.session).toMatchObject({
      principal: { subject: { id: 'integration-owner' } },
    })
    await expect(browser.consoleClient.query(query, {})).resolves.toBe('integration-owner')
    await browser.consoleClient.logout()
    expect(browser.consoleClient.session).toBeUndefined()
  } finally {
    await browser.fiber.dispose()
    await server.fiber.dispose()
  }
})
