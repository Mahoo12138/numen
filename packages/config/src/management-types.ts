export type HostPluginState = 'ACTIVE' | 'PENDING' | 'LOADING' | 'FAILED' | 'DISPOSED' | 'UNLOADING' | 'DISABLED' | 'UNLOADED'

export interface HostInternalPlugin {
  diagnosticId: string
  name: string
  state: HostPluginState
  dependencies: string[]
  ownerEntryId: string
}

/** Bounded display metadata only. Host validation remains authoritative. */
export interface HostConfigSchemaNode {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'json'
  required: boolean
  /** Defaults are intentionally withheld and must never be materialized by the editor. */
  hasDefault?: true
  description?: string
  min?: number
  max?: number
  step?: number
  options?: Array<{ label: string; value: string | number | boolean | null }>
  fields?: HostConfigSchemaField[]
  item?: HostConfigSchemaNode
  fallbackReason?: 'unsupported' | 'cycle' | 'limit' | 'unsafe-metadata'
}

export interface HostConfigSchemaField extends HostConfigSchemaNode {
  name: string
  label: string
}

export interface HostPluginEntry {
  id: string
  key: string
  name: string
  packageName: string
  packageVersion: string | null
  installed: boolean | null
  parentId?: string
  group: boolean
  label?: string
  collapsed?: boolean
  selfEnabled: boolean
  effectiveEnabled: boolean
  actualState: HostPluginState
  children?: string[]
  config: Record<string, unknown>
  configEditable: boolean
  configSchema?: HostConfigSchemaNode
  configReadOnlyReason?: string
  protected: boolean
  internal: HostInternalPlugin[]
}

export interface HostConfigSnapshot {
  fingerprint: string
  version: 1 | 2
  writable: boolean
  readOnlyReason?: string
  safeMode: boolean
  entries: HostPluginEntry[]
  /** True when on-disk desired state differs from the last application attempted by this host. */
  restartRequired: boolean
}

export type HostConfigOperation =
  | { kind: 'setEnabled'; id: string; enabled: boolean }
  | { kind: 'setLabel'; id: string; label: string }
  | { kind: 'setCollapsed'; id: string; collapsed: boolean }
  | { kind: 'createGroup'; id: string; label?: string; parentId?: string }
  | { kind: 'move'; id: string; parentId?: string }
  | { kind: 'removeGroup'; id: string }
  | { kind: 'setConfig'; id: string; config: Record<string, unknown> }

export interface HostConfigMutationRequest {
  fingerprint: string
  operation: HostConfigOperation
}

export interface HostConfigImpact {
  status: 'unknown'
  message: string
  /** Potentially related objects, not a complete dependency proof. */
  connections: string[]
  capabilities: string[]
  triggers: string[]
  automations: string[]
}

export interface HostConfigPreview {
  fingerprint: string
  operation: HostConfigOperation
  affectedEntryIds: string[]
  impact: HostConfigImpact
  blockedReason?: string
}

export interface HostConfigMutationResult {
  saved: boolean
  runtimeApplied: boolean
  fingerprint: string
  restartRequired: boolean
  snapshot: HostConfigSnapshot
  error?: { code: string; message: string }
}

export interface HostConfigService {
  read(): Promise<HostConfigSnapshot>
  preview(input: HostConfigMutationRequest): Promise<HostConfigPreview>
  apply(input: HostConfigMutationRequest): Promise<HostConfigMutationResult>
  diagnose(refs: HostRegistrationRef[]): Promise<HostRegistrationDiagnosis[]>
}

export interface HostRegistrationRef {
  kind: 'capability' | 'connection-adapter' | 'connection-type'
  id: string
  version: number
}

export interface HostRegistrationOwner {
  role: 'definition' | 'provider'
  evidence: 'current' | 'previous' | 'unknown'
  reason?: 'not-observed' | 'unmanaged' | 'entry-removed' | 'entry-replaced' | 'configuration-changed'
  observedAt?: string
  entry?: Pick<HostPluginEntry, 'id' | 'label' | 'actualState' | 'selfEnabled' | 'effectiveEnabled'>
  /** Outermost first; these are current configuration ancestors, not registration-time paths. */
  ancestors: Array<Pick<HostPluginEntry, 'id' | 'label' | 'actualState' | 'selfEnabled' | 'effectiveEnabled'>>
}

export interface HostRegistrationDiagnosis extends HostRegistrationRef {
  owners: HostRegistrationOwner[]
}

export class HostConfigError extends Error {
  override name = 'HostConfigError'
  constructor(public readonly code: string, message: string) { super(message) }
}
