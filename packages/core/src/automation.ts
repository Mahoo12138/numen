import type { NumenValue, ResourceRef } from './value.js'

export type ValueExpr =
  | { type: 'literal'; value: NumenValue }
  | { type: 'ref'; path: string }
  | { type: 'array'; items: ValueExpr[] }
  | { type: 'object'; entries: Record<string, ValueExpr> }
  | { type: 'template'; parts: Array<string | { ref: string }> }
  | { type: 'call'; function: string; arguments: ValueExpr[] }

export interface CapabilitySource {
  type: 'capability'
  id: string
  capability: CapabilityRef
  /** @deprecated Read as the `default` slot for protocol-v1 persisted Sources. */
  connection?: string
  connections?: Record<string, string>
  input: Record<string, ValueExpr>
  policy?: InvocationPolicy
}

export interface InvocationPolicy {
  timeoutMs?: number
  retry?: {
    maxAttempts: number
    backoffMs?: number
  }
}

export interface BlockSource {
  type: 'block'
  id: string
  steps: ControlSource[]
  output?: Record<string, ValueExpr>
}

export interface IfSource {
  type: 'if'
  id: string
  condition: ValueExpr
  then: BlockSource
  else?: BlockSource
}

export interface WaitSource {
  type: 'wait'
  id: string
  until?: ValueExpr
  durationMs?: ValueExpr
}

export interface ParallelSource {
  type: 'parallel'
  id: string
  branches: BlockSource[]
}

export interface RaceSource {
  type: 'race'
  id: string
  branches: BlockSource[]
}

export interface ForEachSource {
  type: 'foreach'
  id: string
  items: ValueExpr
  body: BlockSource
  concurrency?: number
}

export type ControlSource =
  | CapabilitySource
  | BlockSource
  | IfSource
  | WaitSource
  | ParallelSource
  | RaceSource
  | ForEachSource

export interface TriggerSource {
  id: string
  capability: CapabilityRef
  /** @deprecated Read as the `default` slot for protocol-v1 persisted Sources. */
  connection?: string
  connections?: Record<string, string>
  config: Record<string, NumenValue>
}

export interface AutomationSource {
  triggers: TriggerSource[]
  flow: ControlSource
  policy?: {
    maxActive?: number
    overflow?: 'queue' | 'drop' | 'replace'
    groupBy?: ValueExpr
  }
}

export interface CapabilityRef {
  id: string
  version: number
}

export type CoreInstruction =
  | {
    op: 'invoke'
    id: string
    capability: CapabilityRef
    /** @deprecated Read as the `default` slot for protocol-v1 persisted plans. */
    connection?: string
    connections?: Record<string, string>
    input: ValueExpr
    policy?: InvocationPolicy
    next?: string
  }
  | { op: 'eval'; id: string; expression: ValueExpr; assign: string; next?: string }
  | { op: 'branch'; id: string; condition: ValueExpr; then: string; else: string }
  | {
    op: 'suspend'
    id: string
    source: 'timer' | 'signal' | 'event' | 'child'
    config: { until?: ValueExpr; durationMs?: ValueExpr }
    next?: string
  }
  | { op: 'fork'; id: string; mode: 'all' | 'first_success'; branches: string[]; join: string }
  | { op: 'iterate'; id: string; items: ValueExpr; body: string; concurrency: number; join: string }
  | { op: 'scope_complete'; id: string }
  | { op: 'join'; id: string; mode: 'all' | 'first_success' | 'iterate'; next?: string }
  | { op: 'complete'; id: string; output?: ValueExpr }
  | { op: 'fail'; id: string; error: ValueExpr }

export interface CorePlan {
  irVersion: number
  entry: string
  instructions: Record<string, CoreInstruction>
  resources?: ResourceRef[]
}

export interface Automation {
  id: string
  name: string
  enabled: boolean
  activeRevisionId?: string
  activationGeneration: number
  createdAt: string
  updatedAt: string
}

export interface AutomationDraft {
  automationId: string
  baseRevisionId?: string
  source: AutomationSource
  presentation: Record<string, NumenValue>
  version: number
  updatedAt: string
}

export interface SourceRef {
  nodeId?: string
  fieldPath?: string
}

export interface CompileDiagnostic {
  severity: 'warning' | 'error'
  code: string
  message: string
  source?: SourceRef
}

export interface CapabilityDependency extends CapabilityRef {
  kind: 'trigger' | 'query' | 'action'
  /** @deprecated Read as the `default` slot for protocol-v1 persisted manifests. */
  connectionId?: string
  connectionIds?: Record<string, string>
}

export interface DependencyManifest {
  capabilities: CapabilityDependency[]
}

export interface ContractSnapshotCapability extends CapabilityRef {
  kind: 'trigger' | 'query' | 'action'
  title: string
  inputSchema: unknown
  outputSchema: unknown
  semantics: {
    sideEffect: boolean
    idempotent: boolean
    retrySafe: boolean
    defaultTimeoutMs?: number
  }
  connections?: Array<{
    name: string
    required: boolean
    accepts: string[]
  }>
}

export interface ContractSnapshot {
  capabilities: ContractSnapshotCapability[]
}

export interface AutomationRevision {
  id: string
  automationId: string
  number: number
  protocolVersion: number
  source: AutomationSource
  presentation: Record<string, NumenValue>
  irVersion: number
  compiledPlan: CorePlan
  dependencyManifest: DependencyManifest
  contractSnapshot: ContractSnapshot
  contentHash: string
  createdAt: string
}
