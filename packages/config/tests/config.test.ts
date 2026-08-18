import { describe, expect, it } from 'vitest'
import { ConfigError, createRuntimeEntries, validateConfig } from '../src/index.js'

describe('configuration', () => {
  it('maps Koishi-style keys to stable Cordis entries', () => {
    const config = validateConfig({
      version: 1,
      dataDir: '.numen',
      plugins: {
        database: { path: '.numen/test.db' },
        'github:personal': { token: 'not-a-real-secret' },
        '~telegram:disabled': null,
      },
    })

    const entries = createRuntimeEntries(config, new Set(['database']))
    expect(entries).toEqual([
      {
        id: 'database',
        key: 'database',
        name: 'cordis:database',
        config: { path: '.numen/test.db' },
        disabled: false,
        builtin: true,
      },
      {
        id: 'github-personal',
        key: 'github:personal',
        name: 'numen-plugin-github',
        config: { token: 'not-a-real-secret' },
        disabled: false,
        builtin: false,
      },
      {
        id: 'telegram-disabled',
        key: '~telegram:disabled',
        name: 'numen-plugin-telegram',
        config: {},
        disabled: true,
        builtin: false,
      },
    ])
  })

  it('disables third-party plugins in safe mode without changing config', () => {
    const config = validateConfig({
      version: 1,
      dataDir: '.numen',
      plugins: { health: {}, example: {} },
    })
    const entries = createRuntimeEntries(config, new Set(['health']), true)
    expect(entries.map(({ disabled }) => disabled)).toEqual([false, true])
    expect(config.plugins.example).toEqual({})
  })

  it('rejects invalid meta values', () => {
    expect(() => validateConfig({
      version: 1,
      dataDir: '.numen',
      plugins: { example: { $if: 'yes' } },
    })).toThrow(ConfigError)
  })
})
