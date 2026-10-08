import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from 'cordis'
import { DatabaseService } from '@numenjs/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectRuntimeImpactEvidence, runtimeImpactLimits } from '../src/config-impact-evidence.js'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})
async function setup(path = ':memory:') {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(DatabaseService, { path })
  // Runtime availability is independent from persisted domain relationships.
  const live = { get(name: string) { return name === 'database' ? ctx.database : {} } } as Context
  return { ctx, db: ctx.database.db, collect: () => collectRuntimeImpactEvidence(live) }
}
type DB = Context['database']['db']
function automation(db: DB, id = 'auto_a', active: string | null = null) {
  db.prepare('INSERT INTO automations(id, name, enabled, active_revision_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)').run(id, 'PRIVATE_AUTOMATION_NAME', active, 'now', 'now')
}
const capability = { id: 'test:effect', version: 1, kind: 'action' }
function snapshot(db: DB, options: { id?: string; automationId?: string; number?: number | null; purpose?: string; manifest?: unknown; plan?: unknown; contract?: unknown; source?: string } = {}) {
  const { id = 'revision_a', automationId = 'auto_a', number = 1, purpose = 'published' } = options
  const manifest = options.manifest ?? { capabilities: [{ ...capability, connectionId: 'ignored_legacy', connectionIds: { default: 'conn_legacy', source: 'conn_named' } }] }
  const plan = options.plan ?? { irVersion: 1, entry: 'invoke', instructions: {
    invoke: { id: 'invoke', op: 'invoke', capability: { id: capability.id, version: 1 }, connection: 'ignored_legacy', connections: { default: 'conn_legacy', source: 'conn_named' }, input: { literal: 'PRIVATE_INPUT' } },
    wait: { id: 'wait', op: 'suspend', config: { durationMs: { literal: 10000 } } },
  } }
  const contract = options.contract ?? { capabilities: [{ ...capability, semantics: { sideEffect: true }, inputSchema: { default: 'PRIVATE_SCHEMA' }, outputSchema: {} }] }
  db.prepare(`INSERT INTO automation_revisions
    (id, automation_id, number, purpose, source_draft_version, protocol_version, source_json, presentation_json, ir_version, compiled_plan_json, dependency_manifest_json, contract_snapshot_json, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run(id, automationId, number, purpose, purpose === 'draft-test' ? 2 : null, options.source ?? 'PRIVATE_SOURCE_IS_NOT_JSON', 'PRIVATE_PRESENTATION_IS_NOT_JSON', JSON.stringify(plan), JSON.stringify(manifest), JSON.stringify(contract), 'hash', 'now')
}
function run(db: DB, id = 'run_a', revisionId = 'revision_a', status = 'RUNNING', automationId = 'auto_a') {
  db.prepare(`INSERT INTO runs(id, automation_id, revision_id, status, trigger_json, input_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, automationId, revisionId, status, 'PRIVATE_TRIGGER', 'PRIVATE_RUN_INPUT', 'now')
}
function execution(db: DB, id = 'exec_a', status = 'RUNNABLE', instructionId = 'invoke', runId = 'run_a') {
  db.prepare(`INSERT INTO executions(id, run_id, instruction_id, status, resolved_input_json, output_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, runId, instructionId, status, 'PRIVATE_RESOLVED', 'PRIVATE_OUTPUT', 'now', 'now')
}
function attempt(db: DB, status: string, number = 1, executionId = 'exec_a') {
  db.prepare(`INSERT INTO attempts(id, execution_id, number, status, provider_ref, error_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`${executionId}_${number}`, executionId, number, status, 'PRIVATE_PROVIDER_REF', 'PRIVATE_ERROR', 'now')
}
function connection(db: DB, id = 'conn_legacy', type = 'test:type') {
  db.prepare(`INSERT INTO connections(id, name, adapter_id, adapter_version, type_id, type_version, config_json, credential_id, enabled, created_at, updated_at)
    VALUES (?, ?, 'test:adapter', 1, ?, 2, ?, ?, 1, 'now', 'now')`).run(id, 'PRIVATE_CONNECTION_NAME', type, 'PRIVATE_CONFIG', 'PRIVATE_CREDENTIAL_ID')
}

describe('bounded config impact evidence', () => {
  it('projects explicit active, historical, and draft-test references without exposing business values or mutating storage', async () => {
    const { db, collect } = await setup()
    automation(db, 'auto_a', 'revision_active')
    snapshot(db, { id: 'revision_active', number: 2 })
    snapshot(db)
    snapshot(db, { id: 'snapshot_test', purpose: 'draft-test', number: null })
    run(db); run(db, 'run_test', 'snapshot_test', 'QUEUED'); run(db, 'run_terminal', 'revision_active', 'COMPLETED')
    connection(db); connection(db, 'conn_named')
    execution(db); execution(db, 'exec_wait', 'WAITING', 'wait')
    const changes = db.prepare('SELECT total_changes() AS changes').get()
    const result = collect()
    expect(result.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionId: 'revision_active', active: true, purpose: 'published', automationEnabled: true }),
      expect.objectContaining({ revisionId: 'revision_a', active: false, purpose: 'published', connections: ['conn_legacy', 'conn_named'] }),
      expect.objectContaining({ revisionId: 'snapshot_test', active: false, purpose: 'draft-test' }),
    ]))
    expect(result.runs.map(item => item.id)).toEqual(['run_a', 'run_test'])
    expect(result.runs[0].executions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'exec_a', op: 'invoke', capability: { id: capability.id, version: 1 }, capabilityKind: 'action', connections: ['conn_legacy', 'conn_named'], sideEffect: true, outcomeUnknown: false }),
      expect.objectContaining({ id: 'exec_wait', op: 'other', status: 'WAITING' }),
    ]))
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    expect(result.coverage.filter(item => item.source !== 'drafts').every(item => item.status === 'complete')).toBe(true)
    expect(result.coverage.find(item => item.source === 'drafts')).toMatchObject({ status: 'excluded', reasons: ['draft-references-excluded'] })
    expect(db.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
  })

  it('retains persisted state across restart and separates actual attempts from Run status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'numen-impact-')); directories.push(directory)
    const path = join(directory, 'db.sqlite')
    const first = await setup(path)
    automation(first.db); snapshot(first.db); run(first.db)
    execution(first.db, 'exec_blocked', 'BLOCKED'); execution(first.db, 'exec_external', 'RUNNING'); attempt(first.db, 'RUNNING', 1, 'exec_external')
    execution(first.db, 'exec_a', 'COMPLETED'); attempt(first.db, 'OUTCOME_UNKNOWN'); attempt(first.db, 'SUCCEEDED', 2)
    execution(first.db, 'exec_uncalled', 'RUNNABLE')
    await first.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const restarted = await setup(path)
    const executions = restarted.collect().runs[0].executions
    expect(executions.find(item => item.id === 'exec_a')).toMatchObject({ status: 'COMPLETED', attemptStatus: 'SUCCEEDED', outcomeUnknown: true })
    expect(executions.find(item => item.id === 'exec_external')).toMatchObject({ status: 'RUNNING', attemptStatus: 'RUNNING', sideEffect: true })
    expect(executions.find(item => item.id === 'exec_uncalled')).not.toHaveProperty('attemptStatus')
    expect(executions.find(item => item.id === 'exec_blocked')).toMatchObject({ status: 'BLOCKED', outcomeUnknown: false })
  })

  it('preserves useful persisted references when current domain services are unavailable', async () => {
    const { ctx, db } = await setup()
    automation(db, 'auto_a', 'revision_a'); snapshot(db); connection(db)
    const result = collectRuntimeImpactEvidence(ctx)
    expect(result.connections).toHaveLength(1)
    expect(result.snapshots).toHaveLength(1)
    expect(result.coverage.find(item => item.source === 'connections')).toMatchObject({ status: 'partial', reasons: ['runtime-service-unavailable'] })
    const absent = collectRuntimeImpactEvidence(new Context())
    expect(absent.connections).toEqual([])
    expect(absent.coverage.find(item => item.source === 'connections')).toMatchObject({ status: 'unavailable', reasons: ['database-unavailable'] })
  })

  it('does not decode oversized UTF-8 snapshots and gives explicit truncation', async () => {
    const { db, collect } = await setup()
    automation(db, 'auto_a', 'revision_a'); snapshot(db); run(db)
    const oversized = JSON.stringify({ capabilities: [], ignored: '密'.repeat(runtimeImpactLimits.snapshotBytes / 2) })
    db.prepare('UPDATE automation_revisions SET dependency_manifest_json = ?').run(oversized)
    const parse = vi.spyOn(JSON, 'parse')
    const result = collect()
    expect(parse.mock.calls.some(([value]) => value === oversized)).toBe(false)
    expect(result.snapshots).toEqual([])
    expect(result.coverage.find(item => item.source === 'run-snapshots')).toMatchObject({ status: 'partial', truncated: true, reasons: ['snapshot-byte-limit'] })
  })

  it.each(['protocol_version', 'ir_version'])('does not decode unsupported %s metadata', async column => {
    const { db, collect } = await setup()
    automation(db, 'auto_a', 'revision_a'); snapshot(db); run(db)
    db.prepare(`UPDATE automation_revisions SET ${column} = 99, dependency_manifest_json = 'CORRUPT_NOT_JSON'`).run()
    const parse = vi.spyOn(JSON, 'parse')
    const result = collect()
    expect(parse.mock.calls.some(([value]) => value === 'CORRUPT_NOT_JSON')).toBe(false)
    expect(result.coverage.find(item => item.source === 'run-snapshots')?.reasons).toContain('unsupported-snapshot-version')
  })

  it('records missing snapshots and corrupt metadata without fabricating empty coverage', async () => {
    const { db, collect } = await setup()
    automation(db, 'auto_missing', 'nonexistent')
    automation(db, 'auto_a', 'revision_a'); snapshot(db); run(db); execution(db)
    db.prepare("UPDATE automation_revisions SET dependency_manifest_json = 'broken', compiled_plan_json = '{}'").run()
    const result = collect()
    expect(result.snapshots[0]).toMatchObject({ dependenciesComplete: false, executionPlanComplete: false })
    expect(result.coverage.find(item => item.source === 'active-revisions')?.reasons).toEqual(expect.arrayContaining(['snapshot-missing', 'invalid-dependency-manifest', 'invalid-execution-metadata']))
    expect(result.runs[0].executions[0]).not.toHaveProperty('capability')
    expect(result.runs[0].executionEvidenceIncomplete).toBe(true)
    expect(result.coverage.find(item => item.source === 'run-executions')?.reasons).toContain('execution-instruction-unavailable')
  })

  it('keeps explicit adapter evidence for a legacy Connection whose Type was not recorded', async () => {
    const { db, collect } = await setup(); connection(db, 'legacy', '')
    const result = collect()
    expect(result.connections[0]).toEqual({ id: 'legacy', enabled: true, adapter: { id: 'test:adapter', version: 1 } })
    expect(result.coverage.find(item => item.source === 'connections')).toMatchObject({ status: 'partial', reasons: ['connection-type-unrecorded'] })
  })

  it('bounds each row collection in SQL and marks truncated Runs and execution histories', async () => {
    const { db, collect } = await setup()
    automation(db, 'auto_a', 'revision_a'); snapshot(db)
    db.transaction(() => {
      for (let index = 0; index <= runtimeImpactLimits.connections; index++) connection(db, `conn_${index}`)
      for (let index = 0; index <= runtimeImpactLimits.runs; index++) run(db, `run_${String(index).padStart(3, '0')}`)
      for (let index = 0; index <= runtimeImpactLimits.executionsPerRun; index++) execution(db, `exec_${index}`, 'RUNNABLE', 'invoke', 'run_000')
    })()
    const prepared = vi.spyOn(db, 'prepare')
    const result = collect()
    expect(result.connections).toHaveLength(runtimeImpactLimits.connections)
    expect(result.runs).toHaveLength(runtimeImpactLimits.runs)
    expect(result.runs[0].executions).toHaveLength(runtimeImpactLimits.executionsPerRun)
    expect(result.runs[0].executionsTruncated).toBe(true)
    for (const source of ['connections', 'nonterminal-runs', 'run-executions']) expect(result.coverage.find(item => item.source === source)?.truncated).toBe(true)
    const bulkReads = prepared.mock.calls.map(([query]) => String(query)).filter(query => /FROM (connections|automations|runs|executions e)/.test(query))
    expect(bulkReads.length).toBeGreaterThan(0)
    expect(bulkReads.every(query => /LIMIT (\?|@execution_limit)/.test(query))).toBe(true)
  })

  it('does not use a frozen contract mismatch to identify an external effect', async () => {
    const { db, collect } = await setup()
    automation(db); snapshot(db, { contract: { capabilities: [{ id: 'other:effect', version: 1, kind: 'action', semantics: { sideEffect: true } }] } }); run(db); execution(db, 'exec_a', 'RUNNING'); attempt(db, 'RUNNING')
    const result = collect()
    expect(result.runs[0].executions[0]).toMatchObject({ op: 'invoke', attemptStatus: 'RUNNING' })
    expect(result.runs[0].executions[0]).not.toHaveProperty('sideEffect')
    expect(result.snapshots[0].executionPlanComplete).toBe(false)
    expect(result.coverage.find(item => item.source === 'run-snapshots')?.reasons).toContain('missing-frozen-contract')
  })

  it('returns unavailable instead of a partially connected graph if database reads fail', async () => {
    const { db, collect } = await setup(); connection(db)
    db.prepare('ALTER TABLE automation_revisions RENAME TO revisions_unavailable').run()
    const result = collect()
    expect(result.connections).toEqual([])
    expect(result.coverage.find(item => item.source === 'connections')).toMatchObject({ status: 'unavailable', reasons: ['database-read-failed'] })
    expect(JSON.stringify(result)).not.toContain('revisions_unavailable')
  })
  it('caps cumulative snapshot bytes and execution rows, not only each individual snapshot or Run', async () => {
    const { db, collect } = await setup()
    automation(db)
    db.transaction(() => {
      for (let index = 0; index < 24; index++) {
        const id = `revision_${index}`
        snapshot(db, { id, number: index + 1, manifest: { capabilities: [capability], padding: 'x'.repeat(210_000) } })
        run(db, `run_${String(index).padStart(3, '0')}`, id)
        for (let executionIndex = 0; executionIndex < runtimeImpactLimits.executionsPerRun; executionIndex++) {
          execution(db, `exec_${index}_${executionIndex}`, 'RUNNABLE', 'invoke', `run_${String(index).padStart(3, '0')}`)
        }
      }
    })()
    const result = collect()
    expect(result.runs.flatMap(item => item.executions)).toHaveLength(runtimeImpactLimits.executions)
    expect(result.snapshots.length).toBeGreaterThan(0)
    expect(result.snapshots.length).toBeLessThan(24)
    expect(result.coverage.find(item => item.source === 'run-snapshots')).toMatchObject({ status: 'partial', truncated: true, reasons: ['snapshot-byte-limit'] })
    expect(result.coverage.find(item => item.source === 'run-executions')).toMatchObject({ status: 'partial', truncated: true, scanned: runtimeImpactLimits.executions })
    expect(result.runs.at(-1)?.executionsTruncated).toBe(true)
  })

  it('marks malformed and dynamic dependencies as unknown while retaining independently valid explicit references', async () => {
    const { db, collect } = await setup()
    automation(db, 'auto_a', 'revision_a')
    snapshot(db, { manifest: { controls: [{ id: 'custom:dynamic', version: 1 }], capabilities: [
      { ...capability, connectionIds: { good: 'conn_named', broken: { secret: 'PRIVATE_BAD_REFERENCE' } } },
      { id: 'invalid:version', version: -2, kind: 'action' },
    ] } })
    const result = collect()
    expect(result.snapshots[0]).toMatchObject({ capabilities: [capability], connections: ['conn_named'], dependenciesComplete: false })
    expect(result.coverage.find(item => item.source === 'active-revisions')?.reasons).toEqual(expect.arrayContaining(['invalid-connection-dependency', 'invalid-dependency-manifest', 'dynamic-control-references-uninspected']))
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BAD_REFERENCE')
  })

  it('does not choose a favorable contract from contradictory duplicate frozen definitions', async () => {
    const { db, collect } = await setup()
    automation(db); snapshot(db, { contract: { capabilities: [
      { ...capability, semantics: { sideEffect: true } },
      { ...capability, semantics: { sideEffect: false } },
      { ...capability, semantics: { sideEffect: true } },
    ] } }); run(db); execution(db, 'exec_a', 'RUNNING'); attempt(db, 'RUNNING')
    const result = collect()
    expect(result.runs[0].executions[0]).not.toHaveProperty('sideEffect')
    expect(result.snapshots[0].executionPlanComplete).toBe(false)
    expect(result.coverage.find(item => item.source === 'run-snapshots')?.reasons).toContain('ambiguous-frozen-contract')
  })

  it('bounds pathological retry histories and treats unseen old outcomes as unknown', async () => {
    const { db, collect } = await setup()
    automation(db); snapshot(db); run(db); execution(db)
    attempt(db, 'OUTCOME_UNKNOWN')
    for (let index = 2; index <= runtimeImpactLimits.attemptsPerExecution + 1; index++) attempt(db, 'FAILED', index)
    const result = collect()
    // The old uncertain result lies outside the inspected window. Do not fabricate
    // its value or describe the otherwise not-started call as safe to retry.
    expect(result.runs[0].executions[0]).toMatchObject({ attemptStatus: 'FAILED', outcomeUnknown: false })
    expect(result.runs[0].executionEvidenceIncomplete).toBe(true)
    expect(result.coverage.find(item => item.source === 'run-executions')).toMatchObject({ status: 'partial', truncated: true, reasons: ['attempt-limit'] })
  })

  it('does not expose corrupted Execution or Attempt status text as a public enum', async () => {
    const { db, collect } = await setup()
    automation(db); snapshot(db); run(db); execution(db); attempt(db, 'FAILED')
    execution(db, 'exec_bad', 'WAITING', 'wait')
    db.pragma('ignore_check_constraints = ON')
    db.prepare("UPDATE attempts SET status = 'PRIVATE_BROKEN_ATTEMPT'").run()
    db.prepare("UPDATE executions SET status = 'PRIVATE_BROKEN_EXECUTION' WHERE id = 'exec_bad'").run()
    db.pragma('ignore_check_constraints = OFF')
    const result = collect()
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BROKEN')
    expect(result.runs[0].executionEvidenceIncomplete).toBe(true)
    expect(result.runs[0].executions).toHaveLength(1)
    expect(result.runs[0].executions[0]).not.toHaveProperty('attemptStatus')
    expect(result.coverage.find(item => item.source === 'run-executions')?.reasons).toEqual(expect.arrayContaining(['invalid-execution-status', 'invalid-attempt-status']))
  })

  it.each([
    { label: 'legacy only', manifest: { connectionId: 'legacy' }, instruction: { connection: 'legacy' }, expected: ['legacy'] },
    { label: 'named replaces legacy', manifest: { connectionId: 'ignored', connectionIds: { named: 'current' } }, instruction: { connection: 'ignored', connections: { named: 'current' } }, expected: ['current'] },
    { label: 'empty named replaces legacy', manifest: { connectionId: 'ignored', connectionIds: {} }, instruction: { connection: 'ignored', connections: {} }, expected: [] },
    { label: 'other protocol field is not a reference', manifest: { connection: 'ignored', connections: { named: 'ignored' } }, instruction: { connectionId: 'ignored', connectionIds: { named: 'ignored' } }, expected: [] },
  ])('follows actual persisted binding semantics: $label', async item => {
    const { db, collect } = await setup()
    automation(db)
    snapshot(db, { manifest: { capabilities: [{ ...capability, ...item.manifest }] }, plan: { irVersion: 1, entry: 'invoke', instructions: {
      invoke: { id: 'invoke', op: 'invoke', capability, ...item.instruction },
    } } })
    run(db); execution(db)
    const result = collect()
    expect(result.snapshots[0].connections).toEqual(item.expected)
    expect(result.runs[0].executions[0].connections).toEqual(item.expected)
    expect(JSON.stringify(result)).not.toContain('ignored')
  })

})
