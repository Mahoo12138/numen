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
  connection?: string
  input: Record<string, ValueExpr>
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

export type ControlSource = CapabilitySource | BlockSource | IfSource | WaitSource

export interface TriggerSource {
  id: string
  capability: CapabilityRef
  connection?: string
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
  | { op: 'invoke'; id: string; capability: CapabilityRef; input: ValueExpr; next?: string }
  | { op: 'eval'; id: string; expression: ValueExpr; assign: string; next?: string }
  | { op: 'branch'; id: string; condition: ValueExpr; then: string; else: string }
  | { op: 'suspend'; id: string; source: 'timer' | 'signal' | 'event' | 'child'; config: NumenValue; next?: string }
  | { op: 'complete'; id: string; output?: ValueExpr }
  | { op: 'fail'; id: string; error: ValueExpr }

export interface CorePlan {
  irVersion: number
  entry: string
  instructions: Record<string, CoreInstruction>
  resources?: ResourceRef[]
}
