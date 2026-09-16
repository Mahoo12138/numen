import Http from '@cordisjs/plugin-http'
import * as httpSocksPlugin from '@cordisjs/plugin-http-socks'
import type { Context } from 'cordis'
import z from 'schemastery'

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
}

export class OutboundHttpService extends Http {
  static override Config: z<OutboundHttpConfig> = z.intersect([
    Http.Config,
    z.object({
      proxyAgentEnv: z.string().default('NUMEN_HTTP_PROXY').description('Environment variable containing the fallback proxy URL. Empty disables the fallback.'),
    }),
  ]) as z<OutboundHttpConfig>

  constructor(ctx: Context, config: OutboundHttpConfig = {}) {
    const {
      proxyAgentEnv = 'NUMEN_HTTP_PROXY',
      ...httpConfig
    } = config
    const environmentProxy = proxyAgentEnv
      ? process.env[proxyAgentEnv]?.trim()
      : undefined
    const proxyAgent = httpConfig.proxyAgent || environmentProxy

    super(ctx, {
      ...httpConfig,
      timeout: httpConfig.timeout ?? 30_000,
      ...(proxyAgent ? { proxyAgent } : {}),
    })
  }
}

export default OutboundHttpService
