import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import type { LoadedConfig, NumenConfig, PluginConfig, RuntimeEntry } from './types.js'

export class ConfigError extends Error {
  override name = 'ConfigError'
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`)
  }
}

export function validateConfig(value: unknown): NumenConfig {
  assertRecord(value, 'config')

  if (value.version !== 1) {
    throw new ConfigError('config.version must be 1')
  }
  if (typeof value.dataDir !== 'string' || !value.dataDir.trim()) {
    throw new ConfigError('config.dataDir must be a non-empty string')
  }
  assertRecord(value.plugins, 'config.plugins')

  for (const [key, plugin] of Object.entries(value.plugins)) {
    if (!key || key.startsWith('$')) {
      throw new ConfigError(`invalid plugin key: ${JSON.stringify(key)}`)
    }
    if (plugin === null) continue
    assertRecord(plugin, `config.plugins.${key}`)
    if ('$if' in plugin && typeof plugin.$if !== 'boolean') {
      throw new ConfigError(`config.plugins.${key}.$if must be a boolean`)
    }
    if ('$package' in plugin && typeof plugin.$package !== 'string') {
      throw new ConfigError(`config.plugins.${key}.$package must be a string`)
    }
  }

  return value as unknown as NumenConfig
}

export async function loadConfig(filename = 'numen.config.yml'): Promise<LoadedConfig> {
  const absolute = resolve(filename)
  let source: string
  try {
    source = await readFile(absolute, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`config file not found: ${absolute}`)
    }
    throw error
  }

  let document: unknown
  try {
    document = parse(source)
  } catch (error) {
    throw new ConfigError(`cannot parse ${absolute}: ${(error as Error).message}`)
  }

  return {
    filename: absolute,
    baseDir: dirname(absolute),
    config: validateConfig(document),
  }
}

export async function writeConfig(filename: string, config: NumenConfig): Promise<void> {
  validateConfig(config)
  const absolute = resolve(filename)
  const temporary = `${absolute}.tmp`
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(temporary, stringify(config), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, absolute)
}

export function resolveDataPath(loaded: LoadedConfig, path: string): string {
  if (isAbsolute(path) || path === ':memory:') return path
  return resolve(loaded.baseDir, path)
}

function defaultPackageName(name: string): string {
  if (name.startsWith('@') || name.startsWith('.') || name.startsWith('/')) return name
  return `numen-plugin-${name}`
}

function entryId(name: string, ident?: string): string {
  const source = ident ? `${name}-${ident}` : name
  return source.replace(/[^a-zA-Z0-9_.-]/g, '-')
}

export function createRuntimeEntries(
  config: NumenConfig,
  builtins: ReadonlySet<string>,
  safeMode = false,
): RuntimeEntry[] {
  const entries: RuntimeEntry[] = []
  const ids = new Set<string>()

  for (const [rawKey, rawConfig] of Object.entries(config.plugins)) {
    const disabledByPrefix = rawKey.startsWith('~')
    const key = disabledByPrefix ? rawKey.slice(1) : rawKey
    const separator = key.indexOf(':')
    const name = separator < 0 ? key : key.slice(0, separator)
    const ident = separator < 0 ? undefined : key.slice(separator + 1)
    if (!name || (separator >= 0 && !ident)) {
      throw new ConfigError(`invalid plugin key: ${rawKey}`)
    }

    const pluginConfig = (rawConfig ?? {}) as PluginConfig
    const builtin = builtins.has(name)
    const id = entryId(name, ident)
    if (ids.has(id)) throw new ConfigError(`duplicate plugin entry id: ${id}`)
    ids.add(id)

    const { $if, $package, ...runtimeConfig } = pluginConfig
    const disabled = disabledByPrefix || $if === false || (safeMode && !builtin)
    entries.push({
      id,
      key: rawKey,
      name: builtin ? `cordis:${name}` : ($package ?? defaultPackageName(name)),
      config: runtimeConfig,
      disabled,
      builtin,
    })
  }

  return entries
}
