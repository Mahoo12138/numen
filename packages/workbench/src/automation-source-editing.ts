import type { AutomationSource, BlockSource, ControlSource, NumenValue, TriggerSource, ValueExpr } from '@numen/core'
import type { WorkbenchAutomationInsertItem } from './contracts.js'

export type AutomationSourceCommand =
  | { type: 'SET_AUTOMATION_INPUTS'; inputs: AutomationSource['inputs'] }
  | { type: 'DELETE_STEP'; nodeId: string }
  | { type: 'MOVE_STEP'; nodeId: string; direction: 'up' | 'down' }
  | { type: 'INSERT'; item: WorkbenchAutomationInsertItem }
  | { type: 'SET_CAPABILITY_CONNECTION'; nodeId: string; slotName: string; connectionId?: string }
  | { type: 'SET_TRIGGER_CONFIG'; nodeId: string; fieldName: string; value?: NumenValue }
  | { type: 'SET_EXTENSION_INPUT'; nodeId: string; fieldName: string; expression?: ValueExpr }
  | { type: 'SET_CAPABILITY_INPUT'; nodeId: string; fieldName: string; expression?: ValueExpr }
  | { type: 'SET_CONTROL_EXPRESSION'; nodeId: string; field: 'condition' | 'items'; expression: ValueExpr }
  | { type: 'SET_WAIT_EXPRESSION'; nodeId: string; field: 'durationMs' | 'until'; expression: ValueExpr }

export interface AutomationSourceCommandResult {
  source: AutomationSource
  selectedNodeId?: string | undefined
}

function collectControlIds(source: AutomationSource): Set<string> {
  const ids = new Set(source.triggers.map(trigger => trigger.id))
  const visit = (control: ControlSource): void => {
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

function appendControl(source: AutomationSource, control: ControlSource, ids: Set<string>): AutomationSource {
  if (source.flow.type === 'block') {
    return {
      ...source,
      flow: { ...source.flow, steps: [...source.flow.steps, control] },
    }
  }
  return {
    ...source,
    flow: {
      type: 'block',
      id: availableId(ids, 'flow'),
      steps: [source.flow, control],
    },
  }
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

function insertItem(source: AutomationSource, item: WorkbenchAutomationInsertItem): AutomationSourceCommandResult {
  const ids = collectControlIds(source)
  if (item.kind === 'trigger') {
    const config = Object.fromEntries(item.inputFields.flatMap(field => (
      field.defaultValue === undefined ? [] : [[field.name, structuredClone(field.defaultValue)]]
    )))
    const trigger: TriggerSource = {
      id: availableId(ids, 'trigger'),
      capability: item.capability,
      config,
    }
    return { source: { ...source, triggers: [...source.triggers, trigger] }, selectedNodeId: trigger.id }
  }
  const control = createInsertControl(item, ids)
  return {
    source: appendControl(source, control, ids),
    selectedNodeId: control.id,
  }
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
    canDelete: triggerIndex >= 0 || !!position || (source.flow.type !== 'block' && source.flow.id === nodeId),
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
      selectedNodeId: triggers[triggerIndex]?.id ?? triggers[triggerIndex - 1]?.id,
    }
  }
  const position = sequencePosition(source, nodeId)
  if (!position) {
    if (!direction && source.flow.id === nodeId && source.flow.type !== 'block') {
      return { source: { ...source, flow: { type: 'block', id: source.flow.id, steps: [] } }, selectedNodeId: undefined }
    }
    return { source }
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
  return { source: { ...source, flow: result.control }, selectedNodeId }
}

/** Applies one structured edit while preserving AutomationSource as the sole semantic truth. */
export function applyAutomationSourceCommand(
  source: AutomationSource,
  command: AutomationSourceCommand,
): AutomationSourceCommandResult {
  switch (command.type) {
    case 'SET_AUTOMATION_INPUTS': {
      const { inputs: _inputs, ...rest } = source
      return { source: command.inputs === undefined ? rest : { ...rest, inputs: structuredClone(command.inputs) } }
    }
    case 'DELETE_STEP': return editSequence(source, command.nodeId)
    case 'MOVE_STEP': return editSequence(source, command.nodeId, command.direction)
    case 'INSERT': return insertItem(source, command.item)
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
}

export function findAutomationControl(source: AutomationSource, nodeId: string): ControlSource | undefined {
  let found: ControlSource | undefined
  const visit = (control: ControlSource): void => {
    if (found) return
    if (control.id === nodeId) {
      found = control
      return
    }
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
      default:
        break
    }
  }
  visit(source.flow)
  return found
}

export function findAutomationTrigger(source: AutomationSource, nodeId: string): TriggerSource | undefined {
  return source.triggers.find(trigger => trigger.id === nodeId)
}

export function automationSourceHasNode(source: AutomationSource, nodeId: string | undefined): boolean {
  return !!nodeId && (
    source.triggers.some(trigger => trigger.id === nodeId)
    || !!findAutomationControl(source, nodeId)
  )
}
