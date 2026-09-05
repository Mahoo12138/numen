import type Schema from 'schemastery'
import {
  capabilityKey,
  controlKey,
  getCoreExpressionFunction,
  isNumenValue,
  type AutomationSource,
  type CapabilityDefinition,
  type CapabilityDependency,
  type CapabilityRef,
  type CapabilityStatus,
  type CompileDiagnostic,
  type ContractSnapshotCapability,
  type ControlSource,
  type ControlResolver,
  type CoreControlSource,
  type ExtensionControlDefinition,
  type SourceRef,
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

export interface ConnectionContract {
  id: string
  adapter: { id: string; version: number }
}

export interface ConnectionResolver {
  get(connectionId: string): ConnectionContract | undefined
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

function schemaSnapshot(schema: Schema): unknown {
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

function freezeControlInput(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const child of Object.values(value)) freezeControlInput(child)
}

/** Extension output is bounded, JSON-only, namespaced, and cannot recursively invoke extensions. */
function validateLoweredControl(value: CoreControlSource, nodeId: string): void {
  const active = new Set<object>()
  let values = 0
  const json = (item: unknown, depth: number): void => {
    if (++values > 20_000 || depth > 64) throw new TypeError('lowered tree too large')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || active.has(item)) throw new TypeError('non-JSON lowered tree')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('non-JSON object')
    active.add(item)
    for (const child of Object.values(item)) json(child, depth + 1)
    active.delete(item)
  }
  json(value, 0)
  let nodes = 0
  const visit = (control: ControlSource, root = false): void => {
    if (++nodes > 256 || !control || typeof control.id !== 'string'
      || (root ? control.id !== nodeId : !control.id.startsWith(`${nodeId}.`))) throw new TypeError('invalid lowered identity')
    switch (control.type) {
      case 'capability': case 'wait': return
      case 'block': control.steps.forEach(child => visit(child)); return
      case 'if': visit(control.then); if (control.else) visit(control.else); return
      case 'parallel': case 'race': control.branches.forEach(child => visit(child)); return
      case 'foreach': visit(control.body); return
      default: throw new TypeError('unsupported lowered control')
    }
  }
  visit(value, true)
}

export function compileAutomation(
  source: AutomationSource,
  capabilities: CapabilityResolver,
  connections?: ConnectionResolver,
  controls?: ControlResolver,
): CompileResult {
  const diagnostics: CompileDiagnostic[] = []
  const usedControls = new Map<string, ExtensionControlDefinition>()
  const sourceMap: Record<string, SourceRef> = {}
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

  const normalizeConnectionIds = (
    nodeId: string,
    legacyConnection: unknown,
    value: unknown,
  ): Record<string, string> => {
    const result: Record<string, string> = {}
    if (legacyConnection !== undefined) {
      if (typeof legacyConnection === 'string' && legacyConnection) result.default = legacyConnection
      else report({
        severity: 'error',
        code: 'CONNECTION_BINDING_INVALID',
        message: 'Legacy connection binding must be a non-empty Connection ID.',
        source: { nodeId, fieldPath: 'connection' },
      })
    }
    if (value === undefined) return result
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      report({
        severity: 'error',
        code: 'CONNECTION_BINDINGS_INVALID',
        message: 'Connection bindings must be an object keyed by slot name.',
        source: { nodeId, fieldPath: 'connections' },
      })
      return result
    }
    for (const [slotName, connectionId] of Object.entries(value)) {
      if (!slotName || typeof connectionId !== 'string' || !connectionId) {
        report({
          severity: 'error',
          code: 'CONNECTION_BINDING_INVALID',
          message: `Connection slot ${slotName || '(empty)'} requires a non-empty Connection ID.`,
          source: { nodeId, fieldPath: `connections.${slotName}` },
        })
        continue
      }
      result[slotName] = connectionId
    }
    return result
  }

  const connectionBindingKey = (connectionIds: Record<string, string>): string => (
    Object.entries(connectionIds)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([slot, connectionId]) => `${slot}=${connectionId}`)
      .join(',')
  )

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
      case 'call': {
        const definition = getCoreExpressionFunction(expression.function)
        if (!functionPattern.test(expression.function)) {
          report({ severity: 'error', code: 'INVALID_EXPRESSION_FUNCTION', message: `Expression function must be namespaced: ${expression.function}`, source: { nodeId, fieldPath } })
        } else if (!definition) {
          report({ severity: 'error', code: 'EXPRESSION_FUNCTION_UNAVAILABLE', message: `Expression function is not available: ${expression.function}`, source: { nodeId, fieldPath } })
        }
        if (!Array.isArray(expression.arguments)) {
          report({ severity: 'error', code: 'EXPRESSION_CALL_INVALID', message: 'Call expression requires arguments.', source: { nodeId, fieldPath } })
          break
        }
        if (definition) {
          const minimum = definition.arguments.length
          const tooFew = expression.arguments.length < minimum
          const tooMany = !definition.variadic && expression.arguments.length > minimum
          if (tooFew || tooMany) {
            report({
              severity: 'error',
              code: 'EXPRESSION_CALL_ARITY_INVALID',
              message: `${definition.id} requires ${definition.variadic ? `at least ${minimum}` : minimum} argument${minimum === 1 ? '' : 's'}.`,
              source: { nodeId, fieldPath },
            })
          }
        }
        expression.arguments.forEach((item, index) => validateExpression(item, nodeId, `${fieldPath}.arguments.${index}`))
        break
      }
      default:
        report({ severity: 'error', code: 'UNKNOWN_EXPRESSION', message: 'Unknown expression type.', source: { nodeId, fieldPath } })
    }
  }

  const resolveCapability = (
    ref: CapabilityRef,
    nodeId: string,
    expectedKind: 'trigger' | 'step',
    connectionIds: Record<string, string>,
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
    const slots = new Map((definition.connections ?? []).map(slot => [slot.name, slot]))
    if (connectionIds.default && !slots.has('default') && slots.size === 1) {
      const [onlySlot] = slots.keys()
      connectionIds[onlySlot!] = connectionIds.default
      delete connectionIds.default
    }
    for (const slotName of Object.keys(connectionIds)) {
      if (!slots.has(slotName)) {
        report({
          severity: 'error',
          code: 'CONNECTION_SLOT_UNKNOWN',
          message: `${capabilityKey(ref)} does not declare connection slot: ${slotName}.`,
          source: { nodeId, fieldPath: `connections.${slotName}` },
        })
      }
    }
    for (const slot of slots.values()) {
      const connectionId = connectionIds[slot.name]
      if (slot.required && !connectionId) {
        report({
          severity: 'error',
          code: 'CONNECTION_REQUIRED',
          message: `${capabilityKey(ref)} requires connection slot: ${slot.name}.`,
          source: { nodeId, fieldPath: `connections.${slot.name}` },
        })
        continue
      }
      if (!connectionId || !connections) continue
      const connection = connections.get(connectionId)
      if (!connection) {
        report({
          severity: 'error',
          code: 'CONNECTION_MISSING',
          message: `Connection not found: ${connectionId}.`,
          source: { nodeId, fieldPath: `connections.${slot.name}` },
        })
        continue
      }
      const adapterKey = `${connection.adapter.id}@${connection.adapter.version}`
      if (slot.accepts.length && !slot.accepts.includes(connection.adapter.id) && !slot.accepts.includes(adapterKey)) {
        report({
          severity: 'error',
          code: 'CONNECTION_INCOMPATIBLE',
          message: `${connectionId} uses ${adapterKey}, which is incompatible with slot ${slot.name}.`,
          source: { nodeId, fieldPath: `connections.${slot.name}` },
        })
      }
    }

    const bindingsKey = connectionBindingKey(connectionIds)
    const key = `${capabilityKey(ref)}:${bindingsKey}`
    dependencies.set(key, {
      id: ref.id,
      version: ref.version,
      kind: definition.kind,
      ...(bindingsKey ? { connectionIds: { ...connectionIds } } : {}),
    })
    snapshots.set(capabilityKey(ref), {
      id: definition.id,
      version: definition.version,
      kind: definition.kind,
      title: definition.title,
      inputSchema: schemaSnapshot(definition.input),
      outputSchema: schemaSnapshot(definition.output),
      semantics: { ...definition.semantics },
      ...(definition.connections ? {
        connections: definition.connections.map(slot => ({
          name: slot.name,
          required: slot.required,
          accepts: [...slot.accepts],
        })),
      } : {}),
    })
    return definition
  }

  const validateCapabilityInput = (
    definition: { input: Schema },
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

  const compileControl = (control: ControlSource, next: string, registered = false): string => {
    if (!control || typeof control !== 'object' || typeof control.id !== 'string') {
      report({ severity: 'error', code: 'INVALID_CONTROL', message: 'Control must have a stable id.' })
      return next
    }
    const controlId = control.id
    if (!registered) registerNode(controlId)
    switch (control.type) {
      case 'extension': {
        const ref = control.control
        if (!ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.version) || ref.version < 1) {
          report({ severity: 'error', code: 'CONTROL_REF_INVALID', message: 'Control reference requires an id and positive integer version.', source: { nodeId: controlId, fieldPath: 'control' } })
          return next
        }
        const definition = controls?.get(ref)
        if (definition?.kind !== 'extension') {
          report({ severity: 'error', code: 'CONTROL_UNAVAILABLE', message: `Control compiler unavailable: ${controlKey(ref)}`, source: { nodeId: controlId, fieldPath: 'control' } })
          return next
        }
        if (!control.input || typeof control.input !== 'object' || Array.isArray(control.input)) {
          report({ severity: 'error', code: 'CONTROL_INPUT_INVALID', message: 'Control input must be an object of expressions.', source: { nodeId: controlId, fieldPath: 'input' } })
          return next
        }
        const diagnosticStart = diagnostics.length
        validateCapabilityInput(definition, control.input, controlId)
        if (diagnostics.slice(diagnosticStart).some(item => item.severity === 'error')) return next
        let lowered: CoreControlSource
        try {
          const input = structuredClone(control.input)
          freezeControlInput(input)
          lowered = definition.lower(Object.freeze({ nodeId: controlId, input }))
          validateLoweredControl(lowered, controlId)
        } catch {
          report({ severity: 'error', code: 'CONTROL_LOWER_FAILED', message: `Control ${controlKey(ref)} did not produce a valid core control tree.`, source: { nodeId: controlId } })
          return next
        }
        usedControls.set(controlKey(ref), definition)
        const existingInstructions = new Set(Object.keys(instructions))
        const entry = compileControl(lowered, next, true)
        for (const id of Object.keys(instructions)) if (!existingInstructions.has(id)) sourceMap[id] = { nodeId: controlId }
        for (const diagnostic of diagnostics.slice(diagnosticStart)) diagnostic.source = { nodeId: controlId }
        return entry
      }
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
        const connectionIds = normalizeConnectionIds(control.id, control.connection, control.connections)
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
        const definition = resolveCapability(control.capability, control.id, 'step', connectionIds)
        if (definition) validateCapabilityInput(definition, input, control.id)
        const policy = control.policy
        if (policy !== undefined && (!policy || typeof policy !== 'object' || Array.isArray(policy))) {
          report({ severity: 'error', code: 'INVOCATION_POLICY_INVALID', message: 'Invocation policy must be an object.', source: { nodeId: control.id, fieldPath: 'policy' } })
        }
        if (policy?.timeoutMs !== undefined && (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 1)) {
          report({ severity: 'error', code: 'TIMEOUT_INVALID', message: 'policy.timeoutMs must be a positive integer.', source: { nodeId: control.id, fieldPath: 'policy.timeoutMs' } })
        }
        if (policy?.retry) {
          if (!Number.isSafeInteger(policy.retry.maxAttempts) || policy.retry.maxAttempts < 1) {
            report({ severity: 'error', code: 'RETRY_ATTEMPTS_INVALID', message: 'retry.maxAttempts must be a positive integer.', source: { nodeId: control.id, fieldPath: 'policy.retry.maxAttempts' } })
          }
          if (policy.retry.backoffMs !== undefined && (!Number.isSafeInteger(policy.retry.backoffMs) || policy.retry.backoffMs < 0)) {
            report({ severity: 'error', code: 'RETRY_BACKOFF_INVALID', message: 'retry.backoffMs must be a non-negative integer.', source: { nodeId: control.id, fieldPath: 'policy.retry.backoffMs' } })
          }
          if (policy.retry.maxAttempts > 1 && definition && !definition.semantics.retrySafe) {
            report({ severity: 'error', code: 'RETRY_UNSAFE', message: `${capabilityKey(control.capability)} is not safe to retry.`, source: { nodeId: control.id, fieldPath: 'policy.retry' } })
          }
        }
        instructions[control.id] = {
          op: 'invoke',
          id: control.id,
          capability: control.capability,
          ...(Object.keys(connectionIds).length ? { connections: connectionIds } : {}),
          input: { type: 'object', entries: input },
          ...(policy ? { policy } : {}),
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
        if (control.durationMs?.type === 'literal'
          && (typeof control.durationMs.value !== 'number' || control.durationMs.value < 0)) {
          report({
            severity: 'error',
            code: 'WAIT_DURATION_INVALID',
            message: 'Wait duration must be a non-negative number of milliseconds.',
            source: { nodeId: control.id, fieldPath: 'durationMs' },
          })
        }
        if (control.until?.type === 'literal'
          && (typeof control.until.value !== 'string' || !Number.isFinite(Date.parse(control.until.value)))) {
          report({
            severity: 'error',
            code: 'WAIT_UNTIL_INVALID',
            message: 'Wait until must be a valid ISO date string.',
            source: { nodeId: control.id, fieldPath: 'until' },
          })
        }
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
      case 'parallel': {
        if (!Array.isArray(control.branches) || control.branches.length < 2) {
          report({
            severity: 'error',
            code: 'PARALLEL_BRANCHES_INVALID',
            message: 'Parallel requires at least two block branches.',
            source: { nodeId: control.id, fieldPath: 'branches' },
          })
          return next
        }
        const joinId = `__${control.id}.join`
        instructions[joinId] = { op: 'join', id: joinId, mode: 'all', next }
        const branches = control.branches.map((branch, index) => {
          if (!branch || branch.type !== 'block') {
            report({
              severity: 'error',
              code: 'PARALLEL_BRANCH_INVALID',
              message: 'Each Parallel branch must be a block.',
              source: { nodeId: control.id, fieldPath: `branches.${index}` },
            })
            return `__${control.id}.branch.${index}.complete`
          }
          const terminalId = `__${control.id}.branch.${index}.complete`
          instructions[terminalId] = { op: 'scope_complete', id: terminalId }
          return compileControl(branch, terminalId)
        })
        instructions[control.id] = {
          op: 'fork',
          id: control.id,
          mode: 'all',
          branches,
          join: joinId,
        }
        return control.id
      }
      case 'race': {
        if (!Array.isArray(control.branches) || control.branches.length < 2) {
          report({
            severity: 'error',
            code: 'RACE_BRANCHES_INVALID',
            message: 'Race requires at least two block branches.',
            source: { nodeId: control.id, fieldPath: 'branches' },
          })
          return next
        }
        const joinId = `__${control.id}.join`
        instructions[joinId] = { op: 'join', id: joinId, mode: 'first_success', next }
        const branches = control.branches.map((branch, index) => {
          if (!branch || branch.type !== 'block') {
            report({
              severity: 'error',
              code: 'RACE_BRANCH_INVALID',
              message: 'Each Race branch must be a block.',
              source: { nodeId: control.id, fieldPath: `branches.${index}` },
            })
            return `__${control.id}.branch.${index}.complete`
          }
          const terminalId = `__${control.id}.branch.${index}.complete`
          instructions[terminalId] = { op: 'scope_complete', id: terminalId }
          return compileControl(branch, terminalId)
        })
        instructions[control.id] = {
          op: 'fork',
          id: control.id,
          mode: 'first_success',
          branches,
          join: joinId,
        }
        return control.id
      }
      case 'foreach': {
        validateExpression(control.items, control.id, 'items')
        const concurrency = control.concurrency ?? 1
        if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
          report({
            severity: 'error',
            code: 'FOREACH_CONCURRENCY_INVALID',
            message: 'ForEach concurrency must be a positive integer.',
            source: { nodeId: control.id, fieldPath: 'concurrency' },
          })
        }
        if (!control.body || control.body.type !== 'block') {
          report({
            severity: 'error',
            code: 'FOREACH_BODY_INVALID',
            message: 'ForEach body must be a block.',
            source: { nodeId: control.id, fieldPath: 'body' },
          })
          return next
        }
        const joinId = `__${control.id}.join`
        const terminalId = `__${control.id}.iteration.complete`
        instructions[joinId] = { op: 'join', id: joinId, mode: 'iterate', next }
        instructions[terminalId] = { op: 'scope_complete', id: terminalId }
        const body = compileControl(control.body, terminalId)
        instructions[control.id] = {
          op: 'iterate',
          id: control.id,
          items: control.items,
          body,
          concurrency,
          join: joinId,
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
    const connectionIds = normalizeConnectionIds(trigger.id, trigger.connection, trigger.connections)
    const definition = resolveCapability(trigger.capability, trigger.id, 'trigger', connectionIds)
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

  const controlDefinitions = [...usedControls.values()].sort((a, b) => controlKey(a).localeCompare(controlKey(b)))
  return {
    plan: { irVersion: 1, entry, instructions, ...(usedControls.size ? { sourceMap } : {}) },
    dependencyManifest: {
      ...(usedControls.size ? { controls: controlDefinitions.map(({ id, version }) => ({ id, version })) } : {}),
      capabilities: [...dependencies.values()].sort((a, b) => (
        `${capabilityKey(a)}:${connectionBindingKey(a.connectionIds ?? (a.connectionId ? { default: a.connectionId } : {}))}`
          .localeCompare(`${capabilityKey(b)}:${connectionBindingKey(b.connectionIds ?? (b.connectionId ? { default: b.connectionId } : {}))}`)
      )),
    },
    contractSnapshot: {
      ...(usedControls.size ? { controls: controlDefinitions.map(({ id, version, title, input }) => ({ id, version, title, inputSchema: schemaSnapshot(input) })) } : {}),
      capabilities: [...snapshots.values()].sort((a, b) => capabilityKey(a).localeCompare(capabilityKey(b))),
    },
    diagnostics,
  }
}
