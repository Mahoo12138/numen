export type LogType = 'error' | 'warn' | 'info' | 'debug'
export interface LogContext {
  automationId?: string
  runId?: string
  executionId?: string
  attemptId?: string
  connectionId?: string
  triggerId?: string
  requestId?: string
  traceId?: string
}
export interface LogRecord extends LogContext {
  id: string
  timestamp: string
  type: LogType
  level: number
  namespace: string
  message: string
  pluginPath?: string
  fiberId?: number
}
export interface LogCursor { stream: string; sequence: number }
export interface LogQuery extends LogContext {
  limit?: number
  before?: LogCursor | undefined
  maxLevel?: number
  namespace?: string
  search?: string
}
export interface LogSnapshot {
  records: LogRecord[]
  stream: string
  revision: number
  next?: LogCursor | undefined
  reset: boolean
  expired: boolean
  retained: number
  evicted: number
  malformed: number
  persistence: 'ready' | 'disabled' | 'failed'
}
export const logsQueryRef = { id: 'numen:logs', version: 1 } as const
export const logsChangedRef = { id: 'numen:logs-changed', version: 1 } as const
