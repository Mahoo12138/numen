import type { NumenValue, ValueExpr } from '@numenjs/core'

export type CollectionExpression = Extract<ValueExpr, { type: 'object' | 'array' }>

/** JSON permits lone UTF-16 surrogates; encode those without URIError or key collisions. */
export function collectionMemberKey(value: string): string {
  return Array.from(value, character => {
    const point = character.codePointAt(0)!
    return point >= 0xd800 && point <= 0xdfff ? `%u${point.toString(16)}` : encodeURIComponent(character)
  }).join('')
}

/** An explicit mode change keeps compatible literal data, without evaluating expressions. */
export function toCollectionExpression(expression: ValueExpr | undefined, type: 'object' | 'array'): CollectionExpression {
  if (expression?.type === type) return expression
  if (type === 'array') return {
    type,
    items: expression?.type === 'literal' && Array.isArray(expression.value)
      ? expression.value.map(value => ({ type: 'literal', value })) : [],
  }
  return {
    type,
    entries: expression?.type === 'literal' && expression.value !== null && typeof expression.value === 'object' && !Array.isArray(expression.value)
      ? Object.fromEntries(Object.entries(expression.value).map(([key, value]) => [key, { type: 'literal', value }])) : {},
  }
}

/** Only static collections can round-trip to Literal; refs/templates/calls are never resolved here. */
export function collectionLiteral(expression: ValueExpr | undefined): Extract<ValueExpr, { type: 'literal' }> | undefined {
  if (expression?.type === 'literal') return expression
  if (expression?.type === 'array') {
    const items = expression.items.map(collectionLiteral)
    if (items.some(item => !item)) return
    return { type: 'literal', value: items.map(item => item!.value) }
  }
  if (expression?.type === 'object') {
    const entries: Array<[string, NumenValue]> = []
    for (const [key, value] of Object.entries(expression.entries)) {
      const literal = collectionLiteral(value)
      if (!literal) return
      entries.push([key, literal.value])
    }
    return { type: 'literal', value: Object.fromEntries(entries) }
  }
}

/** Renames without overwriting siblings, changing value identity, or interpreting property names. */
export function renameCollectionField(expression: Extract<ValueExpr, { type: 'object' }>, from: string, to: string): Extract<ValueExpr, { type: 'object' }> {
  if (!Object.hasOwn(expression.entries, from) || from === to) return expression
  if (Object.hasOwn(expression.entries, to)) throw new TypeError('duplicate object field')
  return { type: 'object', entries: Object.fromEntries(Object.entries(expression.entries).map(([key, value]) => [key === from ? to : key, value])) }
}
