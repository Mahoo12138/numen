import type { ConsoleProcedureRef } from '@numen/console'

export const workbenchHomeOverviewQueryRef = {
  id: 'numen:home-overview',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED'

export interface WorkbenchHomeAutomation {
  id: string
  name: string
  enabled: boolean
  updatedAt: string
}

export interface WorkbenchHomeRun {
  id: string
  automationId: string
  automationName: string
  status: WorkbenchRunStatus
  createdAt: string
  finishedAt?: string
}

export interface WorkbenchHomeOverview {
  automations: {
    total: number
    enabled: number
    recent: WorkbenchHomeAutomation[]
  }
  runs: {
    queued: number
    active: number
    recent: WorkbenchHomeRun[]
  }
  connections: {
    ready: boolean
    total: number
    enabled: number
    runtimeReady: number
    unavailable: number
    errors: number
  }
}

export const workbenchRunsIndexQueryRef = {
  id: 'numen:runs-index',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchRunsCursor = string

export interface WorkbenchRunsQueryInput {
  limit: number
  cursor?: WorkbenchRunsCursor
}

export interface WorkbenchRunIndexItem extends WorkbenchHomeRun {
  revisionId: string
  startedAt?: string
  executionCount: number
  attemptCount: number
}

export interface WorkbenchRunsIndex {
  summary: {
    total: number
    queued: number
    active: number
    completed: number
    failed: number
    cancelled: number
  }
  items: WorkbenchRunIndexItem[]
  nextCursor?: WorkbenchRunsCursor
}

export const workbenchConnectionsIndexQueryRef = {
  id: 'numen:connections-index',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchConnectionStatus =
  | 'DISABLED'
  | 'UNAVAILABLE'
  | 'STOPPED'
  | 'STARTING'
  | 'READY'
  | 'ERROR'
  | 'STOPPING'

export interface WorkbenchConnectionIndexItem {
  id: string
  name: string
  adapterId: string
  adapterVersion: number
  adapterTitle: string
  enabled: boolean
  adapterAvailable: boolean
  credentialBound: boolean
  status: WorkbenchConnectionStatus
  statusDetail: string
  generation: number
  createdAt: string
  updatedAt: string
}

export interface WorkbenchConnectionsIndex {
  summary: {
    total: number
    enabled: number
    ready: number
    unavailable: number
    errors: number
  }
  items: WorkbenchConnectionIndexItem[]
}
