import { interpolate, type MessageParams } from '@numenjs/i18n'
import { enUS } from './locales/en-US.js'
import type { AutomationSource, CompileDiagnostic, ControlSource, ValueExpr } from '@numenjs/core'
import { Boxes, Clock3, GitBranch, Network, Play, Radio, Repeat2, Zap } from '@lucide/vue'
import type { AutomationStep } from './model.js'

function humanize(identifier: string, fallback: string): string {
  const localName = identifier.split(/[.:/]/).at(-1) ?? identifier
  const words = localName.replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : fallback
}

type Translate = (key: string, params?: MessageParams) => string
const english: Translate = (key, params) => interpolate((enUS as Record<string, string>)[key] ?? key, params)

function describeExpression(expression: ValueExpr, t: Translate): string {
  switch (expression.type) {
    case 'literal': {
      const value = JSON.stringify(expression.value)
      return value.length > 44 ? `${value.slice(0, 41)}…` : value
    }
    case 'ref': return expression.path
    case 'template': return t('workbench.projection.template')
    case 'array': return t('workbench.projection.array', { count: expression.items.length })
    case 'object': return t('workbench.projection.object', { count: Object.keys(expression.entries).length })
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
  t: Translate,
): void {
  switch (source.type) {
    case 'block':
      output.push(step(
        source.id,
        'block',
        humanize(source.id, 'Block'),
        t(`workbench.projection.block.${source.steps.length === 1 ? 'one' : 'other'}`, { count: source.steps.length }),
        Boxes,
        depth,
      ))
      for (const child of source.steps) projectControl(child, depth + 1, output, capabilityTitles, t)
      break
    case 'extension':
      output.push(step(source.id, 'extension', capabilityTitles.get(`control:${source.control.id}@${source.control.version}`) ?? t('workbench.projection.unknownControl'), `${t('workbench.projection.control')} · ${source.control.id}@${source.control.version}`, Boxes, depth))
      break
    case 'capability':
      output.push(step(
        source.id,
        'capability',
        capabilityTitles.get(`${source.capability.id}@${source.capability.version}`) ?? humanize(source.id, 'Capability'),
        `${t('workbench.projection.capability')} · ${source.capability.id}@${source.capability.version}${describeConnections(source)}`,
        Zap,
        depth,
      ))
      break
    case 'wait':
      output.push(step(
        source.id,
        'wait',
        humanize(source.id, 'Wait'),
        `${t('workbench.projection.wait')} · ${source.durationMs ? describeExpression(source.durationMs, t) : source.until ? t('workbench.projection.until', { value: describeExpression(source.until, t) }) : t('workbench.projection.noDuration')}`,
        Clock3,
        depth,
      ))
      break
    case 'if':
      output.push(step(source.id, 'if', humanize(source.id, 'Condition'), `${t('workbench.projection.if')} · ${describeExpression(source.condition, t)}`, GitBranch, depth))
      projectControl(source.then, depth + 1, output, capabilityTitles, t)
      if (source.else) projectControl(source.else, depth + 1, output, capabilityTitles, t)
      break
    case 'parallel':
      output.push(step(source.id, 'parallel', humanize(source.id, 'Parallel'), t('workbench.projection.parallel', { count: source.branches.length }), Network, depth))
      for (const branch of source.branches) projectControl(branch, depth + 1, output, capabilityTitles, t)
      break
    case 'race':
      output.push(step(source.id, 'race', humanize(source.id, 'Race'), t('workbench.projection.race', { count: source.branches.length }), Play, depth))
      for (const branch of source.branches) projectControl(branch, depth + 1, output, capabilityTitles, t)
      break
    case 'foreach':
      output.push(step(
        source.id,
        'foreach',
        humanize(source.id, 'For each'),
        t('workbench.projection.foreach', { count: source.concurrency ?? 1, value: describeExpression(source.items, t) }),
        Repeat2,
        depth,
      ))
      projectControl(source.body, depth + 1, output, capabilityTitles, t)
      break
  }
}

/** A read-only Canvas projection. AutomationSource remains the sole authoring truth. */
export function projectAutomationSteps(
  source: AutomationSource,
  diagnostics: CompileDiagnostic[] = [],
  capabilityTitles: ReadonlyMap<string, string> = new Map(),
  t: Translate = english,
): AutomationStep[] {
  const output = source.triggers.map<AutomationStep>(trigger => ({
    id: `trigger:${trigger.id}`,
    sourceId: trigger.id,
    kind: 'trigger',
    label: capabilityTitles.get(`${trigger.capability.id}@${trigger.capability.version}`) ?? humanize(trigger.id, 'Trigger'),
    summary: `${t('workbench.projection.trigger')} · ${trigger.capability.id}@${trigger.capability.version}${describeConnections(trigger)}`,
    icon: Radio,
    tone: 'neutral',
    depth: 0,
  }))
  if (source.flow.type === 'block') {
    for (const child of source.flow.steps) projectControl(child, 0, output, capabilityTitles, t)
  } else {
    projectControl(source.flow, 0, output, capabilityTitles, t)
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
