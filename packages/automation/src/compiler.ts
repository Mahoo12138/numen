import {
  capabilityKey,
  isNumenValue,
  type AutomationSource,
  type CapabilityDefinition,
  type CapabilityDependency,
  type CapabilityRef,
  type CapabilityStatus,
  type CompileDiagnostic,
  type ContractSnapshotCapability,
  type ControlSource,
  type CoreInstruction,
  type CorePlan,
  type DependencyManifest,
  type ContractSnapshot,
  type NumenValue,
  type ValueExpr,
} from '@numen/core'

export interface CapabilityResolver {
  get(ref: CapabilityRef): CapabilityStatus | undefined
}

export interface CompileResult {
  plan: CorePlan
  dependencyManifest: DependencyManifest
  contractSnapshot: ContractSnapshot
  diagnostics: CompileDiagnostic[]
}

export class AutomationCompileError extends Error {
  override name = 'AutomationCompileError'

  constructor(public readonly diagnostics: CompileDiagnostic[]) {
    super(`automation compilation failed with ${diagnostics.filter(item => item.severity === 'error').length} error(s)`)
  }
}

const nodeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const refPattern = /^(run|trigger|input|steps|vars|loop|error)(\.[a-zA-Z0-9_$-]+)+$/
const functionPattern = /^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/

function schemaSnapshot(schema: CapabilityDefinition['input']): unknown {
  return JSON.parse(JSON.stringify(schema.toJSON())) as unknown
}

function literalValue(expression: ValueExpr): NumenValue | undefined {
  if (!expression || typeof expression !== 'object') return
  if (expression.type === 'literal') return expression.value
  if (expression.type === 'array') {
    if (!Array.isArray(expression.items)) return
    const values: NumenValue[] = []
    for (const item of expression.items) {
      const value = literalValue(item)
      if (value === undefined) return
      values.push(value)
    }
    return values
  }
  if (expression.type === 'object') {
    if (!expression.entries || typeof expression.entries !== 'object' || Array.isArray(expression.entries)) return
    const values: Record<string, NumenValue> = {}
    for (const [key, item] of Object.entries(expression.entries)) {
      const value = literalValue(item)
      if (value === undefined) return
      values[key] = value
    }
    return values
  }
}

export function compileAutomation(source: AutomationSource, capabilities: CapabilityResolver): CompileResult {
  const diagnostics: CompileDiagnostic[] = []
  const instructions: Record<string, CoreInstruction> = {}
  const nodeIds = new Set<string>()
  const dependencies = new Map<string, CapabilityDependency>()
  const snapshots = new Map<string, ContractSnapshotCapability>()

  const report = (diagnostic: CompileDiagnostic) => diagnostics.push(diagnostic)
  if (!source || typeof source !== 'object' || !Array.isArray(source.triggers) || !source.flow || typeof source.flow !== 'object') {
    throw new AutomationCompileError([{
      severity: 'error',
      code: 'SOURCE_STRUCTURE_INVALID',
      message: 'Automation source requires a triggers array and a flow object.',
    }])
  }
  const registerNode = (id: string, fieldPath?: string) => {
    if (!nodeIdPattern.test(id) || id.startsWith('__')) {
      report({
        severity: 'error',
        code: 'INVALID_NODE_ID',
        message: `Invalid or reserved node id: ${id}`,
        source: { nodeId: id, ...(fieldPath ? { fieldPath } : {}) },
      })
      return false
    }
    if (nodeIds.has(id)) {
      report({ severity: 'error', code: 'DUPLICATE_NODE_ID', message: `Duplicate node id: ${id}`, source: { nodeId: id } })
      return false
    }
    nodeIds.add(id)
    return true
  }

  const validateExpression = (expression: ValueExpr, nodeId: string, fieldPath: string): void => {
    if (!expression || typeof expression !== 'object' || typeof expression.type !== 'string') {
      report({ severity: 'error', code: 'UNKNOWN_EXPRESSION', message: 'Expression must have a type.', source: { nodeId, fieldPath } })
      return
    }
    switch (expression.type) {
      case 'literal':
        if (!isNumenValue(expression.value)) {
          report({ severity: 'error', code: 'INVALID_LITERAL', message: 'Literal must be a JSON-like Numen value.', source: { nodeId, fieldPath } })
        }
        break
      case 'ref':
        if (!refPattern.test(expression.path)) {
          report({ severity: 'error', code: 'INVALID_REFERENCE', message: `Invalid reference: ${expression.path}`, source: { nodeId, fieldPath } })
        }
        break
      case 'array':
        if (!Array.isArray(expression.items)) {
          report({ severity: 'error', code: 'EXPRESSION_ARRAY_INVALID', message: 'Array expression requires items.', source: { nodeId, fieldPath } })
          break
        }
        expression.items.forEach((item, index) => validateExpression(item, nodeId, `${fieldPath}.${index}`))
        break
      case 'object':
        if (!expression.entries || typeof expression.entries !== 'object' || Array.isArray(expression.entries)) {
          report({ severity: 'error', code: 'EXPRESSION_OBJECT_INVALID', message: 'Object expression requires entries.', source: { nodeId, fieldPath } })
          break
        }
        Object.entries(expression.entries).forEach(([key, item]) => validateExpression(item, nodeId, `${fieldPath}.${key}`))
        break
      case 'template':
        if (!Array.isArray(expression.parts)) {
          report({ severity: 'error', code: 'EXPRESSION_TEMPLATE_INVALID', message: 'Template expression requires parts.', source: { nodeId, fieldPath } })
          break
        }
        expression.parts.forEach((part, index) => {
          if (typeof part !== 'string' && !refPattern.test(part.ref)) {
            report({ severity: 'error', code: 'INVALID_REFERENCE', message: `Invalid template reference: ${part.ref}`, source: { nodeId, fieldPath: `${fieldPath}.parts.${index}` } })
          }
        })
        break
      case 'call':
        if (!functionPattern.test(expression.function)) {
          report({ severity: 'error', code: 'INVALID_EXPRESSION_FUNCTION', message: `Expression function must be namespaced: ${expression.function}`, source: { nodeId, fieldPath } })
        }
        if (!Array.isArray(expression.arguments)) {
          report({ severity: 'error', code: 'EXPRESSION_CALL_INVALID', message: 'Call expression requires arguments.', source: { nodeId, fieldPath } })
          break
        }
        expression.arguments.forEach((item, index) => validateExpression(item, nodeId, `${fieldPath}.arguments.${index}`))
        break
      default:
        report({ severity: 'error', code: 'UNKNOWN_EXPRESSION', message: 'Unknown expression type.', source: { nodeId, fieldPath } })
    }
  }

  const resolveCapability = (
    ref: CapabilityRef,
    nodeId: string,
    expectedKind: 'trigger' | 'step',
    connectionId?: string,
  ): CapabilityDefinition | undefined => {
    const status = capabilities.get(ref)
    if (!status) {
      report({ severity: 'error', code: 'CAPABILITY_MISSING', message: `Capability contract not found: ${capabilityKey(ref)}`, source: { nodeId, fieldPath: 'capability' } })
      return
    }
    const definition = status.definition
    if (expectedKind === 'trigger' && definition.kind !== 'trigger') {
      report({ severity: 'error', code: 'CAPABILITY_KIND_MISMATCH', message: `${capabilityKey(ref)} is not a trigger capability.`, source: { nodeId, fieldPath: 'capability' } })
    }
    if (expectedKind === 'step' && definition.kind === 'trigger') {
      report({ severity: 'error', code: 'CAPABILITY_KIND_MISMATCH', message: `${capabilityKey(ref)} cannot be invoked as a flow step.`, source: { nodeId, fieldPath: 'capability' } })
    }
    if (definition.connections?.some(slot => slot.required) && !connectionId) {
      report({ severity: 'error', code: 'CONNECTION_REQUIRED', message: `${capabilityKey(ref)} requires a connection.`, source: { nodeId, fieldPath: 'connection' } })
    }

    const key = `${capabilityKey(ref)}:${connectionId ?? ''}`
    dependencies.set(key, {
      id: ref.id,
      version: ref.version,
      kind: definition.kind,
      ...(connectionId ? { connectionId } : {}),
    })
    snapshots.set(capabilityKey(ref), {
      id: definition.id,
      version: definition.version,
      kind: definition.kind,
      title: definition.title,
      inputSchema: schemaSnapshot(definition.input),
      outputSchema: schemaSnapshot(definition.output),
      semantics: { ...definition.semantics },
    })
    return definition
  }

  const validateCapabilityInput = (
    definition: CapabilityDefinition,
    input: Record<string, ValueExpr>,
    nodeId: string,
  ) => {
    for (const [name, fieldSchema] of Object.entries(definition.input.dict ?? {})) {
      if (fieldSchema.meta.required && !(name in input)) {
        report({ severity: 'error', code: 'INPUT_REQUIRED', message: `Missing required input: ${name}`, source: { nodeId, fieldPath: `input.${name}` } })
      }
    }
    for (const [name, expression] of Object.entries(input)) {
      validateExpression(expression, nodeId, `input.${name}`)
      const value = literalValue(expression)
      const fieldSchema = definition.input.dict?.[name]
      if (value === undefined || !fieldSchema) continue
      try {
        fieldSchema(value)
      } catch (error) {
        report({ severity: 'error', code: 'INPUT_SCHEMA_INVALID', message: (error as Error).message, source: { nodeId, fieldPath: `input.${name}` } })
      }
    }
    const literalInput: Record<string, NumenValue> = {}
    let fullyLiteral = true
    for (const [name, expression] of Object.entries(input)) {
      const value = literalValue(expression)
      if (value === undefined) {
        fullyLiteral = false
        break
      }
      literalInput[name] = value
    }
    if (fullyLiteral) {
      try {
        definition.input(literalInput)
      } catch (error) {
        report({ severity: 'error', code: 'INPUT_SCHEMA_INVALID', message: (error as Error).message, source: { nodeId, fieldPath: 'input' } })
      }
    }
  }

  const compileControl = (control: ControlSource, next: string): string => {
    if (!control || typeof control !== 'object' || typeof control.id !== 'string') {
      report({ severity: 'error', code: 'INVALID_CONTROL', message: 'Control must have a stable id.' })
      return next
    }
    const controlId = control.id
    registerNode(controlId)
    switch (control.type) {
      case 'block': {
        if (control.output) {
          report({ severity: 'error', code: 'BLOCK_OUTPUT_NOT_IMPLEMENTED', message: 'Block output lowering is not implemented in this milestone.', source: { nodeId: control.id, fieldPath: 'output' } })
        }
        if (!Array.isArray(control.steps)) {
          report({ severity: 'error', code: 'BLOCK_STEPS_INVALID', message: 'Block requires a steps array.', source: { nodeId: control.id, fieldPath: 'steps' } })
          return next
        }
        let cursor = next
        for (const child of [...control.steps].reverse()) cursor = compileControl(child, cursor)
        return cursor
      }
      case 'capability': {
        const input = control.input && typeof control.input === 'object' && !Array.isArray(control.input)
          ? control.input
          : {}
        if (input !== control.input) {
          report({ severity: 'error', code: 'CAPABILITY_INPUT_INVALID', message: 'Capability input must be an object.', source: { nodeId: control.id, fieldPath: 'input' } })
        }
        const validRef = control.capability
          && typeof control.capability.id === 'string'
          && Number.isSafeInteger(control.capability.version)
        if (!validRef) {
          report({ severity: 'error', code: 'CAPABILITY_REF_INVALID', message: 'Capability reference requires id and integer version.', source: { nodeId: control.id, fieldPath: 'capability' } })
          return control.id
        }
        const definition = resolveCapability(control.capability, control.id, 'step', control.connection)
        if (definition) validateCapabilityInput(definition, input, control.id)
        instructions[control.id] = {
          op: 'invoke',
          id: control.id,
          capability: control.capability,
          ...(control.connection ? { connection: control.connection } : {}),
          input: { type: 'object', entries: input },
          next,
        }
        return control.id
      }
      case 'if': {
        validateExpression(control.condition, control.id, 'condition')
        const thenEntry = compileControl(control.then, next)
        const elseEntry = control.else ? compileControl(control.else, next) : next
        instructions[control.id] = { op: 'branch', id: control.id, condition: control.condition, then: thenEntry, else: elseEntry }
        return control.id
      }
      case 'wait': {
        if ((!control.until && !control.durationMs) || (control.until && control.durationMs)) {
          report({ severity: 'error', code: 'WAIT_SOURCE_INVALID', message: 'Wait requires exactly one of until or durationMs.', source: { nodeId: control.id } })
        }
        if (control.until) validateExpression(control.until, control.id, 'until')
        if (control.durationMs) validateExpression(control.durationMs, control.id, 'durationMs')
        instructions[control.id] = {
          op: 'suspend',
          id: control.id,
          source: 'timer',
          config: {
            ...(control.until ? { until: control.until } : {}),
            ...(control.durationMs ? { durationMs: control.durationMs } : {}),
          },
          next,
        }
        return control.id
      }
      default:
        report({ severity: 'error', code: 'UNKNOWN_CONTROL', message: `Unknown control type: ${(control as { type?: string }).type ?? 'missing'}`, source: { nodeId: controlId } })
        return next
    }
  }

  for (const trigger of source.triggers) {
    if (
      !trigger
      || typeof trigger !== 'object'
      || typeof trigger.id !== 'string'
      || !trigger.capability
      || typeof trigger.capability.id !== 'string'
      || !Number.isSafeInteger(trigger.capability.version)
    ) {
      report({ severity: 'error', code: 'TRIGGER_STRUCTURE_INVALID', message: 'Trigger requires id and capability fields.' })
      continue
    }
    if (!registerNode(trigger.id, 'triggers')) continue
    const definition = resolveCapability(trigger.capability, trigger.id, 'trigger', trigger.connection)
    if (!trigger.config || typeof trigger.config !== 'object' || Array.isArray(trigger.config) || !isNumenValue(trigger.config)) {
      report({ severity: 'error', code: 'TRIGGER_CONFIG_INVALID', message: 'Trigger config must be a JSON-like Numen value.', source: { nodeId: trigger.id, fieldPath: 'config' } })
    } else if (definition) {
      try {
        definition.input(trigger.config)
      } catch (error) {
        report({ severity: 'error', code: 'TRIGGER_SCHEMA_INVALID', message: (error as Error).message, source: { nodeId: trigger.id, fieldPath: 'config' } })
      }
    }
  }

  if (source.policy !== undefined && (!source.policy || typeof source.policy !== 'object' || Array.isArray(source.policy))) {
    report({ severity: 'error', code: 'POLICY_STRUCTURE_INVALID', message: 'policy must be an object.', source: { fieldPath: 'policy' } })
  }
  if (source.policy?.maxActive !== undefined && (!Number.isSafeInteger(source.policy.maxActive) || source.policy.maxActive < 1)) {
    report({ severity: 'error', code: 'POLICY_MAX_ACTIVE_INVALID', message: 'policy.maxActive must be a positive integer.', source: { fieldPath: 'policy.maxActive' } })
  }
  if (source.policy?.groupBy) validateExpression(source.policy.groupBy, '__policy', 'policy.groupBy')

  const completeId = '__complete'
  instructions[completeId] = { op: 'complete', id: completeId }
  const entry = compileControl(source.flow, completeId)

  if (diagnostics.some(item => item.severity === 'error')) {
    throw new AutomationCompileError(diagnostics)
  }

  return {
    plan: { irVersion: 1, entry, instructions },
    dependencyManifest: {
      capabilities: [...dependencies.values()].sort((a, b) => {
        return `${capabilityKey(a)}:${a.connectionId ?? ''}`.localeCompare(`${capabilityKey(b)}:${b.connectionId ?? ''}`)
      }),
    },
    contractSnapshot: {
      capabilities: [...snapshots.values()].sort((a, b) => capabilityKey(a).localeCompare(capabilityKey(b))),
    },
    diagnostics,
  }
}
