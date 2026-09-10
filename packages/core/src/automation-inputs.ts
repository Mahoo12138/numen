import type { AutomationInputDeclaration, AutomationSource, CompileDiagnostic } from './automation.js'
import { isNumenValue, type NumenValue } from './value.js'

export const automationInputTypes = ['string', 'number', 'boolean', 'object', 'array'] as const
export function isAutomationInputName(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$-]{0,63}$/.test(name) && !['__proto__', 'prototype', 'constructor'].includes(name)
}
function matches(type: AutomationInputDeclaration['type'], value: NumenValue): boolean {
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value)
  return typeof value === type
}

/** The persisted declaration vocabulary is deliberately smaller than arbitrary JSON Schema. */
export function validateAutomationInputDeclarations(inputs: unknown): CompileDiagnostic[] {
  if (inputs === undefined) return []
  const diagnostics: CompileDiagnostic[] = []
  const report = (message: string, fieldPath = 'inputs') => diagnostics.push({
    severity: 'error', code: 'AUTOMATION_INPUT_DECLARATION_INVALID', message, source: { nodeId: '__inputs', fieldPath },
  })
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    report('Input declarations must be an object keyed by input name.')
    return diagnostics
  }
  if (Object.keys(inputs).length > 64) report('An Automation can declare at most 64 inputs.')
  for (const [name, raw] of Object.entries(inputs)) {
    const path = `inputs.${name}`
    if (!isAutomationInputName(name)) report(`Invalid input name: ${name}.`, path)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { report('Input declaration must be an object.', path); continue }
    const field = raw as AutomationInputDeclaration
    if (!automationInputTypes.includes(field.type)) report('Input type must be string, number, boolean, object, or array.', `${path}.type`)
    for (const key of Object.keys(raw)) if (!['type', 'title', 'description', 'required', 'default'].includes(key)) report(`Unknown declaration field: ${key}.`, `${path}.${key}`)
    for (const key of ['title', 'description'] as const) {
      if (field[key] !== undefined && (typeof field[key] !== 'string' || field[key]!.length > 1000)) report(`${key} must be text up to 1000 characters.`, `${path}.${key}`)
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') report('Required must be boolean.', `${path}.required`)
    if (Object.hasOwn(field, 'default') && (!isNumenValue(field.default) || !matches(field.type, field.default))) report('Default must match the declared input type.', `${path}.default`)
  }
  return diagnostics
}

export interface AutomationInputIssue { field: string; message: string }
export class AutomationInputValidationError extends Error {
  constructor(public readonly issues: AutomationInputIssue[]) {
    super('Run inputs do not match the active Revision input declarations.')
    this.name = 'AutomationInputValidationError'
  }
}

/** Validate and copy before Run acceptance; old Sources without declarations remain open-ended. */
export function resolveAutomationInputs(source: Pick<AutomationSource, 'inputs'>, input: unknown): Record<string, NumenValue> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !isNumenValue(input)) {
    throw new AutomationInputValidationError([{ field: '', message: 'Inputs must be a JSON object.' }])
  }
  if (source.inputs === undefined) return structuredClone(input) as Record<string, NumenValue>
  if (validateAutomationInputDeclarations(source.inputs).length) throw new AutomationInputValidationError([{ field: '', message: 'Revision input declarations are invalid.' }])
  const issues: AutomationInputIssue[] = []
  const values: Array<[string, NumenValue]> = []
  for (const name of Object.keys(input)) if (!Object.hasOwn(source.inputs, name)) issues.push({ field: name, message: 'This input is not declared.' })
  for (const [name, field] of Object.entries(source.inputs)) {
    const value = Object.hasOwn(input, name) ? (input as Record<string, NumenValue>)[name] : field.default
    if (value === undefined) {
      if (field.required) issues.push({ field: name, message: 'This input is required.' })
    } else if (!matches(field.type, value)) issues.push({ field: name, message: `Expected ${field.type}.` })
    else values.push([name, structuredClone(value)])
  }
  if (issues.length) throw new AutomationInputValidationError(issues)
  return Object.fromEntries(values)
}
