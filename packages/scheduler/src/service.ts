import '@numen/automation'
import {
  capabilityKey,
  isNumenValue,
  isResourceRef,
  type Attempt,
  type AutomationRevision,
  type CancellationReason,
  type ContractSnapshotCapability,
  type CoreInstruction,
  type Execution,
  type NumenValue,
  type Run,
  type RunEvent,
  type TriggerAcceptance,
  type TriggerBinding,
  type TriggerEmission,
} from '@numen/core'
import '@numen/database'
import '@numen/resources'
import { Service, type Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { evaluateExpression, type EvaluationBindings } from './evaluator.js'

export interface SchedulerConfig {
  autoDispatch?: boolean
  sweepIntervalMs?: number
  maxConcurrentExecutions?: number
}

export interface SchedulerHealth {
  ready: boolean
  queuedRuns: number
  runningRuns: number
  cancellingRuns: number
  runnableExecutions: number
  waitingExecutions: number
  blockedExecutions: number
}

export interface RunListCursor {
  createdAt: string
  id: string
}

export interface RunSummary extends Run {
  executionCount: number
  attemptCount: number
}

export interface RunSummaryPage {
  items: RunSummary[]
  nextCursor?: RunListCursor
}

export type RunStatusCounts = Record<Run['status'], number>

export interface ExecutionListCursor {
  createdAt: string
  id: string
}

export interface RunExecutionDiagnostic {
  execution: Execution
  attempts: Attempt[]
}

export interface RunExecutionDiagnosticsPage {
  items: RunExecutionDiagnostic[]
  statusCounts: Record<Execution['status'], number>
  attemptCount: number
  nextCursor?: ExecutionListCursor
}

export interface RunEventPage {
  items: RunEvent[]
  total: number
  nextCursor?: number
}

export interface RunInstructionExecutionSummary {
  instructionId: string
  statusCounts: Record<Execution['status'], number>
  latestUpdatedAt: string
}

export interface RunInspection {
  context: EvaluationBindings
  instructionExecutions: RunInstructionExecutionSummary[]
}

interface RunRow {
  id: string
  automation_id: string
  revision_id: string
  status: Run['status']
  trigger_json: string
  input_json: string
  group_key: string | null
  cancel_reason: CancellationReason | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface RunSummaryRow extends RunRow {
  execution_count: number
  attempt_count: number
}

interface ExecutionRow {
  id: string
  run_id: string
  instruction_id: string
  parent_execution_id: string | null
  scope_execution_id: string | null
  scope_branch: number | null
  loop_item_json: string | null
  loop_index: number | null
  status: Execution['status']
  resolved_input_json: string | null
  output_json: string | null
  wake_at: string | null
  blocked_reason: string | null
  generation: number
  created_at: string
  updated_at: string
}

interface AttemptRow {
  id: string
  execution_id: string
  number: number
  status: Attempt['status']
  provider_ref: string
  error_json: string | null
  started_at: string
  finished_at: string | null
}

interface EventRow {
  run_id: string
  sequence: number
  type: string
  payload_json: string
  occurred_at: string
}

interface IterationRow {
  iterate_execution_id: string
  item_index: number
  item_json: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  root_execution_id: string | null
  terminal_execution_id: string | null
  error_json: string | null
  created_at: string
  updated_at: string
}

declare module 'cordis' {
  interface Context {
    scheduler: SchedulerService
  }

  interface Events {
    'numen/run-change'(runId: string): void
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function parseJson<T>(source: string): T {
  return JSON.parse(source) as T
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    automationId: row.automation_id,
    revisionId: row.revision_id,
    status: row.status,
    trigger: parseJson(row.trigger_json),
    input: parseJson(row.input_json),
    ...(row.group_key ? { groupKey: row.group_key } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  }
}

function mapExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    runId: row.run_id,
    instructionId: row.instruction_id,
    ...(row.parent_execution_id ? { parentExecutionId: row.parent_execution_id } : {}),
    ...(row.scope_execution_id ? { scopeExecutionId: row.scope_execution_id } : {}),
    ...(row.scope_branch === null ? {} : { scopeBranch: row.scope_branch }),
    ...(row.loop_item_json ? { loopItem: parseJson(row.loop_item_json) } : {}),
    ...(row.loop_index === null ? {} : { loopIndex: row.loop_index }),
    status: row.status,
    ...(row.resolved_input_json ? { resolvedInput: parseJson(row.resolved_input_json) } : {}),
    ...(row.output_json ? { output: parseJson(row.output_json) } : {}),
    ...(row.wake_at ? { wakeAt: row.wake_at } : {}),
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    executionId: row.execution_id,
    number: row.number,
    status: row.status,
    providerRef: row.provider_ref,
    ...(row.error_json ? { error: parseJson(row.error_json) } : {}),
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  }
}

function mapEvent(row: EventRow): RunEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    payload: parseJson(row.payload_json),
    occurredAt: row.occurred_at,
  }
}

function errorValue(error: unknown): NumenValue {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { name: 'Error', message: String(error) }
}

class InvocationTimeoutError extends Error {
  override name = 'InvocationTimeoutError'
}

class InvocationCancelledError extends Error {
  override name = 'InvocationCancelledError'

  constructor(public readonly reason: CancellationReason) {
    super(`invocation cancelled: ${reason}`)
  }
}

interface ActiveInvocation {
  runId: string
  controller: AbortController
}

export class SchedulerService extends Service {
  static inject = ['database', 'capabilities', 'automations', 'resources']

  private ready = false
  private dispatchTask: Promise<number> | undefined
  private readonly activeInvocations = new Map<string, ActiveInvocation>()
  private readonly activeExecutionTasks = new Map<string, Promise<void>>()
  private readonly pendingRunChanges = new Set<string>()
  private runChangeScheduled = false
  private readonly autoDispatch: boolean
  private readonly sweepIntervalMs: number
  private readonly maxConcurrentExecutions: number

  constructor(ctx: Context, public config: SchedulerConfig = {}) {
    super(ctx, 'scheduler')
    this.autoDispatch = config.autoDispatch ?? true
    this.sweepIntervalMs = config.sweepIntervalMs ?? 1000
    this.maxConcurrentExecutions = config.maxConcurrentExecutions ?? 16
    if (!Number.isSafeInteger(this.maxConcurrentExecutions) || this.maxConcurrentExecutions < 1) {
      throw new TypeError('scheduler.maxConcurrentExecutions must be a positive integer')
    }
  }

  async *[Service.init]() {
    this.recoverCancellations()
    this.recoverInterruptedWork()
    this.recoverStructuredScopes()
    this.ready = true
    let timer: NodeJS.Timeout | undefined
    if (this.autoDispatch) {
      this.ctx.on('numen/capability-change', () => this.kick())
      timer = setInterval(() => this.kick(), this.sweepIntervalMs)
      timer.unref()
      queueMicrotask(() => this.kick())
    }
    yield () => {
      this.ready = false
      if (timer) clearInterval(timer)
    }
  }

  startManual(
    automationId: string,
    input: Record<string, NumenValue> = {},
    trigger: NumenValue = { type: 'manual' },
  ): Run {
    const automation = this.ctx.automations.get(automationId)
    if (!automation) throw new Error(`automation not found: ${automationId}`)
    if (!automation.activeRevisionId) throw new Error(`automation has no active revision: ${automationId}`)
    if (!isNumenValue(input) || !isNumenValue(trigger)) throw new TypeError('run input and trigger must be Numen values')
    const runId = id('run')
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      this.ctx.database.db.prepare(`
        INSERT INTO runs (
          id, automation_id, revision_id, status, trigger_json, input_json, created_at
        ) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?)
      `).run(runId, automationId, automation.activeRevisionId, JSON.stringify(trigger), JSON.stringify(input), now)
      this.appendEvent(runId, 'RunAccepted', { source: 'manual' }, now)
    })
    if (this.autoDispatch) this.kick()
    return this.getRun(runId)!
  }

  acceptTrigger(binding: TriggerBinding, emission: TriggerEmission): TriggerAcceptance {
    if (!isNumenValue(emission.data)) throw new TypeError('trigger data must be a Numen value')
    if (emission.checkpoint !== undefined && !isNumenValue(emission.checkpoint)) {
      throw new TypeError('trigger checkpoint must be a Numen value')
    }
    if (emission.eventId !== undefined && !emission.eventId.trim()) {
      throw new TypeError('trigger eventId must not be empty')
    }
    if (emission.subject !== undefined && !emission.subject.trim()) {
      throw new TypeError('trigger subject must not be empty')
    }
    const acceptedAt = new Date().toISOString()
    const occurredAt = emission.occurredAt === undefined
      ? acceptedAt
      : new Date(emission.occurredAt).toISOString()
    let accepted = false
    const result = this.ctx.database.transaction((): TriggerAcceptance => {
      const automation = this.ctx.database.db.prepare(`
        SELECT enabled, active_revision_id, activation_generation
        FROM automations WHERE id = ?
      `).get(binding.automationId) as {
        enabled: number
        active_revision_id: string | null
        activation_generation: number
      } | undefined
      if (
        !automation?.enabled
        || automation.active_revision_id !== binding.revisionId
        || automation.activation_generation !== binding.activationGeneration
      ) {
        return { status: 'stale' }
      }

      if (emission.eventId !== undefined) {
        const duplicate = this.ctx.database.db.prepare(`
          SELECT run_id FROM trigger_events
          WHERE revision_id = ? AND trigger_id = ? AND event_id = ?
        `).get(binding.revisionId, binding.triggerId, emission.eventId) as { run_id: string } | undefined
        if (duplicate) return { status: 'duplicate', runId: duplicate.run_id }
      }

      const runId = id('run')
      const eventRowId = id('trigger')
      this.ctx.database.db.prepare(`
        INSERT INTO runs (
          id, automation_id, revision_id, status, trigger_json, input_json, created_at
        ) VALUES (?, ?, ?, 'QUEUED', ?, '{}', ?)
      `).run(runId, binding.automationId, binding.revisionId, JSON.stringify(emission.data), acceptedAt)
      this.ctx.database.db.prepare(`
        INSERT INTO trigger_events (
          id, automation_id, revision_id, activation_generation, trigger_id,
          capability_id, capability_version, event_id, subject, data_json,
          checkpoint_json, occurred_at, accepted_at, run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventRowId,
        binding.automationId,
        binding.revisionId,
        binding.activationGeneration,
        binding.triggerId,
        binding.capability.id,
        binding.capability.version,
        emission.eventId ?? null,
        emission.subject ?? null,
        JSON.stringify(emission.data),
        emission.checkpoint === undefined ? null : JSON.stringify(emission.checkpoint),
        occurredAt,
        acceptedAt,
        runId,
      )
      this.appendEvent(runId, 'RunAccepted', {
        source: 'trigger',
        triggerId: binding.triggerId,
        ...(emission.eventId === undefined ? {} : { eventId: emission.eventId }),
      }, acceptedAt)
      accepted = true
      return { status: 'accepted', runId }
    })
    if (accepted && this.autoDispatch) this.kick()
    return result
  }

  cancelRun(runId: string, reason: CancellationReason = 'USER'): Run {
    const existing = this.getRun(runId)
    if (!existing) throw new Error(`run not found: ${runId}`)
    if (existing.status === 'COMPLETED' || existing.status === 'FAILED' || existing.status === 'CANCELLED') {
      return existing
    }
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE runs SET status = 'CANCELLING', cancel_reason = ?
        WHERE id = ? AND status IN ('QUEUED', 'RUNNING')
      `).run(reason, runId)
      if (result.changes) this.appendEvent(runId, 'RunCancellationRequested', { reason }, now)
    })
    const cancellationReason = (this.getRun(runId)?.cancelReason as CancellationReason | undefined) ?? reason
    this.propagateCancellation(runId, cancellationReason)
    return this.getRun(runId)!
  }

  getRun(runId: string): Run | undefined {
    const row = this.ctx.database.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined
    return row ? mapRun(row) : undefined
  }

  inspectRun(runId: string): RunInspection | undefined {
    const run = this.getRun(runId)
    if (!run) return
    const emptyCounts = (): Record<Execution['status'], number> => ({
      RUNNABLE: 0,
      RUNNING: 0,
      WAITING: 0,
      BLOCKED: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
      TIMED_OUT: 0,
    })
    const summaries = new Map<string, RunInstructionExecutionSummary>()
    const rows = this.ctx.database.db.prepare(`
      SELECT instruction_id, status, COUNT(*) AS count, MAX(updated_at) AS latest_updated_at
      FROM executions WHERE run_id = ?
      GROUP BY instruction_id, status
      ORDER BY instruction_id, status
    `).all(runId) as Array<{
      instruction_id: string
      status: Execution['status']
      count: number
      latest_updated_at: string
    }>
    for (const row of rows) {
      const summary = summaries.get(row.instruction_id) ?? {
        instructionId: row.instruction_id,
        statusCounts: emptyCounts(),
        latestUpdatedAt: row.latest_updated_at,
      }
      summary.statusCounts[row.status] = row.count
      if (row.latest_updated_at > summary.latestUpdatedAt) summary.latestUpdatedAt = row.latest_updated_at
      summaries.set(row.instruction_id, summary)
    }
    return {
      context: this.createBindings(run),
      instructionExecutions: [...summaries.values()],
    }
  }

  listRuns(limit = 20): Run[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('run list limit must be an integer between 1 and 100')
    }
    return (this.ctx.database.db.prepare(`
      SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(limit) as RunRow[]).map(mapRun)
  }

  listRunSummariesPage(limit = 20, cursor?: RunListCursor): RunSummaryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError('run summary page limit must be an integer between 1 and 50')
    }
    if (cursor && (!cursor.createdAt || !cursor.id)) throw new TypeError('run summary cursor is invalid')
    const rows = this.ctx.database.db.prepare(`
      SELECT runs.*, COUNT(DISTINCT executions.id) AS execution_count,
        COUNT(attempts.id) AS attempt_count
      FROM runs
      LEFT JOIN executions ON executions.run_id = runs.id
      LEFT JOIN attempts ON attempts.execution_id = executions.id
      ${cursor ? 'WHERE runs.created_at < ? OR (runs.created_at = ? AND runs.id < ?)' : ''}
      GROUP BY runs.id
      ORDER BY runs.created_at DESC, runs.id DESC
      LIMIT ?
    `).all(...(cursor
      ? [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
      : [limit + 1])) as RunSummaryRow[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(row => ({
      ...mapRun(row),
      executionCount: row.execution_count,
      attemptCount: row.attempt_count,
    }))
    const last = items.at(-1)
    return {
      items,
      ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
    }
  }

  getRunStatusCounts(): RunStatusCounts {
    const counts: RunStatusCounts = {
      QUEUED: 0,
      RUNNING: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
    }
    const rows = this.ctx.database.db.prepare(`
      SELECT status, COUNT(*) AS count FROM runs GROUP BY status
    `).all() as Array<{ status: Run['status']; count: number }>
    for (const row of rows) counts[row.status] = row.count
    return counts
  }

  listExecutions(runId: string): Execution[] {
    return (this.ctx.database.db.prepare(`
      SELECT * FROM executions WHERE run_id = ? ORDER BY created_at, id
    `).all(runId) as ExecutionRow[]).map(mapExecution)
  }

  listExecutionDiagnosticsPage(
    runId: string,
    limit = 25,
    cursor?: ExecutionListCursor,
  ): RunExecutionDiagnosticsPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError('execution diagnostics page limit must be an integer between 1 and 50')
    }
    if (cursor && (!cursor.createdAt || !cursor.id)) {
      throw new TypeError('execution diagnostics cursor is invalid')
    }
    const rows = this.ctx.database.db.prepare(`
      SELECT * FROM executions
      WHERE run_id = ?
      ${cursor ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(runId, ...(cursor
      ? [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
      : [limit + 1])) as ExecutionRow[]
    const hasMore = rows.length > limit
    const executions = rows.slice(0, limit).map(mapExecution)
    const attemptsByExecution = new Map<string, Attempt[]>()
    if (executions.length) {
      const placeholders = executions.map(() => '?').join(', ')
      const attempts = (this.ctx.database.db.prepare(`
        SELECT * FROM attempts
        WHERE execution_id IN (${placeholders})
        ORDER BY execution_id, number
      `).all(...executions.map(execution => execution.id)) as AttemptRow[]).map(mapAttempt)
      for (const attempt of attempts) {
        const items = attemptsByExecution.get(attempt.executionId) ?? []
        items.push(attempt)
        attemptsByExecution.set(attempt.executionId, items)
      }
    }
    const statusCounts = {
      RUNNABLE: 0,
      RUNNING: 0,
      WAITING: 0,
      BLOCKED: 0,
      COMPLETED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
      TIMED_OUT: 0,
    } satisfies Record<Execution['status'], number>
    const statusRows = this.ctx.database.db.prepare(`
      SELECT status, COUNT(*) AS count FROM executions WHERE run_id = ? GROUP BY status
    `).all(runId) as Array<{ status: Execution['status']; count: number }>
    for (const row of statusRows) statusCounts[row.status] = row.count
    const attemptCount = (this.ctx.database.db.prepare(`
      SELECT COUNT(*) AS count FROM attempts
      JOIN executions ON executions.id = attempts.execution_id
      WHERE executions.run_id = ?
    `).get(runId) as { count: number }).count
    const last = executions.at(-1)
    return {
      items: executions.map(execution => ({
        execution,
        attempts: attemptsByExecution.get(execution.id) ?? [],
      })),
      statusCounts,
      attemptCount,
      ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
    }
  }

  listAttempts(runId: string): Attempt[] {
    return (this.ctx.database.db.prepare(`
      SELECT attempts.* FROM attempts
      JOIN executions ON executions.id = attempts.execution_id
      WHERE executions.run_id = ? ORDER BY executions.created_at, attempts.number
    `).all(runId) as AttemptRow[]).map(mapAttempt)
  }

  listEvents(runId: string): RunEvent[] {
    return (this.ctx.database.db.prepare(`
      SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence
    `).all(runId) as EventRow[]).map(mapEvent)
  }

  listRunEventsPage(runId: string, limit = 50, beforeSequence?: number): RunEventPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('run event page limit must be an integer between 1 and 100')
    }
    if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) {
      throw new TypeError('run event cursor must be a positive integer')
    }
    const rows = this.ctx.database.db.prepare(`
      SELECT * FROM run_events
      WHERE run_id = ? ${beforeSequence === undefined ? '' : 'AND sequence < ?'}
      ORDER BY sequence DESC
      LIMIT ?
    `).all(runId, ...(beforeSequence === undefined ? [limit + 1] : [beforeSequence, limit + 1])) as EventRow[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(mapEvent)
    const total = (this.ctx.database.db.prepare(`
      SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?
    `).get(runId) as { count: number }).count
    const last = items.at(-1)
    return {
      items,
      total,
      ...(hasMore && last ? { nextCursor: last.sequence } : {}),
    }
  }

  health(): SchedulerHealth {
    const count = (status: string, table = 'executions') => {
      return (this.ctx.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE status = ?`).get(status) as { count: number }).count
    }
    return {
      ready: this.ready,
      queuedRuns: count('QUEUED', 'runs'),
      runningRuns: count('RUNNING', 'runs'),
      cancellingRuns: count('CANCELLING', 'runs'),
      runnableExecutions: count('RUNNABLE'),
      waitingExecutions: count('WAITING'),
      blockedExecutions: count('BLOCKED'),
    }
  }

  dispatchUntilIdle(maxTransitions = 1000): Promise<number> {
    if (this.dispatchTask) return this.dispatchTask
    const task = this.runDispatchLoop(maxTransitions)
    this.dispatchTask = task.finally(() => {
      this.dispatchTask = undefined
    })
    return this.dispatchTask
  }

  private kick(): void {
    if (!this.ready) return
    queueMicrotask(() => {
      this.dispatchUntilIdle().catch(error => this.ctx.logger('scheduler').error(error))
    })
  }

  private async runDispatchLoop(maxTransitions: number): Promise<number> {
    let transitions = 0
    while (transitions < maxTransitions) {
      let progressed = false
      const cancelled = this.reconcileCancellations()
      const resumed = this.resumeDueTimers()
      const unblocked = this.reconcileBlockedExecutions()
      if (cancelled || resumed || unblocked) {
        transitions += cancelled + resumed + unblocked
        progressed = true
      }
      if (this.admitOneRun()) {
        transitions += 1
        progressed = true
      }
      const availableSlots = this.maxConcurrentExecutions - this.activeExecutionTasks.size
      const executions = availableSlots > 0 ? this.nextRunnableExecutions(availableSlots) : []
      if (executions.length) {
        for (const execution of executions) {
          const task = this.execute(execution).finally(() => {
            this.activeExecutionTasks.delete(execution.id)
          })
          this.activeExecutionTasks.set(execution.id, task)
        }
        transitions += executions.length
        progressed = true
      }
      if (this.activeExecutionTasks.size) {
        await Promise.race(this.activeExecutionTasks.values())
        progressed = true
      }
      if (!progressed) return transitions
    }
    throw new Error(`scheduler exceeded ${maxTransitions} transitions without becoming idle`)
  }

  private appendEvent(runId: string, type: string, payload: NumenValue, occurredAt = new Date().toISOString()): void {
    const { sequence } = this.ctx.database.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?
    `).get(runId) as { sequence: number }
    this.ctx.database.db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, sequence, type, JSON.stringify(payload), occurredAt)
    this.scheduleRunChange(runId)
  }

  private scheduleRunChange(runId: string): void {
    this.pendingRunChanges.add(runId)
    if (this.runChangeScheduled) return
    this.runChangeScheduled = true
    queueMicrotask(() => {
      this.runChangeScheduled = false
      const runIds = [...this.pendingRunChanges]
      this.pendingRunChanges.clear()
      for (const changedRunId of runIds) this.ctx.emit('numen/run-change', changedRunId)
    })
  }

  private createExecution(
    runId: string,
    instructionId: string,
    parentExecutionId?: string,
    scopeExecutionId?: string,
    scopeBranch?: number,
    loopItem?: NumenValue,
    loopIndex?: number,
  ): string {
    const executionId = id('exec')
    const now = new Date().toISOString()
    this.ctx.database.db.prepare(`
      INSERT INTO executions (
        id, run_id, instruction_id, parent_execution_id, scope_execution_id, scope_branch,
        loop_item_json, loop_index,
        status, generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNABLE', 0, ?, ?)
    `).run(
      executionId,
      runId,
      instructionId,
      parentExecutionId ?? null,
      scopeExecutionId ?? null,
      scopeBranch ?? null,
      loopItem === undefined ? null : JSON.stringify(loopItem),
      loopIndex ?? null,
      now,
      now,
    )
    this.appendEvent(runId, 'ExecutionCreated', { executionId, instructionId }, now)
    return executionId
  }

  private admitOneRun(): boolean {
    const row = this.ctx.database.db.prepare(`
      SELECT * FROM runs WHERE status = 'QUEUED' ORDER BY created_at, id LIMIT 1
    `).get() as RunRow | undefined
    if (!row) return false
    const revision = this.ctx.automations.getRevision(row.revision_id)
    if (!revision) {
      this.failQueuedRun(row.id, { code: 'REVISION_MISSING', revisionId: row.revision_id })
      return true
    }
    const now = new Date().toISOString()
    return this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE runs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'
      `).run(now, row.id)
      if (!result.changes) return false
      this.appendEvent(row.id, 'RunStarted', { revisionId: row.revision_id }, now)
      this.createExecution(row.id, revision.compiledPlan.entry)
      return true
    })
  }

  private failQueuedRun(runId: string, error: NumenValue): void {
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      this.ctx.database.db.prepare(`
        UPDATE runs SET status = 'FAILED', finished_at = ? WHERE id = ? AND status = 'QUEUED'
      `).run(now, runId)
      this.appendEvent(runId, 'RunFailed', { error }, now)
    })
  }

  private nextRunnableExecutions(limit: number): Execution[] {
    return (this.ctx.database.db.prepare(`
      SELECT executions.* FROM executions
      JOIN runs ON runs.id = executions.run_id
      WHERE executions.status = 'RUNNABLE' AND runs.status = 'RUNNING'
      ORDER BY executions.created_at, executions.id
      LIMIT ?
    `).all(limit) as ExecutionRow[]).map(mapExecution)
  }

  private getExecutionRow(executionId: string): ExecutionRow | undefined {
    return this.ctx.database.db.prepare('SELECT * FROM executions WHERE id = ?')
      .get(executionId) as ExecutionRow | undefined
  }

  private getRevisionForExecution(execution: Execution): { run: Run; revision: AutomationRevision; instruction: CoreInstruction } {
    const run = this.getRun(execution.runId)
    if (!run) throw new Error(`run not found: ${execution.runId}`)
    const revision = this.ctx.automations.getRevision(run.revisionId)
    if (!revision) throw new Error(`revision not found: ${run.revisionId}`)
    const instruction = revision.compiledPlan.instructions[execution.instructionId]
    if (!instruction) throw new Error(`instruction not found: ${execution.instructionId}`)
    return { run, revision, instruction }
  }

  private createBindings(run: Run, execution?: Execution): EvaluationBindings {
    const steps: Record<string, NumenValue> = {}
    const rows = this.ctx.database.db.prepare(`
      SELECT instruction_id, output_json FROM executions
      WHERE run_id = ? AND status = 'COMPLETED' AND output_json IS NOT NULL
      ORDER BY created_at, id
    `).all(run.id) as Array<{ instruction_id: string; output_json: string }>
    for (const row of rows) {
      if (!row.instruction_id.startsWith('__')) steps[row.instruction_id] = parseJson(row.output_json)
    }
    if (execution) {
      const ancestors = this.ctx.database.db.prepare(`
        WITH RECURSIVE ancestors(id, parent_execution_id, instruction_id, output_json, status, depth) AS (
          SELECT id, parent_execution_id, instruction_id, output_json, status, 0
          FROM executions WHERE id = ?
          UNION ALL
          SELECT parent.id, parent.parent_execution_id, parent.instruction_id,
            parent.output_json, parent.status, ancestors.depth + 1
          FROM executions AS parent
          JOIN ancestors ON parent.id = ancestors.parent_execution_id
        )
        SELECT instruction_id, output_json FROM ancestors
        WHERE status = 'COMPLETED' AND output_json IS NOT NULL
        ORDER BY depth DESC
      `).all(execution.id) as Array<{
        instruction_id: string
        output_json: string
      }>
      for (const row of ancestors) {
        if (!row.instruction_id.startsWith('__')) steps[row.instruction_id] = parseJson(row.output_json)
      }
    }
    return {
      run: {
        id: run.id,
        automationId: run.automationId,
        revisionId: run.revisionId,
      },
      trigger: run.trigger,
      input: run.input,
      steps,
      vars: {},
      loop: execution?.loopIndex === undefined
        ? {}
        : { item: execution.loopItem ?? null, index: execution.loopIndex },
      error: null,
    }
  }

  private async execute(execution: Execution): Promise<void> {
    try {
      const { run, revision, instruction } = this.getRevisionForExecution(execution)
      const bindings = this.createBindings(run, execution)
      switch (instruction.op) {
        case 'invoke': {
          const contract = revision.contractSnapshot.capabilities.find(item => (
            capabilityKey(item) === capabilityKey(instruction.capability)
          ))
          if (!contract) throw new Error(`frozen capability contract not found: ${capabilityKey(instruction.capability)}`)
          await this.invokeCapability(execution, instruction, bindings, contract)
          break
        }
        case 'branch': {
          const condition = evaluateExpression(instruction.condition, bindings)
          if (typeof condition !== 'boolean') throw new Error('branch condition must evaluate to boolean')
          this.completeInternal(execution, condition ? instruction.then : instruction.else, condition)
          break
        }
        case 'suspend':
          this.suspendTimer(execution, instruction, bindings)
          break
        case 'fork':
          this.forkAll(execution, instruction)
          break
        case 'iterate':
          this.beginIterate(execution, instruction, bindings)
          break
        case 'scope_complete':
          this.completeScope(execution)
          break
        case 'join':
          this.completeInternal(execution, instruction.next, null)
          break
        case 'complete': {
          const output = instruction.output ? evaluateExpression(instruction.output, bindings) : null
          this.completeRun(execution, output)
          break
        }
        case 'fail':
          this.failExecution(execution, evaluateExpression(instruction.error, bindings))
          break
        case 'eval':
          this.failExecution(execution, { code: 'EVAL_ASSIGN_NOT_IMPLEMENTED', assign: instruction.assign })
          break
        default:
          this.failExecution(execution, { code: 'INSTRUCTION_NOT_SUPPORTED' })
      }
    } catch (error) {
      this.failExecution(execution, errorValue(error))
    }
  }

  private async invokeCapability(
    execution: Execution,
    instruction: Extract<CoreInstruction, { op: 'invoke' }>,
    bindings: EvaluationBindings,
    contract: ContractSnapshotCapability,
  ): Promise<void> {
    const status = this.ctx.capabilities.get(instruction.capability)
    const provider = this.ctx.capabilities.resolveProvider<NumenValue, NumenValue>(instruction.capability)
    if (!status || !provider) {
      this.blockExecution(execution, 'PROVIDER_UNAVAILABLE', { capability: capabilityKey(instruction.capability) })
      return
    }
    const evaluatedInput = evaluateExpression(instruction.input, bindings)
    const resolvedInput = status.definition.input(evaluatedInput)
    if (!isNumenValue(resolvedInput)) throw new Error('capability input normalized to a non-Numen value')

    const attemptId = id('attempt')
    let attemptNumber = 0
    const now = new Date().toISOString()
    const claimed = this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE executions
        SET status = 'RUNNING', resolved_input_json = ?, blocked_reason = NULL,
            generation = generation + 1, updated_at = ?
        WHERE id = ? AND status = 'RUNNABLE'
      `).run(JSON.stringify(resolvedInput), now, execution.id)
      if (!result.changes) return false
      const { number } = this.ctx.database.db.prepare(`
        SELECT COALESCE(MAX(number), 0) + 1 AS number FROM attempts WHERE execution_id = ?
      `).get(execution.id) as { number: number }
      attemptNumber = number
      this.ctx.database.db.prepare(`
        INSERT INTO attempts (
          id, execution_id, number, status, provider_ref, started_at
        ) VALUES (?, ?, ?, 'RUNNING', ?, ?)
      `).run(attemptId, execution.id, number, capabilityKey(instruction.capability), now)
      this.appendEvent(execution.runId, 'AttemptStarted', { attemptId, executionId: execution.id, number }, now)
      return true
    })
    if (!claimed) return

    const controller = new AbortController()
    this.activeInvocations.set(execution.id, { runId: execution.runId, controller })
    const timeoutMs = instruction.policy?.timeoutMs ?? contract.semantics.defaultTimeoutMs
    try {
      const output = await this.invokeWithGuards(() => provider.invoke({
          input: resolvedInput,
          connectionIds: instruction.connections ?? (instruction.connection ? { default: instruction.connection } : {}),
          signal: controller.signal,
          idempotencyKey: attemptId,
        }), controller, timeoutMs)
      const validatedOutput = status.definition.output(output)
      if (!isNumenValue(validatedOutput)) throw new Error('capability output is not a Numen value')
      this.completeInvocation(execution, attemptId, instruction.next, validatedOutput)
    } catch (error) {
      if (error instanceof InvocationCancelledError) return
      const timedOut = error instanceof InvocationTimeoutError
      this.settleFailedInvocation(
        execution,
        attemptId,
        attemptNumber,
        instruction,
        contract.semantics.retrySafe,
        timedOut ? 'TIMED_OUT' : 'FAILED',
        errorValue(error),
      )
    } finally {
      this.activeInvocations.delete(execution.id)
    }
  }

  private async invokeWithGuards<T>(
    invoke: () => Promise<T>,
    controller: AbortController,
    timeoutMs?: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const reason = controller.signal.reason
        reject(reason instanceof Error ? reason : new InvocationCancelledError('USER'))
      }
      if (controller.signal.aborted) {
        onAbort()
      } else {
        controller.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        controller.abort(new InvocationTimeoutError(`capability timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()
    }
    try {
      return await Promise.race([Promise.resolve().then(invoke), aborted])
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private completeInvocation(execution: Execution, attemptId: string, next: string | undefined, output: NumenValue): void {
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      this.ctx.database.db.prepare(`
        UPDATE attempts SET status = 'SUCCEEDED', finished_at = ? WHERE id = ? AND status = 'RUNNING'
      `).run(now, attemptId)
      const result = this.ctx.database.db.prepare(`
        UPDATE executions SET status = 'COMPLETED', output_json = ?, updated_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(JSON.stringify(output), now, execution.id)
      if (!result.changes) return
      this.commitOutputResources(execution, output)
      this.appendEvent(execution.runId, 'ExecutionCompleted', { executionId: execution.id, output }, now)
      if (next) this.createSuccessor(execution, next)
    })
  }

  private settleFailedInvocation(
    execution: Execution,
    attemptId: string,
    attemptNumber: number,
    instruction: Extract<CoreInstruction, { op: 'invoke' }>,
    retrySafe: boolean,
    attemptStatus: 'FAILED' | 'TIMED_OUT',
    error: NumenValue,
  ): void {
    const now = new Date().toISOString()
    const retry = instruction.policy?.retry
    const canRetry = retrySafe && attemptNumber < (retry?.maxAttempts ?? 1)
    const outcomeUnknown = attemptStatus === 'TIMED_OUT' && !retrySafe
    const attemptEvent = attemptStatus === 'TIMED_OUT' ? 'AttemptTimedOut' : 'AttemptFailed'
    this.ctx.database.transaction(() => {
      const attemptResult = this.ctx.database.db.prepare(`
        UPDATE attempts SET status = ?, error_json = ?, finished_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(attemptStatus, JSON.stringify(error), now, attemptId)
      if (!attemptResult.changes) return
      this.appendEvent(execution.runId, attemptEvent, { attemptId, executionId: execution.id, error }, now)

      if (outcomeUnknown) {
        const result = this.ctx.database.db.prepare(`
          UPDATE executions
          SET status = 'BLOCKED', blocked_reason = 'OUTCOME_UNKNOWN', output_json = ?, updated_at = ?
          WHERE id = ? AND status = 'RUNNING'
        `).run(JSON.stringify(error), now, execution.id)
        if (result.changes) {
          this.appendEvent(execution.runId, 'ExecutionBlocked', {
            executionId: execution.id,
            reason: 'OUTCOME_UNKNOWN',
            details: { attemptId, error },
          }, now)
        }
        return
      }

      if (canRetry) {
        const backoffMs = (retry?.backoffMs ?? 0) * (2 ** (attemptNumber - 1))
        const wakeAt = new Date(Date.now() + backoffMs).toISOString()
        const result = this.ctx.database.db.prepare(`
          UPDATE executions
          SET status = 'WAITING', blocked_reason = 'RETRY_BACKOFF', wake_at = ?, output_json = ?, updated_at = ?
          WHERE id = ? AND status = 'RUNNING'
        `).run(wakeAt, JSON.stringify(error), now, execution.id)
        if (result.changes) {
          this.appendEvent(execution.runId, 'ExecutionRetryScheduled', {
            executionId: execution.id,
            attemptId,
            nextAttempt: attemptNumber + 1,
            wakeAt,
          }, now)
        }
        return
      }

      const executionStatus = attemptStatus === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED'
      const result = this.ctx.database.db.prepare(`
        UPDATE executions SET status = ?, output_json = ?, updated_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(executionStatus, JSON.stringify(error), now, execution.id)
      if (!result.changes) return
      const runFailed = this.handleStructuredFailure(execution, now, error)
      if (runFailed) {
        this.ctx.database.db.prepare(`
          UPDATE runs SET status = 'FAILED', finished_at = ? WHERE id = ? AND status = 'RUNNING'
        `).run(now, execution.runId)
      }
      this.appendEvent(execution.runId, 'ExecutionFailed', {
        executionId: execution.id,
        status: executionStatus,
        error,
      }, now)
      if (runFailed) this.appendEvent(execution.runId, 'RunFailed', { executionId: execution.id, error }, now)
    })
  }

  private completeInternal(execution: Execution, next: string | undefined, output: NumenValue): void {
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE executions SET status = 'COMPLETED', output_json = ?, updated_at = ?
        WHERE id = ? AND status = 'RUNNABLE'
      `).run(JSON.stringify(output), now, execution.id)
      if (!result.changes) return
      this.commitOutputResources(execution, output)
      this.appendEvent(execution.runId, 'ExecutionCompleted', { executionId: execution.id, output }, now)
      if (next) this.createSuccessor(execution, next)
    })
  }

  private completeRun(execution: Execution, output: NumenValue): void {
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE executions SET status = 'COMPLETED', output_json = ?, updated_at = ?
        WHERE id = ? AND status = 'RUNNABLE'
      `).run(JSON.stringify(output), now, execution.id)
      if (!result.changes) return
      this.commitOutputResources(execution, output)
      this.ctx.database.db.prepare(`
        UPDATE runs SET status = 'COMPLETED', finished_at = ? WHERE id = ? AND status = 'RUNNING'
      `).run(now, execution.runId)
      this.appendEvent(execution.runId, 'ExecutionCompleted', { executionId: execution.id, output }, now)
      this.appendEvent(execution.runId, 'RunCompleted', { output }, now)
    })
  }

  private failExecution(execution: Execution, error: NumenValue): void {
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE executions SET status = 'FAILED', output_json = ?, updated_at = ?
        WHERE id = ? AND status IN ('RUNNABLE', 'RUNNING')
      `).run(JSON.stringify(error), now, execution.id)
      if (!result.changes) return
      const runFailed = this.handleStructuredFailure(execution, now, error)
      if (runFailed) {
        this.ctx.database.db.prepare(`
          UPDATE runs SET status = 'FAILED', finished_at = ? WHERE id = ? AND status = 'RUNNING'
        `).run(now, execution.runId)
      }
      this.appendEvent(execution.runId, 'ExecutionFailed', { executionId: execution.id, error }, now)
      if (runFailed) this.appendEvent(execution.runId, 'RunFailed', { executionId: execution.id, error }, now)
    })
  }

  private blockExecution(execution: Execution, reason: string, details: NumenValue): void {
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE executions SET status = 'BLOCKED', blocked_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'RUNNABLE'
      `).run(reason, now, execution.id)
      if (!result.changes) return
      this.appendEvent(execution.runId, 'ExecutionBlocked', { executionId: execution.id, reason, details }, now)
    })
  }

  private suspendTimer(
    execution: Execution,
    instruction: Extract<CoreInstruction, { op: 'suspend' }>,
    bindings: EvaluationBindings,
  ): void {
    const nowMs = Date.now()
    let wakeAtMs: number
    if (instruction.config.durationMs) {
      const duration = evaluateExpression(instruction.config.durationMs, bindings)
      if (typeof duration !== 'number' || duration < 0) throw new Error('timer duration must be a non-negative number')
      wakeAtMs = nowMs + duration
    } else if (instruction.config.until) {
      const until = evaluateExpression(instruction.config.until, bindings)
      if (typeof until !== 'string') throw new Error('timer until must evaluate to an ISO date string')
      wakeAtMs = Date.parse(until)
      if (!Number.isFinite(wakeAtMs)) throw new Error('timer until is not a valid date')
    } else {
      throw new Error('timer has no wake source')
    }
    const wakeAt = new Date(wakeAtMs).toISOString()
    const now = new Date(nowMs).toISOString()
    this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE executions SET status = 'WAITING', wake_at = ?, updated_at = ?
        WHERE id = ? AND status = 'RUNNABLE'
      `).run(wakeAt, now, execution.id)
      if (!result.changes) return
      this.appendEvent(execution.runId, 'ExecutionWaiting', { executionId: execution.id, wakeAt }, now)
    })
  }

  private resumeDueTimers(): number {
    const now = new Date().toISOString()
    const rows = this.ctx.database.db.prepare(`
      SELECT * FROM executions
      WHERE status = 'WAITING' AND wake_at IS NOT NULL AND wake_at <= ?
      ORDER BY wake_at, id
    `).all(now) as ExecutionRow[]
    let count = 0
    for (const row of rows) {
      const execution = mapExecution(row)
      if (row.blocked_reason === 'RETRY_BACKOFF') {
        const changed = this.ctx.database.transaction(() => {
          const result = this.ctx.database.db.prepare(`
            UPDATE executions
            SET status = 'RUNNABLE', blocked_reason = NULL, wake_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'WAITING' AND blocked_reason = 'RETRY_BACKOFF'
          `).run(now, execution.id)
          if (!result.changes) return false
          this.appendEvent(execution.runId, 'ExecutionRetryReady', { executionId: execution.id }, now)
          return true
        })
        if (changed) count += 1
        continue
      }
      const { instruction } = this.getRevisionForExecution(execution)
      if (instruction.op !== 'suspend') continue
      const changed = this.ctx.database.transaction(() => {
        const result = this.ctx.database.db.prepare(`
          UPDATE executions SET status = 'COMPLETED', output_json = 'null', updated_at = ?
          WHERE id = ? AND status = 'WAITING'
        `).run(now, execution.id)
        if (!result.changes) return false
        this.appendEvent(execution.runId, 'ExecutionResumed', { executionId: execution.id }, now)
        if (instruction.next) this.createSuccessor(execution, instruction.next)
        return true
      })
      if (changed) count += 1
    }
    return count
  }

  private reconcileBlockedExecutions(): number {
    const rows = this.ctx.database.db.prepare(`
      SELECT * FROM executions
      WHERE status = 'BLOCKED' AND blocked_reason = 'PROVIDER_UNAVAILABLE'
      ORDER BY updated_at, id
    `).all() as ExecutionRow[]
    let count = 0
    for (const row of rows) {
      const execution = mapExecution(row)
      const { instruction } = this.getRevisionForExecution(execution)
      if (instruction.op !== 'invoke' || !this.ctx.capabilities.resolveProvider(instruction.capability)) continue
      const now = new Date().toISOString()
      const changed = this.ctx.database.transaction(() => {
        const result = this.ctx.database.db.prepare(`
          UPDATE executions SET status = 'RUNNABLE', blocked_reason = NULL, updated_at = ?
          WHERE id = ? AND status = 'BLOCKED' AND blocked_reason = 'PROVIDER_UNAVAILABLE'
        `).run(now, execution.id)
        if (!result.changes) return false
        this.appendEvent(execution.runId, 'ExecutionUnblocked', { executionId: execution.id }, now)
        return true
      })
      if (changed) count += 1
    }
    return count
  }

  private propagateCancellation(runId: string, reason: CancellationReason): boolean {
    for (const active of this.activeInvocations.values()) {
      if (active.runId === runId && !active.controller.signal.aborted) {
        active.controller.abort(new InvocationCancelledError(reason))
      }
    }
    const rows = this.ctx.database.db.prepare(`
      SELECT * FROM executions
      WHERE run_id = ? AND status IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'CANCELLING')
      ORDER BY created_at, id
    `).all(runId) as ExecutionRow[]
    const now = new Date().toISOString()
    return this.ctx.database.transaction(() => {
      this.ctx.database.db.prepare(`
        UPDATE attempts
        SET status = 'ABORTED', error_json = ?, finished_at = ?
        WHERE status = 'RUNNING' AND execution_id IN (
          SELECT id FROM executions WHERE run_id = ?
        )
      `).run(JSON.stringify({ reason }), now, runId)
      this.ctx.database.db.prepare(`
        UPDATE execution_iterations SET status = 'CANCELLED', updated_at = ?
        WHERE status IN ('PENDING', 'RUNNING') AND iterate_execution_id IN (
          SELECT id FROM executions WHERE run_id = ?
        )
      `).run(now, runId)
      for (const row of rows) {
        const result = this.ctx.database.db.prepare(`
          UPDATE executions
          SET status = 'CANCELLED', blocked_reason = NULL, wake_at = NULL, updated_at = ?
          WHERE id = ? AND status IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'CANCELLING')
        `).run(now, row.id)
        if (result.changes) {
          this.appendEvent(runId, 'ExecutionCancelled', { executionId: row.id, reason }, now)
        }
      }
      const result = this.ctx.database.db.prepare(`
        UPDATE runs SET status = 'CANCELLED', cancel_reason = ?, finished_at = ?
        WHERE id = ? AND status = 'CANCELLING'
      `).run(reason, now, runId)
      if (!result.changes) return false
      this.appendEvent(runId, 'RunCancelled', { reason }, now)
      return true
    })
  }

  private reconcileCancellations(): number {
    const rows = this.ctx.database.db.prepare(`
      SELECT id, cancel_reason FROM runs WHERE status = 'CANCELLING' ORDER BY created_at, id
    `).all() as Array<{ id: string; cancel_reason: CancellationReason | null }>
    let count = 0
    for (const row of rows) {
      if (this.propagateCancellation(row.id, row.cancel_reason ?? 'USER')) count += 1
    }
    return count
  }

  private recoverCancellations(): void {
    this.reconcileCancellations()
  }

  private recoverInterruptedWork(): void {
    const attempts = this.ctx.database.db.prepare(`
      SELECT attempts.*, executions.run_id, executions.instruction_id
      FROM attempts
      JOIN executions ON executions.id = attempts.execution_id
      JOIN runs ON runs.id = executions.run_id
      WHERE attempts.status = 'RUNNING' AND executions.status = 'RUNNING' AND runs.status = 'RUNNING'
      ORDER BY attempts.started_at, attempts.id
    `).all() as Array<AttemptRow & { run_id: string; instruction_id: string }>

    for (const attempt of attempts) {
      const run = this.getRun(attempt.run_id)
      const revision = run ? this.ctx.automations.getRevision(run.revisionId) : undefined
      const instruction = revision?.compiledPlan.instructions[attempt.instruction_id]
      const contract = instruction?.op === 'invoke'
        ? revision?.contractSnapshot.capabilities.find(item => capabilityKey(item) === capabilityKey(instruction.capability))
        : undefined
      const retrySafe = contract?.semantics.retrySafe ?? false
      const now = new Date().toISOString()
      this.ctx.database.transaction(() => {
        this.ctx.database.db.prepare(`
          UPDATE attempts SET status = ?, finished_at = ? WHERE id = ? AND status = 'RUNNING'
        `).run(retrySafe ? 'INTERRUPTED' : 'OUTCOME_UNKNOWN', now, attempt.id)
        this.ctx.database.db.prepare(`
          UPDATE executions SET status = ?, blocked_reason = ?, updated_at = ?
          WHERE id = ? AND status = 'RUNNING'
        `).run(retrySafe ? 'RUNNABLE' : 'BLOCKED', retrySafe ? null : 'OUTCOME_UNKNOWN', now, attempt.execution_id)
        this.appendEvent(attempt.run_id, retrySafe ? 'AttemptInterrupted' : 'AttemptOutcomeUnknown', {
          attemptId: attempt.id,
          executionId: attempt.execution_id,
          retrySafe,
        }, now)
      })
    }

    const internal = this.ctx.database.db.prepare(`
      SELECT executions.* FROM executions
      JOIN runs ON runs.id = executions.run_id
      WHERE executions.status = 'RUNNING' AND runs.status = 'RUNNING'
        AND NOT EXISTS (
          SELECT 1 FROM attempts
          WHERE attempts.execution_id = executions.id AND attempts.status = 'RUNNING'
        )
    `).all() as ExecutionRow[]
    for (const row of internal) {
      const now = new Date().toISOString()
      this.ctx.database.transaction(() => {
        this.ctx.database.db.prepare(`
          UPDATE executions SET status = 'RUNNABLE', updated_at = ?
          WHERE id = ? AND status = 'RUNNING'
        `).run(now, row.id)
        this.appendEvent(row.run_id, 'ExecutionRecovered', { executionId: row.id }, now)
      })
    }
  }

  private recoverStructuredScopes(): void {
    const rows = this.ctx.database.db.prepare(`
      SELECT * FROM executions
      WHERE status = 'WAITING' AND blocked_reason IN ('CHILDREN', 'ITERATIONS')
      ORDER BY created_at, id
    `).all() as ExecutionRow[]
    const now = new Date().toISOString()
    for (const row of rows) {
      const fork = mapExecution(row)
      const { revision, instruction } = this.getRevisionForExecution(fork)
      this.ctx.database.transaction(() => {
        if (instruction.op === 'iterate') {
          this.reconcileIterate(fork, instruction, now)
          return
        }
        if (instruction.op !== 'fork') return
        if (instruction.mode === 'all') {
          this.reconcileAllFork(row.id, now)
          return
        }
        const completed = this.ctx.database.db.prepare(`
          SELECT * FROM executions
          WHERE scope_execution_id = ? AND status = 'COMPLETED'
          ORDER BY updated_at, id
        `).all(row.id) as ExecutionRow[]
        const winner = completed.find(candidate => (
          revision.compiledPlan.instructions[candidate.instruction_id]?.op === 'scope_complete'
        ))
        if (winner) this.reconcileRaceFork(row.id, mapExecution(winner), now)
      })
    }
  }

  private createSuccessor(execution: Execution, instructionId: string): string {
    return this.createExecution(
      execution.runId,
      instructionId,
      execution.id,
      execution.scopeExecutionId,
      execution.scopeBranch,
      execution.loopItem,
      execution.loopIndex,
    )
  }

  private forkAll(
    execution: Execution,
    instruction: Extract<CoreInstruction, { op: 'fork' }>,
  ): void {
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE executions
        SET status = 'WAITING', blocked_reason = 'CHILDREN', updated_at = ?
        WHERE id = ? AND status = 'RUNNABLE'
      `).run(now, execution.id)
      if (!result.changes) return
      this.appendEvent(execution.runId, 'ExecutionForked', {
        executionId: execution.id,
        mode: instruction.mode,
        branches: instruction.branches,
      }, now)
      for (const [branchIndex, branch] of instruction.branches.entries()) {
        this.createExecution(
          execution.runId,
          branch,
          execution.id,
          execution.id,
          branchIndex,
          execution.loopItem,
          execution.loopIndex,
        )
      }
    })
  }

  private beginIterate(
    execution: Execution,
    instruction: Extract<CoreInstruction, { op: 'iterate' }>,
    bindings: EvaluationBindings,
  ): void {
    const items = evaluateExpression(instruction.items, bindings)
    if (!Array.isArray(items)) throw new Error('ForEach items must evaluate to an array')
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE executions
        SET status = 'WAITING', blocked_reason = 'ITERATIONS', resolved_input_json = ?, updated_at = ?
        WHERE id = ? AND status = 'RUNNABLE'
      `).run(JSON.stringify(items), now, execution.id)
      if (!result.changes) return
      const insert = this.ctx.database.db.prepare(`
        INSERT INTO execution_iterations (
          iterate_execution_id, item_index, item_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'PENDING', ?, ?)
      `)
      items.forEach((item, index) => insert.run(execution.id, index, JSON.stringify(item), now, now))
      this.appendEvent(execution.runId, 'ExecutionIterationStarted', {
        executionId: execution.id,
        itemCount: items.length,
        concurrency: instruction.concurrency,
      }, now)
      this.reconcileIterate(execution, instruction, now)
    })
  }

  private reconcileIterate(
    iterate: Execution,
    instruction: Extract<CoreInstruction, { op: 'iterate' }>,
    now: string,
  ): void {
    const current = this.getExecutionRow(iterate.id)
    if (!current || current.status !== 'WAITING' || current.blocked_reason !== 'ITERATIONS') return
    const { running } = this.ctx.database.db.prepare(`
      SELECT COUNT(*) AS running FROM execution_iterations
      WHERE iterate_execution_id = ? AND status = 'RUNNING'
    `).get(iterate.id) as { running: number }
    const capacity = Math.max(0, instruction.concurrency - running)
    if (capacity) {
      const pending = this.ctx.database.db.prepare(`
        SELECT * FROM execution_iterations
        WHERE iterate_execution_id = ? AND status = 'PENDING'
        ORDER BY item_index LIMIT ?
      `).all(iterate.id, capacity) as IterationRow[]
      for (const item of pending) {
        const claimed = this.ctx.database.db.prepare(`
          UPDATE execution_iterations SET status = 'RUNNING', updated_at = ?
          WHERE iterate_execution_id = ? AND item_index = ? AND status = 'PENDING'
        `).run(now, iterate.id, item.item_index)
        if (!claimed.changes) continue
        const value = parseJson<NumenValue>(item.item_json)
        const rootExecutionId = this.createExecution(
          iterate.runId,
          instruction.body,
          iterate.id,
          iterate.id,
          item.item_index,
          value,
          item.item_index,
        )
        this.ctx.database.db.prepare(`
          UPDATE execution_iterations SET root_execution_id = ?, updated_at = ?
          WHERE iterate_execution_id = ? AND item_index = ?
        `).run(rootExecutionId, now, iterate.id, item.item_index)
        this.appendEvent(iterate.runId, 'ExecutionIterationDispatched', {
          executionId: iterate.id,
          itemIndex: item.item_index,
          rootExecutionId,
        }, now)
      }
    }
    const counts = this.ctx.database.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running,
        COUNT(*) AS total
      FROM execution_iterations WHERE iterate_execution_id = ?
    `).get(iterate.id) as { pending: number | null; running: number | null; total: number }
    if ((counts.pending ?? 0) || (counts.running ?? 0)) return
    const output = { count: counts.total }
    const completed = this.ctx.database.db.prepare(`
      UPDATE executions
      SET status = 'COMPLETED', blocked_reason = NULL, output_json = ?, updated_at = ?
      WHERE id = ? AND status = 'WAITING' AND blocked_reason = 'ITERATIONS'
    `).run(JSON.stringify(output), now, iterate.id)
    if (!completed.changes) return
    this.appendEvent(iterate.runId, 'ExecutionIterationCompleted', {
      executionId: iterate.id,
      itemCount: counts.total,
    }, now)
    this.createExecution(
      iterate.runId,
      instruction.join,
      iterate.id,
      iterate.scopeExecutionId,
      iterate.scopeBranch,
      iterate.loopItem,
      iterate.loopIndex,
    )
  }

  private completeScope(execution: Execution): void {
    if (!execution.scopeExecutionId) {
      this.failExecution(execution, { code: 'SCOPE_PARENT_MISSING' })
      return
    }
    const now = new Date().toISOString()
    this.ctx.database.transaction(() => {
      const result = this.ctx.database.db.prepare(`
        UPDATE executions SET status = 'COMPLETED', output_json = 'null', updated_at = ?
        WHERE id = ? AND status = 'RUNNABLE'
      `).run(now, execution.id)
      if (!result.changes) return
      this.appendEvent(execution.runId, 'ExecutionScopeCompleted', {
        executionId: execution.id,
        scopeExecutionId: execution.scopeExecutionId!,
      }, now)
      const forkRow = this.ctx.database.db.prepare('SELECT * FROM executions WHERE id = ?')
        .get(execution.scopeExecutionId) as ExecutionRow | undefined
      if (!forkRow) return
      const { instruction } = this.getRevisionForExecution(mapExecution(forkRow))
      if (instruction.op === 'fork') {
        if (instruction.mode === 'all') this.reconcileAllFork(execution.scopeExecutionId!, now)
        else this.reconcileRaceFork(execution.scopeExecutionId!, execution, now)
        return
      }
      if (instruction.op === 'iterate') {
        if (execution.scopeBranch === undefined) return
        const updated = this.ctx.database.db.prepare(`
          UPDATE execution_iterations
          SET status = 'COMPLETED', terminal_execution_id = ?, updated_at = ?
          WHERE iterate_execution_id = ? AND item_index = ? AND status = 'RUNNING'
        `).run(execution.id, now, execution.scopeExecutionId, execution.scopeBranch)
        if (!updated.changes) return
        this.appendEvent(execution.runId, 'ExecutionIterationItemCompleted', {
          executionId: execution.scopeExecutionId!,
          itemIndex: execution.scopeBranch,
          terminalExecutionId: execution.id,
        }, now)
        this.reconcileIterate(mapExecution(forkRow), instruction, now)
      }
    })
  }

  private reconcileAllFork(forkExecutionId: string, now: string): void {
    const forkRow = this.ctx.database.db.prepare(`
      SELECT * FROM executions WHERE id = ?
    `).get(forkExecutionId) as ExecutionRow | undefined
    if (!forkRow || forkRow.status !== 'WAITING' || forkRow.blocked_reason !== 'CHILDREN') return
    const { remaining } = this.ctx.database.db.prepare(`
      SELECT COUNT(*) AS remaining FROM executions
      WHERE scope_execution_id = ? AND status != 'COMPLETED'
    `).get(forkExecutionId) as { remaining: number }
    if (remaining) return
    const fork = mapExecution(forkRow)
    const { instruction } = this.getRevisionForExecution(fork)
    if (instruction.op !== 'fork' || instruction.mode !== 'all') return
    const result = this.ctx.database.db.prepare(`
      UPDATE executions
      SET status = 'COMPLETED', blocked_reason = NULL, output_json = 'null', updated_at = ?
      WHERE id = ? AND status = 'WAITING' AND blocked_reason = 'CHILDREN'
    `).run(now, forkExecutionId)
    if (!result.changes) return
    this.appendEvent(fork.runId, 'ExecutionJoined', {
      executionId: fork.id,
      mode: 'all',
    }, now)
    this.createExecution(
      fork.runId,
      instruction.join,
      fork.id,
      fork.scopeExecutionId,
      fork.scopeBranch,
      fork.loopItem,
      fork.loopIndex,
    )
  }

  private reconcileRaceFork(forkExecutionId: string, winner: Execution, now: string): void {
    if (winner.scopeBranch === undefined) return
    const forkRow = this.ctx.database.db.prepare('SELECT * FROM executions WHERE id = ?')
      .get(forkExecutionId) as ExecutionRow | undefined
    if (!forkRow || forkRow.status !== 'WAITING' || forkRow.blocked_reason !== 'CHILDREN') return
    const fork = mapExecution(forkRow)
    const { instruction } = this.getRevisionForExecution(fork)
    if (instruction.op !== 'fork' || instruction.mode !== 'first_success') return
    const output = { winnerBranch: winner.scopeBranch, winnerExecutionId: winner.id }
    const result = this.ctx.database.db.prepare(`
      UPDATE executions
      SET status = 'COMPLETED', blocked_reason = NULL, output_json = ?, updated_at = ?
      WHERE id = ? AND status = 'WAITING' AND blocked_reason = 'CHILDREN'
    `).run(JSON.stringify(output), now, forkExecutionId)
    if (!result.changes) return
    this.cancelScopeExecutions(forkExecutionId, fork.runId, 'RACE', now, {
      excludeBranch: winner.scopeBranch,
    })
    this.appendEvent(fork.runId, 'ExecutionRaceWon', {
      executionId: fork.id,
      winnerBranch: winner.scopeBranch,
      winnerExecutionId: winner.id,
    }, now)
    this.appendEvent(fork.runId, 'ExecutionJoined', { executionId: fork.id, mode: 'first_success' }, now)
    this.createExecution(
      fork.runId,
      instruction.join,
      fork.id,
      fork.scopeExecutionId,
      fork.scopeBranch,
      fork.loopItem,
      fork.loopIndex,
    )
  }

  private handleStructuredFailure(execution: Execution, now: string, error: NumenValue): boolean {
    if (!execution.scopeExecutionId) return true
    const forkRow = this.ctx.database.db.prepare('SELECT * FROM executions WHERE id = ?')
      .get(execution.scopeExecutionId) as ExecutionRow | undefined
    if (!forkRow) return true
    const fork = mapExecution(forkRow)
    const { instruction } = this.getRevisionForExecution(fork)
    if (instruction.op === 'iterate') {
      if (execution.scopeBranch === undefined) return true
      this.ctx.database.db.prepare(`
        UPDATE execution_iterations
        SET status = 'FAILED', error_json = ?, updated_at = ?
        WHERE iterate_execution_id = ? AND item_index = ? AND status = 'RUNNING'
      `).run(JSON.stringify(error), now, fork.id, execution.scopeBranch)
      this.cancelScopeExecutions(fork.id, execution.runId, 'PARENT', now)
      this.ctx.database.db.prepare(`
        UPDATE execution_iterations
        SET status = 'CANCELLED', updated_at = ?
        WHERE iterate_execution_id = ? AND status IN ('PENDING', 'RUNNING')
      `).run(now, fork.id)
      const result = this.ctx.database.db.prepare(`
        UPDATE executions
        SET status = 'FAILED', blocked_reason = NULL, output_json = ?, updated_at = ?
        WHERE id = ? AND status = 'WAITING' AND blocked_reason = 'ITERATIONS'
      `).run(JSON.stringify(error), now, fork.id)
      if (result.changes) {
        this.appendEvent(execution.runId, 'ExecutionIterationFailed', {
          executionId: fork.id,
          itemIndex: execution.scopeBranch,
          failedExecutionId: execution.id,
          error,
        }, now)
      }
      return this.handleStructuredFailure(fork, now, error)
    }
    if (instruction.op !== 'fork') return true

    if (instruction.mode === 'first_success') {
      if (execution.scopeBranch === undefined) return true
      this.cancelScopeExecutions(fork.id, execution.runId, 'PARENT', now, {
        includeBranch: execution.scopeBranch,
      })
      this.appendEvent(execution.runId, 'ExecutionRaceBranchFailed', {
        executionId: fork.id,
        branch: execution.scopeBranch ?? -1,
        failedExecutionId: execution.id,
        error,
      }, now)
      const { failedBranches } = this.ctx.database.db.prepare(`
        SELECT COUNT(DISTINCT scope_branch) AS failedBranches FROM executions
        WHERE scope_execution_id = ? AND status IN ('FAILED', 'TIMED_OUT')
      `).get(fork.id) as { failedBranches: number }
      if (failedBranches < instruction.branches.length) return false
    } else {
      this.cancelScopeExecutions(fork.id, execution.runId, 'PARENT', now)
    }

    const result = this.ctx.database.db.prepare(`
      UPDATE executions
      SET status = 'FAILED', blocked_reason = NULL, output_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED')
    `).run(JSON.stringify(error), now, fork.id)
    if (result.changes) {
      this.appendEvent(execution.runId, 'ExecutionScopeFailed', {
        executionId: fork.id,
        failedExecutionId: execution.id,
        error,
      }, now)
    }
    return this.handleStructuredFailure(fork, now, error)
  }

  private cancelScopeExecutions(
    scopeExecutionId: string,
    runId: string,
    reason: 'PARENT' | 'RACE',
    now: string,
    filter: { includeBranch?: number; excludeBranch?: number } = {},
  ): void {
    const rows = this.ctx.database.db.prepare(`
      WITH RECURSIVE descendants(id, root_branch) AS (
        SELECT id, scope_branch FROM executions WHERE scope_execution_id = ?
        UNION ALL
        SELECT executions.id, descendants.root_branch FROM executions
        JOIN descendants ON executions.scope_execution_id = descendants.id
      )
      SELECT executions.*, descendants.root_branch FROM executions
      JOIN descendants ON descendants.id = executions.id
      WHERE executions.status IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'CANCELLING')
    `).all(scopeExecutionId) as Array<ExecutionRow & { root_branch: number | null }>
    for (const row of rows) {
      if (filter.includeBranch !== undefined && row.root_branch !== filter.includeBranch) continue
      if (filter.excludeBranch !== undefined && row.root_branch === filter.excludeBranch) continue
      const active = this.activeInvocations.get(row.id)
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(new InvocationCancelledError(reason))
      }
      this.ctx.database.db.prepare(`
        UPDATE attempts SET status = 'ABORTED', error_json = ?, finished_at = ?
        WHERE execution_id = ? AND status = 'RUNNING'
      `).run(JSON.stringify({ reason }), now, row.id)
      const result = this.ctx.database.db.prepare(`
        UPDATE executions
        SET status = 'CANCELLED', blocked_reason = NULL, wake_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'CANCELLING')
      `).run(now, row.id)
      this.ctx.database.db.prepare(`
        UPDATE execution_iterations SET status = 'CANCELLED', updated_at = ?
        WHERE iterate_execution_id = ? AND status IN ('PENDING', 'RUNNING')
      `).run(now, row.id)
      if (result.changes) {
        this.appendEvent(runId, 'ExecutionCancelled', { executionId: row.id, reason }, now)
      }
    }
  }

  private commitOutputResources(execution: Execution, output: NumenValue): void {
    const resourceIds = new Set<string>()
    const visit = (value: NumenValue): void => {
      if (isResourceRef(value)) {
        resourceIds.add(value.$resource)
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) visit(item)
      }
    }
    visit(output)
    for (const resourceId of resourceIds) {
      this.ctx.resources.commitOwner(resourceId, { type: 'execution', id: execution.id })
    }
  }
}

export default SchedulerService
