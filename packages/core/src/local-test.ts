import type { CapabilityRef, ContractSnapshotCapability } from './automation.js'
import type { NumenValue } from './value.js'

/** Immutable reusable output data. ResourceRef values are deliberately unsupported. */
export interface OutputSample {
  id: string
  automationId: string
  nodeId: string
  capability: CapabilityRef
  contract: ContractSnapshotCapability
  contractHash: string
  value: NumenValue
  valueHash: string
  integrity: 'complete'
  provenance: { kind: 'manual'; draftVersion: number } | {
    kind: 'execution'; snapshotId: string; snapshotContentHash: string; runId: string; executionId: string
  }
  createdAt: string
}

export type OutputSampleSummary = Omit<OutputSample, 'value' | 'contract'>

export interface LocalTestRequest {
  automationId: string
  expectedDraftVersion: number
  targetNodeId: string
  mode: 'to-node' | 'only-node'
  sampleIds: string[]
  input: Record<string, NumenValue>
  trigger: NumenValue
}

export interface LocalTestScope {
  version: 1
  request: LocalTestRequest
  mode: LocalTestRequest['mode']
  targetNodeId: string
  sourceContentHash: string
  nodeIds: string[]
  samples: OutputSample[]
}

export interface LocalTestPreview {
  request: LocalTestRequest
  previewHash: string
  scope: LocalTestScope
  calls: Array<{ nodeId: string; capability: CapabilityRef; sideEffect: boolean; retrySafe: boolean; inputValidation: 'validated' | 'runtime' }>
  substitutions: Array<{ nodeId: string; sampleId: string; provenance: OutputSample['provenance']; createdAt: string }>
  externalWrites: string[]
}
