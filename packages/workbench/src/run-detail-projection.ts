import { capabilityKey, type AutomationRevision, type NumenValue, type Run } from '@numen/core'
import type { RunEventPage, RunExecutionDiagnosticsPage } from '@numen/scheduler'
import type {
  WorkbenchRunDetail,
  WorkbenchRunExecution,
  WorkbenchRunTimelineEvent,
} from './contracts.js'

export function projectWorkbenchRunDetail(
  run: Run,
  automationName: string,
  revision: AutomationRevision | undefined,
  diagnostics: RunExecutionDiagnosticsPage,
  events: RunEventPage,
  encodeExecutionCursor: (cursor: NonNullable<RunExecutionDiagnosticsPage['nextCursor']>) => string,
): WorkbenchRunDetail {
  const capabilityTitles = new Map(
    (revision?.contractSnapshot.capabilities ?? []).map(capability => [capabilityKey(capability), capability.title]),
  )
  const instructions = revision?.compiledPlan.instructions ?? {}
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
