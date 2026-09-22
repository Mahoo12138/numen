import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { Dispatcher } from 'undici'

interface BypassRule {
  hostname: string
  port?: string
  subdomainsOnly: boolean
  ip: boolean
}

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1)
  }
  if (isIP(hostname) === 6) return new URL(`http://[${hostname}]`).hostname
  return domainToASCII(hostname).toLowerCase().replace(/\.$/, '')
}

/** Compile once at startup; never resolve DNS or include configuration in errors. */
export function compileProxyBypass(value: string): (url: URL) => boolean {
  const tokens = value.split(/[\s,]+/).filter(Boolean)
  const rules: BypassRule[] = []
  for (const token of tokens) {
    if (token === '*') continue
    let hostname = token
    let port: string | undefined
    const address = /^(\[[^\]]+\])(?::(\d+))?$/.exec(token)
    if (address) {
      hostname = address[1]!
      port = address[2]
      if (isIP(hostname.slice(1, -1)) !== 6) throw new Error('Invalid HTTP noProxy rule')
    } else if (!isIP(token) && token.includes(':')) {
      const qualified = /^([^:]+):(\d+)$/.exec(token)
      if (!qualified) throw new Error('Invalid HTTP noProxy rule')
      hostname = qualified[1]!
      port = qualified[2]!
    }
    if (port !== undefined) {
      const number = Number(port)
      if (number < 1 || number > 65535) throw new Error('Invalid HTTP noProxy port')
      port = String(number)
    }
    const subdomainsOnly = hostname.startsWith('*.')
    hostname = hostname.replace(/^(\*\.|\.)/, '')
    const ip = !!isIP(hostname.replace(/^\[|\]$/g, ''))
    if (!ip && /[\/:@?#\[\]*%]/.test(hostname)) throw new Error('Invalid HTTP noProxy rule')
    hostname = normalizeHostname(hostname)
    if (!hostname || (!ip && hostname.split('.').some(label => !/^[a-z0-9_-]+$/.test(label)))) {
      throw new Error('Invalid HTTP noProxy rule')
    }
    rules.push({ hostname, ...(port === undefined ? {} : { port }), subdomainsOnly, ip })
  }
  const all = tokens.includes('*')
  return url => {
    const hostname = normalizeHostname(url.hostname)
    const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80')
    return all || rules.some(rule => (!rule.port || rule.port === port) && (
      (!rule.subdomainsOnly && hostname === rule.hostname)
      || (!rule.ip && hostname.endsWith(`.${rule.hostname}`))
    ))
  }
}

/** Undici dispatches every redirect separately, so routing follows each origin. */
export class ProxyRoutingDispatcher extends Dispatcher {
  constructor(
    private readonly direct: Dispatcher,
    private readonly proxy: Dispatcher,
    private readonly bypass: (url: URL) => boolean,
  ) {
    super()
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (!options.origin) return this.proxy.dispatch(options, handler)
    const target = new URL(options.origin)
    return (this.bypass(target) ? this.direct : this.proxy).dispatch(options, handler)
  }
}
