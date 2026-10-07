import {
  isResourceRef,
  type AutomationSource,
  type ControlSource,
  type CorePlan,
  type NumenValue,
  type ValueExpr,
} from '@numenjs/core'

/** Acceptance bounds apply before hashing or retaining any reference. Never truncate. */
export const draftTestAcceptanceLimits = {
  maxDepth: 64,
  maxValues: 100_000,
  maxResources: 1_000,
  maxRequestBytes: 1024 * 1024,
  maxSnapshotBytes: 8 * 1024 * 1024,
} as const

export function assertDraftTestRequestValues(input: unknown, trigger: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('run input must be a Numen object')
  const collector = new ResourceReferenceCollector()
  collector.value(input)
  collector.value(trigger)
  if (Buffer.byteLength(JSON.stringify({ input, trigger }), 'utf8') > draftTestAcceptanceLimits.maxRequestBytes) {
    throw new TypeError('draft test input and trigger exceed the acceptance size limit')
  }
}

class ResourceReferenceCollector {
  readonly ids = new Set<string>()
  private values = 0

  private count(depth: number): void {
    if (++this.values > draftTestAcceptanceLimits.maxValues || depth > draftTestAcceptanceLimits.maxDepth) {
      throw new TypeError('draft test data exceed the acceptance depth or value limit')
    }
  }

  value(value: unknown, depth = 0, active = new Set<object>()): void {
    this.count(depth)
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number' && Number.isFinite(value)) return
    if (!value || typeof value !== 'object' || active.has(value)) throw new TypeError('draft test data must be Numen values')
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('draft test data must be JSON objects')
    }
    if (isResourceRef(value)) {
      this.ids.add(value.$resource)
      if (this.ids.size > draftTestAcceptanceLimits.maxResources) throw new TypeError('draft test references exceed the resource limit')
      return
    }
    active.add(value)
    for (const child of Object.values(value)) this.value(child, depth + 1, active)
    active.delete(value)
  }

  expression(expression: ValueExpr | undefined, depth = 0): void {
    if (!expression) return
    this.count(depth)
    switch (expression.type) {
      case 'literal': this.value(expression.value, depth + 1); break
      case 'array': for (const item of expression.items) this.expression(item, depth + 1); break
      case 'object': for (const item of Object.values(expression.entries)) this.expression(item, depth + 1); break
      case 'call': for (const item of expression.arguments) this.expression(item, depth + 1); break
      case 'ref': case 'template': break
    }
  }

  control(control: ControlSource, depth = 0): void {
    this.count(depth)
    switch (control.type) {
      case 'capability': case 'extension':
        for (const expression of Object.values(control.input)) this.expression(expression, depth + 1)
        break
      case 'block':
        for (const child of control.steps) this.control(child, depth + 1)
        for (const expression of Object.values(control.output ?? {})) this.expression(expression, depth + 1)
        break
      case 'if':
        this.expression(control.condition, depth + 1)
        this.control(control.then, depth + 1)
        if (control.else) this.control(control.else, depth + 1)
        break
      case 'wait': this.expression(control.until, depth + 1); this.expression(control.durationMs, depth + 1); break
      case 'parallel': case 'race': for (const branch of control.branches) this.control(branch, depth + 1); break
      case 'foreach': this.expression(control.items, depth + 1); this.control(control.body, depth + 1); break
    }
  }

  source(source: AutomationSource): void {
    for (const declaration of Object.values(source.inputs ?? {})) {
      if (declaration.default !== undefined) this.value(declaration.default)
    }
    for (const trigger of source.triggers) this.value(trigger.config)
    this.expression(source.policy?.groupBy)
    this.control(source.flow)
  }

  plan(plan: CorePlan): void {
    for (const ref of plan.resources ?? []) this.value(ref)
    for (const instruction of Object.values(plan.instructions)) {
      switch (instruction.op) {
        case 'invoke': this.expression(instruction.input); break
        case 'eval': this.expression(instruction.expression); break
        case 'branch': this.expression(instruction.condition); break
        case 'suspend': this.expression(instruction.config.until); this.expression(instruction.config.durationMs); break
        case 'iterate': this.expression(instruction.items); break
        case 'complete': this.expression(instruction.output); break
        case 'fail': this.expression(instruction.error); break
        case 'fork': case 'join': case 'scope_complete': break
      }
    }
  }
}

/** Only supported Source/IR expression fields and Numen Presentation values are inspected. */
export function collectSnapshotResourceIds(snapshot: {
  source: AutomationSource
  compiledPlan: CorePlan
  presentation: Record<string, NumenValue>
}): Set<string> {
  const collector = new ResourceReferenceCollector()
  collector.source(snapshot.source)
  collector.plan(snapshot.compiledPlan)
  collector.value(snapshot.presentation)
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > draftTestAcceptanceLimits.maxSnapshotBytes) {
    throw new TypeError('draft test snapshot exceeds the acceptance size limit')
  }
  return collector.ids
}

export function collectRunResourceIds(input: Record<string, NumenValue>, trigger: NumenValue): Set<string> {
  const collector = new ResourceReferenceCollector()
  collector.value(input)
  collector.value(trigger)
  if (Buffer.byteLength(JSON.stringify({ input, trigger }), 'utf8') > draftTestAcceptanceLimits.maxRequestBytes) {
    throw new TypeError('resolved draft test input and trigger exceed the acceptance size limit')
  }
  return collector.ids
}
