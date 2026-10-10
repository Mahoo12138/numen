import {
  CoreExpressionFunctionError,
  coreExpressionFunctions,
  evaluateCoreExpressionFunction,
  getCoreExpressionFunction,
  type NumenValue,
} from '../src/index.js'
import { describe, expect, it } from 'vitest'

describe('core expression functions', () => {
  it('exposes one stable, unique catalog for runtime and authoring adapters', () => {
    const ids = coreExpressionFunctions.map(definition => definition.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      'core:eq',
      'core:gt',
      'core:gte',
      'core:lt',
      'core:lte',
      'core:not',
      'core:and',
      'core:or',
      'core:coalesce',
      'core:add',
      'core:length',
      'core:contains',
      'core:to-string',
    ])
    expect(getCoreExpressionFunction('core:add')).toMatchObject({
      outputType: 'number',
      variadic: { valueType: 'number' },
    })
    for (const name of ['core:gt', 'core:gte', 'core:lt', 'core:lte']) {
      expect(getCoreExpressionFunction(name)).toMatchObject({
        outputType: 'boolean', arguments: [{ valueType: 'number' }, { valueType: 'number' }],
      })
    }
    expect(getCoreExpressionFunction('core:length')).toMatchObject({
      outputType: 'number', arguments: [{ valueType: 'unknown' }],
    })
    expect(getCoreExpressionFunction('core:contains')).toMatchObject({
      outputType: 'boolean', arguments: [{ valueType: 'string' }, { valueType: 'string' }],
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

  it.each([
    ['core:gt', [false, false, true]],
    ['core:gte', [false, true, true]],
    ['core:lt', [true, false, false]],
    ['core:lte', [true, true, false]],
  ] as const)('compares finite numbers using %s without coercion', (name, results) => {
    for (const [index, left] of [-1.5, 0, Number.MAX_VALUE].entries()) {
      expect(evaluateCoreExpressionFunction(name, [left, 0])).toBe(results[index])
    }
    expect(evaluateCoreExpressionFunction(name, [-0, 0])).toBe(results[1])
    expect(evaluateCoreExpressionFunction(name, [-Number.MAX_VALUE, Number.MIN_VALUE])).toBe(results[0])
    for (const invalid of ['0', null, false, [], {}, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => evaluateCoreExpressionFunction(name, [invalid, 0])).toThrow('expects finite number arguments')
      expect(() => evaluateCoreExpressionFunction(name, [0, invalid])).toThrow('expects finite number arguments')
    }
  })

  it.each([
    ['', 0],
    ['hello', 5],
    ['中文', 2],
    ['a😀', 2],
    ['e\u0301', 2],
    ['👩‍💻', 3],
    [[], 0],
    [[null, ['nested', 'items'], { value: true }], 3],
  ] satisfies Array<[NumenValue, number]>)('counts text code points and array items for %j', (value, length) => {
    const original = structuredClone(value)
    expect(evaluateCoreExpressionFunction('core:length', [value])).toBe(length)
    expect(value).toEqual(original)
  })

  it('rejects values that have no text or array length', () => {
    for (const value of [null, 0, false, {}, { length: 3 }, { $resource: 'file' }]) {
      expect(() => evaluateCoreExpressionFunction('core:length', [value])).toThrow('expects text or an array')
    }
  })

  it('checks literal, case-sensitive substrings including empty and Unicode text', () => {
    expect(evaluateCoreExpressionFunction('core:contains', ['Ready', 'ead'])).toBe(true)
    expect(evaluateCoreExpressionFunction('core:contains', ['Ready', 'ready'])).toBe(false)
    expect(evaluateCoreExpressionFunction('core:contains', ['ready', '.*'])).toBe(false)
    expect(evaluateCoreExpressionFunction('core:contains', ['你好😀', '好😀'])).toBe(true)
    expect(evaluateCoreExpressionFunction('core:contains', ['', ''])).toBe(true)
    expect(evaluateCoreExpressionFunction('core:contains', ['text', ''])).toBe(true)
    expect(evaluateCoreExpressionFunction('core:contains', ['', 'text'])).toBe(false)
    for (const value of [null, 0, false, ['text'], { text: 'text' }]) {
      expect(() => evaluateCoreExpressionFunction('core:contains', [value, 'text'])).toThrow('expects string arguments')
      expect(() => evaluateCoreExpressionFunction('core:contains', ['text', value])).toThrow('expects string arguments')
    }
  })

  it.each(['core:gt', 'core:gte', 'core:lt', 'core:lte', 'core:length', 'core:contains'])('enforces catalog arity for %s', (name) => {
    const minimum = getCoreExpressionFunction(name)!.arguments.length
    for (const length of [0, minimum - 1, minimum + 1]) {
      expect(() => evaluateCoreExpressionFunction(name, Array.from({ length }, () => null)))
        .toThrow(`${name} expects ${minimum} argument`)
    }
  })
})
