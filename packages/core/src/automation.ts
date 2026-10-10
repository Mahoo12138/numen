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

export interface ControlRef { id: string; version: number }

export interface ExtensionControlSource {
  type: 'extension'
  id: string
  control: ControlRef
  input: Record<string, ValueExpr>
}

export interface GraphEndpoint {
  nodeId: string
  port: string
}

export interface GraphEdge {
  id: string
  from: GraphEndpoint
  to: GraphEndpoint
}

export interface GraphConditionSource {
  type: 'condition'
  id: string
  condition: ValueExpr
}

export interface GraphMergeSource {
  type: 'merge'
  id: string
  mode: 'all' | 'selected'
  /** Each named input has exactly one incoming edge. */
  inputs: string[]
}

export interface GraphForEachSource {
  type: 'foreach'
  id: string
  items: ValueExpr
  concurrency?: number
  /** An explicit output is required and is collected in original input order. */
  body: GraphSource
}

export type GraphNodeSource = CapabilitySource | GraphConditionSource | GraphMergeSource | GraphForEachSource

export interface GraphSource {
  type: 'graph'
  id: string
  version: 1
  nodes: GraphNodeSource[]
  /** graph.id/start is the explicit, control-only activation source. */
  edges: GraphEdge[]
  /** Evaluated after all members succeed or skip; absent output is null. */
  output?: ValueExpr
}

export type CoreControlSource =
  | CapabilitySource
  | BlockSource
  | IfSource
  | WaitSource
  | ParallelSource
  | RaceSource
  | ForEachSource
  | GraphSource

export type ControlSource = CoreControlSource | ExtensionControlSource

export interface TriggerSource {
  id: string
  capability: CapabilityRef
  /** @deprecated Read as the `default` slot for protocol-v1 persisted Sources. */
  connection?: string
  connections?: Record<string, string>
  config: Record<string, NumenValue>
}

export interface AutomationInputDeclaration {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  title?: string
  description?: string
  required?: boolean
  default?: NumenValue
}

export interface AutomationSource {
  inputs?: Record<string, AutomationInputDeclaration>
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
  | {
    op: 'graph_scope'
    id: string
    version: 1
    members: string[]
    edges: GraphEdge[]
    output?: ValueExpr
    next?: string
  }
  | { op: 'graph_condition'; id: string; condition: ValueExpr }
  | { op: 'graph_merge'; id: string; mode: 'all' | 'selected'; inputs: string[] }
  | { op: 'graph_iterate'; id: string; items: ValueExpr; body: string; concurrency: number }

export interface CorePlan {
  irVersion: number
  entry: string
  instructions: Record<string, CoreInstruction>
  resources?: ResourceRef[]
  /** Generated instruction IDs mapped to their authored extension node. */
  sourceMap?: Record<string, SourceRef>
}

export interface Automation {
  id: string
  name: string
  enabled: boolean
  activeRevisionId?: string
  activationGeneration: number
  archivedAt?: string
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
  controls?: ControlRef[]
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
  controls?: Array<ControlRef & { title: string; inputSchema: unknown }>
  capabilities: ContractSnapshotCapability[]
}

export interface AutomationSnapshotFields {
  id: string
  automationId: string
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

/** A published Revision can be selected for activation or a manual run. */
export interface AutomationRevision extends AutomationSnapshotFields {
  purpose: 'published'
  number: number
  /** Absent on legacy Revisions whose original Draft version is unknown. */
  sourceDraftVersion?: number
  baseRevisionId?: string
}

/** A fixed execution snapshot of a saved Draft; it has no publication number. */
export interface DraftTestAutomationSnapshot extends AutomationSnapshotFields {
  purpose: 'draft-test'
  sourceDraftVersion: number
  baseRevisionId?: string
}

export type AutomationExecutionSnapshot = AutomationRevision | DraftTestAutomationSnapshot
