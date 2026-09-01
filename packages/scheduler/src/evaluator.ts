import {
  CoreExpressionFunctionError,
  evaluateCoreExpressionFunction,
  isNumenValue,
  stringifyCoreExpressionValue,
  type NumenValue,
  type ValueExpr,
} from '@numen/core'

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
        return typeof part === 'string' ? part : stringifyCoreExpressionValue(resolveReference(part.ref, bindings))
      }).join('')
      break
    case 'call':
      try {
        value = evaluateCoreExpressionFunction(
          expression.function,
          expression.arguments.map(item => evaluateExpression(item, bindings)),
        )
      } catch (error) {
        if (error instanceof CoreExpressionFunctionError) throw new ExpressionEvaluationError(error.message)
        throw error
      }
      break
    default:
      throw new ExpressionEvaluationError('unknown expression type')
  }
  if (!isNumenValue(value)) throw new ExpressionEvaluationError('expression produced a non-Numen value')
  return value
}
