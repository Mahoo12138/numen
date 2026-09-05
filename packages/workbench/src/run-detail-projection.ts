import {
  capabilityKey,
  type AutomationRevision,
  type ControlSource,
  type NumenValue,
  type Run,
} from '@numen/core'
import type {
  RunEventPage,
  RunExecutionDiagnosticsPage,
  RunInspection,
  RunInstructionExecutionSummary,
} from '@numen/scheduler'
import type {
  WorkbenchRunContextGroup,
  WorkbenchRunDetail,
  WorkbenchRunExecution,
  WorkbenchRunFlowNode,
  WorkbenchRunFlowStatus,
  WorkbenchRunTimelineEvent,
} from './contracts.js'

export function projectWorkbenchRunDetail(
  run: Run,
  automationName: string,
  revision: AutomationRevision | undefined,
  inspection: RunInspection,
  diagnostics: RunExecutionDiagnosticsPage,
  events: RunEventPage,
  encodeExecutionCursor: (cursor: NonNullable<RunExecutionDiagnosticsPage['nextCursor']>) => string,
): WorkbenchRunDetail {
  const capabilityTitles = new Map(
    (revision?.contractSnapshot.capabilities ?? []).map(capability => [capabilityKey(capability), capability.title]),
  )
  const instructions = revision?.compiledPlan.instructions ?? {}
  const flow = projectRunFlow(revision, inspection.instructionExecutions)
  const counts = diagnostics.statusCounts
  return {
    run: {
      id: run.id,
      automationId: run.automationId,
      automationName,
      revisionId: run.revisionId,
      ...(revision ? { revisionNumber: revision.number } : {}),
      status: run.status,
      ...(run.groupKey ? { groupKey: run.groupKey } : {}),
      ...(run.cancelReason ? { cancelReason: run.cancelReason } : {}),
      createdAt: run.createdAt,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    },
    executionSummary: {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      attempts: diagnostics.attemptCount,
      runnable: counts.RUNNABLE,
      running: counts.RUNNING,
      waiting: counts.WAITING,
      blocked: counts.BLOCKED,
      completed: counts.COMPLETED,
      failed: counts.FAILED,
      cancelling: counts.CANCELLING,
      cancelled: counts.CANCELLED,
      timedOut: counts.TIMED_OUT,
    },
    flow,
    context: projectRunContext(inspection.context),
    executions: diagnostics.items.map(({ execution, attempts }): WorkbenchRunExecution => {
      const instruction = instructions[execution.instructionId]
      return {
        id: execution.id,
        instructionId: execution.instructionId,
        title: instructionTitle(instruction, execution.instructionId, capabilityTitles),
        operation: instruction?.op ?? 'unknown',
        status: execution.status,
        ...(execution.parentExecutionId ? { parentExecutionId: execution.parentExecutionId } : {}),
        ...(execution.scopeExecutionId ? { scopeExecutionId: execution.scopeExecutionId } : {}),
        ...(execution.scopeBranch === undefined ? {} : { scopeBranch: execution.scopeBranch }),
        ...(execution.loopIndex === undefined ? {} : { loopIndex: execution.loopIndex }),
        ...(execution.blockedReason ? { blockedReason: execution.blockedReason } : {}),
        generation: execution.generation,
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt,
        attempts: attempts.map(attempt => {
          const summary = errorSummary(attempt.error)
          return {
            id: attempt.id,
            number: attempt.number,
            status: attempt.status,
            providerRef: attempt.providerRef,
            ...(summary ? { errorSummary: summary } : {}),
            startedAt: attempt.startedAt,
            ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
          }
        }),
      }
    }),
    ...(diagnostics.nextCursor ? { nextExecutionCursor: encodeExecutionCursor(diagnostics.nextCursor) } : {}),
    timeline: {
      total: events.total,
      items: events.items.map(projectRunEvent),
      ...(events.nextCursor ? { nextCursor: events.nextCursor } : {}),
    },
  }
}

const flowStatusPriority: WorkbenchRunFlowStatus[] = [
  'FAILED', 'CANCELLING', 'RUNNING', 'BLOCKED', 'WAITING', 'CANCELLED', 'QUEUED', 'COMPLETED', 'IDLE',
]

function projectRunFlow(
  revision: AutomationRevision | undefined,
  summaries: RunInstructionExecutionSummary[],
): WorkbenchRunDetail['flow'] {
  if (!revision) {
    return {
      root: {
        id: '__missing-revision',
        type: 'block',
        title: 'Flow unavailable',
        detail: 'The immutable Revision is no longer available.',
        status: 'IDLE',
        executionCount: 0,
        children: [],
      },
      truncated: false,
    }
  }
  const capabilityTitles = new Map(
    revision.contractSnapshot.capabilities.map(capability => [capabilityKey(capability), capability.title]),
  )
  for (const control of revision.contractSnapshot.controls ?? []) capabilityTitles.set(`control:${control.id}@${control.version}`, control.title)
  const byInstruction = new Map<string, RunInstructionExecutionSummary>()
  for (const summary of summaries) {
    const id = revision.compiledPlan.sourceMap?.[summary.instructionId]?.nodeId ?? summary.instructionId
    const existing = byInstruction.get(id)
    if (!existing) byInstruction.set(id, { ...summary, instructionId: id, statusCounts: { ...summary.statusCounts } })
    else {
      for (const status of Object.keys(summary.statusCounts) as Array<keyof typeof summary.statusCounts>) existing.statusCounts[status] += summary.statusCounts[status]
      if (summary.latestUpdatedAt > existing.latestUpdatedAt) existing.latestUpdatedAt = summary.latestUpdatedAt
    }
  }
  const budget = { remaining: 250, truncated: false }
  const source = projectFlowNode(revision.source.flow, byInstruction, capabilityTitles, budget)!
  const root: WorkbenchRunFlowNode = {
    id: '__flow',
    type: 'block',
    title: 'Flow',
    detail: `Revision ${revision.number} · IR ${revision.irVersion}`,
    status: source.status,
    executionCount: source.executionCount,
    children: [source],
  }
  return { root, truncated: budget.truncated }
}

function projectFlowNode(
  control: ControlSource,
  summaries: ReadonlyMap<string, RunInstructionExecutionSummary>,
  capabilityTitles: ReadonlyMap<string, string>,
  budget: { remaining: number; truncated: boolean },
  label?: string,
): WorkbenchRunFlowNode | undefined {
  if (budget.remaining <= 0) {
    budget.truncated = true
    return
  }
  budget.remaining -= 1
  const children: WorkbenchRunFlowNode[] = []
  const append = (child: ControlSource, childLabel?: string) => {
    const projected = projectFlowNode(child, summaries, capabilityTitles, budget, childLabel)
    if (projected) children.push(projected)
  }
  switch (control.type) {
    case 'block':
      for (const child of control.steps) append(child)
      break
    case 'if':
      append(control.then, 'Then')
      if (control.else) append(control.else, 'Else')
      break
    case 'parallel':
    case 'race':
      control.branches.forEach((branch, index) => append(branch, `Branch ${index + 1}`))
      break
    case 'foreach':
      append(control.body, 'Iteration')
      break
  }
  const summary = summaries.get(control.id)
  const directStatus = summary ? flowStatusFromSummary(summary) : 'IDLE'
  const status = highestFlowStatus([directStatus, ...children.map(child => child.status)])
  return {
    id: control.id,
    type: control.type,
    title: label ?? flowNodeTitle(control, capabilityTitles),
    detail: flowNodeDetail(control),
    status,
    executionCount: totalExecutions(summary) + children.reduce((total, child) => total + child.executionCount, 0),
    children,
  }
}

function flowNodeTitle(control: ControlSource, capabilityTitles: ReadonlyMap<string, string>): string {
  switch (control.type) {
    case 'block': return 'Sequence'
    case 'extension': return capabilityTitles.get(`control:${control.control.id}@${control.control.version}`) ?? control.control.id
    case 'capability': return capabilityTitles.get(capabilityKey(control.capability)) ?? control.capability.id
    case 'if': return 'Condition'
    case 'wait': return 'Wait'
    case 'parallel': return 'Parallel'
    case 'race': return 'Race'
    case 'foreach': return 'For each'
  }
}

function flowNodeDetail(control: ControlSource): string {
  switch (control.type) {
    case 'block': return `${control.steps.length} ${control.steps.length === 1 ? 'step' : 'steps'}`
    case 'extension': return `${control.control.id}@${control.control.version}`
    case 'capability': return `${capabilityKey(control.capability)} · ${Object.keys(control.connections ?? {}).length} connection bindings`
    case 'if': return control.else ? 'Then / Else' : 'Then branch'
    case 'wait': return control.until ? 'Until expression' : 'Duration expression'
    case 'parallel': return `${control.branches.length} branches · wait for all`
    case 'race': return `${control.branches.length} branches · first success`
    case 'foreach': return `Concurrency ${control.concurrency ?? 1}`
  }
}

function flowStatusFromSummary(summary: RunInstructionExecutionSummary): WorkbenchRunFlowStatus {
  const counts = summary.statusCounts
  if (counts.FAILED || counts.TIMED_OUT) return 'FAILED'
  if (counts.CANCELLING) return 'CANCELLING'
  if (counts.RUNNING) return 'RUNNING'
  if (counts.BLOCKED) return 'BLOCKED'
  if (counts.WAITING) return 'WAITING'
  if (counts.CANCELLED) return 'CANCELLED'
  if (counts.RUNNABLE) return 'QUEUED'
  if (counts.COMPLETED) return 'COMPLETED'
  return 'IDLE'
}

function highestFlowStatus(statuses: WorkbenchRunFlowStatus[]): WorkbenchRunFlowStatus {
  return flowStatusPriority.find(status => statuses.includes(status)) ?? 'IDLE'
}

function totalExecutions(summary: RunInstructionExecutionSummary | undefined): number {
  return summary ? Object.values(summary.statusCounts).reduce((total, count) => total + count, 0) : 0
}

const sensitiveContextKey = /(?:^|[-_])(authorization|cookie|credential|password|secret|token)(?:$|[-_])/i

function projectRunContext(context: RunInspection['context']): WorkbenchRunContextGroup[] {
  const names: WorkbenchRunContextGroup['name'][] = ['run', 'trigger', 'input', 'steps', 'vars', 'loop', 'error']
  return names.map(name => {
    const state = { remaining: 160, truncated: false }
    return {
      name,
      value: projectContextValue(context[name], state, 0, name === 'run'),
      truncated: state.truncated,
    }
  })
}

function projectContextValue(
  value: NumenValue,
  state: { remaining: number; truncated: boolean },
  depth: number,
  revealScalars: boolean,
): NumenValue {
  if (state.remaining <= 0 || depth > 6) {
    state.truncated = true
    return '[Truncated]'
  }
  state.remaining -= 1
  if (typeof value === 'string') {
    if (!revealScalars) return `[string · ${value.length} chars]`
    if (value.length <= 1_000) return value
    state.truncated = true
    return `${value.slice(0, 1_000)}…`
  }
  if (value === null) return null
  if (typeof value !== 'object') return revealScalars ? value : `[${typeof value}]`
  if (Array.isArray(value)) {
    if (value.length > 30) state.truncated = true
    return value.slice(0, 30).map(item => projectContextValue(item, state, depth + 1, revealScalars))
  }
  const entries = Object.entries(value)
  if (entries.length > 30) state.truncated = true
  return Object.fromEntries(entries.slice(0, 30).map(([key, item]) => [
    key,
    sensitiveContextKey.test(key) ? '[Redacted]' : projectContextValue(item, state, depth + 1, revealScalars),
  ]))
}

function instructionTitle(
  instruction: AutomationRevision['compiledPlan']['instructions'][string] | undefined,
  instructionId: string,
  capabilityTitles: ReadonlyMap<string, string>,
): string {
  if (!instruction) return instructionId.startsWith('__') ? 'Runtime control' : instructionId
  switch (instruction.op) {
    case 'invoke': return capabilityTitles.get(capabilityKey(instruction.capability)) ?? instruction.capability.id
    case 'branch': return 'Condition'
    case 'suspend': return instruction.source === 'timer' ? 'Wait' : 'Suspension'
    case 'fork': return instruction.mode === 'all' ? 'Parallel branches' : 'Race branches'
    case 'iterate': return 'For each'
    case 'join': return instruction.mode === 'iterate' ? 'Iteration join' : 'Branch join'
    case 'scope_complete': return 'Scope complete'
    case 'complete': return 'Run complete'
    case 'fail': return 'Run failure'
    case 'eval': return `Set ${instruction.assign}`
  }
}

function projectRunEvent(event: RunEventPage['items'][number]): WorkbenchRunTimelineEvent {
  const payload = recordValue(event.payload)
  const executionId = stringValue(payload?.executionId)
  const attemptId = stringValue(payload?.attemptId)
  const detail = eventDetail(event.type, payload)
  return {
    sequence: event.sequence,
    type: event.type,
    title: humanizeEventType(event.type),
    ...(detail ? { detail } : {}),
    ...(executionId ? { executionId } : {}),
    ...(attemptId ? { attemptId } : {}),
    occurredAt: event.occurredAt,
  }
}

function eventDetail(type: string, payload: Record<string, NumenValue> | undefined): string | undefined {
  if (!payload) return
  const error = errorSummary(payload.error)
  if (error) return error
  const reason = stringValue(payload.reason)
  if (reason) return `Reason: ${humanizeToken(reason)}`
  const wakeAt = stringValue(payload.wakeAt)
  if (wakeAt) return `Wake at ${wakeAt}`
  const number = numberValue(payload.number)
  if (type === 'AttemptStarted' && number !== undefined) return `Attempt ${number}`
  const mode = stringValue(payload.mode)
  if (mode) return `Mode: ${humanizeToken(mode)}`
  const instructionId = stringValue(payload.instructionId)
  if (instructionId) return `Instruction ${instructionId}`
  const revisionId = stringValue(payload.revisionId)
  if (revisionId) return `Revision ${revisionId}`
  const source = stringValue(payload.source)
  if (source) return `Source: ${humanizeToken(source)}`
  return
}

function errorSummary(value: NumenValue | undefined): string | undefined {
  if (typeof value === 'string') return value
  const record = recordValue(value)
  const message = stringValue(record?.message)
  const name = stringValue(record?.name)
  if (message && name && name !== 'Error') return `${name}: ${message}`
  return message ?? name
}

function recordValue(value: NumenValue | undefined): Record<string, NumenValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, NumenValue>
    : undefined
}

function stringValue(value: NumenValue | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: NumenValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function humanizeEventType(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

function humanizeToken(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^./, first => first.toUpperCase())
}
