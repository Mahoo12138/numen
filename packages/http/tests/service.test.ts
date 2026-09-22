import { Context } from 'cordis'
import { createServer } from 'node:http'
import { MockAgent } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutboundHttpService, type OutboundHttpConfig } from '../src/index.js'

const environmentName = 'NUMEN_TEST_HTTP_PROXY'
const previousEnvironment = process.env[environmentName]

afterEach(() => {
  vi.unstubAllEnvs()
  if (previousEnvironment === undefined) {
    delete process.env[environmentName]
  } else {
    process.env[environmentName] = previousEnvironment
  }
})

describe('OutboundHttpService', () => {
  it('uses an explicit proxy before the configured environment fallback', async () => {
    process.env[environmentName] = 'http://environment-proxy.invalid:8080'
    const root = new Context()
    try {
      await root.plugin(OutboundHttpService, {
        timeout: 30_000,
        proxyAgent: 'http://explicit-proxy.invalid:8080',
        proxyAgentEnv: environmentName,
      })
      expect(root.http.config).toMatchObject({
        timeout: 30_000,
        proxyAgent: 'http://explicit-proxy.invalid:8080',
      })
      expect(root.http.config).not.toHaveProperty('proxyAgentEnv')
    } finally {
      await root.fiber.dispose()
    }
  })

  it('reads the proxy environment once during Runtime startup and can disable fallback', async () => {
    process.env[environmentName] = 'http://environment-proxy.invalid:8080'
    const first = new Context()
    const second = new Context()
    try {
      await first.plugin(OutboundHttpService, { proxyAgentEnv: environmentName })
      await second.plugin(OutboundHttpService, { proxyAgentEnv: '' })
      expect(first.http.config.timeout).toBe(30_000)
      expect(first.http.config.proxyAgent).toBe('http://environment-proxy.invalid:8080')
      expect(second.http.config.proxyAgent).toBeUndefined()
    } finally {
      await Promise.all([first.fiber.dispose(), second.fiber.dispose()])
    }
  })

  it('snapshots bypass environment, honors explicit overrides, and shares routing with scoped clients', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/plain')
      response.end('direct')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')
    const origin = `http://127.0.0.1:${address.port}`
    const contexts: Context[] = []
    async function client(config: OutboundHttpConfig = {}) {
      const root = new Context()
      contexts.push(root)
      await root.plugin(OutboundHttpService, { proxyAgent: 'test://proxy', ...config })
      const proxy = new MockAgent()
      vi.spyOn(proxy, 'destroy').mockImplementation(() => proxy.close())
      proxy.disableNetConnect()
      proxy.get(origin).intercept({ path: '/', method: 'GET' }).reply(200, 'proxy', {
        headers: { 'content-type': 'text/plain' },
      }).persist()
      root.http.proxy(['test'], () => proxy)
      expect(root.http.config).not.toHaveProperty('noProxy')
      expect(root.http.config).not.toHaveProperty('noProxyEnv')
      return root.http.extend({ baseUrl: origin })
    }
    try {
      vi.stubEnv('NO_PROXY', '127.0.0.1')
      const snapshot = await client()
      vi.stubEnv('NO_PROXY', '')
      await expect(snapshot.get('/')).resolves.toBe('direct')
      await expect((await client()).get('/')).resolves.toBe('proxy')
      vi.stubEnv('NO_PROXY', '*')
      await expect((await client({ noProxy: '' })).get('/')).resolves.toBe('proxy')
      await expect((await client({ noProxyEnv: '' })).get('/')).resolves.toBe('proxy')
      vi.stubEnv('NUMEN_TEST_NO_PROXY', '127.0.0.1')
      await expect((await client({ noProxyEnv: 'NUMEN_TEST_NO_PROXY' })).get('/')).resolves.toBe('direct')
      vi.stubEnv('NO_PROXY', undefined)
      vi.stubEnv('no_proxy', '127.0.0.1')
      await expect((await client()).get('/')).resolves.toBe('direct')
      vi.stubEnv('NO_PROXY', '')
      await expect((await client()).get('/')).resolves.toBe('proxy')
      await expect((await client({ noProxy: '127.0.0.1' })).get('/')).resolves.toBe('direct')
    } finally {
      await Promise.all(contexts.map(root => root.fiber.dispose()))
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('reuses plugin proxy transports and destroys them when the registration is disposed', async () => {
    const root = new Context()
    const proxy = new MockAgent()
    const destroyed = vi.spyOn(proxy, 'destroy').mockImplementation(() => proxy.close())
    const factory = vi.fn(() => proxy)
    proxy.disableNetConnect()
    proxy.get('http://service.test').intercept({ path: '/', method: 'GET' }).reply(200, 'ok').persist()
    try {
      await root.plugin(OutboundHttpService, { proxyAgent: 'test://proxy', noProxy: 'localhost' })
      const dispose = root.http.proxy(['test'], factory)
      await root.http.get('http://service.test/', { responseType: 'text' })
      await root.http.get('http://service.test/', { responseType: 'text' })
      expect(factory).toHaveBeenCalledTimes(1)
      expect(destroyed).not.toHaveBeenCalled()
      await dispose()
      expect(destroyed).toHaveBeenCalledTimes(1)
      await expect(root.http.get('http://service.test/')).rejects.toThrow('Cannot resolve proxy agent')
    } finally {
      await root.fiber.dispose()
    }
    expect(destroyed).toHaveBeenCalledTimes(1)
  })
})
