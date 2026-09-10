import type { AutomationSource, CompileDiagnostic, ControlSource, CoreControlSource, SourceRef, ValueExpr } from '@numen/core'

interface Scope { parent?: Scope }
interface Declaration { control: ControlSource; scope: Scope }

/** Run only after structural validation. This checks lexical availability, not output field schemas. */
export function validateSourceReferences(
  source: AutomationSource,
  loweredControls: ReadonlyMap<string, CoreControlSource>,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = []
  const scopes = new Map<ControlSource, Scope>()
  const declarations = new Map<string, Declaration>()
  const rootScope: Scope = {}
  const index = (control: ControlSource, scope: Scope, into: Map<string, Declaration>): void => {
    scopes.set(control, scope)
    into.set(control.id, { control, scope })
    switch (control.type) {
      case 'block': {
        const childScope: Scope = { parent: scope }
        for (const child of control.steps) index(child, childScope, into)
        break
      }
      case 'if': index(control.then, scope, into); if (control.else) index(control.else, scope, into); break
      case 'parallel': case 'race': for (const branch of control.branches) index(branch, scope, into); break
      case 'foreach': index(control.body, scope, into); break
    }
  }
  index(source.flow, rootScope, declarations)
  const isAncestor = (ancestor: Scope, scope: Scope): boolean => {
    for (let current: Scope | undefined = scope; current; current = current.parent) if (current === ancestor) return true
    return false
  }
  interface Environment {
    available: ReadonlySet<string>
    scope: Scope
    inLoop: boolean
    declarations: ReadonlyMap<string, Declaration>
    authoredNodeId?: string
    admission?: boolean
  }
  const check = (path: string, location: SourceRef, env: Environment): void => {
    const report = (code: string, message: string) => diagnostics.push({
      severity: 'error', code, message,
      source: env.authoredNodeId ? { nodeId: env.authoredNodeId } : location,
    })
    if (path.startsWith('loop.')) {
      if (!env.inLoop) report('LOOP_REFERENCE_OUT_OF_SCOPE', `Reference ${path} is only available inside a ForEach body.`)
      else if (!['item', 'index'].includes(path.split('.')[1]!)) report('LOOP_REFERENCE_INVALID', `Unknown loop binding: ${path}. Use loop.item or loop.index.`)
      return
    }
    if (!path.startsWith('steps.')) return
    // Match the evaluator: the first segment selects an output key. Dotted node IDs are not path segments.
    const id = path.split('.')[1]!
    const target = env.declarations.get(id)
    if (!target) {
      const dotted = [...env.declarations.keys()].find(candidate => candidate.includes('.') && (path === `steps.${candidate}` || path.startsWith(`steps.${candidate}.`)))
      if (dotted) report('STEP_REFERENCE_UNADDRESSABLE', `Step ${dotted} has a dotted ID that cannot be addressed by ${path}.`)
      else report('STEP_REFERENCE_MISSING', `Referenced step ${id} does not exist: ${path}.`)
    } else if (env.admission) {
      report('STEP_REFERENCE_NOT_READY', `Reference ${path} is unavailable before the flow starts.`)
    } else if (target.control.type !== 'capability') {
      report('STEP_REFERENCE_NO_OUTPUT', `Step ${id} does not expose a Capability output contract.`)
    } else if (env.available.has(id)) {
      return
    } else if (!isAncestor(target.scope, env.scope)) {
      report('STEP_REFERENCE_OUT_OF_SCOPE', `Step ${id} belongs to another block or branch and is not visible here.`)
    } else {
      report('STEP_REFERENCE_NOT_READY', `Step ${id} must run earlier in this sequence; self and forward references are unavailable.`)
    }
  }
  const expression = (value: ValueExpr, nodeId: string, fieldPath: string, env: Environment): void => {
    switch (value.type) {
      case 'ref': check(value.path, { nodeId, fieldPath }, env); break
      case 'template': value.parts.forEach((part, i) => {
        if (typeof part !== 'string') check(part.ref, { nodeId, fieldPath: `${fieldPath}.parts.${i}` }, env)
      }); break
      case 'array': value.items.forEach((item, i) => expression(item, nodeId, `${fieldPath}.${i}`, env)); break
      case 'object': Object.entries(value.entries).forEach(([key, item]) => expression(item, nodeId, `${fieldPath}.${key}`, env)); break
      case 'call': value.arguments.forEach((item, i) => expression(item, nodeId, `${fieldPath}.arguments.${i}`, env)); break
    }
  }
  const visit = (control: ControlSource, inherited: Environment): void => {
    const env: Environment = { ...inherited, scope: scopes.get(control)! }
    switch (control.type) {
      case 'block': {
        const available = new Set(env.available)
        for (const child of control.steps) {
          visit(child, { ...env, available })
          if (child.type === 'capability') available.add(child.id)
        }
        break
      }
      case 'capability': case 'extension': {
        const previousErrors = diagnostics.length
        Object.entries(control.input).forEach(([key, value]) => expression(value, control.id, `input.${key}`, env))
        // Invalid authored inputs already have precise locations; avoid cascading generated errors.
        if (control.type === 'extension' && diagnostics.length === previousErrors) {
          const lowered = loweredControls.get(control.id)
          if (lowered) {
            const generatedDeclarations = new Map(env.declarations)
            index(lowered, { parent: env.scope }, generatedDeclarations)
            visit(lowered, { ...env, declarations: generatedDeclarations, authoredNodeId: control.id })
          }
        }
        break
      }
      case 'wait':
        if (control.durationMs) expression(control.durationMs, control.id, 'durationMs', env)
        if (control.until) expression(control.until, control.id, 'until', env)
        break
      case 'if':
        expression(control.condition, control.id, 'condition', env)
        visit(control.then, env)
        if (control.else) visit(control.else, env)
        break
      case 'parallel': case 'race': control.branches.forEach(branch => visit(branch, env)); break
      case 'foreach':
        expression(control.items, control.id, 'items', env)
        visit(control.body, { ...env, inLoop: true })
        break
    }
  }
  const environment: Environment = { available: new Set(), scope: rootScope, inLoop: false, declarations }
  if (source.policy?.groupBy) expression(source.policy.groupBy, '__policy', 'policy.groupBy', { ...environment, admission: true })
  visit(source.flow, environment)
  return diagnostics
}
