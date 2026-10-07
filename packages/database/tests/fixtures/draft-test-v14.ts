import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { coreMigrations, runMigrations } from '../../src/migrations.js'

/** Synthetic legacy data only. Never open a user database to build this fixture. */
export const draftTestV14Ids = {
  automation: 'auto_fixture_primary',
  archivedAutomation: 'auto_fixture_archived',
  revision1: 'rev_fixture_1',
  revision3: 'rev_fixture_3',
  archivedRevision: 'rev_fixture_archived',
  waitingRun: 'run_fixture_waiting',
  completedRun: 'run_fixture_completed',
  triggeredRun: 'run_fixture_triggered',
  sharedResource: 'res_fixture_shared',
  outputResource: 'res_fixture_output',
  leasedResource: 'res_fixture_leased',
} as const

const now = '2026-09-29T10:00:00.000Z'
const json = JSON.stringify

export function populateDraftTestV14Fixture(database: Database.Database, initializeSchema = true): void {
  database.pragma('foreign_keys = ON')
  if (initializeSchema) runMigrations(database, coreMigrations.filter(migration => migration.version <= 14))
  database.transaction(() => {
    const ids = draftTestV14Ids
    const source = {
      inputs: { attachment: { type: 'object', default: { $resource: ids.sharedResource } } },
      triggers: [{ id: 'clock', capability: { id: 'fixture:clock', version: 1 }, config: {} }],
      flow: { type: 'foreach', id: 'items', items: { type: 'literal', value: ['first'] }, concurrency: 1,
        body: { type: 'block', id: 'body', steps: [{ type: 'wait', id: 'wait', durationMs: { type: 'literal', value: 60_000 } }] } },
    }
    const plan = { irVersion: 1, entry: 'items', instructions: {
      items: { op: 'iterate', id: 'items', items: source.flow.items, body: 'wait', concurrency: 1, join: '__join' },
      wait: { op: 'suspend', id: 'wait', source: 'timer', config: { durationMs: { type: 'literal', value: 60_000 } }, next: '__scope_complete' },
      __scope_complete: { op: 'scope_complete', id: '__scope_complete' },
      __join: { op: 'join', id: '__join', mode: 'iterate', next: '__complete' },
      __complete: { op: 'complete', id: '__complete' },
    }, resources: [{ $resource: ids.sharedResource }], sourceMap: { wait: { nodeId: 'wait' } } }
    const dependencies = { capabilities: [{ id: 'fixture:clock', version: 1, kind: 'trigger' }] }
    const contracts = { capabilities: [{ id: 'fixture:clock', version: 1, kind: 'trigger', title: 'Synthetic clock', inputSchema: {}, outputSchema: {}, semantics: { sideEffect: false, idempotent: true, retrySafe: true } }] }
    const insertAutomation = database.prepare(`
      INSERT INTO automations (id, name, enabled, active_revision_id, activation_generation, archived_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insertAutomation.run(ids.automation, 'Synthetic active Automation', 1, ids.revision3, 9, null, now, now)
    insertAutomation.run(ids.archivedAutomation, 'Synthetic archived Automation', 0, ids.archivedRevision, 4, now, now, now)

    const insertRevision = database.prepare(`
      INSERT INTO automation_revisions (id, automation_id, number, protocol_version, source_json, presentation_json,
        ir_version, compiled_plan_json, dependency_manifest_json, contract_snapshot_json, content_hash, created_at)
      VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?)
    `)
    for (const [id, automationId, number] of [
      [ids.revision1, ids.automation, 1], [ids.revision3, ids.automation, 3], [ids.archivedRevision, ids.archivedAutomation, 1],
    ] as const) {
      const contentHash = createHash('sha256').update(json({ source, plan, number })).digest('hex')
      insertRevision.run(id, automationId, number, json(source), json({ collapsed: ['body'], caption: `Version ${number}` }), json(plan), json(dependencies), json(contracts), contentHash, now)
    }
    const insertDraft = database.prepare(`
      INSERT INTO automation_drafts (automation_id, base_revision_id, source_json, presentation_json, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    insertDraft.run(ids.automation, ids.revision3, json(source), json({ caption: 'Current Draft' }), 7, now)
    insertDraft.run(ids.archivedAutomation, ids.archivedRevision, json(source), '{}', 2, now)

    const insertRun = database.prepare(`
      INSERT INTO runs (id, automation_id, revision_id, status, trigger_json, input_json, created_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insertRun.run(ids.waitingRun, ids.automation, ids.revision1, 'RUNNING', json({ type: 'manual' }), json({ attachment: { $resource: ids.sharedResource } }), now, now, null)
    insertRun.run(ids.completedRun, ids.automation, ids.revision1, 'COMPLETED', 'null', '{}', now, now, now)
    insertRun.run(ids.triggeredRun, ids.automation, ids.revision3, 'COMPLETED', json({ tick: 1 }), '{}', now, now, now)
    const insertExecution = database.prepare(`
      INSERT INTO executions (id, run_id, instruction_id, parent_execution_id, scope_execution_id, scope_branch,
        status, resolved_input_json, output_json, wake_at, generation, loop_item_json, loop_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insertExecution.run('exe_fixture_loop', ids.waitingRun, 'items', null, null, null, 'WAITING', '{}', null, null, 2, null, null, now, now)
    insertExecution.run('exe_fixture_wait', ids.waitingRun, 'wait', 'exe_fixture_loop', 'exe_fixture_loop', 0, 'WAITING', '{}', null, '2026-09-29T10:01:00.000Z', 1, json('first'), 0, now, now)
    insertExecution.run('exe_fixture_completed', ids.completedRun, '__complete', null, null, null, 'COMPLETED', '{}', json({ $resource: ids.outputResource }), null, 0, null, null, now, now)
    database.prepare(`
      INSERT INTO execution_iterations (iterate_execution_id, item_index, item_json, status, root_execution_id,
        terminal_execution_id, created_at, updated_at)
      VALUES (?, 0, ?, 'RUNNING', ?, ?, ?, ?)
    `).run('exe_fixture_loop', json('first'), 'exe_fixture_wait', 'exe_fixture_wait', now, now)
    database.prepare(`
      INSERT INTO attempts (id, execution_id, number, status, provider_ref, error_json, started_at, finished_at)
      VALUES (?, ?, 1, 'SUCCEEDED', ?, NULL, ?, ?)
    `).run('att_fixture_completed', 'exe_fixture_completed', 'fixture:provider@1', now, now)
    database.prepare(`INSERT INTO manual_run_requests (request_id, content_hash, run_id) VALUES (?, ?, ?)`)
      .run('fixture-manual-request-0001', 'synthetic-request-hash', ids.completedRun)
    database.prepare(`
      INSERT INTO trigger_events (id, automation_id, revision_id, activation_generation, trigger_id, capability_id,
        capability_version, event_id, data_json, checkpoint_json, occurred_at, accepted_at, run_id)
      VALUES (?, ?, ?, 9, 'clock', 'fixture:clock', 1, 'tick-1', ?, ?, ?, ?, ?)
    `).run('trigger_fixture', ids.automation, ids.revision3, json({ tick: 1 }), json({ offset: 1 }), now, now, ids.triggeredRun)
    const insertEvent = database.prepare(`INSERT INTO run_events (run_id, sequence, type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)`)
    for (const runId of [ids.waitingRun, ids.completedRun, ids.triggeredRun]) {
      insertEvent.run(runId, 1, 'RunAccepted', json({ source: runId === ids.triggeredRun ? 'trigger' : 'manual' }), now)
      insertEvent.run(runId, 2, 'RunStarted', '{}', now)
    }
    insertEvent.run(ids.completedRun, 3, 'RunCompleted', '{}', now)
    insertEvent.run(ids.triggeredRun, 3, 'RunCompleted', '{}', now)

    const insertResource = database.prepare(`
      INSERT INTO resources (id, name, media_type, size, digest, store_id, state, staged_expires_at, created_at, updated_at)
      VALUES (?, ?, 'application/octet-stream', 4, ?, 'local', ?, ?, ?, ?)
    `)
    for (const [index, resourceId] of [ids.sharedResource, ids.outputResource, ids.leasedResource].entries()) {
      const staged = resourceId === ids.leasedResource
      insertResource.run(resourceId, 'Synthetic metadata only', `sha256:${String(index + 1).repeat(64)}`, staged ? 'STAGED' : 'COMMITTED', staged ? '2026-09-30T10:00:00.000Z' : null, now, now)
    }
    const insertOwner = database.prepare(`INSERT INTO resource_owners (resource_id, owner_type, owner_id, created_at) VALUES (?, ?, ?, ?)`)
    insertOwner.run(ids.sharedResource, 'automation', ids.automation, now)
    insertOwner.run(ids.sharedResource, 'automation', ids.archivedAutomation, now)
    insertOwner.run(ids.outputResource, 'execution', 'exe_fixture_completed', now)
    database.prepare(`INSERT INTO resource_leases (id, resource_id, holder, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('lease_fixture', ids.leasedResource, 'fixture-holder', '2026-09-30T10:00:00.000Z', now)
    database.prepare(`INSERT INTO automation_draft_copy_requests (request_id, content_hash, automation_id) VALUES (?, ?, ?)`)
      .run('fixture-copy-request-0001', 'synthetic-copy-hash', ids.archivedAutomation)
  }).immediate()
}

/** Capture every legacy row, including migration markers, in stable primary-key order. */
export function captureDraftTestV14Rows(database: Database.Database): Record<string, unknown[]> {
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[]
  return Object.fromEntries(tables.map(table => {
    const escapedTable = `"${table.replaceAll('"', '""')}"`
    const columns = database.pragma(`table_info(${escapedTable})`) as Array<{ name: string; pk: number }>
    const keys = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk)
    const ordering = keys.map(column => `"${column.name.replaceAll('"', '""')}"`).join(', ')
    return [table, database.prepare(`SELECT * FROM ${escapedTable} ORDER BY ${ordering || 'rowid'}`).all()]
  }))
}
