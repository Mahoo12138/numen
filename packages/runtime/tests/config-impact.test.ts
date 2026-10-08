import { describe, expect, it } from 'vitest'
import type { HostConfigOperation, HostConfigSnapshot, HostRegistrationDiagnosis, HostRegistrationOwner } from '@numenjs/config'
import { buildConfigImpact, configImpactLimits } from '../src/config-impact.js'
import type { RuntimeImpactEvidence, RuntimeImpactExecution, RuntimeImpactRun } from '../src/config-impact-evidence.js'

const observedAt = '2026-10-08T00:00:00.000Z', computedAt = '2026-10-08T00:00:01.000Z'
const entry = (id: string, parentId?: string, group = false) => ({ id, key: id, name: `unrelated-name-${id}`, packageName: id, packageVersion: null, installed: true, parentId, group, selfEnabled: true, effectiveEnabled: true, actualState: 'ACTIVE' as const, config: { secret: 'do-not-transport' }, configEditable: false, protected: false, internal: [] })
const snapshot: HostConfigSnapshot = { fingerprint: 'fingerprint', version: 2, writable: true, safeMode: false, restartRequired: false, entries: [entry('group', undefined, true), entry('definition', 'group'), entry('provider', 'group'), entry('other')] }
const owner = (id: string, role: 'definition' | 'provider', evidence: 'current' | 'previous' = 'current'): HostRegistrationOwner => ({ role, evidence, observedAt, entry: { id, actualState: 'ACTIVE', selfEnabled: true, effectiveEnabled: true }, ancestors: [] })
const diagnoses: HostRegistrationDiagnosis[] = [
  { kind: 'capability', id: 'remote:action', version: 1, owners: [owner('definition', 'definition'), owner('provider', 'provider')] },
  { kind: 'connection-adapter', id: 'remote:adapter', version: 2, owners: [owner('definition', 'definition'), owner('provider', 'provider')] },
  { kind: 'connection-type', id: 'remote:type', version: 1, owners: [owner('definition', 'definition')] },
  { kind: 'capability', id: 'provider:same-prefix', version: 1, owners: [owner('other', 'definition'), owner('other', 'provider')] },
]
const evidence = (): RuntimeImpactEvidence => ({
  connections: [{ id: 'linked', enabled: true, adapter: { id: 'remote:adapter', version: 2 }, type: { id: 'remote:type', version: 1 } }, { id: 'unrelated', enabled: true, adapter: { id: 'other', version: 1 } }],
  snapshots: [
    { automationId: 'automation', revisionId: 'active', purpose: 'published', active: true, automationEnabled: true, capabilities: [{ id: 'remote:action', version: 1, kind: 'action' }], connections: ['linked'], dependenciesComplete: true, executionPlanComplete: true },
    { automationId: 'automation', revisionId: 'old-test', purpose: 'draft-test', active: false, automationEnabled: true, capabilities: [], connections: ['linked'], dependenciesComplete: true, executionPlanComplete: true },
    { automationId: 'unrelated', revisionId: 'unrelated-revision', purpose: 'published', active: true, automationEnabled: true, capabilities: [{ id: 'provider:same-prefix', version: 1, kind: 'query' }], connections: ['unrelated'], dependenciesComplete: true, executionPlanComplete: true },
  ],
  runs: [{ id: 'queued', automationId: 'automation', revisionId: 'active', status: 'QUEUED', executions: [], executionsTruncated: false }, { id: 'test-run', automationId: 'automation', revisionId: 'old-test', status: 'RUNNING', executions: [], executionsTruncated: false }],
  coverage: [
    ...(['connections', 'active-revisions', 'nonterminal-runs', 'run-executions', 'run-snapshots'] as const).map(source => ({ source, status: 'complete' as const, scanned: 1, limit: 128, truncated: false, reasons: [] })),
    { source: 'drafts', status: 'excluded', scanned: 0, limit: 0, truncated: false, reasons: ['drafts-not-scanned'] },
  ],
})
function analyze(ids = ['provider'], source = evidence(), refs = diagnoses, operation: HostConfigOperation = { kind: 'setEnabled', id: ids[0]!, enabled: false }, current = snapshot) {
  return buildConfigImpact(operation, ids, current, { diagnoses: refs, scanned: refs.length, limit: 256, truncated: false, evicted: false }, source, computedAt)
}

describe('bounded current-ownership dependency proof', () => {
  it('separates Definition and Provider and excludes unrelated objects and prefixes', () => {
    const provider = analyze(), definition = analyze(['definition'])
    expect(provider).toMatchObject({ status: 'known-impacts', computedAt, truncated: false })
    expect(provider.nodes.filter(node => node.kind === 'registration').map(node => node.role)).toEqual(['provider', 'provider'])
    expect(definition.nodes.filter(node => node.kind === 'registration').map(node => node.role)).toEqual(['definition', 'definition', 'definition'])
    expect(provider.nodes.map(node => node.id)).toEqual(['provider', 'remote:action', 'remote:adapter', 'linked', 'active', 'old-test', 'queued', 'test-run'])
    expect(provider.edges).toContainEqual(expect.objectContaining({ relation: 'owns-provider', source: 'ownership', observedAt }))
    expect(provider.edges).toContainEqual(expect.objectContaining({ relation: 'depends-on-connection', source: 'run-snapshots' }))
    expect(JSON.stringify(provider)).not.toContain('do-not-transport')
    expect(JSON.stringify(provider)).not.toContain('same-prefix')
  })

  it('retains historical evidence separately without proving downstream reachability or recovery', () => {
    const previous = diagnoses.map(ref => ({ ...ref, owners: ref.owners.map(item => ({ ...item, evidence: 'previous' as const })) }))
    const result = analyze(['provider'], evidence(), previous)
    expect(result.status).toBe('unknown')
    expect(result.nodes.map(node => node.kind)).toEqual(['entry'])
    expect(result.history).toHaveLength(2)
    expect(result.edges).toEqual([])
    expect(result.unknownReasons).toContainEqual(expect.objectContaining({ code: 'historical-only', entryId: 'provider' }))
  })

  it('reports never observed instances and missing domain services as unknown', () => {
    const source = evidence(); source.coverage[0] = { source: 'connections', status: 'unavailable', scanned: 0, limit: 128, truncated: false, reasons: ['service-unavailable'] }
    const result = analyze(['provider'], source, [])
    expect(result.status).toBe('unknown')
    expect(result.unknownReasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'entry-not-observed' }), expect.objectContaining({ code: 'source-incomplete', source: 'connections' })]))
    expect(result.nodes).toHaveLength(1)
  })

  it('follows Group descendants by stable IDs and uses current moved ancestry', () => {
    const result = analyze(['group', 'definition', 'provider'])
    expect(result.edges.filter(edge => edge.relation === 'contains')).toHaveLength(2)
    const moved = structuredClone(snapshot); moved.entries.find(item => item.id === 'provider')!.parentId = 'other'
    expect(analyze(['group', 'definition'], evidence(), diagnoses, undefined, moved).nodes.some(node => node.kind === 'registration' && node.role === 'provider')).toBe(false)
    expect(analyze(['provider'], evidence(), diagnoses, { kind: 'move', id: 'provider', parentId: 'other' }, moved).nodes.filter(node => node.kind === 'registration')).toHaveLength(2)
  })

  it.each(['setLabel', 'setCollapsed', 'createGroup', 'removeGroup'] as const)('does not classify %s as runtime dependency impact', kind => {
    const operation = { kind, id: 'provider', label: 'New label', collapsed: true } as HostConfigOperation
    const result = analyze(['provider'], evidence(), diagnoses, operation)
    expect(result).toMatchObject({ operationEffect: 'metadata-only', status: 'no-known-impacts', edges: [], history: [], unknownReasons: [] })
    expect(result.nodes.map(node => node.kind)).toEqual(['entry'])
  })

  it('does not attach a Run to another automation with the same malformed revision reference', () => {
    const source = evidence(); source.runs[0]!.automationId = 'different'
    expect(analyze(['provider'], source).nodes.some(node => node.kind === 'run' && node.id === 'queued')).toBe(false)
  })

  it('bounds graph output, records omissions and keeps every rendered dependency rooted', () => {
    const source = evidence()
    source.snapshots = Array.from({ length: 1000 }, (_, index) => ({ ...source.snapshots[0]!, revisionId: `revision-${index}` }))
    const result = analyze(['provider'], source)
    expect(result.truncated).toBe(true)
    expect(result.nodes.length).toBeLessThanOrEqual(configImpactLimits.nodes)
    expect(result.edges.length).toBeLessThanOrEqual(configImpactLimits.edges)
    expect(result.unknownReasons).toContainEqual(expect.objectContaining({ code: 'graph-limit' }))
    const reachable = new Set(result.nodes.filter(node => node.kind === 'entry').map(node => node.key))
    for (const edge of result.edges) if (reachable.has(edge.from)) reachable.add(edge.to)
    expect(result.nodes.every(node => reachable.has(node.key))).toBe(true)
  })
})

const execution = (change: Partial<RuntimeImpactExecution> = {}): RuntimeImpactExecution => ({ id: 'affected-call', instructionId: 'call', status: 'RUNNABLE', op: 'invoke', capability: { id: 'remote:action', version: 1 }, capabilityKind: 'action', sideEffect: true, connections: ['linked'], outcomeUnknown: false, ...change })
function withRun(executions: RuntimeImpactExecution[], change: Partial<RuntimeImpactRun> = {}) {
  const source = evidence(); source.runs = [{ id: 'run', automationId: 'automation', revisionId: 'active', status: 'RUNNING', executions, executionsTruncated: false, ...change }]
  return analyze(['provider'], source).nodes.find(node => node.kind === 'run')!
}
it('distinguishes affected-call states without equating RUNNING to external action or promising a replay', () => {
  expect(withRun([])).toMatchObject({ condition: 'not-started' })
  expect(withRun([execution({ status: 'BLOCKED' })])).toMatchObject({ condition: 'blocked' })
  expect(withRun([execution({ status: 'WAITING' })])).toMatchObject({ condition: 'waiting' })
  expect(withRun([execution({ status: 'RUNNING' })])).toMatchObject({ condition: 'running' })
  expect(withRun([execution({ status: 'RUNNING', attemptStatus: 'RUNNING' })])).toMatchObject({ condition: 'executing-external-action', executions: [{ id: 'affected-call', status: 'RUNNING', attemptStatus: 'RUNNING' }] })
  expect(withRun([execution({ status: 'RUNNING', attemptStatus: 'RUNNING', sideEffect: false })])).toMatchObject({ condition: 'running' })
  expect(withRun([execution({ status: 'RUNNING', attemptStatus: 'RUNNING', op: 'other' })])).toMatchObject({ condition: 'running' })
  expect(withRun([execution({ status: 'COMPLETED', outcomeUnknown: true })])).toMatchObject({ condition: 'outcome-unknown' })
  expect(withRun([execution({ status: 'COMPLETED', attemptStatus: 'SUCCEEDED' })])).toMatchObject({ condition: 'unknown' })
  expect(withRun([], { status: 'CANCELLING' })).toMatchObject({ condition: 'cancelling' })
  expect(withRun([], { executionsTruncated: true })).toMatchObject({ condition: 'unknown', executionTruncated: true })
})
it('does not transfer unrelated parallel action state onto affected calls, and preserves observed danger through truncation', () => {
  expect(withRun([execution({ capability: { id: 'unrelated', version: 1 }, connections: [], status: 'RUNNING', attemptStatus: 'RUNNING' })])).toMatchObject({ condition: 'running', executions: [expect.objectContaining({ scope: 'run-context' })] })
  expect(withRun([execution({ outcomeUnknown: true })], { executionsTruncated: true })).toMatchObject({ condition: 'outcome-unknown' })
  expect(withRun([execution({ status: 'RUNNING', attemptStatus: 'RUNNING' })], { executionsTruncated: true })).toMatchObject({ condition: 'executing-external-action' })
})

it('recognizes a preceding control wait before affected calls are materialized', () => {
  const wait = execution({ id: 'wait', op: 'other', capability: undefined, connections: [], status: 'WAITING' })
  expect(withRun([wait])).toMatchObject({ condition: 'waiting', executions: [{ id: 'wait', status: 'WAITING' }] })
  expect(withRun([wait, execution({ capability: { id: 'other', version: 1 }, connections: [], status: 'RUNNING', attemptStatus: 'RUNNING' })])).toMatchObject({ condition: 'running', executions: [expect.objectContaining({ scope: 'run-context' })] })
})

it('keeps an unrelated uncertain call visible as Run context without falsely attributing its provider', () => {
  expect(withRun([execution({ id: 'unrelated-call', capability: { id: 'unrelated', version: 1 }, connections: [], status: 'COMPLETED', outcomeUnknown: true })])).toMatchObject({ condition: 'outcome-unknown', executions: [{ id: 'unrelated-call', scope: 'run-context' }] })
})
it('keeps a known executing dependency when the manifest is incomplete but its frozen invocation is readable', () => {
  const source = evidence()
  source.snapshots[0] = { ...source.snapshots[0]!, capabilities: [], connections: [], dependenciesComplete: false }
  source.runs = [{ id: 'running-call', automationId: 'automation', revisionId: 'active', status: 'RUNNING', executions: [execution({ status: 'RUNNING', attemptStatus: 'RUNNING' })], executionsTruncated: false }]
  const result = analyze(['provider'], source)
  expect(result.nodes.find(node => node.kind === 'run')).toMatchObject({ condition: 'executing-external-action' })
  expect(result.edges).toContainEqual(expect.objectContaining({ relation: 'invokes-capability', source: 'run-executions', executionId: 'affected-call' }))
  expect(result.edges).toContainEqual(expect.objectContaining({ relation: 'uses-connection', source: 'run-executions', executionId: 'affected-call' }))
})
it('rejects oversized or invalid registration references without changing their identity or leaking them', () => {
  const result = analyze(['provider'], evidence(), [
    { kind: 'capability', id: 'secret'.repeat(60), version: 1, owners: [owner('provider', 'provider')] },
    { kind: 'capability', id: 'bad-version', version: Infinity, owners: [owner('provider', 'provider')] },
  ])
  expect(result.status).toBe('unknown')
  expect(result.nodes).toHaveLength(1)
  expect(result.unknownReasons).toContainEqual(expect.objectContaining({ code: 'ownership-invalid' }))
  expect(JSON.stringify(result)).not.toContain('secret'.repeat(60))
})

it.each(['FAILED', 'INTERRUPTED'] as const)('does not call a %s attempt awaiting a safe retry unstarted', attemptStatus => {
  expect(withRun([execution({ status: 'RUNNABLE', attemptStatus })])).toMatchObject({ condition: 'unknown', executions: [{ id: 'affected-call', status: 'RUNNABLE', attemptStatus, scope: 'affected-call' }] })
  expect(withRun([execution({ status: 'RUNNABLE' }), execution({ id: 'retried-call', status: 'RUNNABLE', attemptStatus })])).toMatchObject({ condition: 'unknown' })
})

it('exposes historical unknown outcomes even when the latest attempt succeeded', () => {
  expect(withRun([execution({ status: 'COMPLETED', attemptStatus: 'SUCCEEDED', outcomeUnknown: true })])).toMatchObject({ condition: 'outcome-unknown', executions: [{ id: 'affected-call', status: 'COMPLETED', attemptStatus: 'SUCCEEDED', outcomeUnknown: true, scope: 'affected-call' }] })
  expect(withRun([execution({ status: 'COMPLETED', attemptStatus: 'SUCCEEDED' })])).toMatchObject({ executions: [{ outcomeUnknown: false }] })
})
