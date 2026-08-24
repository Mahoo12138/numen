import type { AutomationSource, CompileDiagnostic, ControlSource, ValueExpr } from '@numen/core'
import { Boxes, Clock3, GitBranch, Network, Play, Radio, Repeat2, Zap } from '@lucide/vue'
import type { AutomationStep } from './model.js'

function humanize(identifier: string, fallback: string): string {
  const localName = identifier.split(/[.:/]/).at(-1) ?? identifier
  const words = localName.replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : fallback
}

function describeExpression(expression: ValueExpr): string {
  switch (expression.type) {
    case 'literal': {
      const value = JSON.stringify(expression.value)
      return value.length > 44 ? `${value.slice(0, 41)}…` : value
    }
    case 'ref': return expression.path
    case 'template': return 'Template expression'
    case 'array': return `${expression.items.length} item array`
    case 'object': return `${Object.keys(expression.entries).length} field object`
    case 'call': return `${expression.function}(…)`
  }
}

function describeConnections(source: { connection?: string; connections?: Record<string, string> }): string {
  if (!source.connections && source.connection) return ` · ${source.connection}`
  const connections = source.connections ?? {}
  const bindings = Object.entries(connections)
  if (!bindings.length) return ''
  return ` · ${bindings.map(([slot, connectionId]) => `${slot}: ${connectionId}`).join(', ')}`
}

function step(
  sourceId: string,
  kind: string,
  label: string,
  summary: string,
  icon: AutomationStep['icon'],
  depth: number,
): AutomationStep {
  return {
    id: `source:${sourceId}`,
    sourceId,
    kind,
    label,
    summary,
    icon,
    tone: kind === 'capability' ? 'accent' : 'neutral',
    depth,
  }
}

function projectControl(
  source: ControlSource,
  depth: number,
  output: AutomationStep[],
  capabilityTitles: ReadonlyMap<string, string>,
): void {
  switch (source.type) {
    case 'block':
      output.push(step(
        source.id,
        'block',
        humanize(source.id, 'Block'),
        `${source.steps.length} step${source.steps.length === 1 ? '' : 's'}`,
        Boxes,
        depth,
      ))
      for (const child of source.steps) projectControl(child, depth + 1, output, capabilityTitles)
      break
    case 'capability':
      output.push(step(
        source.id,
        'capability',
        capabilityTitles.get(`${source.capability.id}@${source.capability.version}`) ?? humanize(source.id, 'Capability'),
        `Capability · ${source.capability.id}@${source.capability.version}${describeConnections(source)}`,
        Zap,
        depth,
      ))
      break
    case 'wait':
      output.push(step(
        source.id,
        'wait',
        humanize(source.id, 'Wait'),
        `Wait · ${source.durationMs ? describeExpression(source.durationMs) : source.until ? `until ${describeExpression(source.until)}` : 'no duration configured'}`,
        Clock3,
        depth,
      ))
      break
    case 'if':
      output.push(step(source.id, 'if', humanize(source.id, 'Condition'), `If · ${describeExpression(source.condition)}`, GitBranch, depth))
      projectControl(source.then, depth + 1, output, capabilityTitles)
      if (source.else) projectControl(source.else, depth + 1, output, capabilityTitles)
      break
    case 'parallel':
      output.push(step(source.id, 'parallel', humanize(source.id, 'Parallel'), `${source.branches.length} parallel branches`, Network, depth))
      for (const branch of source.branches) projectControl(branch, depth + 1, output, capabilityTitles)
      break
    case 'race':
      output.push(step(source.id, 'race', humanize(source.id, 'Race'), `${source.branches.length} first-success branches`, Play, depth))
      for (const branch of source.branches) projectControl(branch, depth + 1, output, capabilityTitles)
      break
    case 'foreach':
      output.push(step(
        source.id,
        'foreach',
        humanize(source.id, 'For each'),
        `For each · concurrency ${source.concurrency ?? 1} · ${describeExpression(source.items)}`,
        Repeat2,
        depth,
      ))
      projectControl(source.body, depth + 1, output, capabilityTitles)
      break
  }
}

/** A read-only Canvas projection. AutomationSource remains the sole authoring truth. */
export function projectAutomationSteps(
  source: AutomationSource,
  diagnostics: CompileDiagnostic[] = [],
  capabilityTitles: ReadonlyMap<string, string> = new Map(),
): AutomationStep[] {
  const output = source.triggers.map<AutomationStep>(trigger => ({
    id: `trigger:${trigger.id}`,
    sourceId: trigger.id,
    kind: 'trigger',
    label: humanize(trigger.id, 'Trigger'),
    summary: `Trigger · ${trigger.capability.id}@${trigger.capability.version}${describeConnections(trigger)}`,
    icon: Radio,
    tone: 'neutral',
    depth: 0,
  }))
  if (source.flow.type === 'block') {
    for (const child of source.flow.steps) projectControl(child, 0, output, capabilityTitles)
  } else {
    projectControl(source.flow, 0, output, capabilityTitles)
  }
  if (!diagnostics.length) return output
  const problemCounts = new Map<string, number>()
  for (const diagnostic of diagnostics) {
    const nodeId = diagnostic.source?.nodeId
    if (nodeId) problemCounts.set(nodeId, (problemCounts.get(nodeId) ?? 0) + 1)
  }
  return output.map(item => {
    const problemCount = item.sourceId ? problemCounts.get(item.sourceId) : undefined
    return problemCount ? { ...item, problemCount } : item
  })
}
