import { chmod, chown, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit, type Pair, type YAMLMap } from 'yaml'
import { createRuntimeEntries, flattenRuntimeEntries, validateConfig } from './config.js'
import { configFingerprint } from './migration.js'
import { HostConfigError, type HostConfigOperation } from './management-types.js'
import { withConfigFileLock } from './persistence.js'
import type { NumenConfig, RuntimeEntry } from './types.js'


function retainComments(previous: unknown, next: unknown): void {
  if (!isNode(previous) || !isNode(next)) return
  if (previous.commentBefore) next.commentBefore = previous.commentBefore
  if (previous.comment) next.comment = previous.comment
  if (isMap(previous) && isMap(next)) {
    for (const pair of next.items) {
      const old = previous.items.find(item => isScalar(item.key) && isScalar(pair.key) && item.key.value === pair.key.value)
      if (!old) continue
      retainComments(old.key, pair.key)
      retainComments(old.value, pair.value)
    }
  } else if (isSeq(previous) && isSeq(next)) {
    next.items.forEach((item, index) => retainComments(previous.items[index], item))
  }
}

export interface ManagedConfigDocument {
  source: string
  fingerprint: string
  config: NumenConfig
  entries: RuntimeEntry[]
}

export function parseManagedConfig(source: string, builtins: ReadonlySet<string>, safeMode = false): ManagedConfigDocument {
  const doc = parseDocument(source)
  if (doc.errors.length) throw new HostConfigError('CONFIG_INVALID', 'Configuration YAML is invalid; source values are omitted.')
  let config: NumenConfig
  try { config = validateConfig(doc.toJS()) } catch { throw new HostConfigError('CONFIG_INVALID', 'Configuration validation failed; inspect the host configuration locally.') }
  return { source, fingerprint: configFingerprint(source), config, entries: createRuntimeEntries(config, builtins, safeMode) }
}

export async function readManagedConfig(filename: string, builtins: ReadonlySet<string>, safeMode = false): Promise<ManagedConfigDocument> {
  return parseManagedConfig(await readFile(filename, 'utf8'), builtins, safeMode)
}

export function mutateManagedConfig(current: ManagedConfigDocument, operation: HostConfigOperation, builtins: ReadonlySet<string>, safeMode = false): ManagedConfigDocument {
  if (current.config.version !== 2) throw new HostConfigError('MIGRATION_REQUIRED', 'Version 1 configuration is read-only. Run an explicit config migration first.')
  if (!operation || typeof operation !== 'object' || typeof operation.id !== 'string') throw new HostConfigError('OPERATION_INVALID', 'A valid operation and stable entry ID are required.')
  const doc = parseDocument(current.source)
  let aliases = false
  visit(doc, { Node(_key, node) { if (isAlias(node) || ('anchor' in node && node.anchor)) aliases = true } })
  if (aliases) throw new HostConfigError('YAML_ALIASES_UNSUPPORTED', 'This configuration uses YAML anchors or aliases. Edit it locally to preserve reference semantics.')
  const plugins = doc.get('plugins', true)
  if (!isMap(plugins)) throw new HostConfigError('CONFIG_INVALID', 'Plugins must be a YAML mapping.')
  const locations = new Map<string, { pair: Pair; parent: YAMLMap; entry: RuntimeEntry }>()
  const locate = (entries: RuntimeEntry[], parent: YAMLMap): void => {
    for (const entry of entries) {
      const pair = parent.items.find(pair => isScalar(pair.key) && pair.key.value === entry.key)!
      locations.set(entry.id, { pair, parent, entry })
      if (entry.children && isMap(pair.value)) locate(entry.children, pair.value.get('plugins', true) as unknown as YAMLMap)
    }
  }
  locate(current.entries, plugins)
  const selected = locations.get(operation.id)
  const requireSelected = () => { if (!selected) throw new HostConfigError('ENTRY_NOT_FOUND', 'The configured entry no longer exists.'); return selected }
  const values = (pair: Pair): YAMLMap => {
    if (!isMap(pair.value)) {
      const replacement = doc.createNode({}) as YAMLMap
      if (isNode(pair.value)) {
        if (pair.value.comment) replacement.comment = pair.value.comment
        if (pair.value.commentBefore) replacement.commentBefore = pair.value.commentBefore
      }
      pair.value = replacement
    }
    return pair.value as YAMLMap
  }
  const destination = (parentId?: string): YAMLMap => {
    if (parentId === undefined) return plugins
    const group = locations.get(parentId)
    if (!group?.entry.children) throw new HostConfigError('GROUP_NOT_FOUND', 'The target group no longer exists.')
    return values(group.pair).get('plugins', true) as unknown as YAMLMap
  }
  const label = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 160) throw new HostConfigError('OPERATION_INVALID', 'A display label must be at most 160 characters.')
    return value
  }
  switch (operation.kind) {
    case 'createGroup': {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(operation.id)) throw new HostConfigError('OPERATION_INVALID', 'Use a group identifier of 1–80 letters, numbers, dots, underscores or hyphens.')
      const target = destination(operation.parentId)
      const key = `group:${operation.id}`
      if (target.has(key) || locations.has(`group-${operation.id}`)) throw new HostConfigError('ENTRY_CONFLICT', 'That group identifier already exists.')
      target.set(key, doc.createNode({ ...(operation.label === undefined ? {} : { $label: label(operation.label) }), plugins: {} }))
      break
    }
    case 'setEnabled': {
      if (typeof operation.enabled !== 'boolean') throw new HostConfigError('OPERATION_INVALID', 'Enabled must be a boolean.')
      const { pair, entry } = requireSelected()
      if (entry.selfEnabled === operation.enabled) return current
      if (operation.enabled && isScalar(pair.key) && entry.key.startsWith('~')) pair.key.value = entry.key.slice(1)
      values(pair).set('$if', operation.enabled)
      break
    }
    case 'setLabel': values(requireSelected().pair).set('$label', label(operation.label)); break
    case 'setCollapsed': {
      if (typeof operation.collapsed !== 'boolean') throw new HostConfigError('OPERATION_INVALID', 'Collapsed must be a boolean.')
      const { pair, entry } = requireSelected()
      if (!entry.children) throw new HostConfigError('GROUP_REQUIRED', 'Only groups can be collapsed.')
      values(pair).set('$collapsed', operation.collapsed)
      break
    }
    case 'removeGroup': {
      const { pair, parent, entry } = requireSelected()
      if (!entry.children) throw new HostConfigError('GROUP_REQUIRED', 'Only groups can be removed by this operation.')
      if (entry.children.length) throw new HostConfigError('GROUP_NOT_EMPTY', 'Move the group members out before removing the group.')
      parent.items = parent.items.filter(item => item !== pair)
      break
    }
    case 'move': {
      const { pair, parent } = requireSelected()
      let ancestor = operation.parentId
      while (ancestor) {
        if (ancestor === operation.id) throw new HostConfigError('GROUP_CYCLE', 'An entry cannot be moved into itself or its descendants.')
        ancestor = locations.get(ancestor)?.entry.parentId
      }
      const target = destination(operation.parentId)
      if (target === parent) return current
      parent.items = parent.items.filter(item => item !== pair)
      target.items.push(pair)
      break
    }
    case 'setConfig': {
      const { pair, entry } = requireSelected()
      if (entry.children) throw new HostConfigError('PLUGIN_REQUIRED', 'Group metadata must be changed with group operations.')
      if (!operation.config || typeof operation.config !== 'object' || Array.isArray(operation.config) || Object.keys(operation.config).some(key => key.startsWith('$'))) throw new HostConfigError('OPERATION_INVALID', 'Plugin configuration must be an object without loader metadata.')
      const existing = values(pair)
      const updated = doc.createNode(operation.config) as YAMLMap
      // Reuse unchanged YAML values and their comments; removed fields are explicit edits.
      for (const item of updated.items) {
        const old = existing.items.find(pair => isScalar(pair.key) && isScalar(item.key) && pair.key.value === item.key.value)
        if (!old) continue
        retainComments(old.key, item.key)
        retainComments(old.value, item.value)
        if (isNode(old.value) && isNode(item.value) && JSON.stringify(old.value.toJSON()) === JSON.stringify(item.value.toJSON())) item.value = old.value
      }
      updated.items.unshift(...existing.items.filter(pair => isScalar(pair.key) && String(pair.key.value).startsWith('$')))
      if (existing.commentBefore) updated.commentBefore = existing.commentBefore
      if (existing.comment) updated.comment = existing.comment
      pair.value = updated
      break
    }
    default: throw new HostConfigError('OPERATION_INVALID', 'Unsupported configuration operation.')
  }
  return parseManagedConfig(String(doc), builtins, safeMode)
}

/** Serialized CAS across Config's writers; preserves ownership and mode before rename. */
export async function commitManagedConfig(filename: string, expectedFingerprint: string, prepare: (current: ManagedConfigDocument) => Promise<ManagedConfigDocument>, builtins: ReadonlySet<string>, safeMode = false): Promise<ManagedConfigDocument> {
  const absolute = resolve(filename)
  return withConfigFileLock(absolute, async () => {
    const before = await lstat(absolute)
    if (!before.isFile()) throw new HostConfigError('CONFIG_FILE_UNSUPPORTED', 'Configuration management requires a regular file.')
    const current = await readManagedConfig(absolute, builtins, safeMode)
    if (current.fingerprint !== expectedFingerprint) throw new HostConfigError('CONFIG_CONFLICT', 'Configuration changed. Refresh the current state and review your pending edits.')
    const next = await prepare(current)
    if (next.source === current.source) return current
    const temporary = `${absolute}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, next.source, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      const created = await lstat(temporary)
      if (created.uid !== before.uid || created.gid !== before.gid) await chown(temporary, before.uid, before.gid)
      await chmod(temporary, before.mode & 0o777)
      const latest = await lstat(absolute)
      if (latest.ino !== before.ino || latest.dev !== before.dev || latest.mode !== before.mode || latest.uid !== before.uid || latest.gid !== before.gid || configFingerprint(await readFile(absolute, 'utf8')) !== expectedFingerprint) throw new HostConfigError('CONFIG_CONFLICT', 'Configuration changed during the write. Your edits were not saved.')
      await rename(temporary, absolute)
      return next
    } finally { await rm(temporary, { force: true }) }
  })
}
