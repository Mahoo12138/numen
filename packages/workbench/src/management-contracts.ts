import type { ConsoleProcedureRef } from '@numenjs/console'
import type { HostRegistrationDiagnosis } from '@numenjs/config'

export const workbenchPluginsQueryRef = { id: 'numen:plugins', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchPluginPreviewRef = { id: 'numen:plugin-preview', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchPluginApplyRef = { id: 'numen:plugin-apply', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchSystemQueryRef = { id: 'numen:system', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchConnectionUsageRef = { id: 'numen:connection-usage', version: 1 } as const satisfies ConsoleProcedureRef
export const workbenchPluginOwnershipRef = { id: 'numen:plugin-ownership', version: 1 } as const satisfies ConsoleProcedureRef

export type WorkbenchOwnershipInput = { kind: 'connection'; connectionId: string }
  | { kind: 'execution'; runId: string; executionId: string }
  | { kind: 'capability'; id: string; version: number }
export interface WorkbenchOwnershipResult { registrations: HostRegistrationDiagnosis[]; missingConnectionIds: string[] }

export interface WorkbenchSystemCheck {
  id: 'storage' | 'scheduler' | 'triggers' | 'connections' | 'logs'
  status: 'ready' | 'attention' | 'unavailable'
  values: Record<string, number | string | boolean>
}
export interface WorkbenchSystemOverview { observedAt: string; checks: WorkbenchSystemCheck[] }
export interface WorkbenchConnectionUsage {
  connectionId: string
  automations: Array<{ id: string; name: string; draft: boolean; active: boolean }>
  /** Extension controls may resolve bindings dynamically. */
  complete: boolean
}
