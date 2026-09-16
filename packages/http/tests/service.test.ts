import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { OutboundHttpService } from '../src/index.js'

const environmentName = 'NUMEN_TEST_HTTP_PROXY'
const previousEnvironment = process.env[environmentName]

afterEach(() => {
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
})
