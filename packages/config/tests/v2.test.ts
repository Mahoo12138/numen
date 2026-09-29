import { describe, expect, it } from 'vitest'
import { createRuntimeEntries, flattenRuntimeEntries, maxGroupDepth, maxPluginEntries, validateConfig } from '../src/index.js'

const builtins = new Set(['console', 'workbench', 'consoleAuth', 'credentials', 'health', 'group'])
const config = (plugins: Record<string, unknown>) => validateConfig({ version: 2, dataDir: '.numen', plugins })

describe('version 2 groups', () => {
  it('preserves individual intent through nested disabled groups and recursive safe mode', () => {
    const raw = config({ '~group:outer': { $label: 'Integrations', $collapsed: true, plugins: {
      health: {}, 'group:inner': { plugins: { 'external:a': {}, '~external:b': {}, credentials: {} } },
    } } })
    const entries = flattenRuntimeEntries(createRuntimeEntries(raw, builtins, true))
    expect(entries.map(entry => [entry.id, entry.selfEnabled, entry.effectiveEnabled, entry.disabled])).toEqual([
      ['group-outer', false, false, true], ['health', true, false, false], ['group-inner', true, false, false],
      ['external-a', true, false, true], ['external-b', false, false, true], ['credentials', true, false, false],
    ])
    expect(entries[0]).toMatchObject({ label: 'Integrations', collapsed: true, config: {} })
    expect(raw.plugins['~group:outer']).toHaveProperty('plugins.group:inner.plugins.external:a', {})
    const group = raw.plugins['~group:outer']!
    delete raw.plugins['~group:outer']
    raw.plugins['group:outer'] = group
    const enabled = flattenRuntimeEntries(createRuntimeEntries(raw, builtins, false))
    expect(enabled.filter(entry => entry.effectiveEnabled).map(entry => entry.id)).toEqual(['group-outer', 'health', 'group-inner', 'external-a', 'credentials'])
  })

  it('keeps identity after moving and leaves plugin-owned plugins untouched', () => {
    const leaf = { plugins: { arbitrary: { $package: 'some-module' } }, custom: 3 }
    const original = flattenRuntimeEntries(createRuntimeEntries(config({ 'group:a': { plugins: { 'custom:stable': leaf } } }), builtins))[1]!
    const moved = flattenRuntimeEntries(createRuntimeEntries(config({ 'group:b': { plugins: { 'custom:stable': leaf } } }), builtins))[1]!
    expect(moved.id).toBe(original.id)
    expect(moved.config).toEqual(leaf)
    expect(moved.children).toBeUndefined()
  })

  it('rejects normalized global collisions across groups and products across package aliases', () => {
    expect(() => config({ 'group:a': { plugins: { 'custom:a': {} } }, 'custom-a': {} })).toThrow('duplicate plugin entry id')
    for (const source of ['cordis:workbench', '@numenjs/workbench', '@numenjs/workbench/plugin']) {
      expect(() => config({ workbench: {}, 'group:a': { plugins: { other: { $package: source } } } })).toThrow('duplicate workbench')
    }
    expect(() => config({ console: {}, workbench: {} })).not.toThrow()
    expect(() => config({ console: {}, '@numenjs/console': {} })).toThrow('duplicate console')
    expect(() => config({ workbench: {}, '@numenjs/workbench/plugin': {} })).toThrow('duplicate workbench')
    expect(createRuntimeEntries(config({ '@numenjs/console': {} }), builtins, true)[0]).toMatchObject({ name: 'cordis:console', builtin: true, disabled: false })
    for (const source of ['@numenjs/workbench/runtime', '@numenjs/workbench/server']) {
      expect(() => config({ [source]: {} })).toThrow('legacy Workbench subpath')
      expect(() => config({ alias: { $package: source } })).toThrow('legacy Workbench subpath')
    }
  })

  it('identifies sources before rejecting legacy entries and applying safe mode', () => {
    const entries = createRuntimeEntries(config({ console: { $package: '@example/custom-console' }, consoleAuth: { $package: '@example/custom-auth' }, alias: { $package: '@numenjs/console' } }), builtins, true)
    expect(entries.map(entry => [entry.name, entry.builtin, entry.disabled])).toEqual([
      ['@example/custom-console', false, true], ['@example/custom-auth', false, true], ['cordis:console', true, false],
    ])
    expect(() => config({ 'group:a': { plugins: { custom: { $package: 'cordis:consoleAuth' } } } })).toThrow('legacy consoleAuth')
    expect(() => config({ console: {}, consoleAuth: {} })).toThrow('legacy consoleAuth')
    for (const source of ['constructor', 'toString', '__proto__']) {
      expect(createRuntimeEntries(config({ alias: { $package: source } }), builtins)[0]).toMatchObject({ name: source, builtin: false })
      expect(() => config({ [source]: {} })).toThrow('reserved by the installed loader')
    }
  })

  it('validates metadata, reserved group syntax, cycles, depth and node limits', () => {
    for (const plugins of [{ group: {} }, { 'group:a': { $package: 'third-party', plugins: {} } }, { 'group:a': null }, { 'group:a': { plugins: {}, extra: true } }, { custom: { $label: 12 } }, { custom: { $collapsed: 'yes' } }, { custom: { $package: 'cordis:group' } }]) {
      expect(() => config(plugins)).toThrow()
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(() => config({ custom: cycle })).toThrow('cyclic')
    let nested: Record<string, unknown> = { health: {} }
    for (let index = 0; index <= maxGroupDepth; index++) nested = { [`group:${index}`]: { plugins: nested } }
    expect(() => config(nested)).toThrow('maximum group depth')
    expect(() => config(Object.fromEntries(Array.from({ length: maxPluginEntries + 1 }, (_, index) => [`custom:${index}`, {}])))).toThrow('maximum plugin entries')
  })
})
