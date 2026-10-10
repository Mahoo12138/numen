import { describe, expect, it } from 'vitest'
import type { ValueExpr } from '@numenjs/core'
import { collectionLiteral, collectionMemberKey, renameCollectionField, toCollectionExpression } from '../src/collection-expression.js'

describe('collection expression editing', () => {
  it('encodes JSON keys including lone surrogates without collisions', () => {
    const keys = ['a/b', 'a%2Fb', '\ud800', '%ud800', '\udc00', '😀', '', '__proto__']
    const encoded = keys.map(collectionMemberKey)
    expect(new Set(encoded).size).toBe(keys.length)
    expect(encoded[0]).toBe('a%2Fb')
    expect(encoded[2]).toBe('%ud800')
  })
  it('round-trips empty and nested literal values without evaluating or coercing them', () => {
    for (const value of [{}, [], { nothing: null, disabled: false, blank: '', nested: [0, { flag: true }] }, [null, false, 0, '', [], {}]]) {
      const expression: ValueExpr = { type: 'literal', value }
      const collection = toCollectionExpression(expression, Array.isArray(value) ? 'array' : 'object')
      expect(collectionLiteral(collection)).toEqual(expression)
      expect(expression.value).toEqual(value)
    }
  })

  it('preserves prototype-shaped and empty property names, rejects duplicate renames without overwriting', () => {
    const expression = toCollectionExpression({ type: 'literal', value: JSON.parse('{"__proto__":{"private":true},"constructor":false,"":null}') }, 'object')
    if (expression.type !== 'object') throw new Error('object expected')
    const snapshot = JSON.stringify(expression)
    expect(() => renameCollectionField(expression, '', 'constructor')).toThrow('duplicate')
    expect(JSON.stringify(expression)).toBe(snapshot)
    const renamed = renameCollectionField(expression, '__proto__', 'renamed')
    expect(Object.keys(renamed.entries)).toEqual(['renamed', 'constructor', ''])
    expect(renamed.entries.renamed).toBe(expression.entries.__proto__)
    expect(Object.getPrototypeOf(renamed.entries)).toBe(Object.prototype)
    const restored = renameCollectionField(renamed, 'renamed', '__proto__')
    expect(collectionLiteral(restored)).toEqual(collectionLiteral(expression))
    expect(renameCollectionField(expression, 'missing', 'constructor')).toBe(expression)
  })

  it('never materializes dynamic nested values into a literal', () => {
    for (const child of [
      { type: 'ref', path: 'input.value' },
      { type: 'template', parts: ['literal-looking template'] },
      { type: 'call', function: 'core:add', arguments: [{ type: 'literal', value: 2 }, { type: 'literal', value: 3 }] },
    ] satisfies ValueExpr[]) {
      const expression: ValueExpr = { type: 'object', entries: { mixed: { type: 'array', items: [{ type: 'literal', value: 1 }, child] } } }
      expect(toCollectionExpression(expression, 'object')).toBe(expression)
      expect(collectionLiteral(expression)).toBeUndefined()
    }
  })
})
