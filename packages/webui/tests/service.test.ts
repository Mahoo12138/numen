import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserConsoleClient,
  ConsoleClientError,
  type BrowserConsoleEnvironment,
} from '../src/index.js'

const session = {
  principal: { subject: { type: 'user', id: 'owner' }, authenticated: true },
  session: { id: 'session_browser' },
}

function environment(
  href: string,
  fetch: BrowserConsoleEnvironment['fetch'],
): BrowserConsoleEnvironment & { replacements: string[] } {
  const location = { href }
  const replacements: string[] = []
  return {
    fetch,
    location,
    replacements,
    history: {
      state: { preserved: true },
      replaceState(_data, _unused, url) {
        const next = String(url)
        replacements.push(next)
        location.href = next
      },
    },
  }
}

describe('BrowserConsoleClient', () => {
  it('removes the fragment secret before exchanging a bootstrap session', async () => {
    let browser!: ReturnType<typeof environment>
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(browser.location.href).not.toContain('browser-secret')
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'include',
        headers: { authorization: 'Bearer browser-secret' },
      })
      return Response.json(session)
    }) as BrowserConsoleEnvironment['fetch']
    browser = environment(
      'http://numen.local/workbench?mode=full#view=runs&numen-bootstrap=browser-secret',
      fetch,
    )
    const root = new Context()
    await root.plugin(BrowserConsoleClient, { environment: browser })

    expect(root.consoleClient.session).toEqual(session)
    expect(browser.replacements).toEqual([
      'http://numen.local/workbench?mode=full#view=runs',
    ])
    expect(browser.location.href).not.toContain('numen-bootstrap')
    await root.fiber.dispose()
  })

  it('restores an existing cookie session without a fragment token', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'GET', credentials: 'include' })
      expect(init?.headers).toBeUndefined()
      return Response.json(session)
    }) as BrowserConsoleEnvironment['fetch']
    const browser = environment('http://numen.local/workbench#view=automations', fetch)
    const root = new Context()
    await root.plugin(BrowserConsoleClient, { environment: browser })

    expect(root.consoleClient.session).toEqual(session)
    expect(browser.replacements).toEqual([])
    await root.fiber.dispose()
  })

  it('invokes typed Query/Action calls and exposes stable transport errors', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      if (url.endsWith('/session')) return Response.json(session)
      const body = JSON.parse(String(init?.body)) as { kind: string; input: unknown }
      if (body.kind === 'query') return Response.json({ requestId: 'request-1', result: body.input })
      return Response.json({
        requestId: 'request-2',
        error: { code: 'ACTION_REJECTED', message: 'Action rejected', details: { retry: false } },
      }, { status: 409 })
    }) as BrowserConsoleEnvironment['fetch']
    const root = new Context()
    await root.plugin(BrowserConsoleClient, {
      environment: environment('http://numen.local/', fetch),
    })

    await expect(root.consoleClient.query({ id: 'test:echo', version: 1 }, { value: 'hello' }))
      .resolves.toEqual({ value: 'hello' })
    await expect(root.consoleClient.action({ id: 'test:mutate', version: 2 }, {}))
      .rejects.toMatchObject<Partial<ConsoleClientError>>({
        status: 409,
        code: 'ACTION_REJECTED',
        requestId: 'request-2',
        details: { retry: false },
      })
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
      kind: 'query', procedure: 'test:echo@1', input: { value: 'hello' },
    })
    expect(JSON.parse(String(requests[2]!.init?.body))).toEqual({
      kind: 'action', procedure: 'test:mutate@2', input: {},
    })

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(root.consoleClient.query({ id: 'test:echo', version: 1 }, {}, controller.signal))
      .rejects.toThrow('cancelled')
    expect(fetch).toHaveBeenCalledTimes(3)
    await root.fiber.dispose()
  })
})
