import {
  capabilityKey,
  isSupportedAutomationVersion,
  type AutomationExecutionSnapshot,
  type ControlSource,
  type GraphNodeSource,
  type NumenValue,
  type Run,
} from '@numenjs/core'
import type {
  RunEventPage,
  RunExecutionDiagnosticsPage,
  RunInspection,
  RunInstructionExecutionSummary,
  RunGraphMemberSummary,
} from '@numenjs/scheduler'
import type {
  WorkbenchRunContextGroup,
  WorkbenchRunDetail,
  WorkbenchRunExecution,
  WorkbenchRunFlowNode,
  WorkbenchRunFlowStatus,
  WorkbenchRunTimelineEvent,
} from './contracts.js'
import { findInspectionSourceNode } from './automation-source-inspection.js'

export function projectWorkbenchRunDetail(
  run: Run,
  automationName: string,
  revision: AutomationExecutionSnapshot | undefined,
  inspection: RunInspection,
  diagnostics: RunExecutionDiagnosticsPage,
  events: RunEventPage,
  encodeExecutionCursor: (cursor: NonNullable<RunExecutionDiagnosticsPage['nextCursor']>) => string,
  flowNodeId?: string,
): WorkbenchRunDetail {
  const supportedRevision = revision && isSupportedAutomationVersion(revision.protocolVersion, revision.irVersion) ? revision : undefined
  const capabilityTitles = new Map(
    (supportedRevision?.contractSnapshot.capabilities ?? []).map(capability => [capabilityKey(capability), capability.title]),
  )
  const instructions = supportedRevision?.compiledPlan.instructions ?? {}
  const focusedNodeId = supportedRevision && flowNodeId && findInspectionSourceNode(supportedRevision.source.flow, flowNodeId) ? flowNodeId : undefined
  const flow = projectRunFlow(revision, inspection.instructionExecutions, inspection.graphMembers, focusedNodeId)
  const counts = diagnostics.statusCounts
  return {
    run: {
      id: run.id,
      automationId: run.automationId,
      automationName,
      revisionId: run.revisionId,
      ...(revision ? { snapshotPurpose: revision.purpose, ...(revision.purpose === 'draft-test' ? { sourceDraftVersion: revision.sourceDraftVersion } : { revisionNumber: revision.number }) } : {}),
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
      const sourceNodeId = sourceNodeIdForExecution(revision, execution.instructionId)
      return {
        id: execution.id,
        instructionId: execution.instructionId,
        ...(sourceNodeId ? { sourceNodeId } : {}),
        ...(execution.sampleId ? { sampleId: execution.sampleId } : {}),
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

/** Resolve against immutable Source independently of the current visible Flow page. */
export function sourceNodeIdForExecution(revision: AutomationExecutionSnapshot | undefined, instructionId: string): string | undefined {
  if (!revision || !isSupportedAutomationVersion(revision.protocolVersion, revision.irVersion)) return
  const candidate = revision.compiledPlan.sourceMap?.[instructionId]?.nodeId ?? instructionId
  return findInspectionSourceNode(revision.source.flow, candidate)?.id
}

const flowStatusPriority: WorkbenchRunFlowStatus[] = [
  'FAILED', 'CANCELLING', 'RUNNING', 'BLOCKED', 'WAITING', 'CANCELLED', 'QUEUED', 'PENDING', 'COMPLETED', 'SKIPPED', 'IDLE',
]

export function projectRunFlow(
  revision: AutomationExecutionSnapshot | undefined,
  summaries: RunInstructionExecutionSummary[],
  graphMembers: RunGraphMemberSummary[] = [],
  sourceNodeId?: string,
  maximumNodes = 250,
): WorkbenchRunDetail['flow'] {
  if (!revision || !isSupportedAutomationVersion(revision.protocolVersion, revision.irVersion)) {
    return {
      root: {
        id: revision ? '__unsupported-revision' : '__missing-revision',
        type: 'block',
        title: 'Flow unavailable',
        detail: revision ? 'This Source and IR version pair is not supported for inspection.' : 'The immutable Revision is no longer available.',
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
      if (summary.sampledExecutionCount) existing.sampledExecutionCount = (existing.sampledExecutionCount ?? 0) + summary.sampledExecutionCount
      if (summary.latestUpdatedAt > existing.latestUpdatedAt) existing.latestUpdatedAt = summary.latestUpdatedAt
    }
  }
  const budget = { remaining: maximumNodes, truncated: false }
  const membersByNode = new Map<string, RunGraphMemberSummary[]>()
  for (const member of graphMembers) membersByNode.set(member.nodeId, [...(membersByNode.get(member.nodeId) ?? []), member])
  const selected = sourceNodeId ? findInspectionSourceNode(revision.source.flow, sourceNodeId) : revision.source.flow
  if (!selected) throw new Error('Source node is not present in this immutable snapshot')
  const source = projectFlowNode(selected, byInstruction, capabilityTitles, budget, membersByNode)!
  const root: WorkbenchRunFlowNode = {
    id: '__flow',
    type: 'block',
    title: 'Flow',
    detail: revision.purpose === 'draft-test' ? `Draft test · Draft v${revision.sourceDraftVersion} · IR ${revision.irVersion}` : `Revision ${revision.number} · IR ${revision.irVersion}`,
    status: source.status,
    executionCount: source.executionCount,
    ...(source.sampledExecutionCount ? { sampledExecutionCount: source.sampledExecutionCount } : {}),
    children: [source],
  }
  return { root, truncated: budget.truncated, ...(sourceNodeId ? { focusedNodeId: sourceNodeId } : {}) }
}

function projectFlowNode(
  control: ControlSource | GraphNodeSource,
  summaries: ReadonlyMap<string, RunInstructionExecutionSummary>,
  capabilityTitles: ReadonlyMap<string, string>,
  budget: { remaining: number; truncated: boolean },
  members: ReadonlyMap<string, RunGraphMemberSummary[]>,
  label?: string,
  depth = 0,
): WorkbenchRunFlowNode | undefined {
  if (budget.remaining <= 0 || depth > 64) {
    budget.truncated = true
    return
  }
  budget.remaining -= 1
  const children: WorkbenchRunFlowNode[] = []
  const append = (child: ControlSource, childLabel?: string) => {
    const projected = projectFlowNode(child, summaries, capabilityTitles, budget, members, childLabel, depth + 1)
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
  const memberStates = members.get(control.id) ?? []
  const directStatus = summary ? flowStatusFromSummary(summary) : 'IDLE'
  let graph: WorkbenchRunFlowNode['graph']
  if (control.type === 'graph') {
    const nodes = control.nodes.flatMap(member => {
      const projected = projectFlowNode(member, summaries, capabilityTitles, budget, members, undefined, depth + 1)
      return projected ? [projected] : []
    })
    const ids = new Set([control.id, ...nodes.map(node => node.id)])
    const edges = control.edges.filter(edge => ids.has(edge.from.nodeId) && ids.has(edge.to.nodeId)).slice(0, 1_000)
      .map(edge => ({ id: edge.id, from: { nodeId: edge.from.nodeId, port: edge.from.port }, to: { nodeId: edge.to.nodeId, port: edge.to.port } }))
    if (edges.length !== control.edges.length) budget.truncated = true
    graph = { nodes, edges }
  }
  const status = highestFlowStatus([directStatus, ...memberStates.map(member => graphMemberStatus(member.status)), ...children.map(child => child.status), ...(graph?.nodes.map(node => node.status) ?? [])])
  const blockedReason = memberStates.find(member => member.status === 'BLOCKED' && member.blockedReason)?.blockedReason
  const sampledExecutionCount = (summary?.sampledExecutionCount ?? 0) + [...children, ...(graph?.nodes ?? [])].reduce((total, child) => total + (child.sampledExecutionCount ?? 0), 0)
  return {
    id: control.id,
    type: control.type,
    title: label ?? flowNodeTitle(control, capabilityTitles),
    detail: flowNodeDetail(control),
    status,
    executionCount: totalExecutions(summary) + [...children, ...(graph?.nodes ?? [])].reduce((total, child) => total + child.executionCount, 0),
    ...(sampledExecutionCount ? { sampledExecutionCount } : {}),
    children,
    ...(graph ? { graph } : {}),
    ...(blockedReason ? { blockedReason } : {}),
  }
}

function graphMemberStatus(status: RunGraphMemberSummary['status']): WorkbenchRunFlowStatus {
  return status === 'RUNNABLE' ? 'QUEUED' : status === 'TIMED_OUT' ? 'FAILED' : status
}

function flowNodeTitle(control: ControlSource | GraphNodeSource, capabilityTitles: ReadonlyMap<string, string>): string {
  switch (control.type) {
    case 'block': return 'Sequence'
    case 'extension': return capabilityTitles.get(`control:${control.control.id}@${control.control.version}`) ?? control.control.id
    case 'capability': return capabilityTitles.get(capabilityKey(control.capability)) ?? control.capability.id
    case 'if': return 'Condition'
    case 'wait': return 'Wait'
    case 'parallel': return 'Parallel'
    case 'race': return 'Race'
    case 'foreach': return 'For each'
    case 'graph': return 'Graph'
    case 'condition': return 'Condition'
    case 'merge': return 'Merge'
  }
}

function flowNodeDetail(control: ControlSource | GraphNodeSource): string {
  switch (control.type) {
    case 'block': return `${control.steps.length} ${control.steps.length === 1 ? 'step' : 'steps'}`
    case 'extension': return `${control.control.id}@${control.control.version}`
    case 'capability': return `${capabilityKey(control.capability)} · ${Object.keys(control.connections ?? {}).length} connection bindings`
    case 'if': return control.else ? 'Then / Else' : 'Then branch'
    case 'wait': return control.until ? 'Until expression' : 'Duration expression'
    case 'parallel': return `${control.branches.length} branches · wait for all`
    case 'race': return `${control.branches.length} branches · first success`
    case 'foreach': return `Concurrency ${control.concurrency ?? 1}`
    case 'graph': return `${control.nodes.length} members · ${control.edges.length} edges`
    case 'condition': return 'True / False ports'
    case 'merge': return `${control.mode === 'all' ? 'All inputs' : 'Selected input'} · ${control.inputs.length} inputs`
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
  instruction: AutomationExecutionSnapshot['compiledPlan']['instructions'][string] | undefined,
  instructionId: string,
  capabilityTitles: ReadonlyMap<string, string>,
): string {
  if (!instruction) return instructionId.startsWith('__') ? 'Runtime control' : instructionId
  switch (instruction.op) {
    case 'invoke': return capabilityTitles.get(capabilityKey(instruction.capability)) ?? instruction.capability.id
    case 'branch': return 'Condition'
    case 'suspend': return instruction.source === 'timer' ? 'Wait' : 'Suspension'
    case 'fork': return instruction.mode === 'all' ? 'Parallel branches' : 'Race branches'
    case 'iterate': case 'graph_iterate': return 'For each'
    case 'join': return instruction.mode === 'iterate' ? 'Iteration join' : 'Branch join'
    case 'scope_complete': return 'Scope complete'
    case 'complete': return 'Run complete'
    case 'fail': return 'Run failure'
    case 'eval': return `Set ${instruction.assign}`
    case 'graph_scope': return 'Graph scope'
    case 'graph_condition': return 'Graph condition'
    case 'graph_merge': return 'Graph merge'
    case 'graph_value': return 'Sample output'
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
  if (type === 'RunAccepted') {
    const source = stringValue(payload.source)
    const revisionId = stringValue(payload.revisionId)
    const requestId = stringValue(payload.requestId)
    return [source ? `Source: ${humanizeToken(source)}` : undefined, revisionId ? `Revision: ${revisionId}` : undefined, requestId ? `Request: ${requestId}` : undefined].filter(Boolean).join(' · ') || undefined
  }
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
