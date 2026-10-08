import type {
  HostConfigImpact, HostConfigImpactEdge, HostConfigImpactNode,
  HostConfigImpactRunCondition, HostConfigOperation, HostConfigSnapshot, HostRegistrationRef,
} from '@numenjs/config'
import type { RuntimeImpactEvidence, RuntimeImpactExecution, RuntimeImpactRun, RuntimeImpactSnapshot } from './config-impact-evidence.js'
import type { RegistrationOwnership } from './registration-ownership.js'

export const configImpactLimits = Object.freeze({ registrations: 256, nodes: 512, edges: 1024, history: 256 })
const validRef = (ref: HostRegistrationRef) => typeof ref.id === 'string' && ref.id.length > 0 && ref.id.length <= 256 && Number.isSafeInteger(ref.version) && ref.version > 0 && ['capability', 'connection-adapter', 'connection-type'].includes(ref.kind)
const refKey = (ref: { id: string; version: number }) => JSON.stringify([ref.id, ref.version])
const nodeKey = (kind: string, ...values: unknown[]) => JSON.stringify([kind, ...values])
export const isMetadataOperation = (operation: HostConfigOperation) => ['setLabel', 'setCollapsed', 'createGroup', 'removeGroup'].includes(operation.kind)

function runCondition(run: RuntimeImpactRun, executions: RuntimeImpactExecution[], snapshot: RuntimeImpactSnapshot): HostConfigImpactRunCondition {
  if (run.executions.some(execution => execution.outcomeUnknown || execution.attemptStatus === 'OUTCOME_UNKNOWN')) return 'outcome-unknown'
  if (executions.some(execution => execution.op === 'invoke' && execution.sideEffect === true && execution.attemptStatus === 'RUNNING')) return 'executing-external-action'
  if (run.executionsTruncated || run.executionEvidenceIncomplete || !snapshot.executionPlanComplete || !snapshot.dependenciesComplete) return 'unknown'
  if (run.status === 'CANCELLING') return 'cancelling'
  if (executions.some(execution => execution.status === 'RUNNING' || execution.attemptStatus === 'RUNNING')) return 'running'
  if (executions.some(execution => execution.status === 'BLOCKED')) return 'blocked'
  if (executions.some(execution => execution.status === 'WAITING')) return 'waiting'
  if (!executions.length && run.executions.some(execution => execution.status === 'RUNNING' || execution.attemptStatus === 'RUNNING')) return 'running'
  if (!executions.length || executions.every(execution => execution.status === 'RUNNABLE' && !execution.attemptStatus)) return 'not-started'
  // Completed/failed calls in an otherwise nonterminal Run do not promise a retry.
  return 'unknown'
}

/** Pure, bounded graph over explicit observations. No plugin code or configuration is inspected. */
export function buildConfigImpact(
  operation: HostConfigOperation,
  affectedEntryIds: readonly string[],
  snapshot: HostConfigSnapshot,
  ownership: ReturnType<RegistrationOwnership['inspect']>,
  evidence: RuntimeImpactEvidence,
  computedAt = new Date().toISOString(),
): HostConfigImpact {
  const metadataOnly = isMetadataOperation(operation)
  const result: HostConfigImpact = {
    status: metadataOnly ? 'no-known-impacts' : 'unknown', operationEffect: metadataOnly ? 'metadata-only' : 'runtime', computedAt,
    message: metadataOnly ? 'This operation changes configuration organization or display metadata. No known runtime dependency impact was found.'
      : 'Only current observed ownership and explicit stored dependencies are included. No known impact does not mean arbitrary plugin behavior is side-effect free.',
    nodes: [], edges: [], history: [], unknownReasons: [], coverage: [], truncated: false,
  }
  const nodeKeys = new Set<string>(), edgeKeys = new Set<string>(), reasons = new Set<string>()
  const unknown = (item: HostConfigImpact['unknownReasons'][number]) => {
    const key = JSON.stringify([item.code, item.source, item.entryId])
    if (!reasons.has(key)) { reasons.add(key); result.unknownReasons.push(item) }
  }
  const limited = () => { result.truncated = true; unknown({ code: 'graph-limit', source: 'ownership', message: 'The impact graph reached its display bound; omitted objects remain unknown.' }) }
  const node = (value: HostConfigImpactNode) => {
    if (nodeKeys.has(value.key)) return true
    if (result.nodes.length >= configImpactLimits.nodes) { limited(); return false }
    nodeKeys.add(value.key); result.nodes.push(value); return true
  }
  const edge = (value: HostConfigImpactEdge) => {
    if (!nodeKeys.has(value.from) || !nodeKeys.has(value.to)) return
    const key = JSON.stringify([value.from, value.to, value.relation, value.executionId])
    if (edgeKeys.has(key)) return
    if (result.edges.length >= configImpactLimits.edges) { limited(); return }
    edgeKeys.add(key); result.edges.push(value)
  }
  const connectedNode = (value: HostConfigImpactNode, parents: string[]) => {
    if (!parents.some(key => nodeKeys.has(key))) return false
    if (result.edges.length >= configImpactLimits.edges) { limited(); return false }
    return node(value)
  }
  const affectedIds = new Set(affectedEntryIds)
  const allEntries = snapshot.entries.filter(entry => affectedIds.has(entry.id))
  const entries = allEntries.slice(0, configImpactLimits.nodes)
  if (allEntries.length > entries.length) limited()
  const selectedIds = new Set(entries.map(entry => entry.id))
  for (const entry of entries) {
    if (!node({ key: nodeKey('entry', entry.id), kind: 'entry', id: entry.id, group: entry.group })) break
    if (entry.parentId && selectedIds.has(entry.parentId)) edge({ from: nodeKey('entry', entry.parentId), to: nodeKey('entry', entry.id), relation: 'contains', source: 'configuration' })
  }
  result.coverage.push({ source: 'configuration', status: result.truncated ? 'partial' : 'complete', scanned: allEntries.length, limit: configImpactLimits.nodes, truncated: result.truncated, reasons: result.truncated ? ['entry-limit'] : [] })
  if (metadataOnly) {
    result.coverage.push({ source: 'ownership', status: 'excluded', scanned: 0, limit: configImpactLimits.registrations, truncated: false, reasons: ['metadata-only-operation'] })
    return result
  }
  result.coverage.push({ source: 'ownership', status: ownership.truncated || ownership.evicted || ownership.invalid ? 'partial' : 'complete', scanned: ownership.scanned, limit: ownership.limit, truncated: ownership.truncated || ownership.evicted, reasons: [...(ownership.truncated ? ['registration-limit'] : []), ...(ownership.evicted ? ['observations-evicted'] : []), ...(ownership.invalid ? ['invalid-registration-reference'] : [])] }, ...evidence.coverage)
  const registrations: Array<{ ref: HostRegistrationRef; key: string }> = []
  const observedEntries = new Set<string>()
  for (const diagnosis of ownership.diagnoses) {
    if (!validRef(diagnosis)) { unknown({ code: 'ownership-invalid', source: 'ownership', message: 'A registration reference cannot be safely represented; its ownership remains unknown.' }); continue }
    for (const owner of diagnosis.owners) {
      const entryId = owner.entry?.id
      if (owner.evidence === 'unknown') {
        if (owner.reason !== 'not-observed') unknown({ code: 'ownership-invalid', source: 'ownership', message: `Registration ownership is not current: ${owner.reason ?? 'not-observed'}.` })
        continue
      }
      if (!entryId || !selectedIds.has(entryId) || !owner.observedAt) continue
      observedEntries.add(entryId)
      const registration: HostRegistrationRef = { kind: diagnosis.kind, id: diagnosis.id, version: diagnosis.version }
      if (owner.evidence === 'previous') {
        if (result.history.length < configImpactLimits.history) result.history.push({ registration, role: owner.role, entryId, observedAt: owner.observedAt })
        else limited()
        unknown({ code: 'historical-only', source: 'ownership', entryId, message: 'Previous ownership is a historical clue, not proof of current impact or successful restoration.' })
        continue
      }
      const key = nodeKey('registration', diagnosis.kind, diagnosis.id, diagnosis.version, owner.role)
      if (!connectedNode({ key, kind: 'registration', id: diagnosis.id, registrationKind: diagnosis.kind, version: diagnosis.version, role: owner.role, observedAt: owner.observedAt }, [nodeKey('entry', entryId)])) continue
      edge({ from: nodeKey('entry', entryId), to: key, relation: owner.role === 'definition' ? 'owns-definition' : 'owns-provider', source: 'ownership', observedAt: owner.observedAt })
      registrations.push({ ref: registration, key })
    }
  }
  for (const entry of entries) if (!entry.group && !observedEntries.has(entry.id)) unknown({ code: 'entry-not-observed', source: 'ownership', entryId: entry.id, message: 'No retained registration owner observation proves this instance’s dependencies. It may be unloaded, unobserved, or register arbitrary dynamic behavior.' })
  if (ownership.invalid) unknown({ code: 'ownership-invalid', source: 'ownership', message: 'Invalid registration references were omitted from the ownership index.' })
  if (ownership.evicted) unknown({ code: 'ownership-evicted', source: 'ownership', message: 'The bounded process-local ownership index evicted observations. Missing records are unknown.' })
  const impactedConnections = new Map<string, string>()
  for (const connection of evidence.connections) {
    const matches = registrations.filter(({ ref }) => ref.kind === 'connection-adapter' && refKey(ref) === refKey(connection.adapter) || ref.kind === 'connection-type' && connection.type && refKey(ref) === refKey(connection.type))
    if (!matches.length) continue
    const key = nodeKey('connection', connection.id)
    if (!connectedNode({ key, kind: 'connection', id: connection.id, enabled: connection.enabled }, matches.map(match => match.key))) continue
    impactedConnections.set(connection.id, key)
    for (const match of matches) edge({ from: match.key, to: key, relation: match.ref.kind === 'connection-type' ? 'uses-type' : 'uses-adapter', source: 'connections' })
  }
  const impactedCapabilities = new Set(registrations.filter(item => item.ref.kind === 'capability').map(item => refKey(item.ref)))
  const impactedSnapshots = new Map<string, { key: string; snapshot: RuntimeImpactSnapshot }>()
  for (const revision of evidence.snapshots) {
    const capabilities = registrations.filter(({ ref }) => ref.kind === 'capability' && revision.capabilities.some(capability => refKey(capability) === refKey(ref)))
    const connections = revision.connections.filter(id => impactedConnections.has(id))
    if (!capabilities.length && !connections.length) continue
    const key = nodeKey('revision', revision.revisionId)
    if (!connectedNode({ key, kind: 'revision', id: revision.revisionId, automationId: revision.automationId, purpose: revision.purpose, active: revision.active, automationEnabled: revision.automationEnabled }, [...capabilities.map(item => item.key), ...connections.map(id => impactedConnections.get(id)!)])) continue
    impactedSnapshots.set(revision.revisionId, { key, snapshot: revision })
    const source = revision.active ? 'active-revisions' : 'run-snapshots'
    for (const capability of capabilities) edge({ from: capability.key, to: key, relation: 'depends-on-capability', source })
    for (const id of connections) edge({ from: impactedConnections.get(id)!, to: key, relation: 'depends-on-connection', source })
  }
  for (const run of evidence.runs) {
    const snapshot = evidence.snapshots.find(item => item.revisionId === run.revisionId && item.automationId === run.automationId)
    if (!snapshot) continue
    const executions = run.executions.filter(execution => execution.capability && impactedCapabilities.has(refKey(execution.capability)) || execution.connections.some(id => impactedConnections.has(id)))
    let revision = impactedSnapshots.get(run.revisionId)
    // A malformed manifest must not hide an observed invocation whose immutable
    // compiled instruction still proves the capability/connection reference.
    if (executions.length) {
      const key = nodeKey('revision', snapshot.revisionId)
      const links: HostConfigImpactEdge[] = []
      for (const execution of executions) {
        for (const registration of registrations) if (registration.ref.kind === 'capability' && execution.capability && refKey(registration.ref) === refKey(execution.capability)) links.push({ from: registration.key, to: key, relation: 'invokes-capability', source: 'run-executions', executionId: execution.id })
        for (const id of execution.connections) if (impactedConnections.has(id)) links.push({ from: impactedConnections.get(id)!, to: key, relation: 'uses-connection', source: 'run-executions', executionId: execution.id })
      }
      if (connectedNode({ key, kind: 'revision', id: snapshot.revisionId, automationId: snapshot.automationId, purpose: snapshot.purpose, active: snapshot.active, automationEnabled: snapshot.automationEnabled }, links.map(link => link.from))) {
        for (const link of links) edge(link)
        revision = { key, snapshot }; impactedSnapshots.set(snapshot.revisionId, revision)
      }
    }
    if (!revision || revision.snapshot.automationId !== run.automationId) continue
    const affectedExecutionIds = new Set(executions.map(execution => execution.id))
    // A preceding timer/control may suspend the Run before the affected call exists.
    // Use that observed wait only when no concurrent invocation is running.
    if (!executions.length && !run.executions.some(execution => execution.status === 'RUNNING' && execution.op === 'invoke' || execution.attemptStatus === 'RUNNING')) {
      executions.push(...run.executions.filter(execution => execution.op === 'other' && execution.status === 'WAITING'))
    }
    const condition = runCondition(run, executions, revision.snapshot)
    const observations = [...executions]
    for (const execution of run.executions) if (!observations.includes(execution) && (execution.outcomeUnknown || execution.attemptStatus === 'OUTCOME_UNKNOWN' || condition === 'running' && !affectedExecutionIds.size && (execution.status === 'RUNNING' || execution.attemptStatus === 'RUNNING'))) observations.push(execution)
    const key = nodeKey('run', run.id)
    if (!connectedNode({ key, kind: 'run', id: run.id, automationId: run.automationId, revisionId: run.revisionId, status: run.status, condition, executions: observations.map(execution => ({ id: execution.id, status: execution.status, outcomeUnknown: execution.outcomeUnknown || execution.attemptStatus === 'OUTCOME_UNKNOWN', scope: affectedExecutionIds.has(execution.id) ? 'affected-call' : 'run-context', ...(execution.attemptStatus ? { attemptStatus: execution.attemptStatus } : {}) })), executionTruncated: run.executionsTruncated }, [revision.key])) continue
    edge({ from: revision.key, to: key, relation: 'executes-revision', source: 'nonterminal-runs' })
    if (condition === 'unknown') unknown({ code: 'execution-state-incomplete', source: 'run-executions', message: 'Current affected-call state cannot be established completely; completed or uncertain effects do not imply a safe retry.' })
  }
  for (const source of evidence.coverage) if (source.status === 'partial' || source.status === 'unavailable') unknown({ code: 'source-incomplete', source: source.source, message: `The ${source.source} source is ${source.status}; missing objects remain unknown.` })
  unknown({ code: 'dynamic-references-excluded', source: 'dynamic-references', message: 'Dynamic extension references and arbitrary plugin behavior are outside this explicit dependency graph.' })
  unknown({ code: 'drafts-excluded', source: 'drafts', message: 'Unpublished Draft references are excluded; later editing or publishing may still be affected.' })
  unknown({ code: 'external-effects-not-reversible', source: 'external-effects', message: 'Disabling or restoring an instance cannot undo external actions and does not automatically replay calls with an uncertain result.' })
  result.coverage.push(...(['dynamic-references', 'external-effects'] as const).map(source => ({ source, status: 'excluded' as const, scanned: 0, limit: 0, truncated: false, reasons: [source === 'dynamic-references' ? 'not-statically-provable' : 'not-reversible'] })))
  result.truncated ||= result.coverage.some(source => source.truncated)
  result.status = registrations.length ? 'known-impacts' : result.unknownReasons.some(item => ['entry-not-observed', 'historical-only', 'ownership-invalid', 'ownership-evicted', 'source-incomplete', 'graph-limit'].includes(item.code)) ? 'unknown' : 'no-known-impacts'
  return result
}
