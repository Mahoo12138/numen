import type { AutomationSource, BlockSource, ControlSource, ValueExpr } from '@numen/core'
import type { WorkbenchAutomationInsertItem } from './contracts.js'

export type AutomationSourceCommand =
  | { type: 'INSERT'; item: WorkbenchAutomationInsertItem }
  | { type: 'SET_CAPABILITY_CONNECTION'; nodeId: string; slotName: string; connectionId?: string }
  | { type: 'SET_CAPABILITY_INPUT'; nodeId: string; fieldName: string; expression?: ValueExpr }
  | { type: 'SET_WAIT_DURATION'; nodeId: string; durationMs: number }

export interface AutomationSourceCommandResult {
  source: AutomationSource
  selectedNodeId?: string
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
  item: WorkbenchAutomationInsertItem,
  ids: Set<string>,
): ControlSource {
  if (item.kind === 'capability') {
    const input = Object.fromEntries((item.inputFields ?? []).flatMap(field => (
      'defaultValue' in field
        ? [[field.name, { type: 'literal' as const, value: field.defaultValue! }]]
        : []
    )))
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

function setWaitDuration(source: AutomationSource, nodeId: string, durationMs: number): AutomationSource {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new TypeError('Wait duration must be a non-negative whole number of milliseconds.')
  }
  const result = editControl(source.flow, nodeId, control => {
    if (control.type !== 'wait') return control
    if (control.durationMs?.type === 'literal' && control.durationMs.value === durationMs && !control.until) return control
    return {
      type: 'wait',
      id: control.id,
      durationMs: { type: 'literal', value: durationMs },
    }
  })
  return result.changed ? { ...source, flow: result.control } : source
}

function setCapabilityInput(
  source: AutomationSource,
  nodeId: string,
  fieldName: string,
  expression: ValueExpr | undefined,
): AutomationSource {
  if (!fieldName) throw new TypeError('Capability input field name is required.')
  const result = editControl(source.flow, nodeId, control => {
    if (control.type !== 'capability') return control
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
  const result = editControl(source.flow, nodeId, control => {
    if (control.type !== 'capability') return control
    const connections = {
      ...(control.connection ? { [slotName]: control.connection } : {}),
      ...control.connections,
    }
    if (connectionId === undefined) delete connections[slotName]
    else connections[slotName] = connectionId
    const { connection: _legacy, connections: _current, ...rest } = control
    if (!Object.keys(connections).length) return control.connection || control.connections ? rest : control
    if (!control.connection && JSON.stringify(control.connections) === JSON.stringify(connections)) return control
    return { ...rest, connections }
  })
  return result.changed ? { ...source, flow: result.control } : source
}

/** Applies one structured edit while preserving AutomationSource as the sole semantic truth. */
export function applyAutomationSourceCommand(
  source: AutomationSource,
  command: AutomationSourceCommand,
): AutomationSourceCommandResult {
  switch (command.type) {
    case 'INSERT': return insertItem(source, command.item)
    case 'SET_CAPABILITY_CONNECTION': return {
      source: setCapabilityConnection(source, command.nodeId, command.slotName, command.connectionId),
    }
    case 'SET_CAPABILITY_INPUT': return {
      source: setCapabilityInput(source, command.nodeId, command.fieldName, command.expression),
    }
    case 'SET_WAIT_DURATION': return { source: setWaitDuration(source, command.nodeId, command.durationMs) }
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

export function automationSourceHasNode(source: AutomationSource, nodeId: string | undefined): boolean {
  return !!nodeId && (
    source.triggers.some(trigger => trigger.id === nodeId)
    || !!findAutomationControl(source, nodeId)
  )
}
