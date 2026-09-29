import type { AutomationSource, ControlSource, ValueExpr } from '@numenjs/core'

// Keep this grammar aligned with the compiler and scheduler's dot-segment evaluator.
const referencePattern = /^(run|trigger|input|steps|vars|loop|error)(\.[a-zA-Z0-9_$-]+)+$/

function visitControls(control: ControlSource, visit: (node: ControlSource) => void): void {
  visit(control)
  switch (control.type) {
    case 'block': control.steps.forEach(child => visitControls(child, visit)); break
    case 'if': visitControls(control.then, visit); if (control.else) visitControls(control.else, visit); break
    case 'foreach': visitControls(control.body, visit); break
    case 'parallel': case 'race': control.branches.forEach(child => visitControls(child, visit)); break
  }
}

/** Visit only authored ValueExpr locations, never strings or objects inside literal values. */
function mapExpressions(control: ControlSource, map: (value: ValueExpr) => ValueExpr): void {
  const record = (values: Record<string, ValueExpr>) => Object.fromEntries(Object.entries(values).map(([name, value]) => [name, map(value)]))
  visitControls(control, node => {
    switch (node.type) {
      case 'capability': node.input = record(node.input); break
      case 'block': if (node.output) node.output = record(node.output); break
      case 'if': node.condition = map(node.condition); break
      case 'foreach': node.items = map(node.items); break
      case 'wait':
        if (node.until) node.until = map(node.until)
        if (node.durationMs) node.durationMs = map(node.durationMs)
        break
      case 'parallel': case 'race': break
      // Extensions can carry opaque semantics. Their copy is disabled until a safe contract exists.
      default: throw new Error('Copy is unavailable for unknown or extension controls because their reference semantics cannot be verified.')
    }
  })
}

function mapExpression(expression: ValueExpr, mapPath: (path: string) => string): ValueExpr {
  if (!expression || typeof expression !== 'object') throw new Error('Copy is unavailable for an unrecognized expression.')
  switch (expression.type) {
    case 'literal': return expression
    case 'ref': return { ...expression, path: mapPath(expression.path) }
    case 'template': return { ...expression, parts: expression.parts.map(part => typeof part === 'string' ? part : { ...part, ref: mapPath(part.ref) }) }
    case 'array': return { ...expression, items: expression.items.map(item => mapExpression(item, mapPath)) }
    case 'object': return { ...expression, entries: Object.fromEntries(Object.entries(expression.entries).map(([name, value]) => [name, mapExpression(value, mapPath)])) }
    case 'call': return { ...expression, arguments: expression.arguments.map(item => mapExpression(item, mapPath)) }
    default: throw new Error('Copy is unavailable for an unrecognized expression.')
  }
}

function validateCopy(control: ControlSource, source: AutomationSource): void {
  const seen = new Set<string>()
  const declarations: string[] = []
  const declare = (id: string) => {
    if (seen.has(id)) throw new Error(`Copy is unavailable because node ID ${id} is duplicated.`)
    seen.add(id)
    declarations.push(id)
  }
  source.triggers.forEach(trigger => declare(trigger.id))
  visitControls(source.flow, node => declare(node.id))
  visitControls(control, node => {
    if (!node.id || node.id.includes('.')) throw new Error('Copy is unavailable for dotted or empty node IDs.')
  })
  const dottedIds = declarations.filter(id => id.includes('.'))
  // This validation works on a clone because expression mapping deliberately edits only that clone.
  mapExpressions(structuredClone(control), expression => mapExpression(expression, path => {
    if (typeof path !== 'string' || !referencePattern.test(path)) throw new Error(`Copy is unavailable for an unrecognized reference: ${String(path)}.`)
    if (path.startsWith('steps.') && dottedIds.some(id => path === `steps.${id}` || path.startsWith(`steps.${id}.`))) {
      throw new Error(`Copy is unavailable for an ambiguous reference to a dotted node ID: ${path}.`)
    }
    return path
  }))
}

export function controlCopyError(control: ControlSource, source: AutomationSource): string | undefined {
  try { validateCopy(control, source) } catch (error) { return error instanceof Error ? error.message : 'Copy is unavailable for this source.' }
}

/** Allocate every ID first, so forward and nested references use the same complete mapping. */
export function copyAutomationControl(
  control: ControlSource,
  source: AutomationSource,
  allocate: (oldId: string) => string,
): { control: ControlSource; idMap: Record<string, string> } {
  validateCopy(control, source)
  const entries: Array<[string, string]> = []
  visitControls(control, node => entries.push([node.id, allocate(node.id)]))
  const idMap = Object.fromEntries(entries)
  const copy = structuredClone(control)
  visitControls(copy, node => { node.id = idMap[node.id]! })
  mapExpressions(copy, expression => mapExpression(expression, path => {
    const [root, id, ...tail] = path.split('.')
    if (root !== 'steps' || !id || !Object.hasOwn(idMap, id)) return path
    return ['steps', idMap[id], ...tail].join('.')
  }))
  return { control: copy, idMap }
}
