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

export interface HostConfigApplyRequest extends HostConfigMutationRequest {
  /** Opaque Host proof binding this exact operation to its inspected runtime observations. */
  previewToken: string
}

export type HostConfigImpactSource = 'ownership' | 'configuration' | 'connections' | 'active-revisions' | 'nonterminal-runs' | 'run-executions' | 'run-snapshots' | 'drafts' | 'dynamic-references' | 'external-effects'

export interface HostConfigImpactCoverage {
  source: HostConfigImpactSource
  status: 'complete' | 'partial' | 'unavailable' | 'excluded'
  scanned: number
  limit: number
  truncated: boolean
  reasons: string[]
}

export type HostConfigImpactRunCondition = 'not-started' | 'blocked' | 'waiting' | 'executing-external-action' | 'outcome-unknown' | 'running' | 'cancelling' | 'unknown'

export type HostConfigImpactNode =
  | { key: string; kind: 'entry'; id: string; group: boolean }
  | { key: string; kind: 'registration'; id: string; registrationKind: HostRegistrationRef['kind']; version: number; role: HostRegistrationOwner['role']; observedAt: string }
  | { key: string; kind: 'connection'; id: string; enabled: boolean }
  | { key: string; kind: 'revision'; id: string; automationId: string; purpose: 'published' | 'draft-test'; active: boolean; automationEnabled: boolean }
  | { key: string; kind: 'run'; id: string; automationId: string; revisionId: string; status: string; condition: HostConfigImpactRunCondition; executions: Array<{ id: string; status: string; scope: 'affected-call' | 'run-context'; outcomeUnknown: boolean; attemptStatus?: string }>; executionTruncated: boolean }

export interface HostConfigImpactEdge {
  from: string
  to: string
  relation: 'contains' | 'owns-definition' | 'owns-provider' | 'uses-adapter' | 'uses-type' | 'depends-on-capability' | 'depends-on-connection' | 'executes-revision' | 'invokes-capability' | 'uses-connection'
  source: HostConfigImpactSource
  observedAt?: string
  executionId?: string
}

export type HostConfigImpactUnknownCode = 'entry-not-observed' | 'historical-only' | 'ownership-invalid' | 'ownership-evicted' | 'source-incomplete' | 'graph-limit' | 'dynamic-references-excluded' | 'drafts-excluded' | 'external-effects-not-reversible' | 'execution-state-incomplete'

export interface HostConfigImpact {
  status: 'known-impacts' | 'no-known-impacts' | 'unknown'
  operationEffect: 'runtime' | 'metadata-only'
  computedAt: string
  message: string
  nodes: HostConfigImpactNode[]
  edges: HostConfigImpactEdge[]
  /** Historical clues are deliberately outside the current-evidence graph. */
  history: Array<{ registration: HostRegistrationRef; role: HostRegistrationOwner['role']; entryId: string; observedAt: string }>
  unknownReasons: Array<{ code: HostConfigImpactUnknownCode; source: HostConfigImpactSource; message: string; entryId?: string }>
  coverage: HostConfigImpactCoverage[]
  truncated: boolean
}

export interface HostConfigPreview {
  fingerprint: string
  operation: HostConfigOperation
  affectedEntryIds: string[]
  impact: HostConfigImpact
  blockedReason?: string
  /** Absent when Host validation blocks the operation. */
  previewToken?: string
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
  apply(input: HostConfigApplyRequest): Promise<HostConfigMutationResult>
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
