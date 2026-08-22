import type { ConsoleProcedureRef } from '@numen/console'
import type { AutomationSource, CapabilityRef, NumenValue } from '@numen/core'

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

export const workbenchInvalidationSubscriptionRef = {
  id: 'numen:workbench-invalidation',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchInvalidationScope = 'home' | 'automations' | 'automationCatalog' | 'runs' | 'connections'

export interface WorkbenchInvalidationEvent {
  scopes: WorkbenchInvalidationScope[]
}

export const workbenchAutomationsIndexQueryRef = {
  id: 'numen:automations-index',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchAutomationIndexItem {
  id: string
  name: string
  enabled: boolean
  activeRevisionId?: string
  activationGeneration: number
  draftVersion: number
  revisionCount: number
  latestRevisionNumber?: number
  createdAt: string
  updatedAt: string
}

export interface WorkbenchAutomationsIndex {
  summary: {
    total: number
    enabled: number
    published: number
  }
  items: WorkbenchAutomationIndexItem[]
}

export const workbenchAutomationDetailQueryRef = {
  id: 'numen:automation-detail',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchAutomationDetailQueryInput {
  automationId: string
}

export interface WorkbenchAutomationIdentity {
  id: string
  name: string
  enabled: boolean
  activeRevisionId?: string
  activationGeneration: number
  createdAt: string
  updatedAt: string
}

export interface WorkbenchAutomationDraft {
  baseRevisionId?: string
  source: AutomationSource
  presentation: Record<string, NumenValue>
  version: number
  updatedAt: string
}

export interface WorkbenchAutomationRevisionSummary {
  id: string
  number: number
  contentHash: string
  active: boolean
  createdAt: string
}

export interface WorkbenchAutomationDetail {
  automation: WorkbenchAutomationIdentity
  draft: WorkbenchAutomationDraft
  revisions: WorkbenchAutomationRevisionSummary[]
}

export const workbenchAutomationInsertCatalogQueryRef = {
  id: 'numen:automation-insert-catalog',
  version: 1,
} as const satisfies ConsoleProcedureRef

export type WorkbenchAutomationControlKind = 'wait' | 'if' | 'parallel' | 'race' | 'foreach'

export type WorkbenchAutomationInputFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'json'

export interface WorkbenchAutomationInputOption {
  label: string
  value: NumenValue
}

export interface WorkbenchAutomationInputField {
  name: string
  label: string
  type: WorkbenchAutomationInputFieldType
  schemaType: string
  required: boolean
  description?: string
  role?: string
  defaultValue?: NumenValue
  options?: WorkbenchAutomationInputOption[]
  min?: number
  max?: number
  step?: number
}

export interface WorkbenchAutomationConnectionSlot {
  name: string
  required: boolean
  accepts: string[]
}

export interface WorkbenchAutomationConnectionOption {
  id: string
  name: string
  adapterId: string
  adapterVersion: number
  enabled: boolean
  adapterAvailable: boolean
  status: WorkbenchConnectionStatus
}

export type WorkbenchAutomationInsertItem =
  | {
    kind: 'control'
    control: WorkbenchAutomationControlKind
    title: string
    description: string
  }
  | {
    kind: 'capability'
    capability: CapabilityRef
    capabilityKind: 'query' | 'action'
    title: string
    description?: string
    providerAvailable: boolean
    connectionSlots: string[]
    connectionRequirements: WorkbenchAutomationConnectionSlot[]
    inputFields: WorkbenchAutomationInputField[]
    inputSchemaSupported: boolean
  }

export interface WorkbenchAutomationInsertCatalog {
  items: WorkbenchAutomationInsertItem[]
  connections: WorkbenchAutomationConnectionOption[]
}

export const workbenchSaveAutomationDraftActionRef = {
  id: 'numen:automation-save-draft',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchSaveAutomationDraftInput {
  automationId: string
  expectedVersion: number
  source: AutomationSource
  presentation: Record<string, NumenValue>
}

export interface WorkbenchSaveAutomationDraftResult {
  draft: WorkbenchAutomationDraft
}

export const workbenchPublishAutomationDraftActionRef = {
  id: 'numen:automation-publish-draft',
  version: 1,
} as const satisfies ConsoleProcedureRef

export interface WorkbenchPublishAutomationDraftInput {
  automationId: string
  expectedVersion: number
}

export interface WorkbenchPublishAutomationDraftResult {
  draft: WorkbenchAutomationDraft
  revision: WorkbenchAutomationRevisionSummary
}
