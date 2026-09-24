export interface LogLevels { base?: number; [namespace: string]: number | LogLevels | undefined }
export interface LoggingConfig {
  levels?: number | LogLevels
  showTime?: boolean | string
  showDiff?: boolean
  console?: boolean
  persist?: boolean
  capacity?: number
  maxFileBytes?: number
  maxFiles?: number
}

export function validateLoggingConfig(value: unknown): asserts value is LoggingConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('logger must be an object')
  const config = value as Record<string, unknown>
  const validKeys = new Set(['levels', 'showTime', 'showDiff', 'console', 'persist', 'capacity', 'maxFileBytes', 'maxFiles'])
  if (Object.keys(config).some(key => !validKeys.has(key))) throw new TypeError('Unknown logger configuration key')
  for (const key of ['showDiff', 'console', 'persist']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new TypeError(`logger.${key} must be a boolean`)
  }
  if (config.showTime !== undefined && typeof config.showTime !== 'boolean' && typeof config.showTime !== 'string') throw new TypeError('logger.showTime must be a boolean or string')
  for (const [key, minimum, maximum] of [['capacity', 1, 10000], ['maxFileBytes', 65536, 16777216], ['maxFiles', 1, 10]] as const) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || (config[key] as number) < minimum || (config[key] as number) > maximum)) throw new TypeError(`logger.${key} must be an integer between ${minimum} and ${maximum}`)
  }
  const ancestors = new Set<object>()
  const check = (level: unknown, depth: number) => {
    if (typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= 3) return
    if (!level || typeof level !== 'object' || Array.isArray(level) || ancestors.has(level) || depth > 12) throw new TypeError('Log levels must be 0..3 or an acyclic namespace tree')
    ancestors.add(level)
    for (const [key, child] of Object.entries(level)) {
      if (!/^[\w:-]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || (key === 'base' && typeof child !== 'number')) throw new TypeError('Invalid log level namespace')
      check(child, depth + 1)
    }
    ancestors.delete(level)
  }
  if (config.levels !== undefined) check(config.levels, 0)
}

export function resolveLoggingConfig(config: LoggingConfig = {}, env: Record<string, string | undefined> = {}): LoggingConfig {
  validateLoggingConfig(config)
  const result = structuredClone(config)
  const levels: LogLevels = typeof config.levels === 'number' ? { base: config.levels } : structuredClone(config.levels ?? { base: 2 })
  if (env.NUMEN_LOG_LEVEL !== undefined) {
    if (!/^[0-3]$/.test(env.NUMEN_LOG_LEVEL)) throw new TypeError('NUMEN_LOG_LEVEL must be 0, 1, 2, or 3')
    levels.base = Number(env.NUMEN_LOG_LEVEL)
  }
  if (env.NUMEN_DEBUG) {
    for (const name of env.NUMEN_DEBUG.split(',').map(value => value.trim()).filter(Boolean)) levels[name] = 3
  }
  result.levels = levels
  validateLoggingConfig(result)
  return result
}

export function namespaceLevel(levels: LoggingConfig['levels'], namespace: string): number {
  if (typeof levels === 'number') return levels
  let node = levels ?? {}, level = node.base ?? 2
  const parts = namespace.split(':')
  for (let index = 0; index < parts.length;) {
    let end = parts.length
    while (end > index + 1 && node[parts.slice(index, end).join(':')] === undefined) end--
    const next = node[parts.slice(index, end).join(':')]
    if (typeof next === 'number') return next
    if (!next) break
    node = next
    level = node.base ?? level
    index = end
  }
  return level
}
