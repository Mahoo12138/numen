import type { NumenValue } from './value.js'

export type RunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED'

export type ExecutionStatus =
  | 'RUNNABLE'
  | 'RUNNING'
  | 'WAITING'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'TIMED_OUT'

export type AttemptStatus =
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'ABORTED'
  | 'INTERRUPTED'
  | 'OUTCOME_UNKNOWN'

export type CancellationReason =
  | 'USER'
  | 'PARENT'
  | 'RACE'
  | 'TIMEOUT'
  | 'PROVIDER_DISPOSED'
  | 'CONNECTION_DISPOSED'
  | 'RECONFIGURED'
  | 'SHUTDOWN'
  | 'CREDENTIAL_ROTATED'

export interface Run {
  id: string
  automationId: string
  revisionId: string
  status: RunStatus
  trigger: NumenValue
  input: Record<string, NumenValue>
  groupKey?: string
  cancelReason?: CancellationReason
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface Execution {
  id: string
  runId: string
  instructionId: string
  parentExecutionId?: string
  scopeExecutionId?: string
  status: ExecutionStatus
  resolvedInput?: NumenValue
  output?: NumenValue
  wakeAt?: string
  blockedReason?: string
  generation: number
  createdAt: string
  updatedAt: string
}

export interface Attempt {
  id: string
  executionId: string
  number: number
  status: AttemptStatus
  providerRef: string
  error?: NumenValue
  startedAt: string
  finishedAt?: string
}

export interface RunEvent {
  runId: string
  sequence: number
  type: string
  payload: NumenValue
  occurredAt: string
}
