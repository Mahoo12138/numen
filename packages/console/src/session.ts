import type { Context } from 'cordis'
import { consoleSessionCookieName } from './auth.js'
import { ConsoleAuthenticationError, type ConsoleAuthenticationResult } from './service.js'

export interface ConsoleSessionConfig {
  path?: string
  secureCookie?: boolean
}

export interface ConsoleSessionDocument {
  principal: ConsoleAuthenticationResult['principal']
  session: NonNullable<ConsoleAuthenticationResult['session']>
}

function cookie(value: string, secure: boolean, clear = false): string {
  return [
    `${consoleSessionCookieName}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/api/console',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
    ...(clear ? ['Max-Age=0'] : []),
  ].join('; ')
}

export function consoleSessionPlugin(ctx: Context, config: ConsoleSessionConfig = {}): void {
  const path = config.path ?? '/api/console/session'
  const secure = config.secureCookie ?? false
  ctx.server.post(path, async (request, response) => {
    try {
      const { cookieValue, identity } = ctx.consoleAuth.exchangeBootstrapToken(request.headers)
      response.headers.set('set-cookie', cookie(cookieValue, secure))
      response.headers.set('cache-control', 'no-store')
      response.json({
        principal: identity.principal,
        session: identity.session!,
      } satisfies ConsoleSessionDocument)
    } catch (error) {
      if (!(error instanceof ConsoleAuthenticationError)) throw error
      response.status = 401
      response.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: error.message } })
    }
  })

  ctx.server.delete(path, async (request, response) => {
    const controller = new AbortController()
    try {
      await ctx.console.authenticate({
        method: request.method,
        path: request.path,
        headers: request.headers,
        ...(request._req.socket.remoteAddress ? { remoteAddress: request._req.socket.remoteAddress } : {}),
        signal: controller.signal,
      })
    } catch (error) {
      if (!(error instanceof ConsoleAuthenticationError)) throw error
      response.status = 401
      response.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: error.message } })
      return
    }
    response.headers.set('set-cookie', cookie('', secure, true))
    response.headers.set('cache-control', 'no-store')
    response.status = 204
  })
}

consoleSessionPlugin.inject = ['console', 'consoleAuth', 'server']
