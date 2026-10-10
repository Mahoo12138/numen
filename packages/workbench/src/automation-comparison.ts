import { isSupportedAutomationVersion, type AutomationSource, type NumenValue } from '@numenjs/core'
import type { WorkbenchAutomationChange } from './contracts.js'
import { maximumInspectedSourceNodes } from './automation-source-inspection.js'

export class AutomationComparisonLimitError extends Error {
  override name = 'AutomationComparisonLimitError'
  constructor() { super('Automation comparison exceeds its inspection limits.') }
}

export class AutomationComparisonUnavailableError extends Error {
  override name = 'AutomationComparisonUnavailableError'
  constructor() { super('Automation comparison is unavailable for these documents.') }
}

interface ComparisonDocument {
  source: AutomationSource
  presentation: Record<string, NumenValue>
  protocolVersion: number
  irVersion?: number
}

type RecordValue = Record<string, unknown>
type Field = NonNullable<WorkbenchAutomationChange['field']>
interface Node {
  value: RecordValue
  parent: string | undefined
  slot: string
}
interface ParsedDocument {
  source: RecordValue
  nodes: Map<string, Node>
  groups: Map<string, string[]>
  triggers: Map<string, RecordValue>
}

const unavailable = (): never => { throw new AutomationComparisonUnavailableError() }
const limit = (): never => { throw new AutomationComparisonLimitError() }
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable()
  return value as RecordValue
}
const entries = (value: RecordValue) => Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
const extra = (value: RecordValue, known: string[]): RecordValue => Object.fromEntries(entries(value).filter(([key]) => !known.includes(key)))
const pick = (value: RecordValue, known: string[]): RecordValue => Object.fromEntries(known.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
const hasKeys = (value: RecordValue) => Object.keys(value).length !== 0

/** Compare JSON objects independent of key insertion order; array order remains significant. */
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${entries(value as RecordValue).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
const equal = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)

/** Reject excessive, cyclic and non-JSON data before recursive projections or comparisons. */
function validateJson(value: unknown, maximumDepth: number): void {
  const active = new Set<object>()
  let count = 0
  const visit = (item: unknown, depth: number): void => {
    if (++count > 100_000 || depth > maximumDepth) return limit()
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || active.has(item)) return unavailable()
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return unavailable()
    active.add(item)
    if (Array.isArray(item)) for (const child of item) visit(child, depth + 1)
    else for (const child of Object.values(item)) if (child !== undefined) visit(child, depth + 1)
    active.delete(item)
  }
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8 * 1024 * 1024) limit()
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) || value.startsWith('__')) return unavailable()
  if (value.length > 160) return limit()
  return value
}

function reference(value: unknown, extensions: unknown[]): RecordValue {
  const ref = record(value)
  if (typeof ref.id !== 'string' || !ref.id || !Number.isSafeInteger(ref.version) || (ref.version as number) < 1) return unavailable()
  const opaque = extra(ref, ['id', 'version'])
  if (hasKeys(opaque)) extensions.push({ reference: opaque })
  return pick(ref, ['id', 'version'])
}

/** Paths exist only inside the server's equality inputs and are never returned. */
function expression(value: unknown, extensions: unknown[], path: string[], depth = 0): unknown {
  if (depth > 64) return limit()
  const item = record(value)
  let known: string[]
  let result: RecordValue
  switch (item.type) {
    case 'literal':
      if (item.value === undefined) return unavailable()
      known = ['type', 'value']; result = pick(item, known); break
    case 'ref':
      if (typeof item.path !== 'string') return unavailable()
      known = ['type', 'path']; result = pick(item, known); break
    case 'array': case 'call': {
      const key = item.type === 'array' ? 'items' : 'arguments'
      if (!Array.isArray(item[key]) || (item.type === 'call' && typeof item.function !== 'string')) return unavailable()
      known = item.type === 'array' ? ['type', key] : ['type', 'function', key]
      result = { ...pick(item, known), [key]: (item[key] as unknown[]).map((child, index) => expression(child, extensions, [...path, String(index)], depth + 1)) }
      break
    }
    case 'object': {
      known = ['type', 'entries']
      result = { type: item.type, entries: expressionMap(item.entries, extensions, [...path, 'entries'], depth + 1) }
      break
    }
    case 'template': {
      if (!Array.isArray(item.parts)) return unavailable()
      known = ['type', 'parts']
      result = { type: item.type, parts: item.parts.map((part, index) => {
        if (typeof part === 'string') return part
        const ref = record(part)
        if (typeof ref.ref !== 'string') return unavailable()
        const opaque = extra(ref, ['ref'])
        if (hasKeys(opaque)) extensions.push({ path: [...path, 'parts', String(index)], opaque })
        return { ref: ref.ref }
      }) }
      break
    }
    default: return unavailable()
  }
  const opaque = extra(item, known)
  if (hasKeys(opaque)) extensions.push({ path, opaque })
  return result
}

function expressionMap(value: unknown, extensions: unknown[], path: string[], depth = 0): RecordValue {
  return Object.fromEntries(entries(record(value)).map(([key, item]) => [key, expression(item, extensions, [...path, key], depth)]))
}

function bindings(node: RecordValue): unknown {
  const result: RecordValue = Object.create(null)
  if (node.connection !== undefined) {
    if (typeof node.connection !== 'string' || !node.connection) return unavailable()
    result.default = node.connection
  }
  if (node.connections !== undefined) for (const [key, value] of entries(record(node.connections))) {
    if (!key || typeof value !== 'string' || !value) return unavailable()
    result[key] = value
  }
  // Conflicting authored forms are kept opaque rather than silently discarding one of them.
  const explicit = node.connections === undefined ? undefined : record(node.connections).default
  return node.connection !== undefined && explicit !== undefined && node.connection !== explicit
    ? { bindings: result, legacyConflict: node.connection } : result
}

function invocationPolicy(value: unknown, extensions: unknown[]): RecordValue {
  if (value === undefined) return {}
  const policy = record(value)
  if (policy.timeoutMs !== undefined && typeof policy.timeoutMs !== 'number') return unavailable()
  const opaque = extra(policy, ['timeoutMs', 'retry'])
  if (hasKeys(opaque)) extensions.push({ invocationPolicy: opaque })
  const result = pick(policy, ['timeoutMs'])
  if (policy.retry !== undefined) {
    const retry = record(policy.retry)
    if (typeof retry.maxAttempts !== 'number' || (retry.backoffMs !== undefined && typeof retry.backoffMs !== 'number')) return unavailable()
    result.retry = pick(retry, ['maxAttempts', 'backoffMs'])
    const retryOpaque = extra(retry, ['maxAttempts', 'backoffMs'])
    if (hasKeys(retryOpaque)) extensions.push({ retry: retryOpaque })
  }
  return result
}

const nodeFields: Record<string, string[]> = {
  block: ['type', 'id', 'steps', 'output'], if: ['type', 'id', 'condition', 'then', 'else'], wait: ['type', 'id', 'until', 'durationMs'],
  parallel: ['type', 'id', 'branches'], race: ['type', 'id', 'branches'], foreach: ['type', 'id', 'items', 'body', 'concurrency'],
  capability: ['type', 'id', 'capability', 'connection', 'connections', 'input', 'policy'], extension: ['type', 'id', 'control', 'input'],
  graph: ['type', 'id', 'version', 'nodes', 'edges', 'output'], condition: ['type', 'id', 'condition'], merge: ['type', 'id', 'mode', 'inputs'],
}

function parseDocument(document: ComparisonDocument): ParsedDocument {
  validateJson(document.source, 256)
  validateJson(document.presentation, 64)
  record(document.presentation)
  const source = record(document.source)
  if (!Array.isArray(source.triggers)) return unavailable()
  if (source.triggers.length > 100) return limit()
  const nodes = new Map<string, Node>(), groups = new Map<string, string[]>(), triggers = new Map<string, RecordValue>()
  const walk = (value: unknown, parent: string | undefined, slot: string, depth: number, blockOnly = false): void => {
    if (depth > 64 || nodes.size >= maximumInspectedSourceNodes) return limit()
    const node = record(value), id = identity(node.id)
    if (typeof node.type !== 'string' || !Object.hasOwn(nodeFields, node.type) || (blockOnly && node.type !== 'block') || nodes.has(id)) return unavailable()
    if ((node.type === 'condition' || node.type === 'merge') && (document.protocolVersion !== 2 || slot !== 'graphNodes')) return unavailable()
    nodes.set(id, { value: node, parent, slot })
    const key = JSON.stringify([parent, slot])
    const group = groups.get(key) ?? []
    group.push(id)
    groups.set(key, group)
    const children = (array: unknown, childSlot: string, onlyBlocks = false): void => {
      if (!Array.isArray(array)) return unavailable()
      if (array.length > maximumInspectedSourceNodes) return limit()
      for (const child of array) walk(child, id, childSlot, depth + 1, onlyBlocks)
    }
    switch (node.type) {
      case 'block': children(node.steps, 'steps'); break
      case 'if': walk(node.then, id, 'then', depth + 1, true); if (node.else !== undefined) walk(node.else, id, 'else', depth + 1, true); break
      case 'parallel': case 'race': children(node.branches, 'branches', true); break
      case 'foreach': {
        const graphMember = slot === 'graphNodes'
        if (graphMember && (record(node.body).type !== 'graph' || record(node.body).output === undefined)) return unavailable()
        walk(node.body, id, 'body', depth + 1, !graphMember); break
      }
      case 'graph': {
        if (document.protocolVersion !== 2 || node.version !== 1 || !Array.isArray(node.nodes)) return unavailable()
        if (node.nodes.some(member => !['capability', 'condition', 'merge', 'foreach'].includes(record(member).type as string))) return unavailable()
        children(node.nodes, 'graphNodes')
        const memberIds = new Set(node.nodes.map(member => identity(record(member).id)))
        for (const edge of graphEdges(node.edges)) {
          const from = record(edge.from), to = record(edge.to)
          if ((!memberIds.has(from.nodeId as string) && from.nodeId !== id) || !memberIds.has(to.nodeId as string)) return unavailable()
        }
        break
      }
    }
  }
  walk(source.flow, undefined, 'root', 0)
  for (const value of source.triggers) {
    const trigger = record(value), id = identity(trigger.id)
    if (triggers.has(id)) return unavailable()
    triggers.set(id, trigger)
    record(trigger.config); reference(trigger.capability, []); bindings(trigger)
  }
  return { source, nodes, groups, triggers }
}

function graphEdges(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return unavailable()
  if (value.length > 1_000) return limit()
  const ids = new Set<string>()
  return value.map(item => {
    const edge = record(item), id = graphName(edge.id)
    if (ids.has(id)) return unavailable()
    ids.add(id)
    const endpoint = (value: unknown) => {
      const item = record(value)
      return { nodeId: identity(item.nodeId), port: graphName(item.port) }
    }
    return { id, from: endpoint(edge.from), to: endpoint(edge.to) }
  }).sort((a, b) => (a.id as string).localeCompare(b.id as string))
}

function graphName(value: unknown): string {
  if (typeof value !== 'string' || !value) return unavailable()
  if (value.length > 160) return limit()
  return value
}

function nodeProjection(node: RecordValue) {
  const type = node.type as string
  const extensions: unknown[] = []
  const opaque = extra(node, nodeFields[type]!)
  if (hasKeys(opaque)) extensions.push({ node: opaque })
  const parameters = new Map<Field, unknown>()
  let ref: RecordValue | undefined, connection: unknown, policy: RecordValue | undefined
  const field = (key: Field, value: unknown, required = false): void => {
    if (value !== undefined) parameters.set(key, expression(value, extensions, [key]))
    else if (required) unavailable()
  }
  switch (type) {
    case 'capability':
      ref = reference(node.capability, extensions); connection = bindings(node); policy = invocationPolicy(node.policy, extensions)
      parameters.set('input', expressionMap(node.input, extensions, ['input'])); break
    case 'extension':
      ref = reference(node.control, extensions)
      // Extension-specific inputs remain a single opaque change, regardless of their field names.
      extensions.push({ input: record(node.input) }); break
    case 'block': if (node.output !== undefined) parameters.set('output', expressionMap(node.output, extensions, ['output'])); break
    case 'if': case 'condition': field('condition', node.condition, true); break
    case 'graph':
      field('output', node.output)
      parameters.set('graphEdges', graphEdges(node.edges))
      // Future edge metadata remains opaque without changing public diff payloads.
      for (const item of [...node.edges as unknown[]].sort((a, b) => graphName(record(a).id).localeCompare(graphName(record(b).id)))) {
        const edge = record(item)
        const opaque = { edge: extra(edge, ['id', 'from', 'to']), from: extra(record(edge.from), ['nodeId', 'port']), to: extra(record(edge.to), ['nodeId', 'port']) }
        if (Object.values(opaque).some(hasKeys)) extensions.push(opaque)
      }
      break
    case 'merge':
      if (!['all', 'selected'].includes(node.mode as string) || !Array.isArray(node.inputs) || !node.inputs.length) return unavailable()
      parameters.set('mergeMode', node.mode)
      parameters.set('mergeInputs', node.inputs.map(graphName).sort())
      if (new Set(node.inputs).size !== node.inputs.length) return unavailable()
      break
    case 'wait': field('until', node.until); field('durationMs', node.durationMs); break
    case 'foreach':
      field('items', node.items, true)
      if (node.concurrency !== undefined && typeof node.concurrency !== 'number') unavailable()
      policy = pick(node, ['concurrency']); break
  }
  return { parameters, ref, connection, policy, extensions }
}

/** Choose a largest stable subsequence; insertion/deletion never moves surviving siblings. */
function stableSubsequence(previous: string[], current: string[]): Set<string> {
  const positions = new Map(previous.map((id, index) => [id, index]))
  const tails: number[] = [], predecessors = current.map(() => -1)
  for (let index = 0; index < current.length; index++) {
    const position = positions.get(current[index]!)!
    let start = 0, end = tails.length
    while (start < end) {
      const middle = (start + end) >>> 1
      if (positions.get(current[tails[middle]!]!)! < position) start = middle + 1
      else end = middle
    }
    if (start) predecessors[index] = tails[start - 1]!
    tails[start] = index
  }
  let best = tails.at(-1) ?? -1
  const result = new Set<string>()
  while (best !== -1) { result.add(current[best]!); best = predecessors[best]! }
  return result
}

/** Read-only semantic comparison. Returned metadata never contains authored values or paths. */
export function compareAutomationDocuments(left: ComparisonDocument, right: ComparisonDocument): WorkbenchAutomationChange[] {
  const changes: WorkbenchAutomationChange[] = []
  compareDocuments(left, right, change => {
    if (changes.length >= 1_000) return limit()
    changes.push(change)
  })
  return changes
}

/** All comparisons are computed, but only the requested bounded page is retained and returned. */
export function compareAutomationDocumentPage(left: ComparisonDocument, right: ComparisonDocument, offset = 0, pageSize = 250): { changes: WorkbenchAutomationChange[]; totalChanges: number; nextChangeOffset?: number } {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 250) throw new TypeError('Invalid comparison page')
  const changes: WorkbenchAutomationChange[] = []
  let totalChanges = 0
  compareDocuments(left, right, change => {
    if (totalChanges >= offset && changes.length < pageSize) changes.push(change)
    totalChanges++
  })
  return { changes, totalChanges, ...(offset + changes.length < totalChanges ? { nextChangeOffset: offset + changes.length } : {}) }
}

function compareDocuments(left: ComparisonDocument, right: ComparisonDocument, emit: (change: WorkbenchAutomationChange) => void): void {
  if (!isSupportedAutomationVersion(left.protocolVersion, left.irVersion ?? left.protocolVersion)
    || !isSupportedAutomationVersion(right.protocolVersion, right.irVersion ?? right.protocolVersion)) return unavailable()
  const before = parseDocument(left), after = parseDocument(right)
  const add = (category: WorkbenchAutomationChange['category'], kind: WorkbenchAutomationChange['kind'], field: Field, nodeId?: string): void => {
    emit({ category, kind, field, ...(nodeId === undefined ? {} : { nodeId }) })
  }
  const changed = (category: WorkbenchAutomationChange['category'], field: Field, a: unknown, b: unknown, nodeId?: string) => { if (!equal(a, b)) add(category, 'changed', field, nodeId) }
  const moved = new Set<string>()
  for (const [id, node] of before.nodes) {
    const next = after.nodes.get(id)
    if (!next) add('structure', 'removed', 'node', id)
    else if (node.parent !== next.parent || node.slot !== next.slot) moved.add(id)
  }
  for (const [id] of after.nodes) if (!before.nodes.has(id)) add('structure', 'added', 'node', id)
  for (const [key, group] of after.groups) {
    // Member array order is not Graph execution order. Only explicit edges determine it.
    if (group.some(id => after.nodes.get(id)?.slot === 'graphNodes')) continue
    const current = group.filter(id => before.nodes.has(id) && !moved.has(id))
    const currentIds = new Set(current)
    const previous = (before.groups.get(key) ?? []).filter(id => currentIds.has(id))
    const stable = stableSubsequence(previous, current)
    for (const id of current) if (!stable.has(id)) moved.add(id)
  }
  for (const [id, node] of after.nodes) {
    const previous = before.nodes.get(id)
    // Validate known fields even on additions and removals, so malformed trees cannot yield partial diffs.
    const next = nodeProjection(node.value)
    if (!previous) continue
    const prior = nodeProjection(previous.value)
    if (moved.has(id)) add('structure', 'moved', 'node', id)
    if (previous.value.type !== node.value.type) { add('structure', 'changed', 'type', id); continue }
    if (node.value.type === 'capability' || node.value.type === 'extension') changed('structure', node.value.type === 'capability' ? 'capability' : 'control', prior.ref, next.ref, id)
    for (const field of new Set([...prior.parameters.keys(), ...next.parameters.keys()])) changed(['graphEdges', 'mergeInputs', 'mergeMode'].includes(field) ? 'structure' : 'parameters', field, prior.parameters.get(field), next.parameters.get(field), id)
    changed('bindings', 'connections', prior.connection, next.connection, id)
    changed('policies', node.value.type === 'foreach' ? 'concurrency' : 'invocationPolicy', prior.policy, next.policy, id)
    changed('extensions', 'extensionFields', prior.extensions, next.extensions, id)
  }
  for (const [id, node] of before.nodes) if (!after.nodes.has(id)) nodeProjection(node.value)

  const sourceExtensions = (source: RecordValue): { policy: unknown; inputs: unknown; extensions: unknown[] } => {
    const extensions: unknown[] = [extra(source, ['flow', 'triggers', 'inputs', 'policy'])]
    const policy = source.policy === undefined ? {} : record(source.policy)
    if ((policy.maxActive !== undefined && typeof policy.maxActive !== 'number') || (policy.overflow !== undefined && !['queue', 'drop', 'replace'].includes(policy.overflow as string))) unavailable()
    const policyValue = pick(policy, ['maxActive', 'overflow'])
    if (policy.groupBy !== undefined) policyValue.groupBy = expression(policy.groupBy, extensions, ['policy', 'groupBy'])
    const policyOpaque = extra(policy, ['maxActive', 'overflow', 'groupBy'])
    if (hasKeys(policyOpaque)) extensions.push({ policy: policyOpaque })
    const declarations = source.inputs === undefined ? {} : record(source.inputs), inputs: RecordValue = Object.create(null)
    if (Object.keys(declarations).length > 100) limit()
    for (const [name, value] of entries(declarations)) {
      const declaration = record(value)
      if (!['string', 'number', 'boolean', 'object', 'array'].includes(declaration.type as string)
        || (declaration.required !== undefined && typeof declaration.required !== 'boolean')
        || (declaration.title !== undefined && typeof declaration.title !== 'string')
        || (declaration.description !== undefined && typeof declaration.description !== 'string')) unavailable()
      inputs[name] = { ...pick(declaration, ['type', 'title', 'description', 'default']), required: declaration.required === true }
      const opaque = extra(declaration, ['type', 'title', 'description', 'default', 'required'])
      if (hasKeys(opaque)) extensions.push({ declaration: name, opaque })
    }
    return { policy: policyValue, inputs, extensions }
  }
  const first = sourceExtensions(before.source), second = sourceExtensions(after.source)
  changed('policies', 'automationPolicy', first.policy, second.policy)
  changed('inputs', 'inputDeclarations', first.inputs, second.inputs)
  changed('extensions', 'extensionFields', first.extensions, second.extensions)
  changed('presentation', 'presentation', left.presentation, right.presentation)

  if ([...before.triggers.keys()].some(id => !after.triggers.has(id))) add('triggers', 'removed', 'triggers')
  if ([...after.triggers.keys()].some(id => !before.triggers.has(id))) add('triggers', 'added', 'triggers')
  const triggerProjection = (triggers: Map<string, RecordValue>) => Object.fromEntries([...triggers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, trigger]) => {
    const extensions: unknown[] = [extra(trigger, ['id', 'capability', 'connection', 'connections', 'config'])]
    return [id, { capability: reference(trigger.capability, extensions), config: trigger.config, bindings: bindings(trigger), extensions }]
  }))
  const triggersA = triggerProjection(before.triggers), triggersB = triggerProjection(after.triggers)
  // Added/removed Trigger contents are already represented by their identity change.
  const commonTriggers = [...before.triggers.keys()].filter(id => after.triggers.has(id)).sort()
  for (const [category, field, key] of [['triggers', 'triggerCapability', 'capability'], ['triggers', 'triggerConfig', 'config'], ['bindings', 'connections', 'bindings'], ['extensions', 'extensionFields', 'extensions']] as const) {
    changed(category, field, commonTriggers.map(id => (triggersA[id] as RecordValue)[key]), commonTriggers.map(id => (triggersB[id] as RecordValue)[key]))
  }
}
