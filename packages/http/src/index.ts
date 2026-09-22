import Http from '@cordisjs/plugin-http'
import * as httpSocksPlugin from '@cordisjs/plugin-http-socks'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { Dispatcher } from 'undici'
import { compileProxyBypass, ProxyRoutingDispatcher } from './proxy-routing.js'

export type { Http }
export { httpSocksPlugin }

/**
 * Host-owned defaults for the shared outbound HTTP client.
 *
 * `proxyAgent` always wins. When it is omitted, the named environment variable
 * is read once while the Runtime starts. Set `proxyAgentEnv` to an empty string
 * to disable the environment fallback.
 */
export interface OutboundHttpConfig extends Http.Config {
  proxyAgentEnv?: string
  noProxy?: string
  noProxyEnv?: string
}

export class OutboundHttpService extends Http {
  static override Config: z<OutboundHttpConfig> = z.intersect([
    Http.Config,
    z.object({
      proxyAgentEnv: z.string().default('NUMEN_HTTP_PROXY').description('Environment variable containing the fallback proxy URL. Empty disables the fallback.'),
      noProxy: z.string().description('Comma-separated direct destinations. Empty disables proxy bypass.'),
      noProxyEnv: z.string().default('NO_PROXY').description('Environment variable containing fallback direct destinations. Empty disables the fallback.'),
    }),
  ]) as z<OutboundHttpConfig>

  constructor(ctx: Context, config: OutboundHttpConfig = {}) {
    const {
      proxyAgentEnv = 'NUMEN_HTTP_PROXY',
      noProxy,
      noProxyEnv = 'NO_PROXY',
      ...httpConfig
    } = config
    const environmentProxy = proxyAgentEnv
      ? process.env[proxyAgentEnv]?.trim()
      : undefined
    const proxyAgent = httpConfig.proxyAgent || environmentProxy
    const environmentBypass = noProxyEnv
      ? process.env[noProxyEnv] ?? (noProxyEnv === 'NO_PROXY' ? process.env.no_proxy : undefined)
      : undefined
    const bypassValue = noProxy ?? environmentBypass ?? ''
    const bypass = compileProxyBypass(bypassValue)

    super(ctx, {
      ...httpConfig,
      timeout: httpConfig.timeout ?? 30_000,
      ...(proxyAgent ? { proxyAgent } : {}),
    })

    if (!bypassValue.trim()) return
    const direct = new this.undici.Agent()
    const routes = new WeakMap<Dispatcher, ProxyRoutingDispatcher>()
    const route = (init: { dispatcher?: Dispatcher }) => {
      if (!init.dispatcher) return
      let dispatcher = routes.get(init.dispatcher)
      if (!dispatcher) {
        dispatcher = new ProxyRoutingDispatcher(direct, init.dispatcher, bypass)
        routes.set(init.dispatcher, dispatcher)
      }
      init.dispatcher = dispatcher
    }
    this.ctx.effect(() => () => direct.destroy())
    this.ctx.on('http/fetch', async (_url, init, _config, next) => {
      route(init)
      return next()
    }, { prepend: true })
    this.ctx.on('http/websocket', (_url, init, _config, next) => {
      route(init)
      return next()
    }, { prepend: true })
  }

  // Reuse each plugin-owned proxy transport across requests and redirect routes.
  // Retire its sockets with the same Cordis Effect that owns its factory.
  override proxy(names: string[], factory: (url: URL) => Dispatcher) {
    const agents = new Map<string, Dispatcher>()
    const dispose = super.proxy(names, url => {
      let agent = agents.get(url.href)
      if (!agent) {
        agent = factory(url)
        agents.set(url.href, agent)
      }
      return agent
    })
    return this.ctx.effect(() => async () => {
      await dispose()
      await Promise.all([...agents.values()].map(agent => agent.destroy()))
      agents.clear()
    })
  }
}

export default OutboundHttpService
