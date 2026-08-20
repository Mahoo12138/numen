import { Service, type Context } from 'cordis'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import z from 'schemastery'
import {
  ConsoleAuthenticationError,
  type ConsoleAuthenticationRequest,
  type ConsoleAuthenticationResult,
} from './service.js'

export const consoleSessionCookieName = 'numen_console_session'

export interface SingleUserConsoleAuthConfig {
  token?: string
  ownerId?: string
}

declare module 'cordis' {
  interface Context {
    consoleAuth: SingleUserConsoleAuthService
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export class SingleUserConsoleAuthService extends Service {
  static inject = ['console']
  static Config = z.object({
    token: z.string().role('secret').description('Fixed bearer token. Generated in memory when omitted.'),
    ownerId: z.string().default('owner').description('Subject ID for the single authenticated owner.'),
  })

  private readonly token: string
  private readonly tokenDigest: Buffer
  private readonly browserSessionToken: string
  private readonly browserSessionDigest: Buffer
  private readonly sessionId: string
  private readonly ownerId: string

  constructor(ctx: Context, config: SingleUserConsoleAuthConfig = {}) {
    super(ctx, 'consoleAuth')
    const configuredToken = config.token?.trim()
    if (config.token !== undefined && !configuredToken) {
      throw new TypeError('console auth token must not be empty')
    }
    this.token = configuredToken ?? randomBytes(32).toString('base64url')
    this.tokenDigest = digest(this.token)
    this.browserSessionToken = randomBytes(32).toString('base64url')
    this.browserSessionDigest = digest(this.browserSessionToken)
    this.sessionId = `session_${createHash('sha256').update(this.browserSessionToken).digest('hex').slice(0, 24)}`
    this.ownerId = config.ownerId?.trim() || 'owner'
  }

  *[Service.init]() {
    yield this.ctx.console.provideAuthenticator(this.ctx, {
      authenticate: request => this.authenticate(request),
    })
  }

  getBootstrapToken(): string {
    return this.token
  }

  exchangeBootstrapToken(headers: Headers): { cookieValue: string; identity: ConsoleAuthenticationResult } {
    const candidate = this.readBearer(headers)
    if (!timingSafeEqual(digest(candidate), this.tokenDigest)) {
      throw new ConsoleAuthenticationError('invalid console credentials')
    }
    return { cookieValue: this.browserSessionToken, identity: this.identity() }
  }

  private authenticate(request: ConsoleAuthenticationRequest): ConsoleAuthenticationResult {
    request.signal.throwIfAborted()
    const bearer = this.readBearer(request.headers)
    if (timingSafeEqual(digest(bearer), this.tokenDigest)) return this.identity()
    const cookie = this.readCookie(request.headers)
    if (!this.hasSameOrigin(request.headers) || !timingSafeEqual(digest(cookie), this.browserSessionDigest)) {
      throw new ConsoleAuthenticationError('invalid console credentials')
    }
    return this.identity()
  }

  private identity(): ConsoleAuthenticationResult {
    return {
      principal: {
        subject: { type: 'user', id: this.ownerId },
        authenticated: true,
      },
      session: { id: this.sessionId },
    }
  }

  private readBearer(headers: Headers): string {
    const authorization = headers.get('authorization') ?? ''
    return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
  }

  private readCookie(headers: Headers): string {
    const source = headers.get('cookie') ?? ''
    for (const part of source.split(';')) {
      const separator = part.indexOf('=')
      if (separator < 0 || part.slice(0, separator).trim() !== consoleSessionCookieName) continue
      try {
        return decodeURIComponent(part.slice(separator + 1).trim())
      } catch {
        return ''
      }
    }
    return ''
  }

  private hasSameOrigin(headers: Headers): boolean {
    const origin = headers.get('origin')
    const host = headers.get('host')
    if (!origin) return headers.get('sec-fetch-site') === 'same-origin'
    if (!host) return false
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
}

export default SingleUserConsoleAuthService
