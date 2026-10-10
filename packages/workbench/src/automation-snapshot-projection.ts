import { isSupportedAutomationVersion, type AutomationExecutionSnapshot, type ControlSource, type GraphNodeSource, type NumenValue, type ValueExpr } from '@numenjs/core'
import type { WorkbenchAutomationSnapshotDetail, WorkbenchAutomationSnapshotSourceNode, WorkbenchInspectedValue } from './contracts.js'
import { inspectExecutionValue } from './execution-inspection.js'
import { projectRunFlow } from './run-detail-projection.js'
import { findInspectionSourceNode, inspectionSourceChildren } from './automation-source-inspection.js'

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: string): string => value.slice(0, 200)
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const omitted: WorkbenchInspectedValue = { value: '[Inspection limit reached]', hidden: 0, truncated: true, available: true }
const absent: WorkbenchInspectedValue = { value: '[No literal input]', hidden: 0, truncated: false, available: false }
const expressionTypes = new Set(['literal', 'ref', 'array', 'object', 'template', 'call'])

/** Literal containers are inspected using the immutable contract; expressions are never evaluated. */
function literalExpression(expression: ValueExpr, budget: { remaining: number; truncated: boolean }, depth = 0): { available: boolean; value?: NumenValue } {
  if (depth > 6 || budget.remaining-- <= 0) { budget.truncated = true; return { available: false } }
  if (expression.type === 'literal') return { available: true, value: expression.value }
  if (expression.type === 'object') {
    const output: Record<string, NumenValue> = Object.create(null)
    for (const [key, item] of Object.entries(expression.entries)) {
      if (budget.remaining <= 0) { budget.truncated = true; break }
      const result = literalExpression(item, budget, depth + 1)
      if (result.available) output[key] = result.value!
    }
    return { available: true, value: output }
  }
  if (expression.type === 'array') {
    if (expression.items.length > 20) budget.truncated = true
    const results = expression.items.slice(0, 20).map(item => literalExpression(item, budget, depth + 1))
    // Partial arrays would misrepresent the authored positions. Keep mixed expressions opaque.
    if (results.some(item => !item.available)) return { available: false }
    return { available: true, value: results.map(item => item.value!) }
  }
  return { available: false }
}

function knownSchemaFields(snapshot: unknown): Set<string> {
  const root = record(snapshot)
  const refs = record(root?.refs)
  const encoded = root && !root.type && typeof root.uid === 'number' ? record(refs?.[String(root.uid)]) : root
  return new Set(Object.keys(record(encoded?.dict) ?? {}))
}

export function projectAutomationSnapshot(snapshot: AutomationExecutionSnapshot, automationName: string, sourceNodeId?: string, maximumNodes = 250): WorkbenchAutomationSnapshotDetail {
  const result: WorkbenchAutomationSnapshotDetail = {
    automationName: text(automationName),
    identity: {
      id: snapshot.id, automationId: snapshot.automationId, purpose: snapshot.purpose,
      ...(snapshot.purpose === 'published' ? { number: snapshot.number } : { sourceDraftVersion: snapshot.sourceDraftVersion }),
      protocolVersion: snapshot.protocolVersion, irVersion: snapshot.irVersion, contentHash: snapshot.contentHash, createdAt: snapshot.createdAt,
    },
    compatibility: isSupportedAutomationVersion(snapshot.protocolVersion, snapshot.irVersion) ? 'supported' : 'unsupported-protocol',
    flow: { root: { id: '__unsupported-snapshot', type: 'block', title: 'Flow unavailable', detail: 'This Source protocol is not supported for inspection.', status: 'IDLE', executionCount: 0, children: [] }, truncated: false },
    source: { nodes: [], triggers: [], policy: { hasGroupBy: false }, truncated: false },
    presentation: { collapsedNodes: [], hiddenFields: 0, truncated: false }, inputs: [], inputsTruncated: false,
  }
  if (result.compatibility !== 'supported') return result
  const selected = sourceNodeId ? findInspectionSourceNode(snapshot.source.flow, sourceNodeId) : snapshot.source.flow
  if (!selected) throw new Error('Source node is not present in this immutable snapshot')
  result.flow = projectRunFlow(snapshot, [], [], sourceNodeId, maximumNodes)
  // The Flow renderer contains metadata only, never expression values or connection identities.
  const pendingFlow = [result.flow.root]
  while (pendingFlow.length) {
    const node = pendingFlow.pop()!
    node.title = text(node.title)
    node.detail = text(node.detail)
    pendingFlow.push(...node.children, ...(node.graph?.nodes ?? []))
  }
  const byteBudget = { remaining: 32_768 }
  const inspected = (value: unknown, schema: unknown): WorkbenchInspectedValue => {
    if (byteBudget.remaining < 128) { result.source.truncated = true; return { ...omitted } }
    const projection = inspectExecutionValue(value, schema)
    const bytes = Buffer.byteLength(JSON.stringify(projection), 'utf8')
    if (bytes > byteBudget.remaining) { result.source.truncated = true; byteBudget.remaining = 0; return { ...omitted } }
    byteBudget.remaining -= bytes
    return projection
  }
  const pending: Array<{ node: ControlSource | GraphNodeSource; depth: number }> = [{ node: selected, depth: 0 }]
  const ids = new Set<string>()
  while (pending.length && result.source.nodes.length < maximumNodes) {
    const { node, depth } = pending.pop()!
    if (depth > 64) { result.source.truncated = true; continue }
    ids.add(node.id)
    const projected: WorkbenchAutomationSnapshotSourceNode = { nodeId: node.id, type: node.type, input: { ...absent }, expressionFields: [], connectionBindingCount: 0 }
    if (node.type === 'capability' || node.type === 'extension') {
      const ref = node.type === 'capability' ? node.capability : node.control
      if (node.type === 'capability') {
        projected.capability = { id: text(ref.id), version: ref.version }
        projected.connectionBindingCount = Object.keys(node.connections ?? {}).length || (node.connection ? 1 : 0)
        const policy = node.policy
        if (policy) projected.policy = {
          ...(numeric(policy.timeoutMs) ? { timeoutMs: policy.timeoutMs } : {}),
          ...(policy.retry && numeric(policy.retry.maxAttempts) ? { retry: { maxAttempts: policy.retry.maxAttempts, ...(numeric(policy.retry.backoffMs) ? { backoffMs: policy.retry.backoffMs } : {}) } } : {}),
        }
      } else projected.control = { id: text(ref.id), version: ref.version }
      const schema = node.type === 'capability'
        ? snapshot.contractSnapshot.capabilities.find(item => item.id === ref.id && item.version === ref.version)?.inputSchema
        : snapshot.contractSnapshot.controls?.find(item => item.id === ref.id && item.version === ref.version)?.inputSchema
      const known = knownSchemaFields(schema)
      const values: Record<string, NumenValue> = Object.create(null)
      const budget = { remaining: 128, truncated: false }
      for (const [field, expression] of Object.entries(node.input)) {
        const literal = literalExpression(expression, budget)
        if (literal.available) values[field] = literal.value!
        if (known.has(field) && field.length <= 128 && projected.expressionFields.length < 30) projected.expressionFields.push({ field, type: expressionTypes.has(expression.type) ? expression.type : 'unknown' })
      }
      projected.input = inspected(values, schema)
      if (budget.truncated) { projected.input.truncated = true; result.source.truncated = true }
    } else {
      switch (node.type) {
        case 'if': case 'condition': projected.expressionFields.push({ field: 'condition', type: expressionTypes.has(node.condition.type) ? node.condition.type : 'unknown' }); break
        case 'wait':
          for (const field of ['until', 'durationMs'] as const) if (node[field]) projected.expressionFields.push({ field, type: expressionTypes.has(node[field]!.type) ? node[field]!.type : 'unknown' })
          break
        case 'foreach': projected.expressionFields.push({ field: 'items', type: expressionTypes.has(node.items.type) ? node.items.type : 'unknown' }); break
        case 'block': if (node.output) projected.expressionFields.push({ field: 'output', type: 'object' }); break
        case 'graph': if (node.output) projected.expressionFields.push({ field: 'output', type: expressionTypes.has(node.output.type) ? node.output.type : 'unknown' }); break
      }
    }
    result.source.nodes.push(projected)
    const descendants = inspectionSourceChildren(node)
    const available = maximumNodes - result.source.nodes.length
    if (descendants.length > available) result.source.truncated = true
    pending.push(...descendants.slice(0, available).reverse().map(child => ({ node: child, depth: depth + 1 })))
  }
  if (pending.length) result.source.truncated = true
  if (snapshot.source.triggers.length > 30) result.source.truncated = true
  result.source.triggers = snapshot.source.triggers.slice(0, 30).map(trigger => ({
    id: trigger.id, capability: { id: text(trigger.capability.id), version: trigger.capability.version },
    config: inspected(trigger.config, snapshot.contractSnapshot.capabilities.find(item => item.id === trigger.capability.id && item.version === trigger.capability.version && item.kind === 'trigger')?.inputSchema),
    connectionBindingCount: Object.keys(trigger.connections ?? {}).length || (trigger.connection ? 1 : 0),
  }))
  const policy = snapshot.source.policy
  result.source.policy = { hasGroupBy: !!policy?.groupBy,
    ...(numeric(policy?.maxActive) ? { maxActive: policy.maxActive } : {}),
    ...(policy?.overflow === 'queue' || policy?.overflow === 'drop' || policy?.overflow === 'replace' ? { overflow: policy.overflow } : {}),
  }
  const collapsed = snapshot.presentation.collapsedNodes
  if (Array.isArray(collapsed)) {
    const known = collapsed.filter((item): item is string => typeof item === 'string' && ids.has(item))
    result.presentation.collapsedNodes = [...new Set(known)].slice(0, 250)
    result.presentation.truncated = known.length > 250 || collapsed.length > known.length
  }
  result.presentation.hiddenFields = Object.keys(snapshot.presentation).filter(key => key !== 'collapsedNodes').length
  const inputs = Object.entries(snapshot.source.inputs ?? {})
  result.inputsTruncated = inputs.length > 100
  for (const [name, declaration] of inputs.slice(0, 100)) {
    if (name.length > 128 || !['string', 'number', 'boolean', 'object', 'array'].includes(declaration.type)) { result.inputsTruncated = true; continue }
    result.inputs.push({ name, type: declaration.type, required: declaration.required === true, hasDefault: Object.hasOwn(declaration, 'default') })
  }
  return result
}
