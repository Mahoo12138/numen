import { isNumenValue, type NumenValue, type ValueExpr } from '@numen/core'

export interface EvaluationBindings {
  run: Record<string, NumenValue>
  trigger: NumenValue
  input: Record<string, NumenValue>
  steps: Record<string, NumenValue>
  vars: Record<string, NumenValue>
  loop: Record<string, NumenValue>
  error: NumenValue
}

export class ExpressionEvaluationError extends Error {
  override name = 'ExpressionEvaluationError'
}

function resolveReference(path: string, bindings: EvaluationBindings): NumenValue {
  const [root, ...segments] = path.split('.')
  let value: unknown = bindings[root as keyof EvaluationBindings]
  for (const segment of segments) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !(segment in value)) {
      throw new ExpressionEvaluationError(`reference not found: ${path}`)
    }
    value = (value as Record<string, unknown>)[segment]
  }
  if (!isNumenValue(value)) throw new ExpressionEvaluationError(`reference is not a Numen value: ${path}`)
  return value
}

function asBoolean(value: NumenValue, name: string): boolean {
  if (typeof value !== 'boolean') throw new ExpressionEvaluationError(`${name} expects boolean arguments`)
  return value
}

function stringify(value: NumenValue): string {
  if (typeof value === 'string') return value
  if (value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function callFunction(name: string, args: NumenValue[]): NumenValue {
  switch (name) {
    case 'core:eq':
      return JSON.stringify(args[0]) === JSON.stringify(args[1])
    case 'core:not':
      return !asBoolean(args[0] ?? null, name)
    case 'core:and':
      return args.every(value => asBoolean(value, name))
    case 'core:or':
      return args.some(value => asBoolean(value, name))
    case 'core:coalesce':
      return args.find(value => value !== null) ?? null
    case 'core:add': {
      if (args.some(value => typeof value !== 'number')) {
        throw new ExpressionEvaluationError('core:add expects number arguments')
      }
      return (args as number[]).reduce((sum, value) => sum + value, 0)
    }
    case 'core:to-string':
      return stringify(args[0] ?? null)
    default:
      throw new ExpressionEvaluationError(`expression function is not available: ${name}`)
  }
}

export function evaluateExpression(expression: ValueExpr, bindings: EvaluationBindings): NumenValue {
  let value: NumenValue
  switch (expression.type) {
    case 'literal':
      value = expression.value
      break
    case 'ref':
      value = resolveReference(expression.path, bindings)
      break
    case 'array':
      value = expression.items.map(item => evaluateExpression(item, bindings))
      break
    case 'object':
      value = Object.fromEntries(
        Object.entries(expression.entries).map(([key, item]) => [key, evaluateExpression(item, bindings)]),
      )
      break
    case 'template':
      value = expression.parts.map(part => {
        return typeof part === 'string' ? part : stringify(resolveReference(part.ref, bindings))
      }).join('')
      break
    case 'call':
      value = callFunction(expression.function, expression.arguments.map(item => evaluateExpression(item, bindings)))
      break
    default:
      throw new ExpressionEvaluationError('unknown expression type')
  }
  if (!isNumenValue(value)) throw new ExpressionEvaluationError('expression produced a non-Numen value')
  return value
}
