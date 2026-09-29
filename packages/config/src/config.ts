import { validateLoggingConfig } from '@numenjs/logging/config'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { withConfigFileLock } from './persistence.js'
import type { LoadedConfig, NumenConfig, PluginConfig, RuntimeEntry } from './types.js'

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export const maxGroupDepth = 16
export const maxPluginEntries = 1000
export const legacyConsoleNames = ['console', 'consoleEntries', 'consoleAuth', 'consoleSession', 'consoleAssets', 'consoleHttp', 'consoleWs'] as const
export const legacyWorkbenchNames = ['workbench', 'workbenchAutomationAuthoring', 'workbenchAutomationActivation', 'workbenchAutomationCatalog', 'workbenchAutomations', 'workbenchConnections', 'workbenchCredentials', 'workbenchHome', 'workbenchLogs', 'workbenchInvalidation', 'workbenchRuns'] as const
const legacyLeaves = new Set<string>([...legacyConsoleNames.slice(1), ...legacyWorkbenchNames.slice(1)])
const productPackages = new Map([['@numenjs/console', 'console'], ['@numenjs/workbench', 'workbench'], ['@numenjs/workbench/plugin', 'workbench']])

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${path} must be an object`)
}

// Bound expanded traversal, including aliases in ordinary plugin-owned config.
function validateObjectGraph(value: unknown): void {
  const ancestors = new Set<object>()
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 100_000) throw new ConfigError('config exceeds the expanded value limit')
    if (!value || typeof value !== 'object') return
    if (depth > 64) throw new ConfigError('config exceeds the object depth limit')
    if (ancestors.has(value)) throw new ConfigError('config contains a cyclic object or YAML alias')
    ancestors.add(value)
    for (const child of Object.values(value)) visit(child, depth + 1)
    ancestors.delete(value)
  }
  visit(value, 0)
}

export function splitPluginKey(rawKey: string): { name: string; ident?: string; prefixed: boolean } {
  const prefixed = rawKey.startsWith('~')
  const key = prefixed ? rawKey.slice(1) : rawKey
  const separator = key.indexOf(':')
  const name = separator < 0 ? key : key.slice(0, separator)
  const ident = separator < 0 ? undefined : key.slice(separator + 1)
  if (!name || name.startsWith('$') || name.startsWith('~') || (separator >= 0 && !ident)) {
    throw new ConfigError(`invalid plugin key: ${JSON.stringify(rawKey)}`)
  }
  return { name, ...(ident === undefined ? {} : { ident }), prefixed }
}

function entryId(name: string, ident?: string): string {
  const id = (ident ? `${name}-${ident}` : name).replace(/[^a-zA-Z0-9_.-]/g, '-')
  if (Object.hasOwn(Object.prototype, id)) throw new ConfigError(`plugin entry id ${id} is reserved by the installed loader`)
  return id
}

/** Resolve v2 source independently of the instance key. */
export function configuredPluginSource(name: string, config: PluginConfig): string {
  const explicit = config.$package
  if (explicit === undefined) return productPackages.get(name) ?? name
  return productPackages.get(explicit) ?? (explicit.startsWith('cordis:') ? explicit.slice(7) : explicit)
}

export function validateConfig(value: unknown): NumenConfig {
  assertRecord(value, 'config')
  validateObjectGraph(value)
  if (value.version !== 1 && value.version !== 2) throw new ConfigError('config.version must be 1 or 2')
  if (typeof value.dataDir !== 'string' || !value.dataDir.trim()) throw new ConfigError('config.dataDir must be a non-empty string')
  if (value.logger !== undefined) {
    try { validateLoggingConfig(value.logger) } catch (error) { throw new ConfigError((error as Error).message) }
  }
  assertRecord(value.plugins, 'config.plugins')
  const ids = new Map<string, string>()
  const products = new Map<string, string>()
  let count = 0
  const visit = (plugins: Record<string, unknown>, path: string, depth: number): void => {
    if (depth > maxGroupDepth) throw new ConfigError(`${path} exceeds maximum group depth ${maxGroupDepth}`)
    for (const [key, rawPlugin] of Object.entries(plugins)) {
      const location = `${path}.${key}`
      const { name, ident } = splitPluginKey(key)
      if (++count > maxPluginEntries) throw new ConfigError(`config exceeds maximum plugin entries ${maxPluginEntries}`)
      if (rawPlugin !== null) assertRecord(rawPlugin, location)
      const plugin = (rawPlugin ?? {}) as PluginConfig
      if ('$if' in plugin && typeof plugin.$if !== 'boolean') throw new ConfigError(`${location}.$if must be a boolean`)
      if ('$package' in plugin && (typeof plugin.$package !== 'string' || !plugin.$package.trim())) throw new ConfigError(`${location}.$package must be a non-empty string`)
      if (value.version === 1) continue
      const id = entryId(name, ident)
      if (ids.has(id)) throw new ConfigError(`duplicate plugin entry id ${id}: ${ids.get(id)} and ${location}`)
      ids.set(id, location)
      if ('$label' in plugin && typeof plugin.$label !== 'string') throw new ConfigError(`${location}.$label must be a string`)
      if ('$collapsed' in plugin && typeof plugin.$collapsed !== 'boolean') throw new ConfigError(`${location}.$collapsed must be a boolean`)
      if (name === 'group') {
        if (!ident) throw new ConfigError(`${location}: groups require group:<ident>`)
        for (const field of Object.keys(plugin)) {
          if (!['$if', '$label', '$collapsed', 'plugins'].includes(field)) throw new ConfigError(`${location}: unsupported group field ${field}`)
        }
        assertRecord(plugin.plugins, `${location}.plugins`)
        visit(plugin.plugins, `${location}.plugins`, depth + 1)
      } else {
        const packageSource = plugin.$package ?? name
        if (packageSource === '@numenjs/workbench/runtime' || packageSource === '@numenjs/workbench/server') throw new ConfigError(`${location}: legacy Workbench subpath is not allowed as a version 2 plugin entry`)
        const source = configuredPluginSource(name, plugin)
        const builtinSource = plugin.$package === undefined || plugin.$package.startsWith('cordis:') || productPackages.has(plugin.$package)
        if (builtinSource && source === 'group') throw new ConfigError(`${location}: groups require the reserved group:<ident> syntax`)
        if (builtinSource && legacyLeaves.has(source)) throw new ConfigError(`${location}: legacy ${source} entry is not allowed in version 2; migrate its product configuration`)
        if (builtinSource && (source === 'console' || source === 'workbench')) {
          if (products.has(source)) throw new ConfigError(`${location}: duplicate ${source} product entry; first at ${products.get(source)}`)
          products.set(source, location)
        }
      }
    }
  }
  visit(value.plugins, 'config.plugins', 0)
  return value as unknown as NumenConfig
}

export async function loadConfig(filename = 'numen.config.yml'): Promise<LoadedConfig> {
  const absolute = resolve(filename)
  let source: string
  try { source = await readFile(absolute, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(`config file not found: ${absolute}`)
    throw error
  }
  let document: unknown
  try { document = parse(source) } catch {
    // YAML parser excerpts can contain credentials.
    throw new ConfigError(`cannot parse ${absolute}: invalid YAML (source values omitted)`)
  }
  return { filename: absolute, baseDir: dirname(absolute), config: validateConfig(document) }
}

export async function writeConfig(filename: string, config: NumenConfig): Promise<void> {
  validateConfig(config)
  const absolute = resolve(filename)
  const temporary = `${absolute}.${randomUUID()}.tmp`
  await mkdir(dirname(absolute), { recursive: true })
  await withConfigFileLock(absolute, async () => {
    try {
      await writeFile(temporary, stringify(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, absolute)
    } finally { await rm(temporary, { force: true }) }
  })
}

export function resolveDataPath(loaded: LoadedConfig, path: string): string {
  if (isAbsolute(path) || path === ':memory:') return path
  return resolve(loaded.baseDir, path)
}

function defaultPackageName(name: string): string {
  if (name.startsWith('@') || name.startsWith('.') || name.startsWith('/')) return name
  return `numen-plugin-${name}`
}

export function createRuntimeEntries(config: NumenConfig, builtins: ReadonlySet<string>, safeMode = false): RuntimeEntry[] {
  validateConfig(config)
  const ids = new Set<string>()
  const visit = (plugins: NumenConfig['plugins'], ancestorsEnabled: boolean, path: string, parentId?: string): RuntimeEntry[] => Object.entries(plugins).map(([rawKey, rawConfig]) => {
    const { name, ident, prefixed } = splitPluginKey(rawKey)
    const pluginConfig = rawConfig ?? {}
    const id = entryId(name, ident)
    if (ids.has(id)) throw new ConfigError(`duplicate plugin entry id: ${id}`)
    ids.add(id)
    const group = config.version === 2 && name === 'group'
    const source = config.version === 1 ? name : configuredPluginSource(name, pluginConfig)
    const builtin = group || (builtins.has(source) && (config.version === 1 || pluginConfig.$package === undefined || pluginConfig.$package === `cordis:${source}` || productPackages.get(pluginConfig.$package) === source))
    const selfEnabled = !prefixed && pluginConfig.$if !== false
    const disabled = !selfEnabled || (safeMode && !builtin)
    const effectiveEnabled = ancestorsEnabled && !disabled
    const { $if, $package, ...originalConfig } = pluginConfig
    const { $label, $collapsed, ...v2Config } = originalConfig
    const location = `${path}.${rawKey}`
    return {
      id, key: rawKey,
      name: builtin ? `cordis:${source}` : ($package ?? defaultPackageName(name)),
      config: group ? {} : (config.version === 1 ? originalConfig : v2Config),
      disabled, builtin,
      ...(config.version === 2 ? {
        selfEnabled, effectiveEnabled, path: location,
        ...(parentId === undefined ? {} : { parentId }),
        ...(typeof $label === 'string' ? { label: $label } : {}),
        ...(typeof $collapsed === 'boolean' ? { collapsed: $collapsed } : {}),
      } : {}),
      ...(group ? { children: visit(pluginConfig.plugins as NumenConfig['plugins'], effectiveEnabled, `${location}.plugins`, id) } : {}),
    }
  })
  return visit(config.plugins, true, 'config.plugins')
}

export function flattenRuntimeEntries(entries: readonly RuntimeEntry[]): RuntimeEntry[] {
  return entries.flatMap(entry => [entry, ...flattenRuntimeEntries(entry.children ?? [])])
}
