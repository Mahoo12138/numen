import type { NumenValue } from './value.js'

export type CoreExpressionValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'
  | 'unknown'

export interface CoreExpressionFunctionArgument {
  label: string
  valueType: CoreExpressionValueType
}

export interface CoreExpressionFunctionDefinition {
  id: string
  title: string
  description: string
  outputType: CoreExpressionValueType
  arguments: ReadonlyArray<CoreExpressionFunctionArgument>
  variadic?: CoreExpressionFunctionArgument
}

/** Stable pure functions accepted by protocol-v1 ValueExpr Call nodes. */
export const coreExpressionFunctions: ReadonlyArray<CoreExpressionFunctionDefinition> = [
  {
    id: 'core:eq',
    title: 'Equals',
    description: 'Compare two JSON-like values for equality.',
    outputType: 'boolean',
    arguments: [
      { label: 'Left value', valueType: 'unknown' },
      { label: 'Right value', valueType: 'unknown' },
    ],
  },
  {
    id: 'core:gt',
    title: 'Greater than',
    description: 'Return true when the left number is greater than the right number.',
    outputType: 'boolean',
    arguments: [
      { label: 'Left number', valueType: 'number' },
      { label: 'Right number', valueType: 'number' },
    ],
  },
  {
    id: 'core:gte',
    title: 'Greater than or equal',
    description: 'Return true when the left number is greater than or equal to the right number.',
    outputType: 'boolean',
    arguments: [
      { label: 'Left number', valueType: 'number' },
      { label: 'Right number', valueType: 'number' },
    ],
  },
  {
    id: 'core:lt',
    title: 'Less than',
    description: 'Return true when the left number is less than the right number.',
    outputType: 'boolean',
    arguments: [
      { label: 'Left number', valueType: 'number' },
      { label: 'Right number', valueType: 'number' },
    ],
  },
  {
    id: 'core:lte',
    title: 'Less than or equal',
    description: 'Return true when the left number is less than or equal to the right number.',
    outputType: 'boolean',
    arguments: [
      { label: 'Left number', valueType: 'number' },
      { label: 'Right number', valueType: 'number' },
    ],
  },
  {
    id: 'core:not',
    title: 'Not',
    description: 'Invert one boolean value.',
    outputType: 'boolean',
    arguments: [{ label: 'Value', valueType: 'boolean' }],
  },
  {
    id: 'core:and',
    title: 'All conditions',
    description: 'Return true when every condition is true.',
    outputType: 'boolean',
    arguments: [
      { label: 'Condition 1', valueType: 'boolean' },
      { label: 'Condition 2', valueType: 'boolean' },
    ],
    variadic: { label: 'Condition', valueType: 'boolean' },
  },
  {
    id: 'core:or',
    title: 'Any condition',
    description: 'Return true when at least one condition is true.',
    outputType: 'boolean',
    arguments: [
      { label: 'Condition 1', valueType: 'boolean' },
      { label: 'Condition 2', valueType: 'boolean' },
    ],
    variadic: { label: 'Condition', valueType: 'boolean' },
  },
  {
    id: 'core:coalesce',
    title: 'First available value',
    description: 'Return the first value that is not null.',
    outputType: 'unknown',
    arguments: [
      { label: 'Value 1', valueType: 'unknown' },
      { label: 'Value 2', valueType: 'unknown' },
    ],
    variadic: { label: 'Value', valueType: 'unknown' },
  },
  {
    id: 'core:add',
    title: 'Add numbers',
    description: 'Add two or more numeric values.',
    outputType: 'number',
    arguments: [
      { label: 'Number 1', valueType: 'number' },
      { label: 'Number 2', valueType: 'number' },
    ],
    variadic: { label: 'Number', valueType: 'number' },
  },
  {
    id: 'core:length',
    title: 'Length',
    description: 'Count array items or Unicode code points in text, not visual characters. Only text and arrays are accepted.',
    outputType: 'number',
    arguments: [{ label: 'Text or array', valueType: 'unknown' }],
  },
  {
    id: 'core:contains',
    title: 'Text contains',
    description: 'Check whether text contains a case-sensitive substring. An empty substring always matches.',
    outputType: 'boolean',
    arguments: [
      { label: 'Text', valueType: 'string' },
      { label: 'Substring', valueType: 'string' },
    ],
  },
  {
    id: 'core:to-string',
    title: 'Convert to text',
    description: 'Convert one JSON-like value to text explicitly.',
    outputType: 'string',
    arguments: [{ label: 'Value', valueType: 'unknown' }],
  },
]

const functionById = new Map(coreExpressionFunctions.map(definition => [definition.id, definition]))

export function getCoreExpressionFunction(id: string): CoreExpressionFunctionDefinition | undefined {
  return functionById.get(id)
}

export class CoreExpressionFunctionError extends Error {
  override name = 'CoreExpressionFunctionError'
}

function validateArguments(definition: CoreExpressionFunctionDefinition, args: NumenValue[]): void {
  const minimum = definition.arguments.length
  const maximum = definition.variadic ? Number.POSITIVE_INFINITY : minimum
  if (args.length < minimum || args.length > maximum) {
    const expected = definition.variadic ? `at least ${minimum}` : String(minimum)
    throw new CoreExpressionFunctionError(`${definition.id} expects ${expected} argument${minimum === 1 ? '' : 's'}`)
  }
}

function booleanArgument(value: NumenValue, name: string): boolean {
  if (typeof value !== 'boolean') throw new CoreExpressionFunctionError(`${name} expects boolean arguments`)
  return value
}

function numberArgument(value: NumenValue, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CoreExpressionFunctionError(`${name} expects finite number arguments`)
  }
  return value
}

function stringArgument(value: NumenValue, name: string): string {
  if (typeof value !== 'string') throw new CoreExpressionFunctionError(`${name} expects string arguments`)
  return value
}

export function stringifyCoreExpressionValue(value: NumenValue): string {
  if (typeof value === 'string') return value
  if (value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function evaluateCoreExpressionFunction(name: string, args: NumenValue[]): NumenValue {
  const definition = getCoreExpressionFunction(name)
  if (!definition) throw new CoreExpressionFunctionError(`expression function is not available: ${name}`)
  validateArguments(definition, args)
  switch (name) {
    case 'core:eq':
      return JSON.stringify(args[0]) === JSON.stringify(args[1])
    case 'core:gt':
      return numberArgument(args[0]!, name) > numberArgument(args[1]!, name)
    case 'core:gte':
      return numberArgument(args[0]!, name) >= numberArgument(args[1]!, name)
    case 'core:lt':
      return numberArgument(args[0]!, name) < numberArgument(args[1]!, name)
    case 'core:lte':
      return numberArgument(args[0]!, name) <= numberArgument(args[1]!, name)
    case 'core:not':
      return !booleanArgument(args[0]!, name)
    case 'core:and':
      return args.every(value => booleanArgument(value, name))
    case 'core:or':
      return args.some(value => booleanArgument(value, name))
    case 'core:coalesce':
      return args.find(value => value !== null) ?? null
    case 'core:add': {
      if (args.some(value => typeof value !== 'number')) {
        throw new CoreExpressionFunctionError('core:add expects number arguments')
      }
      return (args as number[]).reduce((sum, value) => sum + value, 0)
    }
    case 'core:to-string':
      return stringifyCoreExpressionValue(args[0]!)
    case 'core:length': {
      const value = args[0]!
      if (Array.isArray(value)) return value.length
      if (typeof value === 'string') {
        let length = 0
        for (const _codePoint of value) length++
        return length
      }
      throw new CoreExpressionFunctionError('core:length expects text or an array')
    }
    case 'core:contains':
      return stringArgument(args[0]!, name).includes(stringArgument(args[1]!, name))
    default:
      throw new CoreExpressionFunctionError(`expression function is not available: ${name}`)
  }
}
