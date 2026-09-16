import { defineCapability, type TriggerProvider } from '@numen/core'
import type { Context } from 'cordis'
import z from 'schemastery'

export interface ScheduleIntegrationConfig {
  now?: () => Date
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

interface CronField {
  any: boolean
  values: Set<number>
}

interface CronExpression {
  minute: CronField
  hour: CronField
  day: CronField
  month: CronField
  weekday: CronField
}

const maxTimerDelay = 2_147_000_000

function parseNumber(source: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(source)) throw new TypeError(`invalid cron ${label}: ${source}`)
  const value = Number(source)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`cron ${label} must be between ${min} and ${max}`)
  return value
}

function parseField(source: string, min: number, max: number, label: string, normalize?: (value: number) => number): CronField {
  const values = new Set<number>()
  for (const segment of source.split(',')) {
    if (!segment) throw new TypeError(`invalid cron ${label}`)
    const [rangeSource, stepSource, extra] = segment.split('/')
    if (extra !== undefined || !rangeSource) throw new TypeError(`invalid cron ${label}: ${segment}`)
    const step = stepSource === undefined ? 1 : parseNumber(stepSource, 1, max - min + 1, `${label} step`)
    let start: number
    let end: number
    if (rangeSource === '*') {
      start = min; end = max
    } else if (rangeSource.includes('-')) {
      const [startSource, endSource, rangeExtra] = rangeSource.split('-')
      if (!startSource || !endSource || rangeExtra !== undefined) throw new TypeError(`invalid cron ${label}: ${segment}`)
      start = parseNumber(startSource, min, max, label)
      end = parseNumber(endSource, min, max, label)
      if (start > end) throw new TypeError(`invalid cron ${label} range: ${rangeSource}`)
    } else {
      start = end = parseNumber(rangeSource, min, max, label)
      if (stepSource !== undefined) throw new TypeError(`cron ${label} step requires * or a range`)
    }
    for (let value = start; value <= end; value += step) values.add(normalize?.(value) ?? value)
  }
  return { any: source === '*', values }
}

export function parseCron(source: string): CronExpression {
  const fields = source.trim().split(/\s+/)
  if (fields.length !== 5) throw new TypeError('cron expression must contain minute, hour, day, month, and weekday')
  return {
    minute: parseField(fields[0]!, 0, 59, 'minute'),
    hour: parseField(fields[1]!, 0, 23, 'hour'),
    day: parseField(fields[2]!, 1, 31, 'day'),
    month: parseField(fields[3]!, 1, 12, 'month'),
    weekday: parseField(fields[4]!, 0, 7, 'weekday', value => value === 7 ? 0 : value),
  }
}

function zonedParts(date: Date, timeZone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    minute: '2-digit',
    hour: '2-digit',
    day: '2-digit',
    month: '2-digit',
    weekday: 'short',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const weekday = weekdays[value('weekday')]
  if (weekday === undefined) throw new TypeError(`could not evaluate cron timezone: ${timeZone}`)
  return { minute: Number(value('minute')), hour: Number(value('hour')), day: Number(value('day')), month: Number(value('month')), weekday }
}

function matches(expression: CronExpression, parts: ReturnType<typeof zonedParts>): boolean {
  if (!expression.minute.values.has(parts.minute) || !expression.hour.values.has(parts.hour) || !expression.month.values.has(parts.month)) return false
  const day = expression.day.values.has(parts.day)
  const weekday = expression.weekday.values.has(parts.weekday)
  if (expression.day.any) return expression.weekday.any || weekday
  if (expression.weekday.any) return day
  return day || weekday
}

export function nextCronOccurrence(source: string, after: Date, timeZone = 'UTC'): Date {
  const expression = parseCron(source)
  // Validate the IANA timezone before scanning.
  zonedParts(after, timeZone)
  const minute = 60_000
  let timestamp = Math.floor(after.getTime() / minute) * minute + minute
  const limit = timestamp + 5 * 366 * 24 * 60 * minute
  for (; timestamp <= limit; timestamp += minute) {
    const candidate = new Date(timestamp)
    if (matches(expression, zonedParts(candidate, timeZone))) return candidate
  }
  throw new RangeError('cron expression has no occurrence within five years')
}

export const scheduleCronTrigger = defineCapability({
  id: 'schedule:cron',
  version: 1,
  kind: 'trigger',
  title: 'Cron Schedule',
  description: 'Run an Automation on a five-field cron schedule.',
  input: z.object({
    cron: z.string().description('Five fields: minute hour day month weekday').required(),
    timezone: z.string().default('UTC'),
  }),
  output: z.object({ scheduledAt: z.string().required() }),
  semantics: { sideEffect: false, idempotent: true, retrySafe: true },
})

export function scheduleIntegrationPlugin(ctx: Context, config: ScheduleIntegrationConfig = {}): void {
  const now = config.now ?? (() => new Date())
  const scheduleTimeout = config.setTimeout ?? globalThis.setTimeout.bind(globalThis)
  const cancelTimeout = config.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
  ctx.capabilities.define(ctx, scheduleCronTrigger)
  ctx.capabilities.provideTrigger(ctx, scheduleCronTrigger, {
    activate({ binding, signal, emit }) {
      const cron = binding.config.cron
      const timezone = binding.config.timezone ?? 'UTC'
      if (typeof cron !== 'string' || typeof timezone !== 'string') throw new TypeError('schedule:cron requires string cron and timezone values')
      parseCron(cron)
      zonedParts(now(), timezone)
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined
      let disposed = false
      const plan = () => {
        if (disposed || signal.aborted) return
        const scheduled = nextCronOccurrence(cron, now(), timezone)
        const wait = Math.max(0, Math.min(scheduled.getTime() - now().getTime(), maxTimerDelay))
        timer = scheduleTimeout(async () => {
          if (disposed || signal.aborted) return
          if (wait === maxTimerDelay) return plan()
          const scheduledAt = scheduled.toISOString()
          try {
            await emit({
              data: { scheduledAt },
              occurredAt: scheduledAt,
              eventId: `cron:${scheduledAt}`,
            })
          } finally {
            plan()
          }
        }, wait)
      }
      plan()
      return () => {
        disposed = true
        if (timer !== undefined) cancelTimeout(timer)
      }
    },
  } satisfies TriggerProvider<{ scheduledAt: string }>)
}

scheduleIntegrationPlugin.inject = ['capabilities']

export default scheduleIntegrationPlugin
