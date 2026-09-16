import { defineCapability, isNumenValue, type CapabilityDefinition, type CapabilityProvider, type NumenValue } from '@numen/core'
import type {} from '@numen/http'
import type { Context } from 'cordis'
import type Schema from 'schemastery'
import z from 'schemastery'

export type HttpRequestMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type HttpRequestBody =
  | { type: 'text'; value: string }
  | { type: 'json'; value: NumenValue }

export interface HttpRequestInput {
  method: HttpRequestMethod
  url: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: HttpRequestBody
  timeoutMs?: number
}

export interface HttpRequestOutput {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  bodyType: 'text' | 'json'
  body: NumenValue
}

export interface HttpIntegrationConfig {
  maxRequestBytes?: number
  maxResponseBytes?: number
}

export type HttpRequestErrorCode =
  | 'HTTP_URL_INVALID'
  | 'HTTP_SCHEME_UNSUPPORTED'
  | 'HTTP_URL_CREDENTIALS_FORBIDDEN'
  | 'HTTP_BODY_INVALID'
  | 'HTTP_REQUEST_TOO_LARGE'
  | 'HTTP_RESPONSE_TOO_LARGE'
  | 'HTTP_RESPONSE_MEDIA_TYPE_UNSUPPORTED'
  | 'HTTP_RESPONSE_TEXT_INVALID'
  | 'HTTP_RESPONSE_JSON_INVALID'
  | 'HTTP_TIMEOUT'
  | 'HTTP_NETWORK_ERROR'

export class HttpRequestError extends Error {
  override name = 'HttpRequestError'

  constructor(
    public readonly code: HttpRequestErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options)
  }
}

const mebibyte = 1024 * 1024
const maximumConfiguredBytes = 16 * mebibyte
const maximumRequestTimeoutMs = 5 * 60_000
const redactedResponseHeaders = new Set([
  'authorization',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'set-cookie2',
])

const bodySchema = z.union([
  z.object({
    type: z.const('text').required(),
    value: z.string().required(),
  }),
  z.object({
    type: z.const('json').required(),
    value: z.any().required(),
  }),
]) as Schema<HttpRequestBody>

const inputSchema = z.object({
  method: z.union(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  url: z.string().required(),
  headers: z.dict(z.string()),
  query: z.dict(z.string()),
  body: bodySchema,
  timeoutMs: z.natural().min(1).max(maximumRequestTimeoutMs).role('ms'),
}) as unknown as Schema<HttpRequestInput>

const outputSchema = z.object({
  ok: z.boolean().required(),
  status: z.natural().required(),
  statusText: z.string().required(),
  headers: z.dict(z.string()).required(),
  bodyType: z.union(['text', 'json']).required(),
  body: z.any().required(),
}) as unknown as Schema<HttpRequestOutput>

export const httpRequestCapability: CapabilityDefinition<HttpRequestInput, HttpRequestOutput> = defineCapability({
  id: 'http:request',
  version: 1,
  kind: 'action',
  title: 'HTTP Request',
  description: 'Send a bounded HTTP(S) request through the Runtime-managed outbound client.',
  input: inputSchema,
  output: outputSchema,
  // The configured method is dynamic, so the contract must use the most
  // conservative semantics. Explicit retry policy remains a user decision.
  semantics: { sideEffect: true, idempotent: false, retrySafe: false },
})

function checkedLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximumConfiguredBytes) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximumConfiguredBytes}`)
  }
  return resolved
}

function parseTarget(source: string): URL {
  let url: URL
  try {
    url = new URL(source)
  } catch (cause) {
    throw new HttpRequestError('HTTP_URL_INVALID', 'url must be absolute', { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpRequestError('HTTP_SCHEME_UNSUPPORTED', 'only http: and https: targets are allowed')
  }
  if (url.username || url.password) {
    throw new HttpRequestError('HTTP_URL_CREDENTIALS_FORBIDDEN', 'URL userinfo is not allowed; use a Credential-backed Integration for secrets')
  }
  return url
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase()
  return Object.keys(headers).some(key => key.toLowerCase() === normalized)
}

function encodeBody(
  method: HttpRequestMethod,
  body: HttpRequestBody | undefined,
  sourceHeaders: Record<string, string> | undefined,
  maxRequestBytes: number,
): { data?: string; headers: Record<string, string> } {
  const headers = { ...sourceHeaders }
  if (!body) return { headers }
  if (method === 'GET' || method === 'HEAD') {
    throw new HttpRequestError('HTTP_BODY_INVALID', `${method} requests cannot contain a body`)
  }
  if (body.type === 'json' && !isNumenValue(body.value)) {
    throw new HttpRequestError('HTTP_BODY_INVALID', 'JSON body must be a Numen value')
  }
  const data = body.type === 'json' ? JSON.stringify(body.value) : body.value
  if (Buffer.byteLength(data) > maxRequestBytes) {
    throw new HttpRequestError('HTTP_REQUEST_TOO_LARGE', `request body exceeds ${maxRequestBytes} bytes`)
  }
  if (!hasHeader(headers, 'content-type')) {
    headers['content-type'] = body.type === 'json'
      ? 'application/json; charset=utf-8'
      : 'text/plain; charset=utf-8'
  }
  return { data, headers }
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel()
    throw new HttpRequestError('HTTP_RESPONSE_TOO_LARGE', `response body exceeds ${limit} bytes`)
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new HttpRequestError('HTTP_RESPONSE_TOO_LARGE', `response body exceeds ${limit} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function isJsonMediaType(mediaType: string): boolean {
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

function isTextMediaType(mediaType: string): boolean {
  return !mediaType
    || mediaType.startsWith('text/')
    || mediaType === 'application/xml'
    || mediaType.endsWith('+xml')
    || mediaType === 'application/x-www-form-urlencoded'
    || mediaType === 'application/graphql'
    || mediaType === 'application/javascript'
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new HttpRequestError('HTTP_RESPONSE_TEXT_INVALID', 'response body is not valid UTF-8 text', { cause })
  }
}

function decodeBody(bytes: Uint8Array, contentType: string | null): Pick<HttpRequestOutput, 'bodyType' | 'body'> {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!isJsonMediaType(mediaType) && !isTextMediaType(mediaType) && bytes.byteLength) {
    throw new HttpRequestError('HTTP_RESPONSE_MEDIA_TYPE_UNSUPPORTED', `unsupported response media type: ${mediaType || '(missing)'}`)
  }
  const text = decodeText(bytes)
  if (!isJsonMediaType(mediaType)) return { bodyType: 'text', body: text }
  try {
    const body: unknown = JSON.parse(text)
    if (!isNumenValue(body)) throw new TypeError('JSON is not a Numen value')
    return { bodyType: 'json', body }
  } catch (cause) {
    throw new HttpRequestError('HTTP_RESPONSE_JSON_INVALID', 'response declares JSON but does not contain valid JSON', { cause })
  }
}

function projectHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of source.entries()) {
    headers[name] = redactedResponseHeaders.has(name.toLowerCase()) ? '[redacted]' : value
  }
  return headers
}

async function request(
  ctx: Context,
  input: HttpRequestInput,
  signal: AbortSignal,
  maxRequestBytes: number,
  maxResponseBytes: number,
): Promise<HttpRequestOutput> {
  signal.throwIfAborted()
  const url = parseTarget(input.url)
  const { data, headers } = encodeBody(input.method, input.body, input.headers, maxRequestBytes)
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timeoutMs = input.timeoutMs ?? ctx.http.config.timeout
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    controller.abort(new HttpRequestError('HTTP_TIMEOUT', `request timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  timer?.unref()
  try {
    const response = await ctx.http(url, {
      method: input.method,
      headers,
      ...(input.query === undefined ? {} : { params: input.query }),
      ...(data === undefined ? {} : { data }),
      signal: controller.signal,
    })
    const bytes = await readBounded(response, maxResponseBytes, controller.signal)
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: projectHeaders(response.headers),
      ...decodeBody(bytes, response.headers.get('content-type')),
    }
  } catch (cause) {
    if (signal.aborted) throw signal.reason
    if (controller.signal.reason instanceof HttpRequestError) throw controller.signal.reason
    if (cause instanceof HttpRequestError) throw cause
    throw new HttpRequestError('HTTP_NETWORK_ERROR', 'request failed', { cause })
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

export function httpIntegrationPlugin(ctx: Context, config: HttpIntegrationConfig = {}): void {
  const maxRequestBytes = checkedLimit(config.maxRequestBytes, mebibyte, 'maxRequestBytes')
  const maxResponseBytes = checkedLimit(config.maxResponseBytes, mebibyte, 'maxResponseBytes')
  ctx.capabilities.define(ctx, httpRequestCapability)
  ctx.capabilities.provide(ctx, httpRequestCapability, {
    invoke({ input, signal }) {
      return request(ctx, input, signal, maxRequestBytes, maxResponseBytes)
    },
  } satisfies CapabilityProvider<HttpRequestInput, HttpRequestOutput>)
}

httpIntegrationPlugin.inject = ['capabilities', 'http']
httpIntegrationPlugin.Config = z.object({
  maxRequestBytes: z.natural().min(1).max(maximumConfiguredBytes).default(mebibyte),
  maxResponseBytes: z.natural().min(1).max(maximumConfiguredBytes).default(mebibyte),
})

export default httpIntegrationPlugin
