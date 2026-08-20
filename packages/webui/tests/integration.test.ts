import Server from '@cordisjs/plugin-server'
import {
  ConsoleService,
  SingleUserConsoleAuthService,
  consoleHttpPlugin,
  consoleSessionPlugin,
  consoleWebSocketPlugin,
} from '@numen/console'
import { Context } from 'cordis'
import z from 'schemastery'
import { expect, it, vi } from 'vitest'
import NodeWebSocket from 'ws'
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
  await server.plugin(consoleWebSocketPlugin)
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
    const updates = {
      id: 'test:updates',
      version: 1,
      kind: 'subscription' as const,
      title: 'Updates',
      input: z.object({}),
      event: z.number(),
    }
    let publish: ((event: number) => void | Promise<void>) | undefined
    server.console.define(server, updates)
    server.console.provideSubscription(server, updates, {
      subscribe({ emit }) {
        publish = emit
        return () => {
          publish = undefined
        }
      },
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
    await browser.plugin(BrowserConsoleClient, {
      environment,
      createWebSocket: url => {
        if (!sessionCookie) throw new Error('browser session cookie missing')
        return new NodeWebSocket(url, {
          headers: { cookie: sessionCookie, origin: baseUrl },
        }) as unknown as WebSocket
      },
    })

    expect(location.href).toBe(`${baseUrl}/`)
    expect(browser.consoleClient.session).toMatchObject({
      principal: { subject: { id: 'integration-owner' } },
    })
    await expect(browser.consoleClient.query(query, {})).resolves.toBe('integration-owner')
    const events: number[] = []
    const unsubscribe = await browser.consoleClient.subscribe(updates, {}, {
      event: value => events.push(value),
    })
    await publish?.(9)
    await vi.waitFor(() => expect(events).toEqual([9]))
    unsubscribe()
    await browser.consoleClient.logout()
    expect(browser.consoleClient.session).toBeUndefined()
  } finally {
    await browser.fiber.dispose()
    await server.fiber.dispose()
  }
})
