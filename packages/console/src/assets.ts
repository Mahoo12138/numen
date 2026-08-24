import type { Request, Response } from '@cordisjs/plugin-server'
import type { Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConsoleAuthenticationError,
  ConsoleAuthenticatorUnavailableError,
} from './service.js'

export interface ConsoleAssetConfig {
  mode?: 'dev' | 'prod'
  manifestPath?: string
  assetPath?: string
}

export interface ConsoleEntryManifestItem {
  id: string
  url: string
  scopeId?: string
  generation?: number
}

export interface ConsoleEntryManifest {
  revision: number
  entries: ConsoleEntryManifestItem[]
  unavailable: Array<{ id: string; code: 'SOURCE_UNRESOLVABLE' }>
}

interface ResolvedSource {
  root: string
  entryPath: string
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

function trimPath(path: string, name: string): string {
  const value = path.replace(/\/$/, '')
  if (!value.startsWith('/') || value.includes('?') || value.includes('#')) {
    throw new TypeError(`${name} must be an absolute URL path`)
  }
  return value
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function encodeEntryId(entryId: string): string {
  return Buffer.from(entryId, 'utf8').toString('base64url')
}

function decodeEntryId(token: string): string | undefined {
  try {
    const value = Buffer.from(token, 'base64url').toString('utf8')
    if (!value || encodeEntryId(value) !== token) return
    return value
  } catch {
    return
  }
}

function resolveSource(source: string, baseUrl?: string): ResolvedSource {
  let filename: string
  let root: string
  if (source.startsWith('file:')) {
    filename = fileURLToPath(source)
    root = dirname(filename)
  } else if (isAbsolute(source)) {
    filename = source
    root = dirname(filename)
  } else {
    if (!baseUrl) throw new Error('relative console entry source has no base URL')
    const base = new URL(baseUrl)
    if (base.protocol !== 'file:') throw new Error('console entry base URL must use file:')
    filename = fileURLToPath(new URL(source, base))
    root = dirname(filename)
  }
  const entryPath = relative(root, filename)
  if (!entryPath || entryPath.startsWith('..') || isAbsolute(entryPath)) {
    throw new Error('console entry source escapes its root')
  }
  return { root, entryPath }
}

function encodePath(path: string): string {
  return path.split(sep).map(segment => encodeURIComponent(segment)).join('/')
}

function manifestUrl(
  assetPath: string,
  assetGeneration: string,
  entryId: string,
  revision: number,
  entryPath: string,
): string {
  return `${assetPath}/${assetGeneration}/${encodeEntryId(entryId)}/${revision}/${encodePath(entryPath)}`
}

async function authenticate(ctx: Context, request: Request, response: Response): Promise<boolean> {
  try {
    await ctx.console.authenticate({
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(request._req.socket.remoteAddress ? { remoteAddress: request._req.socket.remoteAddress } : {}),
      signal: new AbortController().signal,
    })
    return true
  } catch (error) {
    if (error instanceof ConsoleAuthenticationError) {
      response.status = 401
      response.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: error.message } })
      return false
    }
    if (error instanceof ConsoleAuthenticatorUnavailableError) {
      response.status = 503
      response.json({ error: { code: 'AUTHENTICATOR_UNAVAILABLE', message: error.message } })
      return false
    }
    throw error
  }
}

function isWithin(root: string, filename: string): boolean {
  const path = relative(root, filename)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function consoleAssetPlugin(ctx: Context, config: ConsoleAssetConfig = {}): void {
  const mode = config.mode ?? 'prod'
  if (mode !== 'dev' && mode !== 'prod') throw new TypeError(`invalid Console asset mode: ${String(mode)}`)
  const manifestPath = trimPath(config.manifestPath ?? '/api/console/entries', 'manifestPath')
  const assetPath = trimPath(config.assetPath ?? '/api/console/assets', 'assetPath')
  const assetGeneration = randomUUID()
  const assetPattern = new RegExp(`^${escapeRegExp(assetPath)}/([^/]+)/([^/]+)/([1-9]\\d*)/(.+)$`)

  ctx.server.get(manifestPath, async (request, response) => {
    if (!await authenticate(ctx, request, response)) return
    const revision = ctx.consoleEntries.getRevision()
    const etag = `W/"entries-${mode}-${assetGeneration}-${revision}"`
    response.headers.set('cache-control', 'private, no-cache')
    response.headers.set('etag', etag)
    if (request.headers.get('if-none-match') === etag) {
      response.status = 304
      return
    }
    const document: ConsoleEntryManifest = { revision, entries: [], unavailable: [] }
    for (const entry of ctx.consoleEntries.list()) {
      const source = ctx.consoleEntries.resolveSource(entry.id, mode)
      if (!source) continue
      try {
        const resolved = resolveSource(source.source, source.baseUrl)
        document.entries.push({
          id: entry.id,
          url: manifestUrl(assetPath, assetGeneration, entry.id, revision, resolved.entryPath),
          ...(entry.scopeId ? { scopeId: entry.scopeId } : {}),
          ...(entry.generation === undefined ? {} : { generation: entry.generation }),
        })
      } catch {
        document.unavailable.push({ id: entry.id, code: 'SOURCE_UNRESOLVABLE' })
      }
    }
    response.json(document)
  })

  ctx.server.get(assetPattern, async (request, response) => {
    if (!await authenticate(ctx, request, response)) return
    const generation = request.params[1]
    const entryId = decodeEntryId(request.params[2] ?? '')
    const revision = Number(request.params[3])
    if (generation !== assetGeneration) {
      response.status = 410
      response.json({ error: { code: 'ENTRY_GENERATION_STALE', message: 'Console asset generation is stale' } })
      return
    }
    if (!entryId || !Number.isSafeInteger(revision)) {
      response.status = 404
      return
    }
    if (revision !== ctx.consoleEntries.getRevision()) {
      response.status = 410
      response.json({ error: { code: 'ENTRY_GENERATION_STALE', message: 'Console entry generation is stale' } })
      return
    }
    const source = ctx.consoleEntries.resolveSource(entryId, mode)
    if (!source) {
      response.status = 404
      return
    }
    let requestedPath: string
    try {
      requestedPath = decodeURIComponent(request.params[4] ?? '')
    } catch {
      response.status = 404
      return
    }
    try {
      const resolved = resolveSource(source.source, source.baseUrl)
      const candidate = resolve(resolved.root, requestedPath)
      if (!isWithin(resolved.root, candidate)) {
        response.status = 404
        return
      }
      const [realRoot, realCandidate] = await Promise.all([realpath(resolved.root), realpath(candidate)])
      if (!isWithin(realRoot, realCandidate) || !(await stat(realCandidate)).isFile()) {
        response.status = 404
        return
      }
      const data = await readFile(realCandidate)
      response.headers.set('cache-control', 'private, max-age=31536000, immutable')
      response.headers.set('content-type', mimeTypes[extname(realCandidate).toLowerCase()] ?? 'application/octet-stream')
      response.headers.set('cross-origin-resource-policy', 'same-origin')
      response.headers.set('x-content-type-options', 'nosniff')
      response.bytes(data)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        response.status = 404
        return
      }
      throw error
    }
  })
}

consoleAssetPlugin.inject = ['console', 'consoleEntries', 'server']
