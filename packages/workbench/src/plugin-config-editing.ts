/** Paths use string keys for objects and numeric indexes for arrays. */
export type PluginConfigPath = readonly (string | number)[]
export type PluginConfig = Record<string, unknown>
export type PluginConfigRead = { present: true; value: unknown } | { present: false }
export type PluginConfigParse = { ok: true; config: PluginConfig } | { ok: false; reason: 'invalid-json' | 'not-object' | 'invalid-value' }
export type PluginConfigPatch = { kind: 'set'; value: unknown } | { kind: 'remove' }
export type PluginConfigPatchResult = { ok: true; config: PluginConfig; changed: boolean } | { ok: false; reason: 'invalid-path' | 'invalid-value' | 'incompatible-container' }

type Container = Record<string, unknown> | unknown[]
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key)
const object = (value: unknown): value is PluginConfig => !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const container = (value: unknown): value is Container => Array.isArray(value) || object(value)
const validSegment = (segment: string | number) => typeof segment === 'string' || (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0)
const compatible = (value: Container, segment: string | number) => Array.isArray(value) ? typeof segment === 'number' : typeof segment === 'string'
const property = (value: Container, segment: string | number) => Object.getOwnPropertyDescriptor(value, segment)

/** Parsing never applies schema defaults or discards unknown fields. */
export function parsePluginConfig(text: string): PluginConfigParse {
  let value: unknown
  try { value = JSON.parse(text) } catch { return { ok: false, reason: 'invalid-json' } }
  if (!object(value)) return { ok: false, reason: 'not-object' }
  // JSON.parse accepts numbers such as 1e400, which become Infinity and would save as null.
  if (!copyJsonValue(value).ok) return { ok: false, reason: 'invalid-value' }
  return { ok: true, config: value }
}

/** Inherited properties are never configuration values, including __proto__ and constructor. */
export function readPluginConfigPath(config: PluginConfig, path: PluginConfigPath): PluginConfigRead {
  let value: unknown = config
  for (const segment of path) {
    if (!validSegment(segment) || !container(value) || !compatible(value, segment)) return { present: false }
    const descriptor = property(value, segment)
    if (!descriptor || !('value' in descriptor)) return { present: false }
    value = descriptor.value
  }
  return { present: true, value }
}

/**
 * Copy only edited ancestors. Unknown siblings, absent defaults, and explicit null/empty values
 * survive unchanged. An existing scalar is never replaced implicitly to reach a nested field.
 */
export function patchPluginConfig(config: PluginConfig, path: PluginConfigPath, patch: PluginConfigPatch): PluginConfigPatchResult {
  if (!object(config)) return { ok: false, reason: 'incompatible-container' }
  if (path.some(segment => !validSegment(segment))) return { ok: false, reason: 'invalid-path' }
  let nextValue: unknown
  if (patch.kind === 'set') {
    const copied = copyJsonValue(patch.value)
    if (!copied.ok) return { ok: false, reason: 'invalid-value' }
    nextValue = copied.value
  }
  if (!path.length) {
    if (patch.kind !== 'set' || !object(nextValue)) return { ok: false, reason: 'invalid-value' }
    return { ok: true, config: nextValue, changed: nextValue !== config }
  }
  const parents: Array<{ value: Container; segment: string | number }> = []
  let current: Container = config
  for (let index = 0; index < path.length; index++) {
    const segment = path[index]!
    if (!compatible(current, segment)) return { ok: false, reason: 'incompatible-container' }
    if (Array.isArray(current) && (segment as number) > current.length) return { ok: false, reason: 'invalid-path' }
    const descriptor = property(current, segment)
    if (descriptor && !('value' in descriptor)) return { ok: false, reason: 'invalid-value' }
    const present = !!descriptor
    if (patch.kind === 'remove' && !present) return { ok: true, config, changed: false }
    parents.push({ value: current, segment })
    if (index === path.length - 1) {
      if (patch.kind === 'set' && present && Object.is(descriptor!.value, nextValue)) return { ok: true, config, changed: false }
      break
    }
    if (present) {
      if (!container(descriptor!.value)) return { ok: false, reason: 'incompatible-container' }
      current = descriptor!.value
    } else current = typeof path[index + 1] === 'number' ? [] : {}
  }
  for (let index = parents.length - 1; index >= 0; index--) {
    const { value, segment } = parents[index]!
    const copy: Container = Array.isArray(value) ? value.slice() : { ...value }
    if (index === parents.length - 1 && patch.kind === 'remove') {
      if (Array.isArray(copy)) copy.splice(segment as number, 1)
      else delete copy[segment]
    } else {
      // Assignment to __proto__ invokes a setter on ordinary objects; defining an own key does not.
      Object.defineProperty(copy, segment, { value: nextValue, enumerable: true, configurable: true, writable: true })
    }
    nextValue = copy
  }
  return { ok: true, config: nextValue as PluginConfig, changed: true }
}

/** Copy a JSON tree iteratively so unknown deeply nested values do not consume the JS call stack. */
function copyJsonValue(value: unknown): { ok: true; value: unknown } | { ok: false } {
  const holder: Record<string, unknown> = {}
  const active = new Set<object>()
  type Frame = { kind: 'value'; source: unknown; target: Container; key: string | number } | { kind: 'leave'; source: object }
  const stack: Frame[] = [{ kind: 'value', source: value, target: holder, key: 'value' }]
  while (stack.length) {
    const frame = stack.pop()!
    if (frame.kind === 'leave') { active.delete(frame.source); continue }
    const { source, target, key } = frame
    let copy: unknown = source
    if (source !== null && typeof source === 'object') {
      if (!container(source) || active.has(source)) return { ok: false }
      active.add(source)
      stack.push({ kind: 'leave', source })
      copy = Array.isArray(source) ? [] : {}
      const keys = Object.keys(source)
      if (Array.isArray(source) && (keys.length !== source.length || keys.some((item, index) => item !== String(index)))) return { ok: false }
      if (Object.getOwnPropertySymbols(source).length) return { ok: false }
      for (let index = keys.length - 1; index >= 0; index--) {
        const childKey = keys[index]!, descriptor = property(source, childKey)!
        if (!('value' in descriptor)) return { ok: false }
        stack.push({ kind: 'value', source: descriptor.value, target: copy as Container, key: childKey })
      }
    } else if (!(source === null || typeof source === 'string' || typeof source === 'boolean' || (typeof source === 'number' && Number.isFinite(source)))) return { ok: false }
    Object.defineProperty(target, key, { value: copy, enumerable: true, configurable: true, writable: true })
  }
  return { ok: true, value: holder.value }
}
