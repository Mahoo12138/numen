import { createHash, randomUUID } from 'node:crypto'
import { chmod, chown, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isAlias, isMap, isNode, isScalar, parseDocument, visit, type Pair, type YAMLMap } from 'yaml'
import { ConfigError, legacyConsoleNames, legacyWorkbenchNames, splitPluginKey, validateConfig } from './config.js'
import { withConfigFileLock } from './persistence.js'
import type { PluginConfig } from './types.js'

export interface ConfigMigrationPlan {
  fromVersion: 1 | 2
  toVersion: 2
  fingerprint: string
  changes: string[]
  conflicts: string[]
  diagnostics: string[]
}

const fields: Record<string, readonly string[]> = {
  console: [], consoleEntries: [],
  consoleAuth: ['token', 'ownerId'], consoleSession: ['path', 'secureCookie'],
  consoleAssets: ['mode', 'manifestPath', 'assetPath'], consoleHttp: ['path'],
  consoleWs: ['path', 'maxMessageBytes', 'maxBufferedBytes'],
  workbench: ['root', 'assetPath', 'entrySource'],
}
const consoleSections: Record<string, string> = { consoleAuth: 'auth', consoleSession: 'session', consoleAssets: 'assets', consoleHttp: 'http', consoleWs: 'websocket' }
const knownLegacyNames = new Set<string>([...legacyConsoleNames, ...legacyWorkbenchNames])
export function configFingerprint(source: string): string { return createHash('sha256').update(source).digest('hex') }

/** Only this internal result contains source text; the CLI prints the value-free plan. */
function buildMigration(source: string, builtins: ReadonlySet<string>): { plan: ConfigMigrationPlan; output?: string } {
  const doc = parseDocument(source)
  if (doc.errors.length) throw new ConfigError('cannot plan migration: invalid YAML (source values omitted)')
  let raw: unknown
  try { raw = doc.toJS() } catch { throw new ConfigError('cannot plan migration: invalid YAML aliases') }
  const config = validateConfig(raw)
  const plan: ConfigMigrationPlan = { fromVersion: config.version, toVersion: 2, fingerprint: configFingerprint(source), changes: [], conflicts: [], diagnostics: [] }
  if (config.version === 2) { plan.diagnostics.push('Configuration is already version 2.'); return { plan } }
  const plugins = doc.get('plugins', true)
  if (!isMap(plugins)) throw new ConfigError('config.plugins must be a YAML mapping')
  const groups: Record<string, Array<{ key: string; name: string; config: PluginConfig; pair: Pair }>> = { console: [], workbench: [] }
  for (const pair of plugins.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') { plan.conflicts.push('Non-string plugin keys cannot be migrated.'); continue }
    const key = pair.key.value
    const { name } = splitPluginKey(key)
    const plugin = config.plugins[key] ?? {}
    if ('$label' in plugin || '$collapsed' in plugin) plan.conflicts.push(`config.plugins.${key}: v1 display-like fields are plugin-owned values; version 2 metadata would change their meaning.`)
    const packageSource = plugin.$package ?? name
    if (packageSource === '@numenjs/workbench/server') plan.conflicts.push(`config.plugins.${key}: legacy standalone Workbench server cannot be combined losslessly.`)
    if (name === 'group') plan.conflicts.push(`config.plugins.${key}: v1 group-like keys need manual migration to preserve plugin meaning.`)
    // v1 builtin names take precedence over $package. Do not guess what the user meant.
    if (builtins.has(name) && plugin.$package !== undefined && plugin.$package !== `cordis:${name}`) {
      plan.conflicts.push(`config.plugins.${key}: explicit package conflicts with the v1 builtin source; resolve it before migrating.`)
      continue
    }
    const resolved = knownLegacyNames.has(name) ? name : packageSource === '@numenjs/workbench/runtime' ? 'workbench' : plugin.$package?.startsWith('cordis:') ? plugin.$package.slice(7) : undefined
    if (!resolved || !knownLegacyNames.has(resolved)) continue
    const family = resolved.startsWith('console') ? 'console' : 'workbench'
    groups[family]!.push({ key, name: resolved, config: plugin, pair })
  }
  const enabledProducts = new Map<string, boolean>()
  for (const [family, members] of Object.entries(groups)) {
    if (!members.length) continue
    const required = family === 'console' ? legacyConsoleNames : legacyWorkbenchNames
    const missing = required.filter(name => !members.some(member => member.name === name))
    const duplicate = required.filter(name => members.filter(member => member.name === name).length > 1)
    if (missing.length) plan.conflicts.push(`${family}: partial legacy assembly; missing ${missing.join(', ')}. No components will be enabled implicitly.`)
    if (duplicate.length) plan.conflicts.push(`${family}: multiple instances of ${duplicate.join(', ')} cannot be combined losslessly.`)
    const enabled = members.map(member => !member.key.startsWith('~') && member.config.$if !== false)
    if (enabled.some(value => value !== enabled[0])) plan.conflicts.push(`${family}: mixed member enablement cannot be represented by one product entry.`)
    enabledProducts.set(family, enabled[0] ?? false)
    for (const member of members) {
      const allowed = fields[member.name] ?? []
      const unknown = Object.keys(member.config).filter(key => !['$if', '$package', ...allowed].includes(key))
      if (unknown.length) plan.conflicts.push(`config.plugins.${member.key}: unsupported fields prevent lossless migration (values omitted).`)
      // Aliases can refer to moved/removed anchors elsewhere. Keep the file untouched rather than break them.
      let referenced = false
      for (const node of [member.pair.key, member.pair.value]) if (isNode(node)) visit(node, { Node(_key, node) { if (isAlias(node) || ('anchor' in node && node.anchor)) referenced = true } })
      if (referenced) plan.conflicts.push(`config.plugins.${member.key}: YAML anchors or aliases require manual migration.`)
    }
    if (!missing.length && !duplicate.length) plan.changes.push(`Combine ${required.length} legacy ${family} entries into ${family}, preserving ${enabled[0] ? 'enabled' : 'disabled'} intent and supported options.`)
  }
  if (enabledProducts.get('workbench') && !enabledProducts.get('console')) plan.diagnostics.push('Workbench remains enabled while Console is unavailable. Verify a compatible external provider; Console will not be enabled automatically.')
  // A reference outside the replaced entries may point at an anchor within them.
  // No referenced node is rewritten automatically (the check above detects its anchor).
  if (plan.conflicts.length) return { plan }

  for (const [family, members] of Object.entries(groups)) {
    if (!members.length) continue
    const primary = members.find(member => member.name === family)!
    const replacement = doc.createNode({}) as YAMLMap
    const primaryValue = primary.pair.value
    if (isNode(primaryValue)) {
      if (primaryValue.commentBefore !== undefined) replacement.commentBefore = primaryValue.commentBefore
      if (primaryValue.comment !== undefined) replacement.comment = primaryValue.comment
    }
    const extraComments: string[] = []
    for (const member of members) {
      const node = member.pair.value
      if (member !== primary && isNode(member.pair.key)) {
        if (member.pair.key.commentBefore) extraComments.push(member.pair.key.commentBefore)
        if (member.pair.key.comment) extraComments.push(member.pair.key.comment)
      }
      if (!isMap(node)) {
        if (member !== primary && isNode(node)) {
          if (node.commentBefore) extraComments.push(node.commentBefore)
          if (node.comment) extraComments.push(node.comment)
        }
        continue
      }
      const content = node.clone() as YAMLMap
      for (const meta of ['$if', '$package']) {
        const metaPair = content.items.find(pair => isScalar(pair.key) && pair.key.value === meta)
        if (member === primary && metaPair) replacement.items.push(metaPair)
        if (member !== primary && metaPair) {
          for (const value of [metaPair.key, metaPair.value]) if (isNode(value)) {
            if (value.commentBefore) extraComments.push(value.commentBefore)
            if (value.comment) extraComments.push(value.comment)
          }
        }
        content.delete(meta)
      }
      if (member === primary && family === 'workbench') replacement.items.push(...content.items)
      else if (consoleSections[member.name]) replacement.set(consoleSections[member.name]!, content)
      if (member !== primary) {
        if (!consoleSections[member.name]) {
          if (node.commentBefore) extraComments.push(node.commentBefore)
          if (node.comment) extraComments.push(node.comment)
          visit(node, { Scalar(_key, scalar) { if (scalar.commentBefore) extraComments.push(scalar.commentBefore); if (scalar.comment) extraComments.push(scalar.comment) } })
        }
      }
    }
    if (extraComments.length) replacement.commentBefore = [replacement.commentBefore, ...extraComments].filter(Boolean).join('\n')
    if ((primary.config.$package ?? splitPluginKey(primary.key).name) === '@numenjs/workbench/runtime') replacement.set('$package', '@numenjs/workbench/plugin')
    primary.pair.value = replacement
    plugins.items = plugins.items.filter(pair => !members.some(member => member !== primary && member.pair === pair))
  }
  doc.set('version', 2)
  try { validateConfig(doc.toJS()) } catch (error) {
    plan.conflicts.push(`Resulting version 2 configuration is invalid: ${(error as Error).message}`)
    return { plan }
  }
  plan.changes.unshift('Set configuration version to 2. Other plugin configuration and data remain unchanged.')
  return { plan, output: String(doc) }
}

export function planConfigMigration(source: string, builtins: ReadonlySet<string>): ConfigMigrationPlan { return buildMigration(source, builtins).plan }

async function restoreFileProtection(filename: string, original: { uid: number; gid: number; mode: number }): Promise<void> {
  const created = await lstat(filename)
  if (created.uid !== original.uid || created.gid !== original.gid) await chown(filename, original.uid, original.gid)
  await chmod(filename, original.mode & 0o777)
}

/** Explicit, serialized migration with a dry-run fingerprint and protected backup. */
export async function applyConfigMigration(filename: string, expectedFingerprint: string, builtins: ReadonlySet<string>): Promise<{ plan: ConfigMigrationPlan; backup: string }> {
  const absolute = resolve(filename)
  const temporary = `${absolute}.${randomUUID()}.tmp`
  const backup = `${absolute}.${randomUUID()}.bak`
  return withConfigFileLock(absolute, async () => {
    try {
      const before = await lstat(absolute)
      if (!before.isFile()) throw new ConfigError('migration requires a regular configuration file, not a symbolic link')
      const source = await readFile(absolute, 'utf8')
      if (configFingerprint(source) !== expectedFingerprint) throw new ConfigError('configuration changed since dry-run; generate and review a new migration plan')
      const { plan, output } = buildMigration(source, builtins)
      if (plan.conflicts.length) throw new ConfigError(`migration blocked: ${plan.conflicts.join('; ')}`)
      if (!output) throw new ConfigError('configuration is already version 2; no migration is needed')
      // Set ownership before restoring any group/other permission bits.
      await writeFile(backup, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await restoreFileProtection(backup, before)
      await writeFile(temporary, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await restoreFileProtection(temporary, before)
      const current = await lstat(absolute)
      if (current.ino !== before.ino || current.dev !== before.dev || current.mode !== before.mode || current.uid !== before.uid || current.gid !== before.gid || configFingerprint(await readFile(absolute, 'utf8')) !== expectedFingerprint) throw new ConfigError('configuration changed during migration; source was left untouched')
      await rename(temporary, absolute)
      return { plan, backup }
    } finally {
      await rm(temporary, { force: true })
    }
  })
}
