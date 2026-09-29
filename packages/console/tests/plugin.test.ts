import Server from '@cordisjs/plugin-server'
import { Context } from 'cordis'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import consolePlugin, { legacyConsoleBuiltins } from '../src/index.js'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
})

describe('Console product plugin', () => {
  it('owns its children and maps authenticated transport options without creating a workbench', async () => {
    const root = new Context()
    roots.push(root)
    await root.plugin(Server, { host: '127.0.0.1', port: 0 })
    const baseline = root.registry.size
    const parent = await root.plugin(consolePlugin, {
      auth: { token: 'product-console-token', ownerId: 'product-owner' },
      session: { path: '/custom/session', secureCookie: true },
      assets: { manifestPath: '/custom/entries', assetPath: '/custom/assets' },
      http: { path: '/custom/call' },
      websocket: { path: '/custom/subscribe', maxMessageBytes: 1024, maxBufferedBytes: 2048 },
    })
    await vi.waitFor(() => expect(root.consoleAuth).toBeDefined())
    for (const child of Object.values(legacyConsoleBuiltins)) {
      const fibers = root.registry.get(child)?.fibers
      expect(fibers).toHaveLength(1)
      expect([...fibers!][0]!.parent.fiber).toBe(parent)
    }
    expect(root.consoleEntries.list()).toEqual([])
    const headers = { authorization: 'Bearer product-console-token' }
    const session = await fetch(`${root.server.baseUrl}/custom/session`, { method: 'POST', headers })
    expect(session.status).toBe(200)
    expect(session.headers.get('set-cookie')).toContain('Secure')
    expect(await session.json()).toMatchObject({ principal: { subject: { id: 'product-owner' } } })
    expect((await fetch(`${root.server.baseUrl}/custom/entries`)).status).toBe(401)
    const entries = await fetch(`${root.server.baseUrl}/custom/entries`, { headers })
    expect(entries.status).toBe(200)
    expect(await entries.json()).toMatchObject({ entries: [] })
    expect((await fetch(`${root.server.baseUrl}/custom/call`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${root.server.baseUrl}/`)).status).toBe(404)
    const socket = new WebSocket(`${root.server.baseUrl.replace('http:', 'ws:')}/custom/subscribe`, { headers })
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.close()
    await closed

    await parent.dispose()
    expect(root.console).toBeUndefined()
    expect(root.consoleEntries).toBeUndefined()
    expect(root.consoleAuth).toBeUndefined()
    expect(root.registry.size).toBe(baseline)
    expect((await fetch(`${root.server.baseUrl}/custom/session`, { method: 'POST', headers })).status).toBe(404)
    expect((await fetch(`${root.server.baseUrl}/custom/entries`, { headers })).status).toBe(404)
    expect((await fetch(`${root.server.baseUrl}/custom/call`, { method: 'POST', headers })).status).toBe(404)
  })

  it('rejects disabling authentication before installing any children', async () => {
    const root = new Context()
    roots.push(root)
    await expect(root.plugin(consolePlugin, { auth: false } as never)).rejects.toThrow()
    expect(root.registry.has(legacyConsoleBuiltins.console)).toBe(false)
    expect(root.registry.has(legacyConsoleBuiltins.consoleHttp)).toBe(false)
    expect(root.registry.has(legacyConsoleBuiltins.consoleWs)).toBe(false)
  })
})
