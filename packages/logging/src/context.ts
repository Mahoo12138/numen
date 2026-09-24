import { AsyncLocalStorage } from 'node:async_hooks'
import type { LogContext } from './contracts.js'

interface LogScope { metadata: Readonly<LogContext>; secrets: readonly string[] }
const context = new AsyncLocalStorage<LogScope>()
export const logContextKeys = ['automationId', 'runId', 'executionId', 'attemptId', 'connectionId', 'triggerId', 'requestId', 'traceId'] as const
export function currentLogContext(): Readonly<LogContext> { return context.getStore()?.metadata ?? {} }
export function currentLogSecrets(): readonly string[] { return context.getStore()?.secrets ?? [] }
/** Async-local metadata follows concurrent plugin work without mutating a shared logger. */
export function withLogContext<T>(metadata: LogContext, callback: () => T): T {
  return context.run({ metadata: Object.freeze({ ...currentLogContext(), ...metadata }), secrets: currentLogSecrets() }, callback)
}
/** Secret snapshots supplied to an Adapter stay redacted even when logged as a bare string. */
export function withLogSecrets<T>(value: unknown, callback: () => T): T {
  const secrets = new Set(currentLogSecrets())
  const visit = (value: unknown, depth: number) => {
    if (secrets.size >= 256 || depth > 8) return
    if (typeof value === 'string') { if (value.length >= 4) secrets.add(value); return }
    if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item, depth + 1)
  }
  visit(value, 0)
  return context.run({ metadata: currentLogContext(), secrets: [...secrets] }, callback)
}
