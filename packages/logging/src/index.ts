import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context, type Fiber, type Message } from 'cordis'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import { namespaceLevel, resolveLoggingConfig, type LoggingConfig } from './config.js'
import { currentLogContext, currentLogSecrets, logContextKeys } from './context.js'
import { formatLogArgs, sanitize } from './sanitize.js'
import type { LogQuery, LogRecord, LogSnapshot } from './contracts.js'

export * from './contracts.js'
export * from './config.js'
export * from './context.js'
export { sanitize, redactText } from './sanitize.js'

export interface LoggingOptions extends LoggingConfig {
  directory?: string
  secrets?: readonly string[]
  environment?: Record<string, string | undefined>
  writeConsole?: (line: string) => void
  pluginPath?: (fiber: Fiber) => string
}
declare module 'cordis' { interface Context { logs: LoggingService } }

export class LoggingService extends Service {
  readonly stream = randomUUID()
  private readonly records: { sequence: number; record: LogRecord }[] = []
  private readonly listeners = new Set<() => void>()
  private readonly config: LoggingConfig
  private readonly directory: string | undefined
  private readonly secrets: readonly string[]
  private sequence = 0
  private evicted = 0
  private malformed = 0
  private bytes = 0
  private persistence: LogSnapshot['persistence'] = 'disabled'
  private dirty = false
  private closed = false
  private capturing = false

  constructor(ctx: Context, options: LoggingOptions = {}) {
    super(ctx, 'logs')
    const { directory, secrets = [], environment = {}, writeConsole = console.log, pluginPath, ...config } = options
    this.config = resolveLoggingConfig(config, environment)
    this.directory = directory
    this.secrets = [...secrets].filter(Boolean)
    if (directory && config.persist !== false) this.restore()
    // The built-in buffer retains raw arguments; this service owns the sanitized history.
    ctx.logger.bufferSize = 0
    ctx.logger.buffer.length = 0
    ctx.effect(() => () => { this.closed = true; this.listeners.clear() })
    const service = this
    new class extends ConsoleExporter {
      export(message: Message): void {
        if (service.closed) return
        if (service.capturing) { service.malformed++; service.dirty = true; return }
        service.capturing = true
        try {
          if (typeof message.name !== 'string' || !['error', 'warn', 'info', 'debug'].includes(message.type)
            || message.level !== ['error', 'warn', 'info', 'debug'].indexOf(message.type)) throw new TypeError('Invalid log metadata')
          if (message.level > namespaceLevel(service.config.levels, message.name)) return
          const context = currentLogContext()
          const record: LogRecord = {
            id: `${service.stream}:${service.sequence + 1}`,
            timestamp: new Date(message.ts).toISOString(),
            type: message.type, level: message.level,
            namespace: service.text(message.name, 200),
            message: formatLogArgs(message.args, [...service.secrets, ...currentLogSecrets()]),
          }
          for (const key of logContextKeys) if (typeof context[key] === 'string') record[key] = service.text(context[key]!, 200)
          const fiber = message.fiber?.deref()
          if (fiber) {
            record.pluginPath = service.text(pluginPath?.(fiber) ?? fiber.name, 500)
            if (fiber.uid !== null) record.fiberId = fiber.uid
          }
          service.push(record)
          service.persist(record)
          if (service.config.console !== false) {
            const correlation = logContextKeys.filter(key => record[key]).map(key => `${key}=${record[key]}`).join(' ')
            try { writeConsole(this.render({ ...message, name: record.namespace, args: ['%s', record.message + (correlation ? ` [${correlation}]` : '')] })) }
            catch { /* A closed terminal must not interrupt domain work. History remains available. */ }
          }
        } catch {
          // Proxies or malformed custom logger metadata cannot break an invocation.
          service.malformed++
          service.dirty = true
        } finally {
          service.capturing = false
        }
      }
    }(ctx, {
      colors: false, levels: { default: 3 }, showDiff: config.showDiff ?? false,
      showTime: config.showTime === false ? '' : typeof config.showTime === 'string' ? config.showTime : 'yyyy-MM-dd hh:mm:ss ',
    })
    const timer = setInterval(() => {
      if (!this.dirty) return
      this.dirty = false
      for (const listener of [...this.listeners]) {
        try { listener() } catch { this.listeners.delete(listener) }
      }
    }, 200)
    timer.unref()
    ctx.effect(() => () => clearInterval(timer))
  }

  private text(value: string, limit: number): string { return String(sanitize(value, [...this.secrets, ...currentLogSecrets()])).slice(0, limit) }
  private push(record: LogRecord): void {
    this.records.push({ sequence: ++this.sequence, record })
    const excess = this.records.length - (this.config.capacity ?? 2000)
    if (excess > 0) { this.records.splice(0, excess); this.evicted += excess }
    this.dirty = true
  }
  private filename(index = 0): string { return join(this.directory!, index ? `runtime.${index}.jsonl` : 'runtime.jsonl') }
  private restore(): void {
    try {
      mkdirSync(this.directory!, { recursive: true, mode: 0o700 })
      for (let index = (this.config.maxFiles ?? 5) - 1; index >= 0; index--) {
        const filename = this.filename(index)
        if (!existsSync(filename)) continue
        // Do not read unexpectedly large/tampered files into memory.
        if (statSync(filename).size > (this.config.maxFileBytes ?? 1048576) + 16384) { this.malformed++; continue }
        chmodSync(filename, 0o600)
        const source = readFileSync(filename, 'utf8')
        for (const line of source.split('\n')) {
          if (!line.trim()) continue
          try {
            const value = JSON.parse(line)
            if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.message !== 'string'
              || typeof value.namespace !== 'string' || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
              || !['error', 'warn', 'info', 'debug'].includes(value.type) || value.level !== ['error', 'warn', 'info', 'debug'].indexOf(value.type)) throw new Error('invalid log record')
            const record: LogRecord = { id: this.text(value.id, 200), message: this.text(value.message, 4096), namespace: this.text(value.namespace, 200), timestamp: new Date(value.timestamp).toISOString(), level: value.level, type: value.type }
            for (const key of logContextKeys) if (typeof value[key] === 'string') record[key] = this.text(value[key], 200)
            if (typeof value.pluginPath === 'string') record.pluginPath = this.text(value.pluginPath, 500)
            if (Number.isSafeInteger(value.fiberId) && value.fiberId >= 0) record.fiberId = value.fiberId
            this.push(record)
          } catch { this.malformed++ }
        }
        if (index === 0 && source && !source.endsWith('\n')) appendFileSync(filename, '\n')
      }
      this.bytes = existsSync(this.filename()) ? statSync(this.filename()).size : 0
      this.persistence = 'ready'
    } catch { this.persistence = 'failed' }
  }
  private persist(record: LogRecord): void {
    if (this.persistence !== 'ready') return
    try {
      const line = JSON.stringify(record) + '\n'
      const size = Buffer.byteLength(line)
      if (this.bytes + size > (this.config.maxFileBytes ?? 1048576)) {
        const count = this.config.maxFiles ?? 5
        if (existsSync(this.filename(count - 1))) unlinkSync(this.filename(count - 1))
        for (let index = count - 2; index >= 0; index--) if (existsSync(this.filename(index))) renameSync(this.filename(index), this.filename(index + 1))
        this.bytes = 0
      }
      appendFileSync(this.filename(), line, { encoding: 'utf8', mode: 0o600 })
      this.bytes += size
    } catch { this.persistence = 'failed' }
  }

  subscribe(listener: () => void): () => void {
    if (this.closed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  query(input: LogQuery = {}): LogSnapshot {
    const limit = input.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Log limit must be 1..200')
    if (input.maxLevel !== undefined && (!Number.isInteger(input.maxLevel) || input.maxLevel < 0 || input.maxLevel > 3)) throw new TypeError('Log level must be 0..3')
    if (input.before && (!Number.isSafeInteger(input.before.sequence) || input.before.sequence < 1 || typeof input.before.stream !== 'string')) throw new TypeError('Invalid log cursor')
    const reset = !!input.before && input.before.stream !== this.stream
    const before = reset ? undefined : input.before?.sequence
    const matches = this.records.filter(({ record, sequence }) => (before === undefined || sequence < before)
      && record.level <= (input.maxLevel ?? 3)
      && (!input.namespace || record.namespace === input.namespace || record.namespace.startsWith(input.namespace + ':'))
      && (!input.search || record.message.toLocaleLowerCase().includes(input.search.toLocaleLowerCase()))
      && logContextKeys.every(key => !input[key] || input[key] === record[key]))
    const selected = matches.slice(-limit).reverse()
    return {
      records: selected.map(item => ({ ...item.record })), stream: this.stream, revision: this.sequence,
      ...(matches.length > selected.length ? { next: { stream: this.stream, sequence: selected.at(-1)!.sequence } } : {}),
      reset, expired: before !== undefined && this.evicted > 0 && before <= (this.records[0]?.sequence ?? this.sequence), retained: this.records.length, evicted: this.evicted, malformed: this.malformed, persistence: this.persistence,
    }
  }
}
