import {
  CoreExpressionFunctionError,
  coreExpressionFunctions,
  evaluateCoreExpressionFunction,
  getCoreExpressionFunction,
} from '../src/index.js'
import { describe, expect, it } from 'vitest'

describe('core expression functions', () => {
  it('exposes one stable, unique catalog for runtime and authoring adapters', () => {
    const ids = coreExpressionFunctions.map(definition => definition.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      'core:eq',
      'core:not',
      'core:and',
      'core:or',
      'core:coalesce',
      'core:add',
      'core:to-string',
    ])
    expect(getCoreExpressionFunction('core:add')).toMatchObject({
      outputType: 'number',
      variadic: { valueType: 'number' },
    })
  })

  it('evaluates the stable pure functions without arbitrary code execution', () => {
    expect(evaluateCoreExpressionFunction('core:eq', [{ a: 1 }, { a: 1 }])).toBe(true)
    expect(evaluateCoreExpressionFunction('core:not', [false])).toBe(true)
    expect(evaluateCoreExpressionFunction('core:and', [true, true, false])).toBe(false)
    expect(evaluateCoreExpressionFunction('core:or', [false, true])).toBe(true)
    expect(evaluateCoreExpressionFunction('core:coalesce', [null, 'ready'])).toBe('ready')
    expect(evaluateCoreExpressionFunction('core:add', [1, 2, 3])).toBe(6)
    expect(evaluateCoreExpressionFunction('core:to-string', [{ ready: true }])).toBe('{"ready":true}')
  })

  it('rejects unavailable functions, invalid arity, and invalid argument types', () => {
    expect(() => evaluateCoreExpressionFunction('plugin:eval', ['process.exit()']))
      .toThrow(CoreExpressionFunctionError)
    expect(() => evaluateCoreExpressionFunction('core:not', []))
      .toThrow('expects 1 argument')
    expect(() => evaluateCoreExpressionFunction('core:add', [1, '2']))
      .toThrow('expects number arguments')
  })
})
