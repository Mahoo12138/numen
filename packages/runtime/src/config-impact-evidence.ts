import type { Attempt, Execution, Run } from '@numenjs/core'
import '@numenjs/database'
import type { Context } from 'cordis'

export const runtimeImpactLimits = Object.freeze({
  connections: 128, activeRevisions: 128, runs: 128, executionsPerRun: 64,
  executions: 1024, attemptsPerExecution: 64, snapshotBytes: 262_144, totalSnapshotBytes: 4_194_304,
  dependenciesPerSnapshot: 256, instructionsPerSnapshot: 1024,
})
export type RuntimeImpactSource = 'connections' | 'active-revisions' | 'nonterminal-runs' | 'run-executions' | 'run-snapshots' | 'drafts'
export interface RuntimeImpactCoverage {
  source: RuntimeImpactSource
  status: 'complete' | 'partial' | 'unavailable' | 'excluded'
  scanned: number
  limit: number
  truncated: boolean
  reasons: string[]
}
export interface RuntimeImpactRef { id: string; version: number }
export interface RuntimeImpactConnection { id: string; enabled: boolean; adapter: RuntimeImpactRef; type?: RuntimeImpactRef }
export interface RuntimeImpactSnapshot {
  automationId: string
  revisionId: string
  purpose: 'published' | 'draft-test'
  active: boolean
  automationEnabled: boolean
  capabilities: (RuntimeImpactRef & { kind: 'trigger' | 'query' | 'action' })[]
  connections: string[]
  dependenciesComplete: boolean
  executionPlanComplete: boolean
}
export interface RuntimeImpactExecution {
  id: string
  instructionId: string
  status: Execution['status']
  op?: 'invoke' | 'other'
  capability?: RuntimeImpactRef
  connections: string[]
  capabilityKind?: 'trigger' | 'query' | 'action'
  sideEffect?: boolean
  attemptStatus?: Attempt['status']
  outcomeUnknown: boolean
}
export interface RuntimeImpactRun {
  id: string
  automationId: string
  revisionId: string
  status: Run['status']
  executions: RuntimeImpactExecution[]
  executionsTruncated: boolean
  executionEvidenceIncomplete?: true
}
export interface RuntimeImpactEvidence {
  connections: RuntimeImpactConnection[]
  snapshots: RuntimeImpactSnapshot[]
  runs: RuntimeImpactRun[]
  coverage: RuntimeImpactCoverage[]
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const ref = (value: unknown): value is RuntimeImpactRef & Record<string, unknown> => record(value) && identifier(value.id) && Number.isSafeInteger(value.version) && Number(value.version) > 0
const kind = (value: unknown): value is 'trigger' | 'query' | 'action' => value === 'trigger' || value === 'query' || value === 'action'
const refKey = (value: RuntimeImpactRef) => JSON.stringify([value.id, value.version])
const executionStatuses = new Set(['RUNNABLE', 'RUNNING', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLING', 'CANCELLED', 'TIMED_OUT'])
const attemptStatuses = new Set(['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED', 'INTERRUPTED', 'OUTCOME_UNKNOWN'])
const instructionOps = new Set(['invoke', 'eval', 'branch', 'suspend', 'fork', 'iterate', 'scope_complete', 'join', 'complete', 'fail'])
const snapshotKey = (automationId: string, revisionId: string) => JSON.stringify([automationId, revisionId])
function incomplete(coverage: RuntimeImpactCoverage, reason: string, truncated = false) {
  if (coverage.status !== 'unavailable' && coverage.status !== 'excluded') coverage.status = 'partial'
  if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason)
  coverage.truncated ||= truncated
}
function initialCoverage(): RuntimeImpactCoverage[] {
  return [
    ['connections', runtimeImpactLimits.connections], ['active-revisions', runtimeImpactLimits.activeRevisions],
    ['nonterminal-runs', runtimeImpactLimits.runs], ['run-executions', runtimeImpactLimits.executions],
    ['run-snapshots', runtimeImpactLimits.runs], ['drafts', 0],
  ].map(([source, limit]) => ({ source: source as RuntimeImpactSource, limit: Number(limit), scanned: 0,
    status: source === 'drafts' ? 'excluded' : 'complete', truncated: false,
    reasons: source === 'drafts' ? ['draft-references-excluded'] : [],
  }))
}
function connectionIds(value: Record<string, unknown>, source: 'manifest' | 'instruction'): { ids: string[]; complete: boolean } {
  const named = value[source === 'manifest' ? 'connectionIds' : 'connections']
  const legacy = value[source === 'manifest' ? 'connectionId' : 'connection']
  // Match the persisted protocol and Scheduler: a named map replaces the legacy
  // default binding, even when the map is empty. Never infer an ignored edge.
  if (named === undefined || named === null) {
    if (legacy === undefined) return { ids: [], complete: named !== null }
    return identifier(legacy) ? { ids: [legacy], complete: named !== null } : { ids: [], complete: false }
  }
  if (!record(named)) return { ids: [], complete: false }
  const bindings = Object.values(named)
  if (bindings.length > 32) return { ids: [], complete: false }
  return { ids: [...new Set(bindings.filter(identifier))], complete: bindings.every(identifier) }
}
interface SnapshotRequest { automationId: string; revisionId: string; active: boolean; automationEnabled: boolean; run: boolean }
interface InstructionEvidence {
  op: 'invoke' | 'other'; capability?: RuntimeImpactRef; connections: string[]
  capabilityKind?: 'trigger' | 'query' | 'action'; sideEffect?: boolean
}
interface StoredSnapshot {
  purpose: string; protocol_version: number; ir_version: number; json_bytes: number
  dependency_manifest_json: string | null; compiled_plan_json: string | null; contract_snapshot_json: string | null
}

/** A read-only, bounded projection. No domain payload or executable plugin callbacks cross this boundary. */
export function collectRuntimeImpactEvidence(ctx: Context): RuntimeImpactEvidence {
  const evidence: RuntimeImpactEvidence = { connections: [], snapshots: [], runs: [], coverage: initialCoverage() }
  const bySource = new Map(evidence.coverage.map(item => [item.source, item]))
  const coverage = (source: RuntimeImpactSource) => bySource.get(source)!
  let database: Context['database']['db']
  try {
    const service = ctx.get('database')
    if (!service) throw new Error('database unavailable')
    database = service.db
  } catch {
    for (const item of evidence.coverage) if (item.source !== 'drafts') { item.status = 'unavailable'; item.reasons.push('database-unavailable') }
    return evidence
  }
  // The persisted relationships remain useful if their current runtime service is absent.
  // Absence is uncertainty, never an empty/complete live catalog.
  for (const [service, sources] of [
    ['connections', ['connections']], ['automations', ['active-revisions', 'run-snapshots']],
    ['scheduler', ['nonterminal-runs', 'run-executions']],
  ] as const) {
    if (!ctx.get(service)) for (const source of sources) incomplete(coverage(source), 'runtime-service-unavailable')
  }
  try {
    // Deferred transaction gives a consistent SQLite read snapshot without acquiring a write lock.
    database.transaction(() => {
      const connectionRows = database.prepare(`
        SELECT id, enabled, adapter_id, adapter_version, type_id, type_version
        FROM connections ORDER BY id LIMIT ?
      `).all(runtimeImpactLimits.connections + 1) as {
        id: string; enabled: number; adapter_id: string; adapter_version: number; type_id: string; type_version: number
      }[]
      const connectionCoverage = coverage('connections')
      connectionCoverage.scanned = Math.min(connectionRows.length, runtimeImpactLimits.connections)
      if (connectionRows.length > runtimeImpactLimits.connections) incomplete(connectionCoverage, 'row-limit', true)
      for (const row of connectionRows.slice(0, runtimeImpactLimits.connections)) {
        const adapter = { id: row.adapter_id, version: row.adapter_version }
        const type = { id: row.type_id, version: row.type_version }
        if (!identifier(row.id) || !ref(adapter)) { incomplete(connectionCoverage, 'invalid-connection-reference'); continue }
        if (!ref(type)) incomplete(connectionCoverage, 'connection-type-unrecorded')
        evidence.connections.push({ id: row.id, enabled: !!row.enabled, adapter, ...(ref(type) ? { type } : {}) })
      }
      const requests = new Map<string, SnapshotRequest>()
      const activeRows = database.prepare(`
        SELECT id, active_revision_id, enabled FROM automations
        WHERE active_revision_id IS NOT NULL AND archived_at IS NULL ORDER BY id LIMIT ?
      `).all(runtimeImpactLimits.activeRevisions + 1) as { id: string; active_revision_id: string; enabled: number }[]
      coverage('active-revisions').scanned = Math.min(activeRows.length, runtimeImpactLimits.activeRevisions)
      if (activeRows.length > runtimeImpactLimits.activeRevisions) incomplete(coverage('active-revisions'), 'row-limit', true)
      for (const row of activeRows.slice(0, runtimeImpactLimits.activeRevisions)) {
        if (!identifier(row.id) || !identifier(row.active_revision_id)) { incomplete(coverage('active-revisions'), 'invalid-snapshot-reference'); continue }
        requests.set(snapshotKey(row.id, row.active_revision_id), { automationId: row.id, revisionId: row.active_revision_id, active: true, automationEnabled: !!row.enabled, run: false })
      }
      const runRows = database.prepare(`
        SELECT id, automation_id, revision_id, status FROM runs
        WHERE status IN ('QUEUED', 'RUNNING', 'CANCELLING') ORDER BY created_at, id LIMIT ?
      `).all(runtimeImpactLimits.runs + 1) as { id: string; automation_id: string; revision_id: string; status: Run['status'] }[]
      coverage('nonterminal-runs').scanned = Math.min(runRows.length, runtimeImpactLimits.runs)
      if (runRows.length > runtimeImpactLimits.runs) incomplete(coverage('nonterminal-runs'), 'row-limit', true)
      for (const row of runRows.slice(0, runtimeImpactLimits.runs)) {
        if (!identifier(row.id) || !identifier(row.automation_id) || !identifier(row.revision_id)) { incomplete(coverage('nonterminal-runs'), 'invalid-run-reference'); continue }
        const key = snapshotKey(row.automation_id, row.revision_id)
        const existing = requests.get(key)
        requests.set(key, existing ? { ...existing, run: true } : { automationId: row.automation_id, revisionId: row.revision_id, active: false, automationEnabled: false, run: true })
        evidence.runs.push({ id: row.id, automationId: row.automation_id, revisionId: row.revision_id, status: row.status, executions: [], executionsTruncated: false })
      }
      const plans = new Map<string, Map<string, InstructionEvidence>>()
      let remainingBytes = runtimeImpactLimits.totalSnapshotBytes
      const statement = database.prepare(`
        SELECT purpose, protocol_version, ir_version,
          length(CAST(dependency_manifest_json AS BLOB))
            + CASE WHEN @include_plan THEN length(CAST(compiled_plan_json AS BLOB)) + length(CAST(contract_snapshot_json AS BLOB)) ELSE 0 END AS json_bytes,
          CASE WHEN protocol_version = 1 AND ir_version = 1 AND length(CAST(dependency_manifest_json AS BLOB))
            + CASE WHEN @include_plan THEN length(CAST(compiled_plan_json AS BLOB)) + length(CAST(contract_snapshot_json AS BLOB)) ELSE 0 END <= @byte_limit
            THEN dependency_manifest_json END AS dependency_manifest_json,
          CASE WHEN @include_plan AND protocol_version = 1 AND ir_version = 1
            AND length(CAST(dependency_manifest_json AS BLOB)) + length(CAST(compiled_plan_json AS BLOB)) + length(CAST(contract_snapshot_json AS BLOB)) <= @byte_limit
            THEN compiled_plan_json END AS compiled_plan_json,
          CASE WHEN @include_plan AND protocol_version = 1 AND ir_version = 1
            AND length(CAST(dependency_manifest_json AS BLOB)) + length(CAST(compiled_plan_json AS BLOB)) + length(CAST(contract_snapshot_json AS BLOB)) <= @byte_limit
            THEN contract_snapshot_json END AS contract_snapshot_json
        FROM automation_revisions WHERE id = @revision_id AND automation_id = @automation_id
      `)
      for (const [key, request] of requests) {
        const sources = [request.active ? coverage('active-revisions') : undefined, request.run ? coverage('run-snapshots') : undefined].filter((item): item is RuntimeImpactCoverage => !!item)
        const mark = (reason: string, truncated = false) => sources.forEach(item => incomplete(item, reason, truncated))
        if (request.run) coverage('run-snapshots').scanned++
        const row = statement.get({ include_plan: Number(request.run), byte_limit: Math.min(runtimeImpactLimits.snapshotBytes, remainingBytes), revision_id: request.revisionId, automation_id: request.automationId }) as StoredSnapshot | undefined
        if (!row) { mark('snapshot-missing'); continue }
        if (row.protocol_version !== 1 || row.ir_version !== 1) { mark('unsupported-snapshot-version'); continue }
        if (row.purpose !== 'published' && row.purpose !== 'draft-test' || request.active && row.purpose !== 'published') { mark('invalid-snapshot-purpose'); continue }
        if (row.json_bytes > runtimeImpactLimits.snapshotBytes || row.json_bytes > remainingBytes) { mark('snapshot-byte-limit', true); continue }
        remainingBytes -= row.json_bytes
        const snapshot: RuntimeImpactSnapshot = { automationId: request.automationId, revisionId: request.revisionId, purpose: row.purpose, active: request.active,
          automationEnabled: request.automationEnabled, capabilities: [], connections: [], dependenciesComplete: true, executionPlanComplete: !request.run }
        evidence.snapshots.push(snapshot)
        try {
          const manifest: unknown = JSON.parse(row.dependency_manifest_json!)
          if (!record(manifest) || !Array.isArray(manifest.capabilities)) throw new Error('invalid manifest')
          const connectionRefs = new Set<string>()
          if (manifest.capabilities.length > runtimeImpactLimits.dependenciesPerSnapshot) { snapshot.dependenciesComplete = false; mark('dependency-limit', true) }
          for (const dependency of manifest.capabilities.slice(0, runtimeImpactLimits.dependenciesPerSnapshot)) {
            if (!ref(dependency) || !kind(dependency.kind)) { snapshot.dependenciesComplete = false; mark('invalid-dependency-manifest'); continue }
            snapshot.capabilities.push({ id: dependency.id, version: dependency.version, kind: dependency.kind })
            const connected = connectionIds(dependency, 'manifest')
            connected.ids.forEach(id => connectionRefs.add(id))
            if (!connected.complete) { snapshot.dependenciesComplete = false; mark('invalid-connection-dependency') }
          }
          snapshot.connections = [...connectionRefs]
          // Extension controls can hide dynamic references; these never become an inferred edge.
          if (manifest.controls !== undefined && (!Array.isArray(manifest.controls) || manifest.controls.length > 0)) mark('dynamic-control-references-uninspected')
        } catch { snapshot.dependenciesComplete = false; mark('invalid-dependency-manifest') }
        if (!request.run) continue
        try {
          const plan: unknown = JSON.parse(row.compiled_plan_json!)
          const contracts: unknown = JSON.parse(row.contract_snapshot_json!)
          if (!record(plan) || plan.irVersion !== 1 || !record(plan.instructions) || !record(contracts) || !Array.isArray(contracts.capabilities)) throw new Error('invalid execution metadata')
          const frozen = new Map<string, { kind: 'trigger' | 'query' | 'action'; sideEffect: boolean }>()
          const ambiguousContracts = new Set<string>()
          let complete = true
          if (contracts.capabilities.length > runtimeImpactLimits.dependenciesPerSnapshot) { complete = false; mark('contract-limit', true) }
          for (const contract of contracts.capabilities.slice(0, runtimeImpactLimits.dependenciesPerSnapshot)) {
            if (!ref(contract) || !kind(contract.kind) || !record(contract.semantics) || typeof contract.semantics.sideEffect !== 'boolean') {
              complete = false; mark('invalid-contract-snapshot'); continue
            }
            if (frozen.has(refKey(contract)) || ambiguousContracts.has(refKey(contract))) {
              frozen.delete(refKey(contract)); ambiguousContracts.add(refKey(contract)); complete = false; mark('ambiguous-frozen-contract'); continue
            }
            frozen.set(refKey(contract), { kind: contract.kind, sideEffect: contract.semantics.sideEffect })
          }
          const instructions = Object.entries(plan.instructions)
          if (instructions.length > runtimeImpactLimits.instructionsPerSnapshot) { complete = false; mark('instruction-limit', true) }
          const projected = new Map<string, InstructionEvidence>()
          for (const [instructionId, instruction] of instructions.slice(0, runtimeImpactLimits.instructionsPerSnapshot)) {
            if (!identifier(instructionId) || !record(instruction) || instruction.id !== instructionId || typeof instruction.op !== 'string' || !instructionOps.has(instruction.op)) { complete = false; mark('invalid-compiled-plan'); continue }
            if (instruction.op !== 'invoke') { projected.set(instructionId, { op: 'other', connections: [] }); continue }
            if (!ref(instruction.capability)) { complete = false; mark('invalid-compiled-plan'); continue }
            const capability = { id: instruction.capability.id, version: instruction.capability.version }
            const semantics = frozen.get(refKey(capability))
            if (!semantics) { complete = false; mark('missing-frozen-contract') }
            const connected = connectionIds(instruction, 'instruction')
            if (!connected.complete) { complete = false; mark('invalid-connection-dependency') }
            projected.set(instructionId, { op: 'invoke', capability, connections: connected.ids,
              ...(semantics ? { capabilityKind: semantics.kind, sideEffect: semantics.sideEffect } : {}) })
          }
          plans.set(key, projected)
          snapshot.executionPlanComplete = complete
        } catch { mark('invalid-execution-metadata') }
      }
      const executionStatement = database.prepare(`
        SELECT e.id, e.instruction_id, e.status,
          (SELECT a.status FROM attempts a WHERE a.execution_id = e.id ORDER BY a.number DESC LIMIT 1) AS attempt_status,
          EXISTS(SELECT 1 FROM (SELECT a.status FROM attempts a WHERE a.execution_id = e.id ORDER BY a.number DESC LIMIT @attempt_limit)
            WHERE status = 'OUTCOME_UNKNOWN') AS outcome_unknown,
          EXISTS(SELECT 1 FROM attempts a WHERE a.execution_id = e.id ORDER BY a.number DESC LIMIT 1 OFFSET @attempt_limit) AS attempts_truncated,
          EXISTS(SELECT 1 FROM (SELECT a.status FROM attempts a WHERE a.execution_id = e.id ORDER BY a.number DESC LIMIT @attempt_limit)
            WHERE status NOT IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED', 'INTERRUPTED', 'OUTCOME_UNKNOWN')) AS invalid_attempt_status
        FROM executions e WHERE e.run_id = @run_id ORDER BY e.created_at, e.id LIMIT @execution_limit
      `)
      let remainingExecutions: number = runtimeImpactLimits.executions
      for (const run of evidence.runs) {
        if (remainingExecutions === 0) { run.executionsTruncated = true; incomplete(coverage('run-executions'), 'execution-limit', true); continue }
        const limit = Math.min(runtimeImpactLimits.executionsPerRun, remainingExecutions)
        const rows = executionStatement.all({ run_id: run.id, execution_limit: limit + 1, attempt_limit: runtimeImpactLimits.attemptsPerExecution }) as { id: string; instruction_id: string; status: Execution['status']; attempt_status: Attempt['status'] | null; outcome_unknown: number; attempts_truncated: number; invalid_attempt_status: number }[]
        if (rows.length > limit) { run.executionsTruncated = true; incomplete(coverage('run-executions'), 'execution-limit', true) }
        const plan = plans.get(snapshotKey(run.automationId, run.revisionId))
        for (const row of rows.slice(0, limit)) {
          remainingExecutions--; coverage('run-executions').scanned++
          if (!identifier(row.id) || !identifier(row.instruction_id)) { incomplete(coverage('run-executions'), 'invalid-execution-reference'); run.executionEvidenceIncomplete = true; continue }
          if (!executionStatuses.has(row.status)) { run.executionEvidenceIncomplete = true; incomplete(coverage('run-executions'), 'invalid-execution-status'); continue }
          if (row.invalid_attempt_status || row.attempt_status !== null && !attemptStatuses.has(row.attempt_status)) { run.executionEvidenceIncomplete = true; incomplete(coverage('run-executions'), 'invalid-attempt-status') }
          if (row.attempts_truncated) { run.executionEvidenceIncomplete = true; incomplete(coverage('run-executions'), 'attempt-limit', true) }
          const instruction = plan?.get(row.instruction_id)
          if (!instruction) { run.executionEvidenceIncomplete = true; incomplete(coverage('run-executions'), 'execution-instruction-unavailable') }
          run.executions.push({ id: row.id, instructionId: row.instruction_id, status: row.status,
            connections: [], ...instruction, ...(row.attempt_status && attemptStatuses.has(row.attempt_status) ? { attemptStatus: row.attempt_status } : {}), outcomeUnknown: !!row.outcome_unknown })
        }
      }
    })()
  } catch {
    // A partially read or migrated database cannot substantiate a cross-domain graph.
    evidence.connections = []; evidence.snapshots = []; evidence.runs = []
    for (const item of evidence.coverage) if (item.source !== 'drafts') { item.status = 'unavailable'; item.scanned = 0; item.reasons = ['database-read-failed'] }
  }
  return evidence
}
