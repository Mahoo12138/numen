import type { AutomationSource, BlockSource, ControlSource, InvocationPolicy, NumenValue, TriggerSource, ValueExpr } from '@numenjs/core'
import type { WorkbenchAutomationInsertItem } from './contracts.js'
import { copyAutomationControl, controlCopyError } from './automation-source-copy.js'
import { applyGraphSourceCommand, automationSourceNodeChildren, findAutomationNode, replaceAutomationGraph, type AutomationSourceNode, type GraphSourceCommand, type GraphSourceCommandError } from './graph-source-editing.js'
export { findAutomationNode } from './graph-source-editing.js'

export type AutomationInsertTarget =
  | { kind: 'block'; blockId: string; beforeNodeId?: string }
  | { kind: 'triggers'; beforeTriggerId?: string }
  | { kind: 'root'; beforeNodeId?: string }

export interface AutomationSourceCommandError {
  code: 'TARGET_INVALID' | 'NODE_NOT_FOUND' | 'STRUCTURAL_SLOT' | 'DESCENDANT_TARGET' | 'COPY_UNSAFE' | 'INVALID_BRANCH' | 'MIN_BRANCHES' | GraphSourceCommandError['code']
  message: string
}

export type AutomationSourceCommand =
  | GraphSourceCommand
  | { type: 'SET_AUTOMATION_INPUTS'; inputs: AutomationSource['inputs'] }
  | { type: 'DELETE_STEP'; nodeId: string }
  | { type: 'MOVE_STEP'; nodeId: string; direction: 'up' | 'down' }
  | { type: 'INSERT'; item: WorkbenchAutomationInsertItem; target: AutomationInsertTarget }
  | { type: 'MOVE_TO'; nodeId: string; target: AutomationInsertTarget }
  | { type: 'COPY_TO'; nodeId: string; target: AutomationInsertTarget; source?: AutomationSource }
  | { type: 'ADD_ELSE' | 'REMOVE_ELSE' | 'ADD_BRANCH' | 'CLEAR_BLOCK'; nodeId: string }
  | { type: 'REMOVE_BRANCH'; nodeId: string; branchId: string }
  | { type: 'SET_INVOCATION_POLICY'; nodeId: string; policy?: InvocationPolicy }
  | { type: 'SET_CAPABILITY_CONNECTION'; nodeId: string; slotName: string; connectionId?: string }
  | { type: 'SET_TRIGGER_CONFIG'; nodeId: string; fieldName: string; value?: NumenValue }
  | { type: 'SET_EXTENSION_INPUT'; nodeId: string; fieldName: string; expression?: ValueExpr }
  | { type: 'SET_CAPABILITY_INPUT'; nodeId: string; fieldName: string; expression?: ValueExpr }
  | { type: 'SET_CONTROL_EXPRESSION'; nodeId: string; field: 'condition' | 'items'; expression: ValueExpr }
  | { type: 'SET_WAIT_EXPRESSION'; nodeId: string; field: 'durationMs' | 'until'; expression: ValueExpr }

export interface AutomationSourceCommandResult {
  source: AutomationSource
  selectedNodeId?: string | undefined
  error?: AutomationSourceCommandError
  idMap?: Record<string, string>
  removedNodeIds?: string[]
}

function collectControlIds(source: AutomationSource): Set<string> {
  const ids = new Set(source.triggers.map(trigger => trigger.id))
  const visit = (control: AutomationSourceNode): void => {
    ids.add(control.id)
    switch (control.type) {
      case 'block':
        control.steps.forEach(visit)
        break
      case 'if':
        visit(control.then)
        if (control.else) visit(control.else)
        break
      case 'parallel':
      case 'race':
        control.branches.forEach(visit)
        break
      case 'foreach':
        visit(control.body)
        break
      case 'graph':
        control.nodes.forEach(visit)
        break
      default:
        break
    }
  }
  visit(source.flow)
  // References left after deletion must not silently bind to a newly inserted step with a reused ID.
  const reservePath = (path: unknown): void => {
    if (typeof path !== 'string' || !path.startsWith('steps.')) return
    const segments = path.slice(6).split('.')
    for (let count = 1; count <= segments.length; count += 1) ids.add(segments.slice(0, count).join('.'))
  }
  const reserveReferences = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (record.type === 'ref') reservePath(record.path)
    if (record.type === 'template' && Array.isArray(record.parts)) {
      for (const part of record.parts) if (part && typeof part === 'object') reservePath(part.ref)
    }
    for (const child of Object.values(value)) reserveReferences(child)
  }
  reserveReferences(source)
  return ids
}

function availableId(ids: Set<string>, prefix: string): string {
  let suffix = 1
  while (ids.has(`${prefix}-${suffix}`)) suffix += 1
  const id = `${prefix}-${suffix}`
  ids.add(id)
  return id
}

function fail(source: AutomationSource, code: AutomationSourceCommandError['code'], message: string): AutomationSourceCommandResult {
  return { source, error: { code, message } }
}

/** A stale insertion anchor never changes the destination or falls back to root. */
export function automationInsertTargetError(
  source: AutomationSource,
  target: AutomationInsertTarget,
  itemKind?: 'trigger' | 'step',
): string | undefined {
  if (!target) return 'Choose an explicit insertion target.'
  if (itemKind === 'trigger' && target.kind !== 'triggers') return 'Triggers can only be inserted in the trigger list.'
  if (itemKind === 'step' && target.kind === 'triggers') return 'Flow steps cannot be inserted in the trigger list.'
  if (target.kind === 'triggers') {
    if (target.beforeTriggerId !== undefined && !source.triggers.some(trigger => trigger.id === target.beforeTriggerId)) {
      return 'The trigger insertion position no longer exists.'
    }
    return
  }
  if (target.kind === 'root') {
    if (source.flow.type === 'graph') return 'Graph members require an explicit Graph command.'
    if (source.flow.type === 'block') return 'The root flow changed. Choose its current block as the target.'
    if (target.beforeNodeId !== undefined && target.beforeNodeId !== source.flow.id) return 'The root insertion position no longer exists.'
    return
  }
  if (target.kind !== 'block') return 'The insertion target is not supported.'
  const block = findAutomationControl(source, target.blockId)
  if (!block || block.type !== 'block') return 'The target block no longer exists.'
  if (target.beforeNodeId !== undefined && !block.steps.some(step => step.id === target.beforeNodeId)) {
    return 'The insertion position no longer belongs to the target block.'
  }
}

function insertControlAt(source: AutomationSource, control: ControlSource, target: Exclude<AutomationInsertTarget, { kind: 'triggers' }>, ids: Set<string>): AutomationSource {
  if (target.kind === 'root') {
    return { ...source, flow: { type: 'block', id: availableId(ids, 'flow'), steps: target.beforeNodeId ? [control, source.flow] : [source.flow, control] } }
  }
  const result = editControl(source.flow, target.blockId, node => {
    if (node.type !== 'block') return node
    const steps = [...node.steps]
    const index = target.beforeNodeId === undefined ? steps.length : steps.findIndex(step => step.id === target.beforeNodeId)
    steps.splice(index, 0, control)
    return { ...node, steps }
  })
  return { ...source, flow: result.control }
}

function createInsertControl(
  item: Exclude<WorkbenchAutomationInsertItem, { kind: 'trigger' }>,
  ids: Set<string>,
): ControlSource {
  if (item.kind === 'capability' || item.kind === 'extension') {
    const input = Object.fromEntries((item.inputFields ?? []).flatMap(field => (
      'defaultValue' in field
        ? [[field.name, { type: 'literal' as const, value: field.defaultValue! }]]
        : []
    )))
    if (item.kind === 'extension') return { type: 'extension', id: availableId(ids, 'control'), control: item.control, input }
    return {
      type: 'capability',
      id: availableId(ids, 'capability'),
      capability: item.capability,
      input,
    }
  }
  switch (item.control) {
    case 'wait':
      return {
        type: 'wait',
        id: availableId(ids, 'wait'),
        durationMs: { type: 'literal', value: 60_000 },
      }
    case 'if': {
      const id = availableId(ids, 'if')
      return {
        type: 'if',
        id,
        condition: { type: 'literal', value: true },
        then: { type: 'block', id: availableId(ids, `${id}-then`), steps: [] },
      }
    }
    case 'parallel':
    case 'race': {
      const id = availableId(ids, item.control)
      return {
        type: item.control,
        id,
        branches: [
          { type: 'block', id: availableId(ids, `${id}-branch`), steps: [] },
          { type: 'block', id: availableId(ids, `${id}-branch`), steps: [] },
        ],
      }
    }
    case 'foreach': {
      const id = availableId(ids, 'foreach')
      return {
        type: 'foreach',
        id,
        items: { type: 'literal', value: [] },
        body: { type: 'block', id: availableId(ids, `${id}-body`), steps: [] },
        concurrency: 1,
      }
    }
  }
}

function insertItem(source: AutomationSource, item: WorkbenchAutomationInsertItem, target: AutomationInsertTarget): AutomationSourceCommandResult {
  const error = automationInsertTargetError(source, target, item.kind === 'trigger' ? 'trigger' : 'step')
  if (error) return fail(source, 'TARGET_INVALID', error)
  const ids = collectControlIds(source)
  if (item.kind === 'trigger' && target.kind === 'triggers') {
    const config = Object.fromEntries(item.inputFields.flatMap(field => (
      field.defaultValue === undefined ? [] : [[field.name, structuredClone(field.defaultValue)]]
    )))
    const trigger: TriggerSource = { id: availableId(ids, 'trigger'), capability: structuredClone(item.capability), config }
    const triggers = [...source.triggers]
    const index = target.beforeTriggerId === undefined ? triggers.length : triggers.findIndex(node => node.id === target.beforeTriggerId)
    triggers.splice(index, 0, trigger)
    return { source: { ...source, triggers }, selectedNodeId: trigger.id }
  }
  if (item.kind === 'trigger' || target.kind === 'triggers') return fail(source, 'TARGET_INVALID', 'The item and insertion target do not match.')
  const control = createInsertControl(structuredClone(item), ids)
  return { source: insertControlAt(source, control, target, ids), selectedNodeId: control.id }
}

function editControl(
  control: ControlSource,
  nodeId: string,
  edit: (control: ControlSource) => ControlSource,
): { control: ControlSource; changed: boolean } {
  if (control.id === nodeId) {
    const edited = edit(control)
    return { control: edited, changed: edited !== control }
  }
  switch (control.type) {
    case 'graph': {
      const index = control.nodes.findIndex(node => node.id === nodeId && node.type === 'capability')
      if (index >= 0) {
        const member = control.nodes[index]!
        if (member.type !== 'capability') break
        const edited = edit(member)
        if (edited !== member && edited.type === 'capability') {
          const nodes = [...control.nodes]; nodes[index] = edited
          return { control: { ...control, nodes }, changed: true }
        }
      }
      for (let memberIndex = 0; memberIndex < control.nodes.length; memberIndex++) {
        const member = control.nodes[memberIndex]!
        if (member.type !== 'foreach') continue
        const result = editControl(member.body, nodeId, edit)
        if (result.changed && result.control.type === 'graph') {
          const nodes = [...control.nodes]; nodes[memberIndex] = { ...member, body: result.control }
          return { control: { ...control, nodes }, changed: true }
        }
      }
      break
    }
    case 'block': {
      for (let index = 0; index < control.steps.length; index += 1) {
        const result = editControl(control.steps[index]!, nodeId, edit)
        if (result.changed) {
          const steps = [...control.steps]
          steps[index] = result.control
          return { control: { ...control, steps }, changed: true }
        }
      }
      break
    }
    case 'if': {
      const thenResult = editControl(control.then, nodeId, edit)
      if (thenResult.changed) {
        return { control: { ...control, then: thenResult.control as BlockSource }, changed: true }
      }
      if (control.else) {
        const elseResult = editControl(control.else, nodeId, edit)
        if (elseResult.changed) {
          return { control: { ...control, else: elseResult.control as BlockSource }, changed: true }
        }
      }
      break
    }
    case 'parallel':
    case 'race': {
      for (let index = 0; index < control.branches.length; index += 1) {
        const result = editControl(control.branches[index]!, nodeId, edit)
        if (result.changed) {
          const branches = [...control.branches]
          branches[index] = result.control as BlockSource
          return { control: { ...control, branches }, changed: true }
        }
      }
      break
    }
    case 'foreach': {
      const result = editControl(control.body, nodeId, edit)
      if (result.changed) {
        return { control: { ...control, body: result.control as BlockSource }, changed: true }
      }
      break
    }
    default:
      break
  }
  return { control, changed: false }
}

function setControlExpression(
  source: AutomationSource,
  nodeId: string,
  field: 'condition' | 'items',
  expression: ValueExpr,
): AutomationSource {
  const graphNode = findAutomationNode(source, nodeId)
  if ((field === 'condition' && graphNode?.type === 'condition') || (field === 'items' && graphNode?.type === 'foreach' && graphNode.body.type === 'graph')) {
    if (JSON.stringify(graphNode.type === 'condition' ? graphNode.condition : graphNode.items) === JSON.stringify(expression)) return source
    const pending: AutomationSourceNode[] = [source.flow]
    while (pending.length) {
      const node = pending.pop()!
      if (node.type === 'graph' && node.nodes.some(member => member === graphNode)) return replaceAutomationGraph(source, node.id, graph => ({ ...graph,
        nodes: graph.nodes.map(member => member === graphNode ? { ...member, [field]: structuredClone(expression) } : member),
      }))
      pending.push(...automationSourceNodeChildren(node))
    }
  }
  const result = editControl(source.flow, nodeId, control => {
    if (field === 'condition' && control.type === 'if') {
      return JSON.stringify(control.condition) === JSON.stringify(expression)
        ? control : { ...control, condition: expression }
    }
    if (field === 'items' && control.type === 'foreach') {
      return JSON.stringify(control.items) === JSON.stringify(expression)
        ? control : { ...control, items: expression }
    }
    return control
  })
  return result.changed ? { ...source, flow: result.control } : source
}

function setWaitExpression(
  source: AutomationSource,
  nodeId: string,
  field: 'durationMs' | 'until',
  expression: ValueExpr,
): AutomationSource {
  const result = editControl(source.flow, nodeId, control => {
    if (control.type !== 'wait') return control
    if (JSON.stringify(control[field]) === JSON.stringify(expression)
      && (field === 'durationMs' ? !control.until : !control.durationMs)) return control
    return {
      type: 'wait',
      id: control.id,
      [field]: expression,
    }
  })
  return result.changed ? { ...source, flow: result.control } : source
}

function setNodeInput(
  source: AutomationSource,
  nodeId: string,
  fieldName: string,
  expression: ValueExpr | undefined,
  kind: 'capability' | 'extension' = 'capability',
): AutomationSource {
  if (!fieldName) throw new TypeError('Input field name is required.')
  const result = editControl(source.flow, nodeId, control => {
    if (control.type !== kind || (control.type !== 'capability' && control.type !== 'extension')) return control
    const current = control.input[fieldName]
    if (expression === undefined) {
      if (!(fieldName in control.input)) return control
      const input = { ...control.input }
      delete input[fieldName]
      return { ...control, input }
    }
    if (JSON.stringify(current) === JSON.stringify(expression)) return control
    return { ...control, input: { ...control.input, [fieldName]: expression } }
  })
  return result.changed ? { ...source, flow: result.control } : source
}

function setCapabilityConnection(
  source: AutomationSource,
  nodeId: string,
  slotName: string,
  connectionId: string | undefined,
): AutomationSource {
  if (!slotName) throw new TypeError('Capability connection slot name is required.')
  if (connectionId !== undefined && !connectionId) throw new TypeError('Connection ID must be non-empty when provided.')
  const updateBindings = <Node extends { connection?: string; connections?: Record<string, string> }>(node: Node): Node => {
    const connections = {
      ...(node.connection ? { [slotName]: node.connection } : {}),
      ...node.connections,
    }
    if (connectionId === undefined) delete connections[slotName]
    else connections[slotName] = connectionId
    const { connection: _legacy, connections: _current, ...rest } = node
    if (!Object.keys(connections).length) return (node.connection || node.connections ? rest : node) as Node
    if (!node.connection && JSON.stringify(node.connections) === JSON.stringify(connections)) return node
    return { ...rest, connections } as Node
  }
  const triggerIndex = source.triggers.findIndex(trigger => trigger.id === nodeId)
  if (triggerIndex >= 0) {
    const trigger = updateBindings(source.triggers[triggerIndex]!)
    if (trigger === source.triggers[triggerIndex]) return source
    const triggers = [...source.triggers]
    triggers[triggerIndex] = trigger
    return { ...source, triggers }
  }
  const result = editControl(source.flow, nodeId, control => {
    if (control.type !== 'capability') return control
    return updateBindings(control)
  })
  return result.changed ? { ...source, flow: result.control } : source
}

function setTriggerConfig(source: AutomationSource, nodeId: string, fieldName: string, value: NumenValue | undefined): AutomationSource {
  if (!fieldName) throw new TypeError('Trigger config field name is required.')
  const index = source.triggers.findIndex(trigger => trigger.id === nodeId)
  if (index < 0) return source
  const current = source.triggers[index]!
  const config = { ...current.config }
  if (value === undefined) {
    if (!(fieldName in config)) return source
    delete config[fieldName]
  } else {
    if (JSON.stringify(config[fieldName]) === JSON.stringify(value)) return source
    config[fieldName] = structuredClone(value)
  }
  const triggers = [...source.triggers]
  triggers[index] = { ...current, config }
  return { ...source, triggers }
}

export interface AutomationStepEditOptions {
  canDelete: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  canMoveTo: boolean
  canCopy: boolean
}

/** Render-time move eligibility by ID; commands still validate their current Source and destination. */
export function automationMovableNodeIds(source: AutomationSource): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const trigger of source.triggers) if (trigger.id) ids.add(trigger.id)
  visitControls(source.flow, node => {
    // Only sequence members move independently; branch/body slots retain their required identity.
    if (node.type === 'block') for (const child of node.steps) if (child.id) ids.add(child.id)
  })
  return ids
}

function sequencePosition(source: AutomationSource, nodeId: string): { block: BlockSource; index: number } | undefined {
  let position: { block: BlockSource; index: number } | undefined
  // Find only Block.steps membership; branch/body slots keep their required identity.
  const visit = (control: ControlSource): void => {
    if (position) return
    if (control.type === 'block') {
      const index = control.steps.findIndex(child => child.id === nodeId)
      if (index >= 0) { position = { block: control, index }; return }
      control.steps.forEach(visit)
    } else if (control.type === 'if') {
      visit(control.then)
      if (control.else) visit(control.else)
    } else if (control.type === 'foreach') visit(control.body)
    else if (control.type === 'parallel' || control.type === 'race') control.branches.forEach(visit)
  }
  visit(source.flow)
  return position
}

/** Mandatory branch/body Blocks and Trigger declarations are not sequence steps. */
export function automationStepEditOptions(source: AutomationSource, nodeId: string | undefined): AutomationStepEditOptions {
  const triggerIndex = nodeId ? source.triggers.findIndex(trigger => trigger.id === nodeId) : -1
  const position = nodeId ? sequencePosition(source, nodeId) : undefined
  return {
    canDelete: triggerIndex >= 0 || !!position || (source.flow.type !== 'block' && source.flow.type !== 'graph' && source.flow.id === nodeId),
    canMoveTo: triggerIndex >= 0 || !!position,
    canCopy: !!nodeId && automationNodeCopyError(source, nodeId) === undefined,
    canMoveUp: triggerIndex > 0 || (!!position && position.index > 0),
    canMoveDown: (triggerIndex >= 0 && triggerIndex < source.triggers.length - 1) || (!!position && position.index < position.block.steps.length - 1),
  }
}

function editSequence(source: AutomationSource, nodeId: string, direction?: 'up' | 'down'): AutomationSourceCommandResult {
  const triggerIndex = source.triggers.findIndex(trigger => trigger.id === nodeId)
  if (triggerIndex >= 0) {
    const triggers = [...source.triggers]
    if (direction) {
      const target = triggerIndex + (direction === 'up' ? -1 : 1)
      if (target < 0 || target >= triggers.length) return { source }
      const moved = triggers[triggerIndex]!
      triggers[triggerIndex] = triggers[target]!
      triggers[target] = moved
      return { source: { ...source, triggers }, selectedNodeId: nodeId }
    }
    triggers.splice(triggerIndex, 1)
    return {
      source: { ...source, triggers },
      removedNodeIds: [nodeId],
      selectedNodeId: triggers[triggerIndex]?.id ?? triggers[triggerIndex - 1]?.id,
    }
  }
  const position = sequencePosition(source, nodeId)
  if (!position) {
    if (source.flow.type === 'graph' && source.flow.id === nodeId) return fail(source, 'STRUCTURAL_SLOT', 'The Graph Start is a required scope boundary.')
    if (!direction && source.flow.id === nodeId && source.flow.type !== 'block') {
      return { source: { ...source, flow: { type: 'block', id: availableId(collectControlIds(source), 'flow'), steps: [] } }, selectedNodeId: undefined, removedNodeIds: subtreeIds(source.flow) }
    }
    return fail(source, findAutomationControl(source, nodeId) ? 'STRUCTURAL_SLOT' : 'NODE_NOT_FOUND', 'Required branch and body blocks cannot be removed or reordered as steps.')
  }
  const { block, index } = position
  const steps = [...block.steps]
  let selectedNodeId: string | undefined = nodeId
  if (direction) {
    const target = index + (direction === 'up' ? -1 : 1)
    if (target < 0 || target >= steps.length) return { source }
    const moved = steps[index]!
    steps[index] = steps[target]!
    steps[target] = moved
  } else {
    steps.splice(index, 1)
    selectedNodeId = steps[index]?.id ?? steps[index - 1]?.id
      ?? (block.id === source.flow.id ? undefined : block.id)
  }
  const result = editControl(source.flow, block.id, () => ({ ...block, steps }))
  return { source: { ...source, flow: result.control }, selectedNodeId, ...(!direction ? { removedNodeIds: subtreeIds(block.steps[index]!) } : {}) }
}

function visitControls(control: ControlSource, visit: (node: ControlSource) => void): void {
  visit(control)
  switch (control.type) {
    case 'block': control.steps.forEach(child => visitControls(child, visit)); break
    case 'if': visitControls(control.then, visit); if (control.else) visitControls(control.else, visit); break
    case 'foreach': visitControls(control.body, visit); break
    case 'parallel': case 'race': control.branches.forEach(child => visitControls(child, visit)); break
  }
}

function subtreeIds(control: ControlSource): string[] {
  const ids: string[] = []
  visitControls(control, node => ids.push(node.id))
  return ids
}

/** Resolve before/after once when opening the picker; do not resolve again when accepting it. */
export function automationRelativeInsertTarget(source: AutomationSource, nodeId: string, position: 'before' | 'after'): AutomationInsertTarget | undefined {
  const triggerIndex = source.triggers.findIndex(trigger => trigger.id === nodeId)
  if (triggerIndex >= 0) {
    const beforeTriggerId = source.triggers[triggerIndex + (position === 'after' ? 1 : 0)]?.id
    return { kind: 'triggers', ...(beforeTriggerId === undefined ? {} : { beforeTriggerId }) }
  }
  const found = sequencePosition(source, nodeId)
  if (found) {
    const beforeNodeId = found.block.steps[found.index + (position === 'after' ? 1 : 0)]?.id
    return { kind: 'block', blockId: found.block.id, ...(beforeNodeId === undefined ? {} : { beforeNodeId }) }
  }
  if (source.flow.id === nodeId && source.flow.type !== 'block') {
    return { kind: 'root', ...(position === 'before' ? { beforeNodeId: nodeId } : {}) }
  }
}

export function automationBlockDestinations(source: AutomationSource): Array<{ blockId: string; label: string }> {
  const destinations: Array<{ blockId: string; label: string }> = []
  visitControls(source.flow, node => {
    if (node.type === 'block') destinations.push({ blockId: node.id, label: node.id })
  })
  return destinations
}

export function automationNodeCopyError(source: AutomationSource, nodeId: string): string | undefined {
  const trigger = findAutomationTrigger(source, nodeId)
  if (trigger) return trigger.id.includes('.') ? 'Copy is unavailable for dotted node IDs.' : undefined
  const control = findAutomationControl(source, nodeId)
  if (!control) return 'The source node no longer exists.'
  return controlCopyError(control, source)
}

function moveTo(source: AutomationSource, nodeId: string, target: AutomationInsertTarget): AutomationSourceCommandResult {
  const trigger = findAutomationTrigger(source, nodeId)
  const control = findAutomationControl(source, nodeId)
  if (!trigger && !control) return fail(source, 'NODE_NOT_FOUND', 'The step to move no longer exists.')
  const error = automationInsertTargetError(source, target, trigger ? 'trigger' : 'step')
  if (error) return fail(source, 'TARGET_INVALID', error)
  if (trigger && target.kind === 'triggers') {
    if (target.beforeTriggerId === nodeId) return { source }
    const triggers = source.triggers.filter(node => node.id !== nodeId)
    const index = target.beforeTriggerId === undefined ? triggers.length : triggers.findIndex(node => node.id === target.beforeTriggerId)
    triggers.splice(index, 0, trigger)
    if (triggers.every((node, i) => node === source.triggers[i])) return { source }
    return { source: { ...source, triggers }, selectedNodeId: nodeId }
  }
  if (!control || target.kind === 'triggers') return fail(source, 'TARGET_INVALID', 'The step and target do not match.')
  const position = sequencePosition(source, nodeId)
  if (!position) return fail(source, 'STRUCTURAL_SLOT', 'Root flows and required branch/body blocks cannot be moved as steps.')
  if (target.kind === 'block' && subtreeIds(control).includes(target.blockId)) {
    return fail(source, 'DESCENDANT_TARGET', 'A step cannot be moved into itself or one of its descendants.')
  }
  if (target.kind === 'block' && target.blockId === position.block.id) {
    const nextNodeId = position.block.steps[position.index + 1]?.id
    if (target.beforeNodeId === nodeId || target.beforeNodeId === nextNodeId) return { source }
  }
  // Validate against the original source before detaching. The selected node is retained atomically.
  const detached = editSequence(source, nodeId).source
  return { source: insertControlAt(detached, control, target, collectControlIds(source)), selectedNodeId: nodeId }
}

function copyTo(source: AutomationSource, nodeId: string, target: AutomationInsertTarget, snapshot: AutomationSource): AutomationSourceCommandResult {
  const trigger = findAutomationTrigger(snapshot, nodeId)
  const control = findAutomationControl(snapshot, nodeId)
  if (!trigger && !control) return fail(source, 'NODE_NOT_FOUND', 'The node to copy no longer exists.')
  const targetError = automationInsertTargetError(source, target, trigger ? 'trigger' : 'step')
  if (targetError) return fail(source, 'TARGET_INVALID', targetError)
  const copyError = automationNodeCopyError(snapshot, nodeId)
  if (copyError) return fail(source, 'COPY_UNSAFE', copyError)
  const ids = collectControlIds(source)
  // The snapshot may outlive the original subtree. Its old IDs must still receive fresh IDs.
  for (const id of collectControlIds(snapshot)) ids.add(id)
  if (trigger && target.kind === 'triggers') {
    const id = availableId(ids, 'trigger')
    const triggers = [...source.triggers]
    const index = target.beforeTriggerId === undefined ? triggers.length : triggers.findIndex(node => node.id === target.beforeTriggerId)
    triggers.splice(index, 0, { ...structuredClone(trigger), id })
    return { source: { ...source, triggers }, selectedNodeId: id, idMap: { [nodeId]: id } }
  }
  if (!control || target.kind === 'triggers') return fail(source, 'TARGET_INVALID', 'The step and target do not match.')
  const { control: copied, idMap } = copyAutomationControl(control, snapshot, oldId => availableId(ids, `${oldId}-copy`))
  return { source: insertControlAt(source, copied, target, ids), selectedNodeId: copied.id, idMap }
}

function editContainer(
  source: AutomationSource,
  command: Extract<AutomationSourceCommand, { type: 'ADD_ELSE' | 'REMOVE_ELSE' | 'ADD_BRANCH' | 'REMOVE_BRANCH' | 'CLEAR_BLOCK' }>,
): AutomationSourceCommandResult {
  const node = findAutomationControl(source, command.nodeId)
  if (!node) return fail(source, 'NODE_NOT_FOUND', 'The container no longer exists.')
  const ids = collectControlIds(source)
  let edited: ControlSource
  let selectedNodeId = node.id
  let removedNodeIds: string[] = []
  switch (command.type) {
    case 'ADD_ELSE': {
      if (node.type !== 'if') return fail(source, 'INVALID_BRANCH', 'Only If supports an else branch.')
      if (node.else) return { source }
      const branch: BlockSource = { type: 'block', id: availableId(ids, `${node.id}-else`), steps: [] }
      edited = { ...node, else: branch }
      selectedNodeId = branch.id
      break
    }
    case 'REMOVE_ELSE': {
      if (node.type !== 'if') return fail(source, 'INVALID_BRANCH', 'Only If supports an else branch.')
      if (!node.else) return { source }
      removedNodeIds = subtreeIds(node.else)
      const { else: _else, ...rest } = node
      edited = rest
      break
    }
    case 'ADD_BRANCH': {
      if (node.type !== 'parallel' && node.type !== 'race') return fail(source, 'INVALID_BRANCH', 'Only Parallel and Race support additional branches.')
      const branch: BlockSource = { type: 'block', id: availableId(ids, `${node.id}-branch`), steps: [] }
      edited = { ...node, branches: [...node.branches, branch] }
      selectedNodeId = branch.id
      break
    }
    case 'REMOVE_BRANCH': {
      if (node.type !== 'parallel' && node.type !== 'race') return fail(source, 'INVALID_BRANCH', 'Only Parallel and Race support removable branches.')
      const branch = node.branches.find(candidate => candidate.id === command.branchId)
      if (!branch) return fail(source, 'INVALID_BRANCH', 'The branch no longer belongs to this container.')
      if (node.branches.length <= 2) return fail(source, 'MIN_BRANCHES', 'Parallel and Race require at least two branches.')
      removedNodeIds = subtreeIds(branch)
      edited = { ...node, branches: node.branches.filter(candidate => candidate.id !== command.branchId) }
      break
    }
    case 'CLEAR_BLOCK': {
      if (node.type !== 'block') return fail(source, 'STRUCTURAL_SLOT', 'Only a block can be cleared.')
      if (!node.steps.length) return { source }
      removedNodeIds = node.steps.flatMap(subtreeIds)
      edited = { ...node, steps: [] }
      break
    }
  }
  const result = editControl(source.flow, node.id, () => edited)
  return { source: { ...source, flow: result.control }, selectedNodeId, removedNodeIds }
}

/** Applies one structured edit while preserving AutomationSource as the sole semantic truth. */
export function applyAutomationSourceCommand(
  source: AutomationSource,
  command: AutomationSourceCommand,
): AutomationSourceCommandResult {
  if (command.type.startsWith('GRAPH_')) return applyGraphSourceCommand(source, command as GraphSourceCommand)
  switch (command.type) {
    case 'SET_AUTOMATION_INPUTS': {
      const { inputs: _inputs, ...rest } = source
      return { source: command.inputs === undefined ? rest : { ...rest, inputs: structuredClone(command.inputs) } }
    }
    case 'DELETE_STEP': return editSequence(source, command.nodeId)
    case 'MOVE_STEP': return editSequence(source, command.nodeId, command.direction)
    case 'INSERT': return insertItem(source, command.item, command.target)
    case 'MOVE_TO': return moveTo(source, command.nodeId, command.target)
    case 'COPY_TO': return copyTo(source, command.nodeId, command.target, command.source ?? source)
    case 'ADD_ELSE': case 'REMOVE_ELSE': case 'ADD_BRANCH': case 'REMOVE_BRANCH': case 'CLEAR_BLOCK':
      return editContainer(source, command)
    case 'SET_INVOCATION_POLICY': {
      const result = editControl(source.flow, command.nodeId, control => {
        if (control.type !== 'capability' || JSON.stringify(control.policy) === JSON.stringify(command.policy)) return control
        const { policy: _policy, ...rest } = control
        return command.policy === undefined ? rest : { ...rest, policy: structuredClone(command.policy) }
      })
      return { source: result.changed ? { ...source, flow: result.control } : source }
    }
    case 'SET_CAPABILITY_CONNECTION': return {
      source: setCapabilityConnection(source, command.nodeId, command.slotName, command.connectionId),
    }
    case 'SET_TRIGGER_CONFIG': return {
      source: setTriggerConfig(source, command.nodeId, command.fieldName, command.value),
    }
    case 'SET_EXTENSION_INPUT': return { source: setNodeInput(source, command.nodeId, command.fieldName, command.expression, 'extension') }
    case 'SET_CAPABILITY_INPUT': return {
      source: setNodeInput(source, command.nodeId, command.fieldName, command.expression),
    }
    case 'SET_CONTROL_EXPRESSION': return {
      source: setControlExpression(source, command.nodeId, command.field, command.expression),
    }
    case 'SET_WAIT_EXPRESSION': return {
      source: setWaitExpression(source, command.nodeId, command.field, command.expression),
    }
  }
  return { source }
}

export function findAutomationControl(source: AutomationSource, nodeId: string): ControlSource | undefined {
  const node = findAutomationNode(source, nodeId)
  if (node?.type === 'condition' || node?.type === 'merge' || (node?.type === 'foreach' && node.body.type === 'graph')) return undefined
  return node as ControlSource | undefined
}

export function findAutomationTrigger(source: AutomationSource, nodeId: string): TriggerSource | undefined {
  return source.triggers.find(trigger => trigger.id === nodeId)
}

export function automationSourceHasNode(source: AutomationSource, nodeId: string | undefined): boolean {
  return !!nodeId && (
    source.triggers.some(trigger => trigger.id === nodeId)
    || !!findAutomationNode(source, nodeId)
  )
}
