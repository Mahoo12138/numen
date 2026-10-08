import { describe, expect, it } from 'vitest'
import { parsePluginConfig, patchPluginConfig, readPluginConfigPath, type PluginConfig, type PluginConfigPatch, type PluginConfigPath } from '../src/plugin-config-editing.js'

function patch(config: PluginConfig, path: PluginConfigPath, operation: PluginConfigPatch): PluginConfig {
  const result = patchPluginConfig(config, path, operation)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  return result.config
}

describe('plugin configuration JSON editing', () => {
  it('parses objects without materializing defaults or removing unknown and special own keys', () => {
    const text = '{"empty":"","nil":null,"off":false,"zero":0,"nested":{"retained":true},"__proto__":{"safe":true},"constructor":{"prototype":{"safe":true}}}'
    const result = parsePluginConfig(text)
    expect(result).toEqual({ ok: true, config: JSON.parse(text) })
    if (!result.ok) throw new Error(result.reason)
    expect(Object.hasOwn(result.config, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(result.config)).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'safe')).toBe(false)
  })

  it.each(['', '{', '{"unfinished":', 'undefined'])('rejects invalid JSON without manufacturing an empty configuration: %s', text => {
    expect(parsePluginConfig(text)).toEqual({ ok: false, reason: 'invalid-json' })
  })

  it.each(['[]', 'null', 'true', '0', '"text"'])('rejects a non-object root: %s', text => {
    expect(parsePluginConfig(text)).toEqual({ ok: false, reason: 'not-object' })
  })

  it('rejects overflow numbers that JSON serialization would silently change to null', () => {
    expect(parsePluginConfig('{"unknown":{"number":1e400}}')).toEqual({ ok: false, reason: 'invalid-value' })
  })

  it('distinguishes absent values from all falsy values and never reads inherited keys', () => {
    const config = { empty: '', nil: null, off: false, zero: 0, list: [false, null] }
    for (const [key, value] of Object.entries(config)) expect(readPluginConfigPath(config, [key])).toEqual({ present: true, value })
    expect(readPluginConfigPath(config, ['list', 1])).toEqual({ present: true, value: null })
    for (const path of [['missing'], ['__proto__'], ['constructor'], ['list', 'length'], ['list', '0'], ['list', -1], ['list', 0.5]]) {
      expect(readPluginConfigPath(config, path)).toEqual({ present: false })
    }
  })

  it('changes one nested field while preserving unknown siblings and the original document', () => {
    const original = { nested: { field: 'old', unknown: { data: [1, 2, 3] }, empty: '' }, extension: { future: true } }
    const changed = patch(original, ['nested', 'field'], { kind: 'set', value: 'new' })
    expect(changed).toEqual({ ...original, nested: { ...original.nested, field: 'new' } })
    expect(original.nested.field).toBe('old')
    expect(changed.nested).not.toBe(original.nested)
    expect(changed.extension).toBe(original.extension)
    expect((changed.nested as typeof original.nested).unknown).toBe(original.nested.unknown)
  })

  it('creates only the explicitly edited missing path and never replaces incompatible existing ancestors', () => {
    const original = { sibling: 'kept', explicitNull: null, explicitEmpty: '', false: false, zero: 0 }
    expect(patch(original, ['optional', 'value'], { kind: 'set', value: 7 })).toEqual({ ...original, optional: { value: 7 } })
    expect(patch(original, ['optional', 'items', 0, 'enabled'], { kind: 'set', value: true })).toEqual({ ...original, optional: { items: [{ enabled: true }] } })
    for (const name of ['explicitNull', 'explicitEmpty', 'false', 'zero']) {
      expect(patchPluginConfig(original, [name, 'value'], { kind: 'set', value: 1 })).toEqual({ ok: false, reason: 'incompatible-container' })
    }
    expect(original).toEqual({ sibling: 'kept', explicitNull: null, explicitEmpty: '', false: false, zero: 0 })
  })

  it('removes only the selected key, leaving an explicit empty parent and unknown keys intact', () => {
    const original = { nested: { remove: null, unknown: false }, optional: { only: '' } }
    const changed = patch(patch(original, ['nested', 'remove'], { kind: 'remove' }), ['optional', 'only'], { kind: 'remove' })
    expect(changed).toEqual({ nested: { unknown: false }, optional: {} })
    expect(original).toEqual({ nested: { remove: null, unknown: false }, optional: { only: '' } })
    expect(patchPluginConfig(original, ['missing', 'child'], { kind: 'remove' })).toEqual({ ok: true, config: original, changed: false })
  })

  it('supports replace, append and delete in arrays without truncating unknown item properties or making sparse arrays', () => {
    const original = { array: [{ field: 'first', unknown: 1 }, { field: 'second', unknown: 2 }], keep: true }
    let changed = patch(original, ['array', 1, 'field'], { kind: 'set', value: 'edited' })
    changed = patch(changed, ['array', 2], { kind: 'set', value: { field: 'last', extra: null } })
    changed = patch(changed, ['array', 0], { kind: 'remove' })
    expect(changed).toEqual({ array: [{ field: 'edited', unknown: 2 }, { field: 'last', extra: null }], keep: true })
    expect(original.array).toHaveLength(2)
    for (const index of [3, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(patchPluginConfig(original, ['array', index], { kind: 'set', value: true }).ok).toBe(false)
    }
    expect(patchPluginConfig(original, ['array', '0'], { kind: 'set', value: true })).toEqual({ ok: false, reason: 'incompatible-container' })
  })

  it('treats special keys as own JSON data and never mutates object prototypes', () => {
    let config: PluginConfig = JSON.parse('{"__proto__":{"kept":true},"constructor":{"prototype":{"kept":true}}}')
    config = patch(config, ['__proto__', 'polluted'], { kind: 'set', value: 'safe data' })
    config = patch(config, ['constructor', 'prototype', 'polluted'], { kind: 'set', value: 'also data' })
    expect(JSON.stringify(config)).toBe('{"__proto__":{"kept":true,"polluted":"safe data"},"constructor":{"prototype":{"kept":true,"polluted":"also data"}}}')
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
    expect(patch({}, ['__proto__', 'new'], { kind: 'set', value: 1 })).toEqual(JSON.parse('{"__proto__":{"new":1}}'))
    expect(patch(config, ['__proto__'], { kind: 'remove' })).toEqual({ constructor: { prototype: { kept: true, polluted: 'also data' } } })
  })

  it('detaches inserted values, including repeated references, from later caller mutation', () => {
    const nested = { field: 'initial' }, value = { first: nested, second: nested }
    const changed = patch({}, ['value'], { kind: 'set', value })
    nested.field = 'later'
    expect(changed).toEqual({ value: { first: { field: 'initial' }, second: { field: 'initial' } } })
  })

  it('rejects lossy or executable values without invoking accessors or modifying input', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    let getterCalled = false
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => { getterCalled = true; return 'bad' } })
    const sparse = Array(1)
    const symbol = { [Symbol('hidden')]: 'hidden' }
    for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), cyclic, accessor, sparse, symbol, { nested: undefined }]) {
      const original = { kept: true }
      expect(patchPluginConfig(original, ['value'], { kind: 'set', value })).toEqual({ ok: false, reason: 'invalid-value' })
      expect(original).toEqual({ kept: true })
    }
    expect(getterCalled).toBe(false)
  })

  it('preserves large unknown arrays and deep unknown subtrees without schema rendering limits', () => {
    const text = `{"unknownArray":[${Array.from({ length: 2000 }, (_, index) => index).join(',')}],"deep":${'{"child":'.repeat(1500)}true${'}'.repeat(1500)},"field":"old"}`
    const parsed = parsePluginConfig(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.reason)
    const changed = patch(parsed.config, ['field'], { kind: 'set', value: 'new' })
    expect(changed.unknownArray).toBe(parsed.config.unknownArray)
    expect(changed.deep).toBe(parsed.config.deep)
    expect(JSON.stringify(changed)).toContain('"field":"new"')
    expect((changed.unknownArray as unknown[]).length).toBe(2000)
  })

  it('makes equal scalar sets and missing removes no-ops while keeping empty and absent values distinct', () => {
    const config = { value: '', optional: { child: true } }
    expect(patchPluginConfig(config, ['value'], { kind: 'set', value: '' })).toEqual({ ok: true, config, changed: false })
    expect(patchPluginConfig(config, ['absent'], { kind: 'remove' })).toEqual({ ok: true, config, changed: false })
    expect(patch(config, ['value'], { kind: 'remove' })).toEqual({ optional: { child: true } })
  })

  it('allows explicit replacement with another object but rejects removing or changing the root to a scalar', () => {
    expect(patch({ old: true }, [], { kind: 'set', value: { new: false } })).toEqual({ new: false })
    expect(patchPluginConfig({}, [], { kind: 'remove' })).toEqual({ ok: false, reason: 'invalid-value' })
    expect(patchPluginConfig({}, [], { kind: 'set', value: [] })).toEqual({ ok: false, reason: 'invalid-value' })
  })
})
