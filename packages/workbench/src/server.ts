import type { Request, Response } from '@cordisjs/plugin-server'
import type { Context } from 'cordis'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WorkbenchServerConfig {
  root?: string
  assetPath?: string
}

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const workbenchRoute = /^\/(?:|automations(?:\/.*)?|runs(?:\/.*)?|connections(?:\/.*)?|plugins(?:\/.*)?|system(?:\/.*)?)$/
const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

function normalizeAssetPath(path: string): string {
  const result = path.replace(/\/$/, '')
  if (!result.startsWith('/') || result.includes('?') || result.includes('#') || result === '') {
    throw new TypeError('Workbench assetPath must be an absolute URL path')
  }
  return result
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isWithin(root: string, filename: string): boolean {
  const path = relative(root, filename)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function secureHeaders(response: Response): void {
  response.headers.set('cross-origin-opener-policy', 'same-origin')
  response.headers.set('cross-origin-resource-policy', 'same-origin')
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()')
  response.headers.set('referrer-policy', 'no-referrer')
  response.headers.set('x-content-type-options', 'nosniff')
  response.headers.set('x-frame-options', 'DENY')
}

async function readWithin(root: string, requestedPath: string): Promise<{ data: Uint8Array; filename: string }> {
  const candidate = resolve(root, requestedPath)
  if (!isWithin(root, candidate)) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)])
  if (!isWithin(realRoot, realCandidate) || !(await stat(realCandidate)).isFile()) {
    throw Object.assign(new Error('not found'), { code: 'ENOENT' })
  }
  return { data: await readFile(realCandidate), filename: realCandidate }
}

function notFound(response: Response): void {
  response.status = 404
}

export function workbenchServerPlugin(ctx: Context, config: WorkbenchServerConfig = {}): void {
  const root = resolve(config.root ?? fileURLToPath(new URL('./app/', import.meta.url)))
  const assetPath = normalizeAssetPath(config.assetPath ?? '/workbench')
  const assetPattern = new RegExp(`^${escapeRegExp(assetPath)}/(.+)$`)

  const serveIndex = async (_request: Request, response: Response) => {
    secureHeaders(response)
    response.headers.set('cache-control', 'no-store')
    response.headers.set('content-security-policy', contentSecurityPolicy)
    response.headers.set('content-type', mimeTypes['.html']!)
    try {
      const { data } = await readWithin(root, 'index.html')
      response.text(Buffer.from(data).toString('utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      response.status = 503
      response.text('Workbench build is unavailable')
    }
  }

  ctx.server.get(workbenchRoute, serveIndex)
  ctx.server.get(assetPattern, async (request, response) => {
    let requestedPath: string
    try {
      requestedPath = decodeURIComponent(request.params[1] ?? '')
    } catch {
      notFound(response)
      return
    }
    try {
      const { data, filename } = await readWithin(root, requestedPath)
      secureHeaders(response)
      const hashed = /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(filename)
      response.headers.set('cache-control', hashed
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate')
      response.headers.set('content-type', mimeTypes[extname(filename).toLowerCase()] ?? 'application/octet-stream')
      response.bytes(data)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        notFound(response)
        return
      }
      throw error
    }
  })
}

workbenchServerPlugin.inject = ['server']

export default workbenchServerPlugin
