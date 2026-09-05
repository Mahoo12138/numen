import type { AutomationSource, CapabilitySource, ControlSource, ValueExpr } from '@numen/core'
import type {
  WorkbenchAutomationInputField,
  WorkbenchAutomationVariableCatalog,
  WorkbenchAutomationVariableDefinition,
  WorkbenchAutomationVariableValueType,
} from './contracts.js'

export type MagicVariableGroup = 'trigger' | 'steps' | 'loop' | 'run'
export type MagicVariableCompatibility = 'direct' | 'conversion'

export interface MagicVariableCandidate {
  path: string
  label: string
  sourceLabel: string
  group: MagicVariableGroup
  valueType: WorkbenchAutomationVariableValueType
  compatibility: MagicVariableCompatibility
  conversion?: 'core:to-string'
  description?: string
}

export interface ProjectMagicVariablesOptions {
  source: AutomationSource
  nodeId: string
  field: WorkbenchAutomationInputField
  catalog: WorkbenchAutomationVariableCatalog
  mode: 'reference' | 'template'
}

interface LexicalScope {
  priorCapabilities: CapabilitySource[]
  inLoop: boolean
}

function capabilityKey(ref: { id: string; version: number }): string {
  return `${ref.id}@${ref.version}`
}

function findLexicalScope(
  control: ControlSource,
  nodeId: string,
  priorCapabilities: CapabilitySource[] = [],
  inLoop = false,
): LexicalScope | undefined {
  if (control.id === nodeId) return { priorCapabilities, inLoop }
  switch (control.type) {
    case 'block': {
      const visible = [...priorCapabilities]
      for (const step of control.steps) {
        const scope = findLexicalScope(step, nodeId, visible, inLoop)
        if (scope) return scope
        if (step.type === 'capability') visible.push(step)
      }
      return
    }
    case 'if':
      return findLexicalScope(control.then, nodeId, priorCapabilities, inLoop)
        ?? (control.else ? findLexicalScope(control.else, nodeId, priorCapabilities, inLoop) : undefined)
    case 'parallel':
    case 'race':
      for (const branch of control.branches) {
        const scope = findLexicalScope(branch, nodeId, priorCapabilities, inLoop)
        if (scope) return scope
      }
      return
    case 'foreach':
      return findLexicalScope(control.body, nodeId, priorCapabilities, true)
    default:
      return
  }
}

export function targetValueTypes(field: WorkbenchAutomationInputField): Set<WorkbenchAutomationVariableValueType> {
  if (field.type === 'enum') {
    const types = new Set<WorkbenchAutomationVariableValueType>(field.options?.map(option => {
      if (option.value === null) return 'null'
      if (Array.isArray(option.value)) return 'array'
      if (typeof option.value === 'object') return 'object'
      if (typeof option.value === 'string') return 'string'
      if (typeof option.value === 'number') return 'number'
      return 'boolean'
    }) ?? [])
    return types
  }
  if (field.type === 'json' && field.schemaType === 'array') return new Set(['array'])
  if (field.type === 'json' && field.schemaType === 'object') return new Set(['object'])
  if (field.type === 'json' && field.schemaType === 'null') return new Set(['null'])
  if (field.type === 'json') return new Set(['string', 'number', 'boolean', 'object', 'array', 'null', 'unknown'])
  return new Set([field.type])
}

function compatibility(
  field: WorkbenchAutomationInputField,
  valueType: WorkbenchAutomationVariableValueType,
  mode: 'reference' | 'template',
): Pick<MagicVariableCandidate, 'compatibility' | 'conversion'> | undefined {
  if (mode === 'template') return { compatibility: 'direct' }
  if (targetValueTypes(field).has(valueType)) return { compatibility: 'direct' }
  if (field.type === 'string') return { compatibility: 'conversion', conversion: 'core:to-string' }
  return
}

function definitionMap(catalog: WorkbenchAutomationVariableCatalog): Map<string, WorkbenchAutomationVariableDefinition> {
  return new Map(catalog.definitions.map(definition => [capabilityKey(definition.capability), definition]))
}

function candidate(
  field: WorkbenchAutomationInputField,
  mode: 'reference' | 'template',
  value: Omit<MagicVariableCandidate, 'compatibility' | 'conversion'>,
): MagicVariableCandidate | undefined {
  const match = compatibility(field, value.valueType, mode)
  return match ? { ...value, ...match } : undefined
}

function triggerCandidates(
  options: ProjectMagicVariablesOptions,
  definitions: Map<string, WorkbenchAutomationVariableDefinition>,
): MagicVariableCandidate[] {
  const byPath = new Map<string, {
    label: string
    sourceLabels: Set<string>
    valueTypes: Set<WorkbenchAutomationVariableValueType>
    description?: string
  }>()
  for (const trigger of options.source.triggers) {
    const definition = definitions.get(capabilityKey(trigger.capability))
    if (!definition) continue
    for (const field of definition.outputFields) {
      if (!field.path.length) continue
      const path = `trigger.${field.path.join('.')}`
      const previous = byPath.get(path)
      if (previous) {
        previous.sourceLabels.add(definition.title)
        previous.valueTypes.add(field.valueType)
      } else byPath.set(path, {
        label: field.label,
        sourceLabels: new Set([definition.title]),
        valueTypes: new Set([field.valueType]),
        ...(field.description ? { description: field.description } : {}),
      })
    }
  }
  return [...byPath.entries()].flatMap(([path, field]) => {
    const valueType = field.valueTypes.size === 1 ? [...field.valueTypes][0]! : 'unknown'
    const projected = candidate(options.field, options.mode, {
      path,
      label: field.label,
      sourceLabel: [...field.sourceLabels].join(' / '),
      group: 'trigger',
      valueType,
      ...(field.description ? { description: field.description } : {}),
    })
    return projected ? [projected] : []
  })
}

function stepCandidates(
  options: ProjectMagicVariablesOptions,
  definitions: Map<string, WorkbenchAutomationVariableDefinition>,
  scope: LexicalScope,
): MagicVariableCandidate[] {
  return scope.priorCapabilities.flatMap(step => {
    const definition = definitions.get(capabilityKey(step.capability))
    if (!definition) return []
    return definition.outputFields.flatMap(field => {
      const path = ['steps', step.id, ...field.path].join('.')
      const value = candidate(options.field, options.mode, {
        path,
        label: field.path.length ? field.label : 'Output',
        sourceLabel: definition.title,
        group: 'steps',
        valueType: field.valueType,
        ...(field.description ? { description: field.description } : {}),
      })
      return value ? [value] : []
    })
  })
}

function contextCandidates(options: ProjectMagicVariablesOptions, inLoop: boolean): MagicVariableCandidate[] {
  const values: Array<Omit<MagicVariableCandidate, 'compatibility' | 'conversion'>> = [
    { path: 'run.id', label: 'Run ID', sourceLabel: 'Run', group: 'run', valueType: 'string' },
    { path: 'run.automationId', label: 'Automation ID', sourceLabel: 'Run', group: 'run', valueType: 'string' },
    { path: 'run.revisionId', label: 'Revision ID', sourceLabel: 'Run', group: 'run', valueType: 'string' },
  ]
  if (inLoop) {
    values.unshift(
      { path: 'loop.item', label: 'Current item', sourceLabel: 'For each', group: 'loop', valueType: 'unknown' },
      { path: 'loop.index', label: 'Current index', sourceLabel: 'For each', group: 'loop', valueType: 'number' },
    )
  }
  return values.flatMap(value => {
    const projected = candidate(options.field, options.mode, value)
    return projected ? [projected] : []
  })
}

/**
 * Projects the current Draft's lexical scope into typed, presentation-only variable choices.
 * It deliberately does not inspect runtime state or mutate Source.
 */
export function projectMagicVariables(options: ProjectMagicVariablesOptions): MagicVariableCandidate[] {
  const scope = findLexicalScope(options.source.flow, options.nodeId)
  if (!scope) return []
  const definitions = definitionMap(options.catalog)
  return [
    ...triggerCandidates(options, definitions),
    ...stepCandidates(options, definitions, scope),
    ...contextCandidates(options, scope.inLoop),
  ]
}

export function magicVariableExpression(candidate: MagicVariableCandidate): ValueExpr {
  const reference: ValueExpr = { type: 'ref', path: candidate.path }
  return candidate.conversion
    ? { type: 'call', function: candidate.conversion, arguments: [reference] }
    : reference
}

export function insertTemplateReference(
  value: string,
  path: string,
  selectionStart = value.length,
  selectionEnd = selectionStart,
): { value: string; cursor: number } {
  const token = `{{ ${path} }}`
  const nextValue = `${value.slice(0, selectionStart)}${token}${value.slice(selectionEnd)}`
  return { value: nextValue, cursor: selectionStart + token.length }
}
