import { Service, type Context } from 'cordis'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import z from 'schemastery'
import {
  ConsoleAuthenticationError,
  type ConsoleAuthenticationRequest,
  type ConsoleAuthenticationResult,
} from './service.js'

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
    this.sessionId = `session_${createHash('sha256').update(`session:${this.token}`).digest('hex').slice(0, 24)}`
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

  private authenticate(request: ConsoleAuthenticationRequest): ConsoleAuthenticationResult {
    request.signal.throwIfAborted()
    const authorization = request.headers.get('authorization') ?? ''
    const prefix = 'Bearer '
    const candidate = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : ''
    if (!timingSafeEqual(digest(candidate), this.tokenDigest)) {
      throw new ConsoleAuthenticationError('invalid console credentials')
    }
    return {
      principal: {
        subject: { type: 'user', id: this.ownerId },
        authenticated: true,
      },
      session: { id: this.sessionId },
    }
  }
}

export default SingleUserConsoleAuthService
